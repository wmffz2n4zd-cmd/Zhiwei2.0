import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import { createLifeTimeline } from '../src/life-timeline.js';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { createPwaAuth } from '../src/pwa-auth.js';
import { createPwaStore } from '../src/pwa-store.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const origin = 'https://pwa.test';
const articleUrl = 'https://www.rfc-editor.org/rfc/rfc862.txt';
const subject = 'Echo Protocol';
const thought = { action: '想找时间读完这篇文章，弄清它怎样描述回声协议', subject };
const original = '那篇《' + subject + '》在这里： ' + articleUrl;
const live = process.env.S137_LIVE_ARTICLE === '1';
const day = 24 * 60 * 60 * 1000;
const decodeLines = async path => (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);

async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(50);
  } while (Date.now() < end);
  throw Error('Timed out waiting for ' + label);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function hubPorts() {
  const pwa = createServer(), admin = createServer();
  try {
    // Both leases coexist with the article fixture, so the kernel assigns three distinct ports.
    return { pwa:await listen(pwa), admin:await listen(admin) };
  } finally {
    await Promise.all([pwa,admin].filter(server=>server.listening).map(server=>new Promise(resolve=>server.close(resolve))));
  }
}

function call(port, path, account, body, method) {
  const headers = { host: 'pwa.test' };
  if (account) Object.assign(headers, { origin, cookie: '__Host-zhiwei=' + account.token,
    'x-csrf-token': account.csrfToken, 'x-pwa-request': '1' });
  const payload = body ? JSON.stringify(body) : '';
  if (body) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers, method: method || (body ? 'POST' : 'GET') }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200 && !(res.statusCode === 201 && path.endsWith('/comments') && body)) return reject(Error('HTTP ' + res.statusCode + ' for ' + path));
        resolve(path === '/' ? true : JSON.parse(data));
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

