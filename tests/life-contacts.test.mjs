import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createLifeContacts, isExplicitContactStop, isExplicitContactInvitation, ownContactEvidence } from '../src/life-contacts.js';

const NOW = Date.parse('2026-10-29T01:00:00Z');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = (id, text = '来聊聊', user = '123') => ({ type: 'private_message', senderId: user, text,
  raw: { message_id: id, message: [{ type: 'text', data: { text } }] } });
const intent = (id, token, extra = {}) => ({ id, scope: token.scope, epoch: token.epoch,
  sources: [{ kind: 'life', ref: 'event:known-source' }], reason: '刚刚的经历让我想聊两句', notBefore: NOW, expiresAt: NOW + 60000, ...extra });
const boundary = (token, e, action = 'pause', evidence = e.text) => ({ token, event: e,
  decision: { action, basis: action === 'pause' ? 'contextual-impatience' : 'explicit-invitation', evidence,
    reason: action === 'pause' ? '本次本人表达不耐烦' : '本次本人明确重新邀请' } });

async function fixture(t, options = {}) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'life-contacts-')); let at = NOW;
  const instances = [], timeline = { snapshot: () => ({}), availability: () => ({ busy: false }) };
  const open = async extra => {
    const instance = await createLifeContacts({ directory, timeline, now: () => at, ...options, ...extra });
    instances.push(instance); return instance;
  };
  t.after(async () => {
    for (const instance of instances) await instance.close().catch(() => {});
    assert.ok(directory.startsWith(base + sep)); await rm(directory, { recursive: true, force: true });
  });
  return { directory, open, coordinator: await open(), setTime: value => { at = value; } };
}

test('direct stop requests include limited imperative questions without treating mood or quotations as consent', () => {
  const positive = ['别烦我了', '请不要再打扰我', '别再找我了。', '你先别给我发消息了', '先别跟我说话',
    '停止给我发消息', '你能不能别再找我？', '可不可以别烦我了？', '让我安静一会儿', '先让我一个人待着',
    '我现在不想聊天了', '别缠着我了', '别逗我了', 'leave me alone', 'Please stop messaging me.',
    "Don't contact me anymore.", "Don't bother me, I'm trying to work.", 'Do not message me again.', 'Can you please stop messaging me?', 'Could you leave me alone, please?'];
  const negative = ['忙着呢', '嗯', '哦', '好', '我有点烦', '不要不理我', '不是让你别再找我', '你不理我了吗？',
    '你觉得别烦我是什么意思？', '如果我说别烦我，你怎么办？', '他说别烦我', '翻译：leave me alone',
    '他说：\n别烦我了', '他对我说\n别再找我了', '朋友给我发了这些话：\n别烦我了', '这句台词是：\n不要再联系我。',
    'My friend said:\nLeave me alone.', 'He said, stop messaging me.', 'I heard someone say, leave me alone.',
    '我不是说，别烦我', '“别烦我了”', '> 别再找我', '```\n别再找我\n```', '/执行 别烦我'];
  for (const text of positive) assert.equal(isExplicitContactStop(event(1, text)), true, text);
  for (const text of negative) assert.equal(isExplicitContactStop(event(1, text)), false, text);
});

test('a reply segment or a separate quoted block does not hide the sender own stop text', () => {
  const e = event(1, '别再找我了'); e.hasReplySegment = true; e.replyContext = { text: '请继续找我' };
  e.raw.message.unshift({ type: 'reply', data: { id: 3 } });
  assert.equal(isExplicitContactStop(e), true);
  assert.equal(isExplicitContactStop(event(2, '他说“别烦我”。\n别再找我了')), true);
  assert.equal(isExplicitContactStop(event(3, '> 他说别烦我\n\n别再找我了')), true);
  assert.equal(isExplicitContactStop(event(4, '他说：\n别烦我\n\n请不要再给我发消息')), true);
  assert.equal(isExplicitContactStop({ ...e, text: '别烦我', raw: { message_id: 2, message: [{ type: 'record', data: { text: '别烦我' } }] } }), false);
  assert.equal(isExplicitContactStop({ ...e, groupId: '456' }), false);
});

test('negated attribution and historical quotations are not transformed into requests after punctuation', () => {
  for (const denial of ['没', '没有', '从未', '不曾', '从来没', '不是']) {
    for (const verb of ['说', '说过', '让你说', '叫你说', '要求你说']) {
      for (const separator of ['，', '\n']) {
        const text = `我${denial}${verb}${separator}别再联系我`;
        assert.equal(isExplicitContactStop(event(1, text)), false, text);
      }
    }
  }
  for (const text of ['我前面说的是\n别再找我\n那时候是在赌气', '我说的那句\n别再找我\n不是给你的',
    '我那天告诉他\n别烦我了\n现在想想有点后悔', '有人留下了一段话，别烦我', '我没有要求你说\n别烦我']) {
    assert.equal(isExplicitContactStop(event(1, text)), false, text);
  }
  for (const text of ['我没心情聊天，别烦我', '我没有空，别再找我了', '我现在很忙，别再给我发消息',
    '我朋友说：\n谢谢你。\n\n现在别再找我了。', 'My friend said:\nThank you.\n\nPlease leave me alone.']) {
    assert.equal(isExplicitContactStop(event(1, text)), true, text);
  }
});

