import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createPwaStore } from '../src/pwa-store.js';

const day = 86400000, lease = 600000;
const url = 'https://www.example.com/articles/stars';
const words = 'A short text about the ancient star map';
const digest = value => createHash('sha256').update(value).digest('hex');
const readReceipt = () => ({ url,title:'Ancient map',excerpt:words,fetchedAt:Date.now(),
  coverage:'page-excerpt',contentHash:digest(words),textLength:words.length });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'private-actions-'));
  const path = join(dir,'pwa.sqlite');
  let at = Date.now(), store;
  const open = options => createPwaStore({ path, now:() => at, ...options });
  store = open();
  t.after(() => { store?.close(); rmSync(dir,{recursive:true,force:true}); });
  return { path, open,
    get store() { return store; }, get now() { return at; },
    advance(ms) { at += ms; },
    reopen(options = {}) { store?.close(); store = open(options); },
    edit(fn) { const db = new Database(path); try { fn(db); } finally { db.close(); } },
    user(username) {
      const { token } = store.createInvitation();
      const { identity } = store.claimInvitation({ token,username,displayName:username,passwordHash:'synthetic' });
      return {userId:identity.userId,scope:identity.memoryScope,epoch:randomUUID()};
    },
    turn(owner, name = 'star map', text = 'Here is the article ' + url, replyTo = null) {
      const {userId,scope,epoch} = owner, logicalReplyId = randomUUID();
      const item = store.acceptInbound({userId,clientMessageId:randomUUID(),text,replyTo});
      const inboundIds = [item.inboxId];
      store.markInboxProjected(item.inboxId,{channel:'pwa',privateIdentity:item.identity,memoryEpochToken:{scope,epoch}});
      const privateThought = {action:'read later',subject:name};
      const { routeVersion,generation } = item.identity;
      const sent = store.publishSegments({userId,scope,routeVersion,generation,inboundIds,deliveryId:logicalReplyId,
        logicalReplyId,segments:[{type:'text',text:'I will come back to that article.'}],
        projection:{version:1,kind:'exchange',event:{privateThought,privateIdentity:item.identity,
          channel:'pwa',type:'private_message',memoryEpochToken:{scope,epoch}}}});
      const capture = {userId,scope,epoch,logicalReplyId,inboundIds,thought:privateThought};
      assert.equal(store.commitPrivateThought(capture).ok,true);
      store.completeProjection(sent.projectionId);
      store.completeInbox(item.inboxId);
      return {sourceId:item.inboxId,logicalReplyId,sentIds:sent.messages.map(row => row.id),capture};
    }
  };
}

test('an S136 thought outside the recent window is due, keeps its original source and returns to same-owner recall after review', t => {
  const env = fixture(t), owner = env.user('alice'), first = env.turn(owner);
  for (let i=0;i<5;i++) { env.advance(1); env.turn(owner,'newer '+i); }
  assert.equal(env.store.listPrivateThoughts({...owner,limit:4}).some(row => row.logicalReplyId===first.logicalReplyId),false);
  env.edit(db => db.exec('DROP TABLE private_thought_reviews'));
  env.reopen({readOnly:true});
  assert.equal(env.store.listPrivateThoughts(owner).length,5);
  assert.equal(env.store.claimDuePrivateThought(),null);
  env.reopen();
  assert.equal(env.store.claimDuePrivateThought(),null);
  env.advance(day-5);
  const ticket = env.store.claimDuePrivateThought();
  assert.equal(ticket.logicalReplyId,first.logicalReplyId);
  const source = env.store.privateThoughtSource(ticket);
  assert.deepEqual(source.inbound,[{id:first.sourceId,text:'Here is the article '+url}]);
  assert.deepEqual(source.sent.map(row => row.id),first.sentIds);
  const bob = env.user('bob');
  assert.equal(env.store.privateThoughtSource({...ticket,...bob}),null);
  assert.equal(env.store.privateThoughtSource({...ticket,epoch:randomUUID()}),null);
  assert.equal(env.store.startPrivateThoughtRead(ticket,{sourceId:first.sourceId,url:url+'/other'}),false);
  assert.equal(env.store.startPrivateThoughtRead(ticket,{sourceId:randomUUID(),url}),false);
  assert.equal(env.store.startPrivateThoughtRead(ticket,{sourceId:first.sourceId,url}),true);
  const receipt = readReceipt();
  assert.equal(env.store.finishPrivateThought(ticket,{status:'read',receipt:{...receipt,url:url+'/other'}}),false);
  assert.equal(env.store.finishPrivateThought(ticket,{status:'read',receipt}),true);
  assert.equal(env.store.finishPrivateThought(ticket,{status:'read',receipt}),false);
  assert.equal(env.store.commitPrivateThought(first.capture).duplicate,true);
  env.reopen();
  const recall = env.store.listPrivateThoughts({...owner,limit:4})[0];
  assert.equal(recall.logicalReplyId,ticket.logicalReplyId);
  assert.equal(recall.review.sourceId,first.sourceId);
  assert.deepEqual(recall.review.receipt,receipt);
  assert.deepEqual(env.store.listPrivateThoughts(bob),[]);
  assert.deepEqual(env.store.listPrivateThoughts({...owner,epoch:randomUUID()}),[]);
});

