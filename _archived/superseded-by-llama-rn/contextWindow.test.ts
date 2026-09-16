/**
 * 上下文窗口分档的单元测试。
 *
 * 全部是纯逻辑测试 —— contextWindow.ts 不 import llama.rn / react-native，
 * 所以可以在 Node 下直接跑。
 *
 * 运行：node --test src/inference/contextWindow.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTEXT_TIERS,
  DEFAULT_CONTEXT_TIER_ID,
  REFERENCE_PREFILL_TOKENS_PER_SECOND,
  estimateFirstTokenSeconds,
  getContextTier,
  tierForContextLength,
  selectDefaultTier,
  explainDefaultTier,
  kvCacheBytes,
  tierFitsMemory,
} from './contextWindow.ts'

/* ==========================================================================
 * 档位表的自洽性
 * ========================================================================== */

test('tier table is ordered ascending and unique', () => {
  assert.ok(CONTEXT_TIERS.length >= 4)
  for (let i = 1; i < CONTEXT_TIERS.length; i += 1) {
    assert.ok(
      CONTEXT_TIERS[i].nCtx > CONTEXT_TIERS[i - 1].nCtx,
      `tier ${i} nCtx must be strictly ascending`,
    )
    assert.ok(
      CONTEXT_TIERS[i].minDeviceRamGiB >= CONTEXT_TIERS[i - 1].minDeviceRamGiB,
      `tier ${i} RAM floor must not decrease`,
    )
  }
  const ids = new Set(CONTEXT_TIERS.map((t) => t.id))
  assert.equal(ids.size, CONTEXT_TIERS.length, 'tier ids must be unique')
})

test('the four documented tiers are present with the documented n_ctx values', () => {
  const byId = new Map(CONTEXT_TIERS.map((t) => [t.id, t.nCtx]))
  assert.equal(byId.get('lean'), 4096)
  assert.equal(byId.get('standard'), 8192)
  assert.equal(byId.get('long'), 16384)
  assert.equal(byId.get('extreme'), 32768)
})

test('worst-case first-token estimates are consistent with the reference prefill speed', () => {
  for (const tier of CONTEXT_TIERS) {
    const expected = Math.round(tier.nCtx / REFERENCE_PREFILL_TOKENS_PER_SECOND)
    // 允许 1 秒取整误差
    assert.ok(
      Math.abs(tier.worstCaseFirstTokenSeconds - expected) <= 1,
      `${tier.id}: expected ~${expected}s, table says ${tier.worstCaseFirstTokenSeconds}s`,
    )
  }
})

/* ==========================================================================
 * 默认档位 —— 设计文档的核心要求
 * ========================================================================== */

test('DEFAULT TIER IS 8192, NOT THE MAXIMUM', () => {
  // 设计文档 §4：把 32K 当默认 = 首字等 13 分钟。
  const def = getContextTier(DEFAULT_CONTEXT_TIER_ID)
  assert.equal(def.nCtx, 8192)
  const max = Math.max(...CONTEXT_TIERS.map((t) => t.nCtx))
  assert.notEqual(def.nCtx, max, 'default must not be the largest window')
})

test('8 GiB device gets the 8192 default tier', () => {
  const t = selectDefaultTier(8)
  assert.equal(t.nCtx, 8192)
})

test('selectDefaultTier never auto-selects the extreme tier', () => {
  // 即使 24 GB 旗舰，自动选择也停在 long；extreme 必须用户主动开启。
  for (const gb of [4, 6, 8, 12, 16, 24, 32, 64]) {
    const t = selectDefaultTier(gb)
    assert.notEqual(t.id, 'extreme', `${gb} GiB must not auto-select extreme`)
  }
})

test('selectDefaultTier is monotonic in device memory', () => {
  const order = CONTEXT_TIERS.map((t) => t.nCtx)
  let prev = -1
  for (const gb of [2, 3, 4, 6, 8, 12, 16, 24]) {
    const n = selectDefaultTier(gb).nCtx
    assert.ok(n >= prev, `${gb} GiB regressed from ${prev} to ${n}`)
    prev = n
    assert.ok(order.includes(n))
  }
})

