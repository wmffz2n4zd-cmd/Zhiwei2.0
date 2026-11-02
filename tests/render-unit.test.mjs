import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { renderUnit } from '../scripts/render-unit.mjs';

const template = await readFile(new URL('../deploy/zhiwei.service.in', import.meta.url), 'utf8');
const options = { dir: '/srv/zhiwei', user: 'zhiwei', home: '/home/zhiwei', node: '/usr/bin/node' };

test('unit keeps a persistent optional environment file without embedding local CLI credentials', () => {
  const unit = renderUnit(template, options);
  assert.match(unit, /^EnvironmentFile=-\/srv\/zhiwei\/deploy\/zhiwei\.env$/m);
  assert.match(unit, /^Environment="HOME=\/home\/zhiwei"$/m);
  assert.match(unit, /^ExecStart=:"\/usr\/bin\/node" src\/server\.js$/m);
  assert.match(unit, /^User=zhiwei$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^TimeoutStopSec=600$/m);
  assert.doesNotMatch(unit, /(?:CODEX_HOME|CODEX_CLI_PATH)=/);
});

test('systemd raw paths and quoted words preserve spaces, quotes, percent signs and backslashes', () => {
  const unit = renderUnit(template, {
    ...options,
    dir: String.raw`/srv/50% "quoted"\directory @NODE@`,
    home: String.raw`/home/a "quote"\b%h`,
    node: String.raw`/opt/$tools/50% "quoted"\node`,
    envFile: '/etc/50% "quoted" @HOME_ENV@.env'
  });
  assert.ok(unit.includes(String.raw`WorkingDirectory=/srv/50%% "quoted"\directory @NODE@` + '\n'));
  assert.ok(unit.includes('EnvironmentFile=-/etc/50%% "quoted" @HOME_ENV@.env\n'));
  assert.ok(unit.includes(String.raw`Environment="HOME=/home/a \"quote\"\\b%%h"` + '\n'));
  assert.ok(unit.includes(String.raw`ExecStart=:"/opt/$tools/50%% \"quoted\"\\node" src/server.js` + '\n'));
});

test('ambiguous environment file paths and injected directives are rejected', () => {
  for (const envFile of ['/etc/*.env', '/etc/[a].env', '/etc/file?.env', '/etc/back\\slash.env', '/etc/trailing ']) {
    assert.throws(() => renderUnit(template, { ...options, envFile }), /环境文件/);
  }
  for (const field of ['dir', 'home', 'node', 'envFile']) {
    assert.throws(() => renderUnit(template, { ...options, [field]: '/valid\nExecStart=/bad' }), /控制字符/);
    assert.throws(() => renderUnit(template, { ...options, [field]: 'relative/path' }), /绝对路径/);
  }
  assert.throws(() => renderUnit(template, { ...options, user: 'a\nUser=root' }), /用户名称/);
});

test('environment example has no active assignments or embedded credentials', async () => {
  const example = await readFile(new URL('../deploy/zhiwei.env.example', import.meta.url), 'utf8');
  assert.ok(example.split(/\r?\n/).every(line => !line.trim() || line.startsWith('#')));
  for (const name of ['CODEX_CLI_PATH', 'CODEX_HOME', 'PATH']) assert.ok(example.includes(`# ${name}=`));
});

test('renderer CLI accepts --env-file and old options without launching a service', { skip: process.platform !== 'linux' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiwei-render-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '/zhiwei-render-'));
    await rm(directory, { recursive: true, force: true });
  });
  const output = join(directory, 'zhiwei.service');
  const envFile = join(directory, 'local environment.env');
  const execute = promisify(execFile);
  await execute(process.execPath, [fileURLToPath(new URL('../scripts/render-unit.mjs', import.meta.url)),
    '--dir', directory, '--user', 'zhiwei', '--home', '/home/zhiwei', '--node', process.execPath,
    '--out', output, '--env-file', envFile]);
  const unit = await readFile(output, 'utf8');
  assert.ok(unit.includes(`EnvironmentFile=-${envFile}\n`));
  await assert.rejects(readFile(envFile), { code: 'ENOENT' });
});

test('systemd parses the rendered special-character paths without starting a service', { skip: process.platform !== 'linux' }, async t => {
  const execute = promisify(execFile);
  try { await execute('systemd-analyze', ['--version']); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('systemd-analyze is not installed'); throw error; }
  const directory = await mkdtemp(join(tmpdir(), 'zhiwei-unit-verify-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '/zhiwei-unit-verify-'));
    await rm(directory, { recursive: true, force: true });
  });
  const installDir = join(directory, '50% "quoted" $literal');
  await mkdir(installDir);
  const executable = join(installDir, 'node');
  await symlink(process.execPath, executable);
  const unit = renderUnit(template, {
    dir: installDir, user: userInfo().username, home: directory, node: executable
  });
  const output = join(directory, 'zhiwei-paths.service');
  await writeFile(output, unit);
  await execute('systemd-analyze', ['verify', output]);
});
