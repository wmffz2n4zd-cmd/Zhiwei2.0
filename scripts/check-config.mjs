#!/usr/bin/env node
// 配置校验：不启动服务、不连接 QQ、不调用模型，只检查 data/local.json 是否自洽。
// 退出码 0 表示可用于启动；1 表示存在会阻止启动或让能力不可用的问题。
import { access } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalConfig, localConfigPath } from '../src/portable.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const warnings = [];
const notes = [];
const fail = (message) => problems.push(message);
const warn = (message) => warnings.push(message);

const path = localConfigPath(root);
let config;
try {
  config = loadLocalConfig(root);
} catch (error) {
  console.log(`配置无法读取：${path}`);
  console.log(`  ${error.message}`);
  process.exit(1);
}

const isQq = (value) => /^\d{5,20}$/.test(String(value ?? ''));
const isSecret = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);

const owners = Array.isArray(config.ownerUserIds) ? config.ownerUserIds : [];
if (owners.length === 0) fail('ownerUserIds 为空：没有任何账号能和她私聊');
for (const id of owners) if (!isQq(id)) fail(`ownerUserIds 里有非法 QQ 号：${id}`);
if (owners.length) notes.push(`管理员：${owners.join(', ')}`);

for (const key of ['oneBotSecret', 'oneBotAccessToken']) {
  const value = config[key] || process.env[key === 'oneBotSecret' ? 'ONEBOT_SECRET' : 'ONEBOT_ACCESS_TOKEN'];
  if (!value) fail(`${key} 未配置：OneBot 回调或发送会被拒绝`);
  else if (!isSecret(value)) warn(`${key} 不是 64 位十六进制；能工作，但不是 npm run setup 生成的格式`);
}

const life = config.life?.enabled === true;
const planning = life && config.life?.planning?.enabled === true;
const world = config.world?.enabled === true;
if (planning && !world) fail('life.planning.enabled=true 但 world.enabled!=true：服务启动时会直接退出');
if (!life) warn('生活时间线已关闭：只有聊天，没有念头、日程、情绪推进和主动联系');
if (life && !planning) warn('生活规划已关闭：时间线不会产生新的念头和日程');
if (planning && !config.world?.executablePath) {
  notes.push('网页阅读：未配置 world.executablePath，阅读会在需要时失败；规划与聊天不受影响');
} else if (world && config.world?.executablePath && !isAbsolute(config.world.executablePath)) {
  fail('world.executablePath 必须是绝对路径');
}

const mode = config.runtimeBudget?.mode;
if (mode === 'observe') notes.push('额度模式：observe（只记录，不拦截）');
else warn('额度模式不是 observe：strict 需要人工校准记录，否则每次模型调用都会被拒');

if (config.allowFullAccessTasks === true) warn('/执行完全访问 已开启：模型可以在工作目录之外读写和执行');
if (config.allowOtherPrivateChats === true) warn('allowOtherPrivateChats 已开启：任意陌生人都能和她私聊并写入各自的记忆');
if (config.qqPrivateOnly !== true) warn('qqPrivateOnly 应为 true；运行时会被强制为 true，但配置里写清楚更好');

if (config.assistantProfile) {
  const profile = resolve(root, config.assistantProfile);
  try { await access(profile); notes.push(`人格：${config.assistantProfile}`); }
  catch { fail(`人格文件不可读：${config.assistantProfile}（显式配置但读不到会阻止生成）`); }
} else {
  notes.push('人格：未配置，使用默认聊天行为');
}

try { await access(config.workspace); }
catch { warn(`工作目录不存在：${config.workspace}（首次 /执行 前会被创建，或现在 mkdir）`); }

console.log(`配置文件：${path}`);
for (const note of notes) console.log(`  说明  ${note}`);
for (const message of warnings) console.log(`  注意  ${message}`);
for (const message of problems) console.log(`  错误  ${message}`);

if (problems.length) {
  console.log(`\n${problems.length} 项错误需要修复后才能正常启动。`);
  process.exitCode = 1;
} else {
  console.log(warnings.length ? `\n配置本身可启动，但有 ${warnings.length} 项提醒。` : '\n配置检查通过。');
}
