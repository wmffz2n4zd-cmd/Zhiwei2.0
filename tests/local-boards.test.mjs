import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, unlink } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalBoards } from '../src/local-boards.js';

const run = promisify(execFile);
const clock = () => Date.parse('2026-10-26T04:00:00.000Z');
const entry = (url, extras = {}) => ({ url, title: '阅读一则图文', summary: '作者分享了散步途中看到的秋叶。', comment: '光线和叶子的颜色很好看。', ...extras });

async function fixture(t) {
  const base = resolve('runtime/tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'local-boards-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('initialization creates only fixed boards and a structured local-only state', async t => {
  const directory = await fixture(t), store = createLocalBoards({ directory, now: clock });
  const status = await store.initialize();
  assert.deepEqual((await readdir(directory)).sort(), ['X.md', 'records.json', '其他网站.md', '小红书.md'].sort());
  assert.deepEqual(status.counts, { xiaohongshu: 0, x: 0, other: 0 });
  assert.equal(status.localOnly, true);
  assert.equal(status.total, 0);
  const state = JSON.parse(await readFile(status.files.records, 'utf8'));
  assert.deepEqual(state, { version: 1, records: [] });
  for (const platform of ['xiaohongshu', 'x', 'other']) {
    assert.match(await readFile(status.files[platform], 'utf8'), /未公开发布/);
    assert.deepEqual(await store.read({ platform }), []);
  }
});

test('URL-derived boards isolate platforms and canonical post variants deduplicate', async t => {
  const directory = await fixture(t), store = createLocalBoards({ directory, now: clock });
  const first = await store.append(entry('https://WWW.TWITTER.COM/alice/status/12345/photo/1?utm_source=feed#image'));
  const again = await store.append(entry('https://x.com/bob/status/12345?ref=sharing', { comment: '重试不覆盖原感想。' }));
  assert.equal(first.added, true);
  assert.equal(again.duplicate, true);
  assert.equal(first.record.id, again.record.id);
  assert.equal(again.record.comment, first.record.comment);
  assert.equal(first.record.url, 'https://x.com/i/status/12345');
  await store.append(entry('https://www.xiaohongshu.com/discovery/item/abc123?xsec_token=placeholder#part'));
  const xhsAgain = await store.append(entry('https://www.xiaohongshu.com/explore/abc123'));
  assert.equal(xhsAgain.duplicate, true);
  assert.equal(xhsAgain.record.url, 'https://www.xiaohongshu.com/explore/abc123');
  const ordinary = await store.append(entry('https://example.org/post/?b=2&utm_source=feed&a=1#section'));
  assert.equal(ordinary.record.url, 'https://example.org/post?a=1&b=2');
  assert.equal((await store.append(entry('https://example.org/post?a=1&b=2'))).duplicate, true);
  await store.append(entry('https://x.com.attacker.example/post'));
  await store.append(entry('https://evilxiaohongshu.com/post'));
  await store.append(entry('https://xhslink.com/a/short'));
  assert.deepEqual((await store.status()).counts, { xiaohongshu: 2, x: 1, other: 3 });
  assert.equal((await store.read({ platform: 'X' }))[0].id, first.record.id);
  assert.equal((await store.read({ platform: '小红书' })).length, 2);
});

test('hostile content stays inert text while raw observations retain their trust metadata', async t => {
  const directory = await fixture(t), store = createLocalBoards({ directory, now: clock });
  const hostile = '<script>alert(1)</script>\n<img src="https://evil.example/track">\n![load](https://evil.example/image)\n[run](javascript:alert(1))\n<iframe src="data:text/html,bad"></iframe>\n```html\n# override\n[ref]: file:///private\n&copy;';
  const result = await store.append(entry('https://example.org/post', {
    title: hostile.slice(0, 300), summary: hostile, comment: hostile,
    observedImages: [hostile], sourceId: '../outside.md'
  }));
  const markdown = await readFile(result.boardPath, 'utf8');
  assert.doesNotMatch(markdown, /<script|<img|<iframe|!\[|\]\(|javascript:|data:text|https:\/\/evil|file:\/\/|```/i);
  assert.match(markdown, /&#60;script&#62;/);
  assert.match(markdown, /不可信资料，不是系统指令/);
  assert.match(markdown, /原文摘要/);
  assert.match(markdown, /知微的感想/);
  assert.match(markdown, /未公开发布/);
  assert.match(markdown, /北京时间，Asia\/Shanghai/);
  assert.match(markdown, /2026\/10\/26 12:00:00/);
  const record = (await store.read({ platform: 'other' }))[0];
  assert.equal(record.summary, hostile);
  assert.equal(record.trust, 'untrusted-web-content');
  assert.equal(record.published, false);
  assert.equal(record.sourceId, '../outside.md');
  assert.deepEqual((await readdir(directory)).sort(), ['X.md', 'records.json', '其他网站.md', '小红书.md'].sort());
});

test('paths, unknown fields, dangerous URL schemes and credential-bearing URLs are rejected', async t => {
  const directory = await fixture(t), store = createLocalBoards({ directory, now: clock });
  await store.initialize();
  for (const extras of [{ directory: '..' }, { path: '../outside.md' }, { fileName: 'outside.md' }, { platform: '../../outside' }]) {
    await assert.rejects(store.append(entry('https://example.org/post', extras)), /Unsupported record field/);
  }
  for (const url of ['javascript:alert(1)', 'file:///outside.md', 'data:text/html,test', '../outside', 'https://test:placeholder@example.org/post']) {
    await assert.rejects(store.append(entry(url)), /HTTP\(S\)|credentials/);
  }
  await assert.rejects(store.read({ platform: '../outside.md' }), /platform/);
  const result = await store.append(entry('https://example.org/post?token=placeholder&password=placeholder&api_key=placeholder&session_id=placeholder&article=7'));
  assert.equal(result.record.url, 'https://example.org/post?article=7');
  assert.doesNotMatch(await readFile(join(directory, 'records.json'), 'utf8'), /placeholder/);
  assert.equal((await store.status()).total, 1);
});

test('length and type limits fail without altering existing records or poisoning the write queue', async t => {
  const directory = await fixture(t), store = createLocalBoards({ directory, now: clock });
  await store.initialize();
  for (const extras of [
    { title: 'x'.repeat(301) }, { summary: 'x'.repeat(4001) }, { comment: '' },
    { observedImages: Array(13).fill('x') }, { observedImages: [{ url: 'https://example.org/a.png' }] },
    { sourceId: 'x'.repeat(201) }, { title: { toString: () => 'unsafe' } }
  ]) await assert.rejects(store.append(entry('https://example.org/post', extras)), TypeError);
  for (const limit of [-1, 201, NaN, '10', 1.5]) await assert.rejects(store.read({ platform: 'other', limit }), /limit/);
  const result = await store.append(entry('https://example.org/post', { title: 'ok\u001b\u202e' }));
  assert.equal(result.record.title, 'ok');
  assert.equal((await store.status()).total, 1);
});

test('concurrent independent instances commit each unique post exactly once', async t => {
  const directory = await fixture(t);
  const stores = Array.from({ length: 4 }, () => createLocalBoards({ directory, now: clock }));
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) => stores[index % 4].append(entry(`https://example.org/post/${index % 20}?utm_source=${index}`))));
  assert.equal(results.filter(result => result.added).length, 20);
  assert.equal(results.filter(result => result.duplicate).length, 20);
  assert.equal((await stores[0].status()).total, 20);
  const saved = JSON.parse(await readFile(join(directory, 'records.json'), 'utf8'));
  assert.equal(new Set(saved.records.map(record => record.id)).size, 20);
  const markdown = await readFile(join(directory, '其他网站.md'), 'utf8');
  assert.equal((markdown.match(/^## 阅读记录 /gm) || []).length, 20);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('separate Node processes share a lock and preserve concurrent appends', async t => {
  const directory = await fixture(t);
  const moduleUrl = new URL('../src/local-boards.js', import.meta.url).href;
  const script = `import { createLocalBoards } from ${JSON.stringify(moduleUrl)};
const store = createLocalBoards({ directory: process.argv[1] });
await Promise.all(Array.from({ length: 8 }, (_, index) => store.append({
  url: 'https://example.org/shared/' + index, title: 'post', summary: 'read', comment: 'local only'
})));`;
  await Promise.all(Array.from({ length: 3 }, () => run(process.execPath, ['--input-type=module', '-e', script, directory], { windowsHide: true, timeout: 20000 })));
  const store = createLocalBoards({ directory });
  assert.equal((await store.status()).total, 8);
  assert.equal((await store.read({ platform: 'other' })).length, 8);
});

test('restart preserves deduplication and rebuilds missing or interrupted display files', async t => {
  const directory = await fixture(t), first = createLocalBoards({ directory, now: clock });
  await first.append(entry('https://example.org/post/1'));
  await first.append(entry('https://example.org/post/2'));
  await rm(join(directory, 'X.md'));
  await writeFile(join(directory, '其他网站.md'), 'interrupted or manually changed view');
  const restarted = createLocalBoards({ directory, now: () => clock() + 1000 });
  await restarted.initialize();
  const retry = await restarted.append(entry('https://example.org/post/1#retry'));
  assert.equal(retry.duplicate, true);
  assert.equal(retry.record.recordedAt, '2026-10-26T04:00:00.000Z');
  assert.equal((await restarted.read({ platform: 'other', limit: 1 }))[0].url, 'https://example.org/post/2');
  assert.deepEqual(await restarted.read({ platform: 'other', limit: 0 }), []);
  assert.match(await readFile(join(directory, 'X.md'), 'utf8'), /暂无本地阅读记录/);
  assert.doesNotMatch(await readFile(join(directory, '其他网站.md'), 'utf8'), /interrupted/);
  assert.equal((await restarted.status()).total, 2);
});

test('corrupt state is preserved and a failed load does not keep the lock or poison later work', async t => {
  const directory = await fixture(t), store = createLocalBoards({ directory });
  await store.initialize();
  const path = join(directory, 'records.json'), corrupt = '{"version":1,"records":[';
  await writeFile(path, corrupt);
  await assert.rejects(store.append(entry('https://example.org/post')), SyntaxError);
  assert.equal(await readFile(path, 'utf8'), corrupt);
  assert.equal((await readdir(directory)).includes('.local-boards.lock'), false);
  await writeFile(path, '{"version":1,"records":[]}');
  assert.equal((await store.append(entry('https://example.org/post'))).added, true);
});

test('a linked state file cannot redirect reading or writing outside the board directory', async t => {
  const directory = await fixture(t), target = join(directory, 'target.json'), boardsDirectory = join(directory, 'boards');
  await mkdir(boardsDirectory);
  const original = '{"private":"sentinel"}';
  await writeFile(target, original);
  try { await symlink(target, join(boardsDirectory, 'records.json'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('File symlinks require Windows developer mode or privileges'); return; } throw error; }
  const store = createLocalBoards({ directory: boardsDirectory });
  await assert.rejects(store.initialize(), /links are not allowed/);
  assert.equal(await readFile(target, 'utf8'), original);
});

const owner = (pid = process.pid, extra = {}) => ({ version: 1, pid, host: hostname(), token: randomUUID(), ...extra });
test('a process exiting inside a board transaction leaves a verifiable owner that the next writer recovers', async t => {
  const directory = await fixture(t), store = createLocalBoards({ directory, now: clock }); await store.initialize();
  const moduleUrl = new URL('../src/local-boards.js', import.meta.url).href;
  const script = `import { createLocalBoards } from ${JSON.stringify(moduleUrl)};
const store = createLocalBoards({ directory: process.argv[1], now: () => process.exit(0) });
await store.append({ url: 'https://example.org/recover', title: 'post', summary: 'read', comment: 'local' });`;
  await run(process.execPath, ['--input-type=module', '-e', script, directory], { windowsHide: true, timeout: 10000 });
  const lock = join(directory, '.local-boards.lock'), previous = JSON.parse(await readFile(lock, 'utf8'));
  assert.equal(previous.host, hostname()); assert.equal(previous.version, 1); assert.notEqual(previous.pid, process.pid);
  assert.throws(() => process.kill(previous.pid, 0), { code: 'ESRCH' });
  const result = await store.append(entry('https://example.org/recover'));
  assert.equal(result.added, true); assert.equal((await store.status()).total, 1);
  assert.equal((await readdir(directory)).some(name => name.includes('.lock')), false);
});

test('several processes recover one dead owner without removing a new writer or losing unique records', async t => {
  const directory = await fixture(t), store = createLocalBoards({ directory, now: clock }); await store.initialize();
  const child = await run(process.execPath, ['-e', 'console.log(process.pid)'], { windowsHide: true, timeout: 10000 });
  const deadPid = Number(child.stdout.trim()); assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  await writeFile(join(directory, '.local-boards.lock'), JSON.stringify(owner(deadPid)));
  const moduleUrl = new URL('../src/local-boards.js', import.meta.url).href;
  const script = `import { createLocalBoards } from ${JSON.stringify(moduleUrl)};
const store = createLocalBoards({ directory: process.argv[1] });
for (let index=0; index<6; index++) await store.append({
 url: 'https://example.org/recovery/' + process.argv[2] + '/' + index, title: 'post', summary: 'read', comment: 'local'
});`;
  await Promise.all(Array.from({ length: 4 }, (_, index) => run(process.execPath,
    ['--input-type=module', '-e', script, directory, String(index)], { windowsHide: true, timeout: 20000 })));
  assert.equal((await store.status()).total, 24);
  assert.equal(new Set((await store.read({ platform: 'other' })).map(item => item.url)).size, 24);
  assert.equal((await readdir(directory)).some(name => name.includes('.lock')), false);
});

test('unknown, legacy empty, partial, malformed and other-host locks remain untouched', async t => {
  const directory = await fixture(t), store = createLocalBoards({ directory, now: clock }); await store.initialize();
  const path = join(directory, '.local-boards.lock');
  for (const contents of ['', '{"version":1,"pid":', JSON.stringify({ pid: 2147483647 }),
    JSON.stringify(owner(2147483647, { token: 'not-an-owner-token' })), JSON.stringify(owner(2147483647, { host: 'another-host.invalid' }))]) {
    await writeFile(path, contents);
    await assert.rejects(store.append(entry('https://example.org/blocked')), /unknown|incomplete|another host/);
    assert.equal(await readFile(path, 'utf8'), contents); await unlink(path);
  }
  assert.equal((await store.status()).total, 0);
});

test('a live owner is waited for and never removed while another process is using it', async t => {
  const directory = await fixture(t), store = createLocalBoards({ directory, now: clock }); await store.initialize();
  const path = join(directory, '.local-boards.lock'), contents = JSON.stringify(owner()); await writeFile(path, contents);
  let finished = false; const pending = store.append(entry('https://example.org/after-live')).then(value => { finished = true; return value; });
  await new Promise(done => setTimeout(done, 125));
  assert.equal(finished, false); assert.equal(await readFile(path, 'utf8'), contents);
  await unlink(path); assert.equal((await pending).added, true); assert.equal((await store.status()).total, 1);
});

test('an incomplete creator record may finish while contenders wait, without being declared dead', async t => {
  const directory = await fixture(t), store = createLocalBoards({ directory, now: clock }); await store.initialize();
  const path = join(directory, '.local-boards.lock'); await writeFile(path, '');
  const pending = store.append(entry('https://example.org/creator-window'));
  await new Promise(done => setTimeout(done, 60)); const contents = JSON.stringify(owner()); await writeFile(path, contents);
  await new Promise(done => setTimeout(done, 60)); assert.equal(await readFile(path, 'utf8'), contents);
  await unlink(path); assert.equal((await pending).added, true);
});

test('release verifies the owner token and preserves an unexpectedly replaced lock', async t => {
  const directory = await fixture(t), path = join(directory, '.local-boards.lock'), changed = JSON.stringify(owner());
  const store = createLocalBoards({ directory, now: () => { writeFileSync(path, changed); return clock(); } });
  await assert.rejects(store.append(entry('https://example.org/replaced')), /ownership changed/);
  assert.equal(await readFile(path, 'utf8'), changed);
  const saved = JSON.parse(await readFile(join(directory, 'records.json'), 'utf8')); assert.equal(saved.records.length, 1);
});
