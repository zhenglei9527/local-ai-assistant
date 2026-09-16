/**
 * 历史滚动摘要的纯逻辑测试。
 *
 * 覆盖：占用测量、触发阈值（60%）、压缩目标（25%）、最近轮次保护、
 * 批次选择、摘要提示词构造。
 *
 * Run: node --test src/inference/rollingSummary.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ChatMessage } from './InferenceEngine.ts';
import {
  SUMMARY_TRIGGER_RATIO,
  SUMMARY_TARGET_RATIO,
  SUMMARY_N_PREDICT,
  MIN_RECENT_TURNS,
  measureContextUsage,
  planSummarization,
  selectSummaryBatch,
  buildSummaryPrompt,
  summarySampling,
  wrapSummary,
  prependSummary,
} from './rollingSummary.ts';

/* ==========================================================================
 * 测试夹具
 * ========================================================================== */

/** 每条消息固定 n 个字符的假计数：1 字符 = 1 token，便于手算。 */
const charCount = (s: string) => s.length;

function msg(role: 'user' | 'assistant', content: string): ChatMessage {
  return { role, content };
}

/** 造 n 条各 `len` 字符的消息，交替角色。 */
function history(n: number, len = 10): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(msg(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(len)));
  }
  return out;
}

/* ==========================================================================
 * 1. 阈值常量符合设计文档
 * ========================================================================== */

test('触发阈值为 60%，压缩目标为 25%（文档 §5 规则 4）', () => {
  assert.equal(SUMMARY_TRIGGER_RATIO, 0.6);
  assert.equal(SUMMARY_TARGET_RATIO, 0.25);
  // 目标必须小于触发线，否则压缩完立刻又触发，会陷入摘要死循环。
  assert.ok(SUMMARY_TARGET_RATIO < SUMMARY_TRIGGER_RATIO);
});

test('摘要生成的 n_predict 落在文档要求的 200–300 区间', () => {
  assert.ok(
    SUMMARY_N_PREDICT >= 200 && SUMMARY_N_PREDICT <= 300,
    `n_predict=${SUMMARY_N_PREDICT} 超出文档 §5 规则 3 的 200–300`,
  );
});

test('最近轮次保护至少保留 4 轮', () => {
  assert.ok(MIN_RECENT_TURNS >= 4);
});

/* ==========================================================================
 * 2. 占用测量
 * ========================================================================== */

test('measureContextUsage: 分母是「窗口减输出预留」，不是整个窗口', () => {
  // 窗口 8000，预留 1000 -> 可用 7000；前缀 2000 + 历史 1500 = 3500
  // 3500 / 7000 = 0.5（若错误地用 8000 做分母则得 0.4375）
  const ratio = measureContextUsage({
    windowTokens: 8000,
    prefixTokens: 2000,
    historyTokens: 1500,
    reservedOutputTokens: 1000,
  });
  assert.equal(ratio, 0.5);
});

test('measureContextUsage: 预留空间为 0 或负数时视为完全占满', () => {
  assert.equal(
    measureContextUsage({
      windowTokens: 1000,
      prefixTokens: 10,
      historyTokens: 10,
      reservedOutputTokens: 1000,
    }),
    1,
  );
  assert.equal(
    measureContextUsage({
      windowTokens: 1000,
      prefixTokens: 10,
      historyTokens: 10,
      reservedOutputTokens: 2000,
    }),
    1,
  );
});

test('measureContextUsage: 超出窗口时比例大于 1（不截断为 1）', () => {
  const ratio = measureContextUsage({
    windowTokens: 1000,
    prefixTokens: 0,
    historyTokens: 2000,
    reservedOutputTokens: 0,
  });
  assert.equal(ratio, 2);
});

/* ==========================================================================
 * 3. 触发判定
 * ========================================================================== */

