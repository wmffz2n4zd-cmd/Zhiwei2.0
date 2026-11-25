import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { canonicalVideoUrl } from '../src/video-reader.js';
import { requestKind } from '../src/video-session-network.js';
import { inspectPlayer } from '../src/video-session-player.js';

test('Bilibili can add its non-content vd_source tag while the video and actual part stay fixed',()=>{
  const source=canonicalVideoUrl('https://www.bilibili.com/video/BV1K54y1r7dU/');
  const data={title:'Synthetic clip',aid:123,bvid:source.id,rights:{pay:0,ugc_pay:0},state:0,pubdate:1700000000,is_upower_exclusive:false,
    is_view_self:false,cid:832,pages:[{page:1,cid:832,duration:136}]};
  function check(url){
    const context={URL,window:{__INITIAL_STATE__:{videoData:data}},location:{href:url},
      source:{...source,signedMetadataOnly:true,listing:'platform_publication_required'},document:{querySelector:()=>null,querySelectorAll:()=>[]}};
    return vm.runInNewContext('('+inspectPlayer.toString()+')(source)',context);
  }
  for(const motion of ['/?vd_source=synthetic','?vd_source=synthetic&p=1','/?p=1&vd_source=synthetic']){
    const url=source.url+motion;assert.equal(requestKind(source,url,'GET','document',true),'first');assert.equal(check(url).cid,832);
  }
  for(const suffix of ['/?p=2&vd_source=synthetic','/?vd_source=synthetic&other=unknown','/?p=1&p=2']){
    const url=source.url+suffix;assert.equal(requestKind(source,url,'GET','document',true),null);assert.equal(check(url).unknown,true);
  }
  assert.equal(requestKind(source,source.url.replace(source.id,'BV1xx411c7mD')+'/?vd_source=synthetic','GET','document',true),null);
});
