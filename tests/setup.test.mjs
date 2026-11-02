import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ask } from '../scripts/setup.mjs';
import { prepareQqModelImages } from '../src/qq-enhancer/index.js';

const source = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url));
const ids = ['--owner', '100001', '--bot', '100002'];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhiwei-setup-'));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('zhiwei-setup-'));
    return rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'scripts'));
  const script = join(root, 'scripts', 'setup.mjs');
  await copyFile(source, script);
  return {
    root,
    local: join(root, 'data', 'local.json'),
    bridgeDir: join(root, 'bridge'),
    bridge: join(root, 'bridge', 'onebot11_100002.json'),
    run: (args = []) => spawnSync(process.execPath, [script, ...ids, ...args], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, ONEBOT_API_BASE: 'http://127.0.0.1:3000' }
    })
  };
}

async function put(path, content, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode });
  await chmod(path, mode);
}

async function absent(path) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}

async function ownerOnly(path) {
  if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o600);
}

test('interactive question returns an answer and releases its readline interface', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = ask('管理员 QQ 号', '', { input, output });
  input.write(' 100001 \n');
  assert.equal(await pending, '100001');
  assert.equal(input.listenerCount('data'), 0);
  input.destroy();
  output.destroy();
});

test('interactive question accepts an empty answer and returns its default', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = ask('显示名称', '知微', { input, output });
  input.write('\n');
  assert.equal(await pending, '知微');
  assert.equal(input.listenerCount('data'), 0);
  input.destroy();
  output.destroy();
});

