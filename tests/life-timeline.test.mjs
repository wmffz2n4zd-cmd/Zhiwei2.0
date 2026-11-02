import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, readdir, mkdir, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beijingDay, createLifeTimeline } from '../src/life-timeline.js';

const execute = promisify(execFile), minute = 60000, day = 24 * 60 * minute;
const origin = Date.parse('2026-10-27T09:07:00+08:00');
const thought = (id = 'reading', extra = {}) => ({ id, text: '想安静看一会书', source: { kind: 'interest', ref: 'existing-reading-interest' },
  strength: 0.7, activity: { title: '看书', statusText: '*看书中…勿扰', durationMs: 30 * minute, busy: true, mode: 'simulated' }, ...extra });

async function fixture(t, { time = origin, policy = {} } = {}) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'zhiwei-life-'));
  let clock = time, timeline = await createLifeTimeline({ directory, now: () => clock, policy });
  t.after(async () => {
    await timeline?.close().catch(() => {});
    if (resolve(directory).startsWith(parent + sep)) await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, get life() { return timeline; }, time: () => clock,
    set(value) { clock = value; }, advance(value) { clock += value; },
    async reopen() { await timeline.close(); timeline = await createLifeTimeline({ directory, now: () => clock, policy }); return timeline; },
    async tickMinutes(count) { for (let i = 0; i < count; i++) { clock += minute; await timeline.tick(); } }
  };
}

test('start gate holds every advance path and commits one opaque pre-start reservation', async t => {
  const f = await fixture(t); let gates = 0;
  f.life.setStartGate((plan, context) => {
    gates++; assert.equal(plan.id, 'held'); assert.equal(context.thought.id, 'reading'); return true;
  });
  await f.life.addThought(thought('reading', { expiresAt: origin + 40 * minute }));
  await f.life.planThought('reading', { id: 'held', startAt: origin + minute });
  f.advance(minute);
  await f.life.addThought(thought('later'));
  const held = f.life.pendingStart();
  assert.equal(held.status, 'planned'); assert.equal(f.life.availability().busy, false);
  assert.equal(held.startTransition.deadline, f.time() + 30000);
  assert.deepEqual(Object.keys(held.startTransition), ['id', 'claimedAt', 'deadline', 'status', 'resolvedAt']);
  await f.life.tick(); await f.life.claimAction(held.id);
  await f.life.recordExperience({ id: 'simulated-observation', kind: 'rest', mode: 'simulated',
    source: { kind: 'personal' }, summary: '安静了一会' });
  assert.equal(gates, 1); assert.equal(f.life.snapshot().events.filter(e => e.type === 'plan-start-held').length, 1);
  assert.equal(f.life.snapshot().events.filter(e => e.type === 'activity-started').length, 0);
  const result = await f.life.resolveStart(held.id, { decisionId: held.startTransition.id, outcome: 'start' });
  assert.equal(result.kind, 'resolved'); assert.equal(f.life.availability().busy, true);
  assert.equal(f.life.pendingStart(), null);
});

test('one comparison can defer the full activity once within its explicit lifetime', async t => {
  const f = await fixture(t); let gates = 0;
  f.life.setStartGate(() => { gates++; return true; });
  await f.life.addThought(thought('reading', { expiresAt: origin + 35 * minute }));
  const plan = await f.life.planThought('reading');
  f.advance(20000);
  const requests = await Promise.all([1, 2].map(() => f.life.resolveStart(plan.id,
    { decisionId: plan.startTransition.id, outcome: 'defer' })));
  assert.deepEqual(requests.map(r => r.kind), ['resolved', 'stale']);
  const moved = f.life.snapshot().plans[0];
  assert.equal(moved.startAt, origin + 5 * minute); assert.equal(moved.endAt, origin + 35 * minute);
  assert.equal(moved.durationMs, 30 * minute); assert.equal(moved.startTransition.status, 'deferred');
  await f.tickMinutes(4); f.set(origin + 5 * minute); await f.life.tick();
  assert.equal(f.life.availability().busy, true); assert.equal(gates, 1);
  assert.equal(f.life.snapshot().events.filter(e => e.type === 'activity-started').length, 1);
});

