import { spawn } from 'node:child_process';
import { proxyRequest, resolveProxyControl } from './proxy-control.js';
export { proxyRequest } from './proxy-control.js';
import { memoryScope } from './unified-memory/index.js';

const retiredInterestCommands = new Set(['兴趣', '兴趣测试', '兴趣添加', '兴趣删除']);

export const commandHelp = [
  '/开始聊天测试 /结束聊天测试（仅当前管理员私聊）',
  '/关机 → /确认关机；60 秒内可 /取消关机',
  '后台指令（不调用模型）：', '/状态 /开启QQ /关闭QQ',
  '/QQ模型 名称 /私聊模型 名称', '/QQ智能等级 low|medium|high|xhigh /私聊智能等级 同上',
  '/记忆 [关键词] /记住 内容 /交接 内容 /统一记忆状态',
  '/清除统一记忆 → /确认清除记忆', '/节点检查 /节点列表 /切换节点 节点名',
  '/脚本 /运行脚本 名称',
  '/浏览 网址或主题 /探索 /浏览状态 /留言板 小红书|X|其他网站',
  '任务：/执行 描述 → /确认；/取消；/技能；/清空任务记忆',
  '完全访问任务：/执行完全访问 描述 → /确认（需本机 allowFullAccessTasks=true）。',
  '本机任务使用已登录 Codex CLI；插件可用性以 CLI 实际配置为准。'
].join('\n');
export function isHubCommand(text) {
  const value = String(text).trim();
  // Recognize retired commands only to answer locally, never as chat prompts.
  if (value.startsWith('/') && retiredInterestCommands.has(value.slice(1).split(/\s+/, 1)[0])) return true;
  if (/^\/(浏览|探索|浏览状态|留言板)(?:\s|$)/.test(value)) return true;
  if (/^\/(开始聊天测试|结束聊天测试|关机|确认关机|取消关机)(?:\s|$)/.test(value)) return true;
  return /^\/(帮助|状态|开启QQ|关闭QQ|QQ模型|私聊模型|QQ智能等级|私聊智能等级|记忆|记住|交接|统一记忆状态|清除统一记忆|确认清除记忆|节点检查|节点列表|切换节点|脚本|运行脚本)(?:\s|$)/i.test(value);
}
export function runConfiguredScript(spec, cwd) {
  if (!spec?.command || !Array.isArray(spec.args) || spec.args.some(a => typeof a !== 'string')) throw Error('脚本需要配置固定 command 和 args 数组');
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.min(spec.timeoutMs || 30000, 120000));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output = (output + b).slice(-3000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(timedOut ? '脚本超时，已请求停止。' : `退出码 ${code}\n${output.trim()}`); });
  });
}
export class HubCommands {
  constructor({ config, state, memory, persist, saveSettings, workspace, world = null, now = Date.now, shutdown = async () => { throw Error('Service stop handler missing'); }, schedule = setTimeout, unschedule = clearTimeout }) {
    Object.assign(this, { config, state, memory, persist, saveSettings, workspace, now }); this.clearRequests = new Map();
    Object.assign(this, { shutdown, schedule, unschedule });
    this.chatTests = new Map(); this.shutdownRequests = new Map(); this.shutdownTimer = null;
    this.world = world;
  }
  testDecision(event) {
    if (!event.isOwner || event.type !== 'private_message' || /^\s*\//.test(event.text || '')) return null;
    try { memoryScope(event); } catch { return null; }
    if (this.chatTests.get(String(event.senderId)) !== 'chat') return null;
    return { ok: true, reason: 'Owner private chat test' };
  }
  async handle(event) {
    const text = String(event.text || '').trim();
    if (!isHubCommand(text)) return null;
    if (!event.isOwner || event.type !== 'private_message') return '后台指令仅允许管理员私聊使用。';
    let scope;
    try { scope = memoryScope(event); } catch { return '后台指令需要有效的管理员私聊对象。'; }
    const [command, ...parts] = text.slice(1).split(/\s+/); const arg = parts.join(' ');
    const sender = String(event.senderId);
    if (retiredInterestCommands.has(command)) return '旧兴趣评分指令已停用，私聊不再按话题分数筛选。';
    if (['浏览', '探索', '浏览状态', '留言板'].includes(command)) {
      if (!this.world) return '本机尚未启用图文浏览，需在 world.enabled 开启后重启后台。';
      if (command === '浏览状态') {
        const s = await this.world.status({ scope });
        const usage = s.limits.dailyEnforced === false
          ? `今日探索 ${s.usage.activities} 次，模型调用 ${s.usage.modelCalls} 次（仅记录用量，无每日额度上限）`
          : `今日探索 ${s.usage.activities}/${s.limits.activities} 次，模型调用 ${s.usage.modelCalls}/${s.limits.modelCalls} 次`;
        return `图文浏览：${s.busy ? '正在阅读' : s.browser.mode === 'login' ? '等待网页登录' : '就绪'}\n${usage}\n${s.last?.message || '还没有阅读记录'}\n本机管理页：http://127.0.0.1:${process.env.PORT || 3789}/world`;
      }
      if (command === '留言板') {
        const entries = await this.world.readBoards(arg || '小红书', { scope });
        return entries.slice(0, 3).map(n => `${n.title}\n${n.comment}\n${n.url}\n（仅本地保存）`).join('\n\n').slice(0, 3000) || '这个留言板还没有记录。';
      }
      if (command === '浏览' && !arg) return '格式：/浏览 网址或主题；也可以 /探索 让知微自己选择。';
      const result = await this.world.run(command === '探索' ? '' : arg, { scope });
      return result.message;
    }
    if (command === '开始聊天测试') {
      if (arg === '兴趣') return '兴趣筛选测试已停用；直接发送普通私聊即可。';
      if (arg) return '格式：/开始聊天测试';
      this.chatTests.set(sender, 'chat');
      return '当前私聊已开启普通聊天测试，可测试聊天、图片和表情包。发送 /结束聊天测试 恢复原来的私聊规则。服务重启后测试自动结束。';
    }
    if (command === '结束聊天测试') { this.chatTests.delete(sender); return '当前私聊测试已结束，恢复原来的私聊规则。'; }
    if (command === '关机') {
      this.shutdownRequests.set(sender, this.now() + 180000);
      return '将停止知微消息服务，不关闭电脑或 QQ 客户端。3 分钟内发送 /确认关机，确认后等待 60 秒停止，可用 /取消关机 撤销。停止后需要在电脑上重新启动知微。';
    }
    if (command === '取消关机') {
      this.shutdownRequests.delete(sender);
      if (this.shutdownTimer) this.unschedule(this.shutdownTimer);
      this.shutdownTimer = null;
      return '已取消本服务尚未执行的关机请求。';
    }
    if (command === '确认关机') {
      const expires = this.shutdownRequests.get(sender); this.shutdownRequests.delete(sender);
      if (!(expires > this.now())) return '没有有效的关机请求，请先发送 /关机。';
      if (this.shutdownTimer) return '已有关机倒计时，可发送 /取消关机。';
      this.shutdownTimer = this.schedule(() => {
        this.shutdownTimer = null;
        this.shutdown().catch(() => console.error('Zhiwei service stop failed.'));
      }, 60000);
      return '已确认，60 秒后停止知微消息服务，电脑继续运行。现在仍可发送 /取消关机。';
    }
    if (command === '帮助') return commandHelp;
    if (command === '状态') return `QQ：${this.state.channels.qq ? '开' : '关'}\n聊天范围：仅私聊，群聊已禁用\n默认模型：${this.state.ai.model} / ${this.state.ai.reasoningEffort}\n私聊模型：${this.config.privateChatModel || this.state.ai.model} / ${this.config.privateChatReasoningEffort || this.state.ai.reasoningEffort}\n任务权限：workspace-write\n统一记忆：按对象隔离，结合相关内容和近期对话召回；旧记录不因年龄直接失效，无必要线索可不注入，缺前文最多补查一次。`;
    if (/^(开启QQ|关闭QQ)$/i.test(command)) {
      this.state.channels.qq = /^开启/i.test(command); this.config.qqEnabled = this.state.channels.qq;
      await this.persist(); return `QQ 私聊响应已${this.state.channels.qq ? '开启' : '关闭'}；管理员私聊指令仍可使用。群聊继续禁用。`;
    }
    if (/^(QQ|私聊)(模型|智能等级)$/i.test(command)) {
      const privateChat = command.startsWith('私聊'), model = command.endsWith('模型');
      if (model ? !/^[A-Za-z0-9._:-]{1,100}$/.test(arg) : !['low', 'medium', 'high', 'xhigh'].includes(arg)) return '参数格式无效；发送 /帮助 查看格式。';
      this.config[privateChat ? (model ? 'privateChatModel' : 'privateChatReasoningEffort') : (model ? 'chatModel' : 'chatReasoningEffort')] = arg;
      if (!privateChat) this.state.ai[model ? 'model' : 'reasoningEffort'] = arg;
      await this.persist(); await this.saveSettings(); return `已设置${command}：${arg}。模型是否可用以账号实际权限为准。`;
    }
    if (command === '记忆') { const snapshot = await this.memory.read({ scope, query: arg }); return snapshot.entries.map(e => `[${e.tier}] ${e.summary}`).join('\n') || '当前私聊记忆为空。'; }
    if (command === '统一记忆状态') return JSON.stringify(await this.memory.status({ scope }));
    if (command === '记住' || command === '交接') {
      if (!arg) return `格式：/${command} 要保存的内容（后台直接保存，不调用模型）。`;
      await this.memory.write({ scope, type: command === '交接' ? 'handoff' : 'preference', source: 'qq-command', summary: arg }); return '已保存到当前管理员私聊记忆。';
    }
    if (command === '清除统一记忆') { this.clearRequests.set(scope, this.now() + 180000); return '将清除当前私聊的统一记忆；3 分钟内发送 /确认清除记忆。其他会话记忆不受影响。'; }
    if (command === '确认清除记忆') {
      const expires = this.clearRequests.get(scope); this.clearRequests.delete(scope);
      if (!(expires > this.now())) return '没有有效的记忆清除请求。';
      await this.memory.clear({ scope }); return '当前私聊统一记忆已清除。';
    }
    if (command === '脚本') return Object.keys(this.config.automationScripts || {}).join('\n') || '尚未配置自动化脚本。';
    if (command === '运行脚本') {
      if (!Object.hasOwn(this.config.automationScripts || {}, arg)) return '未知脚本；/脚本 查看列表。';
      return runConfiguredScript(this.config.automationScripts[arg], this.workspace);
    }
    if (command === '节点检查') {
      const control = await resolveProxyControl(this.config.proxyControl);
      const info = await proxyRequest(control, '/version'); return `代理接口在线：${info.version || '版本未知'}。此检查不切换节点。`;
    }
    if (command === '节点列表' || command === '切换节点') {
      const control = await resolveProxyControl(this.config.proxyControl), data = await proxyRequest(control, '/proxies');
      const group = data.proxies?.[control.group];
      if (!group || group.type !== 'Selector') return '请在 proxyControl.group 配置一个可手动选择的代理组。';
      if (command === '节点列表') return `当前：${group.now}\n${group.all.join('\n')}`.slice(0, 3000);
      if (!group.all.includes(arg)) return '节点名不存在，请先发送 /节点列表。';
      await proxyRequest(control, '/proxies/' + encodeURIComponent(control.group), { method: 'PUT', body: JSON.stringify({ name: arg }) });
      return `已切换代理组 ${control.group} 到 ${arg}。`;
    }
    return '请发送 /帮助 查看格式。';
  }
}

