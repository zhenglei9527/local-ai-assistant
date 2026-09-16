/**
 * 前缀稳定性测试。
 *
 * 运行：node --test src/inference/prefixStability.test.ts
 *
 * 这组测试的意义：前缀稳定性是「缓存能不能命中」的唯一判据，而它一旦被
 * 破坏，表现只是「变慢了」，不会报错、不会崩溃 —— 属于最容易悄悄回归的一类
 * 缺陷。所以这里把每一条会破坏前缀的行为都写成断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  splitPrompt,
  computePrefixKey,
  findVolatileContent,
  comparePrefix,
  firstDifferenceIndex,
  shouldPersistPrefix,
  prefixReuseSavingSeconds,
  DEFAULT_MIN_PREFIX_TOKENS,
} from './prefixStability.ts'
import type { ChatMessage } from './InferenceEngine.ts'

/* ==========================================================================
 * splitPrompt
 * ========================================================================== */

test('splitPrompt: system 段是前缀，历史是后缀', () => {
  const sys = 'You are Alice.'
  const messages: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]
  const r = splitPrompt(sys, messages)

  assert.equal(r.prefix, sys)
  assert.ok(r.suffix.includes('user:hi'))
  assert.ok(r.suffix.includes('assistant:hello'))
  // 前缀的复本不应重复出现在后缀里 —— 否则缓存的是同一段文本两份。
  assert.ok(!r.suffix.includes('You are Alice.'))
})

test('splitPrompt: 与 systemPrompt 不同的 system 消息算作可变后缀', () => {
  // 作者注按深度插入历史，位置随轮次推移 —— 它属于可变后缀。
  const sys = 'Card body.'
  const note = 'Author note: stay in character.'
  const messages: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: 'a' },
    { role: 'system', content: note },
    { role: 'user', content: 'b' },
  ]
  const r = splitPrompt(sys, messages)

  assert.equal(r.prefix, sys)
  assert.ok(r.suffix.includes(note), '作者注必须落在可变后缀，不能冻结进前缀')
})

test('splitPrompt: 空前缀时 prefixShare 为 0 而不是 NaN', () => {
  const r = splitPrompt('', [])
  assert.equal(r.prefix, '')
  assert.equal(r.suffix, '')
  assert.equal(r.prefixShare, 0)
  assert.ok(Number.isFinite(r.prefixShare))
})

test('splitPrompt: prefixShare 反映前缀占比，且落在 0..1', () => {
  const sys = 'x'.repeat(300)
  const messages: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: 'y'.repeat(100) },
  ]
  const r = splitPrompt(sys, messages)
  assert.ok(r.prefixShare > 0.5 && r.prefixShare < 1, `got ${r.prefixShare}`)
})

/* ==========================================================================
 * computePrefixKey
 * ========================================================================== */

test('computePrefixKey: 同样内容 => 同样键', () => {
  const a = 'Alice is a detective.'
  assert.equal(computePrefixKey(a), computePrefixKey(`${a}`))
})

test('computePrefixKey: 一个字符之差 => 不同键', () => {
  const a = computePrefixKey('Alice is a detective.')
  const b = computePrefixKey('Alice is a detective!')
  assert.notEqual(a, b, '标点变化也必须让缓存失效')
})

test('computePrefixKey: 大小写与空白敏感', () => {
  assert.notEqual(computePrefixKey('Alice'), computePrefixKey('alice'))
  assert.notEqual(computePrefixKey('a b'), computePrefixKey('a  b'))
})

test('computePrefixKey: 键是稳定字符串且带长度前缀', () => {
  const key = computePrefixKey('hello')
  assert.equal(typeof key, 'string')
  assert.match(key, /^p5-[0-9a-f]{8}$/, `unexpected key shape: ${key}`)
  // 同内容多次调用必须完全一致（不能靠 Math.random 或对象地址）。
  assert.equal(key, computePrefixKey('hello'))
})

test('computePrefixKey: 空前缀也有确定键', () => {
  assert.equal(computePrefixKey(''), computePrefixKey(''))
  assert.match(computePrefixKey(''), /^p0-[0-9a-f]{8}$/)
})

