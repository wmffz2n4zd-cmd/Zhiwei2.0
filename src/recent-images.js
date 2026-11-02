// Image follow-ups stay within one conversation/sender and expire after two minutes.
export class RecentImages {
  constructor({ now = Date.now, ttl = 120000 } = {}) { this.now = now; this.ttl = ttl; this.entries = new Map(); }
  attach(event) {
    const now = this.now();
    for (const [key, entry] of this.entries) if (now - entry.at > this.ttl) this.entries.delete(key);
    if (event?.type !== 'private_message' || event.groupId != null || event.raw?.group_id != null
      || !['string', 'number'].includes(typeof event.senderId) || !String(event.senderId).trim()
      || (typeof event.senderId === 'number' && (!Number.isFinite(event.senderId) || event.senderId <= 0))) return event;
    const key = String(event.senderId).trim();
    const text = String(event.text || '');
    if (/(?:^|\s)\/\S/.test(text.replace(/\[CQ:at,[^\]]*\]/gi, '').trim())) return event;
    if (event.images?.length) {
      this.entries.set(key, { at: now, images: event.images.slice(0, 4) }); return event;
    }
    if (event.replyContext?.images?.length || event.hasReplySegment) return event;
    const previous = this.entries.get(key);
    if (previous && /读.{0,6}(图|字)|图.{0,8}(文字|内容|什么)|这张|刚才.{0,6}图|识别.{0,6}图|看.{0,4}图/.test(text)) {
      return { ...event, images: previous.images, reusedRecentImages: true };
    }
    return event;
  }
}
