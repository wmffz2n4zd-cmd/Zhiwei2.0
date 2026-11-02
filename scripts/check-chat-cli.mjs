import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodex, codexCommand, loadLocalConfig } from '../src/portable.js';
const root = fileURLToPath(new URL('..', import.meta.url)), config = loadLocalConfig(root);
const dir = join(root, 'runtime/tests/chat-cli'); await mkdir(dir, { recursive: true });
const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', join(root, 'workspaces/codex-cli'), '-o', join(dir, 'reply.txt')];
if (config.chatModel) args.push('-m', config.chatModel);
args.push('-c', 'model_reasoning_effort="low"', '-');
const invocation = codexCommand(resolveCodex(), args), env = { ...process.env };
if (config.codexProxy) { env.HTTP_PROXY = env.HTTPS_PROXY = config.codexProxy; env.NO_PROXY = 'localhost,127.0.0.1,::1'; }
const child = spawn(invocation.command, invocation.args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', b => { stdout = (stdout + b).slice(-64000); });
child.stderr.on('data', b => { stderr = (stderr + b).slice(-64000); });
child.stdin.on('error', () => {}); child.stdin.end('只输出 CHAT_CLI_OK，不要调用任何工具。');
const timeout = setTimeout(() => child.kill(), 120000);
const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); }); clearTimeout(timeout);
await writeFile(join(dir, 'stdout.jsonl'), stdout); await writeFile(join(dir, 'stderr.log'), stderr);
const errors = stdout.split('\n').flatMap(line => { try { const e = JSON.parse(line); return ['error','turn.failed'].includes(e.type) ? [e] : []; } catch { return []; } });
console.log(JSON.stringify({ code, errors, reply: code === 0 ? await readFile(join(dir, 'reply.txt'), 'utf8') : undefined,
  warningLines: stderr.split('\n').filter(line => /ERROR|WARN|plugin assets/.test(line)).slice(-5) }));
