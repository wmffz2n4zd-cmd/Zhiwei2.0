import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createPwaStore } from '../src/pwa-store.js';
import { privateScopeFor } from '../src/private-identity.js';
import { runPwaAdmin } from '../scripts/pwa-admin.mjs';

function setup(t, disk=false) {
  let at=1800000000000;
  const directory=disk?mkdtempSync(join(tmpdir(),'pwa-store-')):null;
  const path=directory?join(directory,'pwa.sqlite'):':memory:';
  let store=createPwaStore({path,now:()=>at});
  t.after(()=>{store.close();if(directory)rmSync(directory,{recursive:true,force:true});});
  const user=(username='alice',options={})=>{
    const invite=store.createInvitation(options);
    return store.claimInvitation({token:invite.token,username,displayName:username,passwordHash:'internal-test-hash'});
  };
  return {get store(){return store;},user,path,now:()=>at,advance:ms=>at+=ms,
    reopen(){store.close();store=createPwaStore({path,now:()=>at});return store;}};
}
function accepted(store,userId,id='client:1',text='你好') {
  const input=store.acceptInbound({userId,clientMessageId:id,text});
  store.markInboxProjected(input.inboxId,{contactToken:{sequence:1}});return input;
}
function publish(store,input,options={}) {
  return store.publishSegments({userId:input.message.userId,scope:input.identity.memoryScope,
    routeVersion:input.identity.routeVersion,generation:input.identity.generation,inboundIds:[input.inboxId],
    deliveryId:'reply:1:0',logicalReplyId:'reply:1',segments:[{type:'text',text:'你好呀'}],
    projection:{version:1,replyText:'你好呀'},...options});
}
const subscription={endpoint:'https://web.push.apple.com/example',keys:{p256dh:'B'.repeat(87),auth:'A'.repeat(22)}};

test('invitation is consumed once; legacy binding is pending and unique',t=>{
  const env=setup(t),store=env.store,invite=store.createInvitation({memoryScope:'qq:private:12345',role:'admin'});
  const claim=store.claimInvitation({token:invite.token,username:'alice',displayName:'A',passwordHash:'internal-test-hash'});
  assert.equal(claim.identity.bindingStatus,'pending');assert.equal(claim.user.role,'admin');
  assert.equal(claim.identity.preferredChannel,'pwa');
  assert.throws(()=>store.claimInvitation({token:invite.token,username:'bob',displayName:'B',passwordHash:'x'}),/registration-unavailable/);
  assert.throws(()=>store.listMessages(claim.user.id),/binding-pending/);
  assert.throws(()=>store.acceptInbound({userId:claim.user.id,clientMessageId:'x',text:'x'}),/binding-pending/);
  assert.throws(()=>store.createInvitation({memoryScope:'qq:private:12345'}),/identity-already-bound/);
  const verified=store.verifyBinding(claim.user.id);
  assert.equal(verified.bindingStatus,'active');assert.equal(verified.preferredChannel,'pwa');
  assert.equal(verified.routeVersion,claim.identity.routeVersion+1);
  assert.equal(store.listMessages(claim.user.id).messages.length,0);
});

test('expired and revoked invitations fail; new people use distinct private scopes',t=>{
  const env=setup(t),store=env.store,old=store.createInvitation({expiresAt:env.now()+10});env.advance(11);
  assert.throws(()=>store.claimInvitation({token:old.token,username:'alice',displayName:'A',passwordHash:'x'}),/registration-unavailable/);
  const revoked=store.createInvitation();store.revokeInvitation(revoked.id);
  assert.throws(()=>store.claimInvitation({token:revoked.token,username:'alice',displayName:'A',passwordHash:'x'}),/registration-unavailable/);
  const a=env.user('alice'),b=env.user('bob');assert.notEqual(a.identity.memoryScope,b.identity.memoryScope);
  assert.match(a.identity.memoryScope,/^private:user:/);assert.throws(()=>privateScopeFor({type:'private_message',senderId:'bad'}));
  assert.equal(privateScopeFor({type:'private_message',channel:'pwa',privateIdentity:a.identity}),a.identity.memoryScope);
});

test('inbound stable id is idempotent and stores acceptance generation, not later generation',t=>{
  const env=setup(t),store=env.store,a=env.user(),first=store.acceptInbound({userId:a.user.id,clientMessageId:'one',text:'first'});
  const retry=store.acceptInbound({userId:a.user.id,clientMessageId:'one',text:'first'});
  assert.equal(retry.duplicate,true);assert.equal(retry.message.id,first.message.id);assert.equal(retry.identity.generation,1);
  assert.throws(()=>store.acceptInbound({userId:a.user.id,clientMessageId:'one',text:'changed'}),/message-id-conflict/);
  store.acceptInbound({userId:a.user.id,clientMessageId:'two',text:'next'});
  assert.equal(store.getInbox(first.inboxId).identity.generation,1);assert.equal(store.getIdentity(a.user.id).generation,2);
});

