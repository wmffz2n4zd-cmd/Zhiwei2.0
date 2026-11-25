import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPwaStore } from '../src/pwa-store.js';
import { createPwaAuth } from '../src/pwa-auth.js';
import { createPwaHttp } from '../src/pwa-http.js';
import { createPwaHistory } from '../src/pwa-history.js';

async function setup(t,{readOnly=false}={}) {
  const dir=await mkdtemp(join(tmpdir(),'t062-history-http-')),store=createPwaStore({path:join(dir,'db.sqlite')}),auth=createPwaAuth({store});
  const pub=join(dir,'public');await mkdir(pub);await writeFile(join(pub,'index.html'),'<!doctype html>');
  function user(name,scope){const value=store.claimInvitation({token:store.createInvitation({memoryScope:scope}).token,username:name,displayName:name,passwordHash:'test'}).user;store.verifyBinding(value.id);const session=store.createSession({userId:value.id});return{...value,session,
    headers:{Host:'zhiwei.example',Origin:'https://zhiwei.example','X-PWA-Request':'1','X-CSRF-Token':session.csrfToken,Cookie:`__Host-zhiwei=${session.token}`}};}
  const a=user('alice','qq:private:111'),b=user('bob','qq:private:222');let pause=null;
  const history=createPwaHistory({store,readLegacyHistorySnapshot:async({scope})=>{await pause?.();return{records:scope==='qq:private:111'?[{id:'old',at:'2026-01-02T03:00:00Z',userText:'真正留存的原话',replyText:'旧回答'}]:[]};}});
  const stickerCalls=[];const stickers={list:async(...args)=>{stickerCalls.push(['list',...args]);return{items:[],hasMore:false,nextCursor:null};},save:async(user,input,check)=>{check();stickerCalls.push(['save',user,input]);return{item:{id:input.mediaId}};},remove:(...args)=>{stickerCalls.push(['remove',...args]);return{ok:true};},select:async(user,id,check)=>{check();stickerCalls.push(['select',user,id]);return{media:{id,type:'image/png',url:`/api/pwa/media/${id}`},mediaId:id};}};
  const http=createPwaHttp({store,auth,history,stickers,media:{},publicDir:pub,origin:'https://zhiwei.example',readOnly}),address=await http.listen(0);
  t.after(async()=>{await http.close();store.close();await rm(dir,{recursive:true,force:true});});
  const call=(who,method,path,data,extra={})=>new Promise((resolve,reject)=>{
    const bytes=data===undefined?null:Buffer.from(JSON.stringify(data));
    const req=request({host:'127.0.0.1',port:address.port,method,path,headers:{Host:'zhiwei.example',...(who?.headers||{}),'Content-Type':'application/json',...(bytes?{'Content-Length':bytes.length}:{}),...extra}},res=>{
      const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,text,body:JSON.parse(text)});});});
    req.on('error',reject);req.end(bytes);
  });
  return{store,a,b,history,call,stickerCalls,setPause:fn=>{pause=fn;}};
}

test('history HTTP search, context, lazy preview and quoted admission use one authorized source contract',async t=>{
  const f=await setup(t);
  assert.equal((await f.call(null,'GET','/api/pwa/history/search')).status,401);
  const me=await f.call(f.a,'GET','/api/pwa/me');assert.equal(me.body.capabilities.historySearch,true);assert.equal(me.body.capabilities.stickers,true);
  const search=await f.call(f.a,'GET',`/api/pwa/history/search?q=${encodeURIComponent('原话')}`);assert.equal(search.status,200,search.text);const ref=search.body.records[0].id;
  const context=await f.call(f.a,'GET',`/api/pwa/history/context?ref=${ref}`);assert.equal(context.body.record.id,ref);assert.equal(context.body.records.length,2);
  assert.equal((await f.call(f.a,'GET',`/api/pwa/references?ref=${ref}`)).body.record.text,'真正留存的原话');
  assert.equal((await f.call(f.b,'GET',`/api/pwa/references?ref=${ref}`)).status,404);
  assert.equal((await f.call(f.b,'POST','/api/pwa/messages',{clientMessageId:'forged',text:'x',replyTo:ref})).status,404);
  const accepted=await f.call(f.a,'POST','/api/pwa/messages',{clientMessageId:'quote',text:'是这句',replyTo:ref});assert.equal(accepted.status,200,accepted.text);assert.equal(accepted.body.message.replyTo,ref);
  const retried=await f.call(f.a,'POST','/api/pwa/messages',{clientMessageId:'quote',text:'是这句',replyTo:ref});assert.equal(retried.body.duplicate,true);
  const invalid=await f.call(f.a,'GET','/api/pwa/history/search?from=2026-02-30');assert.equal(invalid.status,400);
});

test('revocation during source resolution cannot persist quoted intake or expose returned history',async t=>{
  const f=await setup(t),ref=(await f.history.search(f.a.id,{q:'原话'})).records[0].id;
  let entered,release;const started=new Promise(resolve=>{entered=resolve;});
  f.setPause(()=>{entered();return new Promise(resolve=>{release=resolve;});});
  const sending=f.call(f.a,'POST','/api/pwa/messages',{clientMessageId:'late',text:'no admission',replyTo:ref});
  await started;f.store.revokeSession(f.a.session.session.id);release();
  const rejected=await sending;assert.equal(rejected.status,401,rejected.text);assert.equal(f.store.readHistoryMessages(f.a.id).length,0);
});

test('sticker routes pass authenticated user, decode shared IDs, require CSRF and enforce read-only on every mutation',async t=>{
  const f=await setup(t),id='12345678-1234-4234-8234-123456789012',shared=`shared:${'a'.repeat(64)}`;
  assert.equal((await f.call(f.a,'GET','/api/pwa/stickers?view=recent&cursor=abc')).status,200);
  assert.deepEqual(f.stickerCalls[0],['list',f.a.id,{view:'recent',limit:60,cursor:'abc'}]);
  assert.equal((await f.call(f.a,'POST','/api/pwa/stickers',{mediaId:id,name:'喜欢'})).status,200);
  assert.equal((await f.call(f.a,'POST',`/api/pwa/stickers/${encodeURIComponent(shared)}/select`,{})).status,200);
  assert.equal(f.stickerCalls.at(-1)[2],shared);
  assert.equal((await f.call(f.a,'DELETE',`/api/pwa/stickers/${id}`,{})).status,200);
  assert.equal((await f.call(f.a,'POST','/api/pwa/stickers',{mediaId:id},{'X-CSRF-Token':'bad'})).status,403);
  const locked=await setup(t,{readOnly:true});
  for(const [method,path,data] of [['POST','/api/pwa/stickers',{mediaId:id}],['DELETE',`/api/pwa/stickers/${id}`,{}],['POST',`/api/pwa/stickers/${id}/select`,{}],
    ['POST',`/api/pwa/%73tickers/${encodeURIComponent(shared)}/select`,{}],['DELETE',`/api/pwa/%73tickers/${id}`,{}],
    ['POST','/api/pwa/%73tickers',{mediaId:id}],['POST',`/api/%70wa/%73tickers/${id}%2Fselect`,{}]])
    assert.equal((await locked.call(locked.a,method,path,data)).status,503);
  assert.equal(locked.stickerCalls.length,0);
  assert.equal((await locked.call(locked.a,'POST','/api/pwa/stickers/%zz/select',{})).status,400);
  assert.equal((await locked.call(locked.a,'GET','/api/pwa/%00stickers')).status,400);
});
