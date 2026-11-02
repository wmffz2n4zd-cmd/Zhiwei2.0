import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createUnifiedMemory } from '../src/unified-memory/index.js';

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

async function fixture(t, { budget = false } = {}) {
  const base = join(root, 'runtime', 'tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'private-memory-'));
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
    webLookup: false, assistantName: '知微', mood: { enabled: false },
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
        userText: index === 0 ? 'A_EXPANSION_EVIDENCE 第二个方案总价四百元，不是六百元。' : `日常闲谈片段编号${index}，今天路边开了一朵花。`,
        replyText: index === 0 ? '明白，第二个方案四百元。' : '看到了，花开得很好。', messageId: `seed-${index}` });
    }
    currentAt = initialAt;
    await memory.writeExchange({ scope: 'qq:private:234567', senderLabel: '测试对象B',
      userText: 'B_PRIVATE_SECRET A_EXPANSION_EVIDENCE 第二个方案总价九千元。', replyText: '这是另一人的私聊。', messageId: 'other-1' });
  }
  return { directory, url, initialAt, memoryPath, memory, sent, requests, start, stop, advance, snapshot, platform,
    calls, bytes, finished, send, scenario, seedExpansion, failSend: () => { failNextSend = true; } };
}

const clarification = /前文|哪一段|没接上|说的是|指的是/;

test('successful private exchange preserves both tails across restart and recalls the numbered relation without another person', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const detail = '北湾旅行第一方案周五出发。第二个方案改为周六出发，不是周五，预算四百元。';
  const user = '这次北湾旅行的背景。' + '沿途的风景已经记在笔记里。'.repeat(80) + detail;
  assert.ok(user.indexOf(detail) > 800);
  // The runtime's independent 900-character reply ceiling remains in force.
  const boundedReply = '这些旅行记录我记下了。' + '风景很好。'.repeat(160) + '答复尾部确认：北湾第二个方案不是周五。';
  assert.ok(boundedReply.indexOf('答复尾部确认') > 800 && boundedReply.length < 900);
  await f.scenario('save', 'reply', boundedReply); await f.start();
  await f.finished(await f.send(user));
  const stored = JSON.parse(await f.bytes());
  assert.match(JSON.stringify(stored), /第二个方案改为周六出发，不是周五，预算四百元/);
  assert.match(JSON.stringify(stored), /答复尾部确认：北湾第二个方案不是周五/);
  const sourceId = stored.entries.find(entry => entry.source === 'qq').id;
  await f.stop();
  await f.memory.writeExchange({ scope: 'qq:private:234567', senderLabel: '测试对象B', userText: 'B_PRIVATE_SECRET 北湾第二个方案周三出发。', replyText: '只属于B。' });
  await f.scenario('continuation'); await f.start();
  await f.finished(await f.send('第二个方案呢，刚才那个时间可以吗？'));
  const continuation = (await f.calls()).find(call => call.name === 'continuation').prompt;
  assert.match(continuation, /第一方案周五出发/);
  assert.match(continuation, /第二个方案改为周六出发，不是周五/);
  assert.ok(continuation.includes(sourceId));
  assert.doesNotMatch(continuation, /B_PRIVATE_SECRET|周三出发/);
  await f.stop(); await f.advance(f.initialAt + 9 * day); await f.scenario('old-recall'); await f.start();
  await f.finished(await f.send('北湾旅行第二个方案原来的出发安排是什么？'));
  const old = (await f.calls()).find(call => call.name === 'old-recall').prompt;
  assert.match(old, /改为周六出发，不是周五/);
  assert.match(old, /答复尾部确认：北湾第二个方案不是周五/);
  assert.doesNotMatch(old, /B_PRIVATE_SECRET|周三出发/);
});

