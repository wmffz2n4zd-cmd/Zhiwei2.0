import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, status = 400) => { throw Object.assign(Error(code), { code, status }); };
export const isLegacyPwaReference = value => typeof value === 'string' && /^l1_[a-f0-9]{64}_[ua]$/.test(value);
const scopeNotice = '仅查询当前账号的网页消息和已关联的原始 QQ 留存；未保存或已删除的内容不在结果中。';
const descending = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.orderKey.localeCompare(a.orderKey);
const key = row => [row.createdAt, row.orderKey];
const afterKey = (row, anchor) => row.createdAt < anchor[0] || row.createdAt === anchor[0] && row.orderKey < anchor[1];

function dateBound(value, end = false) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid-history-date');
  const at = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(at) || new Date(at + 8 * 3600000).toISOString().slice(0, 10) !== value) fail('invalid-history-date');
  return at + (end ? 86400000 : 0);
}

/** Reads retained originals afresh. No summary index or private text cache is kept. */
export function createPwaHistory({ store, readLegacyHistorySnapshot } = {}) {
  const active = userId => {
    const identity = store.getIdentity(userId);
    if (!identity?.enabled || identity.bindingStatus !== 'active') fail('account-unavailable', 403);
    return identity;
  };
  function current(userId, before) {
    const now = active(userId);
    if (now.memoryScope !== before.memoryScope || now.routeVersion !== before.routeVersion) fail('history-identity-changed', 409);
    return now;
  }
  async function snapshot(userId) {
    const identity = active(userId);
    const legacy = typeof readLegacyHistorySnapshot === 'function' && /^qq:private:\d+$/.test(identity.memoryScope)
      ? await readLegacyHistorySnapshot({ scope: identity.memoryScope }) : { records: [] };
    current(userId, identity);
    const rows = store.readHistoryMessages(userId).map(message => ({ id: message.id, source: 'pwa',
      createdAt: new Date(message.createdAt).toISOString(), speaker: message.direction === 'outbound' ? 'assistant' : 'user',
      text: message.text || '', mediaIds: message.mediaIds || [], ...(message.work ? {work:message.work} : {}), truncated: false,
      mediaMissing: (message.mediaIds || []).some(id => !store.getMedia(userId, id)), seq: message.seq,
      orderKey: `p${String(message.seq).padStart(16,'0')}`, replyTo: message.replyTo || null }));
    const legacyRows = [];
    for (const entry of legacy.records || []) {
      if (typeof entry.id !== 'string' || !Number.isFinite(Date.parse(entry.at))) continue;
      for (const [side, field, speaker] of [['u', 'userText', 'user'], ['a', 'replyText', 'assistant']]) {
        const text = entry[field];
        const quotedText = side === 'u' && typeof entry.quotedText === 'string' ? entry.quotedText : '';
        if (typeof text !== 'string' || !text && !quotedText) continue;
        const createdAt = new Date(entry.at).toISOString();
        const truncated = Number.isSafeInteger(entry.originalLengths?.[field])
          ? entry.originalLengths[field] > text.length : Boolean(entry.truncated);
        const quotedTruncated = Boolean(quotedText) && (Number.isSafeInteger(entry.originalLengths?.quotedText)
          ? entry.originalLengths.quotedText > quotedText.length : Boolean(entry.truncated));
        const mediaMissing = /\[(?:图片|表情|image)|\[CQ:image/i.test(text);
        const id = `l1_${digest([userId, identity.memoryScope, entry.id, side, text, createdAt, truncated, quotedText, quotedTruncated])}_${side}`;
        legacyRows.push({ id, source: 'qq', createdAt, speaker, text, mediaIds: [], truncated, mediaMissing,
          orderKey: `l${digest(entry.id)}${side === 'u' ? '1' : '2'}`,
          quotedText, quotedTruncated, mediaNotice: '旧留存仅含实际保存的原文，未回取 QQ 媒体。' });
      }
    }
    rows.push(...legacyRows);
    rows.sort(descending);
    return { identity, rows, legacyRevision: digest(legacyRows.map(row => row.id).sort()),
      maxSeq: rows.reduce((max,row) => row.source === 'pwa' ? Math.max(max,row.seq) : max, 0) };
  }
  const api = {
    async resolve(userId, ref) {
      if (typeof ref !== 'string' || ref.length > 100) fail('reference-unavailable', 404);
      const data = await snapshot(userId), record = data.rows.find(row => row.id === ref);
      if (!record) fail('reference-unavailable', 404);
      return record;
    },
    async search(userId, { q = '', from = '', to = '', speaker = 'all', source = 'all', cursor = null, limit = 30 } = {}) {
      if (typeof q !== 'string' || q.length > 300 || /[\u0000-\u001f]/.test(q)
        || !['all', 'user', 'assistant'].includes(speaker) || !['all', 'pwa', 'qq'].includes(source)
        || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid-history-search');
      const start = dateBound(from), end = dateBound(to, true);
      if (start !== null && end !== null && start >= end) fail('invalid-history-date');
      q = q.trim().toLocaleLowerCase('zh-CN');
      const data = await snapshot(userId), queryHash = digest([userId, data.identity.memoryScope, q, from || '', to || '', speaker, source]);
      let page = null;
      if (cursor !== null && cursor !== '') {
        try {
          if (typeof cursor !== 'string' || cursor.length > 1200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
          page = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
          if (page.v !== 1 || page.query !== queryHash || !Number.isSafeInteger(page.maxSeq) || page.maxSeq < 0
            || !Array.isArray(page.last) || page.last.length !== 2 || page.last.some(v => typeof v !== 'string' || v.length > 100)) throw Error();
        } catch { fail('invalid-history-cursor'); }
        if (page.legacy !== data.legacyRevision) fail('history-changed-refresh', 409);
      }
      const maxSeq = page?.maxSeq ?? data.maxSeq;
      const matching = data.rows.filter(row => (row.source !== 'pwa' || row.seq <= maxSeq)
        && (!page || afterKey(row, page.last)) && (source === 'all' || row.source === source)
        && (speaker === 'all' || row.speaker === speaker)
        && (start === null || Date.parse(row.createdAt) >= start) && (end === null || Date.parse(row.createdAt) < end)
        && (!q || row.text.toLocaleLowerCase('zh-CN').includes(q) || (row.quotedText || '').toLocaleLowerCase('zh-CN').includes(q)));
      const records = matching.slice(0, limit).map(row => {
        const inText = Boolean(q) && row.text.toLocaleLowerCase('zh-CN').includes(q);
        const inQuote = Boolean(q) && (row.quotedText || '').toLocaleLowerCase('zh-CN').includes(q);
        return { ...row, matchIn: inText && inQuote ? 'both' : inQuote ? 'quotedText' : inText ? 'text' : null };
      }), hasMore = matching.length > limit;
      return { records, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, query: queryHash,
        legacy: data.legacyRevision, maxSeq, last: key(records.at(-1)) })).toString('base64url') : null, scopeNotice };
    },
    async context(userId, ref, { radius = 3 } = {}) {
      if (!Number.isInteger(radius) || radius < 0 || radius > 10 || typeof ref !== 'string') fail('invalid-history-context');
      const data = await snapshot(userId), index = data.rows.findIndex(row => row.id === ref);
      if (index < 0) fail('reference-unavailable', 404);
      return { record: data.rows[index], records: data.rows.slice(Math.max(0, index - radius), index + radius + 1).reverse(), scopeNotice };
    },
    async acceptInbound(userId, input, check = () => {}) {
      // Idempotent acknowledgements do not require a source that was removed
      // after the original successful admission. The transaction checks hashes.
      check();
      if (store.getMessageByClientId(userId, input.clientMessageId)) return store.acceptInbound({ ...input, userId });
      let referenceAdmission;
      if (isLegacyPwaReference(input.replyTo)) {
        const before = active(userId), reference = await api.resolve(userId, input.replyTo);
        current(userId, before);
        check();
        referenceAdmission = store.authorizeLegacyReference(userId, reference.id);
      }
      return store.acceptInbound({ ...input, userId, referenceAdmission });
    }
  };
  return api;
}
