import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoReader, canonicalVideoUrl } from '../src/video-reader.js';

const url = 'https://www.bilibili.com/video/BV1K54y1r7dU';
const scope = { kind: 'private', contactId: 'person-a', memoryEpoch: 'epoch-1' };
const hash = content => createHash('sha256').update(content).digest('hex');
const at = 1795046622000;
function workerData(text = '字幕来自实际取材') {
  return { version: 1, status: 'partial', source: canonicalVideoUrl(url), title: '归来', duration: 136,
    metadataVersion: 'f'.repeat(64), subtitleTrack: { kind: 'human', language: 'zh-CN' },
    subtitles: [{ start: 20, end: 24, text }], frames: [], sourceAccess: 'dedicated_browser_public', errors: ['frames_unavailable'] };
}
async function fixture(t, worker, platforms = ['bilibili']) {
  const directory = await mkdtemp(join(tmpdir(), 'space-video-'));
  const reader = createVideoReader({ directory, worker, platforms, now: () => at });
  t.after(async () => { await reader.close(); await rm(directory, { recursive: true, force: true }); });
  return { reader, directory };
}

test('same B站 link has independent public evidence, without copying private cached results or issuing leases', async t => {
  const calls = [];
  const { reader, directory } = await fixture(t, async request => {
    calls.push(request.mode);
    if (request.mode === 'probe') return { ...workerData(), status: 'available', subtitles: [] };
    return workerData(calls.length === 1 ? '仅原私聊可见' : '空间重新取得的字幕');
  });
  const first = await reader.read({ url, scope });
  assert.equal(first.subtitles[0].text, '仅原私聊可见');
  await first.release(); const dirs = await readdir(directory);
  const receipt = await reader.readForSpace(url);
  const excerpt = '[20–24秒] 空间重新取得的字幕';
  assert.deepEqual(receipt, { url, title: '归来', excerpt, contentHash: hash(excerpt), fetchedAt: at });
  assert.deepEqual(await readdir(directory), dirs);
  const cached = await reader.read({ url, scope }); await cached.release();
  assert.equal(cached.subtitles[0].text, '仅原私聊可见');
  assert.deepEqual(calls, ['read', 'read', 'probe']);
  assert.equal(reader.getStatus().cached, 1);
  assert.equal(reader.getStatus().leases, 0);
});

test('the source must explicitly attest public access and supply a real timed subtitle track', async t => {
  let value;
  const { reader, directory } = await fixture(t, () => value);
  const original = workerData();
  for (const bad of [{ sourceAccess: undefined }, { sourceAccess: 'private' }, { status: 'available' },
    { status: 'restricted' }, { status: 'unavailable' }, { subtitles: [] }, { subtitleTrack: null },
    { subtitleTrack: { kind: 'unknown', language: 'zh' } }, { source: { url: url + '?p=2' } },
    { subtitles: [{ start: 3, end: 2, text: 'x' }] }, { title: '' }]) {
    value = { ...original, ...bad };
    assert.equal(await reader.readForSpace(url), null);
  }
  value = { ...original, sourceAccess: 'anonymous_public' };
  assert.match((await reader.readForSpace(url)).excerpt, /\[20–24秒\]/);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(reader.getStatus().leases, 0);
});

test('space refuses noncanonical URLs, YouTube and disabled platforms before worker I/O', async t => {
  const { reader } = await fixture(t, assert.fail, ['bilibili', 'youtube']);
  for (const link of [url + '?t=32', url + '?spm=x', url + '/', 'https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.example.org/post']) {
    assert.equal(await reader.readForSpace(link), null);
  }
  assert.equal(reader.getStatus().attempts, 0);
  const other = await fixture(t, assert.fail, ['youtube']);
  assert.equal(await other.reader.readForSpace(url), null);
  assert.equal(other.reader.getStatus().attempts, 0);
});

test('space and private jobs share a single queue; cancellation drains in-flight and drops queued work', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const { reader, directory } = await fixture(t, async ({ signal }) => {
    calls.push('start'); entered();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    calls.push('stopped'); return workerData();
  });
  const first = reader.readForSpace(url);
  await started;
  const queuedPublic = reader.readForSpace(url);
  const queuedPrivate = reader.read({ url, scope });
  const settled = Promise.allSettled([first, queuedPublic, queuedPrivate]);
  await reader.invalidateAll();
  for (const result of await settled) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'REPLY_SUPERSEDED'); }
  assert.deepEqual(calls, ['start', 'stopped']);
  assert.deepEqual(await readdir(directory), []);
  const dead = new AbortController(); dead.abort();
  await assert.rejects(reader.readForSpace(url, { signal: dead.signal }), { code: 'REPLY_SUPERSEDED' });
});

test('public evidence retains only complete bounded timed cues, even with very long subtitles', async t => {
  const { reader } = await fixture(t, () => ({ ...workerData(), subtitles: Array.from({ length: 20 }, (_, i) => ({
    start: i, end: i + 0.8, text: '完整句子'.repeat(40)
  })) }));
  const { excerpt, contentHash } = await reader.readForSpace(url);
  assert(excerpt.length <= 2000);
  const lines = excerpt.split('\n');
  assert(lines.length > 1 && lines.length < 20);
  for (const [i, line] of lines.entries()) assert.equal(line, '[' + i + '–' + (i + 0.8) + '秒] ' + '完整句子'.repeat(40));
  assert.equal(contentHash, hash(excerpt));
});
