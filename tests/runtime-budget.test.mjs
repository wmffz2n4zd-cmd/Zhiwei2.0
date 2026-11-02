import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, unlink, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRuntimeBudget, RuntimeBudgetError, inspectRuntimeBudget, planRuntimeBudgetRecovery, applyRuntimeBudgetRecovery } from '../src/runtime-budget.js';

const execute = promisify(execFile), START = Date.parse('2026-10-27T12:00:00Z'), DAY = 86400000, WEEK = 7 * DAY;
const config = overrides => ({ ...overrides, calibration: { verified: true, accountScopeKey: 'fixture-scope', planType: 'prolite',
  accountWeekToPlusRatio: 5, reservationPlusPercent: 5, evidence: 'Isolated test fixture; not real calibration',
  expiresAt: START + 60 * DAY, ...overrides?.calibration } });
const quota = (at, reset = Math.floor(START / 1000) + 86400, used = 20) => ({
  source: 'account/rateLimits/read', attribution: 'account-total', limitId: 'codex', planType: 'prolite', accountScopeKey: 'fixture-scope',
  ordinaryUsageAllowed: true,
  checkedAt: new Date(at).toISOString(), weekly: { usedPercent: used, windowDurationMins: 10080, resetsAt: reset }, shorter: []
});
const blocked = reason => error => error instanceof RuntimeBudgetError && error.code === 'RUNTIME_BUDGET_BLOCKED'
  && error.reason === reason && error.safeForChat === true;

async function fixture(t, overrides = {}) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'runtime-budget-'));
  const f = { directory, at: START, reset: Math.floor(START / 1000) + 86400, used: 20, instances: [],
    config: config(overrides), sample: () => quota(f.at, f.reset, f.used), now: () => f.at };
  f.open = async (changes = {}) => {
    const budget = await createRuntimeBudget({ directory, config: f.config, meter: () => f.sample(), now: f.now, ...changes });
    f.instances.push(budget); return budget;
  };
  t.after(async () => {
    for (const budget of f.instances) await budget.close().catch(() => {});
    if (resolve(directory).startsWith(base + sep)) await rm(directory, { recursive: true, force: true });
  });
  return f;
}

test('uncalibrated or unidentified runtime cannot invoke a model and does not leak meter details', async t => {
  const f = await fixture(t); let reads = 0, calls = 0;
  let budget = await f.open({ config: {}, meter: () => { reads++; throw Error('secret detail'); } });
  await assert.rejects(budget.run({ purpose: 'chat' }, () => calls++), blocked('calibration_unverified'));
  assert.equal(reads, 0); assert.equal(calls, 0); await budget.close();
  budget = await f.open({ meter: () => ({ ...f.sample(), accountScopeKey: undefined }) });
  await assert.rejects(budget.run({ purpose: 'chat' }, () => calls++), blocked('account_identity_unknown'));
  assert.equal(calls, 0); assert.equal(budget.getStatus().chargedPlusPercent, 0);
});

test('a claim is durable before model invocation; account totals stay separate and status is immutable', async t => {
  const f = await fixture(t); f.used = 62;
  const budget = await f.open();
  assert.equal(await budget.run({ purpose: 'qq-chat' }, async () => {
    const { state } = JSON.parse(await readFile(join(f.directory, 'budget.json'), 'utf8'));
    assert.equal(state.current.claims[0].status, 'reserved');
    assert.equal(state.current.chargedUnits, 5_000_000);
    return 'reply';
  }), 'reply');
  const status = budget.getStatus();
  assert.equal(status.chargedPlusPercent, 5); assert.equal(status.accountTotalUsedPercent, 62);
  assert.equal(status.exactUsageMeasured, false); assert.equal(status.accounting, 'conservative-reservation');
  assert.doesNotMatch(JSON.stringify(status), /fixture-scope|Isolated test fixture|accountScopeHash/);
  status.history.push({ forged: true }); assert.deepEqual(budget.getStatus().history, []);
});

