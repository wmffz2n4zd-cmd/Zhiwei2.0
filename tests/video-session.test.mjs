import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { collect, selectTrack } from '../scripts/video-session-worker.mjs';
import { requestKind, hostKind } from '../src/video-session-network.js';
import { inspectPlayer, captureVideo, readTrack } from '../src/video-session-player.js';
import { publishedListing } from '../src/video-public-listing.js';
import { canonicalVideoUrl, createVideoReader, formatVideoEvidence } from '../src/video-reader.js';

const yt = canonicalVideoUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw');
const bili = canonicalVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=2');
const jpg = Buffer.from('ffd8ffe000104a46494600ffd9', 'hex');
const track = { kind: 'human', language: 'en', url: 'https://www.youtube.com/api/timedtext?v=' + yt.id + '&sig=synthetic-marker' };
const meta = { duration: 12, title: 'Test video' };
const scope = { kind: 'private', contactId: 'synthetic', memoryEpoch: 'one' };

test('only the canonical document, player reads and target platform HTTPS asset endpoints are admitted', () => {
  assert.equal(requestKind(yt, yt.url, 'GET', 'document', true), 'first');
  assert.equal(requestKind(yt, track.url, 'GET', 'fetch', false), 'first');
  assert.equal(requestKind(yt, 'https://r1.googlevideo.com/videoplayback?sig=redacted', 'GET', 'media', false), 'asset');
  assert.equal(requestKind(bili, 'https://i0.hdslb.com/bfs/subtitle/current.json', 'GET', 'fetch', false), 'asset');
  const bound = {...bili,expectedCid:832,expectedAid:123};
  assert.equal(requestKind(bound, 'https://api.bilibili.com/x/player/wbi/v2?cid=832&aid=123', 'GET','xhr',false),'first');
  assert.equal(requestKind(bound, 'https://api.bilibili.com/x/player/wbi/v2?cid=999&aid=123', 'GET','xhr',false),null);
  assert.equal(requestKind(bound, 'https://api.bilibili.com/x/player/wbi/v2?cid=832&aid=999', 'GET','xhr',false),null);
  for (const [source, url, method, type, main] of [
    [yt, yt.url + '&token=wrong', 'GET', 'document', true], [yt, yt.url, 'GET', 'document', false],
    [yt, yt.url.replace(yt.id,'aaaaaaaaaaa'), 'GET', 'document', true], [yt, track.url.replace(yt.id,'aaaaaaaaaaa'), 'GET', 'fetch', false],
    [yt, 'https://www.youtube.com/youtubei/v1/like/like', 'POST', 'fetch', false],
    [yt, 'https://www.youtube.com/api/stats/watchtime', 'GET', 'xhr', false],
    [yt, 'https://www.youtube.com/playlist?list=WL', 'GET', 'document', true],
    [yt, 'https://api.bilibili.com/x/player/v2', 'GET', 'fetch', false],
    [bili, 'https://api.bilibili.com/x/web-interface/archive/like', 'POST', 'xhr', false],
    [bili, 'https://api.bilibili.com/x/space/myinfo', 'GET', 'xhr', false],
    [yt, 'https://foo.googlevideo.com:444/videoplayback', 'GET', 'media', false],
    [yt, 'https://googlevideo.com.attacker.invalid/videoplayback', 'GET', 'media', false],
    [yt, 'http://www.youtube.com/watch?v=' + yt.id, 'GET', 'document', true],
    [yt, 'https://127.0.0.1/x.js', 'GET', 'script', false]]) {
    assert.equal(requestKind(source, url, method, type, main), null);
  }
  assert.equal(hostKind('youtube','accounts.google.com'), null);
  assert.equal(hostKind('bilibili','passport.bilibili.com'), null);
});

test('nonpublic and unknown metadata, unexpected video id and ad intervals cannot supply content', () => {
  const resp = { playabilityStatus: { status: 'OK' }, videoDetails: { videoId: yt.id, isPrivate: false, lengthSeconds: 12, title: meta.title },
    microformat: { playerMicroformatRenderer: { isUnlisted: false, isFamilySafe: true } }, streamingData: { formats: [{ mimeType:'video/mp4' }] } };
  const active = { mediaKeys: null, readyState: 4, duration: 12 };
  const player = { classList: { contains: () => false }, getPlayerResponse: () => resp, getVideoData: () => ({video_id:yt.id}), querySelector: () => active };
  const env = { URL, location: { href: yt.url }, document: { querySelectorAll: () => [], querySelector: () => player }, window: {}, source: { ...yt, publicProofOnly: true } };
  const inspect = () => vm.runInNewContext('(' + inspectPlayer.toString() + ')(source)', env);
  assert.equal(inspect().duration,12);
  resp.videoDetails.isPrivate = true; assert.equal(inspect().restricted,true); resp.videoDetails.isPrivate = false;
  delete resp.microformat.playerMicroformatRenderer.isUnlisted; assert.equal(inspect().unknown,true);
  resp.microformat.playerMicroformatRenderer.isUnlisted = false; resp.playabilityStatus.status = 'LOGIN_REQUIRED'; assert.equal(inspect().restricted,true);
  resp.playabilityStatus.status = 'OK'; resp.videoDetails.videoId='aaaaaaaaaaa'; assert.equal(inspect().unknown,true);
  resp.videoDetails.videoId=yt.id; player.classList.contains=()=>true; assert.equal(inspect(),null);
});

