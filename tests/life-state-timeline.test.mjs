import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, readdir, mkdir, rmdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createLifeTimeline } from '../src/life-timeline.js';
import { createLifeState } from '../src/life-state.js';

const minute = 60000, origin = Date.parse('2026-10-28T09:21:00+08:00');
const effects = (topic = 'photography') => ({ version: 't030-1', mood: { valence: 0.3, energy: 0.1, tension: -0.1 },
  interest: { topic, label: topic === 'photography' ? '摄影' : topic, delta: 0.2 } });
const experience = (id, extra = {}) => ({ id, kind: 'discovery', mode: 'simulated', source: { kind: 'life', ref: `scene:${id}` },
  summary: '角色模拟中注意到光影构图', effects: effects(), ...extra });
const thought = (id, extra = {}) => ({ id, text: '想观察一下光影', source: { kind: 'life-planner', ref: 'profile' },
  activity: { title: '观察光影', durationMs: minute, mode: 'simulated', busy: false, effects: effects() }, ...extra });
const proof = source => ({ source, ref: 'read:fixture-1' });

async function fixture(t, { storage } = {}) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'zhiwei-state-timeline-'));
  let clock = origin, life;
  const options = { directory, now: () => clock, storage };
  life = await createLifeTimeline(options);
  t.after(async () => {
    await life?.close().catch(() => {});
    if (resolve(directory).startsWith(parent + sep)) await rm(directory, { recursive: true, force: true });
  });
  return { directory, options, get life() { return life; }, now: () => clock,
    advance(value) { clock += value; },
    async reopen() { await life.close(); life = await createLifeTimeline(options); return life; },
    state: () => createLifeState({ timeline: life, now: () => clock }) };
}

test('standalone experiences preserve stable source and time across delayed duplicate delivery and restart', async t => {
  const f = await fixture(t), input = experience('scene-1');
  const saved = await f.life.recordExperience(input);
  assert.equal(saved.type, 'experience-recorded'); assert.equal(saved.at, origin);
  assert.deepEqual(saved.source, input.source); assert.deepEqual(saved.experience.effects, input.effects);
  assert.deepEqual(f.life.snapshot().thoughts, []); assert.deepEqual(f.life.snapshot().plans, []);
  f.advance(3 * minute);
  const sequence = f.life.snapshot().sequence;
  assert.deepEqual(await f.life.recordExperience(input), saved);
  assert.deepEqual(await f.life.recordExperience({ ...input,
    effects: { ...input.effects, mood: { tension: -0.1, energy: 0.1, valence: 0.3 } } }), saved,
  'equivalent effects retain idempotency when object keys arrive in a different order');
  assert.equal(f.life.snapshot().sequence, sequence);
  await assert.rejects(f.life.recordExperience({ ...input, summary: '不同内容' }), /already exists with different content/);
  await assert.rejects(f.life.recordExperience({ ...input, source: { ...input.source, scope: 'private:b' } }), /already exists with different content/);
  const projected = f.state().snapshot();
  await f.reopen();
  assert.deepEqual(f.state().snapshot(), projected);
  assert.deepEqual(await f.life.recordExperience(input), saved);
  assert.equal(f.life.snapshot().events.length, 1);
});

test('experience input rejects unproved external facts, wrong private scope and caller-provided timestamps', async t => {
  const f = await fixture(t), global = experience('global', { mode: 'external' });
  await assert.rejects(f.life.recordExperience(global), /requires actual result evidence/);
  await assert.rejects(f.life.recordExperience({ ...global, evidence: proof({ kind: 'web', scope: 'private:a' }) }), /retain the activity scope/);
  await assert.rejects(f.life.recordExperience({ ...experience('past'), at: origin - minute }), /Invalid life experience input/);
  await assert.rejects(f.life.recordExperience(experience('unknown', { effects: { ...effects(), version: 'future' } })), /version|effects/i);
  await assert.rejects(f.life.recordExperience(experience('unbounded', { effects: { ...effects(), mood: { valence: 1, energy: 0, tension: 0 } } })), /Invalid mood/i);
  assert.equal(f.life.snapshot().events.length, 0);
  const privateInput = experience('private', { mode: 'external', source: { kind: 'chat', scope: 'private:a', ref: 'message:1' },
    evidence: proof({ kind: 'web', scope: 'private:a' }) });
  await f.life.recordExperience(privateInput);
  assert.equal(f.state().snapshot().interests.length, 0);
  assert.equal(f.state().snapshot({ scope: 'private:b' }).interests.length, 0);
  assert.equal(f.state().snapshot({ scope: 'private:a' }).interests.length, 1);
});

