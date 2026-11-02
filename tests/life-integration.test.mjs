import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, cp, mkdtemp, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLifeTimeline } from '../src/life-timeline.js';
import { createWorld } from '../src/world.js';
import { summarizeRuntimeUsage } from '../src/runtime-usage.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const minute = 60000;
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(check, description, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await check();
    if (result) return result;
    await sleep(25);
  }
  throw Error(`Timed out waiting for ${description}`);
}

async function fixture(t, { enabled = true, plans = 2, planDurationMs = minute, planning = false,
  runtimeBudget = { enabled: false }, trustedMeter = false, remoteEnabled = false, allowOtherPrivateChats = false,
  experiences = [], browsing = false, holdFirstSend = false, action = null, planDelayMs = minute,
  tickIntervalMs = 250, planFlexMs = null, failActiveSnapshotOnce = false,
  startTime = Date.UTC(2026, 9, 27, 10, 0, 0) } = {}) {
  const baseDirectory = join(root, 'runtime', 'tests');
  await mkdir(baseDirectory, { recursive: true });
  const directory = await mkdtemp(join(baseDirectory, 'life-integration-'));
  const startedAt = startTime;
  const clockPath = join(directory, 'clock.json'), callsPath = join(directory, 'calls.jsonl');
  const scenarioPath = join(directory, 'scenario.json'), memoryPath = join(directory, 'data', 'unified-memory.json');
  const holdStartedPath = join(directory, 'model-held'), holdReleasePath = join(directory, 'model-release');
  const holdFinishedPath = join(directory, 'held-model-finished');
  const choiceHeldPath = join(directory, 'choice-held'), choiceReleasePath = join(directory, 'choice-release');
  const choiceFinishedPath = join(directory, 'choice-finished');
  const requests = [], sent = [];
  let releaseSend;
  const firstSendReleased = new Promise(done => { releaseSend = done; });
  let child, logs = '', messageId = 0;
  const bridge = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    requests.push({ path: req.url, body });
    assert.equal(req.headers.authorization, 'Bearer isolated-life-api');
    let data = { user_id: 999999, nickname: 'isolated life bridge' };
    if (req.url === '/get_msg') data = { message_id: body.message_id, user_id: 999999,
      message: [{ type: 'text', data: { text: '之前的普通回复。' } }] };
    if (req.url === '/get_image') data = { file: join(directory, 'data', 'qq-stickers', '笑.png') };
    if (req.url === '/send_private_msg' || req.url === '/send_group_msg') {
      sent.push({ path: req.url, ...body }); data = { message_id: 10000 + sent.length };
      if (holdFirstSend && sent.length === 1) await firstSendReleased;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', data }));
  });
  await new Promise(done => bridge.listen(0, '127.0.0.1', done));
  const probe = createServer();
  await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  const url = `http://127.0.0.1:${port}`;
  async function stop() {
    if (child && child.exitCode == null) {
      const closed = once(child, 'close'); child.kill(); await closed;
    }
    child = null;
  }
  t.after(async () => {
    releaseSend();
    try {
      if (await readFile(choiceHeldPath, 'utf8').catch(() => false)) {
        await writeFile(choiceReleasePath, 'released');
        await until(() => readFile(choiceFinishedPath, 'utf8').catch(() => false), 'held choice cleanup', 5000);
      }
      if (await readFile(holdStartedPath, 'utf8').catch(() => false)) {
        await writeFile(holdReleasePath, 'released');
        await until(() => readFile(holdFinishedPath, 'utf8').catch(() => false), 'held fake model cleanup', 5000);
      }
    } finally {
      await stop();
      bridge.closeAllConnections(); await new Promise(done => bridge.close(done));
      // Only this test's freshly allocated workspace can be removed.
      if (resolve(directory).startsWith(resolve(baseDirectory) + sep)) await rm(directory, { recursive: true, force: true });
    }
  });

  await cp(join(root, 'src'), join(directory, 'src'), { recursive: true });
  if (failActiveSnapshotOnce) {
    // Inject only into this fixture's copy. snapshot.json is a replaceable
    // checkpoint; its failure must not erase a committed journal transition.
    const timelinePath = join(directory, 'src', 'life-timeline.js');
    let source = await readFile(timelinePath, 'utf8');
    assert.ok(source.includes('async function atomicWrite(path, content) {'));
    assert.ok(source.includes('    await rename(temporary, path);'));
    source = source.replace('async function atomicWrite(path, content) {',
      'let testActiveSnapshotDenied = false;\nasync function atomicWrite(path, content) {');
    source = source.replace('    await rename(temporary, path);', `
    if (!testActiveSnapshotDenied && path.endsWith('snapshot.json') && JSON.parse(content).plans?.some(plan => plan.status === 'active')) {
      testActiveSnapshotDenied = true;
      const error = Error('TEST_ONCE_ACTIVE_SNAPSHOT_RENAME_DENIED'); error.code = 'EPERM'; throw error;
    }
    await rename(temporary, path);`);
    await writeFile(timelinePath, source);
  }
  if (browsing) {
    await cp(join(directory, 'src', 'browser-reader.js'), join(directory, 'src', 'browser-reader-real.js'));
    await writeFile(join(directory, 'src', 'browser-reader.js'), `
import { appendFile } from 'node:fs/promises';
export { isXBrowserUrl } from './browser-reader-real.js';
export function createBrowserReader() {
 return { status: () => ({mode:'readonly',busy:false}), close: async () => {},
  read: async url => {await appendFile(${JSON.stringify(join(directory, 'browser-calls.jsonl'))},JSON.stringify({url})+'\\n');return {url,title:'OBSERVED_READING_TITLE',text:'OBSERVED_PAGE_TEXT',links:[],imagePaths:[],requiresLogin:false};},
  search: async query => ({url:'https://example.org/search',title:'Observed search',text:query,links:[],imagePaths:[],requiresLogin:false}) };
}
`);
  }
  await cp(join(root, 'modules', 'web-console'), join(directory, 'modules', 'web-console'), { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await mkdir(join(directory, 'data', 'qq-stickers'), { recursive: true });
  await writeFile(join(directory, 'data', 'qq-stickers', '笑.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXfoAAAAASUVORK5CYII=', 'base64'));
  await writeFile(join(directory, 'data', 'windows.local.json'), JSON.stringify({
    ...(runtimeBudget === null ? {} : { runtimeBudget }),
    ownerUserIds: ['123456', '234567'], allowOtherPrivateChats,
    qqEnabled: true, remoteEnabled, webLookup: false, assistantName: '知微',
    mood: { enabled: true }, world: { enabled: planning || browsing },
    ...(enabled ? { life: { enabled: true, tickIntervalMs, planning: { enabled: planning } } } : {}),
    oneBotSecret: 'isolated-life-callback', oneBotAccessToken: 'isolated-life-api',
    oneBotApiBase: `http://127.0.0.1:${bridge.address().port}`,
    qqImageCacheRoots: [join(directory, 'data', 'qq-stickers')]
  }));
  await writeFile(clockPath, JSON.stringify({ now: startedAt }));
  if (trustedMeter) {
    // Replace only the copied adapter in this isolated workspace; never a real
    // account or auth file. The actual RPC adapter has separate protocol tests.
    await writeFile(join(directory, 'src', 'codex-quota.js'), `
export const WEEKLY_PLUS_CAP_PERCENT = 80;
export async function readAccountQuota() {
 return { source:'account/rateLimits/read', attribution:'account-total', limitId:'codex',
 planType:'prolite', accountScopeKey:'isolated-budget-scope', ordinaryUsageAllowed:true, checkedAt:new Date(Date.now()).toISOString(),
 weekly:{usedPercent:20,windowDurationMins:10080,resetsAt:${startedAt / 1000 + 7 * 86400}},shorter:[] };
}
`);
  }
  await writeFile(scenarioPath, JSON.stringify({ name: 'ordinary', reply: '普通聊天仍然正常。' }));
  const clockModule = join(directory, 'clock.mjs');
  await writeFile(clockModule, `import { readFileSync } from 'node:fs';
let value = JSON.parse(readFileSync(${JSON.stringify(clockPath)}, 'utf8')).now;
Date.now = () => {
  try { value = JSON.parse(readFileSync(${JSON.stringify(clockPath)}, 'utf8')).now; } catch {}
  return value;
};
`);
  const fakeCli = join(directory, 'fake-codex.mjs');
  await writeFile(fakeCli, `import { readFile, writeFile, appendFile } from 'node:fs/promises';
const args = process.argv.slice(2); let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const scenario = JSON.parse(await readFile(${JSON.stringify(scenarioPath)}, 'utf8'));
const schema = args.includes('--output-schema') ? JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8')) : null;
await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ name: scenario.name, prompt, args, schema, held: Boolean(scenario.hold) }) + '\\n');
if (schema?.properties.choice) {
 if (scenario.holdChoice) {
  await writeFile(${JSON.stringify(choiceHeldPath)}, 'held');
  let released = false;
  for (let attempt = 0; attempt < 1500; attempt++) {
   released = await readFile(${JSON.stringify(choiceReleasePath)}, 'utf8').catch(() => false);
   if (released) break;
   await new Promise(done => setTimeout(done, 10));
  }
  if (!released) throw Error('Isolated held choice was not released');
 }
 const text = JSON.stringify(scenario.choiceDecision || {choice:'activity',reason:'当前活动更吸引我，按计划进行。',reply:''});
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:0,output_tokens:50}}));
 if (scenario.holdChoice) await writeFile(${JSON.stringify(choiceFinishedPath)}, 'finished');
 process.exit(0);
}
if (schema && !schema.properties.contactBoundary && !schema.properties.sourceRefs) {
 const text=JSON.stringify(prompt.includes('正在进行个人阅读') ? (scenario.worldDecision || {action:'rest'}) : scenario.lifeDecision || { thoughts:[{text:'想画一会画',sourceRefs:['profile'],strength:0.7,
 title:'画画',statusText:'*画画中，稍后回来',busy:true,durationMinutes:5,delayMinutes:1}],reconsiderAfterMinutes:1440 });
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:0,output_tokens:50}}));
 process.exit(0);
}

if (scenario.hold) {
  await writeFile(${JSON.stringify(holdStartedPath)}, 'held');
  let released = false;
  for (let attempt = 0; attempt < 1500; attempt++) {
    released = await readFile(${JSON.stringify(holdReleasePath)}, 'utf8').catch(() => false);
    if (released) break;
    await new Promise(done => setTimeout(done, 10));
  }
  if (!released) throw Error('Isolated held model was not released');
}
let reply = scenario.reply;
if (scenario.name === 'resume') reply = prompt.includes('SECOND_OWNER_SECRET')
  ? '[[qq_context_more]]' : '回来了，刚才安静看了一会书。\\n[[qq_sticker:笑.png]]';
if (schema?.properties.contactBoundary) reply = JSON.stringify({reply,contextMore:reply.includes('[[qq_context_more]]'),
 contactBoundary:scenario.contactBoundary || {kind:'none',quote:''}});
if (schema?.properties.sourceRefs) {
 const marker='当前这一位对象的有界资料和生活动因：\\n';
 const input=JSON.parse(prompt.slice(prompt.lastIndexOf(marker)+marker.length));
 reply = JSON.stringify(scenario.proactiveAuto ? {reply:'刚想到一件想和你聊的小事。',sourceRefs:input.sources.slice(0,2).map(s=>s.ref)} : scenario.proactiveDecision || {reply:null,sourceRefs:[]});
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:reply}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:0,output_tokens:50}}));
 if (scenario.hold) await writeFile(${JSON.stringify(holdFinishedPath)}, 'finished');
 process.exit(0);
}
await writeFile(args[args.indexOf('-o') + 1], reply);
if (scenario.emitUsage) {
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:reply}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,cached_input_tokens:5,output_tokens:3}}));
}
if (scenario.hold) await writeFile(${JSON.stringify(holdFinishedPath)}, 'finished');
`);
  if (plans || experiences.length) {
    const timeline = await createLifeTimeline({ directory: join(directory, 'data', 'life'), now: () => startedAt });
    try {
      for (const experience of experiences) await timeline.recordExperience(experience);
      for (let index = 0; index < plans; index++) {
        await timeline.addThought({ id: `thought-${index}`, text: '想安静看一会书', source: { kind: 'interest', ref: 'isolated-test' },
          ...(planFlexMs == null ? {} : { expiresAt: startedAt + planDelayMs + index * 20 * minute + planDurationMs + planFlexMs }),
          strength: 0.7, activity: { title: '看书', statusText: '*看书中…勿扰', durationMs: planDurationMs,
            busy: !action, mode: action ? 'external' : 'simulated', ...(action ? { action } : {}) } });
        await timeline.planThought(`thought-${index}`, { id: `plan-${index}`, startAt: startedAt + planDelayMs + index * 20 * minute });
      }
    } finally { await timeline.close(); }
  }

  async function start() {
    child = spawn(process.execPath, ['--import', pathToFileURL(clockModule).href, 'src/server.js'], {
      cwd: directory, windowsHide: true,
      env: { ...process.env, PORT: String(port), CODEX_CLI_PATH: fakeCli, CODEX_REMOTE_CONTACT_QQ_WEB_LOOKUP: '0' }
    });
    child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
    try { await until(() => fetch(url + '/api/platform').then(res => res.ok).catch(() => false), 'isolated Hub startup'); }
    catch (error) { throw Error(`${error.message}\n${logs}`); }
  }
  const platform = () => fetch(url + '/api/platform').then(res => res.json());
  const snapshot = () => fetch(url + '/api/state').then(res => res.json());
  const calls = async () => (await readFile(callsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const memory = () => readFile(memoryPath, 'utf8').catch(() => '');
  const finished = id => until(async () => (await snapshot()).qq.events.find(row => row.event.raw?.message_id === id && row.completedAt), `message ${id} completion`);
  async function advance(now) {
    await writeFile(clockPath + '.next', JSON.stringify({ now }));
    await rename(clockPath + '.next', clockPath);
  }
  const planState = async (index, status) => until(async () => {
    const saved = await readFile(join(directory, 'data', 'life', 'snapshot.json'), 'utf8').then(JSON.parse).catch(() => null);
    return saved?.plans.find(plan => plan.id === `plan-${index}` && plan.status === status);
  }, `plan ${index} ${status}`);
  async function send(text, { sender = 123456, group, image = false, audio = false, id, quoted = true, quoteId = '77', expectedStatus = 200 } = {}) {
    const payload = { post_type: 'message', message_type: group ? 'group' : 'private', self_id: 999999,
      user_id: sender, message_id: id ?? ++messageId, raw_message: text, ...(group ? { group_id: group } : {}),
      // Quoted messages bypass only the short batching window, exercising real admission.
      message: [...(quoted ? [{ type: 'reply', data: { id: quoteId } }] : []), { type: 'text', data: { text } },
        ...(audio ? [{ type: 'record', data: { file: 'unread-audio' } }] : []),
        ...(image ? [{ type: 'image', data: { file: 'busy-image-must-not-be-read' } }] : [])] };
    const raw = JSON.stringify(payload), signature = 'sha1=' + createHmac('sha1', 'isolated-life-callback').update(raw).digest('hex');
    const response = await fetch(url + '/api/onebot/event', { method: 'POST', headers: { 'x-signature': signature }, body: raw });
    assert.equal(response.status, expectedStatus);
    if (group) assert.equal((await response.json()).ignored, true);
    return payload.message_id;
  }
  const scenario = (name, reply = '普通聊天仍然正常。', options = {}) => writeFile(scenarioPath, JSON.stringify({ name, reply, ...options }));
  const releaseModel = () => writeFile(holdReleasePath, 'released');
  const releaseChoice = () => writeFile(choiceReleasePath, 'released');
  const life = () => readFile(join(directory, 'data', 'life', 'snapshot.json'), 'utf8').then(JSON.parse);
  const observed = at => until(async () => {
    const saved = await readFile(join(directory, 'data', 'life', 'snapshot.json'), 'utf8').then(JSON.parse).catch(() => null);
    return saved?.lastObservedAt >= at;
  }, `timeline observation at ${at}`);
  return { directory, url, startedAt, sent, requests, start, stop, advance, planState, platform, snapshot,
    calls, memory, life, finished, send, scenario, releaseModel, releaseChoice, releaseSend, observed, logs: () => logs };
}

test('developer life observer uses actual Hub routing without changing life files or invoking models and sends', { timeout: 20000 }, async t => {
  const f = await fixture(t, { plans: 0, experiences: [
    { source: { kind: 'role-life', ref: 'public-fixture' }, id: 'public-observation', kind: 'rest', mode: 'simulated', summary: 'PUBLIC_ROLE_LIFE', effects: null },
    { source: { kind: 'private', ref: 'PRIVATE_SOURCE_SECRET', scope: 'qq:private:234567' }, id: 'private-observation', kind: 'chat', mode: 'simulated', summary: 'PRIVATE_OBSERVER_SECRET', effects: null }
  ] });
  await f.start(); await f.observed(f.startedAt);
  const inventory = async () => {
    const result = {};
    async function walk(path, prefix = '') {
      for (const item of await readdir(path, { withFileTypes: true })) {
        const relative = prefix + item.name;
        if (item.isDirectory()) await walk(join(path, item.name), relative + '/');
        else result[relative] = (await readFile(join(path, item.name))).toString('base64');
      }
    }
    await walk(join(f.directory, 'data', 'life'));
    return result;
  };
  const before = await inventory();
  const headers = { 'x-life-observer-client': 'developer', origin: f.url };
  assert.equal((await fetch(f.url + '/life-observer.html')).status, 200);
  assert.equal((await fetch(f.url + '/api/life-observer/report')).status, 403);
  const session = await fetch(f.url + '/api/life-observer/session', { headers });
  assert.equal(session.status, 200);
  headers['x-life-observer-token'] = (await session.json()).token;
  const response = await fetch(f.url + '/api/life-observer/report', { headers });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.match(JSON.stringify(report), /PUBLIC_ROLE_LIFE/);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_OBSERVER_SECRET|PRIVATE_SOURCE_SECRET|qq:private:234567|private-observation/);
  assert.deepEqual(await (await fetch(f.url + '/api/life-observer/report', { headers })).json(), report);
  assert.equal((await fetch(f.url + '/api/life-observer/report?scope=qq%3Aprivate%3A234567', { headers })).status, 400);
  assert.equal((await fetch(f.url + '/api/life-observer/report', { headers: { ...headers, 'x-forwarded-for': '192.0.2.1' } })).status, 403);
  const daily = await fetch(f.url + '/api/life-observer/report?date=2026-10-27&days=1', { headers });
  assert.equal(daily.status, 200);
  assert.deepEqual(await inventory(), before, 'viewing must not write life state, locks, logs or checkpoints');
  assert.equal((await f.calls()).length, 0); assert.equal(f.sent.length, 0);
});

test('developer life observer reports disabled without creating a life directory', { timeout: 20000 }, async t => {
  const f = await fixture(t, { enabled: false, plans: 0 }); await f.start();
  const headers = { 'x-life-observer-client': 'developer', origin: f.url };
  const session = await fetch(f.url + '/api/life-observer/session', { headers });
  assert.equal(session.status, 200);
  headers['x-life-observer-token'] = (await session.json()).token;
  const response = await fetch(f.url + '/api/life-observer/report', { headers });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.match(JSON.stringify(report), /disabled/);
  assert.equal((await readdir(join(f.directory, 'data'))).includes('life'), false);
  assert.equal((await f.calls()).length, 0); assert.equal(f.sent.length, 0);
});

test('life admission avoids media/model work while busy, merges per person once, and respects commands and QQ off', { timeout: 45000 }, async t => {
  const f = await fixture(t); await f.start();
  assert.equal((await f.platform()).lifeEnabled, true);
  const initial = await f.finished(await f.send('普通私聊还在吗'));
  assert.equal(initial.timings.modelCalls, 1);
  assert.match(JSON.stringify(f.sent.at(-1)), /普通聊天仍然正常/);

  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  const before = { calls: (await f.calls()).length, sends: f.sent.length, requests: f.requests.length, memory: await f.memory() };
  await f.finished(await f.send('BUSY_FIRST 我先放在这里', { image: true }));
  await f.finished(await f.send('BUSY_SECOND 不用逐条回复', { image: true }));
  await f.finished(await f.send('SECOND_OWNER_SECRET 这是另一人的话', { sender: 234567, image: true }));
  await f.finished(await f.send('UNAUTHORIZED_SECRET', { sender: 888888, image: true }));
  await f.send('GROUP_SECRET', { group: 123456789, image: true });
  assert.equal((await f.calls()).length, before.calls, 'busy notices and ignored messages cannot invoke the model');
  assert.equal(f.sent.length, before.sends + 2, 'each authorized person gets one busy notice');
  assert.ok(f.sent.slice(before.sends).every(message => message.message.length === 1 && message.message[0].type === 'text'));
  assert.ok(f.sent.slice(before.sends).every(message => JSON.stringify(message).includes('看书中')));
  assert.equal(f.requests.slice(before.requests).some(request => ['/get_msg', '/get_image'].includes(request.path)), false,
    'busy admission must happen before quotation and image lookup');
  assert.equal(await f.memory(), before.memory, 'busy notices cannot become normal chat memories or emotion');
  for (const command of ['/状态', '/记忆']) {
    const row = await f.finished(await f.send(command)); assert.equal(row.timings.modelCalls, 0);
  }
  assert.equal((await f.calls()).length, before.calls);

  await f.scenario('resume');
  const sendsBeforeResume = f.sent.length, requestsBeforeResume = f.requests.length;
  await f.advance(f.startedAt + 2 * minute); await f.planState(0, 'completed');
  await until(async () => (await f.calls()).length === before.calls + 2 && f.sent.length >= sendsBeforeResume + 2, 'one merged response per person');
  // Observe multiple scheduler ticks: completed messages must not be retried.
  await sleep(750);
  const resumed = (await f.calls()).slice(before.calls);
  assert.equal(resumed.length, 2, 'even a context-expansion marker cannot trigger a second life reply generation');
  const owner = resumed.find(call => call.prompt.includes('BUSY_FIRST'));
  const second = resumed.find(call => call.prompt.includes('SECOND_OWNER_SECRET'));
  assert.ok(owner); assert.ok(second);
  assert.match(owner.prompt, /contextMore必须为false/);
  assert.doesNotMatch(owner.prompt, /contextMore=true|直接只输出 \[\[qq_context_more\]\]/);
  assert.match(owner.prompt, /BUSY_SECOND/);
  assert.doesNotMatch(owner.prompt, /SECOND_OWNER_SECRET|UNAUTHORIZED_SECRET|GROUP_SECRET/);
  assert.doesNotMatch(second.prompt, /BUSY_FIRST|BUSY_SECOND|UNAUTHORIZED_SECRET|GROUP_SECRET/);
  assert.equal(f.sent.length, sendsBeforeResume + 2, 'sticker markers cannot add another post-busy message');
  assert.ok(f.sent.slice(sendsBeforeResume).every(message => message.message.length === 1 && message.message[0].type === 'text'));
  assert.doesNotMatch(JSON.stringify(f.sent.slice(sendsBeforeResume)), /qq_sticker|qq_context_more/);
  assert.equal(f.requests.slice(requestsBeforeResume).some(request => ['/get_msg', '/get_image'].includes(request.path)), false,
    'a merged reply must not reread deferred quotation or image payloads');

  await f.advance(f.startedAt + 21 * minute); await f.planState(1, 'active');
  await f.finished(await f.send('QQ_CLOSED_PENDING 这条不应在关闭后补发'));
  await f.finished(await f.send('/关闭QQ'));
  const closed = { calls: (await f.calls()).length, sends: f.sent.length };
  await f.advance(f.startedAt + 22 * minute); await f.planState(1, 'completed');
  await sleep(750);
  assert.equal((await f.calls()).length, closed.calls); assert.equal(f.sent.length, closed.sends);
  await f.finished(await f.send('/开启QQ'));
  await sleep(500);
  assert.equal((await f.calls()).length, closed.calls, 'reenabling QQ cannot release a cancelled catch-up');
  assert.equal(f.sent.length, closed.sends + 1);
  await f.scenario('ordinary-after-life');
  const ordinary = await f.finished(await f.send('现在正常聊一句'));
  assert.equal(ordinary.timings.modelCalls, 1);
  assert.match(JSON.stringify(f.sent.at(-1)), /普通聊天仍然正常/);
  assert.ok(f.sent.every(message => message.path === '/send_private_msg'));
});

test('life pending messages survive a Hub restart and a later restart cannot repeat the completed catch-up', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 1 }); await f.start();
  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  await f.finished(await f.send('RESTART_PENDING 没有必要逐条补答'));
  assert.equal(f.sent.length, 1); assert.equal((await f.calls()).length, 0);
  await f.stop();
  await f.advance(f.startedAt + 2 * minute);
  await f.scenario('after-restart', '刚才的安排中断了，现在回来了。');
  await f.start();
  await f.planState(0, 'interrupted');
  await until(async () => (await f.calls()).length === 1 && f.sent.length === 2, 'persisted pending reply after restart');
  assert.match((await f.calls())[0].prompt, /RESTART_PENDING/);
  assert.match((await f.calls())[0].prompt, /interrupted|中断/);
  await sleep(500);
  const savedReply = JSON.parse(await f.memory()).entries.find(entry => entry.source === 'qq');
  assert.deepEqual(savedReply.exchange.sentMessageIds, ['10002'], 'completed catch-up keeps delivery provenance for later quotation');
  await f.stop(); await f.start();
  await sleep(750);
  assert.equal((await f.calls()).length, 1); assert.equal(f.sent.length, 2);
});

