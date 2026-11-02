import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { WEEKLY_PLUS_CAP_PERCENT } from './codex-quota.js';

// These are conservative admission charges, NOT measurements of consumed subscription quota.
// The caller must supply independently verified calibration and an authenticated scope from
// its meter. The quota adapter can bind scope using matching public account/read
// observations around the quota read. A quota percentage alone proves neither that
// identity nor a Plus conversion ratio or an upper bound for a complete model call.
const SCALE = 1_000_000, WEEK_MS = 10080 * 60_000, MAX_BYTES = 4 * 1024 * 1024, MAX_CLAIMS = 10000;
const MAX_RECOVERIES = 256, RECOVERY_TTL_MS = 5 * 60_000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const requestHash = value => hash(canonical(value));
const clone = value => structuredClone(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const epoch = value => Number.isSafeInteger(value) && value >= 0;
const plainText = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const units = value => Math.round(value * SCALE);

export class RuntimeBudgetError extends Error {
  constructor(reason) {
    const userMessage = reason === 'weekly_cap' ? '本周的知微运行预算已接近上限，暂时不能继续调用模型。'
      : reason === 'account_capacity' ? '当前账号可用额度不足，暂时不能继续调用模型。'
        : '运行预算暂时无法安全确认，已暂停新的模型调用；本地管理指令仍可使用。';
    super(userMessage);
    this.name = 'RuntimeBudgetError'; this.code = 'RUNTIME_BUDGET_BLOCKED';
    this.reason = reason; this.userMessage = userMessage; this.safeForChat = true;
  }
}

function policy(config) {
  const result = { weeklyPlusCapPercent: config.weeklyPlusCapPercent ?? WEEKLY_PLUS_CAP_PERCENT,
    reserveBufferPlusPercent: config.reserveBufferPlusPercent ?? 5,
    accountBufferPercent: config.accountBufferPercent ?? 5,
    meterMaxAgeMs: config.meterMaxAgeMs ?? 60_000, meterTimeoutMs: config.meterTimeoutMs ?? 15_000 };
  if (result.weeklyPlusCapPercent !== WEEKLY_PLUS_CAP_PERCENT
    || !finite(result.reserveBufferPlusPercent) || result.reserveBufferPlusPercent <= 0 || result.reserveBufferPlusPercent >= WEEKLY_PLUS_CAP_PERCENT
    || !finite(result.accountBufferPercent) || result.accountBufferPercent <= 0 || result.accountBufferPercent >= 100
    || !Number.isSafeInteger(result.meterMaxAgeMs) || result.meterMaxAgeMs < 1 || result.meterMaxAgeMs > 300_000
    || !Number.isSafeInteger(result.meterTimeoutMs) || result.meterTimeoutMs < 1 || result.meterTimeoutMs > 30_000) {
    throw new RuntimeBudgetError('invalid_configuration');
  }
  return Object.freeze(result);
}

function calibration(config, at) {
  const c = config.calibration;
  if (!c || c.verified !== true || !plainText(c.accountScopeKey) || !plainText(c.planType, 40)
    || !plainText(c.evidence, 1000) || !finite(c.accountWeekToPlusRatio) || c.accountWeekToPlusRatio <= 0 || c.accountWeekToPlusRatio > 1000
    || !finite(c.reservationPlusPercent) || units(c.reservationPlusPercent) < 1 || c.reservationPlusPercent > 80
    || !epoch(c.expiresAt) || c.expiresAt <= at) throw new RuntimeBudgetError('calibration_unverified');
  return { accountScopeHash: hash(c.accountScopeKey), planType: c.planType,
    accountWeekToPlusRatio: c.accountWeekToPlusRatio, reservationUnits: units(c.reservationPlusPercent) };
}

function reading(value, at, maxAge) {
  if (!value || value.source !== 'account/rateLimits/read' || value.attribution !== 'account-total' || value.limitId !== 'codex'
    || !plainText(value.planType, 40)) throw new RuntimeBudgetError('meter_invalid');
  // Extra usage/credits are not an authorized substitute for the included quota.
  if (value.ordinaryUsageAllowed !== true) throw new RuntimeBudgetError('ordinary_usage_unavailable');
  if (!plainText(value.accountScopeKey)) throw new RuntimeBudgetError('account_identity_unknown');
  const checkedAt = Date.parse(value.checkedAt);
  if (!epoch(checkedAt) || checkedAt > at || at - checkedAt > maxAge) throw new RuntimeBudgetError('meter_stale');
  const validWindow = w => w && finite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100
    && Number.isSafeInteger(w.windowDurationMins) && w.windowDurationMins > 0
    && epoch(w.resetsAt) && w.resetsAt * 1000 > at;
  if (!validWindow(value.weekly) || value.weekly.windowDurationMins !== 10080
    || value.weekly.resetsAt * 1000 > at + WEEK_MS + 60_000 || !Array.isArray(value.shorter)
    || value.shorter.some(w => !validWindow(w) || w.windowDurationMins >= 10080)) throw new RuntimeBudgetError('meter_invalid');
  return { checkedAt, accountScopeHash: hash(value.accountScopeKey), planType: value.planType,
    resetAt: value.weekly.resetsAt, usedPercent: value.weekly.usedPercent,
    shorter: value.shorter.map(w => ({ ...w })) };
}

async function regular(path) {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw Error('Budget file must be a regular file'); return info; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicWrite(path, data) {
  await regular(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(data, 'utf8'); await handle.sync();
    await handle.close(); handle = null; await rename(temporary, path); await syncDirectory(dirname(path));
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}
async function writerLock(root) {
  const path = join(root, '.writer.lock'), recoveryPath = join(root, '.writer-recovery.lock');
  const owner = { pid: process.pid, host: hostname(), token: randomUUID() };
  const readOwner = async () => {
    await regular(path); const value = JSON.parse(await readFile(path, 'utf8'));
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || value.host !== hostname() || !plainText(value.token)) throw Error('Unverifiable budget writer lock');
    return value;
  };
  const take = async () => {
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(root);
  };
  try { await take(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (processAlive((await readOwner()).pid)) throw new RuntimeBudgetError('writer_active');
    const recovery = await open(recoveryPath, 'wx', 0o600);
    try {
      if (processAlive((await readOwner()).pid)) throw new RuntimeBudgetError('writer_active');
      await unlink(path); await take();
    } finally { await recovery.close(); await unlink(recoveryPath); }
  }
  return async () => {
    if ((await readOwner()).token !== owner.token) throw Error('Budget writer ownership changed');
    await unlink(path); await syncDirectory(root);
  };
}

function validateState(state) {
  if (!state || ![1, 2].includes(state.version) || !epoch(state.lastObservedAt) || (state.fault !== null && !plainText(state.fault))
    || !Array.isArray(state.history) || state.history.length > 52) throw Error('Invalid budget state');
  if (state.version === 2) validateRecoveryAudit(state.recoveryAudit);
  if (state.binding !== null && (!/^[a-f0-9]{64}$/.test(state.binding.accountScopeHash) || !plainText(state.binding.planType, 40)
    || !finite(state.binding.accountWeekToPlusRatio) || state.binding.accountWeekToPlusRatio <= 0)) throw Error('Invalid budget binding');
  if (state.current === null) {
    if (state.binding !== null || state.history.length) throw Error('Missing budget week');
    return;
  }
  const week = state.current;
  if (!state.binding || !epoch(week.resetAt) || !finite(week.baselineAccountUsedPercent) || week.baselineAccountUsedPercent < 0 || week.baselineAccountUsedPercent > 100
    || !finite(week.lastAccountUsedPercent) || week.lastAccountUsedPercent < week.baselineAccountUsedPercent || week.lastAccountUsedPercent > 100
    || !epoch(week.meterCheckedAt) || !Number.isSafeInteger(week.chargedUnits) || week.chargedUnits < 0
    || !Number.isSafeInteger(week.admissionLimitUnits) || week.admissionLimitUnits < 1 || week.admissionLimitUnits >= units(80)
    || (week.carryRequired !== undefined && typeof week.carryRequired !== 'boolean')
    || !Array.isArray(week.claims) || week.claims.length > MAX_CLAIMS) throw Error('Invalid budget week');
  const ids = new Set();
  let total = 0;
  for (const claim of week.claims) {
    if (!plainText(claim.id) || ids.has(claim.id) || !plainText(claim.purpose, 100)
      || !Number.isSafeInteger(claim.reservedUnits) || claim.reservedUnits < 1 || claim.reservedUnits > units(80)
      || !['reserved', 'succeeded', 'failed', 'unknown', ...(state.version === 2 ? ['attested-terminal', 'carry'] : [])].includes(claim.status) || !epoch(claim.createdAt)
      || (claim.settledAt !== null && (!epoch(claim.settledAt) || claim.settledAt < claim.createdAt))) throw Error('Invalid budget claim');
    if (claim.status === 'attested-terminal' && (!epoch(claim.operatorTerminalAt) || claim.operatorTerminalAt < claim.createdAt
      || !plainText(claim.recoveryOperationId, 80) || !state.recoveryAudit.some(entry => entry.operationId === claim.recoveryOperationId))) throw Error('Missing terminal attestation');
    if (claim.status === 'carry' && (!epoch(claim.carriedFromResetAt) || claim.carriedFromResetAt >= week.resetAt
      || !plainText(claim.recoveryOperationId, 80) || !state.recoveryAudit.some(entry => entry.operationId === claim.recoveryOperationId))) throw Error('Missing carry attestation');
    ids.add(claim.id); total += claim.reservedUnits;
  }
  if (total !== week.chargedUnits) throw Error('Inconsistent budget charge');
  let previous = -1;
  for (const summary of state.history) {
    if (!epoch(summary.resetAt) || summary.resetAt <= previous || summary.resetAt >= week.resetAt
      || !Number.isSafeInteger(summary.chargedUnits) || summary.chargedUnits < 0) throw Error('Invalid budget history');
    previous = summary.resetAt;
  }
}

const recoveryActions = new Set(['resume-observation', 'attest-terminal', 'carry-forward']);
const recoverableFaults = new Set(['clock_rollback', 'meter_rollback', 'account_binding_changed',
  'calibration_binding_changed', 'week_rollback', 'week_changed_early', 'week_interval_invalid']);
const digestText = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const operationText = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(value);
const same = (left, right) => requestHash(left) === requestHash(right);
function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new RuntimeBudgetError('recovery_invalid');
}
function normalizeEvidence(value, action) {
  exactKeys(value, ['kind', 'operator', 'reference', 'sha256'], ['terminalAt']);
  if (value.kind !== 'operator-attested' || !plainText(value.operator, 80) || !plainText(value.reference, 300)
    || !digestText(value.sha256) || (action === 'attest-terminal' ? !epoch(value.terminalAt) : value.terminalAt !== undefined)) {
    throw new RuntimeBudgetError('recovery_evidence_invalid');
  }
  // This describes the operator's attestation. Neither a digest nor this API proves
  // the referenced evidence is truthful, or that a remote inference actually ended.
  return clone(value);
}
function normalizeClaimIds(value, action) {
  if (!Array.isArray(value) || value.length > MAX_CLAIMS || value.some(id => !plainText(id))
    || new Set(value).size !== value.length || (action === 'attest-terminal' ? value.length < 1 : value.length !== 0)) {
    throw new RuntimeBudgetError('recovery_claims_invalid');
  }
  return [...value].sort();
}
function recoverySummary(state) {
  const week = state.current;
  return { fault: state.fault, weekResetsAt: week?.resetAt ?? null,
    chargedPlusPercent: (week?.chargedUnits || 0) / SCALE,
    admissionLimitPlusPercent: week ? week.admissionLimitUnits / SCALE : null,
    carryRequired: week?.carryRequired || false,
    carriedPlusPercent: (week?.claims.filter(claim => claim.status === 'carry').reduce((sum, claim) => sum + claim.reservedUnits, 0) || 0) / SCALE };
}
function validateRecoveryAudit(value) {
  if (!Array.isArray(value) || value.length > MAX_RECOVERIES) throw Error('Invalid recovery audit');
  const seen = new Set();
  for (const entry of value) {
    if (!operationText(entry.operationId) || seen.has(entry.operationId) || !digestText(entry.requestSha256)
      || !digestText(entry.beforeLedgerSha256) || !recoveryActions.has(entry.action) || !epoch(entry.appliedAt)
      || entry.beforeImage !== `recovery/operation-${entry.operationId}.before.json`) throw Error('Invalid recovery audit entry');
    normalizeEvidence(entry.evidence, entry.action); normalizeClaimIds(entry.claimIds, entry.action);
    for (const summary of [entry.before, entry.after]) {
      if (!summary || !epoch(summary.weekResetsAt) || !finite(summary.chargedPlusPercent) || summary.chargedPlusPercent < 0
        || !finite(summary.admissionLimitPlusPercent) || summary.admissionLimitPlusPercent <= 0 || summary.admissionLimitPlusPercent >= 80
        || typeof summary.carryRequired !== 'boolean' || !finite(summary.carriedPlusPercent) || summary.carriedPlusPercent < 0) throw Error('Invalid recovery summary');
    }
    if (entry.after.chargedPlusPercent !== entry.before.chargedPlusPercent
      || entry.after.admissionLimitPlusPercent > entry.before.admissionLimitPlusPercent) throw Error('Recovery refunded budget');
    seen.add(entry.operationId);
  }
}
async function existingBudget(directory) {
  if (typeof directory !== 'string' || !directory) throw new RuntimeBudgetError('storage_invalid');
  const root = resolve(directory), path = join(root, 'budget.json');
  try {
    const rootInfo = await lstat(root), info = await regular(path), marker = await regular(join(root, '.initialized'));
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !info || !marker || info.size > MAX_BYTES) throw Error('Missing initialized ledger');
    const bytes = await readFile(path), envelope = JSON.parse(bytes.toString('utf8'));
    if (envelope.sha256 !== hash(envelope.state)) throw Error('Budget checksum mismatch');
    validateState(envelope.state);
    return { root, path, bytes, ledgerSha256: bytesHash(bytes), state: envelope.state };
  } catch { throw new RuntimeBudgetError('storage_invalid'); }
}
async function readRecoveryMeter(meter, settings, now) {
  if (typeof meter !== 'function') throw new RuntimeBudgetError('meter_unavailable');
  let timer, raw;
  try {
    raw = await Promise.race([Promise.resolve().then(meter), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new RuntimeBudgetError('meter_unavailable')), settings.meterTimeoutMs);
    })]);
  } catch { throw new RuntimeBudgetError('meter_unavailable'); }
  finally { clearTimeout(timer); }
  return reading(raw, now(), settings.meterMaxAgeMs);
}
function recoveryConfiguration(config, at) {
  const settings = policy(config), calibrated = calibration(config, at);
  return { settings, calibrated, configSha256: requestHash({ settings, calibrated,
    expiresAt: config.calibration.expiresAt, evidenceSha256: hash(config.calibration.evidence) }) };
}
function proposedRecovery(state, { action, claimIds, evidence, operationId }, configured, sample, at) {
  const next = clone(state), week = next.current, { settings, calibrated } = configured;
  if (!week || !state.binding || !epoch(at) || at < state.lastObservedAt || sample.checkedAt < week.meterCheckedAt) {
    throw new RuntimeBudgetError('recovery_observation_invalid');
  }
  const binding = { accountScopeHash: calibrated.accountScopeHash, planType: calibrated.planType,
    accountWeekToPlusRatio: calibrated.accountWeekToPlusRatio };
  if (!same(state.binding, binding) || sample.accountScopeHash !== binding.accountScopeHash || sample.planType !== binding.planType) {
    throw new RuntimeBudgetError('recovery_binding_changed');
  }
  const sameWeek = sample.resetAt === week.resetAt;
  if (sameWeek && sample.usedPercent < week.lastAccountUsedPercent) throw new RuntimeBudgetError('recovery_observation_invalid');
  if (!sameWeek && (at < week.resetAt * 1000 || sample.resetAt * 1000 < week.resetAt * 1000 + WEEK_MS)) {
    throw new RuntimeBudgetError('recovery_week_invalid');
  }
  next.version = 2; next.recoveryAudit ||= [];
  if (next.recoveryAudit.length >= MAX_RECOVERIES) throw new RuntimeBudgetError('recovery_audit_capacity');
  if (action === 'resume-observation') {
    if (!sameWeek || !recoverableFaults.has(state.fault)) throw new RuntimeBudgetError('recovery_action_ineligible');
    next.fault = null;
  } else if (action === 'attest-terminal') {
    if (evidence.terminalAt > at) throw new RuntimeBudgetError('recovery_evidence_invalid');
    for (const id of claimIds) {
      const claim = week.claims.find(item => item.id === id);
      if (!claim || !['unknown', 'reserved', 'failed'].includes(claim.status) || evidence.terminalAt < claim.createdAt) {
        throw new RuntimeBudgetError('recovery_claims_invalid');
      }
      claim.status = 'attested-terminal'; claim.operatorTerminalAt = evidence.terminalAt;
      claim.recoveryOperationId = operationId; claim.settledAt = Math.max(claim.settledAt || 0, evidence.terminalAt);
    }
    // An attestation recorded after the saved week expired never grants an automatic
    // rollover, even if the operator believes termination happened before that reset.
    if (!sameWeek || at >= week.resetAt * 1000 || state.fault === 'call_crossed_week') week.carryRequired = true;
  } else if (action === 'carry-forward') {
    if (sameWeek || !(week.carryRequired || state.fault)
      || (state.fault && !recoverableFaults.has(state.fault) && state.fault !== 'call_crossed_week')
      || week.claims.some(claim => ['reserved', 'unknown', 'failed'].includes(claim.status))) {
      throw new RuntimeBudgetError('recovery_action_ineligible');
    }
    next.history.push({ resetAt: week.resetAt, chargedUnits: week.chargedUnits }); next.history = next.history.slice(-52);
    next.current = { resetAt: sample.resetAt, baselineAccountUsedPercent: sample.usedPercent,
      lastAccountUsedPercent: sample.usedPercent, meterCheckedAt: sample.checkedAt, chargedUnits: week.chargedUnits,
      admissionLimitUnits: Math.min(week.admissionLimitUnits, units(settings.weeklyPlusCapPercent - settings.reserveBufferPlusPercent)),
      carryRequired: false, claims: week.chargedUnits ? [{ id: `carry-${operationId}`, purpose: 'budget-recovery-carry',
        reservedUnits: week.chargedUnits, status: 'carry', createdAt: at, settledAt: at,
        carriedFromResetAt: week.resetAt, recoveryOperationId: operationId }] : [] };
    next.fault = null;
  } else throw new RuntimeBudgetError('recovery_action_ineligible');
  // Terminal acknowledgement after expiry retains the old window's observation,
  // until a separately reviewed carry action installs the new one.
  if (sameWeek) {
    next.current.lastAccountUsedPercent = sample.usedPercent;
    next.current.meterCheckedAt = sample.checkedAt;
  }
  next.current.admissionLimitUnits = Math.min(next.current.admissionLimitUnits,
    units(settings.weeklyPlusCapPercent - settings.reserveBufferPlusPercent));
  next.lastObservedAt = at;
  return next;
}
function inspection(snapshot) {
  return { ledgerSha256: snapshot.ledgerSha256, status: { ...recoverySummary(snapshot.state),
    accounting: 'conservative-reservation', exactUsageMeasured: false, admissionVerified: false,
    accountTotalUsedPercent: snapshot.state.current?.lastAccountUsedPercent ?? null,
    checkedAt: snapshot.state.current?.meterCheckedAt ?? null,
    recoveryOperations: snapshot.state.recoveryAudit?.length || 0 },
  claims: (snapshot.state.current?.claims || []).map(claim => ({ id: claim.id, purpose: claim.purpose,
    status: claim.status, reservedPlusPercent: claim.reservedUnits / SCALE, createdAt: claim.createdAt,
    settledAt: claim.settledAt, ...(claim.operatorTerminalAt !== undefined ? { operatorTerminalAt: claim.operatorTerminalAt,
      terminationSource: 'operator-attested' } : {}) })),
  recoveryAudit: clone(snapshot.state.recoveryAudit || []) };
}

