import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalVideoUrl, parseSharedVideoLinks, createVideoReader, createVideoWorker, probeVideoDependencies, formatVideoEvidence } from '../src/video-reader.js';

const URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const scope = { kind: 'private', contactId: 'synthetic-a', memoryEpoch: 'epoch-1' };
const jpg = Buffer.from('ffd8ffe000104a46494600ffd9', 'hex');
const sha = data => createHash('sha256').update(data).digest('hex');
function result(url = URL) { return { version: 1, status: 'ok', source: canonicalVideoUrl(url), title: 'Synthetic video', duration: 10,
  metadataVersion: 'a'.repeat(64), subtitleTrack: { kind: 'human', language: 'en' }, subtitles: [{ start: 0, end: 2, text: 'The object is blue.' }],
  frames: [{ file: 'frame-0.jpg', timestamp: 1, bytes: jpg.length, sha256: sha(jpg) }], errors: [] }; }
async function fixture(t, worker) {
  const directory = await mkdtemp(join(tmpdir(), 't062-video-'));
  const reader = createVideoReader({ directory, worker: worker || (async ({ url, outputDir, mode }) => {
    if (mode === 'probe') return { ...result(url), status: 'available', subtitles: [], frames: [] };
    await writeFile(join(outputDir, 'frame-0.jpg'), jpg); return result(url);
  }) });
  t.after(async () => { await reader.close(); await rm(directory, { recursive: true, force: true }); });
  return { reader, directory };
}

