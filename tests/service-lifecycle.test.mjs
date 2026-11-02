import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServiceLifecycle } from '../src/service-lifecycle.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await predicate()) return; await sleep(20); }
  throw Error('Condition timed out');
}

test('shutdown closes admission first, drains work and world, then awaits final writes exactly once', async () => {
  const world = deferred(), writes = deferred(), events = [], exits = [];
  let pending = 1;
  const lifecycle = createServiceLifecycle({
    stopAccepting: () => { events.push('admission closed'); },
    stopBackground: () => { events.push('world closing'); return world.promise; },
    pending: () => pending,
    flush: () => { events.push('flush latest writes'); return writes.promise; },
    exit: code => exits.push(code), report: () => {}, timeoutMs: 1000, pollMs: 1
  });
  const first = lifecycle.stop('SIGTERM');
  assert.equal(lifecycle.stopping, true);
  assert.equal(lifecycle.stop('SIGINT'), first);
  await sleep(5);
  assert.deepEqual(events, ['admission closed', 'world closing']);
  world.resolve(); await sleep(5);
  assert.deepEqual(exits, []);
  assert.equal(events.includes('flush latest writes'), false);
  pending = 0; await until(() => events.includes('flush latest writes'));
  assert.deepEqual(exits, []);
  writes.resolve();
  assert.equal(await first, 0);
  assert.deepEqual(exits, [0]);
  assert.equal(await lifecycle.stop('/关机'), 0);
  assert.deepEqual(exits, [0]);
});

test('a bounded drain timeout reports failure and exits unsuccessfully', async () => {
  const reports = [], exits = [];
  let flushed = false;
  const lifecycle = createServiceLifecycle({
    stopAccepting: () => {}, stopBackground: () => {}, pending: () => 1,
    flush: () => { flushed = true; }, report: message => reports.push(message),
    exit: code => exits.push(code), timeoutMs: 20, pollMs: 2
  });
  assert.equal(await lifecycle.stop('SIGTERM'), 1);
  assert.deepEqual(exits, [1]);
  assert.equal(flushed, false);
  assert.ok(reports.some(message => /timed out/.test(message)));
});

test('failed final writes cannot be reported as a clean shutdown', async () => {
  const reports = [], exits = [];
  const lifecycle = createServiceLifecycle({
    stopAccepting: () => {}, stopBackground: () => {}, pending: () => 0,
    flush: async () => { throw Error('write failed'); }, report: message => reports.push(message),
    exit: code => exits.push(code), timeoutMs: 100
  });
  assert.equal(await lifecycle.stop('/关机'), 1);
  assert.deepEqual(exits, [1]);
  assert.ok(reports.some(message => /write failed/.test(message)));
  assert.equal(reports.includes('Service stopped cleanly'), false);
});

