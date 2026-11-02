import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createLifeTimeline } from '../src/life-timeline.js';
import { createLifePlanner } from '../src/life-planner.js';
import { createLifeBrowsing } from '../src/life-browsing.js';
import { createWorld } from '../src/world.js';

const minute = 60000, origin = Date.parse('2026-10-29T03:00:00Z');
const output = value => ({ text: JSON.stringify(value), usage: { input_tokens: 10, output_tokens: 5 } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, { think = async () => output({ action: 'rest' }), config = {}, pageExtra = {}, runtimeBudget } = {}) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const projectDir = await mkdtemp(join(base, 'life-browsing-')), directory = join(projectDir, 'data', 'life');
  let at = origin, timeline = await createLifeTimeline({ directory, now: () => at });
  const calls = [], models = [];
  const browser = { status: () => ({ busy: false, mode: 'readonly' }),
    read: async url => { calls.push(['read', url]); return { url, title: '云的形状', text: '真实测试页面', links: [], imagePaths: [], ...pageExtra }; },
    search: async query => { calls.push(['search', query]); return { url: 'https://example.org/cloud', title: '云', text: '测试页面', links: [], imagePaths: [], ...pageExtra }; },
    close: async () => {} };
  const world = await createWorld({ projectDir, browser, now: () => at,
    config: { runtimeBudget: { enabled: false }, life: { enabled: true }, ...config }, runtimeBudget,
    think: async input => { models.push(input); return think(input); },
    recordExperience: input => timeline.recordExperience(input) });
  const drivers = [], planners = [];
  const driver = (options = {}) => { const result = createLifeBrowsing({ timeline, world, now: () => at, ...options }); drivers.push(result); return result; };
  t.after(async () => {
    for (const item of drivers) await item.close().catch(() => {});
    for (const item of planners) await item.close().catch(() => {});
    await world.close(); await timeline.close();
    if (resolve(projectDir).startsWith(base + sep)) await rm(projectDir, { recursive: true, force: true });
  });
  return { calls, models, world, driver, now: () => at, get timeline() { return timeline; },
    async plan({ action = { type: 'browse', target: '云的形状' }, delay = 0, duration = 5 } = {}) {
      const planner = await createLifePlanner({ directory, timeline, now: () => at, decide: async () => ({ reconsiderAfterMinutes: 240,
        thoughts: [{ text: '想观察一下云', sourceRefs: ['profile'], strength: 0.7, title: '看云的资料', statusText: '正在看资料',
          busy: false, durationMinutes: duration, delayMinutes: delay, action, effects: null }] }) });
      planners.push(planner); await planner.tick(); return timeline.snapshot().plans.at(-1);
    },
    async minutes(count) { for (let i = 0; i < count; i++) { at += minute; await timeline.tick(); } },
    async reopen() { await timeline.close(); timeline = await createLifeTimeline({ directory, now: () => at }); }
  };
}

test('a persisted planner browse action drives an actual reader and confirmed timeline receipt once', async t => {
  const effects = { version: 't030-1', mood: { valence: 0.2, energy: 0, tension: 0 }, interest: null };
  const f = await fixture(t, { think: async () => output({ action: 'note', summary: '云的形状', comment: '有点开心', effects }) });
  const plan = await f.plan(), driver = f.driver();
  assert.equal((await driver.tick()).kind, 'completed');
  assert.equal((await driver.tick()).kind, 'waiting');
  assert.deepEqual(f.calls, [['search', '云的形状']]); assert.equal(f.models.length, 1);
  const state = f.timeline.snapshot(), completion = state.events.find(event => event.type === 'activity-completed');
  assert.equal(state.plans[0].status, 'completed'); assert.equal(state.plans[0].actionClaim.planId, plan.id);
  assert.equal(state.events.filter(event => event.type === 'experience-recorded').length, 1);
  assert.equal(state.events.filter(event => event.experience?.effects?.mood).length, 1);
  assert.equal(completion.effects, undefined, 'reading effects are not applied twice through the plan');
  assert.match(completion.evidence.ref, /world:/);
});

test('no typed browse candidate means no browser or model call', async t => {
  const f = await fixture(t), driver = f.driver();
  assert.equal((await driver.tick()).kind, 'waiting');
  await f.plan({ action: { type: 'contact' } });
  assert.equal((await driver.tick()).kind, 'waiting'); assert.deepEqual(f.calls, []); assert.equal(f.models.length, 0);
});

