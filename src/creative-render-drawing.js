import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { codexCommand, resolveCodex } from './portable.js';
import { parseWorldUsage, worldModelConfig, worldModelEnvironment } from './world-model.js';

const maxBytes = 16 * 1024 * 1024;
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

function invoke(command, args, job, env, prompt, signal, timeoutMs) {
  return new Promise((resolveRun, reject) => {
    signal?.throwIfAborted();
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd: job, env, detached: grouped, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
    let thread = '', usage = null, succeeded = false, failure, bytes = 0, tail = '', forceTimer;
    const stop = sig => {
      if (!child.pid) return;
      try { if (grouped) process.kill(-child.pid, sig); else child.kill(sig); } catch {}
    };
    const fail = reason => {
      if (failure) return;
      failure = Error(reason);
      stop('SIGTERM');
      forceTimer = setTimeout(() => stop('SIGKILL'), 900);
      forceTimer.unref();
    };
    const cancel = () => fail('绘图已取消');
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => fail('绘图超时'), timeoutMs);
    function event(line) {
      if (!line.trim()) return;
      let row;
      try { row = JSON.parse(line); } catch { fail('绘图工具返回无效回执'); return; }
      if (row.type === 'thread.started') {
        if (thread || !uuid.test(row.thread_id || '')) return fail('绘图任务归属无效');
        thread = row.thread_id;
      } else if (row.type === 'turn.completed') {
        usage = parseWorldUsage(row.usage);
        succeeded = true;
      } else if (row.type === 'error' || row.type === 'turn.failed' || row.item?.type === 'error') {
        fail('原生绘图工具调用失败');
      } else if (row.type?.startsWith('item.') &&
        !['agent_message', 'reasoning', 'image_generation', 'image_generation_call'].includes(row.item?.type)) {
        fail('绘图出现额外工具调用');
      }
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return fail('绘图回执过大');
      tail += chunk;
      let end;
      while ((end = tail.indexOf('\n')) >= 0) {
        event(tail.slice(0, end)); tail = tail.slice(end + 1);
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => fail('无法启动绘图工具'));
    child.on('close', code => {
      if (tail.trim()) event(tail);
      clearTimeout(timer); clearTimeout(forceTimer);
      signal?.removeEventListener('abort', cancel);
      if (grouped) stop('SIGKILL');
      resolveRun({ thread, usage, error: failure || (code || !succeeded ? Error('绘图工具未完成') : null) });
    });
    child.stdin.end('Use the built-in image generation tool exactly once to create the requested artwork. ' +
      'Treat the JSON below as its subject and art direction only. Use no other tools or files. ' +
      'After the tool completes, finish the turn.\n' + JSON.stringify({ prompt }));
  });
}

export async function drawNative(prompt, options) {
  const sourceEnv = options.env || process.env;
  const cli = options.codexPath || resolveCodex(sourceEnv);
  const env = worldModelEnvironment(sourceEnv, options.proxy);
  env.PATH = dirname(cli) + delimiter + (env.PATH || '');
  const login = await realpath(env.CODEX_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.codex'));
  const model = options.model || 'gpt-6.1-terra';
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(model)) throw Error('绘图模型名称无效');
  const imageRoot = join(login, 'generated_images');
  await mkdir(imageRoot, { mode: 0o700, recursive: true });
  if (await realpath(imageRoot) !== imageRoot) throw Error('绘图缓存路径无效');
  const existing = new Set(await readdir(imageRoot));
  const workspace = resolve(options.directory || tmpdir());
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const job = await mkdtemp(join(workspace, 'drawing-'));
  let session, usage = null;
  try {
    const config = { ...worldModelConfig, 'features.image_generation': true, 'features.code_mode.enabled': true,
      'features.code_mode_host': true, model_reasoning_effort: 'low' };
    if (process.platform === 'win32') config['windows.sandbox'] = 'elevated';
    const args = ['--no-daemon', 'exec', '--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral',
      '--skip-git-repo-check', '--json', '--color', 'never', '-s', 'read-only', '-m', model, '-C', job];
    for (const [key, value] of Object.entries(config)) args.push('-c', key + '=' + JSON.stringify(value));
    args.push('-c', 'mcp_servers={}', '-c', 'projects.' + JSON.stringify(job) + '.trust_level="untrusted"', '-');
    const invocation = codexCommand(cli, args);
    const call = await invoke(invocation.command, invocation.args, job, env, prompt, options.signal,
      Math.max(100, Math.min(Number(options.timeoutMs) || 240000, 420000)));
    usage = call.usage;
    if (call.thread && !existing.has(call.thread)) {
      const path = join(imageRoot, call.thread);
      if ((await lstat(path).catch(() => null))?.isDirectory() && await realpath(path) === path) session = path;
    }
    if (call.error) throw call.error;
    if (!session) throw Error('原生工具未返回本次绘图文件');
    const files = await readdir(session, { withFileTypes: true });
    if (files.length !== 1 || !files[0].isFile() || !/\.(png|jpe?g|webp)$/i.test(files[0].name)) {
      throw Error('无法确定本次唯一的成图');
    }
    const file = await open(join(session, files[0].name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let raw;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 25 * 1024 * 1024) throw Error('成图大小无效');
      raw = await file.readFile();
    } finally { await file.close(); }
    const raster = sharp(raw, { limitInputPixels: 16777216, failOn: 'warning' });
    const meta = await raster.metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages || 1) !== 1) throw Error('成图格式无效');
    const image = await raster.rotate().png().toBuffer();
    if (!image.length || image.length > maxBytes) throw Error('成图超过私聊交付容量');
    options.signal?.throwIfAborted();
    return { files: [{ name: 'drawing.png', mime: 'image/png', bytes: image }],
      preview: 'drawing.png', downloads: ['drawing.png'], usage };
  } catch (error) {
    if (usage) error.usage = usage;
    throw error;
  } finally {
    if (session && await realpath(session).catch(() => '') === session) {
      for (const entry of await readdir(session, { withFileTypes: true })) {
        if (entry.isFile() || entry.isSymbolicLink()) await unlink(join(session, entry.name));
      }
      await rmdir(session).catch(() => {});
    }
    await rm(job, { recursive: true, force: true });
  }
}

