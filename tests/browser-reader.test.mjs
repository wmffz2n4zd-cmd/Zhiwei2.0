import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createBrowserReader, isPublicAddress, validatePublicUrl, checkReadRequest, sanitizePageSnapshot, isXBrowserUrl, inspectXReadiness } from '../src/browser-reader.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const snapshot = () => ({ title: '一篇真实页面', text: '这里是已经渲染的正文，包含一段足够长的可读内容，用于验证阅读和截图流程。', links: [{ title: '下一篇', url: 'https://example.com/next' }], images: [0, 1] });

test('public URL policy blocks private, reserved, credential and account action destinations', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '100.64.0.1', '169.254.169.254', '198.18.1.1', '203.0.113.5', '::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'http://127.0.0.1/', 'http://2130706433/', 'http://local/', 'https://user:password@example.com/', 'https://example.com:3000/', 'https://x.com/settings', 'https://x.com/i/api/graphql/id/CreateTweet', 'https://example.com/%64elete', 'https://example.com/?access_token=secret']) await assert.rejects(validatePublicUrl(url, { lookup: publicLookup }), undefined, url);
  assert.equal(await validatePublicUrl('https://x.com/person/status/123#photo', { lookup: publicLookup }), 'https://x.com/person/status/123');
  await assert.rejects(validatePublicUrl('https://example.com/', { lookup: async () => [{ address: '127.0.0.1' }] }), /内网/);
  await assert.rejects(validatePublicUrl('https://example.com/', { lookup: () => new Promise(() => {}), dnsTimeoutMs: 5 }), /超时/);
});

test('write requests fail closed; only explicitly configured read POST and its preflight pass', () => {
  const url = 'https://edith.xiaohongshu.com/api/sns/web/v1/feed';
  assert.throws(() => checkReadRequest(url, { method: 'POST', resourceType: 'fetch' }), /写入/);
  assert.equal(checkReadRequest(url, { method: 'POST', resourceType: 'fetch', readonlyPostEndpoints: [url] }), url);
  assert.equal(checkReadRequest(url, { method: 'OPTIONS', resourceType: 'other', readonlyPostEndpoints: [url] }), url);
  for (const change of [{ method: 'DELETE' }, { method: 'PUT' }, { resourceType: 'eventsource' }, { method: 'POST', resourceType: 'document' }]) assert.throws(() => checkReadRequest(url, { ...change, readonlyPostEndpoints: [url] }));
  assert.throws(() => checkReadRequest(url + '?extra=1', { method: 'POST', resourceType: 'fetch', readonlyPostEndpoints: [url] }));
});

test('X HomeTimeline allowance is exact and cannot authorize adjacent queries or writes', () => {
  const home = 'https://x.com/i/api/graphql/fedFLLzmiCAuzPgA8lyh8Q/HomeTimeline';
  const options = { method: 'POST', resourceType: 'fetch', readonlyPostEndpoints: [home] };
  assert.equal(checkReadRequest(home, options), home);
  for (const url of [home + '?extra=1', home + '/suffix', home.replace('fedFLLzmiCAuzPgA8lyh8Q', 'another-id'), home.replace('HomeTimeline', 'CreateTweet'), home.replace('HomeTimeline', 'FavoriteTweet'), home.replace('x.com', 'api.x.com'), home.replace('https:', 'http:')]) assert.throws(() => checkReadRequest(url, options), undefined, url);
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.throws(() => checkReadRequest(home, { ...options, method }));
});

test('login and verification pages are withheld from the model; unsafe links are omitted', () => {
  for (const change of [{ password: true }, { text: '扫码登录后查看内容' }, { challenge: true }]) {
    const result = sanitizePageSnapshot({ ...snapshot(), ...change }, 'https://example.com/');
    assert.ok(result.blockedReason); assert.deepEqual(result.links, []); assert.deepEqual(result.imagePaths, []);
    assert.doesNotMatch(result.text, /已渲染的正文/);
  }
  const clean = sanitizePageSnapshot({ ...snapshot(), links: [...snapshot().links, { title: 'local', url: 'http://127.0.0.1/' }, { title: 'secret', url: 'https://x.com/?token=secret' }] }, 'https://example.com/');
  assert.equal(clean.links.length, 1);
});

