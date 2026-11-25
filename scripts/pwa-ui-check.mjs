// Synthetic browser regression only. No production account, model, provider or data.
// BROWSER_PATH=/path/to/chrome node scripts/pwa-ui-check.mjs
// PLAYWRIGHT_MODULE may name an installed playwright-core directory.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
if (!process.env.BROWSER_PATH) throw Error('Set BROWSER_PATH to an isolated Linux Chrome executable');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'modules/pwa/public');
const output = path.resolve(process.env.PWA_UI_OUTPUT || path.join(root, 'runtime/pwa-ui-check'));
await mkdir(output, { recursive: true });
const model = { loggedIn: false, readOnly: false, pendingBinding: false, messages: [], requests: [], posts: [], resetTokens: [], faultNextMessage: false, swVersion: 1 };
const mediaId = '01000000-0000-4000-8000-000000000001';
const streams = new Set();
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const changed = () => { for (const res of streams) res.write('event: message\ndata: {}\n\n'); };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1'); model.requests.push({ method: req.method, path: req.url });
    if (url.pathname.startsWith('/api/pwa/')) {
      let data; const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (chunks.length && req.headers['content-type']?.startsWith('application/json')) data = JSON.parse(Buffer.concat(chunks));
      if (req.method !== 'GET') assert.equal(req.headers['x-pwa-request'], '1');
      if (req.method === 'POST' && url.pathname === '/api/pwa/password-reset') { model.resetTokens.push(data.token); assert.ok(data.password.length >= 10); model.loggedIn = false; return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && ['/api/pwa/session', '/api/pwa/invitations/claim'].includes(url.pathname)) { assert.ok(data.username); assert.ok(data.password.length >= 10); model.loggedIn = true; return json(res, 200, { ok: true }); }
      if (!model.loggedIn) return json(res, 401, { error: 'session-expired' });
      if (req.method === 'DELETE' && url.pathname === '/api/pwa/session') { assert.equal(req.headers['x-csrf-token'], 'synthetic-csrf'); model.loggedIn = false; return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/pwa/me') return json(res, 200, { user: { id: 'synthetic-user-a', displayName: '测试朋友', role: 'user', active: true }, csrfToken: 'synthetic-csrf', capabilities: { chat: !model.readOnly && !model.pendingBinding, images: true, notifications: false, legacyHistory: true }, readOnly: model.readOnly, pendingBinding: model.pendingBinding, pushPublicKey: '', push: { subscribed: false } });
      if (req.method === 'GET' && url.pathname === '/api/pwa/legacy-history') {
        if (url.searchParams.get('before') === 'older-cursor') return json(res, 200, { records: [{ id: 'old-1', at: '2026-10-01T00:00:00Z', source: 'qq', userText: '更早的合成 QQ 原文', replyText: '合成回复', quotedText: '', truncated: false }], hasMore: false, nextBefore: null });
        return json(res, 200, { records: [{ id: 'old-2', at: '2026-11-01T00:00:00Z', source: 'qq', userText: '<img src=x onerror="window.syntheticXss=true">', replyText: '这是留存的原始合成文字', quotedText: '当时的合成引用', truncated: true }], hasMore: true, nextBefore: 'older-cursor' });
      }
      if (req.method === 'GET' && url.pathname === '/api/pwa/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.write('event: ready\ndata: {}\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
      if (req.method !== 'GET') assert.equal(req.headers['x-csrf-token'], 'synthetic-csrf');
      if (req.method === 'POST' && url.pathname === '/api/pwa/read') return json(res, 200, { readSeq: data.seq });
      if (req.method === 'GET' && url.pathname === '/api/pwa/messages') {
        let messages = model.messages;
        if (url.searchParams.has('after')) messages = messages.filter(m => m.seq > Number(url.searchParams.get('after')));
        if (url.searchParams.has('before')) messages = messages.filter(m => m.seq < Number(url.searchParams.get('before')));
        return json(res, 200, { messages, hasMore: false, readSeq: 0 });
      }
      if (req.method === 'POST' && url.pathname === '/api/pwa/messages') {
        if (model.readOnly) return json(res, 503, { error: 'read-only-maintenance' });
        model.posts.push(data); let message = model.messages.find(m => m.clientMessageId === data.clientMessageId);
        if (!message) { message = { ...data, id: randomUUID(), seq: model.messages.length + 1, direction: 'inbound', createdAt: new Date().toISOString() }; model.messages.push(message); }
        json(res, 200, { message }); changed(); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/pwa/media') { assert.equal(req.headers['content-type'], 'image/png'); assert.ok(Buffer.concat(chunks).length); return json(res, 201, { media: { id: mediaId, type: 'image/png', url: `/api/pwa/media/${mediaId}` } }); }
      if (req.method === 'GET' && url.pathname === `/api/pwa/media/${mediaId}`) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(await readFile(path.join(publicDir, 'icon-192.png'))); return; }
      return json(res, 404, { error: 'not-found' });
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^[a-zA-Z0-9.\-]+$/.test(name)) return json(res, 404, {});
    let content = await readFile(path.join(publicDir, name));
    if (name === 'sw.js' && model.swVersion > 1) content = Buffer.from(content.toString().replace('zhiwei-public-v1', `zhiwei-public-v${model.swVersion}`));
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
    res.writeHead(200, { 'Content-Type': types[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' }); res.end(content);
  } catch (error) { model.serverError = error.stack; if (!res.headersSent) json(res, 500, { error: 'synthetic-server-error' }); else res.destroy(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const checks = []; const errors = [];
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
await context.route(`${origin}/api/pwa/messages`, async route => {
  if (route.request().method() === 'POST' && model.faultNextMessage) {
    model.faultNextMessage = false;
    // Persist at the real synthetic HTTP backend, then drop its response at the
    // test proxy. Destroying a fresh socket can trigger Chromium's own retry.
    await route.fetch(); await route.abort('failed'); return;
  }
  await route.continue();
});
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
const check = (name, details = {}) => checks.push({ name, passed: true, ...details });
const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
const visible = selector => page.waitForSelector(selector, { state: 'visible' });
const hidden = selector => page.waitForSelector(selector, { state: 'hidden' });
const draft = () => page.evaluate(() => new Promise((resolve, reject) => { const r = indexedDB.open('zhiwei-private-drafts', 1); r.onsuccess = () => { const db = r.result; const tx = db.transaction('drafts'); const all = tx.objectStore('drafts').getAll(); all.onsuccess = () => resolve(all.result); tx.oncomplete = () => db.close(); }; r.onerror = () => reject(r.error); }));
try {
  await page.goto(`${origin}/#invite=synthetic-invite`); await visible('#auth-form');
  assert.equal(new URL(page.url()).hash, ''); assert.match(await page.locator('#auth-submit').innerText(), /接受邀请/); await screenshot('01-invite-mobile');
  await page.fill('#username', 'test.friend'); await page.fill('#display-name', '测试朋友'); await page.fill('#password', 'Synthetic-password-61'); await page.click('#auth-submit'); await visible('#chat-app');
  await page.evaluate(() => navigator.serviceWorker.ready); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  check('invite fragment consumed, account form and first login');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  check('390px layout has no horizontal overflow');
  const hostile = '<img src=x onerror="window.syntheticXss=true"><script>window.syntheticXss=true</script>';
  model.messages.push({ id: randomUUID(), seq: 1, direction: 'outbound', text: hostile, mediaIds: [], replyTo: null, createdAt: new Date().toISOString() }); changed();
  await page.getByText(hostile, { exact: true }).waitFor(); assert.equal(await page.evaluate(() => window.syntheticXss), undefined); assert.equal(await page.locator('#messages script').count(), 0);
  check('untrusted message text renders without HTML execution');
  model.faultNextMessage = true; await page.fill('#composer', '这是一条合成的断线重试消息'); await page.click('#send-button');
  await visible('#pending-messages .delivery-state.failed'); assert.equal(await page.getByRole('button', { name: '修改后再发', exact: true }).count(), 0);
  const originalClientId = model.posts.at(-1).clientMessageId; await page.getByRole('button', { name: '重试', exact: true }).click(); await hidden('#pending-messages .message');
  assert.equal(model.posts.at(-1).clientMessageId, originalClientId); assert.equal(model.messages.filter(m => m.clientMessageId === originalClientId).length, 1);
  check('unknown HTTP result retries the same stable ID without duplicate acceptance');
  await page.locator('#messages .message').first().getByRole('button', { name: '引用' }).click(); await visible('#reply-preview');
  await page.setInputFiles('#file-input', { name: 'synthetic.png', mimeType: 'image/png', buffer: await readFile(path.join(publicDir, 'icon-192.png')) }); await visible('#attachments img');
  await page.fill('#composer', '带图片和引用的合成消息'); await page.click('#send-button'); await hidden('#pending-messages .message');
  assert.equal(model.posts.at(-1).replyTo, model.messages[0].id); assert.deepEqual(model.posts.at(-1).mediaIds, [mediaId]);
  await page.waitForFunction(() => [...document.querySelectorAll('#messages img')].every(img => img.complete && img.naturalWidth > 0)); await screenshot('02-chat-mobile');
  check('image upload, authorized media URL, quote and send');
  await page.click('#settings-open'); await page.click('#legacy-open'); await visible('#legacy-records .legacy-record');
  assert.match(await page.locator('#legacy-dialog').innerText(), /并非完整 QQ/); assert.equal(await page.locator('#legacy-records img, #legacy-records button, #legacy-records script').count(), 0); assert.equal(await page.evaluate(() => window.syntheticXss), undefined);
  await page.click('#legacy-more'); await page.getByText('更早的合成 QQ 原文', { exact: true }).waitFor(); assert.equal(await page.locator('#legacy-records .legacy-record').count(), 2); assert.equal(await page.locator('#legacy-more').isVisible(), false); await screenshot('02a-legacy-records-mobile'); await page.click('#legacy-close');
  check('raw retained QQ history loads on demand with opaque paging and safe text only');
  await context.setOffline(true); await page.fill('#composer', '离线待发仍使用原来的编号'); await page.click('#send-button'); await visible('#pending-messages .message');
  await page.fill('#composer', '这份未发送草稿会在更新后保留'); await page.waitForTimeout(300);
  const offlineDrafts = await draft(); const pendingId = offlineDrafts[0].pending[0].clientMessageId; const postsBefore = model.posts.length;
  model.readOnly = true; await context.setOffline(false); await page.evaluate(() => dispatchEvent(new Event('online'))); await page.waitForFunction(() => document.getElementById('composer').disabled);
  assert.match(await page.locator('#account-pending').innerText(), /只读维护/); assert.equal(model.posts.length, postsBefore); assert.ok(await page.locator('#messages .message').count()); assert.equal((await draft())[0].pending[0].clientMessageId, pendingId); await screenshot('03-readonly-mobile');
  check('read-only resume displays history and retains draft plus pending ID');
  model.swVersion = 2; await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update()); await visible('#update-banner');
  await page.evaluate(() => { window.syntheticOriginalIdbOpen = indexedDB.open; indexedDB.open = () => { throw new DOMException('Synthetic storage denial', 'SecurityError'); }; });
  await page.click('#update-now'); await page.getByText('草稿暂时无法保存，请允许网站储存后再更新。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting), true);
  await page.evaluate(() => { indexedDB.open = window.syntheticOriginalIdbOpen; delete window.syntheticOriginalIdbOpen; });
  check('service worker update is blocked when saving the private draft fails');
  const navigation = page.waitForEvent('load'); await page.click('#update-now'); await navigation; await visible('#chat-app');
  assert.equal(await page.inputValue('#composer'), '这份未发送草稿会在更新后保留'); assert.equal((await draft())[0].pending[0].clientMessageId, pendingId); assert.equal(model.posts.length, postsBefore);
  check('waiting service worker activates only on click and preserves private draft');
  const cachedUrls = await page.evaluate(async () => { const urls = []; for (const key of await caches.keys()) for (const request of await (await caches.open(key)).keys()) urls.push(new URL(request.url).pathname); return urls; });
  assert.ok(cachedUrls.length > 0); assert.ok(cachedUrls.every(p => !p.startsWith('/api/') && p !== '/' && !p.endsWith('.html')));
  check('service worker cache contains public assets only', { cachedUrls: [...new Set(cachedUrls)] });
  await page.evaluate(() => { document.getElementById('chat-app').hidden = true; dispatchEvent(new Event('pageshow')); });
  model.loggedIn = false; await page.evaluate(() => dispatchEvent(new Event('online'))); await visible('#auth-form'); assert.equal(await page.locator('#messages .message').count(), 0);
  check('revoked session hides and clears private DOM before login');
  await page.goto(`${origin}/#reset=synthetic-reset`); await page.waitForFunction(() => !location.hash && document.getElementById('username-field').hidden && !document.getElementById('auth-form').hidden); assert.equal(new URL(page.url()).hash, ''); assert.equal(await page.locator('#username-field').isVisible(), false);
  await page.fill('#password', 'New-synthetic-password-61'); await page.click('#auth-submit'); await page.getByText('密码已更新，请用新密码登录。', { exact: true }).waitFor(); assert.deepEqual(model.resetTokens, ['synthetic-reset']); await screenshot('04-reset-login-mobile');
  check('reset fragment updates password and returns to login without auto-auth');
  model.readOnly = false; await page.fill('#username', 'test.friend'); await page.fill('#password', 'New-synthetic-password-61'); await page.click('#auth-submit'); await visible('#chat-app');
  await page.fill('#composer', '退出将清除的本机草稿'); await page.waitForTimeout(300); await page.click('#settings-open'); await visible('#settings-dialog'); await screenshot('05-settings-mobile'); await page.click('#logout-button'); await page.getByText('已退出登录。', { exact: true }).waitFor();
  assert.deepEqual(await draft(), []); assert.equal(await page.locator('#messages .message').count(), 0); assert.equal(await page.locator('#legacy-records .legacy-record').count(), 0); assert.equal(await page.evaluate(() => localStorage.getItem('zhiwei-logout-pending')), null);
  check('logout revokes server session and clears DOM, pending and local drafts');
  assert.equal(model.requests.some(r => /synthetic-invite|synthetic-reset/.test(r.path)), false); assert.deepEqual(errors, []); assert.equal(model.serverError, undefined);
  check('no fragment secrets in HTTP request paths and no page exceptions');
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, scope: 'Linux Chromium with synthetic HTTP backend; not real iPhone or production integration', checks }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: true, checks: checks.length, output }) + '\n');
} catch (error) {
  await screenshot('failure').catch(() => {});
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: false, checks, error: error.stack, pageErrors: errors, serverError: model.serverError }, null, 2) + '\n');
  throw error;
} finally { await context.close(); await browser.close(); for (const res of streams) res.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
