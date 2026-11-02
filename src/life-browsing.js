/** A consumer of durable typed actions; the Hub's life timer is the only scheduler. */
export function createLifeBrowsing({ timeline, world, now = Date.now } = {}) {
  if (!timeline || typeof timeline.claimAction !== 'function' || typeof world?.run !== 'function') throw TypeError('Life browsing needs a timeline and a world reader');
  let closed = false, pending = null;
  const current = plan => {
    const state = timeline.snapshot(), found = state.plans.find(item => item.id === plan.id), at = now();
    return !closed && found?.status === 'active' && found.action?.type === 'browse'
      && found.actionClaim?.planId === plan.id && found.actionClaim?.claimedAt === plan.actionClaim.claimedAt
      && at >= found.actualStartedAt && at < found.endAt && at >= state.lastObservedAt
      && at - state.lastObservedAt <= timeline.policy.maxObservationGapMs;
  };
  async function run() {
    const next = timeline.snapshot().plans.find(item => item.status === 'active' && item.action?.type === 'browse' && !item.actionClaim);
    if (!next) return { kind: 'waiting' };
    const plan = await timeline.claimAction(next.id);
    if (!plan) return { kind: 'already-consumed' };
    let result;
    try {
      result = await world.run(plan.action.target, { scope: plan.source.scope, canContinue: () => current(plan) });
    } catch {
      await timeline.failActivity(plan.id, 'reading-action-failed');
      return { kind: 'failed', planId: plan.id };
    }
    // Only observations committed by world and confirmed by the actual timeline
    // are evidence. A model's rest, a login page, or invented refs are not.
    const state = timeline.snapshot();
    const refs = Array.isArray(result?.experienceRefs) ? [...new Set(result.experienceRefs)] : [];
    const validRun = typeof result?.runId === 'string' && /^[a-f0-9-]{36}$/.test(result.runId);
    const proven = validRun && refs.length > 0 && refs.length <= 8 && refs.every(ref => typeof ref === 'string'
      && ref.startsWith(`world:${result.runId}:`) && state.events.some(event => event.type === 'experience-recorded'
        && event.experience?.id === ref && event.experience.mode === 'external'
        && event.source.kind === 'world-reading' && (event.source.scope || null) === (plan.source.scope || null)));
    if (result?.status !== 'complete' || !proven) {
      await timeline.failActivity(plan.id, 'reading-result-without-evidence');
      return { kind: 'no-reading', planId: plan.id };
    }
    if (!current(plan)) {
      await timeline.tick();
      return { kind: 'late-result', planId: plan.id };
    }
    try {
      await timeline.completeActivity(plan.id, { summary: '已完成本次只读浏览，观察记录已接入个人经历。',
        evidence: { source: { kind: 'world-reading', ...(plan.source.scope ? { scope: plan.source.scope } : {}) },
          ref: JSON.stringify({ runId: result.runId, experienceRefs: refs }) } });
    } catch (error) {
      // completeActivity advances time itself. A boundary crossed between our
      // read and that transaction must not revive the expired activity.
      await timeline.tick();
      if (timeline.snapshot().plans.find(item => item.id === plan.id)?.status === 'active') throw error;
      return { kind: 'late-result', planId: plan.id };
    }
    return { kind: 'completed', planId: plan.id, runId: result.runId };
  }
  return {
    tick() {
      if (closed) return Promise.reject(Error('Life browsing is closed'));
      if (!pending) pending = run().finally(() => { pending = null; });
      return pending;
    },
    async close() { closed = true; if (pending) await pending; }
  };
}