class FakePage extends EventEmitter {
  constructor(context) { super(); this.context = context; this.closed = false; this.address = 'about:blank'; this.shots = []; }
  isClosed() { return this.closed; }
  async close() {
    if (this.closed) return;
    this.closed = true; this.emit('close');
    if (this.context.exitOnLastPage && this.context.connected && !this.context.pages().length) await this.context.close();
  }
  mainFrame() { return this; }
  async goto(url) { assert.equal(this.closed, false); this.address = this.context.redirect || url; this.context.visited.push(url); }
  url() { return this.address; }
  async waitForLoadState() {}
  async evaluate(fn) { return fn === inspectXReadiness ? this.context.xReadiness : { ...this.context.snapshot }; }
  async waitForFunction(fn, target, options) {
    assert.equal(fn, inspectXReadiness);
    this.context.waits.push({ target, options });
    if (!this.context.xReadiness) { const error = new Error('fixture content deadline'); error.name = 'TimeoutError'; throw error; }
    return { jsonValue: async () => this.context.xReadiness, dispose: async () => {} };
  }
  locator(selector) { return { selector, nth: index => ({ screenshot: async () => Buffer.from(`image-${index}`) }) }; }
  async screenshot(options) { this.shots.push(options); return Buffer.from('page image'); }
}
class FakeContext extends EventEmitter {
  constructor(options, { exitOnLastPage = false, restorePage = false } = {}) {
    super(); this.options = options; this.connected = true; this.tabs = []; this.visited = []; this.snapshot = snapshot(); this.offline = []; this.waits = []; this.xReadiness = false;
    this.exitOnLastPage = exitOnLastPage;
    if (restorePage) this.tabs.push(new FakePage(this));
  }
  browser() { return { isConnected: () => this.connected }; }
  pages() { return this.tabs.filter(p => !p.closed); }
  async newPage() { assert.ok(this.connected); const p = new FakePage(this); this.tabs.push(p); this.emit('page', p); return p; }
  async close() { if (this.failClose) throw Error('fixture close failed'); this.connected = false; for (const p of this.pages()) await p.close(); this.emit('close'); }
  async route(pattern, handler) { this.routeHandler = handler; }
  async routeWebSocket(pattern, handler) { this.socketHandler = handler; }
  async addInitScript(fn) { this.initScript = fn; }
  async clearPermissions() {}
  async setOffline(value) { this.offline.push(value); }
}
async function fixture(t, options = {}, contextOptions = {}) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'browser-reader-'));
  const contexts = [];
  const reader = createBrowserReader({ profileDir: join(dir, 'profile'), screenshotDir: join(dir, 'snapshots'), lookup: publicLookup,
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async (_, opts) => { const c = new FakeContext(opts, contextOptions); contexts.push(c); return c; } } }), ...options });
  t.after(async () => { await reader.close(); const path = relative(base, dir); assert.ok(path && !path.startsWith('..') && !isAbsolute(path)); await rm(dir, { recursive: true, force: true }); });
  return { reader, contexts, dir };
}
async function routeResult(context, url, method = 'GET', resourceType = 'document') {
  let result;
  const page = context.pages()[0];
  await context.routeHandler({ request: () => ({ url: () => url, method: () => method, resourceType: () => resourceType, isNavigationRequest: () => resourceType === 'document', frame: () => page }), continue: async () => { result = 'continue'; }, abort: async () => { result = 'abort'; } });
  return result;
}

test('closing a login tab or browser window allows the next platform login to reopen', async t => {
  const { reader, contexts } = await fixture(t);
  await reader.openLogin('x');
  assert.equal(contexts.length, 1);
  await contexts[0].pages()[0].close();
  await reader.openLogin('xiaohongshu');
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].visited.at(-1), 'https://www.xiaohongshu.com/');
  await contexts[0].close();
  assert.equal(reader.status().mode, 'closed');
  await reader.openLogin('x');
  assert.equal(contexts.length, 2);
  assert.equal(reader.status().mode, 'login');
});

test('login and read startup survive browsers that exit when their last restored tab closes', async t => {
  const { reader, contexts } = await fixture(t, {}, { exitOnLastPage: true, restorePage: true });
  await reader.openLogin('x');
  const login = contexts[0];
  assert.equal(reader.status().running, true);
  assert.equal(login.tabs[0].isClosed(), true);
  assert.equal(login.pages().length, 1);
  assert.equal(login.pages()[0].url(), 'https://x.com/i/flow/login');
  await reader.finishLogin();
  assert.equal(login.connected, false);
  const read = contexts[1];
  assert.equal(reader.status().mode, 'read');
  assert.equal(read.tabs[0].isClosed(), true);
  assert.equal(read.pages().length, 1);
});

test('repeated reads keep a browser tab alive while still rejecting read-mode popups', async t => {
  const { reader, contexts } = await fixture(t, {}, { exitOnLastPage: true });
  const first = await reader.read('https://example.com/first');
  assert.equal(first.blockedReason, undefined);
  const context = contexts[0], firstPage = context.pages()[0];
  const second = await reader.read('https://example.com/second');
  assert.equal(second.blockedReason, undefined);
  assert.equal(second.url, 'https://example.com/second');
  assert.equal(firstPage.isClosed(), true);
  assert.equal(contexts.length, 1);
  assert.equal(context.pages().length, 1);
  const popup = await context.newPage();
  assert.equal(popup.isClosed(), true);
  assert.equal(context.connected, true);
  assert.equal(context.pages().length, 1);
});

