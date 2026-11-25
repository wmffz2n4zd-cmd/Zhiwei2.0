import { isPrivateScope, privateEventScope, privateScopeId } from './private-scope.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const VERSION = 1;
const DEFAULTS = Object.freeze({ maxMessages: 12, maxMessageChars: 600, maxTextChars: 4000,
  maxEntries: 128, maxSeen: 2048, maxAgeMs: 24 * 60 * 60 * 1000, seenTtlMs: 48 * 60 * 60 * 1000 });
const attemptStates = new Set(['claimed', 'sending', 'sent', 'failed', 'uncertain']);
const clone = value => structuredClone(value);
const scopeFor = event => event.channel === 'pwa' && isPrivateScope(event.privateIdentity?.memoryScope) ? event.privateIdentity.memoryScope : `qq:private:${String(event.senderId)}`;
const isPrivate = event => event?.type === 'private_message' && !event.groupId && event.senderId != null
  && String(event.senderId).length > 0 && String(event.senderId).length <= 128;

function cleanText(value, max) {
  return String(value || '').replace(/\[CQ:(?:image|reply|record|video|file)[^\]]*\]/gi, '[附件未查看]')
    .replace(/\[CQ:[^\]]*\]/gi, '').replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/(?:https?:\/\/|file:\/\/)[^\s<>]+/gi, '[链接未打开]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function readMessages(event, now, policy) {
  const raw = event.raw || {};
  const batch = Array.isArray(raw.hubBatchMessages) && raw.hubBatchMessages.length
    ? raw.hubBatchMessages : [raw];
  return batch.slice(-policy.maxSeen).map((message, index) => {
    const segments = Array.isArray(message.message) ? message.message : [];
    const text = segments.filter(part => part?.type === 'text').map(part => part.data?.text || '').join('');
    const parts = [];
    if (segments.some(part => part?.type === 'image') || (batch.length === 1 && event.images?.length)) parts.push('[图片未查看]');
    if (segments.some(part => part?.type === 'reply') || (batch.length === 1 && event.hasReplySegment)) parts.push('[引用内容未查看]');
    if (segments.some(part => ['record', 'voice', 'audio', 'video', 'file'].includes(part?.type))) parts.push('[附件未查看]');
    parts.push(cleanText(text || message.raw_message || (batch.length === 1 ? event.text : ''), policy.maxMessageChars));
    const body = parts.filter(Boolean).join('\n').slice(0, policy.maxMessageChars) || '[没有可读取的文字]';
    // Callbacks with no stable ID are only deduplicated when the bridge supplies a timestamp.
    // Do not mistake separate identical utterances for retries merely because their text matches.
    let id = message.message_id == null ? null : String(message.message_id).slice(0, 200);
    if (!id && raw.time != null && Number.isFinite(Number(raw.time))) {
      id = 'fingerprint:' + createHash('sha256').update(JSON.stringify([String(event.senderId), raw.time, index, body])).digest('hex');
    }
    return { id: id || `local:${randomUUID()}`, at: now, text: body };
  });
}

function senderFor(event) {
  return { ...(event.channel === 'pwa' ? { channel: 'pwa', privateIdentity: clone(event.privateIdentity) } : {}),
    ...(event.pwaScopeGeneration !== undefined ? {pwaScopeGeneration:event.pwaScopeGeneration} : {}),
    senderId: String(event.senderId).slice(0, 128), selfId: String(event.selfId || '').slice(0, 128),
    senderName: cleanText(event.senderName, 80), senderLabel: cleanText(event.senderLabel, 80) };
}

function validateState(state) {
  const validAttempt = attempt => attempt == null || (attemptStates.has(attempt.state) && Number.isFinite(attempt.at));
  if (state?.version !== VERSION || !Array.isArray(state.entries) || !Array.isArray(state.seen)) throw Error('Invalid life reply state');
  const unique = new Set();
  for (const entry of state.entries) {
    if (typeof entry.id !== 'string' || unique.has(entry.id) || typeof entry.scope !== 'string'
      || typeof entry.sender?.senderId !== 'string' || entry.scope !== scopeFor(entry.sender)
      || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt) || !Number.isFinite(entry.expiresAt)
      || !Array.isArray(entry.messages) || !Array.isArray(entry.activities) || !validAttempt(entry.statusAttempt) || !validAttempt(entry.replyAttempt)
      || entry.messages.some(message => typeof message.id !== 'string' || typeof message.text !== 'string' || !Number.isFinite(message.at))
      || entry.activities.some(activity => typeof activity.id !== 'string' || typeof activity.title !== 'string' || typeof activity.mode !== 'string')) {
      throw Error('Invalid life reply entry');
    }
    unique.add(entry.id);
  }
  for (const seen of state.seen) if (typeof seen.scope !== 'string' || typeof seen.id !== 'string' || !Number.isFinite(seen.at)) throw Error('Invalid life reply deduplication state');
  return state;
}

