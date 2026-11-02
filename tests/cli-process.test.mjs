import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCliProcess } from '../src/cli-process.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn(); if (value) return value;
    await sleep(10);
  }
  throw Error('Fixture condition timed out');
}
async function fixture(t, source, options = {}) {
  const testsDir = join(root, 'runtime', 'tests');
  await mkdir(testsDir, { recursive: true });
  const cwd = await mkdtemp(join(testsDir, 'cli-process-'));
  const file = join(cwd, 'cli.mjs');
  await writeFile(file, `import { writeFile } from 'node:fs/promises';
const delay = ms => new Promise(r => setTimeout(r, ms));
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
${source}`);
  let exitResult, finishExit;
  const exited = new Promise(r => { finishExit = r; });
  const pending = runCliProcess({ command: process.execPath, args: [file], cwd,
    input: 'fixture input', timeout: 2500, cleanupMs: 150, ...options,
    onExit: result => { exitResult = result; finishExit(result); } });
  // Prevent a deliberately failing fixture from becoming an unhandled rejection
  // while the test waits for its pre-completion marker.
  pending.catch(() => {});
  t.after(async () => {
    await exited;
    if (!resolve(cwd).startsWith(resolve(testsDir) + sep)) throw Error('Unexpected fixture path');
    await rm(cwd, { recursive: true, force: true });
  });
  return { pending, exited, exit: () => exitResult,
    marker: name => readFile(join(cwd, name), 'utf8').catch(() => null) };
}

test('fragmented JSON and multiple lines yield the final agent message only after completion', async t => {
  const f = await fixture(t, String.raw`
process.stdout.write('{"type":"item.com');
await delay(15);
process.stdout.write('pleted","item":{"type":"agent_message","text":"最终回复"}}\n');
process.stdout.write('{"type":"item.completed","item":{"type":"reasoning","text":"ignored"}}\n{"type":"turn.completed"}\n');
await delay(500);
`, { earlyReply: true });
  const result = await f.pending;
  assert.equal(result.replyText, '最终回复');
  assert.equal(result.cliTiming.processExitMs, null);
  assert.equal(f.exit(), undefined);
  const exit = await f.exited;
  assert.ok(exit.exitTailMs >= 100);
});

test('an agent message without turn.completed cannot return before the process finishes', async t => {
  const f = await fixture(t, `
emit({ type: 'item.completed', item: { type: 'agent_message', text: '尚未完成' } });
await writeFile('message-ready', 'yes');
await delay(250);
`, { earlyReply: true });
  let resolved = false; f.pending.then(() => { resolved = true; });
  await until(() => f.marker('message-ready')); await sleep(40);
  assert.equal(resolved, false);
  const result = await f.pending;
  assert.equal(result.replyText, '尚未完成');
  assert.equal(typeof result.cliTiming.processExitMs, 'number');
  assert.equal(result.cliTiming.replyReadyMs, null);
});

test('turn.failed before completion rejects even when an agent message exists and exit is zero', async t => {
  const f = await fixture(t, `
emit({ type: 'item.completed', item: { type: 'agent_message', text: '不应发送' } });
emit({ type: 'turn.failed', error: { message: 'simulated failure' } });
emit({ type: 'turn.completed' });
`, { earlyReply: true });
  await assert.rejects(f.pending, error => error.code === 0 && /simulated failure/.test(error.stdout));
});

test('ordinary remote tasks wait for process exit despite a completed JSON turn', async t => {
  const f = await fixture(t, `
emit({ type: 'item.completed', item: { type: 'agent_message', text: '任务完成' } });
emit({ type: 'turn.completed' });
await writeFile('turn-completed', 'yes');
await delay(250);
await writeFile('task-tail-finished', 'yes');
`, { earlyReply: false });
  let resolved = false; f.pending.then(() => { resolved = true; });
  await until(() => f.marker('turn-completed')); await sleep(40);
  assert.equal(resolved, false);
  const result = await f.pending;
  assert.equal(await f.marker('task-tail-finished'), 'yes');
  assert.equal(typeof result.cliTiming.processExitMs, 'number');
  assert.equal(result.cliTiming.replyReadyMs, null);
});

