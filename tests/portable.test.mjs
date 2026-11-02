import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrivateTasks, validSignature, codexCommand, resolveCodex } from '../src/portable.js';

const owner = (text, id = '123456') => ({ text, senderId: id, isOwner: true, type: 'private_message' });
test('signed callbacks reject missing, modified and wrong-secret bodies', () => {
  const body = Buffer.from('{"text":"中文测试"}');
  const signature = 'sha1=' + createHmac('sha1', 'secret').update(body).digest('hex');
  assert.ok(validSignature(body, signature, 'secret'));
  assert.equal(validSignature(Buffer.from('{}'), signature, 'secret'), false);
  assert.equal(validSignature(body, signature, 'wrong'), false);
  assert.equal(validSignature(body, undefined, 'secret'), false);
  assert.equal(validSignature(body, signature, ''), false);
});
test('tasks require owner private chat, confirmation, and consume confirmation once', async () => {
  const calls = [];
  const tasks = new PrivateTasks({ enabled: true, skills: { feynman: '/skill' }, run: async (...args) => { calls.push(args); return 'done'; } });
  assert.match(await tasks.handle({ ...owner('/执行 x'), isOwner: false }), /仅允许/);
  assert.match(await tasks.handle({ ...owner('/执行 x'), type: 'group_message' }), /仅允许/);
  await tasks.handle(owner('/技能 feynman'));
  await tasks.handle(owner('/执行 创建文件'));
  assert.equal(calls.length, 0);
  assert.match(await tasks.handle(owner('/确认', '654321')), /没有有效/);
  assert.equal(await tasks.handle(owner('/确认')), 'done');
  assert.equal(calls[0][1], 'feynman');
  await tasks.handle(owner('/确认'));
  assert.equal(calls.length, 1);
  assert.equal(tasks.chatSkill({ ...owner('hi'), type: 'group_message' }), null);
});
test('expiry, cancellation, disabled tasks and concurrency never start unwanted jobs', async () => {
  let now = 0, release, calls = 0;
  const tasks = new PrivateTasks({ enabled: true, skills: {}, now: () => now, run: () => { calls++; return new Promise(r => { release = r; }); } });
  await tasks.handle(owner('/执行 a'));
  now = 180001;
  assert.match(await tasks.handle(owner('/确认')), /没有有效/);
  await tasks.handle(owner('/执行 a'));
  await tasks.handle(owner('/取消'));
  assert.match(await tasks.handle(owner('/确认')), /没有有效/);
  await tasks.handle(owner('/执行 a'));
  const pending = tasks.handle(owner('/确认'));
  assert.match(await tasks.handle(owner('/执行 b', '654321')), /正在执行/);
  assert.match(await tasks.handle(owner('/确认')), /没有有效/);
  release('done'); await pending;
  assert.equal(calls, 1);
  tasks.enabled = false;
  assert.match(await tasks.handle(owner('/执行 a')), /未启用/);
  assert.equal(calls, 1);
});
test('failure releases the busy flag; skill changes do not alter an already proposed task', async () => {
  const tasks = new PrivateTasks({ enabled: true, skills: { feynman: '/skill' }, run: async (_, skill) => { assert.equal(skill, 'none'); throw Error('test failure'); } });
  await tasks.handle(owner('/执行 a'));
  await tasks.handle(owner('/技能 feynman'));
  await assert.rejects(tasks.handle(owner('/确认')), /test failure/);
  assert.equal(tasks.busy, false);
});
test('JS Codex shim is executed with node, without shell interpolation', () => {
  const invocation = codexCommand('C:/directory with spaces/codex.js', ['exec', '-']);
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ['C:/directory with spaces/codex.js', 'exec', '-']);
  assert.equal(codexCommand('C:/codex.exe', []).command, 'C:/codex.exe');
});

async function cliFixture(t) {
  const prefix = join(tmpdir(), 'codex-resolve-');
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    if (!resolve(directory).startsWith(resolve(prefix))) throw Error('Unexpected fixture path');
    await rm(directory, { recursive: true, force: true });
  });
  const executable = async (path, content = 'fixture executable') => {
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, content); return path;
  };
  return { directory, executable };
}

test('Windows desktop discovery picks the newest complete hash directory and recovers a removed override', async t => {
  const { directory, executable } = await cliFixture(t);
  const bin = join(directory, 'OpenAI', 'Codex', 'bin');
  const old = await executable(join(bin, 'old-hash', 'codex.exe'));
  const recent = await executable(join(bin, 'new-hash', 'codex.exe'));
  await executable(join(bin, 'incomplete-update', 'codex.exe'), '');
  await utimes(join(old, '..'), new Date(100000), new Date(100000));
  await utimes(join(recent, '..'), new Date(200000), new Date(200000));
  const env = { LOCALAPPDATA: directory, PATH: '', CODEX_CLI_PATH: join(bin, 'removed-hash', 'codex.exe') };
  assert.equal(resolveCodex(env, { platform: 'win32' }), recent);
  assert.equal(resolveCodex({ ...env, CODEX_CLI_PATH: old }, { platform: 'win32' }), old);
});

test('explicit, PATH and npm installations keep priority over desktop discovery', async t => {
  const { directory, executable } = await cliFixture(t);
  const desktop = await executable(join(directory, 'OpenAI', 'Codex', 'bin', 'hash', 'codex.exe'));
  const pathDir = join(directory, 'path');
  const npm = await executable(join(pathDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  const env = { LOCALAPPDATA: directory, PATH: pathDir };
  assert.equal(resolveCodex(env, { platform: 'win32' }), npm);
  const native = await executable(join(pathDir, 'codex.exe'));
  assert.equal(resolveCodex(env, { platform: 'win32' }), native);
  assert.equal(resolveCodex({ ...env, CODEX_CLI_PATH: desktop }, { platform: 'win32' }), desktop);
});

test('missing desktop install returns a command fallback without consulting the real user install', async t => {
  const { directory } = await cliFixture(t);
  assert.equal(resolveCodex({ PATH: '', LOCALAPPDATA: directory }, { platform: 'win32' }), 'codex.exe');
  assert.equal(resolveCodex({ PATH: '' }, { platform: 'linux' }), 'codex');
});
