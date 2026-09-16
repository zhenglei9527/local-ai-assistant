/**
 * 世界书「激活集合冻结」（world-book activation freezing）
 *
 * 依据 `docs/context-budget-strategy.md` §5 规则 2：
 *
 *   > 世界书条目按触发插入会**破坏前缀稳定性**，应做「已激活条目集合在会话内
 *   > 冻结」处理。
 *
 * 问题在哪：`worldInfo.ts` 每轮都重新扫描历史，命中集合随对话内容漂移。
 * 用户提到一个新词，条目 A 被激活 → system 段多出一段文本 → 固定前缀变了 →
 * `save_prompt_state_path` 的缓存整体失效 → 用户本来只等 8K 的增量 prefill，
 * 结果退化成全量重算。
 *
 * 冻结策略：会话开始时算一次激活集合，之后按 `refreshEveryTurns` 轮才重新解冻
 * 一次。代价是**新触发的条目最多延迟 `refreshEveryTurns` 轮才生效** —— 这是
 * 明确写进文档的取舍，不是 bug。
 *
 * 设计取舍说明：
 *   - 冻结的是「激活集合」而不是「世界书全文」。冻结全文等于放弃触发机制，
 *     那是另一种（更粗糙的）产品选择。
 *   - `constant: true` 的条目不受冻结影响 —— 它们本来就每轮都该在，把它排除
 *     在冻结逻辑外可以少一个「为什么这个条目突然消失了」的困惑。
 *   - 解冻时**只做并集**（union），不删除已激活条目。若解冻时发现有条目不再
 *     命中就移除它，前缀会在解冻那一轮剧烈变化；只增不减虽然让世界书单调
 *     增长，但增长是缓慢且可预算的，且解冻后前缀依然连续。
 *
 * 本文件是纯逻辑：不 import llama.rn，不 import react-native，可在 Node 下测试。
 */

/* ==========================================================================
 * 1. 冻结配置
 * ========================================================================== */

/** 冻结策略。 */
export interface FreezeOptions {
  /**
   * 每隔多少轮解冻一次（重新扫描并并入新命中）。
   *
   * 设计文档 §7 给的参考值是每 10 轮。设 1 等价于「不冻结」（每轮都重新扫），
   * 设 `Infinity` 等价于「整个会话只扫一次」。
   */
  readonly refreshEveryTurns: number
  /**
   * 是否让 `constant: true` 的条目绕过冻结。
   *
   * 默认 true：常量条目语义上就是「永远在场」，把它一起冻结会让用户觉得
   * 卡坏了（而且它本来也不构成「漂移」，它每轮都在）。
   */
  readonly exemptConstants: boolean
}

/** 默认冻结配置。 */
export const DEFAULT_FREEZE_OPTIONS: FreezeOptions = {
  refreshEveryTurns: 10,
  exemptConstants: true,
}

/**
 * 「不冻结」配置：每轮重新扫描，行为与改动前完全一致。
 *
 * 给「世界书对时效性要求很高」的卡留出口，也让回归测试能对照旧行为。
 */
export const NO_FREEZE_OPTIONS: FreezeOptions = {
  refreshEveryTurns: 1,
  exemptConstants: false,
}

/* ==========================================================================
 * 2. 冻结状态
 * ========================================================================== */

/**
 * 会话级的冻结状态。应由聊天会话持有，跨轮次传递。
 *
 * 之所以把状态放在调用方而不是模块级变量：模块级可变状态在 RN 下会被
 * Fast Refresh 重置，且同一个 App 里可能有多个聊天会话并存（多开角色卡），
 * 它们必须各自冻结。
 */
export interface ActivationFreezeState {
  /** 当前被冻结（已确认注入）的条目 uid 集合。 */
  readonly frozenUids: ReadonlySet<number>
  /** 上次解冻时的轮次号。 */
  readonly frozenAtTurn: number
  /** 上次解冻时该前缀的缓存键；用于诊断冻结是否真的稳住了前缀。 */
  readonly prefixKeyAtFreeze: string | null
}

/** 新建一份空冻结状态（会话开始时调用）。 */
export function createFreezeState(): ActivationFreezeState {
  return { frozenUids: new Set(), frozenAtTurn: -1, prefixKeyAtFreeze: null }
}

/** 当前轮次是否应该解冻（重新扫描并并入新命中）。 */
export function shouldRefresh(
  state: ActivationFreezeState,
  currentTurn: number,
  options: FreezeOptions = DEFAULT_FREEZE_OPTIONS,
): boolean {
  // 从未冻结过：第一次必然要扫。
  if (state.frozenAtTurn < 0) return true

  const every = normalizeInterval(options.refreshEveryTurns)
  // Infinity -> 只扫一次（首次之后永不再扫）。
  if (every === Infinity) return false
  if (every <= 1) return true

  return currentTurn - state.frozenAtTurn >= every
}

