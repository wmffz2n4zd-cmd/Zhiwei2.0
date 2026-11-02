import test from 'node:test';
import assert from 'node:assert/strict';
import { HubCommands, isHubCommand, commandHelp } from '../src/hub-commands.js';

test('reading, exploration, notes and status pass the validated current private scope', async () => {
  const calls = [];
  const h = new HubCommands({ config: {}, world: {
    run: async (...args) => { calls.push(['run', ...args]); return { message: 'done' }; },
    readBoards: async (...args) => { calls.push(['boards', ...args]); return []; },
    status: async (...args) => { calls.push(['status', ...args]); return { browser: {}, usage: {}, limits: {} }; }
  } });
  const e = text => ({ text, senderId: '123456', isOwner: true, type: 'private_message' });
  await h.handle(e('/浏览 https://example.org/private'));
  await h.handle(e('/探索'));
  await h.handle(e('/留言板 x'));
  await h.handle(e('/浏览状态'));
  assert.deepEqual(calls, [
    ['run', 'https://example.org/private', { scope: 'qq:private:123456' }],
    ['run', '', { scope: 'qq:private:123456' }],
    ['boards', 'x', { scope: 'qq:private:123456' }],
    ['status', { scope: 'qq:private:123456' }]
  ]);
  await h.handle({ ...e('/探索'), groupId: 12 });
  await h.handle({ ...e('/探索'), senderId: 'invalid' });
  assert.equal(calls.length, 4);
});

test('ordinary private test isolates users and groups and accepts any topic without scoring', async () => {
  const h = new HubCommands({ config: {}, state: { channels: { qq: false } } });
  const e = text => ({ text, senderId: '1', isOwner: true, type: 'private_message' });
  await h.handle(e('/开始聊天测试'));
  for (const text of ['你好', '公交车晚点了', '威士忌']) {
    const event = e(text), decision = h.testDecision(event);
    assert.equal(decision.ok, true);
    assert.equal(decision.reply, undefined);
    assert.equal(event.interestDecision, undefined);
  }
  assert.equal(h.testDecision({ ...e('你好'), senderId: '2' }), null);
  assert.equal(h.testDecision({ ...e('你好'), isOwner: false }), null);
  assert.equal(h.testDecision({ ...e('你好'), type: 'group_message' }), null);
  assert.equal(h.testDecision(e('/状态')), null);
  assert.equal(h.state.channels.qq, false);
  await h.handle(e('/结束聊天测试'));
  assert.equal(h.testDecision(e('你好')), null);
});

test('private reading status describes observation instead of printing null daily limits', async () => {
  const status = { browser: {}, usage: { activities: 8, modelCalls: 40 },
    limits: { dailyEnforced: false, activities: null, modelCalls: null } };
  const h = new HubCommands({ config: {}, world: { status: async () => status } });
  const event = { text: '/浏览状态', senderId: '123456', isOwner: true, type: 'private_message' };
  const reply = await h.handle(event);
  assert.match(reply, /今日探索 8 次，模型调用 40 次/); assert.match(reply, /无每日额度上限/);
  assert.doesNotMatch(reply, /null|undefined|\/6|\/36/);
  status.limits = { dailyEnforced: true, activities: 6, modelCalls: 36 };
  assert.match(await h.handle(event), /8\/6 次，模型调用 40\/36 次/);
});

test('retired interest commands answer locally without enabling tests or mutating configuration', async () => {
  let writes = 0;
  const config = { interests: { threshold: 10, topics: { 旧话题: ['旧词'] } } };
  const original = structuredClone(config);
  const h = new HubCommands({ config, persist: async () => { writes++; } });
  const e = text => ({ text, senderId: '1', isOwner: true, type: 'private_message' });
  for (const text of ['/兴趣', '/兴趣测试 音乐', '/兴趣添加 新话题 新词', '/兴趣删除 旧话题', '/开始聊天测试 兴趣']) {
    assert.equal(isHubCommand(text), true, text);
    assert.match(await h.handle(e(text)), /已停用/, text);
    assert.equal(h.testDecision(e('公交车晚点了')), null);
  }
  assert.deepEqual(config, original);
  assert.equal(writes, 0);
  assert.match(await h.handle({ ...e('/兴趣'), isOwner: false }), /仅允许/);
  assert.match(await h.handle({ ...e('/兴趣'), type: 'group_message' }), /仅允许/);
  assert.doesNotMatch(commandHelp, /\/兴趣|\[兴趣\]/);
});

test('ordinary private speech never invokes command handling and status keeps private model settings', async () => {
  const h = new HubCommands({
    config: { qqPrivateOnly: true, privateChatModel: 'private-model', privateChatReasoningEffort: 'high' },
    state: { channels: { qq: true }, ai: { model: 'default-model', reasoningEffort: 'low' } }
  });
  const e = text => ({ text, senderId: '1', isOwner: true, type: 'private_message' });
  for (const text of ['兴趣测试 音乐', '开始聊天测试', '状态', '我对音乐很有兴趣']) {
    assert.equal(isHubCommand(text), false);
    assert.equal(await h.handle(e(text)), null);
  }
  const status = await h.handle(e('/状态'));
  assert.match(status, /仅私聊/);
  assert.match(status, /私聊模型：private-model \/ high/);
  assert.doesNotMatch(status, /兴趣筛选|兴趣门槛/);
});

test('shutdown requires private owner confirmation, expires, cancels and executes only the injected action', async () => {
  let now = 0, callback, calls = 0, canceled = false;
  const h = new HubCommands({ config: {}, now: () => now, shutdown: async () => { calls++; }, schedule: fn => { callback = fn; return 1; }, unschedule: () => { canceled = true; } });
  const e = text => ({ text, senderId: '1', isOwner: true, type: 'private_message' });
  assert.match(await h.handle({ ...e('/关机'), type: 'group_message' }), /仅允许/);
  assert.match(await h.handle(e('/确认关机')), /没有有效/);
  await h.handle(e('/关机')); now += 180001;
  assert.match(await h.handle(e('/确认关机')), /没有有效/);
  await h.handle(e('/关机'));
  assert.match(await h.handle({ ...e('/确认关机'), senderId: '2' }), /没有有效/);
  await h.handle(e('/确认关机'));
  assert.equal(calls, 0);
  await h.handle(e('/取消关机')); assert.equal(canceled, true);
  await h.handle(e('/关机')); await h.handle(e('/确认关机'));
  callback(); assert.equal(calls, 1);
  assert.match(await h.handle(e('/确认关机')), /没有有效/);
});
