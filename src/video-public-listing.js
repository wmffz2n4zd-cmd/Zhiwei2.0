// Published metadata only. No subtitle, media URL, cookies or account data go
// to the caller. Only the platform's canonical public archive read is accepted.
export function publishedListing(source, data) {
  if (source.platform !== 'bilibili') return null;
  const d = data?.data, part = d?.pages?.find(p => p.page === source.part);
  if (data?.code !== 0 || !part) return null;
  if (d.rights?.pay || d.rights?.ugc_pay || d.is_upower_exclusive || d.is_upower_play || d.is_upower_preview || d.is_view_self || d.rights?.is_view_self || d.rights?.is_only_movie) return { restricted: true };
  const expected = source.id.startsWith('BV') ? d.bvid : 'av' + d.aid;
  if (expected !== source.id || d.state !== 0 || d.rights?.pay !== 0 || d.rights?.ugc_pay !== 0 || d.is_upower_exclusive !== false
      || !Number.isSafeInteger(d.pubdate) || d.pubdate <= 0 || d.pubdate * 1000 > Date.now() || d.redirect_url || d.rights?.is_stein_gate
      || !Number.isSafeInteger(part.cid) || part.cid <= 0 || !Number.isSafeInteger(d.aid) || d.aid <= 0
      || typeof d.bvid !== 'string' || !Number.isFinite(part.duration) || part.duration <= 0 || part.duration > 1200 || !d.title?.trim()) return null;
  return { title:d.title, cid:part.cid, aid:d.aid, bvid:d.bvid, duration:part.duration, listing:'bilibili_public_archive' };
}
