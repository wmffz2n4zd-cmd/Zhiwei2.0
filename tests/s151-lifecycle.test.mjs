import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPwaStore } from '../src/pwa-store.js';
import { createPwaAuth } from '../src/pwa-auth.js';
import { createLifeTimeline } from '../src/life-timeline.js';
import { createUnifiedMemory } from '../src/unified-memory/index.js';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
  const began = Date.now();
  while (Date.now() - began < timeout) { const result = await check(); if (result) return result; await pause(40); }
  throw Error(`Timed out: ${label}`);
}
async function port() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: { ...headers,
      ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', reject); req.end(body);
  });
}
async function fixture(t, { busy = false } = {}) {
  const parent = join(root, 'runtime', 'tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'pwa-core-'));
  const apiPort = await port(), adminPort = await port(), origin = 'https://pwa.test';
  const base = `http://127.0.0.1:${apiPort}`, clockPath = join(directory, 'clock.json');
  const scenarioPath = join(directory, 'scenario.json'), callsPath = join(directory, 'calls.jsonl');
  const databasePath = join(directory, 'data', 'pwa', 'pwa.sqlite');
  const at = Date.UTC(2026, 10, 17, 10, 0);
  let child, logs = '', database;
  await cp(join(root, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(root, 'modules'), join(directory, 'modules'), { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await mkdir(join(directory, 'data', 'qq-stickers'), { recursive: true });
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#88aaff' } }).png().toBuffer();
  await writeFile(join(directory, 'data', 'qq-stickers', '笑.png'), png);
  await writeFile(clockPath, JSON.stringify({ now: at }));
  await writeFile(scenarioPath, JSON.stringify({ reply: '第一段。\n\n第二段。' }));
  await writeFile(join(directory, 'clock.mjs'), `import {readFileSync} from 'node:fs';
Date.now=()=>JSON.parse(readFileSync(${JSON.stringify(clockPath)},'utf8')).now;`);
  const cli = join(directory, 'fake-codex.mjs');
  await writeFile(cli, `import {readFile,writeFile,appendFile} from 'node:fs/promises';
let prompt='';for await(const part of process.stdin)prompt+=part;
const args=process.argv.slice(2),scenario=JSON.parse(await readFile(${JSON.stringify(scenarioPath)},'utf8'));
const schema=args.includes('--output-schema')?JSON.parse(await readFile(args[args.indexOf('--output-schema')+1],'utf8')):null;
await appendFile(${JSON.stringify(callsPath)},JSON.stringify({prompt,args,schema,pixels:await Promise.all(args.flatMap((arg,i) => arg==='--image' ? [args[i+1]] : []).map(async path => (await (await import('sharp')).default(path).raw().toBuffer())[0]))})+'\\n');
if(scenario.hold){await writeFile(${JSON.stringify(join(directory, 'model-held'))},'yes');
 while(!await readFile(${JSON.stringify(join(directory, 'model-release'))},'utf8').catch(()=>false))await new Promise(r=>setTimeout(r,20));}
let text=scenario.reply||'正常回复。';
if(schema?.properties.contactBoundary)text=JSON.stringify({reply:text,contextMore:false,contactBoundary:{kind:'none',quote:''},browseIntent:null});
if(args.includes('-o'))await writeFile(args[args.indexOf('-o')+1],text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,output_tokens:20}}));`);
  await writeFile(join(directory, 'data', 'windows.local.json'), JSON.stringify({
    qqEnabled: false, ownerUserIds: ['123456'], oneBotSecret: 'isolated-secret', oneBotApiBase: 'http://127.0.0.1:1',
    oneBotAccessToken: 'isolated-token', remoteEnabled: false, webLookup: false,
    runtimeBudget: { enabled: false }, mood: { enabled: true },
    life: { enabled: true, tickIntervalMs: 250, planning: { enabled: false }, browsingIntents: { enabled: false } },
    pwa: { enabled: true, origin, port: apiPort, pushEnabled: false }
  }));
  database = createPwaStore({ path: databasePath, now: () => at });
  const auth = createPwaAuth({ store: database });
  const accounts = [];
  for (const [username, role] of [['alice', 'admin'], ['bravo', 'friend']]) {
    const invitation = database.createInvitation({ role });
    const account = await auth.claim({ token: invitation.token, username, displayName: username,
      password: 'a-good-test-password', deviceName: 'synthetic' });
    accounts.push(account);
  }
  if (busy) {
    const timeline = await createLifeTimeline({ directory: join(directory, 'data', 'life'), now: () => at });
    await timeline.addThought({ id: 'synthetic-thought', text: '安静看一会书', source: { kind: 'interest', ref: 'synthetic' },
      strength: 0.7, activity: { title: '看书', statusText: '*看书中，稍后回来', durationMs: 60000, busy: true, mode: 'simulated' } });
    const plan = await timeline.planThought('synthetic-thought', { id: 'synthetic-plan', startAt: at + 1000 });
    assert.equal(plan.status, 'planned', 'Fixture must not start an activity before the Hub owns it');
    // Leave the plan unstarted. Active activities are correctly interrupted on
    // process recovery; the Hub itself must own this test activity's start.
    await timeline.close();
  }
  async function start() {
    child = spawn(process.execPath, ['--import', pathToFileURL(join(directory, 'clock.mjs')).href, 'src/server.js'], {
      cwd: directory, windowsHide: true, env: { ...process.env, PORT: String(adminPort), CODEX_CLI_PATH: cli,
        CODEX_REMOTE_CONTACT_QQ_WEB_LOOKUP: '0', HOME: directory, CODEX_HOME: join(directory, 'codex-home') } });
    child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
    let startupResponse;
    await until(() => rawRequest(base + '/', { headers: { host: 'pwa.test' } }).then(response => {
      startupResponse = response; return response.status === 200;
    }).catch(() => false), 'PWA Hub startup').catch(error => {
      throw Error(error.message + '\nHTTP=' + JSON.stringify(startupResponse?.body || startupResponse?.status) + '\n' + logs);
    });
  }
  async function stop(signal = 'SIGTERM') {
    if (child && child.exitCode == null) { const closed = once(child, 'close'); child.kill(signal); await closed; }
    child = null;
  }
  t.after(async () => {
    await writeFile(join(directory, 'model-release'), 'release').catch(() => {});
    await stop();
    const forensic = { test: t.name, log: logs, clock: JSON.parse(await readFile(clockPath, 'utf8')),
      lifeJournal: await readFile(join(directory, 'data', 'life', 'journal.jsonl'), 'utf8').catch(() => null),
      replies: await readFile(join(directory, 'data', 'life', 'replies.json'), 'utf8').catch(() => null),
      pendingInbox: database?.listPendingInbox({ limit: 1000 }), pendingProjections: database?.listPendingProjections({ limit: 1000 }) };
    await writeFile(directory + '.evidence.json', JSON.stringify(forensic, null, 2), { mode: 0o600 });
    database?.close();
    if (resolve(directory).startsWith(resolve(parent) + sep)) await rm(directory, { recursive: true, force: true });
  });
  async function request(account, path, { method = 'GET', data, bytes, mime } = {}) {
    return rawRequest(base + path, { method, headers: { host: 'pwa.test', origin,
      'x-pwa-request': '1', cookie: `__Host-zhiwei=${account.token}`, 'x-csrf-token': account.csrfToken,
      ...(mime ? { 'content-type': mime } : data ? { 'content-type': 'application/json' } : {}) },
      ...(bytes ? { body: bytes } : data ? { body: JSON.stringify(data) } : {}) });
  }
  const send = (account, id, text, extra = {}) => request(account, '/api/pwa/messages', { method: 'POST', data: {
    clientMessageId: id, text, ...extra } });
  const messages = account => database.listMessages(account.user.userId, { limit: 200 }).messages;
  const outbound = account => messages(account).filter(message => message.direction === 'outbound');
  const memory = async () => JSON.parse(await readFile(join(directory, 'data', 'unified-memory.json'), 'utf8'));
  const calls = async () => (await readFile(callsPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse);
  await start();
  if (busy) {
    await writeFile(clockPath, JSON.stringify({ now: at + 1000 }));
    await until(async () => {
      const lines = await readFile(join(directory, 'data', 'life', 'journal.jsonl'), 'utf8');
      const events = lines.split('\n').filter(Boolean).flatMap(line => JSON.parse(line).events);
      return events.some(event => event.type === 'activity-started' && event.plan.id === 'synthetic-plan' && event.plan.busy);
    }, 'Hub-owned busy activity start');
  }
  return { directory, database, accounts, request, send, messages, outbound, memory, calls, png, stop, start,
    config: async value => {
      const path = join(directory, 'data', 'windows.local.json');
      const current = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...current, pwa: { ...current.pwa, ...value } }));
    },
    scenario: value => writeFile(scenarioPath, JSON.stringify(value)),
    advance: value => writeFile(clockPath, JSON.stringify({ now: value })), at, logs: () => logs };
}

// Appended to the frozen PWA fixture by round-two.py. The instrumented CLI
// decodes the pixel in each --image file while that reply is still running.
async function attachColors(f, account, colors) {
  const ids = [];
  for (const r of colors) {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3,
      background: { r, g: 62, b: 90 } } }).png().toBuffer();
    const response = await f.request(account, '/api/pwa/media', { method: 'POST', bytes, mime: 'image/png' });
    assert.equal(response.status, 201);
    ids.push(response.body.media.id);
  }
  return ids;
}

