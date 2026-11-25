import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAnonymousHttpClient, createChatLookupAdapter, createAnonymousCatalogReader, isPublicAddress, publicHttpUrl, parseRss, parsePublicPage } from '../src/chat-retrieval-http.js';
import { createPublicTopicCatalog, approvePublicTopics, createChatRetrieval } from '../src/chat-retrieval.js';

const metrics = () => ({ requests: 0, dnsResolutions: 0, redirects: 0, bytes: 0 });
const rss = (title = 'New observatory detects remarkable transient', link = 'https://news.example.org/story') => `<rss><channel><item><title><![CDATA[${title}]]></title><link>${link}</link><description>Actual public description &amp; source.</description><pubDate>Tue, 17 Nov 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
const page = '<html><head><title>Public article</title><meta property="article:published_time" content="2026-11-16T11:00:00Z"><meta content="2026-11-17T12:00:00Z" property="article:modified_time"></head><body><nav>Menu</nav><article>Actual published public scientific article '.repeat(1) + 'This is externally sourced evidence only, not a user statement. '.repeat(5) + '</article><script>INJECTED SCRIPT</script></body></html>';
const response = (body, extra = {}) => ({ status: 200, url: 'https://news.example.org/story', headers: { 'content-type': 'text/html; charset=utf-8' }, body, ...extra });
const freshSignal = () => new AbortController().signal;

function fakeNetwork(handler) {
  const calls = [], state = { live: 0, closed: 0 };
  const requestImpl = (url, options, callback) => {
    const req = new EventEmitter(); let incoming, destroyed = false, closed = false;
    calls.push({ url: url.href, options }); state.live++;
    const close = () => { if (closed) return; closed = true; state.live--; state.closed++; req.emit('close'); };
    req.destroy = caught => { if (destroyed) return; destroyed = true; incoming?.destroy(); setImmediate(() => { if (caught) req.emit('error', caught); close(); }); };
    req.end = () => setImmediate(() => {
      if (destroyed) return;
      options.lookup(url.hostname, { all: true }, (err, pins) => { assert.equal(err, null); calls.at(-1).pins = pins; });
      const item = handler(url, calls.length) || {};
      incoming = new PassThrough(); incoming.statusCode = item.status ?? 200; incoming.headers = item.headers ?? { 'content-type': 'text/html' };
      callback(incoming);
      incoming.on('end', () => setImmediate(close));
      if (destroyed || item.hang) return;
      for (const chunk of item.chunks || [Buffer.from(item.body || 'ok')]) { if (destroyed) break; incoming.write(chunk); }
      if (!destroyed) incoming.end();
    });
    return req;
  };
  return { requestImpl, calls, state };
}

test('address boundary rejects private, metadata, mixed encodings and IPv6 transition ranges', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.100.100.200', '172.16.0.1', '192.168.1.2', '192.0.0.9', '192.0.2.2', '198.18.0.2', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:7f00:1::', '2001:0:4136:e378::', '2001:db8::1', 'fe80::1', 'fc00::1', '3fff::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
});

test('URL policy refuses credentials, literals, secret parameters and internal names; strips only known tracking', () => {
  for (const url of ['http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'https://a:b@public.example/', 'file:///tmp/a', 'https://localhost/', 'https://metadata.internal/', 'https://foo.example:8080/', 'https://x.example/?token=secret', 'https://x.example/?signature=x', 'https://x.example/?at_secret=x']) assert.throws(() => publicHttpUrl(url), { code: 'UNSAFE_URL' });
  assert.equal(publicHttpUrl('https://www.bbc.co.uk/news/articles/a?at_medium=RSS&at_campaign=rss').href, 'https://www.bbc.co.uk/news/articles/a');
  assert.equal(publicHttpUrl('https://public.example/article?id=42&utm_source=feed#part').href, 'https://public.example/article?id=42');
});

test('DNS all answers validated, pinned lookup has only validated address and every redirect re-resolves', async () => {
  const network = fakeNetwork((url, count) => count === 1 ? { status: 302, headers: { location: 'https://second.example/article' } } : { body: 'final body' });
  const hosts = [], read = createAnonymousHttpClient({ requestImpl: network.requestImpl, resolveAddresses: async host => { hosts.push(host); return [{ address: '93.184.216.34', family: 4 }]; } });
  const state = metrics(), result = await read('https://first.example/', { signal: freshSignal(), metrics: state });
  assert.equal(result.body, 'final body'); assert.deepEqual(hosts, ['first.example', 'second.example']); assert.equal(state.redirects, 1);
  assert.equal(network.calls[0].options.agent, false); assert.equal(network.calls[0].options.headers['accept-encoding'], 'identity');
  assert.deepEqual(network.calls[0].pins, [{ address: '93.184.216.34', family: 4 }]); assert.equal(network.state.live, 0);
  const blocked = createAnonymousHttpClient({ requestImpl: network.requestImpl, resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(blocked('https://public.example/', { signal: freshSignal(), metrics: metrics() }), { code: 'UNSAFE_DNS' });
  assert.equal(network.calls.length, 2);
});

test('private DNS on redirect and generic search query URLs are rejected', async () => {
  const network = fakeNetwork(() => ({ status: 302, headers: { location: 'https://inside.example/a' } }));
  const read = createAnonymousHttpClient({ requestImpl: network.requestImpl, resolveAddresses: async host => [{ address: host === 'inside.example' ? '10.0.0.5' : '8.8.8.8', family: 4 }] });
  await assert.rejects(read('https://public.example/', { signal: freshSignal(), metrics: metrics() }), { code: 'UNSAFE_DNS' });
  assert.equal(network.calls.length, 1);
  await assert.rejects(read('https://public.example/?q=public', { signal: freshSignal(), metrics: metrics() }), { code: 'UNSAFE_URL' });
  assert.equal(network.calls.length, 1);
});

test('direct reads and redirects never send a request to retired keyword search routes', async () => {
  for (const url of ['https://www.bing.com/search', 'https://images.google.co.uk/search',
    'https://www.google.com/%73earch', 'https://duckduckgo.com/?q=topic', 'https://html.duckduckgo.com/html/',
    'https://x.com/search', 'https://mobile.twitter.com/search/', 'https://www.baidu.com/s',
    'https://search.brave.com/search', 'https://search.yahoo.com/search']) {
    const wire = fakeNetwork(() => ({ status:302, headers:{ location:url } }));
    const read = createAnonymousHttpClient({ requestImpl:wire.requestImpl,
      resolveAddresses:async () => [{ address:'8.8.8.8',family:4 }] });
    await assert.rejects(read(url,{signal:freshSignal(),metrics:metrics()}),{code:'UNSAFE_URL'});
    assert.equal(wire.calls.length,0);
    await assert.rejects(read('https://publisher.example/article',{signal:freshSignal(),metrics:metrics()}),{code:'UNSAFE_URL'});
    assert.deepEqual(wire.calls.map(call=>call.url),['https://publisher.example/article']);
  }
  for (const url of ['https://x.com/public_author/status/12345','https://www.google.com/about/',
    'https://public.example/search', 'https://www.xiaohongshu.com/explore/67efab001234567890abcdef']) {
    assert.equal(publicHttpUrl(url).href,url);
  }
});

test('cancelled response destroys and drains owned request before rejection', async () => {
  const network = fakeNetwork(() => ({ hang: true })), controller = new AbortController();
  const read = createAnonymousHttpClient({ requestImpl: network.requestImpl, resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }] });
  const pending = read('https://public.example/', { signal: controller.signal, metrics: metrics() });
  await new Promise(resolve => setImmediate(() => setImmediate(resolve))); assert.equal(network.state.live, 1);
  controller.abort(); await assert.rejects(pending, { code: 'REPLY_SUPERSEDED' }); assert.equal(network.state.live, 0); assert.equal(network.state.closed, 1);
});

test('compression, announced size and streaming size limits close the request', async () => {
  for (const item of [{ headers: { 'content-encoding': 'gzip' }, body: 'compressed' }, { headers: { 'content-length': '500' } }, { chunks: [Buffer.alloc(30), Buffer.alloc(30)] }]) {
    const network = fakeNetwork(() => item), read = createAnonymousHttpClient({ requestImpl: network.requestImpl, resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }] });
    await assert.rejects(read('https://public.example/', { signal: freshSignal(), metrics: metrics(), maxBytes: 50 }), /Anonymous public retrieval unavailable/);
    assert.equal(network.state.live, 0);
  }
});

test('public RSS parser retains exact sources and recognizes BBC tracking links', () => {
  const rows = parseRss(rss('A &amp; B', 'https://www.bbc.co.uk/news/articles/a?at_medium=RSS&amp;at_campaign=rss'), 'bbc-public-feed');
  assert.equal(rows.length, 1); assert.equal(rows[0].url, 'https://www.bbc.co.uk/news/articles/a'); assert.equal(rows[0].title, 'A & B');
  assert.equal(rows[0].publishedAt, '2026-11-17T12:00:00.000Z'); assert.equal(rows[0].capture, 'search_snippet');
  assert.deepEqual(parseRss(rss('no', 'https://public.example/?token=private'), 'fixture'), []);

});

test('page extraction preserves published and modified time, strips executable text, never claims full coverage', () => {
  const item = parsePublicPage(response(page), { title: 'prior', provider: 'fixture', url: 'https://news.example.org/story' });
  assert.equal(item.capture, 'page_excerpt'); assert.equal(item.publishedAt, '2026-11-16T11:00:00.000Z'); assert.equal(item.updatedAt, '2026-11-17T12:00:00.000Z');
  assert.doesNotMatch(item.text, /INJECTED SCRIPT|Menu/); assert.equal(item.eventAt, null);
  assert.equal(parsePublicPage(response('captcha', { status: 403 }), item), null);
  assert.equal(parsePublicPage(response(page, { headers: { 'content-type': 'application/octet-stream' } }), item), null);
  assert.equal(parsePublicPage(response(page, { headers: { 'content-type': 'text/html; charset=gbk' } }), item), null);
});

const xhsNote = { url: 'https://www.xiaohongshu.com/explore/67efab001234567890abcdef', title: 'Public note', text: 'Observed note excerpt', capture: 'page_excerpt' };

test('topic reads use the Xiaohongshu browser only and preserve the observed coverage', async () => {
  const seen = [];
  const adapter = createChatLookupAdapter({ httpClient: async () => assert.fail('unexpected anonymous request'),
    searchPublicNotes: async (query, options) => { seen.push(query); assert.deepEqual(Object.keys(options), ['signal']);
      return { status: 'ok', sources: [xhsNote], pageRequests: 1 }; } });
  const result = await adapter({ query: 'Node.js runtime', freshness: 'latest' }, { signal: freshSignal() });
  assert.equal(result.status, 'ok'); assert.equal(result.sources[0].provider, 'xiaohongshu-notes'); assert.equal(result.sources[0].capture, 'page_excerpt');
  assert.deepEqual(seen,['Node.js runtime']); assert.equal(result.metrics.requests, 0); assert.equal(result.metrics.searchRequests, 1); assert.equal(result.metrics.pageRequests, 1);
});

test('empty and restricted site results differ from a failure and never trigger an HTTP fallback', async () => {
  const httpClient = async () => assert.fail('unexpected anonymous request');
  for (const status of ['empty', 'restricted', 'failed', 'partial']) {
    const sources = status === 'partial' ? [{ ...xhsNote, capture: 'search_snippet' }] : [];
    const adapter = createChatLookupAdapter({ httpClient, searchPublicNotes: async () => ({ status, sources }) });
    const result = await adapter({ query: 'Node.js runtime', freshness: 'current' });
    assert.equal(result.status,status); assert.equal(result.sources[0]?.capture,sources[0]?.capture);
  }
  const disabled=createChatLookupAdapter({httpClient});
  assert.equal((await disabled({query:'Node.js runtime',freshness:'current'})).status,'failed');
});

test('adapter deadline terminates network before failed result and cancellation never becomes fallback', async () => {
  const httpClient = (_url, { signal }) => new Promise((_, reject) => { if (signal.aborted) reject(Error('aborted')); else signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
  const adapter = createChatLookupAdapter({ searchPublicNotes: httpClient, searchTimeoutMs: 10 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await adapter({ query: 'public topic', freshness: 'current' }, { signal: freshSignal() }); assert.equal(result.status, 'failed'); assert.equal(result.metrics.timedOut, true);
    const controller = new AbortController(), pending = adapter({ query: 'public topic', freshness: 'current' }, { signal: controller.signal }); controller.abort();
    await assert.rejects(pending, { code: 'REPLY_SUPERSEDED' });
  } finally { clearTimeout(keepAlive); }
});

test('public catalog reads fixed feeds only; new headline without old keyword becomes immutable approved query', async t => {
  const requests = [], reader = createAnonymousCatalogReader({ httpClient: async (url, { metrics }) => { requests.push(url); metrics.requests++; return response(rss('Qubit observatory announces first photonic atlas', 'https://news.example.org/new-atlas'), { url, headers: { 'content-type': 'text/xml' } }); } });
  const catalog = createPublicTopicCatalog({ reader }); t.after(() => catalog.close());
  assert.equal(catalog.peekTopics(), null); const issued = await catalog.getTopics({ signal: freshSignal() });
  assert.equal(requests.length, 2); assert.ok(requests.every(url => !url.includes('?')));
  const topics = approvePublicTopics({ text: '那个新光子图谱查证一下 私密姓名synthetic_secret', catalog: issued });
  assert.equal(topics.length, 1); assert.match(topics[0].id, /^public:feed:/); assert.equal(topics[0].basis.kind, 'anonymous-public-feed');
  assert.throws(() => { topics[0].label = 'private'; }, TypeError); assert.deepEqual(approvePublicTopics({ text: 'nothing', catalog: structuredClone(issued) }), []);
  let payload;
  const service = createChatRetrieval({ adapter: async value => { payload = value; return { status: 'empty', sources: [] }; } }); t.after(() => service.close());
  await service.retrieve({ topics, signal: freshSignal(), assertCurrent: () => true, request: { version: 1, id: 'one', turnId: 'one', scope: { kind: 'private', contactId: 'private-id', memoryEpoch: 'epoch' }, publicQuery: { topicIds: [topics[0].id], freshness: 'current', sourceUrl: null } } });
  assert.deepEqual(payload, { query: 'Qubit observatory announces first photonic atlas', freshness: 'current', url: 'https://news.example.org/new-atlas' });
  assert.doesNotMatch(JSON.stringify(payload), /synthetic_secret|private-id|epoch/);
  await catalog.getTopics(); assert.equal(requests.length, 2); assert.equal(catalog.getStatus().topicCount, 1);
});

test('dynamic public feed selection reads its known article directly and never trusts unrelated search results', async t => {
  const catalog = createPublicTopicCatalog({ reader: async () => ({ rows: [{ title: 'Asterion observatory finds photonic atlas', url: 'https://public.example/asterion', feedUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml' }] }) }); t.after(() => catalog.close());
  const topics = approvePublicTopics({ catalog: await catalog.getTopics() }), seen = [];
  const adapter = createChatLookupAdapter({ httpClient: async (url, { metrics }) => { seen.push(url); metrics.requests++; return response(page, { url }); } });
  const service = createChatRetrieval({ adapter }); t.after(() => service.close());
  const request = { version: 1, id: 'feed', turnId: 'feed', scope: { kind: 'private', contactId: 'a', memoryEpoch: '1' }, publicQuery: { topicIds: [topics[0].id], freshness: 'current', sourceUrl: null } };
  const result = await service.retrieve({ request, topics, assertCurrent: () => true });
  assert.deepEqual(seen, ['https://public.example/asterion']); assert.equal(result.metrics.http.searchRequests, 0);
  assert.equal(result.evidence[0].source.requestedUrl, topics[0].basis.articleUrl);
  const cached = await service.retrieve({ request, topics, assertCurrent: () => true }); assert.equal(cached.cacheHit, true); assert.equal(seen.length, 1);
});

test('catalog TTL refresh is action-driven; stale title remains public vocabulary and does not assert fresh evidence', async t => {
  let now = 10000, calls = 0;
  const catalog = createPublicTopicCatalog({ now: () => now, ttlMs: 100, reader: async () => { calls++; return { rows: [{ title: 'Public unrelated event', url: 'https://public.example/a', feedUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml' }] }; } }); t.after(() => catalog.close());
  const issued = await catalog.getTopics(); now += 500;
  assert.equal(catalog.peekTopics(), issued); assert.equal(calls, 1);
  const topics = approvePublicTopics({ catalog: issued }); assert.equal(topics.length, 1); assert.equal(topics[0].basis.fetchedAt, '1970-01-01T00:00:10.000Z');
  await catalog.getTopics(); assert.equal(calls, 2);
});

test('explicit new-message public links create direct-read plans, context links and token links cannot', async t => {
  assert.deepEqual(approvePublicTopics({ text: 'https://public.example/a' }), []);
  assert.deepEqual(approvePublicTopics({ explicitText: 'https://public.example/a?token=private https://public.example/login https://user:pass@public.example/a' }), []);
  const topics = approvePublicTopics({ explicitText: '读一下 https://public.example/a 私密姓名synthetic_secret' }); assert.equal(topics.length, 1);
  const requests = [], adapter = createChatLookupAdapter({ httpClient: async (url, { metrics }) => { requests.push(url); metrics.requests++; return response(page, { url }); } });
  const service = createChatRetrieval({ adapter }); t.after(() => service.close());
  const result = await service.retrieve({ topics, signal: freshSignal(), assertCurrent: () => true, request: { version: 1, id: 'one', turnId: 'one', scope: { kind: 'private', contactId: 'private-id', memoryEpoch: 'epoch' }, publicQuery: { topicIds: [topics[0].id], freshness: 'current', sourceUrl: null } } });
  assert.equal(result.status, 'partial'); assert.deepEqual(requests, ['https://public.example/a']); assert.equal(result.metrics.http.searchRequests, 0); assert.equal(result.metrics.http.pageRequests, 1);
  assert.equal(result.evidence[0].capture.kind, 'page_excerpt'); assert.equal(result.evidence[0].coverage.complete, false);
});

test('catalog close propagates cancellation and drains reader; unavailable feeds do not break chatting', async () => {
  let live = 0;
  const catalog = createPublicTopicCatalog({ reader: ({ signal }) => new Promise((_, reject) => { live++; signal.addEventListener('abort', () => setImmediate(() => { live--; reject(Error('cancelled')); }), { once: true }); }) });
  const pending = catalog.getTopics(); const rejection = assert.rejects(pending, { code: 'REPLY_SUPERSEDED' }); await catalog.close(); await rejection; assert.equal(live, 0); assert.equal(catalog.getStatus().pending, 0);
  const unavailable = createPublicTopicCatalog({ reader: async () => { throw Error('private provider error'); } }); assert.equal(await unavailable.getTopics(), null); assert.equal(unavailable.peekTopics(), null); await unavailable.close();
});

test('issued result is revalidated after generation for TTL, clock rollback, scope clear and original cancellation', async t => {
  let now = 10000;
  const service = createChatRetrieval({ now: () => now, ttlMs: 100, adapter: async () => ({ status: 'ok', sources: [{ provider: 'xiaohongshu-notes', url: 'https://www.xiaohongshu.com/explore/67efab001234567890abcdef', title: 'Public', text: 'Actual excerpt', capture: 'page_excerpt' }] }) }); t.after(() => service.close());
  const controller = new AbortController();
  const options = { topics: approvePublicTopics({ text: 'Python' }), signal: controller.signal, assertCurrent: () => true, request: { version: 1, id: 'one', turnId: 'one', scope: { kind: 'private', contactId: 'private-id', memoryEpoch: 'epoch' }, publicQuery: { topicIds: ['public:python'], freshness: 'current', sourceUrl: null } } };
  const result = await service.retrieve(options); assert.equal(await service.assertResultCurrent(result), true);
  await assert.rejects(service.assertResultCurrent({ ...result }), { code: 'INVALID_RETRIEVAL_RESULT' });
  now += 100; await assert.rejects(service.assertResultCurrent(result), { code: 'RETRIEVAL_EVIDENCE_EXPIRED' });
  now -= 101; await assert.rejects(service.assertResultCurrent(result), { code: 'RETRIEVAL_EVIDENCE_EXPIRED' });
  now = 10001; controller.abort(); await assert.rejects(service.assertResultCurrent(result), { code: 'REPLY_SUPERSEDED' });
  const second = await service.retrieve({ ...options, signal: freshSignal() }); await service.invalidateScope('private-id');
  await assert.rejects(service.assertResultCurrent(second), { code: 'MEMORY_EPOCH_CHANGED' });
});
