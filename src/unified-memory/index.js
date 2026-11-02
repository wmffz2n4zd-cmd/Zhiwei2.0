import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { activeMemories, listMemories, recallMemories } from './recall.js';
import { PRIVATE_PROFILE_SOURCE, PRIVATE_PROFILE_TOPIC, isProfileScope, updatePrivateProfile,
  validatePrivateProfile, formatPrivateProfile } from '../private-profile.js';
const types = new Set(['idea', 'handoff', 'projectNote', 'preference', 'openLoop', 'dailyState']);
// Runtime-only state must never be recalled as a shared conversation memory.
const hiddenSources = new Set(['qq-mood', PRIVATE_PROFILE_SOURCE]);
const mutableRuntimeSources = new Set(['qq-mood']);
const latestState = (data, key) => data.entries.findLast(e => e.type === 'dailyState'
  && e.scope === key.scope && e.source === key.source && e.topic === key.topic) || null;
export function memoryScope(event) {
  const sender = event?.senderId;
  if (event?.type !== 'private_message' || event.groupId != null || event.raw?.group_id != null
      || !['string', 'number'].includes(typeof sender) || !/^[1-9]\d*$/.test(String(sender))) {
    throw new Error('A valid private sender is required for QQ memory');
  }
  return `qq:private:${sender}`;
}

function boundedText(value, limit) {
  const text = String(value || '');
  if (text.length <= limit) return { text, truncated: false };
  // An oversized source is outside normal private-message retention. Keep only
  // complete sentences, and explicitly say that content was not retained.
  const prefix = text.slice(0, limit);
  const boundaries = [...prefix.matchAll(/[\n。！？!?]/g)];
  const end = boundaries.length ? boundaries.at(-1).index + 1 : 0;
  return { text: prefix.slice(0, end), truncated: true };
}

function validity(input, data, scope) {
  const result = {};
  if (input.validUntil != null) {
    const time = Date.parse(input.validUntil);
    if (!Number.isFinite(time)) throw Error('Invalid memory expiry');
    result.validUntil = new Date(time).toISOString();
  }
  if (input.supersedes != null) {
    if (!Array.isArray(input.supersedes) || input.supersedes.length > 8) throw Error('Invalid supersession');
    const ids = [...new Set(input.supersedes)];
    if (ids.some(id => typeof id !== 'string' || !data.entries.some(entry => entry.id === id && entry.scope === scope && !hiddenSources.has(entry.source)))) {
      throw Error('Supersession must refer to existing visible memories in the same scope');
    }
    result.supersedes = ids;
  }
  return result;
}

const privateScope = scope => typeof scope === 'string' && /^qq:private:[^\s:]+$/.test(scope)
  && scope.length <= 160 && !/^qq:private:(?:undefined|null|NaN)$/i.test(scope);