test('fixed expiry and nearby reservations reject deferral without consuming the release choice', async t => {
  for (const reason of ['expiry', 'neighbor', 'busy-gap']) await t.test(reason, async t => {
    const f = await fixture(t); f.life.setStartGate(() => true);
    await f.life.addThought(thought('reading', { expiresAt: origin + (reason === 'expiry' ? 30 : 60) * minute }));
    if (reason !== 'expiry') {
      await f.life.addThought(thought('neighbor', { activity: { ...thought().activity,
        busy: reason === 'busy-gap', durationMs: minute } }));
      await f.life.planThought('neighbor', { startAt: origin + (reason === 'neighbor' ? 31 : 45) * minute });
    }
    const held = await f.life.planThought('reading');
    const result = await f.life.resolveStart(held.id, { decisionId: held.startTransition.id, outcome: 'defer' });
    assert.equal(result.kind, 'cannot-defer'); assert.equal(f.life.pendingStart().id, held.id);
    assert.equal((await f.life.resolveStart(held.id, { decisionId: held.startTransition.id, outcome: 'start' })).kind, 'resolved');
    assert.equal(f.life.availability().busy, true);
  });
});

test('deadline, observation gap and restart release pending choices without repeating them', async t => {
  for (const cause of ['deadline', 'gap', 'restart']) await t.test(cause, async t => {
    const f = await fixture(t); let gates = 0;
    f.life.setStartGate(() => { gates++; return true; });
    await f.life.addThought(thought()); const plan = await f.life.planThought('reading');
    if (cause === 'deadline') { f.advance(30000); await f.life.tick(); }
    else if (cause === 'gap') { f.advance(3 * minute); await f.life.tick(); }
    else { f.advance(1000); await f.reopen(); f.life.setStartGate(() => { gates++; return true; }); }
    const current = f.life.snapshot().plans[0];
    assert.equal(current.startTransition.status, cause === 'deadline' ? 'expired' : 'uncertain');
    assert.equal(current.status, 'active'); assert.equal(gates, 1);
    assert.equal((await f.life.resolveStart(plan.id, { decisionId: plan.startTransition.id, outcome: 'defer' })).kind, 'stale');
    await f.life.tick(); assert.equal(f.life.snapshot().events.filter(e => e.type === 'activity-started').length, 1);
  });
});

test('missed held slots do not start after restart and deferred slots retain their chosen time', async t => {
  for (const deferred of [false, true]) await t.test(String(deferred), async t => {
    const f = await fixture(t); f.life.setStartGate(() => true);
    await f.life.addThought(thought('reading', { expiresAt: origin + 35 * minute }));
    const plan = await f.life.planThought('reading');
    if (deferred) {
      await f.life.resolveStart(plan.id, { decisionId: plan.startTransition.id, outcome: 'defer' });
      f.advance(minute); await f.reopen();
      assert.equal(f.life.snapshot().plans[0].startAt, origin + 5 * minute);
      assert.equal(f.life.snapshot().plans[0].status, 'planned');
    } else {
      f.advance(40 * minute); await f.reopen();
      assert.equal(f.life.snapshot().plans[0].status, 'missed');
      assert.equal(f.life.snapshot().events.filter(e => e.type === 'activity-started').length, 0);
    }
  });
});

test('ordinary reply capture remains invalid after a busy activity both starts and ends', async t => {
  const f = await fixture(t), token = f.life.captureReply();
  assert.equal(f.life.isReplyCurrent(token), true);
  await f.life.addThought(thought('short', { activity: { ...thought().activity, durationMs: minute } }));
  await f.life.planThought('short');
  assert.equal(f.life.captureReply(), null); assert.equal(f.life.isReplyCurrent(token), false);
  await f.tickMinutes(1);
  assert.equal(f.life.availability().busy, false); assert.equal(f.life.isReplyCurrent(token), false);
  const current = f.life.captureReply(); assert.equal(f.life.isReplyCurrent(current), true);
  await f.reopen(); assert.equal(f.life.isReplyCurrent(token), false); assert.equal(f.life.isReplyCurrent(current), true);
  assert.equal(f.life.isReplyCurrent(null), false); assert.equal(f.life.isReplyCurrent({ ...current, supplied: true }), false);
});

