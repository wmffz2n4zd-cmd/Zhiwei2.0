import { AsyncLocalStorage } from 'node:async_hooks';

// One context per reply, including any context-expansion CLI retries.
export const replyTimingContext = new AsyncLocalStorage();
export function createReplyTiming(receivedAt = Date.now(), batchCompletedAt = receivedAt, queueStartedAt = batchCompletedAt) {
  return { receivedAt, batchMs: Math.max(0, batchCompletedAt - receivedAt), queueMs: Math.max(0, queueStartedAt - batchCompletedAt),
    preparationMs: 0, modelMs: 0, modelCalls: 0, sendMs: null, totalMs: null, calls: [] };
}
export async function measureModelCall(run, now = Date.now) {
  const timing = replyTimingContext.getStore();
  if (!timing) return run();
  const startedAt = now(); const call = { startedAt, durationMs: null, ok: false };
  timing.calls.push(call); timing.modelCalls++;
  try { const result = await run(); call.ok = true; if (result?.cliTiming) call.cli = result.cliTiming; return result; }
  catch (error) {
    if (error.code === 'REPLY_SUPERSEDED') { call.superseded = true; if (error.cliTiming) call.cli = error.cliTiming; }
    throw error;
  }
  finally { call.durationMs = Math.max(0, now() - startedAt); timing.modelMs += call.durationMs; }
}
export async function measurePreparation(timing, run, now = Date.now) {
  const start = now(), beforeModel = timing.modelMs;
  try { return await run(); }
  finally { timing.preparationMs += Math.max(0, now() - start - (timing.modelMs - beforeModel)); }
}
export async function measureSend(timing, run, now = Date.now) {
  const start = now();
  try { return await run(); }
  finally { timing.sendMs = Math.max(0, now() - start); timing.totalMs = Math.max(0, now() - timing.receivedAt); }
}
