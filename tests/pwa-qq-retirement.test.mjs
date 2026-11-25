import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, cp, writeFile, readFile, rm, access } from 'node:fs/promises';
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
async function fixture(t, { busy = false, legacyAcl = false } = {}) {
  const parent = join(root, 'runtime', 'tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'pwa-qq-retirement-'));
  const apiPort = await port(), adminPort = await port(), origin = 'https://pwa.test';
  const base = `http://127.0.0.1:${apiPort}`, clockPath = join(directory, 'clock.json');
  const scenarioPath = join(directory, 'scenario.json'), callsPath = join(directory, 'calls.jsonl');
  const databasePath = join(directory, 'data', 'pwa', 'pwa.sqlite');
  const at = Date.UTC(2026, 10, 17, 10, 0);
  let child, logs = '', database;
  await cp(join(root, 'src'), join(directory, 'src'), { recursive: true, filter: path => !path.includes('qq-enhancer') && !path.endsWith('private-chat-access.js') });
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
  let bridgeCalls = 0;
  const bridge = createServer((_req, res) => { bridgeCalls++; res.writeHead(200); res.end('{}'); });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => bridge.close(resolve)));
  await writeFile(join(directory, 'data', 'windows.local.json'), JSON.stringify({
    ...(legacyAcl ? { qqEnabled: true, ownerUserIds: ['123456'], privateChatUserIds: ['123456'], allowOtherPrivateChats: true, oneBotApiBase: `http://127.0.0.1:${bridge.address().port}` } : {}),
    remoteEnabled: false, webLookup: false,
    runtimeBudget: { enabled: false }, mood: { enabled: true },
    life: { enabled: true, tickIntervalMs: 250, planning: { enabled: false }, browsingIntents: { enabled: false } },
    pwa: { enabled: true, origin, port: apiPort, pushEnabled: false }
  }));
  database = createPwaStore({ path: databasePath, now: () => at });
  const auth = createPwaAuth({ store: database });
  const accounts = [];
  for (const [username, role] of [['alice', 'admin'], ['bravo', 'friend']]) {
    const invitation = database.createInvitation({ role, ...(username === 'bravo' ? { memoryScope: 'qq:private:123456' } : {}) });
    const account = await auth.claim({ token: invitation.token, username, displayName: username,
      password: 'a-good-test-password', deviceName: 'synthetic' });
    if (account.identity.bindingStatus === 'pending') account.identity = database.verifyBinding(account.user.userId);
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
        CODEX_REMOTE_CONTACT_WEB_LOOKUP: '0', HOME: directory, CODEX_HOME: join(directory, 'codex-home') } });
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
  return { admin: (path, options) => rawRequest(`http://127.0.0.1:${adminPort}` + path, options), bridgeCalls: () => bridgeCalls, directory, database, accounts, request, send, messages, outbound, memory, calls, png, stop, start,
    config: async value => {
      const path = join(directory, 'data', 'windows.local.json');
      const current = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...current, pwa: { ...current.pwa, ...value } }));
    },
    scenario: value => writeFile(scenarioPath, JSON.stringify(value)),
    advance: value => writeFile(clockPath, JSON.stringify({ now: value })), at, logs: () => logs };
}

test('PWA starts without QQ modules, directories or credentials; retired HTTP routes are absent', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  for (const path of ['src/qq-enhancer', 'src/private-chat-access.js', 'vendor/napcat', 'home/.config/QQ'])
    await assert.rejects(access(join(f.directory, path)));
  const config = JSON.parse(await readFile(join(f.directory, 'data/windows.local.json'), 'utf8'));
  assert.equal(Object.keys(config).some(key => /onebot|^qq|ownerUserIds/i.test(key)), false);
  for (const path of ['/api/onebot/event', '/api/qq/event']) {
    assert.equal((await f.admin(path, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 123456,
        message_id: 'retired-callback', message: [{ type: 'text', data: { text: '/状态' } }] }) })).status, 404);
    // The public listener never routes non-/api/pwa paths into admin APIs;
    // its existing static boundary rejects all such POSTs with 405.
    const publicDenied = await f.request(alice, path, { method: 'POST', data: {} });
    assert.equal(publicDenied.status, 405);
    assert.equal(publicDenied.body.error, 'method-not-allowed');
  }
  const health = await f.admin('/api/maintenance');
  assert.equal(health.status, 200);
  assert.equal(health.body.channels.pwa, true);
  assert.equal(Object.hasOwn(health.body, 'oneBot'), false);
  assert.equal(Object.hasOwn(health.body, 'qq'), false);
  assert.equal(f.bridgeCalls(), 0);
  assert.equal(f.messages(alice).length, 0);
  await f.send(alice, 'web-only-chat', '新的网页独立私聊');
  await until(() => f.outbound(alice).length === 2, 'web reply without bridge');
  assert.equal(f.bridgeCalls(), 0);
});

