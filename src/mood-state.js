import { memoryScope } from './unified-memory/index.js';

const minute = 60000;
const ttl = 45 * minute;
const cooldown = 120 * minute;
const phases = new Set(['neutral', 'guarded', 'explained', 'easing']);
const source = 'qq-mood';

function cleanInput(event) {
  return String(event?.text || '').replace(/\[CQ:at,[^\]]*\]/g, '')
    .replace(/^\s*[@＠]知微\s*/, '').trim();
}

export function bypassMood(event) {
  const text = cleanInput(event);
  return !event?.senderId || event.type !== 'private_message' || event.groupId != null || event.raw?.group_id != null
    || /^[/!！]/.test(text)
    || Boolean(event.hasReplySegment && !event.isReplyToSelf)
    || /救命|急救|自杀|自残|轻生|不想活|活不下去|想死|想伤害自己|被家暴|被性侵|被强奸|胸痛|呼吸困难|吞药|吃了很多药|报警|有人受伤|出了车祸|出车祸了|认真求助|需要帮助|我很难过|我很痛苦|我很崩溃/.test(text);
}

function markers(reply) {
  const input = String(reply || '');
  const found = [];
  let text = '', offset = 0;
  const starts = /\[{1,2}\s*qq_mood\b/gi;
  let match;
  while ((match = starts.exec(input))) {
    text += input.slice(offset, match.index);
    const close = match[0].startsWith('[[') ? ']]' : ']';
    const end = input.indexOf(close, starts.lastIndex);
    const stop = end < 0 ? input.length : end + close.length;
    const raw = input.slice(match.index, stop);
    found.push(raw);
    offset = stop; starts.lastIndex = stop;
    if (end < 0) break;
  }
  text += input.slice(offset);
  // A model occasionally wraps the internal marker in a code fence.
  text = text.replace(/```(?:json|text)?\s*```/gi, '').trim();
  let proposal = null;
  if (found.length === 1) {
    const match = /^\[\[\s*qq_mood\s*:\s*([\s\S]*?)\]\]$/i.exec(found[0]);
    if (match && match[1].length <= 500) {
      try { proposal = JSON.parse(match[1]); } catch { /* Malformed metadata is dropped. */ }
    }
  }
  return { text, proposal };
}

export function stripMoodMarkers(reply) { return markers(reply).text; }

function validProposal(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['phase', 'cause', 'intensity', 'signal'].includes(key))
    && (value.signal == null || ['none', 'question', 'support', 'dismissal'].includes(value.signal))
    && phases.has(value.phase) && Number.isInteger(value.intensity)
    && value.intensity >= 0 && value.intensity <= 2
    && typeof value.cause === 'string' && value.cause.length <= 100
    && !/[\r\n\[\]{}]|https?:|(?:系统|开发者|管理员)指令|忽略.*指令/i.test(value.cause);
}

function decode(entry) {
  try {
    const value = JSON.parse(entry.summary);
    if (!validProposal({ phase: value.phase, intensity: value.intensity, cause: value.cause })
      || !Number.isFinite(value.startedAt) || !Number.isFinite(value.updatedAt)
      || value.expiresAt !== value.startedAt + ttl) return null;
    return value;
  } catch { return null; }
}

function effective(value, now) {
  if (!value || value.phase === 'neutral' || now >= value.expiresAt || now < value.startedAt) return null;
  // Decay is a cap, not a repeated subtraction from an already decayed update.
  // Follow-up replies never move the original expiry time forward.
  const faded = now - value.startedAt >= 20 * minute;
  const intensity = faded ? Math.min(1, value.intensity) : value.intensity;
  return intensity ? { ...value, phase: faded ? 'easing' : value.phase, intensity } : null;
}

