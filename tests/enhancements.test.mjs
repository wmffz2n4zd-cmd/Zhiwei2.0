import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createUnifiedMemory, memoryScope } from '../src/unified-memory/index.js';
import { HubCommands } from '../src/hub-commands.js';
import { PrivateTasks } from '../src/portable.js';
import { searchRecentCodexContext } from '../src/unified-memory/recent-context.js';
import { resolveQqReplyMedia, prepareQqModelImages, extractOneBotImageInputs } from '../src/qq-enhancer/index.js';
async function fixture(t) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'enhancements-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
test('memory persists, isolates private conversations, retains old records and serializes independent writers', async t => {
  const dir = await fixture(t), path = join(dir, 'memory.json'); let now = Date.now();
  const memory = createUnifiedMemory({ memoryPath: path, now: () => now });
  const other = createUnifiedMemory({ memoryPath: path, now: () => now });
  await Promise.all([memory.write({ scope: 'qq:private:1', summary: '私密'.repeat(500) }), other.write({ scope: 'qq:private:2', summary: '其他对象记录' })]);
  assert.equal((await memory.status({ scope: 'qq:private:1' })).count, 1);
  assert.equal((await memory.read({ scope: 'qq:private:2' })).entries.length, 1);
  assert.doesNotMatch(await memory.formatForPrompt({ scope: 'qq:private:2', query: '私密' }), /私密/);
  now += 3 * 86400000;
  assert.equal((await memory.read({ scope: 'qq:private:1' })).entries[0].summary.length, 1000);
  now += 5 * 86400000;
  assert.equal((await memory.read({ scope: 'qq:private:1' })).entries[0].summary.length, 1000);
  now += 23 * 86400000;
  assert.equal((await memory.read({ scope: 'qq:private:1' })).entries.length, 1);
  await memory.clear({ scope: 'qq:private:1' });
  assert.equal((await other.status({ scope: 'qq:private:2' })).count, 1);
});
test('backend commands authorize owner private chat, keep admin controls alive, and scope clear confirmation', async t => {
  const dir = await fixture(t), memory = createUnifiedMemory({ memoryPath: join(dir, 'm.json') });
  const state = { ai: { model: 'default', reasoningEffort: 'low' }, channels: { qq: true } };
  const commands = new HubCommands({ config: {}, state, memory, persist: async () => {}, saveSettings: async () => {} });
  const owner = text => ({ text, senderId: '1', isOwner: true, type: 'private_message' });
  assert.match(await commands.handle({ ...owner('/关闭QQ'), isOwner: false }), /仅允许/);
  assert.equal(state.channels.qq, true);
  for (const invalid of [{ senderId: undefined }, { senderId: '' }, { senderId: {} }, { groupId: '99' },
    { groupId: '' }, { raw: { group_id: '99' } }, { senderId: 'null' }, { senderId: 'undefined' },
    { senderId: 'NaN' }, { senderId: '1:2' }, { senderId: ' 1' }, { senderId: 0 }, { senderId: NaN }]) {
    const event = { ...owner('/关闭QQ'), ...invalid };
    assert.throws(() => memoryScope(event), /private sender/);
    assert.match(await commands.handle(event), /有效/);
    assert.equal(state.channels.qq, true, 'invalid private identity cannot change settings');
    assert.equal(commands.testDecision({ ...event, text: '你好' }), null);
  }
  await commands.handle(owner('/关闭QQ')); assert.equal(state.channels.qq, false);
  await commands.handle(owner('/开启QQ')); assert.equal(state.channels.qq, true);
  await commands.handle(owner('/记住 我喜欢甜巧克力'));
  assert.match(await commands.handle(owner('/记忆')), /甜巧克力/);
  await commands.handle(owner('/清除统一记忆'));
  assert.match(await commands.handle({ ...owner('/确认清除记忆'), senderId: '2' }), /没有有效/);
  assert.match(await commands.handle(owner('/记忆')), /甜巧克力/);
  await commands.handle(owner('/确认清除记忆'));
  assert.match(await commands.handle(owner('/记忆')), /为空/);
});
test('media permits validated cache images and catalog stickers, rejects arbitrary file output and fake images', async t => {
  const dir = await fixture(t), cache = join(dir, 'cache'); await mkdir(cache);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXfoAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(cache, '笑.png'), png); await writeFile(join(cache, 'fake.png'), 'secret');
  assert.equal((await resolveQqReplyMedia('[[qq_sticker:笑.png]]', { stickerDir: cache })).length, 1);
  assert.deepEqual(await resolveQqReplyMedia(`[[qq_image:${join(cache, '笑.png')}]] [[qq_sticker:../secret.png]] [[qq_sticker:fake.png]]`, { stickerDir: cache }), []);
  const inputs = extractOneBotImageInputs({ message: [{ type: 'image', data: { file: 'id' } }] });
  const options = { outputDir: join(dir, 'out'), fetchOneBotImage: async () => ({ file: join(cache, '笑.png') }), cacheRoots: [cache] };
  assert.equal((await prepareQqModelImages(inputs, options)).length, 1);
  assert.equal((await prepareQqModelImages(inputs, { ...options, cacheRoots: [] })).length, 0);
});
test('full access requires local opt-in and confirmed task; normal task remains workspace-write', async () => {
  const events = [], owner = text => ({ text, senderId: '1', isOwner: true, type: 'private_message' });
  const tasks = new PrivateTasks({ skills: {}, enabled: true, run: async (_text, _skill, _history, event) => { events.push(event); return 'done'; } });
  assert.match(await tasks.handle(owner('/执行完全访问 测试')), /未在本机启用/);
  tasks.allowFullAccess = true;
  await tasks.handle(owner('/执行完全访问 测试')); assert.equal(events.length, 0);
  await tasks.handle(owner('/确认')); assert.equal(events[0].fullAccess, true);
  await tasks.handle(owner('/执行 普通')); await tasks.handle(owner('/确认')); assert.equal(events[1].fullAccess, false);
});
test('desktop recall reads selected workspace messages, excludes tools and hidden phases', async t => {
  const dir = await fixture(t), root = join(dir, 'project'), now = Date.now();
  const rows = cwd => [
    { type: 'session_meta', payload: { cwd } },
    { timestamp: new Date(now).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'analysis', content: [{ type: 'output_text', text: 'hidden' }] } },
    { timestamp: new Date(now).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '已完成图片支持' }] } }
  ].map(JSON.stringify).join('\n');
  await writeFile(join(dir, 'one.jsonl'), rows(root));
  await writeFile(join(dir, 'two.jsonl'), rows(join(dir, 'another')));
  const snippets = await searchRecentCodexContext({ sessionsDir: dir, workspaceRoots: [root], now });
  assert.equal(snippets.length, 1); assert.equal(snippets[0].text, '已完成图片支持');
  assert.deepEqual(await searchRecentCodexContext({ sessionsDir: dir, now }), []);
});
