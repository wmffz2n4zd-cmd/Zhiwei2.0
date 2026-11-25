import { privateInboundIds, pwaIdentityCurrent } from './private-transport.js';

const pageSize = 4;
const recentMs = 120000;
// Bare "比较" or the character 图 in a topic such as 图书馆 is not a request for private images.
const imageQuestion = /首尾(?:两)?张|(?:首|末|尾)(?:张|图)|(?:这|那|哪|上|前|后|两|几|一|每)张|(?:这|那|刚才|刚发|刚刚|之前|上面|前面|后面).{0,5}(?:张|幅|照片|图片|截图|相片)|第\s*[0-9零一二两三四五六七八九十百]+\s*[张幅]|(?:看|读|识别)(?:一下|一眼)?图|图(?:里|中|上|里的|中的)(?:面|有|是|写|的|哪|什么|颜色)|(?:这|那)(?:个|些|幅)?图(?!书|纸|表)|\b(?:these|those|the last|previous) (?:images?|photos?|pictures?)\b/i;
const nextPage = /下一批|下一组|接下来的(?:图|几张)|剩下的(?:图|几张|照片)|其余的(?:图|几张)|next batch/i;
const comparePrevious = /上一张|刚才|前面|之前|对比|比较|两张|有什么(?:不同|区别)|\bcompare\b/i;
const sourceLabels = { quoted: '引用消息', current: '本轮消息', recent: '近期消息' };

function ordinalNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = '零一二三四五六七八九';
  let result = 0, digit = 0;
  for (const char of value.replaceAll('两', '二')) {
    if (char === '十' || char === '百') { result += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
    else digit = digits.indexOf(char);
  }
  return result + digit;
}