test('concurrent model entries share one durable cap and buffer', async t => {
  const f = await fixture(t, { reserveBufferPlusPercent: 10, calibration: { reservationPlusPercent: 30 } });
  const budget = await f.open(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started = 0;
  const first = budget.run({ purpose: 'chat' }, async () => { started++; await gate; return 1; });
  const second = budget.run({ purpose: 'life-planning' }, async () => { started++; await gate; return 2; });
  await assert.rejects(budget.run({ purpose: 'world-reading' }, () => { started++; }), blocked('weekly_cap'));
  assert.equal(started, 2); assert.equal(budget.getStatus().chargedPlusPercent, 60);
  release(); assert.deepEqual(await Promise.all([first, second]), [1, 2]);
});

test('same-week restart and looser buffer cannot replenish charges or restore admission capacity', async t => {
  const f = await fixture(t, { reserveBufferPlusPercent: 10, calibration: { reservationPlusPercent: 30 } });
  let budget = await f.open(); await budget.run({ purpose: 'chat' }, () => 'one'); await budget.run({ purpose: 'task' }, () => 'two');
  await budget.close();
  budget = await f.open({ config: config({ reserveBufferPlusPercent: 1, calibration: { reservationPlusPercent: 20 } }) });
  await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked('weekly_cap'));
  assert.equal(budget.getStatus().chargedPlusPercent, 60); assert.equal(budget.getStatus().admissionLimitPlusPercent, 70);
});

test('failed calls keep the full reservation and preserve the original model failure', async t => {
  const f = await fixture(t), budget = await f.open(), original = Error('model failed');
  await assert.rejects(budget.run({ purpose: 'chat' }, () => { throw original; }), error => error === original);
  assert.equal(budget.getStatus().chargedPlusPercent, 5);
  const { state } = JSON.parse(await readFile(join(f.directory, 'budget.json'), 'utf8'));
  assert.equal(state.current.claims[0].status, 'unknown');
  f.at = f.reset * 1000 + 1000; f.reset += WEEK / 1000; f.used = 0;
  await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked('unresolved_previous_week'));
});

test('falsy thrown failures remain failed promises and unknown charged executions', async t => {
  const f = await fixture(t), budget = await f.open(); let caught = false;
  try { await budget.run({ purpose: 'chat' }, () => { throw undefined; }); }
  catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true); assert.equal(budget.getStatus().unknownCalls, 1); assert.equal(budget.getStatus().chargedPlusPercent, 5);
});

test('crash after reservation recovers as charged unknown and cannot silently reset at the next week', async t => {
  const f = await fixture(t), script = join(f.directory, 'crash.mjs');
  await writeFile(script, `import { createRuntimeBudget } from ${JSON.stringify(new URL('../src/runtime-budget.js', import.meta.url).href)};
const budget = await createRuntimeBudget({directory:${JSON.stringify(f.directory)},config:${JSON.stringify(f.config)},now:()=>${START},meter:()=>(${JSON.stringify(f.sample())})});
await budget.run({purpose:'chat'},()=>process.exit(0));`);
  await execute(process.execPath, [script], { windowsHide: true });
  let budget = await f.open(); assert.equal(budget.getStatus().chargedPlusPercent, 5); assert.equal(budget.getStatus().unknownCalls, 1);
  await budget.run({ purpose: 'task' }, () => 'allowed only against charged balance');
  await budget.close(); f.at = f.reset * 1000 + 1000; f.reset += WEEK / 1000; f.used = 0;
  budget = await f.open();
  await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked('unresolved_previous_week'));
  assert.equal(budget.getStatus().chargedPlusPercent, 10);
});

test('a genuine next week after all calls settle gets its own budget and retains the old summary', async t => {
  const f = await fixture(t); let budget = await f.open();
  await budget.run({ purpose: 'chat' }, () => 'old'); await budget.close();
  const oldReset = f.reset; f.at = oldReset * 1000 + 1000; f.reset += WEEK / 1000; f.used = 1;
  budget = await f.open(); await budget.run({ purpose: 'chat' }, () => 'new');
  assert.equal(budget.getStatus().chargedPlusPercent, 5);
  assert.deepEqual(budget.getStatus().history, [{ weekResetsAt: oldReset, chargedPlusPercent: 5 }]);
});

