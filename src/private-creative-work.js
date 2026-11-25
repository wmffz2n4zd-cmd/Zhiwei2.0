import { setTimeout as delay } from 'node:timers/promises';

const labels = Object.freeze({
  drawing: '按文字新绘一张静态图片', website: '制作可离线浏览的交互单页信息网站',
  design: '制作分层可编辑的 SVG 图文设计并导出 PNG', model3d: '用基本形体组合简单参数化三维物件，支持旋转预览、改尺寸和导出 GLB'
});
export const enabledCreativeKinds = flags => Object.keys(labels).filter(kind => flags?.[kind] === true);

export function withCreativeSchema(schema, kinds = []) {
  if (!kinds.length) return schema;
  return { ...schema, required: [...schema.required, 'creativeWork'], properties: { ...schema.properties,
    creativeWork: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
      required: ['kind', 'title', 'brief'], properties: { kind: { type: 'string', enum: kinds },
        title: { type: 'string', minLength: 1, maxLength: 80 }, brief: { type: 'string', minLength: 1, maxLength: 1600 } } }] } } };
}

export function creativeDecisionPrompt(kinds, { allowReceiptOnly = false } = {}) {
  if (!kinds?.length) return '';
  return '本轮还需输出 creativeWork。可以填 null，或在你确实想为当前这位朋友做一件作品时填 {kind,title,brief}。'
    + '可选 ' + kinds.map(kind => kind + '（' + labels[kind] + '）').join('、') + '。'
    + '对方请你制作实际作品时，愿意就选相应工具；你自己想创作并与这位朋友分享也可以选。普通聊天、仅讨论做法、缺少关键要求、选择不联系或不想做时填 null。'
    + 'title 是简短作品名，brief 用不超过1600字描述你想做的具体内容、版式或造型，带上实际要求。只给作品本身需要的资料。'
    + (allowReceiptOnly && kinds.includes('website')
      ? '决定创作时填写本入口要求的依据。对方只要最终网页时，选 website 并把发起时的 reply 留为空字符串，作品完成后才发回执。其他情况仍填写正常发言。'
      : '决定创作时仍填写正常发言和本入口要求的依据。')
    + '补查、停扰、浏览和私聊念头不要与创作并选。此时只决定发起，成品状态、附件与下载入口由执行回执决定。';
}

// Only the Hub selects an identity, destination, task id and file location.
export function readCreativeDecision(raw, kinds, parse, { allowReceiptOnly = false } = {}) {
  if (!kinds?.length) return parse(raw);
  if (typeof raw === 'string' && raw.length > 24000) throw TypeError('Creative decision too long');
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw TypeError('Invalid creative decision');
  const { creativeWork = null, ...rest } = value;
  const parsed = parse(rest);
  if (creativeWork === null) return parsed;
  const receiptOnly = allowReceiptOnly && creativeWork?.kind === 'website' && parsed.reply === ''
    && parsed.contactBoundary?.kind === 'none';
  const safe = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(s);
  if (!creativeWork || Object.keys(creativeWork).length !== 3 || !kinds.includes(creativeWork.kind)
    || !safe(creativeWork.title, 80) || !safe(creativeWork.brief, 1600)
    || parsed.action && parsed.action !== 'reply' || parsed.contextMore || parsed.browseIntent || parsed.privateThought
    || parsed.contactBoundary && parsed.contactBoundary.kind !== 'none'
    || (!receiptOnly && !parsed.reply?.trim()) || /\[\[(?:pwa_history|qq_context_more)/i.test(parsed.reply)) {
    throw TypeError('Invalid creative action');
  }
  return { ...parsed, creativeWork: { kind: creativeWork.kind, title: creativeWork.title.trim(), brief: creativeWork.brief.trim() } };
}

export async function prepareCreativeWork({ store, binding, proposal, draft, render, describe, assertCurrent, signal }) {
  const input = { ...binding, ...proposal };
  await assertCurrent();
  let claim = store.claimCreativeWork(input);
  // A previous process or overlapping worker owns this task. Wait for the real
  // result, or reclaim after its durable lease expires. Do not consume the
  // original inbox by answering "still running" and abandoning its pending work.
  while (claim.status === 'running') {
    await delay(Math.max(20, Math.min(1500, (claim.leaseUntil || Date.now() + 1500) - Date.now())), undefined, { signal });
    await assertCurrent();
    claim = store.claimCreativeWork(input);
  }
  let workId = claim.workId, status = claim.status, programCheck;
  if (status === 'claimed') {
    try {
      const spec = proposal.kind === 'drawing' ? { prompt: proposal.brief } : await draft(proposal);
      await assertCurrent();
      const output = await render({ kind: proposal.kind, title: proposal.title, spec });
      await assertCurrent();
      ({ workId } = store.finishCreativeWork({ ...binding, token: claim.token, output }));
      programCheck = output.programCheck;
      status = 'ready';
    } catch (error) {
      store.failCreativeWork({ ...binding, token: claim.token, reason: 'generation-failed' });
      await assertCurrent();
      status = 'failed';
    }
  }
  await assertCurrent();
  const ready = (status === 'ready' || status === 'delivered') && Boolean(workId);
  const receipt = { status: ready ? 'ready' : status, kind: proposal.kind, title: proposal.title };
  if (ready && programCheck) receipt.programCheck = programCheck;
  let caption;
  try { caption = await describe(receipt); }
  catch { /* The confirmed artifact remains deliverable if wording fails. */ }
  await assertCurrent();
  if (!ready) return { workId: null, text: '这次制作没有生成可交付的文件，可以再试一次。' };
  const valid = typeof caption === 'string' && caption.trim().length > 0 && caption.length <= 320
    && !/[\u0000-\u001f\u007f]|\[\[|\[CQ:|https?:\/\//iu.test(caption);
  return { workId, text: valid ? caption.trim() : '《' + proposal.title + '》做好了，可以打开预览或下载。' };
}
