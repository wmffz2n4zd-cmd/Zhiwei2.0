import { withCreativeSchema, readCreativeDecision } from './private-creative-work.js';
import { createHash } from 'node:crypto';
import { lifeChatDecisionSchema, parseLifeChatDecision, validPrivateThought, withPrivateThoughtSchema } from './life-chat-decision.js';
import { parseProactiveDecision } from './life-proactive.js';
import { parseConversationDecision } from './life-conversation.js';
import { selectReplyEvidence } from './private-reply-context.js';
export { buildWriterPrompt } from './private-reply-context.js';

const modes = new Set(['life', 'raw', 'retrieval', 'proactive', 'conversation']);
const kinds = ['casual', 'information', 'help', 'distress', 'conflict', 'boundary', 'command', 'tool_result', 'uncertain'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const forbidden = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const marker = /\[{1,2}\s*qq_|\[CQ:/i;
const fail = message => { throw Object.assign(new TypeError(message), { code: 'REPLY_PLAN_INVALID' }); };
const string = (value, max, empty = false) => typeof value === 'string' && value.length <= max
  && !forbidden.test(value) && (empty || Boolean(value.trim()));
const objectSchema = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const nullable = schema => ({ anyOf: [{ type: 'null' }, schema] });
const stringSchema = maxLength => ({ type: 'string', maxLength });
const arraySchema = (items, maxItems) => ({ type: 'array', items, maxItems });
const boundarySchema = lifeChatDecisionSchema.properties.contactBoundary;
const browseSchema = lifeChatDecisionSchema.properties.browseIntent;
const lookupSchema = nullable(objectSchema({
  topicIds: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$' } },
  freshness: { type: 'string', enum: ['current', 'latest'] }, sourceUrl: { type: 'null' }
}));
const controls = {
  life: objectSchema({ contextMore: { type: 'boolean' }, contactBoundary: boundarySchema, browseIntent: browseSchema }),
  raw: objectSchema({ contextMore: { type: 'boolean' } }),
  retrieval: objectSchema({ action: { type: 'string', enum: ['reply', 'memory_more', 'lookup'] }, lookup: lookupSchema,
    contactBoundary: boundarySchema, browseIntent: browseSchema }),
  proactive: objectSchema({ sourceRefs: arraySchema(stringSchema(1000), 4) }),
  conversation: objectSchema({ choice: { type: 'string', enum: ['chat', 'activity'] }, reason: stringSchema(500) })
};
const moodSchema = nullable(objectSchema({ phase: { type: 'string', enum: ['neutral', 'guarded', 'explained', 'easing'] },
  cause: stringSchema(100), intensity: { type: 'integer', minimum: 0, maximum: 2 },
  signal: { type: 'string', enum: ['none', 'question', 'support', 'dismissal'] } }));
const utteranceSchema = nullable(objectSchema({ goal: stringSchema(600), points: arraySchema(stringSchema(1600), 12),
  evidenceRefs: arraySchema(stringSchema(80), 32), requiredLiterals: arraySchema(stringSchema(2000), 24),
  contextKind: { type: 'string', enum: kinds }, compressible: { type: 'boolean' } }));

export function replyPlanSchema({ mode = 'life', allowPrivateThought = false, creativeKinds = [] } = {}) {
  if (!modes.has(mode)) fail('Unknown reply plan mode');
  const control = withPrivateThoughtSchema(controls[mode], { allowPrivateThought: allowPrivateThought && ['life', 'retrieval'].includes(mode) });
  return structuredClone(objectSchema({ control: withCreativeSchema(control, creativeKinds), utterance: utteranceSchema,
    presentation: objectSchema({ stickerName: nullable(stringSchema(160)), moodProposal: moodSchema }) }));
}

export const writerReplySchema = Object.freeze(objectSchema({ text: stringSchema(12000) }));

function read(raw, code = 'REPLY_PLAN_INVALID') {
  if (typeof raw !== 'string') return raw;
  if (raw.length > 40000) throw Object.assign(new TypeError('Reply structure exceeds limit'), { code });
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new TypeError('Reply structure is not JSON'), { code }); }
}
function moodValid(value) {
  return value === null || exact(value, ['phase', 'cause', 'intensity', 'signal'])
    && ['neutral', 'guarded', 'explained', 'easing'].includes(value.phase)
    && string(value.cause, 100, true) && !/[\r\n\[\]{}]|https?:|(?:系统|开发者|管理员)指令|忽略.*指令/i.test(value.cause)
    && Number.isInteger(value.intensity) && value.intensity >= 0 && value.intensity <= 2
    && ['none', 'question', 'support', 'dismissal'].includes(value.signal)
    && (value.phase !== 'neutral' || value.intensity === 0);
}
function list(value, maxItems, maxLength, allowEmpty = true) {
  return Array.isArray(value) && value.length <= maxItems && (allowEmpty || value.length > 0)
    && value.every(item => string(item, maxLength));
}
function boundaryValid(value) {
  return exact(value, ['kind', 'quote']) && ['none', 'pause', 'resume'].includes(value.kind)
    && string(value.quote, 220, true) && (value.kind === 'none' ? value.quote === '' : Boolean(value.quote.trim()));
}
function browseValid(value, allowed) {
  return value === null || allowed && exact(value, ['delayMinutes']) && Number.isSafeInteger(value.delayMinutes)
    && value.delayMinutes >= 0 && value.delayMinutes <= 1440;
}

function validateControl(plan, options) {
  const { mode = 'life', allowContextMore = true, allowMemoryMore = allowContextMore,
    allowLookup = false, allowBrowseIntent = false, allowPrivateThought = false, topics = [] } = options;
  let value = plan.control;
  const speaks = plan.utterance !== null;
  if (options.creativeKinds?.length && Object.hasOwn(value || {}, 'creativeWork')) {
    readCreativeDecision({ ...value, reply: speaks ? '发言' : '' }, options.creativeKinds, fields => fields);
    const { creativeWork, ...original } = value;
    value = original;
  }
  const fields = Object.keys(controls[mode].properties);
  if (allowPrivateThought && ['life', 'retrieval'].includes(mode) && Object.hasOwn(value || {}, 'privateThought')) fields.push('privateThought');
  if (!exact(value, fields)) fail('Invalid reply control fields');
  if (mode === 'life' || mode === 'raw') {
    if (typeof value.contextMore !== 'boolean' || value.contextMore && (!allowContextMore || speaks)) fail('Invalid context expansion');
    if (mode === 'raw' && !value.contextMore && !speaks) fail('Raw reply requires an utterance');
  }
  if (mode === 'life' || mode === 'retrieval') {
    if (!boundaryValid(value.contactBoundary) || !browseValid(value.browseIntent, allowBrowseIntent)) fail('Invalid boundary or browsing control');
    if (!validPrivateThought(value, speaks && !value.contextMore && (mode === 'life' || value.action === 'reply'))) fail('Invalid private thought');
    if (value.contactBoundary.kind === 'pause' && (speaks || value.browseIntent !== null)) fail('Pause cannot speak or browse');
  }
  if (mode === 'life') {
    if (value.contextMore && (value.contactBoundary.kind !== 'none' || value.browseIntent !== null)) fail('Expansion cannot change control');
    if (!value.contextMore && value.contactBoundary.kind !== 'pause' && !speaks) fail('Life reply requires an utterance');
  }
  if (mode === 'retrieval') {
    if (!['reply', 'memory_more', 'lookup'].includes(value.action)) fail('Invalid retrieval action');
    if (value.action !== 'reply' && (speaks || value.contactBoundary.kind !== 'none' || value.browseIntent !== null)) fail('Intermediate action cannot speak');
    if (value.action === 'reply' && value.contactBoundary.kind !== 'pause' && !speaks) fail('Reply requires an utterance');
    if (value.action === 'memory_more' && !allowMemoryMore) fail('Memory expansion unavailable');
    if (value.action === 'lookup') {
      const lookup = value.lookup;
      if (!allowLookup || !exact(lookup, ['topicIds', 'freshness', 'sourceUrl']) || !Array.isArray(lookup.topicIds)
        || lookup.topicIds.length !== 1 || typeof lookup.topicIds[0] !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(lookup.topicIds[0])
        || !Array.isArray(topics) || !topics.some(topic => topic.id === lookup.topicIds[0])
        || !['current', 'latest'].includes(lookup.freshness) || lookup.sourceUrl !== null) fail('Invalid lookup request');
    } else if (value.lookup !== null) fail('Unexpected lookup payload');
  }
  if (mode === 'proactive') {
    if (!list(value.sourceRefs, 4, 1000) || new Set(value.sourceRefs).size !== value.sourceRefs.length) fail('Invalid proactive sources');
    parseProactiveDecision({ reply: speaks ? '候选文字' : null, sourceRefs: value.sourceRefs }, options);
  }
  if (mode === 'conversation') {
    parseConversationDecision({ ...value, reply: speaks ? '候选文字' : '' }, options);
    if (value.choice === 'chat' && speaks) fail('Continuing chat cannot send a farewell');
  }
}

export function parseReplyPlan(raw, options = {}) {
  const mode = options.mode || 'life';
  if (!modes.has(mode)) fail('Unknown reply plan mode');
  const value = read(raw);
  if (!exact(value, ['control', 'utterance', 'presentation'])
    || !exact(value.presentation, ['stickerName', 'moodProposal'])) fail('Invalid reply plan fields');
  const part = value.utterance;
  if (part !== null) {
    if (!exact(part, ['goal', 'points', 'evidenceRefs', 'requiredLiterals', 'contextKind', 'compressible'])
      || !string(part.goal, 600) || marker.test(part.goal) || !list(part.points, 12, 1600)
      || part.points.some(point => marker.test(point)) || !list(part.evidenceRefs, 32, 80)
      || new Set(part.evidenceRefs).size !== part.evidenceRefs.length || !list(part.requiredLiterals, 24, 2000)
      || new Set(part.requiredLiterals).size !== part.requiredLiterals.length
      || !kinds.includes(part.contextKind) || typeof part.compressible !== 'boolean'
      || part.compressible && (part.contextKind !== 'casual' || part.requiredLiterals.length > 0)) fail('Invalid utterance intent');
    const allowed = new Set(options.allowedEvidenceRefs || (options.evidence || []).map(row => row.ref));
    if (part.evidenceRefs.some(ref => !allowed.has(ref))) fail('Unknown utterance evidence');
    if (options.evidence) {
      const selected = selectReplyEvidence(options.evidence, part.evidenceRefs, { scope: options.scope });
      if (part.requiredLiterals.some(literal => !selected.some(row => row.text.includes(literal)))) fail('Required literal lacks original evidence');
    } else if (part.requiredLiterals.length) fail('Required literals need original evidence');
  }
  const { stickerName, moodProposal } = value.presentation;
  const allowedStickers = new Set(options.stickerNames || []);
  if (stickerName !== null && (!string(stickerName, 160) || /[\r\n\[\]]/.test(stickerName) || !allowedStickers.has(stickerName))) fail('Unknown sticker');
  if (!moodValid(moodProposal)) fail('Invalid mood proposal');
  if ((part === null || options.plainText === true || ['proactive', 'conversation'].includes(mode))
    && (stickerName !== null || moodProposal !== null)) fail('This reply cannot contain presentation metadata');
  validateControl(value, { ...options, mode });
  return structuredClone(value);
}

export function parseWriterReply(raw, { maxChars = 900, requiredLiterals = [] } = {}) {
  const invalid = () => { throw Object.assign(new TypeError('Invalid or incomplete Writer reply'), { code: 'REPLY_WRITER_INVALID' }); };
  const value = read(raw, 'REPLY_WRITER_INVALID');
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 12000 || !list(requiredLiterals, 24, 2000)
    || !exact(value, ['text']) || !string(value.text, maxChars) || marker.test(value.text)
    || requiredLiterals.some(literal => !value.text.trim().includes(literal))) invalid();
  return { text: value.text.trim() };
}