test('a deferred thought keeps its future date across restart, then may be abandoned exactly once', t => {
  const env = fixture(t), owner = env.user('alice'), turn = env.turn(owner);
  env.advance(day);
  const ticket = env.store.claimDuePrivateThought(), nextConsiderAt = env.now+12345;
  assert.equal(env.store.finishPrivateThought(ticket,{status:'deferred',nextConsiderAt:env.now}),false);
  assert.equal(env.store.finishPrivateThought(ticket,{status:'read',receipt:readReceipt()}),false);
  assert.equal(env.store.finishPrivateThought(ticket,{status:'deferred',nextConsiderAt}),true);
  env.reopen(); env.advance(12344);
  assert.equal(env.store.claimDuePrivateThought(),null);
  assert.equal(env.store.listPrivateThoughts(owner)[0].review.nextConsiderAt,nextConsiderAt);
  env.advance(1);
  const resumed = env.store.claimDuePrivateThought();
  assert.equal(resumed.logicalReplyId,turn.logicalReplyId);
  assert.notEqual(resumed.token,ticket.token);
  assert.equal(resumed.deferrals,1);
  assert.equal(resumed.scheduledFor,nextConsiderAt);
  assert.equal(resumed.lastConsideredAt,nextConsiderAt-12345);
  assert.equal(env.store.finishPrivateThought(ticket,{status:'abandoned'}),false);
  env.advance(lease);
  const retried=env.store.claimDuePrivateThought();
  assert.equal(retried.scheduledFor,nextConsiderAt);
  assert.equal(retried.lastConsideredAt,resumed.lastConsideredAt);
  assert.equal(env.store.finishPrivateThought(retried,{status:'abandoned'}),true);
  assert.equal(env.store.listPrivateThoughts(owner)[0].review.deferrals,1);
  env.advance(day);
  assert.equal(env.store.claimDuePrivateThought(),null);
});

test('simultaneous stores fence expired reviewers and preserve uncertain reads without issuing another read', t => {
  const env = fixture(t), owner = env.user('alice'), turn = env.turn(owner);
  env.advance(day);
  const first = env.store.claimDuePrivateThought();
  const other = env.open();
  try {
    assert.equal(other.claimDuePrivateThought(),null);
    env.advance(lease);
    assert.equal(env.store.privateThoughtSource(first),null);
    const replacement = other.claimDuePrivateThought();
    assert.notEqual(first.token,replacement.token);
    assert.equal(env.store.startPrivateThoughtRead(first,{sourceId:turn.sourceId,url}),false);
    assert.equal(other.startPrivateThoughtRead(replacement,{sourceId:turn.sourceId,url}),true);
    env.advance(lease-1);
    env.reopen();
    assert.equal(env.store.claimDuePrivateThought(),null);
    env.advance(1);
    assert.equal(env.store.claimDuePrivateThought(),null);
    assert.equal(other.finishPrivateThought(replacement,{status:'read',receipt:readReceipt()}),false);
    const review=env.store.listPrivateThoughts(owner)[0].review;
    assert.equal(review.status,'unknown');
    assert.deepEqual(review.receipt,{reason:'reading-interrupted',url});
    env.advance(day); assert.equal(env.store.claimDuePrivateThought(),null);
  } finally { other.close(); }
});

