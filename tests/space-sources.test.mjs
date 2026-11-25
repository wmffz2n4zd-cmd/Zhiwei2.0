import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createWorld } from '../src/world.js';
import { createLifeTimeline } from '../src/life-timeline.js';
import { lifePlanningContext, lifeSourceRefs } from '../src/life-planner.js';
import { createSpaceTimeline, spaceOpportunity } from '../src/space-timeline.js';
import { createListedSpaceReader, spacePublicationUrl } from '../src/space-sources.js';

const article = 'https://go.dev/blog/go1.22';
const social = 'https://www.xiaohongshu.com/explore/0123456789abcdef12345678';
const video = 'https://www.bilibili.com/video/BV1K54y1r7dU';

test('world projects only independent committed concrete pages; original signed-in text stays local', async t => {
  const root = resolve('runtime/tests');
  await mkdir(root,{recursive:true});
  const projectDir = await mkdtemp(join(root,'space-world-'));
  const timeline = await createLifeTimeline({directory:join(projectDir,'life')});
  let world;
  t.after(async () => {
    await world?.close(); await timeline.close();
    await rm(projectDir,{recursive:true,force:true});
  });
  let blocked = false, requestFollow = false;
  const page = url => ({url, title:'signed-in title marker',text:'signed-in text marker', links:[], imagePaths:[], requiresLogin:blocked});
  const reader = { status:()=>({busy:false,mode:'read'}), close:async()=>{},
    read:async url=>page(url), search:async()=>({...page('https://www.bing.com/search?q=test'),links:[{title:'Source',url:article}]}) };
  world = await createWorld({projectDir, browser:reader,config:{pwa:{spaceEnabled:true},world:{enabled:true},life:{enabled:true},
    runtimeBudget:{enabled:false,mode:'observe'}},recordExperience:value=>timeline.recordExperience(value),
    think:async()=>{const decision = requestFollow ? {action:'follow',linkIndex:0} : {action:'rest'}; requestFollow = false;
      return {text:JSON.stringify(decision),usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}};}});
  await world.run(article,{scope:'qq:private:900000461'});
  requestFollow = true;
  await world.run('公开搜索');
  await world.run(social+'?xsec_token=synthetic');
  await world.run(video+'/?spm_id_from=synthetic');
  await world.run('https://journal.example.org/notes/one/');
  blocked = true; await world.run('https://go.dev/blog/go1.13');
  const events = timeline.snapshot().events.filter(event => event.type === 'experience-recorded');
  assert.equal(events.length,6);
  assert.ok(events[0].source.scope);
  assert.deepEqual(events.slice(0,2).map(e=>spaceOpportunity(e)),[null,null]);
  const opportunities = events.map(e=>spaceOpportunity(e)).filter(Boolean);
  assert.deepEqual(opportunities.map(x=>x.url),[article,social,video,'https://journal.example.org/notes/one/']);
  assert.doesNotMatch(JSON.stringify(opportunities),/signed-in|token|spm_id|900000461/);
});

test('generic post must be anonymously linked from the homepage or its visible parent archive',async()=>{
  const origin = 'https://journal.example.org';
  const post = origin+'/notes/leaves/', index = origin+'/notes/';
  const prose = '落叶中有几片绿色，这篇文章讲了观察的时间地点以及当天的天气。'.repeat(6);
  const urls = [];
  const pages = new Map([[origin+'/', '<a href="/notes/">笔记</a>'],[index,'<a href="/notes/leaves/">落叶</a>'],
    [post, '<title>落叶</title><article>'+prose+'</article>']]);
  const read = createListedSpaceReader({httpClient:async url=>{
    urls.push(url); return {url,status:200,headers:{'content-type':'text/html'},body:pages.get(url)||''};
  }});
  assert.equal((await read(post)).status,'read');
  assert.deepEqual(urls,[origin+'/',index,post]);
  urls.length=0;
  pages.set(index,'<!-- <a href="/notes/leaves/">old</a> --><script>const example=\'<a href="/notes/leaves/">\'</script>');
  assert.equal((await read(post)).status,'unavailable');
  assert.deepEqual(urls,[origin+'/',index]);
  pages.set(index,'<base href="/different/"><a href="leaves/">另一篇</a><a title=" href=&quot;/notes/leaves/&quot;">说明</a>');
  assert.equal((await read(post)).status,'unavailable');
  pages.set(index,'<base href="/notes/"><a href="leaves/">本文</a>');
  assert.equal((await read(post)).status,'read');
  assert.equal(spacePublicationUrl(post+'?key=dummy'),null);
  assert.equal(spacePublicationUrl('https://internal.local/notes/foo'),null);
  assert.equal(spacePublicationUrl('https://www.youtube.com/watch?v=abcdefg1234'),null);
});

