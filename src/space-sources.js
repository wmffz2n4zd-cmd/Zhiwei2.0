import { approvePublicTopics } from './chat-retrieval.js';
import { createHash } from 'node:crypto';
import { createAnonymousHttpClient, decodeHtml, publicHttpUrl } from './chat-retrieval-http.js';
import { createSpaceArticleReader } from './space-publisher.js';
import { canonicalVideoUrl } from './video-reader.js';

function platformPublication(url) {
  const video = canonicalVideoUrl(url.href);
  if (video) return video.platform === 'bilibili' ? video.url : null;
  const host = url.hostname, path = url.pathname;
  if (host === 'www.xiaohongshu.com') {
    const post = /^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/i.exec(path);
    return post ? 'https://www.xiaohongshu.com/explore/' + post[1] : null;
  }
  if (['x.com','www.x.com','twitter.com','www.twitter.com'].includes(host)) {
    const post = /^\/(?:[A-Za-z0-9_]+\/status|i\/(?:web\/)?status)\/(\d+)\/?$/.exec(path);
    return post ? 'https://x.com/i/status/' + post[1] : null;
  }
  if (['www.bilibili.com','bilibili.com'].includes(host)) {
    const post = /^\/(read\/cv\d+|opus\/\d+)\/?$/.exec(path);
    return post ? 'https://www.bilibili.com/' + post[1] : null;
  }
  if (/(^|\.)(?:xiaohongshu\.com|xhslink\.com|x\.com|twitter\.com|bilibili\.com|b23\.tv|youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com|tiktok\.com)$/.test(host)) return null;
  return undefined;
}

// Canonical platform permalinks can drop tracking tokens. Other sites must
// supply a plain anonymous page address; a generic URL alone cannot prove it
// is published, which is checked separately before fetching its contents.
export function spacePublicationUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || typeof raw !== 'string' || raw.length > 4096) return null;
  const platform = platformPublication(url);
  if (platform !== undefined) return platform;
  try {
    const checked = publicHttpUrl(raw);
    if (url.search || checked.pathname === '/' || checked.href.length > 900 ||
      /\/(search|search_result|results)\/?$/i.test(checked.pathname)) return null;
    const id = 'public:url:' + createHash('sha256').update(checked.href).digest('hex').slice(0,24);
    return approvePublicTopics({explicitText:checked.href}).some(topic => topic.id === id) ? checked.href : null;
  } catch { return null; }
}

function editorialArchive(url) {
  const host = url.hostname, path = url.pathname;
  return Boolean(platformPublication(url)) ||
    host === 'go.dev' && /^\/blog\/[\w.-]+$/.test(path) ||
    host === 'blog.python.org' && /^\/\d{4}\/\d{2}\/[\w-]+\.html$/.test(path) ||
    ['www.bbc.com','www.bbc.co.uk'].includes(host) && /^\/news\/(?:articles\/[a-z0-9]+|[a-z-]+-\d+)\/?$/.test(path) ||
    host === 'www.rfc-editor.org' && /^\/rfc\/rfc\d+\.txt$/.test(path);
}

function sameOriginLinks(response) {
  const origin = new URL(response.url).origin;
  if (!/^text\/html\b|^application\/xhtml\+xml\b/i.test(response.headers['content-type']) ||
      response.status !== 200) return [];
  const html = response.body.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|noscript|template|textarea|title)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');
  let base = response.url;
  const destinations = [];
  let baseSet = false;
  // Match whole tags, including quoted attribute values. Text inside another
  // attribute cannot stand in for an actual href on a published anchor.
  for (const tag of html.matchAll(/<([a-z][\w:-]*)\b((?:[^<>'"]|"[^"]*"|'[^']*')*)>/gi)) {
    const name = tag[1].toLowerCase();
    if (name !== 'a' && name !== 'base') continue;
    const attributes = tag[2].matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g);
    for (const [, key, double, single, plain] of attributes) {
      if (key.toLowerCase() !== 'href') continue;
      const href = decodeHtml(double ?? single ?? plain ?? '');
      if (name === 'a') destinations.push(href);
      else if (!baseSet) {
        try { base = new URL(href,response.url).href; } catch { return []; }
        baseSet = true;
      }
      break;
    }
  }
  const links = new Set();
  for (const href of destinations) {
    try {
      const target = new URL(href, base);
      if (target.origin !== origin || target.username || target.password || target.search) continue;
      target.hash = '';
      links.add(target.href);
    } catch { /* Skip invalid navigation. */ }
  }
  return links;
}

export function createListedSpaceReader({ httpClient = createAnonymousHttpClient(), now = Date.now } = {}) {
  const read = createSpaceArticleReader({httpClient, now});
  return async function readListed(raw, {signal} = {}) {
    const canonical = spacePublicationUrl(raw);
    const unavailable = () => ({status:'unavailable',receipt:{reason:'publication-unverified'}});
    if (!canonical || canonical !== raw || canonicalVideoUrl(raw)) return unavailable();
    const url = new URL(raw);
    if (!editorialArchive(url)) {
      const root = url.origin + '/';
      const timeout = AbortSignal.timeout(12000);
      const context = {signal:signal ? AbortSignal.any([signal,timeout]) : timeout, followRedirects:false,
        metrics:{requests:0,redirects:0,dnsResolutions:0,bytes:0}};
      const linksAt = async address => {
        const response = await httpClient(address, context);
        return response.url === address ? new Set(sameOriginLinks(response)) : new Set();
      };
      try {
        const index = await linksAt(root);
        if (!index.has(raw)) {
          // Follow at most one parent archive, and only if the anonymous
          // homepage actually links it. Never probe an unlisted target.
          const parentPath = url.pathname.replace(/\/$/,'').replace(/\/[^/]*$/,'/');
          if (parentPath === '/') return unavailable();
          const parent = [url.origin + parentPath, url.origin + parentPath.slice(0,-1)].find(link => index.has(link));
          if (!parent || !(await linksAt(parent)).has(raw)) return unavailable();
        }
      } catch { signal?.throwIfAborted(); return unavailable(); }
    }
    return read(raw, {signal});
  };
}
