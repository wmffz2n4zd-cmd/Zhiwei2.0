import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLifeObserverHttp } from '../src/life-observer-http.js';

const now = () => Date.parse('2026-10-30T04:00:00Z');
function request(url = '/api/life-observer/session', overrides = {}) {
  return { url, method: 'GET', socket: { remoteAddress: '127.0.0.1', localPort: 3789 },
    ...overrides, headers: { host: 'localhost:3789', 'sec-fetch-site': 'same-origin', 'x-life-observer-client': 'developer', ...overrides.headers } };
}
function call(handler, req) {
  const response = { headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    writeHead(status, headers) { this.status = status; for (const [key, value] of Object.entries(headers)) this.setHeader(key, value); },
    end(body) { this.body = JSON.parse(body); } };
  const handled = handler(req, response);
  return { handled, ...response };
}
function fixture(options = {}) {
  const reads = [], builds = [], captured = { snapshot: { marker: 'committed' }, diagnostics: {}, enabled: true };
  const handler = createLifeObserverHttp({ now, readSnapshot() { reads.push(true); return captured; },
    buildReport(value) { builds.push(value); return { scope: 'public', at: value.at, date: value.date, days: value.days }; }, ...options });
  const session = call(handler, request());
  const headers = { 'x-life-observer-token': session.body.token };
  return { handler, reads, builds, captured, session, headers };
}

test('observer session is per-process capability and never reads state', () => {
  const a = fixture(), b = fixture();
  assert.equal(a.session.status, 200); assert.match(a.session.body.token, /^[a-f0-9]{64}$/);
  assert.equal(a.session.body.scope, 'public'); assert.notEqual(a.session.body.token, b.session.body.token);
  assert.deepEqual(a.reads, []); assert.deepEqual(a.builds, []);
  assert.equal(a.session.headers['cache-control'], 'no-store'); assert.equal(a.session.headers['access-control-allow-origin'], undefined);
  assert.equal(call(b.handler, request('/api/life-observer/report', { headers: a.headers })).status, 401);
});

test('observer trust requires actual loopback, local host, same origin and no forwarded proxy headers', () => {
  const f = fixture();
  const denied = [
    { socket: { remoteAddress: '192.0.2.10' } }, { headers: { host: 'evil.example' } },
    { headers: { host: 'localhost.evil.example:3789' } }, { headers: { host: 'localhost:70000' } },
    { headers: { origin: 'https://evil.example' } }, { headers: { origin: 'http://localhost:1234' } },
    { headers: { 'sec-fetch-site': 'cross-site' } }, { headers: { 'sec-fetch-site': 'same-site' } },
    { headers: { forwarded: 'for=192.0.2.1' } }, { headers: { 'x-forwarded-for': '192.0.2.1' } },
    { headers: { 'x-forwarded-host': 'localhost:3789' } }, { headers: { 'sec-fetch-site': undefined } },
    { headers: { 'x-life-observer-client': undefined } }
  ];
  for (const overrides of denied) assert.equal(call(f.handler, request(undefined, overrides)).status, 403, JSON.stringify(overrides));
  assert.deepEqual(f.reads, []);
});

test('trusted SSH local forward can use a different port and exact-origin clients work', () => {
  const f = fixture();
  const forwardedPort = request(undefined, { headers: { host: 'localhost:33789', origin: 'http://localhost:33789', 'sec-fetch-site': undefined } });
  assert.equal(call(f.handler, forwardedPort).status, 200);
  for (const remoteAddress of ['::1', '::ffff:127.0.0.1']) assert.equal(call(f.handler, request(undefined, { socket: { remoteAddress } })).status, 200);
  assert.deepEqual(f.reads, []);
});

test('report tokens reject missing, malformed, Unicode and foreign capability without throwing', () => {
  const f = fixture();
  for (const value of [undefined, '', 'a'.repeat(63), '界'.repeat(64), '0'.repeat(64), ['a'.repeat(64)]]) {
    assert.equal(call(f.handler, request('/api/life-observer/report', { headers: { 'x-life-observer-token': value } })).status, 401);
  }
  assert.deepEqual(f.reads, []);
});

