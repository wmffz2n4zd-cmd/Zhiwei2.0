#!/usr/bin/env node
// Render a Linux systemd unit without installing it or starting a service.
// Optional: --service-env-file /absolute/path/to/zhiwei.env
import { readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), '..');

function validatePath(value, label) {
  if (typeof value !== 'string' || !posix.isAbsolute(value)) {
    throw Error(`${label} 必须是 Linux 绝对路径`);
  }
  if (/[\x00-\x1f\x7f]/.test(value)) throw Error(`${label} 路径不能包含控制字符`);
  if (value.split('/').includes('..')) throw Error(`${label} 路径不能包含 ..`);
}

// WorkingDirectory and EnvironmentFile use raw paths in systemd 255, rather
// than the word parser used by Environment and ExecStart. Quotes would become
// part of their filename. All four settings expand % specifiers.
// https://github.com/systemd/systemd/blob/v255/src/core/load-fragment.c
const escapeSpecifiers = value => value.replaceAll('%', '%%');
function rawPath(value, label) {
  validatePath(value, label);
  if (/[\s\\]$/.test(value)) throw Error(`${label} 路径不能以空白或反斜线结尾`);
  return escapeSpecifiers(value);
}

function quotedWord(value) {
  return '"' + escapeSpecifiers(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

export function renderUnit(template, { dir, user, home, node, envFile = posix.join(dir, 'deploy', 'zhiwei.env') }) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) throw Error(`用户名称不合法：${user}`);
  validatePath(home, 'HOME');
  validatePath(node, 'node');
  // systemd validates the decoded executable with string_is_safe(): quotes and
  // backslashes are rejected even when correctly escaped in the unit text.
  // https://github.com/systemd/systemd/blob/v255/src/basic/string-util.c
  if (/["'\\]/.test(node)) throw Error('node 可执行路径不能包含单引号、双引号或反斜线（systemd 限制）');
  if (node.endsWith('/')) throw Error('node 必须是可执行文件路径，不能以 / 结尾');
  const directory = rawPath(dir, '目录');
  const environmentFile = rawPath(envFile, '环境文件');
  // EnvironmentFile is also a glob expression. Reject ambiguous names rather
  // than load an unintended file or reinterpret a literal backslash.
  if (/[\\*?\[\]]/.test(envFile)) throw Error('环境文件路径不能包含反斜线或通配符');
  const values = {
    DIR: directory,
    USER: user,
    HOME_ENV: quotedWord(`HOME=${home}`),
    NODE: quotedWord(node),
    ENV_FILE: environmentFile
  };
  // A single pass keeps placeholder-looking text inside a path literal.
  return template.replace(/@(DIR|USER|HOME_ENV|NODE|ENV_FILE)@/g, (_, key) => values[key]);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--env-file')) throw Error('请改用 --service-env-file；--env-file 是 Node 自身的参数');
  const arg = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw Error(`--${name} 缺少参数值`);
    return value;
  };
  const dir = resolve(arg('dir', root));
  const currentUser = userInfo().username;
  const user = arg('user', process.env.SUDO_USER || currentUser);
  const home = arg('home', user === currentUser ? homedir() : `/home/${user}`);
  const node = resolve(arg('node', process.execPath));
  const envFile = resolve(arg('service-env-file', join(dir, 'deploy', 'zhiwei.env')));
  const out = resolve(arg('out', join(dir, 'deploy', 'zhiwei.service')));
  const template = await readFile(join(root, 'deploy', 'zhiwei.service.in'), 'utf8');
  const unit = renderUnit(template, { dir, user, home, node, envFile });
  await writeFile(out, unit);
  console.log(`已生成 ${out}`);
  console.log(`服务环境文件：${envFile}（可选；不会自动创建或覆盖）`);
  console.log('可参考 deploy/zhiwei.env.example 配置 CODEX_CLI_PATH、CODEX_HOME 与 PATH。');
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  console.log(`安装服务：
  sudo cp ${shellQuote(out)} /etc/systemd/system/zhiwei.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now zhiwei
  sudo systemctl status zhiwei`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main().catch(error => { console.error(`生成失败：${error.message}`); process.exitCode = 1; });
}
