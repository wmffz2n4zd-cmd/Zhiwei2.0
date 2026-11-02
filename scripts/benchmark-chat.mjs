import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodex, codexCommand, loadLocalConfig } from '../src/portable.js';
import { runCliProcess } from '../src/cli-process.js';
import { assertProxyReachable } from '../src/proxy-control.js';
import { classifyCliFailure } from '../src/cli-errors.js';

// Deliberately uses a synthetic prompt. Does not start the bot or send QQ messages.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadLocalConfig(root), directory = join(root, 'runtime', 'tests', 'chat-benchmark');
await mkdir(directory, { recursive: true });
await assertProxyReachable(config.codexProxy);
const env = { ...process.env };
if (config.codexProxy) Object.assign(env, { HTTP_PROXY: config.codexProxy, HTTPS_PROXY: config.codexProxy, NO_PROXY: 'localhost,127.0.0.1,::1' });
const reports = [];
for (const fast of process.argv.includes('--fast-only') ? [true] : [false, true]) {
  const label = fast ? 'no-analytics' : 'current-config';
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-m', config.chatModel || 'gpt-6.1-sol',
    '-c', 'model_reasoning_effort="low"', '-C', directory,
    ...(fast ? ['-c', 'analytics.enabled=false'] : []), '-'];
  let exit;
  const exited = new Promise(resolve => { exit = resolve; });
  try {
    const result = await runCliProcess({ ...codexCommand(resolveCodex(), args), cwd: directory, env,
      input: '这是本地软件延迟测试。不要使用工具，不要联网。请只用中文回复：测试收到。',
      timeout: 120000, earlyReply: true, cleanupMs: 60000,
      onExit: metrics => { exit(metrics); } });
    console.log(JSON.stringify({ label, phase: 'reply-ready', ...result.cliTiming, hasReply: Boolean(result.replyText) }));
    const metrics = await exited;
    reports.push({ label, ...metrics });
    console.log(JSON.stringify({ label, phase: 'process-exit', ...metrics }));
  } catch (error) {
    reports.push({ label, failed: true, code: error.code, reason: classifyCliFailure(error.stdout, error.stderr) });
    await writeFile(join(directory, `failure-${Date.now()}.json`), JSON.stringify({ stdout: error.stdout, stderr: error.stderr }, null, 2));
    console.log(JSON.stringify(reports.at(-1)));
    console.log((error.stderr || '').split('\n').filter(line => /Error loading config|missing field|unknown field|invalid value|^error:/i.test(line)).slice(0, 3).join('\n'));
  }
}
await writeFile(join(directory, `metrics-${Date.now()}.json`), JSON.stringify(reports, null, 2));
