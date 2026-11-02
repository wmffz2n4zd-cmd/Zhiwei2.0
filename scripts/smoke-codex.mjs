#!/usr/bin/env node
// 真实 Codex 冒烟测试：确认 CLI 能用 workspace-write 在指定目录里写文件。
// 会消耗少量模型额度；不联网、不改其他文件。
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodex, codexCommand } from '../src/portable.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = join(root, 'runtime', 'tests', 'real-codex-smoke');
await mkdir(workspace, { recursive: true });
const output = join(workspace, 'result.txt');
const marker = join(workspace, 'smoke.txt');
await writeFile(marker, 'pending');

const invocation = codexCommand(resolveCodex(), ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'workspace-write', '-C', workspace, '-o', output, '-']);
const child = spawn(invocation.command, invocation.args, { cwd: workspace, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', b => { logs = (logs + b).slice(-6000); });
child.stderr.on('data', b => { logs = (logs + b).slice(-6000); });
const timer = setTimeout(() => child.kill(), 300000);
child.stdin.on('error', () => {});
child.stdin.end('这是最小验收测试。只把当前工作目录 smoke.txt 的内容改为 CODEX_SMOKE_OK，再读回确认。不要联网，不要做其他修改。最终只回复 CODEX_SMOKE_OK。');

const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
clearTimeout(timer);
await writeFile(join(workspace, 'smoke.log'), logs);

const actual = (await readFile(marker, 'utf8')).trim();
if (code !== 0 || actual !== 'CODEX_SMOKE_OK') {
  console.error('真实 CLI 测试失败，请查看 runtime/tests/real-codex-smoke/smoke.log');
  process.exitCode = 1;
} else {
  console.log('真实 Codex 验收通过：workspace-write 模式成功写入并读回 smoke.txt。');
}