test('a call spanning the reset latches reconciliation even when post-call meter is unavailable', async t => {
  const f = await fixture(t); let meterReads = 0;
  const budget = await f.open({ meter: () => { if (++meterReads > 1) throw Error('unavailable'); return f.sample(); } });
  assert.equal(await budget.run({ purpose: 'task' }, () => { f.at = f.reset * 1000; return 'finished'; }), 'finished');
  assert.equal(budget.getStatus().blockedReason, 'call_crossed_week');
  assert.equal(budget.getStatus().chargedPlusPercent, 5); await budget.close();
  f.at += 1000; f.reset += WEEK / 1000; f.used = 0;
  const reopened = await f.open();
  await assert.rejects(reopened.run({ purpose: 'chat' }, () => assert.fail()), blocked('call_crossed_week'));
});

test('premature or too-short reset changes cannot replenish budget', async t => {
  for (const early of [true, false]) await t.test(early ? 'early reset' : 'minute-long purported week', async t => {
    const f = await fixture(t), budget = await f.open(); await budget.run({ purpose: 'chat' }, () => 'one');
    if (early) f.reset += WEEK / 1000;
    else { f.at = f.reset * 1000 + 1000; f.reset += 60; }
    // Early sample still must be no more than a week ahead of the clock.
    if (early) f.at += 60000;
    await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked(early ? 'meter_invalid' : 'week_interval_invalid'));
    assert.equal(budget.getStatus().chargedPlusPercent, 5);
  });
});

test('clock, meter and account identity rollback latch across restarts', async t => {
  const cases = [
    ['clock_rollback', f => { f.at -= 1000; }],
    ['meter_rollback', f => { f.used = 19; }],
    ['account_binding_changed', f => { const sample = f.sample; f.sample = () => ({ ...sample(), accountScopeKey: 'another-account' }); }],
    ['account_binding_changed', f => { const sample = f.sample; f.sample = () => ({ ...sample(), planType: 'plus' }); }]
  ];
  for (const [reason, change] of cases) await t.test(reason, async t => {
    const f = await fixture(t); let budget = await f.open(); await budget.run({ purpose: 'chat' }, () => 'one'); change(f);
    await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked(reason));
    await budget.close(); f.at = START; f.used = 20; f.sample = () => quota(f.at, f.reset, f.used);
    budget = await f.open(); await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked(reason));
  });
});

test('same-week conversion changes do not create a new free account baseline', async t => {
  const f = await fixture(t); let budget = await f.open(); await budget.run({ purpose: 'chat' }, () => 'one'); await budget.close();
  budget = await f.open({ config: config({ calibration: { accountWeekToPlusRatio: 10 } }) });
  await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked('calibration_binding_changed'));
  assert.equal(budget.getStatus().chargedPlusPercent, 5);
});

test('stale and missing quota deny new work without minting budget; a fresh valid reading may recover', async t => {
  const f = await fixture(t); let mode = 'stale';
  const budget = await f.open({ meter: () => {
    if (mode === 'missing') throw Error('SECRET_ACCOUNT');
    return { ...f.sample(), checkedAt: new Date(mode === 'stale' ? f.at - 61000 : f.at).toISOString() };
  } });
  await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked('meter_stale'));
  mode = 'missing'; await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), error => {
    assert.ok(blocked('meter_unavailable')(error)); assert.doesNotMatch(error.message, /SECRET_ACCOUNT/); return true;
  });
  mode = 'valid'; await budget.run({ purpose: 'chat' }, () => 'ok'); assert.equal(budget.getStatus().chargedPlusPercent, 5);
});

test('missing post-call measurement cannot refund a successful call or discard its reply', async t => {
  const f = await fixture(t); let reads = 0;
  const budget = await f.open({ meter: () => { if (++reads === 2) throw Error('lag'); return f.sample(); } });
  assert.equal(await budget.run({ purpose: 'chat' }, () => 'reply'), 'reply');
  assert.equal(budget.getStatus().chargedPlusPercent, 5); assert.equal(budget.getStatus().blockedReason, 'meter_unavailable');
  await budget.run({ purpose: 'chat' }, () => 'next'); assert.equal(budget.getStatus().chargedPlusPercent, 10);
});

