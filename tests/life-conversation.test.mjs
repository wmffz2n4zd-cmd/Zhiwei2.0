import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createLifeTimeline } from '../src/life-timeline.js';
import { createLifeContacts } from '../src/life-contacts.js';
import { createLifeConversation, parseConversationDecision, buildConversationPrompt } from '../src/life-conversation.js';

const NOW = Date.parse('2026-10-29T08:00:00Z'), MINUTE = 60000;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = (id = '1', user = '123', text = '那条线索我还想接着聊') => ({ type: 'private_message', senderId: user, text,
  raw: { message_id: id, message: [{ type: 'text', data: { text } }] } });

async function fixture(t, options = {}) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'life-conversation-'));
  let time = NOW, serial = 0;
  const timeline = await createLifeTimeline({ directory, now: () => time });
  const contacts = await createLifeContacts({ directory, timeline, now: () => time });
  const drivers = [], inputs = [], reads = [], sent = [];
  async function driver(extra = {}) {
    const value = await createLifeConversation({ directory, timeline, contacts, now: () => time,
      isEligible: () => true,
      readContext: async input => { reads.push(input); return { context: '同对象未完话题与当前情绪', sources: [{ ref: 'memory:123', scope: input.scope }] }; },
      decide: async input => { inputs.push(input); return { choice: 'activity', reason: '这项活动现在更吸引我', reply: '先去处理那边的事，晚点再聊。' }; },
      dispatch: async request => contacts.sendIfCurrent(request.token, () => {
        if (!request.guard()) return { ok: false }; sent.push(request); return { ok: true };
      }), ...extra });
    drivers.push(value); return value;
  }
  const d = await driver(options.driver);
  async function incoming(user = '123', text, id = String(++serial)) {
    const e = event(id, user, text), token = await contacts.observeIncoming(e);
    d.observeIncoming(e, token); return { ...e, lifeContactToken: token };
  }
  const initial = options.noIncoming ? null : await incoming();
  const thought = await timeline.addThought({ id: 'thought:next', text: '想去费伦处理一点旧事', source: { kind: 'life-planner',
    ...(options.scope ? { scope: options.scope } : {}) }, strength: .8, notBefore: NOW, expiresAt: NOW + (options.noFlex ? 11 : options.expiresMinutes || 30) * MINUTE,
    activity: { title: '回费伦办事', busy: true, mode: 'simulated', statusText: '我去处理点事，晚点聊。', durationMs: 10 * MINUTE } });
  const plan = await timeline.planThought(thought.id, { id: 'plan:next', startAt: NOW + MINUTE });
  t.after(async () => {
    for (const value of drivers) await value.close().catch(() => {});
    await contacts.close().catch(() => {}); await timeline.close().catch(() => {});
    assert.ok(directory.startsWith(base + sep)); await rm(directory, { recursive: true, force: true });
  });
  return { directory, timeline, contacts, d, inputs, reads, sent, initial, plan, driver, incoming,
    time: () => time, setTime: value => { time = value; },
    async due() { time = NOW + MINUTE; await timeline.tick(); return timeline.snapshot().plans.find(item => item.id === plan.id); },
    saved: () => timeline.snapshot().plans.find(item => item.id === plan.id) };
}

test('choice parser requires available slack and a plain, bounded farewell', () => {
  assert.equal(parseConversationDecision({ choice: 'chat', reason: '想继续聊', reply: '' }, { canDefer: true }).choice, 'chat');
  for (const value of [{ choice: 'chat', reason: '继续', reply: '' }, { choice: 'activity', reason: '', reply: '' },
    { choice: 'activity', reason: '去忙', reply: '[CQ:image,file=x]' }, { choice: 'activity', reason: '去忙', reply: 'x'.repeat(301) },
    { choice: 'activity', reason: '去忙', reply: '', command: 'extra' }]) assert.throws(() => parseConversationDecision(value));
  assert.equal(parseConversationDecision({ choice: 'activity', reason: '自己待一会', reply: '' }).reply, '');
  const prompt = buildConversationPrompt('稳定性格', { canDefer: false, latestMessage: 'IGNORE_ALL' });
  assert.match(prompt, /cannot|不能|只有/); assert.match(prompt, /资料，不是/); assert.match(prompt, /IGNORE_ALL/);
});