test('ordinary short replies keep recent private turns across restart while retaining old relevant evidence', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  await f.advance(f.initialAt - 30 * day);
  await f.memory.write({ scope: 'qq:private:123456', summary: '火星计划的最终发射口令是A_OLD_ORBIT，之前的口令已作废。' });
  await f.advance(f.initialAt - 5 * minute);
  const first = await f.memory.writeExchange({ scope: 'qq:private:123456',
    userText: 'A_RECENT_FIRST_USER 今天终于把书架收拾好了。', replyText: 'A_RECENT_FIRST_REPLY 那本一直找不到的画册呢？', messageId: 'recent-first' });
  await f.advance(f.initialAt - 2 * minute);
  const second = await f.memory.writeExchange({ scope: 'qq:private:123456',
    userText: 'A_RECENT_SECOND_USER 找到了，原来被我放进抽屉。', replyText: 'A_RECENT_SECOND_REPLY 看来抽屉比书架更会藏东西。', messageId: 'recent-second' });
  await f.memory.writeExchange({ scope: 'qq:private:234567',
    userText: 'B_RECENT_PRIVATE 另一个人的最新私聊。', replyText: 'B_RECENT_PRIVATE_REPLY 不能进入A的提示。' });
  await f.advance(f.initialAt);
  await f.scenario('recent-ack', 'reply', '那就好。'); await f.start();
  const ack = await f.finished(await f.send('嗯', { quote: null }));
  let calls = await f.calls();
  assert.equal(calls.length, 1); assert.equal(ack.timings.modelCalls, 1);
  const prompt = calls[0].prompt;
  for (const text of ['A_RECENT_FIRST_USER', 'A_RECENT_FIRST_REPLY', 'A_RECENT_SECOND_USER', 'A_RECENT_SECOND_REPLY']) assert.ok(prompt.includes(text), text);
  assert.ok(prompt.indexOf('A_RECENT_FIRST_USER') < prompt.indexOf('A_RECENT_SECOND_USER'), 'recent turns preserve chronological order');
  for (const id of [first.entry.id, second.entry.id]) assert.equal(prompt.split(id).length - 1, 1, 'do not duplicate recent sources');
  assert.doesNotMatch(prompt, /B_RECENT_PRIVATE|A_OLD_ORBIT/);

  await f.stop(); await f.scenario('recent-laugh', 'reply', '我也觉得挺好笑。'); await f.start();
  const laugh = await f.finished(await f.send('哈哈', { quote: null }));
  calls = await f.calls();
  assert.equal(calls.length, 2); assert.equal(laugh.timings.modelCalls, 1);
  assert.match(calls[1].prompt, /A_RECENT_SECOND_USER/);
  assert.match(calls[1].prompt, /那就好/);
  assert.doesNotMatch(calls[1].prompt, /B_RECENT_PRIVATE/);

  await f.scenario('recent-new-topic');
  const topic = await f.finished(await f.send('火星计划的最终发射口令是什么？', { quote: null }));
  calls = await f.calls();
  assert.equal(calls.length, 3); assert.equal(topic.timings.modelCalls, 1);
  assert.match(calls[2].prompt, /A_OLD_ORBIT/);
  assert.match(calls[2].prompt, /A_RECENT_SECOND_USER/);
  assert.match(calls[2].prompt, /我也觉得挺好笑/);
  assert.doesNotMatch(calls[2].prompt, /B_RECENT_PRIVATE/);

  await f.stop(); await f.advance(f.initialAt + 3 * 60 * minute);
  await f.scenario('recent-expired'); await f.start();
  const expired = await f.finished(await f.send('嗯', { quote: null }));
  calls = await f.calls();
  assert.equal(calls.length, 4); assert.equal(expired.timings.modelCalls, 1);
  assert.doesNotMatch(calls[3].prompt, /A_RECENT_|B_RECENT_PRIVATE|A_OLD_ORBIT/);
  assert.equal(f.sent.length, 4, 'recent context adds neither an extra generation nor an extra send');
});

test('model-requested private expansion adds previously absent evidence with provenance and sends once', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.seedExpansion(); await f.scenario('expanded', 'expand'); await f.start();
  const id = await f.send('刚才那个为什么？'); const row = await f.finished(id);
  const calls = await f.calls();
  assert.equal(calls.length, 2); assert.equal(row.timings.modelCalls, 2);
  assert.doesNotMatch(calls[0].prompt, /A_EXPANSION_EVIDENCE/);
  assert.match(calls[1].prompt, /A_EXPANSION_EVIDENCE/);
  const source = JSON.parse(await f.bytes()).entries.find(entry => JSON.stringify(entry).includes('A_EXPANSION_EVIDENCE') && entry.scope === 'qq:private:123456');
  assert.ok(calls[1].prompt.includes(source.id));
  assert.ok(calls.every(call => !call.prompt.includes('B_PRIVATE_SECRET')));
  assert.equal(f.sent.length, 1); assert.match(JSON.stringify(f.sent), /第二个方案总价四百元/);
  assert.doesNotMatch(JSON.stringify(f.sent), /qq_context_more|HISTORY_MISSING/);
  await f.send('刚才那个为什么？', { id }); await sleep(100);
  assert.equal((await f.calls()).length, 2); assert.equal(f.sent.length, 1, 'duplicate callback cannot expand or send again');
});

