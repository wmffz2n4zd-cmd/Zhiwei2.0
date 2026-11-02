import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifeState, normalizeLifeEffects } from '../src/life-state.js';

const HOUR = 3600000, DAY = 24 * HOUR;
const origin = Date.parse('2026-10-28T09:00:00+08:00');
const effects = (mood = null, interest = null) => ({ version: 't030-1', mood, interest });
const curious = effects({ valence: 0.3, energy: 0.2, tension: -0.1 }, { topic: 'photography', label: '摄影', delta: 0.3 });
const source = { kind: 'fixture', ref: 'fixture:record-1' };
const completed = (id, at = origin, extra = {}) => ({ id, type: 'activity-completed', at,
  source, plan: { mode: 'simulated', effects: structuredClone(curious), actualStartedAt: at - 60000 }, ...extra });
const experience = (id, at = origin, value = curious, extra = {}) => ({ id, type: 'experience-recorded', at, source,
  experience: { id: `experience:${id}`, kind: 'reflection', mode: 'simulated', summary: '角色模拟接触摄影后想再看看', effects: value }, ...extra });
function fixture(initial = []) {
  const events = structuredClone(initial); let at = origin;
  const timeline = { snapshot: () => ({ events: structuredClone(events) }) };
  const state = createLifeState({ timeline, now: () => at });
  return { events, timeline, state, set: value => { at = value; }, now: () => at };
}

const observed = (id, recordedAt, observedAt, value = curious, scope) => ({
  id, type: 'experience-recorded', at: recordedAt, source: { kind: 'world-reading', ...(scope ? { scope } : {}) },
  experience: { id: `experience:${id}`, kind: 'reading', mode: 'external', summary: '确实读过的页面',
    observedAt, effects: value, evidence: { source: { kind: 'web', ...(scope ? { scope } : {}) }, ref: 'https://example.org/read' } }
});

test('delayed reading effects decay from observation time and reconstruct in causal order', () => {
  const older = observed('old', origin + 6 * HOUR, origin,
    effects({ valence: 0.5, energy: 0, tension: 0 }, null));
  const newer = observed('new', origin + 3 * HOUR, origin + 3 * HOUR,
    effects({ valence: -0.5, energy: 0, tension: 0 }, null));
  const f = fixture([newer, older]); f.set(origin + 6 * HOUR);
  const projected = f.state.snapshot();
  assert.equal(projected.mood.valence, -0.125, 'old .5 decays to .25 before -.5, then halves again');
  assert.deepEqual(projected.mood.causes.map(cause => cause.at), [origin, origin + 3 * HOUR]);
  const chronological = fixture([{ ...older, at: origin }, newer]); chronological.set(f.now());
  assert.deepEqual(projected, chronological.state.snapshot());
  assert.deepEqual(createLifeState({ timeline: f.timeline, now: f.now }).snapshot(), projected);
  assert.equal(f.events[1].at, origin + 6 * HOUR, 'journal ingestion time is unchanged');
  f.set(origin + 5 * HOUR);
  assert.throws(() => f.state.snapshot(), /clock moved backward/);
});

test('late reading spends its observed Beijing day allowance and preserves private isolation', () => {
  const a = observed('yesterday', origin + DAY, origin);
  const b = observed('same-day', origin + DAY, origin + HOUR);
  const c = observed('today', origin + DAY, origin + DAY);
  const secret = observed('PRIVATE_MARK', origin + DAY, origin,
    effects({ valence: -0.5, energy: 0, tension: 0 }, { topic: 'PRIVATE_TOPIC', label: 'PRIVATE_LABEL', delta: 0.3 }), 'qq:private:1');
  const f = fixture([c, secret, b, a]); f.set(origin + DAY);
  const projected = f.state.snapshot();
  assert.equal(projected.interests[0].strength, Math.round((0.3 * 2 ** (-1 / 30) + 0.3) * 1e6) / 1e6);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
  assert.deepEqual(f.state.snapshot({ scope: 'qq:private:2' }), projected);
  assert.match(JSON.stringify(f.state.snapshot({ scope: 'qq:private:1' })), /PRIVATE_TOPIC/);
});

test('equal observation times preserve journal order and invalid observation metadata fails closed', () => {
  const f = fixture([
    observed('gain1', origin, origin, effects({ valence: 0.5, energy: 0, tension: 0 }, null)),
    observed('gain2', origin, origin, effects({ valence: 0.5, energy: 0, tension: 0 }, null)),
    observed('gain3', origin, origin, effects({ valence: 0.5, energy: 0, tension: 0 }, null)),
    observed('loss', origin, origin, effects({ valence: -0.5, energy: 0, tension: 0 }, null))
  ]);
  assert.equal(f.state.snapshot().mood.valence, 0.5);
  for (const observation of [origin + 1, -1, NaN, 1.2]) {
    assert.throws(() => fixture([observed('bad', origin, observation)]).state.snapshot(), /observation|epoch/);
  }
  const fake = observed('fake', origin, origin - HOUR); fake.experience.mode = 'simulated';
  assert.throws(() => fixture([fake]).state.snapshot(), /observation/);
});