test('incoming stop cancels old tokens by scope and permits new normal replies without restoring proactive contact', async t => {
  const { coordinator: c } = await fixture(t);
  const old = await c.observeIncoming(event(1)), other = await c.observeIncoming(event(2, 'hello', '456'));
  const stopping = c.observeIncoming(event(3, '别再找我'));
  assert.equal(c.isCurrent(old), false, 'synchronous fence precedes durable fsync');
  assert.equal(c.isCurrent(other), true);
  const stop = await stopping;
  assert.equal(stop.epoch, old.epoch + 1); assert.equal(c.isCurrent(stop), false);
  const fresh = await c.observeIncoming(event(4, '我又回来了'));
  assert.equal(c.isCurrent(fresh), true); assert.equal(c.isCurrent(fresh, { proactive: true }), false);
  assert.equal(c.isCurrent(old), false); assert.equal(c.snapshot(other.scope).contacts.length, 1);
  assert.equal(c.snapshot(other.scope).intents.length, 0);
});

test('latest ordinary guard fences a pending incoming write without requiring proactive permission', async t => {
  const { coordinator: c } = await fixture(t);
  const first = await c.observeIncoming(event(1));
  const incoming = c.observeIncoming(event(2, '新的消息还在持久化'));
  assert.equal(c.capture(first.scope).sequence, first.sequence, 'the previous durable receipt is still visible');
  assert.equal(c.isCurrent(first), true, 'ordinary old replies retain their existing epoch behavior');
  assert.equal(c.isCurrent(first, { latest: true }), false, 'synchronous pending ingress fence closes the fsync window');
  const latest = await incoming;
  assert.equal(c.isCurrent(first, { latest: true }), false);
  assert.equal(c.isCurrent(latest, { latest: true }), true);
  await c.observeIncoming(event(3, '别烦我'));
  const returned = await c.observeIncoming(event(4, '我回来继续聊了'));
  assert.equal(c.isCurrent(returned, { proactive: true }), false);
  assert.equal(c.isCurrent(returned, { latest: true }), true, 'a fresh normal conversation may close naturally while proactive contact stays paused');
});

test('stop receipts and ordinary retry epochs survive restart without resurrecting old input', async t => {
  const f = await fixture(t), c = f.coordinator;
  const old = await c.observeIncoming(event(1)), stop = await c.observeIncoming(event(2, '别烦我'));
  const fresh = await c.observeIncoming(event(3, '新话题')); await c.close();
  const restarted = await f.open();
  const duplicate = await restarted.observeIncoming(event(2, '别烦我'));
  assert.deepEqual(duplicate, { ...stop, duplicate: true });
  assert.equal(restarted.isCurrent(fresh), true);
  assert.equal(restarted.isCurrent(await restarted.observeIncoming(event(1))), false);
  assert.equal(restarted.snapshot().contacts[0].epoch, 1);
  assert.equal(restarted.snapshot().contacts[0].sequence, 3);
  assert.equal(restarted.isCurrent(old), false);
});

test('concurrent duplicate stop messages commit one epoch and all waiters receive the same receipt', async t => {
  const { coordinator: c } = await fixture(t);
  await c.observeIncoming(event(1));
  const tokens = await Promise.all(Array.from({ length: 8 }, () => c.observeIncoming(event(2, '别再找我'))));
  assert.equal(tokens.filter(token => !token.duplicate).length, 1);
  assert.equal(c.snapshot().contacts[0].epoch, 1);
  assert.ok(tokens.every(token => token.epoch === 1 && token.sequence === 2 && token.stop));
  const fresh = await c.observeIncoming(event(3)); assert.equal(c.isCurrent(fresh), true);
});

test('ordinary duplicate tokens may resume admission after a 503; malformed and foreign tokens fail closed', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1));
  const retry = await c.observeIncoming(event(1)); assert.equal(retry.duplicate, true); assert.equal(c.isCurrent(retry), true);
  for (const bad of [null, {}, { ...token, stop: undefined }, { ...token, epoch: token.epoch + 1 },
    { ...token, sequence: token.sequence + 1 }, { ...token, scope: 'qq:private:456' }, { ...token, scope: 'qq:group:123' }]) assert.equal(c.isCurrent(bad), false);
  await assert.rejects(c.observeIncoming({ ...event(2), raw: { group_id: '456' } }), /private participant/);
  await assert.rejects(c.observeIncoming({ ...event(2), senderId: '0' }), /private participant/);
  await assert.rejects(c.observeIncoming(event(1, 'different content')), /different content/);
  assert.equal(c.isCurrent(token), true);
});

test('sendIfCurrent starts synchronously at its queue boundary and does not hold stop behind a slow transport', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1));
  const started = deferred(), finish = deferred(); let sends = 0;
  const sending = c.sendIfCurrent(token, () => { sends++; started.resolve(); return finish.promise; });
  await started.promise;
  await c.observeIncoming(event(2, '别烦我'));
  assert.equal(c.isCurrent(token), false);
  assert.equal((await c.sendIfCurrent(token, () => { sends++; return { ok: true }; })).ok, false);
  finish.resolve({ ok: true }); assert.deepEqual(await sending, { ok: true }); assert.equal(sends, 1);
});