test('an asynchronous gate cannot bypass start coordination or commit a partial hold', async t => {
  const f = await fixture(t); f.life.setStartGate(async () => true);
  await f.life.addThought(thought());
  await assert.rejects(f.life.planThought('reading'), /synchronous boolean/);
  assert.equal(f.life.snapshot().plans.length, 0);
  f.life.setStartGate(async () => { throw Error('rejected gate'); });
  await assert.rejects(f.life.planThought('reading'), /synchronous boolean/);
  await new Promise(done => setImmediate(done));
  f.life.setStartGate(null);
  assert.equal((await f.life.planThought('reading')).status, 'active');
});

test('deferred decisions recheck the synchronous caller guard inside the timeline queue', async t => {
  const f = await fixture(t); f.life.setStartGate(() => true);
  await f.life.addThought(thought('reading', { expiresAt: origin + 35 * minute }));
  const plan = await f.life.planThought('reading'); let current = true;
  const choice = f.life.resolveStart(plan.id, { decisionId: plan.startTransition.id, outcome: 'defer', guard: () => current });
  current = false;
  assert.equal((await choice).kind, 'stale'); assert.equal(f.life.pendingStart().id, plan.id);
  await assert.rejects(f.life.resolveStart(plan.id, { decisionId: plan.startTransition.id, outcome: 'defer', guard: async () => true }), /synchronous boolean/);
  await assert.rejects(f.life.resolveStart(plan.id, { decisionId: plan.startTransition.id, outcome: 'defer', guard: async () => { throw Error('rejected guard'); } }), /synchronous boolean/);
  await new Promise(done => setImmediate(done));
  assert.equal((await f.life.resolveStart(plan.id, { decisionId: plan.startTransition.id, outcome: 'start' })).kind, 'resolved');
});

test('a decision cannot defer across an observation gap even before its thirty-second deadline', async t => {
  const f = await fixture(t, { policy: { maxObservationGapMs: 1000 } }); f.life.setStartGate(() => true);
  await f.life.addThought(thought('reading', { expiresAt: origin + 35 * minute }));
  const plan = await f.life.planThought('reading'); f.advance(1001);
  assert.equal((await f.life.resolveStart(plan.id, { decisionId: plan.startTransition.id, outcome: 'defer' })).kind, 'stale');
  assert.equal(f.life.snapshot().plans[0].startTransition.status, 'uncertain');
  assert.equal(f.life.snapshot().plans[0].startAt, origin);
});

test('a process crash after its start reservation never repeats comparison or stale farewell work', async t => {
  const f = await fixture(t); await f.life.close();
  const moduleUrl = pathToFileURL(resolve('src/life-timeline.js')).href;
  const code = `import { createLifeTimeline } from ${JSON.stringify(moduleUrl)};
const life = await createLifeTimeline({directory:process.argv[1], now:()=>${origin}});
life.setStartGate(()=>true); await life.addThought(${JSON.stringify(thought())});
await life.planThought('reading'); process.exit(0);`;
  await execute(process.execPath, ['--input-type=module', '-e', code, f.directory], { windowsHide: true });
  f.advance(1000); const recovered = await f.reopen(); let comparisons = 0;
  recovered.setStartGate(() => { comparisons++; return true; }); await recovered.tick();
  assert.equal(recovered.snapshot().plans[0].startTransition.status, 'uncertain');
  assert.equal(recovered.snapshot().plans[0].status, 'active'); assert.equal(comparisons, 0);
  assert.equal(recovered.snapshot().events.filter(item => item.type === 'plan-start-held').length, 1);
  assert.equal(recovered.snapshot().events.filter(item => item.type === 'activity-started').length, 1);
});

