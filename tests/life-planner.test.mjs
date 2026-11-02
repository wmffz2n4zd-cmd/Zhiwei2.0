import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createLifeTimeline } from '../src/life-timeline.js';
import { createLifeState } from '../src/life-state.js';
import { createLifePlanner, lifePlanningContext, lifeSourceRefs, parseLifeDecision, buildLifePlanningPrompt } from '../src/life-planner.js';

const minute = 60000, day = 1440 * minute;
const rest = () => ({ thoughts: [], reconsiderAfterMinutes: 240 });
const thought = (extras = {}) => ({ text: '想安静画一会画', sourceRefs: ['profile'], strength: 0.7,
  title: '画画', statusText: '*画画中，稍后回来', busy: true, durationMinutes: 20, delayMinutes: 0, ...extras });
const decision = (...thoughts) => ({ ...rest(), thoughts });
async function fixture(t) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'life-planner-')), opened = [];
  let at = Date.parse('2026-10-27T10:23:00Z');
  t.after(async () => {
    for (const item of opened.reverse()) await item.close().catch(() => {});
    if (resolve(directory).startsWith(base + sep)) await rm(directory, { recursive: true, force: true });
  });
  return { directory, now: () => at, advance: value => { at += value; },
    async open(decide, wrap = value => value, options = {}) {
      const timeline = await createLifeTimeline({ directory, now: () => at }); opened.push(timeline);
      const planner = await createLifePlanner({ directory, timeline: wrap(timeline), decide, now: () => at, ...options }); opened.push(planner);
      return { timeline, planner, close: async () => { await planner.close(); await timeline.close(); } };
    }
  };
}

test('explicit planning flexibility supports one full delay without inventing slack for old decisions', async t => {
  for (const flexMinutes of [undefined, 0, 5]) await t.test(String(flexMinutes), async t => {
    const f = await fixture(t), value = thought(flexMinutes == null ? {} : { flexMinutes });
    const r = await f.open(async () => decision(value)); r.timeline.setStartGate(() => true);
    await r.planner.tick();
    const plan = r.timeline.pendingStart(), item = r.timeline.snapshot().thoughts[0];
    assert.equal(item.expiresAt, plan.endAt + (flexMinutes || 0) * minute);
    const result = await r.timeline.resolveStart(plan.id, { decisionId: plan.startTransition.id, outcome: 'defer' });
    assert.equal(result.kind, flexMinutes === 5 ? 'resolved' : 'cannot-defer');
    assert.equal(Object.hasOwn(r.planner.snapshot().attempt.decision.thoughts[0], 'flexMinutes'), flexMinutes != null);
    await r.close();
    const resumed = await f.open(async () => { throw Error('cannot repeat'); });
    assert.equal(resumed.planner.snapshot().attempt.decision.thoughts[0].flexMinutes, flexMinutes);
  });
});

test('planning flexibility is bounded by five minutes and the original planning horizon', () => {
  for (const extra of [{ flexMinutes: -1 }, { flexMinutes: 6 }, { flexMinutes: 1.5 },
    { flexMinutes: 5, delayMinutes: 1418 }, { flexMinutes: '5' }]) {
    assert.throws(() => parseLifeDecision(decision(thought(extra)), ['profile']));
  }
  assert.deepEqual(parseLifeDecision(decision(thought({ flexMinutes: 0 })), ['profile']), decision(thought({ flexMinutes: 0 })));
  assert.match(buildLifePlanningPrompt('', { policy: {} }), /真实截止.*用0/);
});

test('typed browse and contact intentions survive planner import as external actions with no predicted effects', async t => {
  for (const action of [{ type: 'browse', target: '雨后森林' }, { type: 'contact' }]) await t.test(action.type, async t => {
    const f = await fixture(t), expected = thought({ action, effects: null, busy: false, delayMinutes: 5 });
    const r = await f.open(async () => decision(expected));
    await r.planner.tick();
    assert.deepEqual(r.timeline.snapshot().thoughts[0].activity.action, action);
    assert.deepEqual(r.timeline.snapshot().plans[0].action, action);
    assert.equal(r.timeline.snapshot().plans[0].mode, 'external');
    await r.close();
    const resumed = await f.open(async () => { throw Error('no new decision'); });
    assert.deepEqual(resumed.timeline.snapshot().plans[0].action, action);
    assert.equal(resumed.timeline.snapshot().plans[0].status, 'planned');
  });
});

