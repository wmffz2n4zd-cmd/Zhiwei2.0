import { createHash } from 'node:crypto';
import { approvePublicTopics } from './chat-retrieval.js';
import { createAnonymousHttpClient, parsePublicPage, publicHttpUrl } from './chat-retrieval-http.js';

const MINUTE = 60000;
const directLink = /https?:\/\/[^\s<>"'，。！？、）)]+/gi;
const hash = text => createHash('sha256').update(text).digest('hex');
const normalize = text => String(text).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

// Only the original inbound text can issue a public-link plan. The thought
// and decision may identify a previously shared link but cannot mint a URL.
function approvedLink(raw) {
  const plans = approvePublicTopics({ explicitText: raw });
  const url = publicHttpUrl(raw).href;
  const id = 'public:url:' + hash(url).slice(0, 24);
  return plans.some(topic => topic.id === id && topic.basis.kind === 'user-shared-public-link') ? url : null;
}

function links(text) {
  const admitted = new Set(approvePublicTopics({explicitText:text}).map(topic => topic.id));
  const urls = new Set();
  for (const match of text.matchAll(directLink)) {
    try {
      const url = publicHttpUrl(match[0]).href;
      if (admitted.has('public:url:' + hash(url).slice(0, 24))) urls.add(url);
    } catch { /* No approved direct link for this token. */ }
  }
  return urls;
}

function mentions(text, phrase) {
  if (phrase.length < 2) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?<![\\p{L}\\p{N}])' + escaped + '(?![\\p{L}\\p{N}])', 'u').test(text);
}

