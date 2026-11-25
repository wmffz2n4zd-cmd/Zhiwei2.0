import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatLookupAdapter, publicPageLink } from '../src/chat-retrieval-http.js';
import { approvePublicTopics, createChatRetrieval, formatRetrievalEvidence } from '../src/chat-retrieval.js';
import { chatReplyDecisionPrompt, parseChatReplyDecision } from '../src/life-chat-decision.js';

const origin = 'https://museum.example.org/articles/window';
const other = 'https://catalog.example.org/works/25';
const link = { title: '作者的馆藏与原画说明', url: other };
const text = 'A museum describes its collection and references a separate catalog for the complete accession information. ';
const scope = { kind: 'private', contactId: 'qa:one', memoryEpoch: 'initial' };
const targets = () => approvePublicTopics({ explicitText: origin });
const ask = (topics, extra = {}) => ({ topics, assertCurrent: () => true, request: { version: 1, id: 'first', turnId: 'test', scope,
  publicQuery: { topicIds: [topics[0].id], freshness: 'current', sourceUrl: null }, ...extra } });
function scenario({ render, status = 200, html = '<main>' + text + '</main>', ttlMs = 6000, now = Date.now } = {}) {
  const urls = [];
  const adapter = createChatLookupAdapter({
    renderPage: render || (async response => ({ text: response.url === origin ? text : 'The catalog lists the particular accession date of the drawing.',
      links: response.url === origin ? [link] : [{ title: 'Third page', url: 'https://other.example.org/third' }] })),
    httpClient: async (url, { metrics }) => {
      urls.push(url); metrics.requests++;
      return { status, url, headers: { 'content-type': 'text/html' }, body: '<title>Museum collection</title>' + html };
    }
  });
  return { urls, service: createChatRetrieval({ adapter, ttlMs, now }) };
}

test('model can select one observed cross-domain anchor; parent and child preserve distinct receipts', async t => {
  const { urls, service } = scenario(); t.after(() => service.close());
  const first = await service.retrieve(ask(targets()));
  const links = await service.pageLinkTopics(first);
  assert.deepEqual(urls, [origin]); assert.equal(links.length, 1);
  const options = { topics: links, allowLookup: true };
  assert.match(chatReplyDecisionPrompt(null, options), /刚才读到的网页上实际可见的链接/);
  const decision = { action: 'lookup', reply: '', lookup: { topicIds: [links[0].id], freshness: 'current', sourceUrl: null },
    contactBoundary: { kind: 'none', quote: '' }, browseIntent: null };
  assert.equal(parseChatReplyDecision(decision, options).action, 'lookup');
  const second = await service.retrieve(ask(links));
  assert.deepEqual(urls, [origin,other]); assert.match(formatRetrievalEvidence(first), /museum describes/);
  assert.match(formatRetrievalEvidence(second), /accession date/); assert.equal(second.evidence[0].source.requestedUrl, other);
  assert.deepEqual(await service.pageLinkTopics(second), []);
  const finalPrompt = chatReplyDecisionPrompt(null, { topics: [], allowLookup: false });
  assert.match(finalPrompt, /收到两页摘录.*沿链接读到了目标页/);
  assert.doesNotMatch(finalPrompt, /不声称已经搜索/);
  const cached = await service.retrieve(ask(targets(), { turnId: 'next' }));
  assert.equal(cached.cacheHit, true); const cachedLinks = await service.pageLinkTopics(cached);
  assert.equal((await service.retrieve(ask(cachedLinks, { turnId: 'next' }))).cacheHit, true);
  assert.deepEqual(urls, [origin, other]);
});

test('fabricated, cross-user, other-turn, expired or cancelled follow topics cannot send an outbound URL', async t => {
  let clock = 100;
  const { urls, service } = scenario({ now: () => clock, ttlMs: 100 }); t.after(() => service.close());
  const ctrl = new AbortController();
  const first = await service.retrieve({ ...ask(targets()), signal: ctrl.signal });
  const links = await service.pageLinkTopics(first);
  for (const extra of [{ turnId: 'someone-else' }, { scope: { ...scope, contactId: 'another' } }, { scope: { ...scope, memoryEpoch: 'new' } }]) {
    await assert.rejects(service.retrieve(ask(links, extra)), { code: 'UNAPPROVED_PUBLIC_TOPIC' });
  }
  await assert.rejects(service.retrieve(ask(structuredClone(links))), { code: 'UNAPPROVED_PUBLIC_TOPIC' });
  await assert.rejects(service.pageLinkTopics(structuredClone(first)), { code: 'INVALID_RETRIEVAL_RESULT' });
  clock = 200;
  await assert.rejects(service.retrieve(ask(links)), { code: 'RETRIEVAL_EVIDENCE_EXPIRED' });
  clock = 101; ctrl.abort(); await assert.rejects(service.retrieve(ask(links)), { code: 'REPLY_SUPERSEDED' });
  assert.deepEqual(urls, [origin]);
});

test('failure to render optional links keeps original evidence; denied, login and missing pages cannot mint evidence', async t => {
  for (const [s, status, why] of [
    [scenario({ render: async () => { throw Error('Missing browser'); } }), 'partial', null],
    [scenario({ status: 401 }), 'restricted', 'login-required'], [scenario({ status: 403 }), 'restricted', null],
    [scenario({ html: '<main>Please sign in to continue ' + text + '</main>' }), 'restricted', 'login-required'],
    [scenario({ render: async () => ({ password: true, text, links: [link] }) }), 'restricted', 'login-required'],
    [scenario({ status: 404 }), 'failed', 'provider-failed']]) {
    t.after(() => s.service.close());
    const res = await s.service.retrieve(ask(targets())); assert.equal(res.status, status); assert.equal(res.errorCode, why);
    assert.deepEqual(await s.service.pageLinkTopics(res), []); assert.equal(res.evidence.length, status === 'partial' ? 1 : 0);
  }
  for (const path of ['/compose', '/action/publish', '/send', '/account/settings']) {
    assert.equal(publicPageLink('https://museum.example.org' + path, { observed: true }), null);
  }
  for (const url of [origin + '?secret=private', origin + '/logout', 'https://bing.com/search?q=keyword', 'http://127.0.0.1/page',
    'https://username:password@catalog.example.org/work', other + '/%252flogin']) assert.equal(publicPageLink(url), null);
});

test('anonymous X detail requires a visible status matching the requested post even after a redirect', async t => {
  const target = 'https://x.com/author/status/123';
  const topics = approvePublicTopics({ explicitText: target });
  const raw = '<title>X</title><main>JavaScript is disabled and the X app cannot show posts or replies in this browser. '.repeat(2) + '</main>';
  for (const [renderPage, expected] of [
    [null, 'failed'],
    [async () => { throw Error('Unavailable'); }, 'failed'],
    [async () => ({ text: 'App shell and unrelated recommendation', links: [] }), 'failed'],
    [async () => ({ statusId: '456', text: 'Other post', links: [] }), 'failed'],
    [async (_r, { statusId }) => ({ statusId, text: 'Verified exact author text', links: [] }), 'partial']
  ]) {
    const service = createChatRetrieval({ adapter: createChatLookupAdapter({ renderPage,
      httpClient: async () => ({ status: 200, url: target, body: raw, headers: { 'content-type': 'text/html' } }) }) });
    t.after(() => service.close());
    const result = await service.retrieve(ask(topics));
    assert.equal(result.status, expected);
    assert.equal(result.evidence.length, expected === 'partial' ? 1 : 0);
  }
});