test('typed actions reject extra capabilities, private recipients, busy contacts and predicted effects; legacy shape remains unchanged', () => {
  const effects = { version: 't030-1', mood: { valence: 0.1, energy: 0, tension: 0 }, interest: null };
  for (const extra of [
    { action: { type: 'command', target: 'run' } }, { action: { type: 'contact', scope: 'qq:private:123' }, busy: false },
    { action: { type: 'contact' }, busy: true }, { action: { type: 'browse', target: 'abc\nxyz' } },
    { action: { type: 'browse', target: 'x'.repeat(151) } }, { action: { type: 'browse', target: '' } },
    { action: { type: 'browse', target: '风景' }, effects }
  ]) assert.throws(() => parseLifeDecision(decision(thought(extra)), ['profile']));
  assert.deepEqual(parseLifeDecision(decision(thought()), ['profile']), decision(thought()));
  assert.deepEqual(parseLifeDecision(decision(thought({ action: null })), ['profile']), decision(thought({ action: null })));
});

test('autonomous source creates a persisted thought, plan and availability without a chat trigger', async t => {
  const f = await fixture(t); let input;
  const { planner, timeline } = await f.open(async context => { input = context; return decision(thought()); });
  assert.deepEqual(await planner.tick(), { kind: 'applied', outcomes: ['planned'] });
  assert.equal(input.beijingDay, '2026-10-27');
  const state = timeline.snapshot();
  assert.equal(state.thoughts.length, 1); assert.equal(state.plans.length, 1);
  assert.equal(state.plans[0].status, 'active'); assert.equal(state.plans[0].mode, 'simulated');
  assert.equal(state.thoughts[0].source.kind, 'life-planner');
  assert.deepEqual(JSON.parse(state.thoughts[0].source.ref), ['profile']);
  assert.equal(timeline.availability().busy, true);
  assert.match(timeline.formatContext(), /模拟.*并未实际读取/);
});

test('empty days produce no life events, and the daily cap and next decision survive restart', async t => {
  const f = await fixture(t); f.advance(-10 * 60 * minute); let calls = 0;
  let running = await f.open(async () => { calls++; return rest(); });
  for (let i = 0; i < 3; i++) { await running.planner.tick(); f.advance(240 * minute); }
  await running.planner.tick(); assert.equal(calls, 3);
  assert.equal(running.timeline.snapshot().events.length, 0);
  await running.close();
  running = await f.open(async () => { calls++; return { ...rest(), reconsiderAfterMinutes: 1440 }; });
  await running.planner.tick(); assert.equal(calls, 3, 'the same-day cap survives a process restart');
  f.advance(240 * minute); await running.planner.tick(); assert.equal(calls, 4);
  for (let i = 0; i < 3; i++) { f.advance(day); await running.planner.tick(); }
  assert.equal(running.timeline.snapshot().events.length, 0);
  assert.equal(await readFile(join(f.directory, 'journal.jsonl'), 'utf8'), '');
});

test('three checks per Beijing day is an upper bound even if rest asks for frequent reconsideration', async t => {
  const f = await fixture(t); f.advance(-10 * 60 * minute); // 08:23 Beijing
  let calls = 0; const r = await f.open(async () => { calls++; return rest(); });
  for (let i = 0; i < 4; i++) { await r.planner.tick(); f.advance(240 * minute); }
  assert.equal(calls, 3);
  await r.close();
  const restarted = await f.open(async () => { calls++; return rest(); });
  await restarted.planner.tick(); assert.equal(calls, 4, 'only the new calendar day permits another check');
});

