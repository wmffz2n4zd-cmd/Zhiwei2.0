import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const isMac = process.platform === 'darwin';
export const userHome = homedir();
export function resolveCodex(env = process.env, { platform = process.platform } = {}) {
  const executableFile = path => {
    try { const info = statSync(path); return info.isFile() && info.size > 0; } catch { return false; }
  };
  // Keep explicit valid paths (including JS shims) authoritative. A removed desktop
  // version must not prevent discovery after an app update.
  if (env.CODEX_CLI_PATH && executableFile(env.CODEX_CLI_PATH)) return env.CODEX_CLI_PATH;
  if (platform === 'darwin' && executableFile('/Applications/Codex.app/Contents/Resources/codex')) return '/Applications/Codex.app/Contents/Resources/codex';
  const windows = platform === 'win32';
  const names = windows ? ['codex.exe'] : ['codex'];
  const folders = (env.PATH || env.Path || '').split(windows ? ';' : delimiter).filter(Boolean);
  for (const folder of folders) {
    for (const name of names) if (executableFile(join(folder, name))) return join(folder, name);
  }
  // npm's .cmd shim cannot be spawned directly without a shell. Resolve its JS entry instead.
  if (windows) {
    for (const folder of folders) {
      const entry = join(folder, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (executableFile(entry)) return entry;
    }
    const local = env.LOCALAPPDATA || (env.USERPROFILE && join(env.USERPROFILE, 'AppData', 'Local'));
    if (local) {
      const bin = join(local, 'OpenAI', 'Codex', 'bin');
      const candidates = [];
      try {
        for (const entry of readdirSync(bin, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const directory = join(bin, entry.name), path = join(directory, 'codex.exe');
          if (executableFile(path)) candidates.push({ path, installedAt: statSync(directory).mtimeMs });
        }
      } catch { /* Missing/inaccessible installation; retain PATH fallback below. */ }
      // Hash names have no version ordering. The most recently installed complete
      // directory wins; an empty or missing executable from an update is skipped.
      candidates.sort((a, b) => b.installedAt - a.installedAt || a.path.localeCompare(b.path));
      if (candidates.length) return candidates[0].path;
      if (executableFile(join(bin, 'codex.exe'))) return join(bin, 'codex.exe');
    }
  }
  return windows ? 'codex.exe' : 'codex';
}
export function codexCommand(path, args) {
  if (/\.(cmd|bat)$/i.test(path)) {
    const entry = join(dirname(path), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!existsSync(entry)) throw new Error('请将 CODEX_CLI_PATH 指向 codex.exe 或 @openai/codex/bin/codex.js。');
    return { command: process.execPath, args: [entry, ...args] };
  }
  return /\.m?js$/i.test(path) ? { command: process.execPath, args: [path, ...args] } : { command: path, args };
}
// `data/local.json` is the documented deployment configuration. The historical
// `data/windows.local.json` name is still accepted when it is the only file
// present, so existing installations and test fixtures keep working.
export function localConfigPath(projectDir, env = process.env) {
  if (env.ZHIWEI_CONFIG) return isAbsolute(env.ZHIWEI_CONFIG) ? env.ZHIWEI_CONFIG : resolve(projectDir, env.ZHIWEI_CONFIG);
  const preferred = join(projectDir, 'data', 'local.json');
  const legacy = join(projectDir, 'data', 'windows.local.json');
  return !existsSync(preferred) && existsSync(legacy) ? legacy : preferred;
}
export function loadLocalConfig(projectDir) {
  const path = localConfigPath(projectDir);
  const config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (config.ownerUserIds && (!Array.isArray(config.ownerUserIds) || config.ownerUserIds.some(id => !/^\d{5,20}$/.test(String(id))))) throw new Error('ownerUserIds 必须是 QQ 号数组');
  const workspace = config.workspace || 'workspaces/remote';
  return { ...config, workspace: isAbsolute(workspace) ? workspace : resolve(projectDir, workspace) };
}
export function discoverSkills(projectDir, config = {}) {
  const result = {};
  const add = (key, folder) => {
    const path = join(folder, 'SKILL.md');
    if (existsSync(path)) result[key] = path;
  };
  const generated = join(config.workspace || resolve(projectDir, 'workspaces/remote'), 'skills');
  if (existsSync(generated)) for (const entry of readdirSync(generated, { withFileTypes: true })) {
    if (entry.isDirectory()) add(entry.name, join(generated, entry.name));
  }
  for (const [name, path] of Object.entries(config.skills || {})) result[name] = resolve(projectDir, path);
  return result;
}
// A removed optional selection must not block ordinary chat or select a
// different persona. Explicit task selections still use strict skillContext.
export function resolveChatSkill(skills, key) {
  return key && key !== 'none' && Object.hasOwn(skills, key) ? key : 'none';
}
export function skillContext(skills, key) {
  if (!key || key === 'none') return '';
  const path = skills[key];
  if (!path) throw new Error(`未知 Skill：${key}`);
  return `使用以下 Skill。相对引用以 ${dirname(path)} 为基准。人物视角是公开资料的提炼，不是真人。\n${readFileSync(path, 'utf8')}`;
}
export function validSignature(raw, signature, secret) {
  if (!secret || typeof signature !== 'string') return false;
  const expected = 'sha1=' + createHmac('sha1', secret).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Each owner has an independent pending task, conversation and selected Skill.
export class PrivateTasks {
  constructor({ run, skills, enabled, allowFullAccess = false, now = Date.now }) {
    this.allowFullAccess = allowFullAccess;
    this.run = run; this.skills = skills; this.enabled = enabled; this.now = now;
    this.users = new Map(); this.busy = false;
  }
  async handle(event) {
    const text = String(event.text || '').trim();
    const command = /^\/(执行|执行完全访问|远程执行|确认|取消|技能|帮助|清空任务记忆)(?:\s|$)/.test(text);
    if (!command) return null;
    if (!event.isOwner || event.type !== 'private_message') return '这些指令仅允许管理员私聊使用。';
    const id = String(event.senderId);
    if (!this.users.has(id)) this.users.set(id, { skill: 'none', pending: null, history: [] });
    const session = this.users.get(id);
    session.skill = resolveChatSkill(this.skills, session.skill);
    if (text === '/帮助' || text === '/远程执行') return '任务：/执行 任务描述 → /确认；/取消 撤销待确认任务；/技能 查看或选择自定义 Skill；/清空任务记忆 清除任务上下文。每个任务都需要确认，默认仅可写入指定工作目录。';
    if (text === '/取消') { session.pending = null; return '已取消待确认任务（已运行的任务不会中止）。'; }
    if (text === '/清空任务记忆') { session.history = []; return '已清空任务记忆。'; }
    if (text.startsWith('/技能')) {
      const key = text.slice(3).trim();
      if (!key) return `当前：${session.skill}\n可选：${['none', ...Object.keys(this.skills)].join('、')}\n发送 /技能 名称。自定义 Skill 可用于普通聊天及已确认的任务；none 使用默认人格。`;
      if (key !== 'none' && !Object.hasOwn(this.skills, key)) return '未知 Skill，请发 /技能 查看列表。';
      session.skill = key; return `已选择 ${key}。`;
    }
    if (!this.enabled) return '远程执行未启用。请先在本机完成管理员和 OneBot 回调密钥配置。';
    if (/^\/(执行|执行完全访问)\s/.test(text)) {
      const fullAccess = text.startsWith('/执行完全访问 ');
      if (fullAccess && !this.allowFullAccess) return '完全访问未在本机启用。普通任务请使用 /执行；本机 allowFullAccessTasks=true 后才接受完全访问任务。';
      if (this.busy) return '有任务正在执行，请完成后再提交。';
      const task = text.replace(/^\/(执行完全访问|执行)\s+/, '').trim();
      if (!task || task.length > 12000) return '任务不能为空，且不能超过 12000 字。';
      session.pending = { text: task, skill: session.skill, fullAccess, expires: this.now() + 180000 };
      return `待执行（Skill：${session.skill}；权限：${fullAccess ? '完全访问，可修改工作区外文件和访问网络' : '工作目录写入'}）：\n${task}\n请在 3 分钟内发送 /确认，或 /取消。`;
    }
    if (text === '/确认') {
      const task = session.pending;
      if (!task || task.expires <= this.now()) { session.pending = null; return '没有有效的待确认任务，请重新发送 /执行 任务描述。'; }
      if (resolveChatSkill(this.skills, task.skill) !== task.skill) {
        session.pending = null;
        return '待确认任务所选的 Skill 已不可用，请重新选择并提交任务。';
      }
      if (this.busy) return '有任务正在执行，请稍后确认。';
      this.busy = true; session.pending = null;
      try {
        const reply = await this.run(task.text, task.skill, [...session.history], { ...event, fullAccess: task.fullAccess });
        session.history.push({ task: task.text, reply });
        session.history = session.history.slice(-6);
        return reply;
      } finally { this.busy = false; }
    }
    return '请发送 /帮助 查看指令格式。';
  }
  chatSkill(event) {
    if (!event.isOwner || event.type !== 'private_message') return null;
    const session = this.users.get(String(event.senderId));
    if (!session) return null;
    session.skill = resolveChatSkill(this.skills, session.skill);
    return session.skill;
  }
}
