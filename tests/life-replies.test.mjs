import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLifeReplies } from '../src/life-replies.js';

const base = fileURLToPath(new URL('../runtime/tests/', import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = (id, text = `消息${id}`, user = '123') => ({ type: 'private_message', senderId: user,
  senderName: `用户${user}`, selfId: '999', text,
  raw: { message_id: id, raw_message: text, message: [{ type: 'text', data: { text } }] } });

async function fixture(t, options = {}) {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'life-replies-'));
  let time = 1000, busy = true, activityId = 'reading-1', status = 'active';
  const statuses = [], replies = [], instances = [];
  const timeline = {
    availability: ({ scope } = {}) => ({ busy, activityId: busy ? activityId : null,
      title: options.privateTitle && scope !== 'qq:private:123' ? '暂时忙碌' : '安静看书',
      statusText: '*看书中…勿扰', mode: 'simulated' }),
    snapshot: () => ({ plans: [{ id: activityId, status }] })
  };
  const config = { directory, timeline, now: () => time, isEligible: async () => true,
    sendStatus: async (e, text) => { statuses.push({ event: e, text }); return { ok: true }; },
    reply: async (e, details) => { replies.push({ event: e, ...details }); return { ok: true }; }, ...options };
  async function open(overrides = {}) { const instance = await createLifeReplies({ ...config, ...overrides }); instances.push(instance); return instance; }
  const coordinator = await open();
  t.after(async () => {
    for (const instance of instances) await instance.close().catch(() => {});
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, coordinator, statuses, replies, open,
    setTime: value => { time = value; },
    setActivity: (id, value = 'active') => { activityId = id; status = value; busy = value === 'active'; },
    finish: (value = 'completed') => { busy = false; status = value; },
    state: async () => JSON.parse(await readFile(join(directory, 'replies.json'), 'utf8')) };
}

test('busy messages consume no reply calls, persist one status attempt and resume once per object', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 10 }, (_, i) => f.coordinator.receive(event(i + 1))));
  assert.equal(f.statuses.length, 1);
  assert.equal(f.replies.length, 0);
  assert.equal((await f.state()).entries[0].messages.length, 10);
  assert.deepEqual(await f.coordinator.drain(), { attempted: 0, sent: 0, failed: 0, discarded: 0 });
  f.finish();
  assert.deepEqual(await f.coordinator.drain(), { attempted: 1, sent: 1, failed: 0, discarded: 0 });
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0].event.text, /消息1\n消息2/);
  assert.match(f.replies[0].resumeContext, /角色生活模拟/);
  assert.match(f.replies[0].resumeContext, /不是实际阅读/);
  await f.coordinator.drain();
  assert.equal(f.replies.length, 1);
  assert.equal((await f.state()).entries[0].messages.length, 0, 'discard chat payload after the attempt');
});

test('groups, commands and ineligible objects bypass without persisted content or status', async t => {
  const f = await fixture(t, { isEligible: e => e.senderId === '123' });
  for (const e of [event(1, '/状态'), event(2, ' /执行 任务'), { ...event(3), groupId: '456' },
    { ...event(4), type: 'group_message' }, event(5, '不允许私聊', '456')]) {
    assert.deepEqual(await f.coordinator.receive(e), { handled: false, kind: 'bypassed' });
  }
  assert.equal(f.statuses.length, 0);
  assert.equal(f.replies.length, 0);
  await assert.rejects(readFile(join(f.directory, 'replies.json')), { code: 'ENOENT' });
});

test('ordinary available chat bypasses; an available pending batch absorbs new messages', async t => {
  const f = await fixture(t);
  f.finish();
  assert.deepEqual(await f.coordinator.receive(event(1)), { handled: false, kind: 'bypassed' });
  f.setActivity('reading-1');
  await f.coordinator.receive(event(2, '第一条'));
  f.finish();
  assert.equal((await f.coordinator.receive(event(3, '现在补一句'))).kind, 'queued');
  await f.coordinator.drain();
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].event.text, '第一条\n现在补一句');
});