async function sendAndSettle(f, account, clientId, text, extra) {
  const response = await f.send(account, clientId, text, extra);
  assert.equal(response.status, 200);
  await until(() => f.database.getInbox(response.body.message.id)?.state === 'complete', clientId, 45000);
  return response.body.message;
}

test('two accounts upload at the same time and recover only their own ordered pixels after a Hub restart', async t => {
  const f = await fixture(t), [alice, bravo] = f.accounts;
  await f.scenario({ reply: '收到。' });
  const [a, b] = await Promise.all([attachColors(f, alice, [21, 52]), attachColors(f, bravo, [143, 174])]);
  await Promise.all([
    sendAndSettle(f, alice, 'alice-images', '甲的图片', { mediaIds: a }),
    sendAndSettle(f, bravo, 'bravo-images', '乙的图片', { mediaIds: b })
  ]);
  assert.equal((await f.send(bravo, 'cross-media', '看看', { mediaIds: [a[0]] })).status, 404);
  await f.stop('SIGKILL');
  await f.start();
  for (const [account, name, expected] of [[alice, 'alpha', [21, 52]], [bravo, 'bravo', [143, 174]]]) {
    await sendAndSettle(f, account, 'follow-' + name, '刚才这两张图有什么区别？');
    assert.deepEqual((await f.calls()).at(-1).pixels, expected, name + ' after restart');
    assert.equal(f.outbound(account).length, 2);
  }
});