test('missing or mixed planner provenance never supplies its prose, claims or links to the posting model',()=>{
  const event={id:'life:1:1',type:'activity-completed',at:1000,source:{kind:'life-planner'},
    thought:{basis:{offeredRefs:['profile','note:public:sensitive']},activity:{completionSummary:'sensitive draft'},source:{kind:'life-planner'}},
    plan:{mode:'simulated',status:'completed',title:'sensitive title',actualStartedAt:0,endedAt:60000},
    summary:'sensitive summary'};
  const timeOnly=spaceOpportunity(event,new Set());
  assert.match(timeOnly.summary,/1分钟/); assert.doesNotMatch(JSON.stringify(timeOnly),/sensitive/);
  assert.equal(spaceOpportunity({...event,source:{...event.source,scope:'private:user:a'}}),null);
  event.thought.basis.offeredRefs=['profile'];
  assert.equal(spaceOpportunity(event,new Set()).summary,'sensitive draft');
  delete event.thought.basis;
  assert.equal(spaceOpportunity(event,new Set()),null);
});

test('timeline retries an outstanding claim and recovers the committed post before advancing',async()=>{
  const sample = {id:'life:2:1',type:'activity-completed',at:1000,source:{kind:'life-planner'},
    thought:{id:'t',activity:{mode:'simulated',completionSummary:'整理了昨天的草稿'},basis:{offeredRefs:['profile']},source:{kind:'life-planner'}},
    plan:{mode:'simulated',status:'completed',title:'整理草稿',actualStartedAt:0,endedAt:60000}};
  const events = [sample]; let offset=0, outcome='busy', calls=0;
  const timeline={get eventCount(){return events.length;},eventsFrom:(start,count)=>events.slice(start,start+count)};
  const store={spaceEventOffset:()=>offset, advanceSpaceEventOffset:(expected,next)=>{assert.equal(expected,offset); offset=next; return true;}};
  const options={timeline,store,canPublish:()=>true,publisher:{consider:async()=>{calls++;return outcome;}}};
  const first=createSpaceTimeline(options);
  await Promise.all([first.tick(),first.tick()]); assert.equal(calls,1); assert.equal(offset,0);
  await first.close();
  outcome='duplicate';
  const next=createSpaceTimeline(options); await next.tick(); await next.tick();
  assert.equal(offset,1); assert.equal(calls,2); await next.close();
});

test('a normal planner mood and interest can ground a concrete daily, even after restart',async t => {
  const root = resolve('runtime/tests'); await mkdir(root,{recursive:true});
  const dir = await mkdtemp(join(root,'space-planner-'));
  let at = Date.now(), offset = 0;
  const timeline = await createLifeTimeline({directory:dir,now:()=>at});
  const seen = [];
  const options = {timeline,store:{spaceEventOffset:()=>offset,advanceSpaceEventOffset:(prev,next)=>{
    assert.equal(prev,offset); offset=next; return true;
  }},publisher:{consider:async item=>{seen.push(item);return 'published';}},canPublish:()=>true};
  let stream = createSpaceTimeline(options);
  t.after(async()=>{await stream.close(); await timeline.close(); await rm(dir,{recursive:true,force:true});});
  async function activity(id,summary,withEffects=false) {
    const context = lifePlanningContext(timeline,at);
    const refs = lifeSourceRefs(context), mood = context.personalMood;
    const basis = {version:'t045-1',stateVersion:'t030-1',at,timelineSequence:timeline.snapshot().sequence,
      offeredRefs:refs,selectedRefs:['profile'],interests:context.longTermInterests.map(({ref,strength,sourceRefs})=>({ref,strength,sourceRefs})),
      mood:mood && {ref:mood.ref,valence:mood.valence,energy:mood.energy,tension:mood.tension,sourceRefs:mood.sourceRefs}};
    const effects = withEffects ? {version:'t030-1',mood:{valence:0.2,energy:0,tension:0},interest:{topic:'paper',label:'折纸',delta:0.2}} : null;
    await timeline.addThought({id,text:'想自己试一会儿',source:{kind:'life-planner',ref:'["profile"]'},basis,
      activity:{title:'折纸',statusText:'折纸中',mode:'simulated',durationMs:60000,busy:false,effects,completionSummary:summary}});
    await timeline.planThought(id,{id:'plan-'+id,startAt:at}); at+=60000; await timeline.tick();
    await stream.tick(); return refs;
  }
  await activity('first','用纸折了一个扁扁的信封。',true);
  await stream.close(); stream=createSpaceTimeline(options);
  const refs = await activity('second','换了张薄纸，把昨天的信封折得更齐了。');
  assert.ok(refs.includes('state:personal-mood') && refs.includes('interest:paper'));
  assert.deepEqual(seen.map(item=>item.summary),['用纸折了一个扁扁的信封。','换了张薄纸，把昨天的信封折得更齐了。']);
  await timeline.recordExperience({id:'restricted-observation',kind:'reading',mode:'external',source:{kind:'world-reading'},
    summary:'账户专属的阅读内容',evidence:{source:{kind:'observed-web-page'},ref:'unverified'},effects:{version:'t030-1',mood:null,
    interest:{topic:'paper',label:'专属阅读产生的标签',delta:0.2}}});
  await activity('third','专属阅读产生的标签留在这里。');
  assert.match(seen.at(-1).summary,/1分钟/); assert.doesNotMatch(JSON.stringify(seen),/专属/);
});
