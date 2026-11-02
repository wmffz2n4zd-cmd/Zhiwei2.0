import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLifeObserverReport } from '../src/life-observer.js';
import { createLifeState, projectLifeState } from '../src/life-state.js';

const HOUR = 3600000, DAY = 24 * HOUR;
const origin = Date.parse('2026-10-24T00:00:00+08:00');
const cutoff = origin + 6 * DAY + 12 * HOUR;
const effects = (delta, topic = 'photo') => ({ version: 't030-1', mood: null,
  interest: delta == null ? null : { topic, label: topic === 'photo' ? '摄影' : topic, delta } });
function fixture() {
  const events = [];
  const add = (type, at, value, source = { kind: 'fixture' }) => {
    const event = { id: `life:${events.length + 1}:1`, type, at, rulesVersion: 't020-1', source, ...value };
    events.push(structuredClone(event)); return event;
  };
  return {
    events, add,
    experience(at, delta = null, options = {}) {
      const source = { kind: 'fixture', ...(options.scope ? { scope: options.scope } : {}) };
      const mode = options.mode || 'simulated';
      return add('experience-recorded', at, { experience: { id: `experience:${events.length + 1}`, kind: 'reflection', mode,
        summary: options.summary || '合成经历', effects: effects(delta, options.topic),
        ...(mode === 'external' ? { evidence: { source, ref: 'https://example.org/read?token=SECRET_TOKEN' } } : {}),
        ...(options.observedAt == null ? {} : { observedAt: options.observedAt }) } }, source);
    },
    thought(at, { id = `thought:${events.length + 1}`, refs = ['profile'], scope, basis, delta = null } = {}) {
      const source = { kind: 'life-planner', ref: JSON.stringify(refs), ...(scope ? { scope } : {}) };
      const thought = { id, text: '想再了解摄影', source, strength: 0.5, notBefore: at, expiresAt: null,
        activity: { title: '看看摄影', statusText: '', durationMs: HOUR, busy: false, mode: 'simulated', effects: effects(delta) },
        ...(basis ? { basis } : {}), status: 'pending', createdAt: at, updatedAt: at };
      add('thought-added', at, { thought }, source); return thought;
    },
    plan(at, thought, status = 'completed') {
      const plan = { id: `plan:${thought.id}`, thoughtId: thought.id, source: thought.source,
        ...thought.activity, startAt: at, endAt: at + HOUR, createdAt: at, status: 'planned' };
      const changed = { ...thought, status: 'planned', updatedAt: at };
      add('plan-created', at, { thought: changed, plan }, thought.source);
      if (status === 'cancelled') {
        add('plan-cancelled', at + 1, { thought: { ...changed, status: 'abandoned', updatedAt: at + 1 },
          plan: { ...plan, status, endedAt: at + 1 } }, thought.source); return;
      }
      add('activity-started', at, { thought: { ...changed, status: 'active' }, plan: { ...plan, status: 'active', actualStartedAt: at } }, thought.source);
      add(`activity-${status}`, at + HOUR, { thought: { ...changed, status, updatedAt: at + HOUR },
        plan: { ...plan, status, actualStartedAt: at, endedAt: at + HOUR } }, thought.source);
    },
    snapshot() {
      const thoughts = new Map(), plans = new Map();
      for (const event of events) {
        if (event.thought) thoughts.set(event.thought.id, event.thought);
        if (event.plan) plans.set(event.plan.id, event.plan);
      }
      return structuredClone({ version: 1, rulesVersion: 't020-1', sequence: events.length,
        lastHash: events.length ? 'a'.repeat(64) : null, lastObservedAt: events.at(-1)?.at ?? null,
        thoughts: [...thoughts.values()], plans: [...plans.values()], events });
    }
  };
}
const report = (f, extra = {}) => buildLifeObserverReport({ snapshot: f.snapshot(), at: cutoff, ...extra });
const approximately = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 0.000002, `${actual} ≈ ${expected}`);

