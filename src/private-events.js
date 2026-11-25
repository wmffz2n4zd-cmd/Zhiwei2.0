// Internal private-chat payloads are constructed by an authenticated adapter.
// The segment representation and raw receipt IDs are retained for existing
// durable life/learning records; no OneBot envelope or network API is needed.
export function normalizePrivatePayload(payload) {
  if (payload?.type !== 'private_message' || payload.groupId != null || payload.group_id != null
    || payload.raw?.group_id != null || !['string', 'number'].includes(typeof payload.senderId)
    || !String(payload.senderId).trim()
    || typeof payload.senderId === 'number' && (!Number.isFinite(payload.senderId) || payload.senderId <= 0))
    throw TypeError('A valid private payload is required');
  const segments = Array.isArray(payload.message) ? payload.message : [];
  const text = segments.filter(segment => segment?.type === 'text')
    .map(segment => String(segment.data?.text ?? '')).join('').trim();
  const reply = segments.find(segment => segment?.type === 'reply');
  const replyMessageId = reply?.data?.id;
  return {
    type: 'private_message', senderId: String(payload.senderId),
    senderName: String(payload.senderName || '对方'), text,
    images: segments.filter(segment => segment?.type === 'image').slice(0, 4)
      .map(segment => ({ file: String(segment.data?.file || '') })),
    hasAudioSegment: segments.some(segment => ['record', 'voice', 'audio'].includes(segment?.type)),
    hasAtSegment: false, hasSelfAtSegment: false, atTargets: [],
    hasReplySegment: Boolean(reply), replyMessageId: replyMessageId == null ? undefined : String(replyMessageId),
    isReplyToSelf: false, raw: payload
  };
}
