import { lstat, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalConfig } from '../src/portable.js';
import { readAccountQuota } from '../src/codex-quota.js';
import { inspectRuntimeBudget, planRuntimeBudgetRecovery, applyRuntimeBudgetRecovery } from '../src/runtime-budget.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
const within = (parent, child) => {
  const part = relative(parent, child);
  return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
};
const usage = 'Usage: node scripts/runtime-budget.mjs inspect [--project-dir DIR]\n'
  + '  plan --action resume-observation|attest-terminal|carry-forward --evidence-file FILE --output NEW_FILE [--claim ID ...] [--project-dir DIR]\n'
  + '  apply --plan FILE --evidence-file FILE [--project-dir DIR]\n'
  + 'Evidence is an operator attestation, not automatically verified termination or quota calibration. Apply requires the runtime writer to be stopped.';
function bad() { const error = Error(usage); error.code = 'BUDGET_COMMAND_INVALID'; return error; }
function parse(argv) {
  const [command, ...rest] = argv;
  if (!['inspect', 'plan', 'apply'].includes(command)) throw bad();
  const allowed = new Set(['--project-dir', ...(command === 'plan' ? ['--action', '--evidence-file', '--output', '--claim']
    : command === 'apply' ? ['--plan', '--evidence-file'] : [])]);
  const options = { command, claims: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!allowed.has(key) || !value || value.startsWith('--')) throw bad();
    if (key === '--claim') options.claims.push(value);
    else { if (options[key] !== undefined) throw bad(); options[key] = value; }
  }
  if (command === 'plan' && (!options['--action'] || !options['--evidence-file'] || !options['--output'])) throw bad();
  if (command === 'apply' && (!options['--plan'] || !options['--evidence-file'])) throw bad();
  if (options.claims.length !== new Set(options.claims).size) throw bad();
  return options;
}
async function jsonFile(path, maxBytes) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw bad();
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw bad();
  return { data: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes) };
}
function shortText(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
async function evidenceFile(path, now) {
  const { data, sha256 } = await jsonFile(path, 64 * 1024);
  if (!data || data.version !== 1 || data.kind !== 'operator-attested'
    || Object.keys(data).some(key => !['version', 'kind', 'operator', 'reference', 'observedAt', 'terminalAt'].includes(key))
    || !shortText(data.operator, 80) || !shortText(data.reference, 300)
    || !Number.isSafeInteger(data.observedAt) || data.observedAt < 0 || data.observedAt > now()) throw bad();
  if (data.terminalAt !== undefined && (!Number.isSafeInteger(data.terminalAt) || data.terminalAt < 0 || data.terminalAt > data.observedAt)) throw bad();
  return { kind: data.kind, operator: data.operator, reference: data.reference, sha256,
    ...(data.terminalAt === undefined ? {} : { terminalAt: data.terminalAt }) };
}
async function writePlan(path, plan, directory) {
  // Plans are separate review artifacts, never files inside the authoritative ledger.
  const target = join(await realpath(dirname(resolve(path))), basename(path));
  const ledger = await realpath(directory);
  if (within(ledger, target)) throw bad();
  await writeFile(target, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return target;
}

// Injection exists only for isolated tests/importing code; the executable CLI has
// no flag for supplying fake quota JSON, inventing an identity, or disabling checks.
export async function runBudgetCommand({ argv, projectDir = root, meter, now = Date.now } = {}) {
  const options = parse(argv || []);
  projectDir = resolve(options['--project-dir'] || projectDir);
  const directory = join(projectDir, 'data', 'runtime-budget');
  if (options.command === 'inspect') return { action: 'inspect', readOnly: true,
    ...(await inspectRuntimeBudget({ directory })) };
  const config = loadLocalConfig(projectDir);
  const runtimeConfig = config.runtimeBudget || {};
  const readMeter = meter || (() => readAccountQuota({ cwd: projectDir, proxy: config.codexProxy, now }));
  const evidence = await evidenceFile(resolve(options['--evidence-file']), now);
  if (options.command === 'plan') {
    const plan = await planRuntimeBudgetRecovery({ directory, action: options['--action'], claimIds: options.claims,
      evidence, config: runtimeConfig, meter: readMeter, now });
    const output = await writePlan(options['--output'], plan, directory);
    return { action: 'plan', applied: false, output, operationId: plan.operationId,
      evidenceVerification: 'operator-attested-not-independently-verified', before: plan.before, after: plan.after,
      expiresAt: plan.expiresAt, note: 'Apply rechecks the exact ledger, configuration and live quota; a saved plan does not restore model admission.' };
  }
  const { data: plan } = await jsonFile(resolve(options['--plan']), 256 * 1024);
  const evidenceKeys = ['kind', 'operator', 'reference', 'sha256', 'terminalAt'];
  if (!plan?.evidence || Object.keys(plan.evidence).some(key => !evidenceKeys.includes(key))
    || evidenceKeys.some(key => plan.evidence[key] !== evidence[key])) throw bad();
  const result = await applyRuntimeBudgetRecovery({ directory, plan, config: runtimeConfig, meter: readMeter, now });
  return { action: 'apply', ...result, evidenceVerification: 'operator-attested-not-independently-verified',
    note: 'Reconciliation saved; the next model call must still pass all calibration, identity, permission and capacity checks.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runBudgetCommand({ argv: process.argv.slice(2) }), null, 2)); }
  catch (error) {
    const code = error?.code === 'RUNTIME_BUDGET_BLOCKED' ? error.reason : 'command_failed';
    console.error(JSON.stringify({ ok: false, reason: code, message: error?.code === 'BUDGET_COMMAND_INVALID'
      ? usage : 'Budget maintenance refused; preserve the ledger and check the recovery requirements. No model was called.' }));
    process.exitCode = 1;
  }
}
