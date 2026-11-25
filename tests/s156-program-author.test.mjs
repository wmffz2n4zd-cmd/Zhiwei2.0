import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { authorWebsiteProgram } from '../src/creative-program-author.js';
import { buildCreativeProgramDocument } from '../src/creative-program-runner.js';
import { creativeSpecGuidance, renderCreativeWork } from '../src/creative-render.js';
import { buildRuntimeCapabilities, renderRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { creativeDecisionPrompt, prepareCreativeWork, readCreativeDecision } from '../src/private-creative-work.js';
import { parseChatReplyDecision, parseLifeChatDecision } from '../src/life-chat-decision.js';
import { parseProactiveDecision } from '../src/life-proactive.js';

const title = '茶室 <一>';
const brief = '切换茶室主题，按点击后的实测决定是否调色。';
const page = color => '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>.dark{background:#222;color:' +
  color + '}</style></head><body><button id="theme">换色</button><p>茶</p><script>document.getElementById("theme").addEventListener("click",()=>document.body.classList.toggle("dark"))</script></body></html>';
const initial = { mode: 'program', html: page('#222'), clicks: ['theme'] };
const revised = { html: page('#eee'), clicks: ['theme'] };
const shots = (text, contrast) => [null, 'theme'].map((action, i) => ({
  action, text, samples: [{ text: '茶', contrast: action ? contrast : 10 }], screenshot: Buffer.from(text + i)
}));
const data = ({ prompt }) => JSON.parse(prompt.split('\n\n').at(-1));

test('a website-only private reply can send just the completed work and retains all other decision boundaries', async () => {
  const options = { allowReceiptOnly: true };
  const work = { kind: 'website', title, brief };
  const common = { reply: '', contactBoundary: { kind: 'none', quote: '' }, browseIntent: null, creativeWork: work };
  const retrieval = { ...common, action: 'reply', lookup: null };
  const life = { ...common, contextMore: false };
  const parse = value => parseChatReplyDecision(value, { allowBrowseIntent: true, allowPrivateThought: true });
  const selected = readCreativeDecision(retrieval, ['website'], parse, options);
  assert.deepEqual(selected, retrieval);
  assert.deepEqual(readCreativeDecision(life, ['website'], parseLifeChatDecision, options), life);
  assert.match(creativeDecisionPrompt(['website'], options), /只要最终网页/);
  assert.doesNotMatch(creativeDecisionPrompt(['website']), /只要最终网页/);
  for (const change of [{ reply: ' ' }, { action: 'memory_more' }, { action: 'lookup' },
    { lookup: { topicIds: ['other'], freshness: 'current', sourceUrl: null } },
    { browseIntent: { delayMinutes: 0 } }, { privateThought: { action: '做', subject: '网页' } },
    { contactBoundary: { kind: 'pause', quote: '停' } }, { contactBoundary: { kind: 'resume', quote: '来' } },
    { creativeWork: { ...work, brief: '' } }, { creativeWork: { ...work, kind: 'design' } }]) {
    assert.throws(() => readCreativeDecision({ ...retrieval, ...change }, ['website','design'], parse, options));
  }
  assert.throws(() => readCreativeDecision({ ...life, contextMore: true }, ['website'], parseLifeChatDecision, options));
  assert.throws(() => readCreativeDecision({ reply: null, sourceRefs: [], creativeWork: work }, ['website'], parseProactiveDecision, options));
  assert.throws(() => readCreativeDecision(retrieval, ['website'], parse));
  const { creativeWork, ...plainChat } = retrieval;
  assert.deepEqual(readCreativeDecision({ ...plainChat, creativeWork: null }, ['website'], parse, options), parse(plainChat));
  const steps = [];
  const delivered = await prepareCreativeWork({
    proposal: selected.creativeWork, binding: {}, assertCurrent: async () => {},
    store: {
      claimCreativeWork() { steps.push('claim'); return { status: 'claimed', token: 'test' }; },
      finishCreativeWork({ output }) {
        steps.push('persist');
        assert.equal(output.preview, 'preview.html');
        assert.equal(output.files.find(file => file.name === 'index.html').bytes.toString(), buildCreativeProgramDocument(initial.html));
        return { workId: 'website' };
      }
    },
    draft: async () => { steps.push('draft'); return initial; },
    render: ({ title, spec }) => authorWebsiteProgram(title, spec, { brief, programModel: async () => {
      steps.push('review'); return { action: 'accept', finding: '点击后的页面显示了正文。' };
    } }, async () => { steps.push('run'); return { observations: shots('茶', 10), errors: [] }; }),
    describe: async receipt => { steps.push('receipt'); assert.equal(receipt.status, 'ready'); return '请收下网页。'; }
  });
  assert.deepEqual(steps, ['claim', 'draft', 'run', 'review', 'persist', 'receipt']);
  assert.deepEqual(delivered, { workId: 'website', text: '请收下网页。' });
});

test('each review receives this run’s exact image files, readings and same-page source, then only the accepted version ships', async () => {
  const runs = [], calls = [], paths = [];
  const run = async draft => {
    runs.push(draft);
    return { observations: runs.length === 1 ? shots('初稿读数', 1) : shots('复测读数', 12), errors: [] };
  };
  const programModel = async request => {
    calls.push(request);
    const record = data(request);
    assert.equal(request.purpose, 'creative-website-review');
    assert.equal(record.brief, brief);
    assert.equal(record.html, calls.length === 1 ? initial.html : revised.html);
    assert.equal(record.readings[1].samples[0].contrast, calls.length === 1 ? 1 : 12);
    assert.deepEqual(record.errors, []);
    assert.equal(request.imagePaths.length, 2);
    paths.push(...request.imagePaths);
    for (const [i, path] of request.imagePaths.entries()) {
      assert.equal((await readFile(path)).toString(), record.readings[i].text + i);
    }
    if (calls.length === 1) return { action: 'revise', finding: '点击后正文对比为 1。', ...revised };
    assert.equal(record.previousFinding, '点击后正文对比为 1。');
    return { action: 'accept', finding: '点击后正文对比已到 12。' };
  };
  const result = await authorWebsiteProgram(title, initial, { brief, programModel }, run);
  assert.equal(runs.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(result.programCheck.runs, 2);
  assert.equal(result.files.find(f => f.name === 'index.html').bytes.toString(), buildCreativeProgramDocument(revised.html));
  assert.deepEqual(result.downloads, ['index.html']);
  assert.equal(result.preview, 'preview.html');
  const preview = result.files.find(f => f.name === result.preview).bytes.toString();
  assert.match(preview, /茶室 &lt;一&gt;/);
  assert.match(preview, /点击 theme 后/);
  assert.doesNotMatch(preview, /<script|<iframe/);
  assert.ok(preview.includes(shots('复测读数', 12)[1].screenshot.toString('base64')));
  for (const path of paths) await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('runtime errors reach the author, and a model cannot approve a failed or missing click', async () => {
  for (const run of [{ errors: ['按钮未找到'], observations: shots('初始', 1).slice(0, 1) },
    { errors: [], observations: shots('初始', 1).slice(0, 1) }]) {
    const programModel = async request => {
      assert.deepEqual(data(request).errors, run.errors);
      assert.equal(request.imagePaths.length, 1);
      return { action: 'accept', finding: '模型声称已通过。' };
    };
    await assert.rejects(authorWebsiteProgram(title, initial, { brief, programModel }, async () => run), /未全部通过/);
  }
});

test('replacement during review discards the result and removes the private observation images', async () => {
  const controller = new AbortController();
  let imagePath;
  const programModel = async request => {
    imagePath = request.imagePaths[0];
    controller.abort();
    return { action: 'accept', finding: '看完了。' };
  };
  await assert.rejects(authorWebsiteProgram(title, initial, { brief, programModel, signal: controller.signal },
    async () => ({ errors: [], observations: shots('画面', 1) })), { name: 'AbortError' });
  await assert.rejects(stat(imagePath), { code: 'ENOENT' });
});

test('the program requires the separate capability while ordinary site specs still render', async () => {
  assert.doesNotMatch(creativeSpecGuidance('website'), /"mode":"program"/);
  assert.match(creativeSpecGuidance('website', { programWebsite: true }), /"mode":"program"/);
  const pwa = { enabled: true, writable: true, currentConversation: true, creativeKinds: ['website'], programWebsite: true };
  const facts = input => renderRuntimeCapabilities(buildRuntimeCapabilities({ pwa: input }));
  assert.match(facts(pwa), /查看实际截图或报错/);
  for (const change of [{ programWebsite: false }, { writable: false }, { creativeKinds: ['design'] }, { currentConversation: false }])
    assert.doesNotMatch(facts({ ...pwa, ...change }), /查看实际截图或报错/);
  await assert.rejects(renderCreativeWork({ kind: 'website', title, spec: initial }), /未启用/);
  const staticSite = await renderCreativeWork({ kind: 'website', title,
    spec: { intro: '茶', accent: '#224466', sections: [{ heading: '茶室', body: '清茶' }] } });
  assert.equal(staticSite.preview, 'index.html');
});
