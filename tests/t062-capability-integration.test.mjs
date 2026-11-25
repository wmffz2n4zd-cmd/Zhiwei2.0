// T062-A actual PWA HTTP and fake-CLI prompt consumption. All data synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPwaStore } from '../src/pwa-store.js';
import { createPwaAuth } from '../src/pwa-auth.js';
import { createLifeTimeline } from '../src/life-timeline.js';
import { createUnifiedMemory } from '../src/unified-memory/index.js';
import sharp from 'sharp';
import vm from 'node:vm';
import * as replyPlan from '../src/private-reply-plan.js';
import * as replyContext from '../src/private-reply-context.js';
import { privateReplySettings, resolveReplyWriter } from '../src/private-reply-settings.js';
import { creativeDecisionPrompt, enabledCreativeKinds, readCreativeDecision, withCreativeSchema } from '../src/private-creative-work.js';
import { pwaIdentityCurrent } from '../src/private-transport.js';
import { proactiveDecisionSchema, parseProactiveDecision, buildProactivePrompt } from '../src/life-proactive.js';
import { conversationDecisionSchema, buildConversationPrompt } from '../src/life-conversation.js';
import { buildRuntimeCapabilities, renderRuntimeCapabilities } from '../src/runtime-capabilities.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
  const began = Date.now();
  while (Date.now() - began < timeout) { const result = await check(); if (result) return result; await pause(40); }
  throw Error(`Timed out: ${label}`);
}
async function port() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: { ...headers,
      ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', reject); req.end(body);
  });
}
async function fixture(t, { busy = false, replyMode = 'single', push = false } = {}) {
  const parent = join(root, 'runtime', 'tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 't062-capabilities-'));
  const apiPort = await port(), adminPort = await port(), origin = 'https://pwa.test';
  const base = `http://127.0.0.1:${apiPort}`, clockPath = join(directory, 'clock.json');
  const scenarioPath = join(directory, 'scenario.json'), callsPath = join(directory, 'calls.jsonl');
  const databasePath = join(directory, 'data', 'pwa', 'pwa.sqlite');
  const at = Date.UTC(2026, 10, 17, 10, 0);
  let child, logs = '', database;
  await cp(join(root, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(root, 'modules'), join(directory, 'modules'), { recursive: true });
  // Push delivery is outside this prompt test. Keep the real store and VAPID
  // setup but substitute only the worker in the disposable fixture copy.
  await cp(join(directory, 'src', 'pwa-push.js'), join(directory, 'src', 'pwa-push-real.js'));
  await writeFile(join(directory, 'src', 'pwa-push.js'), `export * from './pwa-push-real.js';
export function createPwaPushWorker(){return {start(){},async stop(){}};}`);
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await mkdir(join(directory, 'data', 'qq-stickers'), { recursive: true });
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#88aaff' } }).png().toBuffer();
  await writeFile(join(directory, 'data', 'qq-stickers', '笑.png'), png);
  await writeFile(clockPath, JSON.stringify({ now: at }));
  await writeFile(scenarioPath, JSON.stringify({ reply: '第一段。\n\n第二段。' }));
  await writeFile(join(directory, 'clock.mjs'), `import {readFileSync} from 'node:fs';
Date.now=()=>JSON.parse(readFileSync(${JSON.stringify(clockPath)},'utf8')).now;`);
  const cli = join(directory, 'fake-codex.mjs');
  await writeFile(cli, `import {readFile,writeFile,appendFile} from 'node:fs/promises';
let prompt='';for await(const part of process.stdin)prompt+=part;
const args=process.argv.slice(2),scenario=JSON.parse(await readFile(${JSON.stringify(scenarioPath)},'utf8'));
const schema=args.includes('--output-schema')?JSON.parse(await readFile(args[args.indexOf('--output-schema')+1],'utf8')):null;
await appendFile(${JSON.stringify(callsPath)},JSON.stringify({prompt,args,schema})+'\\n');
if(scenario.hold){await writeFile(${JSON.stringify(join(directory, 'model-held'))},'yes');
 while(!await readFile(${JSON.stringify(join(directory, 'model-release'))},'utf8').catch(()=>false))await new Promise(r=>setTimeout(r,20));}
let text=scenario.reply||'正常回复。';
if(schema?.properties.control){
 const refs=[...new Set(prompt.match(/e:[a-f0-9]{24}/g)||[])];
 text=JSON.stringify({control:{contextMore:false,contactBoundary:{kind:'none',quote:''},browseIntent:null},
 utterance:{goal:'回应眼前话题',points:['正常回答'],evidenceRefs:refs.slice(0,1),requiredLiterals:[],contextKind:'casual',compressible:false},
 presentation:{stickerName:null,moodProposal:null}});
}else if(schema?.properties.text)text=JSON.stringify({text});
if(schema?.properties.contactBoundary)text=JSON.stringify({reply:text,contextMore:false,contactBoundary:{kind:'none',quote:''},browseIntent:null});
if(args.includes('-o'))await writeFile(args[args.indexOf('-o')+1],text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:0,output_tokens:20}}));`);
  await writeFile(join(directory, 'data', 'windows.local.json'), JSON.stringify({
    qqEnabled: false, ownerUserIds: ['123456'], oneBotSecret: 'isolated-secret', oneBotApiBase: 'http://127.0.0.1:1',
    oneBotAccessToken: 'isolated-token', remoteEnabled: false, webLookup: false,
    runtimeBudget: { enabled: false }, mood: { enabled: true }, privateReplyMode: replyMode,
    life: { enabled: true, tickIntervalMs: 250, planning: { enabled: false }, browsingIntents: { enabled: false } },
    pwa: { enabled: true, origin, port: apiPort, pushEnabled: push }
  }));
  database = createPwaStore({ path: databasePath, now: () => at });
  const auth = createPwaAuth({ store: database });
  const accounts = [];
  for (const [username, role] of [['alice', 'admin'], ['bravo', 'friend']]) {
    const invitation = database.createInvitation({ role });
    const account = await auth.claim({ token: invitation.token, username, displayName: username,
      password: 'a-good-test-password', deviceName: 'synthetic' });
    accounts.push(account);
  }
  if (busy) {
    const timeline = await createLifeTimeline({ directory: join(directory, 'data', 'life'), now: () => at });
    await timeline.addThought({ id: 'synthetic-thought', text: '安静看一会书', source: { kind: 'interest', ref: 'synthetic' },
      strength: 0.7, activity: { title: '看书', statusText: '*看书中，稍后回来', durationMs: 60000, busy: true, mode: 'simulated' } });
    const plan = await timeline.planThought('synthetic-thought', { id: 'synthetic-plan', startAt: at + 1000 });
    assert.equal(plan.status, 'planned', 'Fixture must not start an activity before the Hub owns it');
    // Leave the plan unstarted. Active activities are correctly interrupted on
    // process recovery; the Hub itself must own this test activity's start.
    await timeline.close();
  }
  async function start() {
    child = spawn(process.execPath, ['--import', pathToFileURL(join(directory, 'clock.mjs')).href, 'src/server.js'], {
      cwd: directory, windowsHide: true, env: { ...process.env, PORT: String(adminPort), CODEX_CLI_PATH: cli,
        CODEX_REMOTE_CONTACT_QQ_WEB_LOOKUP: '0', HOME: directory, CODEX_HOME: join(directory, 'codex-home') } });
    child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
    let startupResponse;
    await until(() => rawRequest(base + '/', { headers: { host: 'pwa.test' } }).then(response => {
      startupResponse = response; return response.status === 200;
    }).catch(() => false), 'PWA Hub startup').catch(error => {
      throw Error(error.message + '\nHTTP=' + JSON.stringify(startupResponse?.body || startupResponse?.status) + '\n' + logs);
    });
  }
  async function stop(signal = 'SIGTERM') {
    if (child && child.exitCode == null) { const closed = once(child, 'close'); child.kill(signal); await closed; }
    child = null;
  }
  t.after(async () => {
    await writeFile(join(directory, 'model-release'), 'release').catch(() => {});
    await stop();
    const forensic = { test: t.name, log: logs, clock: JSON.parse(await readFile(clockPath, 'utf8')),
      lifeJournal: await readFile(join(directory, 'data', 'life', 'journal.jsonl'), 'utf8').catch(() => null),
      replies: await readFile(join(directory, 'data', 'life', 'replies.json'), 'utf8').catch(() => null),
      pendingInbox: database?.listPendingInbox({ limit: 1000 }), pendingProjections: database?.listPendingProjections({ limit: 1000 }) };
    await writeFile(directory + '.evidence.json', JSON.stringify(forensic, null, 2), { mode: 0o600 });
    database?.close();
    if (resolve(directory).startsWith(resolve(parent) + sep)) await rm(directory, { recursive: true, force: true });
  });
  async function request(account, path, { method = 'GET', data, bytes, mime } = {}) {
    return rawRequest(base + path, { method, headers: { host: 'pwa.test', origin,
      'x-pwa-request': '1', cookie: `__Host-zhiwei=${account.token}`, 'x-csrf-token': account.csrfToken,
      ...(mime ? { 'content-type': mime } : data ? { 'content-type': 'application/json' } : {}) },
      ...(bytes ? { body: bytes } : data ? { body: JSON.stringify(data) } : {}) });
  }
  const send = (account, id, text, extra = {}) => request(account, '/api/pwa/messages', { method: 'POST', data: {
    clientMessageId: id, text, ...extra } });
  const messages = account => database.listMessages(account.user.userId, { limit: 200 }).messages;
  const outbound = account => messages(account).filter(message => message.direction === 'outbound');
  const memory = async () => JSON.parse(await readFile(join(directory, 'data', 'unified-memory.json'), 'utf8'));
  const calls = async () => (await readFile(callsPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse);
  await start();
  if (busy) {
    await writeFile(clockPath, JSON.stringify({ now: at + 1000 }));
    await until(async () => {
      const lines = await readFile(join(directory, 'data', 'life', 'journal.jsonl'), 'utf8');
      const events = lines.split('\n').filter(Boolean).flatMap(line => JSON.parse(line).events);
      return events.some(event => event.type === 'activity-started' && event.plan.id === 'synthetic-plan' && event.plan.busy);
    }, 'Hub-owned busy activity start');
  }
  return { directory, database, accounts, request, send, messages, outbound, memory, calls, png, stop, start,
    config: async value => {
      const path = join(directory, 'data', 'windows.local.json');
      const current = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...current, pwa: { ...current.pwa, ...value } }));
    },
    scenario: value => writeFile(scenarioPath, JSON.stringify(value)),
    advance: value => writeFile(clockPath, JSON.stringify({ now: value })), at, logs: () => logs };
}

