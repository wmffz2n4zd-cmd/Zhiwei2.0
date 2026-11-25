import { createHash } from 'node:crypto';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, request as playwrightRequest } from 'playwright-core';
import { canonicalVideoUrl } from '../src/video-reader.js';
import { openGate, requestKind } from '../src/video-session-network.js';
import { inspectPlayer, captureVideo, readTrack } from '../src/video-session-player.js';
import { publishedListing } from '../src/video-public-listing.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const clean = text => String(text || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 300);
const denied = (code = 'source_restricted') => ({ version: 1, status: 'restricted', errors: [code], subtitles: [], frames: [] });
const unavailable = (code = 'session_video_unavailable') => ({ version: 1, status: 'unavailable', errors: [code], subtitles: [], frames: [] });
function responseFailure(status) {
  if ([401,403].includes(status)) return {restricted:true,code:'platform_access_denied'};
  if (status === 412) return {unknown:true,code:'platform_precondition_failed'};
  if (status === 429) return {unknown:true,code:'platform_rate_limited'};
  return {unknown:true,code:'platform_page_unavailable'};
}

export async function profileFor(platform) {
  if (!['youtube', 'bilibili'].includes(platform) || process.platform !== 'linux' || !process.getuid?.()) throw Error();
  const owner = userInfo(), root = join(owner.homedir, '.local/share/zhiwei-video-sessions');
  for (const path of [root, join(root, platform)]) {
    const st = await lstat(path);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== owner.uid || (st.mode & 0o077) || await realpath(path) !== path) throw Error();
  }
  return join(root, platform);
}

