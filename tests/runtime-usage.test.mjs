import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, readdir, rm, rmdir, symlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRuntimeUsage, summarizeRuntimeUsage } from '../src/runtime-usage.js';
import { createConfiguredRuntimeBudget } from '../src/runtime-budget-service.js';
import { runUsageCommand } from '../scripts/runtime-usage.mjs';

const execute = promisify(execFile), START = Date.parse('2026-10-30T02:00:00Z');
const usage = (input = 20, cached = 5, output = 3) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
async function fixture(t) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const projectDir = await mkdtemp(join(base, 'runtime-usage-')), directory = join(projectDir, 'data', 'runtime-usage');
  const f = { projectDir, directory, at: START, instances: [] };
  f.now = () => f.at;
  f.open = async () => { const observer = await createRuntimeUsage({ directory, now: f.now }); f.instances.push(observer); return observer; };
  f.summary = options => summarizeRuntimeUsage({ directory, ...options });
  t.after(async () => { for (const observer of f.instances) await observer.close();
    const resolved = resolve(projectDir); if (!resolved.startsWith(base + sep)) throw Error('Unsafe test cleanup');
    await rm(resolved, { recursive: true, force: true }); });
  return f;
}

test('observe overrides enabled false without querying quota or changing the strict ledger', async t => {
  const f = await fixture(t), old = join(f.projectDir, 'data', 'runtime-budget');
  await mkdir(old, { recursive: true }); await writeFile(join(old, 'budget.json'), 'EXISTING-STRICT-LEDGER');
  let meterReads = 0;
  const observer = await createConfiguredRuntimeBudget({ projectDir: f.projectDir, now: f.now,
    config: { runtimeBudget: { mode: 'observe', enabled: false, calibration: null } },
    meter: () => { meterReads++; throw Error('METER MUST NOT RUN'); } }); f.instances.push(observer);
  const output = await observer.run({ purpose: 'qq-chat' }, () => ({ usage: usage(), text: 'PRIVATE_RESPONSE' }));
  assert.equal(output.text, 'PRIVATE_RESPONSE'); assert.equal(meterReads, 0);
  assert.equal(await readFile(join(old, 'budget.json'), 'utf8'), 'EXISTING-STRICT-LEDGER');
  assert.equal(observer.getStatus().enforced, false);
  assert.equal((await f.summary()).totals.knownTokens.input_tokens, 20);
});

test('records only safe attempt metadata and known token numbers for success and failure', async t => {
  const f = await fixture(t), observer = await f.open();
  await observer.run({ purpose: 'qq-chat' }, () => ({ text: 'PRIVATE_TEXT', usage: { ...usage(), credential: 'SECRET_AUTH' } }));
  const failure = Object.assign(Error('SECRET_ERROR'), { usage: usage(9, 0, 2), prompt: 'PRIVATE_PROMPT' });
  await assert.rejects(observer.run({ purpose: 'reading' }, () => { throw failure; }), error => error === failure);
  const files = await readdir(f.directory), content = await readFile(join(f.directory, files[0]), 'utf8');
  assert.doesNotMatch(content, /PRIVATE_|SECRET_|credential|prompt|text/);
  const summary = await f.summary(); assert.equal(summary.totals.runtimeAttempts, 2);
  assert.equal(summary.totals.failed, 1); assert.equal(summary.totals.succeeded, 1);
  assert.deepEqual(summary.totals.knownTokens, usage(29, 5, 5));
  assert.equal(summary.days[0].purposes.length, 2);
});

test('explicit usage is counted once, invalid explicit data can fall back, conflicting reports stay unknown', async t => {
  const f = await fixture(t), observer = await f.open();
  await observer.run({ purpose: 'reading' }, report => { report(usage()); report(usage()); return { usage: usage() }; });
  await observer.run({ purpose: 'reading' }, report => { assert.equal(report({ input_tokens: 1 }), false); return { usage: usage(4, 0, 1) }; });
  await observer.run({ purpose: 'reading' }, report => { report(usage()); report(usage(30, 5, 5)); return { usage: usage(100) }; });
  const summary = await f.summary(); assert.deepEqual(summary.totals.knownTokens, usage(24, 5, 4));
  assert.equal(summary.totals.knownUsageAttempts, 2); assert.equal(summary.totals.missingUsage, 1);
  assert.equal(observer.getStatus().conflictingUsage, 1); assert.equal(summary.integrity, 'incomplete');
});