export function createUnifiedMemory({ memoryPath, now = Date.now }) {
  let queue = Promise.resolve();
  async function load() {
    try {
      const data = JSON.parse(await readFile(memoryPath, 'utf8'));
      if (data.version == null && Array.isArray(data.entries) && data.entries.length === 0) data.version = 1;
      if (data.version !== 1 || !Array.isArray(data.entries)) throw Error('Unsupported unified memory format; original file preserved');
      return data;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, entries: [] }; throw error; }
  }
  function mutate(fn) {
    const task = queue.then(async () => {
      await mkdir(dirname(memoryPath), { recursive: true });
      let lock;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { lock = await open(memoryPath + '.lock', 'wx'); break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise(r => setTimeout(r, 50)); }
      }
      if (!lock) throw Error('Memory store is busy; if a writer crashed, remove its .lock only after stopping all writers');
      try {
      const data = await load(); const result = fn(data);
      data.updatedAt = new Date(now()).toISOString();
      await mkdir(dirname(memoryPath), { recursive: true });
      const temp = memoryPath + '.tmp';
      await writeFile(temp, JSON.stringify(data, null, 2)); await rename(temp, memoryPath);
      return result;
      } finally { await lock.close(); await unlink(memoryPath + '.lock'); }
    });
    queue = task.catch(() => {}); return task;
  }
  const api = {
    async readLatestState({ scope, source, topic }) {
      if (!scope || !mutableRuntimeSources.has(source) || !topic) return null;
      await queue;
      return latestState(await load(), { scope, source, topic });
    },
    async compareAndSetState({ scope, source, topic, expectedId = null, summary }) {
      if (!scope || !mutableRuntimeSources.has(source) || !topic || String(topic).length > 120
        || typeof summary !== 'string' || !summary.trim() || summary.length > 2000) {
        return { ok: false, reason: 'Invalid runtime state' };
      }
      return mutate(data => {
        const current = latestState(data, { scope, source, topic });
        if ((current?.id || null) !== expectedId) return { ok: false, reason: 'Stale runtime state' };
        const entry = { id: randomUUID(), type: 'dailyState', scope, source, topic, summary,
          nextActions: [], at: new Date(now()).toISOString() };
        // One current state per participant, in the existing memory store.
        data.entries = data.entries.filter(e => !(e.type === 'dailyState' && e.scope === scope
          && e.source === source && e.topic === topic));
        data.entries.push(entry); data.entries = data.entries.slice(-5000);
        return { ok: true, entry };
      });
    },
    async write(input = {}) {
      if (!String(input.summary || '').trim()) return { ok: false, reason: 'Empty memory' };
      if (hiddenSources.has(input.source)) return { ok: false, reason: 'Use runtime state compare-and-set' };
      return mutate(data => {
        const scope = input.scope || 'owner';
        const content = boundedText(input.summary, 16000);
        if (!content.text.trim()) return { ok: false, reason: 'No complete memory sentence within retention limit' };
        const entry = { id: randomUUID(), type: types.has(input.type) ? input.type : 'dailyState',
          scope, source: String(input.source || 'manual').slice(0, 120),
          topic: String(input.topic || '').slice(0, 120), summary: content.text,
          nextActions: Array.isArray(input.nextActions) ? input.nextActions.slice(0, 8).map(value => String(value).slice(0, 800)) : [],
          at: new Date(now()).toISOString(), ...validity(input, data, scope), ...(content.truncated ? { truncated: true } : {}) };
        data.entries.push(entry); data.entries = data.entries.slice(-5000);
        return { ok: true, entry };
      });
    },
    async writeExchange({ scope, senderLabel, userText, replyText, messageId, replyMessageId, quotedText, sentMessageIds = [] } = {}) {
      if (!privateScope(scope)) return { ok: false, reason: 'A valid private conversation scope is required' };
      if (!String(replyText || '').trim()) return { ok: false, reason: 'Empty reply' };
      if (!Array.isArray(sentMessageIds) || sentMessageIds.length > 8
        || sentMessageIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 120)) {
        return { ok: false, reason: 'Invalid delivered message ids' };
      }
      const user = boundedText(userText, 8000), reply = boundedText(replyText, 8000), quote = boundedText(quotedText, 2000);
      if (!reply.text.trim()) return { ok: false, reason: 'No complete reply within retention limit' };
      return mutate(data => {
        const exchange = { version: 1, senderLabel: String(senderLabel || '').slice(0, 120),
          userText: user.text, replyText: reply.text, quotedText: quote.text,
          messageId: messageId == null ? null : String(messageId).slice(0, 120),
          // This is the quoted source id, not the id of this assistant reply.
          replyMessageId: replyMessageId == null ? null : String(replyMessageId).slice(0, 120),
          sentMessageIds: [...new Set(sentMessageIds)],
          truncated: user.truncated || reply.truncated || quote.truncated,
          originalLengths: { userText: String(userText || '').length, replyText: String(replyText || '').length, quotedText: String(quotedText || '').length } };
        const entry = { id: randomUUID(), type: 'dailyState', scope, source: 'qq',
          topic: user.text.slice(0, 120), summary: `用户：${user.text}\n${quote.text ? `当时引用：${quote.text}\n` : ''}知微：${reply.text}`,
          exchange, nextActions: [], at: new Date(now()).toISOString() };
        if (isProfileScope(scope)) {
          const prior = latestState(data, { scope, source: PRIVATE_PROFILE_SOURCE, topic: PRIVATE_PROFILE_TOPIC });
          if (prior && !prior.profile) throw Error('Missing private profile state; original memory preserved');
          const profile = updatePrivateProfile(prior?.profile, { scope, userText: user.text,
            messageId: exchange.messageId, exchangeId: entry.id, at: entry.at });
          data.entries = data.entries.filter(e => !(e.scope === scope && e.source === PRIVATE_PROFILE_SOURCE && e.topic === PRIVATE_PROFILE_TOPIC));
          data.entries.push({ id: randomUUID(), type: 'dailyState', scope, source: PRIVATE_PROFILE_SOURCE,
            topic: PRIVATE_PROFILE_TOPIC, summary: 'Private profile runtime state', profile, nextActions: [], at: entry.at });
        }
        data.entries.push(entry); data.entries = data.entries.slice(-5000);
        return { ok: true, entry };
      });
    },
    async writeOutbound({ scope, replyText, intentId, sentMessageIds = [] } = {}) {
      if (!privateScope(scope) || typeof replyText !== 'string' || !replyText.trim() || replyText.length > 900
        || typeof intentId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(intentId)
        || !Array.isArray(sentMessageIds) || sentMessageIds.length > 8
        || sentMessageIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 120)) throw Error('Invalid outbound private memory');
      const outbound = { version: 1, intentId, replyText, sentMessageIds: [...new Set(sentMessageIds)] };
      return mutate(data => {
        const old = data.entries.find(entry => entry.scope === scope && entry.source === 'qq-life-contact' && entry.outbound?.intentId === intentId);
        if (old) {
          if (JSON.stringify(old.outbound) !== JSON.stringify(outbound)) throw Error('Outbound private memory conflicts with an existing intent');
          return { ok: true, entry: old, duplicate: true };
        }
        const entry = { id: randomUUID(), type: 'dailyState', scope, source: 'qq-life-contact',
          topic: '主动私聊', summary: `知微主动发出的私聊：${replyText}`, outbound, nextActions: [], at: new Date(now()).toISOString() };
        data.entries.push(entry); data.entries = data.entries.slice(-5000);
        return { ok: true, entry };
      });
    },
    async readPrivateProfile({ scope } = {}) {
      if (!isProfileScope(scope)) return null;
      await queue;
      const entry = latestState(await load(), { scope, source: PRIVATE_PROFILE_SOURCE, topic: PRIVATE_PROFILE_TOPIC });
      return entry ? structuredClone(validatePrivateProfile(entry.profile, scope)) : null;
    },
    async formatPrivateProfile({ scope } = {}) {
      return formatPrivateProfile(await api.readPrivateProfile({ scope }), scope);
    },
    async hasDeliveredMessage({ scope, messageId } = {}) {
      if (!privateScope(scope) || typeof messageId !== 'string' || !messageId.trim() || messageId.length > 120) return false;
      await queue; const data = await load();
      return data.entries.some(entry => entry.scope === scope && (
        entry.source === 'qq' && entry.exchange?.version === 1
          && Array.isArray(entry.exchange.sentMessageIds) && entry.exchange.sentMessageIds.includes(messageId)
        || entry.source === 'qq-life-contact' && entry.outbound?.version === 1
          && Array.isArray(entry.outbound.sentMessageIds) && entry.outbound.sentMessageIds.includes(messageId)));
    },
    async read({ scope = 'owner', query = '', limit = 8 } = {}) {
      await queue; const data = await load();
      const time = now();
      const entries = listMemories(activeMemories(data.entries, scope, time, hiddenSources), { query, limit, now: time });
      return { entries, latestHandoff: entries.find(e => e.type === 'handoff'), updatedAt: data.updatedAt };
    },
    async recall({ scope = 'owner', ...options } = {}) {
      await queue; const data = await load(); const time = now();
      return recallMemories(activeMemories(data.entries, scope, time, hiddenSources), { ...options, scope, now: time });
    },
    async status({ scope = 'owner' } = {}) {
      await queue; const data = await load(); const entries = data.entries.filter(e => e.scope === scope);
      const keys = { handoff: 'handoffHistory', idea: 'ideas', projectNote: 'projectNotes', preference: 'preferences', openLoop: 'openLoops', dailyState: 'dailyTimeline' };
      const counts = {}; for (const e of entries) counts[keys[e.type]] = (counts[keys[e.type]] || 0) + 1;
      return { ok: true, enabled: true, count: entries.length, counts, updatedAt: data.updatedAt,
        active: activeMemories(data.entries, scope, now(), hiddenSources).length };
    },
    clear({ scope = 'owner' } = {}) { return mutate(data => {
      const before = data.entries.length; data.entries = scope === 'all' ? [] : data.entries.filter(e => e.scope !== scope);
      return { ok: true, removed: before - data.entries.length };
    }); },
    async formatForPrompt(options) {
      return (await api.recall(options)).context;
    }
  }; return api;
}
export function judgeUnifiedMemoryByRules({ text = '' } = {}) {
  if (/记住|记一下/.test(text)) return { action: 'write', memoryType: 'preference', summary: text, confidence: 0.8 };
  if (/记得|上次|之前|交接/.test(text)) return { action: 'read', query: text };
  return { action: 'none' };
}