export function selectTrack(source, tracks) {
  const valid = [];
  for (const t of tracks) {
    if (!['human', 'automatic'].includes(t.kind) || typeof t.language !== 'string' || !/^(?:zh|en)(?:[-_][\w-]{1,24})?$/.test(t.language)
        || typeof t.url !== 'string' || t.url.length > 16384) continue;
    try {
      const u = new URL(t.url, source.url);
      if (!requestKind(source, u.href, 'GET', 'fetch', false)) continue;
      if (source.platform === 'youtube' ? !(u.hostname === 'www.youtube.com' && u.pathname === '/api/timedtext' && u.searchParams.get('v') === source.id)
          : !(/^(aisubtitle|i[012])\.hdslb\.com$/.test(u.hostname) && /^\/bfs\/(?:ai_)?subtitle\//.test(u.pathname))) continue;
      valid.push({ url: u.href, language: t.language, kind: t.kind });
    } catch {}
  }
  const score = t => (t.kind === 'human' ? 2 : 0) + (t.language.startsWith('zh') ? 1 : 0);
  return valid.sort((a, b) => score(b) - score(a))[0];
}

export async function readListing(source, proxy) {
  if (source.platform !== 'bilibili') return {unknown:true};
  const url = new URL('https://api.bilibili.com/x/web-interface/view');
  url.searchParams.set(source.id.startsWith('BV') ? 'bvid' : 'aid', source.id.replace(/^av/, ''));
  const client = await playwrightRequest.newContext({ proxy });
  try {
    const response = await client.get(url.href, { maxRedirects: 0, maxRetries: 0, timeout: 10000 });
    if (!response.ok()) return responseFailure(response.status());
    const body = await response.body();
    if (body.length > 512 * 1024) return {unknown:true};
    return publishedListing(source, JSON.parse(body)) || {unknown:true};
  } catch { return {unknown:true}; }
  finally { await client.dispose(); }
}

export async function openPlayer(context, source, proxy, publicProofOnly = false, confirmFree = null) {
  for (const previous of context.pages()) await previous.close({ runBeforeUnload: false });
  const page = await context.newPage();
  const biliTracks = new Map();
  let requests = 0, documentError = null;
  let grant;
  const materialAllowed = new Promise(ok => { grant = ok; });
  await context.routeWebSocket('**/*', route => route.close());
  await context.route('**/*', async route => {
    const req = route.request();
    let response, publicNetwork;
    try {
      if (++requests > 500 || req.frame().page() !== page) return await route.abort();
      const url = new URL(req.url());
      if (!publicProofOnly && source.platform === 'bilibili' && url.hostname === 'api.bilibili.com' && /^\/x\/player\//.test(url.pathname)
          && !await materialAllowed) return await route.abort();
      const kind = requestKind(source, url.href, req.method(), req.resourceType(), req.frame() === page.mainFrame());
      if (!kind) return await route.abort();
      if ((req.resourceType() === 'media' || /(?:\/videoplayback$|\/api\/timedtext$|\/bfs\/(?:ai_)?subtitle\/|\.(?:mp4|m4s)$)/.test(url.pathname))
          && !await materialAllowed) return await route.abort();
      // Pin POST to the canonical current video, including any site-generated context.
      if (req.method() === 'POST' && req.postDataJSON()?.videoId !== source.id) return await route.abort();
      if (kind === 'first') {
        // Cookie handling stays inside this dedicated browser's request context.
        // No 3xx can inherit a credential or bypass the request policy.
        response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 13000 });
      } else {
        publicNetwork = await playwrightRequest.newContext({ proxy });
        const headers = { Referer: new URL(source.url).origin + '/' };
        const range = await req.headerValue('range');
        if (range && /^bytes=\d+-\d*$/.test(range)) headers.Range = range;
        response = await publicNetwork.fetch(url.href, { method: req.method(), headers, maxRedirects: 0, timeout: 13000 });
      }
      if (source.platform === 'bilibili' && req.resourceType() === 'document' && [301,302,307,308].includes(response.status())) {
        const target = new URL(response.headers()['location'], url);
        if (requestKind(source,target.href,'GET','document',true) !== 'first') {
          documentError = 'platform_navigation_redirected'; return await route.abort();
        }
        await response.dispose();
        response = await route.fetch({url:target.href,maxRedirects:0,maxRetries:0,timeout:13000});
      }
      if (response.status() >= 300 && response.status() < 400) {
        if (req.resourceType() === 'document') documentError = 'platform_navigation_redirected';
        return await route.abort();
      }
      if (source.platform === 'bilibili' && url.hostname === 'api.bilibili.com' && /^\/x\/player\/(?:wbi\/)?v2$/.test(url.pathname)
          && response.status() === 200 && /^\d+$/.test(url.searchParams.get('cid') || '')) {
        const bytes = await response.body();
        if (bytes.length <= 1024 * 1024) {
          const data = JSON.parse(bytes.toString('utf8'));
          if (data.code === 0 && String(data.data?.cid) === url.searchParams.get('cid')) {
            biliTracks.set(Number(data.data.cid), (data.data.subtitle?.subtitles || []).map(t => ({
              url: t.subtitle_url, language: t.lan?.replace(/^ai-/, ''), kind: t.ai_type || t.lan?.startsWith('ai-') ? 'automatic' : 'human'
            })));
          }
        }
      }
      const headers = { ...response.headers() };
      // The Playwright request context already handled first-party Set-Cookie.
      // A fulfilled response uses the decoded body and does not need it again.
      for (const key of ['set-cookie', 'content-encoding', 'transfer-encoding', 'content-length']) delete headers[key];
      await route.fulfill({ response, headers });
    } catch { if (req.resourceType() === 'document') documentError ||= 'platform_document_transport_failed'; await route.abort().catch(() => {}); }
    finally { if (response) await response.dispose().catch(() => {}); if (publicNetwork) await publicNetwork.dispose().catch(() => {}); }
  });
  const pageUrl = new URL(source.url);
  if (source.platform === 'bilibili') pageUrl.pathname += '/';
  const inspect = async flags => {
    const state = await page.waitForFunction(inspectPlayer, { ...source, ...flags }, { timeout: 13000, polling: 250 });
    try { return await state.jsonValue(); } finally { await state.dispose(); }
  };
  try {
    const resp = await page.goto(pageUrl.href, { waitUntil: 'commit', timeout: 18000 }).catch(() => null);
    if (!resp) return {meta:{unknown:true,code:documentError || 'platform_navigation_failed'}};
    if (!resp || !resp.ok()) return { meta: responseFailure(resp?.status()) };
    if (publicProofOnly) return {page, meta: await inspect({publicProofOnly:true})};
    let proof = await inspect({signedMetadataOnly:true}).catch(() => ({unknown:true,code:'player_publication_unavailable'}));
    if ((proof?.needsGuestPlayback || proof?.needsPublishedArchive) && confirmFree) {
      const guest = await confirmFree();
      if (guest?.restricted || guest?.unknown) return {meta:guest};
      if (!guest || guest.unknown || !clean(guest.title) || clean(guest.title) !== clean(proof.title) || (proof.cid && guest.cid !== proof.cid)
          || !Number.isFinite(guest.duration) || !Number.isFinite(proof.duration) || Math.abs(guest.duration - proof.duration) > 1.25) return {meta:{unknown:true}};
      source.requiresFree = false;
      source.expectedTitle = guest.title;
      if (guest.listing === 'bilibili_public_archive') Object.assign(source, {listing:guest.listing,expectedCid:guest.cid,expectedAid:guest.aid,expectedBvid:guest.bvid});
      proof = await inspect({signedMetadataOnly:true});
      if (!Number.isFinite(guest.duration) || !Number.isFinite(proof?.duration) || Math.abs(guest.duration - proof.duration) > 1.25) return {meta:{unknown:true}};
    }
    if (!proof || proof.restricted || proof.unknown || proof.needsGuestPlayback || proof.needsPublishedArchive || !clean(proof.title)
        || (source.expectedTitle && clean(proof.title) !== clean(source.expectedTitle))) return {meta:proof?.restricted ? proof : {unknown:true,code:proof?.code || 'publication_not_confirmed'}};
    if (source.platform === 'bilibili') Object.assign(source,{expectedCid:proof.cid,expectedAid:proof.aid,expectedBvid:proof.bvid});
    grant(true);
    const meta = await inspect({}).catch(() => ({unknown:true,code:'player_material_unavailable'}));
    if (!meta || meta.restricted || meta.unknown || meta.needsGuestPlayback || meta.needsPublishedArchive || !clean(meta.title))
      return { meta: meta?.restricted ? meta : { unknown:true,code:meta?.code || 'player_not_confirmed' } };
    return { page, meta, publicationVerified:true, current:() => page.evaluate(inspectPlayer,source),
      tracks: () => source.platform === 'bilibili' ? biliTracks.get(meta.cid) || [] : meta.tracks };
  } finally { grant(false); }
}

