// The proactive lifecycle exposes a live claim guard, rather than an input
// AbortSignal. Bridge that guard to actual HTTP/model cancellation and drain it.
export async function withCurrentReplySignal(assertCurrent, run, { intervalMs = 100 } = {}) {
  if (typeof assertCurrent !== 'function' || typeof run !== 'function'
    || !Number.isSafeInteger(intervalMs) || intervalMs < 10) throw TypeError('Current reply guard required');
  const controller = new AbortController();
  let failure = null, pending = null, finished = false, completed = false;
  const check = async () => {
    if (failure) throw failure;
    try {
      if (await assertCurrent() === false) throw Error('Reply claim changed');
    } catch (error) {
      failure = Object.assign(Error('Reply no longer current'), {
        code: error?.code === 'RETRIEVAL_EVIDENCE_EXPIRED' ? error.code : 'REPLY_SUPERSEDED', cause: error });
      controller.abort(failure); throw failure;
    }
    if (failure) throw failure;
  };
  await check();
  const timer = setInterval(() => {
    if (!finished && !pending) {
      pending = check().catch(() => {}).finally(() => { pending = null; });
    }
  }, intervalMs);
  timer.unref?.();
  try {
    const result = await run({ signal: controller.signal, assertCurrent: check });
    await check();
    completed = true;
    return result;
  } catch (error) {
    if (failure) { failure.usage ??= error?.usage ?? null; throw failure; }
    throw error;
  } finally {
    finished = true; clearInterval(timer);
    if (pending) await pending;
    if (!completed || failure) controller.abort();
    if (failure) throw failure;
  }
}