test('missing or malformed usage is unknown and does not become a zero-token success', async t => {
  const f = await fixture(t), observer = await f.open();
  for (const value of [undefined, null, {}, { input_tokens: 1, output_tokens: 2 }, usage(-1), usage(1, 2), usage(1, 0, Infinity)]) {
    await observer.run({ purpose: 'qq-chat' }, () => ({ usage: value }));
  }
  await observer.run({ purpose: 'qq-chat' }, () => ({ usage: usage(0, 0, 0) }));
  const summary = await f.summary(); assert.equal(summary.totals.runtimeAttempts, 8);
  assert.equal(summary.totals.missingUsage, 7); assert.equal(summary.totals.knownUsageAttempts, 1);
  assert.equal(observer.getStatus().integrity, 'incomplete');
});

test('concurrent attempts and instances append complete independent records and close drains calls', async t => {
  const f = await fixture(t), first = await f.open(), second = await f.open();
  let release; const gate = new Promise(resolveGate => { release = resolveGate; });
  const calls = Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).run({ purpose: 'qq-chat' }, async () => { await gate; return { usage: usage() }; }));
  const closing = first.close(); let drained = false; closing.then(() => { drained = true; });
  await new Promise(resolveTick => setImmediate(resolveTick)); assert.equal(drained, false);
  release(); await Promise.all(calls); await closing; await second.close();
  await assert.rejects(first.run({ purpose: 'qq-chat' }, () => {}), error => error.code === 'USAGE_CLOSED');
  const summary = await f.summary(); assert.equal(summary.totals.runtimeAttempts, 20);
  assert.equal(summary.totals.knownTokens.input_tokens, 400); assert.equal(summary.invalidRecords, 0);
  assert.equal(summary.filesRead, 2); assert.equal(summary.integrity, 'complete');
});

test('restart uses a new file and preserves past observations across Beijing midnight', async t => {
  const f = await fixture(t); f.at = Date.parse('2026-10-30T15:59:59Z');
  let observer = await f.open(); await observer.run({ purpose: 'reading' }, () => { f.at += 2000; return { usage: usage() }; });
  await observer.close(); const before = await readdir(f.directory);
  observer = await f.open(); await observer.run({ purpose: 'life-planning' }, () => ({ usage: usage(5, 0, 1) })); await observer.close();
  assert.equal((await readdir(f.directory)).length, 2); assert.match(before[0], /^2026-10-30\./);
  const summary = await f.summary(); assert.deepEqual(summary.days.map(value => value.date), ['2026-10-30', '2026-10-31']);
  assert.equal((await f.summary({ from: '2026-10-31', to: '2026-10-31' })).totals.runtimeAttempts, 1);
});

test('unfinished start and incomplete tail are preserved and reported as unknown', async t => {
  const f = await fixture(t), observer = await f.open(); await observer.close();
  const path = join(f.directory, `2026-10-30.${randomUUID()}.jsonl`);
  const start = { version: 1, type: 'started', attemptId: randomUUID(), at: START, purpose: 'qq-chat' };
  const content = JSON.stringify(start) + '\n{"version":1,"type":"finished"';
  await writeFile(path, content);
  const summary = await f.summary(); assert.equal(summary.totals.runtimeAttempts, 1);
  assert.equal(summary.totals.pendingUnknown, 1); assert.equal(summary.totals.missingUsage, 1);
  assert.equal(summary.incompleteTails, 1); assert.equal(summary.integrity, 'incomplete');
  assert.equal(await readFile(path, 'utf8'), content);
});

test('malformed and duplicate records are visible integrity faults, never silently added twice', async t => {
  const f = await fixture(t), observer = await f.open(); await observer.run({ purpose: 'reading' }, () => ({ usage: usage() })); await observer.close();
  const [name] = await readdir(f.directory), path = join(f.directory, name), content = await readFile(path, 'utf8');
  await appendFile(path, content + '{"PRIVATE_CONTENT":"not a record"}\n');
  const summary = await f.summary(); assert.equal(summary.totals.runtimeAttempts, 1);
  assert.equal(summary.invalidRecords, 3); assert.equal(summary.integrity, 'incomplete');
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_CONTENT/);
});

test('recording failure is explicit but cannot block or replace the callback result', async t => {
  const f = await fixture(t); await mkdir(join(f.projectDir, 'data')); await writeFile(f.directory, 'not a directory');
  const observer = await f.open(); let calls = 0;
  const result = await observer.run({ purpose: 'qq-chat' }, () => { calls++; return { usage: usage(), text: 'still works' }; });
  assert.equal(result.text, 'still works'); assert.equal(calls, 1);
  const state = observer.getStatus(); assert.equal(state.enforced, false); assert.equal(state.recording, false);
  assert.equal(state.integrity, 'incomplete'); assert.equal(state.recordingErrors, 1);
  assert.equal(state.lastRecordingError, 'storage-unavailable'); assert.equal(await readFile(f.directory, 'utf8'), 'not a directory');
});