/** Pure inspection: no directory creation, writer recovery or quota calls. */
export async function inspectRuntimeBudget({ directory } = {}) {
  return inspection(await existingBudget(directory));
}

/** Build a reviewable proposal without changing any file, including stale lock files. */
export async function planRuntimeBudgetRecovery({ directory, action, claimIds = [], evidence, config = {}, meter,
  now = Date.now, operationId = randomUUID() } = {}) {
  if (!operationText(operationId) || !recoveryActions.has(action) || typeof now !== 'function') throw new RuntimeBudgetError('recovery_invalid');
  config = clone(config);
  const snapshot = await existingBudget(directory), normalizedEvidence = normalizeEvidence(evidence, action), ids = normalizeClaimIds(claimIds, action);
  if (snapshot.state.recoveryAudit?.some(entry => entry.operationId === operationId)) throw new RuntimeBudgetError('recovery_operation_exists');
  const configured = recoveryConfiguration(config, now()), sample = await readRecoveryMeter(meter, configured.settings, now), at = now();
  recoveryConfiguration(config, at);
  const next = proposedRecovery(snapshot.state, { action, claimIds: ids, evidence: normalizedEvidence, operationId }, configured, sample, at);
  const payload = { version: 1, operationId, action, claimIds: ids, evidence: normalizedEvidence,
    createdAt: at, expiresAt: at + RECOVERY_TTL_MS, ledgerSha256: snapshot.ledgerSha256, configSha256: configured.configSha256,
    observation: { checkedAt: sample.checkedAt, weekResetsAt: sample.resetAt, accountTotalUsedPercent: sample.usedPercent },
    before: recoverySummary(snapshot.state), after: recoverySummary(next) };
  return { ...payload, requestSha256: requestHash(payload) };
}

