import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createLifeTimeline } from '../src/life-timeline.js';

const origin = Date.parse('2026-10-27T09:07:00+08:00');
const hash = value => createHash('sha256').update(value).digest('hex');
const thought = id => ({ id, text: `想继续读书 ${id}`, source: { kind: 'interest', ref: `reading:${id}` }, strength: 0.5,
  activity: { title: '看书', durationMs: 60000, busy: false, mode: 'simulated' } });

async function fixture(t, storage = { segmentBytes: 1024 }) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'zhiwei-archive-'));
  const options = { directory, now: () => origin, storage };
  let life = await createLifeTimeline(options);
  t.after(async () => {
    await life?.close().catch(() => {});
    if (resolve(directory).startsWith(parent + sep)) await rm(directory, { recursive: true, force: true });
  });
  return { directory, options, get life() { return life; }, async reopen() { await life.close(); life = await createLifeTimeline(options); return life; } };
}
async function populate(f, count = 8) {
  for (let index = 0; index < count; index++) await f.life.addThought(thought(`thought-${index}`));
}
async function indexFor(f) { return JSON.parse(await readFile(f.life.files.archiveIndex, 'utf8')); }
function archivePath(f, segment) {
  return join(f.life.files.archives, `${String(segment.first).padStart(12, '0')}-${String(segment.last).padStart(12, '0')}-${segment.lastHash}.jsonl`);
}

