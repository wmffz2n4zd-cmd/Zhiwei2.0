import { createHash } from 'node:crypto';
import { projectLifeState } from './life-state.js';
import { validateLifeObserverSnapshot } from './life-timeline.js';

const VERSION = 't045-1', DAY = 86400000, OFFSET = 8 * 3600000;
const eventTypes = new Set(['thought-added', 'thought-postponed', 'thought-abandoned', 'thought-expired',
  'plan-created', 'plan-cancelled', 'plan-missed', 'plan-start-held', 'plan-start-resolved', 'activity-started',
  'activity-action-claimed', 'activity-completed', 'activity-failed', 'activity-interrupted', 'experience-recorded']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const stamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const round = value => Math.abs(value) < 0.000001 ? 0 : Math.round(value * 1e6) / 1e6;
const beijingDate = at => new Date(at + OFFSET).toISOString().slice(0, 10);
const publicSource = source => plain(source) && typeof source.kind === 'string' && !source.scope;
const observedAt = event => event.type === 'experience-recorded' ? event.experience.observedAt ?? event.at : event.at;
const refOf = event => `event:${event.id}`;
const summarize = value => typeof value === 'string' ? value.slice(0, 1000) : '';

function range(at, date, days) {
  if (!stamp(at)) throw TypeError('Observer cutoff must be epoch milliseconds');
  if (![1, 7].includes(days)) throw RangeError('Observer supports one or seven Beijing days');
  date ??= beijingDate(at);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw TypeError('Observer date must be YYYY-MM-DD');
  const lastDayStart = Date.parse(`${date}T00:00:00+08:00`);
  if (!stamp(lastDayStart) || beijingDate(lastDayStart) !== date || date > beijingDate(at)) throw RangeError('Observer date must be a valid nonfuture Beijing day');
  const startAt = lastDayStart - (days - 1) * DAY, endAt = lastDayStart + DAY;
  if (startAt < 0) throw RangeError('Observer window precedes supported history');
  return { date, days, startAt, endAt, cutoffAt: Math.min(at, endAt - 1) };
}

function committedEvents(snapshot) {
  if (!plain(snapshot) || snapshot.version !== 1 || snapshot.rulesVersion !== 't020-1'
    || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || !Array.isArray(snapshot.events)
    || (snapshot.sequence === 0 ? snapshot.lastHash !== null : !/^[a-f0-9]{64}$/.test(snapshot.lastHash))) throw Error('invalid-snapshot');
  const seen = new Map(), events = [];
  let sequence = 0, index = 0;
  for (const event of snapshot.events) {
    if (!plain(event) || typeof event.id !== 'string' || !stamp(event.at) || !eventTypes.has(event.type)
      || event.rulesVersion !== 't020-1' || !plain(event.source) || typeof event.source.kind !== 'string') throw Error('invalid-event');
    const serialized = JSON.stringify(event);
    if (seen.has(event.id)) {
      if (seen.get(event.id) !== serialized) throw Error('conflicting-event');
      continue;
    }
    const match = /^life:(\d+):(\d+)$/.exec(event.id), seq = Number(match?.[1]), pos = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(seq) || !Number.isSafeInteger(pos)
      || !(seq === sequence && pos === index + 1 || seq === sequence + 1 && pos === 1)) throw Error('incomplete-events');
    sequence = seq; index = pos;
    if (event.type === 'experience-recorded') {
      if (!plain(event.experience) || typeof event.experience.id !== 'string'
        || !['simulated', 'external'].includes(event.experience.mode)) throw Error('invalid-experience');
    } else if (!plain(event.thought) || typeof event.thought.id !== 'string'
      || event.plan && (!plain(event.plan) || typeof event.plan.id !== 'string' || event.plan.thoughtId !== event.thought.id)) throw Error('invalid-record');
    if (event.plan && JSON.stringify(event.source) !== JSON.stringify(event.plan.source)
      || event.thought && JSON.stringify(event.source) !== JSON.stringify(event.thought.source)) throw Error('invalid-source');
    const proof = event.experience?.evidence || event.evidence;
    if (proof?.source?.scope && proof.source.scope !== event.source.scope) throw Error('invalid-evidence-scope');
    seen.set(event.id, serialized); events.push(event);
  }
  if (sequence !== snapshot.sequence) throw Error('incomplete-events');
  validateLifeObserverSnapshot({ ...snapshot, events });
  return events;
}

