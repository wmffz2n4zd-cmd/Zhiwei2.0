import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { createLifeTimeline } from '../src/life-timeline.js';
import { createPwaAuth } from '../src/pwa-auth.js';
import { createPwaStore } from '../src/pwa-store.js';
import { readingExperience } from '../src/world-experiences.js';

const root = fileURLToPath(new URL('..',import.meta.url)), article = 'https://go.dev/blog/go1.22';
const live = process.env.S139_LIVE_ARTICLE === '1', origin = 'https://pwa.test';
const sha = text => createHash('sha256').update(text).digest('hex');
const summary = '用两张颜色不同的书签分开了两组读书笔记。';
const quiet = '选了一个平静的下午，暂且把这件事留给自己。';
const published = '终于能靠书签的颜色找到那一页笔记了。';
const review = '这篇发布帖写出了版本里的改变，我喜欢这种清楚的说明。';
async function listen(server) {
  server.listen(0,'127.0.0.1'); await once(server,'listening'); return server.address().port;
}
const close = server => new Promise(resolve=>server.close(resolve));
async function waitFor(check, message) {
  const until=Date.now()+18000;
  do { if (await check()) return; await delay(65); } while (Date.now()<until);
  throw Error('Timed out awaiting '+message);
}
const lines = async file => (await readFile(file,'utf8').catch(()=>'')).split('\n').filter(Boolean).map(JSON.parse);
function call(port,path,account,method='GET') {
  return new Promise((resolve,reject)=>{
    const headers={Host:'pwa.test',Origin:origin,'X-PWA-Request':'1'};
    if (account) Object.assign(headers,{Cookie:'__Host-zhiwei='+account.token,'X-CSRF-Token':account.csrfToken});
    const req=request({hostname:'127.0.0.1',port,path,method,headers},res=>{
      let text=''; res.setEncoding('utf8'); res.on('data',v=>{text+=v;});
      res.on('end',()=>resolve({status:res.statusCode,body:res.headers['content-type']?.includes('application/json')?JSON.parse(text):text}));
    });
    req.on('error',reject);req.end();
  });
}

