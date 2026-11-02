import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createLifeTimeline, recentLifeExperiences } from '../src/life-timeline.js';
import { lifePlanningContext } from '../src/life-planner.js';

const minute = 60000, day = 1440 * minute, origin = Date.parse('2026-10-28T09:21:00+08:00');
const reading = (id, extra = {}) => ({ id, kind: 'web-reading', mode: 'external',
  source: { kind: 'world-reading', ref: `run:${id}` }, summary: `实际读到页面 ${id}`, effects: null,
  evidence: { source: { kind: 'web' }, ref: `https://example.org/read/${id}` }, ...extra });

async function fixture(t) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'zhiwei-experience-context-'));
  let at = origin, timeline;
  const options = { directory, now: () => at };
  timeline = await createLifeTimeline(options);
  t.after(async () => {
    await timeline?.close().catch(() => {});
    if (resolve(directory).startsWith(parent + sep)) await rm(directory, { recursive: true, force: true });
  });
  return { directory, options, now: () => at, set: value => { at = value; }, advance: value => { at += value; },
    get timeline() { return timeline; },
    async reopen() { await timeline.close(); timeline = await createLifeTimeline(options); return timeline; } };
}

test('external observation time survives delayed delivery, restart and clock-rollback duplicate delivery', async t => {
  const f = await fixture(t), input = reading('delayed', { observedAt: origin - 2 * day });
  const event = await f.timeline.recordExperience(input);
  assert.equal(event.at, origin);
  assert.equal(event.experience.observedAt, origin - 2 * day);
  f.advance(minute); await f.reopen();
  assert.deepEqual(await f.timeline.recordExperience(input), event);
  f.set(origin - 3 * day);
  assert.deepEqual(await f.timeline.recordExperience(input), event, 'an existing ID is checked before the current clock');
  await assert.rejects(f.timeline.recordExperience({ ...input, observedAt: origin - day }), /different content/);
  assert.equal(f.timeline.snapshot().events.length, 1);
});

test('new observations reject future or invalid times and simulated backfill without writing a fact', async t => {
  const f = await fixture(t);
  for (const value of [origin + 1, -1, null, undefined, NaN, Infinity, 0.5, 'yesterday']) {
    await assert.rejects(f.timeline.recordExperience(reading('invalid', { observedAt: value })), /observation|observedAt/);
  }
  await assert.rejects(f.timeline.recordExperience({ ...reading('fiction'), mode: 'simulated', observedAt: origin - minute }), /Only an external/);
  assert.deepEqual(f.timeline.snapshot().events, []);
  const accepted = await f.timeline.recordExperience(reading('epoch', { observedAt: 0 }));
  assert.equal(accepted.experience.observedAt, 0);
});

test('legacy experience byte shape and journal contents remain unchanged when observation time is absent', async t => {
  const f = await fixture(t), event = await f.timeline.recordExperience(reading('legacy'));
  const before = await readFile(f.timeline.files.journal, 'utf8');
  assert.equal(Object.hasOwn(event.experience, 'observedAt'), false);
  f.advance(minute); await f.reopen();
  assert.deepEqual(f.timeline.snapshot().events, [event]);
  assert.equal(await readFile(f.timeline.files.journal, 'utf8'), before);
  assert.deepEqual(await f.timeline.recordExperience(reading('legacy')), event);
  const view = lifePlanningContext(f.timeline, f.now()).experiences[0];
  assert.equal(view.observedAt, origin, 'old observations use their recorded time only in the view');
});