test('calibration denial fails the claimed activity before even opening a page', async t => {
  const f = await fixture(t, { config: { runtimeBudget: {} } }), plan = await f.plan();
  assert.equal((await f.driver().tick()).kind, 'failed');
  assert.equal(f.timeline.snapshot().plans[0].id, plan.id); assert.equal(f.timeline.snapshot().plans[0].status, 'failed');
  assert.deepEqual(f.calls, []); assert.equal(f.models.length, 0); assert.equal(f.timeline.snapshot().events.filter(e => e.experience).length, 0);
});

test('login and rest without observation never masquerade as completed external activities', async t => {
  for (const variant of ['login', 'rest']) await t.test(variant, async t => {
    const f = await fixture(t, { pageExtra: variant === 'login' ? { requiresLogin: true } : {} });
    await f.plan();
    const driver = variant === 'login' ? f.driver() : f.driver({ world: { run: async () => ({ status: 'complete', runId: 'a'.repeat(36), experienceRefs: [] }) } });
    assert.equal((await driver.tick()).kind, 'no-reading');
    assert.equal(f.timeline.snapshot().plans[0].status, 'failed'); assert.equal(f.models.length, 0);
    assert.equal(f.timeline.snapshot().events.filter(e => e.experience).length, 0);
  });
});

test('two consumers race on one durable claim and cannot duplicate the same navigation', async t => {
  const f = await fixture(t); await f.plan();
  const a = f.driver(), b = f.driver(), results = await Promise.all([a.tick(), a.tick(), b.tick()]);
  assert.equal(results.filter(result => result.kind === 'completed').length, 2, 'same consumer promise is shared');
  assert.equal(results[2].kind, 'already-consumed'); assert.equal(f.calls.length, 1); assert.equal(f.models.length, 1);
  assert.equal(f.timeline.snapshot().events.filter(e => e.type === 'activity-action-claimed').length, 1);
});

test('a claimed action interrupted before navigation stays terminal on restart', async t => {
  const f = await fixture(t), plan = await f.plan();
  await f.timeline.claimAction(plan.id); await f.reopen();
  assert.equal(f.timeline.snapshot().plans[0].status, 'interrupted');
  assert.equal((await f.driver().tick()).kind, 'waiting'); assert.deepEqual(f.calls, []); assert.equal(f.models.length, 0);
});

test('a late real reading remains an experience without reviving the failed plan', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { think: async () => { entered.resolve(); await finish.promise; return output({ action: 'rest' }); } });
  await f.plan(); const driver = f.driver(), running = driver.tick(); await entered.promise;
  await f.minutes(5); assert.equal(f.timeline.snapshot().plans[0].status, 'failed');
  finish.resolve(); assert.equal((await running).kind, 'late-result');
  const state = f.timeline.snapshot(); assert.equal(state.plans[0].status, 'failed');
  assert.equal(state.events.filter(e => e.type === 'activity-completed').length, 0);
  assert.equal(state.events.find(e => e.type === 'experience-recorded').experience.observedAt, origin);
  assert.equal((await driver.tick()).kind, 'waiting'); assert.equal(f.calls.length, 1);
});

test('invented or wrong-scope reading receipts cannot complete the activity', async t => {
  for (const scope of [null, 'qq:private:222']) await t.test(String(scope), async t => {
    const f = await fixture(t); await f.plan();
    const runId = 'a'.repeat(36), ref = `world:${runId}:0`;
    if (scope) await f.timeline.recordExperience({ id: ref, kind: 'reading', mode: 'external',
      source: { kind: 'world-reading', scope, ref }, summary: '别人的阅读', effects: null,
      evidence: { source: { kind: 'observed-web-page', scope }, ref: 'https://example.org/private' } });
    const driver = f.driver({ world: { run: async () => ({ status: 'complete', runId, experienceRefs: [ref] }) } });
    assert.equal((await driver.tick()).kind, 'no-reading'); assert.equal(f.timeline.snapshot().plans[0].status, 'failed');
    assert.deepEqual(f.calls, []);
  });
});

test('claim persistence failure invokes no external action', async t => {
  const f = await fixture(t); await f.plan();
  const driver = f.driver({ timeline: { ...f.timeline, claimAction: async () => { throw Error('claim storage failed'); } } });
  await assert.rejects(driver.tick(), /claim storage failed/); assert.deepEqual(f.calls, []); assert.equal(f.models.length, 0);
});