test('human login preserves popups and public WebSockets while pausing all model reads', async t => {
  const { reader, contexts } = await fixture(t);
  await reader.openLogin('x'); const login = contexts[0];
  const popup = await login.newPage();
  assert.equal(popup.isClosed(), false);
  assert.equal(popup.listenerCount('dialog'), 0);
  assert.equal(await routeResult(login, 'https://x.com/i/api/login', 'POST', 'fetch'), 'continue');
  let connected = 0, closed = 0;
  await login.socketHandler({ url: () => 'wss://x.com/connection', connectToServer: () => connected++, close: async () => closed++ });
  await login.socketHandler({ url: () => 'ws://127.0.0.1/connection', connectToServer: () => connected++, close: async () => closed++ });
  assert.equal(connected, 1); assert.equal(closed, 1);
  await assert.rejects(reader.read('https://example.com/'), /登录/);
  await reader.finishLogin();
  assert.equal(login.connected, false);
  assert.equal(reader.status().mode, 'read');
  const read = contexts.at(-1);
  const blockedPopup = await read.newPage(); assert.equal(blockedPopup.isClosed(), true);
  await read.socketHandler({ close: async () => closed++ }); assert.equal(closed, 2);
});

test('read mode enforces network policy, masks forms, bounds screenshots and goes offline after capture', async t => {
  const { reader, contexts } = await fixture(t);
  const page = await reader.read('https://example.com/article');
  assert.equal(page.title, '一篇真实页面'); assert.equal(page.imagePaths.length, 3);
  assert.equal((await readFile(page.imagePaths[0])).toString(), 'page image');
  const context = contexts[0];
  assert.equal(context.options.acceptDownloads, false); assert.equal(context.options.serviceWorkers, 'block');
  assert.equal(context.offline.at(-1), true);
  assert.match(context.pages()[0].shots[0].mask[0].selector, /input.*form/);
  assert.equal(await routeResult(context, 'https://example.com/article'), 'continue');
  assert.equal(await routeResult(context, 'https://example.com/api', 'POST', 'fetch'), 'abort');
  assert.equal(await routeResult(context, 'http://127.0.0.1/'), 'abort');
  assert.equal(await routeResult(context, 'https://x.com/i/api/graphql/id/CreateTweet'), 'abort');
});

test('unsafe initial URLs and redirects never produce page content or screenshots', async t => {
  const { reader, contexts } = await fixture(t);
  const blocked = await reader.read('file:///C:/secret');
  assert.ok(blocked.blockedReason); assert.equal(contexts.length, 0); assert.equal(blocked.url, '');
  await reader.start(); contexts[0].redirect = 'http://127.0.0.1/admin';
  const result = await reader.read('https://example.com/redirect');
  assert.ok(result.blockedReason); assert.deepEqual(result.imagePaths, []); assert.equal(result.text, '');
});

test('login challenges skip screenshots and all following requests remain paused', async t => {
  const { reader, contexts } = await fixture(t);
  await reader.start(); contexts[0].snapshot = { ...snapshot(), challenge: true };
  const result = await reader.read('https://example.com/');
  assert.equal(result.blockedReason, 'human_verification_required'); assert.deepEqual(result.imagePaths, []);
  assert.equal(contexts[0].pages()[0].shots.length, 0); assert.equal(contexts[0].offline.at(-1), true);
});

test('search targets preserve platform-specific destinations with escaped queries', async t => {
  const { reader, contexts } = await fixture(t);
  await reader.search('巧克力 & 猫', { platform: 'x' });
  assert.equal(new URL(contexts[0].visited.at(-1)).searchParams.get('q'), '巧克力 & 猫');
  await reader.search('春天', { platform: 'xiaohongshu' });
  assert.equal(new URL(contexts[0].visited.at(-1)).hostname, 'www.xiaohongshu.com');
  await assert.rejects(reader.search('话题', { platform: 'unsupported' }), /平台/);
});

