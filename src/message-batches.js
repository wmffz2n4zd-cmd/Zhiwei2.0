// Short, bounded collection window; commands and quoted messages keep their identity.
export class MessageBatches {
  constructor({ deliver, delay = 2600, maxWait = 3600, now = Date.now }) {
    Object.assign(this, { deliver, delay, maxWait, now }); this.pending = new Map();
  }
  push(payload, context = {}) {
    // Contact epochs are assigned by the authenticated ingress, never by the
    // callback body. Keep them out-of-band and snapshot them before batching.
    context = structuredClone(context);
    // Use receipt times from this process, never a remote sender's clock.
    payload = { ...payload, hubReceivedAt: this.now(), hubBatchCompletedAt: this.now() };
    // These fields are built here, never accepted from a callback. Preserve each
    // message so a retried first item cannot hide a fresh item in the same batch.
    delete payload.hubBatchMessages;
    delete payload.batched_message_ids;
    delete payload.lifeContactToken;
    delete payload.hubContactToken;
    delete payload.hubContactContext;
    const segments = payload.message;
    const privateChat = payload.message_type === 'private' && payload.group_id == null
      && ['string', 'number'].includes(typeof payload.user_id) && Boolean(String(payload.user_id).trim())
      && !(typeof payload.user_id === 'number' && (!Number.isFinite(payload.user_id) || payload.user_id <= 0));
    const supported = payload.post_type === 'message' && privateChat
      && Array.isArray(segments) && segments.every(s => ['text', 'image', 'at'].includes(s.type))
      && !/^\s*\//.test(segments.filter(s => s.type === 'text').map(s => s.data?.text || '').join(''));
    const channel = privateChat ? `p:${String(payload.user_id).trim()}` : null;
    let old = channel == null ? null : this.pending.get(channel);
    const previousToken = old?.context.contactToken, incomingToken = context.contactToken;
    const sameEpoch = !previousToken && !incomingToken || Boolean(previousToken && incomingToken
      && previousToken.scope === incomingToken.scope && previousToken.epoch === incomingToken.epoch);
    // A later message must not lend its new epoch to text received before a
    // stop, even if both arrive inside the short collection window.
    if (old && !sameEpoch) { this.flush(channel); old = null; }
    if (!supported) { if (old) this.flush(channel); return this.deliver(payload, context); }
    return new Promise((resolve, reject) => {
      let entry = this.pending.get(channel);
      if (!entry) {
        entry = { payload: structuredClone(payload), context, started: this.now(), ids: new Set(), messages: [], waiters: [] };
        this.pending.set(channel, entry);
      } else if (!entry.ids.has(payload.message_id)) {
        entry.payload.message.push({ type: 'text', data: { text: '\n' } }, ...structuredClone(segments));
        entry.payload.raw_message = `${entry.payload.raw_message || ''}\n${payload.raw_message || ''}`;
        // Semantic decisions bind to the latest real ingress, never the merged
        // body or an older duplicate's receipt. All tokens remain in one epoch.
        if (context.contactToken && context.contactToken.sequence > (entry.context.contactToken?.sequence || 0)) entry.context = context;
      }
      if (!entry.ids.has(payload.message_id)) entry.messages.push({ message_id: payload.message_id,
        message: structuredClone(segments), raw_message: payload.raw_message });
      entry.ids.add(payload.message_id); entry.waiters.push({ resolve, reject });
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.flush(channel), Math.max(0, Math.min(this.delay, this.maxWait - (this.now() - entry.started))));
    });
  }
  flush(channel) {
    const entry = this.pending.get(channel); if (!entry) return;
    this.pending.delete(channel); clearTimeout(entry.timer);
    entry.payload.batched_message_ids = [...entry.ids];
    entry.payload.hubBatchMessages = entry.messages;
    entry.payload.hubBatchCompletedAt = this.now();
    Promise.resolve().then(() => this.deliver(entry.payload, entry.context)).then(
      result => entry.waiters.forEach(w => w.resolve(result)),
      error => entry.waiters.forEach(w => w.reject(error)));
  }
}
