import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createBrowserRouter, X_HOME_TIMELINE_ENDPOINT } from '../src/browser-router.js';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, changes = {}) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'browser-router-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], made = [];
  let alive = 0;
  const defaultOptions = { profileDir: join(directory, 'default-profile'), screenshotDir: join(directory, 'default-images'), headless: true };
  const xOptions = { profileDir: join(directory, 'x-profile'), screenshotDir: join(directory, 'x-images'),
    channel: 'chrome', readonlyPostEndpoints: [X_HOME_TIMELINE_ENDPOINT] };
  const browserFactory = options => {
    const name = options.readNavigationScope || 'single';
    let mode = 'closed', busy = false;
    const reader = {
      options, failClose: false, hold: null,
      status: () => ({ mode, running: mode !== 'closed', busy, channel: options.channel }),
      async start() { if (mode === 'closed') alive++; mode = 'read'; assert.equal(alive, 1); },
      async read(url) { await this.start(); calls.push([name, 'read', url]); busy = true; try { if (this.hold) await this.hold.promise; return { url, text: name }; } finally { busy = false; } },
      async search(query, options) { await this.start(); calls.push([name, 'search', query, options]); return { text: name }; },
      async openLogin(platform) { await this.start(); mode = 'login'; calls.push([name, 'login', platform]); return { message: 'login' }; },
      async finishLogin() { await this.start(); mode = 'read'; calls.push([name, 'finishLogin']); },
      async close() { calls.push([name, 'close']); if (this.failClose) throw Error('close failed'); if (mode !== 'closed') alive--; mode = 'closed'; }
    };
    made.push(reader); return reader;
  };
  const router = createBrowserRouter({ defaultOptions, xOptions, browserFactory, ...changes });
  t.after(async () => { for (const reader of made) { reader.failClose = false; reader.hold?.resolve(); } await router.close(); });
  return { router, calls, made, directory, defaultOptions, xOptions, browserFactory, alive: () => alive };
}

test('default behavior retains the injected single reader when no X profile is configured', () => {
  const sentinel = { read() {} }, options = { profileDir: '/old' };
  assert.equal(createBrowserRouter({ defaultOptions: options, browserFactory: actual => { assert.equal(actual, options); return sentinel; } }), sentinel);
});

test('X aliases use the dedicated profile; default pages and lookalike hosts keep the original profile', async t => {
  const f = await fixture(t);
  for (const url of ['https://x.com/home', 'https://www.x.com/search?q=test', 'https://twitter.com/person/status/123',
    'https://www.twitter.com/home', 'https://mobile.twitter.com/home', 'https://mobile.x.com/home', 'https://X.COM./home']) {
    assert.equal((await f.router.read(url)).text, 'x');
  }
  for (const url of ['https://example.org/article', 'https://www.xiaohongshu.com/', 'https://x.com.example.org/', 'https://notx.com/']) {
    assert.equal((await f.router.read(url)).text, 'default');
  }
  assert.equal(f.made.length, 2);
  assert.equal(f.made[0].options.profileDir, f.xOptions.profileDir);
  assert.deepEqual(f.made[0].options.readonlyPostEndpoints, [X_HOME_TIMELINE_ENDPOINT]);
  assert.equal(f.made[1].options.profileDir, f.defaultOptions.profileDir);
  assert.equal(f.made[1].options.readonlyPostEndpoints, undefined);
  assert.equal(f.alive(), 1);
});

test('switching profiles always closes the old browser first and reopening preserves its configured path', async t => {
  const f = await fixture(t);
  await f.router.read('https://www.xiaohongshu.com/');
  await f.router.read('https://x.com/home');
  await f.router.read('https://example.org/article');
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [
    ['default', 'read'], ['default', 'close'], ['x', 'read'], ['x', 'close'], ['default', 'read']
  ]);
  assert.equal(f.made.length, 2); assert.equal(f.router.status().platform, 'default');
  await f.router.close(); assert.equal(f.alive(), 0); assert.equal(f.router.status().mode, 'closed');
});