test('initial history is the recent page; explicit cursors preserve ordered pagination',t=>{
  const env=setup(t),store=env.store,a=env.user();
  const rows=Array.from({length:5},(_,i)=>store.acceptInbound({userId:a.user.id,clientMessageId:`m:${i}`,text:`message ${i}`}).message);
  const latest=store.listMessages(a.user.id,{limit:2});assert.deepEqual(latest.messages.map(row=>row.id),rows.slice(-2).map(row=>row.id));assert.equal(latest.hasMore,true);
  assert.deepEqual(store.listMessages(a.user.id,{after:0,limit:2}).messages.map(row=>row.id),rows.slice(0,2).map(row=>row.id));
  const older=store.listMessages(a.user.id,{before:rows[3].seq,limit:2});assert.deepEqual(older.messages.map(row=>row.id),rows.slice(1,3).map(row=>row.id));
  assert.throws(()=>store.listMessages(a.user.id,{after:0,before:rows[3].seq}),/invalid-cursor/);
});

test('cross-user references, media and cursor probes are rejected',t=>{
  const env=setup(t),store=env.store,a=env.user('alice'),b=env.user('bob'),incoming=accepted(store,a.user.id);
  const media=store.addMedia({userId:a.user.id,id:randomUUID(),path:'/private/test.png',mime:'image/png',size:10,sha256:'a'.repeat(64)});
  assert.equal(store.getOwnMessage(b.user.id,incoming.message.id),null);assert.equal(store.getMedia(b.user.id,media.id),null);
  assert.throws(()=>store.acceptInbound({userId:b.user.id,clientMessageId:'b1',text:'x',replyTo:incoming.message.id}),/reply-unavailable/);
  assert.throws(()=>store.acceptInbound({userId:b.user.id,clientMessageId:'b2',mediaIds:[media.id]}),/media-unavailable/);
  assert.throws(()=>store.acceptInbound({userId:a.user.id,clientMessageId:'too-many-images',mediaIds:Array.from({length:5},()=>randomUUID())}),/invalid-message/);
  assert.throws(()=>store.listMessages(b.user.id,{after:incoming.message.seq}),/invalid-cursor/);
  assert.throws(()=>store.markRead(b.user.id,incoming.message.seq),/invalid-cursor/);
});

test('accepted intake barrier, route and latest generation protect final publication',t=>{
  const env=setup(t),store=env.store,a=env.user(),input=store.acceptInbound({userId:a.user.id,clientMessageId:'1',text:'one'});
  assert.throws(()=>publish(store,input),/intake-pending/);store.markInboxProjected(input.inboxId);
  const next=store.acceptInbound({userId:a.user.id,clientMessageId:'2',text:'two'});
  assert.throws(()=>publish(store,input),/delivery-stale/);store.markInboxProjected(next.inboxId);
  store.disableUser(a.user.id);assert.throws(()=>publish(store,next),/account-unavailable/);
});

// QQ callback intake is intentionally retired. Preserve old receipt rows and
// bindings for historical recovery without exposing a new QQ writer/route.
test('QQ channel selection and external intake are retired while historical rows survive reopen',t=>{
  const env=setup(t,true),store=env.store,a=env.user('alice',{memoryScope:'qq:private:123'});store.verifyBinding(a.user.id);
  const input=accepted(store,a.user.id),before=store.getIdentity(a.user.id);
  assert.equal(store.observeExternalIncoming,undefined);
  assert.throws(()=>store.setPreferredChannel(a.user.id,'qq'),/invalid-channel/);
  assert.throws(()=>runPwaAdmin(['set-channel','--database',env.path,'--user',a.user.id,'--channel','qq']),/invalid-channel/);
  assert.deepEqual(store.getIdentity(a.user.id),before);
  const db=new Database(env.path);
  db.prepare('INSERT INTO external_incoming(memory_scope,source_id,created_at) VALUES(?,?,?)').run(before.memoryScope,'qq:historical',env.now());
  db.prepare("UPDATE bindings SET preferred_channel='qq' WHERE user_id=?").run(a.user.id);
  db.close();
  const reopened=env.reopen();
  assert.equal(reopened.getIdentity(a.user.id).preferredChannel,'qq','Opening does not silently rewrite historical routing');
  assert.equal(reopened.listMessages(a.user.id).messages[0].id,input.message.id);
  const repair=runPwaAdmin(['set-channel','--database',env.path,'--user',a.user.id,'--channel','pwa']);
  assert.equal(repair.identity.preferredChannel,'pwa');
  assert.equal(repair.identity.memoryScope,before.memoryScope);
  const inspect=new Database(env.path,{readonly:true});
  assert.equal(inspect.prepare('SELECT source_id FROM external_incoming WHERE memory_scope=?').get(before.memoryScope).source_id,'qq:historical');
  inspect.close();
});

