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
const reply = text => ({action:'reply',reply:text,lookup:null,contactBoundary:{kind:'none',quote:''},browseIntent:null});
const lookup = freshness => ({...reply(''),action:'lookup',lookup:{topicIds:['public:python'],freshness:freshness||'current',sourceUrl:null}});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
  const began = Date.now();
  while (Date.now() - began < timeout) { const result = await check(); if (result) return result; await pause(40); }
  throw Error(`Timed out: ${label}`);
}

async function planContact(f, account) {
  await f.stop();
  const now=f.at+11*60000; await f.advance(now);
  const timeline=await createLifeTimeline({directory:join(f.directory,'data/life'),now:()=>now});
  await timeline.addThought({id:'lookup-contact',text:'想和这位朋友聊聊 Python 的新变化，先核实一下新资料。',strength:0.8,
    source:{kind:'life-planner',ref:'synthetic',scope:account.identity.memoryScope},
    activity:{title:'聊聊 Python',statusText:'',durationMs:60000,busy:false,mode:'external',action:{type:'contact'}}});
  await timeline.planThought('lookup-contact',{id:'lookup-contact-plan',startAt:now+1000});await timeline.close();
  await f.start();await f.advance(now+1000);
}

test('actual PWA proactive lookup retains motive/object sources and emits one final outbound across restart', {timeout:60000}, async t=>{
  const f=await fixture(t),[alice,bravo]=f.accounts;
  await f.send(alice,'relationship','Python 是我们一直聊的兴趣。');
  await until(()=>f.outbound(alice).length===1&&!f.database.hasPendingProjection(alice.identity.memoryScope),'initial exchange');
  await f.scenario({name:'proactive',decisions:[reply('unused')]});await planContact(f,alice);
  await until(()=>f.outbound(alice).length===2,'proactive evidence reply',30000);
  assert.equal(f.outbound(alice)[1].text,'PROACTIVE_WITH_EVIDENCE');assert.equal(f.outbound(bravo).length,0);
  const calls=(await f.calls()).filter(row=>row.name==='proactive');assert.equal(calls.length,2);
  assert.ok(calls[0].schema.required.includes('sourceRefs'));assert.match(calls[1].prompt,/PUBLIC_RETRIEVAL_FACT/);
  assert.equal((await f.lookups()).length,1);assert.doesNotMatch(JSON.stringify(await f.lookups()),/我们一直|alice|web:private/);
  const maintenance=await f.maintenance();assert.equal(maintenance.status,200);
  assert.equal(maintenance.body.webLookup.lastDurationMs,137,'Expose proactive HTTP duration in maintenance');
  await until(()=>!f.database.hasPendingProjection(alice.identity.memoryScope),'proactive projection');
  const contacts=JSON.parse(await readFile(join(f.directory,'data/life/contacts.json'),'utf8'));
  assert.equal(contacts.intents.filter(i=>i.status==='sent').length,1);
  await f.stop();await f.start();await pause(500);assert.equal(f.outbound(alice).length,2);
  assert.equal((await f.calls()).filter(row=>row.name==='proactive').length,2);
});

