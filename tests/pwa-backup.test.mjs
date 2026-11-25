import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,stat,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPwaStore } from '../src/pwa-store.js';
import { backupPwaDatabase,inspectPwaBackup,restorePwaDatabase } from '../scripts/pwa-backup.mjs';
import { runPwaAdmin } from '../scripts/pwa-admin.mjs';

async function setup(t) {
  const directory=await mkdtemp(join(tmpdir(),'pwa-backup-')),path=join(directory,'source.sqlite');
  const store=createPwaStore({path});t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const invitation=store.createInvitation(),person=store.claimInvitation({token:invitation.token,username:'alice',displayName:'Alice',passwordHash:'original-hash'});
  const session=store.createSession({userId:person.user.id});store.acceptInbound({userId:person.user.id,clientMessageId:'one',text:'keep the accepted message'});
  return {directory,path,store,person,session};
}

test('online backup captures consistent SQLite, validates manifest, and does not overwrite a checkpoint',async t=>{
  const env=await setup(t),output=join(env.directory,'checkpoint.sqlite');
  const result=await backupPwaDatabase({database:env.path,output});assert.equal(result.integrity,'ok');assert.equal(result.counts.messages,1);
  assert.equal(result.mediaIncluded,false);assert.equal((await stat(output)).mode&0o777,0o600);
  assert.equal((await stat(output+'.manifest.json')).mode&0o777,0o600);
  env.store.acceptInbound({userId:env.person.user.id,clientMessageId:'two',text:'later increment'});
  assert.equal((await inspectPwaBackup(output)).counts.messages,1);assert.equal(env.store.listMessages(env.person.user.id).messages.length,2);
  await assert.rejects(backupPwaDatabase({database:env.path,output}),/EEXIST/);
});

test('default restore is verification-only in a new readonly file and preserves source increment',async t=>{
  const env=await setup(t),backup=join(env.directory,'backup.sqlite'),output=join(env.directory,'verification.sqlite');
  await backupPwaDatabase({database:env.path,output:backup});
  env.store.acceptInbound({userId:env.person.user.id,clientMessageId:'after-backup',text:'newer data'});
  const restored=await restorePwaDatabase({backup,output});assert.equal(restored.verificationOnly,true);assert.equal(restored.activationAllowed,false);
  assert.equal((await stat(output)).mode&0o777,0o400);assert.equal(restored.counts.messages,1);
  assert.equal(env.store.listMessages(env.person.user.id).messages.length,2);
  await assert.rejects(restorePwaDatabase({backup,output:env.path}),/EEXIST/);
  await assert.rejects(restorePwaDatabase({backup,output:backup}),/restore-must-be-separate/);
});

test('restored authentication is quarantined: old passwords, sessions, invites and devices cannot revive',async t=>{
  const env=await setup(t),oldInvite=env.store.createInvitation(),backup=join(env.directory,'backup.sqlite'),output=join(env.directory,'quarantine.sqlite');
  await backupPwaDatabase({database:env.path,output:backup});
  const restored=await restorePwaDatabase({backup,output,disableAllAuth:true});assert.equal(restored.verificationOnly,false);assert.equal(restored.activationAllowed,false);
  const recovered=createPwaStore({path:output});
  try {
    assert.equal(recovered.getUser(env.person.user.id).enabled,false);assert.equal(recovered.resolveSession(env.session.token),null);
    assert.throws(()=>recovered.claimInvitation({token:oldInvite.token,username:'bob',displayName:'B',passwordHash:'x'}),/registration-unavailable/);
    assert.throws(()=>recovered.acceptInbound({userId:env.person.user.id,clientMessageId:'bad',text:'x'}),/account-unavailable/);
    const reset=recovered.recoverUserAccess(env.person.user.id);assert.match(recovered.getCredentials('alice').password_hash,/^locked\$/);
    assert.equal(recovered.resolveSession(env.session.token),null);assert.equal(recovered.resetPassword({token:reset.token,passwordHash:'new-hash'}).ok,true);
    assert.equal(recovered.listMessages(env.person.user.id).messages.length,1);
  } finally {recovered.close();}
});

test('changed or missing manifest cannot silently restore private data',async t=>{
  const env=await setup(t),backup=join(env.directory,'backup.sqlite');await backupPwaDatabase({database:env.path,output:backup});
  const bytes=await readFile(backup);bytes[bytes.length-1]^=1;await writeFile(backup,bytes);
  await assert.rejects(inspectPwaBackup(backup),/backup-manifest-mismatch/);
  await assert.rejects(restorePwaDatabase({backup,output:join(env.directory,'bad-copy.sqlite')}),/backup-manifest-mismatch/);
});

test('internal administrator CLI initializes explicitly, emits tokens only when issued and revokes without exposing credentials',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pwa-admin-'));t.after(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,'admin.sqlite');
  assert.equal(runPwaAdmin(['initialize','--database',path]).initialized,true);
  assert.throws(()=>runPwaAdmin(['initialize','--database',path]),/database-already-exists/);
  const invite=runPwaAdmin(['invite','--database',path,'--role','admin','--origin','https://zhiwei.example']);
  assert.match(invite.link,/#invite=/);assert.equal(invite.secret,true);
  const store=createPwaStore({path});const person=store.claimInvitation({token:invite.token,username:'owner',displayName:'Owner',passwordHash:'not-output'});store.close();
  const status=runPwaAdmin(['status','--database',path]);assert.equal(status.users.length,1);assert.equal(JSON.stringify(status).includes('not-output'),false);assert.equal(JSON.stringify(status).includes(invite.token),false);
  const reset=runPwaAdmin(['reset-login','--database',path,'--user',person.user.id,'--origin','https://zhiwei.example']);assert.match(reset.link,/#reset=/);
  assert.equal(runPwaAdmin(['disable','--database',path,'--user',person.user.id]).user.active,false);
});
