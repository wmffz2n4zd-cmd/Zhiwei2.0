const sameContactEpoch = (first, second) => {
  const a = first.contactToken, b = second.contactToken;
  const x = first.memoryEpochToken, y = second.memoryEpochToken;
  return (first.channel || 'private') === (second.channel || 'private')
    && first.privateIdentity?.routeVersion === second.privateIdentity?.routeVersion
    && (!a && !b || Boolean(a && b && a.scope === b.scope && a.epoch === b.epoch))
    && (!x && !y || Boolean(x && y && x.scope === y.scope && x.epoch === y.epoch));
};
const incomingTokens = (...contexts) => [...new Map(contexts.flatMap(context => context.lifeIncomingTokens || [])
  .map(token => [`${token.scope}:${token.epoch}:${token.sequence}`, token])).values()];
const messageKey = value => String(value);
const hasMessage = (entry, id) => entry?.ids && [...entry.ids].some(value => messageKey(value) === messageKey(id));
const supersededError = () => Object.assign(Error('A newer private message replaced the unsent reply'), { code: 'REPLY_SUPERSEDED' });

// Short collection windows feed a per-contact queue. A delivery includes context
// retrieval, generation, sending and memory persistence, not just transport.
export class MessageBatches {
  constructor({ deliver, delay = 2600, maxWait = 3600, now = Date.now, isImmediate = () => false }) {
    Object.assign(this, { deliver, delay, maxWait, now, isImmediate });
    this.pending = new Map(); this.queues = new Map(); this.recent = new Map();
  }
  push(payload, context = {}) {
    // Contact epochs are assigned by the authenticated ingress, never by the
    // callback body. Keep them out-of-band and snapshot them before batching.
    const { replyTurn: ignored, ...incomingContext } = context;
    context = structuredClone(incomingContext);
    // Use receipt times from this process, never a remote sender's clock.
    payload = { ...payload, hubReceivedAt: this.now(), hubBatchCompletedAt: this.now() };
    delete payload.hubQueueStartedAt;
    // These fields are built here, never accepted from a callback. Preserve each
    // message so a retried first item cannot hide a fresh item in the same batch.
    delete payload.hubBatchMessages;
    delete payload.batched_message_ids;
    delete payload.lifeContactToken;
    delete payload.hubContactToken;
    delete payload.hubContactContext;
    delete payload.replyTurn;
    delete payload.memoryEpochToken;
    delete payload.lifeIncomingTokens;
    const segments = payload.message;
    const privateChat = payload.type === 'private_message' && payload.group_id == null && payload.groupId == null
      && ['string', 'number'].includes(typeof payload.senderId) && Boolean(String(payload.senderId).trim())
      && !(typeof payload.senderId === 'number' && (!Number.isFinite(payload.senderId) || payload.senderId <= 0));
    const command = Array.isArray(segments)
      && /^\s*\//.test(segments.filter(s => s.type === 'text').map(s => s.data?.text || '').join(''));
    const supported = privateChat
      && Array.isArray(segments) && segments.every(s => ['text', 'image', 'at'].includes(s.type))
      && !command;
    const scopeKey = context.privateIdentity?.memoryScope;
    // Preserve the complete namespace. A legacy data scope and a new account
    // identity must never alias merely because a suffix happens to match.
    const channel = privateChat ? `p:${scopeKey || `sender:${String(payload.senderId).trim()}`}` : null;
    let old = channel == null ? null : this.pending.get(channel);
    const queue = this.queues.get(channel);
    if (supported) {
      const duplicate = [old, ...(queue?.waiting || []), queue?.active]
        .find(entry => entry && !entry.superseded && sameContactEpoch(entry.context, context) && hasMessage(entry, payload.message_id));
      // Retrying the same input never cancels work or extends its quiet gap.
      if (duplicate) return new Promise((resolve, reject) => duplicate.waiters.push({ resolve, reject }));
    }
    // A later message must not lend its new epoch to text received before a
    // stop, even if both arrive inside the short collection window.
    if (old && !sameContactEpoch(old.context, context)) { this.flush(channel, true); old = null; }
    const active = this.queues.get(channel)?.active;
    if (active && !sameContactEpoch(active.context, context)) active.replacementBlocked = true;
    if (!supported) {
      if (old) this.flush(channel, true);
      const interrupted = this.queues.get(channel)?.active;
      if (interrupted) interrupted.replacementBlocked = true;
      // Control commands (for example cancelling a shutdown) must not wait for
      // slow model work. They still separate adjacent ordinary conversation.
      // The caller must recognize a control handler, not merely a slash prefix:
      // unknown slash commands can still fall through to ordinary model work.
      const immediate = channel != null && this.isImmediate(payload) === true;
      if (immediate) {
        const tail = this.queues.get(channel)?.waiting.at(-1);
        if (tail) tail.joinNext = false;
      }
      // Quotes keep their identity and conversation order. Non-private payloads
      // still reach the rejection boundary without touching a private queue.
      return new Promise((resolve, reject) => this.enqueue(immediate ? null : channel, {
        payload: structuredClone(payload), context, mergeable: false, waiters: [{ resolve, reject }], admittedIds: new Set()
      }));
    }
    return new Promise((resolve, reject) => {
      let entry = this.pending.get(channel);
      if (!entry) {
        entry = this.newEntry(payload, context);
        this.pending.set(channel, entry);
      }
      const knownDuplicate = context.contactToken?.duplicate === true || this.recent.has(`${channel}:${messageKey(payload.message_id)}`);
      this.appendMessage(entry, payload, context, knownDuplicate);
      entry.waiters.push({ resolve, reject });
      this.releaseMergedWaiters(entry);
      this.schedule(channel, entry);
      this.tryReplace(channel);
    });
  }
  newEntry(payload, context) {
    return { payload: structuredClone(payload), context, started: this.now(), lastReceivedAt: payload.hubReceivedAt,
      mergeable: true, ids: new Set(), messages: [], waiters: [], admittedIds: new Set(), knownDuplicateIds: new Set() };
  }
  appendMessage(entry, payload, context, knownDuplicate = false) {
    if (hasMessage(entry, payload.message_id)) return;
    if (entry.messages.length) {
      entry.payload.message.push({ type: 'text', data: { text: '\n' } }, ...structuredClone(payload.message));
      entry.payload.raw_message = `${entry.payload.raw_message || ''}\n${payload.raw_message || ''}`;
    } else {
      entry.payload.message = structuredClone(payload.message);
      entry.payload.raw_message = payload.raw_message;
    }
    const tokens = incomingTokens(entry.context, context);
    if (context.contactToken && context.contactToken.sequence > (entry.context.contactToken?.sequence || 0)) entry.context = context;
    entry.context = { ...entry.context, lifeIncomingTokens: tokens };
    entry.messages.push({ message_id: payload.message_id,
      message: structuredClone(payload.message), raw_message: payload.raw_message });
    entry.ids.add(payload.message_id);
    if (knownDuplicate) entry.knownDuplicateIds.add(messageKey(payload.message_id));
    if (!knownDuplicate && Number.isFinite(payload.hubReceivedAt)) entry.lastReceivedAt = Math.max(entry.lastReceivedAt, payload.hubReceivedAt);
  }
  releaseMergedWaiters(entry) {
    if (!entry.replacement || entry.waiters.length <= 1) return;
    // The newest callback keeps this pending work visible to graceful drain.
    // Already absorbed callbacks must not exhaust the ingress workload cap.
    for (const waiter of entry.waiters.splice(0, entry.waiters.length - 1)) waiter.resolve({ status: 'ok', merged: true });
  }
  schedule(channel, entry) {
    clearTimeout(entry.timer); entry.ready = false;
    const quiet = entry.lastReceivedAt + this.delay - this.now();
    // Replacements wait for a pause instead of forcing a reply mid-input.
    const wait = entry.replacement ? quiet : Math.min(quiet, this.maxWait - (this.now() - entry.started));
    entry.timer = setTimeout(() => this.flush(channel), Math.max(0, wait));
  }
  flush(channel, barrier = false) {
    const entry = this.pending.get(channel); if (!entry) return;
    clearTimeout(entry.timer);
    if (!barrier && entry.replacement && this.queues.get(channel)?.active?.superseded) {
      entry.ready = true;
      return;
    }
    this.pending.delete(channel);
    entry.payload.hubBatchCompletedAt = this.now();
    this.enqueue(channel, entry);
  }
  mergeEntries(entries) {
    const first = entries[0], merged = this.newEntry(first.payload, first.context);
    merged.started = first.started;
    for (const entry of entries) {
      for (const item of entry.messages) this.appendMessage(merged, item, entry.context, entry.knownDuplicateIds.has(messageKey(item.message_id)));
      merged.waiters.push(...entry.waiters);
      for (const id of entry.admittedIds) merged.admittedIds.add(id);
      merged.lastReceivedAt = Math.max(merged.lastReceivedAt, entry.lastReceivedAt);
    }
    merged.payload.hubBatchCompletedAt = entries.at(-1).payload.hubBatchCompletedAt;
    merged.replacement = entries.some(entry => entry.replacement);
    return merged;
  }
  tryReplace(channel) {
    const queue = this.queues.get(channel), active = queue?.active;
    if (!active?.replacementEnabled || active.replacementBlocked || active.joinNext === false || active.superseded || !active.mergeable) return false;
    const pending = this.pending.get(channel);
    const later = [...queue.waiting, ...(pending ? [pending] : [])];
    if (!later.length || later.some(entry => !entry.mergeable || entry.joinNext === false || !sameContactEpoch(active.context, entry.context))) return false;
    if (!later.some(entry => [...entry.ids].some(id => !hasMessage(active, id) && !entry.knownDuplicateIds.has(messageKey(id))))) return false;
    const merged = this.mergeEntries([active, ...later]);
    merged.replacement = true;
    // Old callbacks settle when their cancelled attempt settles; the new input
    // owns the replacement. Inputs and admitted IDs survive independently.
    merged.waiters = later.flatMap(entry => entry.waiters);
    for (const entry of later) { clearTimeout(entry.timer); entry.waiters = []; }
    queue.waiting = [];
    this.pending.set(channel, merged);
    active.superseded = true;
    this.releaseMergedWaiters(merged);
    this.schedule(channel, merged);
    active.controller.abort(supersededError());
    return true;
  }
  enqueue(channel, entry) {
    if (channel == null) {
      this.deliverEntry(entry);
      return;
    }
    let queue = this.queues.get(channel);
    if (!queue) { queue = { active: null, waiting: [] }; this.queues.set(channel, queue); }
    const tail = queue.waiting.at(-1);
    // Combine only work that has not begun. A command, quote or epoch change
    // remains a barrier, even when multiple collection windows expire in flight.
    if (tail?.mergeable && tail.joinNext !== false && entry.mergeable && sameContactEpoch(tail.context, entry.context)) {
      const merged = this.mergeEntries([tail, entry]);
      this.releaseMergedWaiters(merged);
      queue.waiting[queue.waiting.length - 1] = merged;
    } else queue.waiting.push(entry);
    this.startNext(channel, queue);
  }
  startNext(channel, queue) {
    if (queue.active) return;
    const entry = queue.waiting.shift();
    if (!entry) { this.queues.delete(channel); return; }
    queue.active = entry;
    this.deliverEntry(entry, () => {
      queue.active = null;
      if (this.pending.get(channel)?.ready) this.flush(channel);
      this.startNext(channel, queue);
    }, channel);
  }
  deliverEntry(entry, settled = () => {}, channel = null) {
    entry.controller = new AbortController();
    const turn = {
      signal: entry.controller.signal,
      admittedIds: new Set(entry.admittedIds),
      admit: ids => { for (const id of ids) { const key = messageKey(id); turn.admittedIds.add(key); entry.admittedIds.add(key); } },
      enableReplacement: () => {
        if (entry.mergeable && !entry.replacementBlocked) entry.replacementEnabled = true;
        if (channel != null) this.tryReplace(channel);
        return !entry.controller.signal.aborted;
      },
      beginDelivery: () => {
        if (entry.controller.signal.aborted) return false;
        entry.replacementBlocked = true;
        return true;
      }
    };
    const finish = (method, value) => {
      if (entry.superseded) { method = 'resolve'; value = { status: 'ok', superseded: true }; }
      else if (channel != null) {
        for (const id of entry.ids || [entry.payload.message_id]) {
          const key = `${channel}:${messageKey(id)}`;
          this.recent.delete(key); this.recent.set(key, true);
        }
        while (this.recent.size > 5000) this.recent.delete(this.recent.keys().next().value);
      }
      for (const waiter of entry.waiters) waiter[method](value);
      settled();
    };
    Promise.resolve().then(() => {
      if (entry.mergeable) {
        entry.payload.batched_message_ids = [...entry.ids];
        entry.payload.hubBatchMessages = entry.messages;
      }
      entry.payload.hubQueueStartedAt = this.now();
      return this.deliver(entry.payload, { ...entry.context, replyTurn: turn });
    }).then(result => finish('resolve', result), error => finish('reject', error));
  }
}
