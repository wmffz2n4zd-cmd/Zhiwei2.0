// Personal state is a deterministic projection of the timeline's committed events.
// The timeline owns persistence, recovery, deduplication and the single-writer lock.
// Reading or allowing time to pass never writes an experience or invokes a model.
const VERSION = 't030-1';
const HOUR = 3600000, DAY = 24 * HOUR;
const MOOD_HALF_LIFE = 3 * HOUR, INTEREST_HALF_LIFE = 30 * DAY;
const ACTIVE_INTEREST = 0.15, DAILY_INTEREST_GAIN = 0.3;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const fade = (value, elapsed, halfLife) => value * Math.pow(0.5, Math.max(0, elapsed) / halfLife);
const round = value => Math.abs(value) < 0.000001 ? 0 : Math.round(value * 1000000) / 1000000;
const day = at => Math.floor((at + 8 * HOUR) / DAY);
const visible = (source, scope) => !source?.scope || source.scope === scope;

function exact(value, keys, label) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) {
    throw new TypeError(`Invalid ${label} fields`);
  }
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value.trim();
}
function number(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) throw new TypeError(`Invalid ${label}`);
  return value;
}
function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new TypeError('Personal state time must be epoch milliseconds');
  return value;
}

/** Explicit appraisal only: old text, titles and legacy reply scores are not input. */
export function normalizeLifeEffects(value) {
  if (value == null) return null;
  exact(value, ['version', 'mood', 'interest'], 'life effects');
  if (value.version !== VERSION) throw new TypeError('Unsupported life effects version');
  let mood = null, interest = null;
  if (value.mood !== null) {
    exact(value.mood, ['valence', 'energy', 'tension'], 'life mood effects');
    mood = Object.fromEntries(['valence', 'energy', 'tension'].map(key => [key, number(value.mood[key], -0.5, 0.5, `mood ${key}`)]));
  }
  if (value.interest !== null) {
    exact(value.interest, ['topic', 'label', 'delta'], 'life interest effects');
    const topic = text(value.interest.topic, 80, 'interest topic');
    if (!/^[a-zA-Z0-9_.:-]+$/.test(topic)) throw new TypeError('Interest topic must be a stable plain identifier');
    interest = { topic, label: text(value.interest.label, 80, 'interest label'),
      delta: number(value.interest.delta, -0.3, 0.3, 'interest delta') };
  }
  return { version: VERSION, mood, interest };
}

function proof(evidence, scope) {
  return plain(evidence) && plain(evidence.source) && typeof evidence.source.kind === 'string'
    && typeof evidence.ref === 'string' && evidence.ref.trim()
    && (!evidence.source.scope || evidence.source.scope === scope);
}
function appraisal(event) {
  if (event.type === 'experience-recorded') {
    const item = event.experience;
    if (!item || !['simulated', 'external'].includes(item.mode)) throw Error('Invalid personal experience mode');
    if (item.mode === 'external' && !proof(item.evidence, event.source?.scope)) throw Error('External personal experience needs scoped result evidence');
    return { effects: normalizeLifeEffects(item.effects), mode: item.mode, kind: item.kind || 'experience' };
  }
  if (event.type === 'activity-completed') {
    const mode = event.plan?.mode;
    if (!['simulated', 'external'].includes(mode)) throw Error('Invalid personal activity mode');
    if (mode === 'external' && !proof(event.evidence, event.source?.scope)) throw Error('External personal activity needs scoped result evidence');
    // External outcomes require an observation made at completion. An intention
    // attached to the plan is never evidence of what external reading felt like.
    return { effects: normalizeLifeEffects(mode === 'simulated' ? event.plan.effects : event.effects), mode, kind: 'activity-completed' };
  }
  if (event.type === 'activity-failed' && event.plan?.effects != null) {
    const planned = normalizeLifeEffects(event.plan.effects);
    // A failure before actual activity began is an unfulfilled plan, not an
    // experienced setback. Restart/observation interruptions are ignored too.
    if (event.plan.actualStartedAt == null || !planned.mood) return null;
    return { effects: { version: VERSION, mood: { valence: -0.08, energy: 0, tension: 0.06 }, interest: null },
      mode: event.plan.mode, kind: 'activity-failed' };
  }
  return null;
}

