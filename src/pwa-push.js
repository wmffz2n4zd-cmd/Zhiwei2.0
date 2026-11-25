import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createHash, createECDH, ECDH, randomUUID } from 'node:crypto';
import * as webpush from 'web-push';

const PROVIDER_SUFFIX = '.push.apple.com';
const HOUR = 60 * 60 * 1000;
function invalid(code) { const error = new Error(code); error.code = code; return error; }
function canonicalBytes(value, length, code) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 128) throw invalid(code);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) throw invalid(code);
  return bytes;
}
export function validatePushSubscription(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('invalid_subscription');
  const endpoint = validateEndpointUrl(input.endpoint).href;
  const p256dh = canonicalBytes(input.keys?.p256dh, 65, 'invalid_push_key');
  if (p256dh[0] !== 4) throw invalid('invalid_push_key');
  try { ECDH.convertKey(p256dh, 'prime256v1', undefined, undefined, 'uncompressed'); } catch { throw invalid('invalid_push_key'); }
  canonicalBytes(input.keys?.auth, 16, 'invalid_push_auth');
  return { endpoint, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } };
}
function validateEndpointUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) throw invalid('invalid_push_endpoint');
  let url; try { url = new URL(value); } catch { throw invalid('invalid_push_endpoint'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !host.endsWith(PROVIDER_SUFFIX) || host.length <= PROVIDER_SUFFIX.length || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-')) || url.pathname === '/') throw invalid('unsupported_push_endpoint');
  return url;
}
export function isPublicPushAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%') || address.includes('.')) return false;
  const [left, right = ''] = address.toLowerCase().split('::');
  const before = left ? left.split(':') : []; const after = right ? right.split(':') : [];
  const words = [...before, ...Array(Math.max(0, 8 - before.length - after.length)).fill('0'), ...after].map(w => parseInt(w || '0', 16));
  if (words.length !== 8 || (words[0] & 0xe000) !== 0x2000) return false;
  // Reject transition/protocol assignments and documentation prefixes, not just RFC1918.
  if (words[0] === 0x2002 || (words[0] === 0x2001 && (words[1] <= 0x01ff || words[1] === 0x0db8)) || (words[0] === 0x3fff && words[1] < 0x1000)) return false;
  return true;
}
export async function validatePushEndpoint(endpoint, { lookup = dns.lookup } = {}) {
  const url = validateEndpointUrl(endpoint);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(a => !isPublicPushAddress(a.address) || net.isIP(a.address) !== a.family)) throw invalid('unsafe_push_dns');
  return { url, addresses };
}
function validateVapid(value) {
  if (!value || typeof value !== 'object') throw invalid('invalid_vapid_config');
  let subject; try { subject = new URL(value.subject); } catch { throw invalid('invalid_vapid_subject'); }
  if (!['https:', 'mailto:'].includes(subject.protocol) || subject.hostname === 'localhost' || subject.username || subject.password || subject.hash) throw invalid('invalid_vapid_subject');
  const privateKey = canonicalBytes(value.privateKey, 32, 'invalid_vapid_private_key');
  const publicKey = canonicalBytes(value.publicKey, 65, 'invalid_vapid_public_key');
  try { const curve = createECDH('prime256v1'); curve.setPrivateKey(privateKey); if (!curve.getPublicKey().equals(publicKey)) throw invalid('vapid_key_mismatch'); } catch { throw invalid('vapid_key_mismatch'); }
  return { subject: subject.href, publicKey: value.publicKey, privateKey: value.privateKey };
}
export async function loadOrCreateVapidConfig({ filePath, subject }) {
  if (!filePath || !path.isAbsolute(filePath)) throw invalid('vapid_path_required');
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const existing = validateVapid(JSON.parse(await fs.readFile(filePath, 'utf8')));
    await fs.chmod(filePath, 0o600); return existing;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const value = validateVapid({ subject, ...webpush.generateVAPIDKeys() });
  let handle;
  try { handle = await fs.open(filePath, 'wx', 0o600); await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; return validateVapid(JSON.parse(await fs.readFile(filePath, 'utf8'))); }
  finally { await handle?.close(); }
  return value;
}
async function atomicPrivateJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${randomUUID()}.tmp`; let handle;
  try { handle = await fs.open(temp, 'wx', 0o600); await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = null; await fs.rename(temp, filePath); await fs.chmod(filePath, 0o600); }
  catch (error) { await handle?.close(); await fs.unlink(temp).catch(() => {}); throw error; }
}
function epoch(value) { if (typeof value === 'number') return value; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; }
function stableTopic(job) { return createHash('sha256').update(String(job.userId)).update('\0').update(String(job.logicalReplyId || job.messageId || job.id)).digest('base64url').slice(0, 32); }
function safeReason(error) { const known = new Set(['invalid_subscription', 'invalid_push_key', 'invalid_push_auth', 'invalid_push_endpoint', 'unsupported_push_endpoint', 'unsafe_push_dns', 'response_too_large', 'push_timeout', 'ABORT_ERR', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']); return known.has(error?.code) ? error.code : 'push_transport_error'; }

export function sendPinnedPush(requestDetails, resolved, { timeoutMs = 15000, signal } = {}) {
  const { url, addresses } = resolved;
  validateEndpointUrl(url?.href);
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(a => !isPublicPushAddress(a.address) || net.isIP(a.address) !== a.family)) throw invalid('unsafe_push_dns');
  if (requestDetails.endpoint !== url.href || requestDetails.method !== 'POST') throw invalid('invalid_push_request');
  const agent = new https.Agent({ keepAlive: false, lookup(hostname, options, callback) {
    if (hostname !== url.hostname) return callback(invalid('unsafe_push_dns'));
    const selected = options?.family ? addresses.filter(a => a.family === options.family) : addresses;
    if (!selected.length) return callback(invalid('unsafe_push_dns'));
    if (options?.all) callback(null, selected); else callback(null, selected[0].address, selected[0].family);
  } });
  return new Promise((resolve, reject) => {
    let settled = false; let deadline;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(deadline); agent.destroy(); error ? reject(error) : resolve(value); };
    const request = https.request(url, { method: 'POST', headers: requestDetails.headers, agent, servername: url.hostname, signal }, response => {
      let bytes = 0; const chunks = [];
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 8192) { request.destroy(invalid('response_too_large')); return; } chunks.push(chunk); });
      response.on('error', error => finish(error));
      response.on('end', () => {
        let reason = ''; try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (typeof body.reason === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(body.reason)) reason = body.reason; } catch { /* Do not retain provider bodies. */ }
        const apnsId = response.headers['apns-id']; finish(null, { statusCode: response.statusCode, reason, apnsId: typeof apnsId === 'string' && /^[a-f0-9-]{1,64}$/i.test(apnsId) ? apnsId : null });
      });
    });
    deadline = setTimeout(() => request.destroy(invalid('push_timeout')), timeoutMs);
    request.on('error', error => finish(error)); request.end(requestDetails.body || null);
  });
}

export function createPwaPushWorker({ store, vapid, cachePath, intervalMs = 5000, leaseMs = 60000, maxAttempts = 6, now = Date.now, lookup = dns.lookup, transport = sendPinnedPush, onStatus = () => {} } = {}) {
  const keys = validateVapid(vapid); if (!store) throw invalid('push_store_required');
  if (cachePath && !path.isAbsolute(cachePath)) throw invalid('push_cache_path_required');
  let timer = null; let running = false; let active = null; let controller = null; let cache = null;
  const stats = { accepted: 0, retried: 0, failed: 0, cancelled: 0, expired: 0, lastRunAt: null, lastError: null };
  const update = (change) => { Object.assign(stats, change); onStatus({ ...stats }); };
  async function cachedHeaders(origin) {
    if (!cache) {
      cache = { version: 1, entries: {} };
      if (cachePath) { try { const saved = JSON.parse(await fs.readFile(cachePath, 'utf8')); if (saved.version !== 1 || !saved.entries || typeof saved.entries !== 'object') throw invalid('invalid_push_auth_cache'); cache = saved; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
    const key = createHash('sha256').update(origin).update('\0').update(keys.publicKey).digest('hex'); const entry = cache.entries[key]; const current = now();
    if (entry && typeof entry.authorization === 'string' && entry.createdAt <= current && current < entry.expiresAt - HOUR && current - entry.createdAt < 13 * HOUR) return { Authorization: entry.authorization };
    const expiresAt = current + 12 * HOUR;
    const headers = webpush.getVapidHeaders(origin, keys.subject, keys.publicKey, keys.privateKey, 'aes128gcm', Math.floor(expiresAt / 1000));
    cache.entries[key] = { authorization: headers.Authorization, createdAt: current, expiresAt };
    for (const [id, old] of Object.entries(cache.entries)) if (old.expiresAt < current || old.createdAt > current) delete cache.entries[id];
    if (cachePath) await atomicPrivateJson(cachePath, cache); return headers;
  }
  function complete(job, state, reason, extra = {}) { const result = store.finishPushJob(job.id, { state, reason, leaseToken: job.leaseToken, ...extra }); if (result?.ok !== false) stats[state]++; }
  function retry(job, reason, statusCode) {
    const attempt = Number(job.attempts) || 1; const delay = Math.min(30 * 60 * 1000, (statusCode === 429 ? 30000 : 5000) * (2 ** Math.min(attempt - 1, 8)));
    if (attempt >= maxAttempts) { complete(job, 'failed', reason, { statusCode }); return; }
    if (epoch(job.expiresAt) && now() + delay >= epoch(job.expiresAt)) { complete(job, 'expired', 'notification_expired'); return; }
    const result = store.retryPushJob(job.id, { nextAttemptAt: now() + delay, reason, statusCode, leaseToken: job.leaseToken }); if (result?.ok !== false) stats.retried++;
  }
  async function processJob(job) {
    if (epoch(job.expiresAt) && epoch(job.expiresAt) <= now()) { complete(job, 'expired', 'notification_expired'); return; }
    let subscription; let resolved;
    try { subscription = validatePushSubscription(job.subscription); resolved = await validatePushEndpoint(subscription.endpoint, { lookup }); }
    catch (error) { if (['invalid_subscription', 'invalid_push_key', 'invalid_push_auth', 'invalid_push_endpoint', 'unsupported_push_endpoint', 'unsafe_push_dns'].includes(error.code)) complete(job, 'failed', safeReason(error)); else retry(job, safeReason(error)); return; }
    if (controller.signal.aborted) { retry(job, 'worker_stopping'); return; }
    const auth = store.getPushAuthorization(job, now());
    if (!auth?.ok) { complete(job, auth?.reason === 'expired' ? 'expired' : 'cancelled', auth?.reason || 'authorization_revoked'); return; }
    const topic = stableTopic(job); const text = typeof job.text === 'string' ? job.text.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
    const payload = JSON.stringify({ messageId: job.messageId, seq: job.seq, tag: topic, body: job.preview && text ? text : '知微发来了新消息' });
    const remaining = epoch(job.expiresAt) ? Math.max(1, Math.ceil((epoch(job.expiresAt) - now()) / 1000)) : 3600;
    let result;
    try {
      const headers = await cachedHeaders(resolved.url.origin);
      const request = webpush.generateRequestDetails(subscription, payload, { vapidDetails: null, headers, TTL: Math.min(remaining, 86400), urgency: 'normal', contentEncoding: 'aes128gcm', topic });
      // The final gate runs after all asynchronous preparation and directly before transport.
      const finalAuth = store.getPushAuthorization(job, now());
      if (controller.signal.aborted) { retry(job, 'worker_stopping'); return; }
      if (!finalAuth?.ok) { complete(job, finalAuth?.reason === 'expired' ? 'expired' : 'cancelled', finalAuth?.reason || 'authorization_revoked'); return; }
      result = await transport(request, resolved, { timeoutMs: 15000, signal: controller.signal });
    } catch (error) { retry(job, safeReason(error)); return; }
    const code = Number(result.statusCode);
    if (code === 201) complete(job, 'accepted', 'push_service_accepted', { statusCode: code, apnsId: result.apnsId });
    else if (code === 410) { complete(job, 'failed', 'endpoint_expired', { statusCode: code }); store.invalidateSubscription(job.subscription.id, { reason: 'endpoint_expired', expectedAuthorizationVersion: job.subscription.authorizationVersion }); }
    else if (code === 429 || code >= 500) retry(job, code === 429 ? 'provider_rate_limited' : 'provider_unavailable', code);
    else complete(job, 'failed', code === 403 ? 'push_authentication_failed' : code === 404 ? 'push_path_invalid' : code >= 300 && code < 400 ? 'push_redirect_refused' : 'push_request_rejected', { statusCode: code });
  }
  async function runOnce() {
    if (active) return active;
    controller = new AbortController();
    active = (async () => {
      update({ lastRunAt: now(), lastError: null });
      // One job per lease keeps serial HTTPS work inside lease even on a slow provider.
      let processed = 0;
      while (processed < 10 && !controller.signal.aborted) {
        const jobs = store.claimPushJobs({ now: now(), limit: 1, leaseMs });
        if (!jobs?.length) break; await processJob(jobs[0]); processed++;
      }
      update({});
    })().catch(error => { update({ lastError: safeReason(error) }); }).finally(() => { active = null; controller = null; });
    return active;
  }
  function schedule() { if (!running) return; timer = setTimeout(async () => { await runOnce(); schedule(); }, intervalMs); timer.unref?.(); }
  return {
    start() { if (running) return; running = true; schedule(); },
    async stop() { running = false; clearTimeout(timer); timer = null; controller?.abort(); await active; },
    runOnce,
    status() { return { ...stats, running, processing: !!active }; },
  };
}
