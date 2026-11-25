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
import { createLifeContacts } from '../src/life-contacts.js';

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
    await timeline.planThought('synthetic-thought', { id: 'synthetic-plan', startAt: at });
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
    await stop(); database?.close();
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
  return { directory, database, accounts, request, send, messages, outbound, memory, calls, png, stop, start,
    config: async value => {
      const path = join(directory, 'data', 'windows.local.json');
      const current = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...current, pwa: { ...current.pwa, ...value } }));
    },
    scenario: value => writeFile(scenarioPath, JSON.stringify(value)),
    advance: value => writeFile(clockPath, JSON.stringify({ now: value })), at, logs: () => logs };
}

test('restart after an unsent replacement retains every accepted original input', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  await f.scenario({ reply: '旧草稿不可发送', hold: true });
  await f.send(alice, 'original-before-replacement', 'ORIGINAL_BEFORE_REPLACEMENT');
  await until(async () => (await f.calls()).length === 1, 'first model held');
  await f.send(alice, 'latest-after-replacement', 'LATEST_AFTER_REPLACEMENT');
  await until(async () => (await f.calls()).length === 2, 'replacement model held', 30000);
  assert.equal(f.outbound(alice).length, 0);
  await f.stop('SIGKILL');
  await writeFile(join(f.directory, 'model-release'), 'release');
  await f.scenario({ reply: '恢复后合并两个已接收输入。' });
  await f.start();
  await until(() => f.outbound(alice).length === 1, 'recovered unsent batch', 30000);
  const captures = await f.calls();
  assert.match(captures.at(-1).prompt, /ORIGINAL_BEFORE_REPLACEMENT/);
  assert.match(captures.at(-1).prompt, /LATEST_AFTER_REPLACEMENT/);
  const saved = await until(async () => { const memory = await f.memory(); return memory.entries.find(entry => entry.exchange); }, 'recovered exchange');
  assert.match(saved.exchange.userText, /ORIGINAL_BEFORE_REPLACEMENT/);
  assert.match(saved.exchange.userText, /LATEST_AFTER_REPLACEMENT/);
  await f.stop('SIGKILL'); await f.start();
  assert.equal(f.outbound(alice).length, 1);
});

test('contact receipt persisted before intake crash retains its original memory epoch', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  await f.stop();
  const scope = alice.identity.memoryScope;
  const memory = createUnifiedMemory({ memoryPath: join(f.directory, 'data', 'unified-memory.json') });
  const memoryEpochToken = await memory.captureEpoch({ scope });
  const accepted = f.database.acceptInbound({ userId: alice.user.userId, clientMessageId: 'contact-before-intake-mark', text: '旧版本尚未答复输入' });
  const contacts = await createLifeContacts({ directory: join(f.directory, 'data', 'life'), now: () => f.at });
  const event = { type: 'private_message', channel: 'pwa', privateIdentity: accepted.identity,
    senderId: alice.user.userId, text: '旧版本尚未答复输入', raw: { message_id: `pwa:${accepted.message.id}` } };
  const receipt = await contacts.observeIncoming(event, { epochToken: memoryEpochToken });
  assert.deepEqual(contacts.incomingEpoch(receipt), memoryEpochToken);
  await contacts.close();
  await memory.clear({ scope });
  assert.equal(await memory.isEpochCurrent(memoryEpochToken), false);
  assert.equal(f.database.getInbox(accepted.inboxId).state, 'accepted');
  await f.start();
  await until(() => ['complete', 'cancelled', 'failed'].includes(f.database.getInbox(accepted.inboxId).state), 'recovered old-epoch inbox');
  assert.equal(f.database.getInbox(accepted.inboxId).state, 'cancelled');
  assert.equal(f.outbound(alice).length, 0);
  assert.equal((await f.calls()).length, 0);
});
