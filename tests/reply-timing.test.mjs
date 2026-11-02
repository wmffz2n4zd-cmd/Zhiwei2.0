import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplyTiming, replyTimingContext, measureModelCall, measurePreparation, measureSend } from '../src/reply-timing.js';

test('model retries including failures are timed separately from preparation and delivery', async () => {
  let time = 1000; const now = () => time;
  const timing = createReplyTiming(800, 900);
  await replyTimingContext.run(timing, async () => {
    await measurePreparation(timing, async () => {
      time += 10;
      await measureModelCall(async () => { time += 200; }, now);
      await assert.rejects(measureModelCall(async () => { time += 300; throw Error('failed'); }, now));
      time += 20;
    }, now);
    await measureSend(timing, async () => { time += 40; }, now);
  });
  assert.equal(timing.batchMs, 100);
  assert.equal(timing.preparationMs, 30);
  assert.equal(timing.modelMs, 500);
  assert.equal(timing.modelCalls, 2);
  assert.deepEqual(timing.calls.map(c => c.ok), [true, false]);
  assert.equal(timing.sendMs, 40);
  assert.equal(timing.totalMs, 770);
});

test('concurrent groups keep independent model timings and failed sends are measured', async () => {
  const a = createReplyTiming(), b = createReplyTiming();
  await Promise.all([a, b].map((timing, i) => replyTimingContext.run(timing, async () => {
    await measureModelCall(async () => { await Promise.resolve(); });
    if (i === 1) await measureModelCall(async () => {});
  })));
  assert.equal(a.modelCalls, 1); assert.equal(b.modelCalls, 2);
  await assert.rejects(measureSend(a, async () => { throw Error('bridge offline'); }));
  assert.equal(typeof a.sendMs, 'number'); assert.equal(typeof a.totalMs, 'number');
  assert.equal(b.sendMs, null);
});
