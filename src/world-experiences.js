import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeReadingUrl } from './local-boards.js';
import { normalizeLifeEffects } from './life-state.js';

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
  if (typeof scope !== 'string' || scope.length > 160 || !/^qq:private:[1-9]\d*$/.test(scope)) throw Error('A valid private reading scope is required');
  return scope;
}
function normalizePayload(input) {
  exact(input, ['id', 'scope', 'observedAt', 'page', 'summary', 'effects', 'note'], 'reading experience payload');
  const id = text(input.id, 160, 'reading id');
  if (!/^world:[a-zA-Z0-9_.:-]+$/.test(id) || !stamp(input.observedAt)) throw Error('Invalid reading identity or observation time');
  exact(input.page, ['url', 'title', 'contentHash'], 'reading source');
  const url = normalizeReadingUrl(input.page.url).url;
  if (!/^[a-f0-9]{64}$/.test(input.page.contentHash)) throw Error('Invalid reading content hash');
  const page = { url, title: text(input.page.title, 300, 'reading title'), contentHash: input.page.contentHash };
  let note = null;
  if (input.note !== null) {
    exact(input.note, ['summary', 'comment'], 'reading note');
    note = { summary: text(input.note.summary, 4000, 'reading note summary'), comment: text(input.note.comment, 4000, 'reading note comment') };
  }
  return { id, scope: normalizeWorldScope(input.scope), observedAt: input.observedAt, page,
    summary: text(input.summary, 1000, 'reading summary'), effects: normalizeLifeEffects(input.effects), note };
}
export function readingExperience(payload) {
  const value = normalizePayload(payload);
  const source = { kind: 'world-reading', ref: value.id, ...(value.scope ? { scope: value.scope } : {}) };
  // The retained outbox payload is the source record for unusually long URLs.
  const ref = value.page.url.length <= 900 ? value.page.url + '\nsha256:' + value.page.contentHash
    : `world-outbox:${value.id}:sha256:${value.page.contentHash}`;
  return { id: value.id, kind: 'reading', mode: 'external', source, observedAt: value.observedAt,
    summary: value.summary, effects: value.effects, evidence: { source: { ...source, kind: 'observed-web-page' }, ref } };
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
async function atomicWrite(path, directory, body) {
  await regular(path);
  const temporary = path + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(body); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path); await syncDirectory(directory);
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// The caller owns the world's writer lock. This queue serializes durable delivery;
// it never invokes a browser or model and cannot regenerate an uncommitted result.
export async function createWorldExperiences({ directory, appendNote, recordExperience, now = Date.now } = {}) {
  if (typeof appendNote !== 'function' || typeof recordExperience !== 'function' || typeof now !== 'function') throw Error('Reading delivery callbacks and clock are required');
  const root = resolve(directory), file = join(root, 'life-experiences.json'), marker = join(root, '.life-experiences-initialized');
  await mkdir(root, { recursive: true });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('Reading outbox directory must be a real directory');
  let state = { version: 1, entries: [] }, failed = false, closing = false, queue = Promise.resolve();
  const info = await regular(file), initialized = await regular(marker);
  if (!info && initialized) throw Error('Initialized reading outbox is missing; preserve state for recovery');
  if (info) {
    if (info.size > MAX_BYTES) throw Error('Reading outbox exceeds its capacity; original preserved');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    exact(saved, ['version', 'entries', 'sha256'], 'reading outbox');
    if (saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > MAX_ENTRIES
      || hash(JSON.stringify({ version: saved.version, entries: saved.entries })) !== saved.sha256) throw Error('Invalid reading outbox checksum or version; original preserved');
    const ids = new Set();
    for (const entry of saved.entries) {
      exact(entry, ['payload', 'status'], 'reading outbox entry');
      const payload = normalizePayload(entry.payload);
      if (JSON.stringify(payload) !== JSON.stringify(entry.payload) || !['pending', 'delivered'].includes(entry.status) || ids.has(payload.id)) throw Error('Invalid reading outbox entry; original preserved');
      ids.add(payload.id);
    }
    if (saved.entries.filter(entry => entry.status === 'pending').length > MAX_PENDING) throw Error('Invalid pending reading capacity');
    state = { version: 1, entries: saved.entries };
  }
  async function persist(next) {
    const body = JSON.stringify({ ...next, sha256: hash(JSON.stringify(next)) }) + '\n';
    if (Buffer.byteLength(body) > MAX_BYTES) throw Error('Reading outbox capacity reached; existing sources preserved');
    try { await atomicWrite(file, root, body); } catch (error) { failed = true; throw error; }
    state = next;
  }
  if (!info) await persist(state);
  if (!initialized) {
    const handle = await open(marker, 'wx', 0o600);
    try { await handle.writeFile('1\n'); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(root);
  }
  function run(action) {
    if (closing) return Promise.reject(Error('Reading outbox is closed'));
    const task = queue.then(() => {
      if (failed) throw Error('Reading outbox needs recovery after a failed durable write');
      return action();
    });
    queue = task.catch(() => {}); return task;
  }
  return {
    file,
    status() { return { total: state.entries.length, pending: state.entries.filter(entry => entry.status === 'pending').length,
      capacity: MAX_ENTRIES, maxPending: MAX_PENDING, failed }; },
    enqueue(input) {
      return run(async () => {
        const payload = normalizePayload(input);
        const at = now();
        if (!stamp(at) || payload.observedAt > at) throw Error('Reading observation is in the future');
        const old = state.entries.find(entry => entry.payload.id === payload.id);
        if (old) {
          if (JSON.stringify(old.payload) !== JSON.stringify(payload)) throw Error('Reading id already has a different committed result');
          return { id: payload.id, status: old.status };
        }
        if (state.entries.length >= MAX_ENTRIES || state.entries.filter(entry => entry.status === 'pending').length >= MAX_PENDING) throw Error('Reading outbox capacity reached; existing sources preserved');
        const next = clone(state); next.entries.push({ payload, status: 'pending' }); await persist(next);
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
          const payload = clone(entry.payload);
          const at = now();
          if (!stamp(at) || payload.observedAt > at) throw Error('Reading observation clock has not recovered');
          const note = payload.note ? await appendNote({ ...payload.note, url: payload.page.url, title: payload.page.title }, payload.scope) : null;
          // Await the actual sink; an absent or failed sink must never acknowledge.
          const recorded = await recordExperience(readingExperience(payload));
          if (!recorded || recorded.type !== 'experience-recorded' || recorded.experience?.id !== payload.id) throw Error('Reading experience sink did not confirm the committed event');
          const next = clone(state); next.entries[index].status = 'delivered'; await persist(next); delivered++;
          if (note) notes.push({ id: payload.id, added: note.added === true, duplicate: note.duplicate === true, platform: note.record?.platform || null });
        }
        return { delivered, pending: state.entries.filter(entry => entry.status === 'pending').length, notes };
      });
    },
    async close() { closing = true; await queue; }
  };
}