test('disabled or changed bindings cannot execute, obsolete epochs retire without starving other users', t => {
  const env=fixture(t), alice=env.user('alice'), bob=env.user('bob');
  env.turn(alice); env.advance(1); const b=env.turn(bob);
  env.advance(day);
  const old=env.store.claimDuePrivateThought();
  assert.equal(old.userId,alice.userId);
  env.store.disableUser(alice.userId);
  assert.equal(env.store.privateThoughtSource(old),null);
  assert.equal(env.store.finishPrivateThought(old,{status:'abandoned'}),false);
  assert.equal(env.store.finishPrivateThought(old,{status:'stale'}),true);
  const ticket=env.store.claimDuePrivateThought();
  assert.equal(ticket.userId,bob.userId);
  env.store.disableUser(bob.userId); env.store.disableUser(bob.userId,false);
  assert.equal(env.store.startPrivateThoughtRead(ticket,{sourceId:b.sourceId,url}),false);
  assert.equal(env.store.finishPrivateThought(ticket,{status:'stale'}),true);
  assert.equal(env.store.claimDuePrivateThought(),null);
});

test('a changed original or mismatched delivery is unavailable; model text cannot replace it', t => {
  const env=fixture(t), owner=env.user('alice');
  const turn=env.turn(owner);
  env.advance(day);
  const ticket=env.store.claimDuePrivateThought();
  env.edit(db => db.prepare('UPDATE messages SET text=? WHERE id=?').run('Replacement article '+url+'/other',turn.sourceId));
  assert.deepEqual(env.store.privateThoughtSource(ticket),{valid:false,inbound:[],sent:[]});
  assert.equal(env.store.startPrivateThoughtRead(ticket,{sourceId:turn.sourceId,url:url+'/other'}),false);
  assert.equal(env.store.finishPrivateThought(ticket,{status:'unavailable',receipt:{reason:'source-unavailable'}}),true);
  assert.equal(env.store.listPrivateThoughts(owner)[0].review.receipt.reason,'source-unavailable');
  const second=env.turn(owner);
  env.advance(day);
  const another=env.store.claimDuePrivateThought();
  env.edit(db => db.prepare('UPDATE private_thoughts SET sent_message_ids=? WHERE logical_reply_id=?').run('[]',second.logicalReplyId));
  assert.equal(env.store.privateThoughtSource(another).valid,false);
  assert.equal(env.store.startPrivateThoughtRead(another,{sourceId:second.sourceId,url}),false);
  assert.equal(env.store.finishPrivateThought(another,{status:'unavailable',receipt:{reason:'source-unavailable'}}),true);
});

test('an earlier route cannot authorize reading after account reactivation or rebinding', t => {
  const env=fixture(t), owner=env.user('alice'), turn=env.turn(owner);
  env.store.disableUser(owner.userId);
  env.store.disableUser(owner.userId,false);
  env.advance(day);
  const ticket=env.store.claimDuePrivateThought();
  assert.deepEqual(env.store.privateThoughtSource(ticket),{valid:false,inbound:[],sent:[]});
  assert.equal(env.store.startPrivateThoughtRead(ticket,{sourceId:turn.sourceId,url}),false);
  assert.equal(env.store.finishPrivateThought(ticket,{status:'unavailable',receipt:{reason:'route-changed'}}),true);
  const later=env.turn(owner);
  env.advance(day);
  const claimed=env.store.claimDuePrivateThought();
  env.edit(db => db.prepare('UPDATE bindings SET memory_scope=?,route_version=route_version+1 WHERE user_id=?')
    .run('qq:private:90123',owner.userId));
  assert.equal(env.store.privateThoughtSource(claimed),null);
  assert.equal(env.store.startPrivateThoughtRead(claimed,{sourceId:later.sourceId,url}),false);
  assert.deepEqual(env.store.listPrivateThoughts(owner),[]);
  assert.deepEqual(env.store.listPrivateThoughts({...owner,scope:'qq:private:90123'}),[]);
  env.advance(lease);
  assert.equal(env.store.claimDuePrivateThought(),null);
});

