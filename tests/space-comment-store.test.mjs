import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createPwaStore } from '../src/pwa-store.js';
import { createPwaAuth } from '../src/pwa-auth.js';
import { createPwaHttp } from '../src/pwa-http.js';

const origin = 'https://space.example';
const lease = 600000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'space-comments-')), path = join(dir,'web.sqlite');
  const handles = new Set();
  let time = 1800000000000;
  function open(readOnly=false) {
    const store = createPwaStore({path,now:() => time,readOnly});
    handles.add(store);
    return store;
  }
  function close(store) { if (handles.delete(store)) store.close(); }
  t.after(() => { for (const store of handles) close(store); rmSync(dir,{recursive:true,force:true}); });
  const store = open();
  function account(username,displayName,opts) {
    const {token} = store.createInvitation(opts);
    const {user} = store.claimInvitation({token,username,displayName,passwordHash:'fixture-password-hash'});
    return store.createSession({userId:user.id});
  }
  const alice = account('login-one','纸船');
  const bob = account('login-two','纸船',{memoryScope:'qq:private:984152'});
  function post(eventKey) {
    const claim = store.beginSpaceDecision(eventKey);
    return store.finishSpaceDecision({eventKey,claim,post:{kind:'daily',text:eventKey,source:null}}).post;
  }
  return {path,open,close,advance:ms => {time+=ms;},store,alice,bob,first:post('daily:one'),second:post('daily:two')};
}

function write(store,user,post,key,text) {
  return store.addSpaceComment({userId:user.user.id,postId:post.id,clientCommentId:key,text});
}

test('post, author and retry identity are fixed even when two authors share a name and client key',t => {
  const {store,alice,bob,first,second,path} = fixture(t);
  const one = write(store,alice,first,'same','  我折了一只。  ');
  const two = write(store,bob,first,'same','下雨时也会划走吗？');
  assert.equal(one.comment.authorName,two.comment.authorName);
  assert.deepEqual(one.comment,{id:1,postId:first.id,authorName:'纸船',text:'我折了一只。',createdAt:1800000000000,reply:null});
  assert.deepEqual(write(store,alice,first,'same','我折了一只。'),{duplicate:true,comment:one.comment});
  assert.throws(() => write(store,alice,first,'same','改变'),/comment-id-conflict/);
  assert.throws(() => write(store,alice,second,'same','我折了一只。'),/comment-id-conflict/);
  assert.deepEqual(store.listSpaceComments(second.id).comments,[]);
  const head = store.listSpaceComments(first.id,{limit:1});
  assert.deepEqual(head,{comments:[two.comment],nextBefore:two.comment.id});
  write(store,alice,first,'new','后来的一条');
  assert.deepEqual(store.listSpaceComments(first.id,{limit:1,before:head.nextBefore}),{comments:[one.comment],nextBefore:null});
  const privateMarkers=[alice.user.id,bob.user.id,alice.user.username,bob.user.username,'qq:private:984152','PRIVATE_HISTORY'];
  store.acceptInbound({userId:alice.user.id,clientMessageId:'only-private',text:'PRIVATE_HISTORY'});
  for (const marker of privateMarkers) assert.ok(!JSON.stringify(store.listSpaceComments(first.id)).includes(marker));
  const db = new Database(path,{readonly:true});
  try {
    assert.deepEqual(db.prepare('SELECT user_id FROM space_comments WHERE id IN (1,2) ORDER BY id').all().map(row=>row.user_id),[alice.user.id,bob.user.id]);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  } finally { db.close(); }
});