// References are resolved against public, cutoff-visible records. Unknown/private
// references never become evidence merely because a string appeared in a prompt.
function selectedRefs(thought) {
  if (thought.source?.kind !== 'life-planner') return [];
  try { const parsed = JSON.parse(thought.source.ref); return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : []; }
  catch { return []; }
}
function safeSource(source, allowed) {
  if (!publicSource(source)) return null;
  const result = { kind: summarize(source.kind) };
  if (allowed.has(source.ref)) result.ref = source.ref;
  else if (typeof source.ref === 'string' && /^https?:\/\//i.test(source.ref)) {
    try { const url = new URL(source.ref); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; result.ref = url.href; } catch {}
  }
  return result;
}
function safeEvidence(proof, allowed) {
  const source = safeSource(proof?.source, allowed);
  if (!source || typeof proof.ref !== 'string') return null;
  const ref = safeSource({ kind: 'reference', ref: proof.ref }, allowed).ref;
  // Opaque public result keys are useful for locating local receipts. Do not
  // expose an unresolved timeline/private identifier as a receipt.
  const opaque = /^[a-zA-Z0-9_.:-]{1,160}$/.test(proof.ref)
    && !/^(?:event:|thought:|plan:|qq:|private:)/.test(proof.ref) ? proof.ref : null;
  return ref || opaque ? { source, ref: ref || opaque } : { source, ref: null };
}
function safeBasis(basis, allowed) {
  if (!plain(basis) || basis.version !== VERSION || !stamp(basis.at)
    || !Array.isArray(basis.offeredRefs) || !Array.isArray(basis.selectedRefs)) return null;
  const refs = values => Array.isArray(values) ? values.filter(ref => allowed.has(ref)) : [];
  const interests = Array.isArray(basis.interests) ? basis.interests.filter(item => plain(item) && allowed.has(item.ref)
    && Number.isFinite(item.strength)).map(item => ({ ref: item.ref, strength: item.strength, sourceRefs: refs(item.sourceRefs) })) : [];
  const mood = plain(basis.mood) && basis.mood.ref === 'state:personal-mood'
    && ['valence', 'energy', 'tension'].every(key => Number.isFinite(basis.mood[key]))
    ? { ref: basis.mood.ref, valence: basis.mood.valence, energy: basis.mood.energy,
      tension: basis.mood.tension, sourceRefs: refs(basis.mood.sourceRefs) } : null;
  return { version: VERSION, at: basis.at, stateVersion: summarize(basis.stateVersion),
    offeredRefs: refs(basis.offeredRefs), selectedRefs: refs(basis.selectedRefs), interests, mood };
}

function relationIndex(events, allowed) {
  const thoughts = new Map(), plans = new Map();
  for (const event of events) {
    if (event.thought) thoughts.set(event.thought.id, event.thought);
    if (event.plan) {
      const previous = plans.get(event.plan.id);
      plans.set(event.plan.id, { ...event.plan, eventRefs: [...(previous?.eventRefs || []), refOf(event)] });
    }
  }
  return [...thoughts.values()].map(thought => {
    const basis = safeBasis(thought.basis, allowed);
    return { thoughtId: thought.id, at: thought.createdAt, title: summarize(thought.activity?.title || thought.text), status: summarize(thought.status),
      selectedRefs: selectedRefs(thought).filter(ref => allowed.has(ref)), offeredRefs: basis?.offeredRefs || [],
      basisStatus: basis ? 'captured' : 'legacy-unknown', basis,
      plans: [...plans.values()].filter(plan => plan.thoughtId === thought.id).map(plan => ({ id: plan.id,
        title: summarize(plan.title), status: summarize(plan.status), startedAt: plan.actualStartedAt ?? null,
        endedAt: plan.endedAt ?? null, eventRefs: plan.eventRefs })) };
  });
}
function related(relations, ref, topic, after = 0) {
  return relations.flatMap(item => {
    if (item.at < after) return [];
    let kind, usage;
    const interestRef = topic ? `interest:${topic}` : null;
    const captured = item.basis?.interests.find(interest => interest.ref === interestRef);
    if (ref && item.selectedRefs.includes(ref)) { kind = 'exact-event'; usage = 'selected'; }
    else if (ref && captured?.sourceRefs.includes(ref) && item.selectedRefs.includes(interestRef)) {
      kind = 'captured-interest-source'; usage = 'selected';
    }
    else if (ref && item.offeredRefs.includes(ref)) { kind = 'exact-event'; usage = 'offered'; }
    else if (topic) {
      if (item.selectedRefs.includes(interestRef)) usage = 'selected';
      else if (item.offeredRefs.includes(interestRef)) usage = 'offered';
      if (usage) kind = ref && captured?.sourceRefs.includes(ref) ? 'captured-interest-source' : 'topic-only';
    }
    return kind ? [{ ...item, link: { kind, usage, sourceRef: ref || `interest:${topic}`,
      confirmedSource: kind !== 'topic-only' } }] : [];
  });
}

/** Reads one already validated in-memory timeline snapshot. No disk, clock state,
 * recovery, scheduling or model access. Reports deliberately expose public life only. */