function validateRecoveryPlan(plan) {
  exactKeys(plan, ['version', 'operationId', 'action', 'claimIds', 'evidence', 'createdAt', 'expiresAt', 'ledgerSha256', 'configSha256', 'observation', 'before', 'after', 'requestSha256']);
  if (plan.version !== 1 || !operationText(plan.operationId) || !recoveryActions.has(plan.action)
    || !epoch(plan.createdAt) || !epoch(plan.expiresAt) || plan.expiresAt !== plan.createdAt + RECOVERY_TTL_MS
    || !digestText(plan.ledgerSha256) || !digestText(plan.configSha256) || !digestText(plan.requestSha256)) throw new RuntimeBudgetError('recovery_invalid');
  normalizeEvidence(plan.evidence, plan.action);
  exactKeys(plan.observation, ['checkedAt', 'weekResetsAt', 'accountTotalUsedPercent']);
  if (!epoch(plan.observation.checkedAt) || !epoch(plan.observation.weekResetsAt) || !finite(plan.observation.accountTotalUsedPercent)
    || plan.observation.accountTotalUsedPercent < 0 || plan.observation.accountTotalUsedPercent > 100) throw new RuntimeBudgetError('recovery_invalid');
  if (!same(normalizeClaimIds(plan.claimIds, plan.action), plan.claimIds)) throw new RuntimeBudgetError('recovery_invalid');
  const { requestSha256, ...payload } = plan;
  if (requestSha256 !== requestHash(payload)) throw new RuntimeBudgetError('recovery_plan_changed');
}
async function preserveBeforeImage(snapshot, operationId) {
  const relativePath = `recovery/operation-${operationId}.before.json`, folder = join(snapshot.root, 'recovery');
  await mkdir(folder, { recursive: true }); const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RuntimeBudgetError('storage_invalid');
  const path = join(snapshot.root, ...relativePath.split('/'));
  if (await regular(path)) {
    if (bytesHash(await readFile(path)) !== snapshot.ledgerSha256) throw new RuntimeBudgetError('recovery_before_image_changed');
  } else {
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(snapshot.bytes); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(folder); await syncDirectory(snapshot.root);
  }
  return relativePath;
}

