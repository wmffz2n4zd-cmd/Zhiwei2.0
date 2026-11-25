import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFile } from './file-lock.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const maximumRecordBytes = 128 * 1024;

// Caller supplies its single-writer lock. Completed source records leave the hot
// document only after the immutable, checksummed original is durably archived.
// Filenames are a disk-backed identity index: old IDs never become new work.
export async function createImmutableArchive(directory, { minimumCount = 0 } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Archive directory must be a real directory');
  const names = new Set((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)));
  if (names.size < minimumCount) throw Error('Archive is missing committed source records; original state preserved');
  async function readName(name) {
    const path = join(directory, name), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumRecordBytes) throw Error('Unsafe archive record');
    const record = JSON.parse(await readFile(path, 'utf8'));
    const body = { version: record.version, key: record.key, value: record.value };
    if (record.version !== 1 || typeof record.key !== 'string' || `${hash(record.key)}.json` !== name
      || record.sha256 !== hash(JSON.stringify(body)) || Object.keys(record).length !== 4) throw Error('Invalid archive source checksum or identity');
    return record.value;
  }
  return {
    directory,
    get count() { return names.size; },
    async get(key) {
      const name = `${hash(key)}.json`;
      if (!names.has(name)) return null;
      return readName(name);
    },
    async put(key, value) {
      const name = `${hash(key)}.json`;
      if (names.has(name)) {
        const prior = await readName(name);
        if (JSON.stringify(prior) !== JSON.stringify(value)) throw Error('Archived identity already has different source content');
        return false;
      }
      const body = { version: 1, key, value }, content = JSON.stringify({ ...body, sha256: hash(JSON.stringify(body)) }) + '\n';
      if (Buffer.byteLength(content) > maximumRecordBytes) throw Error('Archive source exceeds per-record limit');
      await atomicWriteFile(join(directory, name), content);
      names.add(name); return true;
    },
    async *values() { for (const name of names) yield await readName(name); }
  };
}