async function atomicWrite(path, state) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    await regularFileOrMissing(path);
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(state) + '\n', 'utf8');
    await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path);
    // POSIX rename durability needs the parent directory as well as the file.
    // Windows does not support opening/fsyncing directories through Node.
    if (process.platform !== 'win32') {
      const directoryHandle = await open(dirname(path), 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function regularFileOrMissing(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Life reply state must be a regular file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function readState(path) {
  await regularFileOrMissing(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!(await handle.stat()).isFile()) throw Error('Life reply state must be a regular file');
    return validateState(JSON.parse(await handle.readFile('utf8')));
  } finally { await handle.close(); }
}

function terminal(entry) { return Boolean(entry.discarded || ['sent', 'uncertain'].includes(entry.replyAttempt?.state)
  || entry.replyAttempt?.state === 'failed' && !entry.replyAttempt.retryable); }
function waiting(entry) { return !entry.discarded && (!entry.replyAttempt || entry.replyAttempt.state === 'failed' && entry.replyAttempt.retryable); }
const inFlight = entry => ['claimed', 'sending'].includes(entry.replyAttempt?.state);

function compact(state, now, policy) {
  for (const entry of state.entries) {
    if (waiting(entry) && entry.expiresAt <= now) { entry.discarded = 'expired'; entry.doneAt = now; entry.messages = []; delete entry.lifeContactEvidence; }
  }
  state.entries = state.entries.filter(entry => !terminal(entry) || now - (entry.doneAt || entry.updatedAt) < policy.seenTtlMs);
  state.seen = state.seen.filter(seen => now - seen.at < policy.seenTtlMs).slice(-policy.maxSeen);
  while (state.entries.length >= policy.maxEntries) {
    const index = state.entries.findIndex(terminal);
    if (index < 0) break;
    state.entries.splice(index, 1);
  }
}

function mergedEvent(entry) {
  const text = entry.messages.map(message => message.text).join('\n');
  return { type: 'private_message', ...clone(entry.sender), text, images: [],
    backendCommand: false,
    ...(entry.lifeContactToken ? { lifeContactToken: clone(entry.lifeContactToken) } : {}),
    ...(entry.lifeContactEvidence ? { lifeContactEvidence: clone(entry.lifeContactEvidence) } : {}),
    ...(entry.lifeIncomingTokens ? { lifeIncomingTokens: clone(entry.lifeIncomingTokens) } : {}),
    ...(entry.memoryEpochToken ? { memoryEpochToken: clone(entry.memoryEpochToken) } : {}),
    hasReplySegment: false, hasAudioSegment: false, hasAtSegment: false, hasSelfAtSegment: false,
    isReplyToSelf: false, lifeReplyEpisodeId: entry.id,
    raw: { post_type: 'message', message_type: 'private', user_id: entry.sender.senderId,
      self_id: entry.sender.selfId, message_id: `life:${entry.id}`,
      batched_message_ids: entry.messages.map(message => message.id),
      message: [{ type: 'text', data: { text } }], raw_message: text } };
}

function resumeDetails(entry, timeline) {
  const latest = entry.activities.at(-1);
  const plan = latest && timeline.snapshot().plans?.find(item => item.id === latest.id);
  const outcome = plan?.status || 'unknown';
  let result;
  if (entry.followup) result = '本批是先前回应处理中收到的新消息，只回应这些新消息，不必再次回顾忙碌经历。';
  else if (outcome === 'completed' && latest?.mode === 'simulated') result = `先前角色生活模拟安排「${latest.title}」已结束。这不是实际阅读外部材料的证据，不编造书名、网页内容或做过的细节。`;
  else if (outcome === 'completed') result = `先前活动「${latest?.title || '暂时忙碌'}」记录为结束；这里只提供状态，没有提供外部材料内容，不能据此声称读过具体内容。`;
  else if (['interrupted', 'failed', 'cancelled', 'missed'].includes(outcome)) result = `先前活动「${latest?.title || '暂时忙碌'}」状态为${({ interrupted: '中断', failed: '失败', cancelled: '取消', missed: '错过' })[outcome]}，不能说已完成、读完或补造离线经历。`;
  else result = '先前忙碌阶段现在已可回应，但活动结果没有确认，不要声称完成或补造经历。';
  return { episodeId: entry.id, outcome, resumeContext: `${result}\n对方忙时的消息已合并在本次输入中；最多给一条自然回应，可以只简短提及刚才暂时忙，不逐条补答。图片和引用以本次实际提供的材料为准；只有占位时不能猜测其中内容。` };
}

/**
 * Durable reply coordination. The caller owns the directory through the life
 * writer lock. reply(event, details) MUST await details.markSending() immediately
 * before actual transport. Generation may restart; a persisted sending claim
 * with unknown outcome never automatically retries.
 */
export async function createLifeReplies({ directory, timeline, now = Date.now,
  isEligible, isPaused = () => false, sendStatus, reply, contacts, policy: suppliedPolicy = {} } = {}) {
  if (!directory || !timeline?.availability || !timeline?.snapshot || typeof isEligible !== 'function'
    || typeof sendStatus !== 'function' || typeof reply !== 'function') throw Error('Missing life reply dependencies');
  if (contacts != null && typeof contacts.isCurrent !== 'function') throw Error('Invalid life contact coordinator');
  const current = (token, scope) => !contacts || (token?.scope === scope && contacts.isCurrent(token));
  function discardStale(next, at) {
    for (const entry of next.entries) {
      if (waiting(entry) && !current(entry.lifeContactToken, entry.scope)) {
        entry.discarded = entry.lifeContactToken ? 'contact-stopped' : 'legacy-unfenced';
        entry.doneAt = at; entry.messages = []; delete entry.lifeContactEvidence;
      }
    }
  }
  const policy = { ...DEFAULTS };
  for (const key of Object.keys(policy)) {
    if (suppliedPolicy[key] != null) {
      if (!Number.isSafeInteger(suppliedPolicy[key]) || suppliedPolicy[key] < 1 || suppliedPolicy[key] > DEFAULTS[key]) throw Error(`Invalid life reply policy: ${key}`);
      policy[key] = suppliedPolicy[key];
    }
  }
  const path = join(resolve(directory), 'replies.json');
  await mkdir(resolve(directory), { recursive: true });
  let state;
  try { state = await readState(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { version: VERSION, entries: [], seen: [] }; }
  let changed = false;
  for (const entry of state.entries) for (const key of ['statusAttempt', 'replyAttempt']) {
    if (['claimed', 'sending'].includes(entry[key]?.state)) {
      const retryable = key === 'replyAttempt' && entry[key].state === 'claimed' && entry[key].phase === 'generation';
      entry[key].state = retryable ? 'failed' : 'uncertain'; entry[key].retryable = retryable;
      entry[key].reason = 'process-interrupted'; changed = true;
      if (key === 'replyAttempt' && !retryable) { entry.doneAt = now();
        if (entry.sender.channel !== 'pwa') { entry.messages = []; delete entry.lifeContactEvidence; } }
    }
  }
  const beforeRecovery = JSON.stringify(state);
  discardStale(state, now());
  changed ||= beforeRecovery !== JSON.stringify(state);
  if (changed) await atomicWrite(path, state);
  let tail = Promise.resolve(), fault = null, closing = false, closingTask, draining;
  const operations = new Set();
  const reservations = new Map();
  const reservedScopes = () => new Set(reservations.values());
  function canReceive(event) {
    if (closing || fault || !isPrivate(event)) return false;
    const scope = scopeFor(event), live = state.entries.filter(entry => !terminal(entry) && entry.expiresAt > stamp());
    if (live.some(entry => entry.scope === scope && waiting(entry)) || reservedScopes().has(scope)) return true;
    const occupied = live.length + [...reservedScopes()].filter(reserved => !live.some(entry => entry.scope === reserved && waiting(entry))).length;
    return occupied < policy.maxEntries;
  }

  function mutate(change) {
    const task = tail.then(async () => {
      if (fault) throw fault;
      const next = clone(state);
      const result = change(next);
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        try { await atomicWrite(path, next); state = next; }
        catch (error) { fault = error; throw error; }
      }
      return result;
    });
    tail = task.catch(() => {});
    return task;
  }
  function operation(work) {
    if (closing) return Promise.reject(Error('Life replies are closed'));
    const task = Promise.resolve().then(work); operations.add(task);
    task.then(() => operations.delete(task), () => operations.delete(task));
    return task;
  }
  async function eligibility(event) {
    try { return Boolean(await isEligible(event)); } catch { return false; }
  }
  function stamp() {
    const value = now(); if (!Number.isFinite(value)) throw Error('Invalid life reply clock'); return value;
  }
  async function finishAttempt(id, key, callback) {
    let result, reason;
    try { result = await callback(); reason = result?.ok === true ? null : result?.ok === false && result?.uncertain !== true ? 'rejected' : 'unconfirmed'; }
    catch { reason = 'transport-or-callback-error'; }
    const currentAttempt = state.entries.find(item => item.id === id)?.[key];
    const safelyUnsent = result?.ok === false && result?.uncertain !== true
      || result == null && key === 'replyAttempt' && currentAttempt?.state === 'claimed' && currentAttempt.phase === 'generation';
    const outcome = result?.ok === true || result?.sentMessageIds?.length ? 'sent' : safelyUnsent ? 'failed' : 'uncertain';
    await mutate(next => {
      const entry = next.entries.find(item => item.id === id);
      if (!entry || !['claimed', 'sending'].includes(entry[key]?.state)) return;
      entry[key] = { ...entry[key], state: outcome, finishedAt: stamp(), ...(reason ? { reason } : {}) };
      if (key === 'replyAttempt') {
        const cancelled = ['memory-epoch-changed', 'contact-stopped', 'contact-stopped-or-stale', 'contact-epoch-superseded',
          'incoming-already-consumed-or-stale', 'ineligible', 'new-input-accepted', 'pwa-route-or-input-changed'].includes(result?.reason);
        entry[key].retryable = outcome === 'failed' && !cancelled;
        if (entry[key].retryable) {
          entry.nextAttemptAt = stamp() + Math.min(60000, 1000 * 2 ** Math.min(6, (entry[key].attempts || 1) - 1));
        } else {
          if (cancelled) entry.discarded = result.reason;
          entry.doneAt = stamp(); entry.messages = []; delete entry.lifeContactEvidence;
        }
      }
    });
    return outcome;
  }

  async function receiveInner(event, { deferred = false } = {}) {
    if (!isPrivate(event) || event.backendCommand === true || !(await eligibility(event))) return { handled: false, kind: 'bypassed' };
    // Only a normal generation stopped before its first transport can be
    // deferred. A partly delivered answer or consumed catch-up is never replayed.
    if (deferred && (event.lifeReplyEpisodeId || event.lifeTransportStarted === true || event.sentMessageIds?.length)) {
      return { handled: true, kind: 'already-attempted' };
    }
    const at = stamp(), scope = scopeFor(event), messages = readMessages(event, at, policy);
    if (!current(event.lifeContactToken, scope)) return { handled: true, kind: 'contact-stopped' };
    const available = await timeline.availability({ scope });
    const accepted = await mutate(next => {
      compact(next, at, policy);
      discardStale(next, at);
      if (!current(event.lifeContactToken, scope)) return { handled: true, kind: 'contact-stopped' };
      const withinBatch = new Set();
      const fresh = messages.filter(message => {
        if (withinBatch.has(message.id) || next.seen.some(seen => seen.scope === scope && seen.id === message.id)) return false;
        withinBatch.add(message.id); return true;
      });
      if (!fresh.length) return { handled: true, kind: 'duplicate' };
      let entry = next.entries.find(item => item.scope === scope && waiting(item)
        && (item.sender.channel || 'qq') === (event.channel || 'qq')
        && item.sender.privateIdentity?.routeVersion === event.privateIdentity?.routeVersion);
      if (entry && JSON.stringify(entry.memoryEpochToken) !== JSON.stringify(event.memoryEpochToken)) {
        entry.discarded = 'memory-epoch-changed'; entry.doneAt = at; entry.messages = []; delete entry.lifeContactEvidence; entry = null;
      }
      const hasInFlight = next.entries.some(item => item.scope === scope && inFlight(item)
        && current(item.lifeContactToken, scope));
      const mixedRetry = fresh.length !== messages.length;
      if (!deferred && !available.busy && !entry && !hasInFlight && !mixedRetry) return { handled: false, kind: 'bypassed' };
      if (!entry) {
        compact(next, at, policy);
        const reservedElsewhere = [...reservedScopes()].filter(reserved => reserved !== scope
          && !next.entries.some(item => item.scope === reserved && waiting(item))).length;
        if (next.entries.length + reservedElsewhere >= policy.maxEntries) return { handled: true, kind: 'capacity', retryable: true };
        entry = { id: randomUUID(), scope, sender: senderFor(event), createdAt: at, updatedAt: at,
          expiresAt: at + policy.maxAgeMs, messages: [], activities: [], statusAttempt: null, replyAttempt: null,
          ...(contacts ? { lifeContactToken: clone(event.lifeContactToken) } : {}),
          ...(event.memoryEpochToken ? { memoryEpochToken: clone(event.memoryEpochToken) } : {}),
          ...(event.lifeIncomingTokens ? { lifeIncomingTokens: [] } : {}),
          followup: !available.busy };
        next.entries.push(entry);
      }
      if (available.busy && available.activityId && !entry.activities.some(activity => activity.id === available.activityId)) {
        entry.activities.push({ id: String(available.activityId), title: cleanText(available.title || '暂时忙碌', 120), mode: String(available.mode || 'unknown') });
        entry.activities = entry.activities.slice(-16);
        entry.followup = false;
      }
      // Save all seen IDs even if the content bound drops older messages.
      for (const message of fresh) next.seen.push({ scope, id: message.id, at });
      next.seen = next.seen.slice(-policy.maxSeen);
      entry.messages.push(...fresh); entry.messages = entry.messages.slice(-policy.maxMessages);
      while (entry.messages.length > 1 && entry.messages.map(message => message.text).join('\n').length > policy.maxTextChars) entry.messages.shift();
      if (entry.messages.length === 1) entry.messages[0].text = entry.messages[0].text.slice(0, policy.maxTextChars);
      entry.updatedAt = at;
      entry.sender = senderFor(event);
      if (entry.replyAttempt?.retryable) entry.nextAttemptAt = at;
      if (Array.isArray(event.lifeIncomingTokens)) {
        const combined = [...(entry.lifeIncomingTokens || []), ...event.lifeIncomingTokens];
        const ids = new Set(); entry.lifeIncomingTokens = combined.filter(token => {
          const key = JSON.stringify([token.scope, token.epoch, token.sequence]);
          if (ids.has(key)) return false; ids.add(key); return true;
        }).slice(-policy.maxSeen);
      }
      if (contacts && event.lifeContactToken.sequence >= (entry.lifeContactToken?.sequence || 0)) {
        entry.lifeContactToken = clone(event.lifeContactToken);
        if (event.lifeContactEvidence) entry.lifeContactEvidence = clone(event.lifeContactEvidence);
        else delete entry.lifeContactEvidence;
      }
      let statusText;
      if (!deferred && available.busy && !entry.statusAttempt) {
        entry.statusAttempt = { state: 'claimed', at };
        statusText = '*' + (cleanText(available.statusText, 159).replace(/^\*+\s*/, '') || '暂时忙一会儿，稍后再聊。');
      }
      return { handled: true, kind: available.busy ? 'busy' : 'queued', episodeId: entry.id, statusText };
    });
    if (accepted.statusText != null) {
      await finishAttempt(accepted.episodeId, 'statusAttempt', () => current(event.lifeContactToken, scope)
        ? sendStatus({ ...event, lifeReplyEpisodeId: accepted.episodeId, pwaStatusReply: true }, accepted.statusText) : { ok: false });
    }
    const { statusText: _statusText, ...result } = accepted;
    return result;
  }

  async function drainInner() {
    const totals = { attempted: 0, sent: 0, failed: 0, discarded: 0 };
    await mutate(next => {
      const before = next.entries.filter(waiting).length;
      compact(next, stamp(), policy);
      discardStale(next, stamp());
      totals.discarded += before - next.entries.filter(waiting).length;
    });
    const scopes = [...new Set(state.entries.filter(waiting).map(entry => entry.scope))];
    for (const scope of scopes) {
      if ((await timeline.availability({ scope })).busy) continue;
      const pending = state.entries.find(entry => entry.scope === scope && waiting(entry));
      if (!pending || pending.statusAttempt?.state === 'claimed' || state.entries.some(entry => entry.scope === scope
        && inFlight(entry) && current(entry.lifeContactToken, scope))) continue;
      // An operational read-only pause is not a revoked relationship. Keep
      // queued content until resumption instead of marking it ineligible.
      if (await isPaused(mergedEvent(pending))) continue;
      const allowed = await eligibility(mergedEvent(pending));
      if (allowed && pending.nextAttemptAt > stamp()) continue;
      const claimed = await mutate(next => {
        const entry = next.entries.find(item => item.id === pending.id);
        if (!entry || !waiting(entry)) return null;
        if (entry.expiresAt <= stamp() || !allowed || !current(entry.lifeContactToken, scope)) {
          entry.discarded = !current(entry.lifeContactToken, scope) ? 'contact-stopped' : allowed ? 'expired' : 'ineligible';
          entry.doneAt = stamp(); entry.messages = []; delete entry.lifeContactEvidence; totals.discarded++;
          return null;
        }
        entry.replyAttempt = { state: 'claimed', phase: 'generation', at: stamp(), attempts: (entry.replyAttempt?.attempts || 0) + 1 };
        return clone(entry);
      });
      if (!claimed) continue;
      totals.attempted++;
      const details = { ...resumeDetails(claimed, timeline), markSending: () => mutate(next => {
        const entry = next.entries.find(item => item.id === claimed.id);
        if (!entry || entry.replyAttempt?.state !== 'claimed' || !current(entry.lifeContactToken, scope)) return false;
        entry.replyAttempt.state = 'sending'; entry.replyAttempt.sendClaimedAt = stamp(); return true;
      }) };
      const outcome = await finishAttempt(claimed.id, 'replyAttempt', () => current(claimed.lifeContactToken, scope)
        ? reply(mergedEvent(claimed), details) : { ok: false, reason: 'contact-stopped' });
      if (outcome === 'sent') totals.sent++; else totals.failed++;
    }
    return totals;
  }

  return {
    canReceive,
    reconcilePwaDelivery({ episodeId, kind = 'reply', sentMessageIds }) {
      return operation(() => mutate(next => {
        if (!['reply','status'].includes(kind) || !Array.isArray(sentMessageIds) || !sentMessageIds.length) throw Error('Invalid PWA reply proof');
        const entry = next.entries.find(item => item.id === episodeId), key = kind === 'reply' ? 'replyAttempt' : 'statusAttempt';
        if (!entry || entry.sender.channel !== 'pwa') return { ok: true, skipped: true };
        entry[key] = { ...entry[key], state: 'sent', at: entry[key]?.at || stamp(), finishedAt: stamp(), retryable: false, reason: 'pwa-mailbox-confirmed' };
        if (kind === 'reply') { entry.doneAt = stamp(); entry.messages = []; delete entry.lifeContactEvidence; }
        return { ok: true };
      }));
    },
    recoverPwaDelivery(episodeId) {
      return operation(() => mutate(next => {
        const entry = next.entries.find(item => item.id === episodeId);
        if (!entry || entry.sender.channel !== 'pwa' || !entry.messages.length || entry.replyAttempt?.state !== 'uncertain') return { ok: true, skipped: true };
        entry.replyAttempt = { ...entry.replyAttempt, state: 'failed', retryable: true, reason: 'pwa-mailbox-absent' };
        delete entry.doneAt; entry.nextAttemptAt = stamp(); return { ok: true };
      }));
    },
    pwaRecoveryEntries() { return clone(state.entries.filter(e => e.sender.channel === 'pwa' && e.replyAttempt?.state === 'uncertain')); },
    reserveIncoming(event) {
      if (!canReceive(event)) return { ok: false, reason: 'life-reply-capacity' };
      const id = randomUUID(); reservations.set(id, scopeFor(event)); return { ok: true, id };
    },
    releaseIncomingReservation(id) { return reservations.delete(id); },
    receive: event => operation(() => receiveInner(event)),
    // A reply generated before an activity transition may finish after that
    // activity has already ended. Preserve its original input and epoch even
    // when currently available; the old generated text is not reused.
    defer: event => operation(() => receiveInner(event, { deferred: true })),
    drain() {
      if (draining) return draining;
      const task = operation(drainInner); draining = task;
      task.then(() => { draining = null; }, () => { draining = null; });
      return task;
    },
    close() {
      if (closingTask) return closingTask;
      closing = true;
      reservations.clear();
      closingTask = (async () => {
        const results = await Promise.allSettled([...operations]);
        await tail;
        if (fault) throw fault;
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      })();
      return closingTask;
    }
  };
}