for (const quoted of [true]) test(
  'life clock reconsiders the original PWA thought, then reads once across restart while contact is paused (' + (quoted ? 'native replyTo' : 'direct share') + ')',
  {timeout:105000}, async t => {
    const runtime = join(root, 'runtime/tests');
    await mkdir(runtime, { recursive: true });
    const dir = await mkdtemp(join(runtime, 's137-hub-'));
    let child, store, db, output = '';
    const stop = async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGTERM'); await closed;
      }
      child = null;
    };
    const mock = createServer((req, res) => {
      if (req.url !== '/rfc/rfc862.txt' || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
      res.end('<html><head><title>Echo Protocol</title></head><body><article><h1>Echo Protocol</h1>' +
        '<p>' + 'This fixture describes a loopback service used for testing. '.repeat(23) +
        'The final sentence identifies the test article with the words amber notebook.</p></article></body></html>');
    });
    t.after(async () => { await stop(); if (mock.listening) await new Promise(resolve => mock.close(resolve));
      db?.close(); store?.close(); await rm(dir, { recursive:true, force:true }); });
    const ports = { mock:await listen(mock) };
    const pushes = [];
    const receiver = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/s143-test') { res.writeHead(404); return res.end(); }
      const parts = [];
      req.on('data', part => parts.push(part));
      req.on('end', () => {
        pushes.push({ encrypted: req.headers['content-encoding'] === 'aes128gcm',
          signed: /^vapid /.test(req.headers.authorization || ''), bytes: Buffer.concat(parts).length });
        res.writeHead(201); res.end();
      });
    });
    ports.push = await listen(receiver);
    t.after(() => new Promise(resolve => receiver.close(resolve)));
    for (const path of ['src','modules','config']) await cp(join(root,path), join(dir,path), { recursive:true });
    await mkdir(join(dir,'data'), { recursive:true });
    await writeFile(join(dir,'package.json'), '{"type":"module"}');
    const clock = join(dir,'clock'), decisions = join(dir,'decision'), calls = join(dir,'calls'), requests = join(dir,'requests');
    const capturedBody = join(dir,'raw-article');
    const now = Date.now()-day-31*60000; // The subprocess clock is advanced only at phase boundaries.
    const advance = async time => { await writeFile(clock+'.new',String(time)); await rename(clock+'.new',clock); };
    await advance(now);
    const config = {
      qqEnabled:false, remoteEnabled:false, webLookup:true, privateReplyMode:'single', privateLearning:{enabled:false},
      runtimeBudget:{enabled:false}, life:{enabled:true,tickIntervalMs:250,planning:{enabled:false},browsingIntents:{enabled:false}},
      pwa:{enabled:true,origin,spaceEnabled:true,pushEnabled:true,privateThoughtsEnabled:true,privateThoughtActionsEnabled:true}
    };
    // Only the transport and model are substituted. A live run keeps DNS and TLS for the nominated public article.
    const preload = join(dir,'harness.mjs');
    await writeFile(preload, `import {readFileSync,appendFileSync} from 'node:fs';
import dns, {Resolver} from 'node:dns/promises';
const nativeLookup = dns.lookup.bind(dns);
dns.lookup = (host, options) => host === 'web.push.apple.com'
  ? Promise.resolve([{address:'17.188.170.1',family:4}]) : nativeLookup(host, options); import http from 'node:http'; import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
Date.now=()=>Number(readFileSync(${JSON.stringify(clock)},'utf8'));
const source = new URL(${JSON.stringify(articleUrl)}), live = ${live};
for(const [method, mock] of [['resolve4',['93.184.216.34']],['resolve6',[]]]) {
  const original=Resolver.prototype[method];
  Resolver.prototype[method]=async function(host,...args) {
    if(host !== source.hostname) throw Error('External DNS blocked by test');
    return live ? original.call(this,host,...args) : mock;
  };
}
const originalHttps=https.request.bind(https), originalHttp=http.request.bind(http);
https.request=(url, opts, callback)=>{
  if (url?.href === 'https://web.push.apple.com/s143-test' && opts.method === 'POST') {
    return originalHttp({hostname:'127.0.0.1',port:${ports.push},path:url.pathname,method:'POST',
      headers:opts.headers},callback);
  }
  if(url?.href!==source.href || opts.method!=='GET') throw Error('External request blocked by test');
  appendFileSync(${JSON.stringify(requests)},JSON.stringify({url:url.href, method:opts.method, headers:Object.keys(opts.headers).sort()})+'\\n');
  const observe=incoming=>{
    incoming.on('data',chunk=>appendFileSync(${JSON.stringify(capturedBody)},chunk));
    callback(incoming);
  };
  return live ? originalHttps(url,opts,observe) : originalHttp({hostname:'127.0.0.1',port:${ports.mock},path:url.pathname,method:opts.method,headers:opts.headers},observe);
};
http.request=(...args)=>{const target=args[0]; if(!['127.0.0.1','localhost','::1'].includes(target?.hostname))throw Error('Non-loopback HTTP blocked by test');return originalHttp(...args);};
syncBuiltinESMExports();`);
    const cli = join(dir,'model.mjs');
    await writeFile(cli, `import {readFile,writeFile,appendFile} from 'node:fs/promises';
let prompt=''; for await(const part of process.stdin)prompt+=part;
const argv=process.argv.slice(2), schema=JSON.parse(await readFile(argv[argv.indexOf('--output-schema')+1],'utf8'));
const scenario=JSON.parse(await readFile(${JSON.stringify(decisions)},'utf8')), review=Boolean(schema.properties.decision);
const publicPost = schema.properties.action?.enum?.includes('publish');
const publicComment = !publicPost && schema.properties.action?.enum?.join(',') === 'reply,skip';
const answer=publicPost ? {action:'publish',text:'今天把窗台上的折纸船摊平了，船终于能站稳。'}
  : publicComment ? (JSON.parse(prompt.split('\\n').at(-1)).comment.includes('船底')
    ? {action:'reply',text:'我把船底的折痕摊平了。'} : {action:'skip',text:null})
  : review ? (scenario.review==='defer' ? {decision:'defer',sourceRef:null,delayMinutes:30}
    : {decision:'act',sourceRef:'article-1',delayMinutes:null}) :
  {action:'reply',reply:scenario.reply,lookup:null,contactBoundary:{kind:'none',quote:''},browseIntent:null,privateThought:scenario.thought||null};
await appendFile(${JSON.stringify(calls)},JSON.stringify({review,publicPost,publicComment,label:scenario.label,prompt,answer,schema})+'\\n');
const text=JSON.stringify(answer);if(argv.includes('-o'))await writeFile(argv[argv.indexOf('-o')+1],text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:320,cached_input_tokens:0,output_tokens:14}}));`);
    const scenario = (label, review, reply, material=null) => writeFile(decisions,JSON.stringify({label,review,reply,thought:material}));
    const databasePath = join(dir,'data/pwa/pwa.sqlite');
    store = createPwaStore({path:databasePath, now:() => now});
    db = new Database(databasePath, {readonly:true});
    const auth = createPwaAuth({store}), accounts = [];
    for(const username of ['alice','bravo']) {
      const invite=store.createInvitation({role:'friend'});
      accounts.push(await auth.claim({username,displayName:username,token:invite.token,password:'synthetic-strong-password',deviceName:'fixture'}));
    }
    const [alice,bravo] = accounts;
    const start = async () => {
      Object.assign(ports,await hubPorts());
      config.pwa.port=ports.pwa;
      await writeFile(join(dir,'data/windows.local.json'),JSON.stringify(config));
      const startedAt=output.length;
      child = spawn(process.execPath,['--import',pathToFileURL(preload).href,'src/server.js'],{ cwd:dir,
        env:{...process.env,HOME:dir,CODEX_HOME:join(dir,'home'),CODEX_CLI_PATH:cli,PORT:String(ports.admin),CODEX_REMOTE_CONTACT_WEB_LOOKUP:'1'} });
      child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      await until(()=>{
        if(child.exitCode!==null || child.signalCode!==null)throw Error('Hub exited during startup');
        return output.slice(startedAt).includes('Invitation private chat listener ready on loopback') &&
          call(ports.pwa,'/').catch(()=>false);
      },'startup');
    };
    const send=(account,id,text,replyTo=null)=>call(ports.pwa,'/api/pwa/messages',account,{clientMessageId:id,text,replyTo});
    const out=async account=>(await call(ports.pwa,'/api/pwa/messages',account)).messages.filter(m=>m.direction==='outbound');
    const drained=()=>until(()=>!store.listPendingProjections().length&&!store.listPendingInbox().length,'committed inbox and projection');
    const reviews=async()=>(await decodeLines(calls)).filter(item=>item.review);
    const material=()=>db.prepare('SELECT user_id AS userId,memory_scope AS scope,epoch FROM private_thoughts WHERE user_id=?').get(alice.user.userId);
    const recall=()=>store.listPrivateThoughts(material())[0];
    try {
      await scenario('share','defer','链接收到了。');
      await start();
      let shared;
      if (quoted) {
        shared=await send(alice,'first-share',original);
        await until(async()=>(await out(alice)).some(m=>m.text==='链接收到了。'),'quoted original delivered');
        await drained();
        assert.equal(material(),undefined);
      }
      await scenario('initial','defer','我把这篇记下了。',thought);
      const originalInput=quoted ? '我说的就是引用的这篇文章。' : original;
      const quoteId=shared?.message.id ?? null;
      const inbound=await send(alice,'original',originalInput,quoteId);
      await until(async()=>(await out(alice)).some(m=>m.text==='我把这篇记下了。'),'first delivered reply');
      await drained(); await until(material,'persisted thought');
      assert.equal(recall().subject,subject);
      const originId=recall().logicalReplyId, originalInbound=recall().inboundIds;
      assert.ok(originalInbound.includes(inbound.message.id));
      // A later message contains a different URL, then the real participant stop boundary is committed.
      await advance(now+day-60000);
      await scenario('distractor','defer','看到了。');
      await send(alice,'later','另一篇在 https://www.example.org/unrelated 。');
      await until(async()=>(await out(alice)).some(m=>m.text==='看到了。'),'later chat');
      await send(alice,'stop','别再联系我了');
      const paused=async()=>JSON.parse(await readFile(join(dir,'data/life/contacts.json'),'utf8')).contacts
        .find(c=>c.scope===material().scope)?.paused;
      await until(paused,'contact pause'); await drained();
      assert.deepEqual(await reviews(),[]);
      
      const me = await call(ports.pwa,'/api/pwa/me',alice);
      assert.ok(me.capabilities.notifications && me.capabilities.space && me.capabilities.chat);
      const key=createECDH('prime256v1'); key.generateKeys();
      const registered=await call(ports.pwa,'/api/pwa/push-subscription',alice,{preview:false,
        subscription:{endpoint:'https://web.push.apple.com/s143-test',
          keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}},'PUT');
      assert.ok(registered.enabled);
      const outboundBefore=(await out(alice)).map(m=>m.id);
      await stop();
      let timelineAt = now + day - 60000;
      const timeline = await createLifeTimeline({ directory:join(dir,'data/life'), now:()=>timelineAt });
      try {
        const refs=['profile'];
        await timeline.addThought({id:'s143-daily',text:'整理窗台',source:{kind:'life-planner',ref:JSON.stringify(refs)},
          basis:{version:'t045-1',at:timelineAt,timelineSequence:timeline.snapshot().sequence,stateVersion:'t030-1',
            offeredRefs:refs,selectedRefs:refs,mood:null,interests:[]},
          activity:{title:'折纸船',statusText:'折纸中',durationMs:60000,busy:false,mode:'simulated',
            completionSummary:'折了一只小船，把船底摊平，在窗台上站稳了。'}});
        assert.equal((await timeline.planThought('s143-daily',{id:'s143-plan',startAt:timelineAt})).status,'active');
        timelineAt+=60000; await timeline.tick();
        assert.equal(timeline.snapshot().plans.find(p=>p.id==='s143-plan').status,'completed');
      } finally { await timeline.close(); }
      await advance(now+day+1000); await start();
      
      await until(()=>recall().review?.status==='deferred','persisted deferral');
      const feed='/api/pwa/space/posts';
      const post=await until(async()=>(await call(ports.pwa,feed,alice)).posts[0],'timeline public post');
      assert.equal(post.kind,'daily'); assert.match(post.text,/纸船/);
      assert.deepEqual((await call(ports.pwa,feed,bravo)).posts,[post]);
      const thread=feed+'/'+post.id+'/comments';
      const aliceDraft={clientCommentId:'both-devices',text:'我也喜欢折纸。'};
      const bravoDraft={clientCommentId:'both-devices',text:'船底怎么修？'};
      const aComment=(await call(ports.pwa,thread,alice,aliceDraft)).comment;
      const bComment=(await call(ports.pwa,thread,bravo,bravoDraft)).comment;
      await until(()=>db.prepare('SELECT COUNT(*) AS n FROM space_comments WHERE decided_at IS NOT NULL').get().n===2,
        'both public choices');
      const threadAfter=(await call(ports.pwa,thread,bravo)).comments;
      assert.deepEqual(threadAfter.map(c=>[c.id,c.authorName,c.reply?.text||null]),
        [[bComment.id,'bravo','我把船底的折痕摊平了。'],[aComment.id,'alice',null]]);
      const q=sql=>db.prepare(sql).get().n;
      assert.equal(q('SELECT count(*) AS n FROM push_jobs'),0);
      assert.equal((await out(alice)).length,outboundBefore.length);
      assert.equal((await out(bravo)).length,0);
      const deferred=recall().review, first=(await reviews())[0];
      assert.ok(first.prompt.includes(thought.action));
      assert.ok(!first.prompt.includes('unrelated'));
      assert.equal(deferred.nextConsiderAt,now+day+1000+30*60000);
      assert.deepEqual(await decodeLines(requests),[]);
      await stop();
      await scenario('returned','act','我在。'); await advance(deferred.nextConsiderAt); await start();
      await until(()=>['read','unavailable','unknown'].includes(recall().review?.status),'durable reading result',35000);
      const finished=recall();
      assert.equal(finished.review.status,'read',JSON.stringify(finished.review));
      assert.equal(finished.logicalReplyId,originId); assert.deepEqual(finished.inboundIds, originalInbound);
      assert.equal(finished.review.sourceId,quoteId ?? inbound.message.id,'bound to the inbound message that supplied the URL');
      const reviewHistory=(await reviews())[1].prompt.split('\n').find(line=>line.startsWith('之前的复议：'));
      assert.deepEqual(JSON.parse(reviewHistory.slice('之前的复议：'.length)),{deferrals:1,
        lastConsideredAt:new Date(deferred.decidedAt).toISOString(),scheduledFor:new Date(deferred.nextConsiderAt).toISOString()});
      assert.ok(await paused());
      assert.deepEqual((await out(alice)).map(m=>m.id),outboundBefore); assert.deepEqual(await out(bravo),[]);
      const readRequests=await decodeLines(requests);
      assert.equal(readRequests.length,1); assert.equal(readRequests[0].url,articleUrl);
      assert.deepEqual(readRequests[0].headers,['accept','accept-encoding','user-agent']);
      const receipt=finished.review.receipt;
      const persisted=JSON.stringify(receipt);
      assert.ok(persisted.includes(articleUrl)); assert.match(persisted,live?/debugging|measurement/i:/amber notebook/);
      assert.equal(receipt.coverage,'complete-article');
      const rawArticle=await readFile(capturedBody,'utf8');
      const bodyText=live ? rawArticle : rawArticle.match(/<article>([\s\S]*?)<\/article>/i)[1].replace(/<[^>]*>/g,' ');
      const fullText=live ? bodyText.replace(/\r\n?/g,'\n').replace(/[^\S\t\n ]/g,' ').trim() : bodyText.replace(/\s+/gu,' ').trim();
      assert.ok(fullText.length>600,'article must extend beyond the previous excerpt limit');
      assert.equal(receipt.textLength,fullText.length);
      assert.equal(receipt.contentHash,createHash('sha256').update(fullText).digest('hex'));
      assert.equal(receipt.excerpt,fullText,'the complete material survives into the scoped receipt');
      await stop(); await advance(deferred.nextConsiderAt+60000); await start();
      const repeated=await send(alice,'original',originalInput,quoteId);
      assert.equal(repeated.duplicate,true);
      await scenario('other','act','正想喝茶。'); await send(bravo,'other','之前读了什么？');
      await until(async()=>(await out(bravo)).some(m=>m.text==='正想喝茶。'),'other recipient chat'); await drained();
      await scenario('owner','act','我记得。'); await send(alice,'owner','之前那篇读得怎样？');
      await until(async()=>(await out(alice)).some(m=>m.text==='我记得。'),'originating chat'); await drained();
      const turnCalls=await decodeLines(calls), b=turnCalls.find(m=>!m.review&&m.label==='other'), a=turnCalls.find(m=>!m.review&&m.label==='owner');
      const tail=fullText.slice(-140), escaped=value=>JSON.stringify(value).slice(1,-1);
      const encodedTails=[tail,escaped(tail),escaped(escaped(tail))];
      assert.doesNotMatch(b.prompt,/amber notebook|rfc862\.txt|想找时间读完这篇文章/);
      assert.ok(!encodedTails.some(value=>b.prompt.includes(value)));
      assert.ok(encodedTails.some(value=>a.prompt.includes(value)),'next originating-account model prompt receives the end of the article');
      assert.equal((await reviews()).length,2); assert.equal((await decodeLines(requests)).length,1);
      assert.deepEqual(recall().review,finished.review);
      
      await until(()=>q("SELECT count(*) AS n FROM push_jobs WHERE state='accepted' AND status_code=201")===1,
        'encrypted private notification accepted by fixture receiver');
      assert.equal(q('SELECT count(*) AS n FROM push_jobs'),1);
      assert.equal(pushes.length,1); assert.ok(pushes[0].encrypted && pushes[0].signed && pushes[0].bytes>32);
      assert.deepEqual((await call(ports.pwa,thread,alice)).comments,threadAfter);
      assert.equal((await call(ports.pwa,thread,bravo,bravoDraft)).duplicate,true);
      assert.equal((await call(ports.pwa,thread,alice,aliceDraft)).duplicate,true);
      const publicCalls=turnCalls.filter(row=>row.publicPost||row.publicComment);
      assert.equal(publicCalls.length,3);
      assert.doesNotMatch(JSON.stringify([publicCalls,post,threadAfter]),/rfc862|amber notebook|回声协议|Echo Protocol|记下了/);
      const pushOwner=db.prepare('SELECT m.user_id AS author,p.user_id AS recipient,m.direction FROM push_jobs p JOIN messages m ON p.message_seq=m.seq').get();
      assert.deepEqual(pushOwner,{author:alice.user.id,recipient:alice.user.id,direction:'outbound'});
      console.log('S143_COMBINED '+JSON.stringify({hubStarts:4,privateReviews:['defer','act'],articleSource:'native quote',
        privateReads:1,privateReceiptReachableOnlyByAuthor:true,publicPosts:1,publicComments:2,publicReplies:1,
        publicSkipped:1,replayedCommentsAdded:0,crossAudienceMarkers:0,outboundDuringPause:0,
        publicNotifications:0,privateNotifications:1,notificationProvider:'loopback 201',encrypted:pushes[0].encrypted}));
      console.log('S137_ARTICLE '+JSON.stringify({mode:live?'real HTTPS':'loopback article',source:quoted?'native replyTo':'direct share',url:articleUrl,
        originalInboundCount:originalInbound.length,reviewChoices:(await reviews()).map(m=>m.answer.decision),reads:1,
        contactPausedAtRead:true,extraOutboundWhilePaused:0,sourceTextEqualsReceipt:true,
        originatingPromptHasTail:true,otherPromptHasTail:false,
        receipt:{url:receipt.url,title:receipt.title,fetchedAt:receipt.fetchedAt,coverage:receipt.coverage,
          contentHash:receipt.contentHash,textLength:receipt.textLength}}));
    } catch (error) {
      const states=material() && recall()?.review?.status;
      console.log('S143 diagnostic',error.message,db.prepare('SELECT state,reason,status_code,attempts FROM push_jobs').all(),
        {receiverRequests:pushes.length});
      throw Error(error.message+'; review='+JSON.stringify(states)+'; model='+JSON.stringify((await reviews()).map(m=>m.answer))+
        '; requests='+JSON.stringify(await decodeLines(requests))+'; Hub log='+output.slice(-1400),{cause:error});
    }
});
