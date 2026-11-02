import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { normalizeAccountQuota, readAccountQuota, quotaDiagnostics, WEEKLY_PLUS_CAP_PERCENT } from '../src/codex-quota.js';

const now = Date.parse('2026-10-27T14:00:00Z');
const weekly = { usedPercent: 60, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 86400 };
const result = (extras = {}) => ({ rateLimitsByLimitId: { codex: { limitId: 'codex', planType: 'prolite', primary: weekly, secondary: null, ...extras } } });
const account = (routing = {}, details = {}) => ({ account: { type: 'chatgpt', email: 'not-a-scope@example.invalid', planType: 'prolite', ...details },
  workspaceRouting: { chatgptAccountId: 'fixture-account-A', backendOrigin: 'https://chatgpt.com', accountRoutingOverride: 'NO_CONSTRAINT', ...routing } });
const withIdentity = (extras = {}) => ({ ...result(), accountId: 'fixture-account-A', ordinaryUsageAllowed: true, ...extras });

test('weekly quota is selected by window duration, including weekly-only Pro primary windows', () => {
  const snapshot = normalizeAccountQuota(result(), now);
  assert.deepEqual(snapshot.weekly, weekly); assert.deepEqual(snapshot.shorter, []);
  assert.equal(snapshot.planType, 'prolite'); assert.equal(snapshot.plusBaselineDirectlyComparable, false);
  assert.equal(snapshot.attribution, 'account-total'); assert.equal(WEEKLY_PLUS_CAP_PERCENT, 80);
  assert.equal(snapshot.accountScopeKey, null); assert.equal(snapshot.identityVerified, false);
  assert.equal(snapshot.ordinaryUsageAllowed, null);
  const plus = normalizeAccountQuota(result({ planType: 'plus', primary: { ...weekly, windowDurationMins: 300 }, secondary: weekly }), now);
  assert.equal(plus.plusBaselineDirectlyComparable, true); assert.equal(plus.shorter.length, 1);
  assert.equal(Object.hasOwn(snapshot, 'zhiweiUsedPercent'), false, 'never label a shared account measurement as bot usage');
});

test('quota scope uses matched backend identities and routing namespaces, never the account email', () => {
  const normalize = (before, after = before) => normalizeAccountQuota(withIdentity(), now, { before, after });
  const initial = normalize(account());
  assert.match(initial.accountScopeKey, /^codex-account-v1:[a-f0-9]{64}$/);
  assert.equal(initial.identityVerified, true); assert.equal(initial.ordinaryUsageAllowed, true);
  assert.equal(normalize(account({}, { email: 'changed@example.invalid' })).accountScopeKey, initial.accountScopeKey);
  assert.equal(normalize(account({ backendOrigin: 'https://CHATGPT.com:443/' })).accountScopeKey, initial.accountScopeKey);
  for (const routing of [{ backendOrigin: 'https://regional.example.invalid' }, { backendOrigin: 'https://chatgpt.com/other-backend' },
    { accountRoutingOverride: 'us' }]) assert.notEqual(normalize(account(routing)).accountScopeKey, initial.accountScopeKey);
  assert.doesNotMatch(JSON.stringify(initial), /fixture-account-A|not-a-scope|chatgpt\.com|NO_CONSTRAINT/);
});

test('missing identity preserves diagnostics without granting a verified scope', () => {
  for (const context of [undefined, { before: {}, after: {} }, { before: account(), after: account() }]) {
    const snapshot = normalizeAccountQuota({ ...result(), ordinaryUsageAllowed: null }, now, context);
    assert.equal(snapshot.accountScopeKey, null); assert.equal(snapshot.identityVerified, false);
    assert.equal(snapshot.ordinaryUsageAllowed, null);
  }
  const snapshot = normalizeAccountQuota(withIdentity({ rateLimitsByLimitId: { codex: { ...result().rateLimitsByLimitId.codex, planType: null } } }), now,
    { before: account(), after: account() });
  assert.equal(snapshot.accountScopeKey, null);
});