test('replacement of held image reply carries both originals and publishes once', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  const [first, second] = await attachColors(f, alice, [31, 83]);
  await f.scenario({ reply: '旧的草稿', hold: true });
  assert.equal((await f.send(alice, 'first', '先给你一张', { mediaIds: [first] })).status, 200);
  await until(() => readFile(join(f.directory, 'model-held'), 'utf8').catch(() => false), 'held first model call');
  await f.scenario({ reply: '一起看到了。' });
  await sendAndSettle(f, alice, 'second', '再发一张，这两张图有什么区别？', { mediaIds: [second] });
  const calls = await f.calls();
  assert.deepEqual(calls.map(row => row.pixels), [[31], [31, 83]]);
  await f.stop(); await f.start();
  assert.deepEqual(f.outbound(alice).map(row => row.text), ['一起看到了。']);
  assert.equal((await f.calls()).length, 2);
});

test('contact stop fences a held image reply and its pixels across restart and renewed contact', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  const [first, second] = await attachColors(f, alice, [43, 98]);
  await f.scenario({ reply: '旧图回复', hold: true });
  assert.equal((await f.send(alice, 'before-stop', '看看这两张图', { mediaIds: [first, second] })).status, 200);
  await until(() => readFile(join(f.directory, 'model-held'), 'utf8').catch(() => false), 'model has opened both images');
  await sendAndSettle(f, alice, 'stop', '别再联系我了');
  await writeFile(join(f.directory, 'model-release'), 'release');
  await until(() => !f.database.listPendingInbox({ limit: 50 }).length, 'stopped turn settled');
  await f.stop(); await f.start();
  assert.deepEqual(f.outbound(alice), []);
  await f.scenario({ reply: '重新开始。' });
  await sendAndSettle(f, alice, 'after-stop', '刚才这两张图有什么区别？');
  assert.deepEqual((await f.calls()).map(row => row.pixels), [[43, 98], []]);
  assert.deepEqual(f.outbound(alice).map(row => row.text), ['重新开始。']);
});