test('computePrefixKey: 长度不同但同哈希也能区分（长度进键）', () => {
  // 构造一个内容不同、长度不同的对，断言长度分量确实生效
  const short = computePrefixKey('a')
  const long = computePrefixKey('b'.repeat(50))
  assert.notEqual(short, long)
  assert.ok(short.startsWith('p1-'))
  assert.ok(long.startsWith('p50-'))
})

test('computePrefixKey: 中文与 emoji 不炸（逐 UTF-16 单元处理）', () => {
  const k1 = computePrefixKey('角色卡：爱丽丝')
  const k2 = computePrefixKey('角色卡：爱丽丝')
  const k3 = computePrefixKey('角色卡：爱丽丝2')
  assert.equal(k1, k2)
  assert.notEqual(k1, k3)
  // 代理对（emoji）不会让键缺失
  assert.match(computePrefixKey('🙂'), /^p2-[0-9a-f]{8}$/)
})

/* ==========================================================================
 * findVolatileContent
 * ========================================================================== */

test('findVolatileContent: 干净的角色卡文本不报任何问题', () => {
  const card =
    'Alice is a 19th century detective. She speaks with precision and ' +
    'never breaks character. Scenario: a rainy night in London.'
  assert.deepEqual(findVolatileContent(card), [])
})

test('findVolatileContent: 检出 ISO 时间戳', () => {
  const hits = findVolatileContent('Current time: 2026-09-08T14:23:01Z')
  assert.ok(hits.some((h) => h.rule === 'iso-timestamp'), JSON.stringify(hits))
})

test('findVolatileContent: 检出带秒的时钟时间', () => {
  const hits = findVolatileContent('It is 14:23:01 right now.')
  assert.ok(hits.some((h) => h.rule === 'clock-time'))
})

test('findVolatileContent: 不误伤比例/版本号这类冒号数字', () => {
  // "1:2" 没有秒，不该被当成时间
  assert.deepEqual(findVolatileContent('ratio 1:2 and 3:4'), [])
})

test('findVolatileContent: 检出斜杠日期', () => {
  assert.ok(findVolatileContent('Today is 2026/09/08.').some((h) => h.rule === 'date-slash'))
  assert.ok(findVolatileContent('Today is 09/08/2026.').some((h) => h.rule === 'date-slash'))
})

test('findVolatileContent: 检出 UUID', () => {
  const hits = findVolatileContent('session 550e8400-e29b-41d4-a716-446655440000 started')
  assert.ok(hits.some((h) => h.rule === 'uuid'))
})

test('findVolatileContent: 检出毫秒时间戳', () => {
  const hits = findVolatileContent('generated at 1757330581000')
  assert.ok(hits.some((h) => h.rule === 'epoch-millis'))
})

test('findVolatileContent: 长十六进制串被检出，普通单词不会', () => {
  assert.ok(findVolatileContent('hash deadbeefdeadbeefdead').some((h) => h.rule === 'long-hex'))
  assert.deepEqual(findVolatileContent('deadbeef'), [], '8 位十六进制不该误报')
  assert.deepEqual(findVolatileContent('facade'), [])
})

test('findVolatileContent: 每条规则最多报一次（不刷屏）', () => {
  const many = '2026-09-08T14:23:01Z 2026-09-09T10:00:00Z 2026-09-10T11:11:11Z'
  const hits = findVolatileContent(many)
  assert.equal(hits.filter((h) => h.rule === 'iso-timestamp').length, 1)
})

test('findVolatileContent: 空文本返回空数组', () => {
  assert.deepEqual(findVolatileContent(''), [])
})

test('findVolatileContent: 命中项带 sample 与 why，便于直接展示给用户', () => {
  const [hit] = findVolatileContent('2026-09-08T14:23:01Z')
  assert.ok(hit)
  assert.equal(typeof hit.sample, 'string')
  assert.ok(hit.sample.length > 0)
  assert.ok(hit.why.length > 0)
  assert.ok(hit.sample.length <= 60)
})

/* ==========================================================================
 * comparePrefix / firstDifferenceIndex
 * ========================================================================== */