test('observation permits a fourth daily planning attempt while preserving spacing and restart history', async t => {
  const f = await fixture(t); f.advance(-18 * 60 * minute); // 00:23 Beijing
  let calls = 0;
  const decide = async () => { calls++; return rest(); };
  const options = { enforceDailyLimit: false };
  const r = await f.open(decide, undefined, options);
  for (let i = 0; i < 4; i++) {
    assert.equal((await r.planner.tick()).kind, 'applied');
    for (let repeat = 0; repeat < 5; repeat++) assert.equal((await r.planner.tick()).kind, 'waiting');
    f.advance(240 * minute);
  }
  assert.equal(calls, 4);
  assert.equal(r.planner.snapshot().days['2026-10-27'], 4);
  await r.close();
  const restarted = await f.open(decide, undefined, options);
  assert.equal((await restarted.planner.tick()).kind, 'applied');
  assert.equal(calls, 5);
  assert.equal(restarted.planner.snapshot().days['2026-10-27'], 5);
  await restarted.close(); f.advance(240 * minute);
  const limited = await f.open(decide);
  assert.equal((await limited.planner.tick()).kind, 'waiting', 'restoring daily enforcement keeps observed attempts');
  assert.equal(calls, 5);
});

test('observation keeps existing plans from driving extra model calls', async t => {
  const f = await fixture(t); let calls = 0;
  const r = await f.open(async () => { calls++; return decision(thought({ delayMinutes: 600 })); }, undefined,
    { enforceDailyLimit: false });
  await r.planner.tick(); f.advance(240 * minute);
  assert.equal((await r.planner.tick()).kind, 'existing-plans'); assert.equal(calls, 1);
  await r.close();
  const resumed = await f.open(async () => { calls++; throw Error('unexpected repeat'); }, undefined,
    { enforceDailyLimit: false });
  assert.equal((await resumed.planner.tick()).kind, 'existing-plans'); assert.equal(calls, 1);
});

test('a failed observed planner attempt preserves spacing through restart', async t => {
  const f = await fixture(t); let calls = 0;
  const r = await f.open(async () => { calls++; throw Error('temporary model failure'); }, undefined,
    { enforceDailyLimit: false });
  assert.equal((await r.planner.tick()).kind, 'decision-failed');
  for (let i = 0; i < 20; i++) assert.equal((await r.planner.tick()).kind, 'waiting');
  await r.close();
  const resumed = await f.open(async () => { calls++; return rest(); }, undefined, { enforceDailyLimit: false });
  assert.equal((await resumed.planner.tick()).kind, 'waiting'); assert.equal(calls, 1);
  f.advance(240 * minute);
  assert.equal((await resumed.planner.tick()).kind, 'applied'); assert.equal(calls, 2);
});

test('private thoughts, plans, experiences and source refs never enter global planning', async t => {
  const f = await fixture(t), { timeline } = await f.open(async () => rest());
  await timeline.addThought({ id: 'private', text: 'PRIVATE_MEMORY', source: { kind: 'chat', scope: 'qq:other', ref: 'PRIVATE_SOURCE' },
    activity: { title: 'PRIVATE_ACTIVITY', mode: 'simulated', busy: false, durationMs: minute } });
  await timeline.planThought('private'); await timeline.completeActivity(timeline.snapshot().plans[0].id, { summary: 'PRIVATE_RESULT' });
  const context = lifePlanningContext(timeline, f.now());
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE|qq:other/);
  assert.deepEqual(lifeSourceRefs(context), ['profile']);
  assert.match(buildLifePlanningPrompt('PERSONA_FACT', context), /PERSONA_FACT/);
  assert.throws(() => parseLifeDecision(decision(thought({ sourceRefs: ['thought:private'] })), lifeSourceRefs(context)), /unavailable source/);
});

test('decisions reject invented citations, extra capabilities, malformed times and oversized batches', () => {
  for (const value of [
    { ...rest(), tool: 'exec' }, decision(thought({ sourceRefs: ['made-up'] })),
    decision(thought({ url: 'https://example.org' })), decision(thought({ busy: 'false' })),
    decision(thought({ durationMinutes: 46 })), decision(thought({ delayMinutes: 1440 })),
    decision(thought({ strength: 2 })), decision(thought({ statusText: 'bad\ncommand' })),
    decision(thought(), thought(), thought(), thought()), { ...rest(), reconsiderAfterMinutes: 1 }
  ]) assert.throws(() => parseLifeDecision(value, ['profile']));
  assert.deepEqual(parseLifeDecision(JSON.stringify(rest()), ['profile']), rest());
});