test('shared development usage changes account headroom, never Zhiwei charge attribution', async t => {
  const f = await fixture(t), budget = await f.open(); await budget.run({ purpose: 'chat' }, () => 'one');
  f.used = 90; await budget.run({ purpose: 'chat' }, () => 'two');
  assert.equal(budget.getStatus().accountTotalUsedPercent, 90); assert.equal(budget.getStatus().chargedPlusPercent, 10);
  assert.equal(budget.getStatus().accountBaselineUsedPercent, 20);
});

test('account headroom reserves settled local calls during reporting lag and rejects exhausted short windows', async t => {
  const f = await fixture(t, { calibration: { reservationPlusPercent: 2 } }); f.used = 94;
  const budget = await f.open(); await budget.run({ purpose: 'chat' }, () => 'one'); await budget.run({ purpose: 'chat' }, () => 'two');
  await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked('account_capacity'));
  assert.equal(budget.getStatus().chargedPlusPercent, 4);
  await budget.close();
  const other = await fixture(t), short = await other.open({ meter: () => ({ ...other.sample(),
    shorter: [{ usedPercent: 96, windowDurationMins: 300, resetsAt: Math.floor(other.at / 1000) + 60 }] }) });
  await assert.rejects(short.run({ purpose: 'chat' }, () => assert.fail()), blocked('account_capacity'));
});

test('expired calibration and meter timeout fail closed before callback', async t => {
  const f = await fixture(t); let budget = await f.open({ config: config({ calibration: { expiresAt: START } }) });
  await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked('calibration_unverified')); await budget.close();
  budget = await f.open({ config: config({ meterTimeoutMs: 5 }), meter: () => new Promise(() => {}) });
  await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked('meter_unavailable'));
});

test('writer exclusion, ledger checksum and missing initialized ledger fail closed', async t => {
  const f = await fixture(t), budget = await f.open();
  await assert.rejects(f.open(), blocked('writer_active')); await budget.close();
  const path = join(f.directory, 'budget.json');
  const envelope = JSON.parse(await readFile(path, 'utf8')); envelope.state.lastObservedAt += 1;
  await writeFile(path, JSON.stringify(envelope)); await assert.rejects(f.open(), blocked('storage_invalid'));
  await unlink(path); await assert.rejects(f.open(), blocked('storage_invalid'));
});

test('closing drains in-flight calls and refuses new admission', async t => {
  const f = await fixture(t), budget = await f.open(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const call = budget.run({ purpose: 'chat' }, async () => { entered(); await gate; return 'done'; });
  await started; let closed = false; const close = budget.close().then(() => { closed = true; });
  await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked('closed'));
  assert.equal(closed, false); release(); assert.equal(await call, 'done'); await close;
  assert.equal(budget.getStatus().closed, true); assert.equal(budget.getStatus().chargedPlusPercent, 5);
});

const evidence = terminalAt => ({ kind: 'operator-attested', operator: 'isolated-test-operator',
  reference: 'fixture-terminal-evidence.txt', sha256: 'a'.repeat(64), ...(terminalAt === undefined ? {} : { terminalAt }) });
const recoveryOptions = f => ({ directory: f.directory, config: f.config, meter: () => f.sample(), now: f.now });
async function faultedBudget(f) {
  const budget = await f.open(); await budget.run({ purpose: 'chat' }, () => 'charged');
  f.used = 19; await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked('meter_rollback'));
  f.used = 20; await budget.close(); return budget;
}
async function unknownBudget(f) {
  const budget = await f.open();
  await assert.rejects(budget.run({ purpose: 'task' }, () => { throw Error('termination unknown'); }));
  await budget.close(); return (await inspectRuntimeBudget({ directory: f.directory })).claims[0].id;
}

test('ordinary included usage must be explicitly allowed for admission and recovery readings', async t => {
  for (const value of [false, null, undefined]) await t.test(String(value), async t => {
    const f = await fixture(t), budget = await f.open({ meter: () => ({ ...f.sample(), ordinaryUsageAllowed: value }) });
    await assert.rejects(budget.run({ purpose: 'chat' }, () => assert.fail()), blocked('ordinary_usage_unavailable'));
    assert.equal(budget.getStatus().chargedPlusPercent, 0); await budget.close();
    await faultedBudget(f);
    await assert.rejects(planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'resume-observation', evidence: evidence(),
      meter: () => ({ ...f.sample(), ordinaryUsageAllowed: value }) }), blocked('ordinary_usage_unavailable'));
  });
});