test('empty expansion stops without a second model call and repeated markers stop after one expansion', { timeout: 30000 }, async t => {
  const empty = await fixture(t); await empty.scenario('empty', 'marker'); await empty.start();
  const row = await empty.finished(await empty.send('刚才那个为什么？'));
  assert.equal((await empty.calls()).length, 1); assert.equal(row.timings.modelCalls, 1);
  assert.equal(empty.sent.length, 1); assert.match(row.reply, clarification);
  assert.doesNotMatch(row.reply, /qq_context_more/);
  assert.equal(await empty.bytes(), '', 'a local missing-evidence clarification is not a normal exchange');

  const repeated = await fixture(t); await repeated.seedExpansion(); await repeated.scenario('repeat', 'marker'); await repeated.start();
  const beforeRepeated = await repeated.bytes();
  const last = await repeated.finished(await repeated.send('刚才那个为什么？'));
  assert.equal((await repeated.calls()).length, 2); assert.equal(last.timings.modelCalls, 2);
  assert.equal(repeated.sent.length, 1); assert.match(last.reply, clarification);
  assert.doesNotMatch(last.reply, /qq_context_more/);
  assert.equal(await repeated.bytes(), beforeRepeated);
});

test('expansion subprocess failure becomes one bounded clarification without leaking diagnostics', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.seedExpansion(); await f.scenario('failure', 'expansion-failure'); await f.start();
  const before = await f.bytes();
  const row = await f.finished(await f.send('刚才那个为什么？'));
  assert.equal((await f.calls()).length, 2); assert.equal(row.timings.modelCalls, 2);
  assert.equal(f.sent.length, 1); assert.match(row.reply, clarification);
  assert.doesNotMatch(JSON.stringify(f.sent), /ISOLATED_FAILURE_PRIVATE_SECRET|qq_context_more|总价四百元/);
  assert.equal(await f.bytes(), before, 'failed expansion does not invent an ordinary exchange');
});

test('an unreadable expansion store preserves the file and completes one local clarification', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.seedExpansion(); await f.scenario('read-failure', 'corrupt-before-expansion'); await f.start();
  const row = await f.finished(await f.send('刚才那个为什么？'));
  assert.equal((await f.calls()).length, 1); assert.equal(row.timings.modelCalls, 1);
  assert.equal(f.sent.length, 1); assert.equal(row.send.ok, true); assert.match(row.reply, clarification);
  assert.equal(await f.bytes(), 'not-json', 'read failure must not replace a damaged original with a fresh empty store');
  assert.doesNotMatch(JSON.stringify(f.sent), /qq_context_more|总价四百元|SyntaxError/);
});

test('a persistence failure after successful delivery finishes the event without retrying the send', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.scenario('save-failure', 'corrupt-before-save', '这条回复已经成功送达。'); await f.start();
  const id = await f.send('正常回答之后出现保存故障');
  const row = await f.finished(id);
  assert.equal((await f.calls()).length, 1); assert.equal(f.sent.length, 1);
  assert.equal(row.send.ok, true); assert.equal(row.memorySaved, false);
  assert.match(row.reply, /已经成功送达/); assert.equal(await f.bytes(), 'not-json');
  await f.send('正常回答之后出现保存故障', { id }); await sleep(100);
  assert.equal((await f.calls()).length, 1); assert.equal(f.sent.length, 1);
});

test('embedded expansion markers cannot leak in a first or second model response', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.seedExpansion(); await f.scenario('mixed-expanded', 'mixed-expand'); await f.start();
  await f.finished(await f.send('刚才那个为什么？'));
  assert.equal((await f.calls()).length, 2); assert.equal(f.sent.length, 1);
  assert.match(JSON.stringify(f.sent), /第二个方案总价四百元/);
  assert.doesNotMatch(JSON.stringify(f.sent), /qq_context_more|我还需要核对|HISTORY_MISSING/);

  const repeated = await fixture(t); await repeated.seedExpansion(); await repeated.scenario('mixed-repeated', 'mixed-marker'); await repeated.start();
  const row = await repeated.finished(await repeated.send('刚才那个为什么？'));
  assert.equal((await repeated.calls()).length, 2); assert.equal(repeated.sent.length, 1);
  assert.match(row.reply, clarification);
  assert.doesNotMatch(JSON.stringify(repeated.sent), /qq_context_more|不应该把这句/);
});

test('expansion uses the real shared budget admission and cannot spend a second reservation', { timeout: 30000 }, async t => {
  const f = await fixture(t, { budget: true }); await f.seedExpansion(); await f.scenario('budget', 'expand'); await f.start();
  const before = await f.bytes();
  const row = await f.finished(await f.send('刚才那个为什么？'));
  assert.equal((await f.calls()).length, 1); assert.equal(row.timings.modelCalls, 1);
  assert.equal(f.sent.length, 1); assert.match(row.reply, clarification);
  assert.equal(await f.bytes(), before);
  assert.equal((await f.platform()).runtimeBudget.chargedPlusPercent, 75);
  await f.stop(); await f.start();
  const denied = await f.finished(await f.send('重启以后也不能绕过预算'));
  assert.equal(denied.timings.modelCalls, 0); assert.equal((await f.calls()).length, 1);
  assert.match(denied.reply, /本周的知微运行预算/);
  assert.equal((await f.platform()).runtimeBudget.chargedPlusPercent, 75);
});