test('published parts coalesce durable projection; uncommitted successor cannot pass',t=>{
  const env=setup(t),store=env.store,a=env.user(),input=accepted(store,a.user.id),first=publish(store,input);
  assert.equal(store.getDelivery(first.deliveryId).messages[0].id,first.messages[0].id);
  assert.equal(publish(store,input).duplicate,true);
  assert.throws(()=>publish(store,input,{segments:[{type:'text',text:'different'}]}),/delivery-id-conflict/);
  assert.throws(()=>publish(store,input,{deliveryId:'other',logicalReplyId:'other'}),/projection-pending/);
  const second=publish(store,input,{deliveryId:'reply:1:1',segmentIndex:1,allowedPendingProjectionKey:'reply:1',segments:[{type:'text',text:'第二段'}],projection:{version:1,replyText:'你好呀\n\n第二段'}});
  const pending=store.listPendingProjections();assert.equal(pending.length,1);assert.deepEqual(pending[0].payload.sentMessageIds,[first.messages[0].id,second.messages[0].id]);
  assert.equal(pending[0].payload.replyText,'你好呀\n\n第二段');store.claimProjection(pending[0].id);
  assert.throws(()=>publish(store,input,{deliveryId:'reply:1:2',segmentIndex:2,allowedPendingProjectionKey:'reply:1'}),/projection-pending/);
  store.completeProjection(pending[0].id,{memory:'committed'});assert.equal(store.hasPendingProjection(a.identity.memoryScope),false);
});

test('failed projection persists across restart and blocks only its scope',t=>{
  const env=setup(t,true);let store=env.store;const a=env.user('alice'),b=env.user('bob'),input=accepted(store,a.user.id);
  publish(store,input);const job=store.listPendingProjections()[0];store.failProjection(job.id,'disk-error');
  store=env.reopen();assert.equal(store.listPendingProjections()[0].state,'failed');
  const next=accepted(store,a.user.id,'two','new');assert.throws(()=>store.claimInbox(next.inboxId),/projection-pending/);
  const other=accepted(store,b.user.id,'bob','hello');assert.equal(store.claimInbox(other.inboxId).state,'processing');
  store.completeProjection(job.id,{memory:'committed'});assert.equal(store.claimInbox(next.inboxId).state,'processing');
});

test('SQLite abort during publication rolls message, delivery and projection back together',t=>{
  const env=setup(t,true),store=env.store,a=env.user(),input=accepted(store,a.user.id),db=new Database(env.path);
  db.exec("CREATE TRIGGER reject_projection BEFORE INSERT ON projections BEGIN SELECT RAISE(ABORT,'injected-write-failure'); END");
  assert.throws(()=>publish(store,input),/injected-write-failure/);assert.equal(store.listMessages(a.user.id).messages.length,1);
  assert.equal(store.getDelivery('reply:1:0'),null);assert.equal(store.listPendingProjections().length,0);
  db.exec('DROP TRIGGER reject_projection');db.close();assert.equal(publish(store,input).ok,true);
});

test('SQLite abort accepting intake cannot acknowledge or increase generation',t=>{
  const env=setup(t,true),store=env.store,a=env.user(),db=new Database(env.path);
  db.exec("CREATE TRIGGER reject_intake BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT,'injected-intake-failure'); END");
  assert.throws(()=>store.acceptInbound({userId:a.user.id,clientMessageId:'one',text:'one'}),/injected-intake-failure/);
  assert.equal(store.listMessages(a.user.id).messages.length,0);assert.equal(store.getIdentity(a.user.id).generation,0);db.close();
});

