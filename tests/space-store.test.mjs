import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createPwaStore } from '../src/pwa-store.js';
import { createPwaAuth } from '../src/pwa-auth.js';
import { createPwaHttp } from '../src/pwa-http.js';

const at = 1800000000000;
const daily = {kind:'daily',text:'午后又翻开了手边的书。',source:null};
const basisText = 'This RFC specifies a standard for the ARPA Internet community.';
const source = {url:'https://www.rfc-editor.org/rfc/rfc862.txt',title:'Echo Protocol',contentHash:'a'.repeat(64),observedAt:at-1000,
  basisKind:'article-excerpt',basisText,basisHash:createHash('sha256').update(basisText).digest('hex')};
const share = {kind:'share',text:'只用几句话就说明白了这个约定。',source};
const publicDir = fileURLToPath(new URL('../modules/pwa/public/',import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'space-store-')), path = join(dir,'pwa.sqlite');
  const handles = new Set();
  let clock = at;
  const open = (readOnly=false) => {
    const store = createPwaStore({path,now:() => clock,readOnly});
    handles.add(store);
    return store;
  };
  const close = store => { if (handles.delete(store)) store.close(); };
  t.after(() => { for (const store of handles) close(store); rmSync(dir,{recursive:true,force:true}); });
  return {path,open,close,advance:ms => {clock+=ms;}};
}
function decide(store,eventKey,post) {
  const claim = store.beginSpaceDecision(eventKey);
  assert.ok(claim);
  return store.finishSpaceDecision({eventKey,claim,post}).post;
}
function account(store,username,options={}) {
  const {token} = store.createInvitation(options);
  const {user} = store.claimInvitation({token,username,displayName:username,passwordHash:'fixture-password-hash'});
  return store.createSession({userId:user.id});
}

test('two writers decide once, stale completions cannot publish, and a terminal skip survives reopen',t => {
  const f = fixture(t), a = f.open(), b = f.open(), id = 'reading:32';
  assert.equal(a.hasSpaceDecision(id),false);
  const expired = a.beginSpaceDecision(id);
  assert.ok(expired);
  assert.equal(b.beginSpaceDecision(id),null);
  assert.equal(b.hasSpaceDecision(id),false);
  f.advance(10 * 60000);
  assert.deepEqual(a.finishSpaceDecision({eventKey:id,claim:expired,post:daily}),{duplicate:true,post:null});
  const winner = b.beginSpaceDecision(id);
  assert.ok(winner);
  assert.notEqual(winner,expired);
  assert.equal(a.finishSpaceDecision({eventKey:id,claim:expired,post:daily}).duplicate,true);
  const result = b.finishSpaceDecision({eventKey:id,claim:winner,post:share});
  assert.equal(result.duplicate,false);
  assert.deepEqual(result.post,{id:1,kind:'share',text:share.text,publishedAt:at+600000,source:{title:source.title,url:source.url}});
  assert.equal(b.hasSpaceDecision(id),true);
  assert.deepEqual(b.finishSpaceDecision({eventKey:id,claim:winner,post:daily}),{duplicate:true,post:result.post});
  assert.equal(decide(a,'daily:33',null),null);
  f.close(a); f.close(b);
  const c = f.open();
  assert.equal(c.beginSpaceDecision(id),null);
  assert.equal(c.beginSpaceDecision('daily:33'),null);
  assert.equal(c.hasSpaceDecision('daily:33'),true);
  assert.deepEqual(c.listSpacePosts(),{posts:[result.post],nextBefore:null});
  assert.deepEqual(c.getSpacePost(result.post.id),result.post);
  const inspect = new Database(f.path,{readonly:true});
  try {
    assert.deepEqual(inspect.prepare('SELECT source_hash,observed_at FROM space_posts').get(),{source_hash:source.contentHash,observed_at:source.observedAt});
    assert.deepEqual(inspect.prepare('SELECT basis_kind,basis_text,basis_hash FROM space_posts').get(),
      {basis_kind:'article-excerpt',basis_text:basisText,basis_hash:source.basisHash});
    assert.deepEqual(inspect.pragma('foreign_key_check'),[]);
  } finally { inspect.close(); }
});

