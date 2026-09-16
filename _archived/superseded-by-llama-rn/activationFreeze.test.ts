/**
 * 世界书激活冻结的单元测试。
 *
 * 运行：node --test src/inference/activationFreeze.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FREEZE_OPTIONS,
  NO_FREEZE_OPTIONS,
  advanceFreezeState,
  createFreezeState,
  describeFreezeEffect,
  describeFreezeTradeoff,
  mergeActivation,
  shouldRefresh,
} from './activationFreeze.ts';
import { computePrefixKey } from './prefixStability.ts';

/* -------------------------------------------------------------------------- */
/* 解冻时机                                                                    */
/* -------------------------------------------------------------------------- */

test('createFreezeState: 初始状态未冻结', () => {
  const s = createFreezeState();
  assert.equal(s.frozenAtTurn, -1);
  assert.equal(s.frozenUids.size, 0);
  assert.equal(s.prefixKeyAtFreeze, null);
});

test('shouldRefresh: 首次必然解冻', () => {
  const s = createFreezeState();
  assert.equal(shouldRefresh(s, 0), true);
  // 即便轮次很靠后，没冻结过就得先扫一次。
  assert.equal(shouldRefresh(s, 999), true);
});

test('shouldRefresh: 解冻后按间隔才再次解冻', () => {
  const opts = { refreshEveryTurns: 10, exemptConstants: true };
  let s = advanceFreezeState(createFreezeState(), new Set([1]), true, 0, 'k');

  // 第 0 轮刚解冻，之后 1..9 轮都冻结。
  for (let turn = 1; turn <= 9; turn += 1) {
    assert.equal(shouldRefresh(s, turn, opts), false, `turn ${turn} 不该解冻`);
  }

  // 第 10 轮（差 10 轮）解冻；调用方必须推进状态，否则窗口会一直停留在
  // frozenAtTurn=0，第 11 轮也满足 11-0>=10 而继续解冻。
  assert.equal(shouldRefresh(s, 10, opts), true);
  s = advanceFreezeState(s, new Set([1]), true, 10, 'k');

  // 解冻后重新开始计时。
  assert.equal(shouldRefresh(s, 11, opts), false);
  assert.equal(shouldRefresh(s, 19, opts), false);
  assert.equal(shouldRefresh(s, 20, opts), true);
});

test('shouldRefresh 是纯查询：不推进状态就会一直返回 true', () => {
  // 记录这个易错点本身。shouldRefresh 只回答「现在该不该解冻」，
  // 它不修改 frozenAtTurn —— 忘了调用 advanceFreezeState 的后果是
  // 每轮都解冻，等于冻结功能静默失效。
  const opts = { refreshEveryTurns: 3, exemptConstants: true };
  const s = advanceFreezeState(createFreezeState(), new Set([1]), true, 0);
  assert.equal(shouldRefresh(s, 3, opts), true);
  assert.equal(shouldRefresh(s, 3, opts), true, '未推进状态 -> 重复查询结果相同');
  assert.equal(shouldRefresh(s, 4, opts), true, '未推进状态 -> 之后每轮都解冻');
});

test('shouldRefresh: refreshEveryTurns=1 等价于从不冻结', () => {
  const s = advanceFreezeState(createFreezeState(), new Set([1]), true, 0);
  for (let turn = 1; turn <= 5; turn += 1) {
    assert.equal(shouldRefresh(s, turn, NO_FREEZE_OPTIONS), true);
  }
});

test('shouldRefresh: refreshEveryTurns=Infinity 等价于整个会话只扫一次', () => {
  const s = advanceFreezeState(createFreezeState(), new Set([1]), true, 0);
  const opts = { refreshEveryTurns: Infinity, exemptConstants: true };
  for (let turn = 1; turn <= 1000; turn += 1) {
    assert.equal(shouldRefresh(s, turn, opts), false);
  }
});

test('shouldRefresh: 非法间隔被收敛而不是产生古怪行为', () => {
  const s = advanceFreezeState(createFreezeState(), new Set([1]), true, 0);
  // 0 / 负数 -> 收敛到 1（每轮解冻）
  assert.equal(shouldRefresh(s, 1, { refreshEveryTurns: 0, exemptConstants: true }), true);
  assert.equal(shouldRefresh(s, 1, { refreshEveryTurns: -5, exemptConstants: true }), true);
  // NaN -> 回退到默认间隔 10
  assert.equal(shouldRefresh(s, 5, { refreshEveryTurns: NaN, exemptConstants: true }), false);
  assert.equal(shouldRefresh(s, 10, { refreshEveryTurns: NaN, exemptConstants: true }), true);
  // 小数向下取整
  const s2 = advanceFreezeState(createFreezeState(), new Set([1]), true, 0);
  assert.equal(shouldRefresh(s2, 2, { refreshEveryTurns: 2.9, exemptConstants: true }), true);
});

