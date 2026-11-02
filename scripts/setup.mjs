#!/usr/bin/env node
// 知微初始化：生成 data/local.json 与 NapCat 的 OneBot 连接配置。
//
// 设计原则：
//  1. 每个部署者生成自己的凭据，不存在共享默认密钥。
//  2. 已存在的配置永不静默覆盖；--force 会先写带时间戳的备份。
//  3. 缺少账号或桥接配置时只影响对应能力，不阻止服务启动。
//
// 用法：
//   npm run setup                              # 交互式
//   npm run setup -- --owner 123456 --bot 654321
//   npm run setup -- --owner 123 --bot 456 --print-only
//   npm run setup -- --owner 123 --bot 456 --force
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile, link } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(projectDir, 'data');
const configPath = join(dataDir, 'local.json');
const legacyPath = join(dataDir, 'windows.local.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const values = (name) => argv.flatMap((arg, index) => arg === `--${name}` ? [argv[index + 1]] : []);

function validateArguments() {
  const switches = new Set(['--help', '-h', '--no-life', '--print-only', '--force']);
  const options = new Set(['--owner', '--bot', '--name', '--workspace', '--napcat-dir', '--chromium', '--model', '--effort', '--qq-image-cache-root']);
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (switches.has(arg)) continue;
    if (!options.has(arg)) throw new Error(`未知参数：${arg}`);
    if (!argv[index + 1]?.trim() || argv[index + 1].startsWith('--')) throw new Error(`${arg} 后需要一个值`);
    if (arg !== '--qq-image-cache-root' && seen.has(arg)) throw new Error(`${arg} 不能重复指定`);
    seen.add(arg);
    index++;
  }
}

const isQq = (id) => /^\d{5,20}$/.test(String(id || ''));
const say = (text = '') => process.stdout.write(text + '\n');

function usage(code = 1) {
  say(`
知微初始化

  --owner <QQ号>        管理员（你自己）的 QQ 号，必填
  --bot   <QQ号>        机器人 QQ 号，必填，必须与管理员不同
  --name  <名称>        显示名称，默认 知微
  --workspace <路径>    /执行 任务的工作目录，默认 <安装目录>/workspaces/remote
  --napcat-dir <路径>   NapCat 配置目录；给出则同时写入 onebot11_<机器人>.json
  --qq-image-cache-root <路径>
                       允许读取的 QQ 图片缓存目录，可重复指定；未设则图片视觉不可用
  --chromium <路径>     Chromium/Chrome 可执行文件；不填则网页阅读不可用（生活规划不受影响）
  --no-life             关闭生活时间线（不推荐；默认开启）
  --print-only          只打印将要写入的配置，不落盘
  --force               覆盖已有配置；每个原文件先备份为 <文件名>.<时间戳>.bak

注意：密钥只写入本机配置及其备份（权限 600），不打印密钥内容。
`);
  process.exit(code);
}

export async function ask(question, fallback = '', { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(fallback ? `${question}（默认 ${fallback}）：` : `${question}：`)).trim();
    return answer || fallback;
  } finally { rl.close(); }
}