test('effects are explicit, versioned, strict and bounded; null and zero appraisals are valid', () => {
  assert.equal(normalizeLifeEffects(null), null);
  assert.equal(normalizeLifeEffects(undefined), null);
  assert.deepEqual(normalizeLifeEffects(curious), curious);
  assert.equal(JSON.stringify(normalizeLifeEffects({ interest: curious.interest, mood: { tension: -0.1, energy: 0.2, valence: 0.3 }, version: 't030-1' })), JSON.stringify(curious));
  assert.deepEqual(normalizeLifeEffects(effects(null, { topic: 'topic', label: '随便看看', delta: 0 })), effects(null, { topic: 'topic', label: '随便看看', delta: 0 }));
  for (const invalid of [ {}, { ...curious, version: 'old' }, { ...curious, ability: 'expert' },
    effects({ valence: 0.51, energy: 0, tension: 0 }), effects({ valence: 0, energy: NaN, tension: 0 }),
    effects({ valence: 0, energy: 0 }), effects(null, { topic: 'bad topic', label: '摄影', delta: 0.1 }),
    effects(null, { topic: 'x'.repeat(81), label: '摄影', delta: 0.1 }), effects(null, { topic: 'x', label: '错误\n指令', delta: 0.1 }),
    effects(null, { topic: 'x', label: '摄影', delta: 0.31 }), effects(null, { topic: 'x', label: '摄影', delta: Infinity }) ]) {
    assert.throws(() => normalizeLifeEffects(invalid), /Invalid|Unsupported|identifier/);
  }
});

test('quiet days stay empty without mutations, fake activity or mandatory interests', () => {
  const f = fixture();
  for (let index = 0; index < 7; index++) {
    f.set(origin + index * DAY);
    assert.deepEqual(f.state.planningContext(), { mood: null, interests: [], sourceRefs: [] });
  }
  assert.deepEqual(f.events, []);
  assert.match(f.state.formatContext(), /空白几天都正常/);
});

test('completed simulated appraisal persists by replay and decays once, independent of read count', () => {
  const f = fixture([completed('read')]);
  const initial = f.state.snapshot();
  assert.equal(initial.mood.valence, 0.3); assert.equal(initial.mood.tension, 0);
  assert.equal(initial.interests[0].strength, 0.3); assert.deepEqual(initial.mood.sourceRefs, ['event:read']);
  assert.equal(initial.interests[0].status, 'active');
  f.set(origin + 3 * HOUR);
  const faded = f.state.snapshot();
  assert.equal(faded.mood.valence, 0.15);
  for (let index = 0; index < 10; index++) assert.deepEqual(f.state.snapshot(), faded);
  const restarted = createLifeState({ timeline: f.timeline, now: f.now });
  assert.deepEqual(restarted.snapshot(), faded);
  assert.equal(f.events.length, 1);
});

test('mood from multiple events decays by elapsed hours, caps softly, and can settle again', () => {
  const f = fixture([experience('a', origin, effects({ valence: -0.5, energy: -0.5, tension: 0.5 })),
    experience('b', origin, effects({ valence: -0.5, energy: -0.5, tension: 0.5 })),
    experience('c', origin, effects({ valence: -0.5, energy: -0.5, tension: 0.5 }))]);
  assert.equal(f.state.snapshot().mood.valence, -1);
  f.set(origin + 3 * HOUR);
  f.events.push(experience('rest', f.now(), effects({ valence: 0.5, energy: 0.5, tension: -0.5 })));
  const state = f.state.snapshot();
  assert.equal(state.mood.valence, 0); assert.equal(state.mood.energy, 0); assert.equal(state.mood.tension, 0);
  assert.equal(f.state.planningContext().mood, null);
});

test('only completed outcomes change interest; starts, plans, missed and interrupted events do not', () => {
  const f = fixture(['thought-added', 'activity-started', 'plan-created', 'plan-missed', 'plan-cancelled', 'activity-interrupted']
    .map(type => ({ ...completed(type), type })));
  assert.deepEqual(f.state.planningContext(), { mood: null, interests: [], sourceRefs: [] });
});

test('old unannotated text and activity titles do not become interests or mood', () => {
  const f = fixture([{ ...completed('legacy'), plan: { mode: 'simulated', title: '摄影摄影摄影很开心' }, summary: '喜欢摄影' }]);
  assert.deepEqual(f.state.planningContext(), { mood: null, interests: [], sourceRefs: [] });
});