test('one decision per row survives restart, expired leases, competing workers and delayed retries',t => {
  const f = fixture(t), a = f.store, b = f.open();
  const one = write(a,f.alice,f.first,'one','第一条').comment;
  const two = write(a,f.bob,f.first,'two','第二条').comment;
  const three = write(a,f.alice,f.second,'three','另一动态').comment;
  const first = a.claimSpaceComment(), second = b.claimSpaceComment();
  assert.deepEqual(first.comment,one);
  assert.deepEqual(first.post,f.first);
  assert.deepEqual(second.comment,two);
  assert.equal(a.releaseSpaceComment({commentId:two.id,claim:first.claim}),false);
  assert.equal(a.finishSpaceComment({commentId:two.id,claim:first.claim,text:'错误目标'}).duplicate,true);
  assert.equal(b.finishSpaceComment({commentId:two.id,claim:second.claim,text:null}).duplicate,false);
  assert.equal(a.failSpaceComment({commentId:one.id,claim:first.claim}),'retry');
  assert.deepEqual(b.claimSpaceComment().comment,three);
  assert.equal(a.claimSpaceComment(),null);
  f.advance(lease);
  const retry = b.claimSpaceComment();
  assert.deepEqual(retry.comment,one);
  assert.equal(a.finishSpaceComment({commentId:one.id,claim:first.claim,text:'过期'}).duplicate,true);
  f.close(a); f.close(b);
  f.advance(lease);
  const restarted = f.open();
  assert.equal(restarted.finishSpaceComment({commentId:one.id,claim:retry.claim,text:'过期'}).duplicate,true);
  const expiredThird = restarted.claimSpaceComment();
  assert.equal(expiredThird.comment.id,three.id);
  restarted.finishSpaceComment({commentId:three.id,claim:expiredThird.claim,text:null});
  const winner = restarted.claimSpaceComment();
  assert.equal(winner.comment.id,one.id);
  assert.equal(restarted.finishSpaceComment({commentId:one.id,claim:winner.claim,text:'好看！'}).duplicate,false);
  assert.equal(restarted.finishSpaceComment({commentId:one.id,claim:winner.claim,text:'另外一句'}).duplicate,true);
  assert.equal(restarted.claimSpaceComment(),null);
  f.close(restarted);
  const read = f.open(true);
  assert.deepEqual(read.listSpaceComments(f.first.id).comments,[two,{...one,reply:{text:'好看！',createdAt:1800001200000}}]);
  assert.equal(read.listSpaceComments(f.second.id).comments[0].reply,null);
});

test('disabled authors retain public history while old in-flight replies lose authorization',t => {
  const {store,alice,bob,first,advance} = fixture(t);
  const one = write(store,alice,first,'one','对雨问好').comment;
  const claim = store.claimSpaceComment().claim;
  store.disableUser(alice.user.id);
  assert.throws(() => write(store,alice,first,'two','禁用期间'),/account-unavailable/);
  assert.equal(store.finishSpaceComment({commentId:one.id,claim,text:'停用期间'}).duplicate,true);
  assert.equal(store.failSpaceComment({commentId:one.id,claim}),'stale');
  advance(lease);
  assert.equal(store.claimSpaceComment(),null);
  const two = write(store,bob,first,'two','另一位').comment;
  assert.deepEqual(store.claimSpaceComment().comment,two);
  assert.deepEqual(store.listSpaceComments(first.id).comments,[two,one]);
  store.disableUser(alice.user.id,false);
  const current = store.claimSpaceComment();
  store.disableUser(alice.user.id);
  store.disableUser(alice.user.id,false);
  assert.equal(store.finishSpaceComment({commentId:one.id,claim:current.claim,text:'旧授权'}).duplicate,true);
  assert.equal(store.failSpaceComment({commentId:one.id,claim:current.claim}),'stale');
  assert.equal(store.listSpaceComments(first.id).comments[1].reply,null);
});