test('objects and identities stay isolated, including reused message IDs and scoped activity titles', async t => {
  const f = await fixture(t, { privateTitle: true });
  await f.coordinator.receive(event(1, 'A的内容', '123'));
  await f.coordinator.receive(event(1, 'B的内容', '456'));
  f.finish('interrupted');
  await f.coordinator.drain();
  assert.equal(f.statuses.length, 2); assert.equal(f.replies.length, 2);
  const a = f.replies.find(reply => reply.event.senderId === '123');
  const b = f.replies.find(reply => reply.event.senderId === '456');
  assert.equal(a.event.text, 'A的内容'); assert.equal(b.event.text, 'B的内容');
  assert.doesNotMatch(b.resumeContext, /安静看书|A的内容/);
  assert.match(a.resumeContext, /中断/); assert.match(a.resumeContext, /不能说已完成/);
});

test('hubBatchMessages deduplicates each ID and retains new text in mixed retry batches', async t => {
  const f = await fixture(t);
  await f.coordinator.receive(event(1, '旧内容'));
  const batched = event(1, '旧内容\n新内容');
  batched.raw.hubBatchMessages = [event(1, '旧内容').raw, event(2, '新内容').raw, event(2, '新内容').raw];
  batched.raw.batched_message_ids = [1, 2];
  await f.coordinator.receive(batched);
  assert.equal((await f.coordinator.receive(batched)).kind, 'duplicate');
  assert.deepEqual((await f.state()).entries[0].messages.map(message => message.text), ['旧内容', '新内容']);
  f.finish(); await f.coordinator.drain();
  assert.equal(f.replies[0].event.text, '旧内容\n新内容');
  assert.equal((await f.coordinator.receive(event(2, '新内容'))).kind, 'duplicate');
});

test('pending messages survive a restart and do not repeat the busy notice', async t => {
  const f = await fixture(t);
  await f.coordinator.receive(event(1, '重启前'));
  await f.coordinator.close();
  const second = await f.open();
  await second.receive(event(2, '重启后'));
  assert.equal(f.statuses.length, 1);
  f.finish('failed'); await second.drain();
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0].event.text, /重启前\n重启后/);
  assert.match(f.replies[0].resumeContext, /失败/);
});

test('recovery treats pre-send claims as uncertain and never retries claimed replies', async t => {
  const f = await fixture(t);
  await f.coordinator.receive(event(1)); await f.coordinator.close();
  const saved = await f.state();
  saved.entries[0].statusAttempt.state = 'claimed';
  saved.entries[0].replyAttempt = { state: 'claimed', at: 1000 };
  await writeFile(join(f.directory, 'replies.json'), JSON.stringify(saved));
  const second = await f.open();
  f.finish(); await second.drain();
  assert.equal(f.statuses.length, 1); assert.equal(f.replies.length, 0);
  const recovered = (await f.state()).entries[0];
  assert.equal(recovered.statusAttempt.state, 'uncertain');
  assert.equal(recovered.replyAttempt.state, 'uncertain');
  assert.equal(recovered.replyAttempt.reason, 'process-interrupted');
  assert.equal(recovered.messages.length, 0);
});

test('callback side effects happen after durable claims; timeouts do not retry or store raw errors', async t => {
  let f, statusCalls = 0, replyCalls = 0;
  f = await fixture(t, {
    sendStatus: async () => {
      statusCalls++;
      assert.equal((await f.state()).entries[0].statusAttempt.state, 'claimed');
      throw Error('PRIVATE_SECRET_SHOULD_NOT_PERSIST');
    },
    reply: async () => {
      replyCalls++;
      assert.equal((await f.state()).entries[0].replyAttempt.state, 'claimed');
      // Simulate a remote success followed by a lost response.
      throw Error('PRIVATE_SECRET_SHOULD_NOT_PERSIST');
    }
  });
  await f.coordinator.receive(event(1)); await f.coordinator.receive(event(2));
  assert.equal(statusCalls, 1);
  f.finish(); await f.coordinator.drain(); await f.coordinator.drain();
  assert.equal(replyCalls, 1);
  await f.coordinator.close(); const second = await f.open(); await second.drain();
  assert.equal(replyCalls, 1);
  const raw = await readFile(join(f.directory, 'replies.json'), 'utf8');
  assert.doesNotMatch(raw, /PRIVATE_SECRET/);
  assert.equal((await f.state()).entries[0].replyAttempt.state, 'uncertain');
});

