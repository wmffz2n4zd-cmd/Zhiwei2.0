import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { MoodState, bypassMood, stripMoodMarkers } from '../src/mood-state.js';
import { createUnifiedMemory, memoryScope } from '../src/unified-memory/index.js';

const minute = 60000;
const cause = '解谜卡住却不好意思承认';
const event = (text = '你好', id = 1, extra = {}) => ({
  type: 'private_message', senderId: '123456', text, raw: { message_id: id }, ...extra
});
const output = (phase = 'guarded', intensity = 1, reason = cause) =>
  `哼，等我想想。\n[[qq_mood:${JSON.stringify({ phase, cause: reason, intensity })}]]`;
async function fixture(t) {
  const base = resolve('runtime/tests');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'mood-'));
  t.after(async () => { if (resolve(dir).startsWith(base + sep)) await rm(dir, { recursive: true, force: true }); });
  let now = 1000000;
  const memoryPath = join(dir, 'memory.json');
  const memory = createUnifiedMemory({ memoryPath, now: () => now });
  const mood = new MoodState({ memory, now: () => now });
  const state = async e => {
    const row = await memory.readLatestState({ scope: memoryScope(e), source: 'qq-mood', topic: `mood:${e.senderId}` });
    return row ? { row, value: JSON.parse(row.summary) } : null;
  };
  const respond = async (e, text = output()) => {
    await mood.prepare(e);
    const visible = mood.finalize(text, e);
    const result = await mood.commit(e);
    return { visible, result };
  };
  return { memory, memoryPath, mood, state, respond, time: () => now, advance: n => { now += n; } };
}

test('mood persists only after delivered text, keeps its cause through disclosure and recovery', async t => {
  const f = await fixture(t), first = event();
  const prepared = await f.mood.prepare(first);
  assert.equal(prepared.active, false);
  assert.match(prepared.context, /默认自然友好/);
  assert.equal(f.mood.finalize(output(), first), '哼，等我想想。');
  assert.equal(await f.state(first), null, 'a generated reply alone is not a delivered reply');
  assert.equal((await f.mood.commit(first)).ok, true);
  const original = (await f.state(first)).value;
  f.advance(minute);
  const ask = event('怎么了，为什么不高兴？', 2);
  assert.match((await f.mood.prepare(ask)).context, new RegExp(cause));
  f.mood.finalize(output('explained', 1, '偷偷换一个理由'), ask);
  assert.equal((await f.mood.commit(ask)).ok, true);
  assert.equal((await f.state(ask)).value.cause, cause);
  assert.equal((await f.state(ask)).value.phase, 'explained');
  const comfort = event('卡题不是丢脸，我们换个角度一起看', 3);
  await f.respond(comfort, output('easing'));
  const easing = (await f.state(comfort)).value;
  assert.equal(easing.phase, 'easing');
  assert.equal(easing.startedAt, original.startedAt);
  assert.equal(easing.expiresAt, original.expiresAt);
  await f.respond(event('先歇一会儿也没关系', 4), output('neutral', 0));
  const recovered = await f.mood.prepare(event('聊点别的吧', 5));
  assert.equal(recovered.active, false);
  assert.match(recovered.context, /不再新开一轮生气/);
});

test('private senders keep independent hidden mood state while group events are bypassed', async t => {
  const f = await fixture(t);
  const privateChat = event();
  await f.respond(privateChat);
  const other = event('你好', 2, { senderId: '654321' });
  assert.equal((await f.mood.prepare(other)).active, false);
  assert.doesNotMatch((await f.mood.prepare(other)).context, new RegExp(cause));
  for (const [i, type] of ['group_at', 'group_message', 'private_message'].entries()) {
    const e = event('为什么呀', i + 3, { type, groupId: '111111' });
    assert.equal((await f.mood.prepare(e)).bypassed, true);
    assert.equal((await f.mood.prepare(e)).context, '');
    f.mood.finalize(output('neutral', 0), e);
    assert.equal((await f.mood.commit(e)).ok, false);
  }
  const followup = event('为什么呀', 6);
  assert.equal((await f.mood.prepare(followup)).active, true);
  assert.equal(await f.memory.readLatestState({ scope: 'qq:group:111111', source: 'qq-mood', topic: 'mood:123456' }), null);
  assert.doesNotMatch(await f.memory.formatForPrompt({ scope: 'qq:private:123456' }), /qq-mood|解谜卡住/);
  assert.equal((await f.memory.read({ scope: 'qq:private:123456' })).entries.length, 0);
});