test('Bilibili guest proof requires the same free public part and full-length player stream', () => {
  const part = {page:2,cid:832,duration:12}, data={title:meta.title,bvid:bili.id,state:0,rights:{pay:0},cid:832,pages:[part]};
  const env={URL, location:{href:bili.url},document:{querySelectorAll:()=>[],querySelector:()=>null},
    window:{__INITIAL_STATE__:{videoData:data},__playinfo__:{data:{dash:{video:[{}]},timelength:12000}}},source:{...bili,publicProofOnly:true}};
  const inspect=()=>vm.runInNewContext('('+inspectPlayer.toString()+')(source)',env);
  assert.equal(inspect().cid,832);
  data.rights.pay=1; assert.equal(inspect().restricted,true); data.rights.pay=0;
  data.is_upower_exclusive=true; assert.equal(inspect().restricted,true); data.is_upower_exclusive=false;
  data.cid=987; assert.equal(inspect().unknown,true); data.cid=832;
  env.window.__playinfo__.data.timelength=2600; assert.equal(inspect(),null);
});

test('unsupported tracks, unrelated subtitles, credentials and unsafe artifact URLs never reach selection', () => {
  assert.deepEqual(selectTrack(yt,[{...track,kind:'automatic'},track]),track);
  for (const url of ['https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa','https://me:password@www.youtube.com/api/timedtext?v='+yt.id,
    'https://other.invalid/caption','https://www.youtube.com/s/player/bad.js']) assert.equal(selectTrack(yt,[{...track,url}]),undefined);
  assert.equal(selectTrack(yt,[{...track,language:'danmaku'}]),undefined);
});

test('no guest proof means zero access to the dedicated profile; a different duration or title is rejected',async()=>{
  let opens=0; const open=async()=>{opens++;return {meta,tracks:()=>[]};};
  assert.equal((await collect(yt,'probe',null,'unused',async()=>null,open)).status,'unavailable');
  assert.equal((await collect(yt,'probe',null,'unused',async()=>({restricted:true}),open)).status,'restricted');
  assert.equal(opens,0);
  assert.equal((await collect(yt,'probe',null,'unused',async()=>({...meta,duration:20}),open)).status,'unavailable');
  assert.equal((await collect(yt,'probe',null,'unused',async()=>({...meta,title:'different'}),open)).status,'unavailable');
  assert.equal(opens,2);
});

test('ordinary reader, cache probe, true sourceAccess and requested-time evidence fit the final prompt budget',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'s132-reader-'));const seen=[];let restricted=false;
  const page={async evaluate(fn,arg){
    if(fn===readTrack) return Array.from({length:390},(_,i)=>({start:i,end:i+1,text:i===377?'TARGET-LATE-CUE':'early '.repeat(30)}));
    if(fn===captureVideo){seen.push(arg.target);return {stamp:arg.target,jpeg:jpg.toString('base64')};}
    if(fn===inspectPlayer) return {...meta,duration:390}; throw Error();
  }};
  const current={...meta,duration:390};
  const reader=createVideoReader({directory:dir,worker:async({mode,outputDir,atSeconds})=>collect(yt,mode,atSeconds??null,outputDir,
    async()=>restricted?{restricted:true}:current,async()=>({meta:current,page,tracks:()=>[track]}))});
  t.after(async()=>{await reader.close();await rm(dir,{recursive:true,force:true});});
  const opts={scope,url:yt.url,atSeconds:377.5};
  const first=await reader.read(opts);
  assert.equal(first.status,'ok');assert.equal(first.atSeconds,377.5);assert.equal(first.sourceAccess,'dedicated_browser_public');
  assert.deepEqual(seen,[376.5,377.5,378.5]);assert.deepEqual(await readFile(first.frames[1].path),jpg);
  assert.match(formatVideoEvidence(first,{maxChars:950}),/377–378秒.*TARGET-LATE-CUE/);
  assert.doesNotMatch(JSON.stringify(first),/synthetic-marker|api\/timedtext/);await first.release();
  const hit=await reader.read(opts);assert.equal(hit.cached,true);await hit.release();assert.equal(seen.length,3);
  restricted=true;const expired=await reader.read(opts);assert.equal(expired.status,'restricted');assert.equal(reader.getStatus().cached,0);
});