test('non-busy plans bypass the comparison and invalid deferral inputs preserve the pending choice', async t => {
  const f = await fixture(t); let calls = 0; f.life.setStartGate(() => { calls++; return true; });
  await f.life.addThought(thought('available', { activity: { ...thought().activity, busy: false, durationMs: minute } }));
  const available = await f.life.planThought('available'); assert.equal(available.status, 'active'); assert.equal(calls, 0);
  await f.tickMinutes(1);
  await f.life.addThought(thought('reading', { expiresAt: f.time() + 35 * minute }));
  const held = await f.life.planThought('reading');
  for (const delayMs of [0, -1, 300001, 0.5]) await assert.rejects(f.life.resolveStart(held.id,
    { decisionId: held.startTransition.id, outcome: 'defer', delayMs }), /five minutes/);
  assert.equal((await f.life.resolveStart(held.id, { decisionId: 'other', outcome: 'defer' })).kind, 'stale');
  assert.equal(f.life.pendingStart().startTransition.id, held.startTransition.id); assert.equal(calls, 1);
});

test('executable action claims are durable, singular and cannot be retried after restart', async t => {
  const f = await fixture(t), activity = { ...thought().activity, mode: 'external', action: { type: 'browse', target: '云朵' } };
  await f.life.addThought(thought('browse', { activity }));
  const plan = await f.life.planThought('browse');
  const results = await Promise.all([f.life.claimAction(plan.id), f.life.claimAction(plan.id)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(results.find(Boolean).actionClaim, { planId: plan.id, claimedAt: origin });
  assert.equal(f.life.snapshot().events.filter(item => item.type === 'activity-action-claimed').length, 1);
  await f.reopen();
  assert.equal(f.life.snapshot().plans[0].status, 'interrupted');
  assert.deepEqual(f.life.snapshot().plans[0].actionClaim, { planId: plan.id, claimedAt: origin });
  assert.equal(await f.life.claimAction(plan.id), null);
});

test('only active typed actions can be claimed and private target stays out of other availability', async t => {
  const f = await fixture(t), activity = { ...thought().activity, mode: 'external', action: { type: 'browse', target: 'PRIVATE_SEARCH_NEEDLE' } };
  await f.life.addThought(thought('private-browse', { source: { kind: 'chat', scope: 'qq:private:123' }, activity }));
  const plan = await f.life.planThought('private-browse', { startAt: origin + minute });
  assert.equal(await f.life.claimAction(plan.id), null);
  await f.tickMinutes(1); await f.life.claimAction(plan.id);
  assert.match(JSON.stringify(f.life.availability({ scope: 'qq:private:123' })), /PRIVATE_SEARCH_NEEDLE/);
  assert.doesNotMatch(JSON.stringify(f.life.availability({ scope: 'qq:private:456' })), /PRIVATE_SEARCH_NEEDLE|actionClaim/);
  assert.doesNotMatch(JSON.stringify(f.life.availability()), /PRIVATE_SEARCH_NEEDLE|actionClaim/);
  await f.life.failActivity(plan.id, 'cancelled-reading'); assert.equal(await f.life.claimAction(plan.id), null);
  await f.life.addThought(thought('ordinary', { activity: { ...thought().activity, busy: false } }));
  const ordinary = await f.life.planThought('ordinary'); assert.equal(await f.life.claimAction(ordinary.id), null);
});

test('typed activities cannot masquerade as simulated results or busy contact gates', async t => {
  const f = await fixture(t);
  await assert.rejects(f.life.addThought(thought('invalid', { activity: { ...thought().activity, action: { type: 'browse', target: '风景' } } })), /external mode/);
  await assert.rejects(f.life.addThought(thought('invalid', { activity: { ...thought().activity, mode: 'external', action: { type: 'contact' } } })), /cannot make private chat busy/);
});

test('quiet days are normal: ticks and restarts do not create thoughts, plans or experiences', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) { f.advance(day); await f.life.tick(); }
  const before = f.life.snapshot();
  assert.equal(before.sequence, 0); assert.deepEqual(before.events, []);
  assert.deepEqual(before.plans, []); assert.deepEqual(before.thoughts, []);
  assert.equal(f.life.availability().busy, false);
  assert.match(f.life.formatContext(), /没有新经历也正常/);
  await f.reopen();
  assert.equal(await readFile(f.life.files.journal, 'utf8'), '');
  assert.deepEqual(f.life.snapshot().events, []);
});

