const leadText = {
  '无语': '这下我真不知道说什么好了。', '笑死': '我真的绷不住了。',
  '难过': '唉，听着就难受。', '惊愕': '啊？还有这种事。',
  '愤怒': '这可把我气到了。', '害羞': '你这么说，我都不知道怎么接了。',
  '疑惑': '嗯？我有点没跟上。', '得意': '哼哼，这下知道了吧。',
  '困困': '我有点困了。', '收到': '收到啦。'
};

const deliveryTails = new Map();
export async function inReplyOrder(recipient, send) {
  const previous = deliveryTails.get(recipient) || Promise.resolve();
  const task = previous.catch(() => {}).then(send);
  deliveryTails.set(recipient, task);
  try { return await task; }
  finally { if (deliveryTails.get(recipient) === task) deliveryTails.delete(recipient); }
}

// A malformed sticker-only answer gets a short lead without another model call.
// Normal answers always retain the model's own wording.
export function ensureStickerLeadText(reply) {
  const text = String(reply || '').trim();
  const marker = text.match(/\[\[qq_sticker:([^\]]+)\]\]/);
  if (!marker || text.replace(/\[\[qq_(?:sticker|image):[^\]]*\]\]/g, '').trim()) return text;
  const name = marker[1].replace(/\.(png|jpe?g|gif|webp)$/i, '');
  return `${leadText[name] || '我在。'}\n${marker[0]}`;
}

function naturalTextMessages(segments) {
  const texts = segments.filter(segment => segment.type === 'text');
  // Unknown rich segments and multiple text segments have their own layout;
  // only split the ordinary one-text reply, keeping a quotation on its first part.
  if (texts.length !== 1 || segments.some(segment => !['text', 'reply'].includes(segment.type))) return [segments];
  const value = String(texts[0].data?.text || '');
  const structured = /```|~~~/u.test(value)
    || /^(?:[ \t]{4}\S|\s*(?:#{1,6}\s|>|\||[-*+•]\s|(?:\d+|[一二三四五六七八九十]+)[.)、]\s*|[（(]\d+[）)]))/mu.test(value);
  if (structured) return [segments];
  const paragraphs = value.split(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/u).map(part => part.trim()).filter(Boolean);
  if (paragraphs.length < 2) return [segments];
  // A bound on transport calls, not an instruction to manufacture three parts.
  const parts = paragraphs.length > 3 ? [...paragraphs.slice(0, 2), paragraphs.slice(2).join('\n\n')] : paragraphs;
  const text = texts[0];
  return parts.map((part, index) => {
    const next = { ...text, data: { ...text.data, text: part } };
    return index === 0 ? segments.map(segment => segment === text ? next : segment) : [next];
  });
}

function messageText(message) {
  return message.filter(segment => segment.type === 'text').map(segment => String(segment.data?.text || '')).join('');
}

async function sendNaturalTextThenSticker(message, send) {
  const images = message.filter(segment => segment.type === 'image').slice(0, 1);
  const text = message.filter(segment => segment.type !== 'image');
  if (images.length && !messageText(text).trim()) {
    return { ok: false, reason: 'Sticker needs a text reply first', deliveredText: '', textComplete: false };
  }
  const parts = [], delivered = [];
  let primary;
  for (const part of naturalTextMessages(text)) {
    let result;
    try { result = await send(part); }
    catch { result = { ok: false, reason: 'Text delivery failed', uncertain: true }; }
    parts.push(result);
    if (!result?.ok) {
      if (!primary) return { ...result, ok: false, deliveredText: '', textComplete: false, parts };
      // Preserve acknowledged text and stop. Retrying the whole response would
      // duplicate that prefix; the caller must only remember deliveredText.
      return { ...primary, ok: true, partial: true, deliveredText: delivered.join('\n\n'),
        textComplete: false, ...(images.length ? { stickerSent: false } : {}), parts };
    }
    primary ||= result;
    delivered.push(messageText(part));
  }
  const result = { ...primary, deliveredText: delivered.join('\n\n'), textComplete: true, parts };
  if (!images.length) return result;
  let sticker;
  try { sticker = await send(images); }
  catch { sticker = { ok: false, reason: 'Sticker delivery failed' }; }
  parts.push(sticker);
  return { ...result, stickerSent: Boolean(sticker?.ok), partial: !sticker?.ok };
}

// Await text delivery before posting one sticker; do not delay the text for effect.
// Opt in only for ordinary model replies, never command/status/catch-up layouts.
export async function sendTextThenSticker(message, send, { splitText = false } = {}) {
  if (splitText) return sendNaturalTextThenSticker(message, send);
  const images = message.filter(segment => segment.type === 'image').slice(0, 1);
  if (!images.length) return send(message);
  const text = message.filter(segment => segment.type !== 'image');
  if (!text.some(segment => segment.type === 'text' && segment.data?.text?.trim())) {
    return { ok: false, reason: 'Sticker needs a text reply first' };
  }
  const primary = await send(text);
  if (!primary?.ok) return primary;
  let sticker;
  try { sticker = await send(images); }
  catch { sticker = { ok: false, reason: 'Sticker delivery failed' }; }
  // Text is already delivered: a sticker failure must not cause duplicate text retries.
  return { ...primary, stickerSent: Boolean(sticker?.ok), partial: !sticker?.ok, parts: [primary, sticker] };
}