test('占用 59% 不触发摘要', () => {
  // 可用 10000，已用 5900
  const decision = planSummarization(
    { windowTokens: 10000, prefixTokens: 900, historyTokens: 5000, reservedOutputTokens: 0 },
    history(20, 250),
    { countTokens: charCount },
  );
  assert.equal(decision.shouldSummarize, false);
  assert.equal(decision.reason, null);
  assert.equal(decision.tokensToCompress, 0);
});

test('占用恰好 60% 触发摘要（阈值是 >=，不是 >）', () => {
  const decision = planSummarization(
    { windowTokens: 10000, prefixTokens: 1000, historyTokens: 5000, reservedOutputTokens: 0 },
    history(20, 250),
    { countTokens: charCount },
  );
  assert.equal(decision.usageRatio, 0.6);
  assert.equal(decision.shouldSummarize, true);
});

test('占用 80% 触发摘要，目标是可用空间的 25%', () => {
  const decision = planSummarization(
    {
      windowTokens: 10000,
      prefixTokens: 3000,
      historyTokens: 5000,
      reservedOutputTokens: 0,
    },
    history(20, 250),
    { countTokens: charCount },
  );
  assert.equal(decision.usageRatio, 0.8);
  assert.equal(decision.shouldSummarize, true);
  // 目标 = 10000 * 0.25
  assert.equal(decision.targetHistoryTokens, 2500);
});

test('压缩量扣除了必须保留的最近轮次', () => {
  // 可用 10000 -> 目标 2500；历史 5000（20 条 × 250），最近 4 条 = 1000
  // 摘要额度 = 2500 - 1000 = 1500
  // 可压缩   = 5000 - 1000 - 1500 = 2500
  const decision = planSummarization(
    {
      windowTokens: 10000,
      prefixTokens: 3000,
      historyTokens: 5000,
      reservedOutputTokens: 0,
    },
    history(20, 250),
    { countTokens: charCount },
  );
  assert.equal(decision.targetHistoryTokens, 2500);
  assert.equal(decision.tokensToCompress, 2500);
});

test('窗口配置无效（预留 >= 窗口）时不摘要，并给出原因', () => {
  const decision = planSummarization(
    { windowTokens: 1000, prefixTokens: 100, historyTokens: 100, reservedOutputTokens: 1000 },
    history(5),
    { countTokens: charCount },
  );
  assert.equal(decision.shouldSummarize, false);
  assert.ok(decision.reason && decision.reason.includes('配置无效'));
});

test('超过触发线但可压缩额度不足时，不强行压掉最近几轮', () => {
  // 必须**先真的超过触发线**，否则走的是「未触发」分支，测不到这里。
  // 可用 10000：(1000 + 6000) / 10000 = 0.7 >= 0.6 -> 触发
  // 但 4 条各 1500 = 6000，恰等于整个历史：没有可压缩的旧轮次。
  const recent = history(4, 1500);
  const decision = planSummarization(
    { windowTokens: 10000, prefixTokens: 1000, historyTokens: 6000, reservedOutputTokens: 0 },
    recent,
    { countTokens: charCount },
  );
  assert.equal(decision.usageRatio, 0.7);
  assert.equal(decision.shouldSummarize, false);
  assert.equal(decision.tokensToCompress, 0);
  assert.ok(decision.reason && decision.reason.includes('硬截断'));
});

test('最近几轮本身就超过目标总量时，摘要额度为 0（无压缩空间）', () => {
  // 可用 4000 -> 目标 1000；但最近 4 条各 500 = 2000，已经超过目标总量，
  // 因此摘要额度为 0，且最近几条不可动 -> 无可压缩空间。
  const h = history(8, 500); // 8 × 500 = 4000 token
  const decision = planSummarization(
    { windowTokens: 4000, prefixTokens: 0, historyTokens: 4000, reservedOutputTokens: 0 },
    h,
    { countTokens: charCount },
  );
  assert.equal(decision.targetHistoryTokens, 1000);
  assert.equal(decision.shouldSummarize, false);
  assert.equal(decision.tokensToCompress, 0);
});