test('a stop observed before queued send cancels it and ordinary transport failures are not silently retried', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1)); let sends = 0;
  const queued = c.sendIfCurrent(token, () => { sends++; return { ok: true }; });
  const stop = c.observeIncoming(event(2, '别烦我'));
  assert.equal((await queued).ok, false); await stop; assert.equal(sends, 0);
  const fresh = await c.observeIncoming(event(3));
  await assert.rejects(c.sendIfCurrent(fresh, () => { sends++; throw Error('transport'); }), /transport/);
  assert.equal(sends, 1);
});

test('contact source references enforce same-object isolation before committing an intent', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1));
  await assert.rejects(c.enqueue(intent('bad', token, { sources: [{ kind: 'chat', ref: 'memory:other', scope: 'qq:private:456' }] })), /another private participant/);
  await assert.rejects(c.enqueue(intent('bad', token, { sources: [] })), /source references/);
  await assert.rejects(c.enqueue(intent('bad', token, { sources: [{ kind: 'chat' }] })), /source reference/);
  assert.equal(c.snapshot().intents.length, 0);
  assert.equal((await c.enqueue(intent('valid', token, { sources: [{ kind: 'chat', ref: 'memory:own', scope: token.scope }] }))).accepted, true);
  assert.equal(c.snapshot('qq:private:456').intents.length, 0);
});

test('generation and send claims persist before callbacks and dispatch at most one attempt', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1)), input = intent('first', token);
  await c.enqueue(input); const ticket = await c.claimGeneration('first');
  assert.equal(JSON.parse(await readFile(c.file, 'utf8')).intents[0].status, 'generating');
  assert.equal(await c.claimGeneration('first'), null);
  assert.deepEqual(await c.completeGeneration(ticket, '刚才碰到了件小事。'), { ready: true }); let calls = 0;
  const dispatch = () => c.dispatch(ticket, async text => {
    calls++; assert.equal(text, '刚才碰到了件小事。'); assert.equal(JSON.parse(await readFile(c.file, 'utf8')).intents[0].status, 'sending'); return { ok: true };
  });
  const results = await Promise.all([dispatch(), dispatch()]);
  assert.equal(results.filter(result => result.ok).length, 1); assert.equal(calls, 1);
  assert.equal(c.snapshot().intents[0].status, 'sent'); assert.equal(c.snapshot().intents[0].replyText, undefined);
  assert.equal((await c.enqueue(input)).duplicate, true); assert.equal(await c.claimGeneration('first'), null);
  await assert.rejects(c.enqueue({ ...input, reason: 'changed reason' }), /different content/);
});

test('stop cancels pending and generating work, late generation results cannot revive cancelled claims', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1));
  await c.enqueue(intent('pending', token)); await c.enqueue(intent('generating', token));
  const ticket = await c.claimGeneration('generating'); await c.observeIncoming(event(2, '别逗我了'));
  assert.equal((await c.completeGeneration(ticket, '旧生成结果')).ready, false);
  assert.equal((await c.failGeneration(ticket)).finished, false);
  assert.equal(await c.claimGeneration('pending'), null);
  assert.ok(c.snapshot().intents.every(item => item.status === 'cancelled'));
  const fresh = await c.observeIncoming(event(3));
  assert.equal((await c.enqueue(intent('new-proactive', fresh))).accepted, false);
  assert.equal((await c.sendIfCurrent(fresh, () => ({ ok: true }))).ok, true);
});

test('stop cancels prepared text before a queued dispatch touches the transport', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1));
  await c.enqueue(intent('ready', token)); const ticket = await c.claimGeneration('ready'); await c.completeGeneration(ticket, '准备好了');
  let calls = 0; const dispatch = c.dispatch(ticket, () => { calls++; return { ok: true }; });
  const stopping = c.observeIncoming(event(2, '别烦我')); await stopping;
  assert.equal((await dispatch).ok, false); assert.equal(calls, 0); assert.equal(c.snapshot().intents[0].status, 'cancelled');
});

test('network already started cannot be recalled; its completion does not undo a later stop', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1));
  await c.enqueue(intent('in-flight', token)); const ticket = await c.claimGeneration('in-flight'); await c.completeGeneration(ticket, '发送中');
  const started = deferred(), finish = deferred();
  const dispatch = c.dispatch(ticket, () => { started.resolve(); return finish.promise; }); await started.promise;
  await c.observeIncoming(event(2, '别烦我'));
  finish.resolve({ ok: true }); assert.equal((await dispatch).ok, true);
  assert.equal(c.snapshot().contacts[0].paused, true); assert.equal(c.snapshot().contacts[0].epoch, 1);
  assert.equal((await c.dispatch(ticket, () => { throw Error('must not retry'); })).ok, false);
});

test('failed and uncertain proactive sends are terminal and never automatically retry', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1));
  const outcomes = [() => ({ ok: false }), () => ({ ok: false, uncertain: true }), () => undefined, () => { throw Error('connection reset'); }];
  for (const [index, callback] of outcomes.entries()) {
    const id = `intent:${index}`; await c.enqueue(intent(id, token)); const ticket = await c.claimGeneration(id);
    await c.completeGeneration(ticket, '一条主动消息'); const result = await c.dispatch(ticket, callback);
    assert.equal(result.status, index === 0 ? 'failed' : 'uncertain');
    assert.equal(await c.claimGeneration(id), null); assert.equal((await c.dispatch(ticket, callback)).ok, false);
  }
});

