import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
async function fixture(t, { busy = false, webLookup = false, life = true, holdPublish = false, videoPlatforms } = {}) {
  const parent = join(root, 'runtime', 'tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 't062-video-hub-'));
  const apiPort = await port(), adminPort = await port(), origin = 'https://pwa.test';
  const base = `http://127.0.0.1:${apiPort}`, clockPath = join(directory, 'clock.json');
  const scenarioPath = join(directory, 'scenario.json'), callsPath = join(directory, 'calls.jsonl');
  const videoPath = join(directory, 'video.jsonl');
  const lookupPath = join(directory, 'lookup.jsonl'), adapterPath = join(directory, 'adapter.json');
  const databasePath = join(directory, 'data', 'pwa', 'pwa.sqlite');
  const at = Date.UTC(2026, 10, 17, 10, 0);
  let child, logs = '', database;
  await cp(join(root, 'src'), join(directory, 'src'), { recursive: true });
  if (holdPublish) {
    const path=join(directory,'src/server.js'),source=await readFile(path,'utf8');
    const marker='\n  const evidenceFailure = await privateEvidenceFailure(event);';
    assert.equal(source.split(marker).length,2,'Bind delay seam to the final actual PWA publish gate');
    await writeFile(path,source.replace(marker,`\n  if(event.chatEvidenceValidity || event.videoEvidenceValidity){
      await writeFile(${JSON.stringify(join(directory,'publish-held'))},'held');
      while(!await readFile(${JSON.stringify(join(directory,'publish-release'))},'utf8').catch(()=>false))await sleep(10);
    }\n`+marker));
  }
  await cp(join(root, 'modules'), join(directory, 'modules'), { recursive: true });
  await mkdir(join(directory, 'scripts'), {recursive:true});
  await cp(join(root,'scripts/video-worker.py'),join(directory,'scripts/video-worker.py'));
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
await appendFile(${JSON.stringify(callsPath)},JSON.stringify({name:scenario.name,index,prompt,args,schema,images:await Promise.all(args.flatMap((x,i)=>x==='--image'?[args[i+1]]:[]).map(async p=>({bytes:(await readFile(p)).length})))})+'\\n');
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
    video:{enabled:true,platforms:videoPlatforms,dependencyRoot:videoPlatforms ? undefined : directory,nodePath:process.execPath,sessionBrowser:{executablePath:'/synthetic-chrome',platforms:videoPlatforms || ['youtube']}},
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
 const source=payload.url ? {provider:'anonymous-direct-page',url:payload.url,requestedUrl:payload.url,title:'Shared public page'}
   : {provider:'xiaohongshu-notes',url:'https://www.xiaohongshu.com/explore/67efab001234567890abcdef',title:'Public note'};
 const status=state.status || (payload.url ? 'partial' : 'ok');
 return {status,metrics:{requests:payload.url?1:0,searchRequests:payload.url?0:1,pageRequests:1,feedRequests:0,dnsResolutions:payload.url?1:0,redirects:0,bytes:320,durationMs:137,timedOut:false,providerFee:null},
   sources:['ok','partial'].includes(status)?[{...source,text:'PUBLIC_RETRIEVAL_FACT: An actual synthetic boundary source.',capture:'page_excerpt',sourceVersion:'fixture-v1'}]:[]};
}});}
`);
  await cp(join(directory,'src/video-reader.js'),join(directory,'src/video-reader-real.js'));
  const videoJpg=await sharp({create:{width:16,height:16,channels:3,background:'#2255ff'}}).jpeg().toBuffer();
  await writeFile(join(directory,'src/video-reader.js'), `export * from './video-reader-real.js';