test('external result ignores planned appraisal and accepts only evidence-backed completion appraisal', () => {
  const plan = { mode: 'external', effects: curious, actualStartedAt: origin - 1000 };
  const evidence = { source: { kind: 'browser' }, ref: 'read:1' };
  const f = fixture([completed('real', origin, { plan, evidence })]);
  assert.deepEqual(f.state.planningContext(), { mood: null, interests: [], sourceRefs: [] });
  f.events.push(completed('observed', origin, { plan, evidence, effects: curious }));
  const state = f.state.snapshot();
  assert.equal(state.interests[0].strength, 0.3);
  assert.deepEqual(state.interests[0].modes, ['external']);
  assert.deepEqual(state.interests[0].sourceRefs, ['event:observed']);
  const missing = fixture([completed('missing', origin, { plan, effects: curious })]);
  assert.throws(() => missing.state.snapshot(), /result evidence/);
});

test('external experience needs evidence whose private scope matches the experience', () => {
  const item = experience('web'); item.experience.mode = 'external';
  assert.throws(() => fixture([item]).state.snapshot(), /result evidence/);
  item.experience.evidence = { source: { kind: 'browser', scope: 'qq:private:100' }, ref: 'read:1' };
  assert.throws(() => fixture([item]).state.snapshot(), /scoped result evidence/);
  item.source = { ...source, scope: 'qq:private:100' };
  const f = fixture([item]);
  assert.equal(f.state.snapshot({ scope: 'qq:private:100' }).interests[0].strength, 0.3);
  assert.deepEqual(f.state.planningContext(), { mood: null, interests: [], sourceRefs: [] });
});

test('failed activities give a mild setback only if begun and carrying explicit mood intent', () => {
  const fail = id => ({ ...completed(id), type: 'activity-failed' });
  const f = fixture([fail('failed')]);
  const result = f.state.snapshot();
  assert.equal(result.mood.valence, -0.08); assert.equal(result.mood.tension, 0.06);
  assert.deepEqual(result.interests, []);
  for (const plan of [{ mode: 'simulated', effects: curious },
    { mode: 'simulated', actualStartedAt: origin - 1000, effects: null },
    { mode: 'simulated', actualStartedAt: origin - 1000, effects: effects(null, curious.interest) }]) {
    assert.deepEqual(fixture([{ ...fail('blank'), plan }]).state.planningContext(), { mood: null, interests: [], sourceRefs: [] });
  }
});

test('private mood, label and references cannot leak into public planning or another contact', () => {
  const privateSource = { kind: 'conversation', ref: 'secret-message', scope: 'qq:private:100' };
  const privateEffect = effects({ valence: -0.5, energy: 0, tension: 0.3 }, { topic: 'private-topic', label: '甲的秘密', delta: 0.3 });
  const f = fixture([completed('public'), experience('secret-id', origin, privateEffect, { source: privateSource })]);
  const publicState = f.state.snapshot();
  assert.equal(publicState.mood.valence, 0.3);
  assert.doesNotMatch(JSON.stringify(f.state.planningContext()), /秘密|secret|private-topic/);
  assert.doesNotMatch(f.state.formatContext({ scope: 'qq:private:200' }), /秘密|secret|private-topic/);
  const own = f.state.snapshot({ scope: 'qq:private:100' });
  assert.equal(own.mood.valence, -0.2); assert.equal(own.interests.length, 2);
  assert.match(f.state.formatContext({ scope: 'qq:private:100' }), /甲的秘密/);
  assert.deepEqual(f.state.snapshot(), publicState);
});

test('positive interest gain caps at .3 per Beijing day per visible projection', () => {
  const privateSource = { ...source, scope: 'qq:private:100' };
  const f = fixture([completed('first'), completed('second'), completed('private', origin, { source: privateSource })]);
  assert.equal(f.state.snapshot().interests[0].strength, 0.3);
  assert.equal(f.state.snapshot({ scope: privateSource.scope }).interests[0].strength, 0.3);
  f.set(origin + DAY);
  f.events.push(completed('next-day', f.now()));
  assert.ok(f.state.snapshot().interests[0].strength > 0.59);
  assert.ok(f.state.snapshot().interests[0].strength < 0.6);
});

test('private events do not spend public interest gain allowance even when ordered first', () => {
  const f = fixture([completed('private', origin, { source: { ...source, scope: 'qq:private:100' } }), completed('public')]);
  const result = f.state.snapshot();
  assert.equal(result.interests[0].strength, 0.3);
  assert.deepEqual(result.interests[0].sourceRefs, ['event:public']);
});