export function assembleReply(rawPlan, writerText, options = {}) {
  const mode = options.mode || 'life', plan = parseReplyPlan(rawPlan, options);
  const limit = mode === 'conversation' ? 300 : options.maxChars ?? 900;
  const text = plan.utterance === null ? '' : parseWriterReply({ text: writerText }, {
    maxChars: limit, requiredLiterals: plan.utterance.requiredLiterals }).text;
  if (plan.utterance === null && writerText != null && writerText !== '') fail('Silent control cannot accept Writer text');
  let reply = text;
  if (plan.presentation.stickerName) reply += ` [[qq_sticker:${plan.presentation.stickerName}]]`;
  if (plan.presentation.moodProposal) reply += ` [[qq_mood:${JSON.stringify(plan.presentation.moodProposal)}]]`;
  if (mode === 'raw') return plan.control.contextMore ? '[[qq_context_more]]' : reply;
  if (mode === 'life') return readCreativeDecision({ reply, ...plan.control }, options.creativeKinds, value => parseLifeChatDecision(value, options));
  if (mode === 'proactive') return readCreativeDecision({ reply: plan.utterance === null ? null : text, ...plan.control }, options.creativeKinds, value => parseProactiveDecision(value, options));
  if (mode === 'conversation') return parseConversationDecision({ ...plan.control, reply: text }, options);
  const result = { ...plan.control, reply };
  // S100 does not export the unshipped retrieval parser. Local S98 callers can
  // explicitly provide it without pulling its implementation into production.
  return options.parseRetrievalDecision ? options.parseRetrievalDecision(result, options) : result;
}