import {canonicalVideoUrl} from './video-reader-real.js';
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
function requireConfiguredBrowser(options){
 const browser=options?.sessionBrowser;
 if(browser?.executablePath!=='/synthetic-chrome' || browser.platforms?.length!==1 || browser.platforms[0]!==${JSON.stringify(videoPlatforms?.[0] || 'youtube')})throw Error('video config contract');
}
export async function probeVideoDependencies(options){requireConfiguredBrowser(options);return {ready:true,versions:{fixture:'synthetic'}};}
export function createVideoWorker(options){requireConfiguredBrowser(options);return async({url,outputDir,mode,signal,atSeconds})=>{
 await appendFile(${JSON.stringify(videoPath)},JSON.stringify({url,mode,atSeconds})+'\\n');
 const state=JSON.parse(await readFile(${JSON.stringify(adapterPath)},'utf8'));
 if(state.hold)await new Promise((resolve,reject)=>{
  const abort=()=>{appendFile(${JSON.stringify(videoPath)},JSON.stringify({cancelled:true})+'\\n').then(()=>reject(Object.assign(Error('cancelled'),{code:'REPLY_SUPERSEDED'})))};
  if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
 });
 if(state.restricted)return {version:1,status:'restricted',errors:['source_restricted'],subtitles:[],frames:[]};
 const data=Buffer.from(${JSON.stringify(videoJpg.toString('base64'))},'base64');
 await writeFile(outputDir+'/frame-0.jpg',data);
 return {version:1,status:mode==='probe'?'available':'ok',source:canonicalVideoUrl(url),title:'Synthetic public video',duration:10,metadataVersion:'a'.repeat(64),subtitleTrack:{kind:'human',language:'en'},subtitles:mode==='probe'?[]:[{start:0,end:2,text:'VIDEO_CUE_BLUE_OBJECT'}],frames:mode==='probe'?[]:[{file:'frame-0.jpg',timestamp:atSeconds??1,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}],errors:[]};
};}
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
  const videos = async () => (await readFile(videoPath,'utf8').catch(()=>'')).split('\n').filter(Boolean).map(JSON.parse);
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
  return { directory, database, accounts, request, send, messages, outbound, memory, calls, lookups, videos, png, stop, start,
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

const videoUrl='https://www.youtube.com/watch?v=jNQXAC9IVRw';
test('Bilibili-only Hub enforces current, quoted and implicit source policy with public lookup enabled', {timeout:90000}, async t => {
  const f = await fixture(t, { webLookup: true, videoPlatforms: ['bilibili'] });
  const [alice] = f.accounts;
  const bilibili = 'https://www.bilibili.com/video/BV1K54y1r7dU';
  const youtube = 'https://youtu.be/jNQXAC9IVRw';
  let replies = 0;
  async function send(id, text, extra) {
    const response = await f.send(alice, id, text, extra);
    assert.ok(response.status < 300);
    replies++;
    await until(() => f.outbound(alice).length === replies, id);
    return (await f.calls()).at(-1);
  }
  const first = await send('mixed', youtube + ' ' + bilibili);
  assert.equal(first.images.length, 1);
  assert.match(first.prompt, /已核验引用的B站常规视频/);
  assert.match(first.prompt, /读取所分享的公开网页：youtu\.be/);
  assert.match(first.prompt, /读取所分享的公开网页：www\.bilibili\.com/);
  assert.equal((await f.videos())[0].url, bilibili);

  const disabled = await send('paused', youtube + ' https://example.org/article');
  assert.match(disabled.prompt, /该视频平台目前未启用取材/);
  assert.match(disabled.prompt, /不能据链接、网页文字或其他视频的材料声称看过/);
  assert.match(disabled.prompt, /读取所分享的公开网页：example\.org/);
  assert.equal(disabled.images.length, 0);
  const original = f.messages(alice).find(row => row.text.startsWith(youtube + ' https://example.org'));
  const follow = await send('paused-follow', '刚才视频00:08那里是什么');
  const quote = await send('paused-quote', '请读引用视频的字幕', {replyTo:original.id});
  for (const call of [follow, quote]) {
    assert.match(call.prompt, /该视频平台目前未启用取材/);
    assert.equal(call.images.length, 0);
  }
  assert.equal((await f.videos()).length, 1);
  const restored = await send('enabled', bilibili + ' 看看换的这个视频');
  assert.equal(restored.images.length, 1);
  const timed = await send('enabled-follow', '刚才视频00:08那里是什么');
  assert.equal(timed.images.length, 1);
  assert.equal((await f.videos()).at(-1).atSeconds, 8);
  assert.ok((await f.videos()).every(item => item.url === bilibili));
  assert.deepEqual((await f.maintenance()).body.video.platforms, ['bilibili']);
  assert.deepEqual(await f.lookups(), []);

  const topicId = 'public:url:' + createHash('sha256').update(youtube).digest('hex').slice(0, 24);
  await f.scenario({ name: 'explicit-page', decisions: [
    { ...reply(''), action: 'lookup', lookup: { topicIds:[topicId], freshness:'current', sourceUrl:null } },
    reply('这段是网页文字。')
  ] });
  const page = await send('explicit-page', youtube + ' 请查这个网页的文字说明');
  assert.equal(page.images.length, 0);
  assert.match(page.prompt, /PUBLIC_RETRIEVAL_FACT/);
  assert.match(page.prompt, /anonymous-direct-page/);
  assert.match(page.prompt, /该视频平台目前未启用取材/);
  assert.deepEqual((await f.lookups()).map(call => call.payload.url), [youtube]);
  assert.ok((await f.videos()).every(item => item.url === bilibili));
});

test('video Hub supplies real frame bytes and timestamp cues to CLI, preserves user image and one exchange', {timeout:45000},async t=>{
 const f=await fixture(t),[alice]=f.accounts;
 const media=await f.request(alice,'/api/pwa/media',{method:'POST',bytes:f.png,mime:'image/png'});
 await f.send(alice,'video',videoUrl+' PRIVATE_VIDEO_SENTINEL 请说画面和字幕。',{mediaIds:[media.body.media.id]});
 await until(()=>f.outbound(alice).length===1,'video reply');
 const [call]=await f.calls();assert.equal(call.images.length,2);assert(call.images.every(x=>x.bytes>0));
 assert.match(call.prompt,/VIDEO_CUE_BLUE_OBJECT/);assert.match(call.prompt,/前1张是用户图片/);assert.match(call.prompt,/1秒/);assert.match(call.prompt,/第三方来源/);
 assert.doesNotMatch(JSON.stringify(await f.videos()),/PRIVATE_VIDEO_SENTINEL/);
 await until(async()=>(await f.memory()).entries.filter(x=>x.exchange).length===1,'one memory');
 const status=await f.maintenance();assert.equal(status.body.video.leases,0);
});
test('video restricted source gives no image and explicit unread coverage; regular webpages do not call worker', {timeout:45000},async t=>{
 const f=await fixture(t),[alice]=f.accounts;await f.adapter({restricted:true});
 await f.send(alice,'restricted',videoUrl);await until(()=>f.outbound(alice).length===1,'restricted reply');
 const [call]=await f.calls();assert.equal(call.images.length,0);assert.match(call.prompt,/来源访问受限/);assert.doesNotMatch(call.prompt,/VIDEO_CUE_BLUE_OBJECT/);
 await f.send(alice,'plain','https://example.org/page');await until(()=>f.outbound(alice).length===2,'plain reply');assert.equal((await f.videos()).length,1);
});
test('video quoted same-scope followup rechecks cache, cross-object reference refused and restart re-fetches', {timeout:60000},async t=>{
 const f=await fixture(t),[alice,bravo]=f.accounts;
 await f.send(alice,'first',videoUrl);await until(()=>f.outbound(alice).length===1,'first video');
 const original=f.messages(alice).find(x=>x.direction==='inbound');
 assert.equal((await f.send(bravo,'cross','看看这个',{replyTo:original.id})).status,404);
 await f.send(alice,'quote','这个视频的字幕呢',{replyTo:original.id});await until(()=>f.outbound(alice).length===2,'quote video');
 assert.equal((await f.videos()).at(-1).mode,'probe');assert.match((await f.calls()).at(-1).prompt,/VIDEO_CUE_BLUE_OBJECT/);
 await until(()=>f.database.listPendingProjections({limit:100}).length===0,'projections drained');await f.stop();await f.start();
 await f.send(alice,'restart','再看看引用的片段',{replyTo:original.id});await until(()=>f.outbound(alice).length===3,'restart quote');
 assert.equal((await f.videos()).at(-1).mode,'read');
});
test('video in-flight acquisition is aborted by new input; stale draft never sent', {timeout:45000},async t=>{
 const f=await fixture(t),[alice]=f.accounts;await f.adapter({hold:true});await f.send(alice,'old',videoUrl+' OLD');
 await until(async()=>(await f.videos()).length===1,'held video');await f.adapter({restricted:true});await f.scenario({name:'new',reply:'CURRENT_ONLY'});
 await f.send(alice,'new','NEW_INPUT 先聊别的');await until(()=>f.outbound(alice).length===1,'current response');
 assert.equal(f.outbound(alice)[0].text,'CURRENT_ONLY');assert((await f.videos()).some(x=>x.cancelled));assert.equal((await f.calls()).length,1);
 assert.doesNotMatch((await f.calls())[0].prompt,/VIDEO_CUE_BLUE_OBJECT/);
});
test('video expiry at final PWA publish gate refuses stale answer after frame lease cleanup', {timeout:45000},async t=>{
 const f=await fixture(t,{holdPublish:true}),[alice]=f.accounts;await f.scenario({name:'expire',reply:'STALE_VIDEO_FACT'});
 await f.send(alice,'expire',videoUrl);await until(()=>readFile(join(f.directory,'publish-held'),'utf8').catch(()=>false),'publish gate');
 await f.advance(f.at+30*60000+1);await writeFile(join(f.directory,'publish-release'),'release');
 await until(()=>f.outbound(alice).length===1,'expired fallback');assert.match(f.outbound(alice)[0].text,/视频资料已经过时/);assert.doesNotMatch(f.outbound(alice)[0].text,/STALE_VIDEO_FACT/);
 await until(()=>f.database.listPendingProjections({limit:100}).length===0,'projection');assert.equal((await f.memory()).entries.filter(x=>x.exchange).length,0);
});

test('video busy catch-up acquires evidence only after activity and keeps one merged reply', {timeout:45000},async t=>{
 const f=await fixture(t,{busy:true}),[alice]=f.accounts;
 await f.send(alice,'busy-video',videoUrl);await until(()=>f.outbound(alice).length===1,'busy marker');
 assert.match(f.outbound(alice)[0].text,/^\*/);assert.equal((await f.videos()).length,0);
 await f.send(alice,'busy-video-next','还有字幕在说什么');await until(()=>f.database.listPendingInbox({limit:100}).length===0,'busy intake');
 await f.advance(f.at+62000);await until(()=>f.outbound(alice).length===2,'busy video answer',30000);
 assert.equal((await f.calls()).length,1);assert.match((await f.calls())[0].prompt,/VIDEO_CUE_BLUE_OBJECT/);assert.equal((await f.calls())[0].images.length,1);
});
test('video model waiting across memory epoch clear cannot send or learn stale evidence', {timeout:45000},async t=>{
 const f=await fixture(t),[alice]=f.accounts;await f.scenario({name:'epoch-video',reply:'STALE_VIDEO_EPOCH',hold:true});
 await f.send(alice,'epoch-video',videoUrl);await until(()=>readFile(join(f.directory,'model-held'),'utf8').catch(()=>false),'model held');
 const memory=createUnifiedMemory({memoryPath:join(f.directory,'data','unified-memory.json')});await memory.ensureInitialized();await memory.clear({scope:alice.identity.memoryScope});
 await writeFile(join(f.directory,'model-release'),'release');await until(()=>f.database.listPendingInbox({limit:100}).length===0,'epoch settled');
 assert.equal(f.outbound(alice).some(x=>x.text.includes('STALE_VIDEO_EPOCH')),false);
 assert.equal((await f.memory()).entries.filter(x=>x.exchange).length,0);
});


test('video D-on keeps explicit source separate from retrieval and supports provenance-bound timestamp followup', {timeout:45000},async t=>{
 const f=await fixture(t,{webLookup:true}),[alice,bravo]=f.accounts;
 await f.send(alice,'video-d-on',videoUrl);await until(()=>f.outbound(alice).length===1,'first source');
 await f.send(alice,'video-followup','刚才视频00:08那里是什么');await until(()=>f.outbound(alice).length===2,'timestamp followup');
 const calls=await f.calls();assert.equal(calls.length,2);assert.match(calls[1].prompt,/VIDEO_CUE_BLUE_OBJECT/);assert.match(calls[1].prompt,/8秒/);
 assert.equal((await f.videos()).at(-1).atSeconds,8);assert.equal((await f.lookups()).length,0);
 await f.send(bravo,'no-source','刚才视频00:08那里是什么');await until(()=>f.outbound(bravo).length===1,'other scope');
 assert.doesNotMatch((await f.calls()).at(-1).prompt,/VIDEO_CUE_BLUE_OBJECT/);assert.equal((await f.videos()).length,2);
});