/* -------------------------------------------------------------------------- */
/* 激活集合合并                                                                */
/* -------------------------------------------------------------------------- */

test('mergeActivation: 首次直接采用扫描结果', () => {
  const s = createFreezeState();
  const merged = mergeActivation(s, [1, 2, 3], true);
  assert.deepEqual([...merged].sort((a, b) => a - b), [1, 2, 3]);
});

test('mergeActivation: 冻结轮忽略本轮扫描出的新条目', () => {
  const s = advanceFreezeState(createFreezeState(), new Set([1, 2]), true, 0);
  // 本轮扫描到 3、4，但处于冻结轮 -> 不应注入。
  const merged = mergeActivation(s, [1, 2, 3, 4], false);
  assert.deepEqual([...merged].sort((a, b) => a - b), [1, 2]);
});

test('mergeActivation: 冻结轮不会丢掉已冻结条目（即便本轮没扫到）', () => {
  const s = advanceFreezeState(createFreezeState(), new Set([1, 2, 3]), true, 0);
  // 本轮只扫到 1，但冻结集合应原样保留 —— 这是「只增不减」的直接体现。
  const merged = mergeActivation(s, [1], false);
  assert.deepEqual([...merged].sort((a, b) => a - b), [1, 2, 3]);
});

test('mergeActivation: 解冻轮做并集，不删除旧条目', () => {
  const s = advanceFreezeState(createFreezeState(), new Set([1, 2]), true, 0);
  const merged = mergeActivation(s, [3], true);
  assert.deepEqual([...merged].sort((a, b) => a - b), [1, 2, 3]);
});

test('mergeActivation: 解冻轮并集幂等（重复 uid 不重复计入）', () => {
  const s = advanceFreezeState(createFreezeState(), new Set([1, 2]), true, 0);
  const merged = mergeActivation(s, [2, 2, 3, 3], true);
  assert.deepEqual([...merged].sort((a, b) => a - b), [1, 2, 3]);
});

test('mergeActivation: 豁免条目在冻结轮也会并入', () => {
  const s = advanceFreezeState(createFreezeState(), new Set([1]), true, 0);
  // constant 条目 99 在冻结轮仍应出现。
  const merged = mergeActivation(s, [], false, [99]);
  assert.deepEqual([...merged].sort((a, b) => a - b), [1, 99]);
});

test('mergeActivation: 返回新集合，不修改冻结状态', () => {
  const frozen = new Set([1, 2]);
  const s = advanceFreezeState(createFreezeState(), frozen, true, 0);
  const merged = mergeActivation(s, [3], true);
  merged.add(999);
  assert.deepEqual([...s.frozenUids].sort((a, b) => a - b), [1, 2]);
});

/* -------------------------------------------------------------------------- */
/* 状态推进                                                                    */
/* -------------------------------------------------------------------------- */

test('advanceFreezeState: 解冻轮更新 frozenAtTurn 与缓存键', () => {
  const s = advanceFreezeState(createFreezeState(), new Set([1]), true, 7, 'p10-abcd1234');
  assert.equal(s.frozenAtTurn, 7);
  assert.equal(s.prefixKeyAtFreeze, 'p10-abcd1234');
});

test('advanceFreezeState: 冻结轮保持 frozenAtTurn 不变', () => {
  const s0 = advanceFreezeState(createFreezeState(), new Set([1]), true, 7, 'k1');
  // 第 8、9 轮都是冻结轮：frozenAtTurn 必须仍是 7，否则间隔会被无限推后。
  const s1 = advanceFreezeState(s0, new Set([1]), false, 8, 'k2');
  const s2 = advanceFreezeState(s1, new Set([1]), false, 9, 'k3');
  assert.equal(s1.frozenAtTurn, 7);
  assert.equal(s2.frozenAtTurn, 7);
  // 缓存键同样只在解冻时更新。
  assert.equal(s2.prefixKeyAtFreeze, 'k1');
});

test('advanceFreezeState: 间隔按解冻轮计算，不会因每轮调用而被推后', () => {
  const opts = { refreshEveryTurns: 5, exemptConstants: true };
  let s = createFreezeState();
  let refreshes = 0;

  // 模拟 20 轮，每轮都问一次 shouldRefresh。
  for (let turn = 0; turn < 20; turn += 1) {
    const refresh = shouldRefresh(s, turn, opts);
    if (refresh) refreshes += 1;
    s = advanceFreezeState(s, mergeActivation(s, [turn], refresh), refresh, turn);
  }
  // turn 0, 5, 10, 15 -> 4 次解冻。
  assert.equal(refreshes, 4);
});