test('a backwards experience clock refuses a new fact but retains idempotent delivery of a committed fact', async t => {
  const f = await fixture(t), input = experience('existing');
  const saved = await f.life.recordExperience(input), events = f.life.snapshot().events;
  f.advance(-minute);
  await assert.rejects(f.life.recordExperience(experience('backdated')), /clock precedes committed events/);
  assert.deepEqual(f.life.snapshot().events, events);
  assert.deepEqual(await f.life.recordExperience(input), saved);
  assert.deepEqual(f.life.snapshot().events, events);
  f.advance(2 * minute);
  await f.life.recordExperience(experience('later'));
  assert.equal(f.life.snapshot().events.at(-1).at, origin + minute);
});

test('simulated planned effects wait for completion while missing effects preserve legacy behavior', async t => {
  const f = await fixture(t), first = thought('planned');
  await f.life.addThought(first);
  assert.equal(f.state().snapshot().interests.length, 0);
  await f.life.planThought(first.id);
  assert.equal(f.state().snapshot().interests.length, 0);
  f.advance(minute); await f.life.tick();
  assert.deepEqual(f.life.snapshot().events.at(-1).plan.effects, effects());
  assert.equal(f.state().snapshot().interests[0].topic, 'photography');
  const legacy = thought('legacy'); delete legacy.activity.effects;
  await f.life.addThought(legacy); await f.life.planThought(legacy.id);
  f.advance(minute); await f.life.tick();
  const last = f.life.snapshot().events.at(-1);
  assert.equal(Object.hasOwn(last.plan, 'effects'), false);
  const before = f.state().snapshot(); await f.reopen();
  assert.deepEqual(f.state().snapshot(), before);
  assert.equal(f.life.snapshot().events.filter(item => item.type === 'activity-completed').length, 2);
});

test('external completion consumes observed effects only and keeps expected effects separate', async t => {
  const f = await fixture(t), first = thought('external-1'); first.activity.mode = 'external';
  await f.life.addThought(first); const plan = await f.life.planThought(first.id);
  await assert.rejects(f.life.completeActivity(plan.id, { effects: effects() }), /actual result evidence/);
  await f.life.completeActivity(plan.id, { evidence: proof({ kind: 'web' }), summary: '页面确实读取，但没有形成兴趣' });
  assert.equal(f.state().snapshot().interests.length, 0, 'anticipated effects are not actual reading results');
  const second = thought('external-2'); second.activity.mode = 'external';
  await f.life.addThought(second); const plan2 = await f.life.planThought(second.id);
  const observed = effects('architecture');
  await f.life.completeActivity(plan2.id, { evidence: proof({ kind: 'web' }), summary: '实际结果', effects: observed });
  const event = f.life.snapshot().events.at(-1);
  assert.equal(event.plan.effects.interest.topic, 'photography'); assert.equal(event.effects.interest.topic, 'architecture');
  assert.deepEqual(f.state().snapshot().interests.map(item => item.topic), ['architecture']);
  const before = f.state().snapshot(); await f.reopen(); assert.deepEqual(f.state().snapshot(), before);
});