test('a source-backed thought drives a non-hourly plan, then one simulated outcome', async t => {
  const f = await fixture(t);
  await f.life.addThought(thought());
  const plan = await f.life.planThought('reading', { id: 'p-reading', startAt: origin + 7 * minute });
  assert.equal(plan.status, 'planned'); assert.equal(f.life.availability().busy, false);
  await f.tickMinutes(7);
  assert.deepEqual(f.life.availability().activity.source, { kind: 'interest', ref: 'existing-reading-interest' });
  assert.equal(f.life.availability().activity.actualStartedAt, origin + 7 * minute);
  assert.equal(f.life.availability().statusText, '*看书中…勿扰');
  await f.tickMinutes(30);
  await f.life.tick(); await f.life.tick();
  const state = f.life.snapshot();
  assert.equal(state.plans[0].status, 'completed'); assert.equal(state.thoughts[0].status, 'completed');
  assert.equal(state.events.filter(item => item.type === 'activity-completed').length, 1);
  assert.equal(state.events.find(item => item.type === 'activity-completed').reason, 'simulated-time-elapsed');
  assert.match(f.life.formatContext(), /模拟经历不能伪装成真实网页/);
  const copy = f.life.snapshot(); copy.plans[0].status = 'active';
  assert.equal(f.life.availability().busy, false, 'callers cannot mutate the internal state');
});

test('late startup enters only the remainder of a current slot; missed slots are not replayed', async t => {
  const f = await fixture(t);
  await f.life.addThought(thought('missed', { activity: { ...thought().activity, durationMs: 10 * minute } }));
  await f.life.addThought(thought('current'));
  await f.life.planThought('missed', { startAt: origin + 10 * minute });
  await f.life.planThought('current', { startAt: origin + 40 * minute });
  f.set(origin + 51 * minute); await f.reopen();
  const state = f.life.snapshot(), current = state.plans.find(item => item.thoughtId === 'current');
  assert.equal(state.plans.find(item => item.thoughtId === 'missed').status, 'missed');
  assert.equal(current.status, 'active'); assert.equal(current.startAt, origin + 40 * minute);
  assert.equal(current.actualStartedAt, origin + 51 * minute);
  assert.equal(current.endAt, origin + 70 * minute);
  assert.equal(state.events.filter(item => item.type === 'activity-completed').length, 0);
  await f.tickMinutes(19);
  assert.equal(f.life.snapshot().plans.find(item => item.id === current.id).status, 'completed');
});

test('restart interrupts an active slot even if its old end is past, and never auto-retries it', async t => {
  const f = await fixture(t);
  await f.life.addThought(thought()); const plan = await f.life.planThought('reading');
  await f.tickMinutes(4); f.advance(day); await f.reopen();
  const state = f.life.snapshot();
  assert.equal(state.plans[0].id, plan.id); assert.equal(state.plans[0].status, 'interrupted');
  assert.equal(state.plans[0].observedUntil, origin + 4 * minute);
  assert.equal(state.thoughts[0].status, 'interrupted');
  assert.equal(f.life.availability().busy, false);
  assert.equal(state.events.filter(item => item.type === 'activity-completed').length, 0);
  await assert.rejects(f.life.planThought('reading'), /Only a pending thought/);
  await f.life.postponeThought('reading', f.time() + minute, '明天再继续');
  const next = await f.life.planThought('reading');
  assert.notEqual(next.id, plan.id); assert.equal(next.status, 'planned');
});

