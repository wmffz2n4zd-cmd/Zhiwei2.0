import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { loadAssistantProfile } from '../src/assistant-profile.js';
import { createWorld } from '../src/world.js';

async function fixture(t) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const projectDir = await mkdtemp(join(base, 'assistant-profile-'));
  t.after(async () => {
    if (resolve(projectDir).startsWith(base + sep)) await rm(projectDir, { recursive: true, force: true });
  });
  return { projectDir, load: (config = {}, env = {}) => loadAssistantProfile({ projectDir, config, env }) };
}

test('profile paths support project-relative config, absolute config and an overriding environment path', async t => {
  const f = await fixture(t);
  await writeFile(join(f.projectDir, 'configured.md'), 'CONFIGURED_PROFILE');
  await writeFile(join(f.projectDir, 'override.md'), 'OVERRIDE_PROFILE');
  for (const path of ['configured.md', join(f.projectDir, 'configured.md')]) {
    assert.equal(await f.load({ assistantProfile: path }), 'CONFIGURED_PROFILE');
    for (const override of ['override.md', join(f.projectDir, 'override.md')]) {
      assert.equal(await f.load({ assistantProfile: path }, {
        CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH: override
      }), 'OVERRIDE_PROFILE');
    }
    assert.equal(await f.load({ assistantProfile: path }, {
      CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH: ''
    }), 'CONFIGURED_PROFILE');
  }
});

test('no profile and an empty profile are valid; an unreadable chosen path does not switch personas', async t => {
  const f = await fixture(t);
  assert.equal(await f.load(), '');
  await writeFile(join(f.projectDir, 'empty.md'), '');
  await writeFile(join(f.projectDir, 'configured.md'), 'DO_NOT_FALL_BACK_TO_THIS');
  assert.equal(await f.load({ assistantProfile: 'empty.md' }), '');
  await assert.rejects(f.load({ assistantProfile: 'missing.md' }), { code: 'ENOENT' });
  await assert.rejects(f.load({ assistantProfile: 'configured.md' }, {
    CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH: 'missing-override.md'
  }), { code: 'ENOENT' });
  await mkdir(join(f.projectDir, 'directory.md'));
  await assert.rejects(f.load({ assistantProfile: 'directory.md' }));
});

test('profile reads retain the entire file and observe edits on the next prompt', async t => {
  const f = await fixture(t), config = { assistantProfile: 'long.md' };
  const first = 'FIRST_START\n' + '完整人格'.repeat(5000) + '\nFIRST_END';
  await writeFile(join(f.projectDir, config.assistantProfile), first);
  assert.equal(await f.load(config), first);
  const second = 'SECOND_START\n' + '更新人格'.repeat(5000) + '\nSECOND_END';
  await writeFile(join(f.projectDir, config.assistantProfile), second);
  assert.equal(await f.load(config), second);
});

test('world planning and reading use the complete current environment profile, then reject a missing file before model calls', async t => {
  const f = await fixture(t), key = 'CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH';
  const before = process.env[key];
  let world;
  t.after(async () => {
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
    await world?.close();
  });
  process.env[key] = join(f.projectDir, 'override.md');
  await writeFile(join(f.projectDir, 'configured.md'), 'UNSELECTED_CONFIG_PROFILE');
  const first = 'FIRST_START\n' + '完整人格'.repeat(5000) + '\nFIRST_END';
  await writeFile(process.env[key], first);
  const calls = [], browserCalls = [];
  world = await createWorld({ projectDir: f.projectDir,
    config: { assistantProfile: 'configured.md', runtimeBudget: { enabled: false },
      life: { enabled: true, planning: { enabled: true } } },
    browser: { status: () => ({ mode: 'readonly', busy: false }), close: async () => {},
      read: async () => { browserCalls.push('read'); throw Error('Browser must remain unused'); },
      search: async () => { browserCalls.push('search'); throw Error('Browser must remain unused'); } },
    think: async input => {
      calls.push(input);
      return { text: JSON.stringify(input.purpose === 'life-planning'
        ? { thoughts: [], reconsiderAfterMinutes: 240 } : { action: 'rest' }) };
    }
  });
  await world.planLife({});
  assert.ok(calls[0].prompt.includes(first));
  assert.doesNotMatch(calls[0].prompt, /UNSELECTED_CONFIG_PROFILE/);
  const second = 'SECOND_START\n' + '更新人格'.repeat(5000) + '\nSECOND_END';
  await writeFile(process.env[key], second);
  await world.run();
  await world.planLife({});
  for (const call of calls.slice(1)) {
    assert.ok(call.prompt.includes(second));
    assert.doesNotMatch(call.prompt, /FIRST_START|UNSELECTED_CONFIG_PROFILE/);
  }
  process.env[key] = join(f.projectDir, 'missing.md');
  await assert.rejects(world.planLife({}), { code: 'ENOENT' });
  await assert.rejects(world.run(), { code: 'ENOENT' });
  assert.equal(calls.length, 3);
  assert.deepEqual(browserCalls, []);
  await world.close(); world = null;
});