test('identity changes, quota-account mismatch, plan changes and invalid routes fail closed', () => {
  const contexts = [
    { before: account(), after: {} },
    { before: {}, after: account() },
    { before: account(), after: account({ chatgptAccountId: 'fixture-account-B' }) },
    { before: account(), after: account({ backendOrigin: 'https://regional.example.invalid' }) },
    { before: account(), after: account({ accountRoutingOverride: 'us_cr' }) },
    { before: account(), after: account({}, { planType: 'plus' }) }
  ];
  for (const context of contexts) assert.throws(() => normalizeAccountQuota(withIdentity(), now, context));
  for (const routing of [{ chatgptAccountId: '' }, { chatgptAccountId: 'secret\nvalue' }, { accountRoutingOverride: null },
    { backendOrigin: 'http://chatgpt.com' }, { backendOrigin: 'https://user:password@chatgpt.com' },
    { backendOrigin: 'https://chatgpt.com?credential=secret' }, { backendOrigin: 'https://chatgpt.com#secret' }]) {
    assert.throws(() => normalizeAccountQuota(withIdentity(), now, { before: account(routing), after: account(routing) }),
      error => !/password|credential|secret/.test(error.message));
  }
  assert.throws(() => normalizeAccountQuota(withIdentity({ accountId: 'fixture-account-B' }), now, { before: account(), after: account() }));
  assert.throws(() => normalizeAccountQuota(withIdentity(), now, { before: account({}, { planType: 'plus' }), after: account({}, { planType: 'plus' }) }));
});

test('backend ordinary-usage permission stays tri-state and diagnostic reports omit opaque scope', () => {
  for (const permission of [true, false, null, undefined]) {
    const snapshot = normalizeAccountQuota(withIdentity({ ordinaryUsageAllowed: permission }), now, { before: account(), after: account() });
    assert.equal(snapshot.ordinaryUsageAllowed, permission ?? null);
    const diagnostic = quotaDiagnostics(snapshot);
    assert.equal(diagnostic.accountScopeAvailable, true); assert.equal(diagnostic.identityVerified, true);
    assert.equal(Object.hasOwn(diagnostic, 'accountScopeKey'), false);
    assert.doesNotMatch(JSON.stringify(diagnostic), /codex-account-v1|fixture-account|not-a-scope/);
    diagnostic.weekly.usedPercent = 0; assert.equal(snapshot.weekly.usedPercent, 60);
  }
  for (const permission of [0, 1, 'true', {}, []]) assert.throws(() => normalizeAccountQuota(withIdentity({ ordinaryUsageAllowed: permission }), now));
});

test('missing, stale, malformed, conflicting or other-bucket quotas cannot become a zero reading', () => {
  for (const value of [{}, { rateLimitsByLimitId: {}, rateLimits: result().rateLimitsByLimitId.codex },
    { rateLimitsByLimitId: 'malformed', rateLimits: result().rateLimitsByLimitId.codex },
    { rateLimitsByLimitId: [], rateLimits: result().rateLimitsByLimitId.codex },
    result({ primary: null }), result({ primary: { ...weekly, resetsAt: now / 1000 } }),
    result({ primary: { ...weekly, usedPercent: null } }), result({ primary: { ...weekly, usedPercent: 101 } }),
    result({ secondary: weekly }), result({ primary: { ...weekly, windowDurationMins: 300 } }), result({ limitId: 'other' })
  ]) assert.throws(() => normalizeAccountQuota(value, now));
  const legacy = normalizeAccountQuota({ rateLimits: result().rateLimitsByLimitId.codex }, now);
  assert.equal(legacy.weekly.usedPercent, 60);
});