test('a stalled event loop and a backwards clock are interruptions, not elapsed experience', async t => {
  const f = await fixture(t);
  await f.life.addThought(thought()); await f.life.planThought('reading');
  f.advance(40 * minute); await f.life.tick();
  assert.equal(f.life.snapshot().plans[0].reason, 'observation-gap');
  assert.equal(f.life.snapshot().plans[0].observedUntil, origin);
  await f.life.addThought(thought('second')); await f.life.planThought('second');
  f.advance(-minute); await f.life.tick();
  assert.equal(f.life.snapshot().plans[1].reason, 'clock-moved-backward');
  assert.equal(f.life.availability().busy, false);
});

test('busy limits cover neighboring activities and Beijing daily slices across midnight', async t => {
  const start = Date.parse('2026-10-27T23:40:00+08:00');
  const f = await fixture(t, { time: start, policy: { maxDailyBusyMs: 50 * minute } });
  const activity = { ...thought().activity, durationMs: 40 * minute };
  await f.life.addThought(thought('first', { activity }));
  await f.life.planThought('first');
  await f.life.addThought(thought('second', { activity }));
  await assert.rejects(f.life.planThought('second', { startAt: start + 40 * minute }), /available interval/);
  await assert.rejects(f.life.planThought('second', { startAt: start + 55 * minute }), /Beijing daily busy limit/);
  const shorter = await f.life.planThought('second', { startAt: start + 55 * minute, durationMs: 30 * minute });
  assert.equal(shorter.status, 'planned');
  assert.equal(beijingDay(start), '2026-10-27');
  assert.equal(beijingDay(start + 20 * minute), '2026-10-28');
  await f.life.addThought(thought('too-long', { activity: { ...activity, durationMs: 46 * minute } }));
  await assert.rejects(f.life.planThought('too-long', { startAt: start + 2 * day }), /continuous busy limit/);
});

test('completed busy time still reserves the minimum available gap and the daily limit', async t => {
  const f = await fixture(t, { policy: { maxDailyBusyMs: 45 * minute } });
  await f.life.addThought(thought()); await f.life.planThought('reading'); await f.tickMinutes(30);
  await f.life.addThought(thought('next'));
  await assert.rejects(f.life.planThought('next'), /available interval/);
  await assert.rejects(f.life.planThought('next', { startAt: f.time() + 15 * minute }), /daily busy limit/);
  const short = await f.life.planThought('next', { startAt: f.time() + 15 * minute, durationMs: 15 * minute });
  assert.equal(short.status, 'planned');
});

test('rest and non-busy activity do not gate availability; pending thoughts can cross days', async t => {
  const f = await fixture(t);
  const activity = { title: '发呆', durationMs: 2 * 60 * minute, busy: false, mode: 'simulated' };
  await f.life.addThought(thought('rest', { activity }));
  const rest = await f.life.planThought('rest');
  assert.equal(rest.status, 'active'); assert.equal(f.life.availability().busy, false);
  await f.life.addThought(thought('tomorrow', { notBefore: origin + day }));
  await f.reopen(); f.advance(day); await f.life.tick();
  assert.equal(f.life.snapshot().thoughts.find(item => item.id === 'tomorrow').status, 'pending');
  assert.equal((await f.life.planThought('tomorrow')).status, 'active');
});

test('postponement, failure, abandonment and expiry preserve causes without forced completion', async t => {
  const f = await fixture(t);
  await f.life.addThought(thought()); await f.life.planThought('reading', { startAt: origin + minute });
  await f.life.postponeThought('reading', origin + 20 * minute, '今天不太想看书');
  assert.equal(f.life.snapshot().plans[0].status, 'cancelled');
  const next = await f.life.planThought('reading');
  await f.life.failActivity(next.id, '没有找到想看的素材');
  assert.equal(f.life.snapshot().thoughts[0].status, 'failed');
  await f.life.abandonThought('reading', '先不看了');
  await f.life.abandonThought('reading', '先不看了');
  assert.equal(f.life.snapshot().events.filter(item => item.type === 'thought-abandoned').length, 1);
  await f.life.addThought(thought('expiring', { expiresAt: origin + minute }));
  f.advance(minute); await f.life.tick();
  assert.equal(f.life.snapshot().thoughts.find(item => item.id === 'expiring').status, 'expired');
  assert.equal(f.life.snapshot().events.some(item => item.type === 'activity-completed'), false);
});

