import { spacePublicationUrl } from './space-sources.js';
import { setImmediate as yieldToHub } from 'node:timers/promises';

// Only the public planner may contribute daily prose. A planner can have seen
// credentialed reading notes even when a decision only cited the profile.
function dailySummary(event, sources) {
  const basis = event.thought.basis;
  if (sources && (sources.has('thought:' + event.thought.id) || basis.offeredRefs.every(ref => ref === 'profile' || sources.has(ref)))) {
    return (event.thought.activity.completionSummary || event.plan.title).slice(0, 1000);
  }
  const minutes = Math.max(1, Math.round((event.plan.endedAt - event.plan.actualStartedAt) / 60000));
  return `我刚完成了自己安排的一段日常活动，花了约${minutes}分钟。`;
}

export function spaceOpportunity(event, safeRefs) {
  if (event.source?.scope) return null;
  if (event.type === 'activity-completed' && event.source?.kind === 'life-planner' &&
      event.plan?.mode === 'simulated' && event.plan.status === 'completed' &&
      event.thought?.basis && event.thought.source?.kind === 'life-planner' && !event.thought.source.scope) {
    return { kind: 'daily', eventId: event.id, observedAt: event.at, summary: dailySummary(event, safeRefs) };
  }
  const observed = event.experience, proof = observed?.evidence;
  if (event.type !== 'experience-recorded' || event.source?.kind !== 'world-reading' ||
      observed?.mode !== 'external' || observed.kind !== 'reading' || observed.id !== event.source.ref ||
      proof?.source.kind !== 'space-publication-page' || proof.source.scope || proof.source.ref !== observed.id) return null;
  const match = /^(https:\/\/[^\s]+)\nsha256:[a-f0-9]{64}$/.exec(proof.ref);
  const url = match && spacePublicationUrl(match[1]);
  return url && url === match[1] ? { kind: 'share', eventId: observed.id, observedAt: observed.observedAt, url } : null;
}

export function createSpaceTimeline({ timeline, store, publisher, canPublish }) {
  let offset = store.spaceEventOffset(timeline.eventCount), pending, controller;
  // This set contains only simulated public-planner activity whose *entire*
  // input was already trusted. Rebuild on demand from immutable history.
  const safeRefs = new Set();
  // The personal-state projection retains only its last few supporting refs.
  // Retain the first untrusted contribution to each derived field across the
  // whole journal so truncated ancestry cannot turn a mixed interest public.
  const mixedSince = new Map();
  let verifiedCount = 0, closed = false;
  function remember(event) {
    if (event.source?.scope || timeline.personaPolicy && !timeline.personaPolicy.eventEligible(event)) return;
    const t = event.thought, basis = t?.basis, thoughtRef = t && 'thought:' + t.id;
    const safeInput = ref => {
      if (ref === 'profile' || safeRefs.has(ref)) return true;
      const derived = ref === 'state:personal-mood' ? basis.mood : basis.interests?.find(item => item.ref === ref);
      return derived?.ref === ref && derived.sourceRefs.length > 0 && derived.sourceRefs.every(source => safeRefs.has(source)) &&
        (mixedSince.get(ref) ?? Infinity) > basis.timelineSequence;
    };
    if (event.type === 'thought-added' && event.source.kind === 'life-planner' && t.activity?.mode === 'simulated' &&
        basis && basis.offeredRefs.every(safeInput) && (!timeline.personaPolicy || timeline.personaPolicy.thoughtEligible(t))) {
      safeRefs.add(thoughtRef);
    }
    if (event.type === 'activity-completed' && safeRefs.has(thoughtRef)) {
      if (!event.evidence && (!event.summary || event.summary === t.activity.completionSummary ||
          event.summary === `完成角色生活安排「${event.plan.title}」。`)) safeRefs.add('event:' + event.id);
      // Simulated effects come exclusively from the same verified planner draft.
      return;
    }
    const effects = event.experience?.effects || (event.type === 'activity-completed'
      ? event.plan.mode === 'simulated' ? event.plan.effects : event.effects
      : event.type === 'activity-failed' && event.plan?.actualStartedAt != null ? { mood:event.plan.effects?.mood } : null);
    if (!effects) return;
    const sequence = Number(event.id.split(':')[1]);
    const mark = ref => { if (!mixedSince.has(ref)) mixedSince.set(ref,sequence); };
    if (effects.mood && Object.values(effects.mood).some(value => value !== 0)) mark('state:personal-mood');
    if (effects.interest?.delta) mark('interest:' + effects.interest.topic);
  }
  async function run(signal) {
    if (offset > timeline.eventCount) throw Error('Space timeline checkpoint is ahead of available history');
    const end = Math.min(timeline.eventCount, offset + 64);
    if (offset === end) return;
    while (verifiedCount < end) {
      if (signal.aborted || !canPublish()) return;
      const history = timeline.eventsFrom(verifiedCount, Math.min(128, end - verifiedCount));
      for (const event of history) remember(event);
      verifiedCount += history.length;
      if (verifiedCount < end) await yieldToHub();
    }
    for (const event of timeline.eventsFrom(offset, end - offset)) {
      if (signal.aborted || !canPublish()) return;
      const opportunity = (!timeline.personaPolicy || timeline.personaPolicy.eventEligible(event)) && spaceOpportunity(event, safeRefs);
      if (opportunity) {
        const result = await publisher.consider(opportunity, {signal});
        if (signal.aborted || !canPublish() || result === 'busy' ||
            result === 'cancelled' && !store.hasSpaceDecision(opportunity.kind + ':' + opportunity.eventId)) return;
      }
      if (!store.advanceSpaceEventOffset(offset, offset + 1)) {
        offset = store.spaceEventOffset(timeline.eventCount);
        return;
      }
      offset++;
    }
  }
  return {
    tick() {
      if (closed || pending || offset === timeline.eventCount) return pending;
      controller = new AbortController();
      pending = run(controller.signal).finally(() => { pending = null; });
      return pending;
    },
    async close() { closed = true; controller?.abort(); await pending; }
  };
}