test('isolated Hub drains an already ACKed OneBot batch and persists reply state before exit', { timeout: 20000 }, async t => {
  const base = join(root, 'runtime', 'tests'); await mkdir(base, { recursive: true });
  const fixture = await mkdtemp(join(base, 'service-lifecycle-'));
  const allowSend = deferred(), sending = deferred();
  let child, logs = '', sent = 0;
  const bridge = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    assert.equal(req.headers.authorization, 'Bearer test-api-token');
    if (req.url === '/send_private_msg') {
      sent++; sending.resolve(JSON.parse(raw));
      await allowSend.promise;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', data: { user_id: 999999, nickname: 'test bridge' } }));
  });
  await new Promise(done => bridge.listen(0, '127.0.0.1', done));
  const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port; await new Promise(done => probe.close(done));
  t.after(async () => {
    allowSend.resolve();
    if (child && child.exitCode == null && child.signalCode == null) {
      const stopped = once(child, 'close'); child.kill('SIGKILL'); await stopped;
    }
    bridge.closeAllConnections(); await new Promise(done => bridge.close(done));
    assert.ok(resolve(fixture).startsWith(resolve(base) + sep));
    await rm(fixture, { recursive: true, force: true });
  });
  await cp(join(root, 'src'), join(fixture, 'src'), { recursive: true });
  await writeFile(join(fixture, 'package.json'), '{"type":"module"}');
  await mkdir(join(fixture, 'data')); await mkdir(join(fixture, 'home'));
  await writeFile(join(fixture, 'data', 'windows.local.json'), JSON.stringify({
    runtimeBudget: { enabled: false }, // Explicit legacy-behavior fixture; budget has separate integration cases.
    ownerUserIds: ['123456'], qqEnabled: true, qqPrivateOnly: true, remoteEnabled: false,
    webLookup: false, oneBotSecret: 'test-callback-secret', oneBotAccessToken: 'test-api-token',
    oneBotApiBase: `http://127.0.0.1:${bridge.address().port}`, world: { enabled: false }
  }));
  const fakeCli = join(fixture, 'fake-codex.mjs');
  await writeFile(fakeCli, `import {writeFile} from 'node:fs/promises';
for await (const chunk of process.stdin) {}
const args = process.argv.slice(2);
await writeFile(args[args.indexOf('-o') + 1], '排空完成的私聊回复');`);
  // Emit POSIX signal events over IPC too, so the same handler is exercised on Windows.
  await writeFile(join(fixture, 'runner.mjs'), `
await import('./src/server.js');
process.on('message', signal => { if (['SIGTERM', 'SIGINT'].includes(signal)) process.emit(signal); });
process.send('ready');`);
  child = spawn(process.execPath, ['runner.mjs'], {
    cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, PORT: String(port), CODEX_CLI_PATH: fakeCli,
      CODEX_HOME: join(fixture, 'home', '.codex'), HOME: join(fixture, 'home'), USERPROFILE: join(fixture, 'home'),
      CODEX_REMOTE_CONTACT_QQ_WEB_LOOKUP: '0' }
  });
  const closed = once(child, 'close');
  child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  await once(child, 'message');
  const url = `http://127.0.0.1:${port}`;
  await until(() => fetch(url + '/api/platform').then(response => response.ok).catch(() => false));
  const payload = { post_type: 'message', message_type: 'private', self_id: 999999, user_id: 123456,
    message_id: 811, raw_message: '继续聊聊今天的书吧', message: [{ type: 'text', data: { text: '继续聊聊今天的书吧' } }] };
  const raw = JSON.stringify(payload);
  const signature = 'sha1=' + createHmac('sha1', 'test-callback-secret').update(raw).digest('hex');
  const response = await fetch(url + '/api/onebot/event', { method: 'POST', headers: { 'x-signature': signature }, body: raw });
  assert.equal(response.status, 200); await response.text();
  if (process.platform === 'win32') { child.send('SIGTERM'); child.send('SIGINT'); }
  else { child.kill('SIGTERM'); child.kill('SIGINT'); }
  await until(() => logs.includes('Service stopping'));
  const admission = await fetch(url + '/api/onebot/event', { method: 'POST', headers: { 'x-signature': signature }, body: raw })
    .then(response => response.status).catch(() => 'closed');
  assert.ok(admission === 503 || admission === 'closed');
  const reply = await sending.promise;
  assert.match(JSON.stringify(reply), /排空完成/);
  assert.equal(child.exitCode, null);
  allowSend.resolve();
  const [code, signal] = await closed;
  assert.equal(code, 0, logs); assert.equal(signal, null);
  assert.equal(sent, 1);
  assert.equal((logs.match(/Service stopping/g) || []).length, 1);
  assert.match(logs, /Service stopped cleanly/);
  const timings = (await readFile(join(fixture, 'runtime', 'logs', 'qq-timings.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(timings.some(record => record.messageId === 811 && record.status === '已回复'));
  const memory = await readFile(join(fixture, 'data', 'unified-memory.json'), 'utf8');
  assert.match(memory, /排空完成的私聊回复/);
});
