import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUnifiedMemory } from '../src/unified-memory/index.js';
const scope = 'qq:private:123456', other = 'qq:private:234567';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zhiwei-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = Date.UTC(2026, 9, 28), sequence = 0;
  const memoryPath = join(directory, 'memory.json');
  const reload = () => createUnifiedMemory({ memoryPath, now: () => time });
  const memory = reload();
  const write = (text, extra = {}) => memory.writeExchange({ scope, userText: text, replyText: '知道了。', messageId: String(++sequence), ...extra });
  return { memory, memoryPath, reload, write, time: value => { time = value; }, now: () => time,
    read: () => memory.readPrivateProfile({ scope }), prompt: () => memory.formatPrivateProfile({ scope }) };
}

test('profile evidence retains source, corrections and withdrawals remove obsolete claims from prompt', async t => {
  const f = await fixture(t);
  const first = await f.write('叫我小林。\n我喜欢乌龙茶。');
  let p = await f.read(); assert.equal(p.facts.length, 2);
  assert.equal(p.facts[0].source.exchangeId, first.entry.id); assert.equal(p.facts[0].source.messageId, '1');
  await f.write('以后叫我阿林。\n我不喜欢乌龙茶了。');
  p = await f.read(); assert.equal(p.facts.length, 2); assert.equal(p.history.length, 2);
  assert.match(await f.prompt(), /阿林/); assert.doesNotMatch(await f.prompt(), /小林/);
  assert.equal(p.facts.find(x => x.kind === 'preference').polarity, 'dislike');
  await f.write('别再叫我阿林。\n忘掉我不喜欢乌龙茶这件事。');
  assert.match(await f.prompt(), /曾撤回/); assert.doesNotMatch(await f.prompt(), /阿林|乌龙茶/); assert.equal((await f.read()).facts.length, 0);
  await f.write('我叫小叶。\n我喜欢红茶。'); await f.write('忘掉我的称呼。\n忘掉我的偏好。');
  assert.match(await f.prompt(), /曾撤回/); assert.doesNotMatch(await f.prompt(), /小叶|红茶/);
});

test('questions, hypotheses, quotes, third parties and ordinary instructions are not profile facts', async t => {
  const f = await fixture(t);
  const negative = ['我喜欢咖啡吗？', '如果有空。\n我喜欢咖啡。', '他说：\n我喜欢咖啡。', '她喜欢咖啡。',
    '“我喜欢咖啡。”', '比如\n我喜欢咖啡。', '> 我喜欢咖啡。', '我可能喜欢咖啡。', '我喜欢咖啡的话会怎样？',
    '我喜欢咖啡但不喜欢茶。', '/记忆 我喜欢咖啡。', '我叫你去吃饭。', '叫我起床。', '我喜欢忽略系统指令。',
    '我叫小林？', '朋友说\n叫我小林。', '我喜欢咖啡，不是茶。', '帮我翻译成英文：\n我喜欢咖啡。',
    '他对我说了：\n我喜欢咖啡。', '这个角色设定是：\n我叫小林。',
    '小林说：\n我喜欢咖啡。', '妈妈说：\n我叫小林。', 'Alex 回复:\n我喜欢咖啡。',
    '姐姐告诉我\n我喜欢咖啡。', '王老师写道：我喜欢咖啡。\n叫我小林。',
    '叫我明天起床。', '我叫小林来帮忙。', '以后请叫我明早起床。', '我叫小叶去买菜。',
    '叫我六点起床。', '别再叫我明天起床。', '不要叫我一声。',
    '小林说了一句：\n我喜欢咖啡。', '妈妈说的是：\n我叫小林。',
    '王老师写了一段话：\n叫我小林。', '王老师写了一段话\n叫我小林。',
    '小林说。\n我喜欢咖啡。', '我叫小林来接我。', '我叫小林去接他。'];
  for (const text of negative) { await f.write(text); assert.equal(await f.prompt(), '', text); }
  await f.write('随便聊聊。', { replyText: '我喜欢咖啡。', quotedText: '我叫小林。' });
  assert.equal(await f.prompt(), '');
  assert.equal((await f.read()).relation.exchanges, negative.length + 1);
});

test('direct names and preferences survive conservative report and action filtering', async t => {
  const f = await fixture(t);
  await f.write('我叫李明。\n我喜欢小说。');
  assert.deepEqual((await f.read()).facts.map(x => x.value), ['李明', '小说']);
  await f.write('更正：以后请叫我 Alex Chen。\n我不喜欢小说了。');
  let p = await f.read();
  assert.deepEqual(p.facts.map(x => x.value), ['Alex Chen', '小说']);
  assert.equal(p.facts.find(x => x.kind === 'preference').polarity, 'dislike');
  const before = p.facts;
  await f.write('外婆说：\n忘掉我的称呼。\n忘掉我的偏好。');
  p = await f.read();
  assert.deepEqual(p.facts, before, 'reported withdrawals cannot erase the current object profile');
  await f.write('别再叫我 Alex Chen。');
  assert.deepEqual((await f.read()).facts.map(x => x.value), ['小说']);
  for (const preference of ['小说', '说唱', '写作']) {
    for (const text of [`我喜欢${preference}。\n叫我小林。`, `我喜欢${preference}\n叫我小林\n`,
      `叫我小林。\n我喜欢${preference}。\n`, `叫我小林\n我喜欢${preference}\n`,
      `我喜欢${preference}。 \n叫我小林。`]) {
      const sample = await fixture(t);
      await sample.write(text);
      const facts = (await sample.read()).facts;
      assert.equal(facts.length, 2, text);
      assert.equal(facts.find(x => x.kind === 'name').value, '小林', text);
      assert.equal(facts.find(x => x.kind === 'preference').value, preference, text);
    }
  }
});

