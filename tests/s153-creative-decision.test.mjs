import assert from 'node:assert/strict';
import test from 'node:test';
import { creativeDecisionPrompt, enabledCreativeKinds, prepareCreativeWork, readCreativeDecision, withCreativeSchema } from '../src/private-creative-work.js';
import { chatReplyDecisionSchema, parseChatReplyDecision } from '../src/life-chat-decision.js';
import { parseReplyPlan, assembleReply, replyPlanSchema } from '../src/private-reply-plan.js';

const work = { kind: 'website', title: '页边笔记', brief: '给每本书设计一张可展开的札记。' };
const ordinary = { action: 'reply', reply: '想把它做成可以翻开的书签。', lookup: null,
  contactBoundary: { kind: 'none', quote: '' }, browseIntent: null };
const kinds = ['website'];

test('explicit tool flags constrain private decisions and preserve plain replies and refusals', () => {
  assert.deepEqual(enabledCreativeKinds({ design: true, drawing: 1, website: false }), ['design']);
  assert.equal(withCreativeSchema(chatReplyDecisionSchema, []), chatReplyDecisionSchema);
  assert.equal(creativeDecisionPrompt([]), '');
  const schema = withCreativeSchema(chatReplyDecisionSchema, kinds);
  assert.deepEqual(schema.properties.creativeWork.anyOf[1].properties.kind.enum, kinds);
  assert.deepEqual(readCreativeDecision({ ...ordinary, creativeWork: null }, kinds, parseChatReplyDecision), ordinary);
  const selected = { ...ordinary, creativeWork: work };
  assert.deepEqual(readCreativeDecision(JSON.stringify(selected), kinds, parseChatReplyDecision), selected);
  assert.throws(() => readCreativeDecision(selected, [], parseChatReplyDecision));
  for (const modified of [
    { creativeWork: { ...work, recipient: 'bravo' } }, { creativeWork: { ...work, kind: 'drawing' } },
    { creativeWork: { ...work, brief: '' } }, { reply: '' },
    { reply: '[[pwa_history:{"q":"作品"}]]' }, { action: 'memory_more', reply: '' },
    { contactBoundary: { kind: 'pause', quote: '别来' }, reply: '' },
    { contactBoundary: { kind: 'resume', quote: '聊聊吧' } },
    { browseIntent: { delayMinutes: 15 } }, { privateThought: { action: '做', subject: '卡片' } }
  ]) {
    assert.throws(() => readCreativeDecision({ ...selected, ...modified }, kinds,
      value => parseChatReplyDecision(value, { allowBrowseIntent: true, allowPrivateThought: true })));
  }
});

test('two-stage planner preserves chosen work only for a speaking final action', () => {
  const context = { mode: 'life', creativeKinds: kinds };
  const plan = { control: { contextMore: false, contactBoundary: ordinary.contactBoundary, browseIntent: null, creativeWork: work },
    utterance: { goal: '一起做网页', points: ['把笔记排版'], evidenceRefs: [], requiredLiterals: [],
      contextKind: 'help', compressible: false }, presentation: { stickerName: null, moodProposal: null } };
  assert.ok(replyPlanSchema(context).properties.control.required.includes('creativeWork'));
  assert.deepEqual(assembleReply(plan, '我想试试。', context).creativeWork, work);
  assert.throws(() => parseReplyPlan({ ...plan, control: { ...plan.control, contextMore: true }, utterance: null }, context));
  assert.throws(() => parseReplyPlan(plan, { mode: 'life' }));
});

function fixture() {
  const events = [];
  const binding = { userId: 'user-a', scope: 'a', routeVersion: 2, generation: 3, taskKey: 'incoming-3' };
  const store = {
    claimCreativeWork(input) { events.push(['claim', input]); return { status: 'claimed', token: 'ticket' }; },
    finishCreativeWork(input) { events.push(['finish', input]); return { workId: 'success' }; },
    failCreativeWork(input) { events.push(['fail', input]); }
  };
  const api = { store, binding, proposal: work, assertCurrent: async () => {},
    draft: async proposal => { events.push(['draft', proposal]); return { marker: 'drafted for this exact title' }; },
    render: async input => { events.push(['render', input]); return { files: [] }; },
    describe: async result => { events.push(['receipt', result]); return '书签做好了。'; } };
  return { api, events };
}

test('original claim and real renderer receipt precede its caption; ready work reuses original bytes', async () => {
  const { api, events } = fixture();
  assert.deepEqual(await prepareCreativeWork(api), { workId: 'success', text: '书签做好了。' });
  assert.deepEqual(events.map(row => row[0]), ['claim', 'draft', 'render', 'finish', 'receipt']);
  assert.deepEqual(events[2][1].spec, { marker: 'drafted for this exact title' });
  assert.deepEqual(events[3][1], { ...api.binding, token: 'ticket', output: { files: [] } });
  assert.deepEqual(events[4][1], { status: 'ready', kind: 'website', title: work.title });
  events.length = 0;
  api.store.claimCreativeWork = () => ({ status: 'ready', workId: 'existing-work' });
  assert.equal((await prepareCreativeWork(api)).workId, 'existing-work');
  assert.deepEqual(events.map(row => row[0]), ['receipt']);
});

test('failed and superseded work never receives a success caption or releases a file', async () => {
  const { api, events } = fixture();
  api.render = async () => { throw Error('PRIVATE_TOOL_DIAGNOSTIC'); };
  const result = await prepareCreativeWork(api);
  assert.equal(result.workId, null); assert.match(result.text, /没有生成/);
  assert.equal(events.at(-1)[1].status, 'failed');
  assert.equal(events.find(row => row[0] === 'fail')[1].token, 'ticket');
  events.length = 0;
  let current = true;
  api.assertCurrent = async () => { if (!current) throw Error('superseded'); };
  api.render = async () => { current = false; return { files: [] }; };
  await assert.rejects(prepareCreativeWork(api), /superseded/);
  assert.deepEqual(events.map(row => row[0]), ['claim', 'draft', 'fail']);
});

test('overlapping task waits for the confirmed artifact and stops promptly on replacement', async () => {
  const { api, events } = fixture();
  let count = 0;
  api.store.claimCreativeWork = () => ++count === 1
    ? { status: 'running', leaseUntil: Date.now() + 5 } : { status: 'ready', workId: 'original' };
  const sent = await prepareCreativeWork(api);
  assert.equal(sent.workId, 'original');
  assert.deepEqual(events.map(row => row[0]), ['receipt']);
  events.length = 0;
  const stop = new AbortController();
  api.signal = stop.signal;
  api.store.claimCreativeWork = () => { stop.abort(); return { status: 'running', leaseUntil: Date.now() + 60000 }; };
  await assert.rejects(prepareCreativeWork(api), { name: 'AbortError' });
  assert.equal(events.length, 0);
});
