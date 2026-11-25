import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPrivateThoughtActions, createThoughtArticleReader } from '../src/private-thought-actions.js';

const url = 'https://www.iana.org/help/example-domains';
const title = 'Example Domains';
const body = '<article><p>' + 'The article includes a description of an example namespace. '.repeat(16) + 'End of the original article.</p></article>';
const html = '<html><head><title>Example Domains</title></head><body>' + body + '</body></html>';
const now = () => 1800000000000;
const sha = value => createHash('sha256').update(value).digest('hex');
const act = { decision: 'act', delayMinutes: null, sourceRef: 'article-1' };
const source = (text = '原文《Example Domains》 ' + url) => ({ valid: true, inbound: [{ id: 'inbound-1', text }], sent: [] });
function readerFor(response, onRead = () => {}) {
  return createThoughtArticleReader({ now, httpClient: async (original, options) => {
    onRead(original, options);
    assert.equal(original, url);
    assert.equal(options.followRedirects, false);
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html, url, ...response };
  } });
}

function fixture(options = {}) {
  const ticket = { action: '读完原先分享的文章', subject: title, scope: 'pwa:private:aaa', createdAt: now() - 86400000, ...options.ticket };
  let done = null, started = null, claims = 0, reads = 0;
  const store = {
    claimDuePrivateThought() { claims++; return done ? null : ticket; },
    privateThoughtSource() { return typeof options.origin === 'function' ? options.origin() : options.origin || source(); },
    startPrivateThoughtRead(issued, proof) {
      assert.strictEqual(issued, ticket); assert.equal(started, null); started = proof; return true;
    },
    finishPrivateThought(issued, result) { assert.strictEqual(issued, ticket); done = result; return true; }
  };
  const worker = createPrivateThoughtActions({ store, now, decide: options.decide || (() => act), canRead: options.canRead,
    isCurrent: options.isCurrent || (() => true), readArticle: async (...args) => {
      reads++; assert.deepEqual(started, { sourceId:'inbound-1', url });
      return (options.readArticle || readerFor({}))(...args);
    } });
  return { worker, get done() { return done; }, get started() { return started; }, get claims() { return claims; }, get reads() { return reads; } };
}

test('only exact original URL leaves the executor and full finite article includes the ending in the evidence', async () => {
  const f = fixture({ origin: source('私聊隐私文字 《Example Domains》 ' + url), decide: async ({ prompt, schema, signal, scope, canContinue }) => {
    assert.equal(scope, 'pwa:private:aaa'); assert.equal(signal.aborted, false); assert.equal(await canContinue(), true);
    assert.match(prompt, /article-1/); assert.doesNotMatch(prompt, /私聊隐私文字|inbound-1/);
    assert.equal(schema.additionalProperties, false);
    return JSON.stringify(act);
  } });
  assert.equal(await f.worker.tick(), 'read'); assert.equal(await f.worker.tick(), 'idle');
  assert.equal(f.reads, 1); assert.equal(f.done.receipt.coverage, 'complete-article');
  assert.match(f.done.receipt.excerpt, /End of the original article\.$/);
  assert.ok(f.done.receipt.excerpt.length > 600);
  assert.equal(f.done.receipt.contentHash, sha(f.done.receipt.excerpt));
});

test('reconsideration can specifically defer or abandon without a read', async () => {
  const deferred = fixture({ decide: () => ({ decision:'defer', delayMinutes: 4320, sourceRef:null }) });
  await deferred.worker.tick();
  assert.deepEqual(deferred.done, { status: 'deferred', nextConsiderAt: now() + 4320 * 60000 });
  const abandoned = fixture({ decide: () => ({ decision:'abandon', delayMinutes:null, sourceRef:null }) });
  await abandoned.worker.tick();
  assert.deepEqual(abandoned.done, { status:'abandoned' });
  assert.equal(abandoned.reads + deferred.reads, 0);
});

test('a later reconsideration sees its own prior deferral and promised next time', async () => {
  const lastConsideredAt = now() - 2 * 86400000, scheduledFor = now() - 60000;
  const f = fixture({ticket:{deferrals:2,lastConsideredAt,scheduledFor},decide:({prompt}) => {
    const line = prompt.split('\n').find(item => item.startsWith('之前的复议：'));
    assert.deepEqual(JSON.parse(line.slice('之前的复议：'.length)), {
      deferrals:2,lastConsideredAt:new Date(lastConsideredAt).toISOString(),scheduledFor:new Date(scheduledFor).toISOString()
    });
    return { decision:'abandon',sourceRef:null,delayMinutes:null };
  }});
  assert.equal(await f.worker.tick(),'abandoned');
});

test('an absent, unsafe, ambiguous, sent-only or differently titled article cannot be replaced with another page', async () => {
  for (const [subject, original] of [
    [title, source('只聊《Example Domains》这篇文章。')],
    [title, source('《Example Domains》 https://www.iana.org/login')],
    [title, source('《Example Domains》 ' + url + ' 还有 https://www.iana.org/different')],
    [title, { valid:true, inbound:[{ id:'inbound-1',text:'谢谢' }], sent:[{ id:'sent-1',text:'《Example Domains》 ' + url }] }],
    ['甲的续集', source('读到的是《甲》 ' + url)],
    ['《甲》', source('《甲的续集》 ' + url)],
    ['《甲》', source('之后再读《甲》，现在给你《乙》 ' + url)],
    [title, source('Example DomainsExtra ' + url)],
    [title, source('另一篇文章 ' + url)],
    [url, source('https://www.iana.org/one https://www.iana.org/two https://www.iana.org/three ' + url)]
  ]) {
    const f = fixture({ ticket: { subject }, origin: original, decide: ({prompt}) => {
      assert.match(prompt, /可核对的文章来源：\[\]/u); return { ...act, sourceRef:null };
    } });
    assert.equal(await f.worker.tick(), 'unavailable'); assert.equal(f.done.receipt.reason, 'no-verified-article');
    assert.equal(f.reads, 0);
  }
});