test('life is disabled by default and ordinary private replies remain available', { timeout: 20000 }, async t => {
  const f = await fixture(t, { enabled: false, plans: 0 }); await f.start();
  assert.equal((await f.platform()).lifeEnabled, false);
  const row = await f.finished(await f.send('没有日程也可以正常聊天'));
  assert.equal(row.timings.modelCalls, 1); assert.equal(f.sent.length, 1);
  assert.match(JSON.stringify(f.sent[0]), /普通聊天仍然正常/);
  assert.equal(await readFile(join(f.directory, 'data', 'life', 'journal.jsonl'), 'utf8').catch(error => error.code), 'ENOENT');
});

test('a retried old message cannot discard a fresh message sharing its short batch', { timeout: 20000 }, async t => {
  const f = await fixture(t, { plans: 0 }); await f.start();
  const oldId = await f.send('ALREADY_REPLIED_OLD'); await f.finished(oldId);
  await f.send('ALREADY_REPLIED_OLD', { id: oldId, quoted: false });
  const freshId = await f.send('FRESH_BATCH_MESSAGE', { quoted: false });
  // A slash command flushes the preceding batch immediately, without a fake timer.
  await f.finished(await f.send('/状态'));
  const row = await f.finished(freshId);
  assert.equal(row.timings.modelCalls, 1);
  assert.equal(row.event.text, 'FRESH_BATCH_MESSAGE');
  assert.deepEqual(row.event.raw.batched_message_ids, [freshId]);
  const calls = await f.calls();
  assert.equal(calls.length, 2, 'one previous generation and one fresh-message generation');
  const currentMessage = calls.at(-1).prompt.split('收到的 QQ 私聊：').at(-1);
  assert.match(currentMessage, /FRESH_BATCH_MESSAGE/);
  assert.doesNotMatch(currentMessage, /ALREADY_REPLIED_OLD/);
  assert.equal(f.sent.length, 3, 'the retry causes no additional reply');
});