test('an expired implicit picture is omitted and its explicit history reference is still readable', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  await f.scenario({ reply: '收到。' });
  const ids = await attachColors(f, alice, [64, 105]);
  const original = await sendAndSettle(f, alice, 'old', '先发图片', { mediaIds: ids });
  await f.advance(f.at + 121000);
  await sendAndSettle(f, alice, 'expired', '刚才的图有什么内容？');
  await sendAndSettle(f, alice, 'quote', '引用这条，图里有什么？', { replyTo: original.id });
  assert.deepEqual((await f.calls()).map(row => row.pixels), [[64, 105], [], [64, 105]]);
});

test('five separately submitted pictures retain their page and explicit indices across restart', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  await f.scenario({ reply: '收到。' });
  const colors = [24, 46, 68, 90, 112];
  const ids = await attachColors(f, alice, colors);
  await sendAndSettle(f, alice, 'first-four', '先发四张', { mediaIds: ids.slice(0, 4) });
  await sendAndSettle(f, alice, 'fifth', '这是第五张', { mediaIds: ids.slice(4) });
  assert.ok((await f.calls()).at(-1).pixels.includes(112), 'a numbered caption keeps its own new picture');
  await sendAndSettle(f, alice, 'compare-all', '把刚才发的所有图片按顺序比较一下');
  const firstPage = (await f.calls()).at(-1);
  assert.deepEqual(firstPage.pixels, colors.slice(0, 4));
  assert.match(firstPage.prompt, /共\s*5\s*张/);
  await f.stop('SIGKILL'); await f.start();
  await sendAndSettle(f, alice, 'more', '继续看下一批');
  assert.deepEqual((await f.calls()).at(-1).pixels, [112]);
  await sendAndSettle(f, alice, 'across', '比较这组图片中的第1张与第5张');
  assert.deepEqual((await f.calls()).at(-1).pixels, [24, 112]);
});

test('a missing file does not renumber the remaining evidence', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  await f.scenario({ reply: '收到。' });
  const ids = await attachColors(f, alice, [73, 95, 117]);
  const original = await sendAndSettle(f, alice, 'three', '发三张图片', { mediaIds: ids });
  const record = f.database.getMedia(alice.user.userId, ids[1]);
  assert.ok(resolve(record.path).startsWith(resolve(f.directory) + sep));
  await rm(record.path);
  await sendAndSettle(f, alice, 'missing', '引用这三张图，按顺序比较', { replyTo: original.id });
  const capture = (await f.calls()).at(-1);
  assert.deepEqual(capture.pixels, [73, 117]);
  assert.match(capture.prompt, /第\s*2\s*张.{0,8}(不可读|不可用|缺失)/);
  assert.match(capture.prompt, /附件\s*2\s*=\s*第\s*3\s*张/);
});

test('busy catch-up reads the last image indices beyond the old preview boundary', async t => {
  const f = await fixture(t, { busy: true }), [alice] = f.accounts;
  await f.scenario({ reply: '已经对过这两张。' });
  const ids = await attachColors(f, alice, [29, 56, 83, 110, 137]);
  await sendAndSettle(f, alice, 'busy-four', '先发这四张', { mediaIds: ids.slice(0, 4) });
  await until(() => f.outbound(alice).some(row => row.text.startsWith('*')), 'busy notice');
  const tail = '最后只比较第1张和第5张，留意两张的区别。';
  await sendAndSettle(f, alice, 'busy-long', '这些都是我的笔记。'.repeat(100) + tail, { mediaIds: ids.slice(4) });
  assert.equal((await f.calls()).length, 0);
  await f.advance(f.at + 62000);
  await until(() => f.outbound(alice).some(row => row.text === '已经对过这两张。'), 'catch-up delivered', 35000);
  const calls = await f.calls();
  assert.deepEqual(calls.map(row => row.pixels), [[29,137]]);
  assert.ok(calls[0].prompt.includes(tail));
});