test('known rejection is retained as failed and expiry or permission changes discard pending work', async t => {
  let eligible = true;
  const f = await fixture(t, { isEligible: () => eligible, reply: async () => ({ ok: false }), policy: { maxAgeMs: 100 } });
  await f.coordinator.receive(event(1)); f.finish();
  assert.equal((await f.coordinator.drain()).failed, 1);
  assert.equal((await f.state()).entries[0].replyAttempt.state, 'failed');
  f.setActivity('next'); await f.coordinator.receive(event(2));
  eligible = false; f.finish();
  assert.equal((await f.coordinator.drain()).discarded, 1);
  eligible = true; f.setActivity('last'); await f.coordinator.receive(event(3));
  f.setTime(1200); f.finish();
  assert.equal((await f.coordinator.drain()).discarded, 1);
  assert.equal((await f.state()).entries.find(entry => entry.activities.some(a => a.id === 'last')).discarded, 'expired');
});

test('messages are bounded and media references become unread markers without retaining URLs', async t => {
  const f = await fixture(t, { policy: { maxMessages: 3, maxMessageChars: 100, maxTextChars: 220 } });
  for (let id = 1; id <= 20; id++) await f.coordinator.receive(event(id, `${id}:` + '长'.repeat(150)));
  const media = event(21, '图片 https://secret.invalid/path?a=token');
  media.raw.message.push({ type: 'image', data: { url: 'https://image.invalid/token', file: 'file:///private.jpg' } }, { type: 'reply', data: { id: 'private-history' } });
  await f.coordinator.receive(media);
  const state = await f.state(), raw = JSON.stringify(state);
  assert.ok(state.entries[0].messages.length <= 3);
  assert.ok(state.entries[0].messages.map(message => message.text).join('\n').length <= 220);
  assert.doesNotMatch(raw, /https:|file:\/\/|secret.invalid|image.invalid|private-history/);
  assert.match(raw, /图片未查看/); assert.match(raw, /引用内容未查看/);
  f.finish(); await f.coordinator.drain();
  assert.deepEqual(f.replies[0].event.images, []);
  assert.equal(f.replies[0].event.hasReplySegment, false);
});

test('new messages during a claimed reply survive in a subsequent batch without blocking receipt', async t => {
  const started = deferred(), release = deferred(); let calls = 0;
  const observed = [];
  const f = await fixture(t, { reply: async e => {
    observed.push(e.text); calls++;
    if (calls === 1) { started.resolve(); await release.promise; }
    return { ok: true };
  } });
  await f.coordinator.receive(event(1, '生成前'));
  f.finish();
  const firstDrain = f.coordinator.drain(); await started.promise;
  assert.equal((await f.coordinator.receive(event(2, '生成中又收到'))).kind, 'queued');
  assert.equal(f.coordinator.drain(), firstDrain, 'a concurrent drain shares the current run');
  release.resolve(); await firstDrain;
  await f.coordinator.drain();
  assert.deepEqual(observed, ['生成前', '生成中又收到']);
  assert.equal(calls, 2);
});

test('a later busy activity retains pending messages in one batch without repeating the notice', async t => {
  const f = await fixture(t);
  await f.coordinator.receive(event(1, '前一段'));
  f.setActivity('second');
  await f.coordinator.receive(event(2, '后一段'));
  assert.equal(f.statuses.length, 1);
  assert.equal((await f.state()).entries.filter(entry => !entry.replyAttempt).length, 1);
  f.finish(); await f.coordinator.drain();
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].event.text, '前一段\n后一段');
});

test('close drains callbacks, rejects new work and does not cancel durable attempts', async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, { sendStatus: async () => { started.resolve(); await release.promise; return { ok: true }; } });
  const receiving = f.coordinator.receive(event(1)); await started.promise;
  const closing = f.coordinator.close(); let closed = false; closing.then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  await assert.rejects(f.coordinator.receive(event(2)), /closed/);
  release.resolve(); await receiving; await closing;
  assert.equal((await f.state()).entries[0].statusAttempt.state, 'sent');
});

test('a status still in flight cannot be overtaken by the resumed response', async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, { sendStatus: async () => { started.resolve(); await release.promise; return { ok: true }; } });
  const receiving = f.coordinator.receive(event(1)); await started.promise;
  f.finish(); assert.equal((await f.coordinator.drain()).attempted, 0);
  release.resolve(); await receiving;
  assert.equal((await f.coordinator.drain()).attempted, 1);
});

