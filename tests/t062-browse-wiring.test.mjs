import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createWorld, parseWorldDecision } from '../src/world.js';
import { buildRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { buildLifePlanningPrompt, lifeDecisionSchema } from '../src/life-planner.js';
import { createLifeBrowseIntents, parseBrowseIntentDecision, buildLifeBrowseIntentPrompt } from '../src/life-browse-intents.js';
import { createLifeTimeline, normalizeLifeAction } from '../src/life-timeline.js';
import { createLifeBrowsing } from '../src/life-browsing.js';

const AT = Date.parse('2026-11-17T10:00:00Z');
const result = value => ({ text: JSON.stringify(value), usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
const page = (url, extra = {}) => ({ url, title: '公开材料', text: '实际可见文字', links: [], imagePaths: [], ...extra });
async function fixture(t, { decisions = [{ action: 'rest' }], config = {}, runtimeCapabilities, pages = {}, accounts, onExperience } = {}) {
  const root = resolve('runtime/tests'); await mkdir(root, { recursive: true });
  const projectDir = await mkdtemp(join(root, 't062-browse-')); const calls = [], prompts = [], experiences = [];
  if (accounts) { await mkdir(join(projectDir, 'data/world'), { recursive: true });
    await writeFile(join(projectDir, 'data/world/account-facts.json'), JSON.stringify({ version: 1, accounts })); }
  const reader = { status: () => ({ busy: false, mode: 'read' }), close: async () => {},
    read: async (url, options) => { calls.push({ op: 'read', url, options }); if (pages.throw) throw Error('SECRET raw read failure');
      return typeof pages[url] === 'function' ? pages[url](options) : pages[url] || page(url); },
    search: async (query, { platform }) => {
      calls.push({ op: 'search', query, platform }); if (pages.throw) throw Error('SECRET raw search failure');
      return pages[platform] || page(platform === 'x' ? 'https://x.com/search?q=topic&token=SECRET'
        : platform === 'xiaohongshu' ? 'https://www.xiaohongshu.com/search_result?keyword=topic' : 'https://www.bing.com/search?q=topic',
      platform === 'xiaohongshu' ? { links: [{ title: '具体笔记', url: 'https://www.xiaohongshu.com/explore/note123' }] } : {});
    }
  };
  let index = 0;
  const world = await createWorld({ projectDir, browser: reader, now: () => AT, runtimeCapabilities,
    config: { world: { enabled: true }, life: { enabled: true, planning: { enabled: true } }, runtimeBudget: { mode: 'observe', enabled: false }, ...config },
    think: async input => { prompts.push(input.prompt); return result(decisions[Math.min(index++, decisions.length - 1)]); },
    recordExperience: async value => { experiences.push(value); return onExperience ? onExperience(value) : { type: 'experience-recorded', experience: value }; } });
  t.after(async () => { await world.close(); assert.ok(projectDir.startsWith(root + sep)); await rm(projectDir, { recursive: true, force: true }); });
  return { world, projectDir, calls, prompts, experiences };
}

test('explicit target and subsequent reading decision migrate old platform hints and record the actual site', async t => {
  const f = await fixture(t, { decisions: [{ action: 'search', query: '下一公开话题', platform: 'web' }, { action: 'rest' }] });
  const out = await f.world.run('公开话题', { platform: 'x' });
  assert.deepEqual(f.calls.map(({ op, platform }) => [op, platform]), [['search', 'xiaohongshu'], ['search', 'xiaohongshu']]);
  assert.ok(out.observations.every(receipt => receipt.requestedPlatform === 'xiaohongshu' && receipt.platform === 'xiaohongshu'));
  assert.deepEqual(out.observations.map(row => row.sourceKind), ['search-results', 'search-results']);
  assert.equal(out.outcome, 'observed'); assert.doesNotMatch(JSON.stringify(out), /SECRET|token=|q=topic/);
  assert.match(f.prompts[0], /"sourceKind":"search-results"/);
  assert.ok(f.experiences.every(row => row.summary.includes('搜索结果页') && row.summary.includes('未因此读过链接正文')));
});

test('autonomous initial search and later omitted platform both use Xiaohongshu', async t => {
  const f = await fixture(t, { decisions: [{ action: 'search', query: '公开话题', platform: 'x' },
    { action: 'search', query: '继续这个公开话题' }, { action: 'rest' }] });
  await f.world.run(); assert.deepEqual(f.calls.map(row => row.platform), ['xiaohongshu', 'xiaohongshu']);
});

test('direct URL follows actual site and page receipts differ from search summaries', async t => {
  const f = await fixture(t, { decisions: [{ action: 'search', query: '继续公开话题' }, { action: 'rest' }] });
  const out = await f.world.run('https://x.com/author/status/123', { platform: 'web' });
  assert.deepEqual(f.calls.map(row => [row.op, row.platform]), [['read', undefined], ['search', 'xiaohongshu']]);
  assert.deepEqual(out.observations.map(row => row.platform), ['x', 'xiaohongshu']);
  assert.deepEqual(out.observations.map(row => row.sourceKind), ['page', 'search-results']);
  assert.match(f.experiences[0].summary, /页面可见内容（不代表完整全文）/);
});

test('invalid platform is rejected before browser or model work', async t => {
  const f = await fixture(t); await assert.rejects(f.world.run('话题', { platform: 'bad' }), /platform/);
  assert.throws(() => f.world.start('话题', { platform: 'bad' }), /platform/);
  assert.throws(() => parseWorldDecision('{"action":"search","query":"公开话题","platform":"bad"}'), /platform/);
  assert.equal(f.calls.length, 0); assert.equal(f.prompts.length, 0);
});

test('step boundary preserves observations and identifies proposed search or follow as not executed', async t => {
  for (const decision of [{ action: 'search', query: 'UNEXECUTED_QUERY', platform: 'web' }, { action: 'follow', linkIndex: 0 }]) {
    await t.test(decision.action, async t => {
      const f = await fixture(t, { config: { world: { enabled: true, maxSteps: 1 } }, decisions: [decision],
        pages: { xiaohongshu: page('https://www.xiaohongshu.com/search_result?keyword=实际搜索',
          { links: [{ title: '正文', url: 'https://example.org/article' }, { title: '笔记', url: 'https://www.xiaohongshu.com/explore/n123' }] }) } });
      const out = await f.world.run('实际搜索', { platform: 'x' });
      assert.equal(f.calls.length, 1); assert.equal(f.prompts.length, 1); assert.equal(f.experiences.length, 1);
      assert.equal(out.status, 'complete'); assert.equal(out.outcome, 'observed'); assert.equal(out.experienceRefs.length, 1);
      assert.equal(out.observations.length, 1); assert.equal(out.observations[0].platform, 'xiaohongshu');
      assert.deepEqual(out.unexecutedAction, { action: decision.action, platform: decision.action === 'search' ? 'xiaohongshu' : 'web', outcome: 'not-executed', reason: 'step-limit' });
      assert.match(out.message, /提议尚未执行/); assert.doesNotMatch(JSON.stringify(out), /UNEXECUTED_QUERY/);
      const saved = JSON.parse(await readFile(join(f.projectDir, 'data/world/state.json'), 'utf8')).last;
      assert.deepEqual(saved.unexecutedAction, out.unexecutedAction);
    });
  }
});

test('login, blocked and failure receipts never masquerade as observed content', async t => {
  for (const [name, supplied, outcome] of [
    ['login', { requiresLogin: true, blockedReason: 'login_required' }, 'login-required'],
    ['challenge', { blockedReason: 'human_verification_required' }, 'blocked'],
    ['network', { blockedReason: '网页读取失败或超时；SECRET' }, 'failed']
  ]) await t.test(name, async t => {
    const f = await fixture(t, { pages: { xiaohongshu: page('https://www.xiaohongshu.com/search_result?keyword=secret', supplied) } });
    const out = await f.world.run('公开话题', { platform: 'x' });
    assert.equal(out.status, 'needs_attention'); assert.equal(out.outcome, outcome);
    assert.equal(f.prompts.length, 0); assert.equal(f.experiences.length, 0);
    assert.doesNotMatch(JSON.stringify(out), /SECRET|secret/);
  });
});

test('rest without navigation and throwing navigation remain distinct after persistence', async t => {
  const rest = await fixture(t); const out = await rest.world.run();
  assert.equal(out.outcome, 'not-executed'); assert.deepEqual(out.observations, []); assert.equal(rest.calls.length, 0);
  const failed = await fixture(t, { pages: { throw: true } });
  await assert.rejects(failed.world.run('公开话题', { platform: 'x' }), /raw search/);
  const saved = JSON.parse(await readFile(join(failed.projectDir, 'data/world/state.json'), 'utf8')).last;
  assert.equal(saved.status, 'failed'); assert.equal(saved.outcome, 'failed'); assert.equal(saved.observations[0].reason, 'read-failed');
  assert.doesNotMatch(JSON.stringify(saved), /SECRET|raw search/);
});

test('XHS search navigation shell is not reading and does not prove login expiry', async t => {
  for (const suffix of ['', '/']) await t.test('path suffix ' + suffix, async t => {
    const url = 'https://www.xiaohongshu.com/search_result' + suffix + '?keyword=公开话题';
    const f = await fixture(t, { accounts: { xiaohongshu: { owned: true, configured: true, sessionStatus: 'unknown' } },
      pages: { xiaohongshu: page(url, { text: '发现 发布 通知 搜索筛选 版权所有', links: [{ title: '发现', url: 'https://www.xiaohongshu.com/explore' }] }) } });
    const out = await f.world.run('公开话题', { platform: 'xiaohongshu' });
    assert.equal(out.status, 'needs_attention'); assert.equal(out.observations[0].reason, 'content-not-ready');
    assert.equal(out.observations[0].sourceKind, 'search-results'); assert.equal(out.experienceRefs.length, 0);
    assert.equal(f.prompts.length, 0); assert.equal(f.experiences.length, 0);
    assert.equal(f.world.accountFacts().xiaohongshu.sessionStatus, 'unknown');
  });
});

test('XHS rendered search-result note links are observed summaries rather than navigation shells', async t => {
  const url = 'https://www.xiaohongshu.com/search_result?keyword=公开话题';
  const noteUrl = 'https://www.xiaohongshu.com/search_result/6afbc2c0123456789abcdef0';
  const f = await fixture(t, { pages: { xiaohongshu: page(url, {
    text: '搜索结果中实际可见的笔记标题与摘要', links: [{ title: '具体笔记', url: noteUrl }] }) } });
  const out = await f.world.run('公开话题', { platform: 'xiaohongshu' });
  assert.equal(out.status, 'complete'); assert.equal(out.outcome, 'observed');
  assert.equal(out.observations[0].sourceKind, 'search-results'); assert.equal(out.observations[0].reason, null);
  assert.equal(f.calls.length, 1); assert.equal(f.prompts.length, 1); assert.equal(f.experiences.length, 1);
  assert.match(f.experiences[0].summary, /搜索结果页/);
  assert.match(f.experiences[0].summary, /未因此读过链接正文/);
});

test('fresh public capability provider reaches planner and every reading decision', async t => {
  let enabled = true;
  const provider = () => buildRuntimeCapabilities({ worldEnabled: enabled, lifeEnabled: true,
    platforms: ['web', 'x', 'xiaohongshu'], accounts: { x: { owned: true, configured: true } }, now: AT });
  const f = await fixture(t, { runtimeCapabilities: provider, decisions: [{ thoughts: [], reconsiderAfterMinutes: 120 }] });
  await f.world.planLife({ policy: {} }); assert.match(f.prompts[0], /你有自己的账号/); assert.match(f.prompts[0], /本轮通过已给出的行动选项/);
  assert.doesNotMatch(f.prompts[0], /本轮内置联网搜索可用/);
  const read = await fixture(t, { runtimeCapabilities: provider });
  await read.world.run('公开话题'); assert.match(read.prompts[0], /你有自己的账号/);
  enabled = false; await read.world.run('另一个公开话题'); assert.match(read.prompts[1], /浏览服务目前不可用/);
});

test('account registry projects facts only and public success never proves login', async t => {
  const f = await fixture(t, { accounts: { x: { owned: true, configured: true, sessionStatus: 'unknown', cookie: 'SECRET' },
    xiaohongshu: { owned: true, configured: true, sessionStatus: 'valid', checkedAt: AT } },
    pages: { 'https://x.com/home': page('https://x.com/home', { requiresLogin: true, blockedReason: 'login_required' }) } });
  assert.doesNotMatch(JSON.stringify(f.world.accountFacts()), /cookie|SECRET/);
  await f.world.run('公开话题', { platform: 'x' }); assert.equal(f.world.accountFacts().x.sessionStatus, 'unknown');
  await f.world.preview('https://x.com/home'); assert.equal(f.world.accountFacts().x.sessionStatus, 'expired');
  const saved = JSON.parse(await readFile(join(f.projectDir, 'data/world/account-facts.json'), 'utf8'));
  assert.equal(saved.accounts.x.checkedAt, new Date(AT).toISOString()); assert.doesNotMatch(JSON.stringify(saved), /cookie|SECRET/);
  assert.equal(saved.accounts.xiaohongshu.sessionStatus, 'valid');
});

test('dated account evidence remains stale across repeated snapshot projection', async t => {
  const old = AT - 3 * 86400000;
  const f = await fixture(t, { accounts: { x: { owned: true, configured: true, sessionStatus: 'valid', checkedAt: old } } });
  assert.equal(f.world.accountFacts().x.sessionStatus, 'valid', 'the original observation is retained with its date');
  assert.equal(f.world.capabilities().accounts.x.sessionStatus, 'stale');
  assert.equal(f.world.capabilities().accounts.x.sessionStatus, 'stale');
  assert.equal(f.world.capabilities().accounts.x.checkedAt, new Date(old).toISOString());
});

test('legacy action shapes stay exact and new platform parsers reject unsupported sites', () => {
  assert.deepEqual(normalizeLifeAction({ type: 'browse', target: '公开话题' }), { type: 'browse', target: '公开话题' });
  assert.deepEqual(normalizeLifeAction({ type: 'browse', target: '公开话题', platform: 'x' }), { type: 'browse', target: '公开话题', platform: 'x' });
  assert.throws(() => normalizeLifeAction({ type: 'browse', target: '公开话题', platform: 'bad' }));
  assert.throws(() => parseBrowseIntentDecision({ browseIntent: { target: '公开话题', platform: 'bad', delayMinutes: 0, sourceRefs: ['profile'] } }, ['profile']));
  assert.ok(lifeDecisionSchema.properties.thoughts.items.properties.action.anyOf[2].required.includes('platform'));
  assert.match(buildLifePlanningPrompt('', { policy: {} }), /platform:"xiaohongshu"/);
});

test('public browse choice platform survives restart and reaches execution', async t => {
  const root = resolve('runtime/tests'); await mkdir(root, { recursive: true }); const directory = await mkdtemp(join(root, 't062-intents-'));
  const timeline = { policy: {}, snapshot: () => ({ sequence: 0, thoughts: [], events: [], plans: [], lastObservedAt: AT }), availability: () => ({ busy: false }) };
  const runs = [], inputs = [], drivers = [];
  const world = { status: async () => ({ enabled: true, busy: false }), capabilities: () => buildRuntimeCapabilities({ worldEnabled: true, now: AT }),
    run: async (target, options) => { runs.push({ target, ...options }); return { status: 'complete', experienceRefs: [] }; } };
  const open = async () => { const driver = await createLifeBrowseIntents({ directory, timeline, world, now: () => AT,
    decide: async input => { inputs.push(input); return { browseIntent: { target: '公开话题', platform: 'xiaohongshu', delayMinutes: 0, sourceRefs: ['profile'] } }; } }); drivers.push(driver); return driver; };
  t.after(async () => { for (const d of drivers) await d.close(); assert.ok(directory.startsWith(root + sep)); await rm(directory, { recursive: true, force: true }); });
  const first = await open(); assert.equal((await first.tick()).kind, 'scheduled'); await first.close();
  const queuePath = join(directory, 'browse-intents.json');
  const saved = JSON.parse(await readFile(queuePath, 'utf8'));
  for (const platform of [undefined, 'web', 'x']) {
    if (platform) saved.intents[0].platform = platform; else delete saved.intents[0].platform;
    await writeFile(queuePath, JSON.stringify(saved));
    const next = await open(); assert.equal((await next.tick()).kind, 'no-reading');
    assert.equal(runs.at(-1).platform, 'xiaohongshu'); await next.close();
  }
  assert.equal(inputs[0].capabilities.version, 1); assert.match(buildLifeBrowseIntentPrompt('', inputs[0]), /本轮通过已给出的行动选项/);
});

test('a signed result is selected by index, but model inputs, receipts, experiences and notes contain only public URLs', async t => {
  const signed = 'https://www.xiaohongshu.com/search_result/note2?xsec_token=PRIVATE_SIGNATURE&xsec_source=PRIVATE_SOURCE';
  const search = 'https://www.xiaohongshu.com/search_result?keyword=公开&xsec_source=PRIVATE_SOURCE';
  const f = await fixture(t, { decisions: [{ action: 'follow', linkIndex: 1 }, { action: 'note', summary: '作品正文', comment: '记住标题' }],
    pages: { xiaohongshu: page(search, { links: [{ title: '另一篇', url: 'https://www.xiaohongshu.com/explore/note1' }, { title: signed, url: signed }] }),
      [signed]: page(signed, { title: '', text: '正文有另一个公开引用 ' + signed }) } });
  const out = await f.world.run('公开');
  assert.equal(f.calls[1].url, signed);
  assert.deepEqual(out.observations.map(row => row.sourceKind), ['search-results', 'page']);
  assert.match(f.prompts[0], /note2/);
  const notes = await f.world.readBoards('xiaohongshu');
  assert.equal(notes.length, 1);
  assert.doesNotMatch(JSON.stringify([f.prompts, notes, out, f.experiences]), /xsec_|PRIVATE_(?:SIGNATURE|SOURCE)/);
});

test('legacy engine URL stops before opening at entry, preview, or follow without disturbing article links', async t => {
  const old = 'https://www.bing.com/search?q=DO_NOT_FORWARD';
  const article = 'https://example.org/article';
  const f = await fixture(t, { decisions: [{ action: 'follow', linkIndex: 0 }],
    pages: { [article]: page(article, { links: [{ title: '旧搜索页', url: old }] }) } });
  for (const url of [old, 'https://www.google.co.jp/search?q=old', 'https://duckduckgo.com/?q=old', 'https://x.com/search?q=old']) {
    const out = await f.world.run(url);
    assert.equal(out.observations[0].reason, 'search-source-retired'); assert.equal(out.experienceRefs.length, 0);
    assert.equal((await f.world.preview(url)).blockedReason, 'search_source_retired');
  }
  assert.equal(f.calls.length, 0); assert.equal(f.prompts.length, 0);
  const out = await f.world.run(article);
  assert.deepEqual(f.calls.map(call => call.url), [article]);
  assert.equal(out.observations.at(-1).reason, 'search-source-retired');
  assert.equal(out.experienceRefs.length, 1);
});

const chatQuery = '天文学 研究', chatResults = 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(chatQuery);
const signedNote = 'https://www.xiaohongshu.com/search_result/noteA?xsec_token=PRIVATE_SIGNATURE';
const secondNote = 'https://www.xiaohongshu.com/explore/noteB?xsec_source=PRIVATE_SOURCE';
const cards = [{ title: '站外导航', url: 'https://example.org/' }, { title: '星云观测', url: signedNote },
  { title: '同笔记第二个链接', url: 'https://www.xiaohongshu.com/explore/noteA' }, { title: '另一张观测卡', url: secondNote }];

test('reopened old timeline journals retain original action hashes while the due activity uses Xiaohongshu only', async t => {
  for (const platform of [undefined, 'web', 'x']) await t.test(platform || 'omitted', async t => {
    let at = AT, timeline;
    const f = await fixture(t, { onExperience: value => timeline.recordExperience(value) });
    const options = { directory: join(f.projectDir, 'data/life'), now: () => at };
    const action = { type: 'browse', target: '想再看看星云', ...(platform ? { platform } : {}) };
    timeline = await createLifeTimeline(options);
    let driver;
    try {
      await timeline.addThought({ id: 'old-reading', text: '待到明天看看', source: { kind: 'interest', ref: 'old-reading' }, strength: 0.7,
        activity: { title: '观星', statusText: '正在看资料', durationMs: 300000, busy: false, mode: 'external', action } });
      await timeline.planThought('old-reading', { id: 'old-plan', startAt: at + 60000 });
      await timeline.close(); timeline = await createLifeTimeline(options);
      assert.deepEqual(timeline.snapshot().plans[0].action, action);
      at += 60000; await timeline.tick();
      driver = createLifeBrowsing({ timeline, world: f.world, now: () => at });
      assert.equal((await driver.tick()).kind, 'completed');
      assert.deepEqual(f.calls.map(row => [row.op, row.platform]), [['search', 'xiaohongshu']]);
      assert.equal((await driver.tick()).kind, 'waiting');
      assert.deepEqual(timeline.snapshot().plans[0].action, action);
    } finally { await driver?.close(); await timeline.close(); }
  });
});

test('chat retrieval accepts only public vocabulary, returns exact note body or labelled card and has no world side effects', async t => {
  const f = await fixture(t, { pages: { xiaohongshu: page(chatResults, { links: cards }),
    [signedNote]: page(signedNote, { text: '其他用户评论不可成为正文', noteDetail: { title: '观测笔记', text: '这篇笔记自己的作者正文' } }),
    [secondNote]: page('https://www.xiaohongshu.com/explore/unrelated', { noteDetail: { title: '错误重定向', text: '错误页面正文' } }) } });
  await assert.rejects(f.world.searchPublicNotes('我私聊提到的具体故事'), /未获准/);
  assert.equal(f.calls.length, 0);
  const before = await f.world.status();
  const out = await f.world.searchPublicNotes(chatQuery);
  assert.equal(out.status, 'partial'); assert.equal(out.pageRequests, 2);
  assert.equal(out.sources[0].capture, 'page_excerpt'); assert.equal(out.sources[0].text, '这篇笔记自己的作者正文');
  assert.deepEqual(out.sources[1], { title: '另一张观测卡', text: '另一张观测卡', capture: 'search_snippet', url: 'https://www.xiaohongshu.com/explore/noteB' });
  assert.doesNotMatch(JSON.stringify(out), /私人|xsec_|PRIVATE_|其他用户|错误页面/);
  assert.deepEqual(f.calls.slice(1).map(call => call.url), [signedNote, secondNote]);
  assert.ok(f.calls.slice(1).every(call => call.options.captureImages === false));
  assert.equal(f.prompts.length, 0); assert.equal(f.experiences.length, 0);
  const after = await f.world.status(); assert.equal(after.last, before.last); assert.deepEqual(after.usage, before.usage);
  assert.equal((await f.world.readBoards('xiaohongshu')).length, 0);
});

test('chat cancellation holds the shared browser until the current operation ends and starts no second note', async t => {
  let started, finish;
  const entered = new Promise(resolve => { started = resolve; }), waiting = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { pages: { xiaohongshu: page(chatResults, { links: cards }), [signedNote]: async () => { started(); await waiting; return page(signedNote); } } });
  const controller = new AbortController(), pending = f.world.searchPublicNotes(chatQuery, { signal: controller.signal });
  await entered;
  assert.equal(f.world.readiness().busy, true);
  await assert.rejects(f.world.searchPublicNotes(chatQuery), { code: 'WORLD_BUSY' });
  await assert.rejects(f.world.run('另一个主题'), { code: 'WORLD_BUSY' });
  controller.abort(); finish(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.calls.length, 2); assert.equal(f.world.readiness().busy, false);
});

test('a media-only or mismatched X post cannot become a reading experience', async t => {
  const url = 'https://x.com/author/status/123';
  for (const [reason, outcome, receipt] of [
    ['x_media_without_author_text', 'blocked', 'content-not-ready'],
    ['x_status_mismatch', 'failed', 'read-failed']
  ]) await t.test(reason, async t => {
    const f = await fixture(t, { pages: { [url]: page(url, { blockedReason: reason }) } });
    const run = await f.world.run(url);
    assert.equal(run.observations[0].outcome, outcome);
    assert.equal(run.observations[0].reason, receipt);
    assert.deepEqual(run.experienceRefs, []);
    assert.equal(f.prompts.length, 0);
  });
});

test('confirmed empty, restricted and indeterminate search have distinct receipts without fallback or fabricated reading', async t => {
  for (const [reason, chat, autonomous, receipt] of [['search_no_results', 'empty', 'complete', 'no-results'],
    ['human_verification_required', 'restricted', 'needs_attention', 'human-verification-required'],
    ['xhs_content_not_ready', 'failed', 'needs_attention', 'content-not-ready']]) await t.test(reason, async t => {
    const f = await fixture(t, { pages: { xiaohongshu: page(chatResults, { blockedReason: reason }) } });
    assert.deepEqual(await f.world.searchPublicNotes(chatQuery), { status: chat, sources: [], pageRequests: 0 });
    const out = await f.world.run(chatQuery, { platform: 'web' });
    assert.equal(out.status, autonomous); assert.equal(out.observations[0].reason, receipt);
    assert.deepEqual(out.experienceRefs, []); assert.equal(f.prompts.length, 0);
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.platform === 'xiaohongshu'));
  });
});