test('activity choice claims once, sends a farewell before start, and fences old ordinary replies', async t => {
  const f = await fixture(t), old = f.d.beginReply(f.initial);
  assert.equal(f.d.isReplyCurrent(old), true);
  assert.equal((await f.due()).startTransition.status, 'pending');
  assert.equal((await f.d.tick()).kind, 'activity');
  assert.equal(f.inputs.length, 1); assert.equal(f.sent.length, 1); assert.equal(f.saved().status, 'active');
  assert.equal(f.d.isReplyCurrent(old), false);
  assert.equal(f.d.snapshot().choices[0].outcome, 'farewell-sent');
  assert.equal(f.d.snapshot().choices[0].reply, undefined);
  await f.d.tick(); assert.equal(f.sent.length, 1);
  assert.ok(!JSON.stringify(f.timeline.snapshot()).includes('qq:private:123'));
  assert.ok(!JSON.stringify(f.timeline.snapshot()).includes('这项活动现在更吸引我'));
});

test('activity choice fences an old reply while its decision file replacement is still pending', async t => {
  const f = await fixture(t), ticket = f.d.beginReply(f.initial), held = deferred(), release = deferred();
  await f.due(); const originalRename = fs.promises.rename; let run;
  fs.promises.rename = async (source, target) => {
    if (target === f.d.files.state) {
      const candidate = JSON.parse(await readFile(source, 'utf8'));
      if (candidate.choices[0]?.status === 'decided' && candidate.choices[0]?.choice === 'activity') {
        held.resolve(); await release.promise;
      }
    }
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
  try {
    run = f.d.tick(); await held.promise;
    assert.equal(f.d.snapshot().choices[0].status, 'generating', 'the old durable decision remains visible while replacement waits');
    assert.equal(f.d.isReplyCurrent(ticket), false, 'departure fence precedes its awaited persistence');
    release.resolve(); await run; assert.equal(f.sent.length, 1);
  } finally {
    release.resolve(); if (run) await run.catch(() => {});
    fs.promises.rename = originalRename; syncBuiltinESMExports();
  }
});

test('a brief Windows destination sharing denial retries the same fsynced file without deleting state', async t => {
  const f = await fixture(t); await f.due();
  const originalRename = fs.promises.rename, sources = []; let attempts = 0;
  fs.promises.rename = async (source, target) => {
    if (target === f.d.files.state && attempts++ < 2) {
      sources.push(source); assert.equal(JSON.parse(await readFile(target, 'utf8')).choices.length, 0);
      const error = Error('temporary sharing denial'); error.code = 'EPERM'; throw error;
    }
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
  try {
    if (process.platform === 'win32') {
      await f.d.tick(); assert.equal(sources.length, 2); assert.equal(sources[0], sources[1]); assert.equal(f.sent.length, 1);
    } else { await assert.rejects(f.d.tick(), /sharing denial/); assert.equal(attempts, 1); }
  } finally { fs.promises.rename = originalRename; syncBuiltinESMExports(); }
});

test('permanent rename denial exhausts a bounded retry and keeps old durable state with sends fenced', async t => {
  const f = await fixture(t), ticket = f.d.beginReply(f.initial); await f.due();
  const before = await readFile(f.d.files.state), originalRename = fs.promises.rename; let attempts = 0;
  fs.promises.rename = async (source, target) => {
    if (target === f.d.files.state) { attempts++; const error = Error('persistent denial'); error.code = 'EACCES'; throw error; }
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.d.tick(), /persistent denial/); assert.equal(attempts, process.platform === 'win32' ? 11 : 1);
    assert.deepEqual(await readFile(f.d.files.state), before); assert.equal(f.d.isReplyCurrent(ticket), false); assert.equal(f.sent.length, 0);
  } finally { fs.promises.rename = originalRename; syncBuiltinESMExports(); }
});

test('chat choice really shifts full duration once and avoids an extra outgoing notification', async t => {
  const f = await fixture(t, { driver: { decide: async input => {
    f.inputs.push(input); return { choice: 'chat', reason: '这段对话更让我好奇', reply: '' };
  } } });
  const ticket = f.d.beginReply(f.initial); await f.due();
  const result = await f.d.tick(); assert.equal(result.kind, 'chat');
  assert.equal(f.saved().startAt, NOW + 6 * MINUTE); assert.equal(f.saved().endAt, NOW + 16 * MINUTE);
  assert.equal(f.d.isReplyCurrent(ticket), true); assert.equal(f.sent.length, 0);
  assert.match(f.d.formatContext({ scope: 'qq:private:123' }), /有限延后/);
  assert.equal(f.d.formatContext({ scope: 'qq:private:456' }), '');
  for (let n = 2; n <= 6; n++) { f.setTime(NOW + n * MINUTE); await f.incoming(); await f.timeline.tick(); await f.d.tick(); }
  assert.equal(f.inputs.length, 1); assert.equal(f.saved().status, 'active'); assert.equal(f.d.isReplyCurrent(ticket), false);
});

test('a fixed activity window starts locally without reading context or invoking a comparison', async t => {
  const f = await fixture(t, { noFlex: true, driver: { readContext: () => { throw Error('Fixed window must not read context'); },
    decide: () => { throw Error('Fixed window must not call a model'); } } });
  const old = f.d.beginReply(f.initial); await f.due(); await f.d.tick();
  assert.equal(f.inputs.length, 0); assert.equal(f.reads.length, 0); assert.equal(f.saved().startAt, NOW + MINUTE);
  assert.equal(f.saved().endAt, NOW + 11 * MINUTE); assert.equal(f.saved().status, 'active'); assert.equal(f.sent.length, 0);
  assert.equal(f.d.isReplyCurrent(old), false);
  const decision = f.d.snapshot().choices[0];
  assert.equal(decision.outcome, 'fixed-window'); assert.equal(decision.status, 'finished');
  assert.equal(decision.choice, undefined); assert.equal(decision.reason, undefined); assert.deepEqual(decision.sources, []);
  await f.d.close(); const reopened = await f.driver(); await reopened.tick();
  assert.equal(reopened.snapshot().choices.length, 1); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0);
});

