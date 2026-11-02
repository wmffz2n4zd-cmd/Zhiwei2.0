import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSkills, PrivateTasks, resolveChatSkill, skillContext } from '../src/portable.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const owner = text => ({ type: 'private_message', senderId: '123456', isOwner: true, text });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn(); if (value) return value;
    await sleep(25);
  }
  throw Error('Condition timed out');
}
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'portable-retirement-'));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    assert.ok(resolve(base).startsWith(resolve(tmpdir()) + sep));
    await rm(base, { recursive: true, force: true });
  });
  const put = async (path, contents) => {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); return path;
  };
  return { base, put, cleanups };
}

test('retired sibling and configured tool trees are not discovered; independent custom skills remain', async t => {
  const { base, put } = await fixture(t);
  const project = join(base, 'project');
  const retired = join(base, 'nuwa-skill');
  await put(join(retired, 'SKILL.md'), 'retired tool');
  await put(join(retired, 'examples', 'old-example', 'SKILL.md'), 'retired example');
  const local = await put(join(project, 'workspaces', 'remote', 'skills', 'local', 'SKILL.md'), 'custom local');
  const explicit = await put(join(project, 'my-skill.md'), 'custom explicit');
  assert.deepEqual(discoverSkills(project, { nuwaPath: retired, skills: { explicit: 'my-skill.md' } }), { local, explicit });
  assert.deepEqual(discoverSkills(join(base, 'empty-project'), { nuwaPath: retired }), {});
  assert.match(skillContext({ local }, 'local'), /custom local/);
});

test('missing chat selections use the default, while explicit tasks never silently lose their selected skill', async () => {
  assert.equal(resolveChatSkill({}, 'nuwa'), 'none');
  assert.equal(resolveChatSkill({}, 'old-example'), 'none');
  assert.equal(resolveChatSkill({}, 'toString'), 'none');
  assert.equal(skillContext({}, resolveChatSkill({}, 'old-example')), '');
  assert.throws(() => skillContext({}, 'old-example'), /未知 Skill/);
  const skills = { custom: '/custom' }, calls = [];
  const tasks = new PrivateTasks({ skills, enabled: true, run: async (...args) => { calls.push(args); return 'done'; } });
  assert.equal(tasks.chatSkill(owner('hello')), null);
  await tasks.handle(owner('/技能 custom'));
  await tasks.handle(owner('/执行 read a file'));
  delete skills.custom;
  assert.equal(tasks.chatSkill(owner('hello')), 'none');
  assert.match(await tasks.handle(owner('/确认')), /已不可用/);
  assert.equal(calls.length, 0);
  assert.equal(await tasks.handle(owner('/技能')), '当前：none\n可选：none\n发送 /技能 名称。自定义 Skill 可用于普通聊天及已确认的任务；none 使用默认人格。');
  assert.match(await tasks.handle(owner('/技能 nuwa')), /未知 Skill/);
  assert.equal(tasks.chatSkill({ ...owner('hello'), isOwner: false }), null);
  assert.equal(tasks.chatSkill({ ...owner('hello'), type: 'group_message' }), null);
});

test('Hub starts without retired files and stale chat selection still loads the independent persona', { timeout: 30000 }, async t => {
  const { base, put, cleanups } = await fixture(t);
  const project = join(base, 'project');
  await mkdir(project);
  await cp(join(root, 'src'), join(project, 'src'), { recursive: true });
  await cp(join(root, 'modules', 'web-console'), join(project, 'modules', 'web-console'), { recursive: true });
  await put(join(project, 'package.json'), '{"type":"module"}');
  await put(join(project, 'config', 'profile.md'), 'INDEPENDENT_PERSONA_SENTINEL');
  const callsFile = join(project, 'calls.jsonl');
  const fakeCli = await put(join(project, 'fake-cli.mjs'), `import { appendFile, writeFile } from 'node:fs/promises';
let prompt = ''; for await (const part of process.stdin) prompt += part;
await appendFile(${JSON.stringify(callsFile)}, JSON.stringify({ prompt }) + '\\n');
const args = process.argv.slice(2); await writeFile(args[args.indexOf('-o') + 1], 'isolated response');`);
  const sent = [];
  const bridge = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-api');
    let body = ''; for await (const part of req) body += part;
    if (req.url === '/send_private_msg') sent.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', data: { user_id: 999999, nickname: 'fixture' } }));
  });
  await new Promise(r => bridge.listen(0, '127.0.0.1', r));
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  await put(join(project, 'data', 'windows.local.json'), JSON.stringify({
    runtimeBudget: { enabled: false }, ownerUserIds: ['123456'], qqEnabled: true, webLookup: false,
    oneBotSecret: 'fixture-callback', oneBotAccessToken: 'fixture-api',
    oneBotApiBase: `http://127.0.0.1:${bridge.address().port}`,
    assistantProfile: 'config/profile.md', chatSkill: 'old-example', nuwaPath: '../nuwa-skill'
  }));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: project, windowsHide: true,
    env: { ...process.env, PORT: String(port), CODEX_CLI_PATH: fakeCli,
      CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH: '', CODEX_REMOTE_CONTACT_QQ_WEB_LOOKUP: '0' } });
  let logs = ''; child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  cleanups.push(async () => {
    if (child.exitCode == null) { const closed = once(child, 'close'); child.kill(); await closed; }
    bridge.closeAllConnections(); await new Promise(r => bridge.close(r));
  });
  const url = `http://127.0.0.1:${port}`;
  try { await until(() => fetch(url + '/api/platform').then(r => r.ok).catch(() => false)); }
  catch (error) { throw Error(error.message + '\n' + logs); }
  const platform = await fetch(url + '/api/platform').then(r => r.json());
  assert.deepEqual(platform.skills, []); assert.equal(platform.chatSkill, 'none');
  const raw = JSON.stringify({ post_type: 'message', message_type: 'private', self_id: 999999,
    user_id: 123456, message_id: 1, raw_message: '你好', message: [{ type: 'text', data: { text: '你好' } }] });
  const signature = 'sha1=' + createHmac('sha1', 'fixture-callback').update(raw).digest('hex');
  assert.equal((await fetch(url + '/api/onebot/event', { method: 'POST', headers: { 'x-signature': signature }, body: raw })).status, 200);
  await until(() => sent.length > 0);
  assert.match(JSON.stringify(sent), /isolated response/);
  const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /INDEPENDENT_PERSONA_SENTINEL/);
  assert.doesNotMatch(calls[0].prompt, /old-example|nuwa-skill/);
});
