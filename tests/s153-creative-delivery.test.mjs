import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import Database from 'better-sqlite3';
import { createPwaStore } from '../src/pwa-store.js';
import { createPwaHistory } from '../src/pwa-history.js';
import { createPwaAuth } from '../src/pwa-auth.js';
import { createPwaHttp } from '../src/pwa-http.js';

const html = Buffer.from('<!doctype html><meta charset=utf-8><details><summary>小卡片</summary>回家</details>');
const output = { preview:'index.html', downloads:['index.html'], files:[{name:'index.html',mime:'text/html; charset=utf-8',bytes:html}] };

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(),'zhiwei-creative-'));
  const path = join(directory,'chat.sqlite');
  let now = Date.now();
  const open = () => createPwaStore({path,now:()=>now});
  let store = open();
  t.after(() => { store.close(); rmSync(directory,{recursive:true,force:true}); });
  const register = name => store.claimInvitation({token:store.createInvitation().token,username:name,displayName:name,passwordHash:'test'}).user.id;
  const userId = register('alice'), otherId = register('bob');
  function task(key='reply-creative',user=userId) {
    const { memoryScope:scope, routeVersion, generation } = store.getIdentity(user);
    return {userId:user,scope,routeVersion,generation,taskKey:key,kind:'website',title:'回家小卡片'};
  }
  const publish = (task, workId, extra = {}) => store.publishSegments({...task, deliveryId:task.taskKey+':0',
    logicalReplyId:task.taskKey, segments:[{type:'work',workId}], projection:{kind:'outbound',version:1}, ...extra});
  return {get store(){return store;},open,userId,otherId,task,publish,advance(ms){now+=ms;},reopen(){store.close();store=open();},directory};
}

test('claim, retry and complete survive process recovery; publication atomically associates one chat message',async t => {
  const env=setup(t), task=env.task();
  const first=env.store.claimCreativeWork(task);
  assert.equal(first.status,'claimed');
  const otherProcess=env.open();
  try {assert.equal(otherProcess.claimCreativeWork(task).status,'running');} finally {otherProcess.close();}
  env.reopen();
  env.advance(16*60000);
  const retry=env.store.claimCreativeWork(task);
  assert.equal(retry.status,'claimed'); assert.notEqual(retry.token,first.token);
  assert.equal(env.store.failCreativeWork({...task,token:first.token}),false);
  assert.throws(()=>env.store.finishCreativeWork({...task,token:first.token,output}),/claim-lost/);
  const finish={...task,token:retry.token,output};
  assert.throws(()=>env.store.finishCreativeWork({...finish,output:{...output,downloads:['unknown.glb']}}),/invalid-work-output/);
  const {workId}=env.store.finishCreativeWork(finish);
  env.reopen();
  assert.deepEqual(env.store.claimCreativeWork(task),{status:'ready',workId});
  assert.equal(env.store.readCreativeFile(env.userId,workId),null);
  assert.throws(()=>env.publish(task,workId,{projection:null}),/projection-required/);
  assert.equal(env.store.listMessages(env.userId).messages.length,0);
  assert.equal(env.store.readCreativeFile(env.userId,workId),null);
  const sent=env.publish(task,workId);
  assert.deepEqual(sent.messages[0].work,{id:workId,kind:'website',title:task.title,preview:'index.html',downloads:['index.html']});
  assert.deepEqual(env.store.claimCreativeWork(task),{status:'delivered',workId});
  env.reopen();
  assert.equal(env.publish(task,workId).duplicate,true);
  assert.throws(()=>env.publish({...task,taskKey:'new-task'},workId),/work-unavailable/);
  assert.throws(()=>env.publish(env.task('some-key',env.otherId),workId),/work-unavailable/);
  assert.equal(env.store.listMessages(env.userId).messages.length,1);
  assert.equal(env.store.listMessages(env.otherId).messages.length,0);
  assert.deepEqual(env.store.readCreativeFile(env.userId,workId).bytes,html);
  assert.equal(env.store.readCreativeFile(env.otherId,workId),null);
  const history=createPwaHistory({store:env.store});
  assert.deepEqual((await history.resolve(env.userId,sent.messages[0].id)).work,sent.messages[0].work);
  const snapshot=join(env.directory,'backup.sqlite');
  await env.store.backup(snapshot);
  const recovered=createPwaStore({path:snapshot,readOnly:true});
  try {
    assert.deepEqual(recovered.readCreativeFile(env.userId,workId,'index.html').bytes,html);
    assert.equal(recovered.getMessage(env.userId,sent.messages[0].id).work.id,workId);
  } finally {recovered.close();}
});