test('completed chat returns immediately and a long shutdown tail is reaped in background', async t => {
  const f = await fixture(t, `
emit({ type: 'item.completed', item: { type: 'agent_message', text: '可发送' } });
emit({ type: 'turn.completed' });
setInterval(() => {}, 1000);
`, { earlyReply: true, cleanupMs: 200 });
  const result = await f.pending;
  assert.equal(result.replyText, '可发送');
  assert.equal(f.exit(), undefined);
  assert.equal(result.cliTiming.processExitMs, null);
  const exit = await f.exited;
  assert.ok(exit.exitTailMs >= 150);
  assert.ok(exit.exitTailMs < 2000);
});

test('old CLI output without JSON falls back to successful process exit', async t => {
  const f = await fixture(t, `
process.stdout.write('legacy result');
await writeFile('legacy-ready', 'yes');
await delay(200);
`, { earlyReply: true });
  let resolved = false; f.pending.then(() => { resolved = true; });
  await until(() => f.marker('legacy-ready')); await sleep(40);
  assert.equal(resolved, false);
  const result = await f.pending;
  assert.equal(result.stdout, 'legacy result');
  assert.equal(result.replyText, '');
  assert.equal(typeof result.cliTiming.processExitMs, 'number');
});

test('nonzero exit without a completed turn rejects and retains diagnostics', async t => {
  const f = await fixture(t, `
process.stderr.write('fixture failure');
emit({ type: 'item.completed', item: { type: 'agent_message', text: '未完成' } });
process.exitCode = 7;
`, { earlyReply: true });
  await assert.rejects(f.pending, error => error.code === 7 && error.stderr === 'fixture failure');
});

test('unterminated final JSON cannot turn a known nonzero exit into an early success', async t => {
  const f = await fixture(t, `
emit({ type: 'item.completed', item: { type: 'agent_message', text: '不应发送' } });
process.stdout.write(JSON.stringify({ type: 'turn.completed' }));
process.exitCode = 9;
`, { earlyReply: true });
  await assert.rejects(f.pending, error => error.code === 9
    && error.cliTiming.replyReadyMs === null && typeof error.cliTiming.processExitMs === 'number');
});

test('stderr retry and HTTP fallback markers split across chunks are counted exactly once', async t => {
  const f = await fixture(t, `
process.stderr.write('retrying sam'); await delay(20);
process.stderr.write('pling request; falling back to HT'); await delay(20);
process.stderr.write('TP'); await delay(20);
process.stderr.write('; unrelated suffix'); await delay(20);
process.stderr.write('; RETRYING SAMPLING REQUEST; FALLING BACK TO HTTP'); await delay(20);
process.stderr.write('; another suffix');
`);
  const result = await f.pending;
  assert.equal(result.cliTiming.retries, 2);
  assert.equal(result.cliTiming.httpFallbacks, 2);
  const exit = await f.exited;
  assert.equal(exit.retries, 2);
  assert.equal(exit.httpFallbacks, 2);
});

test('early chat preserves completed numeric usage without keeping model content in usage', async t => {
  const f = await fixture(t, `
emit({type:'item.completed',item:{type:'agent_message',text:'reply'}});
emit({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:7,private_text:'never copied'}});
await delay(300);
`, { earlyReply: true });
  assert.deepEqual((await f.pending).usage, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 });
});

test('usage survives output-tail truncation and completed turns are summed for remote jobs', async t => {
  const f = await fixture(t, `
emit({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:20,output_tokens:7}});
process.stdout.write('x'.repeat(10000)+'\\n');
emit({type:'turn.completed',usage:{input_tokens:50,cached_input_tokens:10,output_tokens:3}});
`);
  assert.deepEqual((await f.pending).usage, { input_tokens: 150, cached_input_tokens: 30, output_tokens: 10 });
});

test('failed completed work retains usage; absent or invalid usage remains unknown', async t => {
  const failed = await fixture(t, `
emit({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:0,output_tokens:7}});
process.exitCode=7;
`);
  await assert.rejects(failed.pending, error => error.code === 7 && error.usage.input_tokens === 100);
  for (const usage of [undefined, {}, { input_tokens: 2, cached_input_tokens: 3, output_tokens: 1 }]) {
    const f = await fixture(t, `emit({type:'turn.completed',usage:${JSON.stringify(usage) || 'undefined'}});`);
    assert.equal((await f.pending).usage, null);
  }
});