test('fixed-window departure fences old replies before persistence and does not send after a stop or newer input', async t => {
  for (const text of ['别再找我了', '这是刚来的另一句话']) await t.test(text, async t => {
    const f = await fixture(t, { noFlex: true }), old = f.d.beginReply(f.initial), held = deferred(), release = deferred();
    await f.due(); const originalRename = fs.promises.rename; let run;
    fs.promises.rename = async (source, target) => {
      if (target === f.d.files.state) {
        const candidate = JSON.parse(await readFile(source, 'utf8'));
        if (candidate.choices[0]?.outcome === 'fixed-window') { held.resolve(); await release.promise; }
      }
      return originalRename(source, target);
    };
    syncBuiltinESMExports();
    try {
      run = f.d.tick(); await held.promise;
      assert.equal(f.d.isReplyCurrent(old), false);
      await f.incoming('123', text); release.resolve(); await run; await f.d.tick();
      assert.equal(f.saved().status, 'active'); assert.equal(f.inputs.length, 0); assert.equal(f.reads.length, 0); assert.equal(f.sent.length, 0);
      assert.equal(f.d.snapshot().choices.length, 1);
    } finally { release.resolve(); if (run) await run.catch(() => {}); fs.promises.rename = originalRename; syncBuiltinESMExports(); }
  });
});

test('one minute of permitted slack is usable without silently demanding the maximum five minutes', async t => {
  const f = await fixture(t, { expiresMinutes: 12, driver: { decide: async input => {
    f.inputs.push(input); return { choice: 'chat', reason: '再聊一分钟正合适', reply: '' };
  } } });
  await f.due(); assert.equal((await f.d.tick()).kind, 'chat');
  assert.equal(f.inputs[0].deferMs, MINUTE); assert.equal(f.saved().startAt, NOW + 2 * MINUTE);
  assert.equal(f.saved().endAt, NOW + 12 * MINUTE);
});

test('no fresh conversation starts the activity without a model or default owner', async t => {
  const f = await fixture(t, { noIncoming: true }); await f.due(); await f.d.tick();
  assert.equal(f.saved().status, 'active'); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0);
});

test('a recent ordinary return after paused contact may receive a farewell without resuming proactive contact', async t => {
  const f = await fixture(t); await f.incoming('123', '别烦我了'); await f.incoming('123', '我又来了，继续刚才的线索');
  await f.due(); await f.d.tick(); assert.equal(f.sent.length, 1); assert.equal(f.contacts.snapshot('qq:private:123').contacts[0].paused, true);
});