test('video URL parser accepts only known public ID routes, strips unrelated query data', () => {
  assert.equal(canonicalVideoUrl('https://youtu.be/jNQXAC9IVRw?si=private-token').url, URL);
  assert.equal(canonicalVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=333').part, 2);
  for (const url of ['http://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://youtube.com.evil.test/watch?v=jNQXAC9IVRw', 'https://127.0.0.1/video/BV1xx411c7mD', 'https://a:b@youtube.com/watch?v=jNQXAC9IVRw', 'https://youtube.com/playlist?list=x', 'https://www.bilibili.com/video/BV1xx411c7mD?p=0']) assert.equal(canonicalVideoUrl(url), null);
  assert.equal(parseSharedVideoLinks(`${URL} ${URL}`).length, 1);
});

test('a disabled video platform never queues a read or touches the worker', async t => {
  const directory = await mkdtemp(join(tmpdir(), 's133-video-'));
  let calls = 0;
  const reader = createVideoReader({ directory, platforms: ['bilibili'], worker: async () => { calls++; } });
  t.after(async () => { await reader.close(); await rm(directory, { recursive: true, force: true }); });
  for (const platforms of [[], null, ['bilibili', 'unknown']]) {
    assert.throws(() => createVideoReader({ directory, platforms, worker() {} }), { code: 'INVALID_VIDEO_PLATFORMS' });
  }
  const pending = reader.read({ url: URL, scope });
  assert.equal(reader.getStatus().pending, 0);
  const result = await pending;
  assert.equal(result.status, 'unsupported');
  assert.match(formatVideoEvidence(result), /该视频平台目前未启用取材/);
  assert.deepEqual(reader.getStatus().platforms, ['bilibili']);
  assert.equal(calls, 0);
  assert.equal(reader.getStatus().attempts, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('browser-only route omits anonymous dependencies and refuses other platforms before spawning', {skip:process.platform !== 'linux'}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 's133-session-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const nodePath = join(directory, 'fake-node.cjs');
  const log = join(directory, 'calls');
  await writeFile(nodePath, '#!' + process.execPath + '\n' + `const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + '\\n');
console.log(JSON.stringify({version:1,status:'ready',browser:'fixture-chromium'}));`, {mode:0o700});
  const options = {directory, nodePath, platforms:['bilibili'],
    sessionBrowser:{platforms:['youtube','bilibili'],executablePath:'/fixture/chromium'}};
  const health = await probeVideoDependencies(options);
  assert.deepEqual(health, {ready:true,versions:{chromium:'fixture-chromium'}});
  const worker = createVideoWorker(options);
  await assert.rejects(worker({url:URL,outputDir:directory}), {code:'VIDEO_PLATFORM_DISABLED'});
  await assert.rejects(worker({mode:'dependencies',outputDir:directory}), {code:'VIDEO_PLATFORM_DISABLED'});
  const inputs = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].mode, 'session_dependencies');
  assert.deepEqual(inputs[0].platforms, ['bilibili']);
  assert.equal(inputs[0].dependencyRoot, undefined);
  assert.throws(() => createVideoWorker({...options,platforms:['youtube','bilibili'],sessionBrowser:{...options.sessionBrowser,platforms:['bilibili']}}), {code:'INVALID_VIDEO_DEPENDENCY'});
});

test('frames are separately leased, verified, scoped, and only genuine cues reach prompt', async t => {
  const { reader } = await fixture(t);
  const one = await reader.read({ url: URL, scope });
  assert.deepEqual(one.scope, scope); assert.deepEqual(await readFile(one.frames[0].path), jpg);
  const text = formatVideoEvidence(one); assert.match(text, /第三方来源/); assert.match(text, /0–2秒/); assert.match(text, /没有逐帧观看/);
  const two = await reader.read({ url: URL, scope });
  assert.equal(two.cached, true); assert.notEqual(one.frames[0].path, two.frames[0].path);
  await one.release(); assert.deepEqual(await readFile(two.frames[0].path), jpg); await two.release();
});

test('cache reuse checks current remote availability and removes formerly available evidence', async t => {
  let checks = 0;
  const { reader } = await fixture(t, async ({ outputDir, mode }) => {
    if (mode === 'probe') { checks++; return { version: 1, status: 'restricted', errors: ['source_restricted'], frames: [], subtitles: [] }; }
    await writeFile(join(outputDir, 'frame-0.jpg'), jpg); return result();
  });
  const one = await reader.read({ url: URL, scope }); await one.release();
  const two = await reader.read({ url: URL, scope });
  assert.equal(checks, 1); assert.equal(two.status, 'restricted'); assert.equal(two.frames.length, 0);
  assert.equal(reader.getStatus().cached, 0); assert.match(formatVideoEvidence(two), /来源访问受限/);
});

test('same URL under a different object or epoch cannot reuse first object evidence', async t => {
  let reads = 0, probes = 0;
  const { reader } = await fixture(t, async ({ outputDir, mode }) => {
    if (mode === 'probe') probes++; else reads++;
    await writeFile(join(outputDir, 'frame-0.jpg'), jpg); return result();
  });
  for (const s of [scope, { ...scope, contactId: 'synthetic-b' }, { ...scope, memoryEpoch: 'epoch-2' }]) (await reader.read({ url: URL, scope: s })).release();
  assert.equal(reads, 3); assert.equal(probes, 0);
  assert.throws(() => reader.read({ url: URL, scope: { kind: 'public' } }), /unavailable/);
});

test('poisoned worker frame path, digest or symlink is rejected without disclosing private paths', async t => {
  for (const poison of ['path', 'hash', 'symlink']) {
    const { reader } = await fixture(t, async ({ outputDir }) => {
      const r = result();
      if (poison === 'path') r.frames[0].file = '../../private.jpg';
      else if (poison === 'hash') { await writeFile(join(outputDir, 'frame-0.jpg'), jpg); r.frames[0].sha256 = '0'.repeat(64); }
      else { await writeFile(join(outputDir, 'real.jpg'), jpg); await symlink(join(outputDir, 'real.jpg'), join(outputDir, 'frame-0.jpg')); }
      return r;
    });
    const r = await reader.read({ url: URL, scope }); assert.equal(r.status, 'unavailable'); assert.equal(r.frames.length, 0);
    assert.deepEqual(r.errors, ['video_processing_failed']);
  }
});

test('running cancellation drains worker and removes task files before rejection', async t => {
  let start;
  const started = new Promise(r => { start = r; });
  let drained = false;
  const { reader, directory } = await fixture(t, async ({ signal }) => { start(); await new Promise(r => signal.addEventListener('abort', () => setTimeout(r, 20), { once: true })); drained = true; return result(); });
  const controller = new AbortController(), task = reader.read({ url: URL, scope, signal: controller.signal });
  await started; controller.abort(); await assert.rejects(task, { code: 'REPLY_SUPERSEDED' });
  assert.equal(drained, true); assert.deepEqual(await readdir(directory), []);
});

test('contact invalidation cancels current and queued old-generation video work', async t => {
  let start; const started = new Promise(r => { start = r; }); let calls = 0;
  const { reader } = await fixture(t, async ({ signal }) => { calls++; start(); await new Promise(r => signal.addEventListener('abort', r, { once: true })); return result(); });
  const one = reader.read({ url: URL, scope }); const two = reader.read({ url: URL, scope });
  const settled = Promise.allSettled([one, two]); await started; await reader.invalidate(scope.contactId);
  const rows = await settled; assert.equal(calls, 1); assert(rows.every(r => r.status === 'rejected' && r.reason.code === 'REPLY_SUPERSEDED'));
});

test('assertCurrent is checked after worker completion; stale evidence never reaches caller', async t => {
  let current = true;
  const { reader } = await fixture(t, async ({ outputDir }) => { await writeFile(join(outputDir, 'frame-0.jpg'), jpg); current = false; return result(); });
  await assert.rejects(reader.read({ url: URL, scope, assertCurrent() { if (!current) throw Object.assign(Error('stale'), { code: 'REPLY_SUPERSEDED' }); } }), { code: 'REPLY_SUPERSEDED' });
});

test('async guard rejection before a worker or cached read propagates without IO', async t => {
  let calls = 0;
  const { reader } = await fixture(t, async ({ outputDir }) => { calls++; await writeFile(join(outputDir, 'frame-0.jpg'), jpg); return result(); });
  const guard = async () => { await Promise.resolve(); throw Object.assign(Error('epoch changed'), { code: 'MEMORY_EPOCH_CHANGED' }); };
  await assert.rejects(reader.read({ url: URL, scope, assertCurrent: guard }), { code: 'MEMORY_EPOCH_CHANGED' });
  assert.equal(calls, 0);
  const first = await reader.read({ url: URL, scope }); await first.release(); assert.equal(calls, 1);
  await assert.rejects(reader.read({ url: URL, scope, assertCurrent: guard }), { code: 'MEMORY_EPOCH_CHANGED' });
  assert.equal(calls, 1); assert.equal(reader.getStatus().cached, 0);
});

test('async history invalidation after worker completion leaves no cache or lease', async t => {
  let current = true;
  const { reader, directory } = await fixture(t, async ({ outputDir }) => { await writeFile(join(outputDir, 'frame-0.jpg'), jpg); current = false; return result(); });
  await assert.rejects(reader.read({ url: URL, scope, assertCurrent: async () => { await Promise.resolve(); if (!current) throw Object.assign(Error('history changed'), { code: 'HISTORY_SOURCE_CHANGED' }); } }), { code: 'HISTORY_SOURCE_CHANGED' });
  assert.equal(reader.getStatus().cached, 0); assert.equal(reader.getStatus().leases, 0); assert.deepEqual(await readdir(directory), []);
});

test('issued evidence rejects expiry, external cancellation and old contact generations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 't062-expiry-')); let at = 1000;
  const reader = createVideoReader({ directory, ttlMs: 10, now: () => at, worker: async ({ outputDir, mode }) => {
    if (mode === 'probe') return { ...result(), status: 'available', frames: [], subtitles: [] };
    await writeFile(join(outputDir, 'frame-0.jpg'), jpg); return result();
  } });
  t.after(async () => { await reader.close(); await rm(directory, { recursive: true, force: true }); });
  const controller = new AbortController();
  const r = await reader.read({ url: URL, scope, signal: controller.signal }); assert.equal(reader.assertResultCurrent(r), true);
  at = 1010; assert.throws(() => reader.assertResultCurrent(r), { code: 'VIDEO_EVIDENCE_EXPIRED' });
  at = 1005; controller.abort(); assert.throws(() => reader.assertResultCurrent(r), { code: 'REPLY_SUPERSEDED' });
  const r2 = await reader.read({ url: URL, scope }); await reader.invalidate(scope.contactId);
  assert.throws(() => reader.assertResultCurrent(r2), { code: 'REPLY_SUPERSEDED' });
  await r.release(); await r2.release();
});

test('real Linux worker timeout kills its descendant process group before returning', async t => {
  const dir = await mkdtemp(join(tmpdir(), 't062-worker-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'worker.py');
  await writeFile(file, "import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-c',\"import time,pathlib; time.sleep(1); pathlib.Path('late').write_text('bad')\"])\ntime.sleep(30)\n");
  const worker = createVideoWorker({ workerPath: file, dependencyRoot: dir, nodePath: process.execPath, timeoutMs: 150 });
  await assert.rejects(worker({ url: URL, outputDir: dir }), { code: 'VIDEO_TIMEOUT' });
  await new Promise(r => setTimeout(r, 1100)); assert.equal((await readdir(dir)).includes('late'), false);
});