test('comparePrefix: 首次调用没有上一轮，视为稳定', () => {
  const r = comparePrefix(null, 'Alice')
  assert.equal(r.stable, true)
  assert.equal(r.previousKey, null)
  assert.ok(r.currentKey.startsWith('p5-'))
  assert.equal(r.reason, null)
})

test('comparePrefix: 前缀逐字节相同 => stable，键也相同', () => {
  const p = 'Alice is a detective.\nWorld: London.'
  const r = comparePrefix(p, p)
  assert.equal(r.stable, true)
  assert.equal(r.previousKey, r.currentKey)
  assert.equal(r.reason, null)
})

test('comparePrefix: 前缀变化 => unstable 且给出可定位的原因', () => {
  const r = comparePrefix('Alice is a detective.', 'Alice is a detective!')
  assert.equal(r.stable, false)
  assert.notEqual(r.previousKey, r.currentKey)
  assert.ok(r.reason)
  // 0-based 下标，且必须与实际差异位置一致（'.' 在 'Alice is a detective.' 的下标 20）
  assert.ok(r.reason!.includes('下标 20'), `reason must locate the diff: ${r.reason}`)
  assert.ok(r.reason!.includes("'.'"), `reason must show the offending char: ${r.reason}`)
  assert.ok(r.reason!.includes("'!'"), `reason must show the replacement: ${r.reason}`)
})

test('comparePrefix: 世界书条目顺序重排也算不稳定', () => {
  const a = 'entry A\nentry B'
  const b = 'entry B\nentry A'
  const r = comparePrefix(a, b)
  assert.equal(r.stable, false, '重排世界书条目必须被视为前缀变化')
})

test('comparePrefix: 前缀变长（追加了一条世界书）算不稳定', () => {
  const r = comparePrefix('base', 'base\nworld info')
  assert.equal(r.stable, false)
})

test('firstDifferenceIndex: 相同字符串返回 -1', () => {
  assert.equal(firstDifferenceIndex('abc', 'abc'), -1)
})

test('firstDifferenceIndex: 定位首个差异，含前缀关系', () => {
  assert.equal(firstDifferenceIndex('abc', 'abd'), 2)
  assert.equal(firstDifferenceIndex('abc', 'abcd'), 3)
  assert.equal(firstDifferenceIndex('abcd', 'abc'), 3)
  assert.equal(firstDifferenceIndex('', 'a'), 0)
  assert.equal(firstDifferenceIndex('', ''), -1)
})

test('comparePrefix: 换行处差异的报错信息把 \\n 写出来', () => {
  const r = comparePrefix('a\nb', 'a\rb')
  assert.equal(r.stable, false)
  assert.ok(r.reason!.includes('\\n') || r.reason!.includes('\\r'), r.reason!)
})

/* ==========================================================================
 * 缓存决策
 * ========================================================================== */

test('shouldPersistPrefix: 空前缀不缓存', () => {
  assert.equal(shouldPersistPrefix(0), false)
})

test('shouldPersistPrefix: 低于门槛不缓存，达到门槛缓存', () => {
  assert.equal(shouldPersistPrefix(DEFAULT_MIN_PREFIX_TOKENS - 1), false)
  assert.equal(shouldPersistPrefix(DEFAULT_MIN_PREFIX_TOKENS), true)
  assert.equal(shouldPersistPrefix(5000), true)
})

test('shouldPersistPrefix: 可自定义门槛', () => {
  assert.equal(shouldPersistPrefix(100, 50), true)
  assert.equal(shouldPersistPrefix(100, 200), false)
})

test('prefixReuseSavingSeconds: 按速度换算，速度非法时回退 20 tok/s', () => {
  assert.equal(prefixReuseSavingSeconds(1000, 20), 50)
  assert.equal(prefixReuseSavingSeconds(1000, 40), 25)
  assert.equal(prefixReuseSavingSeconds(1000, 0), 50, '0 速度应回退到保守参考值')
  assert.equal(prefixReuseSavingSeconds(1000, NaN), 50)
  assert.equal(prefixReuseSavingSeconds(1000, -1), 50)
})
