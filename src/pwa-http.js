import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { validatePushSubscription, validatePushEndpoint } from './pwa-push.js';

const cookieName = '__Host-zhiwei';
const error = (status, code) => Object.assign(Error(code), { status, code });
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };
const security = {
  'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()', 'Cache-Control':'no-store'
};
function cookie(token, clear = false) {
  return `${cookieName}=${clear ? '' : token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 30*86400}`;
}
function sessionToken(req) {
  const parts = String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(cookieName+'='));
  if (parts.length !== 1) return null;
  const token = parts[0].slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{32,256}$/.test(token) ? token : null;
}
async function body(req, limit, json = true) {
  if (Number(req.headers['content-length']) > limit) throw error(413, 'request-too-large');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw error(413, 'request-too-large');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!json) return bytes;
  if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/json') throw error(415, 'json-required');
  try { const value = JSON.parse(bytes.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
  catch { throw error(400, 'invalid-request'); }
}
export function createPwaHttp({ store, auth, media, history, stickers, publicDir, origin, onAccepted, readLegacyHistory, pushPublicKey = '', readOnly = false, spaceEnabled = false }) {
  const canonical = new URL(origin);
  if (canonical.protocol !== 'https:' || canonical.origin !== origin) throw Error('A canonical HTTPS PWA origin is required');
  const streams = new Map(), limits = new Map(); let closing = false;
  const send = (res, status, value, extra = {}) => { res.writeHead(status, { ...security, 'Content-Type':'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(value)); };
  function throttle(req, action, cap) {
    // Only the dedicated loopback proxy may supply its overwritten real IP.
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '').slice(0,80);
    const key = `${action}:${ip}`, now = Date.now(), record = limits.get(key);
    if (limits.size > 10000) for (const [k,v] of limits) if (v.until <= now) limits.delete(k);
    if (!record || record.until <= now) { if (limits.size >= 10000) throw error(429,'try-later'); limits.set(key,{until:now+60000,count:1}); }
    else if (++record.count > cap) throw error(429,'try-later');
  }
  function authenticated(req) {
    const token = sessionToken(req), identity = token && auth.authenticate(token);
    if (!identity) throw error(401,'session-expired');
    return identity;
  }
  function changed(userId) {
    for (const [res, state] of streams) if (state.userId === userId) res.write('event: message\ndata: {}\n\n');
  }
  function queryNumber(url, name) {
    if (!url.searchParams.has(name)) return undefined;
    const text = url.searchParams.get(name);
    if (!/^\d{1,15}$/.test(text)) throw error(400,'invalid-cursor');
    const number = Number(text); if (!Number.isSafeInteger(number)) throw error(400,'invalid-cursor'); return number;
  }
  const server = createServer(async (req,res) => {
    try {
      if (closing) throw error(503,'maintenance');
      if (req.headers.host !== canonical.host) throw error(421,'invalid-host');
      if (!req.url || req.url.length > 2048) throw error(400,'invalid-path');
      const url = new URL(req.url, origin), method = req.method;
      let path;
      try { path = decodeURIComponent(url.pathname); }
      catch { throw error(400,'invalid-path'); }
      if (/[\u0000-\u001f\u007f]/.test(path)) throw error(400,'invalid-path');
      throttle(req,'all',180);
      if (['POST','PUT','DELETE','PATCH'].includes(method)) {
        if (req.headers.origin !== origin || req.headers['x-pwa-request'] !== '1'
          || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw error(403,'invalid-origin');
      }
      if (method === 'POST' && ['/api/pwa/session','/api/pwa/invitations/claim','/api/pwa/password-reset'].includes(path)) {
        throttle(req,'login',8); const input = await body(req,16384);
        let login;
        try {
          if (path.endsWith('/claim')) login = await auth.claim(input);
          else if (path.endsWith('/password-reset')) { await auth.reset(input); return send(res,200,{ok:true},{'Set-Cookie':cookie('',true)}); }
          else login = await auth.login(input);
        } catch { throw error(401,'login-unavailable'); }
        return send(res,200,{ok:true,user:publicUser(login.user),pendingBinding:login.identity?.status === 'pending'}, {'Set-Cookie':cookie(login.token)});
      }
      if (path.startsWith('/api/pwa/')) {
        const context = authenticated(req), userId = context.user.id, sessionId = context.session.id;
        if (method !== 'GET' && !auth.csrf(context.session, req.headers['x-csrf-token'])) throw error(403,'invalid-csrf');
        if (method === 'GET' && path === '/api/pwa/me') return send(res,200,{user:publicUser(context.user),csrfToken:context.csrfToken,
          capabilities:{images:true,references:true,historySearch:Boolean(history),stickers:Boolean(stickers),space:spaceEnabled === true,legacyHistory:typeof readLegacyHistory === 'function' && /^qq:private:\d+$/.test(context.identity?.memoryScope || ''),notifications:Boolean(pushPublicKey) && !readOnly,chat:context.identity?.status !== 'pending' && !readOnly},readOnly,
          pendingBinding:context.identity?.status === 'pending',pushPublicKey,push:publicPush(store.getSubscription?.(sessionId))});
        if (method === 'DELETE' && path === '/api/pwa/session') {
          store.revokeSession(sessionId); closeSession(sessionId); return send(res,200,{ok:true},{'Set-Cookie':cookie('',true)});
        }
        const commentsRoute = /^\/api\/pwa\/space\/posts\/([1-9]\d{0,15})\/comments$/.exec(path);
        if (commentsRoute) {
          const postId = Number(commentsRoute[1]);
          if (spaceEnabled !== true || !Number.isSafeInteger(postId)) throw error(404,'not-found');
          if (method === 'GET') return send(res,200,store.listSpaceComments(postId,{
            before:queryNumber(url,'before'),limit:queryNumber(url,'limit') ?? 20
          }));
          if (method !== 'POST') throw error(405,'method-not-allowed');
          if (readOnly) throw error(503,'read-only-maintenance');
          const input = await body(req,16384);
          authenticated(req);
          if (closing) throw error(503,'maintenance');
          if (Object.keys(input).some(key => key !== 'clientCommentId' && key !== 'text')) throw error(400,'invalid-space-comment');
          const result = store.addSpaceComment({userId,postId,clientCommentId:input.clientCommentId,text:input.text});
          return send(res,result.duplicate ? 200 : 201,result);
        }
        if (method === 'GET' && spaceEnabled === true) {
          if (path === '/api/pwa/space/posts') return send(res,200,store.listSpacePosts({
            before:queryNumber(url,'before'),limit:queryNumber(url,'limit') ?? 20
          }));
          const match = /^\/api\/pwa\/space\/posts\/([1-9]\d{0,15})$/.exec(path);
          if (match) {
            const id = Number(match[1]), post = Number.isSafeInteger(id) && store.getSpacePost(id);
            if (!post) throw error(404,'not-found');
            return send(res,200,{post});
          }
        }
        if (context.identity?.status === 'pending') throw error(403,'binding-pending');
        if (method === 'GET' && ['/api/pwa/history/search','/api/pwa/history'].includes(path)) {
          if (!history) throw error(404,'not-found');
          const result = await history.search(userId, { q:url.searchParams.get('q') ?? '', from:url.searchParams.get('from') ?? '',
            to:url.searchParams.get('to') ?? '', speaker:url.searchParams.get('speaker') ?? 'all', source:url.searchParams.get('source') ?? 'all',
            cursor:url.searchParams.get('cursor'), limit:queryNumber(url,'limit') ?? 30 });
          authenticated(req); return send(res,200,result);
        }
        if (method === 'GET' && ['/api/pwa/history/context','/api/pwa/references'].includes(path)) {
          if (!history) throw error(404,'not-found');
          const ref = url.searchParams.get('ref') ?? url.searchParams.get('id');
          const result = path.endsWith('/context') ? await history.context(userId,ref) : {record:await history.resolve(userId,ref)};
          authenticated(req); return send(res,200,result);
        }
        if (readOnly && ['POST','PUT','DELETE'].includes(method) && path.startsWith('/api/pwa/stickers')) throw error(503,'read-only-maintenance');
        if (method === 'GET' && path === '/api/pwa/stickers') {
          if (!stickers) throw error(404,'not-found');
          const result = await stickers.list(userId,{view:url.searchParams.get('view') ?? 'favourites',limit:queryNumber(url,'limit') ?? 60,cursor:url.searchParams.get('cursor')});
          authenticated(req); return send(res,200,result);
        }
        if (method === 'POST' && path === '/api/pwa/stickers') {
          if (!stickers) throw error(404,'not-found'); const input = await body(req,4096); authenticated(req);
          const result = await stickers.save(userId,{mediaId:input.mediaId,name:input.name},()=>authenticated(req));
          authenticated(req); return send(res,200,result);
        }
        const stickerMatch = /^\/api\/pwa\/stickers\/([a-f0-9-]{36}|shared:[a-f0-9]{64})(\/select)?$/.exec(path);
        if (stickerMatch && (method === 'DELETE' && !stickerMatch[2] || method === 'POST' && stickerMatch[2])) {
          if (!stickers) throw error(404,'not-found');
          const result = method === 'DELETE' ? stickers.remove(userId,stickerMatch[1]) : await stickers.select(userId,stickerMatch[1],()=>authenticated(req));
          authenticated(req); return send(res,200,result);
        }
        if (method === 'GET' && /^\/api\/pwa\/sticker-assets\/[a-f0-9]{64}$/.test(path)) {
          if (!stickers) throw error(404,'not-found');
          const item = await stickers.readShared(userId,`shared:${path.split('/').at(-1)}`,()=>authenticated(req)); authenticated(req);
          res.writeHead(200,{...security,'Content-Type':item.mime,'Content-Length':item.bytes.length,'Content-Disposition':'inline'}); return res.end(item.bytes);
        }
        if (method === 'GET' && path === '/api/pwa/legacy-history') {
          if (typeof readLegacyHistory !== 'function' || !/^qq:private:\d+$/.test(context.identity?.memoryScope || '')) throw error(404,'not-found');
          const result = await readLegacyHistory({scope:context.identity.memoryScope,before:url.searchParams.get('before'),limit:queryNumber(url,'limit') ?? 30});
          authenticated(req); return send(res,200,result);
        }
        if (readOnly && ['POST','PUT'].includes(method) && ['/api/pwa/messages','/api/pwa/media','/api/pwa/push-subscription'].includes(path)) throw error(503,'read-only-maintenance');
        if (method === 'GET' && path === '/api/pwa/messages') return send(res,200,store.listMessages(userId,{after:queryNumber(url,'after'),before:queryNumber(url,'before'),limit:queryNumber(url,'limit') ?? 50}));
        if (method === 'POST' && path === '/api/pwa/messages') {
          const input = await body(req,65536);
          authenticated(req);
          const messageInput = {clientMessageId:input.clientMessageId,text:input.text,mediaIds:input.mediaIds,replyTo:input.replyTo};
          const accepted = history ? await history.acceptInbound(userId,messageInput,()=>authenticated(req)) : store.acceptInbound({userId,...messageInput});
          authenticated(req);
          send(res,200,{message:accepted.message,duplicate:accepted.duplicate}); changed(userId);
          if (!accepted.duplicate) Promise.resolve().then(() => onAccepted?.(accepted.message.id)).catch(() => {});
          return;
        }
        if (method === 'POST' && path === '/api/pwa/read') { const input = await body(req,4096); authenticated(req); const result = store.markRead(userId,input.seq); changed(userId); return send(res,200,result); }
        if (method === 'POST' && path === '/api/pwa/media') {
          throttle(req,'upload',20);
          const data = await body(req,10*1024*1024,false);
          // Recheck revocation after receiving/decoding a potentially slow body.
          authenticated(req);
          const result = await media.upload(userId,data,String(req.headers['content-type']||'').split(';')[0],()=>authenticated(req));
          authenticated(req); return send(res,201,{media:result});
        }
        const workRoute = /^\/api\/pwa\/media\/works\/([a-f0-9-]{36})\/(preview|download\/([A-Za-z0-9_.-]{1,90}))$/.exec(path);
        if (method === 'GET' && workRoute) {
          const name = workRoute[3] || null;
          const file = store.readCreativeFile(userId,workRoute[1],name);
          if (!file) throw error(404,'work-unavailable');
          // Standalone previews get an opaque origin. Only the bundled rotation script may execute.
          const viewer = !name && file.kind === 'model3d' && file.viewerHash;
          const sandbox = viewer ? 'sandbox allow-scripts allow-downloads' : 'sandbox';
          const scripts = viewer || "'none'";
          const policy = `${sandbox}; default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
          res.writeHead(200,{...security,'Content-Security-Policy':policy,
            'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin',
            'Content-Type':name ? 'application/octet-stream' : file.mime + (file.mime === 'text/html' ? '; charset=utf-8' : ''),
            'Content-Length':file.bytes.length,'Content-Disposition':`${name ? 'attachment' : 'inline'}; filename="${file.name}"`});
          return res.end(file.bytes);
        }
        if (method === 'GET' && /^\/api\/pwa\/media\/[a-f0-9-]{36}$/.test(path)) {
          const item = await media.read(userId,path.split('/').at(-1)); authenticated(req);
          res.writeHead(200,{...security,'Content-Type':item.mime,'Content-Length':item.bytes.length,'Content-Disposition':'inline'}); return res.end(item.bytes);
        }
        if (method === 'PUT' && path === '/api/pwa/push-subscription') {
          const input = await body(req,8192), subscription = validatePushSubscription(input.subscription);
          await validatePushEndpoint(subscription.endpoint); authenticated(req);
          const result = store.upsertSubscription({userId,sessionId,subscription,preview:input.preview === true});
          return send(res,200,{ok:true,enabled:true,id:result.id});
        }
        if (method === 'DELETE' && path === '/api/pwa/push-subscription') { store.removeSubscription(sessionId); return send(res,200,{ok:true}); }
        if (method === 'GET' && path === '/api/pwa/events') {
          if ([...streams.values()].filter(x => x.userId === userId).length >= 5) throw error(429,'too-many-connections');
          res.writeHead(200,{...security,'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});
          res.write('event: ready\ndata: {}\n\n'); streams.set(res,{userId,sessionId,token:sessionToken(req)});
          req.on('close',()=>streams.delete(res)); return;
        }
        throw error(404,'not-found');
      }
      if (method !== 'GET' && method !== 'HEAD') throw error(405,'method-not-allowed');
      const spacePage = /^\/space(?:\/[1-9]\d{0,15})?\/?$/.test(path);
      if (spacePage && spaceEnabled !== true) throw error(404,'not-found');
      const asset = path === '/' || spacePage ? 'index.html' : path.slice(1);
      if (!asset || asset.startsWith('.') || asset.includes('..') || asset.includes('\\') || !types[extname(asset)]) throw error(404,'not-found');
      const target = resolve(publicDir,asset);
      if (relative(resolve(publicDir),target).startsWith('..')) throw error(404,'not-found');
      const bytes = await readFile(target).catch(()=>{throw error(404,'not-found');});
      // Deep links also display the static sign-in shell for an expired session.
      // The shell has no user or feed data; requests for either must authenticate.
      const token = spacePage && sessionToken(req);
      const status = spacePage && !(token && auth.authenticate(token)) ? 401 : 200;
      res.writeHead(status,{...security,'Content-Type':types[extname(asset)],...(asset === 'sw.js' ? {'Service-Worker-Allowed':'/'} : {})});
      res.end(method === 'HEAD' ? undefined : bytes);
    } catch (failure) {
      if (res.headersSent) { res.end(); return; }
      const status = Number.isInteger(failure.status) && failure.status >= 400 && failure.status < 600 ? failure.status : 503;
      send(res,status,{error:status >= 500 ? 'service-unavailable' : failure.code || 'request-unavailable'});
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 32;
  const heartbeat = setInterval(()=>{
    for (const [res,state] of streams) {
      try { if (!auth.authenticate(state.token)) { res.end(); streams.delete(res); } else res.write(': keepalive\n\n'); }
      catch { res.end(); streams.delete(res); }
    }
  },3000); heartbeat.unref();
  function closeSession(id) { for (const [res,state] of streams) if (state.sessionId === id) { res.end();streams.delete(res); } }
  return {server,changed,
    listen(port=3790) { return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve(server.address());});}); },
    close() { closing=true;clearInterval(heartbeat);for (const res of streams.keys()) res.end();streams.clear();return new Promise(resolve=>server.close(()=>resolve())); }
  };
}
function publicUser(user) { return {id:user.id,displayName:user.displayName,role:user.role,active:user.active !== false}; }
function publicPush(sub) { return sub ? {enabled:sub.enabled,preview:sub.preview,reason:sub.reason} : {enabled:false,preview:false}; }
