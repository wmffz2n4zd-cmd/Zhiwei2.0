import { isPrivateScope, privateEventScope } from '../private-scope.js';
import { readFile, mkdir, rename, open, unlink, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireFileLock, acquireAdvisoryLock, atomicWriteFile } from '../file-lock.js';
import { V201_MEMORY_RESET_MARKER } from '../memory-reset-guard.js';
import { activeMemories, listMemories, recallMemories } from './recall.js';
import { PRIVATE_PROFILE_SOURCE, PRIVATE_PROFILE_TOPIC, isProfileScope, updatePrivateProfile,
  validatePrivateProfile, formatPrivateProfile } from '../private-profile.js';
const types = new Set(['idea', 'handoff', 'projectNote', 'preference', 'openLoop', 'dailyState']);
// Runtime-only state must never be recalled as a shared conversation memory.
const hiddenSources = new Set(['qq-mood', PRIVATE_PROFILE_SOURCE]);
const mutableRuntimeSources = new Set(['qq-mood']);
const latestState = (data, key) => data.entries.findLast(e => e.type === 'dailyState'
  && e.scope === key.scope && e.source === key.source && e.topic === key.topic) || null;
export const memoryScope = privateEventScope;

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

const privateScope = scope => isPrivateScope(scope) || typeof scope === 'string' && /^qq:private:[^\s:]+$/.test(scope)
  && scope.length <= 160 && !/^qq:private:(?:undefined|null|NaN)$/i.test(scope);