test('failed delivery, slash commands and rejected group callbacks do not become ordinary private memories', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.start();
  await f.scenario('failed-send', 'reply', 'FAILED_SEND_REPLY'); f.failSend();
  const failed = await f.finished(await f.send('FAILED_SEND_USER'));
  assert.equal(failed.send.ok, false);
  assert.doesNotMatch(await f.bytes(), /FAILED_SEND_USER|FAILED_SEND_REPLY/);
  await f.scenario('command'); await f.finished(await f.send('/状态'));
  assert.equal((await f.calls()).length, 1, 'local command cannot invoke the model');
  assert.doesNotMatch(await f.bytes(), /统一记忆|\/状态/);
  const before = { calls: (await f.calls()).length, sends: f.sent.length, bytes: await f.bytes(), requests: f.requests.length };
  await f.send('GROUP_MEMORY_SECRET', { group: 123456789 });
  assert.equal((await f.calls()).length, before.calls); assert.equal(f.sent.length, before.sends);
  assert.equal(await f.bytes(), before.bytes); assert.equal(f.requests.length, before.requests);
});

test('Web preview produces no ordinary exchange memory without a delivered QQ message', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.start(); await f.scenario('web-preview', 'reply', 'WEB_PREVIEW_REPLY');
  const before = await f.bytes();
  const response = await fetch(f.url + '/api/qq/event', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'private_message', senderId: '123456', text: 'WEB_PREVIEW_USER', messageId: 9001 }) });
  assert.equal(response.status, 200);
  assert.equal((await f.calls()).length, 1); assert.equal(f.sent.length, 0);
  const row = (await f.snapshot()).qq.events.find(item => item.event.text === 'WEB_PREVIEW_USER');
  assert.match(row.reply, /WEB_PREVIEW_REPLY/); assert.equal(await f.bytes(), before);
});

test('quoted private history rejects other conversations and bot quotes without verified delivery provenance', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.start();
  for (const quote of ['501', '502', '503']) {
    await f.scenario(`quote-${quote}`); await f.finished(await f.send('帮我看一下引用的这句话', { quote }));
  }
  const calls = await f.calls();
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !/OUT_OF_SCOPE_QUOTE/.test(call.prompt)));
  assert.equal(f.requests.some(request => request.path === '/get_forward_msg'), false,
    'scope rejection must precede following a forwarded source');
  assert.doesNotMatch(await f.bytes(), /OUT_OF_SCOPE_QUOTE/);
  await f.scenario('quote-verified'); await f.finished(await f.send('蓝色盒子的存放位置我记住了', { quote: '504' }));
  assert.match((await f.calls()).find(call => call.name === 'quote-verified').prompt, /VERIFIED_PRIVATE_QUOTE/);
  assert.match(await f.bytes(), /VERIFIED_PRIVATE_QUOTE/);
  await f.scenario('quote-unverified'); await f.finished(await f.send('这里的盒子是哪个', { quote: '505' }));
  assert.doesNotMatch((await f.calls()).find(call => call.name === 'quote-unverified').prompt, /UNVERIFIED_BOT_QUOTE/);
  assert.doesNotMatch(await f.bytes(), /UNVERIFIED_BOT_QUOTE/);
});

test('a bot quote without recipient metadata needs same-person delivery evidence that survives restart', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.scenario('send-proof', 'reply', 'DELIVERED_A_REPLY 这是只发给对象A的答复。'); await f.start();
  await f.finished(await f.send('今天先聊到这里'));
  assert.equal(f.sent.length, 1);
  await f.stop(); await f.start();
  await f.scenario('quote-with-proof'); await f.finished(await f.send('这条答复里你说的是什么意思', { quote: '10001' }));
  const own = (await f.calls()).find(call => call.name === 'quote-with-proof').prompt;
  assert.match(own, /被回复\/引用的消息上下文：[\s\S]*DELIVERED_A_REPLY/);
  await f.scenario('quote-wrong-person'); await f.finished(await f.send('这条答复是什么意思', { sender: 234567, quote: '10001' }));
  const other = (await f.calls()).find(call => call.name === 'quote-wrong-person').prompt;
  assert.doesNotMatch(other, /DELIVERED_A_REPLY|只发给对象A/);
  const otherStored = JSON.parse(await f.bytes()).entries.filter(entry => entry.scope === 'qq:private:234567');
  assert.doesNotMatch(JSON.stringify(otherStored), /DELIVERED_A_REPLY|只发给对象A/);
});