test('reason 文案包含实际占用百分比，便于用户理解', () => {
  const decision = planSummarization(
    {
      windowTokens: 10000,
      prefixTokens: 3000,
      historyTokens: 5000,
      reservedOutputTokens: 0,
    },
    history(20, 250),
    { countTokens: charCount },
  );
  assert.ok(decision.reason?.includes('80%'), `reason=${decision.reason}`);
});

/* ==========================================================================
 * 4. 批次选择
 * ========================================================================== */

test('selectSummaryBatch: 从最旧一端开始取，凑够目标就停', () => {
  const h = history(20, 100); // 每条 100 token
  const batch = selectSummaryBatch(h, 300, { countTokens: charCount });
  assert.equal(batch.messages.length, 3);
  assert.equal(batch.tokens, 300);
  // 必须是**最旧**的三条
  assert.equal(batch.messages[0], h[0]);
  assert.equal(batch.messages[2], h[2]);
});

test('selectSummaryBatch: 永远不碰最近 MIN_RECENT_TURNS 条', () => {
  const h = history(10, 100);
  // 要求压缩 10000 token（超过全部历史），也不能吃掉最近 4 条
  const batch = selectSummaryBatch(h, 10000, { countTokens: charCount });
  assert.equal(batch.messages.length, 10 - MIN_RECENT_TURNS);
  const protectedSet = new Set(h.slice(-MIN_RECENT_TURNS));
  for (const m of batch.messages) {
    assert.ok(!protectedSet.has(m), '最近轮次被错误地纳入摘要批次');
  }
});

test('selectSummaryBatch: 历史比保留轮数还短时返回空批', () => {
  const batch = selectSummaryBatch(history(3, 100), 500, { countTokens: charCount });
  assert.equal(batch.messages.length, 0);
  assert.equal(batch.tokens, 0);
});

test('selectSummaryBatch: 空历史不崩溃', () => {
  const batch = selectSummaryBatch([], 500, { countTokens: charCount });
  assert.deepEqual(batch, { messages: [], tokens: 0 });
});

/* ==========================================================================
 * 5. 摘要提示词
 * ========================================================================== */

test('buildSummaryPrompt 用 user 角色，避免污染固定前缀', () => {
  const prompt = buildSummaryPrompt(null, {
    messages: [msg('user', '你好'), msg('assistant', '你好呀')],
    tokens: 20,
  });
  assert.equal(prompt.length, 1);
  assert.equal(prompt[0].role, 'user', '摘要请求必须是 user，system 段是固定前缀');
  assert.ok(prompt[0].content.includes('你好'));
  assert.ok(prompt[0].content.includes('角色：你好呀'));
});

test('buildSummaryPrompt 携带上一轮摘要时要求合并而非重复', () => {
  const prompt = buildSummaryPrompt('他们约好明天去海边。', {
    messages: [msg('user', '出发吧')],
    tokens: 10,
  });
  assert.ok(prompt[0].content.includes('他们约好明天去海边。'));
  assert.ok(prompt[0].content.includes('合并'));
});

test('buildSummaryPrompt 忽略只含空白的旧摘要', () => {
  const prompt = buildSummaryPrompt('   ', {
    messages: [msg('user', 'hi')],
    tokens: 5,
  });
  assert.ok(!prompt[0].content.includes('已有的更早摘要'));
});

test('buildSummaryPrompt 指令要求不编造，且只输出正文', () => {
  const prompt = buildSummaryPrompt(null, { messages: [msg('user', 'hi')], tokens: 5 });
  assert.ok(prompt[0].content.includes('不要编造'));
  assert.ok(prompt[0].content.includes('只输出摘要正文'));
});

/* ==========================================================================
 * 6. 采样参数
 * ========================================================================== */

test('摘要采样温度低于角色扮演默认温度（0.8）', () => {
  const s = summarySampling();
  assert.equal(s.temperature, 0.3);
  assert.ok(s.temperature < 0.8, '摘要必须比角色扮演更保守');
  assert.equal(s.maxTokens, SUMMARY_N_PREDICT);
});

