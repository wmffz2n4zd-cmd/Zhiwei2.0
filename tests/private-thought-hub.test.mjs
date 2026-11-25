import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPwaAuth } from '../src/pwa-auth.js';
import { createPwaStore } from '../src/pwa-store.js';
import { createLifeTimeline } from '../src/life-timeline.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const origin = 'https://pwa.test';
const thought = { action: '把第七页的两种留白排法画成对照草图', subject: '《北窗小志》的排版札记' };
const ordinaryReply = '这篇写得慢悠悠的，我喜欢。';

async function until(check, label) {
  const end = Date.now() + 20000;
  do {
    const value = await check();
    if (value) return value;
    await delay(350);
  } while (Date.now() < end);
  throw Error('Timed out waiting for ' + label);
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function call(port, path, account, body) {
  const headers = { host: 'pwa.test' };
  if (account) Object.assign(headers, { origin, cookie: '__Host-zhiwei=' + account.token,
    'x-csrf-token': account.csrfToken, 'x-pwa-request': '1' });
  const payload = body ? JSON.stringify(body) : '';
  if (body) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers, method: body ? 'POST' : 'GET' }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Error('HTTP ' + res.statusCode + ' for ' + path));
        resolve(path === '/' ? true : JSON.parse(data));
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function fixture(t, { busy = false, holdFirstPublication = false } = {}) {
  const parent = join(root, 'runtime', 'tests');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'private-thought-'));
  let child, store, logs = '';
  async function stop(signal = 'SIGTERM') {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill(signal);
      await closed;
    }
    child = null;
  }
  t.after(async () => {
    if (holdFirstPublication) await writeFile(join(dir,'release'),'release');
    await stop();
    store?.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (const path of ['src','modules','config']) await cp(join(root, path), join(dir, path), { recursive: true });
  if (holdFirstPublication) {
    // Park the disposable Hub after its real SQLite transaction, before its
    // next send or projection. An interrupted process cannot release this gate.
    const path = join(dir,'src/server.js');
    const source = await readFile(path,'utf8');
    const published = '    pwaHttp?.changed(identity.userId);';
    assert.equal(source.split(published).length, 2);
    await writeFile(path,source.replace(published,published + `
    if (event.text === '这篇的排版如何？' && index === 0) {
      await writeFile(${JSON.stringify(join(dir,'held'))},'held');
      while (!await readFile(${JSON.stringify(join(dir,'release'))},'utf8').catch(() => false)) await sleep(20);
    }`));
  }
  await mkdir(join(dir, 'data'), { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  const port = await freePort(), adminPort = await freePort();
  const clockPath = join(dir, 'clock'), clockModule = join(dir, 'clock.mjs');
  const startTime = Date.UTC(2026, 10, 18, 10, 0);
  const advance = time => writeFile(clockPath, String(time));
  await advance(startTime);
  await writeFile(clockModule, "import {readFileSync} from 'node:fs'; Date.now=()=>Number(readFileSync(" +
    JSON.stringify(clockPath) + ",'utf8'));");
  await writeFile(join(dir, 'data/windows.local.json'), JSON.stringify({
    qqEnabled: false, remoteEnabled: false, webLookup: true, privateReplyMode: 'single',
    privateLearning: { enabled: false }, runtimeBudget: { enabled: false },
    life: { enabled: true, tickIntervalMs: 250, planning: { enabled: false }, browsingIntents: { enabled: false } },
    pwa: { enabled: true, origin, port, privateThoughtsEnabled: true, pushEnabled: false }
  }));
  const cli = join(dir, 'fixture-model.mjs'), config = join(dir, 'decision.json'), callsPath = join(dir, 'calls.jsonl');
  await writeFile(cli, `import {appendFile, readFile, writeFile} from 'node:fs/promises';
let prompt = '';
for await (const part of process.stdin) prompt += part;
const args = process.argv.slice(2);
const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1],'utf8'));
const {label, reply, privateThought} = JSON.parse(await readFile(${JSON.stringify(config)},'utf8'));
await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({label,prompt,schema}) + '\\n');
const text = JSON.stringify({action:'reply',reply,lookup:null,contactBoundary:{kind:'none',quote:''},browseIntent:null,privateThought});
await writeFile(args[args.indexOf('-o') + 1],text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:12}}));`);
  const scenario = (label, reply, privateThought = null) => writeFile(config, JSON.stringify({label, reply, privateThought}));
  const calls = async () => (await readFile(callsPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse);
  store = createPwaStore({ path: join(dir, 'data/pwa/pwa.sqlite'), now: () => startTime });
  const auth = createPwaAuth({ store });
  const accounts = [];
  for (const username of ['alice','bravo']) {
    const invite = store.createInvitation({ role: 'friend' });
    accounts.push(await auth.claim({ username, displayName: username, token: invite.token,
      password: 'synthetic-strong-password', deviceName: 'fixture' }));
  }
  if (busy) {
    const timeline = await createLifeTimeline({ directory: join(dir, 'data/life'), now: () => startTime });
    await timeline.addThought({ id:'test-busy', text:'看一会儿书', source:{kind:'interest',ref:'fixture'}, strength:0.8,
      activity:{title:'看书',statusText:'*看书中，稍后回来',durationMs:60000,busy:true,mode:'simulated'} });
    assert.equal((await timeline.planThought('test-busy', {id:'test-plan',startAt:startTime+1000})).status,'planned');
    await timeline.close();
  }
  async function start() {
    child = spawn(process.execPath, ['--import',pathToFileURL(clockModule).href,'src/server.js'], { cwd: dir,
      env: { ...process.env, HOME:dir, CODEX_HOME:join(dir,'codex-home'), CODEX_CLI_PATH:cli,
        PORT:String(adminPort), CODEX_REMOTE_CONTACT_WEB_LOOKUP:'1' } });
    child.stdout.on('data', data => { logs += data; });
    child.stderr.on('data', data => { logs += data; });
    await until(() => call(port,'/').catch(() => false),'Hub startup').catch(error => { throw Error(error.message + '\n' + logs); });
  }
  await start();
  const send = (account, id, text) => call(port,'/api/pwa/messages',account,{clientMessageId:id,text});
  const messages = async account => (await call(port,'/api/pwa/messages',account)).messages;
  const outbound = async account => (await messages(account)).filter(item => item.direction === 'outbound');
  const drain = () => until(() => !store.listPendingProjections().length && !store.listPendingInbox().length,'durable sinks');
  const delivered = (account, expected) => until(async () => (await outbound(account)).some(item => item.text === expected), expected);
  if (busy) {
    await advance(startTime + 1000);
    await until(async () => {
      const rows = (await readFile(join(dir,'data/life/journal.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      return rows.some(row => row.events.some(event => event.type === 'activity-started' && event.plan.id === 'test-plan'));
    }, 'busy activity start');
  }
  const parked = () => until(() => readFile(join(dir,'held'),'utf8').catch(() => false),'committed first segment');
  return { store, accounts, calls, scenario, send, messages, outbound, delivered, drain, stop, start, advance, startTime, parked };
}

for (const partial of [true, false]) {
  test('process death after ' + (partial ? 'an incomplete prefix discards the proposal' : 'the full reply recovers its proposal'),
    {timeout:60000}, async t => {
      const f = await fixture(t,{holdFirstPublication:true}), [alice] = f.accounts;
      const prefix = '这个留白我喜欢。';
      const tail = '第二段也处理得很漂亮。';
      await f.scenario('before-crash',partial ? prefix + '\n\n' + tail : prefix,thought);
      await f.send(alice,'draft','这篇的排版如何？');
      await f.parked();
      assert.deepEqual((await f.outbound(alice)).map(item => item.text),[prefix]);
      assert.equal(f.store.listPendingProjections().length,1);
      await f.stop('SIGKILL');
      await f.start();
      await f.drain();
      await f.scenario('after-crash','我还在。');
      await f.send(alice,'followup','刚才想到什么了？');
      await f.delivered(alice,'我还在。');
      await f.drain();
      assert.deepEqual((await f.outbound(alice)).map(item => item.text),[prefix,'我还在。']);
      const calls = await f.calls();
      assert.deepEqual(calls.map(row => row.label),['before-crash','after-crash']);
      assert.equal(calls[1].prompt.includes(thought.action),!partial);
    });
}

for (const busy of [false, true]) {
  test('private thought survives Hub restart only in its originating chat (' + (busy ? 'busy merged reply' : 'ordinary reply') + ')',
    {timeout:90000}, async t => {
      const f = await fixture(t,{busy}), [alice, bravo] = f.accounts;
      await f.scenario('initial',ordinaryReply,thought);
      const initial = await f.send(alice, 'initial', '刚读到《北窗小志》里的排版札记。');
      if (busy) {
        await until(async () => (await f.outbound(alice)).some(item => item.text.startsWith('*')), 'busy notice');
        await f.send(alice,'detail','我把这篇读完了。');
        await until(() => !f.store.listPendingInbox().length, 'busy batch');
        assert.equal((await f.calls()).length,0);
        await f.advance(f.startTime + 62000);
      }
      await f.delivered(alice, ordinaryReply);
      await f.drain();
      const [first] = await f.calls();
      assert.ok(first.schema.required.includes('privateThought'),'production model schema offers the thought contract');
      assert.ok(!first.prompt.includes(thought.action),'action first appears in the internal model decision');
      assert.ok(!(await f.messages(alice)).some(item => item.text.includes(thought.action)));
      await f.stop();
      await f.start();
      const duplicate = await f.send(alice,'initial','刚读到《北窗小志》里的排版札记。');
      assert.equal(duplicate.duplicate,true);
      assert.equal(duplicate.message.id,initial.message.id);
      await f.scenario('other','聊点别的也好。');
      await f.send(bravo,'other','上次想到什么了？');
      await f.delivered(bravo,'聊点别的也好。');
      await f.drain();
      await f.scenario('recall','我记得那次聊天。');
      await f.send(alice,'recall','上次想到什么了？');
      await f.delivered(alice,'我记得那次聊天。');
      await f.drain();
      const calls = await f.calls();
      assert.deepEqual(calls.map(call => call.label),['initial','other','recall']);
      assert.ok(!calls[1].prompt.includes(thought.action) && !calls[1].prompt.includes(thought.subject));
      assert.ok(calls[2].prompt.includes(thought.action),'final reply receives the persisted action after restart');
      assert.ok(calls[2].prompt.includes(thought.subject),'retains the original subject');
      assert.ok(!(await f.messages(bravo)).some(item => item.text.includes(thought.subject)));
    });
}
