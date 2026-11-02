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
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function until(predicate, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const result = await predicate(); if (result) return result; await sleep(25); }
  throw Error('Condition timed out');
}

test('private-only Hub ignores signed groups and invites without reads, replies, model calls or group memory', { timeout: 30000 }, async t => {
  const base = join(root, 'runtime', 'tests'); await mkdir(base, { recursive: true });
  const fixture = await mkdtemp(join(base, 'private-only-'));
  const bridgeCalls = [], privateReplies = [];
  let child, logs = '';
  const bridge = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    bridgeCalls.push({ path: req.url, body });
    if (req.url === '/send_private_msg') privateReplies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', data: { user_id: 999999, nickname: 'isolated test bridge' } }));
  });
  await new Promise(done => bridge.listen(0, '127.0.0.1', done));
  const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port; await new Promise(done => probe.close(done));
  t.after(async () => {
    if (child && child.exitCode == null) { const stopped = once(child, 'close'); child.kill(); await stopped; }
    bridge.closeAllConnections(); await new Promise(done => bridge.close(done));
    if (resolve(fixture).startsWith(resolve(base) + sep)) await rm(fixture, { recursive: true, force: true });
  });
  await cp(join(root, 'src'), join(fixture, 'src'), { recursive: true });
  await cp(join(root, 'modules', 'web-console'), join(fixture, 'modules', 'web-console'), { recursive: true });
  await writeFile(join(fixture, 'package.json'), '{"type":"module"}');
  await mkdir(join(fixture, 'data'));
  const retiredData = {
    'qq-memory.json': JSON.stringify({ groups: { '123456789': [{ text: 'LEGACY_MEMORY_KEEP' }] } }),
    'qq-personas.json': JSON.stringify({ groups: { '123456789': { people: { '123456': { label: 'LEGACY_PERSONA_KEEP' } } } } })
  };
  for (const [file, content] of Object.entries(retiredData)) await writeFile(join(fixture, 'data', file), content);
  await writeFile(join(fixture, 'data', 'settings.json'), JSON.stringify({ qq: { allowedGroups: ['123456789'] } }));
  await writeFile(join(fixture, 'data', 'windows.local.json'), JSON.stringify({
    runtimeBudget: { enabled: false }, // Explicit legacy-behavior fixture; budget has separate integration cases.
    ownerUserIds: ['123456'], qqEnabled: true, qqPrivateOnly: false, remoteEnabled: false, webLookup: false,
    assistantName: '知微', chatModes: { enabled: true, defaultMode: 'active', groups: ['123456789'] },
    oneBotSecret: 'test-callback-secret', oneBotAccessToken: 'test-api-secret',
    oneBotApiBase: `http://127.0.0.1:${bridge.address().port}`, world: { enabled: false }
  }));
  const callsPath = join(fixture, 'calls.jsonl'), fakeCli = join(fixture, 'fake-codex.mjs');
  await writeFile(fakeCli, `import { appendFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2); let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ args, prompt }) + '\\n');
await writeFile(args[args.indexOf('-o') + 1], '私聊模型回复完成');`);
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: fixture, windowsHide: true,
    env: { ...process.env, PORT: String(port), CODEX_CLI_PATH: fakeCli, CODEX_REMOTE_CONTACT_QQ_WEB_LOOKUP: '0' }
  });
  child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  const url = `http://127.0.0.1:${port}`;
  try { await until(() => fetch(url + '/api/platform').then(response => response.ok).catch(() => false)); }
  catch (error) { throw Error(error.message + '\nIsolated Hub output: ' + logs); }
  const modelCalls = async () => (await readFile(callsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  let id = 0;
  async function send(payload) {
    const raw = JSON.stringify({ self_id: 999999, user_id: 123456, message_id: ++id, ...payload });
    const signature = 'sha1=' + createHmac('sha1', 'test-callback-secret').update(raw).digest('hex');
    const response = await fetch(url + '/api/onebot/event', { method: 'POST', headers: { 'x-signature': signature }, body: raw });
    assert.equal(response.status, 200); return response.json();
  }
  const platform = await fetch(url + '/api/platform').then(response => response.json());
  assert.equal(platform.qqPrivateOnly, true);
  assert.equal(platform.worldEnabled, false);
  const groupPayload = text => ({ post_type: 'message', message_type: 'group', group_id: 123456789,
    raw_message: text, message: [{ type: 'reply', data: { id: 'group-history' } },
      { type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text } }] });
  for (const payload of [
    groupPayload('GROUP_PRIVATE_ONLY_SENTINEL @知微 请看引用'),
    { ...groupPayload('GROUP_PRIVATE_ONLY_SENTINEL 巧克力和猫咪真可爱'), message: [{ type: 'text', data: { text: '巧克力和猫咪真可爱' } }] },
    { post_type: 'request', request_type: 'group', sub_type: 'invite', group_id: 123456789, flag: 'test-invite' },
    { post_type: 'notice', notice_type: 'group_increase', group_id: 123456789 },
    { ...groupPayload('GROUP_PRIVATE_ONLY_SENTINEL malformed private'), message_type: 'private' }
  ]) {
    const result = await send(payload);
    assert.equal(result.ignored, true);
    assert.equal(result.reason, 'Private-only mode');
  }
  const simulated = await fetch(url + '/api/qq/event', { method: 'POST', body: JSON.stringify({
    type: 'group_at', groupId: '123456789', senderId: '123456', hasSelfAtSegment: true, text: 'GROUP_PRIVATE_ONLY_SENTINEL'
  }) });
  assert.equal(simulated.status, 200);
  assert.equal((await simulated.json()).ignored, true);
  const whiteList = await fetch(url + '/api/qq/groups', { method: 'POST', body: JSON.stringify({ allowedGroups: ['123456789'] }) });
  assert.equal(whiteList.status, 404);
  for (const endpoint of ['/api/qq/memory/clear', '/api/qq/personas', '/api/qq/personas/clear']) {
    const response = await fetch(url + endpoint, { method: 'POST', body: '{}' });
    assert.equal(response.status, 404, 'retired group management endpoints are absent');
  }
  assert.equal((await fetch(url + '/api/memory/clear', { method: 'POST', body: JSON.stringify({ scope: 'qq' }) })).status, 400);
  const memoryView = await fetch(url + '/api/memory').then(response => response.json());
  assert.equal(Object.hasOwn(memoryView, 'qq'), false);
  assert.doesNotMatch(JSON.stringify(memoryView), /LEGACY_MEMORY_KEEP|LEGACY_PERSONA_KEEP/);
  // Stale active-group configuration must never schedule a proactive reply.
  await sleep(1200);
  assert.equal((await modelCalls()).length, 0);
  assert.equal(privateReplies.length, 0);
  assert.equal(bridgeCalls.some(call => ['/get_msg', '/get_image', '/send_group_msg', '/send_msg', '/set_group_add_request'].includes(call.path)), false);
  const beforePrivate = await fetch(url + '/api/state').then(response => response.json());
  assert.equal(Object.hasOwn(beforePrivate.qq, 'allowedGroups'), false);
  assert.equal(beforePrivate.qq.events.length, 0);
  for (const key of ['memory', 'personas', 'proactive']) assert.equal(Object.hasOwn(beforePrivate.qq, key), false);
  for (const file of ['qq-memory.json', 'qq-personas.json', 'unified-memory.json']) {
    const contents = await readFile(join(fixture, 'data', file), 'utf8').catch(() => '');
    assert.doesNotMatch(contents, /GROUP_PRIVATE_ONLY_SENTINEL|group-history|test-invite/);
  }
  await send({ post_type: 'message', message_type: 'private', raw_message: '你好，请介绍一下秋叶', message: [{ type: 'text', data: { text: '你好，请介绍一下秋叶' } }] });
  await until(() => privateReplies.length === 1);
  assert.match(JSON.stringify(privateReplies[0]), /私聊模型回复完成/);
  assert.equal((await modelCalls()).length, 1);
  await send({ post_type: 'message', message_type: 'private', raw_message: '/状态', message: [{ type: 'text', data: { text: '/状态' } }] });
  await until(() => privateReplies.length === 2);
  assert.match(JSON.stringify(privateReplies[1]), /状态|模型|知微/);
  assert.equal((await modelCalls()).length, 1, 'the private status command must not call the model');
  assert.equal(bridgeCalls.some(call => ['/get_msg', '/send_group_msg', '/set_group_add_request'].includes(call.path)), false);
  const finalState = await fetch(url + '/api/state').then(response => response.json());
  assert.ok(finalState.qq.events.every(record => !record.event.groupId));
  for (const [file, content] of Object.entries(retiredData)) {
    assert.equal(await readFile(join(fixture, 'data', file), 'utf8'), content, 'legacy disk data remains untouched');
  }
  for (const file of ['qq-memory.json', 'qq-personas.json', 'unified-memory.json']) {
    const contents = await readFile(join(fixture, 'data', file), 'utf8').catch(() => '');
    assert.doesNotMatch(contents, /GROUP_PRIVATE_ONLY_SENTINEL|group-history|test-invite/);
  }
});