test('a slow catch-up model does not pause timeline observation or send into the next busy activity', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 2, planDurationMs: 3 * minute }); await f.start();
  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  await f.finished(await f.send('SLOW_CATCHUP_PENDING 这条合并回应会等一会儿'));
  assert.equal(f.sent.length, 1); assert.equal((await f.calls()).length, 0);
  await f.scenario('slow-catch-up', '这条旧补答不应在新的忙碌活动中发送。', { hold: true });
  // Advance observed active time in one-minute steps, never fabricating an
  // offline completion by jumping over the timeline's observation-gap bound.
  for (const offset of [2, 3]) {
    await f.advance(f.startedAt + offset * minute); await f.observed(f.startedAt + offset * minute);
  }
  await f.advance(f.startedAt + 4 * minute); await f.planState(0, 'completed');
  await until(async () => (await f.calls()).some(call => call.name === 'slow-catch-up' && call.held), 'held catch-up model');
  await until(async () => (await f.snapshot()).qq.events.some(row => row.source === 'life-resume' && !row.completedAt), 'in-flight catch-up event');

  // The next plan starts after 17 available minutes. Its start and subsequent
  // observation must be persisted while the previous model is still blocked.
  await f.advance(f.startedAt + 21 * minute); await f.planState(1, 'active');
  await f.advance(f.startedAt + 22 * minute); await f.observed(f.startedAt + 22 * minute);
  await f.planState(1, 'active');
  assert.equal((await f.calls()).length, 1); assert.equal(f.sent.length, 1);
  assert.equal((await f.snapshot()).qq.events.find(row => row.source === 'life-resume').completedAt, undefined);

  await f.releaseModel();
  await until(async () => (await f.snapshot()).qq.events.some(row => row.source === 'life-resume' && row.completedAt), 'held catch-up completion');
  assert.equal(f.sent.length, 1, 'a completed old generation must recheck the current busy state before sending');
  assert.equal(await f.memory(), '', 'a suppressed catch-up must not be stored as a delivered conversation');
  await f.advance(f.startedAt + 23 * minute); await f.observed(f.startedAt + 23 * minute);
  await f.advance(f.startedAt + 24 * minute); await f.planState(1, 'completed');
  await sleep(500);
  assert.equal((await f.calls()).length, 1, 'a consumed catch-up attempt must not be regenerated');
  assert.equal(f.sent.length, 1);
});

test('opt-in autonomous planning reaches busy admission and one catch-up without needing an initial chat', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 0, planning: true }); await f.start();
  const life = async () => readFile(join(f.directory, 'data', 'life', 'snapshot.json'), 'utf8').then(JSON.parse);
  const journalEvents = async () => {
    const text = await readFile(join(f.directory, 'data/life/journal.jsonl'), 'utf8');
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).flatMap(line => JSON.parse(line).events);
  };
  // A checkpoint is optional: a sharing denial can leave it behind the journal.
  // A completed planner attempt confirms its timeline writes have returned;
  // inspect its exact committed plan instead of waiting for checkpoint refresh
  // while this test deliberately keeps the clock still.
  const plan = await until(async () => {
    const planner = await readFile(join(f.directory, 'data/life/planner.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (planner?.attempt?.status !== 'complete' || planner.attempt.outcomes[0] !== 'planned') return null;
    return (await journalEvents()).find(event => event.type === 'plan-created' && event.plan.id === `plan:${planner.attempt.id}:0`)?.plan;
  }, 'autonomous plan without a chat').catch(async error => {
    throw Error(`${error.message}\n${JSON.stringify({ life: await life().catch(() => null),
      planner: await readFile(join(f.directory, 'data/life/planner.json'), 'utf8').catch(() => null),
      journal: await readFile(join(f.directory, 'data/life/journal.jsonl'), 'utf8').catch(() => null),
      callCount: (await f.calls()).length, logs: f.logs() })}`);
  });
  assert.equal(f.sent.length, 0); assert.equal((await f.calls()).length, 1);
  assert.match((await f.calls())[0].prompt, /不是收到私聊后/);
  assert.equal(plan.mode, 'simulated');
  await f.finished(await f.send('开始之前能正常聊天'));
  assert.equal((await f.calls()).length, 2);
  await f.advance(f.startedAt + minute);
  await until(async () => (await life()).plans[0].status === 'active', 'autonomous activity starts');
  const before = f.sent.length;
  await f.finished(await f.send('PLANNING_BUSY_PENDING 忙的时候留一句'));
  assert.equal((await f.calls()).length, 2); assert.equal(f.sent.length, before + 1);
  assert.equal((await f.calls()).filter(call => call.schema?.properties.choice).length, 0,
    'the planner created a fixed window; neither its local start nor busy admission invokes a comparison model');
  const decisions = JSON.parse(await readFile(join(f.directory, 'data/life/conversations.json'), 'utf8'));
  assert.equal(decisions.choices[0].outcome, 'fixed-window');
  assert.match(JSON.stringify(f.sent.at(-1)), /画画中/);
  for (let offset = 2; offset <= 6; offset++) { await f.advance(f.startedAt + offset * minute); await f.observed(f.startedAt + offset * minute); }
  await until(async () => (await f.calls()).length === 3 && f.sent.length === before + 2, 'one catch-up');
  assert.match((await f.calls()).at(-1).prompt, /PLANNING_BUSY_PENDING/);
  assert.match((await f.calls()).at(-1).prompt, /simulated/);
  await f.stop(); await f.start(); await sleep(750);
  assert.equal((await f.calls()).length, 3); assert.equal((await life()).plans.length, 1);
  const world = await fetch(f.url + '/api/world/status').then(r => r.json());
  assert.equal(world.usage.modelCalls, 1); assert.equal(world.usage.activities, 0);
});