test('a failed attempt may retry; new input fences late render and publication',t => {
  const e=setup(t), task=e.task(), claim=e.store.claimCreativeWork(task);
  assert.equal(e.store.failCreativeWork({...task,token:claim.token,reason:'renderer-unavailable'}),true);
  const retry=e.store.claimCreativeWork(task);
  assert.equal(retry.status,'claimed');
  e.store.acceptInbound({userId:e.userId,clientMessageId:'supersede',text:'再聊'});
  assert.throws(()=>e.store.finishCreativeWork({...task,token:retry.token,output}),/creative-claim-lost/);
  assert.throws(()=>e.store.claimCreativeWork(task),/creative-task-stale/);
  const next=e.task('another');
  const {token}=e.store.claimCreativeWork(next);
  const {workId}=e.store.finishCreativeWork({...next,token,output});
  e.store.acceptInbound({userId:e.userId,clientMessageId:'supersede-again',text:'稍等'});
  assert.throws(()=>e.publish(next,workId),/work-unavailable/);
  assert.equal(e.store.readCreativeFile(e.userId,workId),null);
});

test('authenticated URL opens and downloads bytes only after publication and only for the original account',async t => {
  const e=setup(t), task=e.task(), {token}=e.store.claimCreativeWork(task);
  const {workId}=e.store.finishCreativeWork({...task,token,output});
  const origin='https://zhiwei.example', api=createPwaHttp({store:e.store,auth:createPwaAuth({store:e.store}),origin,publicDir:e.directory});
  const {port}=await api.listen(0);
  const path='/api/pwa/media/works/'+workId;
  const owner=e.store.createSession({userId:e.userId}), friend=e.store.createSession({userId:e.otherId});
  function get(path, session) {
    return new Promise((resolve,reject)=>{
      const req=request({host:'127.0.0.1',port,path,headers:{Host:'zhiwei.example',...(session ? {Cookie:'__Host-zhiwei='+session.token} : {})}},res=>{
        const chunks=[]; res.on('data',b=>chunks.push(b)); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
      });
      req.on('error',reject); req.end();
    });
  }
  try {
    assert.equal((await get(path+'/preview',owner)).status,404);
    e.publish(task,workId);
    for (const suffix of ['/preview','/download/index.html']) {
      assert.equal((await get(path+suffix)).status,401);
      assert.equal((await get(path+suffix,friend)).status,404);
      const result=await get(path+suffix,owner);
      assert.equal(result.status,200); assert.deepEqual(result.bytes,html);
      assert.equal(result.headers['cache-control'],'no-store');
      assert.equal(result.headers['x-content-type-options'],'nosniff');
      assert.match(result.headers['content-security-policy'],/^sandbox; default-src 'none'; script-src 'none';/);
      assert.match(result.headers['content-disposition'],suffix==='/preview'?/^inline;/:/^attachment;/);
    }
    assert.equal((await get(path+'/download/other.html',owner)).status,404);
    const messages=JSON.parse((await get('/api/pwa/messages',owner)).bytes).messages;
    assert.equal(messages[0].work.id,workId);
    e.store.revokeSession(owner.session.id);
    assert.equal((await get(path+'/preview',owner)).status,401);
  } finally {await api.close();}
});