test('external activities require explicit result evidence; a timer cannot invent a reading result', async t => {
  const f = await fixture(t);
  const activity = { title: '读取已有网页', durationMs: minute, busy: false, mode: 'external' };
  await f.life.addThought(thought('web', { source: { kind: 'world', ref: 'board-record-1' }, activity }));
  const first = await f.life.planThought('web');
  await assert.rejects(f.life.completeActivity(first.id, { summary: '看完了' }), /actual result evidence/);
  await f.tickMinutes(1);
  assert.equal(f.life.snapshot().plans[0].status, 'failed');
  assert.equal(f.life.snapshot().plans[0].reason, 'external-result-missing');
  await f.life.addThought(thought('web2', { source: { kind: 'world', ref: 'board-record-2' }, activity }));
  const second = await f.life.planThought('web2');
  const done = await f.life.completeActivity(second.id, { summary: '已有札记记下了主题', evidence: { source: { kind: 'world' }, ref: 'board:record-2' } });
  assert.equal(done.status, 'completed');
  assert.equal(f.life.snapshot().events.at(-1).evidence.ref, 'board:record-2');
  await f.life.completeActivity(second.id, { summary: 'ignored duplicate completion' });
  assert.equal(f.life.snapshot().events.filter(item => item.type === 'activity-completed').length, 1);
});

test('private-origin life material is not displayed in another contact context or generic availability', async t => {
  const f = await fixture(t);
  await f.life.addThought(thought('private', { text: '想起甲的个人事情', source: { kind: 'conversation', scope: 'qq:private:100', ref: 'message-1' },
    activity: { title: '整理甲的私人谜题', statusText: '*在想甲的私人谜题', durationMs: minute, busy: true, mode: 'simulated' } }));
  await f.life.planThought('private');
  assert.match(f.life.availability({ scope: 'qq:private:100' }).title, /甲/);
  assert.doesNotMatch(JSON.stringify(f.life.availability()), /甲|message-1|qq:private:100/);
  assert.doesNotMatch(f.life.formatContext({ scope: 'qq:private:200' }), /甲|message-1/);
  await f.tickMinutes(1);
  assert.match(f.life.formatContext({ scope: 'qq:private:100' }), /甲/);
  assert.doesNotMatch(f.life.formatContext(), /甲/);
});

test('concurrent calls serialize; stable thought and plan ids prevent duplicate retries', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 10 }, () => f.life.addThought(thought())));
  await Promise.all(Array.from({ length: 10 }, () => f.life.planThought('reading', { id: 'same-plan' })));
  assert.equal(f.life.snapshot().thoughts.length, 1); assert.equal(f.life.snapshot().plans.length, 1);
  assert.equal(f.life.snapshot().events.filter(item => item.type === 'activity-started').length, 1);
  await assert.rejects(f.life.addThought(thought('reading', { text: 'different thought' })), /different content/);
  await assert.rejects(createLifeTimeline({ directory: f.directory }), /active writer/);
  await f.life.close(); await assert.rejects(f.life.tick(), /closed/);
});

test('recovery reads committed journal beyond an older snapshot and does not re-run decisions', async t => {
  const f = await fixture(t);
  const oldSnapshot = await readFile(f.life.files.snapshot);
  await f.life.addThought(thought());
  const before = f.life.snapshot();
  await f.life.close(); await writeFile(f.life.files.snapshot, oldSnapshot);
  const recovered = await f.reopen();
  assert.deepEqual(recovered.snapshot().events, before.events);
  assert.deepEqual(recovered.snapshot().thoughts, before.thoughts);
  assert.equal(recovered.snapshot().sequence, before.sequence);
});