test('exact URL in the thought can disambiguate multiple URLs in an original source', async () => {
  const f = fixture({ ticket:{subject:url}, origin:source('读的两篇：' + url + ' 或 https://www.iana.org/other') });
  assert.equal(await f.worker.tick(), 'read');
});

test('invalid decision never fabricates a user-visible disposition or initiates a read', async () => {
  for (const modelOutput of [{...act,sourceRef:'https://www.iana.org/injected'}, {...act,delayMinutes:1}, 'invalid JSON',
    {decision:'defer',sourceRef:null,delayMinutes:0}]) {
    const f = fixture({decide:() => modelOutput});
    assert.equal(await f.worker.tick(),'review-pending'); assert.equal(f.done,null); assert.equal(f.reads,0);
  }
});

test('a changed epoch, lost original message or disabled web reading fences execution', async () => {
  const stale = fixture({ isCurrent:() => false, decide:() => assert.fail('called model for old epoch') });
  assert.equal(await stale.worker.tick(), 'stale'); assert.equal(stale.reads,0);
  let original = source();
  const lost = fixture({ origin:() => original, decide:() => { original = {valid:false,inbound:[],sent:[]}; return act; } });
  assert.equal(await lost.worker.tick(), 'unavailable'); assert.equal(lost.done.receipt.reason, 'source-unavailable');
  const disabled = fixture({canRead:() => false}); await disabled.worker.tick();
  assert.equal(disabled.reads,0); assert.equal(disabled.done.receipt.reason,'web-reading-disabled');
});

test('overlapping ticks share one review and closing while reading discards the late result', async () => {
  const began = Promise.withResolvers(), resume = Promise.withResolvers();
  let readSignal;
  const f = fixture({readArticle:async (target,{signal}) => {
    readSignal = signal; began.resolve(); await resume.promise; return readerFor({})(target,{});
  }});
  const first = f.worker.tick(); assert.strictEqual(first, f.worker.tick());
  await began.promise; f.worker.invalidate('pwa:private:other'); assert.equal(readSignal.aborted, false);
  const closed = f.worker.close(); assert.equal(readSignal.aborted, true);
  resume.resolve(); await closed;
  assert.equal(await first,'unknown'); assert.equal(f.done.receipt.reason,'read-interrupted');
  assert.equal(await f.worker.tick(),'closed'); assert.equal(f.claims,1); assert.equal(f.reads,1);
});

test('revocation during the model call never substitutes a late read or decision', async () => {
  const began = Promise.withResolvers(), resume = Promise.withResolvers();
  const f = fixture({decide:async () => { began.resolve(); await resume.promise; return act; }});
  const pending=f.worker.tick(); await began.promise; f.worker.invalidate('pwa:private:aaa'); resume.resolve();
  assert.equal(await pending,'interrupted'); assert.equal(f.done,null); assert.equal(f.reads,0);
});

test('HTTP failures and unverified redirects yield actual unavailability without evidence', async () => {
  for (const [response,reason] of [
    [{status:403},'restricted'], [{status:404},'no-readable-page'], [{url:'https://www.iana.org/other'},'redirect-unverified'],
    [{body:'<html><title>Sign In</title>' + body + '</html>'},'restricted'],
    [{body:'<html><script src="/cf-chl-app.js"></script>' + body + '</html>'},'no-readable-page']
  ]) {
    const out=await readerFor(response)(url,{}); assert.equal(out.status,'unavailable'); assert.equal(out.receipt.reason, reason);
    assert.equal(out.receipt.excerpt, undefined);
  }
  const redirect = createThoughtArticleReader({httpClient:async () => { throw Object.assign(Error(),{code:'UNAPPROVED_REDIRECT'}); }});
  assert.equal((await redirect(url,{})).receipt.reason,'redirect-unverified');
});

test('partial transfers, long pages, document shells, text/plain markup and subscription teasers preserve limited coverage', async () => {
  for (const response of [
    {status:206}, {headers:{'content-type':'text/html','content-range':'bytes 0-999/2000'}},
    {body:html.replaceAll('article>','main>')}, {body:html.replace('</article>','Subscribe to read more.</article>')},
    {body:'<body><article></article><p>' + 'Outside the empty article. '.repeat(40) + '</p></body>'},
    {body:'<article>' + 'words '.repeat(2500) + '</article>'},
    {status:206,headers:{'content-type':'text/plain'},body:'words and spaces '.repeat(12)}
  ]) {
    const out = await readerFor(response)(url,{});
    assert.equal(out.status, 'read'); assert.equal(out.receipt.coverage,'page-excerpt'); assert.ok(out.receipt.excerpt.length <= 600);
  }
  const plain = await readerFor({headers:{'content-type':'text/plain'},body:'Symbols <item> &lt; belong to this original page. '.repeat(5)})(url,{});
  assert.equal(plain.receipt.coverage, 'page-excerpt'); assert.match(plain.receipt.excerpt, /<item> &lt;/);
});
