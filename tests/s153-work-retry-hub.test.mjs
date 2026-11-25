import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createPwaAuth } from '../src/pwa-auth.js';
import { createPwaStore } from '../src/pwa-store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://pwa.test';
const specs = {
  website: { intro:'重试后的潮汐',accent:'#227766',sections:[{heading:'晨潮',body:'看海',detail:'听潮'}] },
  design: { width:240,height:160,background:'#ffffff',elements:[{type:'text',x:10,y:80,text:'潮汐',size:22,fill:'#227766'}] },
  model3d: { parts:[{name:'潮汐座',shape:'box',size:[1,2,3],position:[1,0,0],color:'#227766'}] }
};

// The schema and process streams are the same ones used by the product CLI. Only
// the model answers and the native image provider are replaced, in this process.
async function fakeModel() {
  const fs = await import('node:fs/promises'), {join} = await import('node:path');
  const {randomUUID} = await import('node:crypto');
  const dir = new URL('./', import.meta.url);
  const state = JSON.parse(await fs.readFile(new URL('scenario.json',dir)));
  const argv = process.argv.slice(2);
  let prompt = '';
  for await (const part of process.stdin) prompt += part;
  let step, answer, status;
  if (argv.includes('--output-schema')) {
    const {properties} = JSON.parse(await fs.readFile(argv[argv.indexOf('--output-schema')+1]));
    if (properties.action) {
      step='decision';
      answer={action:'reply',reply:'我来做。',lookup:null,contactBoundary:{kind:'none',quote:''},browseIntent:null,
        creativeWork:{kind:state.kind,title:'潮汐',brief:'做一件关于潮汐的作品。'}};
    } else if (properties.specJson) {
      step='draft';
      answer={specJson:JSON.stringify(state.ok ? state.spec : {})};
    } else if (properties.text) {
      step='receipt'; status=JSON.parse(prompt.trim().split('\n').at(-1)).status;
      // Even inaccurate model wording on a failed receipt must never deliver a card.
      answer={text:status==='failed' ? '我已经把作品做好了。' : '潮汐做好了。'};
    } else throw Error('Unexpected model schema');
    const text = JSON.stringify(answer);
    if (argv.includes('-o')) await fs.writeFile(argv[argv.indexOf('-o')+1],text);
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
  } else {
    step='image';
    const thread=randomUUID();
    console.log(JSON.stringify({type:'thread.started',thread_id:thread}));
    if (state.ok) {
      const out=join(process.env.CODEX_HOME,'generated_images',thread);
      await fs.mkdir(out,{recursive:true}); await fs.copyFile(new URL('fixture.png',dir),join(out,'fixture.png'));
    }
  }
  await fs.appendFile(new URL('calls.jsonl',dir),JSON.stringify({kind:state.kind,step,status})+'\n');
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:220,cached_input_tokens:0,output_tokens:18}}));
}

async function hubPorts() {
  const leases = [createServer(),createServer()];
  try {
    return await Promise.all(leases.map(async server=>{
      server.listen(0,'127.0.0.1'); await once(server,'listening'); return server.address().port;
    }));
  } finally { await Promise.all(leases.filter(s=>s.listening).map(s=>new Promise(done=>s.close(done)))); }
}

function api(port, path, account, body) {
  const headers = {host:'pwa.test'};
  if (account) Object.assign(headers,{cookie:'__Host-zhiwei='+account.token,origin,
    'x-csrf-token':account.csrfToken,'x-pwa-request':'1'});
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  if (payload) Object.assign(headers,{'content-type':'application/json','content-length':payload.length});
  return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,headers,method:body?'POST':'GET'},res=>{
      const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>resolve({status:res.statusCode,bytes:Buffer.concat(chunks),headers:res.headers}));
    });
    req.on('error',reject);req.end(payload);
  });
}