test('inspection and planning preserve pending claims and cannot initialize or repair missing storage', async t => {
  const f = await fixture(t), absent = join(f.directory, 'absent');
  await assert.rejects(inspectRuntimeBudget({ directory: absent }), blocked('storage_invalid'));
  assert.deepEqual(await readdir(f.directory), []);
  const budget = await f.open(); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const call = budget.run({ purpose: 'task' }, async () => { entered(); await gate; return 'done'; }); await started;
  const path = join(f.directory, 'budget.json'), before = await readFile(path), files = await readdir(f.directory);
  const inspection = await inspectRuntimeBudget({ directory: f.directory }); assert.equal(inspection.claims[0].status, 'reserved');
  const plan = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'attest-terminal',
    claimIds: [inspection.claims[0].id], evidence: evidence(f.at) });
  assert.deepEqual(await readFile(path), before); assert.deepEqual(await readdir(f.directory), files);
  await assert.rejects(applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan }), blocked('writer_active'));
  release(); await call; await budget.close();
  await assert.rejects(applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan }), blocked('recovery_stale'));
});

test('same-week observed recovery preserves charges, saves original bytes and commits an idempotent receipt', async t => {
  const f = await fixture(t); await faultedBudget(f);
  const path = join(f.directory, 'budget.json'), before = await readFile(path), files = await readdir(f.directory);
  const plan = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'resume-observation', evidence: evidence() });
  assert.deepEqual(await readFile(path), before); assert.deepEqual(await readdir(f.directory), files);
  assert.equal(plan.before.chargedPlusPercent, 5); assert.equal(plan.after.chargedPlusPercent, 5); assert.equal(plan.after.fault, null);
  const applied = await applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan });
  assert.equal(applied.alreadyApplied, false); assert.deepEqual(await readFile(join(f.directory, applied.beforeImage)), before);
  let snapshot = await inspectRuntimeBudget({ directory: f.directory });
  assert.equal(snapshot.recoveryAudit.length, 1); assert.equal(snapshot.status.chargedPlusPercent, 5);
  assert.equal(snapshot.recoveryAudit[0].evidence.kind, 'operator-attested');
  const runtime = await f.open(); await runtime.run({ purpose: 'chat' }, () => 'new call'); await runtime.close();
  const currentBytes = await readFile(path);
  // A retry after later model work still returns the original receipt, without another mutation.
  f.at += 10 * 60000;
  const duplicate = await applyRuntimeBudgetRecovery({ directory: f.directory, plan, config: {}, now: f.now });
  assert.equal(duplicate.alreadyApplied, true); assert.deepEqual(await readFile(path), currentBytes);
  snapshot = await inspectRuntimeBudget({ directory: f.directory }); assert.equal(snapshot.status.chargedPlusPercent, 10);
  assert.equal(snapshot.recoveryAudit.length, 1); assert.doesNotMatch(JSON.stringify(runtime.getStatus()), /operator|fixture-terminal|accountScope/);
});

test('edited, stale, expired and differently configured recovery plans cannot change the ledger', async t => {
  for (const mode of ['edited', 'stale', 'expired', 'configuration']) await t.test(mode, async t => {
    const f = await fixture(t); await faultedBudget(f);
    const path = join(f.directory, 'budget.json');
    const plan = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'resume-observation', evidence: evidence() });
    let options = recoveryOptions(f), reason;
    if (mode === 'edited') { plan.evidence.reference = 'edited-evidence.txt'; reason = 'recovery_plan_changed'; }
    if (mode === 'stale') { await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('\n')])); reason = 'recovery_stale'; }
    if (mode === 'expired') { f.at = plan.expiresAt; reason = 'recovery_expired'; }
    if (mode === 'configuration') { options.config = config({ reserveBufferPlusPercent: 1 }); reason = 'recovery_configuration_changed'; }
    const before = await readFile(path);
    await assert.rejects(applyRuntimeBudgetRecovery({ ...options, plan }), blocked(reason));
    assert.deepEqual(await readFile(path), before); assert.equal((await readdir(f.directory)).includes('recovery'), false);
  });
});

