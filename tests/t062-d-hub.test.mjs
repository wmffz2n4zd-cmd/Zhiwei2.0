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
async function fixture(t, { busy = false, webLookup = true, life = true, holdPublish = false } = {}) {
  const parent = join(root, 'runtime', 'tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 't062-d-hub-'));
  const apiPort = await port(), adminPort = await port(), origin = 'https://pwa.test';
  const base = `http://127.0.0.1:${apiPort}`, clockPath = join(directory, 'clock.json');
  const scenarioPath = join(directory, 'scenario.json'), callsPath = join(directory, 'calls.jsonl');
  const lookupPath = join(directory, 'lookup.jsonl'), adapterPath = join(directory, 'adapter.json');
  const databasePath = join(directory, 'data', 'pwa', 'pwa.sqlite');
  const at = Date.UTC(2026, 10, 17, 10, 0);
  let child, logs = '', database;
  await cp(join(root, 'src'), join(directory, 'src'), { recursive: true });
  if (holdPublish) {
    const path=join(directory,'src/server.js'),source=await readFile(path,'utf8');
    const marker='\n  const evidenceFailure = await privateEvidenceFailure(event);';
    assert.equal(source.split(marker).length,2,'Bind delay seam to the final actual PWA publish gate');
    await writeFile(path,source.replace(marker,`\n  if(event.chatEvidenceValidity){
      await writeFile(${JSON.stringify(join(directory,'publish-held'))},'held');
      while(!await readFile(${JSON.stringify(join(directory,'publish-release'))},'utf8').catch(()=>false))await sleep(10);
    }\n`+marker));
  }
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
if(scenario.hold||scenario.holdAt===index){await writeFile(${JSON.stringify(join(directory, 'model-held'))},'yes');
 while(!await readFile(${JSON.stringify(join(directory, 'model-release'))},'utf8').catch(()=>false))await new Promise(r=>setTimeout(r,20));}
if(scenario.failAt===index){console.error('PRIVATE_FOLLOWUP_SECRET');process.exit(2);}
let answer=scenario.decisions?.[Math.min(index,scenario.decisions.length-1)]||scenario.reply||'正常回复。';
if(!schema&&typeof answer==='object')answer=answer.reply;
if(schema?.properties.contactBoundary&&!schema?.properties.action)answer={reply:typeof answer==='string'?answer:answer.reply,contextMore:false,contactBoundary:{kind:'none',quote:''},browseIntent:null};
const text=typeof answer==='string'?answer:JSON.stringify(answer);
if(args.includes('-o'))await writeFile(args[args.indexOf('-o')+1],text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:0,output_tokens:20}}));`);
  await writeFile(join(directory, 'data', 'windows.local.json'), JSON.stringify({
    qqEnabled: false, ownerUserIds: ['123456'], oneBotSecret: 'isolated-secret', oneBotApiBase: 'http://127.0.0.1:1',
    oneBotAccessToken: 'isolated-token', remoteEnabled: false, webLookup, privateLearning:{enabled:false},
    runtimeBudget: { enabled: false }, mood: { enabled: true },
    life: { enabled: life, tickIntervalMs: 250, planning: { enabled: false }, browsingIntents: { enabled: false } },
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
    await writeFile(join(directory, 'publish-release'), 'release').catch(() => {});
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

test('D-on irrelevant recent/sleep smalltalk is one model call with empty tools, no query, life-off works', {timeout:30000}, async t => {
  const f=await fixture(t,{life:false}),[alice]=f.accounts;
  await f.send(alice,'direct','我最近睡不太好，想说说话。');
  await until(()=>f.outbound(alice).length===1,'direct reply');
  const calls=await f.calls(); assert.equal(calls.length,1); assert.equal(f.outbound(alice)[0].text,'DIRECT_REPLY');
  assert.deepEqual(await f.lookups(),[]); assert.ok(calls[0].schema.required.includes('action'));
  for(const flag of ['web_search="disabled"','features.shell_tool=false','features.view_image=false',
    'tools.experimental_request_user_input.enabled=false','mcp_servers={}']) assert.ok(calls[0].args.includes(flag),flag);
});

test('D-off preserves original reply shape/CLI without a retrieval envelope or new restriction', {timeout:30000}, async t => {
  const f=await fixture(t,{webLookup:false}),[alice]=f.accounts;
  await f.send(alice,'off','Python 最近如何'); await until(()=>f.outbound(alice).length===1,'off reply');
  const [call]=await f.calls();assert.equal(call.schema.required.includes('action'),false);
  assert.equal(call.args.includes('features.shell_tool=false'),false); assert.deepEqual(await f.lookups(),[]);
});

test('D-on lookup publishes only final text and caches per object across restart', {timeout:60000}, async t => {
  const f=await fixture(t),[alice,bravo]=f.accounts;
  await f.scenario({name:'lookup',decisions:[lookup(),reply('FINAL_EVIDENCE')]});
  await f.send(alice,'one','Python PRIVATE_SENTINEL_9284，这是我家的秘密。');
  await until(()=>f.outbound(alice).length===1,'lookup reply');
  let calls=await f.calls();assert.equal(calls.length,2); assert.equal(f.outbound(alice)[0].text,'FINAL_EVIDENCE');
  assert.match(calls[1].prompt,/PUBLIC_RETRIEVAL_FACT/);
  assert.doesNotMatch(JSON.stringify(await f.lookups()),/PRIVATE_SENTINEL|秘密|alice|qq:private|web:private/);
  assert.deepEqual((await f.lookups())[0].payload,{query:'Python programming language',freshness:'current'});
  const maintenance=await f.maintenance();assert.equal(maintenance.status,200);
  assert.equal(maintenance.body.webLookup.lastDurationMs,137,'Expose the actual nested HTTP duration');
  await until(()=>f.database.listPendingProjections({limit:100}).length===0,'projection');
  await f.stop();await f.start();
  await f.scenario({name:'cached',decisions:[lookup(),reply('CACHED_REPLY')]});
  await f.send(alice,'two','Python 再说一点');await until(()=>f.outbound(alice).length===2,'cached reply');
  assert.equal((await f.lookups()).length,1,'same object persisted current evidence');
  await f.scenario({name:'other',decisions:[lookup(),reply('OTHER_REPLY')]});
  await f.send(bravo,'three','Python 怎么样');await until(()=>f.outbound(bravo).length===1,'other object reply');
  assert.equal((await f.lookups()).length,2);
  assert.doesNotMatch((await f.calls()).at(-1).prompt,/PRIVATE_SENTINEL/);
  await until(async()=> (await f.memory()).entries.filter(e=>e.exchange).length===3,'exact exchanges');
});

test('D busy messages remain one merged reply with one lookup after normal busy notice', {timeout:45000}, async t => {
  const f=await fixture(t,{busy:true}),[alice]=f.accounts;
  await f.send(alice,'busy-one','Python 第一条');await until(()=>f.outbound(alice).length===1,'busy notice');
  assert.match(f.outbound(alice)[0].text,/^\*/);
  await f.send(alice,'busy-two','还有第二条');
  await until(()=>f.database.listPendingInbox({limit:100}).length===0,'busy inputs accepted');
  assert.equal((await f.calls()).length,0);
  await f.scenario({name:'busy',decisions:[lookup(),reply('MERGED_LOOKUP_REPLY')]});
  await f.advance(f.at+62000);await until(()=>f.outbound(alice).length===2,'merged lookup reply',30000);
  const calls=await f.calls();assert.equal(calls.length,2);assert.match(calls[0].prompt,/Python 第一条/);assert.match(calls[0].prompt,/还有第二条/);
  assert.match(calls[1].prompt,/PUBLIC_RETRIEVAL_FACT/);assert.equal((await f.lookups()).length,1);
  assert.equal(f.outbound(alice)[1].text,'MERGED_LOOKUP_REPLY');
});

test('new PWA input aborts in-flight HTTP and discards old evidence/draft', {timeout:45000}, async t => {
  const f=await fixture(t),[alice]=f.accounts;
  await f.adapter({hold:true});await f.scenario({name:'old',decisions:[lookup(),reply('STALE_NOT_SENT')]});
  await f.send(alice,'old','Python FIRST_INPUT');await until(async()=>(await f.lookups()).length===1,'HTTP held');
  await f.adapter({});await f.scenario({name:'new',decisions:[reply('MERGED_NEW_REPLY')]});
  await f.send(alice,'new','SECOND_INPUT 换个话题');
  await until(()=>f.outbound(alice).length===1,'new reply',30000);
  assert.equal(f.outbound(alice)[0].text,'MERGED_NEW_REPLY');assert.ok((await f.lookups()).some(row=>row.cancelled));
  const calls=await f.calls();assert.equal(calls.length,2);assert.match(calls[1].prompt,/FIRST_INPUT/);assert.match(calls[1].prompt,/SECOND_INPUT/);
  assert.doesNotMatch(calls[1].prompt,/PUBLIC_RETRIEVAL_FACT/);
  const saved=await until(async()=>{const m=await f.memory();return m.entries.some(e=>e.exchange)&&m;},'new memory');
  assert.equal(saved.entries.filter(e=>e.exchange).length,1);assert.doesNotMatch(JSON.stringify(saved),/STALE_NOT_SENT/);
});

test('provider restriction/failure is explicit evidence and never leaks provider errors', {timeout:45000}, async t => {
  const f=await fixture(t),[alice]=f.accounts;
  await f.adapter({fail:true});await f.scenario({name:'failed',decisions:[lookup(),reply('这次没查到。')]});
  await f.send(alice,'failed','Python 帮我核一下');await until(()=>f.outbound(alice).length===1,'failure reply');
  const calls=await f.calls();assert.equal(calls.length,2);assert.match(calls[1].prompt,/外部资料结果：这次查询失败，不能冒称已核实/);
  assert.doesNotMatch(calls[1].prompt,/PRIVATE_PROVIDER_SECRET/);assert.equal(f.outbound(alice)[0].text,'这次没查到。');
  await f.adapter({status:'restricted'});await f.scenario({name:'restricted',decisions:[lookup('latest'),reply('页面访问受限。')]});
  await f.send(alice,'restricted','Python 查最新');await until(()=>f.outbound(alice).length===2,'restricted reply');
  assert.match((await f.calls()).at(-1).prompt,/外部资料结果：资料受访问限制/);
});

test('malformed lookup draft cannot be published or learned and repeated lookup is bounded', {timeout:45000}, async t => {
  const f=await fixture(t),[alice]=f.accounts;
  await f.scenario({name:'bad',decisions:[{...lookup(),reply:'UNSENT_ACTION_DRAFT'}]});
  await f.send(alice,'bad','Python');await until(()=>f.outbound(alice).length===1,'safe clarification');
  assert.doesNotMatch(f.outbound(alice)[0].text,/UNSENT_ACTION_DRAFT/);assert.deepEqual(await f.lookups(),[]);
  await f.scenario({name:'repeat',decisions:[lookup(),lookup()]});await f.send(alice,'repeat','Python 再看看');
  await until(()=>f.outbound(alice).length===2,'bounded repeat');assert.equal((await f.lookups()).length,1);
  assert.equal((await f.calls()).filter(row=>row.name==='repeat').length,2);
  assert.doesNotMatch(JSON.stringify(await f.memory()),/UNSENT_ACTION_DRAFT/);
});

test('ordinary D-on uses actual current image/quote scope and preserves sticker delivery', {timeout:45000}, async t => {
  const f=await fixture(t),[alice,bravo]=f.accounts;
  const media=await f.request(alice,'/api/pwa/media',{method:'POST',bytes:f.png,mime:'image/png'});assert.equal(media.status,201);
  await f.scenario({name:'vision',decisions:[reply('看到了。\n[[qq_sticker:笑.png]]')]});
  await f.send(alice,'image','看图',{mediaIds:[media.body.media.id]});await until(()=>f.outbound(alice).length===2,'text and sticker');
  assert.ok((await f.calls())[0].args.includes('--image'));
  const sticker=f.outbound(alice).find(m=>m.type==='image');assert.ok(sticker);
  assert.equal((await f.request(bravo,'/api/pwa/media/'+sticker.mediaIds[0])).status,404);
  await f.scenario({name:'quote',decisions:[reply('引用图还在。')]});
  const original=f.messages(alice).find(m=>m.clientMessageId==='image');
  await f.send(alice,'quote','刚才那张',{replyTo:original.id});await until(()=>f.outbound(alice).length===3,'quoted image');
  assert.ok((await f.calls()).at(-1).args.includes('--image'));
});

test('shutdown drains cancelled HTTP and durable accepted input resumes once', {timeout:45000}, async t => {
  const f=await fixture(t),[alice]=f.accounts;
  await f.adapter({hold:true});await f.scenario({name:'shutdown',decisions:[lookup(),reply('OLD_NOT_SENT')]});
  await f.send(alice,'pending','Python 请求中');await until(async()=>(await f.lookups()).length===1,'held HTTP');
  await f.stop();assert.equal(f.outbound(alice).length,0);assert.ok((await f.lookups()).some(row=>row.cancelled));
  await f.adapter({});await f.scenario({name:'recovered',decisions:[reply('RECOVERED_REPLY')]});await f.start();
  await until(()=>f.outbound(alice).length===1,'recovered reply',30000);
  assert.equal(f.outbound(alice)[0].text,'RECOVERED_REPLY');
  await until(()=>f.database.listPendingProjections({limit:100}).length===0,'projection');
  await f.stop();await f.start();assert.equal(f.outbound(alice).length,1);
});

test('evidence expiring while final model waits aborts draft and settles input with one safe non-learning reply', {timeout:45000}, async t=>{
  const f=await fixture(t),[alice]=f.accounts;
  await f.scenario({name:'ttl-model',decisions:[lookup(),reply('STALE_MODEL_FACT')],holdAt:1});
  const accepted=await f.send(alice,'ttl-model','Python 查一下');
  await until(()=>readFile(join(f.directory,'model-held'),'utf8').catch(()=>false),'final model held');
  await f.advance(f.at+15*60000+1);
  await until(()=>f.outbound(alice).length===1,'expiry response',30000);
  assert.match(f.outbound(alice)[0].text,/资料已经过时/);assert.doesNotMatch(f.outbound(alice)[0].text,/STALE_MODEL_FACT/);
  assert.equal((await f.lookups()).length,1);assert.equal((await f.calls()).length,2);
  await until(()=>f.database.getInbox(accepted.body.message.id).state==='complete'&&!f.database.hasPendingProjection(alice.identity.memoryScope),'input settled');
  assert.equal((await f.memory()).entries.filter(e=>e.exchange).length,0);
});

test('expiry at final PWA publish gate replaces entire unsent draft once and does not store stale exchange', {timeout:45000}, async t=>{
  const f=await fixture(t,{holdPublish:true}),[alice]=f.accounts;
  await f.scenario({name:'ttl-send',decisions:[lookup(),reply('STALE_SEND_FACT\n\nSTALE_SECOND_PART')]});
  const accepted=await f.send(alice,'ttl-send','Python 查一下');
  await until(()=>readFile(join(f.directory,'publish-held'),'utf8').catch(()=>false),'final publish gate');
  await f.advance(f.at+15*60000+1);await writeFile(join(f.directory,'publish-release'),'release');
  await until(()=>f.outbound(alice).length===1,'single expiry fallback');
  assert.match(f.outbound(alice)[0].text,/资料已经过时/);assert.doesNotMatch(f.outbound(alice)[0].text,/STALE_/);
  await until(()=>f.database.getInbox(accepted.body.message.id).state==='complete'&&!f.database.hasPendingProjection(alice.identity.memoryScope),'fallback settled');
  assert.equal((await f.memory()).entries.filter(e=>e.exchange).length,0);
  assert.equal((await f.lookups()).length,1);assert.equal((await f.calls()).length,2);
});

