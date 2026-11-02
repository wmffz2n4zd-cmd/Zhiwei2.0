'use strict';
const el = id => document.getElementById(id);
let token = null, currentReport = null, loading = false;
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
  renderInterests(report); renderEvents(report);
  el('notes').textContent = (report.notes || []).join(' ');
  el('download').disabled = report.window.days !== 1;
  el('exportHint').textContent = report.window.days === 1 ? '导出当前快照，不重新读取或生成。' : '选择一天后，可导出当前报告。';
}
async function get(path, headers) {
  const response = await fetch(path, { headers: { 'x-life-observer-client': 'developer', ...headers }, cache: 'no-store', credentials: 'same-origin' });
  const value = await response.json(); if (!response.ok) throw Error(value.error || '读取失败'); return value;
}
async function refresh() {
  if (loading) return; loading = true; el('refresh').disabled = true; el('download').disabled = true;
  el('range').disabled = true; el('date').disabled = true;
  el('message').textContent = '正在读取生活记录…'; el('message').className = 'message';
  try {
    if (!token) token = (await get('/api/life-observer/session')).token;
    const days = el('range').value, query = new URLSearchParams({ days });
    if (days === '1') query.set('date', el('date').value);
    const report = await get('/api/life-observer/report?' + query, { 'x-life-observer-token': token });
    render(report); currentReport = report;
  } catch (error) {
    token = null; currentReport = null;
    el('message').textContent = error.message; el('message').className = 'message error';
    el('thoughtCount').textContent = '—'; el('activityCount').textContent = '—'; el('completeness').textContent = '读取失败'; el('completeness').className = 'badge warning';
    el('window').textContent = '—'; el('cutoff').textContent = '—'; el('snapshot').textContent = ''; el('notes').textContent = ''; el('eventCount').textContent = '';
    empty(el('interests'), '暂不显示旧快照，请重试读取。'); empty(el('events'), '暂不显示旧快照，请重试读取。');
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