test('recovery refuses changed scope, ratio, clock and high-water readings instead of rebinding', async t => {
  for (const mode of ['scope', 'plan', 'ratio', 'clock', 'used', 'timestamp']) await t.test(mode, async t => {
    const f = await fixture(t); await faultedBudget(f);
    const options = { ...recoveryOptions(f), action: 'resume-observation', evidence: evidence() };
    let reason = 'recovery_binding_changed';
    if (mode === 'scope') options.meter = () => ({ ...f.sample(), accountScopeKey: 'different-scope' });
    if (mode === 'plan') options.meter = () => ({ ...f.sample(), planType: 'plus' });
    if (mode === 'ratio') options.config = config({ calibration: { accountWeekToPlusRatio: 10 } });
    if (mode === 'clock') { f.at -= 1000; reason = 'recovery_observation_invalid'; }
    if (mode === 'used') { f.used = 19; reason = 'recovery_observation_invalid'; }
    if (mode === 'timestamp') { options.meter = () => ({ ...f.sample(), checkedAt: new Date(f.at - 1000).toISOString() }); reason = 'recovery_observation_invalid'; }
    const before = await readFile(join(f.directory, 'budget.json'));
    await assert.rejects(planRuntimeBudgetRecovery(options), blocked(reason));
    assert.deepEqual(await readFile(join(f.directory, 'budget.json')), before);
  });
});

test('terminal evidence is explicitly operator-attested, retains charges and does not clear an unrelated fault', async t => {
  const f = await fixture(t), id = await unknownBudget(f);
  let runtime = await f.open(); f.used = 19;
  await assert.rejects(runtime.run({ purpose: 'chat' }, () => assert.fail()), blocked('meter_rollback'));
  f.used = 20; await runtime.close();
  const plan = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'attest-terminal', claimIds: [id], evidence: evidence(f.at) });
  assert.equal(plan.after.fault, 'meter_rollback');
  await applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan });
  const snapshot = await inspectRuntimeBudget({ directory: f.directory });
  assert.equal(snapshot.claims[0].status, 'attested-terminal'); assert.equal(snapshot.claims[0].terminationSource, 'operator-attested');
  assert.equal(snapshot.status.chargedPlusPercent, 5); assert.equal(snapshot.status.fault, 'meter_rollback');
  runtime = await f.open(); await assert.rejects(runtime.run({ purpose: 'chat' }, () => assert.fail()), blocked('meter_rollback'));
});

test('expired-week terminal acknowledgement requires conservative full-charge carry before new work', async t => {
  const f = await fixture(t, { reserveBufferPlusPercent: 10 }), id = await unknownBudget(f);
  let runtime = await f.open(); await runtime.run({ purpose: 'chat' }, () => 'also charged'); await runtime.close();
  const oldReset = f.reset; f.at = oldReset * 1000 + 1000; f.reset += WEEK / 1000; f.used = 0;
  const terminal = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'attest-terminal', claimIds: [id], evidence: evidence(START) });
  await applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan: terminal });
  assert.equal((await inspectRuntimeBudget({ directory: f.directory })).status.carryRequired, true);
  runtime = await f.open(); await assert.rejects(runtime.run({ purpose: 'chat' }, () => assert.fail()), blocked('unresolved_previous_week')); await runtime.close();
  // A more generous configured buffer cannot increase capacity during recovery.
  f.config = config({ reserveBufferPlusPercent: 1 });
  const carry = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'carry-forward', evidence: evidence() });
  assert.equal(carry.before.chargedPlusPercent, 10); assert.equal(carry.after.chargedPlusPercent, 10);
  assert.equal(carry.after.carriedPlusPercent, 10); assert.equal(carry.after.admissionLimitPlusPercent, 70);
  await applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan: carry });
  const snapshot = await inspectRuntimeBudget({ directory: f.directory });
  assert.equal(snapshot.claims[0].status, 'carry'); assert.equal(snapshot.status.carryRequired, false);
  runtime = await f.open(); await runtime.run({ purpose: 'chat' }, () => 'only after carry');
  assert.equal(runtime.getStatus().chargedPlusPercent, 15);
  assert.deepEqual(runtime.getStatus().history, [{ weekResetsAt: oldReset, chargedPlusPercent: 10 }]);
});