export function buildLifeObserverReport(options = {}) {
  if (!plain(options) || Object.hasOwn(options, 'scope')) throw TypeError('Observer supports public life only');
  const { snapshot, diagnostics, enabled = true, at = Date.now(), date, days = 7 } = options;
  if (typeof enabled !== 'boolean') throw TypeError('Observer enabled must be boolean');
  const window = range(at, date, days);
  const report = { version: VERSION, scope: 'public', generatedAt: at, timezone: 'Asia/Shanghai', window,
    snapshot: null, completeness: { status: 'unknown', reason: 'source-unavailable', warnings: [] },
    counts: { newThoughts: null, completedActivities: null }, interests: [], events: [],
    notes: ['统计念头与完成活动按入账时间；兴趣按实际观察时间重建，仅使用截止时刻前已入账记录。',
      '兴趣强度单位为0—1；净变化 = 已发生事件实际增量 + 自然衰减。计划中的预期影响不计入。',
      '来源出现在规划输入、被念头引用和实际执行分别展示；关联不是已证实的单一因果。',
      '仅含公共个人生活，不包含任何对象的私聊记录；空白和没有变化都是正常结果。'] };
  if (!enabled) { report.completeness = { status: 'disabled', reason: 'life-disabled', warnings: [] }; return report; }
  if (diagnostics?.failed) { report.completeness.reason = 'timeline-recovery-required'; return report; }
  try {
    const all = committedEvents(snapshot);
    if (all.some(event => event.at > at)) { report.completeness.reason = 'clock-before-committed-events'; return report; }
    const events = all.filter(event => event.at <= window.cutoffAt && publicSource(event.source));
    const allowed = new Set(['profile', 'state:personal-mood']);
    for (const event of events) {
      allowed.add(refOf(event));
      if (event.thought) allowed.add(`thought:${event.thought.id}`);
      if (event.plan) allowed.add(`plan:${event.plan.id}`);
    }
    const end = projectLifeState(events, { at: window.cutoffAt, detailed: true });
    const start = projectLifeState(events.filter(event => observedAt(event) < window.startAt),
      { at: window.startAt, recordedThrough: window.cutoffAt, detailed: true });
    for (const interest of end.interests) allowed.add(`interest:${interest.topic}`);
    const relations = relationIndex(events, allowed);
    const windowEvents = events.filter(event => event.at >= window.startAt || observedAt(event) >= window.startAt);
    const newThoughts = new Set(), completed = new Set();
    for (const event of windowEvents) {
      if (event.at >= window.startAt && event.type === 'thought-added') newThoughts.add(event.thought.id);
      if (event.at >= window.startAt && event.type === 'activity-completed') {
        if (!event.plan || event.plan.status !== 'completed') throw Error('invalid-completion');
        completed.add(event.plan.id);
      }
    }
    const initial = new Map(start.interests.map(item => [item.topic, item]));
    report.interests = end.interests.map(item => {
      const changes = end.changes.filter(change => change.topic === item.topic && change.at >= window.startAt)
        .map(change => ({ ...change, relations: related(relations, change.ref, item.topic, change.recordedAt) }));
      const startStrength = initial.get(item.topic)?.strength || 0, netDelta = round(item.strength - startStrength);
      const eventDelta = round(changes.reduce((sum, change) => sum + change.actualDelta, 0));
      return { topic: item.topic, label: item.label, startStrength, endStrength: item.strength, netDelta,
        eventDelta, decayDelta: round(netDelta - eventDelta), direction: netDelta > 0 ? 'up' : netDelta < 0 ? 'down' : 'unchanged',
        changes, relations: related(relations, '', item.topic) };
    });
    report.events = windowEvents.map(event => ({ ref: refOf(event), id: event.id, type: event.type, at: event.at,
      observedAt: observedAt(event), mode: event.experience?.mode || event.plan?.mode || event.thought?.activity?.mode || null,
      title: summarize(event.plan?.title || event.thought?.activity?.title || event.experience?.kind),
      summary: summarize(event.experience?.summary || event.summary),
      result: event.experience ? 'recorded' : summarize(event.plan?.status || event.thought?.status),
      source: safeSource(event.source, allowed), evidence: safeEvidence(event.experience?.evidence || event.evidence, allowed),
      thoughtId: event.thought?.id || null, planId: event.plan?.id || null,
      basis: safeBasis(event.thought?.basis, allowed), relations: related(relations, refOf(event)) })).sort((a, b) => b.at - a.at);
    report.snapshot = { revision: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
      rulesVersion: snapshot.rulesVersion, eventCount: events.length,
      lastEventAt: events.reduce((latest, event) => latest == null ? event.at : Math.max(latest, event.at), null) };
    report.counts = { newThoughts: newThoughts.size, completedActivities: completed.size };
    report.completeness = { status: 'complete', reason: windowEvents.length ? 'validated-committed-history' : 'no-records-in-window',
      warnings: Array.isArray(diagnostics?.warnings) && diagnostics.warnings.length ? ['运行时恢复曾产生诊断；本报告仅使用已校验的已提交历史。'] : [] };
  } catch {
    report.snapshot = null; report.interests = []; report.events = [];
    report.counts = { newThoughts: null, completedActivities: null };
    report.completeness = { status: 'unknown', reason: 'invalid-or-incomplete-history', warnings: [] };
  }
  return report;
}
