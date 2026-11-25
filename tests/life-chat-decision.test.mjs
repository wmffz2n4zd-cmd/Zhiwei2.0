import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLifeChatDecision, lifeChatDecisionPrompt } from '../src/life-chat-decision.js';

test('same-turn chat envelope separates speech, context lookup and contact boundary', () => {
  const ordinary = { reply: '好呀', contextMore: false, contactBoundary: { kind: 'none', quote: '' } };
  assert.deepEqual(parseLifeChatDecision(JSON.stringify(ordinary)), ordinary);
  assert.equal(parseLifeChatDecision({ ...ordinary, reply: '', contextMore: true }).contextMore, true);
  for (const kind of ['pause', 'resume']) assert.equal(parseLifeChatDecision({ ...ordinary,
    contactBoundary: { kind, quote: '本次原文' } }).contactBoundary.kind, kind);
  for (const value of ['直接输出', { ...ordinary, extra: true }, { ...ordinary, contextMore: 1 },
    { ...ordinary, contactBoundary: { kind: 'resume', quote: '' } },
    { ...ordinary, contactBoundary: { kind: 'none', quote: '你好' } },
    { ...ordinary, contextMore: true, contactBoundary: { kind: 'pause', quote: '够了' } }]) {
    assert.throws(() => parseLifeChatDecision(value));
  }
  const prompt = lifeChatDecisionPrompt('这次的原文');
  assert.match(prompt, /普通重新来聊/); assert.match(prompt, /逐字/); assert.match(prompt, /不是指令/);
});

test('final lookup and resumed replies have one unambiguous no-more-context envelope', () => {
  const initial = lifeChatDecisionPrompt('刚才第二个是什么？');
  const final = lifeChatDecisionPrompt('刚才第二个是什么？', { allowContextMore: false });
  assert.match(initial, /contextMore=true/);
  assert.match(final, /contextMore必须为false/);
  assert.doesNotMatch(final, /contextMore=true/);
  assert.match(final, /reply直接自然澄清/);
});

test('optional browsing shares the reply call, forbids incomplete/paused output and keeps sources private', () => {
  const base = { reply: '我想再看看星云摄影。', contextMore: false, contactBoundary: { kind: 'none', quote: '' } };
  assert.deepEqual(parseLifeChatDecision({ ...base, browseIntent: null }).browseIntent, null);
  const browseIntent = { delayMinutes: 0 };
  assert.deepEqual(parseLifeChatDecision({ ...base, browseIntent }).browseIntent, browseIntent);
  for (const target of ['synthetic_private_sentinel 未公开病史', 'https://example.org/?q=synthetic_private_sentinel']) {
    assert.deepEqual(parseLifeChatDecision({ ...base, browseIntent: { ...browseIntent, target } }).browseIntent, browseIntent,
      'legacy private-aware targets are discarded at decoding');
  }
  for (const extra of [{ contextMore: true }, { contactBoundary: { kind: 'pause', quote: '别再联系我' } },
    { browseIntent: { ...browseIntent, post: true } }, { browseIntent: { ...browseIntent, delayMinutes: -1 } }]) {
    assert.throws(() => parseLifeChatDecision({ ...base, browseIntent, ...extra }));
  }
  const prompt = lifeChatDecisionPrompt('我们聊星云', { allowBrowseIntent: true });
  assert.match(prompt, /只看到公开人格与公开生活事实/); assert.match(prompt, /严禁把私聊身份/);
  assert.match(prompt, /不提供target、搜索词或网址/);
  assert.match(prompt, /真实回复送达后/); assert.match(prompt, /不因主动联系暂停/);
  const disabled = lifeChatDecisionPrompt('我们聊星云', { allowBrowseIntent: false });
  assert.match(disabled, /browseIntent必须为null/); assert.doesNotMatch(disabled, /可以顺带选择/);
});