test('an invalid decision consumes an attempt, stays blank and cannot spin on every tick', async t => {
  const f = await fixture(t); let calls = 0;
  const r = await f.open(async () => { calls++; return decision(thought({ sourceRefs: ['imaginary'] })); });
  assert.equal((await r.planner.tick()).kind, 'decision-failed');
  for (let i = 0; i < 20; i++) await r.planner.tick();
  assert.equal(calls, 1); assert.equal(r.timeline.snapshot().thoughts.length, 0);
  assert.equal(r.planner.snapshot().attempt.status, 'failed');
});

test('recovery of an unknown claimed model invocation does not call again or invent results', async t => {
  const f = await fixture(t); let calls = 0;
  const r = await f.open(async () => { calls++; return rest(); }); await r.planner.tick();
  const state = r.planner.snapshot(); state.attempt.status = 'claimed'; delete state.attempt.decision;
  await r.close(); await writeFile(join(f.directory, 'planner.json'), JSON.stringify(state));
  const resumed = await f.open(async () => { calls++; return decision(thought()); });
  assert.equal(resumed.planner.snapshot().attempt.status, 'uncertain');
  await resumed.planner.tick(); assert.equal(calls, 1); assert.equal(resumed.timeline.snapshot().events.length, 0);
});

test('a committed decision resumes after a partial import with stable ids and no model retry', async t => {
  const f = await fixture(t); let calls = 0, fail = true;
  const r = await f.open(async () => { calls++; return decision(thought({ delayMinutes: 10 })); }, timeline => ({
    ...timeline, planThought: async (...args) => { if (fail) { fail = false; throw Error('injected interruption'); } return timeline.planThought(...args); }
  }));
  await assert.rejects(r.planner.tick(), /injected/);
  assert.equal(r.timeline.snapshot().thoughts.length, 1); assert.equal(r.timeline.snapshot().plans.length, 0);
  await r.close(); f.advance(15 * minute);
  const resumed = await f.open(async () => { calls++; throw Error('must not call'); });
  await resumed.planner.tick();
  const state = resumed.timeline.snapshot();
  assert.equal(calls, 1); assert.equal(state.thoughts.length, 1); assert.equal(state.plans.length, 1);
  assert.equal(state.plans[0].startAt, f.now()); assert.equal(state.plans[0].durationMs, 15 * minute);
  await resumed.planner.tick(); assert.equal(resumed.timeline.snapshot().plans.length, 1);
});

test('recovery after a plan commit cannot execute or append that activity twice', async t => {
  const f = await fixture(t); let first = true;
  const r = await f.open(async () => decision(thought()), timeline => ({ ...timeline,
    planThought: async (...args) => { const result = await timeline.planThought(...args); if (first) { first = false; throw Error('after commit'); } return result; }
  }));
  await assert.rejects(r.planner.tick(), /after commit/); await r.close();
  const resumed = await f.open(async () => { throw Error('no retry'); });
  await resumed.planner.tick();
  assert.equal(resumed.timeline.snapshot().plans.length, 1);
  assert.equal(resumed.timeline.snapshot().plans[0].status, 'interrupted');
  assert.deepEqual(resumed.planner.snapshot().attempt.outcomes, ['already-consumed']);
});

test('a late model result preserves only the remaining window; a fully missed window stays empty', async t => {
  for (const elapsed of [10, 21]) await t.test(String(elapsed), async t => {
    const f = await fixture(t);
    const r = await f.open(async () => { f.advance(elapsed * minute); return decision(thought()); });
    await r.planner.tick();
    if (elapsed === 10) assert.equal(r.timeline.snapshot().plans[0].durationMs, 10 * minute);
    else { assert.equal(r.timeline.snapshot().events.length, 0); assert.deepEqual(r.planner.snapshot().attempt.outcomes, ['window-missed']); }
  });
});

