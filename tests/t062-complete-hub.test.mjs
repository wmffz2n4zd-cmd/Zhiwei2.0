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
import { DatabaseSync } from 'node:sqlite';

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
  const directory = await mkdtemp(join(parent, 't062-complete-hub-'));
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
    const invitation = database.createInvitation({ role, memoryScope: username === 'alice' ? 'qq:private:123456' : 'qq:private:654321' });
    const account = await auth.claim({ token: invitation.token, username, displayName: username,
      password: 'a-good-test-password', deviceName: 'synthetic' });
    database.verifyBinding(account.user.userId);
    accounts.push({...account,identity:database.getIdentity(account.user.userId)});
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

const history = (q = 'RIVER_ORIGINAL') => reply(`[[pwa_history:${JSON.stringify({q,speaker:'all'})}]]`);
async function seedLegacy(f) {
  const memory = createUnifiedMemory({memoryPath:join(f.directory,'data','unified-memory.json'),now:()=>Date.UTC(2026,9,1)});
  await memory.writeExchange({scope:'qq:private:123456',senderLabel:'alice',userText:'海边约定 RIVER_ORIGINAL',replyText:'我记得是周六。',messageId:'old-in',sentMessageIds:['old-out']});
  await memory.writeExchange({scope:'qq:private:654321',senderLabel:'bravo',userText:'RIVER_ORIGINAL BRAVO_SECRET',replyText:'这是乙的资料。',messageId:'other-in',sentMessageIds:['other-out']});
  return memory;
}
const scenarioCalls = async (f,name) => (await f.calls()).filter(row => row.name === name);

test('A+B+D ordinary raw history stays in controlled reply cycle with current capabilities and account isolation', {timeout:45000}, async t => {
  const f=await fixture(t,{life:false}),[alice]=f.accounts; await seedLegacy(f);
  await f.scenario({name:'history',decisions:[history(),reply('HISTORY_FINAL')]});
  await f.send(alice,'history','找一下以前海边约定的原话');
  await until(()=>f.outbound(alice).length===1,'history final');
  const calls=await scenarioCalls(f,'history'); assert.equal(calls.length,2);
  assert.match(calls[1].prompt,/当前账号聊天原文查询结果/); assert.match(calls[1].prompt,/海边约定 RIVER_ORIGINAL/);
  assert.doesNotMatch(calls[1].prompt,/BRAVO_SECRET/);
  assert.match(calls[0].prompt,/按关键词、日期和说话方查询/); assert.match(calls[0].prompt,/选择、收藏和发送表情图片/);
  assert.match(calls[0].prompt,/本轮可以按需申请聊天联网查询/); assert.doesNotMatch(calls[0].prompt,/仍待补完|本轮内置联网搜索可用/);
  assert.ok(calls.every(call=>call.args.includes('web_search="disabled"')));
  assert.deepEqual(await f.lookups(),[]); assert.equal(f.outbound(alice)[0].text,'HISTORY_FINAL');
  assert.equal(f.messages(alice).some(row=>row.text.includes('[[pwa_history:')),false);
});

for (const order of ['history-first','lookup-first']) test(`B+D ${order} preserves both evidence sets within three generations and one request each`, {timeout:45000}, async t => {
  const f=await fixture(t),[alice]=f.accounts; await seedLegacy(f);
  const decisions=order==='history-first'?[history(),lookup(),reply('COMBINED_FINAL')]:[lookup(),history(),reply('COMBINED_FINAL')];
  await f.scenario({name:order,decisions}); await f.send(alice,order,'Python 查一下，也找找以前海边约定的原话');
  await until(()=>f.outbound(alice).length===1,'combined final');
  const calls=await scenarioCalls(f,order); assert.equal(calls.length,3);
  assert.match(calls[2].prompt,/当前账号聊天原文查询结果/); assert.match(calls[2].prompt,/海边约定 RIVER_ORIGINAL/);
  assert.match(calls[2].prompt,/PUBLIC_RETRIEVAL_FACT/); assert.doesNotMatch(calls[2].prompt,/BRAVO_SECRET/);
  assert.match(calls[2].prompt,/本轮不能再查聊天原文/); assert.match(calls[2].prompt,/本轮不能再请求memory_more/);
  assert.equal((await f.lookups()).length,1); assert.equal(f.outbound(alice)[0].text,'COMBINED_FINAL');
  assert.equal(f.messages(alice).some(row=>row.text.includes('[[pwa_history:')),false);
});

