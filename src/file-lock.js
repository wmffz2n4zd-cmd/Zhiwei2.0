import { spawn } from 'node:child_process';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

// Only this module's completed release/failed acquisition can authorize repair
// of a still-live local PID. Kernel-lock loss alone never adds an entry here.
const relinquishedOwners = new Map();
function rememberRelinquished(path, record) {
  const key = resolve(path), records = relinquishedOwners.get(key) || new Map();
  records.set(record.token, record); relinquishedOwners.set(key, records);
}

async function regular(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Lock and state paths must be regular files, not links');
    return info;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function atomicWriteFile(path, data) {
  await regular(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(data); await file.sync(); await file.close(); file = null;
    await rename(temporary, path);
    const parent = await open(dirname(path), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function identity(pid) {
  try {
    // comm may contain spaces or parentheses. Field 22 is starttime since boot.
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return ['Z', 'X'].includes(fields[0]) ? null : fields[19];
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}

async function owner(path) {
  const info = await regular(path);
  if (!info) return null;
  if (info.size > 4096) throw Error('Unverifiable lock owner; original preserved');
  const raw = await readFile(path, 'utf8');
  // Old memory/learning/recovery locks were empty. Upgrading from that version
  // requires stopping old writers; all new writers arbitrate on the stable guard.
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Invalid owner shape');
    return parsed;
  } catch { throw Error('Unverifiable lock owner; original preserved'); }
}

async function checkLegacyOwner(path, label, allowLegacyPidOnly) {
  const previous = await owner(path);
  const key = resolve(path), relinquished = relinquishedOwners.get(key);
  if (!previous) { relinquishedOwners.delete(key); return; }
  if ((previous.host !== hostname() && !(allowLegacyPidOnly && previous.host == null))
    || !Number.isSafeInteger(previous.pid) || previous.pid < 1
    || (!(allowLegacyPidOnly && previous.token == null) && !/^[a-f0-9-]{36}$/i.test(previous.token || ''))
    || (previous.version === 2 && !/^\d+$/.test(previous.start || ''))) {
    throw Error(`${label}: Unverifiable lock owner or another host; original preserved`);
  }
  const released = relinquished?.get(previous.token);
  // Retain only the token actually on disk, so repeated failed acquisitions do
  // not accumulate abandoned candidates that never reached rename.
  if (released) relinquishedOwners.set(key, new Map([[previous.token, released]]));
  else relinquishedOwners.delete(key);
  if (released && previous.version === released.version && previous.pid === process.pid
    && previous.pid === released.pid && previous.host === released.host && previous.start === released.start) return false;
  const started = await identity(previous.pid);
  return !!(started && (!previous.start || previous.start === started));
}

/** Linux-only. Never unlink .guard: its inode is the mutual-exclusion boundary.
 * The helper owns flock, and exits on stdin EOF even if its parent is SIGKILLed.
 * Owner identity protects migration from older PID locks and PID reuse; the kernel
 * lock, not elapsed wall time or PID metadata, decides ownership for new writers.
 */
export async function acquireFileLock(path, { timeoutMs = 5000, pollMs = 25, label = 'File lock', legacyPaths = [], allowLegacyPidOnly = false } = {}) {
  if (process.platform !== 'linux') throw Error('Durable process locks require Linux flock');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs < 0) throw Error('Invalid lock timeout');
  const guard = `${path}.guard`;
  await regular(guard); await regular(path);
  // Creating once without truncation preserves the inode across all acquisitions.
  const guardFile = await open(guard, 'a', 0o600); await guardFile.close();
  const helper = spawn('flock', ['-x', '-w', String(timeoutMs / 1000), '-F', guard, process.execPath, '-e',
    "process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{}); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); process.stdout.write('locked\\n');"],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let exited = false, output = '', errorText = '';
  const completion = new Promise(resolve => {
    helper.once('error', error => { exited = true; resolve({ error }); });
    helper.once('close', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  helper.stdin.on('error', () => {});
  helper.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-1000); });
  const ready = new Promise(resolve => helper.stdout.on('data', chunk => { output += chunk; if (output.includes('locked\n')) resolve(true); }));
  let held = false, candidateOwner = null;
  try {
    const first = await Promise.race([ready, completion]);
    if (first !== true || exited) throw Error(`${label} is busy (active writer) or flock failed${first?.error ? `: ${first.error.message}` : errorText ? `: ${errorText.trim()}` : ''}`);
    const deadline = performance.now() + timeoutMs;
    for (const legacy of [path, ...legacyPaths]) {
      while (await checkLegacyOwner(legacy, label, allowLegacyPidOnly)) {
        if (performance.now() >= deadline) throw Error(`${label} is busy: active writer`);
        await new Promise(resolve => setTimeout(resolve, Math.max(1, pollMs)));
      }
    }
    const record = candidateOwner = { version: 2, pid: process.pid, host: hostname(), start: await identity(process.pid), token: randomUUID() };
    await atomicWriteFile(path, JSON.stringify(record));
    relinquishedOwners.delete(resolve(path));
    // Recovery fences from old implementations cannot protect a current writer
    // after the main owner has been checked and the new kernel guard is held.
    for (const legacy of legacyPaths) await unlink(legacy).catch(error => { if (error.code !== 'ENOENT') throw error; });
    held = true;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      let removed = false;
      try {
        const current = await owner(path);
        if (current?.token !== record.token) throw Error(`${label} ownership changed; preserving owner record`);
        await unlink(path); removed = true;
      } finally {
        helper.stdin.end(); await completion;
        if (!removed) rememberRelinquished(path, record);
      }
    };
    release.assertHeld = () => { if (released || exited) throw Error(`${label} kernel ownership was lost`); };
    return release;
  } finally {
    if (!held) {
      helper.stdin.end(); await completion;
      if (candidateOwner) rememberRelinquished(path, candidateOwner);
    }
  }
}

export async function withFileLock(path, action, options) {
  const release = await acquireFileLock(path, options);
  try { return await action(); } finally { await release(); }
}

/** Shared/exclusive epoch barrier, independent of the short data-file mutex.
 * path itself is the stable inode; no owner record exists for shared owners.
 */
export async function acquireAdvisoryLock(path, { shared = false, timeoutMs = 5000, label = 'Advisory lock' } = {}) {
  if (process.platform !== 'linux') throw Error('Durable process locks require Linux flock');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || typeof shared !== 'boolean') throw Error('Invalid advisory lock options');
  await regular(path);
  const file = await open(path, 'a', 0o600); await file.close();
  const helper = spawn('flock', [shared ? '-s' : '-x', '-w', String(timeoutMs / 1000), '-F', path, process.execPath, '-e',
    "process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{}); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); process.stdout.write('locked\\n');"],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let exited = false, output = '', errorText = '', acquired = false;
  const completion = new Promise(resolve => {
    helper.once('error', error => { exited = true; resolve({ error }); });
    helper.once('close', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  helper.stdin.on('error', () => {});
  helper.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-1000); });
  const ready = new Promise(resolve => helper.stdout.on('data', chunk => { output += chunk; if (output.includes('locked\n')) resolve(true); }));
  try {
    const first = await Promise.race([ready, completion]);
    if (first !== true || exited) throw Error(`${label} is busy or flock failed${first?.error ? `: ${first.error.message}` : errorText ? `: ${errorText.trim()}` : ''}`);
    acquired = true;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true; helper.stdin.end(); await completion;
    };
    release.assertHeld = () => { if (released || exited) throw Error(`${label} kernel ownership was lost`); };
    return release;
  } finally { if (!acquired) { helper.stdin.end(); await completion; } }
}
