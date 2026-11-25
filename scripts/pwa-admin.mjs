#!/usr/bin/env node
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPwaStore } from '../src/pwa-store.js';

function argumentsFor(args) {
  const values={};let command;
  for(let i=0;i<args.length;i++) {
    const value=args[i];
    if(value.startsWith('--')) {
      const key=value.slice(2);if(!['database','origin','scope','role','hours','user','session','invitation','channel'].includes(key))throw Error('unknown-option');
      if(!args[i+1]||args[i+1].startsWith('--')||values[key]!==undefined)throw Error('missing-or-duplicate-option');values[key]=args[++i];
    } else if(command)throw Error('unexpected-argument');else command=value;
  }
  if(!command||!values.database)throw Error('command-and-database-required');
  return {command,...values};
}
function existingDatabase(path) {
  const target=resolve(path),info=lstatSync(target);
  if(!info.isFile()||info.isSymbolicLink())throw Error('unsafe-database-file');return target;
}
function expires(hours,defaultHours) {const amount=hours===undefined?defaultHours:Number(hours);if(!Number.isFinite(amount)||amount<=0||amount>168)throw Error('invalid-hours');return Date.now()+Math.round(amount*3600000);}
function tokenLink(origin,key,token) {
  if(!origin)return undefined;const url=new URL(origin);
  if(url.protocol!=='https:'||url.origin!==origin)throw Error('canonical-https-origin-required');
  return `${origin}/#${key}=${encodeURIComponent(token)}`;
}

/** Only explicitly issuing invite/reset/recovery prints a one-time secret. Never logs to disk. */
export function runPwaAdmin(args) {
  const input=argumentsFor(args);
  if(input.command==='initialize') {
    const path=resolve(input.database);
    try{lstatSync(path);throw Error('database-already-exists');}catch(error){if(error.code!=='ENOENT')throw error;}
    const store=createPwaStore({path});try{return {ok:true,initialized:true,path,diagnostics:store.diagnostics()};}finally{store.close();}
  }
  const path=existingDatabase(input.database);
  // Validate before any mutation; a bad origin must not consume an invitation.
  if(input.origin)tokenLink(input.origin,'invite','validation');
  const store=createPwaStore({path,readOnly:input.command==='status'});
  try {
    switch(input.command) {
      case 'status':return {ok:true,diagnostics:store.diagnostics(),users:store.listUsers()};
      case 'invite': {const value=store.createInvitation({memoryScope:input.scope||null,role:input.role||'friend',expiresAt:expires(input.hours,72)});
        return {...value,link:tokenLink(input.origin,'invite',value.token),secret:true};}
      case 'revoke-invite':if(!input.invitation)throw Error('invitation-required');return store.revokeInvitation(input.invitation);
      case 'verify-binding':if(!input.user)throw Error('user-required');return {ok:true,identity:store.verifyBinding(input.user)};
      case 'disable':if(!input.user)throw Error('user-required');return {ok:true,user:store.disableUser(input.user)};
      case 'revoke-session':if(!input.session)throw Error('session-required');return store.revokeSession(input.session);
      case 'reset-login':case 'recover-login': {
        if(!input.user)throw Error('user-required');
        const options={expiresAt:expires(input.hours,1)},value=input.command==='recover-login'?store.recoverUserAccess(input.user,options):store.createPasswordReset(input.user,options);
        return {...value,link:tokenLink(input.origin,'reset',value.token),secret:true};
      }
      case 'set-channel':if(!input.user||!input.channel)throw Error('user-and-channel-required');
        if(input.channel!=='pwa')throw Error('invalid-channel');
        return {ok:true,identity:store.setPreferredChannel(input.user,'pwa')};
      default:throw Error('unknown-command');
    }
  } finally {store.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {process.stdout.write(JSON.stringify(runPwaAdmin(process.argv.slice(2)),null,2)+'\n');}
  catch(error) {process.stderr.write(JSON.stringify({ok:false,error:error.code&&/^[a-z0-9_-]+$/i.test(error.code)?error.code:/^[a-z-]+$/.test(error.message)?error.message:'operation-failed'})+'\n');process.exitCode=1;}
}