test('invalid or nonregular state is rejected without overwrite or network side effects', async t => {
  const f = await fixture(t); await f.coordinator.close();
  const path = join(f.directory, 'replies.json');
  await writeFile(path, '{broken state');
  await assert.rejects(f.open());
  assert.equal(await readFile(path, 'utf8'), '{broken state');
  await rm(path); await mkdir(path);
  await assert.rejects(f.open(), /regular file/);
  assert.equal(f.statuses.length, 0); assert.equal(f.replies.length, 0);
});

test('failed durable claim prevents the status send and poisons later mutation', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'replies.json'));
  await assert.rejects(f.coordinator.receive(event(1)), /regular file/);
  assert.equal(f.statuses.length, 0);
  await assert.rejects(f.coordinator.receive(event(2)), /regular file/);
  await assert.rejects(f.coordinator.close(), /regular file/);
});

test('symlink state is rejected rather than following an unrelated file', async t => {
  const f = await fixture(t); await f.coordinator.close();
  const target = join(f.directory, 'unrelated.json');
  await writeFile(target, JSON.stringify({ version: 1, entries: [], seen: [] }));
  try { await symlink(target, join(f.directory, 'replies.json')); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink permission unavailable'); throw error; }
  await assert.rejects(f.open(), /regular file/);
});

function contactFixture() {
  const epochs = new Map();
  return {
    isCurrent: token => token && token.epoch === (epochs.get(token.scope) || 0) && !token.stop,
    stop: user => { const scope = `qq:private:${user}`; epochs.set(scope, (epochs.get(scope) || 0) + 1); },
    event(id, text, user = '123') {
      const scope = `qq:private:${user}`;
      return { ...event(id, text, user), lifeContactToken: { scope, epoch: epochs.get(scope) || 0, sequence: id, stop: false, duplicate: false } };
    }
  };
}

test('stop drops old busy messages across restart; new messages keep their original contact token', async t => {
  const contacts = contactFixture(), f = await fixture(t, { contacts });
  await f.coordinator.receive(contacts.event(1, '旧消息'));
  await f.coordinator.receive(contacts.event(2, '另一个对象', '456'));
  contacts.stop('123');
  await f.coordinator.close();
  const resumed = await f.open();
  const saved = await f.state();
  assert.equal(saved.entries.find(e => e.scope === 'qq:private:123').discarded, 'contact-stopped');
  assert.deepEqual(saved.entries.find(e => e.scope === 'qq:private:123').messages, []);
  const fresh = contacts.event(3, '重新来聊');
  await resumed.receive(fresh); f.finish(); await resumed.drain();
  assert.deepEqual(f.replies.map(r => r.event.text).sort(), ['另一个对象', '重新来聊']);
  assert.deepEqual(f.replies.find(r => r.event.senderId === '123').event.lifeContactToken, fresh.lifeContactToken);
});

test('enabling coordination discards old unfenced pending replies instead of granting a new epoch', async t => {
  const f = await fixture(t);
  await f.coordinator.receive(event(1, '迁移前等待'));
  await f.coordinator.close();
  const resumed = await f.open({ contacts: contactFixture() });
  f.finish(); await resumed.drain();
  assert.equal(f.replies.length, 0);
  assert.equal((await f.state()).entries[0].discarded, 'legacy-unfenced');
});

test('stale batches and forged cross-object tokens cannot create busy work or block a new ordinary reply', async t => {
  const contacts = contactFixture(), f = await fixture(t, { contacts });
  const stale = contacts.event(1, '未结束的batch'); contacts.stop('123');
  assert.equal((await f.coordinator.receive(stale)).kind, 'contact-stopped');
  const forged = contacts.event(2, '不匹配'); forged.lifeContactToken.scope = 'qq:private:456';
  assert.equal((await f.coordinator.receive(forged)).kind, 'contact-stopped');
  assert.equal((await f.coordinator.receive(event(3))).kind, 'contact-stopped');
  assert.equal(f.statuses.length, 0);
  f.finish(); assert.equal((await f.coordinator.receive(contacts.event(4, '新话题'))).kind, 'bypassed');
});

test('a stopped in-flight catch-up cannot trap a new conversation or leak its old context', async t => {
  const contacts = contactFixture(), started = deferred(), release = deferred(), delivered = [];
  const f = await fixture(t, { contacts, reply: async e => {
    started.resolve(); await release.promise;
    if (!contacts.isCurrent(e.lifeContactToken)) return { ok: false };
    delivered.push(e.text); return { ok: true };
  } });
  await f.coordinator.receive(contacts.event(1, '旧补答'));
  f.finish(); const draining = f.coordinator.drain(); await started.promise;
  contacts.stop('123');
  assert.equal((await f.coordinator.receive(contacts.event(2, '新普通聊天'))).kind, 'bypassed');
  release.resolve(); await draining;
  assert.deepEqual(delivered, []);
  assert.equal((await f.state()).entries[0].replyAttempt.state, 'failed');
});

test('stop during eligibility checking cancels a pending catch-up before invoking its model callback', async t => {
  const contacts = contactFixture(); let draining = false;
  const f = await fixture(t, { contacts, isEligible: () => { if (draining) contacts.stop('123'); return true; } });
  await f.coordinator.receive(contacts.event(1, '等待')); f.finish(); draining = true;
  assert.equal((await f.coordinator.drain()).attempted, 0);
  assert.equal(f.replies.length, 0);
  assert.equal((await f.state()).entries[0].discarded, 'contact-stopped');
});

test('a deferred ordinary generation preserves its original input after the activity ended and resumes once', async t => {
  const contacts = contactFixture(), f = await fixture(t, { contacts });
  const original = contacts.event(1, '原始问题，不能丢掉');
  f.finish();
  assert.equal((await f.coordinator.defer(original)).kind, 'queued');
  assert.equal((await f.coordinator.defer(original)).kind, 'duplicate');
  assert.equal(f.statuses.length, 0);
  await f.coordinator.close();
  const resumed = await f.open();
  await resumed.drain(); await resumed.drain();
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].event.text, original.text);
  assert.deepEqual(f.replies[0].event.lifeContactToken, original.lifeContactToken);
  assert.match(f.replies[0].resumeContext, /无需再次回顾|不必再次回顾/);
  assert.doesNotMatch(f.replies[0].resumeContext, /已结束|已完成/);
});

