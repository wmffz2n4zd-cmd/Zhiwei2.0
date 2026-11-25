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
await appendFile(${JSON.stringify(callsPath)},JSON.stringify({prompt,args,schema})+'\\n');
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

test('real PWA listener reaches shared private core, segments once, isolates users and survives restart', async t => {
  const f = await fixture(t), [alice, bravo] = f.accounts;
  const first = await f.send(alice, 'stable-id', '记住我的测试暗号 ALPHA_PRIVATE');
  assert.equal(first.status, 200);
  const replay = await f.send(alice, 'stable-id', '记住我的测试暗号 ALPHA_PRIVATE');
  assert.equal(replay.body.duplicate, true); assert.equal(replay.body.message.id, first.body.message.id);
  await until(() => f.outbound(alice).length === 2, 'two durable paragraphs');
  await until(async () => (await f.memory()).entries.filter(entry => entry.channel === 'pwa' && entry.exchange).length === 1, 'one exchange projection');
  const outputs = f.outbound(alice); assert.deepEqual(outputs.map(message => message.text), ['第一段。', '第二段。']);
  assert.equal(outputs[0].logicalReplyId, outputs[1].logicalReplyId);
  const denied = await f.send(bravo, 'bad-reference', '看看这条', { replyTo: first.body.message.id });
  assert.equal(denied.status, 404);
  await f.scenario({ reply: '乙的回复。' });
  assert.equal((await f.send(bravo, 'bravo-id', '乙的独立信息')).status, 200);
  await until(() => f.outbound(bravo).length === 1, 'second independent reply');
  assert.equal((await f.request(bravo, '/api/pwa/messages')).body.messages.some(message => message.text.includes('ALPHA_PRIVATE')), false);
  const captures = await f.calls(); assert.equal(captures.length, 2);
  assert.match(captures[0].prompt, /PWA/); assert.doesNotMatch(captures[1].prompt, /ALPHA_PRIVATE/);
  await f.stop(); await f.start();
  assert.equal(f.outbound(alice).length, 2); assert.equal(f.outbound(bravo).length, 1);
  assert.equal(f.database.listPendingProjections({ limit: 100 }).length, 0);
  assert.equal((await f.calls()).length, 2);
});

test('PWA continuous input replaces unsent model work through the shared batch coordinator', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  await f.scenario({ reply: '不应发布的旧草稿', hold: true });
  await f.send(alice, 'first-held', 'FIRST_INPUT');
  await until(() => readFile(join(f.directory, 'model-held'), 'utf8').catch(() => false), 'held CLI');
  await f.scenario({ reply: '依据完整新输入重新回复。' });
  await f.send(alice, 'second-new', 'SECOND_INPUT');
  await until(() => f.outbound(alice).length === 1, 'replacement durable reply', 30000);
  assert.equal(f.outbound(alice)[0].text, '依据完整新输入重新回复。');
  const captures = await f.calls(); assert.equal(captures.length, 2);
  assert.match(captures[1].prompt, /FIRST_INPUT/); assert.match(captures[1].prompt, /SECOND_INPUT/);
  const memory = await until(async () => { const data = await f.memory(); return data.entries.some(entry => entry.exchange) && data; }, 'replacement memory');
  assert.equal(memory.entries.filter(entry => entry.exchange).length, 1);
  assert.equal(memory.entries.some(entry => entry.summary?.includes('不应发布的旧草稿')), false);
});

test('PWA image and same-user quote reach vision without OneBot, and local sticker gets private media ACL', async t => {
  const f = await fixture(t), [alice, bravo] = f.accounts;
  const uploaded = await f.request(alice, '/api/pwa/media', { method: 'POST', bytes: f.png, mime: 'image/png' });
  assert.equal(uploaded.status, 201);
  await f.scenario({ reply: '看到了。\n[[qq_sticker:笑.png]]' });
  await f.send(alice, 'image-input', '看这张图', { mediaIds: [uploaded.body.media.id] });
  await until(() => f.outbound(alice).length === 2, 'text and private sticker');
  const captures = await f.calls(); assert.ok(captures[0].args.includes('--image'));
  const image = f.outbound(alice).find(message => message.type === 'image'); assert.ok(image.mediaIds.length);
  assert.equal((await f.request(bravo, '/api/pwa/media/' + image.mediaIds[0])).status, 404);
  assert.equal((await f.send(bravo, 'other-image', '越权', { mediaIds: [uploaded.body.media.id] })).status, 404);
  await f.scenario({ reply: '沿用引用图片的回复。' });
  const inbound = f.messages(alice).find(message => message.clientMessageId === 'image-input');
  await f.send(alice, 'quote-image', '刚才的图', { replyTo: inbound.id });
  await until(() => f.outbound(alice).length === 3, 'quoted picture reply');
  assert.ok((await f.calls())[1].args.includes('--image'));
});