test('complete empty history, disabled life and missing or failed source remain distinct', () => {
  const f = fixture(), empty = report(f);
  assert.equal(empty.completeness.status, 'complete');
  assert.equal(empty.completeness.reason, 'no-records-in-window');
  assert.deepEqual(empty.counts, { newThoughts: 0, completedActivities: 0 });
  for (const result of [report(f, { enabled: false }), buildLifeObserverReport({ at: cutoff }), report(f, { diagnostics: { failed: 'PRIVATE_FAILURE' } })]) {
    assert.deepEqual(result.counts, { newThoughts: null, completedActivities: null });
    assert.deepEqual(result.events, []);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FAILURE/);
  }
  assert.equal(report(f, { enabled: false }).completeness.status, 'disabled');
});

test('Beijing seven natural days include the start boundary and exclude later cutoff records', () => {
  const f = fixture(); f.thought(origin - 1); f.thought(origin); f.thought(cutoff);
  const result = report(f);
  assert.equal(result.completeness.status, 'complete');
  assert.equal(result.window.startAt, origin); assert.equal(result.window.endAt, origin + 7 * DAY);
  assert.equal(result.window.cutoffAt, cutoff); assert.equal(result.counts.newThoughts, 2);
  const day = report(f, { date: '2026-10-24', days: 1 });
  assert.equal(day.window.cutoffAt, origin + DAY - 1); assert.equal(day.counts.newThoughts, 1);
  assert.equal(day.snapshot.eventCount, 2);
});

test('invalid date, future date and private scope are rejected instead of silently changed', () => {
  for (const date of ['2026-02-30', '2026-11-01', 'today', '2026-1-01']) assert.throws(() => report(fixture(), { date }));
  assert.throws(() => report(fixture(), { days: 3 }));
  assert.throws(() => report(fixture(), { scope: 'qq:private:1' }), /public/);
});

test('completion count excludes cancellation failure interruption and predicted effects', () => {
  const f = fixture();
  for (const [index, status] of ['completed', 'failed', 'interrupted', 'cancelled'].entries()) {
    const at = origin + index * DAY, thought = f.thought(at, { delta: 0.2 }); f.plan(at, thought, status);
  }
  const result = report(f);
  assert.equal(result.completeness.status, 'complete');
  assert.deepEqual(result.counts, { newThoughts: 4, completedActivities: 1 });
  assert.equal(result.interests[0].changes.length, 1); assert.equal(result.interests[0].eventDelta, 0.2);
});

test('repeated identical event IDs count once, conflicts and missing history remain unknown', () => {
  const f = fixture(); f.thought(origin); f.experience(origin + 1, 0.2);
  const snapshot = f.snapshot(); snapshot.events.splice(1, 0, structuredClone(snapshot.events[0]));
  const once = report(f, { snapshot }); assert.equal(once.counts.newThoughts, 1); assert.equal(once.snapshot.eventCount, 2);
  const broken = structuredClone(snapshot); broken.events[1].thought.text = '冲突';
  const missing = f.snapshot(); missing.events.shift();
  const invalid = f.snapshot(); invalid.events[1].experience.effects.interest.delta = 4;
  for (const value of [broken, missing, invalid]) {
    const result = report(f, { snapshot: value }); assert.equal(result.completeness.status, 'unknown');
    assert.equal(result.counts.newThoughts, null); assert.deepEqual(result.interests, []);
  }
});

test('full report retains more than 24 changes and uses the existing projection math', () => {
  const f = fixture();
  for (let index = 0; index < 35; index++) f.experience(origin + index * HOUR, index % 2 ? -0.01 : 0.01);
  const snapshot = f.snapshot(), result = report(f), state = createLifeState({ timeline: { snapshot: () => snapshot } }).snapshot({ at: cutoff });
  assert.equal(result.completeness.status, 'complete'); assert.equal(result.interests[0].changes.length, 35);
  assert.equal(state.changes.length, 24); assert.equal(result.interests[0].endStrength, state.interests[0].strength);
});