test('three actual failures survive reopen and end attempts; shutdown and stale claims consume none',t => {
  const f = fixture(t);
  const one = write(f.store,f.alice,f.first,'one','继续保留的评论').comment;
  const two = write(f.store,f.bob,f.first,'two','无需回应').comment;
  const three = write(f.store,f.alice,f.first,'three','能回应吗？').comment;
  const first = f.store.claimSpaceComment();
  assert.equal(f.store.releaseSpaceComment({commentId:one.id,claim:first.claim}),true);
  assert.equal(f.store.failSpaceComment({commentId:one.id,claim:first.claim}),'stale');
  let store = f.store;
  for (let attempt=1; attempt<=3; attempt++) {
    const item = store.claimSpaceComment();
    assert.deepEqual(item.comment,one);
    const target={commentId:one.id,claim:item.claim};
    assert.equal(store.failSpaceComment(target),attempt===3 ? 'failed' : 'retry');
    assert.equal(store.failSpaceComment(target),'stale');
    if (attempt===1) {
      const skip = store.claimSpaceComment();
      assert.equal(skip.comment.id,two.id);
      store.finishSpaceComment({commentId:two.id,claim:skip.claim,text:null});
      const reply = store.claimSpaceComment();
      assert.equal(reply.comment.id,three.id);
      store.finishSpaceComment({commentId:three.id,claim:reply.claim,text:'可以。'});
    }
    f.close(store);
    store=f.open();
    f.advance(lease-1);
    assert.equal(store.claimSpaceComment(),null);
    f.advance(1);
  }
  assert.equal(store.claimSpaceComment(),null);
  assert.deepEqual(store.listSpaceComments(f.first.id).comments.at(-1),one);
  const inspect = new Database(f.path,{readonly:true});
  try {
    assert.deepEqual(inspect.prepare('SELECT outcome,failure_count FROM space_comments ORDER BY id').all(),[
      {outcome:'failed',failure_count:3},{outcome:'skipped',failure_count:0},{outcome:'replied',failure_count:0}
    ]);
  } finally { inspect.close(); }
});

test('S139 read-only store keeps its schema; writable upgrade keeps posts and private messages',t => {
  const f = fixture(t);
  f.store.acceptInbound({userId:f.alice.user.id,clientMessageId:'legacy',text:'旧私聊'});
  f.close(f.store);
  const old = new Database(f.path);
  old.exec('DROP TABLE space_comments');
  old.close();
  const read = f.open(true);
  assert.deepEqual(read.listSpaceComments(f.first.id),{comments:[],nextBefore:null});
  assert.throws(() => write(read,f.alice,f.first,'x','写入'),/read-only/);
  f.close(read);
  const inspect = new Database(f.path,{readonly:true});
  assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE name='space_comments'").get(),undefined);
  inspect.close();
  const upgraded = f.open();
  assert.deepEqual(upgraded.getSpacePost(f.first.id),f.first);
  assert.equal(upgraded.listMessages(f.alice.user.id).messages[0].text,'旧私聊');
  assert.equal(write(upgraded,f.alice,f.first,'x','升级后').comment.id,1);
});

function call(port,path,{user,method='GET',input,headers:extra={}}={}) {
  return new Promise((resolve,reject) => {
    const headers={Host:'space.example',Origin:origin,'X-PWA-Request':'1','Content-Type':'application/json',...extra};
    if (user) {
      headers.Cookie='__Host-zhiwei='+user.token;
      headers['X-CSRF-Token']=user.csrfToken;
    }
    const req = request({port,hostname:'127.0.0.1',path,method,headers},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(Buffer.concat(chunks).toString()),headers:res.headers}));
    });
    req.on('error',reject);
    req.end(input && JSON.stringify(input));
  });
}

