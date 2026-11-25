import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUnifiedMemory, memoryScope } from '../src/unified-memory/index.js';
import { isPrivateScope } from '../src/private-scope.js';
import { MoodState } from '../src/mood-state.js';

const scope='private:user:11111111-1111-4111-8111-111111111111';
test('new PWA scopes remain separate; missing identity never falls back to owner',()=>{
  assert.equal(isPrivateScope(scope),true);
  assert.equal(memoryScope({type:'private_message',channel:'pwa',senderId:'x',privateIdentity:{userId:'x',memoryScope:scope}}),scope);
  assert.throws(()=>memoryScope({type:'private_message',channel:'pwa',senderId:123}));
  assert.throws(()=>memoryScope({type:'private_message',senderId:'owner'}));
  assert.throws(()=>memoryScope({type:'private_message',channel:'pwa',groupId:1,privateIdentity:{userId:'x',memoryScope:scope}}));
});
test('mailbox replay across restart commits one dialogue, profile and learning source; clear blocks resurrection',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pwa-project-')),path=join(dir,'memory.json');
  let memory=createUnifiedMemory({memoryPath:path});
  const epochToken=await memory.captureEpoch({scope});
  const enabled=await memory.readLearningSnapshot({scope});
  const input={scope,deliveryId:'pwa:test:1',channel:'pwa',userText:'我喜欢看星星',replyText:'今晚的天空很亮。',messageId:'a',sentMessageIds:['b'],learningEligible:true,epochToken};
  const first=await memory.writeExchange(input);assert.equal(first.ok,true);
  memory=createUnifiedMemory({memoryPath:path});
  const retry=await memory.writeExchange(input);assert.equal(retry.duplicate,true);assert.equal(retry.entry.id,first.entry.id);
  const snapshot=await memory.readLearningSnapshot({scope,after:enabled.cursor});assert.equal(snapshot.sources.length,1);
  await assert.rejects(memory.writeExchange({...input,replyText:'另一个答案。'}),/Conflicting/);
  await memory.clear({scope});assert.equal((await memory.writeExchange(input)).reason,'memory-epoch-changed');
  assert.equal((await memory.read({scope})).entries.length,0);
});
test('mood projection survives restart, CAS replay does not apply twice',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pwa-mood-')),path=join(dir,'memory.json');let now=100000;
  const memory=createUnifiedMemory({memoryPath:path,now:()=>now});
  const event={type:'private_message',channel:'pwa',senderId:'11111111-1111-4111-8111-111111111111',text:'你怎么了',raw:{message_id:'m1'},privateIdentity:{userId:'a',memoryScope:scope},memoryEpochToken:await memory.captureEpoch({scope})};
  let mood=new MoodState({memory,now:()=>now});await mood.prepare(event);
  mood.finalize('刚才试验失败，有点不爽。[[qq_mood:{"phase":"guarded","cause":"试验失败","intensity":1}]]',event);
  const material=JSON.parse(JSON.stringify(mood.exportPending(event)));assert.ok(material);
  mood=new MoodState({memory,now:()=>now});assert.equal((await mood.commitProjection(material,'mood:1')).ok,true);
  // One mailbox delivery projects into multiple independent sinks.
  assert.equal((await memory.writeExchange({scope,deliveryId:'mood:1',channel:'pwa',userText:'你怎么了',replyText:'刚才试验失败，有点不爽。',epochToken:event.memoryEpochToken})).ok,true);
  const before=JSON.parse(await readFile(path,'utf8')).entries;
  assert.equal((await mood.commitProjection(material,'mood:1')).duplicate,true);
  const after=JSON.parse(await readFile(path,'utf8')).entries;assert.deepEqual(after,before);
});
test('legacy history exposes retained originals for the verified scope only and observes clear',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pwa-legacy-'));let now=100000;
  const memory=createUnifiedMemory({memoryPath:join(dir,'memory.json'),now:()=>now});
  await memory.writeExchange({scope:'qq:private:1',userText:'老消息甲',replyText:'原答甲',sentMessageIds:['qq-1']});now++;
  await memory.write({scope:'qq:private:1',source:'manual',summary:'推测摘要不能变聊天记录'});now++;
  await memory.writeExchange({scope:'qq:private:2',userText:'另一人',replyText:'另一人的答案',sentMessageIds:['qq-2']});now++;
  await memory.writeOutbound({scope:'qq:private:1',replyText:'主动原文',intentId:'old-intent',sentMessageIds:['qq-3']});now++;
  await memory.writeExchange({scope:'qq:private:1',channel:'pwa',userText:'新PWA消息',replyText:'新答案',sentMessageIds:['pwa-1']});
  const latest=await memory.readLegacyHistory({scope:'qq:private:1',limit:1});
  assert.equal(latest.records[0].replyText,'主动原文');assert.equal(latest.hasMore,true);
  const older=await memory.readLegacyHistory({scope:'qq:private:1',before:latest.nextBefore});
  assert.deepEqual(older.records.map(x=>x.userText),['老消息甲']);assert.equal(older.hasMore,false);
  const other=await memory.readLegacyHistory({scope:'qq:private:2'});
  await assert.rejects(memory.readLegacyHistory({scope:'qq:private:1',before:other.records[0].id}),/cursor unavailable/);
  await memory.clear({scope:'qq:private:1'});assert.deepEqual((await memory.readLegacyHistory({scope:'qq:private:1'})).records,[]);
});