async function fake(t, mode = 'valid') {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'quota-')), path = join(directory, 'fake.mjs'), log = join(directory, 'requests.jsonl');
  t.after(async () => { if (resolve(directory).startsWith(base + sep)) await rm(directory, { recursive: true, force: true }); });
  await writeFile(path, `import { createInterface } from 'node:readline'; import { appendFileSync } from 'node:fs';
const mode=${JSON.stringify(mode)}, result=${JSON.stringify(withIdentity())}, account=${JSON.stringify(account())};
const input=createInterface({input:process.stdin});
input.on('line', line=>{
 const msg=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify({method:msg.method,params:msg.params,secretPresent:!!process.env.TEST_QUOTA_SECRET})+'\\n');
 if(mode==='timeout')return;
 if(mode==='exit'){console.error('SECRET_DIAGNOSTIC');process.exit(1);}
 if(mode==='invalid'){console.log('not-json');return;}
 if(mode==='null'){console.log('null');return;}
 if(mode==='scalar'){console.log('42');return;}
 if(msg.id===1)console.log(JSON.stringify({id:1,result:{}}));
 if(mode==='startup-notification'&&msg.method==='initialized'){
   console.log(JSON.stringify({method:'configWarning',params:{}}));
   console.log(JSON.stringify({method:'remoteControl/status/changed',params:{}}));
   console.log(JSON.stringify({method:'account/updated',params:{authMode:'chatgpt',planType:'prolite'}}));
 }
 if(mode==='error'+msg.id){console.log(JSON.stringify({id:msg.id,error:{message:'SECRET_DIAGNOSTIC'}}));return;}
 if(msg.id===2){
   console.log(JSON.stringify({id:2,result:account}));
   if(mode==='notification-after-baseline')console.log(JSON.stringify({method:'account/updated',params:{authMode:'chatgpt',planType:'prolite'}}));
 }
 if(msg.id===3){
   if(mode==='notification')console.log(JSON.stringify({method:'account/updated',params:{authMode:'chatgpt',planType:'prolite'}}));
   console.log(JSON.stringify({id:3,result:mode==='mismatch'?{...result,accountId:'fixture-account-B'}:result}));
 }
 if(msg.id===4){
   if(mode==='notification-after-quota')console.log(JSON.stringify({method:'account/updated',params:{authMode:'chatgpt',planType:'prolite'}}));
   console.log(JSON.stringify({id:4,result:mode==='switch'?{...account,workspaceRouting:{...account.workspaceRouting,chatgptAccountId:'fixture-account-B'}}:account}));
 }
});`);
  return { path, log };
}

test('quota reader sandwiches quota RPC between stable account reads, strips unrelated credentials and cleans up', async t => {
  const f = await fake(t);
  const snapshot = await readAccountQuota({ codexPath: f.path, env: { ...process.env, TEST_QUOTA_SECRET: 'not-for-child' }, now: () => now });
  assert.equal(snapshot.weekly.usedPercent, 60);
  assert.equal(snapshot.identityVerified, true); assert.equal(snapshot.ordinaryUsageAllowed, true);
  const requests = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.map(x => x.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read']);
  assert.equal(requests[0].params.capabilities.experimentalApi, true);
  assert.deepEqual(requests[2].params, { refreshToken: false });
  assert.deepEqual(requests[3].params, { excludeResetCreditDetails: true, supportsLunaReserve: false });
  assert.deepEqual(requests[4].params, { refreshToken: false });
  assert.ok(requests.every(x => !x.secretPresent));
});

test('startup account notification precedes the first identity baseline and allows a verified snapshot', async t => {
  const f = await fake(t, 'startup-notification');
  const snapshot = await readAccountQuota({ codexPath: f.path, now: () => now });
  assert.equal(snapshot.identityVerified, true);
  assert.equal(snapshot.accountScopeKey, normalizeAccountQuota(withIdentity(), now, { before: account(), after: account() }).accountScopeKey);
  const requests = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.map(x => x.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read']);
});

test('quota RPC failures, malformed output, timeout and early exit fail with sanitized errors', async t => {
  for (const mode of ['error2', 'error3', 'error4', 'invalid', 'null', 'scalar', 'timeout', 'exit', 'switch', 'mismatch',
    'notification-after-baseline', 'notification', 'notification-after-quota']) await t.test(mode, async t => {
    const f = await fake(t, mode);
    await assert.rejects(readAccountQuota({ codexPath: f.path, now: () => now, timeoutMs: 500 }), error => {
      if (mode.startsWith('notification')) assert.match(error.message, /账号状态发生变化/);
      assert.doesNotMatch(error.message, /SECRET_DIAGNOSTIC/); return true;
    });
  });
});
