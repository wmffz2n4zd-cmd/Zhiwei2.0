'use strict';
const el = id => document.getElementById(id);
let token = null, currentReport = null, loading = false;
let contactPauseView = null, contactPauseStartedAt = 0, contactPauseTimer = null;
const number = value => Number.isFinite(value) ? value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : '未知';
const delta = value => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${number(value)}` : '未知';
const time = value => Number.isFinite(value) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(value) : '未知时间';
const modeLabel = mode => mode === 'simulated' ? '角色生活' : mode === 'external' ? '真实外部经历' : '生活记录';
const statusLabels = { pending: '未安排', planned: '已计划', active: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', expired: '已过期', abandoned: '已放弃', recorded: '已入账', missed: '已错过' };
const typeLabels = { 'thought-added': '新念头', 'thought-abandoned': '念头放下', 'thought-expired': '念头过期', 'thought-postponed': '念头推迟', 'plan-created': '活动计划', 'plan-cancelled': '计划取消', 'plan-missed': '计划错过', 'plan-start-held': '活动开始暂缓', 'plan-start-resolved': '活动时间已确定', 'activity-started': '活动开始', 'activity-action-claimed': '活动执行已认领', 'activity-completed': '活动完成', 'activity-failed': '活动失败', 'activity-interrupted': '活动中断', 'experience-recorded': '经历入账' };
const reasonLabels = { 'source-unavailable': '生活资料暂不可用，未把缺失记录计作零。', 'life-disabled': '生活尚未启用。当前没有可读取的运行快照。', 'timeline-recovery-required': '生活记录需要恢复核查，观察页面不会自行修复。', 'clock-before-committed-events': '当前时间早于已有记录，暂不计算统计。', 'validated-committed-history': '已读取公共生活记录；所有统计和事件来自同一快照。', 'no-records-in-window': '记录完整，所选范围内没有公共生活事件。空白无需补演。', 'invalid-or-incomplete-history': '来源残缺或未通过校验，统计保持未知。' };
function node(tag, text, className) { const item = document.createElement(tag); if (text != null) item.textContent = text; if (className) item.className = className; return item; }
function paragraph(parent, text, className) { parent.append(node('p', text, className)); }
function empty(parent, text) { parent.replaceChildren(node('p', text, 'empty')); }
function relations(parent, items) {
  if (!items?.length) { paragraph(parent, '尚无后续念头或行为引用的证据。', 'hint'); return; }
  for (const item of items) {
    const box = node('div', null, 'relation');
    paragraph(box, `${item.title || '后续念头'} · ${statusLabels[item.status] || item.status || '状态未知'}`);
    paragraph(box, `念头：${item.thoughtId}`, 'ref');
    paragraph(box, `所选引用：${(item.selectedRefs || []).join('、') || '无可核对引用'}`, 'ref');
    if (item.link) {
      const kind = { 'exact-event': '直接引用该事件', 'captured-interest-source': '当时兴趣依据含该事件', 'topic-only': '仅主题相关，不能确认该事件影响' }[item.link.kind] || '关联程度未知';
      paragraph(box, `${kind} · ${item.link.usage === 'selected' ? '被念头选用' : '仅进入规划输入'}`, 'hint');
    }
    paragraph(box, item.basisStatus === 'captured' ? '已保存当时提供给规划的状态依据。引用不代表唯一原因。' : '旧记录未保存当时状态，无法确认当时强度或完整输入。', 'hint');
    if (item.offeredRefs?.length) paragraph(box, `当时可用引用：${item.offeredRefs.join('、')}`, 'ref');
    if (item.basis) {
      paragraph(box, `依据时刻 ${time(item.basis.at)} · 状态版本 ${item.basis.stateVersion || '未知'}`, 'hint');
      for (const interest of item.basis.interests || []) paragraph(box, `${interest.ref} 当时强度 ${number(interest.strength)}；来源 ${(interest.sourceRefs || []).join('、') || '无'}`, 'ref');
      if (item.basis.mood) paragraph(box, `当时情绪：愉悦 ${number(item.basis.mood.valence)} / 精力 ${number(item.basis.mood.energy)} / 紧张 ${number(item.basis.mood.tension)}`, 'hint');
    }
    if (!item.plans?.length) paragraph(box, '尚无关联活动计划。', 'hint');
    for (const plan of item.plans || []) {
      paragraph(box, `${plan.title || '关联活动'} · ${statusLabels[plan.status] || plan.status || '状态未知'}`);
      if (plan.startedAt != null) paragraph(box, `开始 ${time(plan.startedAt)}`, 'hint');
      if (plan.endedAt != null) paragraph(box, `结束 ${time(plan.endedAt)}`, 'hint');
      paragraph(box, `计划：${plan.id}；记录：${(plan.eventRefs || []).join('、') || '尚无'}`, 'ref');
    }
    parent.append(box);
  }
}
function renderInterests(report) {
  const list = el('interests'); list.replaceChildren();
  if (!report.interests?.length) return empty(list, report.completeness.status === 'complete' ? '所选范围内没有可显示的兴趣变化；没有新兴趣也很正常。' : '当前资料不足，暂不显示兴趣数值。');
  for (const item of report.interests) {
    const details = node('details', null, 'interest'), summary = node('summary');
    summary.append(node('span', item.label || item.topic, 'interest-title'));
    const strength = node('div', `${number(item.startStrength)} → ${number(item.endStrength)}`, 'strength');
    const meter = node('div', null, 'meter'), fill = node('span');
    fill.style.width = `${Math.max(0, Math.min(1, Number(item.endStrength) || 0)) * 100}%`; meter.append(fill); strength.append(meter); summary.append(strength);
    const change = node('span', delta(item.netDelta), `delta ${item.direction}`); change.append(node('small', '净变化')); summary.append(change, node('span', '展开依据 ↓', 'unit'));
    const content = node('div', null, 'detail-content');
    paragraph(content, `经历实际影响 ${delta(item.eventDelta)} · 自然衰减 ${delta(item.decayDelta)} = 净变化 ${delta(item.netDelta)}（内部强度单位）`, 'math');
    if (!item.changes?.length) paragraph(content, '此窗口没有已发生的兴趣增量；变化可能仅来自自然衰减。', 'hint');
    for (const change of item.changes || []) {
      const evidence = node('div', null, 'evidence-card');
      paragraph(evidence, `${time(change.at)} · ${modeLabel(change.mode)}`);
      if (change.recordedAt !== change.at) paragraph(evidence, `入账时间 ${time(change.recordedAt)}`, 'hint');
      paragraph(evidence, `${number(change.before)} → ${number(change.after)}；实际 ${delta(change.actualDelta)}，原始增量 ${delta(change.requestedDelta)}`);
      const source = node('a', `查看来源记录：${change.ref}`, 'ref'); source.href = '#' + encodeURIComponent(change.ref); evidence.append(source);
      relations(evidence, change.relations); content.append(evidence);
    }
    if (item.relations?.length) { paragraph(content, '后续引用与活动状态', 'hint'); relations(content, item.relations); }
    details.append(summary, content); list.append(details);
  }
}
function renderEvents(report) {
  const list = el('events'); list.replaceChildren();
  el('eventCount').textContent = report.completeness.status === 'complete' ? `${report.events.length} 条可见记录` : '数据暂不可用';
  if (!report.events?.length) return empty(list, report.completeness.status === 'complete' ? '这个范围内没有已提交的公共事件。空白无需补演。' : '记录尚不可用；未启用或来源异常不计作零条。');
  for (const item of report.events) {
    const event = node('article', null, 'event'), date = node('time', time(item.at)); event.id = item.ref;
    if (Number.isFinite(item.at)) date.dateTime = new Date(item.at).toISOString(); event.append(date);
    const body = node('div'), top = node('div', null, 'event-top');
    top.append(node('h3', item.title || typeLabels[item.type] || '生活事件'), node('span', modeLabel(item.mode), 'badge neutral'));
    body.append(top);
    paragraph(body, `${typeLabels[item.type] || item.type} · ${statusLabels[item.result] || item.result || '已记录'}`, 'hint');
    if (item.summary) paragraph(body, item.summary);
    if (item.observedAt != null && item.observedAt !== item.at) paragraph(body, `实际观察 ${time(item.observedAt)}；本条上方为入账时间。`, 'hint');
    const details = node('details'); details.append(node('summary', '来源与后续关联'));
    paragraph(details, `记录：${item.ref}`, 'ref');
    if (item.source) paragraph(details, `来源：${item.source.kind || '未知'}${item.source.ref ? ' · ' + item.source.ref : ''}`, 'ref');
    if (item.evidence) paragraph(details, `外部依据：${item.evidence.source?.kind || '已记录'} · ${item.evidence.ref}`, 'ref');
    relations(details, item.relations); body.append(details); event.append(body); list.append(event);
  }
}
function renderOperations(operations) {
  const parent = el('operations'); parent.replaceChildren();
  if (!operations || !Object.keys(operations).length) return empty(parent, '尚无运行诊断。');
  const names = { planner: '日常生活规划', browsing: '自主浏览', proactive: '主动联系', learning: '表达学习', contacts: '主动联系冷却' };
  const reasons = { 'no-new-facts': '没有新事实，无需重复模型判断', declined: '这次没有浏览意愿', scheduled: '等待自己选定的时间',
    'browser-busy': '浏览器正在使用或登录中', 'browser-disabled': '浏览未启用', 'life-busy': '当前活动忙碌，等空闲再看',
    completed: '已取得真实浏览记录', 'no-reading': '没有可核实的浏览成果', 'reading-failed': '本次阅读失败',
    'decision-failed': '本次意愿判断失败', 'existing-plans': '已有普通生活计划', waiting: '等待下次日常规划',
    'contact-no-candidate': '当前没有适合主动联系的对象', 'contact-declined': '这次不想主动联系', 'contact-sent': '主动联系已送达',
    'contact-not-sent': '本次没有发送', 'contact-send-uncertain': '发送结果未知', 'current-boundary': '当前认真或停止要求优先',
    'proactive-paused': '最近判断时主动联系处于冷却期', 'no-relevant-learning': '没有适用的交流经验',
    'reserved-until-delivery': '表达已参考，送达后再记录使用', selected: '已记录表达使用', 'stale-selection': '来源已变化，未记录旧表达',
    'source-unavailable': '来源暂不可用', 'storage-unavailable': '当前状态暂不可写', cancelled: '旧意向已失效', 'driver-failed': '运行失败，需检查日志' };
  for (const [name, item] of Object.entries(operations)) {
    const row = node('div', null, 'evidence-card'); paragraph(row, names[name] || name);
    if (item.enabled === false) paragraph(row, '未启用', 'hint');
    else if (item.closed || item.stopped) paragraph(row, '已停止', 'hint');
    if (name === 'contacts') paragraph(row, `已知联系人：${item.total ?? '未知'}。当前冷却对象与截止时间见下方。`);
    const reason = item.lastResult || item.lastContextReason || item.lastDecision;
    if (reason) paragraph(row, reasons[reason] || `状态：${reason}`);
    if (item.lastDecision && item.lastDecision !== reason) paragraph(row, `最近决定：${reasons[item.lastDecision] || item.lastDecision}`, 'hint');
    if (item.lastError) paragraph(row, `最近错误：${item.lastError}`, 'hint');
    if (Number.isFinite(item.lastAttemptAt)) paragraph(row, `最近尝试 ${time(item.lastAttemptAt)}`, 'hint');
    if (Number.isFinite(item.lastContextAt)) paragraph(row, `最近参考判断 ${time(item.lastContextAt)}`, 'hint');
    if (Number.isFinite(item.nextAt)) paragraph(row, `普通规划下次可考虑 ${time(item.nextAt)}`, 'hint');
    if (Number.isFinite(item.queued)) paragraph(row, `待执行浏览意向 ${item.queued}`, 'hint');
    if (item.failed || item.degraded) paragraph(row, `局部状态待维护${item.warningCount ? `（${item.warningCount} 项）` : ''}`, 'hint');
    parent.append(row);
  }
}
function contactScopeKind(item) {
  if (!item || typeof item.userId !== 'string' || typeof item.scope !== 'string' || item.scope.length > 160) return null;
  if (/^[1-9]\d{0,127}$/.test(item.userId) && item.scope === `qq:private:${item.userId}`) return 'legacy';
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(item.userId)
    && item.scope === `private:user:${item.userId}`) return 'web';
  return null;
}
function renderContactPauses(value) {
  const sources = { 'explicit-rule': '明确停扰规则', 'contextual-model': '模型结合上下文判断', 'legacy-unknown': '历史依据不完整' };
  const evidenceStates = new Set(['recorded', 'legacy-unavailable', 'removed-by-memory-reset']);
  if (!value || !Array.isArray(value.contacts) || !Number.isFinite(value.at)
    || value.contacts.some(item => !contactScopeKind(item)
      || !Object.hasOwn(sources, item.source) || !evidenceStates.has(item.evidenceStatus)
      || (item.pausedAt !== null && !Number.isFinite(item.pausedAt))
      || !Number.isFinite(item.expiresAt)
      || (item.evidenceStatus === 'recorded' && (typeof item.evidence !== 'string' || !item.evidence.trim())))) {
    throw Error('当前冷却记录格式不完整');
  }
  clearContactPauseView();
  contactPauseView = value; contactPauseStartedAt = performance.now();
  paintContactPauses();
}
function clearContactPauseView() {
  if (contactPauseTimer !== null) clearTimeout(contactPauseTimer);
  contactPauseTimer = null; contactPauseView = null;
}
function paintContactPauses() {
  const value = contactPauseView;
  if (!value) return;
  // Count from the server snapshot with monotonic elapsed time. Browser clock
  // settings do not prolong a two-hour boundary or produce negative time.
  const at = value.at + Math.max(0, performance.now() - contactPauseStartedAt);
  const active = value.contacts.filter(item => item.expiresAt > at);
  const sources = { 'explicit-rule': '明确停扰规则', 'contextual-model': '模型结合上下文判断', 'legacy-unknown': '历史依据不完整' };
  const parent = el('contactPauses'); parent.replaceChildren();
  el('contactPausesCount').textContent = `${active.length} 人冷却中`;
  if (!value.contacts.length) empty(parent, '当前无人处于两小时主动联系冷却期。');
  const reasons = { 'same-turn-contextual-impatience': '模型将当时本人话语结合上下文判断为明显不耐烦或要求收手。',
    'contextual-impatience': '结合上下文判断为明显不耐烦或要求收手。',
    'explicit-stop': '本人话语命中了明确停止联系的规则。',
    'removed-by-memory-reset': '触发记录的原始内容已随记忆清理移除。',
    'removed-by-maintenance': '历史记录已整理，原始判断详情不可用。' };
  for (const item of value.contacts) {
    const remaining = Math.max(0, item.expiresAt - at), cooling = remaining > 0;
    const card = node('article', null, 'contact-pause'), heading = node('div', null, 'event-top');
    heading.append(node('h3', `私聊对象 ${item.userId}`), node('span', cooling ? '冷却中' : '冷却已结束', cooling ? 'badge warning' : 'badge neutral')); card.append(heading);
    if (contactScopeKind(item) === 'legacy') paragraph(card, '资料来源：旧 QQ 身份', 'hint');
    paragraph(card, `判断来源：${sources[item.source]}`, 'hint');
    paragraph(card, item.pausedAt === null ? '冷却起点：历史记录未保留' : `冷却起点：${time(item.pausedAt)}（北京时间）`, 'hint');
    paragraph(card, `截止时间：${time(item.expiresAt)}（北京时间）`);
    if (cooling) {
      const minutes = Math.ceil(remaining / 60000), hours = Math.floor(minutes / 60), rest = minutes % 60;
      const duration = remaining < 60000 ? '不足 1 分钟' : hours ? `${hours} 小时${rest ? ` ${rest} 分钟` : ''}` : `${minutes} 分钟`;
      paragraph(card, `${remaining < 60000 ? '剩余' : '剩余约 '}${duration}（据服务器读取时刻计时）`, 'hint');
    } else paragraph(card, '本次冷却已到期，自动恢复主动联系资格；不代表会立即发消息。', 'hint');
    paragraph(card, '触发原话', 'hint');
    if (item.evidenceStatus === 'recorded') card.append(node('blockquote', item.evidence, 'pause-evidence'));
    else paragraph(card, item.evidenceStatus === 'removed-by-memory-reset'
      ? '原话已随记忆清理移除，无法还原。' : '旧记录未保存原话，无法还原。', 'hint');
    const reason = reasons[item.reason] || reasons[item.basis] || item.reason;
    if (reason) paragraph(card, `判定原因：${reason}`);
    else paragraph(card, item.source === 'explicit-rule' ? '判定原因：命中本人明确要求停止联系的规则。'
      : item.source === 'contextual-model' ? '判定原因：当时模型判断应停止打扰。' : '判定原因：历史记录未保留完整依据。', 'hint');
    parent.append(card);
  }
  paragraph(parent, `状态读取于 ${time(value.at)}（北京时间）`, 'hint');
  if (active.length) contactPauseTimer = setTimeout(paintContactPauses,
    Math.max(1, Math.min(60000, ...active.map(item => item.expiresAt - at))));
}
function contactPausesFailure() {
  clearContactPauseView();
  el('contactPausesCount').textContent = '状态未知';
  el('contactPauses').replaceChildren(node('p', '冷却记录读取失败，无法判断当前受限人数或触发依据。请刷新重试。', 'empty pause-error'));
}
function render(report) {
  const complete = report.completeness.status === 'complete';
  el('thoughtCount').textContent = Number.isFinite(report.counts.newThoughts) ? report.counts.newThoughts : '—';
  el('activityCount').textContent = Number.isFinite(report.counts.completedActivities) ? report.counts.completedActivities : '—';
  el('completeness').textContent = complete ? '来源完整' : report.completeness.status === 'disabled' ? '生活尚未启用' : '来源待核查';
  el('completeness').className = `badge ${complete ? '' : 'warning'}`;
  el('window').textContent = `${time(report.window.startAt)} — ${time(report.window.cutoffAt)}（北京时间）`;
  el('cutoff').textContent = `统计截止 ${time(report.window.cutoffAt)} · 报告生成 ${time(report.generatedAt)}`;
  el('snapshot').textContent = `快照 ${report.snapshot?.revision?.slice(0, 12) ?? '未知'} · ${report.version}`;
  el('message').className = 'message';
  el('message').textContent = reasonLabels[report.completeness.reason] || (complete ? '已读取公共生活记录；所有统计和事件来自同一快照。' : '没有把未知状态当作零。');
  const warnings = report.completeness.warnings || [];
  if (warnings.length) el('message').textContent += ` ${warnings.join('；')}`;
  renderOperations(report.operations); renderInterests(report); renderEvents(report);
  el('notes').textContent = (report.notes || []).join(' ');
  el('download').disabled = report.window.days !== 1;
  el('exportHint').textContent = report.window.days === 1 ? '导出当前快照，不重新读取或生成。' : '选择一天后，可导出当前报告。';
}
async function get(path, headers) {
  const response = await fetch(path, { headers: { 'x-life-observer-client': 'developer', ...headers }, cache: 'no-store', credentials: 'same-origin' });
  const value = await response.json(); if (!response.ok) throw Error(value.error || '读取失败'); return value;
}
function reportFailure(error) {
  currentReport = null;
  el('message').textContent = error.message; el('message').className = 'message error';
  el('thoughtCount').textContent = '—'; el('activityCount').textContent = '—'; el('completeness').textContent = '读取失败'; el('completeness').className = 'badge warning';
  el('window').textContent = '—'; el('cutoff').textContent = '—'; el('snapshot').textContent = ''; el('notes').textContent = ''; el('eventCount').textContent = '';
  el('download').disabled = true;
  empty(el('interests'), '暂不显示旧快照，请重试读取。'); empty(el('events'), '暂不显示旧快照，请重试读取。');
  empty(el('operations'), '暂不显示旧诊断，请重试读取。');
}
async function refresh() {
  if (loading) return; loading = true; el('refresh').disabled = true; el('download').disabled = true;
  el('range').disabled = true; el('date').disabled = true;
  el('message').textContent = '正在读取生活记录…'; el('message').className = 'message';
  clearContactPauseView();
  el('contactPausesCount').textContent = '正在读取'; empty(el('contactPauses'), '正在读取主动联系冷却记录…');
  try {
    if (!token) token = (await get('/api/life-observer/session')).token;
    const days = el('range').value, query = new URLSearchParams({ days });
    if (days === '1') query.set('date', el('date').value);
    const headers = { 'x-life-observer-token': token };
    // Private pause evidence is kept out of currentReport and its export path.
    // Each source can succeed independently, so a failed report never masks a pause.
    const results = await Promise.allSettled([
      get('/api/life-observer/report?' + query, headers).then(report => { render(report); currentReport = report; }),
      get('/api/life-observer/contact-pauses', headers).then(renderContactPauses)
    ]);
    if (results[0].status === 'rejected') reportFailure(results[0].reason);
    if (results[1].status === 'rejected') contactPausesFailure();
    if (results.some(result => result.status === 'rejected')) token = null;
  } catch (error) {
    token = null; reportFailure(error); contactPausesFailure();
  } finally { loading = false; el('refresh').disabled = false; el('range').disabled = false; el('date').disabled = el('range').value !== '1'; }
}
el('date').value = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
el('date').max = el('date').value;
el('range').addEventListener('change', () => { el('date').disabled = el('range').value !== '1'; refresh(); });
el('date').addEventListener('change', refresh);
el('refresh').addEventListener('click', refresh);
el('download').addEventListener('click', () => {
  if (!currentReport || currentReport.window.days !== 1 || loading) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(currentReport, null, 2) + '\n'], { type: 'application/json' }));
  const link = node('a'); link.href = url; link.download = `zhiwei-life-${currentReport.window.date}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
});
refresh();