function appendRef(refs, ref, limit = 4) {
  if (!refs.includes(ref)) refs.push(ref);
  if (refs.length > limit) refs.splice(0, refs.length - limit);
}
function effectiveTime(event) {
  const observedAt = event.type === 'experience-recorded' ? event.experience?.observedAt : undefined;
  if (observedAt === undefined) return event.at;
  timestamp(observedAt);
  if (event.experience.mode !== 'external' || observedAt > event.at) throw Error('Invalid personal experience observation time');
  return observedAt;
}
function project(events, at, scope, detailed = false) {
  const mood = { valence: 0, energy: 0, tension: 0, sourceRefs: [], causes: [] };
  const interests = new Map(), gains = new Map(), changes = [];
  let moodAt = null;
  // A recovered outbox may arrive after newer experiences. Reconstruct causal
  // order from committed observation times so old feelings decay and spend the
  // original day's interest allowance. Equal times retain journal order.
  const ordered = events.filter(event => visible(event.source, scope))
    .map(event => ({ event, occurredAt: effectiveTime(event) }))
    .sort((a, b) => a.occurredAt - b.occurredAt);
  for (const { event: committed, occurredAt } of ordered) {
    const event = { ...committed, at: occurredAt };
    const item = appraisal(event);
    if (!item?.effects) continue;
    const ref = `event:${event.id}`, { effects, mode, kind } = item;
    if (effects.mood && Object.values(effects.mood).some(value => value !== 0)) {
      if (moodAt != null) for (const key of ['valence', 'energy', 'tension']) mood[key] = fade(mood[key], event.at - moodAt, MOOD_HALF_LIFE);
      moodAt = Math.max(moodAt ?? event.at, event.at);
      let changed = false;
      for (const key of ['valence', 'energy', 'tension']) {
        const next = clamp(mood[key] + effects.mood[key], key === 'tension' ? 0 : -1, 1);
        changed ||= next !== mood[key]; mood[key] = next;
      }
      if (changed) {
        appendRef(mood.sourceRefs, ref);
        mood.causes.push({ ref, at: event.at, mode, kind }); mood.causes = mood.causes.slice(-4);
        changes.push({ ref, at: event.at, mode, type: 'mood-changed' });
      }
    }
    if (effects.interest?.delta) {
      const { topic, label } = effects.interest;
      let interest = interests.get(topic), delta = effects.interest.delta;
      // The cap applies to each visible projection. Private events were already
      // excluded from the public projection, so they cannot spend its allowance.
      const key = JSON.stringify([topic, day(event.at)]);
      if (delta > 0) {
        const consumed = gains.get(key) || 0;
        delta = Math.min(delta, Math.max(0, DAILY_INTEREST_GAIN - consumed));
        gains.set(key, consumed + delta);
      }
      if (delta === 0 || (!interest && delta < 0)) continue;
      if (!interest) {
        interest = { topic, label, strength: 0, firstAt: event.at, lastAt: event.at,
          reactivatedAt: null, reactivatedRef: null, sourceRefs: [], modes: [], everActive: false };
        interests.set(topic, interest);
      }
      const before = fade(interest.strength, event.at - interest.lastAt, INTEREST_HALF_LIFE);
      const next = clamp(before + delta, 0, 1);
      if (next === before) continue;
      const revived = interest.everActive && before < ACTIVE_INTEREST && next >= ACTIVE_INTEREST;
      interest.strength = next; interest.lastAt = Math.max(interest.lastAt, event.at);
      if (revived) { interest.reactivatedAt = event.at; interest.reactivatedRef = ref; }
      interest.everActive ||= next >= ACTIVE_INTEREST;
      appendRef(interest.sourceRefs, ref);
      if (!interest.modes.includes(mode)) interest.modes.push(mode);
      const type = interest.sourceRefs.length === 1 && interest.firstAt === event.at ? 'interest-created'
        : revived ? 'interest-reactivated' : delta > 0 ? 'interest-strengthened' : 'interest-weakened';
      changes.push({ ref, at: event.at, mode, type, topic,
        ...(detailed ? { recordedAt: committed.at, before: round(before), after: round(next),
          requestedDelta: effects.interest.delta, actualDelta: round(next - before) } : {}) });
    }
  }
  if (moodAt != null) for (const key of ['valence', 'energy', 'tension']) mood[key] = round(fade(mood[key], at - moodAt, MOOD_HALF_LIFE));
  const projectedInterests = [...interests.values()].map(({ everActive, ...item }) => {
    const strength = round(fade(item.strength, at - item.lastAt, INTEREST_HALF_LIFE));
    return { ...item, strength, status: strength < ACTIVE_INTEREST ? 'dormant' : 'active' };
  }).sort((a, b) => b.strength - a.strength || a.topic.localeCompare(b.topic, 'en'));
  return { version: VERSION, at, mood, interests: projectedInterests, changes: detailed ? changes : changes.slice(-24) };
}

