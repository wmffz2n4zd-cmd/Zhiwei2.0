import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, cp, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await fn();
    if (result) return result;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test('signed private OneBot mood stays scoped, hidden and uncommitted until delivery; groups stay ignored', { timeout: 30000 }, async t => {
  const testsDir = join(root, 'runtime', 'tests');
  await mkdir(testsDir, { recursive: true });
  const fixture = await mkdtemp(join(testsDir, 'mood-integration-'));
  const callsPath = join(fixture, 'calls.jsonl');
  const scenarioPath = join(fixture, 'response.json');
  const memoryPath = join(fixture, 'data', 'unified-memory.json');
  const attempts = [], held = new Map();
  let child, holdNext = false, failNext = false, logs = '';
  const bridge = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer mood-api-secret');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const respond = data => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/get_msg') {
      respond({ status: 'ok', data: { message_id: body.message_id, user_id: 999999,
        message_type: 'private', target_id: Number(body.message_id),
        message: [{ type: 'text', data: { text: '在呢。' } }] } });
      return;
    }
    if (['/send_private_msg', '/send_group_msg'].includes(req.url)) {
      const attempt = { route: req.url, ...body };
      attempts.push(attempt);
      const result = failNext ? { status: 'failed', retcode: 100 } : { status: 'ok', data: { message_id: 10000 + attempts.length } };
      failNext = false;
      if (holdNext) {
        holdNext = false;
        held.set(attempts.length, () => respond(result));
      } else respond(result);
      return;
    }
    respond({ status: 'ok', data: { user_id: 999999, nickname: 'isolated mood fixture' } });
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  t.after(async () => {
    for (const release of held.values()) release();
    if (child && child.exitCode == null) {
      const closed = once(child, 'close'); child.kill(); await closed;
    }
    bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve));
    // Remove only this test's temporary workspace, never the real hub's data.
    if (resolve(fixture).startsWith(resolve(testsDir) + sep)) await rm(fixture, { recursive: true, force: true });
  });

  await cp(join(root, 'src'), join(fixture, 'src'), { recursive: true });
  await cp(join(root, 'modules', 'web-console'), join(fixture, 'modules', 'web-console'), { recursive: true });
  await writeFile(join(fixture, 'package.json'), '{"type":"module"}');
  await mkdir(join(fixture, 'data'), { recursive: true });
  await writeFile(join(fixture, 'data', 'windows.local.json'), JSON.stringify({
    runtimeBudget: { enabled: false }, // Explicit legacy-behavior fixture; budget has separate integration cases.
    ownerUserIds: ['123456'], allowOtherPrivateChats: true,
    qqEnabled: true, remoteEnabled: false, webLookup: false, assistantName: '知微',
    mood: { enabled: true },
    oneBotSecret: 'mood-callback-secret', oneBotAccessToken: 'mood-api-secret',
    oneBotApiBase: `http://127.0.0.1:${bridge.address().port}`
  }));
  const fakeCli = join(fixture, 'fake-codex.mjs');
  await writeFile(fakeCli, `import {readFile,writeFile,appendFile} from 'node:fs/promises';
const args=process.argv.slice(2); let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;
const scenario=JSON.parse(await readFile(${JSON.stringify(scenarioPath)}, 'utf8'));
await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({name:scenario.name,prompt,args})+'\\n');
await writeFile(args[args.indexOf('-o')+1], scenario.reply);
if (scenario.failCli) { console.error('isolated CLI failure'); process.exit(1); }
`);
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: fixture, windowsHide: true,
    env: { ...process.env, PORT: String(port), CODEX_CLI_PATH: fakeCli, CODEX_REMOTE_CONTACT_QQ_WEB_LOOKUP: '0' }
  });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  const url = `http://127.0.0.1:${port}`;
  try { await until(() => fetch(url + '/api/platform').then(r => r.ok).catch(() => false), 'isolated hub startup'); }
  catch (error) { throw new Error(`${error.message}\n${logs}`); }
  const groupConfig = await fetch(url + '/api/qq/groups', {
    method: 'POST', body: JSON.stringify({ allowedGroups: ['123456789', '987654321'] })
  });
  assert.equal(groupConfig.status, 404, 'old group configuration must not re-enable group chat');

  const calls = async () => (await readFile(callsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const moodEntries = async () => JSON.parse(await readFile(memoryPath, 'utf8').catch(() => '{"entries":[]}'))
    .entries.filter(entry => entry.source === 'qq-mood');
  const readMood = async (scope, sender = '123456') => (await moodEntries()).find(entry => entry.scope === scope && entry.topic === `mood:${sender}`);
  const snapshot = async () => fetch(url + '/api/state').then(r => r.json());
  const finished = id => until(async () => (await snapshot()).qq.events.find(record => record.event.raw?.message_id === id && record.completedAt), `message ${id} completion`);
  let messageId = 0;
  async function send(text, { groupId, sender = 123456 } = {}) {
    const payload = { post_type: 'message', message_type: groupId ? 'group' : 'private', self_id: 999999,
      user_id: sender, message_id: ++messageId, raw_message: text,
      ...(groupId ? { group_id: groupId } : {}),
      // A real bot-authored quotation bypasses batching without bypassing mood.
      message: [{ type: 'reply', data: { id: String(sender) } },
        ...(groupId ? [{ type: 'at', data: { qq: '999999' } }] : []),
        { type: 'text', data: { text } }] };
    const raw = JSON.stringify(payload);
    const signature = 'sha1=' + createHmac('sha1', 'mood-callback-secret').update(raw).digest('hex');
    const response = await fetch(url + '/api/onebot/event', { method: 'POST', headers: { 'x-signature': signature }, body: raw });
    assert.equal(response.status, 200);
    if (groupId) {
      const result = await response.json();
      assert.equal(result.ignored, true, 'signed group callbacks must be ignored before generation');
      assert.equal(result.reason, 'Private-only mode');
    }
    return payload.message_id;
  }
  const marker = (phase, cause, intensity) => `[[qq_mood:${JSON.stringify({ phase, cause, intensity })}]]`;
  function currentMood(prompt) {
    const match = prompt.match(/当前状态：([^\r\n]+)/);
    assert.ok(match, 'every ordinary private generation gets mood context');
    return match[1] === '平常心情' ? null : JSON.parse(match[1]);
  }
  async function generate(name, text, reply, options = {}) {
    const count = (await calls()).length, sentCount = attempts.length;
    await writeFile(scenarioPath, JSON.stringify({ name, reply, failCli: options.failCli }));
    holdNext = Boolean(options.hold); failNext = Boolean(options.failSend);
    const id = await send(text, options);
    if (options.hold) {
      await until(() => held.has(sentCount + 1), `${name} delivery attempt`);
      const pending = (await snapshot()).qq.events.find(record => record.event.raw?.message_id === id);
      assert.equal(pending.decision.status, '发送中');
      assert.equal(pending.completedAt, undefined);
      assert.equal((await calls()).length, count + 1, 'preparing emotion must use the existing model call');
      await options.beforeDelivery();
      held.get(sentCount + 1)(); held.delete(sentCount + 1);
    }
    const record = await finished(id);
    const allCalls = await calls();
    assert.equal(allCalls.length, count + 1, `${name} must invoke the fake model exactly once`);
    assert.equal(record.timings.modelCalls, 1);
    assert.equal(allCalls.at(-1).name, name);
    for (const attempt of attempts.slice(sentCount)) assert.doesNotMatch(JSON.stringify(attempt), /qq_mood|"phase"|"intensity"/i);
    assert.doesNotMatch(record.reply, /qq_mood/i);
    assert.equal(record.decision.status, options.failCli || options.failSend ? '回复失败' : '已回复');
    return { record, mood: currentMood(allCalls.at(-1).prompt) };
  }

  for (const command of ['/状态', '/记忆']) {
    const record = await finished(await send(command));
    assert.equal(record.timings.modelCalls, 0);
  }
  assert.equal((await calls()).length, 0, 'backend commands must not invoke a model');
  assert.deepEqual(await moodEntries(), [], 'backend commands must not create emotion');

  const privateScope = 'qq:private:123456', otherPrivateScope = 'qq:private:654321';
  const privateStart = await generate('private-start', '今天你的小谜题解开了吗',
    '还差一点，卡在最后一步。\n' + marker('guarded', '解谜卡住', 1), {
      hold: true, beforeDelivery: async () => assert.deepEqual(await moodEntries(), [])
    });
  assert.equal(privateStart.mood, null);
  assert.equal(JSON.parse((await readMood(privateScope)).summary).phase, 'guarded');
  const privateExplain = await generate('private-explain', '怎么了，卡在哪里了',
    '就是最后一格还没解开。\n' + marker('explained', '解谜卡住', 1));
  assert.deepEqual(privateExplain.mood, { phase: 'guarded', cause: '解谜卡住', intensity: 1 });
  const privateSaved = await readMood(privateScope);
  assert.equal(JSON.parse(privateSaved.summary).phase, 'explained');

  const otherPrivateStart = await generate('other-private-start', '你的杯子找到了吗',
    '还没，明明刚才就在桌上的。\n' + marker('guarded', '喜欢的杯子找不到', 1), {
      sender: 654321, hold: true,
      beforeDelivery: async () => { assert.equal(await readMood(otherPrivateScope, '654321'), undefined); assert.deepEqual(await readMood(privateScope), privateSaved); }
    });
  assert.equal(otherPrivateStart.record.event.type, 'private_message');
  assert.equal(otherPrivateStart.mood, null, 'the owner\'s emotion must not enter another private conversation');
  assert.equal(JSON.parse((await readMood(otherPrivateScope, '654321')).summary).cause, '喜欢的杯子找不到');
  assert.ok(attempts.some(attempt => attempt.route === '/send_private_msg'));

  assert.equal((await generate('third-private-sender', '今天怎么样', '挺好的。', { sender: 777777 })).mood, null,
    'a third private sender must not inherit either existing emotion');
  assert.equal((await moodEntries()).length, 2);
  const otherPrivateExplain = await generate('other-private-explain', '怎么了，刚才怎么有点别扭',
    '喜欢的杯子突然找不到了。\n' + marker('explained', '喜欢的杯子找不到', 1), { sender: 654321 });
  assert.deepEqual(otherPrivateExplain.mood, { phase: 'guarded', cause: '喜欢的杯子找不到', intensity: 1 });
  const otherPrivateSaved = await readMood(otherPrivateScope, '654321');
  assert.equal(JSON.parse(otherPrivateSaved.summary).phase, 'explained');

  const beforeGroups = { calls: (await calls()).length, attempts: attempts.length,
    memory: await readFile(memoryPath, 'utf8'), moods: await moodEntries() };
  for (const options of [{ groupId: 123456789 }, { groupId: 987654321, sender: 654321 }]) {
    const id = await send('@知微 怎么了，跟我说说', options);
    assert.equal((await snapshot()).qq.events.some(record => record.event.raw?.message_id === id), false,
      'ignored groups must not enter the reply event queue');
  }
  assert.equal((await calls()).length, beforeGroups.calls, 'group callbacks must not call the model');
  assert.equal(attempts.length, beforeGroups.attempts, 'group callbacks must not send a reply');
  assert.equal(await readFile(memoryPath, 'utf8'), beforeGroups.memory, 'group callbacks must not write memory');
  assert.deepEqual(await moodEntries(), beforeGroups.moods, 'group callbacks must not change private moods');

  // Failed CLI output includes a plausible transition, but cannot be committed.
  await generate('private-cli-failure', '这次再看看最后一格',
    '已经解开了。\n' + marker('neutral', '解谜卡住', 0), { failCli: true });
  assert.deepEqual(await readMood(privateScope), privateSaved);
  await generate('other-private-send-failure', '杯子原来在架子上',
    '找到啦，谢谢。\n' + marker('neutral', '喜欢的杯子找不到', 0), { sender: 654321, failSend: true });
  assert.deepEqual(await readMood(otherPrivateScope, '654321'), otherPrivateSaved);
  await generate('private-send-failure', '最后一格我来帮你吧',
    '好，那一起看看。\n' + marker('easing', '解谜卡住', 1), { failSend: true });
  assert.deepEqual(await readMood(privateScope), privateSaved);

  const countBeforeCommands = (await calls()).length;
  for (const command of ['/状态', '/记忆']) await finished(await send(command));
  assert.equal((await calls()).length, countBeforeCommands);
  assert.deepEqual(await readMood(privateScope), privateSaved);
  assert.deepEqual(await readMood(otherPrivateScope, '654321'), otherPrivateSaved);

  const easing = await generate('private-easing', '最后这一步一起看吧，不着急',
    '好吧，一起看看。\n' + marker('easing', '解谜卡住', 1));
  assert.deepEqual(easing.mood, { phase: 'explained', cause: '解谜卡住', intensity: 1 });
  assert.equal(JSON.parse((await readMood(privateScope)).summary).phase, 'easing');
  const recovered = await generate('private-recovered', '现在解开了，可以放心啦',
    '终于，好像也没那么难嘛。\n' + marker('neutral', '解谜卡住', 0));
  assert.deepEqual(recovered.mood, { phase: 'easing', cause: '解谜卡住', intensity: 1 });
  assert.equal(JSON.parse((await readMood(privateScope)).summary).phase, 'neutral');
  assert.deepEqual(await readMood(otherPrivateScope, '654321'), otherPrivateSaved,
    'one person\'s recovery must not reset another person\'s mood');
  assert.ok(attempts.every(attempt => attempt.route === '/send_private_msg'));
  assert.doesNotMatch(JSON.stringify(attempts), /qq_mood/i);
});