test('all four tools report real generation failure, ignore replay, and deliver one private work on a fresh request',
  {timeout:115000}, async t=>{
    const jobs = join(root,'runtime/tests');await mkdir(jobs,{recursive:true});
    const dir = await mkdtemp(join(jobs,'s153-work-retry-'));
    let child, closed, store, log='';
    t.after(async()=>{
      if (child && child.exitCode===null && child.signalCode===null) child.kill('SIGTERM');
      if (closed) await closed;
      store?.close();await rm(dir,{recursive:true,force:true});
    });
    for (const name of ['src','config','modules','package.json']) await cp(join(root,name),join(dir,name),{recursive:true});
    const [port,admin]=await hubPorts(), cli=join(dir,'fake.mjs');
    await mkdir(join(dir,'home'));
    await mkdir(join(dir,'data/pwa'),{recursive:true});
    await writeFile(cli,'('+fakeModel.toString()+')();');
    await sharp({create:{width:8,height:8,channels:3,background:'#228877'}}).png().toFile(join(dir,'fixture.png'));
    const kinds=['website','design','model3d','drawing'];
    await writeFile(join(dir,'data/windows.local.json'),JSON.stringify({remoteEnabled:false,webLookup:true,
      privateReplyMode:'single',privateLearning:{enabled:false},runtimeBudget:{enabled:false},life:{enabled:false},world:{enabled:false},
      pwa:{enabled:true,origin,port,pushEnabled:false,creativeTools:Object.fromEntries(kinds.map(k=>[k,true]))}}));
    store=createPwaStore({path:join(dir,'data/pwa/pwa.sqlite')});
    const auth=createPwaAuth({store});
    async function claim(username) { return auth.claim({token:store.createInvitation({role:'friend'}).token,username,
      displayName:username,password:'synthetic-private-s153',deviceName:'test'}); }
    const alice=await claim('alice'), bravo=await claim('bravo');
    child=spawn(process.execPath,['src/server.js'],{cwd:dir,env:{...process.env,HOME:dir,CODEX_HOME:join(dir,'home'),
      CODEX_CLI_PATH:cli,PORT:String(admin),CODEX_REMOTE_CONTACT_WEB_LOOKUP:'1'}});
    closed=once(child,'close');
    for (const stream of [child.stderr,child.stdout]) stream.on('data',chunk=>{log=(log+chunk).slice(-2400);});
    async function until(check,label) {
      const end=Date.now()+24000;
      do { if(child.exitCode!==null || child.signalCode!==null)break;
        const value=await check();if(value)return value;await delay(80);
      } while(Date.now()<end);
      throw Error('Hub timed out at '+label+': '+log);
    }
    async function json(path,account,body) { const result=await api(port,path,account,body);
      assert.equal(result.status,200,result.bytes.toString().slice(0,300));return JSON.parse(result.bytes); }
    const history=async account=>(await json('/api/pwa/messages?limit=60',account)).messages;
    const calls=async kind=>(await readFile(join(dir,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(r=>r.kind===kind);
    await until(async()=>(await api(port,'/').catch(()=>null))?.status===200,'startup');

    for (const [i,kind] of kinds.entries()) {
      const fixture=async ok=>writeFile(join(dir,'scenario.json'),JSON.stringify({kind,ok,spec:specs[kind]}));
      const dispatch=async(ok)=>{
        const body={clientMessageId:kind+(ok?'-retry':'-original'),text:(ok?'请重新制作':'请制作')+'潮汐作品（'+kind+'）。'};
        return json('/api/pwa/messages',alice,body);
      };
      const completed=async id=>until(()=>store.getInbox(id)?.state==='complete',kind+' inbox '+id);
      await fixture(false);
      const failed=await dispatch(false);assert.equal(failed.duplicate,false);
      await completed(failed.message.id);
      const afterFailure=(await history(alice)).filter(row=>row.direction==='outbound');
      assert.equal(afterFailure.length,2*i+1);
      assert.equal(afterFailure.filter(m=>m.work).length,i);
      const failureRow=afterFailure.find(m=>m.seq>failed.message.seq);
      assert.match(failureRow.text,/没有生成可交付的文件/);assert.ok(!failureRow.work);
      const first=await calls(kind);
      assert.deepEqual(first.map(v=>v.step),['decision',kind==='drawing'?'image':'draft','receipt']);
      assert.equal(first.at(-1).status,'failed');
      await fixture(true);
      const replay=await dispatch(false);assert.equal(replay.duplicate,true);assert.equal(replay.message.id,failed.message.id);
      assert.deepEqual(await calls(kind),first);
      const retried=await dispatch(true);assert.equal(retried.duplicate,false);
      await completed(retried.message.id);
      const rows=(await history(alice)).filter(m=>m.direction==='outbound');
      assert.equal(rows.length,2*i+2);assert.equal(rows.filter(m=>m.work).length,i+1);
      const card=rows.find(m=>m.seq>retried.message.seq);
      assert.equal(card.work.kind,kind);assert.equal(card.text,'潮汐做好了。');
      const receipts=await calls(kind);
      assert.deepEqual(receipts.map(v=>v.step),[...first.map(v=>v.step),...first.map(v=>v.step)]);
      assert.equal(receipts.at(-1).status,'ready');
      const original=await dispatch(true);assert.equal(original.duplicate,true);assert.equal(original.message.id,retried.message.id);
      for(const suffix of ['preview',...card.work.downloads.map(name=>'download/'+name)]) {
        const path='/api/pwa/media/works/'+card.work.id+'/'+suffix;
        const file=await api(port,path,alice);assert.equal(file.status,200);assert.ok(file.bytes.length>20);
        if(suffix.startsWith('download/'))assert.match(file.headers['content-disposition'],/attachment/);
        assert.equal((await api(port,path,bravo)).status,404);assert.equal((await api(port,path)).status,401);
      }
      assert.deepEqual(await calls(kind),receipts);
    }
    assert.equal((await history(bravo)).length,0);
  });