function capabilityBlock(prompt) {
  const marker = '你的当前能力与账号事实：';
  assert.equal(prompt.split(marker).length, 2, 'one current capability block per actual model prompt');
  return prompt.slice(prompt.indexOf(marker)).split('\n\n')[0];
}
async function finish(f, account, count) {
  await until(() => f.outbound(account).length === count && !f.database.hasPendingProjection(account.identity.memoryScope),
    'published reply and projection', 30000);
}

test('T062 formal PWA chat scopes notification facts and observes revocation after restart', { timeout: 50000 }, async t => {
  const f = await fixture(t, { push: true }), [alice, bravo] = f.accounts;
  await f.scenario({ reply: '收到。' });
  f.database.upsertSubscription({ userId: alice.user.userId, sessionId: alice.session.id,
    subscription: { endpoint: 'https://web.push.apple.com/synthetic-private-endpoint',
      keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } } });
  assert.equal((await f.send(alice, 'facts-a', 'ALICE_ONLY_CONTENT')).status, 200);
  await finish(f, alice, 1);
  assert.equal((await f.send(bravo, 'facts-b', 'BRAVO_ONLY_CONTENT')).status, 200);
  await finish(f, bravo, 1);
  const calls = await f.calls(); assert.equal(calls.length, 2);
  const a = capabilityBlock(calls[0].prompt), b = capabilityBlock(calls[1].prompt);
  assert.match(a, /当前对象已有有效通知订阅/);
  assert.match(b, /当前对象没有可用通知资格/);
  assert.match(a, /PWA|网页/); assert.match(b, /PWA|网页/);
  assert.doesNotMatch(calls[1].prompt, /ALICE_ONLY_CONTENT/);
  for (const block of [a, b]) {
    for (const secret of [alice.token, bravo.token, alice.csrfToken, alice.user.userId, bravo.user.userId,
      'synthetic-private-endpoint', 'A'.repeat(87), 'B'.repeat(22)]) assert.equal(block.includes(secret), false);
  }
  f.database.removeSubscription(alice.session.id);
  await f.stop(); await f.start();
  assert.equal((await f.send(alice, 'facts-revoked', '订阅撤销后的新问题')).status, 200);
  await finish(f, alice, 2);
  const latest = capabilityBlock((await f.calls()).at(-1).prompt);
  assert.match(latest, /当前对象没有可用通知资格/);
  assert.doesNotMatch(latest, /当前对象已有有效通知订阅/);
});

