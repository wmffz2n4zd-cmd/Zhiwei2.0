import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLifeTimeline } from '../src/life-timeline.js';
import { createUnifiedMemory } from '../src/unified-memory/index.js';

// Isolated Hub, fake CLI and fake OneBot: no real model, contact or account.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const minute = 60000, day = 86400000;
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(check, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await check();
    if (result) return result;
    await sleep(25);
  }
  throw Error(`Timed out waiting for ${label}`);
}

async function fixture(t, { budget = false, life = false } = {}) {
  const base = join(root, 'runtime', 'tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'private-profile-'));
  const memoryPath = join(directory, 'data', 'unified-memory.json');
  const callsPath = join(directory, 'calls.jsonl'), scenarioPath = join(directory, 'scenario.json');
  const clockPath = join(directory, 'clock.json');
  const initialAt = Date.UTC(2026, 9, 28, 8);
  const sent = [], requests = [];
  let currentAt = initialAt, child, logs = '', nextId = 100, failNextSend = false;
  const bridge = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    assert.equal(req.headers.authorization, 'Bearer isolated-private-memory-api');
    requests.push({ path: req.url, body });
    let result = { status: 'ok', data: { user_id: 999999, nickname: 'memory fixture' } };
    if (req.url === '/get_msg') result.data = { message_id: body.message_id, user_id: 999999, target_id: 123456, message_type: 'private',
      message: [{ type: 'text', data: { text: '在呢。' } }] };
    if (req.url === '/get_msg' && body.message_id > 10000 && sent[body.message_id - 10001]) {
      // Deliberately omit recipient metadata: only actual sent-message provenance may authorize this quote.
      result.data = { message_id: body.message_id, user_id: 999999, message_type: 'private',
        message: sent[body.message_id - 10001].message };
    }
    if (req.url === '/get_msg' && [501, 502, 503, 504, 505].includes(body.message_id)) {
      const metadata = {
        501: { user_id: 234567, message_type: 'private', target_id: 999999 },
        502: { user_id: 123456, message_type: 'group', group_id: 123456789 },
        503: { user_id: 999999, message_type: 'private', target_id: 234567 },
        504: { user_id: 123456, message_type: 'private', target_id: 999999 },
        505: { user_id: 999999, message_type: 'private' }
      }[body.message_id];
      const text = body.message_id < 504 ? `OUT_OF_SCOPE_QUOTE_${body.message_id}`
        : body.message_id === 504 ? 'VERIFIED_PRIVATE_QUOTE 蓝色盒子放在书柜里。' : 'UNVERIFIED_BOT_QUOTE 红色盒子放在门口。';
      result.data = { message_id: body.message_id, ...metadata, message: [
        { type: 'text', data: { text } },
        ...(body.message_id < 504 ? [{ type: 'forward', data: { id: 'outside-scope-forward' } }] : [])
      ] };
    }
    if (req.url === '/send_private_msg' || req.url === '/send_group_msg') {
      sent.push({ path: req.url, ...body });
      result = failNextSend ? { status: 'failed', retcode: 100 } : { status: 'ok', data: { message_id: 10000 + sent.length } };
      failNextSend = false;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(done => bridge.listen(0, '127.0.0.1', done));
  const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port; await new Promise(done => probe.close(done));
  const url = `http://127.0.0.1:${port}`;
  async function stop() {
    if (child && child.exitCode == null) { const closed = once(child, 'close'); child.kill(); await closed; }
    child = null;
  }
  t.after(async () => {
    await stop(); bridge.closeAllConnections(); await new Promise(done => bridge.close(done));
    // Only remove the fixture allocated by this test under runtime/tests.
    if (resolve(directory).startsWith(resolve(base) + sep)) await rm(directory, { recursive: true, force: true });
  });
  await cp(join(root, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(root, 'modules', 'web-console'), join(directory, 'modules', 'web-console'), { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await mkdir(join(directory, 'data'), { recursive: true });
  await writeFile(join(directory, 'data', 'windows.local.json'), JSON.stringify({
    runtimeBudget: budget ? { enabled: true, calibration: {
      verified: true, accountScopeKey: 'isolated-private-memory-budget', planType: 'prolite',
      accountWeekToPlusRatio: 1, reservationPlusPercent: 75,
      evidence: 'isolated fake meter and model for expansion admission', expiresAt: initialAt + 2 * day
    } } : { enabled: false },
    ownerUserIds: ['123456', '234567'], qqEnabled: true, remoteEnabled: false,
    webLookup: false, assistantName: '知微', mood: { enabled: false }, ...(life ? { life: { enabled: true, tickIntervalMs: 250, planning: { enabled: false } } } : {}),
    oneBotSecret: 'isolated-private-memory-callback', oneBotAccessToken: 'isolated-private-memory-api',
    oneBotApiBase: `http://127.0.0.1:${bridge.address().port}`
  }));
  if (budget) {
    // Replace only the copied meter. Admission/reservation uses the real budget service and ledger.
    await writeFile(join(directory, 'src', 'codex-quota.js'), `
export const WEEKLY_PLUS_CAP_PERCENT = 80;
export async function readAccountQuota() { return {
 source:'account/rateLimits/read', attribution:'account-total', limitId:'codex', planType:'prolite',
 accountScopeKey:'isolated-private-memory-budget', ordinaryUsageAllowed:true,
 checkedAt:new Date(Date.now()).toISOString(), shorter:[],
 weekly:{usedPercent:0,windowDurationMins:10080,resetsAt:${initialAt / 1000 + 7 * 86400}} }; }
`);
  }
  await writeFile(clockPath, JSON.stringify({ now: currentAt }));
  const clockModule = join(directory, 'clock.mjs');
  await writeFile(clockModule, `import {readFileSync} from 'node:fs';
Date.now = () => JSON.parse(readFileSync(${JSON.stringify(clockPath)},'utf8')).now;
`);
  await writeFile(scenarioPath, JSON.stringify({ name: 'ordinary', mode: 'reply', reply: '普通回复。' }));
  const fakeCli = join(directory, 'fake-codex.mjs');
  await writeFile(fakeCli, `import {readFile,writeFile,appendFile} from 'node:fs/promises';
const args=process.argv.slice(2); let prompt=''; for await(const chunk of process.stdin) prompt+=chunk;
const scenario=JSON.parse(await readFile(${JSON.stringify(scenarioPath)},'utf8'));
const previous=(await readFile(${JSON.stringify(callsPath)},'utf8').catch(()=>''))
 .trim().split('\\n').filter(Boolean).map(JSON.parse).filter(call=>call.name===scenario.name);
await appendFile(${JSON.stringify(callsPath)},JSON.stringify({name:scenario.name,prompt,args})+'\\n');
let reply=scenario.reply;
if(scenario.mode==='expand') reply=previous.length===0 ? '[[qq_context_more]]'
 : prompt.includes('A_EXPANSION_EVIDENCE') ? '查到了，第二个方案总价四百元。' : 'HISTORY_MISSING';
if(scenario.mode==='marker') reply='[[qq_context_more]]';
if(scenario.mode==='mixed-expand') reply=previous.length===0 ? '我还需要核对。[[qq_context_more]]'
 : prompt.includes('A_EXPANSION_EVIDENCE') ? '查到了，第二个方案总价四百元。' : 'HISTORY_MISSING';
if(scenario.mode==='mixed-marker') reply='我还需要核对。[[qq_context_more]] 不应该把这句直接发出去。';
if(scenario.mode==='expansion-failure') {
 if(previous.length===0) reply='[[qq_context_more]]';
 else { console.error('ISOLATED_FAILURE_PRIVATE_SECRET'); process.exit(1); }
}
if(scenario.mode==='corrupt-before-expansion') {
 await writeFile(${JSON.stringify(memoryPath)},'not-json'); reply='[[qq_context_more]]';
}
if(scenario.mode==='corrupt-before-save') await writeFile(${JSON.stringify(memoryPath)},'not-json');
if(args.includes('--output-schema')) reply=JSON.stringify({reply,contextMore:reply.includes('[[qq_context_more]]'),contactBoundary:{kind:'none',quote:''}});
await writeFile(args[args.indexOf('-o')+1],reply);
`);
  async function start() {
    child = spawn(process.execPath, ['--import', pathToFileURL(clockModule).href, 'src/server.js'], {
      cwd: directory, windowsHide: true,
      env: { ...process.env, PORT: String(port), CODEX_CLI_PATH: fakeCli, CODEX_REMOTE_CONTACT_QQ_WEB_LOOKUP: '0' }
    });
    child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
    try { await until(() => fetch(url + '/api/platform').then(r => r.ok).catch(() => false), 'private memory Hub'); }
    catch (error) { throw Error(`${error.message}\n${logs}`); }
  }
  async function advance(now) {
    currentAt = now;
    await writeFile(clockPath + '.next', JSON.stringify({ now })); await rename(clockPath + '.next', clockPath);
  }
  const snapshot = () => fetch(url + '/api/state').then(r => r.json());
  const platform = () => fetch(url + '/api/platform').then(r => r.json());
  const calls = async () => (await readFile(callsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const bytes = () => readFile(memoryPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const finished = id => until(async () => (await snapshot()).qq.events.find(row => row.event.raw?.message_id === id && row.completedAt), `message ${id}`);
  async function send(text, { sender = 123456, group, id, quote = '77' } = {}) {
    const payload = { post_type: 'message', message_type: group ? 'group' : 'private', self_id: 999999,
      user_id: sender, message_id: id ?? ++nextId, raw_message: text, ...(group ? { group_id: group } : {}),
      message: [...(quote ? [{ type: 'reply', data: { id: quote } }] : []), { type: 'text', data: { text } }] };
    const body = JSON.stringify(payload), signature = 'sha1=' + createHmac('sha1', 'isolated-private-memory-callback').update(body).digest('hex');
    const response = await fetch(url + '/api/onebot/event', { method: 'POST', headers: { 'x-signature': signature }, body });
    assert.equal(response.status, 200);
    if (group) assert.equal((await response.json()).ignored, true);
    return payload.message_id;
  }
  const scenario = (name, mode = 'reply', reply = '普通回复。') => writeFile(scenarioPath, JSON.stringify({ name, mode, reply }));
  const memory = createUnifiedMemory({ memoryPath, now: () => currentAt });
  async function seedExpansion() {
    for (let index = 0; index < 12; index++) {
      currentAt = initialAt - (12 - index) * minute;
      await memory.writeExchange({ scope: 'qq:private:123456', senderLabel: '测试对象A',
        userText: index === 0 ? 'A_EXPANSION_EVIDENCE 第二个方案总价四百元，不是六百元。' : index === 11 ? '叫我小林。' : `日常闲谈片段编号${index}，今天路边开了一朵花。`,
        replyText: index === 0 ? '明白，第二个方案四百元。' : '看到了，花开得很好。', messageId: `seed-${index}` });
    }
    currentAt = initialAt;
    await memory.writeExchange({ scope: 'qq:private:234567', senderLabel: '测试对象B',
      userText: 'B_PRIVATE_SECRET A_EXPANSION_EVIDENCE 第二个方案总价九千元。', replyText: '这是另一人的私聊。', messageId: 'other-1' });
  }
  return { directory, url, initialAt, memoryPath, memory, sent, requests, start, stop, advance, snapshot, platform,
    calls, bytes, finished, send, scenario, seedExpansion, failSend: () => { failNextSend = true; } };
}

const ownScope = 'qq:private:123456';
const profile = f => f.memory.formatPrivateProfile({ scope: ownScope });

test('delivered self reports form a sourced private profile, survive restart, and accept correction without extra calls', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.start();
  await f.finished(await f.send('叫我小林。\n我喜欢乌龙茶。'));
  assert.equal((await f.calls()).length, 1);
  assert.match(await profile(f), /小林/); assert.match(await profile(f), /乌龙茶/);
  await f.stop(); await f.start(); await f.scenario('after-restart');
  await f.finished(await f.send('今天随便聊聊吧。'));
  const prompt = (await f.calls()).find(c => c.name === 'after-restart').prompt;
  assert.ok(prompt.includes(await profile(f)), 'the persisted same-person profile is actually injected');
  await f.scenario('correction');
  await f.finished(await f.send('以后叫我阿林。\n我不喜欢乌龙茶了。'));
  const current = await profile(f);
  assert.match(current, /阿林/); assert.doesNotMatch(current, /小林/);
  assert.match(current, /不喜欢.*乌龙茶|乌龙茶.*不喜欢/);
  assert.equal((await f.calls()).length, 3); assert.equal(f.sent.length, 3);
  const before = await profile(f);
  await f.memory.writeExchange({ scope: 'qq:private:234567', userText: '叫我隔壁小张。\n我喜欢PRIVATE_B_ONLY。', replyText: '记下了', messageId: 'B-profile' });
  assert.equal(await profile(f), before);
  await f.scenario('other'); await f.finished(await f.send('我们接着聊吧。', { sender: 234567 }));
  const other = (await f.calls()).find(c => c.name === 'other').prompt;
  assert.match(other, /隔壁小张/); assert.doesNotMatch(other, /阿林|乌龙茶/);
});

test('preview, failed delivery, missing-history clarification, commands and unauthorized/group events never create profiles', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.start();
  const preview = await fetch(f.url + '/api/qq/event', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'private_message', senderId: '123456', text: '叫我预览名字。', messageId: 9001 }) });
  assert.equal(preview.status, 200); assert.equal(await profile(f), ''); assert.equal(f.sent.length, 0);
  f.failSend(); const failed = await f.finished(await f.send('叫我失败名字。'));
  assert.equal(failed.send.ok, false); assert.equal(await profile(f), '');
  await f.scenario('clarify', 'marker'); await f.finished(await f.send('叫我澄清名字。刚才那个呢？'));
  assert.equal(await profile(f), '');
  const count = (await f.calls()).length;
  await f.finished(await f.send('/状态'));
  await f.finished(await f.send('叫我陌生名字。', { sender: 888888 }));
  await f.send('叫我群名字。', { group: 123456789 });
  assert.equal((await f.calls()).length, count); assert.equal(await profile(f), '');
  assert.equal(await f.memory.formatPrivateProfile({ scope: 'qq:private:888888' }), '');
});

test('real private expansion retains the same profile without another model pass or another recipient', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.seedExpansion();
  await f.scenario('expand-profile', 'expand'); await f.start();
  await f.finished(await f.send('刚才那个为什么？'));
  const calls = await f.calls(); const expected = await profile(f);
  assert.equal(calls.length, 2); assert.equal(f.sent.length, 1);
  assert.ok(calls.every(c => c.prompt.includes(expected)));
  assert.ok(calls.every(c => !c.prompt.includes('B_PRIVATE_SECRET')));
  assert.doesNotMatch(calls[0].prompt, /A_EXPANSION_EVIDENCE/);
  assert.match(calls[1].prompt, /A_EXPANSION_EVIDENCE/);
});

test('life merged replies receive only this contact profile and persist corrections once', { timeout: 30000 }, async t => {
  const f = await fixture(t, { life: true });
  await f.memory.writeExchange({ scope: ownScope, userText: '叫我小林。', replyText: '记下了。', messageId: 'seed-profile' });
  const timeline = await createLifeTimeline({ directory: join(f.directory, 'data', 'life'), now: () => f.initialAt });
  await timeline.addThought({ id: 'profile-thought', text: '想休息', source: { kind: 'interest', ref: 'isolated' },
    strength: 0.7, activity: { title: '休息', statusText: '休息中', durationMs: minute, busy: true, mode: 'simulated' } });
  await timeline.planThought('profile-thought', { id: 'profile-plan', startAt: f.initialAt + minute }); await timeline.close();
  await f.start(); await f.advance(f.initialAt + minute);
  const planState = status => until(async () => JSON.parse(await readFile(join(f.directory, 'data', 'life', 'snapshot.json'), 'utf8')).plans.some(p => p.id === 'profile-plan' && p.status === status), status);
  await planState('active');
  const before = await profile(f);
  await f.finished(await f.send('以后叫我阿林。')); await f.finished(await f.send('我喜欢红茶。'));
  assert.equal((await f.calls()).length, 0); assert.equal(await profile(f), before);
  await f.scenario('life-profile'); await f.advance(f.initialAt + 2 * minute); await planState('completed');
  const row = await until(async () => (await f.snapshot()).qq.events.find(r => r.source === 'life-resume' && r.completedAt), 'life reply');
  assert.equal(row.send.ok, true); assert.equal((await f.calls()).length, 1);
  assert.ok((await f.calls())[0].prompt.includes(before));
  assert.match(await profile(f), /阿林/); assert.match(await profile(f), /红茶/); assert.doesNotMatch(await profile(f), /小林/);
  await sleep(600); assert.equal((await f.calls()).length, 1); assert.equal(f.sent.length, 2);
});

test('after-delivery profile persistence failure never repeats a private send', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.scenario('save-failure', 'corrupt-before-save'); await f.start();
  const id = await f.send('叫我小林。'); const row = await f.finished(id);
  assert.equal(row.send.ok, true); assert.equal(row.memorySaved, false); assert.equal(await f.bytes(), 'not-json');
  await f.send('叫我小林。', { id }); await sleep(100);
  assert.equal((await f.calls()).length, 1); assert.equal(f.sent.length, 1);
});