test('pagination is stable across new publications; invalid reading evidence never creates a post',t => {
  const f = fixture(t), store = f.open(), eventKey = 'reading:invalid', claim = store.beginSpaceDecision(eventKey);
  for (const invalid of [
    {...daily,source}, {...daily,body:'private'}, {...share,source:{...source,scope:'private:user:one'}},
    {...share,source:{...source,url:'http://www.rfc-editor.org/rfc/rfc862.txt'}},
    {...share,source:{...source,url:'https://localhost/rfc/rfc862.txt'}},
    {...share,source:{...source,contentHash:'unverified'}}, {...share,source:{...source,basisText:'changed after observation'}},
    {...share,source:{...source,basisKind:'private-note'}}
  ]) assert.throws(() => store.finishSpaceDecision({eventKey,claim,post:invalid}),/invalid-space/);
  assert.equal(store.hasSpaceDecision(eventKey),false);
  store.finishSpaceDecision({eventKey,claim,post:null});
  assert.equal(store.getSpacePost(1),null);
  for (let i=0; i<4; i++) decide(store,'daily:'+i,daily);
  const head = store.listSpacePosts({limit:2});
  assert.deepEqual(head.posts.map(p=>p.id),[4,3]);
  assert.equal(head.nextBefore,3);
  decide(store,'daily:new',daily);
  const older = store.listSpacePosts({limit:2,before:head.nextBefore});
  assert.deepEqual(older.posts.map(p=>p.id),[2,1]);
  assert.equal(older.nextBefore,null);
});

test('only the owning worker can release a cancelled decision for immediate retry',t => {
  const f=fixture(t), a=f.open(), b=f.open(), eventKey='daily:cancelled';
  const original=a.beginSpaceDecision(eventKey);
  assert.equal(b.beginSpaceDecision(eventKey),null);
  assert.equal(a.releaseSpaceDecision({eventKey,claim:original}),true);
  const retry=b.beginSpaceDecision(eventKey);
  assert.ok(retry);
  f.advance(10*60000);
  const successor=a.beginSpaceDecision(eventKey);
  assert.ok(successor);
  assert.equal(b.releaseSpaceDecision({eventKey,claim:retry}),false);
  assert.equal(a.finishSpaceDecision({eventKey,claim:successor,post:daily}).duplicate,false);
  assert.equal(a.releaseSpaceDecision({eventKey,claim:successor}),false);
  assert.equal(b.beginSpaceDecision(eventKey),null);
  assert.equal(b.getSpacePost(1).kind,'daily');
  const skipKey='daily:skip', skip=b.beginSpaceDecision(skipKey);
  b.finishSpaceDecision({eventKey:skipKey,claim:skip,post:null});
  assert.equal(b.releaseSpaceDecision({eventKey:skipKey,claim:skip}),false);
  assert.equal(b.hasSpaceDecision(skipKey),true);
});

test('timeline cut-in survives restart; replayed offsets cannot skip another worker’s range',t => {
  const f=fixture(t), a=f.open(), b=f.open();
  assert.equal(a.spaceEventOffset(182),182);
  assert.equal(b.spaceEventOffset(190),182);
  assert.equal(b.advanceSpaceEventOffset(182,183),true);
  assert.equal(a.advanceSpaceEventOffset(182,194),false);
  assert.throws(()=>a.advanceSpaceEventOffset(183,183),/invalid-space-offset/);
  f.close(a); f.close(b);
  assert.equal(f.open(true).spaceEventOffset(210),183);
  assert.equal(f.open().advanceSpaceEventOffset(183,184),true);
});

test('read-only previous schema stays unchanged and writable upgrade retains private data',t => {
  const f=fixture(t), initial=f.open(), session=account(initial,'alicia');
  initial.acceptInbound({userId:session.user.id,clientMessageId:'local-history',text:'个人记录留在原账号。'});
  f.close(initial);
  const old=new Database(f.path);
  old.exec('DROP TABLE space_comments; DROP TABLE space_decisions; DROP TABLE space_posts; DROP TABLE space_timeline_cursor;');
  old.close();
  const readOnly=f.open(true);
  assert.deepEqual(readOnly.listSpacePosts(),{posts:[],nextBefore:null});
  assert.equal(readOnly.getSpacePost(1),null);
  assert.equal(readOnly.hasSpaceDecision('daily:1'),false);
  assert.equal(readOnly.spaceEventOffset(19),19);
  assert.throws(()=>readOnly.beginSpaceDecision('daily:1'),/read-only/);
  f.close(readOnly);
  const inspect=new Database(f.path,{readonly:true});
  assert.equal(inspect.prepare("SELECT count(*) AS total FROM sqlite_master WHERE name GLOB 'space_*'").get().total,0);
  inspect.close();
  const upgraded=f.open();
  assert.equal(upgraded.listMessages(session.user.id).messages[0].text,'个人记录留在原账号。');
  assert.equal(upgraded.spaceEventOffset(25),25);
  assert.equal(decide(upgraded,'daily:1',daily).id,1);
});