test('X feeds wait for actual content; empty shells are not returned as successful reads', async t => {
  const { reader, contexts } = await fixture(t, { timeoutMs: 1000 });
  await reader.start();
  const context = contexts[0];
  context.xReadiness = 'ready';
  const home = await reader.read('https://x.com/home');
  assert.equal(home.blockedReason, undefined);
  assert.deepEqual(context.waits.at(-1), { target: { statusId: null }, options: { polling: 100, timeout: 1000 } });
  const post = await reader.read('https://twitter.com/person/status/12345');
  assert.equal(post.blockedReason, undefined);
  assert.equal(context.waits.at(-1).target.statusId, '12345');
  context.snapshot = { ...snapshot(), text: '短帖。' };
  assert.equal((await reader.read('https://x.com/person/status/12345')).blockedReason, undefined);
  context.snapshot = snapshot();
  context.xReadiness = false;
  const empty = await reader.search('astronomy', { platform: 'x' });
  assert.equal(empty.blockedReason, 'x_content_not_ready');
  assert.deepEqual(empty.links, []); assert.deepEqual(empty.imagePaths, []);
  assert.doesNotMatch(empty.text, /已经渲染的正文/);
  assert.equal(context.offline.at(-1), true);
  const waits = context.waits.length;
  assert.equal((await reader.read('https://www.xiaohongshu.com/')).blockedReason, undefined);
  assert.equal(context.waits.length, waits);
});

test('X readiness preserves authentication and challenge failures without screenshots', async t => {
  const { reader, contexts } = await fixture(t);
  await reader.start();
  for (const reason of ['login_required', 'human_verification_required']) {
    contexts[0].xReadiness = reason;
    const result = await reader.read('https://x.com/home');
    assert.equal(result.blockedReason, reason);
    assert.equal(result.requiresLogin, reason === 'login_required');
    assert.deepEqual(result.imagePaths, []); assert.deepEqual(result.links, []);
  }
  const login = 'https://x.com/i/jf/onboarding?webmode=login';
  assert.equal(sanitizePageSnapshot(snapshot(), login).blockedReason, 'login_required');
  for (const url of ['https://x.com/loginuser', 'https://x.com/signinart', 'https://x.com/loginuser/status/123']) {
    assert.equal(sanitizePageSnapshot(snapshot(), url).requiresLogin, false);
  }
  assert.equal((await reader.read(login)).blockedReason, 'login_required');
  contexts[0].redirect = login;
  const redirect = await reader.read('https://x.com/home');
  assert.equal(redirect.blockedReason, 'login_required');
  assert.equal(redirect.requiresLogin, true);
  assert.deepEqual(redirect.imagePaths, []);
});

test('configured browser profile boundary blocks initial URLs and cross-site top-level redirects', async t => {
  for (const url of ['https://x.com/home', 'https://www.x.com/home', 'https://twitter.com/home', 'https://mobile.twitter.com/home', 'https://x.com./home']) assert.equal(isXBrowserUrl(url), true);
  for (const url of ['https://notx.com/home', 'https://x.com.evil.com/home', 'https://example.com/?next=https://x.com', 'garbage']) assert.equal(isXBrowserUrl(url), false);
  const general = await fixture(t, { readNavigationScope: 'default' });
  assert.equal((await general.reader.read('https://x.com/home')).blockedReason, 'browser_profile_boundary');
  assert.equal(general.contexts.length, 0);
  await general.reader.start();
  const gc = general.contexts[0];
  assert.equal(await routeResult(gc, 'https://x.com/home'), 'abort');
  assert.equal(await routeResult(gc, 'https://example.com/'), 'continue');
  assert.equal(await routeResult(gc, 'https://x.com/i/api/graphql/id/Query', 'GET', 'fetch'), 'continue');
  gc.redirect = 'https://x.com/home';
  assert.equal((await general.reader.read('https://example.com/redirect')).blockedReason, 'browser_profile_boundary');
  const x = await fixture(t, { readNavigationScope: 'x' });
  assert.equal((await x.reader.read('https://example.com/')).blockedReason, 'browser_profile_boundary');
  await x.reader.start();
  assert.equal(await routeResult(x.contexts[0], 'https://example.com/'), 'abort');
  assert.equal(await routeResult(x.contexts[0], 'https://x.com/home'), 'continue');
  await x.reader.openLogin('x');
  assert.equal(await routeResult(x.contexts.at(-1), 'https://example.com/oauth/authorize'), 'continue');
});

test('failed browser close preserves the live context and stops profile/mode transitions', async t => {
  const { reader, contexts } = await fixture(t);
  await reader.start();
  const context = contexts[0]; context.failClose = true;
  try {
    await assert.rejects(reader.close(), /正常关闭/);
    assert.equal(reader.status().running, true); assert.equal(reader.status().mode, 'read');
    await assert.rejects(reader.openLogin('x'), /正常关闭/);
    assert.equal(contexts.length, 1); assert.equal(context.connected, true);
  } finally { context.failClose = false; }
  await reader.close();
  assert.equal(reader.status().running, false);
});