test('replay keeps the original proposal, rejects a replaced context and can release unpublished bytes',t=>{
  const e=setup(t), task={...e.task(),contextKey:'a'.repeat(64),brief:'用青绿色画出沿岸小路'};
  const build=task=>{
    const {token}=e.store.claimCreativeWork(task);
    return e.store.finishCreativeWork({...task,token,output}).workId;
  };
  const old=build(task);
  e.reopen();
  const original=e.store.getCreativeTask(task);
  assert.equal(original.workId,old);
  assert.deepEqual(original.proposal,{kind:task.kind,title:task.title,brief:task.brief});
  const replacement={...task,contextKey:'b'.repeat(64),brief:'改用靛蓝'};
  assert.equal(e.store.getCreativeTask(replacement),null);
  assert.throws(()=>e.publish(task,old,{creativeContextKey:replacement.contextKey}),/work-unavailable/);
  const fresh=build(replacement);
  const db=new Database(e.store.path);
  try{
    const files=id=>db.prepare('SELECT COUNT(*) count FROM creative_files WHERE work_id=?').get(id).count;
    assert.equal(files(old),0);assert.equal(files(fresh),1);
    assert.equal(e.store.discardCreativeTask(task),false);
    assert.equal(e.store.discardCreativeTask(replacement),true);assert.equal(files(fresh),0);
    const newer=build(replacement);
    const sent=e.publish(replacement,newer,{creativeContextKey:replacement.contextKey});
    assert.equal(sent.messages[0].work.id,newer);
    assert.equal(e.store.discardCreativeTask(replacement),false);
    db.prepare('UPDATE bindings SET memory_scope=?,route_version=route_version+1 WHERE user_id=?').run('qq:private:300123',e.userId);
    assert.equal(e.store.readCreativeFile(e.userId,newer),null);
    const record=e.store.getMessage(e.userId,sent.messages[0].id);
    assert.equal(record.work,null);
    assert.ok(!record.text.includes(task.title));
  }finally{db.close();}
});

test('orphan draft collection on reopen preserves delivered works and resumable inbox drafts',t=>{
  const e=setup(t),publish=e.task('kept'),orphan=e.task('abandoned');
  const build=task=>{
    const {token}=e.store.claimCreativeWork(task);return e.store.finishCreativeWork({...task,token,output}).workId;
  };
  const permanent=build(publish);e.publish(publish,permanent);
  build(orphan);
  e.advance(25*3600000);e.reopen();
  assert.equal(e.store.getCreativeTask(orphan),null); assert.deepEqual(e.store.readCreativeFile(e.userId,permanent).bytes,html);
  const inbound=e.store.acceptInbound({userId:e.userId,clientMessageId:'restart',text:'请做网页'});
  const resumable=e.task('pending-input'),ready=build(resumable);
  e.advance(3*86400000);e.reopen();
  assert.equal(e.store.getCreativeTask(resumable).workId,ready);
  e.store.completeInbox(inbound.inboxId,{state:'cancelled'});
  assert.equal(e.store.pruneCreativeDrafts(),1);assert.equal(e.store.getCreativeTask(resumable),null);
});
import { createHash } from 'node:crypto';
import { creativeViewerScriptHash } from '../src/creative-render-viewer.js';

test('the isolated 3D preview uses the trusted script digest saved with that piece',t=>{
  const e=setup(t),task={...e.task(),kind:'model3d'}, {token}=e.store.claimCreativeWork(task);
  const {workId}=e.store.finishCreativeWork({...task,token,output});
  e.publish(task,workId);
  assert.equal(e.store.readCreativeFile(e.userId,workId).viewerHash,creativeViewerScriptHash);
  // Model a database created by a previous version whose bundled viewer had a different digest.
  const prior="'sha256-"+createHash('sha256').update('previous offline viewer').digest('base64')+"'";
  const db=new Database(e.store.path);
  try{db.prepare('UPDATE creative_works SET viewer_hash=? WHERE id=?').run(prior,workId);}finally{db.close();}
  e.reopen();
  assert.equal(e.store.readCreativeFile(e.userId,workId).viewerHash,prior);
});