test('small devices get the lean tier', () => {
  assert.equal(selectDefaultTier(4).nCtx, 4096)
  assert.equal(selectDefaultTier(3).nCtx, 4096)
  // 1 GiB 连 lean 的门槛都不到，仍返回最低档而不是 undefined
  assert.equal(selectDefaultTier(1).nCtx, 4096)
})

test('12 GiB and above unlocks the long tier', () => {
  assert.equal(selectDefaultTier(12).nCtx, 16384)
  assert.equal(selectDefaultTier(16).nCtx, 16384)
})

test('lowRamDevice drops one tier but never below the lean tier', () => {
  assert.equal(selectDefaultTier(8, false).nCtx, 8192)
  assert.equal(selectDefaultTier(8, true).nCtx, 4096)
  assert.equal(selectDefaultTier(4, true).nCtx, 4096, 'must clamp at the floor')
})

test('garbage device memory falls back to the documented default', () => {
  for (const bad of [NaN, Infinity, -Infinity, 0, -1]) {
    assert.equal(
      selectDefaultTier(bad).id,
      DEFAULT_CONTEXT_TIER_ID,
      `${bad} should fall back to the default tier`,
    )
  }
})

/* ==========================================================================
 * 查表与反查
 * ========================================================================== */

test('getContextTier falls back to the default on an unknown id', () => {
  assert.equal(getContextTier('standard').nCtx, 8192)
  assert.equal(getContextTier('nope').id, DEFAULT_CONTEXT_TIER_ID)
  assert.equal(getContextTier('').id, DEFAULT_CONTEXT_TIER_ID)
})

test('tierForContextLength snaps down to the containing tier', () => {
  assert.equal(tierForContextLength(4096).id, 'lean')
  assert.equal(tierForContextLength(8192).id, 'standard')
  assert.equal(tierForContextLength(12000).id, 'standard', 'snaps down, not up')
  assert.equal(tierForContextLength(32768).id, 'extreme')
  // 超出最大档仍返回最大档
  assert.equal(tierForContextLength(131072).id, 'extreme')
  // 低于最小档返回最小档
  assert.equal(tierForContextLength(512).id, 'lean')
})

/* ==========================================================================
 * 首字延迟换算
 * ========================================================================== */

test('estimateFirstTokenSeconds matches the design doc table', () => {
  // 设计文档 §2 @20 tok/s 列：1000 tok = 50 s，16000 tok = 800 s
  assert.equal(estimateFirstTokenSeconds(1000), 50)
  assert.equal(estimateFirstTokenSeconds(16000), 800)
  assert.equal(estimateFirstTokenSeconds(32000), 1600)
})

test('estimateFirstTokenSeconds is linear and handles degenerate input', () => {
  assert.equal(estimateFirstTokenSeconds(0), 0)
  assert.equal(estimateFirstTokenSeconds(-5), 0)
  assert.equal(estimateFirstTokenSeconds(NaN), 0)
  assert.equal(estimateFirstTokenSeconds(1000, 0), 0, 'zero speed must not divide by zero')
  assert.equal(estimateFirstTokenSeconds(1000, -1), 0)
  assert.equal(estimateFirstTokenSeconds(1000, 40), 25, 'speed doubles, time halves')
})

/* ==========================================================================
 * KV cache 计算
 * ========================================================================== */

test('kvCacheBytes reproduces the design doc table (Qwen3-4B, 36 layers, 8 kv heads)', () => {
  const MiB = 1024 ** 2
  // 设计文档 §1 表：2K=288M, 4K=576M, 8K=1152M
  assert.equal(kvCacheBytes(2048, 36, 8, 128), 288 * MiB)
  assert.equal(kvCacheBytes(4096, 36, 8, 128), 576 * MiB)
  assert.equal(kvCacheBytes(8192, 36, 8, 128), 1152 * MiB)
  // 32K f16 ≈ 1.15 GiB（设计文档 §3.1 的结论）
  assert.equal(kvCacheBytes(32768, 36, 8, 128), 4608 * MiB)
})

test('kvCacheBytes returns null for unknown architecture instead of a silent zero', () => {
  assert.equal(kvCacheBytes(8192, 0, 8, 128), null)
  assert.equal(kvCacheBytes(8192, 36, 0, 128), null)
  assert.equal(kvCacheBytes(8192, 36, 8, 0), null)
  assert.equal(kvCacheBytes(0, 36, 8, 128), null)
})