test('fresh setup creates matching private credentials and reports missing image roots', async (t) => {
  const f = await fixture(t);
  const result = f.run(['--napcat-dir', f.bridgeDir]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const local = JSON.parse(await readFile(f.local, 'utf8'));
  const bridge = JSON.parse(await readFile(f.bridge, 'utf8'));
  assert.match(local.oneBotSecret, /^[a-f0-9]{64}$/);
  assert.match(local.oneBotAccessToken, /^[a-f0-9]{64}$/);
  assert.notEqual(local.oneBotSecret, local.oneBotAccessToken);
  assert.equal(bridge.network.httpServers[0].token, local.oneBotAccessToken);
  assert.equal(bridge.network.httpClients[0].token, local.oneBotSecret);
  assert.deepEqual(local.qqImageCacheRoots, []);
  assert.match(result.stdout, /图片\/静态表情视觉不可用/);
  assert.ok(!result.stdout.includes(local.oneBotSecret));
  assert.ok(!result.stdout.includes(local.oneBotAccessToken));
  await ownerOnly(f.local);
  await ownerOnly(f.bridge);
});

test('an existing bridge blocks setup before a local config or backup is written', async (t) => {
  const f = await fixture(t);
  const original = '{"connections":["existing-websocket"]}\n';
  await put(f.bridge, original);
  const result = f.run(['--napcat-dir', f.bridgeDir]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(await readFile(f.bridge, 'utf8'), original);
  await absent(f.local);
  assert.deepEqual(await readdir(f.bridgeDir), ['onebot11_100002.json']);
});

test('an existing local config blocks setup before a new bridge is written', async (t) => {
  const f = await fixture(t);
  const original = '{"ownerUserIds":["999999"]}\n';
  await put(f.local, original);
  const result = f.run(['--napcat-dir', f.bridgeDir]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(await readFile(f.local, 'utf8'), original);
  await absent(f.bridge);
  assert.deepEqual(await readdir(dirname(f.local)), ['local.json']);
});

test('active legacy config requires explicit force before a new local config can supersede it', async (t) => {
  const f = await fixture(t);
  const legacy = join(dirname(f.local), 'windows.local.json');
  const original = '{"ownerUserIds":["999999"],"legacySetting":"keep"}\r\n';
  await put(legacy, original);
  const denied = f.run(['--napcat-dir', f.bridgeDir]);
  assert.equal(denied.status, 2, denied.stdout + denied.stderr);
  assert.match(denied.stdout, /正在使用旧配置/);
  await absent(f.local);
  await absent(f.bridge);
  assert.equal(await readFile(legacy, 'utf8'), original);
  assert.deepEqual(await readdir(dirname(legacy)), ['windows.local.json']);

  const forced = f.run(['--napcat-dir', f.bridgeDir, '--force']);
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.match(forced.stdout, /新 local\.json 将优先使用.*保留旧配置原件/);
  assert.equal(await readFile(legacy, 'utf8'), original);
  const config = JSON.parse(await readFile(f.local, 'utf8'));
  assert.deepEqual(config.ownerUserIds, ['100001']);
  assert.equal(config.legacySetting, undefined);
  await access(f.bridge);
});

test('force preserves both originals byte for byte with private backups and new files', async (t) => {
  const f = await fixture(t);
  const originals = new Map([[f.local, Buffer.from('old local\r\n')], [f.bridge, Buffer.from('old bridge\r\n')]]);
  for (const [path, bytes] of originals) await put(path, bytes, 0o644);
  const result = f.run(['--napcat-dir', f.bridgeDir, '--force']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const [path, bytes] of originals) {
    const names = await readdir(dirname(path));
    const backups = names.filter((name) => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    const backup = join(dirname(path), backups[0]);
    assert.deepEqual(await readFile(backup), bytes);
    await ownerOnly(backup);
    await ownerOnly(path);
    assert.ok(!names.some((name) => name.endsWith('.tmp')));
    const text = await readFile(path, 'utf8');
    assert.doesNotThrow(() => JSON.parse(text), path);
  }
});

for (const targetName of ['local', 'bridge']) {
  test(`force rejects a ${targetName} symlink without changing either original`, { skip: process.platform === 'win32' }, async (t) => {
    const f = await fixture(t);
    const victim = join(f.root, 'original.json');
    const bytes = 'do not change\n';
    await put(victim, bytes);
    const target = f[targetName];
    await mkdir(dirname(target), { recursive: true });
    await symlink(victim, target);
    const other = targetName === 'local' ? f.bridge : f.local;
    await put(other, 'other original\n');
    const result = f.run(['--napcat-dir', f.bridgeDir, '--force']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /符号链接/);
    assert.equal(await readFile(victim, 'utf8'), bytes);
    assert.equal(await readFile(other, 'utf8'), 'other original\n');
    assert.ok((await lstat(target)).isSymbolicLink());
    assert.ok(!(await readdir(dirname(other))).some((name) => /\.(bak|tmp)$/.test(name)));
  });

  test(`force rejects a ${targetName} directory before changing the other config`, async (t) => {
    const f = await fixture(t);
    const target = f[targetName];
    const other = targetName === 'local' ? f.bridge : f.local;
    await mkdir(target, { recursive: true });
    await put(other, 'other original\n');
    const result = f.run(['--napcat-dir', f.bridgeDir, '--force']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /普通文件/);
    assert.equal(await readFile(other, 'utf8'), 'other original\n');
    assert.ok((await lstat(target)).isDirectory());
    assert.ok(!(await readdir(dirname(other))).some((name) => /\.(bak|tmp)$/.test(name)));
  });
}

test('a symlinked bridge parent is rejected before the existing local config changes', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const actual = join(f.root, 'actual-bridge');
  await mkdir(actual);
  await symlink(actual, f.bridgeDir, 'dir');
  await put(f.local, 'local original\n');
  const result = f.run(['--napcat-dir', f.bridgeDir, '--force']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(await readFile(f.local, 'utf8'), 'local original\n');
  assert.deepEqual(await readdir(actual), []);
});

test('repeated image roots are resolved and deduplicated without admitting other paths', async (t) => {
  const f = await fixture(t);
  const first = join(f.root, 'QQ cache');
  const second = join(f.root, 'another-cache');
  await mkdir(first);
  await mkdir(second);
  const result = f.run(['--qq-image-cache-root', 'QQ cache', '--qq-image-cache-root', second, '--qq-image-cache-root', first]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const local = JSON.parse(await readFile(f.local, 'utf8'));
  assert.deepEqual(local.qqImageCacheRoots, [first, second]);
  assert.ok(!result.stdout.includes('未配置 QQ 图片缓存目录'));
});

test('invalid cache roots and missing option values fail before writing configuration', async (t) => {
  const f = await fixture(t);
  const regular = join(f.root, 'not-a-directory');
  await put(regular, 'file');
  for (const args of [
    ['--qq-image-cache-root'],
    ['--qq-image-cache-root', '--force'],
    ['--qq-image-cache-root', parse(f.root).root],
    ['--qq-image-cache-root', regular],
    ['--napcat-dir']
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    await absent(f.local);
    await absent(f.bridge);
  }
});

test('generated cache roots enable real image preparation while rejecting outside files', async (t) => {
  const f = await fixture(t);
  const cache = join(f.root, 'cache');
  const inside = join(cache, 'inside.png');
  const outside = join(f.root, 'outside.png');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  await put(inside, png);
  await put(outside, png);
  const result = f.run(['--qq-image-cache-root', cache]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const config = JSON.parse(await readFile(f.local, 'utf8'));
  const options = {
    outputDir: join(f.root, 'prepared'),
    cacheRoots: config.qqImageCacheRoots,
    fetchOneBotImage: async (file) => ({ file })
  };
  const paths = await prepareQqModelImages([{ file: inside }, { file: outside }], options);
  assert.equal(paths.length, 1);
  assert.deepEqual(await readFile(paths[0]), png);
  assert.deepEqual(await prepareQqModelImages([{ file: outside }], options), []);
  assert.deepEqual(await prepareQqModelImages([{ file: inside }], { ...options, cacheRoots: [] }), []);
});

test('print-only remains read-only with existing files and redacts generated credentials', async (t) => {
  const f = await fixture(t);
  await put(f.bridge, 'bridge original\n');
  const result = f.run(['--napcat-dir', f.bridgeDir, '--print-only']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /预览，未写入/);
  assert.doesNotMatch(result.stdout, /"[0-9a-f]{64}"/);
  await absent(f.local);
  assert.equal(await readFile(f.bridge, 'utf8'), 'bridge original\n');
  assert.deepEqual(await readdir(f.bridgeDir), ['onebot11_100002.json']);
});
