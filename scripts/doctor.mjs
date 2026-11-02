#!/usr/bin/env node
// 部署体检：只用本机信息判断“哪些能力真的可用”，不打印任何密钥内容。
// 退出码 0 表示全部就绪；1 表示至少一项待处理（服务仍可启动，只是对应能力不可用）。
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodex, codexCommand, loadLocalConfig, localConfigPath, discoverSkills } from '../src/portable.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let config = {};
let configError = null;
try { config = loadLocalConfig(root); } catch (error) { configError = error.message; }

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'OK  ' : 'TODO'} ${label}：${detail}`);
  if (!ok) failures++;
};

check('Node', Number(process.versions.node.split('.')[0]) >= 20, process.version);

const configPath = localConfigPath(root);
let mode = '';
try { mode = (statSync(configPath).mode & 0o777).toString(8); } catch { /* reported below */ }
check('关键配置', Boolean(configError) === false && Boolean(config.ownerUserIds?.length),
  configError || (config.ownerUserIds?.length ? `${configPath}（权限 ${mode || '未知'}）` : `${configPath} 不存在，先运行 npm run setup`));
if (mode && mode !== '600') console.log(`     提示：建议 chmod 600 ${configPath}（当前 ${mode}）`);

// Codex CLI 与登录状态。CLI 起不来时不再追问登录，避免把“未检查”说成“已过期”。
const cli = resolveCodex();
console.log(`     Codex 路径：${cli}`);
if (process.env.CODEX_CLI_PATH && process.env.CODEX_CLI_PATH !== cli) console.log('     提示：CODEX_CLI_PATH 已失效，已尝试自动发现可用安装。');
let cliReady = false;
for (const [label, args] of [['Codex CLI', ['--version']], ['Codex 登录', ['login', 'status']]]) {
  if (label === 'Codex 登录' && !cliReady) { console.log('     Codex 登录：未检查（先修复上面的 CLI 启动问题，这不代表登录已过期）'); continue; }
  try {
    const invocation = codexCommand(cli, args);
    const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', timeout: 15000 });
    const detail = result.error
      ? `进程启动/等待失败（${result.error.code || 'unknown'}）：${result.error.message}`
      : (result.stdout || result.stderr || `退出码 ${result.status}；信号 ${result.signal || '无'}`).trim().slice(-300);
    check(label, result.status === 0 && !result.error, detail);
    if (label === 'Codex CLI') cliReady = result.status === 0 && !result.error;
  } catch (error) { check(label, false, error.message); }
}

check('管理员 QQ', Boolean(config.ownerUserIds?.length), (config.ownerUserIds || []).join(', ') || '未配置');
check('OneBot 回调密钥', Boolean(config.oneBotSecret), config.oneBotSecret ? '已配置（未显示）' : '未配置，所有回调都会被 401 拒绝');
check('服务端访问令牌', Boolean(config.oneBotAccessToken), config.oneBotAccessToken ? '已配置（未显示）' : '未配置，无法调用 QQ 发送接口');

const life = config.life?.enabled === true;
const planning = life && config.life?.planning?.enabled === true;
const world = config.world?.enabled === true;
check('生活时间线', life, life ? '已启用' : '未启用（不会规划、不会主动联系）');
check('生活规划', planning, planning ? '已启用' : '未启用（需 life.enabled 与 life.planning.enabled）');
if (planning && !world) check('规划依赖', false, 'life.planning 需要 world.enabled=true，否则服务启动时会报错退出');
check('网页阅读', Boolean(config.world?.executablePath) || config.world?.channel === undefined,
  config.world?.executablePath ? config.world.executablePath : '未配置 world.executablePath，阅读会失败，规划不受影响');
if (config.world?.autoEnabled === true && planning) {
  console.log('     提示：生活规划已接管时间线，world.autoEnabled 在规划开启时不会启动旧浏览定时器。');
}
check('额度模式', config.runtimeBudget?.mode === 'observe', config.runtimeBudget?.mode === 'observe'
  ? 'observe（只记录，不拦截）' : 'strict（需要人工校准记录，否则每次模型调用都会被拒）');

const skills = discoverSkills(root, config);
console.log(`     可选自定义 Skill：${Object.keys(skills).length} 个（不安装也能正常使用）`);
console.log(`     任务工作目录：${config.workspace}`);

try {
  const response = await fetch((process.env.ONEBOT_API_BASE || config.oneBotApiBase || 'http://127.0.0.1:3000') + '/get_login_info', {
    headers: { Authorization: 'Bearer ' + (process.env.ONEBOT_ACCESS_TOKEN || config.oneBotAccessToken || '') },
    signal: AbortSignal.timeout(3000)
  });
  const body = await response.json();
  check('QQ 桥接器', response.ok && body.status === 'ok', body.data?.user_id ? `机器人 QQ ${body.data.user_id}` : '服务返回错误');
  if (body.data?.user_id && config.ownerUserIds?.includes(String(body.data.user_id))) {
    check('机器人账号', false, '机器人应登录另一个 QQ 号，由管理员账号向它发私聊');
  }
} catch { check('QQ 桥接器', false, '未启动或未登录（需要先启动 NapCat 并扫码）'); }

console.log(failures ? `\n共 ${failures} 项待处理。服务可以启动，但对应能力暂不可用。` : '\n全部就绪。');
process.exitCode = failures ? 1 : 0;