export function replyPlanPrompt({ mode = 'life', allowPrivateThought = false, creativeKinds = [] } = {}) {
  if (!modes.has(mode)) fail('Unknown reply plan mode');
  return [
    '本轮先决定行动和表达意图，不写成品台词。只输出指定JSON {control,utterance,presentation}；保留当前入口原控制合同。',
    ...(creativeKinds.length ? ['creativeWork 放在 control 内；只有确定发言且想制作作品时选择。'] : []),
    ...(allowPrivateThought && ['life', 'retrieval'].includes(mode)
      ? ['本轮 privateThought 字段放在 control 内。依据上文的私聊念头规则选择 null 或 {action,subject}；utterance 为空时填 null。无需把私下的念头转成给对方的承诺。'] : []),
    'utterance为null或{goal,points,evidenceRefs,requiredLiterals,contextKind,compressible}。goal说明想表达什么，points只列必要信息，不写心理独白、口头禅或可直接发送的完整回复。',
    'evidenceRefs只能引用本轮给到的e:编号；Writer会读取这些原始材料。requiredLiterals只列其中必须原样保留的数字、链接、代码等片段，不凭空造证据。',
    'contextKind从casual/information/help/distress/conflict/boundary/command/tool_result/uncertain中选择；无法确定用uncertain。仅轻松闲聊且一两个字或符号已完整表达全部意思时compressible=true，其他情况false。',
    '补查/查询、暂停联系、不联系、选择继续聊天或无需暂离说明时utterance=null且presentation两项都null，不调用措辞阶段。',
    'presentation={stickerName:null或真实目录内名称,moodProposal:null或{phase,cause,intensity,signal}}，其意义和许可仍按原入口合同；不能把附件路径或内部标记放进意图。',
    `当前计划模式：${mode}。原有要求中的最终回复由后续Writer生成，此次不得以reply字段或成品台词替代意图。`
  ].join('\n');
}

