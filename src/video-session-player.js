// These functions run in the normal player document. Only the selected video,
// its published tracks and its decoded media element can contribute evidence.
export function inspectPlayer(source) {
  const u = new URL(location.href), expected = new URL(source.url);
  const shown = node => node && node.getClientRects().length > 0;
  if (source.platform === 'bilibili') {
    u.searchParams.delete('vd_source');
    if (u.searchParams.get('p') === '1' && u.searchParams.getAll('p').length === 1) u.searchParams.delete('p');
  }
  if (u.origin !== expected.origin || u.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')
      || u.search !== expected.search) return { unknown: true };
  if ([...document.querySelectorAll('input[type=password], iframe[src*="captcha"], [class*="geetest"]')]
    .some(shown)) return { restricted: true, code:'platform_login_or_verification_required' };
  const error = [...document.querySelectorAll('.ytp-error, .bpx-player-error-layer')].find(shown);
  if (error) return /sign in|not a bot|members.only|private video|age.restricted|登录|会员专享|人机验证|验证码/i.test(error.innerText) ? { restricted: true } : { unknown: true };
  let title, duration, video, tracks = [];
  if (source.platform === 'youtube') {
    const player = document.querySelector('#movie_player');
    const response = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
    if (!response) return null;
    const details = response.videoDetails, micro = response.microformat?.playerMicroformatRenderer;
    const status = response.playabilityStatus?.status;
    if (status && status !== 'OK') return ['LOGIN_REQUIRED', 'AGE_CHECK_REQUIRED', 'CONTENT_CHECK_REQUIRED'].includes(status) ? { restricted: true } : { unknown: true };
    if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) return null;
    if (!details || !micro || !status) return null;
    if (details.isPrivate === true || micro.isUnlisted === true || micro.isFamilySafe === false) return { restricted: true };
    if (details.videoId !== source.id || details.isPrivate !== false || micro.isUnlisted !== false ||
        details.isLiveContent || micro.isFamilySafe !== true || response.playabilityStatus?.errorScreen) return { unknown: true };
    let declaredFree = false;
    if (source.listing === 'platform_publication_required' || source.publicProofOnly) {
      const scopes = [...document.querySelectorAll('[itemscope][itemtype$="/VideoObject"]')];
      for (const scope of scopes) {
        const prop = name => [...scope.querySelectorAll('[itemprop="' + name + '"]')]
          .find(row => row.closest('[itemscope]') === scope)?.getAttribute('content')?.trim().toLowerCase();
        // Video IDs are case-sensitive; do not use the boolean-value helper.
        const id = [...scope.querySelectorAll('[itemprop="videoId"]')].find(row => row.closest('[itemscope]') === scope)?.getAttribute('content');
        if (id !== source.id) continue;
        const exactUrl = [...scope.querySelectorAll('[itemprop="url"],[itemprop="embedUrl"]')].some(row => {
          if (row.closest('[itemscope]') !== scope) return false;
          try {
            const value = new URL(row.getAttribute('content') || row.getAttribute('href'));
            return value.origin === 'https://www.youtube.com' && !value.username && !value.password && !value.hash &&
              ((value.pathname === '/watch' && value.search === '?v=' + source.id) || (value.pathname === '/embed/' + source.id && !value.search));
          } catch { return false; }
        });
        if (!exactUrl) continue;
        const free = prop('isAccessibleForFree'), paid = prop('paid'), sub = prop('requiresSubscription');
        if (free === 'false' || paid === 'true' || sub === 'true') return { restricted: true };
        declaredFree ||= free === 'true' || paid === 'false' && sub === 'false';
      }
      const blocks = window.ytInitialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
      const badges = blocks.flatMap(b => b.videoPrimaryInfoRenderer?.badges || []).map(b => b.metadataBadgeRenderer || {});
      if (badges.some(b => /MEMBERS_ONLY|SUBSCRIPTION|PREMIUM|PURCHASE|RENTAL|PRIVATE|UNLISTED/.test(b.style)
          || /members.only|requires (?:a )?subscription|rent or buy|会员专享|會員專屬|需要付费/i.test(b.label || b.tooltip))) return { restricted:true };
      if (source.requiresFree && !declaredFree) return { needsGuestPlayback: true, title:details.title, duration:Number(details.lengthSeconds) };
    }
    video = player?.querySelector('video.html5-main-video');
    title = details.title;
    duration = Number(details.lengthSeconds);
    if (source.signedMetadataOnly) return { title, duration, free: declaredFree };
    if (source.publicProofOnly) {
      if (!Number.isFinite(duration) || !(duration > 0 && duration <= 1200) ||
          ![...(response.streamingData?.formats || []), ...(response.streamingData?.adaptiveFormats || [])].some(f => /^video\//.test(f.mimeType))) return null;
      return { title, duration };
    }
    if (player?.getVideoData?.()?.video_id !== source.id) return null;
    tracks = (response.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).map(t => ({
      url: t.baseUrl, language: t.languageCode, kind: t.kind === 'asr' ? 'automatic' : 'human'
    }));
  } else {
    const data = window.__INITIAL_STATE__?.videoData;
    if (!data) return null;
    const id = source.id.startsWith('BV') ? data.bvid : 'av' + data.aid;
    const part = data.pages?.find(p => p.page === source.part);
    if (data.rights?.pay || data.is_upower_exclusive || data.is_upower_play || data.is_upower_preview || data.is_view_self || data.rights?.is_view_self || data.rights?.ugc_pay || data.rights?.is_only_movie) return { restricted: true };
    if (id !== source.id || !part || data.state !== 0 || data.rights?.pay !== 0 || data.rights?.is_stein_gate || data.redirect_url) return { unknown: true };
    video = document.querySelector('#bilibili-player video, .bpx-player-container video');
    duration = Number(part.duration);
    title = data.title;
    // Used exclusively to bind provider-returned caption metadata to this part.
    if (!Number.isSafeInteger(part.cid) || part.cid <= 0 || (window.__INITIAL_STATE__?.cid ?? data.cid) !== part.cid) return { unknown: true };
    if (source.publicProofOnly) {
      const play = window.__playinfo__?.data;
      if (!Number.isFinite(duration) || !(duration > 0 && duration <= 1200)
          || !(play?.dash?.video?.length || play?.durl?.length) || Math.abs(play.timelength / 1000 - duration) > 1.25
          || !Number.isFinite(play.timelength)) return null;
      return { title, duration, cid: part.cid, aid: data.aid, bvid: data.bvid };
    }
    if (source.listing === 'platform_publication_required') {
      if (data.rights?.ugc_pay !== 0 || data.is_upower_exclusive !== false || !Number.isSafeInteger(data.pubdate) ||
          data.pubdate <= 0 || data.pubdate * 1000 > Date.now() || !Number.isFinite(duration) || !(duration > 0 && duration <= 1200)) return {unknown:true};
      if (data.is_view_self !== false && data.rights?.is_view_self !== 0) return {needsPublishedArchive:true,title,duration,cid:part.cid};
    }
    if (source.listing === 'bilibili_public_archive' && (data.rights?.ugc_pay !== 0 || data.is_upower_exclusive !== false
        || data.is_upower_preview || data.is_view_self || data.aid !== source.expectedAid || data.bvid !== source.expectedBvid
        || part.cid !== source.expectedCid)) return { unknown: true };
    if (source.signedMetadataOnly) return { title, duration, cid: part.cid, aid:data.aid, bvid:data.bvid };
    if (!video || video.mediaKeys || video.readyState < 2 || Math.abs(video.duration - duration) > 1.25) return null;
    if (!Number.isFinite(video.duration) || !(video.duration > 0 && video.duration <= 1200)) return { unknown: true };
    return { title, duration: video.duration, cid: part.cid, tracks };
  }
  if (!video || video.mediaKeys || video.readyState < 2 || Math.abs(video.duration - duration) > 1.25) return null;
  if (!Number.isFinite(video.duration) || !(video.duration > 0 && video.duration <= 1200)) return { unknown: true };
  return { title, duration: video.duration, tracks, free: !!source.requiresFree };
}

export async function captureVideo({ platform, target, id, cid, duration }) {
  const selector = platform === 'youtube' ? '#movie_player video.html5-main-video' : '#bilibili-player video, .bpx-player-container video';
  const video = document.querySelector(selector);
  if (!video || video.mediaKeys || video.readyState < 2 || !Number.isFinite(target) || target < 0 || target >= video.duration) return null;
  video.pause();
  if (Math.abs(video.currentTime - target) > 0.005) {
    const seeked = new Promise(resolve => {
      const done = ok => { clearTimeout(timer); video.removeEventListener('seeked', onSeek); resolve(ok); };
      const onSeek = () => done(true);
      const timer = setTimeout(() => done(false), 4500);
      video.addEventListener('seeked', onSeek, { once: true });
    });
    video.currentTime = target;
    if (!await seeked) return null;
  }
  if (platform === 'youtube') {
    const player = document.querySelector('#movie_player');
    if (player?.getVideoData?.()?.video_id !== id || player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) return null;
  } else if ((window.__INITIAL_STATE__?.cid ?? window.__INITIAL_STATE__?.videoData?.cid) !== cid) return null;
  if (Math.abs(video.duration - duration) > .25) return null;
  const stamp = video.currentTime;
  if (video.readyState < 2 || video.seeking || video.mediaKeys || !video.videoWidth || !video.videoHeight
      || !Number.isFinite(stamp) || Math.abs(stamp - target) > 0.15) return null;
  const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  try {
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return { stamp, jpeg: canvas.toDataURL('image/jpeg', .82).split(',')[1] };
  } catch { return null; } // Tainted canvases have no fallback.
}

export async function readTrack({ url, language, duration, platform }) {
  const response = await fetch(url, { credentials: new URL(url).origin === location.origin ? 'same-origin' : 'omit', redirect: 'error' });
  if (!response.ok || !response.body) return [];
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); return []; }
    chunks.push(value);
  }
  const raw = await new Blob(chunks).text(), cues = [];
  function add(start, end, text) {
    start = Number(start); end = Math.min(duration, Number(end));
    if (typeof text !== 'string') return;
    text = text.replace(/<[^>]*>/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 1000);
    if (text && Number.isFinite(start) && Number.isFinite(end) && 0 <= start && start < end) cues.push({ start, end, text });
  }
  if (raw.trimStart().startsWith('{')) {
    const data = JSON.parse(raw);
    if (platform === 'bilibili') for (const c of data.body || []) add(c.from, c.to, c.content);
    else for (const c of data.events || []) add(c.tStartMs / 1000, (c.tStartMs + c.dDurationMs) / 1000, (c.segs || []).map(s => s.utf8).join(''));
  } else if (platform === 'youtube') {
    const xml = new DOMParser().parseFromString(raw, 'application/xml');
    for (const c of xml.querySelectorAll('transcript > text[start][dur], timedtext body p[t][d]')) {
      const start = c.hasAttribute('start') ? Number(c.getAttribute('start')) : Number(c.getAttribute('t')) / 1000;
      const length = c.hasAttribute('dur') ? Number(c.getAttribute('dur')) : Number(c.getAttribute('d')) / 1000;
      add(start, start + length, c.textContent);
    }
  }
  return cues.sort((a, b) => a.start - b.start).slice(0, 2000);
}