test('old numeric owner configuration cannot promote the associated PWA friend', async t => {
  const f = await fixture(t, { legacyAcl: true }), [alice, bravo] = f.accounts;
  assert.equal(f.database.getIdentity(bravo.user.userId).memoryScope, 'qq:private:123456');
  assert.equal(f.database.getIdentity(bravo.user.userId).role, 'friend');
  await f.send(bravo, 'legacy-number-owner-attempt', '/默认模型 forbidden-model', {
    role: 'admin', isOwner: true, privateIdentity: alice.identity, userId: alice.user.userId, scope: alice.identity.memoryScope
  });
  await until(() => f.outbound(bravo).length === 1, 'friend denial');
  assert.match(f.outbound(bravo)[0].text, /仅允许管理员/);
  await f.send(alice, 'verified-admin-status', '/状态');
  await until(() => f.outbound(alice).length === 1, 'verified PWA admin status');
  assert.match(f.outbound(alice)[0].text, /网页：开/);
  assert.doesNotMatch(f.outbound(alice)[0].text, /forbidden-model|QQ|OneBot|NapCat/);
  assert.equal((await f.calls()).length, 0);
  const health = await f.admin('/api/maintenance');
  assert.equal(health.status, 200); assert.equal(f.bridgeCalls(), 0);
});

test('new and old scopes retain separate chat, quoted images, original memory and restart without QQ', async t => {
  const f = await fixture(t), [alice, bravo] = f.accounts;
  const newScope = f.database.getIdentity(alice.user.userId).memoryScope;
  assert.match(newScope, /^private:user:/);
  const oldScope = f.database.getIdentity(bravo.user.userId).memoryScope;
  assert.equal(oldScope, 'qq:private:123456');
  await f.scenario({ reply: '新账号的独立回复。' });
  await f.send(alice, 'new-scope-chat', 'NEW_SCOPE_PRIVATE_VALUE');
  await until(() => f.outbound(alice).length === 1, 'new scope chat');
  const uploaded = await f.request(bravo, '/api/pwa/media', { method: 'POST', bytes: f.png, mime: 'image/png' });
  assert.equal(uploaded.status, 201);
  await f.scenario({ reply: '旧关联账号的图片回复。\n[[qq_sticker:笑.png]]' });
  const first = await f.send(bravo, 'old-scope-image', 'OLD_SCOPE_PRIVATE_VALUE', { mediaIds: [uploaded.body.media.id] });
  assert.equal(first.status, 200);
  await until(() => f.outbound(bravo).length === 2, 'legacy scope image reply');
  await f.scenario({ reply: '已依据原图片和文字回答。' });
  await f.send(bravo, 'old-scope-quote', '引用刚才的图', { replyTo: first.body.message.id });
  await until(() => f.outbound(bravo).length === 3, 'legacy image quotation');
  const denied = await f.send(alice, 'cross-scope-image', 'not mine', { mediaIds: [uploaded.body.media.id] });
  assert.equal(denied.status, 404);
  const calls = await f.calls();
  assert.equal(calls.length, 3);
  assert.doesNotMatch(calls[1].prompt, /NEW_SCOPE_PRIVATE_VALUE/);
  assert.ok(calls[1].args.includes('--image'));
  assert.ok(calls[2].args.includes('--image'));
  assert.match(calls[2].prompt, /OLD_SCOPE_PRIVATE_VALUE/);
  const memory = await until(async () => { const current = await f.memory(); return current.entries.filter(e => e.exchange).length === 3 && current; }, 'scoped memories');
  assert.equal(memory.entries.filter(e => e.scope === oldScope && e.exchange).length, 2);
  assert.equal(memory.entries.filter(e => e.scope === newScope && e.exchange).length, 1);
  assert.ok(memory.entries.filter(e => e.exchange).every(e => e.source === 'qq' && e.channel === 'pwa'));
  const ids = memory.entries.map(e => e.id);
  await f.stop(); await f.start();
  assert.equal(f.outbound(alice).length, 1); assert.equal(f.outbound(bravo).length, 3);
  assert.deepEqual((await f.memory()).entries.map(e => e.id), ids);
  assert.equal((await f.calls()).length, 3);
  assert.equal(f.database.listPendingProjections({ limit: 100 }).length, 0);
  assert.equal(f.bridgeCalls(), 0);
});

