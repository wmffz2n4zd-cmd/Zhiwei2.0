import { configuredVideoPlatforms, parseSharedVideoLinks } from './video-reader.js';

const fail = code => Object.assign(Error('Video source is no longer available.'), { code });
const validText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const normalizeScope = scope => {
  if (!scope || scope.kind !== 'private' || !validText(scope.contactId, 160) || !validText(scope.memoryEpoch, 1024)) throw fail('INVALID_VIDEO_SCOPE');
  return { kind: 'private', contactId: scope.contactId, memoryEpoch: scope.memoryEpoch };
};
const keyFor = scope => JSON.stringify(normalizeScope(scope));

export function videoQuestionTimestamp(text) {
  const plain = String(text || '').replace(/https?:\/\/[^\s<>]+/g, ' ');
  let match = /(?:^|[^\d])(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)/.exec(plain), value;
  if (match) {
    if (Number(match[2]) > 59 || match[3] !== undefined && Number(match[3]) > 59) return null;
    value = match[3] === undefined ? Number(match[1]) * 60 + Number(match[2]) : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  } else {
    match = /(?:(\d{1,2})分(?:钟)?)?\s*(\d{1,3}(?:\.\d+)?)秒/.exec(plain);
    if (match) value = Number(match[1] || 0) * 60 + Number(match[2]);
  }
  return Number.isFinite(value) && value >= 0 && value < 1200 ? value : null;
}

export function isVideoFollowup(text) {
  const plain = String(text || '').replace(/https?:\/\/[^\s<>]+/g, ' ');
  return /(?:刚才|那个|这个|这段|那段|上面|上一段).{0,12}(?:视频|片段|画面|字幕|镜头)|(?:视频|片段|画面|字幕|镜头).{0,20}(?:刚才|那个|这个|哪里|什么|为什么|再看|继续|解释|说的)/.test(plain)
    || videoQuestionTimestamp(plain) !== null && /(?:那里|这里|这时|那时|画面|镜头|字幕|视频|是什么|发生|再看|看看)/.test(plain);
}

/** Only the server supplies source records from the authenticated mailbox.
 * The stored selection is a disposable pointer, never a new chat/history store.
 * Restart drops implicit pointers; explicit/quoted links rehydrate from PWA.
 */
export function createVideoSourceContext({ platforms, now = Date.now, ttlMs = 30 * 60 * 1000 } = {}) {
  if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3600000) throw fail('INVALID_VIDEO_CONTEXT');
  const allowedPlatforms = configuredVideoPlatforms(platforms);
  const sources = new Map(), generations = new Map();
  function invalidate(contactId) {
    for (const [key, record] of sources) if (contactId === 'all' || record.scope.contactId === contactId) sources.delete(key);
    if (contactId === 'all') for (const id of generations.keys()) generations.set(id, (generations.get(id) || 0) + 1);
    else generations.set(contactId, (generations.get(contactId) || 0) + 1);
  }
  return {
    async select({ scope, text = '', currentSources = [], quotedSources = [], resolveSource, assertCurrent = () => {} }) {
      scope = normalizeScope(scope);
      if (typeof resolveSource !== 'function' || typeof assertCurrent !== 'function'
          || !Array.isArray(currentSources) || !Array.isArray(quotedSources)) throw fail('INVALID_VIDEO_SOURCE_RESOLVER');
      const key = keyFor(scope), generation = generations.get(scope.contactId) || 0;
      if (!generations.has(scope.contactId)) generations.set(scope.contactId, generation);
      const current = async () => {
        await assertCurrent();
        if (generation !== generations.get(scope.contactId)) throw fail('REPLY_SUPERSEDED');
      };
      const verify = async record => {
        if (!record || !validText(record.id, 100) || !/^[a-f0-9]{64}$/.test(record.fingerprint || '')) throw fail('INVALID_VIDEO_SOURCE_REF');
        await current();
        let actual;
        try { actual = await resolveSource(record.id); } catch { throw fail('HISTORY_SOURCE_CHANGED'); }
        await current();
        if (!actual || actual.id !== record.id || actual.fingerprint !== record.fingerprint) throw fail('HISTORY_SOURCE_CHANGED');
        return actual;
      };
      const choose = rows => {
        for (const record of [...rows].reverse()) {
          const links = parseSharedVideoLinks(record?.text);
          // Keep a disabled video as the current subject when it is the only
          // link, so a later follow-up cannot silently reuse an earlier video.
          const link = links.find(item => allowedPlatforms.includes(item.platform)) || links[0];
          if (link) return { record, link };
        }
        return null;
      };
      await current();
      let chosen = choose(currentSources), selection = 'current';
      if (!chosen) { chosen = choose(quotedSources); selection = 'quote'; }
      if (!chosen && isVideoFollowup(text)) {
        const saved = sources.get(key);
        if (saved && now() >= saved.selectedAt && now() < saved.expiresAt) {
          const record = await verify({ id: saved.sourceRef, fingerprint: saved.sourceFingerprint });
          const link = parseSharedVideoLinks(record.text).find(row => row.url === saved.url);
          if (!link) { sources.delete(key); throw fail('HISTORY_SOURCE_CHANGED'); }
          chosen = { record, link }; selection = 'followup';
        } else sources.delete(key);
      }
      if (!chosen) return null;
      const actual = await verify(chosen.record);
      const link = parseSharedVideoLinks(actual.text).find(row => row.url === chosen.link.url);
      if (!link) throw fail('HISTORY_SOURCE_CHANGED');
      const selectedAt = now();
      const record = { scope, url: link.url, sourceRef: actual.id, sourceFingerprint: actual.fingerprint,
        selectedAt, expiresAt: selectedAt + ttlMs };
      await current(); sources.set(key, record);
      while (sources.size > 64) sources.delete(sources.keys().next().value);
      return { ...link, atSeconds: videoQuestionTimestamp(text) ?? link.atSeconds, sourceRef: record.sourceRef,
        sourceFingerprint: record.sourceFingerprint, selection, expiresAt: record.expiresAt };
    },
    invalidate,
    clear() { invalidate('all'); },
    getStatus() { return { sources: sources.size }; }
  };
}
