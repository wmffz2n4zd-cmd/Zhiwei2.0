import { isPrivateScope, privateEventScope, privateScopeId } from './private-scope.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, lstat, readdir } from 'node:fs/promises';
import { acquireFileLock, atomicWriteFile } from './file-lock.js';
import { resolve, join } from 'node:path';

export const LEARNING_STORE_VERSION = 1;
export const MAX_LEARNING_BYTES = 65536;
export const learningScope = scope => typeof scope === 'string' && isPrivateScope(scope) && scope.length <= 160;
export const learningFileName = scope => {
  if (!learningScope(scope)) throw Error('Invalid learning scope');
  return createHash('sha256').update(scope).digest('hex') + '.json';
};
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
const cursorValid = cursor => cursor && Object.keys(cursor).every(key => ['epoch', 'sequence'].includes(key))
  && text(cursor.epoch, 160) && cursor.epoch.length > 0 && integer(cursor.sequence);
const refsValid = refs => Array.isArray(refs) && refs.length > 0 && refs.length <= 4
  && refs.every(ref => ref && Object.keys(ref).every(key => ['id', 'fingerprint'].includes(key))
    && text(ref.id, 120) && ref.id.length > 0 && /^[a-f0-9]{64}$/.test(ref.fingerprint))
  && new Set(refs.map(ref => ref.id)).size === refs.length;

export function validateLearningState(state, scope) {
  if (!learningScope(scope) || !state || state.schemaVersion !== LEARNING_STORE_VERSION || state.scope !== scope
    || Object.keys(state).some(key => !['schemaVersion', 'scope', 'epoch', 'sourceRevision', 'cursor', 'usageCursor', 'version',
      'initializedAt', 'updatedAt', 'lastAttemptAt', 'lastSuccessAt', 'nextAttemptAt', 'failureCount', 'lastError', 'lastCoverage',
      'interactionHabits', 'selfExpression'].includes(key))
    || !text(state.epoch, 160) || !state.epoch || !integer(state.sourceRevision) || !integer(state.version)
    || !cursorValid(state.cursor) || state.cursor.epoch !== state.epoch || !cursorValid(state.usageCursor)
    || state.usageCursor.epoch !== state.epoch || !iso(state.initializedAt) || !iso(state.updatedAt)
    || ![state.lastAttemptAt, state.lastSuccessAt, state.nextAttemptAt].every(value => value === null || iso(value))
    || !integer(state.failureCount) || state.failureCount > 16
    || !(state.lastError === null || /^[a-z-]{1,40}$/.test(state.lastError))) throw Error('Invalid private learning state');
  for (const kind of ['interactionHabits', 'selfExpression']) {
    if (!Array.isArray(state[kind]) || state[kind].length > 20) throw Error('Invalid learning namespace');
    for (const entry of state[kind]) {
      if (!entry || !/^[a-f0-9]{24}$/.test(entry.id) || entry.kind !== kind || entry.scope !== scope
        || Object.keys(entry).some(key => !['id', 'kind', 'scope', 'summary', 'context', 'applicability', 'tags', 'form', 'sourceRefs',
          'firstSeenAt', 'lastSeenAt', 'supportCount', 'counterexampleCount', 'confidence', 'status', 'revision', 'observedUses',
          'observedSamples', 'selectedCount', 'lastSelectedAt', 'lastSelectionKey'].includes(key))
        || !text(entry.summary, 160) || !entry.summary.trim() || !text(entry.context, 100) || !text(entry.form, 48)
        || !['general', 'topic'].includes(entry.applicability) || kind === 'selfExpression' && entry.applicability !== 'topic'
        || !Array.isArray(entry.tags) || entry.tags.length > 6 || entry.tags.some(tag => !text(tag, 24) || !tag.trim())
        || !refsValid(entry.sourceRefs) || !iso(entry.firstSeenAt) || !iso(entry.lastSeenAt)
        || !integer(entry.supportCount) || entry.supportCount < 1 || !integer(entry.counterexampleCount)
        || !['tentative', 'supported'].includes(entry.confidence) || entry.status !== 'active'
        || !integer(entry.revision) || !integer(entry.observedUses) || !integer(entry.observedSamples)
        || entry.observedUses > entry.observedSamples || !integer(entry.selectedCount)
        || !(entry.lastSelectedAt === null || iso(entry.lastSelectedAt))
        || !(entry.lastSelectionKey === null || /^[a-f0-9]{64}$/.test(entry.lastSelectionKey))) throw Error('Invalid learning entry');
    }
    if (new Set(state[kind].map(entry => entry.id)).size !== state[kind].length) throw Error('Duplicate learning entry');
  }
  const coverage = state.lastCoverage;
  if (coverage !== null && (!coverage || !cursorValid(coverage.coveredFrom) || !cursorValid(coverage.coveredTo)
    || Object.keys(coverage).some(key => !['coveredFrom', 'coveredTo', 'eligibleCount', 'sampledIds', 'skippedCount', 'gapCount'].includes(key))
    || ![coverage.eligibleCount, coverage.skippedCount, coverage.gapCount].every(integer)
    || !Array.isArray(coverage.sampledIds) || coverage.sampledIds.length > 60
    || coverage.sampledIds.some(id => !text(id, 120)))) throw Error('Invalid learning coverage');
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_LEARNING_BYTES) throw Error('Learning state exceeds size limit');
  return state;
}