test('deferral while busy merges with later inbound messages without another status or losing original evidence', async t => {
  const contacts = contactFixture(), f = await fixture(t, { contacts });
  const original = contacts.event(1, '生成中跨入活动的原问题');
  original.lifeContactEvidence = { token: original.lifeContactToken, event: { text: original.text } };
  assert.equal((await f.coordinator.defer(original)).kind, 'busy');
  assert.equal(f.statuses.length, 0);
  const following = contacts.event(2, '忙时再补充一句');
  following.lifeContactEvidence = { token: following.lifeContactToken, event: { text: following.text } };
  await f.coordinator.receive(following);
  assert.equal(f.statuses.length, 1);
  f.finish(); await f.coordinator.drain();
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].event.text, `${original.text}\n${following.text}`);
  assert.deepEqual(f.replies[0].event.lifeContactEvidence, following.lifeContactEvidence);
});

test('deferral never retries a transmitted segment, uncertain transport or already consumed catch-up', async t => {
  const f = await fixture(t); f.finish();
  for (const extra of [{ sentMessageIds: ['sent-1'] }, { lifeTransportStarted: true }, { lifeReplyEpisodeId: 'consumed' }]) {
    assert.deepEqual(await f.coordinator.defer({ ...event(1), ...extra }), { handled: true, kind: 'already-attempted' });
  }
  await f.coordinator.drain();
  assert.equal(f.replies.length, 0); assert.equal(f.statuses.length, 0);
});

test('deferral retains the original contact epoch and cannot revive a stopped or cross-object input', async t => {
  const contacts = contactFixture(), f = await fixture(t, { contacts });
  const old = contacts.event(1, '不应恢复的旧原文'); contacts.stop('123');
  f.finish();
  assert.equal((await f.coordinator.defer(old)).kind, 'contact-stopped');
  const cross = contacts.event(2, '跨对象原文'); cross.lifeContactToken.scope = 'qq:private:456';
  assert.equal((await f.coordinator.defer(cross)).kind, 'contact-stopped');
  await f.coordinator.drain(); assert.equal(f.replies.length, 0);
});