/** Apply only a fresh, unchanged proposal to an existing, exclusively locked ledger. */
export async function applyRuntimeBudgetRecovery({ directory, plan, config = {}, meter, now = Date.now } = {}) {
  plan = clone(plan); config = clone(config);
  validateRecoveryPlan(plan);
  // Reject missing/corrupt state before creating even a lock file.
  const initial = await existingBudget(directory), release = await writerLock(initial.root);
  try {
    const snapshot = await existingBudget(directory), existing = snapshot.state.recoveryAudit?.find(entry => entry.operationId === plan.operationId);
    if (existing) {
      if (existing.requestSha256 !== plan.requestSha256) throw new RuntimeBudgetError('recovery_operation_conflict');
      return { applied: true, alreadyApplied: true, operationId: plan.operationId, beforeImage: existing.beforeImage,
        ledgerSha256: snapshot.ledgerSha256, status: inspection(snapshot).status };
    }
    if (snapshot.ledgerSha256 !== plan.ledgerSha256) throw new RuntimeBudgetError('recovery_stale');
    if (!epoch(now()) || now() < plan.createdAt || now() >= plan.expiresAt) throw new RuntimeBudgetError('recovery_expired');
    const configured = recoveryConfiguration(config, now());
    if (configured.configSha256 !== plan.configSha256) throw new RuntimeBudgetError('recovery_configuration_changed');
    const sample = await readRecoveryMeter(meter, configured.settings, now), at = now();
    if (at < plan.createdAt || at >= plan.expiresAt) throw new RuntimeBudgetError('recovery_expired');
    recoveryConfiguration(config, at);
    if (sample.resetAt !== plan.observation.weekResetsAt || sample.checkedAt < plan.observation.checkedAt
      || sample.usedPercent < plan.observation.accountTotalUsedPercent) throw new RuntimeBudgetError('recovery_observation_changed');
    const next = proposedRecovery(snapshot.state, plan, configured, sample, at);
    if (!same(recoverySummary(snapshot.state), plan.before) || !same(recoverySummary(next), plan.after)) throw new RuntimeBudgetError('recovery_effect_changed');
    const beforeImage = `recovery/operation-${plan.operationId}.before.json`;
    next.recoveryAudit.push({ operationId: plan.operationId, requestSha256: plan.requestSha256, action: plan.action, appliedAt: at,
      evidence: clone(plan.evidence), claimIds: [...plan.claimIds], beforeLedgerSha256: snapshot.ledgerSha256,
      beforeImage, before: recoverySummary(snapshot.state), after: recoverySummary(next) });
    validateState(next);
    const bytes = Buffer.from(JSON.stringify({ state: next, sha256: hash(next) }) + '\n');
    if (bytes.length > MAX_BYTES) throw new RuntimeBudgetError('recovery_audit_capacity');
    await preserveBeforeImage(snapshot, plan.operationId);
    // Cooperative writers hold this lock; this extra comparison also catches an
    // out-of-band edit during the meter read instead of overwriting it knowingly.
    if (bytesHash(await readFile(snapshot.path)) !== snapshot.ledgerSha256) throw new RuntimeBudgetError('recovery_stale');
    // State changes and their audit receipt share one fsync+rename commit. An orphan
    // before-image from an interrupted apply grants no new budget and is kept.
    await atomicWrite(snapshot.path, bytes);
    const applied = { ...snapshot, state: next, bytes, ledgerSha256: bytesHash(bytes) };
    return { applied: true, alreadyApplied: false, operationId: plan.operationId, beforeImage,
      ledgerSha256: applied.ledgerSha256, status: inspection(applied).status };
  } finally { await release(); }
}

