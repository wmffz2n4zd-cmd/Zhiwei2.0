export function hasUnseenMedia(event) {
  const segments = event.raw?.message;
  return /\[CQ:(?:image|face|mface|video|marketface),/i.test(String(event.text || ''))
    || Array.isArray(segments) && segments.some(s => ['image', 'face', 'mface', 'marketface', 'video'].includes(s?.type))
    || Boolean(event.replyContext?.images?.length)
    || /\[CQ:(?:image|face|mface|video|marketface),/i.test(String(event.replyContext?.text || ''));
}

export function mediaText(text) {
  return String(text || '').replace(/\[CQ:[^\]]*\]/g, '').replace(/[@＠]知微/g, '').trim();
}

export function unseenMediaDecision(event, direct) {
  if (!hasUnseenMedia(event)) return null;
  const text = mediaText(event.text);
  if (!text || /(?:看|图|表情|识别|什么意思|何意味|什么梗|动[画图])/.test(text)) {
    return direct ? { ok: true, reply: '这个表情我这边看不到内容，没法认出它在表达什么。', reason: 'Media unavailable' }
      : { ok: false, reason: 'Unseen media; no guessing' };
  }
  return null;
}