test('timeline availability limits reject conflicting suggestions without extending or cancelling older plans', async t => {
  const f = await fixture(t);
  const r = await f.open(async () => decision(thought(), thought({ delayMinutes: 10 }), thought({ delayMinutes: 60 })));
  await r.planner.tick();
  assert.deepEqual(r.planner.snapshot().attempt.outcomes, ['planned', 'availability-conflict', 'planned']);
  assert.equal(r.timeline.snapshot().plans.length, 2);
  assert.equal(r.timeline.snapshot().thoughts[1].status, 'pending');
});

test('stronger intentions take conflicting slots first and zero desire does not manufacture an event', async t => {
  const f = await fixture(t);
  const r = await f.open(async () => decision(thought({ strength: 0 }), thought({ text: '弱念头', strength: 0.2 }), thought({ text: '强念头', strength: 0.9 })));
  await r.planner.tick();
  assert.equal(r.timeline.snapshot().plans.length, 1);
  assert.equal(r.timeline.snapshot().thoughts.find(item => item.status === 'active').text, '强念头');
  assert.deepEqual(r.planner.snapshot().attempt.outcomes, ['planned', 'availability-conflict', 'no-intent']);
  assert.equal(r.timeline.snapshot().thoughts.length, 2);
});

test('existing plans are respected and clock rollback does not immediately generate new decisions', async t => {
  const f = await fixture(t); let calls = 0;
  const r = await f.open(async () => { calls++; return decision(thought({ delayMinutes: 600 })); });
  await r.planner.tick(); f.advance(240 * minute);
  assert.equal((await r.planner.tick()).kind, 'existing-plans');
  f.advance(-300 * minute); assert.equal((await r.planner.tick()).kind, 'waiting'); assert.equal(calls, 1);
});

test('concurrent ticks share one attempt and closing drains a slow decision', async t => {
  const f = await fixture(t); let release, calls = 0;
  const held = new Promise(done => { release = done; });
  const r = await f.open(async () => { calls++; await held; return rest(); });
  const first = r.planner.tick(), second = r.planner.tick(); assert.equal(first, second);
  let closed = false; const closing = r.planner.close().then(() => { closed = true; });
  await new Promise(done => setTimeout(done, 20)); assert.equal(closed, false);
  release(); await first; await closing; assert.equal(calls, 1);
  await assert.rejects(r.planner.tick(), /closed/);
});

test('corrupt persisted planning state is not silently replaced', async t => {
  const f = await fixture(t); const r = await f.open(async () => rest()); await r.close();
  const bad = '{"version":999,"days":{},"nextAt":0}'; await writeFile(join(f.directory, 'planner.json'), bad);
  await assert.rejects(f.open(async () => rest()), /original file preserved/);
  assert.equal(await readFile(join(f.directory, 'planner.json'), 'utf8'), bad);
});

test('completed simulated effects become real planning inputs with traceable refs, never before completion', async t => {
  const f = await fixture(t), contexts = [];
  const effects = { version: 't030-1', mood: { valence: 0.3, energy: 0.1, tension: -0.1 },
    interest: { topic: 'sketch', label: '速写', delta: 0.3 } };
  const r = await f.open(async context => {
    contexts.push(context);
    return contexts.length === 1 ? decision(thought({ effects }))
      : decision(thought({ sourceRefs: ['interest:sketch', 'state:personal-mood'], effects: null }));
  });
  await r.planner.tick();
  const state = createLifeState({ timeline: r.timeline, now: f.now });
  assert.equal(contexts[0].personalMood, null); assert.deepEqual(contexts[0].longTermInterests, []);
  assert.deepEqual(state.snapshot().interests, [], 'a future appraisal is not an experience');
  assert.deepEqual(r.timeline.snapshot().plans[0].effects, effects);
  await r.timeline.completeActivity(r.timeline.snapshot().plans[0].id, { summary: '模拟速写结束' });
  f.advance(240 * minute);
  assert.equal((await r.planner.tick()).kind, 'applied');
  assert.equal(contexts[1].longTermInterests[0].ref, 'interest:sketch');
  assert.equal(contexts[1].personalMood.ref, 'state:personal-mood');
  assert.ok(contexts[1].personalSourceRefs.every(ref => ref.startsWith('event:')));
  assert.equal(contexts[1].unavailableSources.includes('personalMood'), false);
  assert.equal(contexts[1].unavailableSources.includes('liveWeb'), true);
  assert.deepEqual(JSON.parse(r.timeline.snapshot().thoughts[1].source.ref), ['interest:sketch', 'state:personal-mood']);
  const prompt = buildLifePlanningPrompt('PROFILE', contexts[1]);
  assert.match(prompt, /simulated/); assert.match(prompt, /兴趣只代表想接触/);
});

