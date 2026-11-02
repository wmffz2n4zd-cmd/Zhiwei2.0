import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { codexCommand, resolveCodex } from './portable.js';
import { worldModelEnvironment } from './world-model.js';

export const WEEKLY_PLUS_CAP_PERCENT = 80;

const identityText = (value, limit = 500) => typeof value === 'string' && value.length > 0
  && value.length <= limit && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

function accountBinding(value) {
  if (value == null || value.workspaceRouting == null) return null;
  const routing = value.workspaceRouting;
  if (value.account?.type !== 'chatgpt' || !identityText(value.account.planType, 40)
    || !identityText(routing.chatgptAccountId) || !identityText(routing.backendOrigin, 2000)
    || !identityText(routing.accountRoutingOverride, 100)) throw Error('Codex账号范围无效');
  let backend;
  try { backend = new URL(routing.backendOrigin); } catch { throw Error('Codex账号路由无效'); }
  if (backend.protocol !== 'https:' || backend.username || backend.password || backend.search || backend.hash) {
    throw Error('Codex账号路由无效');
  }
  // Preserve any backend path namespace. Only standard URL normalization and a
  // root trailing slash are equivalent; no email, auth material or raw ID leaves here.
  const backendOrigin = backend.origin + (backend.pathname === '/' ? '' : backend.pathname);
  return { accountId: routing.chatgptAccountId, backendOrigin,
    routingOverride: routing.accountRoutingOverride, planType: value.account.planType };
}

function verifiedScope(result, bucket, context) {
  if (!context) return null;
  const before = accountBinding(context.before), after = accountBinding(context.after);
  if (Boolean(before) !== Boolean(after) || (before && JSON.stringify(before) !== JSON.stringify(after))) {
    throw Error('读取额度期间Codex账号范围发生变化');
  }
  if (result.accountId != null && !identityText(result.accountId)) throw Error('Codex额度账号范围无效');
  if (!before || result.accountId == null) return null;
  if (before.accountId !== result.accountId || (bucket.planType != null && before.planType !== bucket.planType)) {
    throw Error('Codex账号与额度范围不一致');
  }
  // A missing bucket plan is useful diagnostics, but cannot bind a calibration.
  if (bucket.planType == null) return null;
  return 'codex-account-v1:' + createHash('sha256').update(JSON.stringify([
    'zhiwei-codex-account-scope-v1', before.backendOrigin, before.routingOverride, before.accountId
  ])).digest('hex');
}

export function normalizeAccountQuota(result, now = Date.now(), identityContext) {
  const byId = result?.rateLimitsByLimitId;
  // A present multi-bucket response is authoritative; never silently use a different bucket.
  if (byId != null && (typeof byId !== 'object' || Array.isArray(byId))) throw Error('Codex额度窗口不可用');
  const bucket = byId != null ? byId.codex : result?.rateLimits;
  if (!bucket || (bucket.limitId != null && bucket.limitId !== 'codex')) throw Error('Codex额度窗口不可用');
  const windows = [bucket.primary, bucket.secondary].filter(Boolean).map(value => {
    if (typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent) || value.usedPercent < 0
      || value.usedPercent > 100 || !Number.isSafeInteger(value.windowDurationMins) || value.windowDurationMins <= 0
      || !Number.isSafeInteger(value.resetsAt) || value.resetsAt * 1000 <= now) throw Error('Codex额度窗口无效或已过期');
    return { usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins, resetsAt: value.resetsAt };
  });
  const weekly = windows.filter(value => value.windowDurationMins === 10080);
  if (weekly.length !== 1) throw Error('未取得唯一有效周额度窗口');
  if (result.ordinaryUsageAllowed != null && typeof result.ordinaryUsageAllowed !== 'boolean') throw Error('Codex额度准入状态无效');
  const accountScopeKey = verifiedScope(result, bucket, identityContext);
  return { checkedAt: new Date(now).toISOString(), source: 'account/rateLimits/read', limitId: 'codex',
    planType: typeof bucket.planType === 'string' ? bucket.planType : null,
    weekly: weekly[0], shorter: windows.filter(value => value.windowDurationMins < 10080),
    weeklyPlusCapPercent: WEEKLY_PLUS_CAP_PERCENT,
    accountScopeKey, identityVerified: accountScopeKey !== null,
    ordinaryUsageAllowed: result.ordinaryUsageAllowed ?? null,
    // This account-wide measurement does not attribute usage to Zhiwei or convert a shared Pro plan.
    attribution: 'account-total', plusBaselineDirectlyComparable: bucket.planType === 'plus' };
}