const experience = (id, label, scope) => ({ id, kind: 'role-life', mode: 'simulated',
  source: { kind: 'isolated-fixture', ...(scope ? { scope } : {}) }, summary: label,
  effects: { version: 't030-1', mood: { valence: 0.25, energy: 0, tension: 0 },
    interest: { topic: id, label, delta: 0.3 } } });

test('personal life state reaches private prompts with scope isolation and survives restart without extra model calls', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 0, experiences: [
    experience('public-interest', 'PUBLIC_INTEREST_FACT'),
    experience('private-interest', 'PRIVATE_INTEREST_FACT', 'qq:private:123456')
  ] });
  await f.start();
  const first = await f.finished(await f.send('晚饭吃什么，我换个完全无关的话题'));
  assert.equal(first.timings.modelCalls, 1);
  const a = (await f.calls()).at(-1).prompt;
  assert.match(a, /PUBLIC_INTEREST_FACT/); assert.match(a, /PRIVATE_INTEREST_FACT/);
  await f.finished(await f.send('你好，普通聊天', { sender: 234567 }));
  const b = (await f.calls()).at(-1).prompt;
  assert.match(b, /PUBLIC_INTEREST_FACT/); assert.doesNotMatch(b, /PRIVATE_INTEREST_FACT|private-interest/);
  assert.equal((await f.calls()).length, 2, 'the state projection itself invokes no model');
  await f.stop(); await f.start();
  await f.finished(await f.send('重启后接着聊', { sender: 234567 }));
  const c = (await f.calls()).at(-1).prompt;
  assert.match(c, /PUBLIC_INTEREST_FACT/); assert.doesNotMatch(c, /PRIVATE_INTEREST_FACT|private-interest/);
  assert.equal((await f.calls()).length, 3);
  assert.equal(f.sent.length, 3, 'interest never becomes a private reply gate');
});

test('the budgeted world planner receives public derived state and no private state', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 0, planning: true, experiences: [
    experience('public-interest', 'PUBLIC_PLANNER_INTEREST'),
    experience('private-interest', 'PRIVATE_PLANNER_INTEREST', 'qq:private:123456')
  ] });
  await f.scenario('state-planning', 'unused', { lifeDecision: { thoughts: [{
    text: '想延续这个公开兴趣', sourceRefs: ['interest:public-interest', 'state:personal-mood'], strength: 0.6,
    title: '安静想一会', statusText: '*稍后回来', busy: false, durationMinutes: 5, delayMinutes: 1, effects: null
  }], reconsiderAfterMinutes: 1440 } });
  await f.start();
  const life = () => readFile(join(f.directory, 'data', 'life', 'snapshot.json'), 'utf8').then(JSON.parse);
  await until(async () => (await life().catch(() => null))?.plans.length === 1, 'state-based autonomous plan');
  const call = (await f.calls())[0];
  assert.match(call.prompt, /PUBLIC_PLANNER_INTEREST/);
  assert.doesNotMatch(call.prompt, /PRIVATE_PLANNER_INTEREST|private-interest|qq:private:123456/);
  assert.deepEqual(JSON.parse((await life()).thoughts[0].source.ref), ['interest:public-interest', 'state:personal-mood']);
  const world = await fetch(f.url + '/api/world/status').then(r => r.json());
  assert.equal(world.usage.modelCalls, 1); assert.equal(world.usage.activities, 0); assert.equal(f.sent.length, 0);
});

const isolatedBudget = reservationPlusPercent => ({ enabled: true, calibration: {
  verified: true, accountScopeKey: 'isolated-budget-scope', planType: 'prolite', accountWeekToPlusRatio: 5,
  reservationPlusPercent, evidence: 'isolated fake meter and fake model only', expiresAt: Date.UTC(2026, 10, 10)
} });

test('default budget blocks model calls with a local private status while commands and group rejection still work', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 0, runtimeBudget: null, remoteEnabled: true, allowOtherPrivateChats: true });
  await f.start();
  assert.equal((await f.platform()).runtimeBudget.enabled, true);
  for (const sender of [123456, 345678]) {
    const row = await f.finished(await f.send('普通消息应该收到预算状态', { sender }));
    assert.equal(row.timings.modelCalls, 0);
    assert.match(JSON.stringify(f.sent.at(-1)), /运行预算暂时无法安全确认/);
  }
  const memoryBefore = await readFile(join(f.directory, 'data', 'qq-memory.json'), 'utf8').catch(() => '');
  const webEvent = await fetch(f.url + '/api/qq/event', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'private_message', senderId: '123456', text: 'WEB_BUDGET_NOTICE', messageId: 9000 }) });
  assert.equal(webEvent.status, 200);
  const webRow = (await f.snapshot()).qq.events.find(row => row.event.text === 'WEB_BUDGET_NOTICE');
  assert.match(webRow.reply, /运行预算暂时无法安全确认/);
  assert.equal(await readFile(join(f.directory, 'data', 'qq-memory.json'), 'utf8').catch(() => ''), memoryBefore);
  for (const command of ['/状态', '/执行 检查隔离工作区', '/确认', '/取消', '/关闭QQ']) {
    const row = await f.finished(await f.send(command));
    assert.equal(row.timings.modelCalls, 0);
    if (command === '/确认') assert.match(row.reply, /运行预算暂时无法安全确认/);
  }
  await f.send('群消息没有模型调用', { group: 123456789 });
  assert.equal((await f.calls()).length, 0);
  assert.ok(f.sent.every(item => item.path === '/send_private_msg'));
  assert.equal(await f.memory(), '');
});

test('observation records shared planning and private chat without calibration or touching the strict ledger', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 0, planning: true, runtimeBudget: { mode: 'observe', calibration: null } });
  const folder = join(f.directory, 'data', 'runtime-budget'); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'budget.json'), 'PRESERVE_OLD_STRICT_LEDGER');
  await f.scenario('observe', '正常回复。', { emitUsage: true });
  await f.start();
  await until(async () => (await f.calls()).length === 1 && (await f.platform()).runtimeBudget.pending === 0, 'observed planning');
  assert.equal((await f.platform()).runtimeBudget.mode, 'observe');
  assert.equal((await f.platform()).runtimeBudget.enforced, false);
  for (let i = 0; i < 2; i++) {
    const row = await f.finished(await f.send('OBSERVATION_PRIVATE_TEXT_' + i));
    assert.equal(row.timings.modelCalls, 1); assert.doesNotMatch(row.reply, /预算/);
  }
  await until(async () => (await f.platform()).runtimeBudget.pending === 0, 'all observed calls settled');
  const world = await fetch(f.url + '/api/world/status').then(r => r.json());
  assert.equal(world.limits.dailyEnforced, false); assert.equal(world.limits.modelCalls, null);
  const report = await summarizeRuntimeUsage({ directory: join(f.directory, 'data', 'runtime-usage') });
  assert.equal(report.totals.runtimeAttempts, 3); assert.equal(report.totals.succeeded, 3);
  assert.equal(report.totals.missingUsage, 0);
  assert.deepEqual(report.totals.knownTokens, { input_tokens: 140, cached_input_tokens: 10, output_tokens: 56 });
  assert.deepEqual(report.days[0].purposes.map(p => p.purpose), ['life-planning', 'qq-chat']);
  assert.doesNotMatch(JSON.stringify(report), /OBSERVATION_PRIVATE_TEXT/);
  await f.stop(); await f.start();
  await f.finished(await f.send('RESTART_OBSERVATION_TEXT'));
  const restarted = await summarizeRuntimeUsage({ directory: join(f.directory, 'data', 'runtime-usage') });
  assert.equal(restarted.totals.runtimeAttempts, 4);
  assert.equal(await readFile(join(folder, 'budget.json'), 'utf8'), 'PRESERVE_OLD_STRICT_LEDGER');
});

test('observation mode reaches a fourth same-day public planning attempt without increasing the planning cadence', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 0, planning: true, runtimeBudget: { mode: 'observe' },
    startTime: Date.UTC(2026, 9, 26, 16) });
  await f.scenario('observe-empty-plan', '', { lifeDecision: { thoughts: [], reconsiderAfterMinutes: 240 } });
  await f.start();
  for (let count = 1; count <= 4; count++) {
    if (count > 1) await f.advance(f.startedAt + (count - 1) * 240 * minute);
    await until(async () => (await f.calls()).length === count && (await f.platform()).runtimeBudget.pending === 0, 'observation planner attempt ' + count);
    if (count < 4) {
      await f.advance(f.startedAt + (count - 1) * 240 * minute + minute); await sleep(300);
      assert.equal((await f.calls()).length, count);
    }
  }
  const report = await summarizeRuntimeUsage({ directory: join(f.directory, 'data', 'runtime-usage') });
  assert.equal(report.days.length, 1); assert.equal(report.totals.runtimeAttempts, 4);
  assert.equal(report.days[0].purposes[0].purpose, 'life-planning');
});

test('empty context expansion makes no extra call and a restart does not refill the weekly ledger', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 0, runtimeBudget: isolatedBudget(75), trustedMeter: true });
  await f.scenario('context-request', '[[qq_context_more]]'); await f.start();
  const first = await f.finished(await f.send('需要补查上下文的消息'));
  assert.equal(first.timings.modelCalls, 1);
  assert.match(first.reply, /前文我没接上/);
  assert.equal((await f.calls()).length, 1);
  assert.match((await f.calls())[0].prompt, /contextMore=true/);
  assert.doesNotMatch((await f.calls())[0].prompt, /直接只输出 \[\[qq_context_more\]\]/);
  assert.equal((await f.platform()).runtimeBudget.chargedPlusPercent, 75);
  await f.stop(); await f.start();
  const next = await f.finished(await f.send('重启后不能再拿一次额度'));
  assert.equal(next.timings.modelCalls, 0); assert.equal((await f.calls()).length, 1);
  assert.equal((await f.platform()).runtimeBudget.chargedPlusPercent, 75);
});

test('autonomous planning and private replies consume the same weekly allowance', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 0, planning: true, runtimeBudget: isolatedBudget(75), trustedMeter: true });
  await f.start();
  await until(async () => (await f.calls()).length === 1 && (await f.platform()).runtimeBudget.pendingCalls === 0, 'budgeted autonomous planning');
  const row = await f.finished(await f.send('规划用完之后的普通私聊'));
  assert.equal(row.timings.modelCalls, 0); assert.match(row.reply, /本周的知微运行预算/);
  const world = await fetch(f.url + '/api/world/status').then(r => r.json());
  assert.equal(world.usage.modelCalls, 1); assert.equal(world.runtimeBudget.chargedPlusPercent, 75);
  const read = await fetch(f.url + '/api/world/read', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-world-token': world.csrfToken }, body: '{"target":""}' });
  assert.equal(read.status, 202);
  await until(async () => (await fetch(f.url + '/api/world/status').then(r => r.json())).last?.status === 'failed', 'reading denied by same allowance');
  const deniedWorld = await fetch(f.url + '/api/world/status').then(r => r.json());
  assert.equal(deniedWorld.usage.modelCalls, 1);
  assert.equal(deniedWorld.usage.unknownUsageCalls, 0);
  assert.match(deniedWorld.last.message, /本周的知微运行预算/);
  assert.equal((await f.calls()).length, 1);
});

