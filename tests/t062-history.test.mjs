import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPwaStore } from '../src/pwa-store.js';
import { createPwaHistory } from '../src/pwa-history.js';
import { createUnifiedMemory } from '../src/unified-memory/index.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(),'t062-history-')); let at = Date.parse('2026-11-17T08:00:00Z');
  const path = join(dir,'pwa.sqlite'); let store = createPwaStore({path,now:()=>at});
  const a = store.claimInvitation({token:store.createInvitation({memoryScope:'qq:private:111'}).token,username:'alice',displayName:'A',passwordHash:'test'}).user;
  store.verifyBinding(a.id);
  const b = store.claimInvitation({token:store.createInvitation({memoryScope:'qq:private:222'}).token,username:'bob',displayName:'B',passwordHash:'test'}).user;
  store.verifyBinding(b.id);
  let records = [{id:'retained-1',at:'2026-11-16T15:59:00Z',userText:'旧原文 星河 出发',replyText:'记得星河',truncated:false},
    {id:'retained-2',at:'2026-11-16T16:00:00Z',userText:'次日 星河 [图片]',replyText:'末尾留存',truncated:true,originalLengths:{userText:40,replyText:4}}];
  const read = async ({scope}) => ({records:scope==='qq:private:111'?structuredClone(records):[{id:'other',at:'2026-11-16T12:00:00Z',userText:'BOB_PRIVATE',replyText:'私有'}]});
  let history = createPwaHistory({store,readLegacyHistorySnapshot:read});
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  return {dir,path,a,b,get store(){return store;},get history(){return history;},setRecords:value=>{records=value;},advance:n=>{at+=n;},
    reopen(){store.close();store=createPwaStore({path,now:()=>at});history=createPwaHistory({store,readLegacyHistorySnapshot:read});}};
}

test('search uses complete retained original text across new and old records and filters Shanghai dates/speakers',async t=>{
  const f=await setup(t);
  for(let i=0;i<205;i++)f.store.acceptInbound({userId:f.a.id,clientMessageId:`m${i}`,text:i===0?'网页 星河 尾部':'普通消息'});
  const found=await f.history.search(f.a.id,{q:'星河'});
  assert.equal(found.records.length,4);assert.equal(found.records.filter(r=>r.source==='pwa').length,1);
  assert.ok(found.records.every(r=>r.createdAt.endsWith('Z')));
  const day=await f.history.search(f.a.id,{from:'2026-11-17',to:'2026-11-17',source:'qq',speaker:'user'});
  assert.equal(day.records.length,1);assert.match(day.records[0].text,/次日/);assert.equal(day.records[0].truncated,true);assert.equal(day.records[0].mediaMissing,true);
  const reply=await f.history.search(f.a.id,{q:'末尾',speaker:'assistant'});assert.equal(reply.records[0].truncated,false);
  assert.equal((await f.history.search(f.a.id,{q:'BOB_PRIVATE'})).records.length,0);
  assert.equal((await f.history.search(f.a.id,{q:'未留存'})).records.length,0);
});

test('stable paging ignores newly arriving web messages, and incompatible query/cross-user cursors are refused',async t=>{
  const f=await setup(t);
  for(let i=0;i<5;i++){f.advance(1000);f.store.acceptInbound({userId:f.a.id,clientMessageId:`m${i}`,text:`星河${i}`});}
  const first=await f.history.search(f.a.id,{source:'pwa',limit:2});
  f.advance(1000);const added=f.store.acceptInbound({userId:f.a.id,clientMessageId:'later',text:'new'}).message;
  const second=await f.history.search(f.a.id,{source:'pwa',limit:2,cursor:first.nextCursor});
  const third=await f.history.search(f.a.id,{source:'pwa',limit:2,cursor:second.nextCursor});
  const ids=[...first.records,...second.records,...third.records].map(r=>r.id);
  assert.equal(ids.length,5);assert.equal(new Set(ids).size,5);assert.equal(ids.includes(added.id),false);assert.equal(third.hasMore,false);
  await assert.rejects(f.history.search(f.b.id,{source:'pwa',cursor:first.nextCursor}),/invalid-history-cursor/);
  await assert.rejects(f.history.search(f.a.id,{source:'pwa',q:'changed',cursor:first.nextCursor}),/invalid-history-cursor/);
});

test('legacy reference survives restart and context keeps exchange speakers in order',async t=>{
  const f=await setup(t),before=await f.history.search(f.a.id,{q:'旧原文'}),ref=before.records[0].id;
  f.reopen();assert.equal((await f.history.resolve(f.a.id,ref)).text,'旧原文 星河 出发');
  const context=await f.history.context(f.a.id,ref);
  const pair=context.records.filter(r=>r.createdAt==='2026-11-16T15:59:00.000Z');assert.deepEqual(pair.map(r=>r.speaker),['user','assistant']);
  await assert.rejects(f.history.resolve(f.b.id,ref),/reference-unavailable/);
  const accepted=await f.history.acceptInbound(f.a.id,{clientMessageId:'quote',text:'这个呢',replyTo:ref});
  assert.equal(accepted.message.replyTo,ref);
  assert.throws(()=>f.store.acceptInbound({userId:f.b.id,clientMessageId:'forged',text:'x',replyTo:ref,referenceAdmission:{}}),/reply-unavailable/);
});