test('q8_0 KV halves the cache relative to f16', () => {
  const f16 = kvCacheBytes(8192, 36, 8, 128, 2)!
  const q8 = kvCacheBytes(8192, 36, 8, 128, 1.0625)!
  assert.ok(q8 < f16 / 1.8 && q8 > f16 / 2.1, `expected ~half, got ${q8 / f16}`)
})

test('tierFitsMemory: CORRECTED budget arithmetic for an 8 GiB device', () => {
  // ⚠️ 设计文档 §1 的表在这里算错了：它把「32K f16 KV」的增量写成 1.13 GiB，
  // 但按它自己 §1 的 KV 表（8K f16 = 1152 MiB）推下去，32K f16 应为 4.50 GiB。
  // 差 ~4 倍。本测试断言的是**修正后**的数字。
  const arch = { layers: 36, kvHeads: 8, headDim: 128 }
  const weightBytes = 3.08 * 1024 ** 3 // Qwen3-4B Q6_K，设计文档 §1
  const budget8GB = 5.44 // GiB，8GB 档预算
  const budget16GB = 10.88 // GiB，16GB 档预算

  // 8 GiB 机上：8K 装得下，16K 及以上装不下。
  assert.equal(
    tierFitsMemory(getContextTier('standard'), budget8GB, weightBytes, arch),
    true,
    '8K must fit an 8 GiB device',
  )
  assert.equal(
    tierFitsMemory(getContextTier('long'), budget8GB, weightBytes, arch),
    false,
    'CORRECTED: 16K does NOT fit an 8 GiB device with a 4B Q6_K',
  )
  assert.equal(
    tierFitsMemory(getContextTier('extreme'), budget8GB, weightBytes, arch),
    false,
    'CORRECTED: 32K does NOT fit an 8 GiB device — the design doc §1 claim is wrong',
  )

  // 32K 需要约 16 GiB 设备才在内存上成立 —— 这也是 extreme 档门槛的来历。
  assert.equal(
    tierFitsMemory(getContextTier('extreme'), budget16GB, weightBytes, arch),
    true,
    '32K fits a ~16 GiB device',
  )
})

test('tierFitsMemory: the lean tier is the safe fallback for a small device', () => {
  const arch = { layers: 36, kvHeads: 8, headDim: 128 }
  const weightBytes = 3.08 * 1024 ** 3
  // 4 GiB 机（预算 2.4 GiB，见 recommend.deviceBudgetGB）连 Q6_K 4B 都放不下，
  // 但 4K 窗口相对于更大的窗口仍是更可能装得下的那个。
  const budget4GB = 2.4
  assert.equal(
    tierFitsMemory(getContextTier('extreme'), budget4GB, weightBytes, arch),
    false,
  )
  assert.equal(
    tierFitsMemory(getContextTier('lean'), budget4GB, weightBytes, arch),
    false,
    'weights alone exceed a 4 GiB budget — the model picker handles this, not the tier',
  )
})

test('tierFitsMemory: unknown architecture returns true rather than a false negative', () => {
  const t = tierFitsMemory(getContextTier('extreme'), 2, 5 * 1024 ** 3, {
    layers: 0,
    kvHeads: 0,
    headDim: 0,
  })
  assert.equal(t, true)
})

/* ==========================================================================
 * 解释文案
 * ========================================================================== */

test('explainDefaultTier marks the standard tier as the default', () => {
  const s = explainDefaultTier(8)
  assert.equal(s.isDefault, true)
  assert.equal(s.tier.nCtx, 8192)
  assert.ok(s.rationale.length > 0)
})

test('explainDefaultTier flags a low-memory override and explains it', () => {
  const s = explainDefaultTier(8, true)
  assert.equal(s.tier.nCtx, 4096)
  assert.equal(s.isDefault, false)
  assert.match(s.rationale, /低内存/)
})

test('explainDefaultTier mentions the wait time for a non-default tier', () => {
  const s = explainDefaultTier(12)
  assert.equal(s.tier.nCtx, 16384)
  assert.equal(s.isDefault, false)
  assert.match(s.rationale, /首字延迟/)
})
