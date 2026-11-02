#!/usr/bin/env node
// 本机状态探针：只读访问正在运行的 Hub，打印通道、生活与额度状态。
// 不修改配置、不发送消息、不触发模型调用。
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.ZHIWEI_URL || `http://127.0.0.1:${process.env.PORT || 3789}`;

async function get(path) {
  try {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return { data: await response.json() };
  } catch (error) { return { error: error.cause?.code || error.message }; }
}

const state = await get('/api/state');
if (state.error) {
  console.log(`无法连接 ${base}（${state.error}）。`);
  console.log('前台运行时确认终端没有报错；系统服务用：sudo systemctl status zhiwei');
  process.exitCode = 1;
} else {
  const s = state.data || {};
  console.log(base);
  console.log(`  QQ 通道    ：${s.channels?.qq ? '开启' : '关闭'}`);
  console.log(`  模型       ：${s.ai?.model || '(默认)'} / ${s.ai?.reasoningEffort || '(默认)'}`);
  console.log(`  QQ 事件    ：最近 ${s.qq?.recentEvents ?? 0} 条`);
  console.log(`  任务执行   ：${s.remoteExecution?.enabled ? (s.remoteExecution.busy ? '忙碌' : '空闲') : '未启用'}`);
  const quota = s.codex?.quota;
  if (quota && quota.available === false) console.log('  模型额度   ：不可读取（以 Codex 客户端显示为准）');
}

const platform = await get('/api/platform');
if (!platform.error) {
  const p = platform.data;
  console.log(`  平台       ：${p.platform}`);
  console.log(`  仅私聊     ：${p.qqPrivateOnly ? '是' : '否（不符合默认部署预期）'}`);
  console.log(`  生活时间线 ：${p.lifeEnabled ? '启用' : '关闭'}；生活规划：${p.lifePlanningEnabled ? '启用' : '关闭'}`);
  console.log(`  网页阅读   ：${p.worldEnabled ? '启用' : '关闭'}`);
  const budget = p.runtimeBudget || {};
  console.log(`  额度模式   ：${budget.mode || 'strict'}${budget.enforced === false ? '（只记录）' : '（会拦截）'}`);
  console.log(`  回调地址   ：${p.callback}（密钥${p.callbackSecretConfigured ? '已配置' : '未配置'}）`);
}

const observer = await get('/api/life-observer/session');
if (!observer.error && observer.data?.token) {
  console.log(`  观察台     ：${base}/life-observer.html?token=${String(observer.data.token).slice(0, 8)}…（完整令牌请从浏览器打开会话获取）`);
}

try { await readFile(join(root, 'data', 'local.json')); } catch {
  console.log('  提示       ：尚未生成 data/local.json，先运行 npm run setup');
}
