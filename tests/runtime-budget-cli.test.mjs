import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRuntimeBudget } from '../src/runtime-budget.js';
import { runBudgetCommand } from '../scripts/runtime-budget.mjs';

const execute = promisify(execFile), START = Date.parse('2026-10-28T01:00:00Z'), DAY = 86400000;
async function fixture(t) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const projectDir = await mkdtemp(join(base, 'budget-cli-')), directory = join(projectDir, 'data', 'runtime-budget');
  const config = { enabled: true, calibration: { verified: true, accountScopeKey: 'cli-isolated-scope', planType: 'prolite',
    accountWeekToPlusRatio: 5, reservationPlusPercent: 5, evidence: 'isolated test only', expiresAt: START + 30 * DAY } };
  await mkdir(join(projectDir, 'data')); await writeFile(join(projectDir, 'data', 'windows.local.json'), JSON.stringify({ runtimeBudget: config }));
  const f = { projectDir, directory, config, at: START, instances: [], reads: 0, planFile: join(projectDir, 'recovery-plan.json'), evidenceFile: join(projectDir, 'evidence.json') };
  f.now = () => f.at;
  f.meter = () => { f.reads++; return { source: 'account/rateLimits/read', attribution: 'account-total', limitId: 'codex',
    planType: 'prolite', accountScopeKey: 'cli-isolated-scope', ordinaryUsageAllowed: true,
    checkedAt: new Date(f.at).toISOString(), weekly: { usedPercent: 20, windowDurationMins: 10080, resetsAt: (START + DAY) / 1000 }, shorter: [] }; };
  f.open = async () => { const b = await createRuntimeBudget({ directory, config, meter: f.meter, now: f.now }); f.instances.push(b); return b; };
  f.command = argv => runBudgetCommand({ argv, projectDir, now: f.now, meter: f.meter });
  f.writeEvidence = async (extra = {}) => writeFile(f.evidenceFile, JSON.stringify({ version: 1, kind: 'operator-attested', operator: 'isolated-test',
    reference: 'fictional test evidence; no real process observation', observedAt: f.at, ...extra }));
  f.plan = () => f.command(['plan', '--action', 'resume-observation', '--evidence-file', f.evidenceFile, '--output', f.planFile]);
  f.apply = () => f.command(['apply', '--plan', f.planFile, '--evidence-file', f.evidenceFile]);
  f.ledger = () => readFile(join(directory, 'budget.json'), 'utf8');
  f.fault = async () => {
    const b = await f.open(); await b.run({ purpose: 'qq-chat' }, () => 'fake reply'); f.at--;
    await assert.rejects(b.run({ purpose: 'qq-chat' }, () => assert.fail()), error => error.reason === 'clock_rollback');
    await b.close(); f.at = START + 2000; await f.writeEvidence();
  };
  t.after(async () => { for (const b of f.instances) await b.close().catch(() => {});
    if (resolve(projectDir).startsWith(base + sep)) await rm(projectDir, { recursive: true, force: true }); });
  return f;
}

test('inspect refuses absent storage without creating files or querying the meter', async t => {
  const f = await fixture(t), before = await readdir(join(f.projectDir, 'data'));
  await assert.rejects(f.command(['inspect']), error => error.reason === 'storage_invalid');
  assert.equal(f.reads, 0);
  assert.deepEqual(await readdir(join(f.projectDir, 'data')), before);
});

test('inspect can read an active writer without altering reservations, identity or accounting', async t => {
  const f = await fixture(t), b = await f.open(); await b.run({ purpose: 'chat' }, () => 'fake');
  const before = await f.ledger(), reads = f.reads;
  const result = await f.command(['inspect']);
  assert.equal(result.readOnly, true); assert.equal(await f.ledger(), before); assert.equal(f.reads, reads);
  assert.doesNotMatch(JSON.stringify(result), /cli-isolated-scope|accountScopeHash|isolated test only/);
});