test('budget denial after a busy period sends at most one local status and never becomes conversation memory', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 1, runtimeBudget: { enabled: true } }); await f.start();
  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  await f.finished(await f.send('预算不可用时仍可合并的消息'));
  await f.advance(f.startedAt + 2 * minute); await f.planState(0, 'completed');
  await until(() => f.sent.length === 2, 'one local catch-up budget status');
  assert.match(JSON.stringify(f.sent.at(-1)), /运行预算暂时无法安全确认/);
  assert.equal((await f.calls()).length, 0); assert.equal(await f.memory(), '');
  await f.stop(); await f.start(); await sleep(600);
  assert.equal(f.sent.length, 2); assert.equal((await f.calls()).length, 0);
});

test('a damaged budget ledger blocks inference but keeps local management available', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 0, runtimeBudget: { enabled: true } });
  const folder = join(f.directory, 'data', 'runtime-budget'); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'budget.json'), 'damaged ledger');
  await f.start();
  const status = (await f.platform()).runtimeBudget;
  assert.equal(status.reason, 'storage-unavailable');
  const row = await f.finished(await f.send('损坏后不能调用模型'));
  assert.equal(row.timings.modelCalls, 0); assert.match(row.reply, /运行预算暂时无法安全确认/);
  await f.finished(await f.send('/状态'));
  assert.equal((await f.calls()).length, 0);
  assert.equal(await readFile(join(folder, 'budget.json'), 'utf8'), 'damaged ledger');
});

test('private reading reaches the same contact life context and notes without leaking to another contact or public status', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 0, browsing: true });
  await f.scenario('read-note', 'unused', { worldDecision: { action: 'note', summary: 'PRIVATE_READING_SUMMARY', comment: 'PRIVATE_READING_COMMENT',
    effects: { version: 't030-1', mood: { valence: 0.3, energy: 0, tension: 0 }, interest: null } } });
  await f.start();
  await f.finished(await f.send('/浏览 https://example.org/observed?token=FAKE_SECRET'));
  assert.equal((await f.calls()).length, 1, 'one existing reading decision, no extra appraisal model');
  const readingSchema = (await f.calls())[0].schema;
  assert.equal(readingSchema.additionalProperties, false);
  assert.ok(readingSchema.required.includes('effects'), 'the actual strict CLI schema permits the same-call appraisal');
  assert.ok(readingSchema.properties.effects.anyOf.some(value => value.type === 'null'));
  assert.match(JSON.stringify(f.sent.at(-1)), /已保存|已记下/);
  const journal = await readFile(join(f.directory, 'data', 'life', 'journal.jsonl'), 'utf8');
  assert.match(journal, /PRIVATE_READING_SUMMARY/); assert.doesNotMatch(journal, /FAKE_SECRET/);
  assert.match(journal, /qq:private:123456/);
  const publicStatus = await fetch(f.url + '/api/world/status').then(r => r.json());
  assert.equal(publicStatus.last, null);
  await f.scenario('ordinary', '看过的内容已经记下了。');
  await f.finished(await f.send('刚才看的内容怎么样'));
  const ownPrompt = (await f.calls()).at(-1).prompt;
  assert.match(ownPrompt, /PRIVATE_READING_SUMMARY/); assert.match(ownPrompt, /external/);
  await f.finished(await f.send('今天有什么见闻', { sender: 234567 }));
  assert.doesNotMatch((await f.calls()).at(-1).prompt, /PRIVATE_READING_SUMMARY|PRIVATE_READING_COMMENT|example.org\/observed/);
  await f.finished(await f.send('/留言板 other'));
  assert.match(JSON.stringify(f.sent.at(-1)), /PRIVATE_READING_COMMENT/);
  await f.finished(await f.send('/留言板 other', { sender: 234567 }));
  assert.doesNotMatch(JSON.stringify(f.sent.at(-1)), /PRIVATE_READING/);
  const callsBeforeRestart = (await f.calls()).length;
  await f.stop(); await f.start(); await sleep(350);
  assert.equal((await f.calls()).length, callsBeforeRestart);
  assert.equal(await readFile(join(f.directory, 'data', 'life', 'journal.jsonl'), 'utf8'), journal);
});

test('Hub replays a durable reading outcome before accepting chat without rerunning the browser or model', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 0, browsing: true });
  const observedAt = f.startedAt - 6 * 60 * minute;
  let reads = 0, models = 0;
  const world = await createWorld({ projectDir: f.directory, now: () => observedAt,
    config: { life: { enabled: true }, world: { enabled: true }, runtimeBudget: { enabled: false } },
    browser: { status: () => ({ mode: 'readonly', busy: false }), close: async () => {},
      read: async url => { reads++; return { url, title: 'DURABLE_PAGE', text: '真实fixture正文', links: [], imagePaths: [] }; } },
    think: async () => { models++; return { text: JSON.stringify({ action: 'note', summary: 'RECOVERED_READING_FACT', comment: '本地感想',
      effects: { version: 't030-1', mood: { valence: 0.4, energy: 0, tension: 0 }, interest: null } }) }; },
    recordExperience: async () => { throw Error('Injected unavailable timeline before restart'); }
  });
  try { await assert.rejects(world.run('https://example.org/durable'), /Injected unavailable/); }
  finally { await world.close(); }
  assert.equal(reads, 1); assert.equal(models, 1);
  await f.start();
  assert.equal((await f.calls()).length, 0, 'startup replay has no model call');
  const events = (await readFile(join(f.directory, 'data', 'life', 'journal.jsonl'), 'utf8')).trim().split('\n')
    .flatMap(row => JSON.parse(row).events).filter(e => e.type === 'experience-recorded');
  assert.equal(events.length, 1); assert.equal(events[0].experience.observedAt, observedAt);
  await f.finished(await f.send('今天有什么见闻'));
  const prompt = (await f.calls()).at(-1).prompt;
  assert.match(prompt, /RECOVERED_READING_FACT/);
  assert.match(prompt, /"valence":0.1/);
  await f.stop(); await f.start(); await sleep(350);
  const after = (await readFile(join(f.directory, 'data', 'life', 'journal.jsonl'), 'utf8')).trim().split('\n')
    .flatMap(row => JSON.parse(row).events).filter(e => e.type === 'experience-recorded');
  assert.equal(after.length, 1); assert.equal((await f.calls()).length, 1);
});

test('an explicit stop bypasses batching and fences an in-flight ordinary reply without silencing another contact', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 0 }); await f.scenario('held-before-stop', 'OLD_RESULT_MUST_NOT_SEND', { hold: true }); await f.start();
  const oldId = await f.send('OLD_MODEL_REQUEST');
  await until(async () => (await f.calls()).some(c => c.held), 'ordinary model in flight');
  const stopId = await f.send('别再找我了', { quoted: false });
  const stopped = await f.finished(stopId);
  assert.equal(stopped.timings.modelCalls, 0);
  assert.equal((await f.calls()).length, 1);
  await f.releaseModel(); await f.finished(oldId); await sleep(150);
  assert.equal(f.sent.length, 0, 'a held old answer must not escape after the stop');
  assert.doesNotMatch(await f.memory(), /OLD_RESULT_MUST_NOT_SEND|OLD_MODEL_REQUEST/);
  await f.scenario('other-contact', 'OTHER_CONTACT_OK');
  await f.finished(await f.send('另一对象普通聊天', { sender: 234567 }));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].user_id, 234567);
  await f.scenario('new-conversation', 'NEW_CONVERSATION_OK');
  await f.finished(await f.send('我回来了，继续聊刚才的想法')); assert.equal(f.sent.length, 2);
  assert.match(JSON.stringify(f.sent.at(-1)), /NEW_CONVERSATION_OK/);
  const before = await readFile(join(f.directory, 'data', 'life', 'contacts.json'), 'utf8');
  await f.send('别再找我了', { quoted: false, id: stopId });
  assert.equal(await readFile(join(f.directory, 'data', 'life', 'contacts.json'), 'utf8'), before, 'a repeated stop ID must not advance the new epoch');
  assert.equal(f.sent.length, 2);
  await f.stop(); await f.start(); await sleep(350);
  assert.equal(f.sent.length, 2, 'restart never replays stopped work');
});

test('old and new short batches cannot cross a stop epoch or merge their prompt contents', { timeout: 20000 }, async t => {
  const f = await fixture(t, { plans: 0 }); await f.start();
  await f.send('BATCH_OLD_CANCELLED', { quoted: false });
  await f.finished(await f.send('不要再发消息给我了', { quoted: false }));
  await f.finished(await f.send('BATCH_NEW_ONLY 我现在回来聊一句', { quoted: false }));
  const calls = await f.calls();
  assert.equal(calls.length, 1); assert.match(calls[0].prompt, /BATCH_NEW_ONLY/);
  assert.doesNotMatch(calls[0].prompt, /BATCH_OLD_CANCELLED/);
  assert.equal(f.sent.length, 1);
});

test('stopping busy catch-up persists across restart and cancels only that contact', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 1 }); await f.start();
  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  await f.finished(await f.send('BUSY_CANCELLED_A'));
  await f.finished(await f.send('BUSY_RETAINED_B', { sender: 234567 }));
  assert.equal(f.sent.length, 2);
  await f.finished(await f.send('先别打扰我了', { quoted: false }));
  assert.equal(f.sent.length, 2, 'stop has no busy acknowledgment or model call');
  assert.equal((await f.calls()).length, 0);
  await f.stop(); await f.advance(f.startedAt + 2 * minute); await f.start();
  await until(() => f.sent.length === 3, 'other contact catch-up after restart'); await sleep(500);
  assert.equal((await f.calls()).length, 1); assert.equal(f.sent.at(-1).user_id, 234567);
  assert.doesNotMatch((await f.calls())[0].prompt, /BUSY_CANCELLED_A/);
  assert.match((await f.calls())[0].prompt, /BUSY_RETAINED_B/);
  await f.finished(await f.send('回来聊个新话题'));
  assert.equal(f.sent.length, 4); assert.doesNotMatch((await f.calls()).at(-1).prompt, /BUSY_CANCELLED_A/);
});

test('a stop received during a generated catch-up blocks its final network handoff', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 1 }); await f.start();
  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  await f.finished(await f.send('BUSY_IN_FLIGHT_STOP'));
  await f.scenario('held-catch-up', 'CATCH_UP_MUST_NOT_SEND', { hold: true });
  await f.advance(f.startedAt + 2 * minute); await f.planState(0, 'completed');
  await until(async () => (await f.calls()).some(c => c.held), 'catch-up model in flight');
  await f.finished(await f.send('别烦我了', { quoted: false }));
  await f.releaseModel();
  await until(async () => (await f.snapshot()).qq.events.some(e => e.source === 'life-resume' && e.completedAt), 'cancelled catch-up completion');
  await sleep(350); assert.equal(f.sent.length, 1, 'only the earlier busy notice was delivered');
  assert.doesNotMatch(await f.memory(), /CATCH_UP_MUST_NOT_SEND/);
  await f.stop(); await f.start(); await sleep(350); assert.equal(f.sent.length, 1);
});