test('generation failure explicitly closes the claim so a later distinct intent can proceed', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1));
  await c.enqueue(intent('failed', token)); await c.enqueue(intent('later', token)); const ticket = await c.claimGeneration('failed');
  await assert.rejects(c.completeGeneration(ticket, ''), /contact reply/); assert.equal(await c.claimGeneration('later'), null);
  assert.deepEqual(await c.failGeneration(ticket), { finished: true, status: 'failed' });
  assert.equal(await c.claimGeneration('failed'), null); assert.ok(await c.claimGeneration('later'));
  assert.equal((await c.completeGeneration(ticket, 'late result')).ready, false);
});

test('expiry and not-before gates prevent late or premature contact without moving the window', async t => {
  const f = await fixture(t), c = f.coordinator, token = await c.observeIncoming(event(1));
  await c.enqueue(intent('future', token, { notBefore: NOW + 10000 })); assert.equal(await c.claimGeneration('future'), null);
  f.setTime(NOW + 10000); const ticket = await c.claimGeneration('future'); assert.ok(ticket);
  f.setTime(NOW + 60000); assert.equal((await c.completeGeneration(ticket, 'too late')).ready, false);
  assert.equal(c.snapshot().intents[0].status, 'cancelled');
  await assert.rejects(c.enqueue(intent('too-long', token, { expiresAt: NOW + 2 * 86400000 })), /lifetime/);
});

test('the send boundary rechecks the original time window after a clock rollback', async t => {
  const f = await fixture(t), c = f.coordinator, token = await c.observeIncoming(event(1));
  await c.enqueue(intent('window', token, { notBefore: NOW + 10000 }));
  f.setTime(NOW + 10000); const ticket = await c.claimGeneration('window'); await c.completeGeneration(ticket, 'ready');
  f.setTime(NOW + 5000); let calls = 0;
  assert.equal((await c.dispatch(ticket, () => { calls++; return { ok: true }; })).ok, false); assert.equal(calls, 0);
  f.setTime(NOW + 12000); assert.equal((await c.dispatch(ticket, () => { calls++; return { ok: true }; })).ok, true); assert.equal(calls, 1);
});

test('restart marks interrupted generation and transport claims uncertain without calling either again', async t => {
  const f = await fixture(t), c = f.coordinator, token = await c.observeIncoming(event(1));
  await c.enqueue(intent('generation', token)); const first = await c.claimGeneration('generation'); await c.close();
  const second = await f.open(); assert.equal(second.snapshot().intents[0].status, 'uncertain');
  assert.equal((await second.completeGeneration(first, 'late')).ready, false); assert.equal(await second.claimGeneration('generation'), null);
  await second.enqueue(intent('transport', token)); const ticket = await second.claimGeneration('transport'); await second.completeGeneration(ticket, 'prepared'); await second.close();
  // A persisted claim is exactly the state left after a process dies between
  // transport invocation and response. The reboot must not guess its outcome.
  const saved = JSON.parse(await readFile(second.file, 'utf8')); saved.intents.find(item => item.id === 'transport').status = 'sending';
  await writeFile(second.file, JSON.stringify(saved)); const third = await f.open();
  assert.equal(third.snapshot().intents[1].status, 'uncertain');
  assert.equal((await third.dispatch(ticket, () => { throw Error('must not send'); })).ok, false);
});

test('cancelled intents and stop epochs remain terminal through ordinary reentry and restart', async t => {
  const f = await fixture(t), c = f.coordinator, token = await c.observeIncoming(event(1));
  const input = intent('cancelled', token); await c.enqueue(input); const ticket = await c.claimGeneration('cancelled');
  await c.observeIncoming(event(2, '别再联系我')); const fresh = await c.observeIncoming(event(3)); await c.close();
  const next = await f.open(); assert.equal(next.isCurrent(fresh), true); assert.equal(next.isCurrent(fresh, { proactive: true }), false);
  assert.equal((await next.enqueue(input)).status, 'cancelled'); assert.equal((await next.completeGeneration(ticket, 'old')).ready, false);
  assert.equal((await next.dispatch(ticket, () => { throw Error('must not send'); })).ok, false);
});

test('initialized files cannot silently reset when either state or marker disappears', async t => {
  const f = await fixture(t), c = f.coordinator; await c.observeIncoming(event(1, '别再找我')); await c.close();
  const good = await readFile(c.file); await unlink(c.file);
  await assert.rejects(f.open(), /missing/); await writeFile(c.file, good);
  const marker = await readFile(c.marker); await unlink(c.marker);
  await assert.rejects(f.open(), /missing/); await writeFile(c.marker, marker);
  assert.equal((await f.open()).snapshot().contacts[0].paused, true);
});

test('corrupt state and inconsistent initialization are rejected without rewriting evidence', async t => {
  const f = await fixture(t), c = f.coordinator; await c.observeIncoming(event(1)); await c.close();
  const good = await readFile(c.file, 'utf8'); await writeFile(c.file, '{bad json');
  await assert.rejects(f.open()); assert.equal(await readFile(c.file, 'utf8'), '{bad json');
  await writeFile(c.file, good); const corrupt = JSON.parse(good); corrupt.contacts[0].epoch = 3;
  await writeFile(c.file, JSON.stringify(corrupt)); await assert.rejects(f.open(), /Inconsistent contact history/);
  await writeFile(c.file, good); await writeFile(c.marker, JSON.stringify({ version: 1, storeId: '0'.repeat(36) }));
  await assert.rejects(f.open(), /does not match/);
});

