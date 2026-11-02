import { randomBytes, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import { buildLifeObserverReport } from './life-observer.js';

const assets = new Set(['/life-observer.html', '/life-observer.js', '/life-observer.css']);
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(body));
  return true;
}

// This is a developer surface within the local OS / authenticated SSH boundary,
// not an Internet login system. Reverse-proxy exposure is deliberately rejected.
function trustedLocalRequest(req) {
  if (!loopback.has(req.socket?.remoteAddress)) return false;
  if (Object.keys(req.headers).some(key => key.toLowerCase() === 'forwarded' || key.toLowerCase().startsWith('x-forwarded-'))) return false;
  const host = req.headers.host;
  if (typeof host !== 'string' || !/^(?:localhost|127\.0\.0\.1)(?::[1-9]\d{0,4})?$/.test(host)) return false;
  const port = host.includes(':') ? Number(host.split(':')[1]) : 80;
  // An SSH local forward may expose a different local port from the Hub port.
  if (port > 65535) return false;
  const origin = req.headers.origin;
  if (origin != null && origin !== `http://${host}`) return false;
  const site = req.headers['sec-fetch-site'];
  return site == null || site === 'same-origin' || site === 'none';
}

function sameOriginClient(req) {
  return req.headers['x-life-observer-client'] === 'developer'
    && (req.headers['sec-fetch-site'] === 'same-origin' || req.headers.origin === `http://${req.headers.host}`);
}

/** No timer, writer, model, recovery, or filesystem dependency. */
export function createLifeObserverHttp({ readSnapshot, now = Date.now, buildReport = buildLifeObserverReport } = {}) {
  if (typeof readSnapshot !== 'function' || typeof now !== 'function' || typeof buildReport !== 'function') throw TypeError('Observer needs a snapshot reader');
  const token = randomBytes(32).toString('hex');
  function validToken(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  }
  return function handleLifeObserver(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
    // Match aliases which the shared static server would decode or normalize,
    // including case/trailing-dot aliases on Windows. Only canonical URLs pass.
    const rawPath = String(req.url).split('?')[0];
    let staticPath;
    try { staticPath = posix.normalize(decodeURIComponent(rawPath).replaceAll('\\', '/'))
      .split('/').map(part => part.replace(/[. ]+$/, '')).join('/').toLowerCase(); }
    catch { staticPath = ''; }
    const asset = assets.has(staticPath);
    const api = url.pathname === '/api/life-observer' || url.pathname.startsWith('/api/life-observer/');
    if (!api && !asset) return false;
    if (!trustedLocalRequest(req)) return send(res, 403, { error: '仅允许本机或可信 SSH 隧道访问观察界面。' });
    if (req.method !== 'GET') return send(res, 405, { error: '观察界面仅支持读取。' });
    if (!api) {
      if (rawPath !== staticPath || url.search) return send(res, 400, { error: '请使用观察页面的标准地址，不附加查询参数。' });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      return false; // Let the existing static file server serve these public assets.
    }
    if (!sameOriginClient(req)) return send(res, 403, { error: '请从本机观察页面打开报告。' });
    if (url.pathname === '/api/life-observer/session') {
      if (url.search) return send(res, 400, { error: '会话入口不接受查询参数。' });
      return send(res, 200, { token, scope: 'public' });
    }
    if (!validToken(req.headers['x-life-observer-token'])) return send(res, 401, { error: '观察会话已失效，请刷新页面。' });
    if (url.pathname !== '/api/life-observer/report') return send(res, 404, { error: '未找到观察入口。' });
    const keys = [...url.searchParams.keys()];
    const date = url.searchParams.get('date') ?? undefined;
    const rawDays = url.searchParams.get('days');
    const at = now(), days = rawDays == null ? 7 : Number(rawDays);
    if (keys.some(key => !['date', 'days'].includes(key)) || new Set(keys).size !== keys.length
      || (rawDays != null && !['1', '7'].includes(rawDays))
      || (date != null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date
        || date > new Date(at + 8 * 3600000).toISOString().slice(0, 10)
        || Date.parse(`${date}T00:00:00+08:00`) - (days - 1) * 86400000 < 0))) {
      return send(res, 400, { error: '请选择有效日期和一天或七天范围；只支持公共生活。' });
    }
    try {
      const captured = readSnapshot();
      const report = buildReport({ ...captured, at, date, days });
      return send(res, 200, report);
    } catch {
      // Do not expose raw persistence errors, paths, or private records.
      return send(res, 503, { error: '暂时无法读取已提交的生活快照，请稍后刷新。' });
    }
  };
}