test('time softens mood without reply-driven expiry extension and applies a new-scene cooldown', async t => {
  const f = await fixture(t), first = event();
  await f.respond(first);
  const dismiss = event('你就是矫情', 2);
  await f.respond(dismiss, output('explained', 2));
  assert.equal((await f.state(dismiss)).value.intensity, 2);
  f.advance(21 * minute);
  const late = event('我听懂了，你是不想被嘲笑', 3);
  const context = await f.mood.prepare(late);
  assert.match(context.context, /"phase":"easing"/);
  assert.match(context.context, /"intensity":1/);
  f.mood.finalize(output('explained', 1), late); await f.mood.commit(late);
  assert.equal((await f.mood.prepare(event('继续聊', 4))).active, true, 'decay must not be subtracted twice');
  f.advance(24 * minute);
  const expired = event('又见面了', 5);
  assert.equal((await f.mood.prepare(expired)).active, false);
  f.mood.finalize(output(), expired);
  assert.equal((await f.mood.commit(expired)).ok, false);
  f.advance(75 * minute);
  const later = event('下午好', 6);
  assert.equal((await f.respond(later)).result.ok, true);
  assert.equal((await f.state(later)).value.startedAt, f.time());
});

test('ordinary silence, busyness, quotations and reassurance cannot escalate irritation', async t => {
  const f = await fixture(t);
  await f.respond(event());
  for (const [i, text] of ['我要去上课了，晚点回来', '换个话题吧', '我不是觉得你矫情', '他说“你就是矫情”', '不要说你矫情，你可以有自己的感受'].entries()) {
    const e = event(text, i + 2);
    const proposal = { phase: 'explained', cause, intensity: 2, signal: 'dismissal' };
    await f.respond(e, `哼。[[qq_mood:${JSON.stringify(proposal)}]]`);
    assert.equal((await f.state(e)).value.intensity, 1, text);
  }
  const other = event('回来了', 30, { senderId: '222222' });
  await f.respond(other, output('guarded', 1, '因为你没有回消息而忽视我'));
  assert.equal(await f.state(other), null);
  const dismissal = event('嗯嗯行了行了，这种事谁会认真听啊', 31);
  const semanticProposal = { phase: 'explained', cause, intensity: 2, signal: 'dismissal' };
  await f.respond(dismissal, `我是在认真说的。[[qq_mood:${JSON.stringify(semanticProposal)}]]`);
  assert.equal((await f.state(dismissal)).value.intensity, 2);
});

test('commands, serious requests, other recipients and disabled mode bypass mood without altering state', async t => {
  const f = await fixture(t);
  await f.respond(event()); const before = (await f.state(event())).row.id;
  for (const [i, extra] of [
    { text: '/状态' }, { text: '@知微 /关机', type: 'group_at', groupId: '111111' },
    { text: '救命，我呼吸困难' }, { text: '我很难过，需要帮助' },
    { text: '听他说', hasReplySegment: true, isReplyToSelf: false }
  ].entries()) {
    const e = event('你好', 20 + i, extra);
    assert.equal((await f.mood.prepare(e)).bypassed, true);
    assert.equal(f.mood.finalize(output(), e), '哼，等我想想。');
    assert.equal((await f.mood.commit(e)).ok, false);
  }
  assert.equal((await f.state(event())).row.id, before);
  const disabled = new MoodState({ memory: f.memory, enabled: false });
  assert.equal((await disabled.prepare(event())).context, '');
  assert.equal(bypassMood(null), true);
});