function requestedOrdinals(text) {
  const result = [];
  // A classifier or a neighbouring image ordinal disambiguates chapter numbers etc.
  for (const match of text.matchAll(/第\s*([0-9零一二两三四五六七八九十百]+)\s*(?=张|幅|幅图|[、和与及跟到至]\s*第)/g)) {
    const value = ordinalNumber(match[1]);
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

// Resolve relative endpoints against the complete group, before paging. A
// quoted attachment and a newly uploaded attachment may lie on different pages.
function relativeEndpoints(text, images, ordinals) {
  const pair = /首尾(?:两)?张/;
  const result = [];
  if (pair.test(text) || /首(?:张|图)|头一张|最前(?:面)?(?:的)?一张/.test(text)) result.push(images[0]);
  if (pair.test(text) || /(?:末|尾)(?:张|图)|最后(?:的)?(?:一|1)张/.test(text)) result.push(images.at(-1));
  if (/[和与跟、]|(?:比较|对比)/.test(text)) {
    if (/引用(?:的)?(?:那|这|一)?(?:张|幅)?(?:旧)?(?:图|照片)|引用(?:的)?[那这]张/.test(text)) {
      result.push(images.find(item => item.kind === 'quoted'));
    }
    if (/新(?:发|传)(?:来|上来)?的(?:那|这)?(?:张|幅|图|照片)|这(?:一)?张新(?:图|照)|(?:和|与|跟)这(?:一)?张/.test(text)) {
      result.push(images.findLast(item => item.kind === 'current') || images.at(-1));
    }
  }
  const endpoints = [...new Set(result.filter(Boolean))];
  // Merely mentioning one source in a request to compare the whole group
  // does not select just that image. Keep both sides unless both are bound.
  return ordinals.length || endpoints.length > 1 ? endpoints : [];
}

function sameReceipt(event, row) {
  const identity = event.privateIdentity, token = row.context.contactToken;
  const memory = row.context.memoryEpochToken;
  return row.routeVersion === identity.routeVersion && token && !token.stop
    && token.scope === identity.memoryScope && token.epoch === event.lifeContactToken?.epoch
    && memory?.scope === identity.memoryScope && memory.epoch === event.memoryEpochToken?.epoch
    && !['cancelled', 'failed'].includes(row.state);
}

export function currentPwaImageInbox(store, event) {
  if (!pwaIdentityCurrent(event, store)) return [];
  return privateInboundIds(event).map(id => store.getImageInbox(event.privateIdentity.userId, id))
    .filter(row => row && sameReceipt(event, row)).sort((a, b) => a.seq - b.seq);
}

// A busy receipt keeps a compact preview; canonical PWA messages still hold
// the full user text and original attachment IDs, even across a Hub restart.
export function restorePwaBusyInput(rows, event) {
  if (!rows.length) return event;
  const question = rows.findLast(row => row.text.trim())?.text || '';
  const quotedImage = event.pwaReplyContexts?.some(quote => quote.images.length || quote.mediaMissing);
  if (!rows.some(row => row.mediaIds.length) && !quotedImage && !imageQuestion.test(question) && !nextPage.test(question)) return event;
  const original = rows.map(row => row.text).filter(Boolean).join('\n');
  // Keep the newest question intact, including the tail of a 16K PWA message.
  const text = original.length > 64000 ? '（部分较早文字过长，已省略开头）\n' + original.slice(-64000) : original;
  const images = rows.flatMap(row => row.mediaIds.map(file => ({ file })));
  return { ...event, text, images, hasReplySegment: Boolean(event.pwaReplyRefs?.length),
    raw: { ...event.raw, raw_message: text, message: [{ type: 'text', data: { text } }] } };
}

export function selectPwaImageTurn(store, event, text) {
  const empty = { total: 0, selected: [], requested: [], cursor: null };
  if (!pwaIdentityCurrent(event, store) || event.backendCommand || /^\s*\//.test(text)) return empty;
  const userId = event.privateIdentity.userId;
  const current = currentPwaImageInbox(store, event);
  if (!current.length) return empty;
  // In a recomputed batch, an older caption such as "这是第五张" must not
  // override a later request to compare all the photos.
  if (current.length > 1) text = current.findLast(row => row.text.trim())?.text || text;
  const refs = [];
  const hasQuote = current.some(row => row.replyTo);
  for (const row of current) if (row.replyTo) refs.push({ id: row.replyTo, kind: 'quoted' });
  let previousCursor;
  const now = current.at(-1).createdAt;
  let expiresAt = now + recentMs;
  const currentCount = current.reduce((sum, row) => sum + row.mediaIds.length, 0);
  const requested = requestedOrdinals(text);
  const joinsEarlier = currentCount === 1 && (comparePrevious.test(text) || requested.some(n => n > currentCount)) || /上一张|之前的图|前面.{0,3}图/.test(text);
  const continuing = nextPage.test(text);
  if (!hasQuote && ((!currentCount && (imageQuestion.test(text) || continuing)) || joinsEarlier)) {
    const priorGroups = [];
    for (const row of store.recentImageInbox(userId, current[0].seq, now - recentMs)) {
      if (!sameReceipt(event, row) || /^\s*\//.test(row.text)) break;
      const cursor = row.context.imageCursor;
      if (cursor && cursor.expiresAt >= now && (!row.mediaIds.length || row.replyTo || cursor.refs.length > 1 || continuing)) {
        if (!priorGroups.length) previousCursor = cursor;
        expiresAt = Math.min(expiresAt, cursor.expiresAt);
        priorGroups.push(cursor.refs.map(ref => ({ ...ref, kind: ref.kind === 'quoted' ? 'quoted' : 'recent' })));
        break;
      }
      if (!row.mediaIds.length && !row.replyTo) break;
      expiresAt = Math.min(expiresAt, row.createdAt + recentMs);
      priorGroups.push([...(row.replyTo ? [{ id: row.replyTo, kind: 'quoted' }] : []), { id: row.id, kind: 'recent' }]);
    }
    for (const group of priorGroups.reverse()) refs.push(...group);
  }
  for (const row of current) if (row.mediaIds.length) refs.push({ id: row.id, kind: 'current' });
  let all = [];
  const seen = new Set();
  for (const ref of refs) {
    const row = store.getOwnMessage(userId, ref.id);
    if (!row?.mediaIds.length) continue;
    for (const [index, id] of row.mediaIds.entries()) {
      if (seen.has(id) || ref.indices && !ref.indices.includes(index + 1)) continue;
      seen.add(id);
      all.push({ id, kind: ref.kind, messageId: row.id, sourceIndex: index + 1 });
    }
  }
  const endpoints = relativeEndpoints(text, all, requested);
  const lastCount = /(?:这|那|刚才|刚发|刚刚|最近|前面|最后)(?:的|发的|那|这|发来)?\s*([0-9一二两三四五六七八九十]+)\s*张/.exec(text);
  if (!hasQuote && !continuing && !endpoints.length) {
    if (lastCount) all = all.slice(-Math.max(1, ordinalNumber(lastCount[1])));
    else if (!currentCount && !requested.length && /(?:这|那)一?张/.test(text) && !comparePrevious.test(text)) all = all.slice(-1);
  }
  all.forEach((item, i) => { item.ordinal = i + 1; });
  for (const item of endpoints) if (!requested.includes(item.ordinal)) requested.push(item.ordinal);
  const groups = new Map();
  for (const item of all) {
    if (!groups.has(item.messageId)) groups.set(item.messageId, { id: item.messageId, kind: item.kind, indices: [] });
    groups.get(item.messageId).indices.push(item.sourceIndex);
  }
  const savedRefs = [...groups.values()];
  const sameGroup = previousCursor && savedRefs.length === previousCursor.refs.length && savedRefs.every((ref, i) => {
    const old = previousCursor.refs[i];
    return old.id === ref.id && old.indices.length === ref.indices.length && old.indices.every((n, j) => n === ref.indices[j]);
  });
  const attempted = new Set(continuing && sameGroup ? previousCursor.attempted : []);
  let selected = all.filter(item => requested.length ? requested.includes(item.ordinal) : !continuing || !attempted.has(item.ordinal)).slice(0, pageSize);
  // An ordinal can introduce the newly uploaded photo ("这是第五张"). If
  // earlier photos have expired, keep the actual new attachment visible.
  if (!selected.length && currentCount && requested.length) selected = all.filter(item => item.kind === 'current').slice(0, pageSize);
  for (const item of selected) attempted.add(item.ordinal);
  const cursor = all.length ? { refs: savedRefs, attempted: [...attempted], expiresAt } : null;
  return { total: all.length, selected, requested, cursor };
}

export function describePwaImageTurn(turn, readable, missing, { frames = [], quotes = [], referenceUnavailable = false } = {}) {
  const positions = readable.map((item, i) => '附件' + (i + 1) + '=第' + item.ordinal + '张（' + sourceLabels[item.kind] + '中的第' + item.sourceIndex + '张）');
  const lines = [];
  const legacyMissing = quotes.some(quote => quote.source === 'qq' && quote.mediaMissing);
  if (legacyMissing) lines.push('引用的旧 QQ 记录仅留有文字或图片占位，原图未留存，本次没有看到该原图。');
  if (referenceUnavailable) lines.push('部分被引原消息无法核实，其中是否有图、图中有什么均未知。');
  const countLabel = legacyMissing || referenceUnavailable ? '本次能定位的图片共' : '这组共';
  if (turn.total || turn.requested.length) lines.push(countLabel + turn.total + '张，本次视觉输入依次为' + (positions.join('、') || '零张') + '。');
  if (missing.length) lines.push('第' + missing.map(item => item.ordinal).join('、') + '张原件不可读。');
  const outside = turn.requested.filter(i => i < 1 || i > turn.total);
  if (outside.length) lines.push('找不到所指的第' + outside.join('、') + '张。');
  if (turn.total > pageSize) lines.push('回复时说明这次实际看了哪几张；只比较已提供的图，可以按序号补看或继续下一批。');
  if (frames.length) lines.push(`本轮模型图像顺序：前${readable.length}张是用户图片，其后${frames.length}张依次为视频${frames.map(frame => frame.timestamp + '秒').join('、')}的实际帧。`);
  return lines.join('\n');
}