/** 把用户/配置给的值收敛到合法区间，避免 0、负数、NaN 造成每轮解冻或永不解冻。 */
function normalizeInterval(value: number): number {
  if (value === Infinity) return Infinity
  if (!Number.isFinite(value)) return DEFAULT_FREEZE_OPTIONS.refreshEveryTurns
  if (value < 1) return 1
  return Math.floor(value)
}

/* ==========================================================================
 * 3. 激活集合的合并
 * ========================================================================== */

/**
 * 把本轮扫描出的激活集合，与冻结集合合并，得到本轮**实际注入**的 uid 集合。
 *
 * 三种情形：
 *   - 解冻轮（`refresh` 为 true）：并集 —— 保留旧的，并入新的。只增不减，
 *     见文件头对「不做删除」的解释。
 *   - 冻结轮：原样返回冻结集合，忽略本轮扫描结果。
 *   - 首次（冻结集合为空）：直接采用本轮扫描结果。
 *
 * `exemptUids`（常量条目）在冻结轮也会被并入 —— 它们不参与冻结。
 */
export function mergeActivation(
  state: ActivationFreezeState,
  scannedUids: readonly number[],
  refresh: boolean,
  exemptUids: readonly number[] = [],
): Set<number> {
  const scanned = new Set(scannedUids)
  const exempt = new Set(exemptUids)

  // 冻结轮：冻结集合 + 豁免条目，本轮扫描结果整体丢弃。
  if (!refresh && state.frozenAtTurn >= 0) {
    const out = new Set(state.frozenUids)
    for (const uid of exempt) out.add(uid)
    return out
  }

  // 解冻轮（含首次）：并集。
  const out = new Set(state.frozenUids)
  for (const uid of scanned) out.add(uid)
  for (const uid of exempt) out.add(uid)
  return out
}

/**
 * 生成下一轮的冻结状态。
 *
 * 注意 `turn` 只在真正解冻时写进 `frozenAtTurn`，这样 `shouldRefresh` 的
 * 「距上次解冻多少轮」才是按解冻轮计算的，而不是按最近一次调用。
 */
export function advanceFreezeState(
  state: ActivationFreezeState,
  merged: ReadonlySet<number>,
  refresh: boolean,
  currentTurn: number,
  prefixKey: string | null = null,
): ActivationFreezeState {
  return {
    frozenUids: merged,
    frozenAtTurn: refresh ? currentTurn : state.frozenAtTurn,
    prefixKeyAtFreeze: refresh ? prefixKey : state.prefixKeyAtFreeze,
  }
}

/**
 * 冻结集合是否真的稳住了前缀。
 *
 * 冻结的意义全在于「前缀不变 → 缓存命中」。如果冻结生效了但前缀仍然变了，
 * 说明**别的地方**在破坏前缀（例如作者注、时间戳宏），此时应该去看
 * `findVolatileContent()` / `comparePrefix()` 的结果，而不是继续调冻结参数。
 */
export function describeFreezeEffect(
  previousKey: string | null,
  currentKey: string,
  frozenCount: number,
  refreshEveryTurns: number,
): string {
  if (frozenCount === 0) {
    return '世界书未激活任何条目，冻结状态无实质作用。'
  }
  if (previousKey != null && previousKey === currentKey) {
    return `世界书激活集合已冻结 ${frozenCount} 条，前缀缓存键未变化，本轮可复用 prompt state。`
  }
  return (
    `世界书激活集合已冻结 ${frozenCount} 条（每 ${refreshEveryTurns} 轮解冻一次），` +
    '但前缀缓存键仍发生了变化 —— 说明破坏前缀的不是世界书，请检查时间戳/作者注等易变内容。'
  )
}

/**
 * 组装给用户看的取舍说明。
 *
 * 设计文档要求冻结的代价对用户可见（「可能让新触发词失效」），所以文案里必须
 * 明确说出延迟轮数，而不是只说「已开启冻结」。
 */
export function describeFreezeTradeoff(options: FreezeOptions): string {
  const every = normalizeInterval(options.refreshEveryTurns)
  if (every <= 1) {
    return '世界书每轮重新评估：新触发词立即生效，但激活集合一旦变化，固定前缀缓存就会失效，首字变慢。'
  }
  if (every === Infinity) {
    return '世界书在整个会话内只评估一次：前缀缓存最稳定、首字最快，但会话中途出现的新触发词永远不会生效。'
  }
  return (
    `世界书每 ${every} 轮解冻一次：前缀缓存大部分时间稳定、首字较快；` +
    `代价是新触发词最多延迟 ${every - 1} 轮才出现在提示词里。`
  )
}