test('invalid private identities never access fallback memory or keep a pending change', async () => {
  const mood = new MoodState({ memory: {
    readLatestState: async () => assert.fail('invalid identity must not read memory'),
    compareAndSetState: async () => assert.fail('invalid identity must not write memory')
  } });
  for (const extra of [{ senderId: undefined }, { senderId: '   ' }, { senderId: {} },
    { senderId: 0 }, { senderId: NaN }, { senderId: Infinity }, { raw: { group_id: '111111' } }]) {
    const e = event('你好', 1, extra);
    assert.equal((await mood.prepare(e)).bypassed, true);
    assert.equal(mood.finalize(output(), e), '哼，等我想想。');
    assert.equal((await mood.commit(e)).ok, false);
  }
});

test('internal markers are stripped even when malformed, duplicated, fenced or context expansion is requested', async t => {
  const f = await fixture(t);
  for (const [i, raw] of ['正常回复 [[qq_mood:{broken}]]', '正常回复 [[qq_mood:{"phase":',
    '正常回复 [qq_mood:bad]', '正常回复\n```json\n[[qq_mood:bad]]\n```',
    output() + '\n' + output(), '[[qq_context_more]]\n[[qq_mood:{"phase":"guarded","cause":"杯子不见了","intensity":1}]]',
    '[[qq_mood:{"phase":"guarded","cause":"杯子不见了","intensity":1}]]'].entries()) {
    const e = event('你好', i + 1);
    await f.mood.prepare(e); const visible = f.mood.finalize(raw, e);
    assert.doesNotMatch(visible, /qq_mood|phase|intensity|杯子不见了/);
    assert.equal((await f.mood.commit(e)).ok, false);
  }
  assert.equal(stripMoodMarkers('好啦 [[qq_sticker:收到.jpg]]\n[[qq_mood:bad]]'), '好啦 [[qq_sticker:收到.jpg]]');
});

test('state rejects stale concurrent commits, duplicate events, cleared sessions and expired delivery', async t => {
  const f = await fixture(t), a = event('你好', 1), b = event('你怎么了', 2);
  await Promise.all([f.mood.prepare(a), f.mood.prepare(b)]);
  f.mood.finalize(output(), a); f.mood.finalize(output('guarded', 1, '另一件事'), b);
  assert.equal((await f.mood.commit(b)).ok, true);
  assert.equal((await f.mood.commit(a)).ok, false);
  const repeat = event('你怎么了', 2);
  await f.respond(repeat, output('neutral', 0));
  assert.equal((await f.state(repeat)).value.phase, 'guarded');
  const cleared = event('解释一下', 3);
  await f.mood.prepare(cleared); f.mood.finalize(output('explained'), cleared);
  await f.memory.clear({ scope: 'qq:private:123456' });
  assert.equal((await f.mood.commit(cleared)).ok, false);
  const delayed = event('等你回', 4);
  await f.mood.prepare(delayed); f.mood.finalize(output(), delayed);
  f.advance(45 * minute);
  assert.equal((await f.mood.commit(delayed)).ok, false);
});

test('separate memory stores and controller instances cannot share pending snapshots', async t => {
  const one = await fixture(t), two = await fixture(t), e = event();
  await one.mood.prepare(e); one.mood.finalize(output(), e);
  await two.mood.prepare(e);
  assert.equal((await two.mood.commit(e)).ok, false);
  assert.equal((await one.mood.commit(e)).ok, true);
  assert.equal(await two.state(e), null);
  const restarted = new MoodState({ memory: createUnifiedMemory({ memoryPath: one.memoryPath }), now: one.time });
  assert.equal((await restarted.prepare(event('为什么', 2))).active, true);
});