// Learning bookkeeping is not a recallable memory or a duplicate dialogue store.
// A new store/reset gets a new epoch, even when clocks and message ids repeat.
export function createEmptyUnifiedMemory() {
  return { version: 1, entries: [], learning: { version: 1, epoch: randomUUID(), scopes: {} } };
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Kept outside the bounded recall list. A pruned dialogue must never become a
// new learning sample when a durable mailbox projection is retried.
function deliveryReceipt(data, scope, deliveryId, content) {
  if (deliveryId == null) return null;
  if (typeof deliveryId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(deliveryId)) throw Error('Invalid delivery id');
  if (data.deliveryCommits != null && (typeof data.deliveryCommits !== 'object' || Array.isArray(data.deliveryCommits))) throw Error('Invalid delivery ledger');
  data.deliveryCommits ||= {};
  const sink = content[0] === 'state' ? content.slice(0,3) : [content[0]];
  const key = fingerprint([scope, sink, deliveryId]), digest = fingerprint(content);
  const old = data.deliveryCommits[key];
  if (old && old.digest !== digest) throw Error('Conflicting delivery projection');
  return { key, digest, old };
}
const validCounter = value => Number.isSafeInteger(value) && value >= 0;
function learningMetadata(data) {
  if (!data.learning) data.learning = createEmptyUnifiedMemory().learning;
  const meta = data.learning;
  if (meta.version !== 1 || typeof meta.epoch !== 'string' || !meta.epoch || meta.epoch.length > 120
    || !meta.scopes || typeof meta.scopes !== 'object' || Array.isArray(meta.scopes)
    || Object.entries(meta.scopes).some(([scope, value]) => !isProfileScope(scope) || !value
      || typeof value.epoch !== 'string' || !value.epoch || value.epoch.length > 120
      || !validCounter(value.sequence) || !validCounter(value.revision))) {
    throw Error('Invalid learning source metadata; original memory preserved');
  }
  return meta;
}
function learningScope(data, scope) {
  if (!isProfileScope(scope)) throw Error('Learning requires a valid private scope');
  const meta = learningMetadata(data);
  meta.scopes[scope] ||= { epoch: randomUUID(), sequence: 0, revision: 0 };
  return { ...meta.scopes[scope], epoch: `${meta.epoch}:${meta.scopes[scope].epoch}` };
}
function incrementLearningRevision(data, scope) {
  if (!isProfileScope(scope)) return;
  learningScope(data, scope);
  const state = data.learning.scopes[scope];
  if (state.revision === Number.MAX_SAFE_INTEGER) throw Error('Learning revision exhausted');
  state.revision++;
}
function markLearningDelivery(data, entry, eligible) {
  if (!eligible || !isProfileScope(entry.scope)) return;
  learningScope(data, entry.scope);
  const state = data.learning.scopes[entry.scope];
  if (state.sequence === Number.MAX_SAFE_INTEGER) throw Error('Learning sequence exhausted');
  entry.learning = { version: 1, sequence: ++state.sequence };
}
function optionalLearningMutation(data, mutate) {
  const original = structuredClone(data.learning);
  try { mutate(); }
  catch {
    // Optional learning bookkeeping must not lose an already delivered chat.
    // Preserve malformed metadata for diagnosis; learning reads fail closed.
    if (original === undefined) delete data.learning;
    else data.learning = original;
  }
}
function attributableUserText(text) {
  const value = typeof text === 'string' ? text : '';
  // These samples may still support what Zhiwei herself said, but quoted,
  // hypothetical or third-party words are never treated as the user's wishes.
  return /(?:翻译|润色|改写|续写|仿写|扮演|示例|例子|歌词|如下|以下文本|下面这句|帮我写|角色设定|原话|转发|引用|台词|举例|例如|比如|假如|假设|如果|```|[“”「」『』"`]|(?:^|\n)\s*>)/u.test(value)
    || /(?:他|她|他们|她们|对方|朋友|同事|别人).{0,12}(?:说|写|发|提到|表示)/u.test(value)
    || /(?:^|[。！!\r\n])[^。！!\r\n]*?(?:说|写|表示|提到|留言|回复|发来|告诉我)[^。！!\r\n：:]*[：:]/u.test(value)
    ? '' : value;
}
export function directLearningFeedback(text) {
  const own = attributableUserText(text).trim();
  return Boolean(own) && /(?:更正|纠正|撤回|忘掉|别再|不要再|别(?:总|老|一直|每次)|不要(?:总|老|一直|每次)|以后.{0,20}(?:叫我|称呼|问|说|回答|回复)|(?:我|对我)(?:现在|已经)?(?:不再喜欢|不喜欢|喜欢|习惯)|(?:别|不要|少)(?:再)?(?:问|追问|叫我|开玩笑|调侃|挤兑|安慰|解释)|认真(?:说|一点)|换(?:个|种)?语气|不是这个意思|不对[，,：:]|\b(?:stop asking|do not call me|don't call me|i (?:don't like|prefer)|correction)\b)/iu.test(own);
}
function selfExpressionEligible(userText) {
  const value = String(userText || '').trim();
  // Delivered quoted/commissioned text is not Zhiwei's spontaneous speech.
  // Merely discussing a friend's quotation does not trigger this exclusion.
  return !/(?:翻译|润色|改写|续写|仿写|复述|转述|扮演|模仿|复读|角色设定)|(?:帮我|替我|给我|请).{0,16}(?:写一|写个|写封|写段|写句|拟一|拟个|拟段)|(?:原样|逐字|重复|照着).{0,12}(?:说|回复|输出|发给|读)|\b(?:translate|rewrite|roleplay|role play|repeat after me|copy this)\b/iu.test(value);
}
function learningSource(entry) {
  if (entry.learning?.version !== 1 || !validCounter(entry.learning.sequence) || entry.learning.sequence < 1) return null;
  const exchange = entry.source === 'qq' && entry.exchange?.version === 1 ? entry.exchange : null;
  const outbound = entry.source === 'qq-life-contact' && entry.outbound?.version === 1 ? entry.outbound : null;
  const content = exchange || outbound;
  if (!content || !Array.isArray(content.sentMessageIds) || !content.sentMessageIds.length
    || typeof content.replyText !== 'string' || !content.replyText.trim()
    || exchange && /^\s*\//u.test(exchange.userText || '')) return null;
  const source = { id: entry.id, at: entry.at, sequence: entry.learning.sequence,
    kind: exchange ? 'exchange' : 'outbound',
    userText: exchange ? attributableUserText(exchange.userText) : '', replyText: content.replyText,
    selfExpressionEligible: !exchange || selfExpressionEligible(exchange.userText),
    feedback: Boolean(exchange && directLearningFeedback(exchange.userText)) };
  if (!source.userText && !source.selfExpressionEligible) return null;
  return { ...source, fingerprint: fingerprint([entry.scope, source, content.sentMessageIds]) };
}
function retainMemoryEntries(entries) {
  // The historical 5000 bound applies to ordinary memory, not the latest
  // participant state. Otherwise an inactive person's withdrawal can disappear.
  const runtime = new Map();
  for (const entry of entries) if (hiddenSources.has(entry.source)) {
    runtime.set(JSON.stringify([entry.scope, entry.source, entry.topic]), entry);
  }
  const retained = new Set([...runtime.values(), ...entries.filter(entry => !hiddenSources.has(entry.source)).slice(-5000)]);
  // Preserve a supersession fence while its target is retained, including an
  // expired replacement; expiry must not resurrect the replaced statement.
  let changed = true;
  while (changed) {
    changed = false;
    const ids = new Set([...retained].map(entry => `${entry.scope}\0${entry.id}`));
    for (const entry of entries) if (!retained.has(entry) && Array.isArray(entry.supersedes)
      && entry.supersedes.some(id => ids.has(`${entry.scope}\0${id}`))) {
      retained.add(entry); changed = true;
    }
  }
  return entries.filter(entry => retained.has(entry));
}
function learningInvalidations(before, after) {
  const events = new Map();
  if (before.learning?.epoch !== after.learning?.epoch) events.set('all', { scope: 'all', reason: 'reset' });
  else for (const [scope, old] of Object.entries(before.learning?.scopes || {})) {
    const next = after.learning?.scopes?.[scope];
    if (!next || old?.epoch !== next.epoch || old?.revision !== next.revision) {
      events.set(scope, { scope, reason: old?.epoch !== next?.epoch ? 'reset' : 'correction' });
    }
  }
  const remaining = new Set(after.entries.map(entry => entry.id));
  for (const entry of before.entries) if (entry.learning && !remaining.has(entry.id)) {
    if (!events.has(entry.scope)) events.set(entry.scope, { scope: entry.scope, reason: 'source-loss', sourceIds: [] });
    const event = events.get(entry.scope);
    if (event.reason === 'source-loss' && !event.sourceIds.includes(entry.id)) event.sourceIds.push(entry.id);
  }
  return [...events.values()];
}
function boundedInteger(value, fallback, max) {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Math.floor(Number(value)))) : fallback;
}

