import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import * as webpush from 'web-push';
import { validatePushSubscription, validatePushEndpoint, isPublicPushAddress, createPwaPushWorker, loadOrCreateVapidConfig } from '../src/pwa-push.js';

function subscription() { const curve = createECDH('prime256v1'); curve.generateKeys(); return { id: 'sub-1', authorizationVersion: 1, endpoint: 'https://web.push.apple.com/test-token', keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }; }
const vapid = () => ({ subject: 'https://example.com', ...webpush.generateVAPIDKeys() });
const lookup = async () => [{ address: '17.188.170.1', family: 4 }];
function job(overrides = {}) { return { id: 'job-1', userId: 'user-1', messageId: 'message-1', seq: 1, logicalReplyId: 'reply-1', createdAt: Date.now(), expiresAt: Date.now() + 86400000, attempts: 1, leaseToken: 'lease-1', subscription: subscription(), text: '私人正文', preview: false, ...overrides }; }
function fakeStore(jobs = []) {
  const result = { completed: [], retried: [], invalidated: [], claims: [], permitted: true, authCalls: 0 };
  result.claimPushJobs = options => { result.claims.push(options); return jobs.length ? [jobs.shift()] : []; };
  result.getPushAuthorization = () => { result.authCalls++; return { ok: result.permitted, reason: result.permitted ? null : 'authorization-revoked' }; };
  result.finishPushJob = (id, value) => { result.completed.push({ id, ...value }); return { ok: true }; };
  result.retryPushJob = (id, value) => { result.retried.push({ id, ...value }); return { ok: true }; };
  result.invalidateSubscription = (id, value) => result.invalidated.push({ id, ...value }); return result;
}
test('only canonical Apple HTTPS subscriptions and valid P-256 keys enter delivery', () => {
  const good = subscription(); assert.equal(validatePushSubscription(good).endpoint, good.endpoint);
  for (const endpoint of ['http://web.push.apple.com/t', 'https://push.apple.com/t', 'https://web.push.apple.com.evil.test/t', 'https://web.push.apple.com:8443/t', 'https://x@y.push.apple.com/t', 'https://web.push.apple.com/t#secret', 'https://127.0.0.1/t', 'https://.push.apple.com/t']) assert.throws(() => validatePushSubscription({ ...good, endpoint }));
  assert.throws(() => validatePushSubscription({ ...good, keys: { ...good.keys, auth: good.keys.auth + '=' } }));
  assert.throws(() => validatePushSubscription({ ...good, keys: { ...good.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') } }));
});
test('DNS resolution rejects every private/special address including mixed answers', async () => {
  for (const ip of ['127.0.0.1', '10.1.1.1', '100.64.0.1', '169.254.1.1', '172.31.0.1', '192.168.1.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1']) assert.equal(isPublicPushAddress(ip), false, ip);
  assert.equal(isPublicPushAddress('17.188.170.1'), true); assert.equal(isPublicPushAddress('2620:149:a44:101::1'), true);
  await assert.rejects(validatePushEndpoint(subscription().endpoint, { lookup: async () => [{ address: '17.188.170.1', family: 4 }, { address: '127.0.0.1', family: 4 }] }), { code: 'unsafe_push_dns' });
  assert.equal((await validatePushEndpoint(subscription().endpoint, { lookup })).addresses.length, 1);
});
test('revocation while DNS is awaiting prevents any transport and preserves lease CAS', async () => {
  const j = job(); const store = fakeStore([j]); let sent = 0;
  const worker = createPwaPushWorker({ store, vapid: vapid(), lookup: async () => { store.permitted = false; return lookup(); }, transport: async () => { sent++; return { statusCode: 201 }; } });
  await worker.runOnce(); assert.equal(sent, 0); assert.equal(store.completed[0].state, 'cancelled'); assert.equal(store.completed[0].leaseToken, j.leaseToken);
});
test('final authorization check runs after JWT preparation and before transport', async () => {
  const store = fakeStore([job()]); let sent = 0; store.getPushAuthorization = () => ({ ok: ++store.authCalls === 1, reason: 'revoked-late' });
  await createPwaPushWorker({ store, vapid: vapid(), lookup, transport: async () => { sent++; return { statusCode: 201 }; } }).runOnce();
  assert.equal(sent, 0); assert.equal(store.authCalls, 2); assert.equal(store.completed[0].state, 'cancelled');
});
test('shutdown at the final preflight preserves the job for the next worker', async () => {
  const store = fakeStore([job()]); let worker; let sent = 0;
  store.getPushAuthorization = () => { if (++store.authCalls === 2) void worker.stop(); return { ok: true }; };
  worker = createPwaPushWorker({ store, vapid: vapid(), lookup, transport: async () => { sent++; return { statusCode: 201 }; } });
  await worker.runOnce(); assert.equal(sent, 0); assert.equal(store.completed.length, 0); assert.equal(store.retried[0].reason, 'worker_stopping');
});
test('201 accepts only the notification job with encrypted payload and stable coalescing', async () => {
  const j = job(); const store = fakeStore([j]); let captured;
  await createPwaPushWorker({ store, vapid: vapid(), lookup, transport: async request => { captured = request; return { statusCode: 201, apnsId: '12345678-abcd' }; } }).runOnce();
  assert.equal(store.completed[0].state, 'accepted'); assert.equal(store.completed[0].apnsId, '12345678-abcd');
  assert.equal(captured.headers['Content-Encoding'], 'aes128gcm'); assert.equal(captured.headers.Topic.length, 32); assert.equal(captured.method, 'POST'); assert.ok(captured.headers.Authorization.startsWith('vapid ')); assert.ok(Buffer.isBuffer(captured.body)); assert.equal(captured.body.includes(Buffer.from('私人正文')), false);
});
test('404 is a failed path while 410 invalidates only its subscription', async () => {
  for (const statusCode of [404, 410]) { const store = fakeStore([job()]); await createPwaPushWorker({ store, vapid: vapid(), lookup, transport: async () => ({ statusCode }) }).runOnce(); assert.equal(store.completed[0].state, 'failed'); assert.equal(store.completed[0].reason, statusCode === 404 ? 'push_path_invalid' : 'endpoint_expired'); assert.equal(store.invalidated.length, statusCode === 410 ? 1 : 0); if (statusCode === 410) assert.equal(store.invalidated[0].expectedAuthorizationVersion, 1); }
});
test('a stale in-flight 410 cannot invalidate a newly rebound subscription version', async () => {
  const j = job(); const store = fakeStore([j]); let currentVersion = 1; let enabled = true;
  store.finishPushJob = () => ({ ok: false }); // Rebinding has already cancelled the old job.
  store.invalidateSubscription = (id, value) => {
    store.invalidated.push({ id, ...value });
    if (value.expectedAuthorizationVersion !== currentVersion) return { ok: false };
    enabled = false; return { ok: true };
  };
  const worker = createPwaPushWorker({ store, vapid: vapid(), lookup, transport: async () => { currentVersion = 2; return { statusCode: 410 }; } });
  await worker.runOnce();
  assert.equal(store.invalidated[0].id, j.subscription.id); assert.equal(store.invalidated[0].expectedAuthorizationVersion, 1);
  assert.equal(enabled, true); assert.equal(worker.status().failed, 0);
});
test('redirect/auth/payload failures never follow arbitrary targets or retry indefinitely', async () => {
  for (const statusCode of [302, 403, 413]) { const store = fakeStore([job()]); let sends = 0; await createPwaPushWorker({ store, vapid: vapid(), lookup, transport: async () => { sends++; return { statusCode }; } }).runOnce(); assert.equal(sends, 1); assert.equal(store.completed[0].state, 'failed'); assert.equal(store.retried.length, 0); assert.equal(store.invalidated.length, 0); }
});
test('temporary errors retry only notifications with bounded attempts and no raw provider data', async () => {
  const store = fakeStore([job()]); await createPwaPushWorker({ store, vapid: vapid(), lookup, transport: async () => ({ statusCode: 429, reason: 'secret-token' }) }).runOnce();
  assert.equal(store.retried.length, 1); assert.ok(store.retried[0].nextAttemptAt > Date.now()); assert.equal(store.retried[0].reason, 'provider_rate_limited');
  const final = fakeStore([job({ attempts: 6 })]); await createPwaPushWorker({ store: final, vapid: vapid(), lookup, transport: async () => ({ statusCode: 503 }) }).runOnce(); assert.equal(final.completed[0].state, 'failed'); assert.equal(final.retried.length, 0);
});
test('expired jobs never reach DNS or the push service', async () => {
  const store = fakeStore([job({ expiresAt: Date.now() - 1 })]); let dnsCalls = 0; await createPwaPushWorker({ store, vapid: vapid(), lookup: async () => { dnsCalls++; return lookup(); }, transport: async () => { throw new Error('must_not_send'); } }).runOnce(); assert.equal(dnsCalls, 0); assert.equal(store.completed[0].state, 'expired');
});
test('VAPID keys and JWT survive restart without refreshing every message', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pwa-push-'));
  try {
    const filePath = path.join(dir, 'vapid.json'); const keys = await loadOrCreateVapidConfig({ filePath, subject: 'https://example.com' }); const second = await loadOrCreateVapidConfig({ filePath, subject: 'https://other.invalid' }); assert.deepEqual(second, keys); assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    const cachePath = path.join(dir, 'auth.json'); const headers = [];
    for (let i = 0; i < 2; i++) { const store = fakeStore([job({ id: `job-${i}` })]); const worker = createPwaPushWorker({ store, vapid: keys, cachePath, lookup, transport: async request => { headers.push(request.headers.Authorization); return { statusCode: 201 }; } }); await worker.runOnce(); await worker.stop(); }
    assert.equal(headers[0], headers[1]); assert.equal((await stat(cachePath)).mode & 0o777, 0o600); const stored = JSON.parse(await readFile(cachePath, 'utf8')); assert.equal(Object.keys(stored.entries).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('runOnce serializes overlapping polls and stop cancels the active request', async () => {
  const store = fakeStore([job()]); let entered; const started = new Promise(resolve => { entered = resolve; }); let sends = 0;
  const worker = createPwaPushWorker({ store, vapid: vapid(), lookup, transport: async (_request, _resolved, { signal }) => new Promise((_resolve, reject) => { sends++; entered(); signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'ABORT_ERR' })), { once: true }); }) });
  const first = worker.runOnce(); const second = worker.runOnce(); await started; await worker.stop(); await Promise.all([first, second]); assert.equal(sends, 1); assert.equal(store.retried.length, 1); assert.equal(worker.status().processing, false);
});