test('simulated completion rejects a separate effects observation instead of silently ignoring it', async t => {
  const f = await fixture(t); await f.life.addThought(thought('simulated'));
  const plan = await f.life.planThought('simulated');
  for (const value of [effects('other-topic'), null]) {
    await assert.rejects(f.life.completeActivity(plan.id, { effects: value }), /must come from its plan/);
    assert.equal(f.life.snapshot().plans[0].status, 'active');
  }
  await f.life.completeActivity(plan.id, { summary: '模拟活动结束' });
  assert.equal(f.state().snapshot().interests[0].topic, 'photography');
  await assert.rejects(f.life.completeActivity(plan.id, { effects: null }), /must come from its plan/);
});

test('private planned effects are absent from public and other-recipient availability', async t => {
  const f = await fixture(t), input = thought('private-plan', { source: { kind: 'chat', ref: 'secret', scope: 'private:a' } });
  input.activity.effects = effects('secret-topic');
  await f.life.addThought(input); const plan = await f.life.planThought(input.id);
  assert.equal(f.life.availability({ scope: 'private:a' }).activity.effects.interest.topic, 'secret-topic');
  assert.equal(Object.hasOwn(f.life.availability().activity, 'effects'), false);
  assert.equal(Object.hasOwn(f.life.availability({ scope: 'private:b' }).activity, 'effects'), false);
  await assert.rejects(f.life.completeActivity(plan.id, { evidence: proof({ kind: 'chat', scope: 'private:b' }) }), /retain the activity scope/);
});

test('failure after a real start has no interest reward and restart interruption has no effect', async t => {
  const f = await fixture(t);
  await f.life.addThought(thought('failed')); const failed = await f.life.planThought('failed');
  await f.life.failActivity(failed.id, '没能继续');
  let state = f.state().snapshot();
  assert.equal(state.interests.length, 0); assert.ok(state.mood.valence < 0);
  await f.life.addThought(thought('interrupted')); await f.life.planThought('interrupted');
  const before = state.mood; await f.reopen(); state = f.state().snapshot();
  assert.equal(state.mood.valence, before.valence); assert.equal(state.interests.length, 0);
  assert.equal(f.life.snapshot().events.at(-1).type, 'activity-interrupted');
});

test('experience history survives archive rotation and an incomplete active journal tail', async t => {
  const f = await fixture(t, { storage: { segmentBytes: 1024 } });
  for (let i = 0; i < 8; i++) await f.life.recordExperience(experience(`scene-${i}`, { effects: i % 2 ? null : effects() }));
  assert.ok(f.life.diagnostics.archivedSegments > 0);
  const events = f.life.snapshot().events, state = f.state().snapshot();
  await f.life.close(); const original = await readFile(f.life.files.journal);
  await appendFile(f.life.files.journal, '{"version":1');
  await f.reopen();
  assert.deepEqual(await readFile(f.life.files.journal), original);
  assert.deepEqual(f.life.snapshot().events, events); assert.deepEqual(f.state().snapshot(), state);
  assert.equal((await readdir(f.directory)).filter(name => name.includes('.incomplete-')).length, 1);
});

test('a durable experience is not duplicated when the snapshot write fails', async t => {
  const f = await fixture(t), path = f.life.files.snapshot;
  await rm(path); await mkdir(path);
  const input = experience('durable'), saved = await f.life.recordExperience(input);
  assert.match(f.life.diagnostics.warnings.join('\n'), /snapshot checkpoint failed/);
  await f.life.close(); await rmdir(path); await f.reopen();
  assert.deepEqual(await f.life.recordExperience(input), saved);
  assert.equal(f.life.snapshot().events.length, 1);
});

test('hash-valid but invalid experience metadata fails closed and preserves original bytes', async t => {
  const f = await fixture(t); await f.life.recordExperience(experience('scene'));
  await f.life.close();
  const transaction = JSON.parse(await readFile(f.life.files.journal, 'utf8'));
  transaction.events[0].experience.effects.version = 'future';
  const { hash: ignored, ...body } = transaction;
  const damaged = JSON.stringify({ ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') }) + '\n';
  await writeFile(f.life.files.journal, damaged);
  await assert.rejects(createLifeTimeline(f.options), /version|effect/i);
  assert.equal(await readFile(f.life.files.journal, 'utf8'), damaged);
});