test('quoted discussion and brief ordinary replies do not establish a stop fence', { timeout: 20000 }, async t => {
  const f = await fixture(t, { plans: 0 }); await f.start();
  for (const text of ['他说“别烦我了”，这句话是什么意思？', '不要不理我', '嗯', '我现在忙，晚点聊']) {
    await f.finished(await f.send(text));
  }
  assert.equal(f.sent.length, 4); assert.equal((await f.calls()).length, 4);
});

test('a stop between text and sticker handoff also cancels replies already waiting for send order', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 0, holdFirstSend: true });
  await f.scenario('text-then-sticker', '已经发起的文字。\n[[qq_sticker:笑.png]]'); await f.start();
  const first = await f.send('第一条普通消息');
  await until(() => f.sent.length === 1, 'first text transport started');
  await f.scenario('waiting-for-order', 'QUEUED_REPLY_MUST_NOT_SEND');
  const second = await f.send('第二条普通消息');
  await until(async () => (await f.snapshot()).qq.events.some(e => e.event.raw?.message_id === second && e.decision.status === '发送中'), 'second reply waiting for send order');
  await f.finished(await f.send('别再找我了', { quoted: false }));
  f.releaseSend(); await f.finished(first); await f.finished(second);
  assert.equal(f.sent.length, 1, 'already handed-off text cannot be recalled, but sticker and queued answer are blocked');
  assert.ok(f.sent[0].message.every(s => s.type === 'text'));
  assert.doesNotMatch(await f.memory(), /QUEUED_REPLY_MUST_NOT_SEND/);
});

test('direct stop text remains effective alongside an unread audio attachment and a reply segment', { timeout: 20000 }, async t => {
  const f = await fixture(t, { plans: 0 }); await f.scenario('held-audio-stop', 'AUDIO_STOP_OLD', { hold: true }); await f.start();
  const oldId = await f.send('旧消息'); await until(async () => (await f.calls()).length === 1, 'old model started');
  await f.finished(await f.send('别再找我了', { audio: true, quoted: true }));
  await f.releaseModel(); await f.finished(oldId); assert.equal(f.sent.length, 0);
  assert.equal((await f.calls()).length, 1, 'the audio is never transcribed or sent to a model for a text stop');
});

test('a stop persistence failure closes the send fence instead of releasing an old model result', { timeout: 20000 }, async t => {
  const f = await fixture(t, { plans: 0 }); await f.scenario('held-storage-fault', 'FAULT_OLD_RESULT', { hold: true }); await f.start();
  const oldId = await f.send('停止落盘失败前的消息');
  await until(async () => (await f.calls()).length === 1, 'old model before injected storage fault');
  const contactsPath = join(f.directory, 'data', 'life', 'contacts.json');
  const original = await readFile(contactsPath, 'utf8');
  await rename(contactsPath, contactsPath + '.preserved'); await mkdir(contactsPath);
  await f.send('别再找我了', { quoted: false, expectedStatus: 500 });
  await f.releaseModel(); await f.finished(oldId);
  assert.equal(f.sent.length, 0); assert.equal((await f.calls()).length, 1);
  assert.equal(await readFile(contactsPath + '.preserved', 'utf8'), original);
  assert.doesNotMatch(await f.memory(), /FAULT_OLD_RESULT/);
});

test('same-turn contextual pause is silent; ordinary reentry stays paused and explicit invitation resumes without resetting epoch', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 0 }); await f.start();
  await f.finished(await f.send('先聊一会儿'));
  const pauseText = '你这次逗得有点过了，先到这里。';
  await f.scenario('context-pause', '', { contactBoundary: { kind: 'pause', quote: '你这次逗得有点过了' } });
  await f.finished(await f.send(pauseText));
  const contacts = () => readFile(join(f.directory, 'data/life/contacts.json'), 'utf8').then(JSON.parse);
  assert.equal((await contacts()).contacts[0].paused, true);
  assert.equal((await contacts()).contacts[0].epoch, 1);
  assert.equal(f.sent.length, 1);
  await f.scenario('ordinary', '在呀。'); await f.finished(await f.send('你好'));
  assert.equal((await contacts()).contacts[0].paused, true);
  const invitation = '以后可以主动来找我聊天了';
  await f.scenario('resume-contact', '好。', { contactBoundary: { kind: 'resume', quote: invitation } });
  await f.finished(await f.send(invitation));
  assert.equal((await contacts()).contacts[0].paused, false);
  assert.equal((await contacts()).contacts[0].epoch, 1);
  assert.equal((await f.calls()).length, 4);
  assert.equal(f.sent.length, 3);
  await f.stop(); await f.start();
  assert.equal((await contacts()).contacts[0].paused, false);
});

test('short batch uses its latest original evidence and busy catch-up retains latest evidence across restart', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 1 }); await f.start();
  const text = '你这次逗得有点过了';
  await f.scenario('batch-pause', '', { contactBoundary: { kind: 'pause', quote: text } });
  const first = await f.send('前一句还在聊天', { quoted: false });
  await f.send(text, { quoted: false }); await f.finished(first);
  const contacts = () => readFile(join(f.directory, 'data/life/contacts.json'), 'utf8').then(JSON.parse);
  assert.equal((await contacts()).contacts[0].paused, true);
  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  await f.scenario('ordinary', '好');
  await f.finished(await f.send('刚才忘了说一件事'));
  const invitation = '以后可以主动来找我聊天了';
  await f.finished(await f.send(invitation));
  await f.stop();
  await f.scenario('busy-invitation', '好呀', { contactBoundary: { kind: 'resume', quote: invitation } });
  await f.start(); await f.advance(f.startedAt + 2 * minute); await f.planState(0, 'interrupted');
  await until(async () => (await contacts()).contacts[0].paused === false, 'busy invitation applied');
  assert.equal((await contacts()).contacts[0].epoch, 1);
});

test('slow resume cannot override a newer stop even when the invitation was once current', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 0 }); await f.start();
  await f.send('别再来找我了');
  const invitation = '以后可以主动来找我聊天了';
  await f.scenario('held-invitation', '好呀', { hold: true, contactBoundary: { kind: 'resume', quote: invitation } });
  const id = await f.send(invitation);
  await until(async () => (await f.calls()).some(row => row.held), 'held invitation model');
  await f.send('别再来找我了'); await f.releaseModel(); await f.finished(id);
  const saved = JSON.parse(await readFile(join(f.directory, 'data/life/contacts.json'), 'utf8'));
  assert.equal(saved.contacts[0].paused, true); assert.equal(saved.contacts[0].epoch, 2);
  assert.equal(f.sent.length, 0);
});

test('life contact action selects one sourced participant and sends through the real Hub once', { timeout: 25000 }, async t => {
  const f = await fixture(t, { runtimeBudget: { mode: 'observe' }, planning: true, plans: 1, action: { type: 'contact' }, planDelayMs: 11 * minute, planDurationMs: 5 * minute });
  await f.start();
  await f.finished(await f.send('FIRST_CONTACT_PRIVATE_MARKER，我喜欢观察星空。'));
  await f.finished(await f.send('SECOND_CONTACT_PRIVATE_MARKER，我喜欢安静看书。', { sender: 234567 }));
  await f.scenario('proactive', '', { proactiveAuto: true });
  await f.advance(f.startedAt + 11 * minute); await f.planState(0, 'completed');
  assert.equal(f.sent.length, 3); assert.equal(f.sent[2].user_id, 234567);
  const call = (await f.calls()).find(row => row.schema?.properties.sourceRefs);
  assert.ok(call); assert.match(call.prompt, /SECOND_CONTACT_PRIVATE_MARKER/);
  const report = await summarizeRuntimeUsage({ directory: join(f.directory, 'data', 'runtime-usage') });
  const contactUsage = report.days.flatMap(day => day.purposes).find(row => row.purpose === 'life-contact');
  assert.equal(contactUsage.runtimeAttempts, 1); assert.equal(contactUsage.knownTokens.input_tokens, 100);
  assert.doesNotMatch(call.prompt, /FIRST_CONTACT_PRIVATE_MARKER/);
  const contacts = JSON.parse(await readFile(join(f.directory, 'data/life/contacts.json'), 'utf8'));
  assert.equal(contacts.intents.length, 1); assert.equal(contacts.intents[0].status, 'sent');
  assert.equal(contacts.intents[0].scope, 'qq:private:234567');
  const publicState = await readFile(join(f.directory, 'data/life/snapshot.json'), 'utf8');
  assert.doesNotMatch(publicState, /SECOND_CONTACT_PRIVATE_MARKER|234567/);
  await f.stop(); await f.start(); await f.observed(f.startedAt + 11 * minute);
  assert.equal(f.sent.length, 3);
  await f.scenario('ordinary', '是刚才主动提起的那件事。');
  const quoted = await f.finished(await f.send('刚才你说的那个？', { sender: 234567, quoteId: '10003' }));
  assert.equal(quoted.event.replyContext?.scopeVerified, true);
  const other = await f.finished(await f.send('同一个引用不能给我看', { quoteId: '10003' }));
  assert.ok(other.event.replyContextError);
});

test('life browse action runs from timeline and requires observation; uncalibrated budget opens no page', { timeout: 25000 }, async t => {
  const f = await fixture(t, { runtimeBudget: { mode: 'observe' }, planning: true, browsing: true, plans: 1, action: { type: 'browse', target: 'https://example.org/life' }, planDurationMs: 5 * minute });
  await f.scenario('reading', '', { worldDecision: { action: 'rest' } }); await f.start();
  await f.advance(f.startedAt + minute); await f.planState(0, 'completed');
  const saved = JSON.parse(await readFile(join(f.directory, 'data/life/snapshot.json'), 'utf8'));
  assert.ok(saved.events.some(row => row.type === 'experience-recorded'));
  assert.equal((await readFile(join(f.directory, 'browser-calls.jsonl'), 'utf8')).trim().split('\n').length, 1);
  const report = await summarizeRuntimeUsage({ directory: join(f.directory, 'data', 'runtime-usage') });
  const readingUsage = report.days.flatMap(day => day.purposes).find(row => row.purpose === 'reading');
  assert.equal(readingUsage.runtimeAttempts, 1); assert.equal(readingUsage.knownTokens.input_tokens, 100);
  await f.stop();
  const denied = await fixture(t, { planning: true, browsing: true, plans: 1, runtimeBudget: null,
    action: { type: 'browse', target: 'https://example.org/blocked' }, planDurationMs: 5 * minute });
  await denied.start(); await denied.advance(denied.startedAt + minute); await denied.planState(0, 'failed');
  assert.equal(await readFile(join(denied.directory, 'browser-calls.jsonl'), 'utf8').catch(() => ''), '');
  assert.equal((await denied.calls()).length, 0);
});