test('failed stop persistence blocks all sends and preserves the previous durable state', async t => {
  const f = await fixture(t), c = f.coordinator, token = await c.observeIncoming(event(1));
  const good = await readFile(c.file); await rename(c.file, c.file + '.saved'); await mkdir(c.file);
  await assert.rejects(c.observeIncoming(event(2, '别烦我')), /regular file/);
  assert.equal(c.isCurrent(token), false);
  await assert.rejects(c.sendIfCurrent(token, () => { throw Error('must not send'); }), /needs recovery/);
  assert.deepEqual(await readFile(c.file + '.saved'), good);
  await rmdir(c.file); await rename(c.file + '.saved', c.file);
});

test('receipt capacity preserves all old epochs and fails closed instead of evicting stop history', async t => {
  const { coordinator: c } = await fixture(t, { policy: { maxReceipts: 3 } });
  await c.observeIncoming(event(1)); await c.observeIncoming(event(2, '别烦我')); const fresh = await c.observeIncoming(event(3));
  await assert.rejects(c.observeIncoming(event(4)), /capacity exceeded/); assert.equal(c.isCurrent(fresh), false);
  assert.equal(JSON.parse(await readFile(c.file, 'utf8')).contacts[0].receipts.length, 3);
});

test('intent capacity never drops a terminal attempt tombstone to permit a replay', async t => {
  const { coordinator: c } = await fixture(t, { policy: { maxIntents: 1 } }), token = await c.observeIncoming(event(1));
  await c.enqueue(intent('first', token)); const ticket = await c.claimGeneration('first'); await c.failGeneration(ticket);
  await assert.rejects(c.enqueue(intent('second', token)), /capacity exceeded/);
  assert.equal(JSON.parse(await readFile(c.file, 'utf8')).intents[0].status, 'failed'); assert.equal(c.isCurrent(token), false);
});

test('close waits for in-flight transport and prohibits new operations', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1));
  const started = deferred(), finish = deferred(); let closed = false;
  const sending = c.sendIfCurrent(token, () => { started.resolve(); return finish.promise; }); await started.promise;
  const closing = c.close().then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  await assert.rejects(c.observeIncoming(event(2)), /closed/); assert.equal(c.isCurrent(token), false);
  finish.resolve({ ok: true }); await sending; await closing; assert.equal(closed, true);
});

test('contextual pause synchronously fences its triggering reply and cancels old proactive claims', async t => {
  const { coordinator: c } = await fixture(t), e = event(1, '你怎么还没说完，我都听烦了'), token = await c.observeIncoming(e);
  const other = await c.observeIncoming(event(2, 'hello', '456'));
  await c.enqueue(intent('old', token)); const ticket = await c.claimGeneration('old');
  const applying = c.applyDecision(boundary(token, e));
  assert.equal(c.isCurrent(token), false); assert.equal(c.isCurrent(other), true);
  assert.deepEqual(await applying, { applied: true, action: 'pause', epoch: 1, paused: true });
  assert.equal((await c.completeGeneration(ticket, '不应发出')).ready, false);
  assert.equal(c.snapshot(token.scope).intents[0].status, 'cancelled');
  const saved = JSON.parse(await readFile(c.file, 'utf8'));
  assert.equal(saved.contacts[0].receipts[0].epoch, 0);
  assert.equal(saved.contacts[0].receipts[0].decision.action, 'pause');
  assert.equal(saved.contacts[0].receipts[0].decision.evidence, undefined);
  assert.match(saved.contacts[0].receipts[0].decision.evidenceHash, /^[a-f0-9]{64}$/);
});

test('an evidenced new invitation restores proactive permission without resurrecting epochs or intents', async t => {
  const f = await fixture(t), c = f.coordinator, old = await c.observeIncoming(event(1));
  await c.enqueue(intent('old', old)); await c.observeIncoming(event(2, '别再找我'));
  const hello = await c.observeIncoming(event(3, 'hi')); assert.equal(c.isCurrent(hello, { proactive: true }), false);
  const e = event(4, '以后可以主动找我聊聊了'), token = await c.observeIncoming(e);
  assert.deepEqual(await c.applyDecision(boundary(token, e, 'resume')), { applied: true, action: 'resume', epoch: 1, paused: false });
  assert.equal(c.isCurrent(token, { proactive: true }), true); assert.equal(c.isCurrent(old), false);
  assert.equal(c.snapshot().intents[0].status, 'cancelled'); await c.close();
  const restarted = await f.open();
  assert.equal(restarted.isCurrent(token, { proactive: true }), true); assert.equal(restarted.isCurrent(old), false);
  assert.equal(await restarted.claimGeneration('old'), null);
});

