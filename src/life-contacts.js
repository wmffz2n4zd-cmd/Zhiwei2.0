import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const VERSION = 1, DAY = 86400000;
const DEFAULTS = Object.freeze({ maxContacts: 512, maxReceipts: 65536, maxIntents: 4096,
  maxBytes: 16 * 1024 * 1024, maxIntentLifetimeMs: DAY });
const states = new Set(['pending', 'generating', 'ready', 'sending', 'sent', 'failed', 'uncertain', 'cancelled']);
const cancellable = new Set(['pending', 'generating', 'ready']);
const clone = value => structuredClone(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const number = value => Number.isSafeInteger(value) && value >= 0;
const time = value => number(value) && value <= 8640000000000000;
const validScope = value => typeof value === 'string' && /^qq:private:[1-9]\d{0,127}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');

function requiredText(value, label, max, multiline = false) {
  const invalid = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== 'string' || !value.trim() || value.length > max || invalid.test(value)) throw TypeError(`Invalid ${label}`);
  return value.trim();
}

function scopeOf(event) {
  const scope = `qq:private:${String(event?.senderId ?? '')}`;
  if (event?.type !== 'private_message' || event.groupId != null || event.raw?.group_id != null || !validScope(scope)) {
    throw TypeError('Contact coordination requires a valid private participant');
  }
  return scope;
}

// Only the sender's own text participates. Reply context, captions, images and
// forwarded messages are not evidence that this participant asked us to stop.
function ownText(event) {
  if (Array.isArray(event?.raw?.message)) return event.raw.message
    .filter(part => part?.type === 'text').map(part => String(part.data?.text ?? '')).join('');
  return String(event?.text || '').replace(/\[CQ:[^\]]*\]/gi, '');
}