test('private derived mood and interest refs cannot enter or be cited by global planning', async t => {
  const f = await fixture(t), { timeline } = await f.open(async () => rest());
  await timeline.recordExperience({ id: 'private-exp', kind: 'interaction', mode: 'external',
    source: { kind: 'chat', scope: 'qq:private:other', ref: 'PRIVATE_SOURCE' }, summary: 'PRIVATE_SUMMARY',
    evidence: { source: { kind: 'chat', scope: 'qq:private:other' }, ref: 'PRIVATE_EVIDENCE' },
    effects: { version: 't030-1', mood: { valence: -0.4, energy: 0, tension: 0.3 },
      interest: { topic: 'private-topic', label: 'PRIVATE_LABEL', delta: 0.3 } } });
  const context = lifePlanningContext(timeline, f.now());
  assert.equal(context.personalMood, null); assert.deepEqual(context.longTermInterests, []);
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE|private-topic|qq:private:other/);
  for (const ref of ['interest:private-topic', 'state:personal-mood']) {
    assert.throws(() => parseLifeDecision(decision(thought({ sourceRefs: [ref] })), lifeSourceRefs(context)), /unavailable source/);
  }
});

test('effects are optional only for legacy decisions and malformed appraisals fail closed', () => {
  const legacy = decision(thought());
  assert.deepEqual(parseLifeDecision(legacy, ['profile']), legacy);
  assert.deepEqual(parseLifeDecision(decision(thought({ effects: null })), ['profile']).thoughts[0].effects, null);
  for (const effects of [
    { version: 'future', mood: null, interest: null },
    { version: 't030-1', mood: { valence: 0.51, energy: 0, tension: 0 }, interest: null },
    { version: 't030-1', mood: null, interest: { topic: 'bad topic', label: 'bad', delta: 0.2 } },
    { version: 't030-1', mood: null, interest: null, capability: 'expert' }
  ]) assert.throws(() => parseLifeDecision(decision(thought({ effects })), ['profile']));
});

test('a recorded public reading can supply the actual citation for a new simulated thought', async t => {
  const f = await fixture(t); let received;
  const r = await f.open(async context => {
    received = context;
    return decision(thought({ text: '想根据刚才读到的内容安静想一会', sourceRefs: [context.experiences[0].ref], effects: null }));
  });
  const event = await r.timeline.recordExperience({ id: 'actual-reading', kind: 'web-reading', mode: 'external',
    source: { kind: 'world-reading', ref: 'run:actual-reading' }, summary: '本次页面里关于光影的观察', effects: null,
    evidence: { source: { kind: 'web' }, ref: 'https://example.org/observed-page' }, observedAt: f.now() - minute });
  assert.equal((await r.planner.tick()).kind, 'applied');
  assert.equal(received.experiences[0].ref, `event:${event.id}`);
  assert.equal(received.experiences[0].observedAt, f.now() - minute);
  assert.equal(received.experiences[0].evidence.ref, 'https://example.org/observed-page');
  assert.deepEqual(JSON.parse(r.timeline.snapshot().thoughts[0].source.ref), [`event:${event.id}`]);
  assert.equal(r.timeline.snapshot().plans[0].mode, 'simulated', 'reading does not grant actual tool execution to the planner');
  const prompt = buildLifePlanningPrompt('龙族人格', received);
  assert.match(prompt, /回费伦/); assert.match(prompt, /不要求每天冒险/);
  assert.match(prompt, /不能编造与用户共同经历/); assert.match(prompt, /不是.*实时浏览|不能把已有材料当作正在实时浏览/);
});