test('an incomplete trailing write is preserved then truncated; valid committed history survives', async t => {
  const f = await fixture(t);
  await f.life.addThought(thought()); const before = await readFile(f.life.files.journal);
  await f.life.close(); await appendFile(f.life.files.journal, '{"version":1,"sequence":2,"events":[');
  const recovered = await f.reopen();
  assert.equal(recovered.snapshot().thoughts.length, 1);
  assert.deepEqual(await readFile(recovered.files.journal), before);
  assert.match(recovered.diagnostics.warnings[0], /Preserved incomplete/);
  const tails = (await readdir(f.directory)).filter(name => name.includes('.incomplete-'));
  assert.equal(tails.length, 1); assert.match(await readFile(join(f.directory, tails[0]), 'utf8'), /sequence/);
});

test('a corrupt complete transaction and a missing committed journal fail closed, preserving files', async t => {
  const f = await fixture(t);
  await f.life.addThought(thought()); await f.life.close();
  const original = await readFile(f.life.files.journal);
  await appendFile(f.life.files.journal, '{"bad":"complete"}\n');
  const corrupt = await readFile(f.life.files.journal);
  await assert.rejects(createLifeTimeline({ directory: f.directory, now: f.time }), /Invalid life journal/);
  assert.deepEqual(await readFile(f.life.files.journal), corrupt);
  await writeFile(f.life.files.journal, '');
  await assert.rejects(createLifeTimeline({ directory: f.directory, now: f.time }), /missing committed snapshot history/);
  assert.equal(await readFile(f.life.files.journal, 'utf8'), '');
  await writeFile(f.life.files.journal, original);
});

test('a snapshot write failure does not turn an already committed mutation into a retryable failure', async t => {
  const f = await fixture(t);
  await rm(f.life.files.snapshot); await mkdir(f.life.files.snapshot);
  const added = await f.life.addThought(thought());
  assert.equal(added.id, 'reading');
  assert.match(f.life.diagnostics.warnings.at(-1), /committed journal remains authoritative/);
  await rmdir(f.life.files.snapshot);
  await f.reopen();
  assert.equal(f.life.snapshot().thoughts.length, 1);
  await f.life.addThought(thought());
  assert.equal(f.life.snapshot().thoughts.length, 1);
});

test('a process that exits without close leaves a verifiable stale lock and recovers without replay', async t => {
  const f = await fixture(t); await f.life.close();
  const moduleUrl = pathToFileURL(resolve('src/life-timeline.js')).href;
  const code = `import { createLifeTimeline } from ${JSON.stringify(moduleUrl)};
const life = await createLifeTimeline({directory:process.argv[1], now:()=>${origin}});
await life.addThought(${JSON.stringify(thought())}); await life.planThought('reading'); process.exit(0);`;
  await execute(process.execPath, ['--input-type=module', '-e', code, f.directory], { windowsHide: true });
  f.set(origin + 40 * minute);
  const recovered = await f.reopen();
  assert.equal(recovered.snapshot().plans[0].status, 'interrupted');
  assert.equal(recovered.snapshot().events.filter(item => item.type === 'activity-started').length, 1);
  assert.equal(recovered.snapshot().events.filter(item => item.type === 'activity-completed').length, 0);
});

test('unknown state versions and unverifiable writer locks are not reset', async t => {
  const f = await fixture(t); await f.life.close();
  await writeFile(f.life.files.snapshot, JSON.stringify({ version: 999, sequence: 0, lastHash: null }));
  await assert.rejects(createLifeTimeline({ directory: f.directory }), /Unsupported life snapshot version/);
  assert.match(await readFile(f.life.files.snapshot, 'utf8'), /999/);
  await writeFile(join(f.directory, '.writer.lock'), '{"pid":0}');
  await assert.rejects(createLifeTimeline({ directory: f.directory }), /Unverifiable life writer lock/);
  assert.equal(await readFile(join(f.directory, '.writer.lock'), 'utf8'), '{"pid":0}');
});