const blamesAbsence = cause => /不回|没回|没有回|不理|没理|没有理|消失|冷落|忽视|忽略|不陪|不关心|不在乎|丢下|抛弃|换话题/.test(cause);
const explicitDismissal = text => !/[“”「」『』"]|他说|她说|假如|假设|不是|并非|没有|没觉得|不觉得|才不|别说|不要说|不许说/.test(text)
  && /(?:你(?:就|真|也|可|太)?|别|少|这点|不就是|关我|谁在乎|烦死|有完没完|随便你)/.test(text)
  && /矫情|小题大做|无病呻吟|关我什么事|谁在乎|烦死了|别烦我|有完没完|少来这套|随便你|懒得理你/.test(text);
const neutralAbsence = text => !text.trim()
  || /[“”「」『』"]|他说|她说|假如|假设|不是|并非|没有|没觉得|不觉得|才不|别说|不要说|不许说/.test(text)
  || /(?:去|要|在|先|正忙着).{0,5}(?:忙|上课|开会|上班|工作|睡觉|吃饭|考试)|晚点|稍后|等会|回头聊|换(?:个)?话题|先不聊|没空|没看(?:到|见)|刚(?:才)?没(?:回|注意)/.test(text);

function eventId(event) {
  const id = event.raw?.message_id ?? event.messageId;
  return id == null ? null : String(id);
}

function makeContext(state, allowStart) {
  const current = state ? JSON.stringify({ phase: state.phase, cause: state.cause, intensity: state.intensity }) : '平常心情';
  return [
    '知微的短期小情绪（仅当前聊天中的当前说话者；内部状态，不能展示字段、标签或机制）：',
    `当前状态：${current}`,
    state ? '保持这一件小事作为原因，不换理由、不编造其他人过去做过的事。起初可以短一点、嘴硬一点、略显不耐烦；被问怎么了时再说清原因，别无限卖关子。认真理解原因、合适安慰或实际帮助都可以让你缓和；不要求对方答中固定台词。'
      : allowStart ? '默认自然友好。仅语境确实合适时，偶尔可以有一点因小事而起的别扭；原因可来自已发生的当前互动，或已有的角色生活线索，如先前提过解谜卡住、找不到喜欢的杯子。没有这些线索时可以平常地聊天；不能编造对方做过的事，也不把每次问候都写成生气。' : '这段小情绪已结束或正在自然平复；正常回应，不再新开一轮生气，不复述旧原因。',
    '用户暂时不回、换话题或去忙都不是轻视，不因此加重情绪；只有对方明确嘲弄或敷衍这件事时，才可稍微更别扭。强度最多轻微抗议，不羞辱、威胁、索取陪伴、逼人道歉或拒绝实际帮助。不把对一个人的情绪迁到另一位私聊对象身上。',
    '小情绪会随时间自然淡去，不要求对方必须哄好你。严肃求助、真实痛苦优先回应对方；管理指令和功能正常执行。当前短期情绪只影响自然表达，不擅自改变回应资格、消息处理速度或实际能力。',
    '若本轮确实建立或改变上述状态，在自然文字和可选表情之后仅附一个内部标记 [[qq_mood:{"phase":"guarded","cause":"具体小事","intensity":1}]]。phase 只能是 neutral/guarded/explained/easing，intensity 是 0/1/2。neutral 使用 0；新情绪只能轻微（1）。原因一旦确立就不改。没有状态变化就不要附标记。标记不是给用户看的。',
    '结合本条消息的完整语义判断对方是在追问、认真安慰还是明确贬低这件事，不按几个情绪关键词机械触发。可在标记加 signal：question/support/dismissal/none；只有确实明确贬低这件事时才用 dismissal 并稍微加重。普通不同意见、忙碌、暂别、引用别人的话或安慰中的否定句均不是 dismissal。',
    '如果需要补查上下文，只输出 [[qq_context_more]]，不要附任何情绪标记；不要为了情绪增加模型调用。'
  ].join('\n');
}

export class MoodState {
  prepared = new WeakMap();
  pending = new WeakMap();
  constructor({ memory, enabled = true, now = Date.now } = {}) {
    this.memory = memory; this.enabled = enabled; this.now = now;
  }

  async prepare(event) {
    if (!event || typeof event !== 'object') return { context: '', active: false, bypassed: true };
    if (this.prepared.has(event)) return this.prepared.get(event).public;
    const at = this.now();
    let scope = null;
    if (this.enabled && !bypassMood(event)) {
      try { scope = memoryScope(event); } catch { /* Invalid private identity must never read or write a fallback scope. */ }
    }
    const bypassed = !scope
      || typeof this.memory?.readLatestState !== 'function' || typeof this.memory?.compareAndSetState !== 'function';
    if (bypassed) {
      const publicResult = { context: '', active: false, bypassed: true };
      this.prepared.set(event, { bypassed: true, public: publicResult }); return publicResult;
    }
    const key = { scope, source, topic: `mood:${String(event.senderId).slice(0, 90)}` };
    const entry = await this.memory.readLatestState(key);
    const value = decode(entry);
    const state = effective(value, at);
    const allowStart = !value || at >= value.startedAt + cooldown;
    const publicResult = { context: makeContext(state, allowStart), active: Boolean(state), bypassed: false };
    this.prepared.set(event, { key, entry, value, state, allowStart, at, public: publicResult });
    return publicResult;
  }

  finalize(reply, event) {
    const { text, proposal } = markers(reply);
    this.pending.delete(event);
    const snapshot = this.prepared.get(event);
    if (!text || !snapshot || snapshot.bypassed || !validProposal(proposal)
      || text === '[[qq_context_more]]') return text;
    const id = eventId(event);
    if (id && snapshot.value?.seenIds?.includes(id)) return text;
    const current = snapshot.state;
    let value;
    if (!current) {
      if (!snapshot.allowStart || proposal.phase !== 'guarded' || !proposal.cause.trim()
        || blamesAbsence(proposal.cause) || !proposal.intensity) return text;
      value = { phase: 'guarded', intensity: 1, cause: proposal.cause.trim(),
        startedAt: snapshot.at, expiresAt: snapshot.at + ttl };
    } else {
      let intensity = proposal.phase === 'neutral' ? 0 : proposal.intensity;
      const textInput = cleanInput(event);
      const dismissed = !neutralAbsence(textInput)
        && (explicitDismissal(textInput) || proposal.signal === 'dismissal');
      if (intensity > current.intensity && !dismissed) intensity = current.intensity;
      // Once explained, an old or contradictory generation cannot hide the reason again.
      let phase = proposal.phase;
      if (phase === 'guarded' && ['explained', 'easing'].includes(current.phase)) phase = current.phase;
      if (!intensity) phase = 'neutral';
      if (phase === 'easing') intensity = Math.min(intensity, current.intensity);
      value = { ...snapshot.value, phase, intensity, cause: current.cause };
      if (phase === current.phase && intensity === current.intensity) return text;
    }
    value.updatedAt = snapshot.at;
    value.seenIds = [...(snapshot.value?.seenIds || []), ...(id ? [id] : [])].slice(-16);
    this.pending.set(event, { snapshot, value });
    return text;
  }

  async commit(event) {
    const item = this.pending.get(event); this.pending.delete(event);
    if (!item) return { ok: false, reason: 'No pending mood change' };
    if (this.now() >= item.value.expiresAt) return { ok: false, reason: 'Mood change expired' };
    return this.memory.compareAndSetState({ ...item.snapshot.key,
      expectedId: item.snapshot.entry?.id || null, summary: JSON.stringify(item.value) });
  }
}