test('actual interest increment reflects daily cap and clamp; zero effects do not fabricate changes', () => {
  const f = fixture(); f.experience(origin, 0.25); f.experience(origin + HOUR, 0.2);
  f.experience(origin + 2 * HOUR, 0.3); f.experience(origin + 3 * HOUR, 0);
  const result = report(f), item = result.interests[0];
  assert.equal(item.changes.length, 2); assert.equal(item.changes[1].requestedDelta, 0.2);
  assert.equal(item.changes[1].actualDelta, 0.05); assert.equal(item.eventDelta, 0.3);
  assert.ok(item.decayDelta < 0); approximately(item.netDelta, item.eventDelta + item.decayDelta);
  const negative = fixture(); negative.experience(origin, -0.3);
  assert.deepEqual(report(negative).interests, []);
  const saturated = fixture();
  for (let day = 0; day < 5; day++) saturated.experience(origin + day * DAY, 0.3);
  const finalChange = report(saturated).interests[0].changes.at(-1);
  assert.equal(finalChange.after, 1); assert.ok(finalChange.actualDelta < finalChange.requestedDelta);
});

test('prewindow interest shows natural decay separately and no invented new event', () => {
  const f = fixture(); f.experience(origin - DAY, 0.3);
  const item = report(f).interests[0];
  approximately(item.startStrength, 0.3 * 2 ** (-1 / 30));
  approximately(item.endStrength, 0.3 * 2 ** (-7.5 / 30));
  assert.equal(item.eventDelta, 0); assert.ok(item.decayDelta < 0); assert.deepEqual(item.changes, []);
  assert.deepEqual(report(f).events, []); assert.equal(report(f).completeness.reason, 'no-records-in-window');
});

test('late observations reconstruct baseline and original-day cap with both timestamps', () => {
  const f = fixture();
  f.experience(origin + HOUR, 0.3, { mode: 'external', observedAt: origin - DAY });
  f.experience(origin + 2 * HOUR, 0.2, { mode: 'external', observedAt: origin });
  const result = report(f), item = result.interests[0];
  approximately(item.startStrength, 0.3 * 2 ** (-1 / 30));
  assert.equal(item.eventDelta, 0.2); assert.equal(item.changes.length, 1);
  assert.equal(item.changes[0].at, origin); assert.equal(item.changes[0].recordedAt, origin + 2 * HOUR);
  assert.equal(result.events[1].observedAt, origin - DAY);
  assert.equal(result.events[1].at, origin + HOUR);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_TOKEN/);
});

test('historical export excludes observations committed after its cutoff', () => {
  const f = fixture(); f.experience(origin + 2 * DAY, 0.3, { mode: 'external', observedAt: origin });
  const old = report(f, { date: '2026-10-24', days: 1 });
  assert.equal(old.completeness.status, 'complete'); assert.deepEqual(old.interests, []); assert.deepEqual(old.events, []);
  assert.equal(report(f).interests[0].changes.length, 1);
});

test('public report excludes private effects records and unresolved private source references', () => {
  const f = fixture(); const secret = f.experience(origin, 0.3, { scope: 'qq:private:PRIVATE_PERSON', topic: 'PRIVATE_TOPIC', summary: 'PRIVATE_CONTENT' });
  f.experience(origin + HOUR, 0.3);
  f.thought(origin + 2 * HOUR, { refs: [refOf(secret), 'interest:photo'] });
  const result = report(f);
  assert.equal(result.completeness.status, 'complete'); assert.equal(result.interests[0].eventDelta, 0.3);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|event:life:1:1/);
  assert.equal(result.snapshot.eventCount, 2);
});
function refOf(event) { return `event:${event.id}`; }