test('deleted or corrected originals invalidate IDs; retry acknowledgement does not duplicate accepted message',async t=>{
  const f=await setup(t),ref=(await f.history.search(f.a.id,{q:'旧原文'})).records[0].id;
  const input={clientMessageId:'quote',text:'引用',replyTo:ref};const original=await f.history.acceptInbound(f.a.id,input);
  const page=await f.history.search(f.a.id,{limit:1});
  f.setRecords([{id:'retained-1',at:'2026-11-16T15:59:00Z',userText:'修正的原文',replyText:'改变'}]);
  await assert.rejects(f.history.resolve(f.a.id,ref),/reference-unavailable/);
  await assert.rejects(f.history.acceptInbound(f.a.id,{...input,clientMessageId:'new'}),/reference-unavailable/);
  const retry=await f.history.acceptInbound(f.a.id,input);assert.equal(retry.duplicate,true);assert.equal(retry.message.id,original.message.id);
  await assert.rejects(f.history.acceptInbound(f.a.id,{...input,text:'different'}),/message-id-conflict/);
  await assert.rejects(f.history.search(f.a.id,{limit:1,cursor:page.nextCursor}),/history-changed-refresh/);
});

test('retained quoted fragments stay distinct from user words, are searchable once and invalidate corrected references',async t=>{
  const f=await setup(t),entry={id:'quoted-entry',at:'2026-11-16T15:59:00Z',userText:'我不同意',replyText:'我知道了',quotedText:'QUOTE_FRAGMENT 第三方当年的话',
    truncated:true,originalLengths:{userText:4,replyText:4,quotedText:100}};
  f.setRecords([entry]);
  const result=await f.history.search(f.a.id,{q:'QUOTE_FRAGMENT'});
  assert.equal(result.records.length,1);assert.equal(result.records[0].speaker,'user');
  assert.equal(result.records[0].text,'我不同意');assert.equal(result.records[0].matchIn,'quotedText');
  assert.equal(result.records[0].quotedText,entry.quotedText);assert.equal(result.records[0].quotedTruncated,true);assert.equal(result.records[0].truncated,false);
  const assistant=(await f.history.search(f.a.id,{speaker:'assistant'})).records[0];assert.equal(assistant.quotedText,'');
  assert.equal((await f.history.search(f.b.id,{q:'QUOTE_FRAGMENT'})).records.length,0);
  f.setRecords([{...entry,quotedText:'更正后的第三方引用'}]);
  await assert.rejects(f.history.resolve(f.a.id,result.records[0].id),/reference-unavailable/);
  assert.equal((await f.history.resolve(f.a.id,assistant.id)).text,'我知道了');
  f.setRecords([{...entry,userText:'',originalLengths:{userText:0,replyText:4,quotedText:100}}]);
  const quoteOnly=await f.history.search(f.a.id,{q:'QUOTE_FRAGMENT'});assert.equal(quoteOnly.records.length,1);assert.equal(quoteOnly.records[0].text,'');
});

test('source and date/query validation do not turn malformed input into broad search',async t=>{
  const f=await setup(t);
  for(const options of [{from:'2026-02-30'},{from:'2026-11-18',to:'2026-11-17'},{speaker:'admin'},{q:'x\u0000y'},{limit:101},{cursor:'bad!'}])
    await assert.rejects(f.history.search(f.a.id,options));
  assert.equal((await f.history.search(f.a.id,{q:'%'})).records.length,0,'SQL wildcards are literal');
});

test('identity and session changes during async legacy read prevent read disclosure and message admission',async t=>{
  const f=await setup(t);let release,entered;const enteredPromise=new Promise(resolve=>{entered=resolve;});
  const service=createPwaHistory({store:f.store,readLegacyHistorySnapshot:async()=>{entered();await new Promise(resolve=>{release=resolve;});return{records:[]};}});
  const pending=service.search(f.a.id);await enteredPromise;f.store.disableUser(f.a.id);release();await assert.rejects(pending,/account-unavailable/);
});

test('raw memory adapter excludes summaries, other scopes and PWA projections without rewriting originals',async t=>{
  const f=await setup(t),memoryPath=join(f.dir,'memory.json'),memory=createUnifiedMemory({memoryPath});
  await memory.write({scope:'qq:private:111',summary:'NOT_ORIGINAL'});
  await memory.writeExchange({scope:'qq:private:111',userText:'retained user',replyText:'retained reply',messageId:'q1',sentMessageIds:['q2']});
  await memory.writeExchange({scope:'qq:private:111',userText:'PWA_COPY',replyText:'copy',messageId:'p1',sentMessageIds:['p2'],channel:'pwa'});
  await memory.writeExchange({scope:'qq:private:222',userText:'OTHER_SCOPE',replyText:'other',messageId:'b1',sentMessageIds:['b2']});
  const before=await readFile(memoryPath,'utf8'),result=await memory.readPwaHistory({scope:'qq:private:111'});
  assert.equal(result.records.length,1);assert.equal(result.records[0].userText,'retained user');
  assert.equal(JSON.stringify(result).includes('NOT_ORIGINAL'),false);assert.equal(JSON.stringify(result).includes('OTHER_SCOPE'),false);
  assert.equal(await readFile(memoryPath,'utf8'),before);
  await memory.clear({scope:'qq:private:111'});
  assert.equal((await memory.readPwaHistory({scope:'qq:private:111'})).records.length,0);
  assert.equal((await memory.readPwaHistory({scope:'qq:private:222'})).records.length,1);
});