async function pathInfo(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Check every destination before generating directories, backups or credentials.
// Never follow a symlink or truncate the original configuration in place.
async function inspectDestination(path) {
  const info = await pathInfo(path);
  if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error(`配置目标必须是普通文件，不能是符号链接：${path}`);
  let parent = dirname(path);
  for (;;) {
    const directory = await pathInfo(parent);
    if (directory && (directory.isSymbolicLink() || !directory.isDirectory())) throw new Error(`配置父目录必须是实际目录，不能是符号链接：${parent}`);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return { path, original: info ? await readFile(path) : null };
}

async function assertUnchanged(target) {
  const current = await inspectDestination(target.path);
  if (target.original === null ? current.original !== null : current.original === null || !current.original.equals(target.original)) {
    throw new Error(`配置在初始化过程中已变化，停止写入：${target.path}`);
  }
}

async function writeConfigurations(targets) {
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
  const staged = [];
  try {
    // Finish all staging and backups before replacing either live file.
    for (const target of targets) {
      await assertUnchanged(target);
      await mkdir(dirname(target.path), { recursive: true });
      const temporary = `${target.path}.${stamp}.tmp`;
      await writeFile(temporary, target.text, { flag: 'wx', mode: 0o600 });
      staged.push({ ...target, temporary });
      await chmod(temporary, 0o600);
    }
    for (const target of staged) {
      await assertUnchanged(target);
      if (target.original !== null) {
        const backup = `${target.path}.${stamp}.bak`;
        await writeFile(backup, target.original, { flag: 'wx', mode: 0o600 });
        await chmod(backup, 0o600);
        say(`已备份原配置 → ${backup}`);
      }
    }
    for (const target of staged) {
      await assertUnchanged(target);
      if (target.original === null) {
        // An exclusive link also catches a new file created after preflight.
        await link(target.temporary, target.path);
        await unlink(target.temporary);
      } else {
        await rename(target.temporary, target.path);
      }
      say(`✓ 已写入 ${target.path}（权限 600）`);
    }
  } finally {
    for (const { temporary } of staged) {
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

async function main() {
  validateArguments();
  if (flag('help') || argv.includes('-h')) usage(0);

  let owner = value('owner');
  let bot = value('bot');
  let name = value('name');
  let workspace = value('workspace');
  let napcatDir = value('napcat-dir');
  const imageRoots = values('qq-image-cache-root');
  const chromium = value('chromium');
  const printOnly = flag('print-only');

  if (!printOnly && process.stdin.isTTY && (!owner || !bot)) {
    say('首次部署需要两项信息。机器人 QQ 必须与管理员 QQ 不同，两者需已互加好友。');
    owner = owner || await ask('管理员 QQ 号');
    bot = bot || await ask('机器人 QQ 号');
    name = name || await ask('显示名称', '知微');
    if (!napcatDir) {
      const answer = await ask('NapCat 配置目录（留空则跳过自动生成桥接配置）', '');
      napcatDir = answer || undefined;
    }
    if (imageRoots.length === 0) {
      for (;;) {
        const answer = await ask('QQ 图片缓存目录（可逐项输入；留空结束，未设时图片视觉不可用）');
        if (!answer) break;
        imageRoots.push(answer);
      }
    }
  }

  if (!isQq(owner)) { say(`✗ 管理员 QQ 号无效：${owner || '(缺失)'}`); usage(); }
  if (!isQq(bot)) { say(`✗ 机器人 QQ 号无效：${bot || '(缺失)'}`); usage(); }
  if (String(owner) === String(bot)) { say('✗ 机器人 QQ 号必须与管理员不同'); usage(); }

  name = name || '知微';
  const model = value('model') || '';
  const effort = value('effort') || 'low';
  const qqImageCacheRoots = [...new Set(imageRoots.map((path) => resolve(path)))];
  for (const path of qqImageCacheRoots) {
    if (path === parse(path).root) throw new Error('QQ 图片缓存白名单不能包含整个文件系统根目录');
    const info = await pathInfo(path);
    if (info && !info.isDirectory()) throw new Error(`QQ 图片缓存路径不是实际目录：${path}`);
  }

  const bridgePath = napcatDir ? join(resolve(napcatDir), `onebot11_${bot}.json`) : null;
  let destinations = [];
  let legacyWillBeShadowed = false;
  if (!printOnly) {
    destinations = await Promise.all([configPath, ...(bridgePath ? [bridgePath] : [])].map(inspectDestination));
    legacyWillBeShadowed = destinations[0].original === null && (await pathInfo(legacyPath)) !== null;
    if (legacyWillBeShadowed && !flag('force')) {
      say(`正在使用旧配置 ${legacyPath}，未写入任何配置。`);
      say('请编辑现有配置；如需另行初始化，请显式加 --force，新 local.json 将优先，旧文件原件保持不变。');
      process.exitCode = 2;
      return;
    }
    const existing = destinations.filter((target) => target.original !== null);
    if (existing.length && !flag('force')) {
      say(`配置已存在，未写入任何配置：${existing.map((target) => target.path).join('、')}`);
      say('如需覆盖，请加 --force（先备份每个原文件），或直接编辑现有配置。');
      process.exitCode = 2;
      return;
    }
    if (legacyWillBeShadowed) {
      say(`已指定 --force：新 local.json 将优先使用；保留旧配置原件 ${legacyPath}，不会自动迁移其中设置。`);
    }
  }

  const secret = randomBytes(32).toString('hex');
  const accessToken = randomBytes(32).toString('hex');
  const workspacePath = resolve(workspace || join(projectDir, 'workspaces', 'remote'));

  const config = {
    version: 1,
    assistantName: name,
    assistantProfile: 'config/zhiwei-profile.md',
    ownerUserIds: [String(owner)],
    botUserId: String(bot),
    allowOtherPrivateChats: false,
    qqPrivateOnly: true,
    qqEnabled: true,
    remoteEnabled: true,
    allowFullAccessTasks: false,
    oneBotApiBase: process.env.ONEBOT_API_BASE || 'http://127.0.0.1:3000',
    oneBotSecret: secret,
    oneBotAccessToken: accessToken,
    workspace: workspacePath,
    chatModel: model,
    chatReasoningEffort: effort,
    qqImageCacheRoots,
    desktopRecall: { enabled: false, workspaceRoots: [] },
    automationScripts: {},
    mood: { enabled: true },
    life: {
      enabled: !flag('no-life'),
      planning: { enabled: !flag('no-life') }
    },
    world: {
      // 生活规划复用 world 的受限模型与预算入口，因此 world 必须启用；
      // 真正的网页阅读还需要 executablePath 指向 Chromium。
      enabled: true,
      autoEnabled: false,
      channel: 'chromium',
      executablePath: chromium || '',
      headless: true,
      maxSteps: 4
    },
    runtimeBudget: { mode: 'observe' }
  };

  const napcat = {
    network: {
      httpServers: [{
        name: 'zhiwei-hub-api', enable: true, host: '127.0.0.1', port: 3000,
        token: accessToken, messagePostFormat: 'array', enableCors: false, enableWebsocket: false
      }],
      httpClients: [{
        name: 'zhiwei-hub-events', enable: true, url: 'http://127.0.0.1:3789/api/onebot/event',
        token: secret, messagePostFormat: 'array', reportSelfMessage: false
      }],
      websocketServers: [], websocketClients: []
    }
  };

  const text = JSON.stringify(config, null, 2) + '\n';
  if (printOnly) {
    say('--- data/local.json（预览，未写入）---');
    say(text.replace(/"[0-9a-f]{64}"/g, '"<随机生成的 64 位十六进制密钥>"'));
    say('--- NapCat onebot11_<机器人QQ>.json（预览，未写入）---');
    say(JSON.stringify(napcat, null, 2).replace(/"[0-9a-f]{64}"/g, '"<同一密钥>"'));
    return;
  }

  await mkdir(dataDir, { recursive: true });
  await mkdir(join(projectDir, 'runtime', 'logs'), { recursive: true });
  await mkdir(join(projectDir, 'runtime', 'replies'), { recursive: true });
  await mkdir(join(projectDir, 'runtime', 'tests'), { recursive: true });
  await mkdir(workspacePath, { recursive: true });

  if (!legacyWillBeShadowed && existsSync(legacyPath)) {
    say('检测到旧文件名 data/windows.local.json：保留旧文件原件，data/local.json 继续优先。');
  }

  await writeConfigurations(destinations.map((target) => ({ ...target, text: target.path === configPath ? text : JSON.stringify(napcat, null, 2) + '\n' })));

  say(`
下一步：
  1) 启动 NapCat 并登录机器人 QQ ${bot}
     NapCat 需使用本配置里的 HTTP 服务端(3000) 与 HTTP 客户端(回调 /api/onebot/event)，
     或把上面生成的 onebot11_${bot}.json 放进 NapCat 的配置目录。
  2) 用管理员 QQ ${owner} 私聊机器人，先发 /帮助。
  3) 本机体检：npm run doctor
  4) 前台运行：npm start    （后台常驻见 deploy/README 的系统服务说明）
  ${config.life.enabled ? '' : '注意：生活时间线已按 --no-life 关闭。'}
  ${config.world.executablePath ? `网页阅读使用：${config.world.executablePath}` : '未配置 --chromium：生活规划正常，但网页阅读会在需要时明确失败，直到你填写 world.executablePath。'}
  ${qqImageCacheRoots.length ? `QQ 图片缓存白名单：${qqImageCacheRoots.join('、')}（目录需存在且服务用户可读）` : '未配置 QQ 图片缓存目录：图片/静态表情视觉不可用，文字聊天仍可用；请配置 --qq-image-cache-root 或 data/local.json 的 qqImageCacheRoots。'}
`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    say(`✗ 初始化失败：${error.message}`);
    process.exitCode = 1;
  });
}
