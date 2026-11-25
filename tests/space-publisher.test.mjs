import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSpaceArticleReader, createSpacePublisher } from '../src/space-publisher.js';

const at = 1795046622000;
const daily = { kind: 'daily', eventId: 'life:54:1', observedAt: at, summary: '傍晚整理了几页手写诗。' };
const share = { kind: 'share', eventId: 'world:527a9e23:0', observedAt: at, url: 'https://www.example.org/field-notes' };
const title = '野外观察记录';
const body = '溪岸边，苔藓从石缝边缘长向背光的一面。'.repeat(8);
const hash = text => createHash('sha256').update(text).digest('hex');
const comment = '喜欢这种蹲下来才看得见的细节。';
const publish = { action: 'publish', text: comment };
const skip = { action: 'skip', text: null };
function storeForTest() {
  const held = new Set(), completed = new Map();
  return {
    completed,
    beginSpaceDecision(key) {
      if (held.has(key) || completed.has(key)) return null;
      held.add(key); return 'ticket';
    },
    hasSpaceDecision(key) { return completed.has(key); },
    releaseSpaceDecision({ eventKey, claim }) { assert.equal(claim, 'ticket'); return held.delete(eventKey); },
    finishSpaceDecision({ eventKey, claim, post }) {
      assert.equal(claim, 'ticket'); assert(held.delete(eventKey));
      completed.set(eventKey, post);
      return { duplicate: false };
    }
  };
}
const freshReader = () => createSpaceArticleReader({ now: () => at + 100, httpClient: async url => ({
  status: 200, url, headers: { 'content-type': 'text/html' },
  body: '<html><title>' + title + '</title><article>' + body + '</article></html>'
}) });
function setup(options = {}) {
  const store = options.store || storeForTest();
  const calls = [];
  const publisher = createSpacePublisher({ store, readArticle: freshReader(), ...options,
    decide: async input => { calls.push(input); return options.decide ? options.decide(input) : publish; } });
  return { store, calls, publisher };
}

test('completed public role activity offers only its permitted summary and time', async () => {
  const { store, calls, publisher } = setup({ readArticle: assert.fail });
  assert.equal(await publisher.consider(daily), 'published');
  assert.match(calls[0].prompt, /所有登录知微的用户/);
  assert.deepEqual(JSON.parse(calls[0].prompt.split('\n').at(-1)), {
    observedAt: new Date(at).toISOString(), summary: daily.summary });
  assert.deepEqual(store.completed.get('daily:' + daily.eventId), { kind: 'daily', text: comment, source: null });
});

test('reads a public post anonymously and binds only its verified source to the decision', async () => {
  const { store, calls, publisher } = setup();
  assert.equal(await publisher.consider(share), 'published');
  assert.deepEqual(store.completed.get('share:' + share.eventId), { kind: 'share', text: comment,
    source: { url: share.url, title, observedAt: at + 100, contentHash: hash(body),
      basisKind: 'article-excerpt', basisText: body, basisHash: hash(body) } });
  assert.deepEqual(JSON.parse(calls[0].prompt.split('\n').at(-1)), {
    observedAt: new Date(at + 100).toISOString(), title, excerpt: body });
  assert.ok(!calls[0].prompt.includes(share.url));
});

test('a private field, malformed opportunity, catalog page or unsupported site is never read or offered', async () => {
  const { publisher, calls, store } = setup({ readArticle: assert.fail });
  const excluded = [{ ...daily, scope: 'pwa:private:test' }, { ...daily, summary: '' },
    { ...share, excerpt: 'private browser copy' }, { ...share, url: 'https://www.example.org' },
    { ...share, url: 'https://example.org/search' }, { ...share, url: 'https://example.org/post?key=hidden' },
    { ...share, url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }, { ...share, url: 'https://youtu.be/jNQXAC9IVRw' },
    { ...share, url: 'https://www.bilibili.com/video/' }];
  for (const input of excluded) assert.equal(await publisher.consider(input), 'invalid');
  assert.equal(calls.length, 0);
  assert.equal(store.completed.size, 0);
});

test('no source and no post on inaccessible, changed or inconsistent evidence', async () => {
  const receipt = (await freshReader()(share.url)).receipt;
  for (const result of [{ status: 'unavailable' }, { status: 'read', receipt: { ...receipt, url: share.url + '/other' } },
    { status: 'read', receipt: { ...receipt, title: 'bad\u2028title' } },
    { status: 'read', receipt: { ...receipt, contentHash: '0'.repeat(64) } },
    { status: 'read', receipt: { ...receipt, excerpt: '' } }]) {
    const { publisher, calls, store } = setup({ readArticle: async () => result });
    assert.equal(await publisher.consider(share), 'unavailable');
    assert.equal(calls.length, 0);
    assert.equal(store.completed.get('share:' + share.eventId), null);
  }
});

test('bounded retained text never splits a Unicode character at the model input boundary', async () => {
  const excerpt = '文'.repeat(1999) + '🐉结尾';
  const readArticle = async () => ({ status: 'read', receipt: { url: share.url, title, fetchedAt: at, excerpt,
    coverage: 'complete-article', textLength: excerpt.length, contentHash: hash(excerpt) } });
  const { store, calls, publisher } = setup({ readArticle });
  assert.equal(await publisher.consider(share), 'published');
  const saved = store.completed.get('share:' + share.eventId).source;
  assert.equal(saved.basisText, '文'.repeat(1999));
  assert.equal(JSON.parse(calls[0].prompt.split('\n').at(-1)).excerpt, saved.basisText);
  assert.equal(saved.basisHash, hash(saved.basisText));
});