test('reviewable recovery plan preserves ledger until apply and repeated apply cannot refund charges', async t => {
  const f = await fixture(t); await f.fault(); const before = await f.ledger();
  const preview = await f.plan();
  assert.equal(preview.applied, false); assert.equal(preview.before.chargedPlusPercent, 5);
  assert.equal(preview.after.chargedPlusPercent, 5); assert.equal(await f.ledger(), before);
  assert.equal(preview.evidenceVerification, 'operator-attested-not-independently-verified');
  const applied = await f.apply(); assert.equal(applied.applied, true); assert.equal(applied.status.chargedPlusPercent, 5);
  const after = await f.ledger(), duplicate = await f.apply();
  assert.equal(duplicate.alreadyApplied, true); assert.equal(await f.ledger(), after);
  const b = await f.open(); await b.run({ purpose: 'chat' }, () => 'fake after recovery');
  assert.equal(b.getStatus().chargedPlusPercent, 10);
});

test('CLI apply requires the identical operator evidence file and preserves data on mismatch', async t => {
  const f = await fixture(t); await f.fault(); await f.plan(); const before = await f.ledger();
  await f.writeEvidence({ reference: 'substituted evidence' });
  await assert.rejects(f.apply()); assert.equal(await f.ledger(), before);
});

test('CLI refuses a stale plan after a separate recovery changes the ledger', async t => {
  const f = await fixture(t); await f.fault(); await f.plan();
  const secondPlan = join(f.projectDir, 'second-plan.json');
  await f.command(['plan', '--action', 'resume-observation', '--evidence-file', f.evidenceFile, '--output', secondPlan]);
  await f.command(['apply', '--plan', secondPlan, '--evidence-file', f.evidenceFile]);
  const before = await f.ledger(); await assert.rejects(f.apply()); assert.equal(await f.ledger(), before);
});

test('CLI maintenance cannot run while the runtime owns the writer lock', async t => {
  const f = await fixture(t); await f.fault(); await f.plan(); const b = await f.open(), before = await f.ledger();
  await assert.rejects(f.apply()); assert.equal(await f.ledger(), before); await b.close();
});

test('plans cannot overwrite existing files or enter the authoritative ledger directory', async t => {
  const f = await fixture(t); await f.fault(); await f.plan(); const existing = await readFile(f.planFile, 'utf8');
  await assert.rejects(f.plan()); assert.equal(await readFile(f.planFile, 'utf8'), existing);
  await assert.rejects(f.command(['plan', '--action', 'resume-observation', '--evidence-file', f.evidenceFile, '--output', join(f.directory, 'plan.json')]));
  assert.equal((await readdir(f.directory)).includes('plan.json'), false);
});

test('malformed evidence and unsupported flags fail before reading quota or writing ledger', async t => {
  const f = await fixture(t); await f.fault(); const before = await f.ledger(), reads = f.reads;
  for (const evidence of [{}, { version: 1, kind: 'operator-attested', operator: 'a', reference: 'b', observedAt: f.at + 1 },
    { version: 1, kind: 'operator-attested', operator: 'a', reference: 'b', observedAt: f.at, accountScopeKey: 'forged' }]) {
    await writeFile(f.evidenceFile, JSON.stringify(evidence)); await assert.rejects(f.plan());
  }
  await assert.rejects(f.command(['inspect', '--meter-json', 'forged.json']));
  assert.equal(f.reads, reads); assert.equal(await f.ledger(), before);
});

test('uncalibrated recovery cannot be enabled by an operator evidence file', async t => {
  const f = await fixture(t); await f.fault();
  await writeFile(join(f.projectDir, 'data', 'windows.local.json'), JSON.stringify({ runtimeBudget: { calibration: null } }));
  const before = await f.ledger(), reads = f.reads;
  await assert.rejects(f.plan(), error => error.reason === 'calibration_unverified');
  assert.equal(await f.ledger(), before); assert.equal(f.reads, reads);
});

test('real executable inspect works without quota CLI and malformed command prints only safe diagnostics', async t => {
  const f = await fixture(t);
  const budget = await f.open(); await budget.close();
  const script = resolve('scripts/runtime-budget.mjs');
  const result = await execute(process.execPath, [script, 'inspect', '--project-dir', f.projectDir], {
    windowsHide: true, env: { ...process.env, CODEX_CLI_PATH: join(f.projectDir, 'not-a-cli') } });
  assert.equal(JSON.parse(result.stdout).readOnly, true);
  await assert.rejects(execute(process.execPath, [script, 'inspect', '--unexpected', 'SENSITIVE_ARGUMENT'], { windowsHide: true }), error => {
    assert.doesNotMatch(error.stderr, /SENSITIVE_ARGUMENT|windows\.local|accountScope/);
    assert.equal(JSON.parse(error.stderr).ok, false); return true;
  });
});