test('explicit stop during proactive generation fences the real Hub send and budget denial has no proactive fallback', { timeout: 25000 }, async t => {
  const f = await fixture(t, { planning: true, plans: 1, action: { type: 'contact' }, planDelayMs: 11 * minute, planDurationMs: 5 * minute });
  await f.start(); await f.finished(await f.send('我喜欢安静看书'));
  await f.scenario('held-proactive', '', { proactiveAuto: true, hold: true });
  await f.advance(f.startedAt + 11 * minute);
  await until(async () => (await f.calls()).some(row => row.schema?.properties.sourceRefs && row.held), 'proactive generation');
  await f.send('别再来找我了'); await f.releaseModel(); await f.planState(0, 'failed');
  assert.equal(f.sent.length, 1);
  const saved = JSON.parse(await readFile(join(f.directory, 'data/life/contacts.json'), 'utf8'));
  assert.equal(saved.contacts[0].paused, true); assert.equal(saved.intents[0].status, 'cancelled');
  await f.stop();
  const denied = await fixture(t, { planning: true, plans: 1, runtimeBudget: null, action: { type: 'contact' }, planDelayMs: 11 * minute, planDurationMs: 5 * minute });
  await denied.start(); await denied.finished(await denied.send('我喜欢看书'));
  assert.equal(denied.sent.length, 1);
  await denied.advance(denied.startedAt + 11 * minute); await denied.planState(0, 'failed');
  assert.equal(denied.sent.length, 1); assert.equal((await denied.calls()).length, 0);
});

test('local preview keeps its reply and cannot borrow trusted contact evidence to mutate real state', { timeout: 15000 }, async t => {
  const f = await fixture(t, { plans: 0 }); await f.start();
  await f.send('别再来找我了');
  const invitation = '以后可以主动来找我聊天了';
  await f.scenario('ordinary', '普通回复'); const messageId = await f.send(invitation); await f.finished(messageId);
  const path = join(f.directory, 'data/life/contacts.json');
  const before = await readFile(path, 'utf8'), saved = JSON.parse(before), last = saved.contacts[0].receipts.at(-1);
  const token = {scope:'qq:private:123456',epoch:last.epoch,sequence:last.sequence,stop:false,duplicate:false};
  await f.scenario('preview', '预览回复仍然可用。', {contactBoundary:{kind:'resume',quote:invitation}});
  const response = await fetch(f.url + '/api/qq/event', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    type:'private_message',senderId:'123456',text:invitation,lifeContactToken:token,
    lifeContactEvidence:{token,event:{type:'private_message',senderId:'123456',text:invitation,
      raw:{message_id:messageId,message:[{type:'text',data:{text:invitation}}]}}}
  })});
  assert.equal(response.status, 200);
  const record = (await f.snapshot()).qq.events[0]; assert.equal(record.reply, '预览回复仍然可用。');
  assert.equal(await readFile(path,'utf8'),before); assert.equal(f.sent.length,1);
});

test('conversation choice defers the actual busy plan once and private reasons never enter the public timeline', { timeout: 25000 }, async t => {
  const f = await fixture(t, { runtimeBudget: { mode: 'observe' }, plans: 1, planDurationMs: 3 * minute, planFlexMs: 5 * minute }); await f.start();
  await f.finished(await f.send('CHOICE_PRIVATE_TOPIC 这个话题还没聊完。'));
  await f.scenario('choose-chat', '我们接着聊。', {
    choiceDecision: { choice: 'chat', reason: 'CHOICE_PRIVATE_REASON 还想继续这个话题。', reply: '' }
  });
  await f.advance(f.startedAt + minute);
  const deferred = await until(async () => (await f.life()).plans.find(plan => plan.startTransition?.status === 'deferred'), 'a durably deferred plan');
  assert.equal(deferred.status, 'planned'); assert.equal(deferred.startAt, f.startedAt + 6 * minute);
  assert.equal(deferred.endAt, f.startedAt + 9 * minute);
  const choice = (await f.calls()).filter(call => call.schema?.properties.choice);
  assert.equal(choice.length, 1); assert.match(choice[0].prompt, /CHOICE_PRIVATE_TOPIC/);
  const report = await summarizeRuntimeUsage({ directory: join(f.directory, 'data', 'runtime-usage') });
  const choiceUsage = report.days.flatMap(day => day.purposes).find(row => row.purpose === 'life-conversation');
  assert.equal(choiceUsage.runtimeAttempts, 1); assert.equal(choiceUsage.knownTokens.input_tokens, 100);
  assert.doesNotMatch(JSON.stringify(await f.life()), /CHOICE_PRIVATE_TOPIC|CHOICE_PRIVATE_REASON|qq:private:123456/);
  await f.advance(f.startedAt + 2 * minute);
  await f.finished(await f.send('延后的这段时间继续聊。'));
  assert.equal((await f.calls()).filter(call => call.schema?.properties.choice).length, 1);
  assert.match(JSON.stringify(f.sent.at(-1)), /我们接着聊/);
  await f.advance(f.startedAt + 6 * minute); await f.planState(0, 'active');
  assert.equal((await f.calls()).filter(call => call.schema?.properties.choice).length, 1, 'new messages never trigger unlimited postponements');
});

test('choosing the activity sends one natural farewell before entering it and restart never repeats that farewell', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 1, planDurationMs: 3 * minute }); await f.start();
  await f.finished(await f.send('现在的对话可以先放一放。'));
  await f.scenario('choose-activity', '', { choiceDecision: {
    choice: 'activity', reason: '我更想按计划去读书。', reply: '我先去看一会书，回来再聊。'
  } });
  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  assert.equal(f.sent.length, 2); assert.match(JSON.stringify(f.sent[1]), /我先去看一会书/);
  const choices = (await f.calls()).filter(call => call.schema?.properties.choice);
  assert.equal(choices.length, 1);
  const saved = JSON.parse(await readFile(join(f.directory, 'data/life/conversations.json'), 'utf8'));
  assert.equal(saved.choices[0].outcome, 'farewell-sent');
  await f.stop(); await f.start(); await f.planState(0, 'interrupted'); await sleep(500);
  assert.equal(f.sent.length, 2); assert.equal((await f.calls()).filter(call => call.schema?.properties.choice).length, 1);
  assert.match(await f.memory(), /我先去看一会书/);
});

test('the authenticated inbound tick cannot bypass the due-plan choice before the periodic timer fires', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 1, tickIntervalMs: 60000, planDurationMs: 3 * minute }); await f.start();
  await f.finished(await f.send('先开一个正在进行的话题。'));
  await f.scenario('inbound-choice', '稍后接着聊。', { choiceDecision: {
    choice: 'activity', reason: '这个时段我想先去读书。', reply: ''
  } });
  await f.advance(f.startedAt + minute);
  const arriving = await f.send('正好到活动时间的这一句。');
  await until(async () => (await f.calls()).some(call => call.schema?.properties.choice), 'choice launched by inbound tick');
  await f.planState(0, 'active'); await f.finished(arriving);
  assert.equal((await f.calls()).filter(call => call.schema?.properties.choice).length, 1);
  assert.ok(f.sent.every(item => item.path === '/send_private_msg'));
});

test('an ordinary model crossing a busy transition is merged once instead of delivering its stale result or losing the input', { timeout: 30000 }, async t => {
  const f = await fixture(t, { plans: 1, planDurationMs: 2 * minute });
  await f.scenario('held-before-choice', 'STALE_GENERATED_REPLY_MUST_NOT_SEND', { hold: true }); await f.start();
  const pending = await f.send('ORIGINAL_IN_FLIGHT_INPUT 等我说明这个细节。');
  await until(async () => (await f.calls()).some(call => call.held && call.schema?.properties.contactBoundary), 'ordinary model held');
  await f.scenario('leave-during-generation', '', { choiceDecision: {
    choice: 'activity', reason: '活动更吸引我，先收尾。', reply: '我先去看书，晚点接上。'
  } });
  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  await f.releaseModel(); await f.finished(pending);
  assert.doesNotMatch(JSON.stringify(f.sent), /STALE_GENERATED_REPLY/);
  const queued = JSON.parse(await readFile(join(f.directory, 'data/life/replies.json'), 'utf8'));
  assert.match(queued.entries[0].messages.map(message => message.text).join('\n'), /ORIGINAL_IN_FLIGHT_INPUT/);
  await f.scenario('resumed-original', '我回来了，你刚才说的细节接着说。');
  await f.advance(f.startedAt + 2 * minute); await f.observed(f.startedAt + 2 * minute);
  await f.advance(f.startedAt + 3 * minute); await f.planState(0, 'completed');
  await until(async () => (await f.calls()).some(call => call.name === 'resumed-original') && f.sent.length === 2, 'single deferred catch-up');
  await sleep(500);
  assert.equal((await f.calls()).filter(call => call.name === 'resumed-original').length, 1);
  assert.match((await f.calls()).find(call => call.name === 'resumed-original').prompt, /ORIGINAL_IN_FLIGHT_INPUT/);
  assert.doesNotMatch(await f.memory(), /STALE_GENERATED_REPLY/);
});

test('a stopped participant fences a held activity comparison and prevents its farewell', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 1, planDurationMs: 3 * minute }); await f.start();
  await f.finished(await f.send('先聊一会。'));
  await f.scenario('held-choice-stop', '', { holdChoice: true, choiceDecision: {
    choice: 'activity', reason: '准备离开。', reply: 'STOPPED_FAREWELL_MUST_NOT_SEND'
  } });
  await f.advance(f.startedAt + minute);
  await until(async () => (await f.calls()).some(call => call.schema?.properties.choice), 'held activity comparison');
  await f.finished(await f.send('别再找我了', { quoted: false }));
  await f.releaseChoice(); await f.planState(0, 'active');
  assert.equal(f.sent.length, 1); assert.doesNotMatch(JSON.stringify(f.sent), /STOPPED_FAREWELL/);
});