test('article reader rejects text-rich generic navigation, script shells, catalog links and wrong MIME types', async () => {
  for (const [type, html] of [
    ['text/html', '<main><nav><p>' + body + '</p></nav></main>'],
    ['text/html', '<article><a href="/item">' + body + '</a></article>'],
    ['text/html', '<script type="text/html"><article>' + body + '</article></script><div>spinner</div>'],
    ['text/html', '<p>仅标题</p><footer>' + body + '</footer>'],
    ['application/rss+xml', '<rss><item><description>' + body + '</description></item></rss>']
  ]) {
    const reader = createSpaceArticleReader({ httpClient: async url => ({
      status: 200, url, headers: { 'content-type': type }, body: html
    }) });
    const { publisher, calls } = setup({ readArticle: reader });
    assert.equal(await publisher.consider(share), 'unavailable'); assert.equal(calls.length, 0);
  }
});

test('public social post uses its article text; a long login notice or generic platform shell yields no source', async () => {
  const item = { ...share, url: 'https://www.xiaohongshu.com/explore/example123' };
  for (const [markup, status] of [['<article>' + body + '</article>', 'published'],
    ['<article>请先登录' + body + '</article>', 'unavailable'],
    ['<main><p>' + body + '</p></main>', 'unavailable']]) {
    const reader = createSpaceArticleReader({ httpClient: async url => ({
      status: 200, url, headers: { 'content-type': 'text/html' }, body: '<title>' + title + '</title>' + markup
    }) });
    const { publisher } = setup({ readArticle: reader });
    assert.equal(await publisher.consider(item), status);
  }
});

test('only actual time-coded video evidence can supply video commentary; no article fallback', async () => {
  const item = { ...share, url: 'https://www.bilibili.com/video/BV1K54y1r7dU?p=2' };
  const excerpt = '00:32 她说春天终究会来的。';
  const source = { title: '归来', url: item.url, fetchedAt: at, excerpt, contentHash: hash(excerpt) };
  for (const bad of [null, { ...source, contentHash: hash('different') }, { ...source, url: share.url }, { ...source, scope: 'private' }]) {
    const { publisher, calls } = setup({ readArticle: assert.fail, readVideo: () => bad });
    assert.equal(await publisher.consider(item), 'unavailable'); assert.equal(calls.length, 0);
  }
  const { publisher, calls, store } = setup({ readArticle: assert.fail, readVideo: async url => { assert.equal(url, item.url); return source; } });
  assert.equal(await publisher.consider(item), 'published');
  assert.match(calls[0].prompt, /不能描写画面/);
  assert.equal(JSON.parse(calls[0].prompt.split('\n').at(-1)).subtitles, excerpt);
  assert.deepEqual(store.completed.get('share:' + item.eventId).source, {
    title: source.title, url: item.url, contentHash: source.contentHash, observedAt: at,
    basisKind: 'video-subtitles', basisText: excerpt, basisHash: source.contentHash });
});

test('concurrent workers see a busy claim; an explicit skip remains terminal after restart', async () => {
  let resume;
  const { store, calls, publisher } = setup({ decide: () => new Promise(resolve => { resume = resolve; }) });
  const first = publisher.consider(daily);
  const later = setup({ store });
  assert.equal(await later.publisher.consider(daily), 'busy');
  resume(skip);
  assert.equal(await first, 'skipped');
  assert.equal(await setup({ store }).publisher.consider(daily), 'duplicate');
  assert.equal(await publisher.consider(daily), 'duplicate');
  assert.equal(calls.length, 1);
  assert.equal(later.calls.length, 0);
  assert.equal(store.completed.get('daily:' + daily.eventId), null);
});

test('malformed decision, extra URL, model failure and late cancellation produce no public post', async () => {
  for (const raw of ['not json', { ...publish, url: share.url }, { action: 'publish', text: share.url },
    { action: 'skip', text: 'private' }, { action: 'publish', text: ' ' }]) {
    const { store, publisher } = setup({ decide: () => raw });
    assert.equal(await publisher.consider(daily), 'unavailable');
    assert.equal(store.completed.get('daily:' + daily.eventId), null);
  }
  const broken = setup({ decide: () => { throw Error('unavailable'); } });
  assert.equal(await broken.publisher.consider(daily), 'unavailable');
  let available = true;
  const stale = setup({ canPublish: () => available, decide: () => { available = false; return publish; } });
  assert.equal(await stale.publisher.consider(share), 'cancelled');
  assert.equal(stale.store.hasSpaceDecision('share:' + share.eventId), false);
  const resumed = setup({ store: stale.store });
  assert.equal(await resumed.publisher.consider(share), 'published');
  assert.equal(await resumed.publisher.consider(share), 'duplicate');
  assert.equal(stale.store.completed.size, 1);
  assert.equal(resumed.calls.length, 1);
  const abort = new AbortController();
  const stopped = setup({ readArticle: async url => { abort.abort(); return freshReader()(url); } });
  assert.equal(await stopped.publisher.consider(share, { signal: abort.signal }), 'cancelled');
  assert.equal(stopped.calls.length, 0);
  assert.equal(stopped.store.hasSpaceDecision('share:' + share.eventId), false);
});