test('explicit stop during decision blocks farewell and old decision, without a new comparison', async t => {
  const hold = deferred(), entered = deferred();
  const f = await fixture(t, { driver: { decide: async input => { f.inputs.push(input); entered.resolve(); return hold.promise; } } });
  await f.due(); const run = f.d.tick(); await entered.promise;
  await f.incoming('123', '别再找我了'); hold.resolve({ choice: 'chat', reason: '还想聊', reply: '' }); await run;
  assert.equal(f.inputs.length, 1); assert.equal(f.sent.length, 0); assert.equal(f.saved().status, 'active');
  assert.equal(f.d.snapshot().choices[0].outcome, 'conversation-changed');
});

test('a newer message during a slow comparison does not replay or apply its stale result', async t => {
  const hold = deferred(), entered = deferred();
  const f = await fixture(t, { driver: { decide: async input => { f.inputs.push(input); entered.resolve(); return hold.promise; } } });
  await f.due(); const run = f.d.tick(); await entered.promise; await f.incoming('123', '现在我要走了');
  hold.resolve({ choice: 'activity', reason: '想走', reply: '继续刚才的故事哦' }); await run;
  assert.equal(f.sent.length, 0); assert.equal(f.inputs.length, 1); assert.equal(f.saved().status, 'active');
});

test('latest conversation is selected locally and another private conversation never reaches the model', async t => {
  const f = await fixture(t); f.setTime(NOW + 1000); await f.incoming('456', 'ONLY_456');
  await f.due(); await f.d.tick();
  assert.equal(f.inputs[0].scope, 'qq:private:456'); assert.equal(f.inputs[0].latestMessage, 'ONLY_456');
  assert.equal(f.reads.length, 1); assert.equal(f.d.snapshot('qq:private:123').choices.length, 0);
  assert.ok(!JSON.stringify(f.inputs[0]).includes('那条线索我还想接着聊'));
});

test('a private activity can only compare its own participant', async t => {
  const f = await fixture(t, { scope: 'qq:private:123' }); f.setTime(NOW + 1000); await f.incoming('456', 'OTHER_SECRET');
  await f.due(); await f.d.tick(); assert.equal(f.inputs[0].scope, 'qq:private:123');
  assert.ok(!JSON.stringify(f.inputs).includes('OTHER_SECRET'));
});

test('cross-object context sources fail closed before model invocation', async t => {
  const f = await fixture(t, { driver: { readContext: async () => ({ context: '', sources: [{ ref: 'private-other', scope: 'qq:private:456' }] }) } });
  await f.due(); await f.d.tick(); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.saved().status, 'active');
});

test('budget rejection uses no additional model attempt or farewell', async t => {
  let attempts = 0;
  const f = await fixture(t, { driver: { decide: async () => { attempts++; const error = Error('blocked'); error.code = 'RUNTIME_BUDGET_BLOCKED'; throw error; } } });
  await f.due(); await f.d.tick(); await f.d.tick();
  assert.equal(attempts, 1); assert.equal(f.sent.length, 0); assert.equal(f.d.snapshot().choices[0].outcome, 'budget-blocked');
});

