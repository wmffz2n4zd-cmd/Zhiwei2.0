// Linux-only T061 command and conversation gates; synthetic identities, fake CLI, no external sends.
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
import Database from 'better-sqlite3';

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
async function fixture(t, { activity = false } = {}) {
  const parent = join(root, 'runtime', 'tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'pwa-command-life-'));
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
  await writeFile(scenarioPath, JSON.stringify({ reply: '普通聊天已收到。' }));
  const taskWorkspace = join(directory, 'task-workspace'); await mkdir(taskWorkspace);
  await writeFile(join(directory, 'clock.mjs'), `import {readFileSync} from 'node:fs';
Date.now=()=>JSON.parse(readFileSync(${JSON.stringify(clockPath)},'utf8')).now;
// Deterministically exercise the real minimum 2-second command delay.
Math.random=()=>0;`);
  const cli = join(directory, 'fake-codex.mjs');
  await writeFile(cli, `import {readFile,writeFile,appendFile} from 'node:fs/promises';
let prompt='';for await(const part of process.stdin)prompt+=part;
const args=process.argv.slice(2),scenario=JSON.parse(await readFile(${JSON.stringify(scenarioPath)},'utf8'));
const schema=args.includes('--output-schema')?JSON.parse(await readFile(args[args.indexOf('--output-schema')+1],'utf8')):null;
const kind=schema?.properties.choice?'conversation':prompt.includes('本次经管理员确认的任务：')?'task':'ordinary';
await appendFile(${JSON.stringify(callsPath)},JSON.stringify({prompt,args,schema,kind,cwd:process.cwd()})+'\\n');
if(kind==='conversation'&&scenario.holdConversation){await writeFile(${JSON.stringify(join(directory,'conversation-held'))},'yes');
 while(!await readFile(${JSON.stringify(join(directory,'conversation-release'))},'utf8').catch(()=>false))await new Promise(r=>setTimeout(r,20));}
if(scenario.hold){await writeFile(${JSON.stringify(join(directory, 'model-held'))},'yes');
 while(!await readFile(${JSON.stringify(join(directory, 'model-release'))},'utf8').catch(()=>false))await new Promise(r=>setTimeout(r,20));}
let text=scenario.reply||'正常回复。';
if(kind==='conversation')text=JSON.stringify({choice:scenario.choice||'activity',reason:'合成活动选择依据',reply:scenario.choice==='chat'?'':scenario.farewell||'我去看一会书，晚点聊。'});
if(kind==='task'){text='SYNTHETIC_TASK_COMPLETED';await writeFile(${JSON.stringify(join(directory,'task-workspace','executed-marker.txt'))},prompt);}
if(schema?.properties.contactBoundary)text=JSON.stringify({reply:text,contextMore:false,contactBoundary:{kind:'none',quote:''},browseIntent:null});
if(args.includes('-o'))await writeFile(args[args.indexOf('-o')+1],text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,output_tokens:20}}));`);
  await writeFile(join(directory, 'data', 'windows.local.json'), JSON.stringify({
    qqEnabled: false, ownerUserIds: ['123456'], oneBotSecret: 'isolated-secret', oneBotApiBase: 'http://127.0.0.1:1',
    oneBotAccessToken: 'isolated-token', remoteEnabled: true, allowFullAccessTasks: false, workspace: taskWorkspace, webLookup: false,
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
  if (activity) {
    const timeline = await createLifeTimeline({ directory: join(directory, 'data', 'life'), now: () => at });
    await timeline.addThought({ id: 'command-life-thought', text: '想安静看一会书', source: { kind: 'interest', ref: 'synthetic', scope: accounts[0].identity.memoryScope },
      strength: 0.8, notBefore: at, expiresAt: at + 30 * 60000,
      activity: { title: '看书', statusText: '*看书中，稍后回来', durationMs: 10 * 60000, busy: true, mode: 'simulated' } });
    const plan = await timeline.planThought('command-life-thought', { id: 'command-life-plan', startAt: at + 60000 });
    assert.equal(plan.status, 'planned'); await timeline.close();
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
    await writeFile(join(directory, 'conversation-release'), 'release').catch(() => {});
    await stop();
    const forensic = { test: t.name, log: logs, clock: JSON.parse(await readFile(clockPath, 'utf8')),
      lifeJournal: await readFile(join(directory, 'data', 'life', 'journal.jsonl'), 'utf8').catch(() => null),
      replies: await readFile(join(directory, 'data', 'life', 'replies.json'), 'utf8').catch(() => null),
      modelCalls: await readFile(callsPath,'utf8').catch(()=>''),
      conversations: await readFile(join(directory,'data','life','conversations.json'),'utf8').catch(()=>null),
      allMessages: rawMessages(),
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
  const rawMessages = () => {
    const inspection = new Database(databasePath, { readonly: true, fileMustExist: true });
    try { return inspection.prepare('SELECT id,user_id,direction,text,logical_reply_id FROM messages ORDER BY seq').all(); }
    finally { inspection.close(); }
  };
  const choices = async () => JSON.parse(await readFile(join(directory,'data','life','conversations.json'),'utf8')).choices;
  const journal = async () => (await readFile(join(directory,'data','life','journal.jsonl'),'utf8')).split('\n').filter(Boolean).flatMap(line=>JSON.parse(line).events);
  const plan = async () => (await journal()).filter(event=>event.plan?.id==='command-life-plan').at(-1)?.plan;
  await start();
  return { directory, database, accounts, request, send, messages, outbound, rawMessages, memory, calls, choices, journal, plan, taskWorkspace, png, stop, start,
    config: async value => {
      const path = join(directory, 'data', 'windows.local.json');
      const current = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...current, pwa: { ...current.pwa, ...value } }));
    },
    scenario: value => writeFile(scenarioPath, JSON.stringify(value)),
    advance: value => writeFile(clockPath, JSON.stringify({ now: value })), at, logs: () => logs };
}


async function command(f, account, id, text, extra = {}) {
  const before = f.outbound(account).length;
  const accepted = await f.send(account, id, text, extra);
  assert.equal(accepted.status, 200, text);
  await until(() => f.outbound(account).length > before, `command response: ${id}`, 25000);
  await until(() => f.database.getInbox(accepted.body.message.id).state === 'complete'
    && !f.database.listPendingProjections({ limit: 100 }).length, `command settled: ${id}`);
  return f.outbound(account).slice(before).map(message => message.text).join('\n');
}

test('PWA confirmed administrator task reaches only its workspace and returns to the same private mailbox', async t => {
  const f = await fixture(t), [alice, bravo] = f.accounts;
  const denial = await command(f, bravo, 'friend-execute', '/执行 SHOULD_NOT_RUN',
    { role: 'admin', scope: alice.identity.memoryScope, userId: alice.user.userId });
  assert.match(denial, /仅允许管理员/);
  assert.equal((await f.calls()).length, 0);
  const offered = await command(f, alice, 'admin-offer', '/执行 SYNTHETIC_TASK_REQUEST');
  assert.match(offered, /待执行/); assert.match(offered, /3 分钟/);
  assert.equal((await f.calls()).length, 0, 'Proposing a task must not run it');
  assert.equal(await readFile(join(f.taskWorkspace,'executed-marker.txt'),'utf8').then(()=>true,()=>false), false);
  const done = await command(f, alice, 'admin-confirm', '/确认');
  assert.match(done, /SYNTHETIC_TASK_COMPLETED/);
  const calls = await f.calls(); assert.equal(calls.length, 1); assert.equal(calls[0].kind, 'task');
  assert.match(calls[0].prompt, /PWA 管理员私聊/); assert.match(calls[0].prompt, /SYNTHETIC_TASK_REQUEST/);
  assert.equal(calls[0].args[calls[0].args.indexOf('-s')+1], 'workspace-write');
  assert.equal(calls[0].args[calls[0].args.indexOf('-C')+1], f.taskWorkspace);
  assert.equal(calls[0].cwd, f.taskWorkspace);
  assert.match(await readFile(join(f.taskWorkspace,'executed-marker.txt'),'utf8'), /SYNTHETIC_TASK_REQUEST/);
  assert.equal(f.messages(bravo).some(message=>message.text.includes('SYNTHETIC_TASK_COMPLETED')), false);
  const memory = await f.memory();
  const notes = memory.entries.filter(entry => entry.source === 'qq-cli-task');
  assert.equal(notes.length, 1); assert.equal(notes[0].scope, alice.identity.memoryScope);
  assert.match(notes[0].summary, /SYNTHETIC_TASK_COMPLETED/);
  const duplicate = await f.send(alice, 'admin-confirm', '/确认'); assert.equal(duplicate.body.duplicate, true);
  await pause(250); assert.equal((await f.calls()).length, 1);
});

test('PWA task cancellation, expiration and disabled full access never execute a pending task', async t => {
  const f = await fixture(t), [alice] = f.accounts;
  assert.match(await command(f, alice, 'cancel-offer', '/执行 CANCELLED_TASK'), /待执行/);
  assert.match(await command(f, alice, 'cancel-task', '/取消'), /已取消待确认任务/);
  assert.match(await command(f, alice, 'cancel-confirm', '/确认'), /没有有效的待确认任务/);
  assert.match(await command(f, alice, 'expire-offer', '/执行 EXPIRED_TASK'), /待执行/);
  await f.advance(f.at + 180001);
  assert.match(await command(f, alice, 'expire-confirm', '/确认'), /没有有效的待确认任务/);
  assert.match(await command(f, alice, 'fullaccess-refusal', '/执行完全访问 NO_FULL_ACCESS'), /完全访问未在本机启用/);
  assert.equal((await f.calls()).length, 0);
  assert.equal(await readFile(join(f.taskWorkspace,'executed-marker.txt'),'utf8').then(()=>true,()=>false), false);
});

test('PWA activity choice can preserve a real deferred schedule without an extra farewell or restart decision', async t => {
  const f = await fixture(t, { activity: true }), [alice, bravo] = f.accounts;
  await f.scenario({ reply: '这个话题我还想接着聊。', choice: 'chat' });
  const accepted = await f.send(alice, 'conversation-before-defer', 'PRIVATE_ACTIVE_CONVERSATION');
  assert.equal(accepted.status, 200);
  await until(() => f.outbound(alice).length === 1 && !f.database.listPendingProjections({ limit: 100 }).length, 'ordinary conversation delivered');
  await f.advance(f.at + 60000);
  const choice = await until(async () => (await f.choices()).find(value => value.outcome === 'chat-deferred'), 'actual saved defer choice');
  const plan = await f.plan();
  assert.equal(choice.scope, alice.identity.memoryScope);
  assert.equal(plan.startAt, f.at + 6 * 60000); assert.equal(plan.endAt - plan.startAt, 10 * 60000);
  assert.equal(plan.startTransition.status, 'deferred'); assert.equal(plan.status, 'planned');
  const decisions = (await f.calls()).filter(call=>call.kind==='conversation');
  assert.equal(decisions.length, 1); assert.match(decisions[0].prompt, /PRIVATE_ACTIVE_CONVERSATION/);
  assert.equal(f.outbound(alice).length, 1); assert.equal(f.outbound(bravo).length, 0);
  await f.stop(); await f.start(); await pause(1200);
  assert.equal((await f.plan()).startAt, plan.startAt);
  assert.equal((await f.calls()).filter(call=>call.kind==='conversation').length, 1);
  assert.equal(f.outbound(alice).length, 1);
});

test('PWA activity farewell publishes once and a disabled account rejects a generated late farewell', async t => {
  for (const revoke of [false, true]) {
    const f = await fixture(t, { activity: true }), [alice, bravo] = f.accounts;
    const farewell = revoke ? 'REVOKED_FAREWELL_MUST_NOT_APPEAR' : '我先去看书，晚点再聊。';
    await f.scenario({ reply: '普通聊天已收到。', choice: 'activity', farewell, holdConversation: revoke });
    assert.equal((await f.send(alice, 'before-activity', 'PRIVATE_FAREWELL_CONTEXT')).status, 200);
    await until(() => f.outbound(alice).length === 1 && !f.database.listPendingProjections({ limit: 100 }).length, 'initial reply settled');
    await f.advance(f.at + 60000);
    if (revoke) {
      await until(() => readFile(join(f.directory,'conversation-held'),'utf8').catch(()=>false), 'farewell model held');
      f.database.disableUser(alice.user.userId);
      await writeFile(join(f.directory,'conversation-release'),'release');
      await until(async () => (await f.choices()).some(value=>value.status==='finished'), 'revoked choice settled');
      assert.equal(f.rawMessages().filter(row=>row.user_id===alice.user.userId&&row.direction==='outbound').length, 1);
      assert.equal(f.rawMessages().some(row=>row.text.includes(farewell)), false);
      assert.equal((await f.request(alice,'/api/pwa/messages')).status, 401);
      assert.equal(JSON.stringify(await f.memory()).includes(farewell), false);
    } else {
      await until(() => f.outbound(alice).some(message=>message.text===farewell), 'farewell reaches PWA mailbox');
      await until(async () => (await f.choices()).some(value=>value.outcome==='farewell-sent')
        && !f.database.listPendingProjections({ limit: 100 }).length, 'farewell committed once');
      await until(async () => (await f.plan()).status === 'active', 'activity starts after the farewell commit');
      const memories = (await f.memory()).entries.filter(entry=>entry.outbound?.replyText===farewell);
      assert.equal(memories.length, 1); assert.equal(memories[0].scope, alice.identity.memoryScope);
      assert.equal(memories[0].channel, 'pwa');
    }
    assert.equal(f.outbound(bravo).length, 0);
    const count = f.rawMessages().filter(row=>row.direction==='outbound').length;
    const calls = (await f.calls()).length;
    await f.stop(); await f.start(); await pause(1200);
    assert.equal(f.rawMessages().filter(row=>row.direction==='outbound').length, count);
    assert.equal((await f.calls()).length, calls);
    await f.stop();
  }
});