test('only GET and exact public report parameters are accepted before reading', () => {
  const f = fixture();
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) assert.equal(call(f.handler, request('/api/life-observer/report', { method, headers: f.headers })).status, 405);
  for (const query of ['scope=public', 'scope=qq%3Aprivate%3A1', 'days=0', 'days=2', 'days=01', 'days=7&days=1', 'date=2026-02-30', 'date=2026-10-31', 'date=1970-01-01', 'date=bad', 'token=secret']) {
    assert.equal(call(f.handler, request('/api/life-observer/report?' + query, { headers: f.headers })).status, 400, query);
  }
  assert.equal(call(f.handler, request('/api/life-observer/session?token=abc')).status, 400);
  assert.equal(call(f.handler, request('/api/life-observer/missing', { headers: f.headers })).status, 404);
  assert.deepEqual(f.reads, []);
});

test('report captures once and uses a fixed clock; repeated reads preserve the snapshot', () => {
  const f = fixture(), before = structuredClone(f.captured);
  const first = call(f.handler, request('/api/life-observer/report', { headers: f.headers }));
  const again = call(f.handler, request('/api/life-observer/report', { headers: f.headers }));
  assert.equal(first.status, 200); assert.deepEqual(first.body, again.body); assert.equal(f.reads.length, 2);
  assert.deepEqual(f.captured, before); assert.equal(f.builds[0].snapshot, f.captured.snapshot);
  assert.deepEqual(f.builds[0], { ...f.captured, at: now(), date: undefined, days: 7 });
  const daily = call(f.handler, request('/api/life-observer/report?days=1&date=2026-10-29', { headers: f.headers }));
  assert.equal(daily.body.date, '2026-10-29'); assert.equal(daily.body.days, 1); assert.equal(f.reads.length, 3);
});

test('real report marks disabled life as unknown counts without opening a writer', () => {
  let reads = 0;
  const handler = createLifeObserverHttp({ now, readSnapshot() { reads++; return { enabled: false }; } });
  const token = call(handler, request()).body.token;
  const report = call(handler, request('/api/life-observer/report?days=1', { headers: { 'x-life-observer-token': token } }));
  assert.equal(report.status, 200); assert.equal(report.body.completeness.status, 'disabled');
  assert.equal(report.body.counts.newThoughts, null); assert.equal(report.body.counts.completedActivities, null);
  assert.deepEqual(report.body.events, []); assert.equal(reads, 1);
});

test('observer assets enforce trust and CSP; API failure does not leak raw error data', () => {
  const f = fixture({ readSnapshot() { throw Error('secret-private-message-and-path'); } });
  assert.equal(call(f.handler, request('/unrelated')).handled, false);
  for (const path of ['/life-observer.html', '/life-observer.js', '/life-observer.css']) {
    const asset = call(f.handler, request(path, { headers: { 'sec-fetch-site': 'none', 'x-life-observer-client': undefined } }));
    assert.equal(asset.handled, false); assert.match(asset.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(call(f.handler, request(path, { headers: { 'x-forwarded-for': '192.0.2.1' } })).status, 403);
    assert.equal(call(f.handler, request(path, { method: 'POST' })).status, 405);
  }
  for (const path of ['/%6cife-observer.html', '//life-observer.html', '/./life-observer.html', '/%5clife-observer.html', '/LIFE-OBSERVER.HTML', '/life-observer.html.', '/life-observer.html%20']) {
    assert.equal(call(f.handler, request(path)).status, 400, path);
    assert.equal(call(f.handler, request(path, { headers: { 'x-forwarded-for': '192.0.2.1' } })).status, 403, path);
    assert.equal(call(f.handler, request(path, { socket: { remoteAddress: '192.0.2.10' } })).status, 403, path);
  }
  const failed = call(f.handler, request('/api/life-observer/report', { headers: f.headers }));
  assert.equal(failed.status, 503); assert.doesNotMatch(JSON.stringify(failed.body), /secret-private/);
});

test('observer page exports the displayed daily report and has no execution or HTML injection surface', async () => {
  const script = await readFile(new URL('../modules/web-console/public/life-observer.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../modules/web-console/public/life-observer.html', import.meta.url), 'utf8');
  assert.match(script, /JSON\.stringify\(currentReport, null, 2\)/);
  assert.match(script, /currentReport\.window\.days !== 1/);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|method:\s*['"]POST/);
  assert.doesNotMatch(page, /onclick=|onchange=|<script[^>]*>[\s\S]+?<\/script>/);
  assert.match(page, /id="download"[^>]*disabled/);
});