test('incoming PWA message while proactive HTTP waits cancels contact claim and never sends its late result', {timeout:60000}, async t=>{
  const f=await fixture(t),[alice]=f.accounts;
  await f.send(alice,'relationship','Python 是我们一直聊的兴趣。');
  await until(()=>f.outbound(alice).length===1&&!f.database.hasPendingProjection(alice.identity.memoryScope),'initial exchange');
  await f.adapter({hold:true});await f.scenario({name:'held-proactive',decisions:[reply('unused')]});await planContact(f,alice);
  await until(async()=>(await f.lookups()).length===1,'proactive HTTP pending',30000);
  await f.adapter({});await f.scenario({name:'new-incoming',decisions:[reply('NEW_INCOMING_REPLY')]});
  await f.send(alice,'new-incoming','我回来了，先聊别的。');
  await until(()=>f.outbound(alice).length===2,'ordinary input replaces proactive',30000);
  await until(async()=>(await f.lookups()).some(row=>row.cancelled),'proactive transport abort');
  assert.equal(f.outbound(alice)[1].text,'NEW_INCOMING_REPLY');assert.equal(f.outbound(alice).some(m=>m.text==='PROACTIVE_WITH_EVIDENCE'),false);
  assert.equal((await f.calls()).filter(row=>row.name==='held-proactive').length,1);
  await until(async()=>{const c=JSON.parse(await readFile(join(f.directory,'data/life/contacts.json'),'utf8'));return c.intents.every(i=>!['pending','generating','ready','sending'].includes(i.status));},'claim terminal');
});
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
async function fixture(t, { busy = false, webLookup = true, life = true } = {}) {
  const parent = join(root, 'runtime', 'tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 't062-d-proactive-hub-'));
  const apiPort = await port(), adminPort = await port(), origin = 'https://pwa.test';
  const base = `http://127.0.0.1:${apiPort}`, clockPath = join(directory, 'clock.json');
  const scenarioPath = join(directory, 'scenario.json'), callsPath = join(directory, 'calls.jsonl');
  const lookupPath = join(directory, 'lookup.jsonl'), adapterPath = join(directory, 'adapter.json');
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
  await writeFile(scenarioPath, JSON.stringify({ name: 'direct', decisions: [reply('DIRECT_REPLY')] }));
  await writeFile(adapterPath, '{}');
  await writeFile(join(directory, 'clock.mjs'), `import {readFileSync} from 'node:fs';
Date.now=()=>JSON.parse(readFileSync(${JSON.stringify(clockPath)},'utf8')).now;`);
  const cli = join(directory, 'fake-codex.mjs');
  await writeFile(cli, `import {readFile,writeFile,appendFile} from 'node:fs/promises';
let prompt='';for await(const part of process.stdin)prompt+=part;
const args=process.argv.slice(2),scenario=JSON.parse(await readFile(${JSON.stringify(scenarioPath)},'utf8'));
const schema=args.includes('--output-schema')?JSON.parse(await readFile(args[args.indexOf('--output-schema')+1],'utf8')):null;
const previous=(await readFile(${JSON.stringify(callsPath)},'utf8').catch(()=>'')).split('\\n').filter(Boolean).map(JSON.parse);
const index=previous.filter(row=>row.name===scenario.name).length;
await appendFile(${JSON.stringify(callsPath)},JSON.stringify({name:scenario.name,index,prompt,args,schema})+'\\n');
if(scenario.hold){await writeFile(${JSON.stringify(join(directory, 'model-held'))},'yes');
 while(!await readFile(${JSON.stringify(join(directory, 'model-release'))},'utf8').catch(()=>false))await new Promise(r=>setTimeout(r,20));}
if(scenario.failAt===index){console.error('PRIVATE_FOLLOWUP_SECRET');process.exit(2);}
let answer=scenario.decisions?.[Math.min(index,scenario.decisions.length-1)]||scenario.reply||'正常回复。';
if(!schema&&typeof answer==='object')answer=answer.reply;
if(schema?.properties.contactBoundary&&!schema?.properties.action)answer={reply:typeof answer==='string'?answer:answer.reply,contextMore:false,contactBoundary:{kind:'none',quote:''},browseIntent:null};
if(schema?.properties.sourceRefs){
 const motive=prompt.match(/"motiveRef":"([^"]+)"/)[1],relation=prompt.match(/"kind":"relationship","ref":"([^"]+)"/)[1];
 answer=index===0?{action:'lookup',reply:null,sourceRefs:[],lookup:{topicIds:['public:python'],freshness:'current',sourceUrl:null}}
  :{action:'reply',reply:'PROACTIVE_WITH_EVIDENCE',sourceRefs:[motive,relation],lookup:null};
}
const text=typeof answer==='string'?answer:JSON.stringify(answer);
if(args.includes('-o'))await writeFile(args[args.indexOf('-o')+1],text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:0,output_tokens:20}}));`);
  await writeFile(join(directory, 'data', 'windows.local.json'), JSON.stringify({
    qqEnabled: false, ownerUserIds: ['123456'], oneBotSecret: 'isolated-secret', oneBotApiBase: 'http://127.0.0.1:1',
    oneBotAccessToken: 'isolated-token', remoteEnabled: false, webLookup, privateLearning:{enabled:false},
    runtimeBudget: { enabled: false }, mood: { enabled: true },
    world:{enabled:true},
    life: { enabled: life, tickIntervalMs: 250, planning: { enabled: true }, browsingIntents: { enabled: false } },
    pwa: { enabled: true, origin, port: apiPort, pushEnabled: false }
  }));
  await mkdir(join(directory,'data/life'),{recursive:true});
  await writeFile(join(directory,'data/life/planner.json'),JSON.stringify({version:1,nextAt:at+86400000,days:{},attempt:null}));
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
  // Only the copied external provider is replaced. All service validation,
  // private caches, C PWA core and strict model-process runner are unchanged.
  await cp(join(directory,'src/chat-retrieval.js'),join(directory,'src/chat-retrieval-real.js'));
  await writeFile(join(directory,'src/chat-retrieval.js'), `
export * from './chat-retrieval-real.js';
import {createChatRetrieval as realCreate} from './chat-retrieval-real.js';
import {readFile,appendFile} from 'node:fs/promises';
export function createPublicTopicCatalog(){return {peekTopics:()=>null,getTopics:async()=>null,close:async()=>{},getStatus:()=>({})};}
export function createChatRetrieval(options={}){return realCreate({...options,adapter:async(payload,{signal})=>{
 await appendFile(${JSON.stringify(lookupPath)},JSON.stringify({payload})+'\\n');
 const state=JSON.parse(await readFile(${JSON.stringify(adapterPath)},'utf8'));
 if(state.hold)await new Promise((resolve,reject)=>{
   const abort=()=>{appendFile(${JSON.stringify(lookupPath)},JSON.stringify({cancelled:true})+'\\n').then(()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})));};
   if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
 });
 if(state.fail)throw Error('PRIVATE_PROVIDER_SECRET');
 return {status:state.status||'ok',metrics:{requests:2,searchRequests:1,pageRequests:1,feedRequests:0,dnsResolutions:2,redirects:0,bytes:320,durationMs:137,timedOut:false,providerFee:null},sources:state.status&&state.status!=='ok'?[]:[{provider:'xiaohongshu-notes',url:'https://www.xiaohongshu.com/explore/67efab001234567890abcdef',title:'Python source',text:'PUBLIC_RETRIEVAL_FACT: An actual synthetic boundary source.',capture:'page_excerpt',sourceVersion:'fixture-v1'}]};
}});}
`);
  async function start() {
    child = spawn(process.execPath, ['--import', pathToFileURL(join(directory, 'clock.mjs')).href, 'src/server.js'], {
      cwd: directory, windowsHide: true, env: { ...process.env, PORT: String(adminPort), CODEX_CLI_PATH: cli,
        CODEX_REMOTE_CONTACT_WEB_LOOKUP: webLookup ? '1' : '0', HOME: directory, CODEX_HOME: join(directory, 'codex-home') } });
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
  const lookups = async () => (await readFile(lookupPath,'utf8').catch(()=>'')).split('\n').filter(Boolean).map(JSON.parse);
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
  return { directory, database, accounts, request, send, messages, outbound, memory, calls, lookups, png, stop, start,
    maintenance: () => rawRequest(`http://127.0.0.1:${adminPort}/api/maintenance`),
    adapter: value => writeFile(adapterPath,JSON.stringify(value)),
    config: async value => {
      const path = join(directory, 'data', 'windows.local.json');
      const current = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...current, pwa: { ...current.pwa, ...value } }));
    },
    scenario: value => writeFile(scenarioPath, JSON.stringify(value)),
    advance: value => writeFile(clockPath, JSON.stringify({ now: value })), at, logs: () => logs };
}