test('a fixed activity window starts without a comparison call or usage and preserves the complete plan', { timeout: 25000 }, async t => {
  for (const failActiveSnapshotOnce of [false, true]) await t.test(
    failActiveSnapshotOnce ? 'a stale optional checkpoint cannot hide the committed busy state' : 'ordinary checkpoint', async t => {
      const f = await fixture(t, { runtimeBudget: { mode: 'observe' }, plans: 1, planDurationMs: 3 * minute, planFlexMs: 0, failActiveSnapshotOnce }); await f.start();
      await f.finished(await f.send('很想继续聊这个话题。'));
      await f.scenario('fixed-window', '', { choiceDecision: { choice: 'chat', reason: '更想聊天。', reply: '' } });
      const journalEvents = async () => {
        const text = await readFile(join(f.directory, 'data/life/journal.jsonl'), 'utf8');
        // Ignore a concurrent incomplete append; never treat snapshot freshness
        // as the authority for whether the actual activity transition committed.
        return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).flatMap(line => JSON.parse(line).events);
      };
      await f.advance(f.startedAt + minute);
      const started = await until(async () => (await journalEvents()).find(event => event.type === 'activity-started'), 'committed activity start');
      assert.equal(started.plan.startAt, f.startedAt + minute); assert.equal(started.plan.endAt, f.startedAt + 4 * minute);
      assert.equal((await f.calls()).filter(call => call.schema?.properties.choice).length, 0);
      const decisions = await readFile(join(f.directory, 'data/life/conversations.json'), 'utf8').then(JSON.parse);
      assert.equal(decisions.choices[0].outcome, 'fixed-window');
      assert.equal(decisions.choices[0].choice, undefined); assert.equal(decisions.choices[0].reason, undefined);
      const usage = await summarizeRuntimeUsage({ directory: join(f.directory, 'data/runtime-usage') });
      assert.ok(usage.days.every(day => day.purposes.every(row => row.purpose !== 'life-conversation')));
      assert.equal(f.sent.length, 1, 'fixed window does not invent an extra farewell');
      let staleCheckpoint;
      if (failActiveSnapshotOnce) {
        await until(() => f.logs().includes('TEST_ONCE_ACTIVE_SNAPSHOT_RENAME_DENIED'), 'injected optional checkpoint failure');
        assert.equal((await f.life()).plans[0].status, 'planned');
        staleCheckpoint = await readFile(join(f.directory, 'data/life/snapshot.json'), 'utf8');
      }
      const callsBeforeBusy = (await f.calls()).length;
      const incoming = await f.finished(await f.send('这条消息应收到实际的忙碌状态。'));
      assert.equal(incoming.decision.reason, 'busy');
      assert.equal((await f.calls()).length, callsBeforeBusy);
      assert.match(JSON.stringify(f.sent.at(-1)), /看书中/);
      if (failActiveSnapshotOnce) {
        await f.stop();
        // POSIX graceful shutdown may refresh the checkpoint. Restore only
        // this saved older checkpoint so every platform exercises recovery
        // from committed journal history that is ahead of snapshot.json.
        await writeFile(join(f.directory, 'data/life/snapshot.json'), staleCheckpoint);
        await f.start();
        const recovered = await f.planState(0, 'interrupted');
        assert.equal(recovered.startAt, started.plan.startAt); assert.equal(recovered.endAt, started.plan.endAt);
        assert.equal((await journalEvents()).filter(event => event.type === 'activity-started').length, 1);
        assert.equal((await f.calls()).filter(call => call.schema?.properties.choice).length, 0);
      }
    });
});

test('a fixed window fences a held ordinary reply and never compares or resends after stop and restart', { timeout: 25000 }, async t => {
  const f = await fixture(t, { runtimeBudget: { mode: 'observe' }, plans: 1, planDurationMs: 3 * minute, planFlexMs: 0 });
  await f.scenario('held-before-fixed-window', 'FIXED_OLD_REPLY_MUST_NOT_SEND', { hold: true }); await f.start();
  const message = await f.send('固定活动开始前还在生成的普通回复。');
  await until(async () => (await f.calls()).some(call => call.held), 'held ordinary generation');
  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  await f.finished(await f.send('别再找我了')); await f.releaseModel(); await f.finished(message);
  assert.equal(f.sent.length, 0); assert.equal((await f.calls()).filter(call => call.schema?.properties.choice).length, 0);
  await f.stop(); await f.start(); await f.planState(0, 'interrupted'); await sleep(400);
  assert.equal(f.sent.length, 0); assert.equal((await f.calls()).length, 1);
  assert.doesNotMatch(await f.memory(), /FIXED_OLD_REPLY_MUST_NOT_SEND/);
  const usage = await summarizeRuntimeUsage({ directory: join(f.directory, 'data/runtime-usage') });
  assert.ok(usage.days.every(day => day.purposes.every(row => row.purpose !== 'life-conversation')));
});

test('uncalibrated budget blocks the activity comparison without a model call or an invented farewell', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 1, runtimeBudget: null, planDurationMs: 3 * minute }); await f.start();
  await f.finished(await f.send('预算不可用时的一句聊天。'));
  assert.equal(f.sent.length, 1);
  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  assert.equal((await f.calls()).length, 0); assert.equal(f.sent.length, 1);
  const saved = JSON.parse(await readFile(join(f.directory, 'data/life/conversations.json'), 'utf8'));
  assert.equal(saved.choices[0].outcome, 'budget-blocked');
});

test('an activity farewell blocks a later sticker but never requeues text already handed to transport', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 1, holdFirstSend: true });
  await f.scenario('text-before-activity', '这句文字已经发起。\n[[qq_sticker:笑.png]]'); await f.start();
  const original = await f.send('先回这条消息。');
  await until(() => f.sent.length === 1, 'text transport already in progress');
  await f.scenario('farewell-after-text', '', { choiceDecision: {
    choice: 'activity', reason: '我要先去看书。', reply: '先去看书了，回来再聊。'
  } });
  await f.advance(f.startedAt + minute);
  await until(async () => {
    const saved = await readFile(join(f.directory, 'data/life/conversations.json'), 'utf8').then(JSON.parse);
    return saved.choices[0]?.status === 'sending';
  }, 'farewell durably claimed while waiting for send order').catch(async error => {
    const choices = await readFile(join(f.directory, 'data/life/conversations.json'), 'utf8');
    const contacts = await readFile(join(f.directory, 'data/life/contacts.json'), 'utf8');
    throw Error(`${error.message}\n${JSON.stringify({ choices, contacts, life: await f.life(),
      calls: (await f.calls()).map(call => ({ name: call.name, schema: call.schema })), logs: f.logs() })}`);
  });
  f.releaseSend(); const completed = await f.finished(original); await f.planState(0, 'active');
  assert.equal(completed.send.ok, true); assert.equal(completed.send.stickerSent, false);
  assert.equal(f.sent.length, 2); assert.ok(f.sent.every(item => item.message.every(part => part.type === 'text')));
  assert.match(JSON.stringify(f.sent[1]), /先去看书了/);
  await f.advance(f.startedAt + 2 * minute); await f.planState(0, 'completed'); await sleep(500);
  assert.equal(f.sent.length, 2, 'the delivered text is never regenerated as a catch-up');
  const saved = await readFile(join(f.directory, 'data/life/replies.json'), 'utf8').then(JSON.parse).catch(() => ({ entries: [] }));
  assert.equal(saved.entries.length, 0);
});

test('an old ordinary model finishing after the entire activity is still deferred instead of passing the now-available check', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 1 });
  await f.scenario('held-past-end', 'OLD_AFTER_ACTIVITY_MUST_NOT_SEND', { hold: true }); await f.start();
  const original = await f.send('INPUT_AFTER_ACTIVITY 这个问题要留住。');
  await until(async () => (await f.calls()).some(call => call.held), 'ordinary model before activity');
  await f.scenario('leave-without-farewell', '', { choiceDecision: { choice: 'activity', reason: '按计划去阅读。', reply: '' } });
  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  await f.advance(f.startedAt + 2 * minute); await f.planState(0, 'completed');
  await f.scenario('fresh-after-activity', '现在回来，接上刚才的问题。');
  await f.releaseModel(); await f.finished(original);
  await until(() => f.sent.length === 1, 'fresh regenerated catch-up after the activity');
  assert.doesNotMatch(JSON.stringify(f.sent), /OLD_AFTER_ACTIVITY/);
  const call = (await f.calls()).find(item => item.name === 'fresh-after-activity');
  assert.match(call.prompt, /INPUT_AFTER_ACTIVITY/);
  await sleep(500); assert.equal(f.sent.length, 1);
});

test('activity comparison uses only the selected current conversation and keeps its private reason out of public state', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 1 }); await f.start();
  await f.finished(await f.send('FIRST_CHOICE_PRIVATE_SECRET 我想聊星空。'));
  await f.advance(f.startedAt + 1000);
  await f.finished(await f.send('SECOND_CHOICE_PRIVATE_SECRET 我想聊航海。', { sender: 234567 }));
  await f.scenario('isolated-choice', '', { choiceDecision: {
    choice: 'activity', reason: 'SECOND_CHOICE_REASON 先暂停这一位的航海话题。', reply: '我先去看会书。'
  } });
  await f.advance(f.startedAt + minute); await f.planState(0, 'active');
  const call = (await f.calls()).find(item => item.schema?.properties.choice);
  assert.match(call.prompt, /SECOND_CHOICE_PRIVATE_SECRET/);
  assert.doesNotMatch(call.prompt, /FIRST_CHOICE_PRIVATE_SECRET/);
  assert.equal(f.sent.at(-1).user_id, 234567);
  assert.doesNotMatch(JSON.stringify(await f.life()), /FIRST_CHOICE_PRIVATE_SECRET|SECOND_CHOICE_PRIVATE_SECRET|SECOND_CHOICE_REASON|qq:private:234567/);
});

test('a newer authenticated message consumes an old comparison without sending its stale farewell or comparing again', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 1, planDurationMs: 3 * minute }); await f.start();
  await f.finished(await f.send('最初正在讨论的话题。'));
  await f.scenario('stale-by-new-input', '新来的那句先接上。', { holdChoice: true, choiceDecision: {
    choice: 'activity', reason: '根据之前的话题准备离开。', reply: 'STALE_CHOICE_FAREWELL'
  } });
  await f.advance(f.startedAt + minute);
  await until(async () => (await f.calls()).some(item => item.schema?.properties.choice), 'comparison held');
  await f.finished(await f.send('这是更新的一句真实消息。'));
  await f.releaseChoice(); await f.planState(0, 'active');
  assert.doesNotMatch(JSON.stringify(f.sent), /STALE_CHOICE_FAREWELL/);
  assert.equal((await f.calls()).filter(item => item.schema?.properties.choice).length, 1);
  const saved = JSON.parse(await readFile(join(f.directory, 'data/life/conversations.json'), 'utf8'));
  assert.equal(saved.choices[0].outcome, 'conversation-changed');
});

test('a held activity comparison cannot freeze timeline observation beyond its bounded decision window', { timeout: 25000 }, async t => {
  const f = await fixture(t, { plans: 1, planDurationMs: 3 * minute }); await f.start();
  await f.finished(await f.send('这段对话开始前先留一句。'));
  await f.scenario('held-choice-expiry', '', { holdChoice: true, choiceDecision: {
    choice: 'chat', reason: '这条比较已经太晚。', reply: ''
  } });
  await f.advance(f.startedAt + minute);
  await until(async () => (await f.calls()).some(item => item.schema?.properties.choice), 'held comparison before deadline');
  await f.advance(f.startedAt + minute + 31000);
  const active = await f.planState(0, 'active');
  assert.equal(active.startAt, f.startedAt + minute);
  assert.equal(active.endAt, f.startedAt + 4 * minute);
  assert.equal(active.startTransition.status, 'expired');
  await f.releaseChoice(); await sleep(400);
  assert.equal((await f.life()).plans[0].startAt, f.startedAt + minute, 'a late chat preference cannot move an active plan');
  assert.equal(f.sent.length, 1);
  assert.equal((await f.calls()).filter(item => item.schema?.properties.choice).length, 1);
});