test('HTTP comments authenticate both reads and writes, allow pending accounts, and derive author from session',async t => {
  const {store,alice,bob,first} = fixture(t);
  const auth = createPwaAuth({store});
  const http = createPwaHttp({store,auth,origin,spaceEnabled:true});
  const {port} = await http.listen(0), path = '/api/pwa/space/posts/'+first.id+'/comments';
  const post = (user,text,opts={}) => call(port,path,{user,method:'POST',input:{text,clientCommentId:'key'},...opts});
  try {
    assert.equal((await call(port,path)).status,401);
    assert.equal((await post(null,'访客')).status,401);
    assert.equal((await post({...alice,csrfToken:'no'},'无授权')).status,403);
    assert.equal((await post(alice,'错误来源',{headers:{Origin:'https://other.example'}})).status,403);
    for (const input of [{text:'冒名',userId:bob.user.id,clientCommentId:'key'},{text:'',clientCommentId:'key'},
      {text:'a'.repeat(1001),clientCommentId:'key'},{text:'foo\u0080',clientCommentId:'key'},{text:'x',clientCommentId:'a b'}])
      assert.equal((await post(alice,null,{input})).status,400);
    assert.equal((await post(alice,'早上好')).status,201);
    assert.equal((await post(alice,'早上好')).value.duplicate,true);
    assert.equal((await post(alice,'修改')).status,409);
    assert.equal((await post(bob,'晚上好')).status,201);
    const list = await call(port,path,{user:bob});
    assert.equal(list.status,200);
    assert.equal(list.headers['cache-control'],'no-store');
    assert.deepEqual(list.value.comments.map(c=>c.text),['晚上好','早上好']);
    assert.deepEqual((await call(port,path,{user:alice})).value,list.value);
    assert.equal((await call(port,path+'?limit=101',{user:alice})).status,400);
    assert.equal((await call(port,'/api/pwa/space/posts/357/comments',{user:bob,method:'POST',input:{text:'不存在',clientCommentId:'new'}})).status,404);
    store.revokeSession(alice.session.id);
    assert.equal((await post(alice,'退出后')).status,401);
    const restricted = createPwaHttp({store,auth,origin,spaceEnabled:true,readOnly:true});
    const maintenance = await restricted.listen(0);
    try {
      assert.equal((await call(maintenance.port,path,{user:bob})).status,200);
      assert.equal((await call(maintenance.port,path,{user:bob,method:'POST',input:{text:'维护',clientCommentId:'xx'}})).status,503);
    } finally { await restricted.close(); }
    const disabled = createPwaHttp({store,auth,origin,spaceEnabled:false});
    const off = await disabled.listen(0);
    try {
      assert.equal((await call(off.port,path,{user:bob})).status,404);
      assert.equal((await call(off.port,path,{user:bob,method:'POST',input:{text:'关闭',clientCommentId:'yy'}})).status,404);
    } finally { await disabled.close(); }
  } finally { await http.close(); }
});

test('revocation during a slow upload wins before the comment transaction',async t => {
  const {store,alice,first} = fixture(t);
  const base = createPwaAuth({store});
  let headersAccepted;
  const accepted = new Promise(resolve => { headersAccepted=resolve; });
  const auth = {...base,authenticate(token) {
    const identity = base.authenticate(token);
    if (identity) headersAccepted();
    return identity;
  }};
  const http = createPwaHttp({store,auth,origin,spaceEnabled:true});
  const {port} = await http.listen(0);
  let req;
  try {
    const response = new Promise((resolve,reject) => {
      req=request({port,hostname:'127.0.0.1',method:'POST',path:'/api/pwa/space/posts/'+first.id+'/comments',
        headers:{Host:'space.example',Origin:origin,'X-PWA-Request':'1','Content-Type':'application/json',
          'X-CSRF-Token':alice.csrfToken,Cookie:'__Host-zhiwei='+alice.token}},res=>{
        res.resume(); res.once('end',()=>resolve(res.statusCode));
      });
      req.on('error',reject);
      req.write('{"clientCommentId":"slow",');
    });
    await accepted;
    store.revokeSession(alice.session.id);
    req.end('"text":"抵达前已退出"}');
    assert.equal(await response,401);
    assert.deepEqual(store.listSpaceComments(first.id).comments,[]);
    assert.equal(store.claimSpaceComment(),null);
  } finally { req?.destroy(); await http.close(); }
});
