import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const writes = new Map();
async function replace(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

// Keep one validated previous configuration, never a history of secret copies.
export function writeJsonAtomic(path, value, { previous = false } = {}) {
  const text = JSON.stringify(value, null, 2) + '\n';
  const task = (writes.get(path) || Promise.resolve()).then(async () => {
    if (previous) {
      let old;
      try { old = await readFile(path, 'utf8'); JSON.parse(old); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; old = null; }
      if (old != null) await replace(path + '.previous', old);
    }
    await replace(path, text);
  });
  const tail = task.catch(() => {}); writes.set(path, tail);
  void tail.finally(() => { if (writes.get(path) === tail) writes.delete(path); });
  return task;
}

export function readJsonRecoverableSync(path, { missing = {}, warn = () => {} } = {}) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (original) {
    if (original.code !== 'ENOENT' && !(original instanceof SyntaxError)) throw original;
    try {
      const value = JSON.parse(readFileSync(path + '.previous', 'utf8'));
      warn('Using the last validated configuration; the current file needs repair.');
      return value;
    } catch (backup) {
      if (original.code === 'ENOENT' && backup.code === 'ENOENT') return missing;
      throw new Error('Configuration is unreadable and has no valid previous version', { cause: original });
    }
  }
}