test('cross-reset terminal calls recover only through full-charge carry with the original binding', async t => {
  const f = await fixture(t), runtime = await f.open();
  await runtime.run({ purpose: 'task' }, () => { f.at = f.reset * 1000; return 'terminal'; }); await runtime.close();
  f.at += 1000; f.reset += WEEK / 1000; f.used = 0;
  await assert.rejects(planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'resume-observation', evidence: evidence() }), blocked('recovery_action_ineligible'));
  const plan = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'carry-forward', evidence: evidence() });
  await applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan });
  const snapshot = await inspectRuntimeBudget({ directory: f.directory });
  assert.equal(snapshot.status.fault, null); assert.equal(snapshot.status.chargedPlusPercent, 5); assert.equal(snapshot.status.carriedPlusPercent, 5);
});

test('unknown termination, fabricated evidence shape, duplicate claims and short weeks remain blocked', async t => {
  const f = await fixture(t), id = await unknownBudget(f);
  await assert.rejects(planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'attest-terminal', claimIds: [id, id], evidence: evidence(f.at) }), blocked('recovery_claims_invalid'));
  await assert.rejects(planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'attest-terminal', claimIds: [id], evidence: { ...evidence(f.at), kind: 'automatically-verified' } }), blocked('recovery_evidence_invalid'));
  await assert.rejects(planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'attest-terminal', claimIds: [id], evidence: evidence(f.at + 1) }), blocked('recovery_evidence_invalid'));
  f.at = f.reset * 1000 + 1000; f.reset += WEEK / 1000; f.used = 0;
  await assert.rejects(planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'carry-forward', evidence: evidence() }), blocked('recovery_action_ineligible'));
  f.reset -= WEEK / 1000 - 60;
  await assert.rejects(planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'attest-terminal', claimIds: [id], evidence: evidence(START) }), blocked('recovery_week_invalid'));
});

test('corrupt or missing initialized ledgers are preserved and never regenerated by recovery', async t => {
  const f = await fixture(t); await faultedBudget(f);
  const plan = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'resume-observation', evidence: evidence() });
  const path = join(f.directory, 'budget.json'); await writeFile(path, 'damaged ledger\n');
  const before = await readFile(path), files = await readdir(f.directory);
  await assert.rejects(inspectRuntimeBudget({ directory: f.directory }), blocked('storage_invalid'));
  await assert.rejects(applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan }), blocked('storage_invalid'));
  assert.deepEqual(await readFile(path), before); assert.deepEqual(await readdir(f.directory), files);
  await unlink(path); await assert.rejects(applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan }), blocked('storage_invalid'));
  assert.equal((await readdir(f.directory)).includes('budget.json'), false);
});

test('apply rejects observations falling behind the reviewed plan even above the older ledger baseline', async t => {
  const f = await fixture(t); await faultedBudget(f); f.used = 30;
  const plan = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'resume-observation', evidence: evidence() });
  f.used = 25;
  const before = await readFile(join(f.directory, 'budget.json'));
  await assert.rejects(applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan }), blocked('recovery_observation_changed'));
  assert.deepEqual(await readFile(join(f.directory, 'budget.json')), before);
});

test('same operation ID with a different reviewed request cannot overwrite an existing receipt', async t => {
  const f = await fixture(t); await faultedBudget(f);
  const options = { ...recoveryOptions(f), action: 'resume-observation', evidence: evidence(), operationId: 'recovery-operation-1' };
  const first = await planRuntimeBudgetRecovery(options);
  const different = await planRuntimeBudgetRecovery({ ...options, evidence: { ...evidence(), reference: 'different-evidence.txt' } });
  await applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan: first });
  const before = await readFile(join(f.directory, 'budget.json'));
  await assert.rejects(applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan: different }), blocked('recovery_operation_conflict'));
  assert.deepEqual(await readFile(join(f.directory, 'budget.json')), before);
});