test('isolated Hub loads the environment profile in full on each reply and fails closed when it disappears', { timeout: 20000 }, async t => {
  const f = await fixture(t), callsPath = join(f.projectDir, 'captured-prompts.jsonl');
  const selected = join(f.projectDir, 'override.md'), configured = join(f.projectDir, 'configured.md');
  const first = 'HUB_FIRST_START\n' + '完整人格'.repeat(5000) + '\nHUB_FIRST_END';
  await cp(resolve('src'), join(f.projectDir, 'src'), { recursive: true });
  await writeFile(join(f.projectDir, 'package.json'), '{"type":"module"}');
  await mkdir(join(f.projectDir, 'data'));
  await writeFile(configured, 'HUB_UNSELECTED_CONFIG');
  await writeFile(selected, first);
  await writeFile(join(f.projectDir, 'data', 'windows.local.json'), JSON.stringify({
    runtimeBudget: { enabled: false }, ownerUserIds: ['123456'], qqEnabled: true,
    remoteEnabled: false, webLookup: false, world: { enabled: false }, assistantProfile: configured
  }));
  const fakeCli = join(f.projectDir, 'fake-codex.mjs');
  await writeFile(fakeCli, `import { appendFile, writeFile } from 'node:fs/promises';
const args=process.argv.slice(2);let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
await appendFile(${JSON.stringify(callsPath)},JSON.stringify({prompt})+'\\n');
await writeFile(args[args.indexOf('-o')+1],'isolated profile response');`);
  const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port; await new Promise(done => probe.close(done));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: f.projectDir, windowsHide: true,
    env: { ...process.env, PORT: String(port), CODEX_CLI_PATH: fakeCli,
      CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH: selected, CODEX_REMOTE_CONTACT_QQ_WEB_LOOKUP: '0' } });
  let logs = '';
  child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode == null && child.signalCode == null) { const closed = once(child, 'close'); child.kill(); await closed; }
  }
  t.after(stop);
  try {
    const url = `http://127.0.0.1:${port}`, started = Date.now();
    while (!await fetch(url + '/api/platform').then(r => r.ok).catch(() => false)) {
      if (Date.now() - started > 10000) throw Error('Isolated Hub did not start: ' + logs);
      await new Promise(done => setTimeout(done, 25));
    }
    const send = async () => {
      const response = await fetch(url + '/api/qq/event', { method: 'POST', body: JSON.stringify({
        type: 'private_message', senderId: '123456', text: '说说你对生活的看法' }) });
      assert.equal(response.status, 200);
      return (await fetch(url + '/api/state').then(r => r.json())).qq.events[0];
    };
    const calls = async () => (await readFile(callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal((await send()).error, null);
    assert.ok((await calls())[0].prompt.includes(first));
    const second = 'HUB_UPDATED_START\n' + '更新人格'.repeat(5000) + '\nHUB_UPDATED_END';
    await writeFile(selected, second);
    assert.equal((await send()).error, null);
    assert.ok((await calls())[1].prompt.includes(second));
    assert.doesNotMatch((await calls())[1].prompt, /HUB_FIRST_START|HUB_UNSELECTED_CONFIG/);
    await rm(selected);
    const failed = await send();
    assert.ok(failed.error);
    assert.doesNotMatch(failed.error, /override\.md|assistant-profile-/);
    assert.equal((await calls()).length, 2);
  } finally { await stop(); }
});