test('login globally blocks reads, searches and another platform until finishLogin', async t => {
  const f = await fixture(t);
  assert.equal((await f.router.openLogin('twitter')).mode, 'login');
  for (const action of [() => f.router.read('https://example.org'), () => f.router.read('https://x.com/home'),
    () => f.router.search('test'), () => f.router.start(), () => f.router.openLogin('xhs')]) await assert.rejects(action, /登录/);
  assert.equal(f.made.length, 1); assert.equal(f.alive(), 1);
  assert.equal((await f.router.finishLogin()).mode, 'read');
  await f.router.openLogin('xhs'); assert.equal(f.router.status().platform, 'default');
  await f.router.finishLogin(); await f.router.search('test', { platform: 'x' });
  assert.equal(f.router.status().platform, 'x');
});

test('close failure retains the original profile and blocks creation of another browser', async t => {
  const f = await fixture(t); await f.router.read('https://example.org');
  f.made[0].failClose = true;
  await assert.rejects(f.router.read('https://x.com/home'), /close failed/);
  assert.equal(f.made.length, 1); assert.equal(f.alive(), 1);
  assert.equal(f.router.status().platform, 'default'); assert.equal(f.router.status().busy, false);
  await assert.rejects(f.router.close(), /close failed/);
  f.made[0].failClose = false; await f.router.read('https://x.com/home'); assert.equal(f.alive(), 1);
});

test('a reader that reports still running after close also prevents profile switching', async t => {
  const f = await fixture(t); await f.router.read('https://example.org');
  const originalClose = f.made[0].close; f.made[0].close = async () => {};
  await assert.rejects(f.router.read('https://x.com/home'), /尚未正常关闭/);
  assert.equal(f.made.length, 1); f.made[0].close = originalClose;
});

test('concurrent operations are rejected without opening a second persistent browser', async t => {
  const f = await fixture(t); await f.router.read('https://x.com/home');
  const wait = deferred(); f.made[0].hold = wait;
  const reading = f.router.read('https://x.com/home');
  assert.equal(f.router.status().busy, true);
  await assert.rejects(f.router.openLogin('xhs'), /另一个操作/);
  await assert.rejects(f.router.read('https://example.org'), /另一个操作/);
  await assert.rejects(f.router.close(), /另一个操作/);
  wait.resolve(); await reading; assert.equal(f.made.length, 1); assert.equal(f.router.status().busy, false);
});

test('platform search and login selection reject unsupported names without launching', async t => {
  const f = await fixture(t);
  await assert.rejects(f.router.search('test', { platform: 'arbitrary' }), /只支持/);
  await assert.rejects(f.router.openLogin('arbitrary'), /只支持/);
  assert.equal(f.made.length, 0);
  await f.router.search('test', { platform: 'twitter' }); assert.equal(f.router.status().platform, 'x');
  await f.router.search('test', { platform: 'xiaohongshu' }); assert.equal(f.router.status().platform, 'default');
});

test('configuration rejects overlapping profiles or screenshots and any unreviewed X POST endpoint', async t => {
  const f = await fixture(t);
  for (const profileDir of [f.defaultOptions.profileDir, join(f.defaultOptions.profileDir, 'child'), f.defaultOptions.screenshotDir, 'relative']) {
    assert.throws(() => createBrowserRouter({ defaultOptions: f.defaultOptions, xOptions: { ...f.xOptions, profileDir }, browserFactory: f.browserFactory }), /目录|绝对/);
  }
  for (const endpoint of ['https://x.com/i/api/graphql/*/HomeTimeline', 'https://x.com/i/api/graphql/other/CreateTweet',
    'https://x.com/i/api/graphql/other/HomeTimeline', 'https://edith.xiaohongshu.com/api/sns/web/v1/feed']) {
    assert.throws(() => createBrowserRouter({ defaultOptions: f.defaultOptions, xOptions: { ...f.xOptions, readonlyPostEndpoints: [endpoint] }, browserFactory: f.browserFactory }), /精确HomeTimeline/);
  }
  assert.equal(f.made.length, 0);
});

test('symlink aliases through an existing ancestor cannot select overlapping profile locations', async t => {
  const f = await fixture(t);
  const actual = join(f.directory, 'actual'), alias = join(f.directory, 'alias');
  await mkdir(actual); await symlink(actual, alias, 'dir');
  const router = createBrowserRouter({ browserFactory: f.browserFactory,
    defaultOptions: { ...f.defaultOptions, profileDir: join(actual, 'profile') },
    xOptions: { ...f.xOptions, profileDir: join(alias, 'profile') } });
  await assert.rejects(router.read('https://x.com/home'), /互不重叠/);
  assert.equal(f.made.length, 0); await router.close();
});
