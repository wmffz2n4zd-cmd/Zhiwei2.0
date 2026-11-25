// A shared article may live on these domains. Classify only their search
// routes, including a search URL retained by an earlier reading plan.
export function isRetiredSearchUrl(input) {
  let url;
  try { url = new URL(input); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const path = url.pathname.replace(/%([0-9a-f]{2})/gi, (part, hex) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return /[a-z0-9._~-]/i.test(char) ? char : part;
  }).replace(/\/+$/, '').toLowerCase();
  const rootQuery = path === '' && url.searchParams.has('q');
  if (/(^|\.)bing\.com$/.test(host))
    return rootQuery || /^\/(?:search|(?:images|videos|news)\/search)$/.test(path);
  if (/(^|\.)duckduckgo\.com$/.test(host))
    return rootQuery || ['/html', '/lite', '/search'].includes(path);
  if (/^(?:(?:www|m|news|images)\.)?google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/.test(host))
    return rootQuery || path === '/search' || (path === '/webhp' && url.searchParams.has('q'));
  if (/(^|\.)(?:x|twitter)\.com$/.test(host)) return path === '/search' || path === '/i/search';
  if (/^(?:(?:www|m|news|image)\.)?baidu\.com$/.test(host))
    return ['/s', '/baidu', '/sf/vsearch', '/search', '/search/index'].includes(path);
  if (host === 'search.brave.com') return rootQuery || path === '/search';
  return /^(?:[a-z]+\.)?search\.yahoo\.com$/.test(host) && path === '/search';
}
