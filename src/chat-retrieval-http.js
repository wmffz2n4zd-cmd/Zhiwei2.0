import http from 'node:http';
import https from 'node:https';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { checkReadRequest } from './browser-reader.js';
import { isRetiredSearchUrl } from './search-destinations.js';

const fail = code => Object.assign(new Error('Anonymous public retrieval unavailable.'), { code });
const cancelled = () => fail('REPLY_SUPERSEDED');
const control = /[\u0000-\u001f\u007f]/;
const MAX_BODY = 1024 * 1024, MAX_TOTAL = 3 * 1024 * 1024, TIMEOUT_MS = 15000;
const FEEDS = Object.freeze([
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://feeds.bbci.co.uk/news/technology/rss.xml'
]);
const TRACKING = /^(?:utm_[a-z_]+|fbclid|gclid|msclkid|ref|referrer|source|spm|at_medium|at_campaign)$/i;
const PUBLIC_PARAMETERS = /^(?:id|p|page|v|lang|language|article|story|newsid)$/i;
const hash = value => createHash('sha256').update(value).digest('hex');

export function isPublicAddress(address) {
  const ip = String(address || '').toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(ip) !== 6 || ip.includes('.') || ip.includes('%')) return false;
  // Accept only global-unicast 2000::/3, excluding transition, protocol and
  // documentation ranges. This also rejects mapped, NAT64, ULA and link-local.
  const first = parseInt(ip.split(':')[0], 16), second = parseInt(ip.split(':')[1] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && !(first === 0x2001 && second <= 0x1ff)
    && !(first === 0x2001 && second === 0xdb8) && first !== 0x2002 && first !== 0x3fff;
}

export function publicHttpUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || control.test(value)) throw fail('UNSAFE_URL');
  let url; try { url = new URL(value); } catch { throw fail('UNSAFE_URL'); }
  if (isRetiredSearchUrl(url)) throw fail('UNSAFE_URL');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isIP(host)
    || !host.includes('.') || host.endsWith('.') || !/^[a-z0-9.-]+$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|onion|home|lan)$/.test(host)
    || (url.port && !['80', '443'].includes(url.port))) throw fail('UNSAFE_URL');
  url.hash = '';
  for (const [key, value] of [...url.searchParams]) {
    if (TRACKING.test(key)) { url.searchParams.delete(key); continue; }
    if (!PUBLIC_PARAMETERS.test(key) || value.length > 160 || !/^[\p{L}\p{N}_.~-]+$/u.test(value)) throw fail('UNSAFE_URL');
  }
  return url;
}

const actionPath = /(?:^|\/)(?:login|log-in|signin|sign-in|logout|oauth|authorize|callback|reset|verify|unsubscribe|delete|remove|confirm|token|invite)(?:\/|$)/i;
function readOnlyPath(url) {
  return !/%(?:2f|5c|25)/i.test(url.pathname) && !actionPath.test(decodeURIComponent(url.pathname));
}
export function publicPageLink(value, { observed = false } = {}) {
  try {
    if (observed) checkReadRequest(value);
    const raw = new URL(value);
    if (raw.search || !readOnlyPath(raw)) return null;
    return publicHttpUrl(value).href;
  } catch { return null; }
}

async function resolvePublic(hostname, signal) {
  if (signal.aborted) throw cancelled();
  const resolver = new Resolver({ timeout: 2500, tries: 1 });
  const abort = () => resolver.cancel(); signal.addEventListener('abort', abort, { once: true });
  try {
    const resolved = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    if (signal.aborted) throw cancelled();
    const records = resolved.flatMap((item, i) => item.status === 'fulfilled' ? item.value.map(address => ({ address, family: i ? 6 : 4 })) : []);
    if (!records.length || records.some(row => !isPublicAddress(row.address))) throw fail('UNSAFE_DNS');
    return records;
  } finally { signal.removeEventListener('abort', abort); }
}