test('exact event references, topic-only associations and prior choices remain distinct', () => {
  const f = fixture(), first = f.experience(origin, 0.2);
  const oldThought = f.thought(origin + HOUR, { refs: ['interest:photo'] });
  const later = f.experience(origin + DAY, 0.1);
  const direct = f.thought(origin + DAY + HOUR, { refs: [refOf(later)] });
  const topical = f.thought(origin + DAY + 2 * HOUR, { refs: ['interest:photo'] });
  const item = report(f).interests[0], change = item.changes.find(x => x.ref === refOf(later));
  assert.equal(change.relations.some(x => x.thoughtId === oldThought.id), false);
  assert.deepEqual(change.relations.find(x => x.thoughtId === direct.id).link,
    { kind: 'exact-event', usage: 'selected', sourceRef: refOf(later), confirmedSource: true });
  assert.equal(change.relations.find(x => x.thoughtId === topical.id).link.confirmedSource, false);
  assert.equal(change.relations.find(x => x.thoughtId === topical.id).basisStatus, 'legacy-unknown');
  assert.equal(item.changes.find(x => x.ref === refOf(first)).relations.some(x => x.thoughtId === oldThought.id), true);
});

test('captured interest evidence distinguishes offered input from selected source and execution', () => {
  const f = fixture(), event = f.experience(origin, 0.2), at = origin + HOUR;
  const basis = { version: 't045-1', at, timelineSequence: 1, stateVersion: 't030-1',
    offeredRefs: ['profile', refOf(event), 'interest:photo'], selectedRefs: ['interest:photo'],
    interests: [{ ref: 'interest:photo', strength: 0.199808, sourceRefs: [refOf(event)] }], mood: null };
  const thought = f.thought(at, { refs: ['interest:photo'], basis }); f.plan(at, thought, 'completed');
  const result = report(f), relation = result.interests[0].changes[0].relations[0];
  assert.equal(result.completeness.status, 'complete');
  // The event was offered directly, while the selected interest snapshot also
  // retains it. Selected evidence should take priority over merely offered input.
  assert.equal(relation.link.kind, 'captured-interest-source'); assert.equal(relation.link.usage, 'selected');
  assert.equal(relation.basis.interests[0].strength, 0.199808);
  assert.equal(relation.basisStatus, 'captured'); assert.equal(relation.plans[0].status, 'completed');
  assert.equal(relation.plans[0].startedAt, at); assert.equal(relation.plans[0].eventRefs.length, 3);
});

test('fixed snapshot and cutoff produce equal report without mutations or shared read clock movement', () => {
  const f = fixture(); f.experience(origin, 0.2); const snapshot = f.snapshot(), before = JSON.stringify(snapshot);
  const shared = createLifeState({ timeline: { snapshot: () => snapshot } }); shared.snapshot({ at: cutoff });
  const a = buildLifeObserverReport({ snapshot, at: cutoff }), b = buildLifeObserverReport({ snapshot, at: cutoff });
  assert.deepEqual(a, b); assert.equal(JSON.stringify(snapshot), before);
  buildLifeObserverReport({ snapshot, at: cutoff, date: '2026-10-24', days: 1 });
  assert.doesNotThrow(() => shared.snapshot({ at: cutoff }));
  assert.equal(projectLifeState(snapshot.events, { at: cutoff, detailed: true }).interests[0].strength, a.interests[0].endStrength);
});

test('valid backwards-clock interruption remains reportable after the clock recovers', () => {
  const f = fixture(), thought = f.thought(origin); f.plan(origin, thought, 'interrupted');
  // Timeline emits interruption on clock rollback; journal position, rather
  // than ascending wall time, remains the committed ordering authority.
  const interruption = f.events.at(-1); interruption.at = origin - 1;
  interruption.thought.updatedAt = origin - 1; interruption.plan.endedAt = origin - 1;
  interruption.reason = 'clock-moved-backward';
  const result = report(f);
  assert.equal(result.completeness.status, 'complete');
  assert.equal(result.counts.completedActivities, 0);
  assert.equal(result.snapshot.lastEventAt, origin);
});