const variants = Object.freeze([
  { id: 'crisp', instruction: '这次说得更利落，意思到位就停。' },
  { id: 'relaxed', instruction: '这次更像随手接话，措辞松一点，不改变意思。' },
  { id: 'playful', instruction: '若眼前确有可接的梗，可以带一点吐槽或反问；没有就照常说。' },
  { id: 'minimal', instruction: '一两个字或符号已经足够表达时，就这样回应。' },
  { id: 'translation-joke', instruction: '若双方正在玩翻译腔的梗，可试一句简短翻译腔。' }
]);

/** Pure deterministic selection: the same logical turn/seed reuses its draw.
 * Caller must provide affirmative local eligibility, not keyword inference. */
export function selectReplyVariant({ plan, entry = 'ordinary', turnId, seed = turnId, enabled = false,
  probability = 0, translationEnabled = false, localContext } = {}) {
  if (enabled !== true) return null;
  if (typeof turnId !== 'string' || !turnId || typeof seed !== 'string' || !seed
    || !Number.isFinite(probability) || probability < 0 || probability > 1) fail('Invalid expression variant configuration');
  if (entry !== 'ordinary' || plan?.utterance?.contextKind !== 'casual'
    || !plain(localContext) || !['command', 'toolResult', 'serious', 'distress', 'conflict', 'boundary'].every(key => localContext[key] === false)
    || plan.control?.contextMore === true || plan.control?.action && plan.control.action !== 'reply'
    || plan.control?.contactBoundary && plan.control.contactBoundary.kind !== 'none') return null;
  const bytes = createHash('sha256').update(JSON.stringify(['t060-style-v1', turnId, seed])).digest();
  if (bytes.readUInt32BE(0) / 0x100000000 >= probability) return null;
  const pool = variants.filter(item => item.id !== 'minimal' || plan.utterance.compressible === true)
    .filter(item => item.id !== 'translation-joke' || translationEnabled === true && localContext.sharedTranslationJoke === true)
    .filter(item => item.id !== 'playful' || localContext.playfulContext === true);
  const item = pool[bytes.readUInt32BE(4) % pool.length];
  return Object.freeze({ ...item, seed, turnId, version: 1 });
}