test('life clock creates optional posts for two accounts, keeps private sources out, and resumes from the same durable cursor',
  {timeout:75000},async t=>{
    const parent=join(root,'runtime','tests'); await mkdir(parent,{recursive:true});
    const dir=await mkdtemp(join(parent,'s139-hub-'));
    const calls=join(dir,'model.jsonl'), requests=join(dir,'requests.jsonl'), clock=join(dir,'clock');
    const mock=createServer((req,res)=>{
      assert.equal(req.url,'/blog/go1.22');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end('<title>Go 1.22 is released</title><article><h1>Go 1.22 is released</h1><p>'+
        'Go 1.22 introduces new language and toolchain improvements. '.repeat(8) +
        'The release announcement describes these changes for developers.</p></article>');
    });
    let child, port, log='', store, inspect;
    async function stop() {
      if (child && child.exitCode===null && child.signalCode===null) {
        const stopped=once(child,'close'); child.kill('SIGTERM'); await stopped;
      }
      child=null;
    }
    t.after(async()=>{await stop(); if(mock.listening)await close(mock); inspect?.close(); store?.close();
      await rm(dir,{recursive:true,force:true});});
    const mockPort=await listen(mock);
    for (const name of ['src','config','modules']) await cp(join(root,name),join(dir,name),{recursive:true});
    await mkdir(join(dir,'data'),{recursive:true}); await writeFile(join(dir,'package.json'),'{"type":"module"}');
    let at=Date.now();
    const preload=join(dir,'preload.mjs');
    await writeFile(preload,`import http from 'node:http';import https from 'node:https';import {Resolver} from 'node:dns/promises';
import {syncBuiltinESMExports} from 'node:module';import {readFileSync,appendFileSync} from 'node:fs';
Date.now=()=>Number(readFileSync(${JSON.stringify(clock)},'utf8'));
const url=new URL(${JSON.stringify(article)}), live=${live}, originalHttp=http.request.bind(http), originalHttps=https.request.bind(https);
for (const [name,value] of [['resolve4',['93.184.216.34']],['resolve6',[]]]) {
  const original=Resolver.prototype[name];
  Resolver.prototype[name]=function(host,...args) {if(host!==url.hostname)throw Error('unexpected DNS');return live?original.call(this,host,...args):Promise.resolve(value);};
}
https.request=(target,opts,cb)=>{
  if(target?.href!==url.href || opts.method!=='GET')throw Error('unexpected external HTTP');
  appendFileSync(${JSON.stringify(requests)},JSON.stringify({url:target.href,headers:Object.keys(opts.headers).sort()})+'\\n');
  return live?originalHttps(target,opts,cb):originalHttp({hostname:'127.0.0.1',port:${mockPort},path:target.pathname,method:'GET',headers:opts.headers},cb);
};
http.request=(target,...args)=>{if(!['127.0.0.1','localhost','::1'].includes(target?.hostname))throw Error('non-loopback HTTP');return originalHttp(target,...args);};
syncBuiltinESMExports();`);
    const cli=join(dir,'model.mjs');
    await writeFile(cli,`import {readFile,appendFile} from 'node:fs/promises';
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const args=process.argv.slice(2),schema=JSON.parse(await readFile(args[args.indexOf('--output-schema')+1],'utf8'));
if(schema.properties?.action?.enum?.includes('publish')!==true)throw Error('unexpected model purpose');
const decision=prompt.includes(${JSON.stringify(quiet)})?{action:'skip',text:null}
  :{action:'publish',text:prompt.includes(${JSON.stringify(summary)})?${JSON.stringify(published)}:${JSON.stringify(review)}};
await appendFile(${JSON.stringify(calls)},JSON.stringify({prompt,decision})+'\\n');
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(decision)}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:210,cached_input_tokens:0,output_tokens:18}}));`);
    const database=join(dir,'data','pwa','pwa.sqlite');
    store=createPwaStore({path:database,now:()=>at});inspect=new Database(database,{readonly:true});
    const auth=createPwaAuth({store}), accounts=[];
    for(const name of ['alicia','bravo']) {
      const invitation=store.createInvitation();
      accounts.push(await auth.claim({token:invitation.token,username:name,displayName:name,password:'synthetic-account-pass'}));
    }
    const [alice,bob]=accounts;
    const inbound=store.acceptInbound({userId:alice.user.id,clientMessageId:'space-fixture',text:'PRIVATE_CHAT_SENTINEL'});
    store.completeInbox(inbound.inboxId);
    const directory=join(dir,'data','life');
    async function addDaily(timeline,key,body) {
      const refs=['profile'];
      await timeline.addThought({id:'thought-'+key,text:'日常小事',source:{kind:'life-planner',ref:JSON.stringify(refs)},
        basis:{version:'t045-1',at,timelineSequence:timeline.snapshot().sequence,stateVersion:'t030-1',
          offeredRefs:refs,selectedRefs:refs,mood:null,interests:[]},
        activity:{title:'整理笔记',statusText:'整理中',mode:'simulated',durationMs:60000,busy:false,completionSummary:body}});
      const plan=await timeline.planThought('thought-'+key,{id:'plan-'+key,startAt:at});
      assert.equal(plan.status,'active');
      at+=60000;
      await timeline.tick();
      assert.equal(timeline.snapshot().plans.find(p=>p.id===plan.id).status,'completed');
    }
    async function start() {
      const pwa=createServer(), admin=createServer();
      port=await listen(pwa);const adminPort=await listen(admin);await Promise.all([close(pwa),close(admin)]);
      await writeFile(clock,String(at));
      await writeFile(join(dir,'data','windows.local.json'),JSON.stringify({
        qqEnabled:false,remoteEnabled:false,webLookup:true,privateLearning:{enabled:false},runtimeBudget:{enabled:false},
        life:{enabled:true,tickIntervalMs:250,planning:{enabled:false},browsingIntents:{enabled:false}},
        pwa:{enabled:true,spaceEnabled:true,origin,port,pushEnabled:false}
      }));
      child=spawn(process.execPath,['--import',pathToFileURL(preload).href,'src/server.js'],{
        cwd:dir,windowsHide:true,env:{...process.env,HOME:dir,CODEX_HOME:join(dir,'home'),PORT:String(adminPort),CODEX_CLI_PATH:cli}});
      child.stdout.on('data',chunk=>{log+=chunk;});child.stderr.on('data',chunk=>{log+=chunk;});
      await waitFor(async()=>{if(child.exitCode!==null)throw Error('Hub exited with '+child.exitCode);
        return (await call(port,'/api/pwa/me',alice).catch(()=>null))?.body.capabilities?.space===true;},'PWA space startup');
    }
    const feed='/api/pwa/space/posts', count=()=>inspect.prepare('SELECT event_count FROM space_timeline_cursor WHERE id=1').get()?.event_count;
    let timeline=await createLifeTimeline({directory,now:()=>at});
    let cutIn;
    try { await addDaily(timeline,'historic','PRE_FEATURE_SENTINEL');cutIn=timeline.eventCount; } finally {await timeline.close();}
    try {
      await start();
      assert.equal(count(),cutIn);
      assert.deepEqual((await call(port,feed,alice)).body.posts,[]);
      await stop();
      timeline=await createLifeTimeline({directory,now:()=>at});
      let end;
      try {
        await addDaily(timeline,'publish',summary);
        await addDaily(timeline,'skip',quiet);
        const reading={scope:null,observedAt:at,page:{url:article,title:'CREDENTIALLED_TITLE_SENTINEL',
          contentHash:sha('previous world page')},summary:'CREDENTIALLED_SUMMARY_SENTINEL',effects:null,note:null};
        await timeline.recordExperience(readingExperience({...reading,id:'world:private-post',scope:alice.identity.memoryScope}));
        await timeline.recordExperience(readingExperience({...reading,id:'world:old-no-public-receipt'}));
        await timeline.recordExperience(readingExperience({...reading,id:'world:public-post',spaceUrl:article}));
        end=timeline.eventCount;
      } finally {await timeline.close();}
      await start(); await waitFor(()=>count()===end,'new committed decisions');
      const decisions=await lines(calls), seenReads=await lines(requests);
      assert.equal(decisions.length,3);
      assert.deepEqual(decisions.map(item=>item.decision.action),['publish','skip','publish']);
      assert.doesNotMatch(JSON.stringify(decisions),/PRIVATE_CHAT_SENTINEL|PRE_FEATURE_SENTINEL|CREDENTIALLED_(?:TITLE|SUMMARY)_SENTINEL/);
      assert.deepEqual(seenReads,[{url:article,headers:['accept','accept-encoding','user-agent']}]);
      const first=(await call(port,feed,alice)).body;
      const [shared,daily]=first.posts;
      assert.deepEqual(first,(await call(port,feed,bob)).body);
      assert.deepEqual(first.posts.map(p=>[p.kind,p.text]),[['share',review],['daily',published]]);
      assert.equal(shared.source.url,article);assert.match(shared.source.title,/Go 1\.22/i);
      assert.equal(daily.source,null);
      const basis=inspect.prepare('SELECT basis_text AS text, basis_hash AS hash FROM space_posts WHERE id=?').get(shared.id);
      assert.ok(basis.text.length>50 && decisions[2].prompt.includes(JSON.stringify(basis.text).slice(1,-1)));
      assert.equal(basis.hash,sha(basis.text));
      assert.deepEqual((await call(port,feed+'/'+shared.id,bob)).body,{post:shared});
      await stop();await start();
      await delay(650);
      assert.deepEqual((await call(port,feed,bob)).body,first);
      assert.equal((await lines(calls)).length,3);assert.equal((await lines(requests)).length,1);
      assert.equal((await call(port,'/api/pwa/session',alice,'DELETE')).status,200);
      for(const path of [feed,feed+'/'+shared.id,'/space/'+shared.id]) {
        const guest=await call(port,path,alice);
        assert.equal(guest.status,401);assert.ok(!JSON.stringify(guest.body).includes(review));
      }
      console.log('S139_SPACE '+JSON.stringify({mode:live?'real HTTPS':'isolated article',cutIn,end,
        actions:decisions.map(d=>d.decision.action),ids:first.posts.map(p=>p.id),source:shared.source,
        basisHash:basis.hash,basisChars:basis.text.length,sameForTwoAccounts:true,guestStatus:401,requests:1,restartDuplicates:0}));
    } catch(error) {
      throw Error(error.message+'; cursor='+count()+'; posts='+JSON.stringify(store.listSpacePosts())+
        '; calls='+JSON.stringify((await lines(calls)).map(x=>x.decision))+'; reads='+JSON.stringify(await lines(requests))+
        '; Hub='+log.slice(-1300),{cause:error});
    }
});