test('same-item public/free declarations allow signed YouTube metadata without guest streaming; paid and member declarations win', () => {
  const rsp={playabilityStatus:{status:'OK'},videoDetails:{videoId:yt.id,title:meta.title,lengthSeconds:12,isPrivate:false},
    microformat:{playerMicroformatRenderer:{isUnlisted:false,isFamilySafe:true}}};
  const props={videoId:yt.id,url:yt.url,isAccessibleForFree:'true'};
  const scopeNode={querySelectorAll(q){
    const keys=q.includes(',') ? ['url','embedUrl'] : [q.match(/"([^"]+)"/)[1]];
    return keys.filter(k=>props[k]!==undefined).map(k=>({closest:()=>scopeNode,getAttribute:()=>props[k]}));
  }};
  const badge={style:'BADGE_STYLE_TYPE_PUBLIC'};
  const root={URL,window:{ytInitialData:{contents:{twoColumnWatchNextResults:{results:{results:{contents:[{videoPrimaryInfoRenderer:{badges:[{metadataBadgeRenderer:badge}]}}]}}}}}},
    document:{querySelectorAll(q){return q.startsWith('[itemscope]')?[scopeNode]:[];},querySelector(){return {getPlayerResponse:()=>rsp,classList:{contains:()=>false},querySelector:()=>null};}},
    location:{href:yt.url},source:{...yt,listing:'platform_publication_required',requiresFree:true,signedMetadataOnly:true}};
  const inspect=()=>vm.runInNewContext('('+inspectPlayer.toString()+')(source)',root);
  assert.equal(inspect().free,true);
  props.url=yt.url.replace(yt.id,'abcdefghijk');assert.equal(inspect().needsGuestPlayback,true);
  props.url=yt.url;props.videoId=yt.id.toLowerCase();assert.equal(inspect().needsGuestPlayback,true);
  props.videoId=yt.id;props.paid='true';assert.equal(inspect().restricted,true);
  delete props.paid;badge.style='BADGE_STYLE_TYPE_MEMBERS_ONLY';assert.equal(inspect().restricted,true);
  badge.style='BADGE_STYLE_TYPE_PUBLIC';delete props.isAccessibleForFree;assert.equal(inspect().needsGuestPlayback,true);
});

test('Bilibili direct declared public archive and separate first-party listing do not depend on a guest media URL',()=>{
  const d={title:meta.title,bvid:bili.id,aid:123,cid:832,state:0,pubdate:1700000000,rights:{pay:0,ugc_pay:0},
    is_view_self:false,is_upower_exclusive:false,pages:[{page:2,cid:832,duration:12}]};
  const root={URL,window:{__INITIAL_STATE__:{videoData:d}},document:{querySelectorAll:()=>[],querySelector:()=>null},location:{href:bili.url},
    source:{...bili,listing:'platform_publication_required',signedMetadataOnly:true}};
  const inspect=()=>vm.runInNewContext('('+inspectPlayer.toString()+')(source)',root);
  assert.equal(inspect().cid,832);assert.equal(publishedListing(bili,{code:0,data:d}).cid,832);
  delete d.is_view_self;assert.equal(inspect().needsPublishedArchive,true);
  delete d.is_upower_exclusive;assert.equal(inspect().unknown,true);assert.equal(publishedListing(bili,{code:0,data:d}),null);
  d.is_upower_exclusive=true;assert.equal(inspect().restricted,true);assert.equal(publishedListing(bili,{code:0,data:d}).restricted,true);
  d.is_upower_exclusive=false;d.is_view_self=true;assert.equal(inspect().restricted,true);
  delete d.is_view_self;d.bvid='BV1notTarget';assert.equal(publishedListing(bili,{code:0,data:d}),null);
});

test('bound publication check rejects paid or newly unverifiable material at end of a read',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'s132-publication-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const [revocation,expected] of [[{restricted:true},'restricted'],[{...meta,needsGuestPlayback:true},'unavailable'],
    [{...meta,cid:832,needsPublishedArchive:true},'unavailable']]){
    const page={evaluate:async fn=>fn===captureVideo?null:meta};
    const selected = revocation.cid ? {...meta,cid:revocation.cid} : meta;
    const result=await collect(revocation.cid ? bili : yt,'read',1,dir,async()=>({listing:'platform_publication_required'}),
      async()=>({meta:selected,page,publicationVerified:true,tracks:()=>[],current:async()=>revocation}));
    assert.equal(result.status,expected);assert.deepEqual(result.frames,[]);assert.deepEqual(result.subtitles,[]);
  }
});