// Keep even opaque account identifiers out of CLI reports and engineering evidence.
export function quotaDiagnostics(snapshot) {
  return { checkedAt: snapshot.checkedAt, source: snapshot.source, limitId: snapshot.limitId,
    planType: snapshot.planType, weekly: structuredClone(snapshot.weekly), shorter: structuredClone(snapshot.shorter),
    weeklyPlusCapPercent: snapshot.weeklyPlusCapPercent, attribution: snapshot.attribution,
    plusBaselineDirectlyComparable: snapshot.plusBaselineDirectlyComparable,
    identityVerified: snapshot.identityVerified === true,
    accountScopeAvailable: typeof snapshot.accountScopeKey === 'string' && snapshot.accountScopeKey.length > 0,
    ordinaryUsageAllowed: snapshot.ordinaryUsageAllowed ?? null };
}

/** Read authenticated account scope around its quota snapshot via public RPC.
 * Never starts a thread/turn, refreshes login, consumes reset credits or reads auth files.
 */
export function readAccountQuota({ codexPath = resolveCodex(), env = process.env, proxy, cwd,
  timeoutMs = 15000, now = Date.now } = {}) {
  const invocation = codexCommand(codexPath, ['app-server', '--listen', 'stdio://']);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd, env: worldModelEnvironment(env, proxy),
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', bytes = 0, result, failure, done = false, phase = 1, before, quota, killTimer;
    const stop = (value, error) => {
      if (done) return;
      done = true; result = value; failure = error; clearTimeout(timer);
      child.stdin.end(); child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref();
    };
    const timer = setTimeout(() => stop(null, Error('读取Codex额度超时')), Math.max(100, Math.min(30000, timeoutMs)));
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8'); child.stderr.resume();
    child.stdout.on('data', chunk => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return stop(null, Error('额度接口输出超限'));
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0 && !done) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { return stop(null, Error('额度接口返回无效数据')); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return stop(null, Error('额度接口返回无效数据'));
        // Startup can announce the account before the first account/read response.
        // That response establishes the baseline; any later account update invalidates it.
        if (message.method === 'account/updated' && phase >= 3) return stop(null, Error('读取额度期间Codex账号状态发生变化'));
        if (message.id === 1 && phase === 1) {
          if (message.error) return stop(null, Error('额度接口初始化失败'));
          phase = 2; send({ method: 'initialized' }); send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        } else if (message.id === 2 && phase === 2) {
          if (message.error) return stop(null, Error('额度账号读取失败'));
          before = message.result; phase = 3;
          send({ id: 3, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true, supportsLunaReserve: false } });
        } else if (message.id === 3 && phase === 3) {
          if (message.error) return stop(null, Error('额度接口读取失败'));
          quota = message.result; phase = 4;
          send({ id: 4, method: 'account/read', params: { refreshToken: false } });
        } else if (message.id === 4 && phase === 4) {
          if (message.error) return stop(null, Error('额度账号复核失败'));
          try { stop(normalizeAccountQuota(quota, now(), { before, after: message.result })); }
          catch (error) { stop(null, error); }
        }
      }
    });
    child.on('error', () => stop(null, Error('无法启动Codex额度接口')));
    child.on('close', () => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (result) resolve(result);
      else reject(failure || Error('额度接口提前退出'));
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: {
      name: 'zhiwei_quota', title: 'Zhiwei quota reader', version: '2.0' }, capabilities: { experimentalApi: true } } });
  });
}