test('an edit during apply is preserved and an orphan before-image supports a safe unchanged-plan retry', async t => {
  const f = await fixture(t); await faultedBudget(f);
  const path = join(f.directory, 'budget.json'), original = await readFile(path), changed = Buffer.concat([original, Buffer.from('\n')]);
  const plan = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'resume-observation', evidence: evidence() });
  await assert.rejects(applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan, meter: async () => {
    await writeFile(path, changed); return f.sample();
  } }), blocked('recovery_stale'));
  assert.deepEqual(await readFile(path), changed);
  const beforePath = join(f.directory, 'recovery', `operation-${plan.operationId}.before.json`);
  assert.deepEqual(await readFile(beforePath), original);
  // Restore only this isolated formatting edit; the original precondition and bytes
  // now match again. A pre-existing complete before-image is reusable, never deleted.
  await writeFile(path, original);
  const result = await applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan });
  assert.equal(result.applied, true); assert.equal(result.status.chargedPlusPercent, 5);
  assert.deepEqual(await readFile(beforePath), original);
});

test('a conflicting partial before-image prevents apply and is retained for inspection', async t => {
  const f = await fixture(t); await faultedBudget(f);
  const plan = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'resume-observation', evidence: evidence() });
  const folder = join(f.directory, 'recovery'); await mkdir(folder);
  const path = join(folder, `operation-${plan.operationId}.before.json`); await writeFile(path, 'partial evidence');
  const before = await readFile(join(f.directory, 'budget.json'));
  await assert.rejects(applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan }), blocked('recovery_before_image_changed'));
  assert.equal(await readFile(path, 'utf8'), 'partial evidence'); assert.deepEqual(await readFile(join(f.directory, 'budget.json')), before);
});

test('multi-week recovery carries the full exhausted budget even above a newly tightened limit', async t => {
  const f = await fixture(t, { calibration: { reservationPlusPercent: 25 } }), id = await unknownBudget(f);
  let runtime = await f.open();
  await runtime.run({ purpose: 'chat' }, () => 'second'); await runtime.run({ purpose: 'chat' }, () => 'third');
  assert.equal(runtime.getStatus().chargedPlusPercent, 75); await runtime.close();
  const oldReset = f.reset;
  f.at = oldReset * 1000 + 2 * WEEK + 1000; f.reset = oldReset + 3 * WEEK / 1000; f.used = 0;
  f.config = config({ reserveBufferPlusPercent: 10, calibration: { reservationPlusPercent: 25 } });
  const terminal = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'attest-terminal', claimIds: [id], evidence: evidence(START) });
  await applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan: terminal });
  const carry = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'carry-forward', evidence: evidence() });
  await applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan: carry });
  runtime = await f.open();
  assert.equal(runtime.getStatus().chargedPlusPercent, 75); assert.equal(runtime.getStatus().admissionLimitPlusPercent, 70);
  assert.equal(runtime.getStatus().remainingAdmissionPlusPercent, 0);
  await assert.rejects(runtime.run({ purpose: 'chat' }, () => assert.fail()), blocked('weekly_cap'));
  assert.deepEqual(runtime.getStatus().history, [{ weekResetsAt: oldReset, chargedPlusPercent: 75 }]);
});

test('successful maintenance never bypasses absent or expired calibration on subsequent runtime admission', async t => {
  const f = await fixture(t); await faultedBudget(f);
  const plan = await planRuntimeBudgetRecovery({ ...recoveryOptions(f), action: 'resume-observation', evidence: evidence() });
  await applyRuntimeBudgetRecovery({ ...recoveryOptions(f), plan });
  for (const configuration of [{ calibration: null }, config({ calibration: { expiresAt: f.at } })]) {
    const runtime = await f.open({ config: configuration });
    await assert.rejects(runtime.run({ purpose: 'chat' }, () => assert.fail()), blocked('calibration_unverified'));
    assert.equal(runtime.getStatus().chargedPlusPercent, 5); await runtime.close();
  }
});
