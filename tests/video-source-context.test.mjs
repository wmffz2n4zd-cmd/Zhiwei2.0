import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createVideoSourceContext, videoQuestionTimestamp, isVideoFollowup } from '../src/video-source-context.js';
import { parseSharedVideoLinks } from '../src/video-reader.js';

const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const scope = {kind:'private',contactId:'synthetic-a',memoryEpoch:'epoch-1'};
const row = (id,text) => ({id,text,fingerprint:createHash('sha256').update(text).digest('hex')});
function fixture() {
  let at=1000;const rows=new Map();const context=createVideoSourceContext({now:()=>at,ttlMs:100});
  const select=options=>context.select({scope,resolveSource:async id=>rows.get(id),...options});
  return {rows,context,select,setTime:value=>{at=value}};
}

test('timestamp parsing accepts actual question/link times and leaves ordinary unrelated statements alone',()=>{
  assert.equal(videoQuestionTimestamp('刚才视频00:18那里是什么'),18);
  assert.equal(videoQuestionTimestamp('1分23秒画面里是什么'),83);
  assert.equal(videoQuestionTimestamp('00:99画面里是什么'),null);
  assert.equal(videoQuestionTimestamp('24分30秒画面里是什么'),null);
  assert.equal(parseSharedVideoLinks(url+'&t=1m23s')[0].atSeconds,83);
  assert.equal(parseSharedVideoLinks(url+'#t=18')[0].atSeconds,18);
  assert.equal(isVideoFollowup('今天00:18去吃饭'),false);
  assert.equal(isVideoFollowup('刚才视频00:18那里是什么'),true);
});

test('busy sanitized message resolves source only from real current inbox row',async()=>{
  const f=fixture(),original=row('pwa:one',url);f.rows.set(original.id,original);
  const selected=await f.select({text:'[链接未打开]\n还有字幕在说什么',currentSources:[original]});
  assert.equal(selected.url,url);assert.equal(selected.sourceRef,original.id);assert.equal(selected.selection,'current');
});

test('explicit followup uses exact validated last source and timestamp, separate scope or epoch cannot use it',async()=>{
  const f=fixture(),original=row('pwa:one',url);f.rows.set(original.id,original);
  await f.select({text:url,currentSources:[original]});
  const found=await f.select({text:'刚才视频00:18那里是什么'});assert.equal(found.url,url);assert.equal(found.atSeconds,18);assert.equal(found.selection,'followup');
  assert.equal(await f.select({scope:{...scope,contactId:'synthetic-b'},text:'刚才视频00:18那里是什么'}),null);
  assert.equal(await f.select({scope:{...scope,memoryEpoch:'epoch-2'},text:'刚才视频00:18那里是什么'}),null);
  assert.equal(await f.select({text:'随便聊聊天'}),null);
});

test('removed/edited original source cannot authorize followup and source ref is never minted from model text',async()=>{
  const f=fixture(),original=row('pwa:one',url);f.rows.set(original.id,original);
  assert.equal(await f.select({text:url}),null,'text without actual accepted source row is not provenance');
  await f.select({text:url,currentSources:[original]});f.rows.set(original.id,row(original.id,'edited'));
  await assert.rejects(f.select({text:'刚才视频00:18那里是什么'}),{code:'HISTORY_SOURCE_CHANGED'});
});

test('TTL or invalidation removes implicit pointers; quoted source can rehydrate after a new process',async()=>{
  const f=fixture(),original=row('pwa:one',url);f.rows.set(original.id,original);
  await f.select({text:url,currentSources:[original]});f.setTime(1101);
  assert.equal(await f.select({text:'刚才视频00:18那里是什么'}),null);
  await f.select({text:'这个视频字幕呢',quotedSources:[original]});f.context.invalidate(scope.contactId);
  assert.equal(await f.select({text:'刚才视频00:18那里是什么'}),null);
  const fresh=createVideoSourceContext();assert.equal(await fresh.select({scope,text:'刚才视频00:18那里是什么',resolveSource:async id=>f.rows.get(id)}),null);
  const selected=await fresh.select({scope,text:'这个视频1分2秒那里是什么',quotedSources:[original],resolveSource:async id=>f.rows.get(id)});
  assert.equal(selected.selection,'quote');assert.equal(selected.atSeconds,62);
});

test('async source invalidation is checked across resolver wait',async()=>{
  const f=fixture(),original=row('pwa:one',url);f.rows.set(original.id,original);let current=true;
  await assert.rejects(f.select({text:url,currentSources:[original],resolveSource:async id=>{current=false;return f.rows.get(id)},
    assertCurrent:async()=>{await Promise.resolve();if(!current)throw Object.assign(Error('changed'),{code:'MEMORY_EPOCH_CHANGED'})}}),{code:'MEMORY_EPOCH_CHANGED'});
  assert.equal(f.context.getStatus().sources,0);
});
