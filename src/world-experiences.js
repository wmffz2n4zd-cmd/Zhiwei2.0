import { isPrivateScope, privateEventScope, privateScopeId } from './private-scope.js';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeReadingUrl } from './local-boards.js';
import { createImmutableArchive } from './immutable-archive.js';
import { normalizeLifeEffects } from './life-state.js';
import { spacePublicationUrl } from './space-sources.js';

const MAX_BYTES = 64 * 1024 * 1024, MAX_ENTRIES = 10000, MAX_PENDING = 256;
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const stamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
function exact(value, keys, label) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw Error(`Invalid ${label}`);
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw Error(`Invalid ${label}`);
  return value.trim();
}
export function normalizeWorldScope(scope) {
  if (scope == null) return null;
  if (typeof scope !== 'string' || scope.length > 160 || !isPrivateScope(scope)) throw Error('A valid private reading scope is required');
  return scope;
}
function normalizePayload(input) {
  exact(input, ['id', 'scope', 'observedAt', 'page', 'summary', 'effects', 'note',
    ...['epochToken','spaceUrl'].filter(key => Object.hasOwn(input || {}, key))], 'reading experience payload');
  if (Object.hasOwn(input, 'epochToken') && (!plain(input.epochToken) || Object.keys(input.epochToken).sort().join(',') !== 'epoch,scope'
    || input.epochToken.scope !== input.scope || !isPrivateScope(input.epochToken.scope)
    || typeof input.epochToken.epoch !== 'string' || !input.epochToken.epoch || input.epochToken.epoch.length > 160)) throw Error('Invalid reading memory epoch token');
  const id = text(input.id, 160, 'reading id');
  if (!/^world:[a-zA-Z0-9_.:-]+$/.test(id) || !stamp(input.observedAt)) throw Error('Invalid reading identity or observation time');
  exact(input.page, ['url', 'title', 'contentHash'], 'reading source');
  const url = normalizeReadingUrl(input.page.url).url;
  if (!/^[a-f0-9]{64}$/.test(input.page.contentHash)) throw Error('Invalid reading content hash');
  const page = { url, title: text(input.page.title, 300, 'reading title'), contentHash: input.page.contentHash };
  if (Object.hasOwn(input, 'spaceUrl') && (input.scope !== null || typeof input.spaceUrl !== 'string' ||
      input.spaceUrl !== spacePublicationUrl(input.spaceUrl) ||
      input.spaceUrl !== spacePublicationUrl(url) && normalizeReadingUrl(input.spaceUrl).url !== url)) throw Error('Invalid space publication source');
  let note = null;
  if (input.note !== null) {
    exact(input.note, ['summary', 'comment'], 'reading note');
    note = { summary: text(input.note.summary, 4000, 'reading note summary'), comment: text(input.note.comment, 4000, 'reading note comment') };
  }
  return { id, scope: normalizeWorldScope(input.scope), observedAt: input.observedAt, page,
    summary: text(input.summary, 1000, 'reading summary'), effects: normalizeLifeEffects(input.effects), note,
    ...(Object.hasOwn(input, 'epochToken') ? { epochToken: clone(input.epochToken) } : {}),
    ...(input.spaceUrl ? { spaceUrl: input.spaceUrl } : {}) };
}
export function readingExperience(payload) {
  const value = normalizePayload(payload);
  const source = { kind: 'world-reading', ref: value.id, ...(value.scope ? { scope: value.scope } : {}) };
  // The retained outbox payload is the source record for unusually long URLs.
  const ref = value.page.url.length <= 900 ? value.page.url + '\nsha256:' + value.page.contentHash
    : `world-outbox:${value.id}:sha256:${value.page.contentHash}`;
  return { id: value.id, kind: 'reading', mode: 'external', source, observedAt: value.observedAt,
    summary: value.summary, effects: value.effects, evidence: value.spaceUrl
      ? { source: { ...source, kind: 'space-publication-page' }, ref: value.spaceUrl + '\nsha256:' + value.page.contentHash }
      : { source: { ...source, kind: 'observed-web-page' }, ref } };
}
async function regular(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Reading outbox files must be regular files');
    return info;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
function assertCommitCurrent(canCommit) {
  if (canCommit == null) return;
  const value = typeof canCommit === 'function' ? canCommit() : false;
  if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
  if (value !== true) {
    throw Object.assign(Error('Reading runtime context changed before commit'), { code: 'STALE_RUNTIME_CONTEXT' });
  }
}
async function atomicWrite(path, directory, body, canCommit) {
  await regular(path);
  const temporary = path + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(body); await handle.sync(); await handle.close(); handle = null;
    assertCommitCurrent(canCommit);
    await rename(temporary, path); await syncDirectory(directory);
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// The caller owns the world's writer lock. This queue serializes durable delivery;
// it never invokes a browser or model and cannot regenerate an uncommitted result.
export async function createWorldExperiences({ directory, appendNote, recordExperience, now = Date.now,
  isMemoryEpochCurrent, retainedEntries = 512, maxPending = MAX_PENDING } = {}) {
  if (typeof appendNote !== 'function' || typeof recordExperience !== 'function' || typeof now !== 'function') throw Error('Reading delivery callbacks and clock are required');
  if (!Number.isSafeInteger(retainedEntries) || retainedEntries < 1 || retainedEntries > MAX_ENTRIES
    || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > MAX_PENDING) throw Error('Invalid reading retention policy');
  const root = resolve(directory), file = join(root, 'life-experiences.json'), marker = join(root, '.life-experiences-initialized');
  await mkdir(root, { recursive: true });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('Reading outbox directory must be a real directory');
  let state, archive, failed = null, closing = false, queue = Promise.resolve();
  function validateEntry(entry) {
    exact(entry, ['payload', 'status'], 'reading outbox entry');
    const payload = normalizePayload(entry.payload);
    if (JSON.stringify(payload) !== JSON.stringify(entry.payload) || !['pending', 'delivered', 'obsolete'].includes(entry.status)) throw Error('Invalid reading outbox entry; original preserved');
    return entry;
  }
  async function load() {
    const info = await regular(file), initialized = await regular(marker);
    if (!info && initialized) throw Error('Initialized reading outbox is missing; preserve state for recovery');
    let next = { version: 2, entries: [], archivedCount: 0 };
    if (info) {
      if (info.size > MAX_BYTES) throw Error('Reading outbox exceeds its capacity; original preserved');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      exact(saved, ['version', 'entries', 'sha256', ...(saved.version === 2 ? ['archivedCount'] : [])], 'reading outbox');
      const { sha256, ...body } = saved;
      if (![1, 2].includes(saved.version) || !Array.isArray(saved.entries) || saved.entries.length > MAX_ENTRIES + MAX_PENDING
        || hash(JSON.stringify(body)) !== sha256 || (saved.version === 2 && (!Number.isSafeInteger(saved.archivedCount) || saved.archivedCount < 0))) throw Error('Invalid reading outbox checksum or version; original preserved');
      const ids = new Set();
      for (const entry of saved.entries) {
        validateEntry(entry);
        if (ids.has(entry.payload.id)) throw Error('Duplicate reading source identity');
        ids.add(entry.payload.id);
      }
      if (saved.entries.filter(entry => entry.status === 'pending').length > MAX_PENDING) throw Error('Invalid pending reading capacity');
      next = { version: 2, entries: saved.entries, archivedCount: saved.archivedCount || 0 };
    }
    archive = await createImmutableArchive(join(root, 'life-experiences-archive'), { minimumCount: next.archivedCount });
    state = next;
    return { fresh: !info, initialized: !!initialized };
  }
  async function persist(next, canCommit) {
    assertCommitCurrent(canCommit);
    const body = JSON.stringify({ ...next, sha256: hash(JSON.stringify(next)) }) + '\n';
    if (Buffer.byteLength(body) > MAX_BYTES) throw Error('Reading outbox active capacity reached; existing sources preserved');
    try { await atomicWrite(file, root, body, canCommit); }
    catch (error) { if (error.code !== 'STALE_RUNTIME_CONTEXT') failed = error.message; throw error; }
    state = next;
  }
  async function maintain() {
    if (state.entries.length <= retainedEntries) return;
    const next = clone(state);
    while (next.entries.length > retainedEntries) {
      const index = next.entries.findIndex(entry => entry.status !== 'pending');
      if (index < 0) break;
      const entry = next.entries[index];
      await archive.put(entry.payload.id, entry);
      next.entries.splice(index, 1); next.archivedCount++;
    }
    if (next.archivedCount !== state.archivedCount) await persist(next);
  }
  const loaded = await load();
  if (loaded.fresh || state.version === 2) await persist(state);
  if (!loaded.initialized) {
    const handle = await open(marker, 'wx', 0o600);
    try { await handle.writeFile('1\n'); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(root);
  }
  await maintain();
  function run(action) {
    if (closing) return Promise.reject(Error('Reading outbox is closed'));
    const task = queue.then(async () => {
      if (failed) {
        try { await load(); failed = null; } catch (error) { throw Error(`Reading outbox needs recovery: ${error.message}`); }
      }
      await maintain();
      return action();
    });
    queue = task.catch(() => {}); return task;
  }
  async function epochCurrent(payload) {
    if (!payload.epochToken) return true;
    if (typeof isMemoryEpochCurrent !== 'function') throw Error('Reading epoch verifier is unavailable; pending source retained');
    return await isMemoryEpochCurrent(clone(payload.epochToken)) === true;
  }
  function pendingStatus() {
    const pending = state.entries.filter(entry => entry.status === 'pending'), at = now();
    const waiting = pending.filter(entry => entry.payload.observedAt > at);
    return { pending: pending.length, waitingClock: waiting.length,
      nextObservationAt: waiting.length ? Math.min(...waiting.map(entry => entry.payload.observedAt)) : null };
  }
  return {
    file,
    status() { return { total: state.entries.length + state.archivedCount, retained: state.entries.length,
      archived: state.archivedCount, ...pendingStatus(),
      capacity: retainedEntries, maxPending, failed: !!failed }; },
    // A synchronous guard stays process-local. Durable historical payloads and
    // their later flush do not inherit a live persona generation constraint.
    enqueue(input, { canCommit } = {}) {
      return run(async () => {
        assertCommitCurrent(canCommit);
        const payload = normalizePayload(input), at = now();
        if (!stamp(at)) throw Error('Invalid reading observation clock');
        const old = state.entries.find(entry => entry.payload.id === payload.id) || await archive.get(payload.id);
        if (old) {
          validateEntry(old);
          if (JSON.stringify(old.payload) !== JSON.stringify(payload)) throw Error('Reading id already has a different committed result');
          return { id: payload.id, status: old.status };
        }
        // New observations cannot claim a future timestamp. An exact durable
        // duplicate above remains valid even while the wall clock has moved back.
        if (payload.observedAt > at) throw Error('Reading observation is in the future');
        if (state.entries.filter(entry => entry.status === 'pending').length >= maxPending) throw Error('Reading outbox pending capacity reached; existing sources preserved');
        const next = clone(state); next.entries.push({ payload, status: 'pending' }); await persist(next, canCommit);
        await maintain();
        return { id: payload.id, status: 'pending' };
      });
    },
    flush() {
      return run(async () => {
        let delivered = 0;
        const notes = [];
        for (let index = 0; index < state.entries.length; index++) {
          const entry = state.entries[index];
          if (entry.status !== 'pending') continue;
          const payload = clone(entry.payload), at = now();
          if (!stamp(at)) throw Error('Invalid reading observation clock');
          if (!await epochCurrent(payload)) {
            const next = clone(state); next.entries[index].status = 'obsolete'; await persist(next); continue;
          }
          // This is an already validated, committed observation, not new future
          // input. Keep its actual time and wait without failing life startup or
          // blocking another ready entry. A later flush can deliver the same ID.
          if (payload.observedAt > at) continue;
          const note = payload.note ? await appendNote({ ...payload.note, url: payload.page.url, title: payload.page.title }, payload.scope, payload.epochToken) : null;
          if (!await epochCurrent(payload)) {
            const next = clone(state); next.entries[index].status = 'obsolete'; await persist(next); continue;
          }
          const recorded = await recordExperience(readingExperience(payload));
          if (!recorded || recorded.type !== 'experience-recorded' || recorded.experience?.id !== payload.id) throw Error('Reading experience sink did not confirm the committed event');
          const next = clone(state); next.entries[index].status = 'delivered'; await persist(next); delivered++;
          if (note) notes.push({ id: payload.id, added: note.added === true, duplicate: note.duplicate === true, platform: note.record?.platform || null });
        }
        await maintain();
        return { delivered, pending: state.entries.filter(entry => entry.status === 'pending').length, notes };
      });
    },
    async close() { closing = true; await queue; }
  };
}
