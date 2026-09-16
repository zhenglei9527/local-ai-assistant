/**
 * 上下文窗口分档（context window tiers）
 *
 * 依据见 `docs/context-budget-strategy.md`。核心结论：
 *
 *   **内存不是瓶颈，预填充时间才是。**
 *
 * Qwen3 全系用 GQA（8 个 KV head 而非 32），KV cache 比 MHA 小 4 倍 ——
 * 但 32K f16 其实是 4.50 GiB，不是设计文档说的 1.15 GiB（见下方
 * `CONTEXT_TIERS` 的修正说明）。所以内存**确实**会在 8K 与 16K 之间开始
 * 咬人。真正的瓶颈仍然是 prefill：16K token 的提示词在 20 tok/s 下要
 * **13 分钟**才出第一个字。
 *
 * 所以窗口按「用户愿意等多久」设，而不是按「内存能放多少」设。默认是
 * 8192（标准档），**不是模型支持的最大值**。
 *
 * 本文件是纯逻辑：不 import llama.rn，不 import react-native，可在 Node 下直接测试。
 */

/** 一档上下文窗口。 */
export interface ContextTier {
  /** 稳定标识，用于持久化与 UI 选择。 */
  readonly id: 'lean' | 'standard' | 'long' | 'extreme'
  /** 实际传给 llama.rn 的 `n_ctx`。 */
  readonly nCtx: number
  /** UI 显示名（中文，与项目既有 UI 文案一致）。 */
  readonly label: string
  /**
   * 该档位的最低设备内存（GiB 物理 RAM）。
   * 注意这是**推荐门槛**，不是硬性可行性门槛 —— 4GB 机型在内存上跑得动 32K，
   * 只是 prefill 会慢到不可用。低于门槛时 UI 应给出明确警告而非直接禁止。
   */
  readonly minDeviceRamGiB: number
  /**
   * 一份典型提示词（角色卡 + 世界书 + 20 轮对话）填满该窗口时的
   * 首字延迟估计（秒），按 20 tok/s 的保守 prefill 速度。
   * 用来给用户一个「要等多久」的直观量级，不是精确预测。
   */
  readonly worstCaseFirstTokenSeconds: number
}

/**
 * 四档窗口。顺序即从最省到最放。
 *
 * ⚠️ `minDeviceRamGiB` 是**修正过**的门槛，与设计文档 §1 不同。
 *
 * 设计文档 §1 的表把「32K f16 KV」的增量算成 1.13 GiB，但按它自己的 KV 表
 * （8K f16 = 1152 MiB）推下去应为 4.50 GiB —— 差约 4 倍。按修正后的数字，
 * 一个 4B Q6_K（3.08 GiB 权重 + 256 MiB scratch）在 5.44 GiB 的 8GB 预算下：
 *
 *   4K f16  → 3.89 GiB  装得下
 *   8K f16  → 4.46 GiB  装得下
 *   16K f16 → 5.58 GiB  装不下
 *   32K f16 → 7.83 GiB  装不下
 *
 * 所以 32K 的门槛是 **16 GiB 设备**，不是 8 GiB。设计文档「32K 在 8GB 上内存
 * 完全可行」的结论是错的 —— 但它的**操作性结论（默认 8192 而非最大值）依然
 * 成立，甚至更成立**：8K 正好是 8GB 机上装得下的最大档。
 */
export const CONTEXT_TIERS: readonly ContextTier[] = [
  {
    id: 'lean',
    nCtx: 4096,
    label: '省流 · 4096',
    minDeviceRamGiB: 4,
    worstCaseFirstTokenSeconds: 205,
  },
  {
    id: 'standard',
    nCtx: 8192,
    label: '标准 · 8192',
    minDeviceRamGiB: 8,
    worstCaseFirstTokenSeconds: 410,
  },
  {
    id: 'long',
    nCtx: 16384,
    label: '长文 · 16384',
    minDeviceRamGiB: 12,
    worstCaseFirstTokenSeconds: 819,
  },
  {
    id: 'extreme',
    nCtx: 32768,
    label: '极限 · 32768',
    minDeviceRamGiB: 16,
    worstCaseFirstTokenSeconds: 1638,
  },
]

/**
 * 默认窗口。
 *
 * 设计文档 §4 明确要求：**默认 8192，不是最大值**。
 * 把 32K 当默认等于让每个新用户首字等 13 分钟。
 */
export const DEFAULT_CONTEXT_TIER_ID = 'standard'

/**
 * 参考 prefill 速度（token/秒），用于把提示词长度换算成首字延迟。
 *
 * 20 tok/s 取自设计文档 §2 的下界列，是 8B 级模型在手机上的悲观值。
 * 选择悲观值是有意的：宁可让用户觉得「比预期快」，也不要反过来说。
 */
export const REFERENCE_PREFILL_TOKENS_PER_SECOND = 20

/**
 * 把 token 数与 prefill 速度换算成首字延迟（秒）。
 *
 * 纯函数，便于测试与 UI 复用。
 */
export function estimateFirstTokenSeconds(
  promptTokens: number,
  tokensPerSecond: number = REFERENCE_PREFILL_TOKENS_PER_SECOND,
): number {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return 0
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return 0
  return promptTokens / tokensPerSecond
}

/** 按 id 取档位；未知 id 回退到默认档（不抛异常，配置损坏不应让 App 起不来）。 */
export function getContextTier(id: string): ContextTier {
  return (
    CONTEXT_TIERS.find((t) => t.id === id) ??
    CONTEXT_TIERS.find((t) => t.id === DEFAULT_CONTEXT_TIER_ID)!
  )
}