export async function createRuntimeBudget({ directory, config = {}, meter, now = Date.now } = {}) {
  if (!directory || typeof meter !== 'function' || typeof now !== 'function') throw new TypeError('Budget directory, meter and clock are required');
  const settings = policy(config), calibrationConfig = clone(config);
  const root = resolve(directory); await mkdir(root, { recursive: true });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new RuntimeBudgetError('storage_invalid');
  const release = await writerLock(root), path = join(root, 'budget.json'), initialized = join(root, '.initialized');
  let state, poisoned = false, lastReason = config.calibration ? 'not_checked' : 'calibration_unverified';
  let queue = Promise.resolve(), closing = false, closed = false, closePromise;
  const jobs = new Set();
  const save = async () => {
    try {
      validateState(state);
      const serialized = JSON.stringify({ state, sha256: hash(state) }) + '\n';
      if (Buffer.byteLength(serialized) > MAX_BYTES) throw Error('Budget ledger capacity exceeded');
      await atomicWrite(path, serialized);
    } catch { poisoned = true; lastReason = 'storage_failure'; throw new RuntimeBudgetError('storage_failure'); }
  };
  try {
    const info = await regular(path), marker = await regular(initialized);
    if (!info) {
      if (marker) throw Error('Initialized budget ledger is missing');
      state = { version: 1, binding: null, lastObservedAt: 0, fault: null, current: null, history: [] };
      await save();
    } else {
      if (info.size > MAX_BYTES) throw Error('Budget ledger too large');
      const envelope = JSON.parse(await readFile(path, 'utf8'));
      if (envelope.sha256 !== hash(envelope.state)) throw Error('Budget checksum mismatch');
      validateState(envelope.state); state = envelope.state;
      let recovered = false;
      for (const claim of state.current?.claims || []) if (claim.status === 'reserved') { claim.status = 'unknown'; recovered = true; }
      if (recovered) await save();
    }
    if (!marker) await atomicWrite(initialized, 'runtime-budget-v1\n');
  } catch { await release(); throw new RuntimeBudgetError('storage_invalid'); }

  const serialize = action => {
    const pending = queue.then(action); queue = pending.catch(() => {}); return pending;
  };
  const fail = reason => { lastReason = reason; throw new RuntimeBudgetError(reason); };
  const readMeter = async () => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(meter), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new RuntimeBudgetError('meter_unavailable')), settings.meterTimeoutMs);
      })]);
    } catch { throw new RuntimeBudgetError('meter_unavailable'); }
    finally { clearTimeout(timer); }
  };
  const latch = async reason => { state.fault = reason; await save(); fail(reason); };
  const observe = async (c, sample, at) => {
    if (!epoch(at) || at < state.lastObservedAt) return latch('clock_rollback');
    if (sample.accountScopeHash !== c.accountScopeHash || sample.planType !== c.planType) return latch('account_binding_changed');
    const binding = { accountScopeHash: c.accountScopeHash, planType: c.planType, accountWeekToPlusRatio: c.accountWeekToPlusRatio };
    if (state.binding && hash(state.binding) !== hash(binding)) return latch('calibration_binding_changed');
    const week = state.current;
    if (week && sample.checkedAt < week.meterCheckedAt) return latch('meter_rollback');
    if (week && sample.resetAt !== week.resetAt) {
      if (sample.resetAt < week.resetAt) return latch('week_rollback');
      if (at < week.resetAt * 1000) return latch('week_changed_early');
      if (sample.resetAt * 1000 < week.resetAt * 1000 + WEEK_MS) return latch('week_interval_invalid');
      if (week.carryRequired || week.claims.some(claim => claim.status === 'reserved' || claim.status === 'unknown')) fail('unresolved_previous_week');
      state.history.push({ resetAt: week.resetAt, chargedUnits: week.chargedUnits });
      state.history = state.history.slice(-52); state.current = null;
    } else if (week && sample.usedPercent < week.lastAccountUsedPercent) return latch('meter_rollback');
    if (!state.current) {
      state.binding = binding;
      state.current = { resetAt: sample.resetAt, baselineAccountUsedPercent: sample.usedPercent,
        lastAccountUsedPercent: sample.usedPercent, meterCheckedAt: sample.checkedAt, chargedUnits: 0,
        admissionLimitUnits: units(settings.weeklyPlusCapPercent - settings.reserveBufferPlusPercent), claims: [] };
    }
    state.current.lastAccountUsedPercent = sample.usedPercent; state.current.meterCheckedAt = sample.checkedAt;
    // A configuration edit may tighten this week's guard, but cannot release its buffer.
    state.current.admissionLimitUnits = Math.min(state.current.admissionLimitUnits,
      units(settings.weeklyPlusCapPercent - settings.reserveBufferPlusPercent));
    state.lastObservedAt = at;
  };
  const admit = async purpose => {
    if (poisoned) fail('storage_failure');
    if (state.fault) fail(state.fault);
    const c = calibration(calibrationConfig, now());
    const raw = await readMeter(), at = now(), sample = reading(raw, at, settings.meterMaxAgeMs);
    // Calibration can expire while a meter call is in flight.
    calibration(calibrationConfig, at);
    await observe(c, sample, at);
    const week = state.current;
    await save();
    if (week.chargedUnits + c.reservationUnits > week.admissionLimitUnits) fail('weekly_cap');
    // Reporting lag is unbounded by this protocol. Keep all this week's local charges
    // against account remaining, even after success; some may already be reflected in
    // the account total (deliberate double counting, never a claim of attribution).
    const accountReserve = (week.chargedUnits + c.reservationUnits) / SCALE / c.accountWeekToPlusRatio;
    if (sample.usedPercent + settings.accountBufferPercent + accountReserve > 100
      || sample.shorter.some(w => w.usedPercent + settings.accountBufferPercent >= 100)) fail('account_capacity');
    if (week.claims.length >= MAX_CLAIMS) fail('ledger_capacity');
    const claim = { id: randomUUID(), purpose, reservedUnits: c.reservationUnits, status: 'reserved', createdAt: at, settledAt: null };
    week.claims.push(claim); week.chargedUnits += claim.reservedUnits;
    await save(); lastReason = null;
    return { id: claim.id, calibration: c };
  };
  const settle = async (reservation, succeeded) => {
    // The full admission charge remains, including failed or unmeasured calls. A shared
    // account delta cannot prove a cheaper call, so it can never authorize a refund.
    const claim = state.current?.claims.find(item => item.id === reservation.id);
    if (!claim || claim.status !== 'reserved') { poisoned = true; lastReason = 'storage_failure'; return; }
    const at = now();
    // A rejected callback (especially timeout) does not prove inference terminated.
    // Keep it unknown so a later weekly reset cannot erase potentially ongoing work.
    claim.status = succeeded ? 'succeeded' : 'unknown'; claim.settledAt = Math.max(at, claim.createdAt);
    // A call spanning a reset cannot be attributed to either window by this meter.
    // Keep its charge and require reconciliation; missing post-call data must not
    // accidentally grant an untouched new-week budget.
    if (at >= state.current.resetAt * 1000) state.fault = 'call_crossed_week';
    try {
      if (!state.fault) {
        const sample = reading(await readMeter(), now(), settings.meterMaxAgeMs);
        // Do not roll the week here: this call could straddle its reset. Preserve the old
        // charged claim; subsequent admission may advance after all calls have settled.
        if (sample.resetAt === state.current.resetAt) await observe(reservation.calibration, sample, now());
        else if (sample.resetAt < state.current.resetAt || now() < state.current.resetAt * 1000) await latch('week_changed_early');
      }
    } catch (error) { lastReason = error.reason || 'meter_unavailable'; }
    try { await save(); } catch { /* The durable reservation remains charged; poison prevents any new invocation. */ }
  };
  const api = {
    run({ purpose } = {}, callback) {
      if (closing || closed) return Promise.reject(new RuntimeBudgetError('closed'));
      if (!plainText(purpose, 100) || typeof callback !== 'function') return Promise.reject(new TypeError('Budget purpose and callback are required'));
      const job = (async () => {
        let reservation;
        try { reservation = await serialize(() => admit(purpose)); }
        catch (error) { lastReason = error.reason || 'meter_unavailable'; throw error instanceof RuntimeBudgetError ? error : new RuntimeBudgetError(lastReason); }
        let result, failure, failed = false;
        try { result = await callback(); } catch (error) { failed = true; failure = error; }
        await serialize(() => settle(reservation, !failed));
        if (failed) throw failure;
        return result;
      })();
      jobs.add(job); job.then(() => jobs.delete(job), () => jobs.delete(job)); return job;
    },
    getStatus() {
      const week = state.current;
      return clone({ enabled: true, accounting: 'conservative-reservation', exactUsageMeasured: false,
        weeklyPlusCapPercent: settings.weeklyPlusCapPercent, reserveBufferPlusPercent: settings.reserveBufferPlusPercent,
        admissionLimitPlusPercent: week ? week.admissionLimitUnits / SCALE : settings.weeklyPlusCapPercent - settings.reserveBufferPlusPercent,
        chargedPlusPercent: (week?.chargedUnits || 0) / SCALE,
        remainingAdmissionPlusPercent: Math.max(0, (week ? week.admissionLimitUnits / SCALE : settings.weeklyPlusCapPercent - settings.reserveBufferPlusPercent) - (week?.chargedUnits || 0) / SCALE),
        weekResetsAt: week?.resetAt || null, accountTotalUsedPercent: week?.lastAccountUsedPercent ?? null,
        accountBaselineUsedPercent: week?.baselineAccountUsedPercent ?? null, accountPlanType: state.binding?.planType || null,
        checkedAt: week?.meterCheckedAt ? new Date(week.meterCheckedAt).toISOString() : null,
        pendingCalls: week?.claims.filter(claim => claim.status === 'reserved').length || 0,
        unknownCalls: week?.claims.filter(claim => claim.status === 'unknown').length || 0,
        carryRequired: week?.carryRequired || false,
        carriedPlusPercent: (week?.claims.filter(claim => claim.status === 'carry').reduce((sum, claim) => sum + claim.reservedUnits, 0) || 0) / SCALE,
        recoveryOperations: state.recoveryAudit?.length || 0,
        blockedReason: closed ? 'closed' : poisoned ? 'storage_failure' : state.fault || lastReason,
        closed, history: state.history.map(item => ({ weekResetsAt: item.resetAt, chargedPlusPercent: item.chargedUnits / SCALE })) });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => { await Promise.allSettled([...jobs]); await queue; await release(); closed = true; })();
      return closePromise;
    }
  };
  return api;
}
