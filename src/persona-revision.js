import { isPrivateScope, privateEventScope, privateScopeId } from './private-scope.js';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { readFile, lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireFileLock, atomicWriteFile } from './file-lock.js';

const MAX_BYTES = 4 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const scopeValid = value => isPrivateScope(value);
const idsValid = value => Array.isArray(value) && value.length <= 100000 && new Set(value).size === value.length
  && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200);
const simulated = event => event?.experience?.mode === 'simulated' || event?.plan?.mode === 'simulated';

export function validatePersonaRevisionState(state) {
  if (!plain(state) || state.version !== 1 || typeof state.revision !== 'string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(state.revision)
    || !Number.isSafeInteger(state.at) || state.at < 0 || !plain(state.scopes)
    || Object.keys(state).some(key => !['version', 'revision', 'at', 'scopes', 'legacyEventIds', 'legacyPlanIds', 'legacyThoughtIds'].includes(key))
    || !idsValid(state.legacyEventIds) || !idsValid(state.legacyPlanIds) || !idsValid(state.legacyThoughtIds)) throw Error('Invalid persona revision state');
  for (const [scope, value] of Object.entries(state.scopes)) {
    if (!scopeValid(scope) || !plain(value) || Object.keys(value).some(key => !['epoch', 'sequence', 'memoryIds'].includes(key))
      || typeof value.epoch !== 'string' || !value.epoch || value.epoch.length > 160
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !idsValid(value.memoryIds)) throw Error('Invalid persona learning cutoff');
  }
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES) throw Error('Persona revision state exceeds bound');
  return state;
}

/** Pure cutover inventory. No memory, receipt, journal or profile is rewritten. */
export function buildPersonaRevisionState({ revision, at, memoryEntries = [], learningSnapshots = [], timelineSnapshot = {} } = {}) {
  if (!Array.isArray(memoryEntries) || !Array.isArray(learningSnapshots)) throw Error('Persona cutover needs complete source inventories');
  const scopes = {};
  for (const item of learningSnapshots) {
    if (!scopeValid(item?.scope) || !item.epoch || item.cursor?.epoch !== item.epoch || scopes[item.scope]) throw Error('Invalid cutover snapshot');
    scopes[item.scope] = { epoch: item.epoch, sequence: item.cursor.sequence,
      memoryIds: [...new Set(memoryEntries.filter(entry => entry.scope === item.scope && typeof entry.id === 'string').map(entry => entry.id))] };
  }
  // Every existing private memory scope needs an explicit sequence/epoch fence.
  if (memoryEntries.some(entry => scopeValid(entry.scope) && !scopes[entry.scope])) throw Error('Missing private cutover snapshot');
  const events = timelineSnapshot.events || [], plans = timelineSnapshot.plans || [], thoughts = timelineSnapshot.thoughts || [];
  if (![events, plans, thoughts].every(Array.isArray)) throw Error('Invalid timeline cutover inventory');
  return validatePersonaRevisionState({ version: 1, revision, at, scopes,
    legacyEventIds: events.filter(simulated).map(event => event.id),
    legacyPlanIds: plans.filter(plan => plan.mode === 'simulated').map(plan => plan.id),
    legacyThoughtIds: thoughts.filter(thought => thought.activity?.mode === 'simulated').map(thought => thought.id) });
}

/** Idempotent cutover write: an existing different policy is never overwritten. */
export async function writePersonaRevision({ path, state } = {}) {
  validatePersonaRevisionState(state);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await acquireFileLock(path + '.lock', { label: 'Persona revision cutover' });
  try {
    let existing;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw Error('Unsafe persona revision file');
      existing = validatePersonaRevisionState(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(state)) throw Error('Persona cutover already exists with different content');
      return { changed: false, revision: existing.revision };
    }
    release.assertHeld();
    await atomicWriteFile(path, JSON.stringify(state));
    return { changed: true, revision: state.revision };
  } finally { await release(); }
}

export function createPersonaRevisionPolicy(state, { path = null, sourceHash = null } = {}) {
  const saved = structuredClone(validatePersonaRevisionState(state));
  const memoryIds = new Map(Object.entries(saved.scopes).map(([scope, value]) => [scope, new Set(value.memoryIds)]));
  const eventIds = new Set(saved.legacyEventIds), planIds = new Set(saved.legacyPlanIds), thoughtIds = new Set(saved.legacyThoughtIds);
  const identity = digest(JSON.stringify(saved));
  const current = () => {
    if (!path) return true;
    try {
      const info = lstatSync(path);
      return info.isFile() && !info.isSymbolicLink() && info.size <= MAX_BYTES
        && digest(readFileSync(path)) === sourceHash;
    } catch { return false; }
  };
  const policy = {
    revision: saved.revision,
    capture() { if (!current()) throw Error('Persona revision changed; restart required'); return Object.freeze({ revision: saved.revision, identity }); },
    isCurrent(token) { return token?.revision === saved.revision && token.identity === identity && current(); },
    assertCurrent(token) { if (!policy.isCurrent(token)) throw Error('Persona revision changed'); },
    isLegacyMemory(entry) { return memoryIds.get(entry?.scope)?.has(entry.id) === true; },
    learningEntryEligible(entry, { scope, epoch } = {}) {
      if (entry.kind !== 'selfExpression') return true;
      const cutoff = saved.scopes[scope];
      return !cutoff || cutoff.epoch !== epoch || entry.sourceRefs.every(ref => !memoryIds.get(scope).has(ref.id));
    },
    learningSnapshot(snapshot) {
      const cutoff = saved.scopes[snapshot.scope];
      if (!cutoff || cutoff.epoch !== snapshot.epoch) return snapshot;
      return { ...snapshot, sources: snapshot.sources.map(source => source.sequence <= cutoff.sequence
        ? { ...source, selfExpressionEligible: false, replyText: '' } : source) };
    },
    eventEligible(event) { return !eventIds.has(event?.id) && !planIds.has(event?.plan?.id); },
    thoughtEligible(thought) { return !thoughtIds.has(thought?.id); },
    migrationPlan(snapshot = {}) {
      return { revision: saved.revision,
        abandonThoughtIds: (snapshot.thoughts || []).filter(thought => thoughtIds.has(thought.id)
          && ['pending', 'planned'].includes(thought.status)).map(thought => thought.id),
        activeLegacyPlanIds: (snapshot.plans || []).filter(plan => planIds.has(plan.id) && plan.status === 'active').map(plan => plan.id) };
    },
    snapshot() { return structuredClone(saved); }
  };
  return Object.freeze(policy);
}

export async function loadPersonaRevision({ path, expectedRevision } = {}) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw Error('Unsafe persona revision file');
  const body = await readFile(path), state = validatePersonaRevisionState(JSON.parse(body.toString('utf8')));
  if (expectedRevision != null && state.revision !== expectedRevision) throw Error('Persona revision does not match configuration');
  return createPersonaRevisionPolicy(state, { path, sourceHash: digest(body) });
}