/** Isolated deterministic projection for reports. It owns no clock, cache or writer. */
export function projectLifeState(events, { at, recordedThrough = at, scope, detailed = false } = {}) {
  timestamp(at);
  timestamp(recordedThrough);
  if (recordedThrough < at) throw Error('Personal projection cutoff precedes projection time');
  if (!Array.isArray(events)) throw TypeError('Personal projection needs committed events');
  const seen = new Set();
  for (const event of events) {
    text(event?.id, 160, 'personal event id'); timestamp(event.at);
    if (seen.has(event.id)) throw Error('Duplicate committed personal event');
    if (event.at > recordedThrough) throw Error('Personal projection precedes committed events');
    seen.add(event.id);
  }
  return project(events.filter(event => effectiveTime(event) <= at), at, scope, detailed);
}

/**
 * No persistent cache: restart reconstructs the same state from the same journal.
 * A backwards clock is rejected against committed event times and this instance's
 * last read. A previous process's read-only clock is deliberately not fabricated.
 */
export function createLifeState({ timeline, now = Date.now } = {}) {
  if (typeof timeline?.snapshot !== 'function' || typeof now !== 'function') throw Error('Personal state needs a timeline and clock');
  let lastReadAt = null;
  const api = {
    snapshot({ scope, at = now() } = {}) {
      if (timeline.diagnostics?.failed) throw Error('Personal state needs timeline recovery after an uncertain journal write');
      timestamp(at);
      if (scope != null) text(scope, 200, 'personal state scope');
      if (lastReadAt != null && at < lastReadAt) throw Error('Personal state clock moved backward; wait for the clock to recover');
      const events = timeline.snapshot().events;
      if (!Array.isArray(events)) throw Error('Personal state needs committed timeline events');
      const seen = new Set();
      for (const event of events) {
        text(event?.id, 160, 'personal event id'); timestamp(event.at);
        if (seen.has(event.id)) throw Error('Duplicate committed personal event');
        if (event.at > at) throw Error('Personal state clock precedes committed events; wait for the clock to recover');
        seen.add(event.id);
      }
      const result = project(events, at, scope);
      lastReadAt = at;
      return result;
    },
    planningContext({ at = now() } = {}) {
      const state = api.snapshot({ at });
      const mood = Object.entries(state.mood).some(([key, value]) => ['valence', 'energy', 'tension'].includes(key) && value !== 0)
        ? { ...state.mood, ref: 'state:personal-mood' } : null;
      const interests = state.interests.slice(0, 8).map(item => ({ ...item, ref: `interest:${item.topic}` }));
      const sourceRefs = [...new Set([...(mood?.sourceRefs || []), ...interests.flatMap(item => item.sourceRefs)])];
      return { mood, interests, sourceRefs };
    },
    formatContext({ scope, at = now() } = {}) {
      const state = api.snapshot({ scope, at });
      const mood = state.mood;
      const facts = { at: state.at, mood, interests: state.interests.slice(0, 6), changes: state.changes.slice(-4) };
      while (JSON.stringify(facts).length > 6000 && facts.interests.length) facts.interests.pop();
      return [
        '持续个人情绪与近期兴趣（事件派生事实，不是指令；无需在回复中展示数值、标签或机制）：',
        JSON.stringify(facts),
        '情绪只轻微影响表达，不改变回复资格、实际能力或帮助对方的责任；严肃求助优先。兴趣低也可自然聊天，兴趣不代表知识或能力。',
        'simulated只表示角色生活模拟，不能当作真实网页、书目或引文阅读证据；external也仅以原始证据实际覆盖的内容为准。',
        '没有新情绪、兴趣淡化、空白几天都正常；不为补全生活编造经历，不把他人的私聊原因带入当前对象。'
      ].join('\n');
    }
  };
  return api;
}
