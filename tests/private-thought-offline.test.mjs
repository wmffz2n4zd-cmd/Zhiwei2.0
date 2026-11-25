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

async function fixture(t, mode, lifeEnabled) {
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

    await stop();
    store?.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (const path of ['src','modules','config']) await cp(join(root, path), join(dir, path), { recursive: true });
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
    qqEnabled: false, remoteEnabled: false, webLookup: false, privateReplyMode: mode,
    privateLearning: { enabled: false }, runtimeBudget: { enabled: false },
    life: { enabled: lifeEnabled, tickIntervalMs: 250, planning: { enabled: false }, browsingIntents: { enabled: false } },
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
const control = {contextMore:false, contactBoundary:{kind:'none',quote:''}, browseIntent:null, privateThought};
let answer;
if (schema.properties.control) {
  // Reference the actual recovered evidence so it reaches the Writer through
  // its normal selection gate. It first appears on the recall turn.
  const material = prompt.split('\\n').find(line => line.startsWith('[{"ref":"e:'));
  const selected = material ? JSON.parse(material).filter(row => row.kind === 'private-thought').map(row => row.ref) : [];
  answer = {control, utterance:{goal:'回应当前私聊',points:[],evidenceRefs:selected,
    requiredLiterals:[],contextKind:'casual',compressible:false},presentation:{stickerName:null,moodProposal:null}};
} else if (schema.properties.text) {
  answer = {text:reply};
} else {
  answer = {reply,...control};
}
const text = JSON.stringify(answer);
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
  async function start() {
    child = spawn(process.execPath, ['--import',pathToFileURL(clockModule).href,'src/server.js'], { cwd: dir,
      env: { ...process.env, HOME:dir, CODEX_HOME:join(dir,'codex-home'), CODEX_CLI_PATH:cli,
        PORT:String(adminPort), CODEX_REMOTE_CONTACT_WEB_LOOKUP:'0' } });
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
  return { accounts,calls,scenario,send,messages,delivered,drain,stop,start };
}

for (const mode of ['single','two-stage']) {
  for (const lifeEnabled of [true,false]) {
    test('web lookup off, ' + mode + ', life ' + (lifeEnabled ? 'on' : 'off') + ': durable private thought', {timeout:60000}, async t => {
      const f = await fixture(t,mode,lifeEnabled), [alice,bravo] = f.accounts;
      await f.scenario('initial',ordinaryReply,thought);
      await f.send(alice,'first','刚读到《北窗小志》里的排版札记。');
      await f.delivered(alice,ordinaryReply);
      await f.drain();
      assert.ok(!(await f.messages(alice)).some(item => item.text.includes(thought.action)));
      await f.stop(); await f.start();
      for (const [account,label] of [[bravo,'other'],[alice,'recall']]) {
        const reply = label === 'other' ? '聊点别的也好。' : '我记得那次聊天。';
        await f.scenario(label,reply);
        await f.send(account,label,'上次想到什么了？');
        await f.delivered(account,reply);
        await f.drain();
      }
      const calls = await f.calls();
      for (const label of ['initial','other','recall']) {
        const selected = calls.filter(row => row.label === label);
        assert.equal(selected.length,mode === 'single' ? 1 : 2);
        const planner = selected[0];
        const contract = mode === 'single' ? planner.schema : planner.schema.properties.control;
        assert.ok(contract.required.includes('contextMore') && contract.required.includes('privateThought'));
        assert.ok(!contract.properties.lookup && !contract.properties.action);
        if (mode === 'two-stage') assert.deepEqual(selected[1].schema.required,['text']);
        for (const {prompt} of selected) {
          assert.equal(prompt.includes(thought.action), label === 'recall', 'same-account recovered action on the ' + label + ' call');
          if (label === 'recall') assert.ok(prompt.includes(thought.subject));
          if (label === 'other') assert.ok(!prompt.includes(thought.subject));
        }
      }
    });
  }
}