test('archive rotation preserves every transaction, cause, source and stable id through restart', async t => {
  const f = await fixture(t); await populate(f);
  const before = f.life.snapshot(), index = await indexFor(f);
  assert.ok(index.segments.length >= 3);
  assert.ok(f.life.diagnostics.activeJournalBytes <= 1024);
  const journal = [];
  for (const segment of index.segments) {
    const bytes = await readFile(archivePath(f, segment));
    assert.equal(hash(bytes), segment.sha256); assert.equal(bytes.length, segment.bytes);
    journal.push(...bytes.toString('utf8').trim().split('\n').map(JSON.parse));
  }
  journal.push(...(await readFile(f.life.files.journal, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse));
  assert.deepEqual(journal.map(entry => entry.sequence), Array.from({ length: 8 }, (_, n) => n + 1));
  await f.reopen();
  assert.deepEqual(f.life.snapshot(), before);
  await f.life.addThought(thought('thought-0'));
  assert.equal(f.life.snapshot().sequence, before.sequence);
});

test('a damaged snapshot is rebuilt from all archived and active transactions', async t => {
  const f = await fixture(t); await populate(f);
  const before = f.life.snapshot(); await f.life.close();
  await writeFile(f.life.files.snapshot, '{"interrupted":');
  await f.reopen();
  assert.deepEqual(f.life.snapshot().thoughts, before.thoughts);
  assert.deepEqual(f.life.snapshot().events, before.events);
  assert.match(f.life.diagnostics.warnings.join('\n'), /Unreadable snapshot rebuilt/);
});

test('an index committed before its rename is completed safely on recovery', async t => {
  const f = await fixture(t); await populate(f, 2); await f.life.close();
  const index = await indexFor(f), bytes = await readFile(f.life.files.journal), state = f.life.snapshot();
  const previous = index.segments.at(-1);
  const segment = { first: previous.last + 1, last: state.sequence, previousHash: previous.lastHash,
    lastHash: state.lastHash, bytes: bytes.length, sha256: hash(bytes) };
  const body = { version: 1, segments: [...index.segments, segment] };
  await writeFile(f.life.files.archiveIndex, JSON.stringify({ ...body, hash: hash(JSON.stringify(body)) }));
  await f.reopen();
  assert.deepEqual(await readFile(archivePath(f, segment)), bytes);
  assert.equal(await readFile(f.life.files.journal, 'utf8'), '');
  assert.equal(f.life.snapshot().sequence, 2);
  await f.life.addThought(thought('after-recovery'));
  assert.equal(f.life.snapshot().sequence, 3);
});

test('a completed rename without a recreated active file recovers and continues the hash chain', async t => {
  const f = await fixture(t); await populate(f, 2); await f.life.close();
  const index = await indexFor(f), bytes = await readFile(f.life.files.journal), state = f.life.snapshot();
  const previous = index.segments.at(-1);
  const segment = { first: previous.last + 1, last: state.sequence, previousHash: previous.lastHash,
    lastHash: state.lastHash, bytes: bytes.length, sha256: hash(bytes) };
  const body = { version: 1, segments: [...index.segments, segment] };
  await writeFile(f.life.files.archiveIndex, JSON.stringify({ ...body, hash: hash(JSON.stringify(body)) }));
  await rename(f.life.files.journal, archivePath(f, segment));
  await f.reopen(); await f.life.addThought(thought('after-rename'));
  assert.equal(f.life.snapshot().sequence, 3);
  assert.equal(JSON.parse(await readFile(f.life.files.journal, 'utf8')).previousHash, segment.lastHash);
});

test('an incomplete active tail is preserved without changing archives or replaying history', async t => {
  const f = await fixture(t); await populate(f); await f.life.close();
  const index = await indexFor(f), hashes = await Promise.all(index.segments.map(async segment => hash(await readFile(archivePath(f, segment)))));
  const before = f.life.snapshot(), active = await readFile(f.life.files.journal);
  await appendFile(f.life.files.journal, '{"version":1');
  await f.reopen();
  assert.deepEqual(await readFile(f.life.files.journal), active);
  assert.deepEqual(f.life.snapshot().events, before.events);
  assert.deepEqual(await Promise.all(index.segments.map(async segment => hash(await readFile(archivePath(f, segment))))), hashes);
  assert.equal((await readdir(f.directory)).filter(name => name.includes('.incomplete-')).length, 1);
});

test('missing or modified archived data fails closed while retaining the active journal', async t => {
  const f = await fixture(t); await populate(f); await f.life.close();
  const index = await indexFor(f), path = archivePath(f, index.segments[0]), original = await readFile(path), active = await readFile(f.life.files.journal);
  await writeFile(path, original.subarray(0, -1));
  await assert.rejects(createLifeTimeline(f.options), /Invalid life archive size or hash/);
  assert.deepEqual(await readFile(f.life.files.journal), active);
  await rm(path);
  await assert.rejects(createLifeTimeline(f.options), /missing committed history/);
  assert.deepEqual(await readFile(f.life.files.journal), active);
  await writeFile(path, original);
});

test('a missing or corrupt archive index cannot silently discard archived history', async t => {
  const f = await fixture(t); await populate(f); await f.life.close();
  const original = await readFile(f.life.files.archiveIndex);
  await writeFile(f.life.files.archiveIndex, '{broken');
  await assert.rejects(createLifeTimeline(f.options), /Invalid life archive index/);
  await rm(f.life.files.archiveIndex);
  await assert.rejects(createLifeTimeline(f.options), /Unindexed life archive/);
  await writeFile(f.life.files.archiveIndex, original);
});

test('matching file metadata never makes an incomplete archive transaction valid', async t => {
  const f = await fixture(t); await populate(f); await f.life.close();
  const index = await indexFor(f), segment = index.segments[0], path = archivePath(f, segment);
  const bytes = (await readFile(path)).subarray(0, -1);
  await writeFile(path, bytes);
  segment.bytes = bytes.length; segment.sha256 = hash(bytes);
  const body = { version: 1, segments: index.segments };
  await writeFile(f.life.files.archiveIndex, JSON.stringify({ ...body, hash: hash(JSON.stringify(body)) }));
  await assert.rejects(createLifeTimeline(f.options), /Incomplete life archive/);
  assert.deepEqual(await readFile(path), bytes);
  assert.equal((await readdir(f.directory)).filter(name => name.includes('.incomplete-')).length, 0);
});

test('retained state has an explicit ceiling without deleting archived or active history', async t => {
  const f = await fixture(t, { segmentBytes: 1024, maxRetainedEventBytes: 2048 });
  await populate(f, 3);
  const before = f.life.snapshot();
  await assert.rejects(populate(f, 8), /retained state exceeds/);
  assert.ok(f.life.diagnostics.retainedEventBytes <= 2048);
  assert.ok(f.life.snapshot().sequence >= before.sequence);
  const committed = f.life.snapshot(); await f.reopen();
  assert.deepEqual(f.life.snapshot(), committed);
  // A lower recovery budget must refuse to load; it may never truncate history to fit.
  await f.life.close();
  await assert.rejects(createLifeTimeline({ ...f.options, storage: { segmentBytes: 1024, maxRetainedEventBytes: 1024 } }), /retained state exceeds/);
  await f.reopen(); assert.deepEqual(f.life.snapshot(), committed);
});

test('archival preserves privacy filtering and never resumes a previously active activity', async t => {
  const f = await fixture(t);
  await f.life.addThought({ ...thought('private'), source: { kind: 'conversation', ref: 'private-ref', scope: 'qq:private:1' },
    activity: { title: '私人的谜题', durationMs: 60000, busy: true, mode: 'simulated' } });
  await f.life.planThought('private');
  await populate(f, 3); await f.reopen();
  assert.equal(f.life.snapshot().plans[0].status, 'interrupted');
  assert.equal(f.life.snapshot().events.filter(event => event.type === 'activity-started').length, 1);
  assert.doesNotMatch(f.life.formatContext(), /私人的谜题|private-ref/);
  assert.match(f.life.formatContext({ scope: 'qq:private:1' }), /私人的谜题/);
});