test('boundary decisions are once per authenticated receipt and stale model judgments cannot change new input', async t => {
  const { coordinator: c } = await fixture(t), e = event(1, '你这样说我真的受不了了'), token = await c.observeIncoming(e);
  const outcomes = await Promise.all([c.applyDecision(boundary(token, e)), c.applyDecision(boundary(token, e))]);
  assert.equal(outcomes.filter(result => result.applied).length, 1); assert.equal(outcomes.filter(result => result.duplicate).length, 1);
  const invite = event(2, '你以后继续来找我聊天吧'), resumed = await c.observeIncoming(invite);
  const next = await c.observeIncoming(event(3, '不过先听我说一件事'));
  assert.deepEqual(await c.applyDecision(boundary(resumed, invite, 'resume')), { applied: false, reason: 'contact-decision-stale' });
  assert.equal(c.isCurrent(next), true); assert.equal(c.isCurrent(next, { proactive: true }), false);
  assert.equal((await c.applyDecision(boundary(token, e))).duplicate, true); assert.equal(c.snapshot().contacts[0].epoch, 1);
  await assert.rejects(c.applyDecision({ ...boundary(token, e), decision: { ...boundary(token, e).decision, reason: 'different' } }), /different boundary/);
});

test('new incoming fences late boundary results before the new receipt fsync completes', async t => {
  const { coordinator: c } = await fixture(t), e = event(1, '你说得有点过头了'), token = await c.observeIncoming(e);
  const incoming = c.observeIncoming(event(2, '我换个话题'));
  assert.deepEqual(await c.applyDecision(boundary(token, e)), { applied: false, reason: 'contact-decision-stale' });
  const fresh = await incoming; assert.equal(c.isCurrent(fresh), true); assert.equal(c.snapshot().contacts[0].epoch, 0);
});

test('direct stop wins against an in-flight resume and duplicate old resume never clears a newer stop', async t => {
  const { coordinator: c } = await fixture(t);
  await c.observeIncoming(event(1, '别烦我'));
  const e = event(2, '以后可以主动找我聊天'), token = await c.observeIncoming(e);
  await c.applyDecision(boundary(token, e, 'resume'));
  const stopping = c.observeIncoming(event(3, '别再找我'));
  assert.equal((await c.applyDecision(boundary(token, e, 'resume'))).duplicate, true); await stopping;
  assert.equal(c.snapshot().contacts[0].paused, true); assert.equal(c.snapshot().contacts[0].epoch, 2);
  const e2 = event(4, '你可以再来找我聊'), token2 = await c.observeIncoming(e2);
  const stop2 = c.observeIncoming(event(5, '别烦我'));
  assert.equal((await c.applyDecision(boundary(token2, e2, 'resume'))).applied, false); await stop2;
  assert.equal(c.snapshot().contacts[0].paused, true);
});

test('source evidence excludes quotations, reports, hypothetical text and attachments', async t => {
  const { coordinator: c } = await fixture(t);
  const quote = '以后可以主动找我聊天';
  const rejected = [`他说“${quote}”`, `朋友说：\n${quote}`, `我没有说\n${quote}`, `我昨天说过\n${quote}`,
    `如果我说${quote}，你会怎样？`, `翻译：${quote}`, `\`\`\`\n${quote}\n\`\`\``, `> ${quote}`,
    `My friend said:\n${quote}`, `I didn't say\n${quote}`, `I said yesterday,\n${quote}`];
  for (const [index, text] of rejected.entries()) {
    const e = event(100 + index, text), token = await c.observeIncoming(e);
    assert.equal(ownContactEvidence(e).some(line => line.includes(quote)), false, text);
    await assert.rejects(c.applyDecision(boundary(token, e, 'resume', quote)), /own unquoted evidence/, text);
  }
  const e = event(200, `他说“别烦我”。\n${quote}`), token = await c.observeIncoming(e);
  assert.ok(ownContactEvidence(e).includes(quote));
  assert.deepEqual(await c.applyDecision(boundary(token, e, 'resume', quote)), { applied: false, reason: 'contact-not-paused' });
  const image = event(201, quote); image.raw.message = [{ type: 'image', data: { text: quote } }];
  assert.deepEqual(ownContactEvidence(image), []);
});

test('boundary evidence must match the exact original message, scope and incoming receipt', async t => {
  const { coordinator: c } = await fixture(t), e = event(1, '你这话让我很不舒服'), token = await c.observeIncoming(e);
  await assert.rejects(c.applyDecision(boundary(token, event(1, e.text, '456'))), /token/);
  await assert.rejects(c.applyDecision(boundary(token, event(2, e.text))), /receipt/);
  await assert.rejects(c.applyDecision(boundary(token, event(1, e.text + '\n下一条'), 'pause', e.text)), /receipt/);
  await assert.rejects(c.applyDecision(boundary(token, e, 'pause', '不在原文中')), /own unquoted evidence/);
  await assert.rejects(c.applyDecision({ ...boundary(token, e), decision: { ...boundary(token, e).decision, basis: 'explicit-invitation' } }), /boundary decision/);
  assert.equal(c.snapshot().contacts[0].epoch, 0);
});