test('B+D busy old reference and raw search survive restart without extra delivery', {timeout:60000}, async t => {
  const f=await fixture(t,{busy:true}),[alice]=f.accounts; await seedLegacy(f);
  const found=await f.request(alice,'/api/pwa/history/search?q=RIVER_ORIGINAL'); assert.equal(found.status,200);
  await f.send(alice,'busy-history','找一下这句原话',{replyTo:found.body.records[0].id});
  await until(()=>f.outbound(alice).length===1,'busy status');
  await until(()=>f.database.listPendingInbox({limit:100}).length===0,'busy durable input');
  assert.equal((await f.calls()).length,0);
  await f.scenario({name:'busy-history',decisions:[history(),reply('BUSY_HISTORY_FINAL')]});
  await f.stop(); await f.advance(f.at+62000); await f.start();
  await until(()=>f.outbound(alice).length===2,'busy history final',30000);
  const calls=await scenarioCalls(f,'busy-history'); assert.equal(calls.length,2);
  assert.match(calls[0].prompt,/旧QQ留存原文/); assert.match(calls[1].prompt,/当前账号聊天原文查询结果/);
  assert.match(calls[1].prompt,/海边约定 RIVER_ORIGINAL/); assert.doesNotMatch(calls[1].prompt,/BRAVO_SECRET/);
  assert.equal(f.outbound(alice)[1].text,'BUSY_HISTORY_FINAL'); assert.deepEqual(await f.lookups(),[]);
  await until(()=>!f.database.hasPendingProjection(alice.identity.memoryScope),'busy projection');
  await f.stop(); await f.start(); assert.equal(f.outbound(alice).length,2);
});

test('B+D new input cancels HTTP after raw history lookup and never publishes old mixed draft', {timeout:60000}, async t => {
  const f=await fixture(t),[alice]=f.accounts; await seedLegacy(f);
  await f.adapter({hold:true}); await f.scenario({name:'old-mixed',decisions:[history(),lookup(),reply('STALE_MIXED_DRAFT')]});
  await f.send(alice,'old-mixed','Python 和以前海边约定的原话');
  await until(async()=>(await f.lookups()).length===1,'mixed lookup held');
  await f.adapter({}); await f.scenario({name:'new-mixed',decisions:[reply('NEW_INPUT_FINAL')]});
  await f.send(alice,'new-mixed','先别查了，换个话题');
  await until(()=>f.outbound(alice).length===1,'new combined input final',30000);
  assert.equal(f.outbound(alice)[0].text,'NEW_INPUT_FINAL'); assert.ok((await f.lookups()).some(row=>row.cancelled));
  assert.equal((await scenarioCalls(f,'old-mixed')).length,2);
  assert.doesNotMatch(JSON.stringify(await f.memory()),/STALE_MIXED_DRAFT/);
});

test('B+D source correction at final publish gate rejects draft even when lookup evidence and epoch remain current', {timeout:60000}, async t => {
  const f=await fixture(t,{holdPublish:true}),[alice]=f.accounts;
  await f.scenario({name:'seed',decisions:[reply('SEED_REPLY')]});
  const seeded=await f.send(alice,'seed','PWA_SOURCE_ORIGINAL'); await until(()=>f.outbound(alice).length===1,'seed delivered');
  await until(()=>!f.database.hasPendingProjection(alice.identity.memoryScope),'seed projection');
  await f.scenario({name:'correction',decisions:[history('PWA_SOURCE_ORIGINAL'),lookup(),reply('STALE_SOURCE_DRAFT')]});
  const accepted=await f.send(alice,'correction','Python 结合之前的原话');
  await until(()=>readFile(join(f.directory,'publish-held'),'utf8').catch(()=>false),'final mixed gate held');
  const identity=f.database.getIdentity(alice.user.userId);
  const db=new DatabaseSync(f.database.path); db.prepare('UPDATE messages SET text=? WHERE id=?').run('SOURCE_CORRECTED',seeded.body.message.id); db.close();
  assert.deepEqual(f.database.getIdentity(alice.user.userId),identity,'correction does not fake an epoch/identity invalidation');
  await writeFile(join(f.directory,'publish-release'),'release');
  await until(()=>f.database.listPendingInbox({limit:100}).length===0,'corrected source input settled');
  assert.equal(f.outbound(alice).some(row=>row.text.includes('STALE_SOURCE_DRAFT')),false);
  assert.doesNotMatch(JSON.stringify(await f.memory()),/STALE_SOURCE_DRAFT/);
  assert.equal((await f.lookups()).length,1); assert.equal((await scenarioCalls(f,'correction')).length,3);
});

test('B+D repeated or mixed history controls cannot leak or allocate another lookup', {timeout:45000}, async t => {
  const f=await fixture(t),[alice]=f.accounts; await seedLegacy(f);
  await f.scenario({name:'repeat-history',decisions:[history(),history()]});
  await f.send(alice,'repeat-history','找以前的原话'); await until(()=>f.outbound(alice).length===1,'bounded history outcome');
  assert.equal((await scenarioCalls(f,'repeat-history')).length,2);
  assert.doesNotMatch(f.outbound(alice)[0].text,/pwa_history|RIVER_ORIGINAL/); assert.deepEqual(await f.lookups(),[]);
  await f.scenario({name:'mixed-history',decisions:[{...history(),browseIntent:{delayMinutes:0}}]});
  await f.send(alice,'mixed-history','再找一下原话'); await until(()=>f.outbound(alice).length===2,'invalid mixed action outcome');
  assert.doesNotMatch(f.outbound(alice)[1].text,/pwa_history/); assert.equal((await scenarioCalls(f,'mixed-history')).length,1);
});