/** 按 n_ctx 反查档位；无精确匹配时取 n_ctx 不超过之的最大档。 */
export function tierForContextLength(nCtx: number): ContextTier {
  let best = CONTEXT_TIERS[0]
  for (const tier of CONTEXT_TIERS) {
    if (tier.nCtx <= nCtx) best = tier
  }
  return best
}

/**
 * 按设备物理内存选择默认档位。
 *
 * 规则：取「门槛不超过设备内存」的最高档，但**永远不自动选到 extreme**。
 *
 * 为什么排除 extreme：32K 在内存上可行，但设计文档 §4 把它列为「发烧友」
 * 档 —— 需要增量 prefill 完整落地后才实用。自动把新用户推到 32K 会让首字
 * 延迟达到分钟级，用户会以为 App 卡死。极限档必须由用户主动开启。
 *
 * `lowRamDevice` 为真（OEM 自己判定为低内存机）时再降一档：这类设备的
 * prefill 速度通常也显著低于参考值。
 *
 * @param totalRamGiB 设备物理内存（GiB）。非有限值或 <= 0 时回退默认档。
 * @param lowRamDevice `ActivityManager.isLowRamDevice()`
 */
export function selectDefaultTier(
  totalRamGiB: number,
  lowRamDevice = false,
): ContextTier {
  if (!Number.isFinite(totalRamGiB) || totalRamGiB <= 0) {
    return getContextTier(DEFAULT_CONTEXT_TIER_ID)
  }

  // 自动选择时不考虑最后一档（extreme），见函数注释。
  const autoSelectable = CONTEXT_TIERS.slice(0, -1)
  let chosen = autoSelectable[0]
  for (const tier of autoSelectable) {
    if (totalRamGiB >= tier.minDeviceRamGiB) chosen = tier
  }

  if (lowRamDevice) {
    const idx = CONTEXT_TIERS.findIndex((t) => t.id === chosen.id)
    if (idx > 0) chosen = CONTEXT_TIERS[idx - 1]
  }

  return chosen
}

/**
 * 计算某个 n_ctx 的 KV cache 字节数。
 *
 *   KV bytes = 2 (K+V) × layers × kv_heads × head_dim × ctx × bytes_per_elem
 *
 * 与 `memoryProbe.estimateModelMemory` 的公式一致，此处单独实现是为了让
 * 「选窗口」这件事不依赖模型目录 —— 窗口分档要在选模型之前就能给出建议。
 *
 * 架构未知（layers/kvHeads/headDim 任一为 0）时返回 null，调用方必须显式
 * 处理「算不出来」，而不是拿到一个静默为 0 的错误答案。
 */
export function kvCacheBytes(
  nCtx: number,
  layers: number,
  kvHeads: number,
  headDim: number,
  bytesPerElement = 2,
): number | null {
  if (nCtx <= 0 || layers <= 0 || kvHeads <= 0 || headDim <= 0) return null
  return Math.round(layers * nCtx * kvHeads * headDim * 2 * bytesPerElement)
}

/**
 * 判断某档位在当前设备上内存层面是否可行（**不代表体验可接受**）。
 *
 * `availableGiB` 是扣除安全边际后可用的内存；`weightBytes` 是模型权重占用。
 * 返回 false 只说明「装不下」，不说明「慢」—— 慢由 UI 用首字延迟提示表达。
 */
export function tierFitsMemory(
  tier: ContextTier,
  availableGiB: number,
  weightBytes: number,
  arch: { layers: number; kvHeads: number; headDim: number },
  scratchBytes = 256 * 1024 * 1024,
): boolean {
  const kv = kvCacheBytes(tier.nCtx, arch.layers, arch.kvHeads, arch.headDim)
  // 架构未知时保守处理：用「每 1K 上下文 0.5 MiB × 参数量」的粗估没有意义，
  // 这里直接返回 true 让上层按「无法判定」处理，避免误报不可行。
  if (kv == null) return true
  const total = weightBytes + kv + scratchBytes
  return total <= availableGiB * 1024 ** 3
}

/**
 * 档位选择结果，供 UI 展示「为什么是这个档」。
 */
export interface TierSelection {
  readonly tier: ContextTier
  /** true 表示这是设备默认值，false 表示用户手动覆盖。 */
  readonly isDefault: boolean
  /** 给用户看的一句话解释。 */
  readonly rationale: string
}

/**
 * 生成带解释的档位选择。
 *
 * UI 需要告诉用户「为什么是 8K 而不是 32K」—— 否则用户只会认为 App 保守。
 */
export function explainDefaultTier(
  totalRamGiB: number,
  lowRamDevice = false,
): TierSelection {
  const tier = selectDefaultTier(totalRamGiB, lowRamDevice)
  const isDefault = tier.id === DEFAULT_CONTEXT_TIER_ID

  let rationale: string
  if (lowRamDevice) {
    rationale =
      `系统将本机判定为低内存设备，已降一档至 ${tier.nCtx}。` +
      '更大的窗口在内存上可能可行，但首字延迟会明显变长。'
  } else if (isDefault) {
    rationale =
      `按 ${totalRamGiB} GiB 内存选择标准档 ${tier.nCtx}。` +
      '这是「提示词处理时间可控」的推荐值；更大的窗口内存放得下，但首字会明显变慢。'
  } else {
    rationale =
      `按 ${totalRamGiB} GiB 内存选择 ${tier.nCtx} 档。` +
      `填满该窗口时首字延迟约 ${tier.worstCaseFirstTokenSeconds} 秒（保守估计）。`
  }

  return { tier, isDefault, rationale }
}