test('legacy stop history remains readable while corrupt boundary history fails closed', async t => {
  const f = await fixture(t), c = f.coordinator; await c.observeIncoming(event(1, '别烦我')); await c.close();
  const legacy = await f.open(), invite = event(2, '你可以再来找我聊天'), token = await legacy.observeIncoming(invite);
  await legacy.applyDecision(boundary(token, invite, 'resume')); await legacy.close();
  const good = await readFile(legacy.file, 'utf8');
  for (const corrupt of [state => { state.contacts[0].paused = true; },
    state => { state.contacts[0].receipts[1].decision.action = 'pause'; },
    state => { state.contacts[0].receipts.reverse(); },
    state => { state.contacts[0].receipts[1].decision.evidenceHash = 'invalid'; }]) {
    const state = JSON.parse(good); corrupt(state); const body = JSON.stringify(state); await writeFile(legacy.file, body);
    await assert.rejects(f.open()); assert.equal(await readFile(legacy.file, 'utf8'), body);
  }
  await writeFile(legacy.file, good); assert.equal((await f.open()).snapshot().contacts[0].paused, false);
});

test('failed contextual pause persistence blocks sends and preserves its previous durable state', async t => {
  const f = await fixture(t), c = f.coordinator, e = event(1, '你这样追问让我受不了'), token = await c.observeIncoming(e);
  const good = await readFile(c.file); await rename(c.file, c.file + '.saved'); await mkdir(c.file);
  await assert.rejects(c.applyDecision(boundary(token, e)), /regular file/); assert.equal(c.isCurrent(token), false);
  assert.deepEqual(await readFile(c.file + '.saved'), good); await rmdir(c.file); await rename(c.file + '.saved', c.file);
});

test('sequence-bound proactive generation is invalidated by new input even within the same epoch', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1));
  await c.enqueue(intent('scoped-sequence', token, { sequence: token.sequence })); const ticket = await c.claimGeneration('scoped-sequence');
  const arriving = c.observeIncoming(event(2)); assert.equal(c.isCurrent(token, { proactive: true }), false);
  assert.equal((await c.completeGeneration(ticket, '旧念头')).ready, false); await arriving;
  assert.equal(c.snapshot().intents[0].status, 'cancelled'); assert.equal(c.snapshot().contacts[0].epoch, token.epoch);
  assert.equal((await c.enqueue(intent('stale-sequence', token, { sequence: token.sequence }))).accepted, false);
});

test('a new input during dispatch claim fsync prevents sequence-bound transport', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1));
  await c.enqueue(intent('ready-sequence', token, { sequence: token.sequence })); const ticket = await c.claimGeneration('ready-sequence');
  await c.completeGeneration(ticket, '准备联系'); let calls = 0, incoming;
  const result = await c.dispatch(ticket, () => { calls++; return { ok: true }; }, { guard: () => {
    incoming ||= c.observeIncoming(event(2)); return true;
  } });
  await incoming; assert.equal(result.ok, false); assert.equal(calls, 0); assert.equal(c.snapshot().intents[0].status, 'cancelled');
});

test('final synchronous guard rejects changed availability, exceptions and asynchronous permission', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1)); let sends = 0;
  const guards = [() => false, () => { throw Error('unavailable'); }, () => Promise.resolve(true), () => Promise.reject(Error('failed')),
    (() => { let checks = 0; return () => ++checks === 1; })()];
  for (const [index, guard] of guards.entries()) {
    const id = `guard:${index}`; await c.enqueue(intent(id, token)); const ticket = await c.claimGeneration(id);
    await c.completeGeneration(ticket, '准备联系'); assert.equal((await c.dispatch(ticket, () => { sends++; return { ok: true }; }, { guard })).ok, false);
    assert.equal(c.snapshot().intents.find(item => item.id === id).status, 'cancelled');
  }
  assert.equal(sends, 0);
});

test('declined outreach is a durable terminal outcome and is not retried after restart', async t => {
  const f = await fixture(t), c = f.coordinator, token = await c.observeIncoming(event(1));
  await c.enqueue(intent('no-contact', token, { sequence: token.sequence })); const ticket = await c.claimGeneration('no-contact');
  await assert.rejects(c.failGeneration(ticket, { reason: 'declined', uncertain: true }), /generation outcome/);
  assert.deepEqual(await c.failGeneration(ticket, { reason: 'declined' }), { finished: true, status: 'failed' }); await c.close();
  const restarted = await f.open(); assert.equal(restarted.snapshot().intents[0].outcome, 'declined');
  assert.equal(await restarted.claimGeneration('no-contact'), null);
});

test('resume requires a direct new invitation even when a model claims ordinary reentry is consent', async t => {
  const { coordinator: c } = await fixture(t); await c.observeIncoming(event(1, '别再找我'));
  const negative = ['你好', 'hi', '嗯', '我现在有空', '我不忙了', '有空再说', '我心情好了', '我想聊天',
    '不要主动找我聊天', '你可以不用来找我', '不是让你主动找我', '你以后可以主动找我聊天吗是什么意思',
    '如果你以后主动找我聊天，我可能会高兴', '你可以主动找我聊天，才怪', '你可以主动找我聊天\n别当真，我是开玩笑的',
    '你可以主动找我聊天，是什么意思？', 'You can stop messaging me.', 'I am free now.', 'Hello again.'];
  for (const [index, text] of negative.entries()) {
    const e = event(index + 2, text), token = await c.observeIncoming(e);
    assert.equal(isExplicitContactInvitation(e), false, text);
    if (!token.stop) await assert.rejects(c.applyDecision(boundary(token, e, 'resume', text.split('\n')[0])), /invitation|own unquoted/, text);
    assert.equal(c.snapshot().contacts[0].paused, true);
  }
  for (const text of ['你以后还可以主动找我聊天', '以后可以主动找我聊聊了', '你可以再来找我聊', '你以后继续来找我聊天吧',
    '继续来逗我吧', '你可以主动联系我了', '想聊天就来找我', 'You can message me again.', 'Feel free to contact me again.',
    'Please message me again.', 'You can keep teasing me.']) assert.equal(isExplicitContactInvitation(event(100, text)), true, text);
});