export function emptyLearningState({ scope, epoch, revision, cursor }, time) {
  return { schemaVersion: 1, scope, epoch, sourceRevision: revision, cursor: structuredClone(cursor), usageCursor: structuredClone(cursor), version: 0,
    initializedAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString(), lastAttemptAt: null,
    lastSuccessAt: null, nextAttemptAt: null, failureCount: 0, lastError: null, lastCoverage: null,
    interactionHabits: [], selfExpression: [] };
}

// Only derived, bounded summaries belong here. Full messages remain in unified memory.
export function createPrivateLearningStore({ directory, now = Date.now, lockAttempts = 100, lockDelayMs = 10 }) {
  if (typeof directory !== 'string' || !directory) throw Error('Learning directory required');
  const root = resolve(directory), queues = new Map(), warnings = new Map();
  async function ensureDirectory() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe learning directory');
  }
  async function readRaw(scope) {
    const path = join(root, learningFileName(scope));
    try {
      const directoryStat = await lstat(root);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw Error('Unsafe learning directory');
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEARNING_BYTES) throw Error('Unsafe learning file');
      return validateLearningState(JSON.parse(await readFile(path, 'utf8')), scope);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const api = {
    async read(scope) {
      learningFileName(scope);
      await queues.get(scope);
      return structuredClone(await readRaw(scope));
    },
    mutate(scope, expectedVersion, transform) {
      learningFileName(scope);
      const task = (queues.get(scope) || Promise.resolve()).then(async () => {
        await ensureDirectory();
        const path = join(root, learningFileName(scope)), lockPath = path + '.lock';
        const releaseLock = await acquireFileLock(lockPath, { timeoutMs: lockAttempts * lockDelayMs, label: 'Private learning store' });
        try {
          const current = await readRaw(scope);
          if ((current?.version ?? null) !== expectedVersion) return { ok: false, reason: 'stale-store' };
          const next = transform(structuredClone(current));
          if (!next || typeof next.then === 'function') throw Error('Learning transform must be synchronous');
          next.version = (current?.version ?? 0) + 1;
          next.updatedAt = new Date(now()).toISOString();
          validateLearningState(next, scope);
          releaseLock.assertHeld();
          await atomicWriteFile(path, JSON.stringify(next));
          warnings.delete(learningFileName(scope));
          return { ok: true, state: structuredClone(next) };
        } finally {
          await releaseLock();
        }
      });
      const settled = task.catch(() => {});
      queues.set(scope, settled);
      settled.finally(() => { if (queues.get(scope) === settled) queues.delete(scope); });
      return task;
    },
    async listScopes() {
      let names;
      try {
        const stat = await lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe learning directory');
        names = await readdir(root);
      } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const present = new Set(names);
      for (const key of warnings.keys()) if (!present.has(key)) warnings.delete(key);
      const result = [];
      for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        try {
          const path = join(root, name), stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEARNING_BYTES) throw Error('Unsafe learning file');
          const raw = JSON.parse(await readFile(path, 'utf8'));
          if (learningFileName(raw.scope) !== name) throw Error('Learning filename does not match scope');
          validateLearningState(raw, raw.scope); result.push(raw.scope); warnings.delete(name);
        } catch (error) {
          if (error.code !== 'ENOENT') warnings.set(name, { scopeHash: name.slice(0, -5), file: name, reason: error instanceof SyntaxError ? 'invalid-json' : error.message === 'Unsafe learning file' ? 'unsafe-file' : 'invalid-state' });
        }
      }
      return result;
    },
    diagnostics() { return { degraded: warnings.size > 0, warnings: structuredClone([...warnings.values()]) }; },
    pending() { return queues.size; },
    async flush() { await Promise.all([...queues.values()]); }
  };
  return api;
}