test('session, reset, disable and subscription revocations stop pending push',t=>{
  const env=setup(t),store=env.store,a=env.user(),session=store.createSession({userId:a.user.id});
  store.upsertSubscription({userId:a.user.id,sessionId:session.session.id,subscription});
  publish(store,accepted(store,a.user.id));const job=store.claimPushJobs()[0];assert.ok(job);assert.equal(store.getPushAuthorization(job).ok,true);
  store.revokeSession(session.session.id);assert.equal(store.resolveSession(session.token),null);assert.equal(store.getPushAuthorization(job).ok,false);
  assert.equal(store.finishPushJob(job.id,{state:'accepted',leaseToken:job.leaseToken}).ok,false);
  const session2=store.createSession({userId:a.user.id}),reset=store.createPasswordReset(a.user.id);
  assert.equal(store.resolveSession(session2.token),null);assert.equal(store.resetPassword({token:reset.token,passwordHash:'replacement'}).ok,true);
  assert.throws(()=>store.resetPassword({token:reset.token,passwordHash:'replacement'}),/reset-unavailable/);
  const session3=store.createSession({userId:a.user.id});store.disableUser(a.user.id);assert.equal(store.resolveSession(session3.token),null);
});

test('read cursor advances only forwards and push acceptance never marks read',t=>{
  const env=setup(t),store=env.store,a=env.user(),session=store.createSession({userId:a.user.id});
  store.upsertSubscription({userId:a.user.id,sessionId:session.session.id,subscription});
  const input=accepted(store,a.user.id),out=publish(store,input),job=store.claimPushJobs()[0];
  store.finishPushJob(job.id,{state:'accepted',leaseToken:job.leaseToken});assert.equal(store.listMessages(a.user.id).unread,1);
  store.markRead(a.user.id,out.messages[0].seq);store.markRead(a.user.id,input.message.seq);
  assert.equal(store.listMessages(a.user.id).readSeq,out.messages[0].seq);assert.equal(store.listMessages(a.user.id).unread,0);
});

test('expired jobs are not sent, expired leases can resume and replaced lease cannot complete',t=>{
  const env=setup(t),store=env.store,a=env.user(),session=store.createSession({userId:a.user.id});
  store.upsertSubscription({userId:a.user.id,sessionId:session.session.id,subscription});publish(store,accepted(store,a.user.id));
  const first=store.claimPushJobs({leaseMs:1000})[0];env.advance(1001);const second=store.claimPushJobs({leaseMs:1000})[0];
  assert.notEqual(first.leaseToken,second.leaseToken);assert.equal(store.getPushAuthorization(first).ok,false);
  assert.equal(store.finishPushJob(first.id,{state:'accepted',leaseToken:first.leaseToken}).ok,false);
  store.retryPushJob(second.id,{nextAttemptAt:env.now()+1,leaseToken:second.leaseToken});env.advance(3600001);
  assert.equal(store.claimPushJobs().length,0);
});

test('a live endpoint cannot silently move between accounts',t=>{
  const env=setup(t),store=env.store,a=env.user('alice'),b=env.user('bob'),sa=store.createSession({userId:a.user.id}),sb=store.createSession({userId:b.user.id});
  store.upsertSubscription({userId:a.user.id,sessionId:sa.session.id,subscription});
  assert.throws(()=>store.upsertSubscription({userId:b.user.id,sessionId:sb.session.id,subscription}),/subscription-already-bound/);
  store.revokeSession(sa.session.id);assert.equal(store.upsertSubscription({userId:b.user.id,sessionId:sb.session.id,subscription}).enabled,true);
});

test('a stale provider failure cannot invalidate a newer subscription version',t=>{
  const env=setup(t),store=env.store,a=env.user(),session=store.createSession({userId:a.user.id});
  const initial=store.upsertSubscription({userId:a.user.id,sessionId:session.session.id,subscription});
  publish(store,accepted(store,a.user.id));const job=store.claimPushJobs()[0];
  const replacement=store.upsertSubscription({userId:a.user.id,sessionId:session.session.id,
    subscription:{...subscription,endpoint:subscription.endpoint+'-new'}});
  assert.equal(replacement.id,initial.id);
  assert.equal(store.invalidateSubscription(job.subscription.id,{reason:'endpoint-expired',
    expectedAuthorizationVersion:job.subscription.authorizationVersion}).ok,false);
  assert.equal(store.getSubscription(session.session.id).enabled,true);
  assert.equal(store.invalidateSubscription(replacement.id,{reason:'current-endpoint-expired',
    expectedAuthorizationVersion:job.subscription.authorizationVersion+1}).ok,true);
  assert.equal(store.getSubscription(session.session.id).enabled,false);
});

test('database online backup retains accepted messages and revoked session state',async t=>{
  const env=setup(t,true),store=env.store,a=env.user(),session=store.createSession({userId:a.user.id});accepted(store,a.user.id);store.revokeSession(session.session.id);
  const destination=env.path+'.backup';await store.backup(destination);const restored=createPwaStore({path:destination,now:env.now});
  try {assert.equal(restored.listMessages(a.user.id).messages.length,1);assert.equal(restored.resolveSession(session.token),null);assert.equal(restored.listPendingInbox().length,1);} finally {restored.close();}
});
