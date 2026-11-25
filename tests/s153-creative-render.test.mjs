import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { creativeSpecGuidance, renderCreativeWork } from '../src/creative-render.js';
import { creativeViewerScriptHash } from '../src/creative-render-viewer.js';
import { createHash } from 'node:crypto';

const artifact = (kind, spec, options) => renderCreativeWork({ title: '山间茶室', kind, spec }, options);
const get = (bundle, name) => bundle.files.find(f => f.name === name).bytes;

test('网站按构想选择版式、数据表、勾选与折叠，转义作品文本', async () => {
  const work = await artifact('website', { accent: '#185041', layout: 'timeline', font: 'serif', intro: '茶会日程', sections: [
    { heading: '第一天', blocks: [{type:'checklist',items:['洗杯']}, {type:'table',columns:['时间','活动'],rows:[['九点','泡茶']]},
      {type:'disclosure',label:'茶叶',text:'<script>alert(1)</script>'}] }
  ]});
  const html = get(work, work.preview).toString();
  for (const token of ['<table>', 'type="checkbox"', '<summary>', 'class="timeline"', '&lt;script&gt;', 'href="#part-1"']) assert.ok(html.includes(token));
  assert.ok(!html.includes('<script>')); assert.deepEqual(work.downloads, ['index.html']);
  await assert.rejects(artifact('website', { accent:'#111111', intro:'x', sections:[{heading:'x',blocks:[{type:'html',text:'x'}]}] }));
});
test('设计稿保留可编辑中文矢量图层，已导出实际像素', async () => {
  const work = await artifact('design', { width:320,height:180,background:'#efddb8',elements:[
    {type:'rect',name:'松绿',x:5,y:5,width:60,height:40,fill:'#112233'},
    {type:'ellipse',cx:150,cy:30,rx:15,ry:12,fill:'#774422'},
    {type:'path',d:'M10 70 L45 60 L65 65 Z',fill:'#506050'},
    {type:'text',name:'标题',x:16,y:130,size:22,text:'山间茶室',fill:'#113320'}
  ]});
  assert.match(get(work,'design.svg').toString(), /<g id="layer-4"><title>标题<\/title><text/);
  const {data,info}=await sharp(get(work,'preview.png')).removeAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,320);assert.equal(info.height,180);
  const at = (10*320+10)*3;
  assert.deepEqual([...data.subarray(at,at+3)],[17,34,51]);
});
test('三维下载可重新解析，预览使用同一 GLB 并精确匹配固定脚本哈希', async () => {
  const parts = ['box','cylinder','cone','sphere'].map((shape,i)=>({shape,name:'部件'+i,size:[1+i,2,3],position:[i,0,0],rotation:[0,15*i,0],color:'#447799'}));
  const work = await artifact('model3d',{parts}), glb = get(work,'model.glb'), html = get(work,work.preview).toString();
  assert.equal(glb.readUInt32LE(8),glb.length);
  const len = glb.readUInt32LE(12);
  const doc = JSON.parse(glb.subarray(20,20+len).toString());
  assert.equal(doc.nodes.length,4);assert.equal(doc.buffers[0].byteLength,glb.length-28-len);
  assert.deepEqual(doc.nodes.map(n=>n.scale),parts.map(p=>p.size));assert.deepEqual(JSON.parse(get(work,'parameters.json')).parts,parts);
  assert.ok(html.includes(glb.toString('base64'))); assert.match(html, /id="import"/);
  const script = html.match(/<script>([\s\S]+)<\/script>/)[1];
  assert.equal("'sha256-"+createHash('sha256').update(script.replace(/\r\n?/g,'\n')).digest('base64')+"'",creativeViewerScriptHash);
  await assert.rejects(artifact('model3d',{parts:[{...parts[0],size:[0,1,1]}]}));
});
test('绘图仅收取该次 CLI 新任务文件，重新解码，失败时清理并保留用量', async () => {
  const directory = await mkdtemp(join(tmpdir(),'s153-drawing-')), login = join(directory,'login'), job = join(directory,'work');
  const png = await sharp({create:{width:8,height:6,channels:3,background:'#19a3aa'}}).png().toBuffer();
  const id = '75a0a36d-cdb6-4e17-8123-70073e9364da';
  const fake = join(directory,'drawing.mjs'), cache = join(login,'generated_images');
  try {
    await mkdir(cache,{recursive:true});
    const source = (behavior) => "import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';"+
      "const id="+JSON.stringify(id)+";const dir=join(process.env.CODEX_HOME,'generated_images',id);"+
      "const args=process.argv.slice(2);if(!['features.shell_tool=false','features.image_generation=true','features.code_mode_host=true','read-only'].every(x=>args.includes(x)))process.exit(1);"+
      "console.log(JSON.stringify({type:'thread.started',thread_id:id}));"+behavior+
      "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:8,cached_input_tokens:2,output_tokens:3}}))";
    const options = {codexPath:fake,directory:job,env:{...process.env,CODEX_HOME:login}};
    await writeFile(fake,source("await mkdir(dir);await writeFile(join(dir,'generated.png'),Buffer.from('"+png.toString('base64')+"','base64'));"));
    const work = await artifact('drawing',{prompt:'画一个茶杯'},options);
    assert.equal((await sharp(get(work,'drawing.png')).metadata()).height,6);assert.equal(work.usage.output_tokens,3);
    assert.deepEqual(await readdir(cache),[]);assert.deepEqual(await readdir(job),[]);
    await writeFile(fake,source("await mkdir(dir);await writeFile(join(dir,'spoof.png'),'not png');"));
    await assert.rejects(artifact('drawing',{prompt:'茶杯'},options),e=>e.usage.output_tokens===3);
    assert.deepEqual(await readdir(cache),[]);
    await mkdir(join(cache,id));await writeFile(join(cache,id,'previous.png'),png);
    await writeFile(fake,source(''));
    await assert.rejects(artifact('drawing',{prompt:'茶杯'},options),/未返回本次/);
    assert.deepEqual(await readFile(join(cache,id,'previous.png')),png);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('未知工具拒绝，四类均有各自创作说明', () => {
  for (const k of ['drawing','website','design','model3d']) assert.ok(creativeSpecGuidance(k).length > 10);
  assert.throws(()=>creativeSpecGuidance('constructor'));
});

