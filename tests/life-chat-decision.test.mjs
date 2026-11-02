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
