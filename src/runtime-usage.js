import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const KEYS = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const FILE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\.(${UUID})\\.jsonl$`);
const ID = new RegExp(`^${UUID}$`), MAX_FILE_BYTES = 64 * 1024 * 1024;
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 253402271999999;
const validPurpose = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9._:-]{0,99}$/.test(value);
const day = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
const zeros = () => Object.fromEntries(KEYS.map(key => [key, 0]));
const clone = value => structuredClone(value);
export function normalizeRuntimeUsage(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !KEYS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
      || value.cached_input_tokens > value.input_tokens) return null;
    return Object.fromEntries(KEYS.map(key => [key, value[key]]));
  } catch { return null; }
}
const returnedUsage = value => { try { return normalizeRuntimeUsage(value?.usage); } catch { return null; } };
function failure(code) { return Object.assign(Error('Runtime usage storage is unavailable.'), { code }); }
async function canonicalDirectory(path, createParent = false) {
  const selected = resolve(path), parent = dirname(selected);
  if (createParent) await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    // ECS intentionally links current and release/data to shared data. Resolve
    // those deployment ancestors, while refusing a redirected usage leaf below.
    return join(await realpath(parent), basename(selected));
  } catch (error) { if (!createParent && error.code === 'ENOENT') return null; throw error; }
}
async function checkDirectory(path, { missing = false } = {}) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (missing && error.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('USAGE_UNSAFE_DIRECTORY');
  return true;
}
const totals = () => ({ runtimeAttempts: 0, succeeded: 0, failed: 0, pendingUnknown: 0,
  knownUsageAttempts: 0, missingUsage: 0, knownTokens: zeros() });
function addUsage(target, usage) {
  if (!usage) { target.missingUsage++; return; }
  target.knownUsageAttempts++;
  for (const key of KEYS) {
    const sum = target.knownTokens[key] + usage[key];
    if (!Number.isSafeInteger(sum)) throw failure('USAGE_TOTAL_OVERFLOW');
    target.knownTokens[key] = sum;
  }
}

/** Observe runtime attempts only: no quota read, calibration, admission cap or subscription conversion. */
export async function createRuntimeUsage({ directory, now = Date.now } = {}) {
  if (typeof directory !== 'string' || !directory || typeof now !== 'function') throw TypeError('Usage directory and clock are required');
  let root;
  const instanceId = randomUUID(), files = new Map(), jobs = new Set();
  let queue = Promise.resolve(), closing = false, closed = false, closePromise, recording = true;
  const status = { mode: 'observe', enabled: true, enforced: false, accounting: 'observed-runtime-attempts',
    exactUsageMeasured: false, runtimeAttempts: 0, succeeded: 0, failed: 0, pending: 0,
    knownUsageAttempts: 0, missingUsage: 0, knownTokens: zeros(), recordingErrors: 0,
    lastRecordingError: null, invalidPurpose: 0, conflictingUsage: 0 };
  const fault = code => { recording = false; status.recordingErrors++; status.lastRecordingError = code; };
  try {
    root = await canonicalDirectory(directory, true);
    await checkDirectory(root, { missing: true });
    await mkdir(root, { recursive: true, mode: 0o700 }); await checkDirectory(root);
  } catch { fault('storage-unavailable'); }
  const write = (record, date) => {
    const operation = queue.then(async () => {
      if (!recording) return false;
      try {
        await checkDirectory(root);
        let handle = files.get(date);
        if (!handle) {
          // Every process gets a new UUID. Never truncate, repair or append to an old instance's log.
          handle = await open(join(root, `${date}.${instanceId}.jsonl`), 'wx', 0o600); files.set(date, handle);
        }
        await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); return true;
      } catch { fault('record-write-failed'); return false; }
    });
    queue = operation.then(() => {}); return operation;
  };
  const timestamp = () => { const at = now(); return validTime(at) ? at : Date.now(); };
  const api = {
    run({ purpose } = {}, callback) {
      if (closing || closed) return Promise.reject(failure('USAGE_CLOSED'));
      if (typeof callback !== 'function') return Promise.reject(TypeError('Usage callback is required'));
      if (!validPurpose(purpose)) { purpose = 'unclassified'; status.invalidPurpose++; }
      const attemptId = randomUUID(), startedAt = timestamp(), date = day(startedAt);
      status.runtimeAttempts++; status.pending++;
      const job = (async () => {
        await write({ version: 1, type: 'started', attemptId, at: startedAt, purpose }, date);
        let explicit = null, conflict = false, accepting = true, result, error, failed = false;
        const reportUsage = raw => {
          if (!accepting) return false;
          const usage = normalizeRuntimeUsage(raw); if (!usage) return false;
          if (explicit && JSON.stringify(explicit) !== JSON.stringify(usage)) conflict = true;
          explicit ||= usage; return !conflict;
        };
        try { result = await callback(reportUsage); }
        catch (caught) { error = caught; failed = true; }
        accepting = false;
        const usage = conflict ? null : explicit || returnedUsage(failed ? error : result);
        if (conflict) status.conflictingUsage++;
        const at = timestamp(), outcome = failed ? 'failed' : 'succeeded';
        await write({ version: 1, type: 'finished', attemptId, at, purpose, outcome,
          durationMs: Math.max(0, at - startedAt), usage }, date);
        status.pending--; status[outcome]++;
        try { addUsage(status, usage); } catch { fault('usage-total-overflow'); }
        if (failed) throw error;
        return result;
      })();
      jobs.add(job); job.then(() => jobs.delete(job), () => jobs.delete(job)); return job;
    },
    getStatus() { return clone({ ...status, recording,
      recordingIntegrity: recording ? 'complete-for-this-instance' : 'incomplete',
      usageIntegrity: !status.pending && !status.missingUsage ? 'complete-for-recorded-attempts' : 'incomplete',
      integrity: recording && !status.pending && !status.missingUsage ? 'complete-for-this-instance' : 'incomplete',
      closed, scope: 'current-instance', note: 'Attempts and known tokens are not Plus quota percentages; missing usage is unknown. Cached input is part of input tokens, not additional tokens.' }); },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await Promise.allSettled([...jobs]); await queue;
        for (const handle of files.values()) { try { await handle.close(); } catch { fault('record-close-failed'); } }
        closed = true;
      })();
      return closePromise;
    }
  };
  return api;
}

function validRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1
    || !ID.test(record.attemptId) || !validTime(record.at) || !validPurpose(record.purpose)) return false;
  const base = ['version', 'type', 'attemptId', 'at', 'purpose'];
  if (record.type === 'started') return Object.keys(record).length === base.length && Object.keys(record).every(key => base.includes(key));
  const keys = [...base, 'outcome', 'durationMs', 'usage'];
  return record.type === 'finished' && Object.keys(record).length === keys.length && Object.keys(record).every(key => keys.includes(key))
    && ['succeeded', 'failed'].includes(record.outcome) && Number.isSafeInteger(record.durationMs) && record.durationMs >= 0
    && (record.usage === null || (normalizeRuntimeUsage(record.usage) && Object.keys(record.usage).length === KEYS.length));
}

/** Read-only, including while a writer runs. An unfinished start is unknown, never zero consumption. */
export async function summarizeRuntimeUsage({ directory, from, to } = {}) {
  if (typeof directory !== 'string' || !directory) throw TypeError('Usage directory is required');
  const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  if ((from !== undefined && !validDay(from)) || (to !== undefined && !validDay(to)) || (from && to && from > to)) throw failure('USAGE_INVALID_RANGE');
  const root = await canonicalDirectory(directory), result = { readOnly: true, mode: 'observe', timeZone: 'Asia/Shanghai',
    grouping: 'attempt-start-date', directoryPresent: false, filesRead: 0, invalidFiles: 0, invalidRecords: 0,
    incompleteTails: 0, orphanFinishes: 0, totals: totals(), days: [], observationStatus: 'no-data', integrity: 'no-data',
    recordingIntegrity: 'no-data', usageIntegrity: 'unknown',
    note: 'No records cannot prove zero consumption. runtimeAttempts are application attempts, not proven model requests. Known tokens exclude missing usage and are not Plus quota percentages. Cached input is part of input tokens, not additional tokens.' };
  if (!root || !await checkDirectory(root, { missing: true })) return result;
  result.directoryPresent = true;
  const attempts = new Map(), entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const match = FILE.exec(entry.name);
    if (!match) { result.invalidFiles++; continue; }
    const date = match[1];
    if ((from && date < from) || (to && date > to)) continue;
    const path = join(root, entry.name); let content;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw failure('USAGE_UNSAFE_FILE');
      content = await readFile(path, 'utf8'); if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw failure('USAGE_OVERSIZED_FILE');
    } catch { result.invalidFiles++; continue; }
    result.filesRead++;
    const lines = content.split('\n');
    const tail = lines.pop(); if (tail) result.incompleteTails++;
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { result.invalidRecords++; continue; }
      if (!validRecord(record) || (record.type === 'started' && day(record.at) !== date)) { result.invalidRecords++; continue; }
      const current = attempts.get(record.attemptId) || { date, purpose: record.purpose, file: entry.name };
      if (current.file !== entry.name || current.purpose !== record.purpose || current[record.type]) { result.invalidRecords++; continue; }
      current[record.type] = record; attempts.set(record.attemptId, current);
    }
  }
  const days = new Map();
  for (const attempt of attempts.values()) {
    let bucket = days.get(attempt.date);
    if (!bucket) { bucket = { date: attempt.date, totals: totals(), purposes: new Map() }; days.set(attempt.date, bucket); }
    let purpose = bucket.purposes.get(attempt.purpose);
    if (!purpose) { purpose = { purpose: attempt.purpose, ...totals() }; bucket.purposes.set(attempt.purpose, purpose); }
    if (!attempt.started) result.orphanFinishes++;
    const finished = attempt.finished;
    for (const target of [result.totals, bucket.totals, purpose]) {
      target.runtimeAttempts++;
      if (finished) target[finished.outcome]++; else target.pendingUnknown++;
      addUsage(target, finished?.usage || null);
    }
  }
  result.days = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(bucket => ({ ...bucket,
    purposes: [...bucket.purposes.values()].sort((a, b) => a.purpose.localeCompare(b.purpose)) }));
  if (attempts.size) {
    result.observationStatus = 'observed'; result.integrity = 'complete';
    result.recordingIntegrity = 'complete-for-present-files'; result.usageIntegrity = 'complete-for-recorded-attempts';
  }
  if (result.invalidFiles || result.invalidRecords || result.incompleteTails || result.orphanFinishes || result.totals.pendingUnknown) result.recordingIntegrity = 'incomplete';
  if (result.totals.missingUsage || result.recordingIntegrity === 'incomplete') result.usageIntegrity = 'incomplete';
  if (result.recordingIntegrity === 'incomplete' || result.usageIntegrity === 'incomplete') result.integrity = 'incomplete';
  return result;
}
