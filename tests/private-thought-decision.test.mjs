import test from 'node:test';
import assert from 'node:assert/strict';
import { chatReplyDecisionSchema, lifeChatDecisionSchema, withPrivateThoughtSchema,
  parseChatReplyDecision, parseLifeChatDecision, chatReplyDecisionPrompt, lifeChatDecisionPrompt } from '../src/life-chat-decision.js';
import { replyPlanSchema, replyPlanPrompt, parseReplyPlan, assembleReply } from '../src/private-reply-plan.js';

const options = { allowPrivateThought: true, allowBrowseIntent: true };
const thought = { action: '周末读完', subject: '聊到的《城墙上的苔藓》' };
const boundary = { kind: 'none', quote: '' };
const common = { contactBoundary: boundary, browseIntent: null };
const routes = [
  { mode: 'life', control: { ...common, contextMore: false }, parse: parseLifeChatDecision,
    schema: lifeChatDecisionSchema, prompt: lifeChatDecisionPrompt },
  { mode: 'retrieval', control: { ...common, action: 'reply', lookup: null }, parse: parseChatReplyDecision,
    schema: chatReplyDecisionSchema, prompt: chatReplyDecisionPrompt }
];
const presentation = { stickerName: null, moodProposal: null };
const utterance = { goal: '接着谈文章', points: [], evidenceRefs: [], requiredLiterals: [], contextKind: 'casual', compressible: false };

for (const { mode, control, parse, schema, prompt } of routes) {
  test(mode + ' offers optional private capture on a final reply, with legacy envelopes still readable', () => {
    const old = { ...control, reply: '它写那块砖的地方真有意思。' };
    assert.deepEqual(parse(old, options), old);
    assert.deepEqual(parse(old), old);
    for (const privateThought of [null, thought]) {
      const value = { ...old, privateThought };
      assert.deepEqual(parse(JSON.stringify(value), options), value);
      assert.throws(() => parse(value));
    }
    const modelSchema = withPrivateThoughtSchema(schema, options);
    assert.ok(modelSchema.required.includes('privateThought'));
    assert.equal(modelSchema.properties.privateThought.anyOf[1].additionalProperties, false);
    assert.equal(withPrivateThoughtSchema(schema).properties.privateThought, undefined);
    assert.match(prompt('原消息', options), /对方的愿望/);
    assert.doesNotMatch(prompt('原消息'), /privateThought/);
  });

  test(mode + ' rejects ambiguous thoughts, extra fields and intermediate or conflicting actions', () => {
    const reply = { ...control, reply: '这个我挺感兴趣', privateThought: thought };
    for (const privateThought of [false, {}, { ...thought, extra: true }, { ...thought, action: '　 ' },
      { ...thought, action: 'a'.repeat(161) }, { ...thought, subject: '标题\n第二行' },
      { ...thought, subject: '两\u2028行' }, { ...thought, subject: '两\u0085行' }]) {
      assert.throws(() => parse({ ...reply, privateThought }, options));
    }
    const intermediate = mode === 'retrieval' ? { action: 'memory_more' } : { contextMore: true };
    for (const override of [{ reply: '　' }, { reply: '[[pwa_history:{"q":"原话"}]]' },
      { reply: '[[qq_mood:{"phase":"neutral"}]] [[qq_sticker:笑.png]] [[image:花朵.png]]' },
      { reply: '[[qq_context_more]]' }, { browseIntent: { delayMinutes: 3 } },
      { contactBoundary: { kind: 'pause', quote: '别聊了' }, reply: '' },
      { contactBoundary: { kind: 'resume', quote: '你继续' } },
      { ...intermediate, reply: '' }]) {
      assert.throws(() => parse({ ...reply, ...override }, options));
    }
    assert.deepEqual(parse({ ...reply, reply: '嗯。 [[sticker:笑.png]]' }, options).privateThought, thought);
  });

  test(mode + ' planner and writer preserve a private control across assembly', () => {
    const route = { mode, ...options, parseRetrievalDecision: parseChatReplyDecision };
    const old = { control, presentation, utterance };
    const plan = { control: { ...control, privateThought: thought }, presentation, utterance };
    assert.deepEqual(parseReplyPlan(old, route), old);
    assert.deepEqual(assembleReply(plan, '我还想再琢磨下开头。', route),
      { ...plan.control, reply: '我还想再琢磨下开头。' });
    assert.throws(() => parseReplyPlan(plan, { mode }));
    assert.throws(() => parseReplyPlan({ ...plan, control: { ...plan.control, browseIntent: { delayMinutes: 3 } } }, route));
    assert.throws(() => parseReplyPlan({ ...plan, control: { ...plan.control, contactBoundary: { kind: 'pause', quote: '停' } },
      utterance: null }, route));
    assert.throws(() => assembleReply(plan, ' ', route));
    assert.ok(replyPlanSchema(route).properties.control.required.includes('privateThought'));
    assert.match(replyPlanPrompt(route), /字段放在 control 内/);
  });
}

test('proactive, activity and raw planners do not offer private thought capture', () => {
  for (const mode of ['raw', 'proactive', 'conversation']) {
    assert.equal(replyPlanSchema({ ...options, mode }).properties.control.properties.privateThought, undefined);
    assert.doesNotMatch(replyPlanPrompt({ ...options, mode }), /privateThought/);
  }
});