/* -------------------------------------------------------------------------- */
/* 前缀稳定性联动                                                              */
/* -------------------------------------------------------------------------- */

test('冻结使前缀真正稳定：冻结轮前缀键保持不变', () => {
  const opts = { refreshEveryTurns: 10, exemptConstants: true };
  let s = createFreezeState();
  const keys: string[] = [];

  const prefixOf = (uids: readonly number[]) =>
    `[char]Alice[/char]\n<wi>${[...uids].sort((a, b) => a - b).join(',')}</wi>`;

  for (let turn = 0; turn < 6; turn += 1) {
    const refresh = shouldRefresh(s, turn, opts);
    // 本轮「扫描」到一个新条目：turn + 10，模拟随对话漂移的命中集合。
    const scanned = [1, turn + 10];
    const merged = mergeActivation(s, scanned, refresh);
    s = advanceFreezeState(s, merged, refresh, turn);
    keys.push(computePrefixKey(prefixOf([...merged])));
  }

  // 第 0 轮解冻后，1..5 轮全部应该与第 0 轮一致 —— 这就是缓存命中。
  assert.equal(new Set(keys.slice(1)).size, 1, `冻结期内前缀键必须恒定，实际：${keys.join(' ')}`);
  assert.equal(keys[1], keys[0], '解冻后第一轮就应与冻结时一致（无新增）');
});

test('不冻结时前缀每轮都变（对照，证明冻结确实在起作用）', () => {
  let s = createFreezeState();
  const keys: string[] = [];
  for (let turn = 0; turn < 6; turn += 1) {
    const refresh = shouldRefresh(s, turn, NO_FREEZE_OPTIONS);
    const merged = mergeActivation(s, [1, turn + 10], refresh);
    s = advanceFreezeState(s, merged, refresh, turn);
    keys.push(computePrefixKey(`<wi>${[...merged].sort((a, b) => a - b).join(',')}</wi>`));
  }
  assert.ok(new Set(keys).size > 1, '不冻结时前缀应当变化（否则本测试无意义）');
});

/* -------------------------------------------------------------------------- */
/* 文案与诊断                                                                  */
/* -------------------------------------------------------------------------- */

test('describeFreezeTradeoff: 三种配置各有明确说法', () => {
  assert.match(describeFreezeTradeoff(NO_FREEZE_OPTIONS), /新触发词立即生效/);
  assert.match(describeFreezeTradeoff({ refreshEveryTurns: Infinity, exemptConstants: true }), /永远不会生效/);
  const s = describeFreezeTradeoff(DEFAULT_FREEZE_OPTIONS);
  assert.match(s, /每 10 轮解冻一次/);
  // 关键：必须说出延迟代价，不能只讲好处。
  assert.match(s, /最多延迟 9 轮/);
});

test('describeFreezeTradeoff: 延迟轮数 = 间隔 - 1', () => {
  assert.match(describeFreezeTradeoff({ refreshEveryTurns: 3, exemptConstants: true }), /最多延迟 2 轮/);
  assert.match(describeFreezeTradeoff({ refreshEveryTurns: 2, exemptConstants: true }), /最多延迟 1 轮/);
});

test('describeFreezeEffect: 无激活条目时如实说明', () => {
  const s = describeFreezeEffect('k1', 'k1', 0, 10);
  assert.match(s, /未激活任何条目/);
});

test('describeFreezeEffect: 前缀稳定时报告可复用', () => {
  const s = describeFreezeEffect('k1', 'k1', 5, 10);
  assert.match(s, /5 条/);
  assert.match(s, /可复用 prompt state/);
});

test('describeFreezeEffect: 冻结生效但前缀仍变时，指向真正的元凶', () => {
  const s = describeFreezeEffect('k1', 'k2', 5, 10);
  assert.match(s, /说明破坏前缀的不是世界书/);
  // 必须给出下一步动作，而不是只说「不稳定」。
  assert.match(s, /时间戳|作者注/);
});

test('describeFreezeEffect: 首次（无上一轮键）不谎报可复用', () => {
  const s = describeFreezeEffect(null, 'k1', 3, 10);
  assert.match(s, /说明破坏前缀的不是世界书/);
  assert.doesNotMatch(s, /可复用/);
});
