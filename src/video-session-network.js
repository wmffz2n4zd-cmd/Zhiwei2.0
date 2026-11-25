import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { isPublicAddress } from './chat-retrieval-http.js';

const MiB = 1024 * 1024;
const hosts = {
  youtube: { first: ['www.youtube.com'], assets: ['ytimg.com', 'googlevideo.com'] },
  bilibili: { first: ['www.bilibili.com', 'api.bilibili.com'], assets: ['hdslb.com', 'bilivideo.com', 'bilivideo.cn'] }
};
const within = (host, suffix) => host === suffix || host.endsWith('.' + suffix);

export function hostKind(platform, host) {
  const permitted = hosts[platform];
  if (permitted?.first.includes(host)) return 'first';
  if (permitted?.assets.some(suffix => within(host, suffix))) return 'asset';
  return null;
}

export function requestKind(source, raw, method, type, mainDocument) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null;
  const kind = hostKind(source.platform, u.hostname);
  if (!kind || !['GET', 'HEAD', 'POST'].includes(method)) return null;
  if (type === 'document') {
    const expected = new URL(source.url);
    if (source.platform === 'bilibili') {
      u.searchParams.delete('vd_source');
      if (u.searchParams.get('p') === '1' && u.searchParams.getAll('p').length === 1) u.searchParams.delete('p');
    }
    return mainDocument && method === 'GET' && u.origin === expected.origin
      && u.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '') && u.search === expected.search ? 'first' : null;
  }
  if (kind === 'asset') {
    if (method === 'POST') return null;
    if (source.platform === 'youtube' && within(u.hostname, 'googlevideo.com')) return u.pathname === '/videoplayback' ? 'asset' : null;
    if (source.platform === 'bilibili' && /^(aisubtitle|i[012])\.hdslb\.com$/.test(u.hostname) && /^\/bfs\/(?:ai_)?subtitle\/.+/.test(u.pathname)) return 'asset';
    return /\.(?:mp4|m4s|js|mjs|css|woff2?|ttf)$/i.test(u.pathname) ? 'asset' : null;
  }
  if (source.platform === 'youtube') {
    if (method === 'POST') return u.pathname === '/youtubei/v1/player' ? 'first' : null;
    if (u.pathname === '/api/timedtext' && u.searchParams.get('v') === source.id) return 'first';
    return /^\/s\/(?:player|desktop)\//.test(u.pathname) && /\.(?:js|css)$/.test(u.pathname) ? 'first' : null;
  }
  if (method === 'POST' || u.hostname !== 'api.bilibili.com') return null;
  if (u.pathname === '/x/web-interface/nav') return !u.search ? 'first' : null;
  if (!/^\/x\/(?:web-interface\/view|player\/(?:wbi\/)?(?:v2|playurl))$/.test(u.pathname)) return null;
  const bvid = u.searchParams.get('bvid'), aid = u.searchParams.get('aid') || u.searchParams.get('avid'), cid = u.searchParams.get('cid');
  const boundAid = source.id.startsWith('av') ? source.id.slice(2) : source.expectedAid && String(source.expectedAid);
  const boundCid = source.expectedCid && String(source.expectedCid);
  if ((bvid && bvid !== source.id && bvid !== source.expectedBvid) || (aid && boundAid && aid !== boundAid) || (cid && boundCid && cid !== boundCid)) return null;
  const sameVideo = (bvid && (bvid === source.id || bvid === source.expectedBvid)) || (aid && aid === boundAid) || (cid && cid === boundCid);
  return sameVideo ? 'first' : null;
}

// Only the Node request contexts use this gateway. Chromium's native traffic
// goes to the separate deny port, including before a page route exists.
export async function openGate(platform) {
  const sockets = new Set();
  let bytes = 0;
  let closed = false;
  function track(socket) {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    return socket;
  }
  function count(data) {
    bytes += data.length;
    if (bytes > 100 * MiB) for (const socket of sockets) socket.destroy();
  }
  const deny = net.createServer(socket => socket.destroy());
  const proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  proxy.on('connection', track);
  proxy.on('connect', async (req, client, head) => {
    const match = /^([a-z0-9.-]+):443$/.exec(req.url);
    if (closed || bytes >= 100 * MiB || !match || !hostKind(platform, match[1])) { client.destroy(); return; }
    try {
      const records = await lookup(match[1], { all: true });
      if (closed || client.destroyed || !records.length || records.some(r => !isPublicAddress(r.address))) { client.destroy(); return; }
      const pin = records.find(r => r.family === 4) || records[0];
      const upstream = track(net.connect({ host: pin.address, family: pin.family, port: 443 }));
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      upstream.setTimeout(18000, () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) { count(head); upstream.write(head); }
        upstream.on('data', count); client.on('data', count);
        upstream.pipe(client); client.pipe(upstream);
      });
    } catch { client.destroy(); }
  });
  const listen = async server => {
    await new Promise((ok, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ok); });
    return 'http://127.0.0.1:' + server.address().port;
  };
  try {
    const browserDeny = await listen(deny);
    const server = await listen(proxy);
    return { browserDeny, server, close() { closed = true; for (const socket of sockets) socket.destroy(); deny.close(); proxy.close(); } };
  } catch (error) { deny.close(); proxy.close(); throw error; }
}