test('write failure after initialization preserves callback failures and marks recording incomplete', async t => {
  const f = await fixture(t), observer = await f.open(); await rmdir(f.directory); await writeFile(f.directory, 'blocked');
  const failure = Error('callback failure');
  await assert.rejects(observer.run({ purpose: 'reading' }, () => { throw failure; }), error => error === failure);
  assert.equal(observer.getStatus().lastRecordingError, 'record-write-failed');
  assert.equal(observer.getStatus().failed, 1); assert.equal(observer.getStatus().missingUsage, 1);
});

test('reader refuses symlink directories and flags symlink files without following them', async t => {
  const f = await fixture(t), observer = await f.open(); await observer.close();
  const target = join(f.projectDir, 'outside.jsonl'); await writeFile(target, 'SECRET_OUTSIDE');
  const link = join(f.directory, `2026-10-30.${randomUUID()}.jsonl`);
  try { await symlink(target, link); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink permission unavailable'); throw error; }
  const summary = await f.summary(); assert.equal(summary.invalidFiles, 1); assert.doesNotMatch(JSON.stringify(summary), /SECRET_OUTSIDE/);
});

test('normal release/data junction ancestors work, but usage leaf junctions are refused', async t => {
  const f = await fixture(t), shared = join(f.projectDir, 'shared-data'), release = join(f.projectDir, 'release');
  await mkdir(shared); await mkdir(release);
  const link = join(release, 'data');
  try { await symlink(shared, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Directory link permission unavailable'); throw error; }
  const linkedDirectory = join(link, 'runtime-usage'), observer = await createRuntimeUsage({ directory: linkedDirectory, now: f.now }); f.instances.push(observer);
  await observer.run({ purpose: 'qq-chat' }, () => ({ usage: usage() })); await observer.close();
  assert.equal(observer.getStatus().recording, true);
  assert.equal((await summarizeRuntimeUsage({ directory: linkedDirectory })).totals.runtimeAttempts, 1);
  assert.equal((await readdir(join(shared, 'runtime-usage'))).length, 1);
  const leafLink = join(f.projectDir, 'redirected-usage');
  await symlink(join(shared, 'runtime-usage'), leafLink, process.platform === 'win32' ? 'junction' : 'dir');
  const refused = await createRuntimeUsage({ directory: leafLink, now: f.now }); f.instances.push(refused);
  assert.equal(refused.getStatus().recording, false);
  await assert.rejects(summarizeRuntimeUsage({ directory: leafLink }), error => error.code === 'USAGE_UNSAFE_DIRECTORY');
});

test('CLI is read-only, accepts date ranges and never needs config, quota or a model executable', async t => {
  const f = await fixture(t), empty = await runUsageCommand({ argv: ['inspect'], projectDir: f.projectDir });
  assert.equal(empty.directoryPresent, false); assert.equal(empty.integrity, 'no-data'); assert.equal(empty.usageIntegrity, 'unknown');
  const observer = await f.open();
  const initialized = await f.summary(); assert.equal(initialized.directoryPresent, true); assert.equal(initialized.integrity, 'no-data');
  await observer.run({ purpose: 'qq-chat' }, () => ({ usage: usage() })); await observer.close();
  const [name] = await readdir(f.directory), before = await readFile(join(f.directory, name), 'utf8');
  const summary = await runUsageCommand({ argv: ['inspect', '--project-dir', f.projectDir, '--from', '2026-10-30', '--to', '2026-10-30'] });
  assert.equal(summary.totals.runtimeAttempts, 1); assert.equal(await readFile(join(f.directory, name), 'utf8'), before);
  assert.equal(summary.observationStatus, 'observed');
  const unusedDate = await f.summary({ from: '2026-10-31' }); assert.equal(unusedDate.integrity, 'no-data');
  const command = await execute(process.execPath, [resolve('scripts/runtime-usage.mjs'), 'inspect', '--project-dir', f.projectDir], {
    windowsHide: true, env: { ...process.env, CODEX_CLI_PATH: join(f.projectDir, 'missing-model') } });
  assert.equal(JSON.parse(command.stdout).totals.runtimeAttempts, 1);
  for (const argv of [['inspect', '--from', '2026-02-31'], ['inspect', '--from', '2026-11-01', '--to', '2026-10-30'], ['inspect', '--secret', 'PRIVATE_ARG']]) {
    await assert.rejects(runUsageCommand({ argv, projectDir: f.projectDir }));
  }
  await assert.rejects(execute(process.execPath, [resolve('scripts/runtime-usage.mjs'), 'inspect', '--secret', 'PRIVATE_ARG'], { windowsHide: true }), error => {
    assert.doesNotMatch(error.stderr, /PRIVATE_ARG/); return true;
  });
});