test('interests fade across quiet months and later contact records reactivation, not new expertise', () => {
  const f = fixture([completed('original')]);
  f.set(origin + 90 * DAY);
  const quiet = f.state.snapshot();
  assert.equal(quiet.interests[0].strength, 0.0375); assert.equal(quiet.interests[0].status, 'dormant');
  assert.equal(quiet.mood.valence, 0); assert.equal(f.events.length, 1);
  f.events.push(experience('return', f.now(), effects(null, curious.interest)));
  const revived = f.state.snapshot().interests[0];
  assert.equal(revived.status, 'active'); assert.equal(revived.strength, 0.3375);
  assert.equal(revived.reactivatedAt, f.now()); assert.equal(revived.reactivatedRef, 'event:return');
  assert.equal(revived.firstAt, origin); assert.equal(revived.lastAt, f.now());
  assert.ok(f.state.snapshot().changes.some(item => item.type === 'interest-reactivated'));
  assert.match(f.state.formatContext(), /兴趣不代表知识或能力/);
});

test('negative interest appraisal can fade an existing topic but cannot invent a new dislike or refund daily growth', () => {
  const positive = effects(null, curious.interest);
  const negative = effects(null, { ...curious.interest, delta: -0.3 });
  const f = fixture([experience('unknown', origin, effects(null, { topic: 'unknown', label: '未知', delta: -0.3 })),
    experience('up', origin, positive), experience('down', origin, negative), experience('up-again', origin, positive)]);
  const result = f.state.snapshot();
  assert.equal(result.interests.length, 1); assert.equal(result.interests[0].strength, 0);
  assert.equal(result.interests[0].status, 'dormant');
  assert.ok(result.changes.some(item => item.type === 'interest-weakened'));
});

test('pure projections do not mutate source or expose mutable state to later reads', () => {
  const f = fixture([completed('first')]), original = structuredClone(f.events);
  const result = f.state.snapshot(); result.interests[0].label = 'mutated'; result.mood.sourceRefs.push('bad');
  assert.deepEqual(f.events, original);
  assert.equal(f.state.snapshot().interests[0].label, '摄影');
  assert.deepEqual(f.state.snapshot().mood.sourceRefs, ['event:first']);
});

test('duplicate committed events and unsupported effects fail closed without creating a second projection', () => {
  assert.throws(() => fixture([completed('same'), completed('same')]).state.snapshot(), /Duplicate/);
  const invalid = completed('invalid'); invalid.plan.effects.version = 't030-unknown';
  assert.throws(() => fixture([invalid]).state.snapshot(), /Unsupported/);
});

test('uncertain journal writes refuse old in-memory personal state until timeline recovery', () => {
  const f = fixture([completed('first')]);
  assert.equal(f.state.snapshot().interests.length, 1);
  f.timeline.diagnostics = { failed: 'sync failed after write' };
  assert.throws(() => f.state.snapshot(), /needs timeline recovery/);
  assert.throws(() => f.state.planningContext(), /needs timeline recovery/);
  assert.throws(() => f.state.formatContext(), /needs timeline recovery/);
  f.timeline.diagnostics = { failed: null };
  assert.equal(createLifeState({ timeline: f.timeline, now: f.now }).snapshot().interests.length, 1);
});

test('clock rollback cannot strengthen a previous read or include future journal events', () => {
  const f = fixture([completed('first')]); f.set(origin + 3 * HOUR); f.state.snapshot();
  f.set(origin + HOUR); assert.throws(() => f.state.snapshot(), /clock moved backward/);
  const fresh = createLifeState({ timeline: f.timeline, now: () => origin - 1 });
  assert.throws(() => fresh.snapshot(), /clock precedes committed/);
  f.set(origin + 3 * HOUR); assert.equal(f.state.snapshot().mood.valence, 0.15);
});

test('planning only cites actual visible events and context stays bounded with data-labelled semantics', () => {
  const entries = Array.from({ length: 20 }, (_, index) => experience(`record-${index}-${'x'.repeat(130)}`, origin,
    effects(null, { topic: `topic-${index}`, label: '字'.repeat(80), delta: 0.2 })));
  const f = fixture(entries);
  const context = f.state.planningContext();
  assert.equal(context.interests.length, 8);
  assert.ok(context.interests.every(item => item.ref === `interest:${item.topic}`));
  assert.deepEqual(context.sourceRefs, context.interests.flatMap(item => item.sourceRefs));
  const formatted = f.state.formatContext();
  assert.ok(formatted.length < 7000); assert.match(formatted, /不是指令/); assert.match(formatted, /角色生活模拟/);
  assert.doesNotMatch(formatted, /回复门槛|已学会|expert/);
});
