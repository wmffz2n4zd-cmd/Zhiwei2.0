import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const V201_MEMORY_RESET_MARKER = '.v201-memory-reset.json';

export function validateV201MemoryResetMarker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || value.kind !== 'v201-memory-reset' || !['applying', 'complete'].includes(value.status)
    || typeof value.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.operationId)
    || typeof value.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.planHash)
    || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0
    || !Number.isSafeInteger(value.totalFiles) || value.totalFiles < 1 || value.totalFiles > 10000
    || !Array.isArray(value.completed) || value.completed.some(path => typeof path !== 'string')
    || new Set(value.completed).size !== value.completed.length
    || value.completed.length > value.totalFiles
    || (value.status === 'complete' && (value.completed.length !== value.totalFiles
      || !Number.isSafeInteger(value.completedAt) || value.completedAt < value.startedAt))) {
    throw Error('Invalid v2.01 memory reset marker; inspect the maintenance operation before starting Hub');
  }
  return value;
}

/** Must run before any Hub state writer starts. A completed operation is never replayed. */
export async function assertV201MemoryResetComplete({ dataDir } = {}) {
  const path = join(dataDir, V201_MEMORY_RESET_MARKER);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // The controller claims this lock before publishing its first checkpoint.
    // Do not open a state writer during that small preflight interval.
    for (const name of ['.v201-memory-reset.lock', '.v201-memory-reset-recovery.lock']) {
      try { await lstat(join(dataDir, name)); }
      catch (probe) { if (probe.code === 'ENOENT') continue; throw probe; }
      throw Error('Offline memory reset maintenance has claimed this data root');
    }
    return;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw Error('Invalid memory reset marker file');
  const value = validateV201MemoryResetMarker(JSON.parse(await readFile(path, 'utf8')));
  if (value.status !== 'complete') throw Error('An unfinished v2.01 memory reset blocks Hub startup; resume the same offline operation');
}