test('complete articles retain the tail and require a digest and length for the entire extracted text', t => {
  const env=fixture(t), owner=env.user('alice'), turn=env.turn(owner);
  env.advance(day);
  const ticket=env.store.claimDuePrivateThought();
  assert.equal(env.store.startPrivateThoughtRead(ticket,{sourceId:turn.sourceId,url}),true);
  const article=words.repeat(30)+' end of the original.';
  const receipt={...readReceipt(),coverage:'complete-article',excerpt:article,textLength:article.length,contentHash:digest(article)};
  for (const invalid of [
    {...receipt,excerpt:article.slice(0,600)},
    {...receipt,contentHash:digest(words)},
    {...receipt,coverage:'page-excerpt'}
  ]) assert.equal(env.store.finishPrivateThought(ticket,{status:'read',receipt:invalid}),false);
  assert.equal(env.store.finishPrivateThought(ticket,{status:'read',receipt}),true);
  env.reopen();
  assert.deepEqual(env.store.listPrivateThoughts(owner)[0].review.receipt,receipt);
});

test('a native PWA quote resolves one authenticated prior share, retaining its original source id', t => {
  const env=fixture(t), owner=env.user('alice'), bob=env.user('bob');
  function share(person, epoch) {
    const msg=env.store.acceptInbound({userId:person.userId,clientMessageId:randomUUID(),text:'Here is the article '+url});
    const context=epoch ? {channel:'pwa',privateIdentity:msg.identity,memoryEpochToken:{scope:person.scope,epoch}} : {};
    env.store.markInboxProjected(msg.inboxId,context);
    env.store.completeInbox(msg.inboxId);
    return msg.inboxId;
  }
  const earlier=share(owner,owner.epoch);
  const quoted=env.turn(owner,'star map','The article I mentioned.',earlier);
  env.advance(day);
  const ticket=env.store.claimDuePrivateThought();
  assert.deepEqual(env.store.privateThoughtSource(ticket).inbound.map(m => m.id),[quoted.sourceId,earlier]);
  assert.equal(env.store.startPrivateThoughtRead(ticket,{sourceId:earlier,url}),true);
  assert.equal(env.store.finishPrivateThought(ticket,{status:'read',receipt:readReceipt()}),true);
  assert.equal(env.store.listPrivateThoughts(owner)[0].review.sourceId,earlier);

  const foreign=share(bob,bob.epoch);
  assert.throws(() => env.turn(owner,'star map','An invalid quote',foreign),/reply-unavailable/);
  // Legacy or uncertain intake, another epoch, a bot reply, and a quote of a
  // quote do not qualify as an authenticated original external source.
  for (const ref of [share(owner,null),share(owner,randomUUID()),quoted.sentIds[0],quoted.sourceId]) {
    const next=env.turn(owner,'star map','Read the one I quoted',ref);
    env.advance(day);
    const review=env.store.claimDuePrivateThought();
    const sources=env.store.privateThoughtSource(review).inbound;
    assert.equal(sources[0].id,next.sourceId);
    assert.equal(sources.some(m => m.text.includes(url)),false);
    assert.equal(env.store.startPrivateThoughtRead(review,{sourceId:earlier,url}),false);
    assert.equal(env.store.startPrivateThoughtRead(review,{sourceId:ref,url}),false);
    assert.equal(env.store.finishPrivateThought(review,{status:'unavailable',receipt:{reason:'source-unavailable'}}),true);
  }
});