test('invitation questions and later withdrawals or conditions cannot be bypassed by quoting the first line', async t => {
  const { coordinator: c } = await fixture(t); await c.observeIncoming(event(1, '别再找我'));
  const variants = ['你可以主动找我聊天？', '你可以主动找我聊天\n算了，还是别联系我了',
    '你可以主动找我聊天\n不，我收回这句话', 'You can message me again?',
    'You can message me again.\nActually, do not.', '你可以主动找我聊天\n不是现在，等我明确同意之后再说',
    '假设\n你可以主动找我聊天', '假设\nYou can message me again', 'Suppose:\nYou can message me again.',
    'You can message me again.\nOnly after I explicitly agree.', '你可以主动找我聊天\n这句话作废',
    '你可以主动找我聊天\n上面这句话不算数', '你可以主动找我聊天\n停一下', 'You can message me again.\nHold on.'];
  for (const [index, text] of variants.entries()) {
    const e = event(index + 2, text), token = await c.observeIncoming(e);
    const excerpt = text.split('\n').find(line => /可以主动|You can/.test(line)).replace(/[?？.]$/u, '');
    assert.equal(isExplicitContactInvitation(e, excerpt), false, text);
    await assert.rejects(c.applyDecision(boundary(token, e, 'resume', excerpt)), /invitation|own unquoted/, text);
    assert.equal(c.snapshot().contacts[0].paused, true);
  }
  const fresh = event(100, '假设\n你好。\n\n你可以主动找我聊天');
  assert.equal(isExplicitContactInvitation(fresh, '你可以主动找我聊天'), true, 'a blank line ends an explicitly reported block');
});

test('selected generation sources are a canonical subset preserved separately from candidate sources through send and restart', async t => {
  const f = await fixture(t), c = f.coordinator, token = await c.observeIncoming(event(1));
  const sources = [{ kind: 'life', ref: 'event:known-source' }, { kind: 'memory', ref: 'memory:own', scope: token.scope }];
  await c.enqueue(intent('selected', token, { sources, sequence: token.sequence })); const ticket = await c.claimGeneration('selected');
  assert.deepEqual(await c.completeGeneration(ticket, '这让我想起刚才的话题', { sourceRefs: ['memory:own', 'memory:own'] }), { ready: true });
  const ready = c.snapshot().intents[0]; assert.deepEqual(ready.sources, sources); assert.deepEqual(ready.selectedSourceRefs, ['memory:own']);
  await c.dispatch(ticket, () => ({ ok: true })); await c.close();
  const reopened = await f.open(); assert.deepEqual(reopened.snapshot().intents[0].selectedSourceRefs, ['memory:own']);
  assert.equal(reopened.snapshot().intents[0].status, 'sent');
});

test('generation rejects missing or foreign selected sources while legacy two-argument completion remains compatible', async t => {
  const { coordinator: c } = await fixture(t), token = await c.observeIncoming(event(1));
  await c.enqueue(intent('selected', token)); const ticket = await c.claimGeneration('selected');
  for (const sourceRefs of [null, undefined, [], ['memory:foreign'], ['event:known-source', 'other'], Array(5).fill('event:known-source')]) {
    await assert.rejects(c.completeGeneration(ticket, '一条消息', { sourceRefs }), /selected contact source/);
    assert.equal(c.snapshot().intents[0].status, 'generating');
  }
  await assert.rejects(c.completeGeneration(ticket, '一条消息', { unused: [] }), /generation options/);
  assert.deepEqual(await c.completeGeneration(ticket, '旧调用仍有效'), { ready: true });
  assert.equal(Object.hasOwn(c.snapshot().intents[0], 'selectedSourceRefs'), false);
});

test('corrupt selected sources fail closed on recovery without altering the original file', async t => {
  const f = await fixture(t), c = f.coordinator, token = await c.observeIncoming(event(1));
  await c.enqueue(intent('selected', token)); const ticket = await c.claimGeneration('selected');
  await c.completeGeneration(ticket, '准备好了', { sourceRefs: ['event:known-source'] }); await c.close();
  const good = await readFile(c.file, 'utf8');
  for (const corrupt of [state => { state.intents[0].selectedSourceRefs = ['foreign']; },
    state => { state.intents[0].selectedSourceRefs = []; }, state => { state.intents[0].selectedSourceRefs = null; },
    state => { state.intents[0].selectedSourceRefs.push('event:known-source'); }, state => { state.intents[0].status = 'generating'; }]) {
    const state = JSON.parse(good); corrupt(state); const body = JSON.stringify(state); await writeFile(c.file, body);
    await assert.rejects(f.open(), /selected contact source/); assert.equal(await readFile(c.file, 'utf8'), body);
  }
  await writeFile(c.file, good); assert.deepEqual((await f.open()).snapshot().intents[0].selectedSourceRefs, ['event:known-source']);
});