function call(port,path,session,method='GET') {
  return new Promise((resolve,reject)=>{
    const headers = {Host:'zhiwei.example',Origin:'https://zhiwei.example','X-PWA-Request':'1'};
    if (session) Object.assign(headers,{Cookie:'__Host-zhiwei='+session.token,'X-CSRF-Token':session.csrfToken});
    const req=request({hostname:'127.0.0.1',port,path,method,headers},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8'),headers:res.headers}));
    });
    req.on('error',reject); req.end();
  });
}
test('active and pending accounts see the same posts; revoked and guest readers see only a sign-in shell',async t => {
  const f=fixture(t), store=f.open(), alice=account(store,'alice'), bob=account(store,'bravo',{memoryScope:'qq:private:532121'});
  store.acceptInbound({userId:alice.user.id,clientMessageId:'private-history',text:'PRIVATE_ACCOUNT_ONLY_SENTINEL'});
  const first=decide(store,'daily:one',daily), second=decide(store,'reading:two',share);
  const auth=createPwaAuth({store}), http=createPwaHttp({store,auth,publicDir,origin:'https://zhiwei.example',spaceEnabled:true});
  const {port}=await http.listen(0);
  try {
    const feed='/api/pwa/space/posts', detail=feed+'/'+second.id;
    for (const person of [alice,bob]) {
      const me=JSON.parse((await call(port,'/api/pwa/me',person)).body);
      assert.equal(me.capabilities.space,true);
      const visible=await call(port,feed,person);
      assert.equal(visible.status,200);
      assert.equal(visible.headers['cache-control'],'no-store');
      assert.deepEqual(JSON.parse(visible.body),{posts:[second,first],nextBefore:null});
      assert.deepEqual(JSON.parse((await call(port,detail,person)).body),{post:second});
      assert.equal((await call(port,'/space/'+second.id,person)).status,200);
      assert.equal((await call(port,'/space',person,'HEAD')).status,200);
      assert.equal((await call(port,feed+'/731231',person)).status,404);
    }
    assert.equal((await call(port,'/api/pwa/messages',bob)).status,403);
    assert.equal((await call(port,feed+'?before=-1',alice)).status,400);
    assert.equal((await call(port,feed+'?limit=101',alice)).status,400);
    assert.equal((await call(port,feed,alice,'POST')).status,404);
    assert.equal((await call(port,'/api/pwa/session',alice,'DELETE')).status,200);
    store.disableUser(bob.user.id);
    for (const person of [alice,bob,null]) {
      for (const path of [feed,detail,'/space','/space/'+second.id]) {
        const response=await call(port,path,person);
        assert.equal(response.status,401);
        assert.equal(response.headers['cache-control'],'no-store');
        assert.ok(!response.body.includes(share.text) && !response.body.includes(daily.text) && !response.body.includes('PRIVATE_ACCOUNT_ONLY_SENTINEL'));
      }
    }
  } finally { await http.close(); }
});

test('disabled space is absent from capabilities and from the page and API',async t => {
  const f=fixture(t), store=f.open(), alice=account(store,'alice');
  const http=createPwaHttp({store,auth:createPwaAuth({store}),publicDir,origin:'https://zhiwei.example'});
  const {port}=await http.listen(0);
  try {
    assert.equal(JSON.parse((await call(port,'/api/pwa/me',alice)).body).capabilities.space,false);
    assert.equal((await call(port,'/api/pwa/space/posts',alice)).status,404);
    assert.equal((await call(port,'/space',alice)).status,404);
  } finally { await http.close(); }
});