test('T062 busy catchup receives fresh shared facts without claiming immediate browsing or sticker output', { timeout: 45000 }, async t => {
  const f = await fixture(t, { busy: true }), [alice] = f.accounts;
  await f.send(alice, 'facts-busy-one', '等你忙完再接着聊');
  await until(() => f.outbound(alice).length === 1, 'busy status');
  await f.send(alice, 'facts-busy-two', '还有一句补充');
  await until(() => f.database.listPendingInbox({ limit: 100 }).length === 0, 'busy inputs persisted');
  assert.equal((await f.calls()).length, 0);
  await f.scenario({ reply: '回来了，接着说。' }); await f.advance(f.at + 62000);
  await finish(f, alice, 2);
  const calls = await f.calls(); assert.equal(calls.length, 1);
  const block = capabilityBlock(calls[0].prompt);
  assert.match(block, /网页|PWA/);
  assert.match(block, /本地表情库可用；这轮只生成文字回复/);
  assert.doesNotMatch(block, /这轮按语境选用贴切的本地表情/);
  assert.doesNotMatch(block, /本轮内置联网搜索可用|当前对象已有有效通知订阅/);
  assert.match(calls[0].prompt, /等你忙完再接着聊/);
  assert.match(calls[0].prompt, /还有一句补充/);
});