function directStop(clause) {
  let text = clause.trim().replace(/^[\s，,。.!！?？;；]+|[\s，,。.!！?？;；]+$/gu, '');
  if (!text) return false;
  if (/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:leave me alone|stop (?:messaging|contacting|bothering|teasing)(?: me)?|(?:do not|don't) (?:message|contact|bother|tease) me)(?:\s+(?:again|anymore))?(?:\s+please)?$/iu.test(text)) return true;
  // Restricted imperative questions are requests, unlike questions about the
  // meaning of a quoted sentence. Do not infer rejection from general mood.
  text = text.replace(/^(?:你)?(?:能不能|可不可以)\s*/u, '');
  text = text.replace(/^(?:(?:请|麻烦你|拜托你?|你|先|现在|以后|今后|从现在起)\s*){0,3}/u, '');
  return /^(?:别(?:再)?|不要(?:再)?|不许(?:再)?|停止)(?:烦我|打扰我|缠(?:着)?我|逗我|闹(?:我)?|理我|联系我|(?:跟|和)我说话|(?:来)?找我|主动(?:联系|来?找)我|(?:给|向)我(?:发消息|发信息|发私信|发短信)|发消息给我)(?:了|啦|吧|啊|呀)?(?:好吗|可以吗|行吗)?$/u.test(text)
    || /^让我(?:一个人)?(?:安静|静静|清静|待着?)(?:一会儿?|会儿?|一下)?(?:吧|好吗)?$/u.test(text)
    || /^我(?:现在)?不想(?:再)?(?:聊天|和你聊|跟你聊|聊)(?:了|天了)?$/u.test(text);
}

function currentReason(clause) {
  const text = clause.trim();
  // A request following a comma is accepted only with an unmistakably current
  // first-person reason or a short imperative/polite lead-in. Arbitrary text
  // before a comma is not a safe way to distinguish a quotation from a request.
  return /^(?:够了|行了|算了|拜托|拜托你|麻烦你|请|现在)$/u.test(text)
    || /^我(?:(?:现在|今天|目前|这会儿|此刻|真的|实在|有点|已经)\s*){0,2}(?:没(?:有)?(?:心情|时间|空)|不想(?:聊天|说话|聊)|很忙|正忙|忙着|在忙|要(?:休息|工作|睡觉)|很烦|烦了|累了|很累|想(?:静静|安静|休息|一个人))[^。！!？?]*$/u.test(text)
    || /^(?:I'm|I am)\s+(?:busy|tired|trying to work|trying to sleep|working|resting)\b[^.!?]*$/iu.test(text);
}

// This filters source provenance only. A remaining passage is still untrusted
// conversational data, not proof of the model's interpretation or permission.
export function ownContactEvidence(event) {
  try { scopeOf(event); } catch { return []; }
  const original = ownText(event);
  if (/^\s*\//u.test(original)) return [];
  // Strip complete quotation spans (including multi-line quotes), then inspect
  // independent own-text lines. The presence of a reply segment is no veto.
  const text = original.replace(/```[\s\S]*?```/g, '\ue000')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\r\n]*"/g, '\ue000')
    .replace(/(^|[\s([{：:])'[^'\r\n]*'(?=$|[\s)\]},.!?;:])/gm, '$1\ue000')
    .replace(/\[CQ:[^\]]*\]/gi, '');
  let reported = false, fenced = false; const statements = [];
  for (const raw of text.split(/\r?\n/u)) {
    const hadQuote = raw.includes('\ue000'), line = raw.replaceAll('\ue000', '').trim();
    if (/^```/u.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^>/u.test(line)) continue;
    if (!line) { reported = false; continue; }
    // An unclosed quotation/report may extend over following lines. Keep that
    // block unclassified until an explicit blank-line boundary.
    if (/[“「『"]/.test(line) || (!hadQuote && (
      /(?:说|讲|写|表示|提到|留言|回复|发来|告诉我)(?:过|了|道|的是|的那句|的那句话|的这句)?(?:[：:]\s*)?$/u.test(line)
      || /(?:这些话|这句话|台词|原文|原话|示例|例子|歌词|文本|内容|如下)[^。！!？?]*[：:]\s*$/u.test(line)
      || /(?:假设|假如|如果|例如|比如|举例|示例|例子|翻译|如下|以下文本|下面这句)\s*[：:]?\s*$/u.test(line)
      || /\b(?:said|says|say|wrote|replied|told|asked|quote|example|lyrics|text|following)(?:\s+(?:to me|is|was|this|that|these words|the following))?\s*:?$/iu.test(line)
      || /\b(?:suppose|assuming|hypothetical|translate|translation)\s*:?$/iu.test(line)
    ))) { reported = true; continue; }
    if (reported) continue;
    // Negated attribution and a historical self-quotation describe speech;
    // neither supplies a new current request on the next line. In particular,
    // "没心情聊天" is a current reason, whereas "没有要求你说" is attribution.
    if (/(?:不是|并非|没(?:有)?|从未|未曾|不曾|并未)(?:想|打算|要|故意)?(?:这么|那么|这样|那样)?(?:说|讲|表示|告诉|叫|让|要求|请求|希望|建议|命令|要你)(?!完|清楚|明白|够)/u.test(line)
      || /(?:前面|之前|以前|先前|刚才|昨天|那天|当时|曾经|过去)[^。！!？?]*(?:说|讲|写|告诉|表示|提到|要求|请求)/u.test(line)
      || /\b(?:did not|didn't|never|not)\s+(?:say|said|tell|told|ask|asked|mean)\b/iu.test(line)
      || /\b(?:earlier|before|yesterday|previously|last time)\b[^.!?]*\b(?:said|say|told|asked|wrote)\b/iu.test(line)
      || /\b(?:said|say|told|asked|wrote)\b[^.!?]*\b(?:earlier|before|yesterday|previously|last time)\b/iu.test(line)) { reported = true; continue; }
    if (/(?:翻译|润色|改写|续写|仿写|扮演|示例|例子|歌词|台词|如下|以下文本|下面这句|帮我写|角色设定|原话|转发|引用|例如|比如|假如|假设|如果|意思|含义|这句话|这句|不是让你|不是说|并不是|并非|不要说|别说|不许说)/u.test(line)
      || /\b(?:if|suppose|hypothetical|translate|translation|meaning|example|lyrics|roleplay)\b/iu.test(line)
      || /(?:说|写|表示|提到|留言|回复|发来|告诉我)[：:]/u.test(line)
      || /\b(?:said|says|say|wrote|writes|told|asked|replied)\b[^.!?]*[,:]/iu.test(line)) continue;
    // Examine complete clauses, not substrings such as "不要不理我" or
    // "别烦我是什么意思". Other-person reports never become own requests.
    if (/(?:他|她|别人|对方|朋友|同事|妈妈|爸爸).{0,12}(?:说|让|要|叫)/u.test(line)) continue;
    statements.push(line);
  }
  return statements;
}

export function isExplicitContactStop(event) {
  return ownContactEvidence(event).some(line => {
    const clauses = line.split(/[，,。.!！;；]/u).map(part => part.trim()).filter(Boolean);
    return clauses.some((clause, index) => directStop(clause) && clauses.slice(0, index).every(currentReason));
  });
}

function directInvitation(clause) {
  let text = clause.trim().replace(/^[\s，,。.!！;；]+|[\s，,。.!！;；]+$/gu, '');
  if (/^(?:you (?:can|may) |feel free to |please |I (?:want|would like) you to )(?:message|contact|tease|keep teasing)(?: me)(?: (?:again|anytime|whenever you want|whenever you like))?$/iu.test(text)) return true;
  text = text.replace(/^(?:你)?(?:(?:以后|今后|现在|从现在起|随时|有空时?)\s*)?(?:你)?/u, '');
  // Only direct permission or invitation patterns reopen proactive contact.
  // Availability, greetings, silence and a merely positive mood do not.
  return /^(?:(?:还|也)?可以(?:再|继续)?|请(?:再|继续)?|欢迎(?:再|继续)?|再|继续)(?:主动)?(?:来)?(?:找我(?:聊(?:聊|天)?|玩)?|联系我|给我发(?:消息|信息)|逗我|缠着我)(?:了|吧|呀|啊|哦)?$/u.test(text)
    || /^(?:主动)?来找我(?:聊(?:聊|天)?|玩)(?:吧|呀|啊|哦)?$/u.test(text)
    || /^想聊天就(?:主动)?来找我(?:吧|呀|啊|哦)?$/u.test(text);
}

export function isExplicitContactInvitation(event, evidence) {
  if (evidence != null && (typeof evidence !== 'string' || !evidence.trim() || !ownText(event).includes(evidence))) return false;
  const statements = ownContactEvidence(event);
  const unquoted = ownText(event).replace(/```[\s\S]*?```/g, '')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\r\n]*"/g, '')
    .replace(/(^|[\s([{：:])'[^'\r\n]*'(?=$|[\s)\]},.!?;:])/gm, '$1')
    .replace(/^\s*>.*$/gm, '');
  // A model excerpt cannot hide a withdrawal or a still-pending condition in
  // another line of this same message. The check intentionally prefers false
  // negatives to reopening contact under ambiguous permission.
  if (/[?？]|收回|撤回|作废|算了|还是别|不要|别再|先别|别联系|别找我|别发|不是现在|现在不行|等我|等到|同意之后|同意以后|以后再说|先不要|暂时不|但是|不过|可是|才怪|骗你的|开玩笑|别误会|别当真|只是举例/u.test(unquoted)
    || /\b(?:do not|don't|not now|not yet|never mind|nevermind|withdraw|retract|take (?:that|it) back|only if|only after|until|but|however|just kidding|only joking|not really)\b/iu.test(unquoted)
    || isExplicitContactStop(event)) return false;
  if (statements.some(line => /才怪|骗你的|开玩笑|别误会|别当真|只是举例|\b(?:just kidding|only joking|not really)\b/iu.test(line))) return false;
  const finalStatement = unquoted.trim().split(/\r?\n/u).at(-1)?.trim();
  // Require the actual own-text statement to be an invitation as well as the
  // model's excerpt. It cannot cherry-pick an affirmative clause from a longer
  // denial or question. It must also be the final unquoted line: this catches
  // later qualifications without trying to enumerate every way to withdraw
  // permission. Conservative misses leave the pause in place.
  return statements.some(line => line === finalStatement && directInvitation(line.replace(/^(?:好|好的|行|没事|没关系)[，,]\s*/u, ''))
    && (evidence == null || (line.includes(evidence) && directInvitation(evidence))));
}

function normalizedDecision(decision, event) {
  if (!plain(decision) || Object.keys(decision).some(key => !['action', 'basis', 'evidence', 'reason'].includes(key))
    || !['pause', 'resume'].includes(decision.action)
    || decision.basis !== (decision.action === 'pause' ? 'contextual-impatience' : 'explicit-invitation')) {
    throw TypeError('Invalid contact boundary decision');
  }
  const evidence = requiredText(decision.evidence, 'contact decision evidence', 220);
  const reason = requiredText(decision.reason, 'contact decision reason', 500);
  // The receipt authenticates the entire original message below. An excerpt
  // must also occur in one surviving own-text statement, never only in quoted,
  // forwarded, hypothetical or attributed content.
  if (!ownText(event).includes(evidence) || !ownContactEvidence(event).some(line => line.includes(evidence))) {
    throw TypeError('Contact decision needs the participant own unquoted evidence');
  }
  if (decision.action === 'resume' && !isExplicitContactInvitation(event, evidence)) {
    throw TypeError('Contact resume requires an explicit new invitation');
  }
  return { action: decision.action, basis: decision.basis, evidenceHash: digest(evidence), reason };
}

function sourceList(sources, scope) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 4) throw TypeError('Contact intent requires bounded source references');
  return sources.map(source => {
    if (!plain(source) || Object.keys(source).some(key => !['kind', 'ref', 'scope'].includes(key))) throw TypeError('Invalid contact source');
    const kind = requiredText(source.kind, 'contact source kind', 80);
    if (!/^[a-zA-Z0-9_.:-]+$/.test(kind)) throw TypeError('Invalid contact source kind');
    const ref = requiredText(source.ref, 'contact source reference', 1000);
    if (source.scope != null && source.scope !== scope) throw TypeError('Contact source belongs to another private participant');
    return { kind, ref, ...(source.scope != null ? { scope } : {}) };
  });
}

function selectedSources(refs, sources) {
  const allowed = new Set(sources.map(source => source.ref));
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 4
    || refs.some(ref => typeof ref !== 'string' || !allowed.has(ref))) throw TypeError('Invalid selected contact source references');
  return [...new Set(refs)];
}

async function regular(path, missing = false, maxBytes = Infinity) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Contact state must be a regular file');
    if (info.size > maxBytes) throw Error('Contact state exceeds its size limit');
    return info;
  } catch (error) { if (error.code === 'ENOENT' && missing) return null; throw error; }
}

async function readJson(path, maxBytes) {
  await regular(path, false, maxBytes);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw Error('Invalid contact state file');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

async function atomicWrite(path, value, { missing = false, maxBytes = Infinity } = {}) {
  const body = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(body) > maxBytes) throw Error('Contact state exceeds its size limit');
  await regular(path, missing, maxBytes);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(body, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function validate(state, policy) {
  if (!plain(state) || state.version !== VERSION || !uuid(state.storeId) || !Array.isArray(state.contacts)
    || !Array.isArray(state.intents) || state.contacts.length > policy.maxContacts || state.intents.length > policy.maxIntents) throw Error('Invalid contact state; original file preserved');
  const scopes = new Set(); let receipts = 0;
  for (const contact of state.contacts) {
    if (!plain(contact) || !validScope(contact.scope) || scopes.has(contact.scope) || !number(contact.epoch)
      || !number(contact.sequence) || contact.sequence < 1 || typeof contact.paused !== 'boolean'
      || !time(contact.lastIncomingAt) || !Array.isArray(contact.receipts)) throw Error('Invalid contact participant');
    scopes.add(contact.scope);
    const keys = new Set(); let expectedEpoch = 0, expectedPaused = false;
    for (const receipt of contact.receipts) {
      if (!plain(receipt) || typeof receipt.key !== 'string' || !receipt.key || receipt.key.length > 240 || keys.has(receipt.key)
        || !number(receipt.epoch) || receipt.epoch > contact.epoch || !number(receipt.sequence) || receipt.sequence < 1
        || receipt.sequence !== keys.size + 1 || typeof receipt.stop !== 'boolean'
        || !time(receipt.at) || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)) throw Error('Invalid contact receipt');
      keys.add(receipt.key);
      if (receipt.stop) { expectedEpoch++; expectedPaused = true; }
      if (receipt.epoch !== expectedEpoch) throw Error('Inconsistent contact history');
      if (receipt.decision != null) {
        const decision = receipt.decision;
        if (receipt.stop || !plain(decision)
          || Object.keys(decision).some(key => !['action', 'basis', 'evidenceHash', 'reason', 'at'].includes(key))
          || !['pause', 'resume'].includes(decision.action)
          || decision.basis !== (decision.action === 'pause' ? 'contextual-impatience' : 'explicit-invitation')
          || !/^[a-f0-9]{64}$/.test(decision.evidenceHash) || !time(decision.at)) throw Error('Invalid contact boundary history');
        requiredText(decision.reason, 'contact decision reason', 500);
        if (decision.action === 'pause') { expectedEpoch++; expectedPaused = true; }
        else { if (!expectedPaused) throw Error('Inconsistent contact resume history'); expectedPaused = false; }
      }
    }
    if (contact.receipts.length !== contact.sequence || expectedEpoch !== contact.epoch || contact.paused !== expectedPaused) throw Error('Inconsistent contact history');
    receipts += contact.receipts.length;
  }
  if (receipts > policy.maxReceipts) throw Error('Contact receipt capacity exceeded');
  const ids = new Set();
  for (const intent of state.intents) {
    if (!plain(intent) || typeof intent.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(intent.id) || ids.has(intent.id)
      || !scopes.has(intent.scope) || !number(intent.epoch) || intent.epoch > state.contacts.find(c => c.scope === intent.scope).epoch
      || (intent.sequence != null && (!number(intent.sequence) || intent.sequence < 1 || intent.sequence > state.contacts.find(c => c.scope === intent.scope).sequence))
      || !states.has(intent.status) || !time(intent.createdAt) || !time(intent.notBefore) || !time(intent.expiresAt)
      || intent.expiresAt <= intent.notBefore || intent.expiresAt <= intent.createdAt
      || intent.expiresAt - intent.createdAt > policy.maxIntentLifetimeMs) throw Error('Invalid contact intent');
    ids.add(intent.id);
    requiredText(intent.reason, 'contact intent reason', 500);
    if (JSON.stringify(sourceList(intent.sources, intent.scope)) !== JSON.stringify(intent.sources)) throw Error('Invalid contact intent source');
    if (Object.hasOwn(intent, 'selectedSourceRefs') && (['pending', 'generating'].includes(intent.status)
      || JSON.stringify(selectedSources(intent.selectedSourceRefs, intent.sources)) !== JSON.stringify(intent.selectedSourceRefs))) {
      throw Error('Invalid selected contact source history');
    }
    if (['generating', 'ready', 'sending', 'sent', 'failed', 'uncertain'].includes(intent.status) && !uuid(intent.claimId)) throw Error('Missing contact claim');
    if (['ready', 'sending'].includes(intent.status)) requiredText(intent.replyText, 'contact reply', 900, true);
    if (intent.claimId != null && !uuid(intent.claimId)) throw Error('Invalid contact claim');
    if (intent.doneAt != null && !time(intent.doneAt)) throw Error('Invalid contact completion time');
  }
  return state;
}

/**
 * Same-object stop epochs and at-most-one-attempt proactive claims. The caller
 * holds life-timeline's writer lock for this directory. No timer, model, memory
 * lookup, recipient selection or transport is owned here. Never expose a token
 * supplied by an HTTP callback as a trusted receipt from observeIncoming.
 */
export async function createLifeContacts({ directory, timeline, now = Date.now, policy: supplied = {} } = {}) {
  if (!directory || !timeline?.snapshot || !timeline?.availability) throw Error('Contact coordination needs its owning life timeline');
  const policy = { ...DEFAULTS };
  for (const key of Object.keys(supplied)) {
    if (!(key in policy) || !Number.isSafeInteger(supplied[key]) || supplied[key] < 1 || supplied[key] > policy[key]) throw TypeError('Invalid contact policy');
    policy[key] = supplied[key];
  }
  const root = resolve(directory); await mkdir(root, { recursive: true });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('Contact directory must be a real directory');
  const file = join(root, 'contacts.json'), marker = join(root, '.contacts-initialized');
  const info = await regular(file, true, policy.maxBytes), markerInfo = await regular(marker, true, 1024);
  let state;
  if (!info && !markerInfo) {
    state = { version: VERSION, storeId: randomUUID(), contacts: [], intents: [] };
    await atomicWrite(file, state, { missing: true, maxBytes: policy.maxBytes });
    await atomicWrite(marker, { version: VERSION, storeId: state.storeId }, { missing: true, maxBytes: 1024 });
  } else {
    if (!info || !markerInfo) throw Error('Initialized contact state is missing; preserve files for recovery');
    const receipt = await readJson(marker, 1024);
    state = validate(await readJson(file, policy.maxBytes), policy);
    if (receipt?.version !== VERSION || receipt.storeId !== state.storeId) throw Error('Contact initialization marker does not match');
  }
  let fault = null, closed = false, closingTask, tail = Promise.resolve();
  const operations = new Set(), pendingStops = new Map(), pendingIncoming = new Map();
  const stamp = () => { const value = now(); if (!time(value)) throw Error('Invalid contact clock'); return value; };
  const participant = (scope, source = state) => source.contacts.find(contact => contact.scope === scope);
  const findIntent = (id, source = state) => source.intents.find(intent => intent.id === id);
  const markCancelled = (intent, reason, at) => { intent.status = 'cancelled'; intent.doneAt = at; intent.outcome = reason; delete intent.replyText; };

  async function persist(next) {
    try {
      validate(next, policy);
      await regular(marker, false, 1024);
      await atomicWrite(file, next, { maxBytes: policy.maxBytes });
      state = next;
    } catch (error) { fault = error; throw error; }
  }
  const recovered = clone(state); let recoveryChanged = false;
  for (const intent of recovered.intents) {
    if (['generating', 'sending'].includes(intent.status)) {
      intent.status = 'uncertain'; intent.outcome = 'process-interrupted'; intent.doneAt = stamp(); delete intent.replyText; recoveryChanged = true;
    } else if (cancellable.has(intent.status) && (participant(intent.scope).paused || intent.epoch !== participant(intent.scope).epoch
      || (intent.sequence != null && intent.sequence !== participant(intent.scope).sequence) || intent.expiresAt <= stamp())) {
      markCancelled(intent, 'stopped-stale-or-expired', stamp()); recoveryChanged = true;
    }
  }
  if (recoveryChanged) await persist(recovered);

  function work(callback) {
    if (closed) return Promise.reject(Error('Contact coordination is closed'));
    const task = Promise.resolve().then(callback); operations.add(task);
    task.then(() => operations.delete(task), () => operations.delete(task)); return task;
  }
  function serial(callback) {
    const task = tail.then(() => { if (fault) throw Error('Contact coordination needs recovery after a persistence failure'); return callback(); });
    tail = task.catch(() => {}); return task;
  }
  function tokenFor(contact, receipt, duplicate = false) {
    return { scope: contact.scope, epoch: receipt.epoch, sequence: receipt.sequence, stop: receipt.stop, duplicate };
  }
  function current(token, { proactive = false, latest = false } = {}) {
    if (fault || closed || !plain(token) || !validScope(token.scope) || !number(token.epoch)
      || !number(token.sequence) || token.sequence < 1 || token.stop !== false || pendingStops.has(token.scope)) return false;
    const contact = participant(token.scope);
    const receipt = contact?.receipts[token.sequence - 1];
    return Boolean(contact && contact.epoch === token.epoch && receipt && receipt.epoch === token.epoch && !receipt.stop
      && (!proactive || (!contact.paused && !pendingIncoming.has(token.scope)))
      && (!latest || (!pendingIncoming.has(token.scope) && contact.sequence === token.sequence)));
  }
  function activeIntent(intent) {
    const contact = intent && participant(intent.scope);
    return Boolean(!fault && !closed && contact && !contact.paused && intent.epoch === contact.epoch
      && (intent.sequence == null || intent.sequence === contact.sequence)
      && (intent.sequence == null || !pendingIncoming.has(intent.scope))
      && !pendingStops.has(intent.scope) && intent.expiresAt > stamp());
  }
  function matches(intent, ticket) {
    return Boolean(intent && plain(ticket) && intent.id === ticket.id && intent.scope === ticket.scope
      && intent.epoch === ticket.epoch && intent.claimId === ticket.claimId);
  }
  function ticketFor(intent) { return { id: intent.id, scope: intent.scope, epoch: intent.epoch, claimId: intent.claimId }; }

  const api = {
    file, marker, policy: Object.freeze(policy),
    isCurrent: current,
    capture(scope) {
      const contact = participant(scope);
      if (!contact) return null;
      return tokenFor(contact, contact.receipts.at(-1));
    },
    snapshot(scope) {
      if (scope != null && !validScope(scope)) throw TypeError('Invalid contact scope');
      return clone(scope == null ? state : { version: VERSION, contacts: state.contacts.filter(contact => contact.scope === scope),
        intents: state.intents.filter(intent => intent.scope === scope) });
    },
    applyDecision({ token, event, decision } = {}) {
      let scope, payload, fingerprint, key;
      try {
        scope = scopeOf(event); payload = normalizedDecision(decision, event); fingerprint = digest(ownText(event));
        key = event.raw?.message_id == null ? null : `message:${requiredText(String(event.raw.message_id), 'contact message id', 200)}`;
        if (!plain(token) || token.scope !== scope || !number(token.epoch) || !number(token.sequence)
          || token.sequence < 1 || token.stop !== false) throw TypeError('Invalid contact decision token');
        const receipt = participant(scope)?.receipts[token.sequence - 1];
        if (!receipt || receipt.epoch !== token.epoch || receipt.stop || receipt.fingerprint !== fingerprint
          || (key == null ? !receipt.key.startsWith('local:') : receipt.key !== key)) {
          throw TypeError('Contact decision does not match its incoming receipt');
        }
      } catch (error) { return Promise.reject(error); }
      const known = participant(scope)?.receipts[token.sequence - 1];
      const fence = payload.action === 'pause' && !known?.decision
        && !pendingIncoming.has(scope) && participant(scope)?.sequence === token.sequence && participant(scope)?.epoch === token.epoch ? randomUUID() : null;
      if (fence) {
        const pending = pendingStops.get(scope) || new Set(); pending.add(fence); pendingStops.set(scope, pending);
      }
      return work(() => serial(async () => {
        const next = clone(state), contact = participant(scope, next), receipt = contact?.receipts[token.sequence - 1];
        if (receipt?.decision) {
          if (Object.keys(payload).some(key => payload[key] !== receipt.decision[key])) throw Error('Contact receipt has a different boundary decision');
          return { applied: false, duplicate: true, action: payload.action, epoch: contact.epoch, paused: contact.paused };
        }
        if (!contact || contact.sequence !== token.sequence || contact.epoch !== token.epoch || pendingIncoming.has(scope)
          || (payload.action === 'resume' && pendingStops.has(scope))) return { applied: false, reason: 'contact-decision-stale' };
        if (payload.action === 'resume' && !contact.paused) return { applied: false, reason: 'contact-not-paused' };
        const at = stamp(); receipt.decision = { ...payload, at };
        if (payload.action === 'pause') {
          contact.epoch++; contact.paused = true;
          for (const intent of next.intents) if (intent.scope === scope && cancellable.has(intent.status)) markCancelled(intent, 'contextual-impatience', at);
        } else contact.paused = false;
        await persist(next);
        return { applied: true, action: payload.action, epoch: contact.epoch, paused: contact.paused };
      })).finally(() => {
        if (fence) { const pending = pendingStops.get(scope); pending?.delete(fence); if (!pending?.size) pendingStops.delete(scope); }
      });
    },
    observeIncoming(event) {
      let scope, key, fingerprint, stop;
      try {
        scope = scopeOf(event);
        const messageId = event.raw?.message_id;
        key = messageId == null ? `local:${randomUUID()}` : `message:${requiredText(String(messageId), 'contact message id', 200)}`;
        fingerprint = digest(ownText(event)); stop = isExplicitContactStop(event);
      } catch (error) { return Promise.reject(error); }
      // Establish the fence synchronously, before an async fsync can yield to a
      // previously claimed send. Duplicate stop receipts do not create a fence.
      const known = participant(scope)?.receipts.find(receipt => receipt.key === key);
      // A new ordinary input also invalidates sequence-bound proactive work
      // immediately, including a dispatch currently awaiting its claim fsync.
      const incomingFence = !known ? randomUUID() : null;
      if (incomingFence) {
        const pending = pendingIncoming.get(scope) || new Set(); pending.add(incomingFence); pendingIncoming.set(scope, pending);
      }
      const fence = stop && !known ? randomUUID() : null;
      if (fence) {
        const pending = pendingStops.get(scope) || new Set(); pending.add(fence); pendingStops.set(scope, pending);
      }
      return work(() => serial(async () => {
        const next = clone(state); let contact = participant(scope, next);
        const old = contact?.receipts.find(receipt => receipt.key === key);
        if (old) {
          if (old.fingerprint !== fingerprint) throw Error('Contact message id has different content');
          return tokenFor(contact, old, true);
        }
        if (!contact) {
          if (next.contacts.length >= policy.maxContacts) { fault = Error('Contact participant capacity exceeded'); throw fault; }
          contact = { scope, epoch: 0, sequence: 0, paused: false, lastIncomingAt: stamp(), receipts: [] }; next.contacts.push(contact);
        }
        if (next.contacts.reduce((sum, entry) => sum + entry.receipts.length, 0) >= policy.maxReceipts) {
          fault = Error('Contact receipt capacity exceeded; preserve history for maintenance'); throw fault;
        }
        const at = stamp();
        if (stop) {
          contact.epoch++; contact.paused = true;
          for (const intent of next.intents) if (intent.scope === scope && cancellable.has(intent.status)) markCancelled(intent, 'participant-stopped', at);
        }
        contact.sequence++; contact.lastIncomingAt = at;
        const receipt = { key, fingerprint, epoch: contact.epoch, sequence: contact.sequence, stop, at };
        contact.receipts.push(receipt); await persist(next); return tokenFor(contact, receipt);
      })).finally(() => {
        if (fence) { const pending = pendingStops.get(scope); pending?.delete(fence); if (!pending?.size) pendingStops.delete(scope); }
        if (incomingFence) { const pending = pendingIncoming.get(scope); pending?.delete(incomingFence); if (!pending?.size) pendingIncoming.delete(scope); }
      });
    },
    sendIfCurrent(token, send, options) {
      if (typeof send !== 'function') return Promise.reject(TypeError('A contact send callback is required'));
      return work(async () => {
        const result = await serial(() => {
          if (!current(token, options)) return { blocked: true };
          // Invoke the callback in this turn. Returning the promise as a field
          // releases the state queue while the network result remains pending.
          let pending; try { pending = Promise.resolve(send()); } catch (error) { pending = Promise.reject(error); }
          pending.catch(() => {}); return { pending };
        });
        return result.blocked ? { ok: false, reason: 'contact-stopped-or-stale' } : result.pending;
      });
    },
    enqueue(input) {
      return work(() => serial(async () => {
        if (!plain(input) || Object.keys(input).some(key => !['id', 'scope', 'epoch', 'sequence', 'sources', 'reason', 'notBefore', 'expiresAt'].includes(key))
          || typeof input.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.id) || !validScope(input.scope) || !number(input.epoch)
          || (input.sequence != null && (!number(input.sequence) || input.sequence < 1))
          || !time(input.notBefore) || !time(input.expiresAt) || input.expiresAt <= input.notBefore) throw TypeError('Invalid contact intent');
        const payload = { id: input.id, scope: input.scope, epoch: input.epoch, ...(input.sequence != null ? { sequence: input.sequence } : {}), sources: sourceList(input.sources, input.scope),
          reason: requiredText(input.reason, 'contact intent reason', 500), notBefore: input.notBefore, expiresAt: input.expiresAt };
        const old = findIntent(input.id);
        if (old) {
          if (Object.keys(payload).some(key => JSON.stringify(payload[key]) !== JSON.stringify(old[key]))) throw Error('Contact intent id has different content');
          return { accepted: true, id: old.id, duplicate: true, status: old.status };
        }
        const at = stamp();
        if (input.expiresAt - at > policy.maxIntentLifetimeMs) throw TypeError('Contact intent lifetime exceeds its limit');
        if (!activeIntent({ ...payload })) return { accepted: false, reason: 'contact-stopped-stale-or-expired' };
        if (state.intents.length >= policy.maxIntents) { fault = Error('Contact intent capacity exceeded; preserve claims for maintenance'); throw fault; }
        const next = clone(state); next.intents.push({ ...payload, createdAt: at, status: 'pending' }); await persist(next);
        return { accepted: true, id: payload.id, duplicate: false, status: 'pending' };
      }));
    },
    claimGeneration(id) {
      return work(() => serial(async () => {
        const next = clone(state), intent = findIntent(id, next);
        if (!intent || intent.status !== 'pending') return null;
        if (!activeIntent(intent)) { markCancelled(intent, 'stopped-stale-or-expired', stamp()); await persist(next); return null; }
        if (intent.notBefore > stamp() || next.intents.some(other => other.id !== id && other.scope === intent.scope
          && ['generating', 'ready', 'sending'].includes(other.status))) return null;
        intent.status = 'generating'; intent.claimId = randomUUID(); intent.claimedAt = stamp(); await persist(next);
        return ticketFor(intent);
      }));
    },
    completeGeneration(ticket, text, options = {}) {
      if (!plain(options) || Object.keys(options).some(key => key !== 'sourceRefs')) return Promise.reject(TypeError('Invalid contact generation options'));
      return work(() => serial(async () => {
        const next = clone(state), intent = findIntent(ticket?.id, next);
        if (!matches(intent, ticket) || intent.status !== 'generating') return { ready: false, reason: 'claim-not-current' };
        if (!activeIntent(intent)) { markCancelled(intent, 'stopped-stale-or-expired', stamp()); await persist(next); return { ready: false, reason: 'contact-stopped-stale-or-expired' }; }
        intent.replyText = requiredText(text, 'contact reply', 900, true);
        if (Object.hasOwn(options, 'sourceRefs')) intent.selectedSourceRefs = selectedSources(options.sourceRefs, intent.sources);
        intent.status = 'ready'; await persist(next);
        return { ready: true };
      }));
    },
    failGeneration(ticket, { uncertain = false, reason = 'generation-failed' } = {}) {
      if (typeof uncertain !== 'boolean' || !['generation-failed', 'declined'].includes(reason)
        || (uncertain && reason === 'declined')) return Promise.reject(TypeError('Invalid contact generation outcome'));
      return work(() => serial(async () => {
        const next = clone(state), intent = findIntent(ticket?.id, next);
        if (!matches(intent, ticket) || intent.status !== 'generating') return { finished: false, reason: 'claim-not-current' };
        if (!activeIntent(intent)) markCancelled(intent, 'stopped-stale-or-expired', stamp());
        else { intent.status = uncertain ? 'uncertain' : 'failed'; intent.doneAt = stamp(); intent.outcome = reason; delete intent.replyText; }
        await persist(next); return { finished: true, status: intent.status };
      }));
    },
    dispatch(ticket, send, { guard } = {}) {
      if (typeof send !== 'function') return Promise.reject(TypeError('A contact send callback is required'));
      if (guard != null && typeof guard !== 'function') return Promise.reject(TypeError('A synchronous contact send guard is required'));
      const permitted = () => {
        if (!guard) return true;
        try {
          const result = guard();
          // A promise is not permission. Consume a rejected promise so a buggy
          // asynchronous guard fails closed without an unhandled rejection.
          if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
          return result === true;
        } catch { return false; }
      };
      return work(async () => {
        const attempt = await serial(async () => {
          const next = clone(state), intent = findIntent(ticket?.id, next);
          if (!matches(intent, ticket) || intent.status !== 'ready') return null;
          if (!activeIntent(intent)) { markCancelled(intent, 'stopped-stale-or-expired', stamp()); await persist(next); return null; }
          if (intent.notBefore > stamp() || intent.createdAt > stamp()) return null;
          if (!permitted()) { markCancelled(intent, 'send-guard-blocked', stamp()); await persist(next); return null; }
          intent.status = 'sending'; intent.sendClaimedAt = stamp(); await persist(next);
          // A stop may have been observed during the sending-claim fsync. Do
          // not cross the transport boundary even though the claim is durable.
          if (!activeIntent(intent) || intent.notBefore > stamp() || intent.createdAt > stamp() || !permitted()) {
            const cancelled = clone(state); markCancelled(findIntent(intent.id, cancelled), 'stopped-before-send', stamp()); await persist(cancelled); return null;
          }
          let pending; try { pending = Promise.resolve(send(intent.replyText)); } catch (error) { pending = Promise.reject(error); }
          pending.catch(() => {}); return { pending };
        });
        if (!attempt) return { ok: false, reason: 'contact-stopped-stale-or-consumed' };
        let result;
        try { result = await attempt.pending; } catch { result = { ok: false, uncertain: true }; }
        const status = result?.ok === true ? 'sent' : result?.ok === false && result?.uncertain !== true ? 'failed' : 'uncertain';
        await serial(async () => {
          const next = clone(state), intent = findIntent(ticket.id, next);
          if (!matches(intent, ticket) || intent.status !== 'sending') return;
          intent.status = status; intent.doneAt = stamp(); delete intent.replyText; await persist(next);
        });
        return { ok: status === 'sent', ...(status === 'uncertain' ? { uncertain: true } : {}), status };
      });
    },
    close() {
      if (closingTask) return closingTask;
      closed = true;
      closingTask = (async () => {
        await Promise.allSettled([...operations]); await tail;
        if (fault) throw Error('Contact coordination needs recovery after a persistence failure');
      })(); return closingTask;
    }
  };
  return api;
}
