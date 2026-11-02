import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createLifeTimeline, normalizeLifeDecisionBasis, validateLifeObserverSnapshot } from '../src/life-timeline.js';
import { createLifePlanner } from '../src/life-planner.js';

const minute = 60000;
const item = refs => ({ text: '想画画', sourceRefs: refs, strength: 0.7, title: '画画', statusText: '稍后回来',
  busy: false, durationMinutes: 10, delayMinutes: 20 });
const decision = refs => ({ thoughts: [item(refs)], reconsiderAfterMinutes: 240 });
const activity = { title: '休息', mode: 'simulated', durationMs: minute };
const emptyBasis = (at, timelineSequence) => ({ version: 't045-1', at, timelineSequence, stateVersion: 't030-1',
  offeredRefs: ['profile'], selectedRefs: ['profile'], interests: [], mood: null });
async function fixture(t) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'observer-provenance-')), opened = [];
  let at = Date.parse('2026-10-30T01:00:00Z');
  t.after(async () => {
    for (const resource of opened.reverse()) await resource.close().catch(() => {});
    assert.ok(resolve(directory).startsWith(base + sep)); await rm(directory, { recursive: true, force: true });
  });
  return { directory, now: () => at, advance(ms) { at += ms; },
    async timeline() { const result = await createLifeTimeline({ directory, now: () => at }); opened.push(result); return result; },
    async planner(timeline, decide) { const result = await createLifePlanner({ directory, timeline, decide, now: () => at }); opened.push(result); return result; } };
}
async function experience(timeline, id, scope) {
  return timeline.recordExperience({ source: { kind: 'test', ...(scope ? { scope } : {}) },
    id, kind: 'reading', mode: 'simulated', summary: scope ? 'PRIVATE_CANARY' : '看了树的形状',
      effects: { version: 't030-1', mood: { valence: 0.1, energy: 0, tension: 0.1 },
        interest: { topic: 'drawing', label: '画画', delta: 0.2 } } });
}

test('planner captures offered facts before awaiting the model and keeps selected citations distinct', async t => {
  const f = await fixture(t), timeline = await f.timeline();
  const publicEvent = await experience(timeline, 'first'); await experience(timeline, 'private', 'qq:private:7');
  const sequence = timeline.snapshot().sequence;
  let captured;
  const planner = await f.planner(timeline, async context => {
    captured = context;
    await experience(timeline, 'later');
    return decision(['interest:drawing']);
  });
  await planner.tick();
  const thought = timeline.snapshot().thoughts[0], basis = thought.basis;
  assert.equal(basis.at, f.now()); assert.equal(basis.timelineSequence, sequence);
  assert.equal(basis.stateVersion, 't030-1');
  assert.equal(basis.interests[0].strength, captured.longTermInterests[0].strength);
  assert.equal(basis.interests[0].strength, 0.2);
  assert.deepEqual(basis.interests[0].sourceRefs, [`event:${publicEvent.id}`]);
  assert.equal(basis.mood.valence, 0.1);
  assert.deepEqual(basis.selectedRefs, ['interest:drawing']);
  assert.ok(basis.offeredRefs.includes('profile'));
  assert.ok(!basis.selectedRefs.includes('profile'));
  assert.doesNotMatch(JSON.stringify(basis), /PRIVATE|qq:private|later/);
  assert.deepEqual(planner.snapshot().attempt.basis.selectedRefs, []);
  assert.equal(validateLifeObserverSnapshot(timeline.snapshot()), true);
  const added = timeline.snapshot().events.find(event => event.type === 'thought-added');
  assert.deepEqual(added.thought.basis, basis);
  await planner.close(); await timeline.close();
  const resumed = await f.timeline();
  assert.deepEqual(resumed.snapshot().thoughts[0].basis, basis);
  const again = await f.planner(resumed, () => { throw Error('must not repeat'); });
  assert.deepEqual(again.snapshot().attempt.basis, planner.snapshot().attempt.basis);
});

test('ready decision recovery imports the original basis once after an interrupted thought write', async t => {
  const f = await fixture(t), timeline = await f.timeline(); let calls = 0;
  await experience(timeline, 'first');
  const wrapped = { ...timeline, addThought: async () => { throw Error('injected interruption'); } };
  const planner = await f.planner(wrapped, async () => { calls++; return decision(['interest:drawing']); });
  await assert.rejects(planner.tick(), /injected/);
  const expected = planner.snapshot().attempt.basis;
  assert.equal(planner.snapshot().attempt.status, 'ready');
  await experience(timeline, 'new-input');
  await planner.close(); await timeline.close(); f.advance(minute);
  const resumed = await f.timeline(), retry = await f.planner(resumed, () => { calls++; throw Error('no retry'); });
  await retry.tick();
  assert.equal(calls, 1);
  assert.deepEqual(resumed.snapshot().thoughts[0].basis, { ...expected, selectedRefs: ['interest:drawing'] });
  assert.equal(resumed.snapshot().thoughts.length, 1);
  assert.equal(validateLifeObserverSnapshot(resumed.snapshot()), true);
});