export function createUnifiedMemory({ memoryPath, now = Date.now, personaPolicy = null }) {
  let queue = Promise.resolve();
  const initializedPath = memoryPath + '.initialized';
  let observedMemory = false;
  const learningListeners = new Set();
  async function initializationMarker() {
    let info;
    try { info = await lstat(initializedPath); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw Error('Invalid unified memory initialization marker');
    const marker = JSON.parse(await readFile(initializedPath, 'utf8'));
    if (!marker || marker.version !== 1 || marker.kind !== 'unified-memory-initialized') {
      throw Error('Invalid unified memory initialization marker');
    }
    return true;
  }
  async function recordInitialization() {
    // Independent of learning epochs: clear replaces content, never this fence.
    await atomicWriteFile(initializedPath, JSON.stringify({ version: 1, kind: 'unified-memory-initialized' }) + '\n');
  }
  async function resetHistoryExists() {
    try { await lstat(join(dirname(memoryPath), V201_MEMORY_RESET_MARKER)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function load() {
    const initialized = await initializationMarker();
    let raw;
    try {
      raw = await readFile(memoryPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A completed legacy reset also proves this is not a new installation,
      // even if the file disappeared before the new reader's first startup.
      if (initialized || observedMemory || await resetHistoryExists()) {
        throw Object.assign(Error('Initialized unified memory store is missing; original history must be recovered before continuing'),
          { code: 'MEMORY_STORE_MISSING' });
      }
      return { version: 1, entries: [] };
    }
    observedMemory = true;
    const data = JSON.parse(raw);
    if (data.version == null && Array.isArray(data.entries) && data.entries.length === 0) data.version = 1;
    if (data.version !== 1 || !Array.isArray(data.entries)) throw Error('Unsupported unified memory format; original file preserved');
    // Bootstrap under the data lock, without rewriting even legacy empty data.
    if (!initialized) await recordInitialization();
    return data;
  }
  function locked(fn, { write = false } = {}) {
    const task = queue.then(async () => {
      await mkdir(dirname(memoryPath), { recursive: true });
      const release = await acquireFileLock(memoryPath + '.lock', { label: 'unified memory' });
      try {
      const data = await load();
      const before = write ? { learning: structuredClone(data.learning), entries: [...data.entries] } : null;
      const unchanged = write === 'changed' ? JSON.stringify(data) : null;
      const result = await fn(data);
      let events = [];
      if (write && (write !== 'changed' || JSON.stringify(data) !== unchanged)) {
        data.entries = retainMemoryEntries(data.entries);
        events = learningInvalidations(before, data);
        data.updatedAt = new Date(now()).toISOString();
        const temp = `${memoryPath}.${process.pid}.${randomUUID()}.tmp`;
        let handle;
        try {
          handle = await open(temp, 'wx', 0o600);
          await handle.writeFile(JSON.stringify(data, null, 2)); await handle.sync(); await handle.close(); handle = null;
          await rename(temp, memoryPath);
          observedMemory = true;
          if (process.platform !== 'win32') {
            const directory = await open(dirname(memoryPath), 'r'); try { await directory.sync(); } finally { await directory.close(); }
          }
        } finally { await handle?.close().catch(() => {}); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        // A first write is not acknowledged until both files are durable. A
        // crash between them leaves valid data that can bootstrap on restart.
        if (!await initializationMarker()) await recordInitialization();
      }
      return { result, events };
      } finally { await release(); }
    });
    // The queue contains only the source transaction. Notifications run after
    // unlock and may safely re-read sources or acquire a sidecar lock.
    queue = task.then(() => {}, () => {});
    return task.then(async ({ result, events }) => {
      for (const event of events) await Promise.allSettled([...learningListeners].map(listener => Promise.resolve().then(() => listener(event))));
      return result;
    });
  }
  const mutate = fn => locked(fn, { write: true });
  async function epochBoundary(scope, callback) {
    await mkdir(dirname(memoryPath), { recursive: true });
    const global = await acquireAdvisoryLock(memoryPath + '.epoch-barrier', {
      shared: scope !== 'all', timeoutMs: 60000, label: 'memory clear barrier' });
    let local;
    try {
      if (scope !== 'all') local = await acquireAdvisoryLock(memoryPath + '.epoch-' + fingerprint(scope), {
        timeoutMs: 60000, label: 'private memory clear barrier' });
      return await callback();
    } finally { try { await local?.(); } finally { await global(); } }
  }
  function epochCurrent(data, token, scope = token?.scope) {
    return Boolean(token && isProfileScope(scope) && token.scope === scope && typeof token.epoch === 'string'
      && data.learning?.scopes?.[scope]
      && token.epoch === `${data.learning.epoch}:${data.learning.scopes[scope].epoch}`);
  }
  async function ensureLearningScope(scope) {
    if (!isProfileScope(scope)) throw Error('Learning requires a valid private scope');
    await locked(data => learningScope(data, scope), { write: 'changed' });
  }
  function validateLearningSources(data, { scope, epoch, revision, sequence, sourceRefs = [] }) {
    const current = learningScope(data, scope);
    const base = { scope, epoch: current.epoch, revision: current.revision,
      cursor: { epoch: current.epoch, sequence: current.sequence } };
    if (!Array.isArray(sourceRefs) || sourceRefs.length > 800 || sourceRefs.some(ref => !ref
      || typeof ref.id !== 'string' || !ref.id || ref.id.length > 160
      || typeof ref.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(ref.fingerprint))
      || new Set(sourceRefs.map(ref => ref.id)).size !== sourceRefs.length) {
      return { ...base, ok: false, reason: 'Invalid source references', sources: [], invalidIds: [] };
    }
    if (epoch !== current.epoch || revision !== current.revision
      || sequence != null && sequence !== current.sequence) {
      return { ...base, ok: false, reason: epoch !== current.epoch ? 'Source epoch changed'
        : revision !== current.revision ? 'Source correction changed' : 'New source arrived',
      sources: [], invalidIds: sourceRefs.map(ref => ref.id) };
    }
    if (!sourceRefs.length) return { ...base, ok: true, sources: [], invalidIds: [] };
    const wanted = new Set(sourceRefs.map(ref => ref.id));
    const active = new Map(activeMemories(data.entries, scope, now(), hiddenSources)
      .filter(entry => wanted.has(entry.id)).map(learningSource).filter(Boolean).map(source => [source.id, source]));
    const sources = [], invalidIds = [];
    for (const ref of sourceRefs) {
      const source = active.get(ref.id);
      if (!source || ref.fingerprint !== source.fingerprint) invalidIds.push(ref.id);
      else sources.push(source);
    }
    return { ...base, ok: invalidIds.length === 0, ...(invalidIds.length ? { reason: 'Source unavailable or changed' } : {}), sources, invalidIds };
  }
  const api = {
    // Hub awaits this before starting writers. Fresh read-only installations
    // remain uninitialized; existing stores acquire the durable missing fence.
    async ensureInitialized() {
      return locked(() => ({ initialized: observedMemory }));
    },
    async captureEpoch({ scope } = {}) {
      return locked(data => ({ scope, epoch: learningScope(data, scope).epoch }), { write: 'changed' });
    },
    async isEpochCurrent(token) {
      return locked(data => epochCurrent(data, token));
    },
    async withEpoch(token, callback) {
      if (typeof callback !== 'function') throw TypeError('A delivery callback is required');
      if (!isProfileScope(token?.scope)) return { ok: false, reason: 'memory-epoch-changed' };
      return epochBoundary(token.scope, async () => await locked(data => epochCurrent(data, token)) ? callback()
        : { ok: false, reason: 'memory-epoch-changed' });
    },
    subscribeLearningInvalidation(listener) {
      if (typeof listener !== 'function') throw TypeError('A learning invalidation listener is required');
      learningListeners.add(listener);
      return () => learningListeners.delete(listener);
    },
    async readLearningSnapshot({ scope, after = null, limit = 60, maxChars = 24000 } = {}) {
      await ensureLearningScope(scope);
      return locked(data => {
        const current = learningScope(data, scope);
        const cursor = { epoch: current.epoch, sequence: current.sequence };
        const base = { scope, epoch: current.epoch, revision: current.revision, cursor,
          fromCursor: after, eligibleCount: 0, gapCount: 0, skippedCount: 0, sampledIds: [], sources: [] };
        // A null cursor means enable now, not replay all retained history.
        if (after == null) return base;
        if (!after || after.epoch !== current.epoch || !validCounter(after.sequence) || after.sequence > current.sequence) {
          return { ...base, reset: true };
        }
        const available = activeMemories(data.entries, scope, now(), hiddenSources)
          .map(learningSource).filter(source => source && source.sequence > after.sequence)
          .sort((a, b) => a.sequence - b.sequence);
        const chosen = new Set(), prioritized = [];
        const add = source => { if (source && !chosen.has(source.id)) { chosen.add(source.id); prioritized.push(source); } };
        for (const source of available.filter(source => source.feedback).reverse()) add(source);
        add(available.at(-1)); add(available[0]);
        // Breadth-first interval midpoints represent the full scan, while the
        // priority pass preserves complete recent corrections within the budget.
        const intervals = [[0, available.length - 1]];
        for (let i = 0; i < intervals.length; i++) {
          const [left, right] = intervals[i];
          if (left > right) continue;
          const middle = Math.floor((left + right) / 2);
          add(available[middle]);
          if (left < middle) intervals.push([left, middle - 1]);
          if (middle < right) intervals.push([middle + 1, right]);
        }
        const count = boundedInteger(limit, 60, 60), budget = boundedInteger(maxChars, 24000, 48000);
        const sources = []; let characters = 0;
        for (const source of prioritized) {
          const size = JSON.stringify(source).length;
          if (sources.length >= count) break;
          if (characters + size > budget) continue;
          sources.push(source); characters += size;
        }
        sources.sort((a, b) => a.sequence - b.sequence);
        const snapshot = { ...base, eligibleCount: available.length,
          gapCount: Math.max(0, current.sequence - after.sequence - available.length),
          skippedCount: available.length - sources.length,
          sampledIds: sources.map(source => source.id), sources, sampledChars: characters };
        return personaPolicy ? personaPolicy.learningSnapshot(snapshot) : snapshot;
      });
    },
    async readLearningSources(options = {}) {
      await ensureLearningScope(options.scope);
      return locked(data => validateLearningSources(data, options));
    },
    async withLearningSources(options = {}, commit) {
      if (typeof commit !== 'function') throw TypeError('A bounded learning commit callback is required');
      await ensureLearningScope(options.scope);
      return locked(async data => {
        const checked = validateLearningSources(data, options);
        if (!checked.ok) return checked;
        // The model ran before this call. Only source-validated bounded sidecar
        // I/O belongs here, under the same lock as clear and dialogue writes.
        return { ...checked, value: await commit(checked) };
      });
    },
    async readLatestState({ scope, source, topic }) {
      if (!scope || !mutableRuntimeSources.has(source) || !topic) return null;
      return locked(data => latestState(data, { scope, source, topic }));
    },
    async compareAndSetState({ scope, source, topic, expectedId = null, summary, epochToken, deliveryId }) {
      if (!scope || !mutableRuntimeSources.has(source) || !topic || String(topic).length > 120
        || typeof summary !== 'string' || !summary.trim() || summary.length > 2000) {
        return { ok: false, reason: 'Invalid runtime state' };
      }
      return mutate(data => {
        if (epochToken != null && !epochCurrent(data, epochToken, scope)) return { ok: false, reason: 'memory-epoch-changed' };
        const receipt = deliveryReceipt(data, scope, deliveryId, ['state', source, topic, expectedId, summary]);
        if (receipt?.old) return { ok: true, duplicate: true, entry: { id: receipt.old.entryId } };
        const current = latestState(data, { scope, source, topic });
        if ((current?.id || null) !== expectedId) return { ok: false, reason: 'Stale runtime state' };
        const entry = { id: randomUUID(), type: 'dailyState', scope, source, topic, summary,
          nextActions: [], at: new Date(now()).toISOString() };
        // One current state per participant, in the existing memory store.
        data.entries = data.entries.filter(e => !(e.type === 'dailyState' && e.scope === scope
          && e.source === source && e.topic === topic));
        data.entries.push(entry);
        if (receipt) data.deliveryCommits[receipt.key] = { digest: receipt.digest, entryId: entry.id };
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
        if (entry.supersedes?.length) optionalLearningMutation(data, () => incrementLearningRevision(data, scope));
        data.entries.push(entry);
        return { ok: true, entry };
      });
    },
    async writeExchange({ scope, senderLabel, userText, replyText, messageId, replyMessageId, quotedText, sentMessageIds = [], learningEligible = false, epochToken, deliveryId, channel = 'qq' } = {}) {
      if (!privateScope(scope)) return { ok: false, reason: 'A valid private conversation scope is required' };
      if (!String(replyText || '').trim()) return { ok: false, reason: 'Empty reply' };
      if (!Array.isArray(sentMessageIds) || sentMessageIds.length > 8
        || sentMessageIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 120)) {
        return { ok: false, reason: 'Invalid delivered message ids' };
      }
      const user = boundedText(userText, 8000), reply = boundedText(replyText, 8000), quote = boundedText(quotedText, 2000);
      if (!reply.text.trim()) return { ok: false, reason: 'No complete reply within retention limit' };
      return mutate(data => {
        if (epochToken != null && !epochCurrent(data, epochToken, scope)) return { ok: false, reason: 'memory-epoch-changed' };
        const receipt = deliveryReceipt(data, scope, deliveryId, ['exchange', user.text, reply.text, quote.text, messageId, replyMessageId, sentMessageIds, channel]);
        if (receipt?.old) return { ok: true, duplicate: true, entry: data.entries.find(e => e.id === receipt.old.entryId) || { id: receipt.old.entryId } };
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
          exchange, channel, ...(deliveryId ? { deliveryId } : {}), nextActions: [], at: new Date(now()).toISOString() };
        let corrected = directLearningFeedback(user.text);
        if (isProfileScope(scope)) {
          const prior = latestState(data, { scope, source: PRIVATE_PROFILE_SOURCE, topic: PRIVATE_PROFILE_TOPIC });
          if (prior && !prior.profile) throw Error('Missing private profile state; original memory preserved');
          const profile = updatePrivateProfile(prior?.profile, { scope, userText: user.text,
            messageId: exchange.messageId, exchangeId: entry.id, at: entry.at });
          const facts = value => (value?.facts || []).map(({ kind, key, value: content, polarity }) => ({ kind, key, value: content, polarity }));
          corrected ||= fingerprint([facts(prior?.profile), prior?.profile?.hasWithdrawals || false])
            !== fingerprint([facts(profile), profile.hasWithdrawals]);
          data.entries = data.entries.filter(e => !(e.scope === scope && e.source === PRIVATE_PROFILE_SOURCE && e.topic === PRIVATE_PROFILE_TOPIC));
          data.entries.push({ id: randomUUID(), type: 'dailyState', scope, source: PRIVATE_PROFILE_SOURCE,
            topic: PRIVATE_PROFILE_TOPIC, summary: 'Private profile runtime state', profile, nextActions: [], at: entry.at });
        }
        optionalLearningMutation(data, () => {
          if (corrected) incrementLearningRevision(data, scope);
          markLearningDelivery(data, entry, learningEligible === true && exchange.sentMessageIds.length > 0
            && !/^\s*\//u.test(user.text)
            && (Boolean(attributableUserText(user.text).trim()) || selfExpressionEligible(user.text)));
        });
        data.entries.push(entry);
        if (receipt) data.deliveryCommits[receipt.key] = { digest: receipt.digest, entryId: entry.id };
        return { ok: true, entry };
      });
    },
    async writeOutbound({ scope, replyText, intentId, sentMessageIds = [], learningEligible = false, epochToken, deliveryId, channel = 'qq' } = {}) {
      if (!privateScope(scope) || typeof replyText !== 'string' || !replyText.trim() || replyText.length > 900
        || typeof intentId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(intentId)
        || !Array.isArray(sentMessageIds) || sentMessageIds.length > 8
        || sentMessageIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 120)) throw Error('Invalid outbound private memory');
      const outbound = { version: 1, intentId, replyText, sentMessageIds: [...new Set(sentMessageIds)] };
      return mutate(data => {
        if (epochToken != null && !epochCurrent(data, epochToken, scope)) return { ok: false, reason: 'memory-epoch-changed' };
        const receipt = deliveryReceipt(data, scope, deliveryId, ['outbound', outbound, channel]);
        if (receipt?.old) return { ok: true, duplicate: true, entry: data.entries.find(e => e.id === receipt.old.entryId) || { id: receipt.old.entryId } };
        const old = data.entries.find(entry => entry.scope === scope && entry.source === 'qq-life-contact' && entry.outbound?.intentId === intentId);
        if (old) {
          if (JSON.stringify(old.outbound) !== JSON.stringify(outbound)) throw Error('Outbound private memory conflicts with an existing intent');
          return { ok: true, entry: old, duplicate: true };
        }
        const entry = { id: randomUUID(), type: 'dailyState', scope, source: 'qq-life-contact',
          topic: '主动私聊', summary: `知微主动发出的私聊：${replyText}`, outbound, channel, ...(deliveryId ? { deliveryId } : {}), nextActions: [], at: new Date(now()).toISOString() };
        optionalLearningMutation(data, () => markLearningDelivery(data, entry, learningEligible === true && outbound.sentMessageIds.length > 0));
        data.entries.push(entry);
        if (receipt) data.deliveryCommits[receipt.key] = { digest: receipt.digest, entryId: entry.id };
        return { ok: true, entry };
      });
    },
    async readPrivateProfile({ scope } = {}) {
      if (!isProfileScope(scope)) return null;
      return locked(data => {
        const entry = latestState(data, { scope, source: PRIVATE_PROFILE_SOURCE, topic: PRIVATE_PROFILE_TOPIC });
        return entry ? structuredClone(validatePrivateProfile(entry.profile, scope)) : null;
      });
    },
    async formatPrivateProfile({ scope } = {}) {
      return formatPrivateProfile(await api.readPrivateProfile({ scope }), scope);
    },
    async hasDeliveredMessage({ scope, messageId } = {}) {
      if (!privateScope(scope) || typeof messageId !== 'string' || !messageId.trim() || messageId.length > 120) return false;
      return locked(data => data.entries.some(entry => entry.scope === scope && (
        entry.source === 'qq' && entry.exchange?.version === 1
          && Array.isArray(entry.exchange.sentMessageIds) && entry.exchange.sentMessageIds.includes(messageId)
        || entry.source === 'qq-life-contact' && entry.outbound?.version === 1
          && Array.isArray(entry.outbound.sentMessageIds) && entry.outbound.sentMessageIds.includes(messageId))));
    },
    async readPwaHistory({ scope } = {}) {
      if (!/^qq:private:\d{1,128}$/.test(scope || '')) throw Object.assign(Error('Invalid retained history request'), { status: 400 });
      return locked(data => ({ records: activeMemories(data.entries, scope, now(), hiddenSources)
        .filter(entry => entry.channel !== 'pwa' && (entry.source === 'qq' && entry.exchange?.version === 1
          && entry.exchange.sentMessageIds?.length || entry.source === 'qq-life-contact' && entry.outbound?.version === 1
          && entry.outbound.sentMessageIds?.length))
        .map(entry => ({ id: entry.id, at: entry.at, source: 'qq', userText: entry.exchange?.userText || '',
          replyText: entry.exchange?.replyText || entry.outbound?.replyText || '', quotedText: entry.exchange?.quotedText || '',
          truncated: Boolean(entry.exchange?.truncated || entry.outbound?.truncated),
          originalLengths: entry.exchange?.originalLengths ? { ...entry.exchange.originalLengths } : null })) }));
    },
    async readLegacyHistory({ scope, before = null, limit = 30 } = {}) {
      if (!/^qq:private:\d{1,128}$/.test(scope || '') || !Number.isInteger(limit) || limit < 1 || limit > 100
        || before !== null && (typeof before !== 'string' || before.length > 160)) throw Object.assign(Error('Invalid legacy history request'), { status: 400 });
      return locked(data => {
        // Read only the retained original fields, never summaries, derived
        // profiles, cleared sources or new PWA mailbox copies.
        const records = activeMemories(data.entries, scope, now(), hiddenSources)
          .filter(entry => entry.channel !== 'pwa' && (entry.source === 'qq' && entry.exchange?.version === 1
            && entry.exchange.sentMessageIds?.length || entry.source === 'qq-life-contact' && entry.outbound?.version === 1
            && entry.outbound.sentMessageIds?.length))
          .map(entry => ({ id: entry.id, at: entry.at, source: 'qq', userText: entry.exchange?.userText || '',
            replyText: entry.exchange?.replyText || entry.outbound?.replyText || '', quotedText: entry.exchange?.quotedText || '',
            truncated: Boolean(entry.exchange?.truncated) }))
          .sort((a,b) => String(b.at).localeCompare(String(a.at)) || b.id.localeCompare(a.id));
        const cursor = before === null ? -1 : records.findIndex(entry => entry.id === before);
        if (before !== null && cursor < 0) throw Object.assign(Error('History cursor unavailable'), { status: 404 });
        const selected = records.slice(cursor + 1, cursor + 1 + limit);
        return { records: selected.toReversed(), hasMore: cursor + 1 + limit < records.length,
          nextBefore: selected.at(-1)?.id || null };
      });
    },
    async read({ scope = 'owner', query = '', limit = 8 } = {}) {
      return locked(data => {
        const time = now();
        const entries = listMemories(activeMemories(data.entries, scope, time, hiddenSources), { query, limit, now: time });
        return { entries, latestHandoff: entries.find(e => e.type === 'handoff'), updatedAt: data.updatedAt };
      });
    },
    async recall({ scope = 'owner', ...options } = {}) {
      return locked(data => recallMemories(activeMemories(data.entries, scope, now(), hiddenSources)
        .map(entry => personaPolicy?.isLegacyMemory(entry) ? { ...entry, personaHistorical: true } : entry), { ...options, scope, now: now() }));
    },
    async status({ scope = 'owner' } = {}) {
      return locked(data => {
        const entries = data.entries.filter(e => e.scope === scope);
        const keys = { handoff: 'handoffHistory', idea: 'ideas', projectNote: 'projectNotes', preference: 'preferences', openLoop: 'openLoops', dailyState: 'dailyTimeline' };
        const counts = {}; for (const e of entries) counts[keys[e.type]] = (counts[keys[e.type]] || 0) + 1;
        return { ok: true, enabled: true, count: entries.length, counts, updatedAt: data.updatedAt,
          active: activeMemories(data.entries, scope, now(), hiddenSources).length };
      });
    },
    clear({ scope = 'owner' } = {}) { return epochBoundary(scope, () => mutate(data => {
      const before = data.entries.length; data.entries = scope === 'all' ? [] : data.entries.filter(e => e.scope !== scope);
      if (scope === 'all') data.learning = createEmptyUnifiedMemory().learning;
      else if (isProfileScope(scope)) {
        learningMetadata(data).scopes[scope] = { epoch: randomUUID(), sequence: 0, revision: 0 };
      }
      return { ok: true, removed: before - data.entries.length };
    })); },
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