function requestPinned(url, pin, { signal, maxBytes, metrics, requestImpl }) {
  return new Promise((resolve, reject) => {
    let request, response, result, failure, complete = false;
    const chunks = []; let length = 0;
    const abort = () => { failure ||= cancelled(); response?.destroy(failure); request?.destroy(failure); };
    const finish = () => {
      if (complete) return; complete = true; signal.removeEventListener('abort', abort);
      if (failure) reject(failure); else if (result) resolve(result); else reject(fail('INCOMPLETE_BODY'));
    };
    if (signal.aborted) { reject(cancelled()); return; }
    try {
      const send = requestImpl || (url.protocol === 'https:' ? https.request : http.request);
      request = send(url, {
        method: 'GET', agent: false, servername: url.hostname, rejectUnauthorized: true,
        headers: { 'user-agent': 'Zhiwei-PublicReader/1.0', accept: 'text/html,application/xhtml+xml,application/rss+xml,application/xml,text/xml,text/plain;q=0.8', 'accept-encoding': 'identity' },
        lookup(_host, options, callback) { callback(null, options.all ? [pin] : pin.address, pin.family); }
      }, incoming => {
        response = incoming;
        incoming.on('error', caught => { failure ||= caught; request.destroy(caught); });
        incoming.on('aborted', () => { failure ||= fail('INCOMPLETE_BODY'); });
        const contentLength = Number(incoming.headers['content-length']);
        if ((Number.isFinite(contentLength) && contentLength > maxBytes) || !['', 'identity'].includes(String(incoming.headers['content-encoding'] || '').toLowerCase())) {
          failure = fail('RESPONSE_TOO_LARGE_OR_ENCODED'); incoming.destroy(failure); request.destroy(failure); return;
        }
        incoming.on('data', chunk => {
          length += chunk.length; metrics.bytes += chunk.length;
          if (length > maxBytes || metrics.bytes > MAX_TOTAL) { failure = fail('RESPONSE_TOO_LARGE'); incoming.destroy(failure); request.destroy(failure); }
          else chunks.push(chunk);
        });
        incoming.on('end', () => { result = { status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8'), url: url.href }; });
      });
      request.on('error', caught => { failure ||= caught; });
      // Resolve/reject only after the owned socket/request is closed. The caller
      // must not replace a cancelled reply while its network work is still live.
      request.on('close', finish);
      signal.addEventListener('abort', abort, { once: true });
      request.end();
      if (signal.aborted) abort();
    } catch (caught) { failure = caught; if (request) request.destroy(caught); else finish(); }
  });
}

export function createAnonymousHttpClient({ resolveAddresses = resolvePublic, requestImpl = null } = {}) {
  if (typeof resolveAddresses !== 'function' || (requestImpl !== null && typeof requestImpl !== 'function')) throw TypeError('Invalid anonymous transport');
  return async function read(value, { signal, metrics, maxBytes = MAX_BODY, followRedirects = true, article = false } = {}) {
    if (!signal || !metrics || typeof metrics.requests !== 'number') throw TypeError('Transport requires owned task context');
    let url = publicHttpUrl(value);
    for (let hop = 0; hop <= 3; hop++) {
      if (signal.aborted) throw cancelled();
      if (metrics.requests >= 8) throw fail('REQUEST_LIMIT');
      metrics.dnsResolutions++;
      const answers = await resolveAddresses(url.hostname, signal);
      if (signal.aborted) throw cancelled();
      if (!Array.isArray(answers) || !answers.length || answers.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) throw fail('UNSAFE_DNS');
      const pin = answers.find(item => item.family === 4) || answers[0];
      metrics.requests++;
      const response = await requestPinned(url, pin, { signal, metrics, maxBytes, requestImpl });
      if (signal.aborted) throw cancelled();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!followRedirects) throw fail('UNAPPROVED_REDIRECT');
        if (hop === 3 || !response.headers.location) throw fail('REDIRECT_LIMIT');
        const next = publicHttpUrl(new URL(response.headers.location, url).href);
        if (article && !readOnlyPath(next)) throw fail(/(?:^|\/)(?:login|log-in|signin|sign-in)(?:\/|$)/i.test(decodeURIComponent(next.pathname)) ? 'PUBLIC_LOGIN_REQUIRED' : 'UNSAFE_URL');
        if (article) checkReadRequest(next.href);
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw fail('UNSAFE_REDIRECT');
        metrics.redirects++; url = next; continue;
      }
      return response;
    }
    throw fail('REDIRECT_LIMIT');
  };
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
export function decodeHtml(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? whole;
    const code = parseInt(entity.slice(entity[1]?.toLowerCase() === 'x' ? 2 : 1), entity[1]?.toLowerCase() === 'x' ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}
const clean = (value, limit = 12000) => decodeHtml(String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<(script|style|noscript|svg|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<!--[^]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, limit);
const tag = (value, name) => value.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'))?.[1] || '';
const sourceUrl = value => { try { return publicHttpUrl(decodeHtml(value.trim())).href; } catch { return null; } };
const date = value => {
  const timestamp = Date.parse(clean(value, 100));
  return Number.isFinite(timestamp) && timestamp >= 0 ? new Date(timestamp).toISOString() : null;
};
const loginPage = response => response.status === 401
  || /<title[^>]*>\s*(?:sign in|log in|login|登录)(?:\s*[|–—:-]|\s*<)/i.test(response.body.slice(0, 12000))
  || /^\s*(?:please (?:sign|log) in|(?:sign|log) in to (?:continue|view)|请先登录|登录后(?:查看|继续))/i.test(clean(tag(response.body, 'main') || tag(response.body, 'body') || response.body, 180));
const restricted = response => loginPage(response) || [403, 407, 429].includes(response.status)
  || /(?:anomaly\.js|id=["']challenge-form|cf-chl-|class=["'][^"']*g-recaptcha|<title[^>]*>\s*(?:access denied|just a moment|captcha)|verify (?:that )?you are human)/i.test(response.body.slice(0, 8000));
const htmlType = response => {
  const type = String(response.headers['content-type'] || ''), charset = type.match(/(?:^|;)\s*charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  return (!charset || /^(?:utf-?8|us-ascii)$/i.test(charset))
    && /^(?:text\/(?:html|plain|xml)|application\/(?:xhtml\+xml|rss\+xml|atom\+xml|xml))(?:\s*;|$)/i.test(type);
};

export function parseRss(body, provider) {
  const rows = [], seen = new Set();
  for (const match of String(body).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    const part = match[1], url = sourceUrl(tag(part, 'link')), title = clean(tag(part, 'title'), 300), text = clean(tag(part, 'description'));
    if (!url || !title || seen.has(url)) continue; seen.add(url);
    rows.push({ provider, url, title, text: text || title, capture: 'search_snippet', publishedAt: provider === 'bbc-public-feed' ? date(tag(part, 'pubDate')) : null, updatedAt: null, eventAt: null });
    if (rows.length >= 40) break;
  }
  return rows;
}

function pageDate(body, names) {
  for (const match of body.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = Object.fromEntries([...match[0].matchAll(/([a-z_:.-]+)\s*=\s*["']([^"']*)["']/gi)].map(row => [row[1].toLowerCase(), decodeHtml(row[2])]));
    if (names.includes((attrs.property || attrs.name || attrs.itemprop || '').toLowerCase())) { const parsed = date(attrs.content); if (parsed) return parsed; }
  }
  return null;
}
export function parsePublicPage(response, prior) {
  if (restricted(response) || response.status < 200 || response.status >= 300 || !htmlType(response)) return null;
  const body = response.body, main = tag(body, 'article') || tag(body, 'main') || tag(body, 'body') || body;
  const text = clean(main);
  if (text.length < 80 || /^(?:enable javascript|please sign in|sign in to continue|log in to continue)/i.test(text)) return null;
  return { provider: prior.provider, url: sourceUrl(response.url) || prior.url, requestedUrl: prior.url, title: clean(tag(body, 'title'), 300) || prior.title,
    text, capture: 'page_excerpt', publishedAt: pageDate(body, ['article:published_time', 'datepublished', 'pubdate']) || prior.publishedAt || null,
    updatedAt: pageDate(body, ['article:modified_time', 'datemodified', 'last-modified']), eventAt: null, sourceVersion: hash(text) };
}

function taskContext(signal, timeoutMs) {
  const controller = new AbortController(), start = Date.now(), abort = () => controller.abort();
  let timedOut = false;
  if (signal?.aborted) controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); timer.unref?.();
  const metrics = { requests: 0, searchRequests: 0, pageRequests: 0, feedRequests: 0, dnsResolutions: 0, redirects: 0, bytes: 0, durationMs: 0, timedOut: false, providerFee: null };
  return { controller, metrics, finish() { clearTimeout(timer); signal?.removeEventListener('abort', abort); metrics.durationMs = Date.now() - start; metrics.timedOut = timedOut; return { ...metrics }; }, timedOut: () => timedOut };
}

// A public topic is read in the dedicated Xiaohongshu session. Explicit
// article URLs still go exclusively through the anonymous HTTP transport.
export function createChatLookupAdapter({ httpClient = createAnonymousHttpClient(), searchPublicNotes = null, renderPage = null,
  timeoutMs = TIMEOUT_MS, searchTimeoutMs = 90000, onMetrics = null } = {}) {
  if (typeof httpClient !== 'function' || (searchPublicNotes !== null && typeof searchPublicNotes !== 'function')
    || (renderPage !== null && typeof renderPage !== 'function') || ![timeoutMs, searchTimeoutMs].every(ms => Number.isSafeInteger(ms) && ms >= 1 && ms <= 120000)) throw TypeError('Invalid chat adapter');
  const counters = { attempts: 0, requests: 0, searchRequests: 0, pageRequests: 0, bytes: 0, cancelled: 0, failed: 0 };
  const adapter = async ({ query, freshness, url: directUrl }, { signal } = {}) => {
    if (typeof query !== 'string' || !query || query.length > 300 || control.test(query) || !['current', 'latest'].includes(freshness)) throw fail('INVALID_PUBLIC_QUERY');
    if (directUrl !== undefined) { const checked = publicHttpUrl(directUrl); if (checked.search || checked.href !== directUrl) throw fail('INVALID_PUBLIC_QUERY'); }
    counters.attempts++;
    const task = taskContext(signal, directUrl ? timeoutMs : searchTimeoutMs), metrics = task.metrics;
    let result;
    try {
      if (task.controller.signal.aborted) throw cancelled();
      if (directUrl) {
        metrics.pageRequests++;
        const response = await httpClient(directUrl, { signal: task.controller.signal, metrics, article: true });
        let page = parsePublicPage(response, { provider: 'anonymous-direct-page', url: directUrl, title: new URL(directUrl).hostname });
        let login = loginPage(response), limited = restricted(response);
        const requested = new URL(directUrl);
        const isX = /^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/i.test(requested.hostname)
          || /^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/i.test(new URL(response.url).hostname);
        const statusId = isX && /^\/(?:[^/]+|i\/web)\/status\/(\d+)(?:\/|$)/.exec(requested.pathname)?.[1];
        const candidate = page;
        // An anonymous X app shell cannot establish any author's content.
        // The renderer must match the visible post to the originally requested ID.
        if (isX) page = null;
        const renderable = !limited && response.status >= 200 && response.status < 300
          && htmlType(response) && /html/i.test(response.headers['content-type']);
        if (renderable && renderPage && (isX ? statusId : candidate)) {
          let view;
          try { view = await renderPage(response, { signal: task.controller.signal, statusId }); }
          catch { task.controller.signal.throwIfAborted(); }
          if (view) {
            login ||= view.password === true;
            limited ||= view.restricted === true;
            if (login || limited || !view.text?.trim() || (isX && view.statusId !== statusId)) page = null;
            else {
              page = candidate || { provider: 'anonymous-direct-page', url: response.url, requestedUrl: directUrl,
                title: clean(tag(response.body, 'title'), 300) || requested.hostname, capture: 'page_excerpt' };
              page.text = view.text.trim().slice(0, 12000);
              page.links = view.links;
              page.sourceVersion = hash(JSON.stringify([page.text, page.links]));
            }
          }
        }
        result = { status: page ? 'partial' : login || limited ? 'restricted' : 'failed', sources: page ? [page] : [], metrics,
          ...(login ? { reason: 'login-required' } : {}) };
      } else if (searchPublicNotes) {
        metrics.searchRequests++;
        const notes = await searchPublicNotes(query, { signal: task.controller.signal });
        if (!notes || !['ok', 'partial', 'empty', 'restricted', 'failed'].includes(notes.status)
          || !Array.isArray(notes.sources) || notes.sources.length > 2) throw fail('INVALID_RETRIEVAL_RESPONSE');
        if (Number.isSafeInteger(notes.pageRequests) && notes.pageRequests >= 0) metrics.pageRequests = notes.pageRequests;
        result = { status: notes.status, ...(notes.reason === 'login-required' ? { reason: notes.reason } : {}), sources: notes.sources.map(note => ({ ...note, provider: 'xiaohongshu-notes' })), metrics };
      } else {
        result = { status: 'failed', sources: [], metrics };
      }
      if (signal?.aborted) throw cancelled();
      if (task.timedOut()) result = { status: 'failed', sources: [], metrics };
      return result;
    } catch (caught) {
      if (signal?.aborted) { counters.cancelled++; throw cancelled(); }
      if (caught.code === 'PUBLIC_LOGIN_REQUIRED') { result = { status: 'restricted', reason: 'login-required', sources: [], metrics }; return result; }
      if (!task.timedOut()) { counters.failed++; throw caught; }
      result = { status: 'failed', sources: [], metrics };
      return result;
    } finally {
      if (result?.status === 'failed') counters.failed++;
      const final = task.finish();
      if (result) result.metrics = final;
      for (const key of ['requests', 'searchRequests', 'pageRequests', 'bytes']) counters[key] += final[key];
      try { onMetrics?.(Object.freeze(final)); } catch { /* observation must not change retrieval */ }
    }
  };
  adapter.getStatus = () => ({ ...counters });
  return adapter;
}

export function createAnonymousCatalogReader({ httpClient = createAnonymousHttpClient(), timeoutMs = TIMEOUT_MS } = {}) {
  return async function readCatalog({ signal } = {}) {
    const task = taskContext(signal, timeoutMs), rows = []; let result;
    try {
      for (const url of FEEDS) {
        if (task.controller.signal.aborted) break;
        try {
          task.metrics.feedRequests++;
          const response = await httpClient(url, { signal: task.controller.signal, metrics: task.metrics, maxBytes: 512 * 1024 });
          if (response.status !== 200 || restricted(response) || !htmlType(response)) continue;
          for (const row of parseRss(response.body, 'bbc-public-feed').slice(0, 15)) rows.push({ ...row, feedUrl: url });
        } catch { if (signal?.aborted) throw cancelled(); }
      }
      if (signal?.aborted) throw cancelled();
      result = { rows, metrics: task.metrics }; return result;
    } finally { const final = task.finish(); if (result) result.metrics = final; }
  };
}
