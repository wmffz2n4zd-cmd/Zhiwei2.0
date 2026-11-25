import { rm, readdir, lstat, realpath, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// The caller owns these exact paths. A completed model turn can precede CLI
// exit, so keep files until both the reader and all writer processes are done.
export function createTransientFiles() {
  const paths = new Map(); let references = 1, started = false, finished = false, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  function release() {
    if (--references !== 0 || started) return;
    started = true;
    Promise.allSettled([...paths].map(([path, directory]) => rm(path, { force: true, recursive: directory })))
      .then(results => resolveDone({ ok: results.every(result => result.status === 'fulfilled') }));
  }
  return {
    add(path, { directory = false } = {}) { paths.set(path, directory); return path; },
    retain() { if (started) throw Error('Temporary output already closed'); references++; let released = false;
      return () => { if (!released) { released = true; release(); } }; },
    finish() { if (!finished) { finished = true; release(); } return done; }
  };
}

// Recover crash leftovers only within an explicitly supplied temporary root.
// Never follow links or touch lock files. Current processes finish within the
// 24-hour retention period; per-turn cleanup handles their ordinary outputs.
export async function pruneTransientFiles(directory, { before = Date.now() - 86400000 } = {}) {
  const stats = { files: 0, bytes: 0 };
  let root;
  try { root = await realpath(directory); } catch (error) { if (error.code === 'ENOENT') return stats; throw error; }
  if (root === resolve(root, '..')) throw Error('Temporary root cannot be a filesystem root');
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name); const info = await lstat(child);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(child);
        if (info.mtimeMs < before) await rmdir(child).catch(error => { if (!['ENOTEMPTY','EEXIST','ENOENT'].includes(error.code)) throw error; });
      }
      else if (info.isFile() && info.mtimeMs < before && !/\.(?:lock|guard)$/.test(entry.name) && entry.name !== '.gitkeep') {
        await unlink(child); stats.files++; stats.bytes += info.size;
      }
    }
  }
  await visit(root); return stats;
}