export async function collect(source, mode, target, output, guestPlayer, dedicatedPlayer) {
  // A previously published result cannot authorize this read or cache probe.
  const guest = await guestPlayer();
  if (guest?.restricted) return denied();
  const fromPage = guest?.listing === 'platform_publication_required';
  if (!guest || guest.unknown || (!fromPage && !clean(guest.title))) return unavailable();
  const selected = await dedicatedPlayer(guest);
  if (selected?.meta?.restricted) return denied(selected.meta.code);
  if (!selected?.meta || selected.meta.unknown || (Number.isFinite(guest.duration) && Math.abs(guest.duration - selected.meta.duration) > 1.25) ||
      (fromPage ? selected.publicationVerified !== true : guest.cid !== selected.meta.cid || clean(guest.title) !== clean(selected.meta.title))) return unavailable(selected?.meta?.code);
  const { page, meta } = selected;
  const duration = meta.duration, title = clean(meta.title);
  if (!(duration > 0 && duration <= 1200) || !title || (target !== null && (!Number.isFinite(target) || target < 0 || target >= duration))) return unavailable();
  const track = selectTrack(source, selected.tracks());
  const subtitleTrack = track && { kind: track.kind, language: track.language };
  const result = { version: 1, source, title, duration, status: 'available', sourceAccess: 'dedicated_browser_public',
    metadataVersion: hash(JSON.stringify([source.url, title, duration, meta.cid, subtitleTrack, 'dedicated_browser_public'])),
    frames: [], subtitles: [], errors: [] };
  if (mode === 'probe') return result;
  if (track) {
    try { result.subtitles = await page.evaluate(readTrack, { ...track, duration, platform: source.platform }); } catch {}
    if (result.subtitles.length) result.subtitleTrack = subtitleTrack;
  }
  if (!result.subtitles.length) result.errors.push('no_supported_subtitles');
  const stamps = target === null ? [0.125, 0.375, 0.625, 0.875].map(f => duration * f)
    : [...new Set([-1, 0, 1].map(delta => Math.max(0, Math.min(Math.max(0, duration - .05), target + delta))))];
  for (const stamp of stamps) {
    const shot = await page.evaluate(captureVideo, { platform: source.platform, id: source.id, cid: meta.cid, duration, target: stamp }).catch(() => null);
    if (!shot?.jpeg || shot.jpeg.length > 2800000 || !Number.isFinite(shot.stamp) || Math.abs(shot.stamp - stamp) > .15) continue;
    const data = Buffer.from(shot.jpeg, 'base64');
    if (data.length < 4 || data.length > 2 * 1024 * 1024 || data.subarray(0, 3).toString('hex') !== 'ffd8ff') continue;
    const file = 'frame-' + result.frames.length + '.jpg';
    await writeFile(join(output, file), data, { mode: 0o600, flag: 'wx' });
    result.frames.push({ file, timestamp: shot.stamp, bytes: data.length, sha256: hash(data) });
  }
  const end = await (selected.current ? selected.current() : page.evaluate(inspectPlayer, source)).catch(() => null);
  if (end?.restricted) return denied();
  if (!end || end.unknown || end.needsGuestPlayback || end.needsPublishedArchive ||
      clean(end.title) !== title || end.duration !== duration || end.cid !== meta.cid) return unavailable();
  if (!result.frames.length) result.errors.push('frames_unavailable');
  result.status = result.frames.length && result.subtitles.length ? 'ok' : result.frames.length || result.subtitles.length ? 'partial' : 'unavailable';
  return result;
}