test('T062 two-stage ordinary reply carries runtime facts into actual Writer despite its evidence selection', { timeout: 45000 }, async t => {
  const f = await fixture(t, { replyMode: 'two-stage' }), [alice] = f.accounts;
  await f.scenario({ reply: '两阶段回复。' });
  assert.equal((await f.send(alice, 'facts-two-stage', '今天有什么想聊的')).status, 200);
  await finish(f, alice, 1);
  const calls = await f.calls(); assert.equal(calls.length, 2);
  assert.ok(calls[0].schema.properties.control);
  assert.ok(calls[1].schema.properties.text);
  for (const call of calls) {
    const block = capabilityBlock(call.prompt);
    assert.match(block, /本轮回复没有直接联网工具/);
    assert.match(block, /PWA|网页/);
    assert.ok(call.args.some(value => value === 'web_search="disabled"'));
  }
});

// These adapters are the real server functions evaluated with deterministic
// stores/clock and a captured model boundary. PWA HTTP coverage is above;
// these cases do not claim a real-model or delivered proactive observation.
async function lifeAdapter(mode, replyMode) {
  const source = await readFile(join(root, 'src/server.js'), 'utf8');
  const parts = ['creativeKindsFor', 'runReplyRole', 'generateLifePlannedReply', 'decideLifeContact', 'decideLifeConversation'].map(name => {
    const start = source.indexOf(`\n${name === 'creativeKindsFor' ? '' : 'async '}function ${name}(`) + 1; assert.ok(start > 0);
    const rest = source.slice(start), end = rest.slice(1).search(/\n(?:async )?function /); assert.ok(end >= 0);
    return rest.slice(0, end + 1);
  });
  const scope = 'qq:private:900000101', token = { scope, epoch: 1, sequence: 1 };
  const input = { scope, canDefer: true, decisionId: 'choice:a', deadline: 30000, token,
    plan: { id: 'plan:a' }, thought: { text: '想聊聊公开读到的内容' }, context: '',
    motiveRef: 'thought:synthetic', sources: [{ kind: 'thought', ref: 'thought:synthetic', scope },
      { kind: 'private-memory', ref: 'memory:synthetic', scope }] };
  const calls = [], factRequests = [];
  const identity = { userId: 'synthetic-user', memoryScope: scope, enabled: true,
    bindingStatus: 'active', preferredChannel: 'pwa', generation: 1, routeVersion: 1 };
  const route = { channel: 'pwa', privateIdentity: identity, scope };
  const sandbox = { ...replyPlan, ...replyContext, join, resolveReplyWriter,
    proactiveDecisionSchema, parseProactiveDecision, buildProactivePrompt, creativeDecisionPrompt, withCreativeSchema, readCreativeDecision,
    pwaIdentityCurrent, enabledCreativeKinds, pwaWritable: () => true, pwaConfig: { creativeTools: { design: true } },
    pwaStore: { getIdentity: id => id === identity.userId ? identity : null }, conversationDecisionSchema, buildConversationPrompt,
    replySettings: privateReplySettings({ privateReplyMode: replyMode }),
    localConfig: { privateChatModel: 'gpt-6.1-sol', privateChatReasoningEffort: 'low' }, state: { ai: {}, privateChat: { webLookup: { enabled: false } } },
    projectDir: '/isolated', dataDir: '/isolated/data', personaPolicy: null, Date: { now: () => 0 },
    AbortController, setTimeout, clearTimeout, backgroundTask: promise => promise,
    measureModelCall: action => action(), runtimeBudget: { run: async (_, action) => action() },
    serviceLifecycle: { stopping: false }, privateInputCurrent: () => true,
    capturePrivateRoute: event => event, contactEventFor: () => route,
    awaitPrivateProjection: async () => true, isLifeContactEligible: () => true,
    lifeGenerationRoutes: new Map(), lifeGenerationValidity: new Map(), lifeGenerationSelections: new Map(),
    unifiedMemory: { isEpochCurrent: async () => true },
    privateLearning: { initialize: async () => {}, formatContext: async () => '' },
    lifeTimeline: { snapshot: () => ({ plans: [{ id: 'plan:a', status: 'planned',
      startTransition: { status: 'pending', id: 'choice:a', claimedAt: 0 } }] }) },
    lifeContacts: { capture: () => token, isCurrent: () => true, isPaused: () => false },
    lifeConversation: { snapshot: () => ({ choices: [{ id: 'choice:a', status: 'generating' }] }) },
    loadAssistantSkillBrief: async () => '极简龙娘身份',
    currentCapabilityText: (event, options) => {
      factRequests.push({ event, options });
      return renderRuntimeCapabilities(buildRuntimeCapabilities({ worldEnabled: true, platforms: ['web', 'x'],
        nativeSearchEnabled: false, lifeEnabled: true, memoryEnabled: true,
        pwa: { enabled: true, writable: true, currentConversation: true, history: true,
          notificationServiceEnabled: true, notificationRecipientEligible: true } }), options);
    },
    createWorldModel: options => async ({ prompt }) => {
      const schema = options.schema, refs = [...new Set(prompt.match(/e:[a-f0-9]{24}/g) || [])];
      const role = schema.properties.control ? 'planner' : schema.properties.text ? 'writer' : 'single';
      calls.push({ role, prompt, schema });
      const body = role === 'writer' ? { text: '真实适配器合成回复。' }
        : role === 'single' ? mode === 'proactive' ? { reply: '合成主动回复。', sourceRefs: input.sources.map(row => row.ref) }
          : { choice: 'activity', reason: '已有安排', reply: '我先去忙一会。' }
        : { control: mode === 'proactive' ? { sourceRefs: input.sources.map(row => row.ref) }
          : { choice: 'activity', reason: '已有安排' },
          utterance: { goal: '自然表达', points: ['眼前意思'], evidenceRefs: refs.slice(0, 1), requiredLiterals: [],
            contextKind: 'casual', compressible: false }, presentation: { stickerName: null, moodProposal: null } };
      if (schema.properties.creativeWork) body.creativeWork = null;
      if (schema.properties.control?.properties.creativeWork) body.control.creativeWork = null;
      return { text: JSON.stringify(body), usage: null };
    }
  };
  const adapters = vm.runInNewContext(parts.join('\n') + '\n({decideLifeContact,decideLifeConversation})', sandbox);
  const result = await (mode === 'proactive' ? adapters.decideLifeContact : adapters.decideLifeConversation)(input,
    { epochToken: {}, selectionKey: 'synthetic', canContinue: async () => true });
  return { result: JSON.parse(result), calls, factRequests, route };
}

for (const mode of ['proactive', 'conversation']) for (const replyMode of ['single', 'two-stage']) {
  test(`T062 actual ${mode} ${replyMode} adapter and Writer consume only current-object capability facts`, async () => {
    const f = await lifeAdapter(mode, replyMode);
    assert.equal(f.factRequests.length, 1);
    assert.equal(f.factRequests[0].event, f.route);
    assert.equal(f.factRequests[0].options.entry, mode);
    assert.equal(f.calls.length, replyMode === 'single' ? 1 : 2);
    for (const call of f.calls) {
      const block = capabilityBlock(call.prompt);
      assert.match(block, /本轮回复没有直接联网工具/);
      assert.match(block, /当前对象已有有效通知订阅/);
      assert.doesNotMatch(block, /本轮内置联网搜索可用|贴切的本地表情/);
    }
    const decision = f.calls[0].schema.properties;
    const creativeField = (decision.control?.properties || decision).creativeWork;
    if (mode === 'proactive') assert.deepEqual([...creativeField.anyOf[1].properties.kind.enum], ['design']);
    else assert.equal(creativeField, undefined);
    assert.ok(f.result.reply);
  });
}

