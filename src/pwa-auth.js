import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { PwaStoreError, equalPwaSecret } from './pwa-store.js';

const derive = promisify(scrypt);
const PARAMETERS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const PASSWORD_BYTES = 1024;
const validPassword = password => typeof password === 'string' && password.length >= 10
  && Buffer.byteLength(password,'utf8') <= PASSWORD_BYTES && !password.includes('\0');
const dummy = `scrypt$1$32768$8$1$${Buffer.alloc(16,1).toString('base64url')}$${Buffer.alloc(32,2).toString('base64url')}`;

export function createPwaAuth({ store, maxConcurrent = 2 } = {}) {
  if (!store || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw TypeError('Invalid authentication configuration');
  let active = 0;
  async function bounded(work) {
    // Reject overload rather than retain an unbounded queue of passwords.
    if (active >= maxConcurrent) throw new PwaStoreError('authentication-busy',429);
    active++;
    try { return await work(); } finally { active--; }
  }
  async function hashPassword(password) {
    if (!validPassword(password)) throw new PwaStoreError('password-requirements',400);
    return bounded(async()=>{
      const salt=randomBytes(16), key=await derive(password,salt,32,PARAMETERS);
      return `scrypt$1$${PARAMETERS.N}$${PARAMETERS.r}$${PARAMETERS.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
    });
  }
  async function verifyPassword(password, encoded) {
    if (typeof password !== 'string' || Buffer.byteLength(password,'utf8') > PASSWORD_BYTES) return false;
    const parts=typeof encoded==='string'?encoded.split('$'):[];
    if(parts.length!==7||parts[0]!=='scrypt'||parts[1]!=='1'||parts[2]!=='32768'||parts[3]!=='8'||parts[4]!=='1'
      || !/^[A-Za-z0-9_-]{22}$/.test(parts[5])||!/^[A-Za-z0-9_-]{43}$/.test(parts[6])) return false;
    return bounded(async()=>{
      const actual=await derive(password,Buffer.from(parts[5],'base64url'),32,PARAMETERS), expected=Buffer.from(parts[6],'base64url');
      return expected.length===actual.length&&timingSafeEqual(actual,expected);
    });
  }
  return {
    hashPassword,verifyPassword,
    async claim({token,username,displayName,password,deviceName}={}) {
      const passwordHash=await hashPassword(password);
      const result=store.claimInvitation({token,username,displayName,passwordHash});
      return {...result,...store.createSession({userId:result.user.userId,deviceName})};
    },
    async login({username,password,deviceName}={}) {
      const account=store.getCredentials(typeof username==='string'?username:'');
      const valid=await verifyPassword(password,account?.password_hash||dummy);
      if(!valid||!account?.enabled) throw new PwaStoreError('login-unavailable',401);
      // Re-read inside createSession so a concurrent disable/reset cannot reuse stale credentials.
      const latest=store.getCredentials(username);
      if(!latest?.enabled||latest.password_hash!==account.password_hash||latest.auth_version!==account.auth_version) throw new PwaStoreError('login-unavailable',401);
      return store.createSession({userId:account.id,deviceName});
    },
    async reset({token,password}={}) {const passwordHash=await hashPassword(password);return store.resetPassword({token,passwordHash});},
    authenticate(token,options) {return store.resolveSession(token,options);},
    csrf(session,supplied) {return equalPwaSecret(session?.csrfToken,supplied);},
    logout(sessionId) {return store.revokeSession(sessionId);},
    diagnostics() {return {active,maxConcurrent};}
  };
}