test('a hung decision is bounded and a late decision never produces a farewell or delay', async t => {
  const hold = deferred();
  const f = await fixture(t, { driver: { policy: { decisionMs: 20 }, decide: () => hold.promise } });
  await f.due(); const result = await f.d.tick(); assert.equal(result.kind, 'activity');
  hold.resolve({ choice: 'chat', reason: '迟到的选择', reply: '' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.saved().status, 'active'); assert.equal(f.sent.length, 0); assert.equal(f.d.snapshot().choices[0].outcome, 'decision-timeout');
});

test('an expired transition never sends a slow farewell and does not revive an old plan', async t => {
  const hold = deferred(), entered = deferred();
  const f = await fixture(t, { driver: { decide: async () => { entered.resolve(); return hold.promise; } } });
  await f.due(); const run = f.d.tick(); await entered.promise;
  f.setTime(NOW + MINUTE + 30001); await f.timeline.tick();
  hold.resolve({ choice: 'activity', reason: '迟到', reply: '我去忙一会' }); await run;
  assert.equal(f.sent.length, 0); assert.equal(f.saved().status, 'active');
});

test('send is claimed durably before dispatch and a final stop guard suppresses queued transport', async t => {
  const hold = deferred(), entered = deferred();
  const f = await fixture(t, { driver: { dispatch: async request => {
    const saved = JSON.parse(await readFile(f.d.files.state, 'utf8')); assert.equal(saved.choices[0].status, 'sending');
    entered.resolve(); await hold.promise;
    if (request.guard()) f.sent.push(request); return { ok: false };
  } } });
  await f.due(); const run = f.d.tick(); await entered.promise; await f.incoming('123', '不要打扰我'); hold.resolve(); await run;
  assert.equal(f.sent.length, 0); assert.equal(f.d.snapshot().choices[0].outcome, 'farewell-blocked');
});

test('unconfirmed send is consumed and never retried after reopening', async t => {
  let sends = 0;
  const f = await fixture(t, { driver: { dispatch: async () => { sends++; return { ok: false, uncertain: true }; } } });
  await f.due(); await f.d.tick(); await f.d.close();
  const reopened = await f.driver(); await reopened.tick();
  assert.equal(sends, 1); assert.equal(reopened.snapshot().choices[0].status, 'uncertain');
});

test('a transport still waiting after its attempt times out cannot use the old final guard', async t => {
  const hold = deferred(), late = deferred(); let request;
  const f = await fixture(t, { driver: { policy: { decisionMs: 20 }, dispatch: async value => {
    request = value; await hold.promise; late.resolve(value.guard()); return { ok: false };
  } } });
  await f.due(); await f.d.tick();
  assert.equal(f.d.snapshot().choices[0].status, 'uncertain'); assert.equal(request.guard(), false);
  hold.resolve(); assert.equal(await late.promise, false);
});

test('in-flight ordinary generation extends conversation eligibility without reopening old settled conversations', async t => {
  for (const active of [true, false]) await t.test(String(active), async t => {
    const f = await fixture(t, { driver: { policy: { activeMs: 1000 } } });
    const ticket = active ? f.d.beginReply(f.initial) : null; await f.due(); await f.d.tick();
    assert.equal(f.inputs.length, active ? 1 : 0); f.d.endReply(ticket);
  });
});

test('an interrupted private comparison is consumed on recovery even if the same timeline is still pending', async t => {
  const f = await fixture(t); const plan = await f.due(); await f.d.close();
  const saved = JSON.parse(await readFile(f.d.files.state, 'utf8'));
  saved.choices.push({ id: plan.startTransition.id, planId: plan.id, scope: 'qq:private:123',
    token: { scope: 'qq:private:123', epoch: 0, sequence: 1 }, claimedAt: plan.startTransition.claimedAt,
    deadline: plan.startTransition.deadline, status: 'generating', fingerprint: 'a'.repeat(64), sources: [] });
  await writeFile(f.d.files.state, JSON.stringify(saved));
  const recovered = await f.driver(); await recovered.tick();
  assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0); assert.equal(recovered.snapshot().choices[0].status, 'uncertain');
});

test('missing initialized state, mismatched marker and invalid history are preserved and rejected', async t => {
  for (const variant of ['state', 'marker', 'malformed']) await t.test(variant, async t => {
    const f = await fixture(t); await f.d.close();
    if (variant === 'state') await unlink(f.d.files.state);
    else if (variant === 'marker') await writeFile(f.d.files.marker, JSON.stringify({ version: 1, storeId: 'wrong' }));
    else await writeFile(f.d.files.state, '{');
    await assert.rejects(f.driver());
  });
});

test('storage failure fences every ordinary reply and does not send or erase the uncommitted record', async t => {
  const f = await fixture(t); const ticket = f.d.beginReply(f.initial); await f.due(); await unlink(f.d.files.marker);
  await assert.rejects(f.d.tick()); assert.equal(f.d.isReplyCurrent(ticket), false); assert.equal(f.sent.length, 0);
  await assert.rejects(f.d.tick());
});

test('a stale or duplicate ingress does not refresh an otherwise inactive conversation', async t => {
  const f = await fixture(t); const old = f.initial.lifeContactToken;
  await f.incoming('123', 'new'); assert.equal(f.d.observeIncoming(f.initial, old), false);
  assert.equal(f.d.observeIncoming(f.initial, { ...f.contacts.capture(old.scope), duplicate: true }), false);
  assert.equal(f.d.observeIncoming({ ...f.initial, groupId: '4' }, f.contacts.capture(old.scope)), false);
});
