#!/usr/bin/env node
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstat, readFile, open, chmod, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPwaStore } from '../src/pwa-store.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function regular(path) {const target=resolve(path),info=await lstat(target);if(!info.isFile()||info.isSymbolicLink())throw Error('unsafe-database-file');return await realpath(target);}
async function freshFile(path,bytes,mode=0o600) {
  const target=resolve(path);await mkdir(dirname(target),{recursive:true,mode:0o700});const parent=await lstat(dirname(target));
  if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('unsafe-output-directory');
  const handle=await open(target,'wx',mode);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  const dir=await open(dirname(target),'r');try{await dir.sync();}finally{await dir.close();}return target;
}
export async function inspectPwaBackup(path,{manifestPath=path+'.manifest.json',requireManifest=true}={}) {
  const target=await regular(path),bytes=await readFile(target);let manifest;
  try{manifest=JSON.parse(await readFile(await regular(manifestPath),'utf8'));}
  catch(error){if(error.code!=='ENOENT'||requireManifest)throw error;}
  if(manifest&&(manifest.version!==1||manifest.sha256!==hash(bytes)||manifest.bytes!==bytes.length))throw Error('backup-manifest-mismatch');
  const db=new Database(target,{readonly:true,fileMustExist:true});
  try {
    if(db.pragma('user_version',{simple:true})!==1)throw Error('unsupported-database-version');
    const integrity=db.pragma('integrity_check',{simple:true});if(integrity!=='ok'||db.pragma('foreign_key_check').length)throw Error('backup-integrity-failed');
    const count=table=>db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
    return {ok:true,version:1,sha256:hash(bytes),bytes:bytes.length,integrity:'ok',counts:{users:count('users'),messages:count('messages'),inbox:count('inbox'),projections:count('projections'),media:count('media'),subscriptions:count('subscriptions')},
      authentication:manifest?.authentication||'preserved',mediaIncluded:false,coreDataIncluded:false};
  } finally {db.close();}
}
export async function backupPwaDatabase({database,output}={}) {
  const source=await regular(database),target=resolve(output);
  if(source===target)throw Error('backup-must-be-separate');
  const store=createPwaStore({path:source,readOnly:true});try{await store.backup(target);}finally{store.close();}
  const info=await inspectPwaBackup(target,{requireManifest:false});
  const manifest={version:1,createdAt:new Date().toISOString(),sha256:info.sha256,bytes:info.bytes,
    mechanism:'sqlite-online-backup',authentication:'preserved',mediaIncluded:false,coreDataIncluded:false};
  await freshFile(target+'.manifest.json',JSON.stringify(manifest,null,2)+'\n');return {...info,output:target,manifestPath:target+'.manifest.json'};
}
export async function restorePwaDatabase({backup,output,disableAllAuth=false}={}) {
  const source=await regular(backup),target=resolve(output);if(source===target)throw Error('restore-must-be-separate');
  const before=await inspectPwaBackup(source);
  // Restoring never replaces a live path. Default is a verification-only, 0400 copy.
  const sourceBytes=await readFile(source);if(hash(sourceBytes)!==before.sha256)throw Error('backup-changed-during-restore');
  await freshFile(target,sourceBytes);
  let authentication='preserved-verification-only';
  if(disableAllAuth){
    const store=createPwaStore({path:target});try{store.quarantineAllAuthentication();}finally{store.close();}
    // Close/checkpoint before hashing. No live source or destination service is touched.
    const db=new Database(target);try{db.pragma('wal_checkpoint(TRUNCATE)');}finally{db.close();}
    authentication='all-users-disabled-all-authorizations-revoked';
  }
  await chmod(target,disableAllAuth?0o600:0o400);
  const bytes=await readFile(target),manifest={version:1,createdAt:new Date().toISOString(),sha256:hash(bytes),bytes:bytes.length,
    mechanism:'verified-new-path-restore',sourceSha256:before.sha256,authentication,mediaIncluded:false,coreDataIncluded:false};
  await freshFile(target+'.manifest.json',JSON.stringify(manifest,null,2)+'\n');
  const inspected=await inspectPwaBackup(target);return {...inspected,output:target,verificationOnly:!disableAllAuth,
    activationAllowed:false,reason:disableAllAuth?'restore-core-media-and-verify-people-before-activation':'verification-only-do-not-point-hub-at-this-copy'};
}
function parseArgs(args){let command;const values={};for(let i=0;i<args.length;i++){
  if(args[i]==='--disable-all-auth'){values.disableAllAuth=true;continue;}
  if(args[i].startsWith('--')){const name=args[i].slice(2);if(!['database','backup','output'].includes(name)||!args[i+1]||args[i+1].startsWith('--')||values[name])throw Error('invalid-option');values[name]=args[++i];}
  else if(command)throw Error('unexpected-argument');else command=args[i];
}return {command,...values};}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const input=parseArgs(process.argv.slice(2));let result;
    if(input.command==='backup'&&input.database&&input.output)result=await backupPwaDatabase(input);
    else if(input.command==='inspect'&&input.backup)result=await inspectPwaBackup(input.backup);
    else if(input.command==='restore'&&input.backup&&input.output)result=await restorePwaDatabase(input);
    else throw Error('command-and-paths-required');process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }catch(error){process.stderr.write(JSON.stringify({ok:false,error:error.code&&/^[a-z0-9_-]+$/i.test(error.code)?error.code:/^[a-z-]+$/.test(error.message)?error.message:'operation-failed'})+'\n');process.exitCode=1;}
}