export function launchOptions(input, gate) {
  const proxy = { server: gate.server, bypass: '<-loopback>' };
  return {
    executablePath: input.executablePath, chromiumSandbox: true, headless: true, proxy, timeout: 15000,
    // The browser itself has zero network access. Only intercepted, validated
    // requests may pass via the Node request contexts and their pinned gateway.
    ignoreDefaultArgs: ['--proxy-server=' + gate.server, '--password-store=basic', '--use-mock-keychain'],
    args: ['--proxy-server=' + gate.browserDeny, '--proxy-bypass-list=<-loopback>', '--disable-quic', '--disable-extensions',
      '--disable-background-networking', '--disable-sync', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: userInfo().homedir, TMPDIR: input.browserTmp || input.outputDir }
  };
}

async function run(input) {
  const readiness = input.mode === 'session_dependencies';
  const source = readiness ? null : canonicalVideoUrl(input.url);
  if (!readiness && (!source || source.url !== input.url || !['read', 'probe'].includes(input.mode))) return denied();
  const platforms = readiness ? input.platforms : [source.platform];
  for (const platform of platforms) await profileFor(platform);
  const gate = await openGate(platforms[0]);
  const opts = launchOptions(input, gate);
  const proxy = opts.proxy;
  let guestBrowser, guestContext, dedicated;
  try {
    if (readiness) {
      guestBrowser = await chromium.launch(opts);
      return { version: 1, status: 'ready', browser: guestBrowser.version() };
    }
    return await collect(source, input.mode, input.atSeconds ?? null, input.outputDir, () => ({listing:'platform_publication_required'}), async guest => {
      try { dedicated = await chromium.launchPersistentContext(await profileFor(source.platform), { ...opts, serviceWorkers: 'block', acceptDownloads: false }); }
      catch (e) { return {meta:{unknown:true,code:/SingletonLock|processsingleton|profile.*in use/i.test(String(e)) ? 'dedicated_profile_in_use' : 'dedicated_browser_launch_failed'}}; }
      const bound = { ...source, requiresFree:source.platform === 'youtube', listing:guest.listing };
      try { return await openPlayer(dedicated, bound, proxy, false, async () => {
        if (source.platform === 'bilibili') return readListing(source, proxy);
        guestBrowser = await chromium.launch(opts);
        guestContext = await guestBrowser.newContext({serviceWorkers:'block',acceptDownloads:false});
        return (await openPlayer(guestContext, source, proxy, true))?.meta;
      }); } catch { return {meta:{unknown:true,code:'player_context_unavailable'}}; }
    });
  } finally {
    await Promise.allSettled([dedicated?.close(), guestBrowser?.close()]);
    gate.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let bytes = 0, chunks = [], result;
  try {
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 16384) throw Error(); chunks.push(chunk); }
    result = await run(JSON.parse(Buffer.concat(chunks)));
  } catch { result = unavailable(); }
  process.stdout.write(JSON.stringify(result));
}