test('PWA busy status and merged later reply retain their identity with QQ unavailable', async t => {
  const f = await fixture(t, { busy: true }), [alice] = f.accounts;
  await f.send(alice, 'busy-one', '忙的时候第一句');
  await until(() => f.outbound(alice).length === 1, 'busy notice');
  assert.match(f.outbound(alice)[0].text, /^\*/);
  await f.send(alice, 'busy-two', '忙的时候第二句');
  await until(() => f.database.listPendingInbox({ limit: 100 }).length === 0, 'durable busy input');
  assert.equal((await f.calls()).length, 0);
  await f.scenario({ reply: '回来了，刚才两句都看到了。' });
  await f.advance(f.at + 62000);
  await until(() => f.outbound(alice).length === 2, 'merged catch-up', 30000);
  const captures = await f.calls(); assert.equal(captures.length, 1);
  assert.match(captures[0].prompt, /忙的时候第一句/); assert.match(captures[0].prompt, /忙的时候第二句/);
  assert.equal(f.outbound(alice)[1].text, '回来了，刚才两句都看到了。');
});

test('PWA administrator command uses verified role and friends never run it', async t => {
  const f = await fixture(t), [alice, bravo] = f.accounts;
  await f.send(bravo, 'friend-command', '/状态', { role: 'admin', scope: alice.identity.memoryScope, userId: alice.user.userId });
  await f.send(alice, 'admin-command', '/状态');
  await until(() => f.outbound(bravo).length === 1 && f.outbound(alice).length === 1, 'permission-scoped command replies');
  assert.match(f.outbound(bravo)[0].text, /仅允许管理员/);
  assert.match(f.outbound(alice)[0].text, /默认模型/);
  assert.equal((await f.calls()).length, 0);
});

test('durable PWA acceptance before intake survives a process interruption exactly once', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  await f.stop();
  const accepted = f.database.acceptInbound({ userId: alice.user.userId, clientMessageId: 'accepted-before-crash', text: '恢复待处理输入' });
  assert.equal(f.database.getInbox(accepted.inboxId).state, 'accepted');
  await f.start();
  await until(() => f.outbound(alice).length === 2, 'recovered accepted input');
  await until(() => f.database.listPendingProjections({ limit: 100 }).length === 0, 'recovered projection');
  await f.stop('SIGKILL'); await f.start();
  assert.equal(f.outbound(alice).length, 2); assert.equal((await f.calls()).length, 1);
});

test('compatibility read-only mode keeps history and accepted input until reopening', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  await f.stop();
  const accepted = f.database.acceptInbound({ userId: alice.user.userId, clientMessageId: 'retained-read-only', text: '兼容恢复期间保留的输入' });
  await f.config({ readOnly: true }); await f.start();
  assert.equal((await f.request(alice, '/api/pwa/messages')).status, 200);
  assert.equal((await f.send(alice, 'blocked-read-only', '维护时禁止入站')).status, 503);
  assert.equal((await f.request(alice, '/api/pwa/me')).body.readOnly, true);
  await pause(3000);
  assert.equal(f.database.getInbox(accepted.inboxId).state, 'accepted');
  assert.equal((await f.calls()).length, 0);
  await f.stop(); await f.config({ readOnly: false }); await f.start();
  await until(() => f.outbound(alice).length === 2, 'retained input after read-only recovery');
  assert.equal((await f.calls()).length, 1);
});

test('published mailbox and durable projection recover without a second model or reply', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  await f.stop();
  const userId = alice.user.userId, scope = alice.identity.memoryScope;
  const memory = createUnifiedMemory({ memoryPath: join(f.directory, 'data', 'unified-memory.json') });
  const memoryEpochToken = await memory.captureEpoch({ scope });
  const accepted = f.database.acceptInbound({ userId, clientMessageId: 'published-before-interruption', text: '已经投递的合成输入' });
  f.database.markInboxProjected(accepted.inboxId, {});
  const logicalReplyId = 'fixture-published-before-interruption';
  const event = { type: 'private_message', channel: 'pwa', privateIdentity: accepted.identity,
    senderId: userId, senderLabel: 'synthetic', text: '已经投递的合成输入', memoryEpochToken,
    pwaLogicalReplyId: logicalReplyId, raw: { message_id: `pwa:${accepted.message.id}` } };
  f.database.publishSegments({ userId, scope, routeVersion: accepted.identity.routeVersion,
    generation: accepted.identity.generation, inboundIds: [accepted.message.id], deliveryId: `${logicalReplyId}:0`,
    logicalReplyId, segments: [{ type: 'text', text: '已进入信箱，尚待投影。' }],
    projection: { version: 1, kind: 'exchange', logicalReplyId, event, replyText: '已进入信箱，尚待投影。' } });
  f.database.completeInbox(accepted.inboxId);
  await f.config({ readOnly: true }); await f.start();
  await until(() => f.database.listPendingProjections({ limit: 100 }).length === 0, 'published projection replay in read-only mode');
  const saved = (await f.memory()).entries.filter(entry => entry.exchange);
  assert.equal(saved.length, 1); assert.equal(saved[0].exchange.replyText, '已进入信箱，尚待投影。');
  assert.equal(f.outbound(alice).length, 1); assert.equal((await f.calls()).length, 0);
  await f.stop('SIGKILL'); await f.start();
  assert.equal((await f.memory()).entries.filter(entry => entry.exchange).length, 1);
  assert.equal(f.outbound(alice).length, 1); assert.equal((await f.calls()).length, 0);
});