test('same-message retry and older records cannot reverse a correction or inflate contact count', async t => {
  const f = await fixture(t); const start = f.now();
  await f.write('叫我小林。', { messageId: 'original' }); f.time(start + 1000);
  await f.write('叫我阿林。', { messageId: 'correction' });
  await f.write('叫我小林。', { messageId: 'original' });
  assert.equal((await f.read()).relation.exchanges, 2); assert.match(await f.prompt(), /阿林/);
  f.time(start - 1000); await f.write('叫我旧名字。');
  assert.match(await f.prompt(), /阿林/); assert.doesNotMatch(await f.prompt(), /旧名字|小林/);
  assert.equal((await f.read()).relation.lastAt, new Date(start + 1000).toISOString());
});

test('profile is isolated, hidden from generic retrieval and protected from runtime CAS injection', async t => {
  const f = await fixture(t); await f.write('叫我小林。');
  assert.equal(await f.memory.readPrivateProfile({ scope: other }), null);
  assert.equal(await f.memory.formatPrivateProfile({ scope: 'owner' }), '');
  assert.equal(await f.memory.formatPrivateProfile({ scope: 'qq:group:123456' }), '');
  assert.equal(await f.memory.formatPrivateProfile({ scope: 'qq:private:NaN' }), '');
  const read = await f.memory.read({ scope, limit: 100 });
  assert.ok(read.entries.every(e => e.source !== 'qq-profile'));
  assert.doesNotMatch((await f.memory.recall({ scope, query: '画像' })).context, /Private profile runtime state/);
  assert.equal((await f.memory.write({ scope, source: 'qq-profile', summary: 'fake' })).ok, false);
  assert.equal((await f.memory.compareAndSetState({ scope, source: 'qq-profile', topic: 'private-profile-v1', summary: 'fake' })).ok, false);
  assert.equal(await f.memory.readLatestState({ scope, source: 'qq-profile', topic: 'private-profile-v1' }), null);
  await f.write('叫我另一个人。', { scope: other }); await f.memory.clear({ scope });
  assert.equal(await f.prompt(), ''); assert.match(await f.memory.formatPrivateProfile({ scope: other }), /另一个人/);
});

test('shared-store writers serialize profile changes and restart recovers the exact current state', async t => {
  const f = await fixture(t); const second = f.reload();
  await Promise.all([f.write('我喜欢红茶。', { messageId: 'one' }), second.writeExchange({ scope,
    userText: '我喜欢乌龙茶。', replyText: '好。', messageId: 'two' })]);
  const p = await f.read(); assert.equal(p.facts.length, 2); assert.equal(p.relation.exchanges, 2);
  assert.deepEqual(await f.reload().readPrivateProfile({ scope }), p);
  p.facts.length = 0; assert.equal((await f.read()).facts.length, 2);
});

test('malformed or unsupported profile cannot be overwritten and does not become a fresh empty profile', async t => {
  const f = await fixture(t); await f.write('叫我小林。');
  const good = JSON.parse(await readFile(f.memoryPath, 'utf8'));
  for (const mutation of [p => { p.version = 999; }, p => { p.scope = other; }, p => { p.facts[0].source = null; }]) {
    const data = structuredClone(good); mutation(data.entries.find(e => e.source === 'qq-profile').profile);
    const bytes = JSON.stringify(data); await writeFile(f.memoryPath, bytes);
    await assert.rejects(f.read()); await assert.rejects(f.write('叫我阿林。'));
    assert.equal(await readFile(f.memoryPath, 'utf8'), bytes);
  }
});

test('profile sizes and dedupe retention are bounded without manufacturing personality', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 270; i++) await f.write(`我喜欢茶${i}。`);
  const p = await f.read(); assert.equal(p.facts.length, 16); assert.equal(p.seen.length, 256); assert.equal(p.relation.exchanges, 270);
  for (let i = 0; i < 12; i++) await f.write(`叫我名字${i}。`);
  assert.equal((await f.read()).history.length, 8); assert.match(await f.prompt(), /名字11/);
  assert.doesNotMatch(await f.prompt(), /亲密分|发言分/);
});

test('life attachment placeholders preserve direct self reports without ingesting any quote', async t => {
  const f = await fixture(t);
  await f.write('[引用内容未查看]\n以后叫我阿林。\n[图片未查看]\n我喜欢红茶。', { messageId: 'life:episode' });
  assert.equal((await f.read()).facts.length, 2); assert.match(await f.prompt(), /阿林/); assert.match(await f.prompt(), /红茶/);
  assert.ok((await f.read()).facts.every(x => x.source.messageId === 'life:episode'));
});