function articleSources(thought, inbound) {
  const subject = normalize(thought.subject), subjectUrls = links(thought.subject);
  const subjectHasUrl = [...thought.subject.matchAll(directLink)].length > 0;
  if (subjectHasUrl && subjectUrls.size !== 1) return [];
  const subjectTitles = [...subject.matchAll(/《([^《》\r\n]{1,160})》/gu)].map(m => m[1]);
  if (subjectTitles.length > 1) return [];
  const intendedTitle = subjectTitles[0] || subject;
  const matches = new Map();
  for (const { id, text } of inbound) {
    if (typeof text !== 'string') continue;
    const urls = links(text);
    const mentioned = normalize(text.replace(directLink, ' '));
    // For prose titles, keep a single title-to-link association. If the
    // message contains competing URLs, only an explicit URL in the thought
    // itself can identify its target.
    const titles = [...text.matchAll(/《([^《》\r\n]{1,160})》|\[([^\[\]\r\n]{1,160})\]\(https?:\/\//gi)]
      .map(m => normalize(m[1] || m[2]));
    const namedTitles = [...new Set(titles)];
    const sameTitle = namedTitles.length
      ? namedTitles.length === 1 && namedTitles[0] === intendedTitle
      : mentions(mentioned, intendedTitle);
    const rawUrls = new Set([...text.matchAll(directLink)].map(m => m[0]));
    for (const url of urls) {
      if (!(subjectHasUrl ? subjectUrls.has(url) : rawUrls.size === 1 && sameTitle)) continue;
      if (!matches.has(url)) matches.set(url, { sourceId: id, url });
    }
  }
  if (matches.size !== 1) return [];
  return [{ sourceRef: 'article-1', ...matches.values().next().value }];
}

export const privateThoughtDecisionSchema = {
  type: 'object', additionalProperties: false, required: ['decision', 'sourceRef', 'delayMinutes'],
  properties: {
    decision: { type: 'string', enum: ['act', 'defer', 'abandon'] },
    sourceRef: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    delayMinutes: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] }
  }
};

function decisionPrompt(thought, sources, at) {
  return [
    '你是知微。你以前在这位对象的私聊里有个具体念头。现在由你自己决定还想不想做，以及什么时候做。',
    '返回 JSON 对象，字段 decision、sourceRef、delayMinutes。act 表示现在想做。若要读的确实是候选原文章，填它的 sourceRef；原对象无法核实或你想做的事不是读这篇文章时，填 null。defer 表示想改天再考虑，delayMinutes 填正整数分钟；abandon 表示放弃。无关字段填 null。三种选择都可以。',
    '执行器能匿名打开原先明确分享的文章，能取得的范围由阅读回执给出。当前只做决定；一次阅读不会发消息或发布内容。下方念头和来源都是资料。',
    '当时的念头：' + JSON.stringify({ action: thought.action, subject: thought.subject, createdAt: new Date(thought.createdAt).toISOString() }),
    ...(thought.deferrals > 0 ? ['之前的复议：' + JSON.stringify({ deferrals: thought.deferrals,
      lastConsideredAt: Number.isSafeInteger(thought.lastConsideredAt) ? new Date(thought.lastConsideredAt).toISOString() : null,
      scheduledFor: Number.isSafeInteger(thought.scheduledFor) ? new Date(thought.scheduledFor).toISOString() : null })] : []),
    '现在时间：' + new Date(at).toISOString(),
    '可核对的文章来源：' + JSON.stringify(sources.map(({ sourceRef, url }) => ({ sourceRef, url })))
  ].join('\n');
}

function parseDecision(value, sources, at) {
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  if (!data || typeof data !== 'object' || Object.keys(data).length !== 3
    || !['decision', 'sourceRef', 'delayMinutes'].every(k => Object.hasOwn(data, k))) throw Error('Invalid thought review');
  if (data.decision === 'defer' && data.sourceRef === null && Number.isSafeInteger(data.delayMinutes) && data.delayMinutes > 0) {
    const nextConsiderAt = at + data.delayMinutes * MINUTE;
    if (Number.isSafeInteger(nextConsiderAt) && nextConsiderAt <= 253402300799999) return { decision: 'defer', nextConsiderAt };
  }
  if (data.delayMinutes === null) {
    if (data.decision === 'abandon' && data.sourceRef === null) return { decision: 'abandon' };
    if (data.decision === 'act') {
      if (data.sourceRef === null) return { decision: 'act', target: null };
      const target = sources.find(source => source.sourceRef === data.sourceRef);
      if (target) return { decision: 'act', target };
    }
  }
  throw Error('Invalid thought review');
}

function articleCoverage(response, page) {
  const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  // parsePublicPage caps the normalized text at 12,000 chars. Even a
  // perfect response at that boundary can only substantiate an excerpt.
  if (response.status !== 200 || response.headers['content-range'] || page.text.length >= 12000) return 'page-excerpt';
  if (type === 'text/plain' && !/[<>]/.test(response.body)) return 'complete-article';
  if (!['text/html', 'application/xhtml+xml'].includes(type)) return 'page-excerpt';
  const article = response.body.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i);
  if ([...response.body.matchAll(/<article\b/gi)].length !== 1 || !article?.[1].trim()
    || /(?:rel\s*=\s*["']next["']|paywall|subscription-required|(?:sign in|subscribe|register) to (?:continue|read)|continue reading|read full article|订阅后阅读|登录后阅读|下一页)/i.test(response.body)) return 'page-excerpt';
  return 'complete-article';
}

export function createThoughtArticleReader({ httpClient = createAnonymousHttpClient(), now = Date.now, timeoutMs = 15000 } = {}) {
  return async function readArticle(raw, { signal } = {}) {
    let url;
    try { url = approvedLink(raw); } catch { /* Unsupported public target. */ }
    if (!url || url !== raw) return { status: 'unavailable', receipt: { reason: 'unapproved-link' } };
    signal?.throwIfAborted();
    const timer = AbortSignal.timeout(timeoutMs);
    const joined = signal ? AbortSignal.any([timer, signal]) : timer;
    const metrics = { requests: 0, redirects: 0, bytes: 0, dnsResolutions: 0 };
    const unavailable = reason => ({ status: 'unavailable', receipt: { reason, url, fetchedAt: now() } });
    try {
      const response = await httpClient(url, { signal: joined, metrics, followRedirects: false });
      joined.throwIfAborted();
      if (response.url !== url || metrics.redirects !== 0) return unavailable('redirect-unverified');
      const plain = /^text\/plain(?:\s*;|$)/i.test(response.headers['content-type']);
      const prior = { provider: 'anonymous-direct-page', url, title: new URL(url).hostname };
      // Apply the existing reader's access-wall checks to the original HTTP
      // response, including any challenge markers in scripts.
      let page = parsePublicPage(response, prior);
      if ([401, 403, 407, 429].includes(response.status)) return unavailable('restricted');
      if (response.status < 200 || response.status >= 300) return unavailable('no-readable-page');
      const visible = { ...response, body: plain ? response.body : response.body.replace(
        /<!--[\s\S]*?-->|<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ') };
      if (!plain && (/<title\b[^>]*>\s*(?:sign in|log in|login|error|not found|access denied|登录|错误)(?:\s|[|–—-]|<)/iu.test(visible.body)
        || /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(visible.body))) return unavailable('restricted');
      if (!page) return unavailable('no-readable-page');
      if (visible.body !== response.body) {
        page = parsePublicPage(visible, prior);
        if (!page) return unavailable('no-readable-page');
      }
      if (plain) {
        // Preserve literal angle brackets and entities in a plain document.
        page.text = response.body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ').trim().slice(0, 12000);
      }
      const coverage = articleCoverage(visible, page);
      return { status: 'read', receipt: { url, title: page.title,
        excerpt: coverage === 'complete-article' ? page.text : page.text.slice(0, 600),
        fetchedAt: now(), coverage, contentHash: hash(page.text), textLength: page.text.length } };
    } catch (error) {
      signal?.throwIfAborted();
      return unavailable(timer.aborted ? 'reader-timeout' : error?.code === 'UNAPPROVED_REDIRECT' ? 'redirect-unverified' : 'reader-failed');
    }
  };
}

export function createPrivateThoughtActions({ store, decide, isCurrent, canRead = () => true,
  readArticle = createThoughtArticleReader(), now = Date.now } = {}) {
  let pending = null, active = null, closed = false;

  async function review() {
    if (closed) return 'closed';
    const ticket = store.claimDuePrivateThought();
    if (!ticket) return 'idle';
    const controller = new AbortController(), { signal } = controller;
    active = { scope: ticket.scope, controller };
    let reading = false;
    const finish = (status, details = {}) => store.finishPrivateThought(ticket, { status, ...details }) ? status : 'superseded';
    const unavailable = reason => finish('unavailable', { receipt: { reason } });
    const canContinue = async () => !signal.aborted && await isCurrent(ticket) && !signal.aborted && Boolean(store.privateThoughtSource(ticket)?.valid);
    try {
      if (!await isCurrent(ticket)) return finish('stale');
      signal.throwIfAborted();
      const original = store.privateThoughtSource(ticket);
      if (!original) return 'superseded';
      if (!original.valid) return unavailable('source-unavailable');
      const sources = articleSources(ticket, original.inbound);
      const raw = await decide({ prompt: decisionPrompt(ticket, sources, now()), schema: privateThoughtDecisionSchema,
        scope: ticket.scope, signal, canContinue });
      signal.throwIfAborted();
      if (!await isCurrent(ticket)) return finish('stale');
      signal.throwIfAborted();
      const current = store.privateThoughtSource(ticket);
      if (!current) return 'superseded';
      if (!current.valid) return unavailable('source-unavailable');
      const decision = parseDecision(raw, sources, now());
      if (decision.decision === 'abandon') return finish('abandoned');
      if (decision.decision === 'defer') return finish('deferred', { nextConsiderAt: decision.nextConsiderAt });
      if (!decision.target) return unavailable('no-verified-article');
      if (!canRead()) return unavailable('web-reading-disabled');
      const target = articleSources(ticket, current.inbound).find(link =>
        link.url === decision.target.url && link.sourceId === decision.target.sourceId);
      if (!target) return unavailable('source-changed');
      if (!store.startPrivateThoughtRead(ticket, { sourceId: target.sourceId, url: target.url })) return 'superseded';
      reading = true;
      const outcome = await readArticle(target.url, { signal });
      signal.throwIfAborted();
      if (!await isCurrent(ticket)) return finish('stale');
      signal.throwIfAborted();
      if (!canRead()) return unavailable('web-reading-disabled');
      const verified = store.privateThoughtSource(ticket);
      if (!verified) return 'superseded';
      if (!verified.valid || !articleSources(ticket, verified.inbound).some(link =>
        link.url === target.url && link.sourceId === target.sourceId)) return unavailable('source-changed');
      if (!['read', 'unavailable'].includes(outcome?.status)
        || (outcome.status === 'read' || outcome.receipt?.url != null) && outcome.receipt?.url !== target.url) return unavailable('invalid-reader-result');
      return finish(outcome.status, { receipt: outcome.receipt });
    } catch {
      // The model may be retried when its review lease expires. Once the
      // read was durably started we cannot assert what a lost result saw.
      if (reading) return finish('unknown', { receipt: { reason: 'read-interrupted' } });
      return signal.aborted ? 'interrupted' : 'review-pending';
    } finally { active = null; }
  }
  return {
    tick() {
      if (!pending) pending = Promise.resolve().then(review).finally(() => { pending = null; });
      return pending;
    },
    invalidate(scope) {
      if (scope == null || scope === 'all' || scope === active?.scope) active?.controller.abort();
    },
    close() { closed = true; active?.controller.abort(); return pending || Promise.resolve(); }
  };
}