test('摘要采样上限可覆盖', () => {
  assert.equal(summarySampling({ maxTokens: 200 }).maxTokens, 200);
});

/* ==========================================================================
 * 7. 拼接
 * ========================================================================== */

test('wrapSummary 包裹正文并标注边界', () => {
  const wrapped = wrapSummary('  他们去了海边。  ');
  assert.ok(wrapped.startsWith('[以下是此前对话的摘要]'));
  assert.ok(wrapped.endsWith('[摘要结束]'));
  assert.ok(wrapped.includes('他们去了海边。'));
  // 首尾空白应被去掉
  assert.ok(!wrapped.includes('  他们去了海边。  '));
});

test('wrapSummary 对空摘要返回空串', () => {
  assert.equal(wrapSummary(''), '');
  assert.equal(wrapSummary('   \n  '), '');
});

test('prependSummary 把摘要放在历史最前，且不改原数组', () => {
  const original = history(3, 5);
  const out = prependSummary('早前摘要', original);
  assert.equal(out.length, 4);
  assert.ok(out[0].content.includes('早前摘要'));
  assert.equal(out[1], original[0]);
  // 原数组未被修改
  assert.equal(original.length, 3);
});

test('prependSummary 无摘要时返回历史副本', () => {
  const original = history(3, 5);
  const out = prependSummary(null, original);
  assert.equal(out.length, 3);
  assert.notEqual(out, original, '必须返回副本，避免调用方误改历史');
});

/* ==========================================================================
 * 8. 端到端：摘要后占用应回落
 * ========================================================================== */

test('端到端：压缩后占用应回落到触发线以下', () => {
  const windowTokens = 10000;
  const reservedOutputTokens = 1000;
  const available = windowTokens - reservedOutputTokens; // 9000
  const h = history(30, 200); // 6000 token

  const decision = planSummarization(
    { windowTokens, prefixTokens: 2000, historyTokens: 6000, reservedOutputTokens },
    h,
    { countTokens: charCount },
  );

  // 占用 = (2000 + 6000) / 9000 = 0.888 -> 触发
  assert.equal(decision.shouldSummarize, true);

  // 模拟真实的压缩：被选中的旧轮次**被摘要替换**，而不是简单地消失。
  // 摘要文本的大小受 summaryBudget 约束（= 目标总量 - 最近轮次）。
  const batch = selectSummaryBatch(h, decision.tokensToCompress, { countTokens: charCount });
  const remaining = h.slice(batch.messages.length);
  const remainingTokens = remaining.reduce((s, m) => s + charCount(m.content), 0);
  const summaryTokens = Math.max(0, decision.targetHistoryTokens - remainingTokens);
  const compressedHistory = remainingTokens + summaryTokens;

  const after = measureContextUsage({
    windowTokens,
    prefixTokens: 2000,
    historyTokens: compressedHistory,
    reservedOutputTokens,
  });
  assert.ok(
    after < SUMMARY_TRIGGER_RATIO,
    `压缩后占用 ${after} 应低于触发线 ${SUMMARY_TRIGGER_RATIO}`,
  );
});

test('端到端：压缩应实际移除旧轮次，且总量确实下降', () => {
  const windowTokens = 10000;
  const reservedOutputTokens = 1000;
  const h = history(30, 200);

  const decision = planSummarization(
    { windowTokens, prefixTokens: 2000, historyTokens: 6000, reservedOutputTokens },
    h,
    { countTokens: charCount },
  );
  const batch = selectSummaryBatch(h, decision.tokensToCompress, { countTokens: charCount });

  // 被摘要的必须是最旧的一段，且数量可观
  assert.ok(batch.messages.length > 0, '必须有轮次被摘要');
  assert.equal(batch.messages[0], h[0]);
  // 压缩量必须为正且不超过原历史
  assert.ok(decision.tokensToCompress > 0);
  assert.ok(decision.tokensToCompress < 6000);
  // 剩余轮次不得少于保留线
  assert.ok(h.length - batch.messages.length >= MIN_RECENT_TURNS);
});