test('hash-valid future observation time is rejected during replay and the original journal is retained', async t => {
  const f = await fixture(t); await f.timeline.recordExperience(reading('replay', { observedAt: origin }));
  await f.timeline.close();
  const transaction = JSON.parse(await readFile(f.timeline.files.journal, 'utf8'));
  transaction.events[0].experience.observedAt = origin + 1;
  const { hash: ignored, ...body } = transaction;
  const damaged = JSON.stringify({ ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') }) + '\n';
  await writeFile(f.timeline.files.journal, damaged);
  await assert.rejects(createLifeTimeline(f.options), /observation cannot follow/);
  assert.equal(await readFile(f.timeline.files.journal, 'utf8'), damaged);
});

test('chat and planning preserve real evidence and observation time with private filtering before selection', async t => {
  const f = await fixture(t);
  const publicEvent = await f.timeline.recordExperience(reading('public', { observedAt: origin - minute }));
  for (let i = 0; i < 12; i++) await f.timeline.recordExperience(reading(`private-${i}`, {
    source: { kind: 'world-reading', scope: 'qq:private:100', ref: `PRIVATE_SOURCE_${i}` },
    summary: `PRIVATE_SUMMARY_${i}`, observedAt: origin,
    evidence: { source: { kind: 'web', scope: 'qq:private:100' }, ref: `https://example.org/PRIVATE_EVIDENCE_${i}` }
  }));
  const context = lifePlanningContext(f.timeline, f.now());
  assert.equal(context.experiences.length, 1);
  assert.equal(context.experiences[0].ref, `event:${publicEvent.id}`);
  assert.equal(context.experiences[0].mode, 'external');
  assert.equal(context.experiences[0].observedAt, origin - minute);
  assert.deepEqual(context.experiences[0].evidence, publicEvent.experience.evidence);
  assert.deepEqual(context.experiences[0].source, publicEvent.source);
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE|qq:private:100/);
  assert.match(f.timeline.formatContext({ scope: 'qq:private:200' }), /https:\/\/example.org\/read\/public/);
  assert.doesNotMatch(f.timeline.formatContext({ scope: 'qq:private:200' }), /PRIVATE|qq:private:100/);
  assert.match(f.timeline.formatContext({ scope: 'qq:private:100' }), /PRIVATE_SUMMARY_11|PRIVATE_EVIDENCE_11/);
  context.experiences[0].source.ref = 'mutated';
  assert.equal(f.timeline.snapshot().events[0].source.ref, 'run:public');
});

test('experience context is bounded by observed recency and count rather than delayed accounting order', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 11; i++) await f.timeline.recordExperience(reading(`recent-${i}`, { observedAt: origin - (11 - i) * minute }));
  await f.timeline.recordExperience(reading('too-old', { observedAt: origin - 7 * day - 1 }));
  await f.timeline.recordExperience(reading('old-delayed', { observedAt: origin - day }));
  const context = lifePlanningContext(f.timeline, f.now());
  assert.equal(context.experiences.length, 8);
  assert.match(context.experiences.at(-1).summary, /recent-10/);
  assert.doesNotMatch(JSON.stringify(context.experiences), /too-old|old-delayed|recent-0\b/);
  const chat = f.timeline.formatContext({ limit: 3 });
  assert.match(chat, /recent-8|recent-9|recent-10/);
  assert.doesNotMatch(chat, /recent-7\b|too-old|old-delayed/);
  assert.deepEqual(recentLifeExperiences(f.timeline.snapshot().events, { at: f.now(), limit: 0 }), []);
  assert.doesNotMatch(f.timeline.formatContext({ limit: 0 }), /recent-10/);
  f.advance(8 * day);
  assert.equal(lifePlanningContext(f.timeline, f.now()).experiences.length, 0);
  assert.doesNotMatch(f.timeline.formatContext(), /recent-10|too-old/);
});

test('fantasy activity completion records only its title while restart interruption never claims completion', async t => {
  const f = await fixture(t);
  const thought = id => ({ id, text: '想回费伦处理一件小麻烦', source: { kind: 'life-planner', ref: 'profile' },
    activity: { title: '回费伦处理麻烦', mode: 'simulated', durationMs: minute, busy: false } });
  await f.timeline.addThought(thought('finished'));
  await f.timeline.planThought('finished');
  assert.match(f.timeline.formatContext(), /当前活动.*回费伦/);
  assert.equal(lifePlanningContext(f.timeline, f.now()).experiences.length, 0);
  f.advance(minute); await f.timeline.tick();
  const completed = f.timeline.snapshot().events.at(-1);
  assert.equal(completed.type, 'activity-completed');
  assert.equal(completed.summary, '完成角色生活安排「回费伦处理麻烦」。');
  assert.equal(completed.plan.mode, 'simulated');
  assert.equal(Object.hasOwn(completed, 'evidence'), false);
  assert.match(f.timeline.formatContext(), /不把角色经历说成与用户共同发生/);
  await f.timeline.addThought(thought('interrupted')); await f.timeline.planThought('interrupted');
  await f.reopen();
  const interrupted = f.timeline.snapshot().events.at(-1);
  assert.equal(interrupted.type, 'activity-interrupted');
  assert.equal(Object.hasOwn(interrupted, 'summary'), false);
  const results = lifePlanningContext(f.timeline, f.now()).experiences;
  assert.deepEqual(results.map(item => item.result), ['completed', 'interrupted']);
  assert.equal(results[1].summary, '');
});
