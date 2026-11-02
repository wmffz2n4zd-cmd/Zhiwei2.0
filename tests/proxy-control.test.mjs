import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClashControlYaml, proxyRequest, resolveProxyControl, assertProxyReachable } from '../src/proxy-control.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'tests');
async function fixture(t) {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'proxy-'));
  t.after(async () => { if (resolve(dir).startsWith(root + sep)) await rm(dir, { recursive: true, force: true }); });
  await mkdir(join(dir, 'io.github.clash-verge-rev.clash-verge-rev'));
  return dir;
}

test('runtime discovery replaces placeholder credentials and stale endpoints without persisting secrets', async t => {
  const dir = await fixture(t);
  const runtime = join(dir, 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml');
  await writeFile(runtime, "external-controller: 127.0.0.1:9097\nsecret: 'runtime # key'\n");
  const seen = [];
  const request = async (config, path) => {
    seen.push({ ...config, path });
    if (config.secret !== 'runtime # key') throw Error('unauthorized');
    return { version: 'test' };
  };
  const original = { controller: 'http://127.0.0.1:1111', secret: 'set-your-secret', group: 'Main' };
  const resolved = await resolveProxyControl(original, { env: { APPDATA: dir }, platform: 'win32', request });
  assert.equal(resolved.controller, 'http://127.0.0.1:9097');
  assert.equal(resolved.group, 'Main');
  assert.equal(seen.length, 1);
  assert.equal(original.secret, 'set-your-secret');
  await resolveProxyControl({ ...original, secret: 'old-secret' }, { env: { APPDATA: dir }, platform: 'win32', request });
  assert.equal(seen.at(-2).secret, 'old-secret');
  assert.equal(seen.at(-1).secret, 'runtime # key');
});

test('valid explicit local control takes precedence; unsafe endpoints and paths are rejected', async () => {
  let calls = 0;
  const config = { controller: 'http://127.0.0.1:9999', secret: 'working' };
  assert.equal(await resolveProxyControl(config, { env: {}, request: async () => { calls++; } }), config);
  assert.equal(calls, 1);
  await assert.rejects(resolveProxyControl({ controller: 'http://example.com', secret: 'x' }, { request: async () => { calls++; } }), /本机/);
  await assert.rejects(proxyRequest(config, '//example.com/'), /路径/);
  await assert.rejects(proxyRequest(config, '/\\example.com/'), /路径/);
  assert.equal(calls, 1);
});

test('scalar parser only reads top-level control fields and preserves quoted secrets', () => {
  const value = parseClashControlYaml('proxies:\n  secret: wrong\nsecret: "test\\\"value"\nexternal-controller: 127.0.0.1:9090 # local\n');
  assert.equal(value.secret, 'test"value');
  assert.equal(value.controller, 'http://127.0.0.1:9090');
  assert.equal(parseClashControlYaml('secret: !unsafe tag\n').secret, '');
});

test('HTTP probe authenticates locally and proxy connectivity fails quickly when offline', async t => {
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-key');
    res.setHeader('Content-Type', 'application/json'); res.end('{"version":"fixture"}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const controller = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await proxyRequest({ controller, secret: 'test-key' }, '/version')).version, 'fixture');
  await assertProxyReachable(controller);
  await new Promise(r => server.close(r));
  await assert.rejects(assertProxyReachable(controller, { timeoutMs: 100 }), /没有尝试直连/);
});