test('old ready decisions and old timeline records keep their byte shape without invented basis', async t => {
  const f = await fixture(t), timeline = await f.timeline();
  await timeline.addThought({ id: 'legacy', text: '旧念头', source: { kind: 'test' }, activity });
  const before = await readFile(join(f.directory, 'journal.jsonl'), 'utf8');
  await timeline.close();
  const resumed = await f.timeline();
  assert.equal(await readFile(join(f.directory, 'journal.jsonl'), 'utf8'), before);
  assert.ok(!Object.hasOwn(resumed.snapshot().thoughts[0], 'basis'));
  await writeFile(join(f.directory, 'planner.json'), JSON.stringify({ version: 1, nextAt: f.now() + 240 * minute,
    days: { '2026-10-30': 1 }, attempt: { id: '12345678-1234-1234-1234-123456789abc', at: f.now(), status: 'ready',
      sourceRefs: ['profile'], outcomes: [], decision: decision(['profile']) } }));
  const planner = await f.planner(resumed, () => { throw Error('no model'); });
  await planner.tick();
  assert.ok(resumed.snapshot().thoughts.every(thought => !Object.hasOwn(thought, 'basis')));
  assert.ok((await readFile(join(f.directory, 'journal.jsonl'), 'utf8')).startsWith(before));
  assert.equal(validateLifeObserverSnapshot(resumed.snapshot()), true);
});

test('basis rejects private, future, missing and unoffered sources without writing an event', async t => {
  const f = await fixture(t), timeline = await f.timeline();
  const privateEvent = await experience(timeline, 'private', 'qq:private:9');
  const earlierSequence = timeline.snapshot().sequence;
  const later = await experience(timeline, 'later');
  const start = timeline.snapshot(), base = emptyBasis(f.now(), start.sequence);
  const inputs = [
    { ...base, offeredRefs: ['profile', `event:${privateEvent.id}`] },
    { ...base, offeredRefs: ['profile', 'event:missing'] },
    { ...base, offeredRefs: ['profile', `event:${later.id}`], timelineSequence: earlierSequence },
    { ...base, at: f.now() + 1 },
    { ...base, timelineSequence: start.sequence + 1 },
    { ...base, selectedRefs: ['interest:missing'] },
    { ...base, privateText: 'NO' },
    { ...base, mood: { ref: 'state:personal-mood', valence: 0, energy: 0, tension: 0, sourceRefs: [] } }
  ];
  for (const basis of inputs) await assert.rejects(timeline.addThought({ id: 'bad', text: '无效', source: { kind: 'life-planner', ref: '["profile"]' }, basis, activity }));
  await assert.rejects(timeline.addThought({ id: 'scoped', text: '无效', source: { kind: 'life-planner', ref: '["profile"]', scope: 'qq:private:2' }, basis: base, activity }));
  assert.deepEqual(timeline.snapshot().events, start.events);
  assert.equal(timeline.snapshot().sequence, start.sequence);
});

test('basis is immutable on retries and transitions; snapshot validator rejects gaps and changed history', async t => {
  const f = await fixture(t), timeline = await f.timeline();
  const input = { id: 'proof', text: '有依据', source: { kind: 'life-planner', ref: '["profile"]' },
    basis: emptyBasis(f.now(), timeline.snapshot().sequence), activity };
  const thought = await timeline.addThought(input);
  await timeline.planThought(thought.id, { startAt: f.now() + minute });
  await timeline.postponeThought(thought.id, f.now() + 2 * minute);
  assert.deepEqual(timeline.snapshot().thoughts[0].basis, thought.basis);
  await assert.rejects(timeline.addThought({ ...input, basis: { ...input.basis, at: input.basis.at - 1 } }), /different content/);
  const snapshot = timeline.snapshot(); assert.equal(validateLifeObserverSnapshot(snapshot), true);
  for (const alter of [
    value => { value.events.splice(0, 1); },
    value => { value.events[1].thought.basis.at--; },
    value => { value.thoughts[0].basis.at--; },
    value => { value.sequence++; },
    value => { value.events[0].id = 'life:1:2'; }
  ]) { const bad = structuredClone(snapshot); alter(bad); assert.throws(() => validateLifeObserverSnapshot(bad)); }
  assert.deepEqual(timeline.snapshot(), snapshot, 'pure validation never changes the owning timeline');
});

test('strict basis schema rejects hidden text, duplicate refs and malformed strengths', () => {
  const base = emptyBasis(10, 0);
  assert.deepEqual(normalizeLifeDecisionBasis(base), base);
  for (const changes of [
    { offeredRefs: ['profile', 'profile'] }, { selectedRefs: ['profile', 'profile'] },
    { offeredRefs: ['profile', 'interest:draw'], interests: [{ ref: 'interest:draw', strength: 1.1, sourceRefs: [] }] },
    { offeredRefs: ['profile', 'interest:draw'], interests: [] },
    { stateVersion: 'future' }, { timelineSequence: 0.1 }, { version: 'old' },
    { offeredRefs: ['profile', 'qq:private:7'] }, { selectedRefs: [], prompt: 'hidden' }
  ]) assert.throws(() => normalizeLifeDecisionBasis({ ...base, ...changes }));
});
