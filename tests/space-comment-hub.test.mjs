import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createPwaAuth } from '../src/pwa-auth.js';
import { createPwaStore } from '../src/pwa-store.js';
import { createUnifiedMemory } from '../src/unified-memory/index.js';
import { buildRuntimeCapabilities, renderRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { summarizeRuntimeUsage } from '../src/runtime-usage.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'https://space.test';
async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function call(port, path, account, body) {
  const headers = { host: 'space.test', origin, 'x-pwa-request': '1', 'content-type': 'application/json' };
  if (account) Object.assign(headers, { cookie: '__Host-zhiwei=' + account.token, 'x-csrf-token': account.csrfToken });
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers, method: body ? 'POST' : 'GET' }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function until(check, label) {
  const deadline = Date.now() + 18000;
  do {
    if (await check()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw Error('Timed out awaiting ' + label);
}
async function seedPrivateExchange(store, memory, userId) {
  const inbound = store.acceptInbound({ userId, clientMessageId: randomUUID(), text: 'ONLY_PRIVATE_CHAT' });
  store.markInboxProjected(inbound.inboxId);
  const { memoryScope: scope, routeVersion, generation } = inbound.identity;
  const thought = { action: '慢慢读', subject: 'ONLY_PRIVATE_THOUGHT' };
  assert.equal((await memory.write({ scope, type: 'preference', summary: 'ONLY_PRIVATE_MEMORY' })).ok, true);
  const token = await memory.captureEpoch({ scope });
  const logicalReplyId = randomUUID(), inboundIds = [inbound.inboxId];
  const event = { channel: 'pwa', type: 'private_message', privateIdentity: inbound.identity,
    memoryEpochToken: token, raw: { message_id: 'pwa:' + inbound.inboxId }, privateThought: thought };
  const sent = store.publishSegments({ userId, scope, routeVersion, generation, logicalReplyId, segmentIndex: 0,
    deliveryId: logicalReplyId + ':0', inboundIds, segments: [{ type: 'text', text: 'ONLY_PRIVATE_ANSWER' }],
    projection: { version: 1, kind: 'exchange', event, skipMemory: false } });
  const args = { userId, scope, epoch: token.epoch, logicalReplyId, inboundIds, thought };
  assert.equal(store.commitPrivateThought(args).ok, true);
  store.completeProjection(sent.projectionId);
  store.completeInbox(inbound.inboxId);
  assert.equal(store.listPrivateThoughts(args)[0].subject, thought.subject);
  assert.match((await memory.recall({ scope, query: 'ONLY_PRIVATE_MEMORY' })).context, /ONLY_PRIVATE_MEMORY/);
}

test('public feature facts reflect writable space and availability of optional replies', () => {
  const facts = (space, writable, spaceReplies) => renderRuntimeCapabilities(
    buildRuntimeCapabilities({ pwa: { enabled: true, space, writable, spaceReplies } }));
  assert.match(facts(true, true, true), /原评论下回复/);
  assert.match(facts(true, true, false), /发表所有登录用户可见的评论/);
  assert.doesNotMatch(facts(true, true, false), /原评论下回复/);
  for (const text of [facts(false, true, true), facts(true, false, true)]) {
    assert.doesNotMatch(text, /原评论下回复|发表所有登录用户可见的评论/);
  }
});

test('two accounts comment through the Hub and see only the selected public reply after restart and replay',
  { timeout: 80000 }, async t => {
    const parent = join(root, 'runtime/tests');
    await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(join(parent, 'space-comments-'));
    const dbPath = join(dir, 'data/pwa/pwa.sqlite'), modelLog = join(dir, 'public-prompts.jsonl');
    let store, hub, log = '';
    async function stop() {
      if (hub && hub.exitCode === null && hub.signalCode === null) {
        const stopped = once(hub, 'close');
        hub.kill('SIGTERM');
        await stopped;
      }
      hub = null;
    }
    t.after(async () => { await stop(); store?.close(); await rm(dir, { recursive: true, force: true }); });
    for (const name of ['src', 'config', 'modules']) await cp(join(root, name), join(dir, name), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    store = createPwaStore({ path: dbPath });
    const auth = createPwaAuth({ store });
    const accounts = [];
    for (const [username, displayName, options] of [
      ['reader1', '山竹', {}], ['reader2', '青禾', { memoryScope: 'qq:private:910000001' }]
    ]) {
      const { token } = store.createInvitation(options);
      accounts.push(await auth.claim({ username, displayName, token, password: randomUUID() }));
    }
    const [a, b] = accounts;
    const memory = createUnifiedMemory({ memoryPath: join(dir, 'data/unified-memory.json') });
    await seedPrivateExchange(store, memory, a.user.id);
    const seedPost = (eventKey, text) => store.finishSpaceDecision({ eventKey, claim: store.beginSpaceDecision(eventKey),
      post: { kind: 'daily', text, source: null } }).post;
    const main = seedPost('daily:paper', '我把第二只纸船的船底重新摊平，放在桌上终于站稳了。');
    const other = seedPost('daily:other', 'OTHER_POST_ONLY');
    const cli = join(dir, 'model.mjs');
    await writeFile(cli, [
      "import { readFile, appendFile } from 'node:fs/promises';",
      "let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;",
      "const args=process.argv, schema=JSON.parse(await readFile(args[args.indexOf('--output-schema')+1],'utf8'));",
      "if (schema.properties.action.enum.join(',')!=='reply,skip') throw Error('unexpected model route');",
      "const material=JSON.parse(prompt.split('\\n').at(-1));",
      "const choice=material.comment.includes('哪里')?{action:'reply',text:'我改的是船底，把中间那条折痕按平了。'}:{action:'skip',text:null};",
      "await appendFile(" + JSON.stringify(modelLog) + ",JSON.stringify({prompt,choice})+'\\n');",
      "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(choice)}}));",
      "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:0,output_tokens:21}}));"
    ].join('\n'));
    const port = await freePort(), adminPort = await freePort();
    const env = { ...process.env, HOME: dir, CODEX_HOME: join(dir, 'home'), CODEX_CLI_PATH: cli, PORT: String(adminPort) };
    async function start(readOnly = false) {
      await writeFile(join(dir, 'data/windows.local.json'), JSON.stringify({
        assistantProfile: 'config/zhiwei-profile.md', qqEnabled: false, remoteEnabled: false,
        life: { enabled: true, tickIntervalMs: 250, planning: { enabled: false } },
        runtimeBudget: { mode: 'observe' }, privateLearning: { enabled: false },
        pwa: { enabled: true, origin, port, pushEnabled: false, spaceEnabled: true, readOnly }
      }));
      hub = spawn(process.execPath, ['src/server.js'], { cwd: dir, windowsHide: true, env });
      hub.stdout.on('data', chunk => { log += chunk; });
      hub.stderr.on('data', chunk => { log += chunk; });
      await until(async () => {
        if (hub.exitCode !== null) throw Error('Hub exited ' + hub.exitCode + '\n' + log.slice(-1800));
        return (await call(port, '/api/pwa/me', a).catch(() => null))?.data.capabilities?.space;
      }, 'space listener');
    }
    const base = '/api/pwa/space/posts', path = base + '/' + main.id + '/comments';
    const draftA = { clientCommentId: 'same-device-key', text: '来留个脚印。' };
    const draftB = { clientCommentId: 'same-device-key', text: '你改的是哪里？' };
    const calls = async () => (await readFile(modelLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse);
    await start();
    const first = (await call(port, path, a, draftA)).data.comment;
    const second = (await call(port, path, b, draftB)).data.comment;
    assert.ok(first && second && first.id !== second.id);
    assert.equal((await call(port, path, null, draftA)).status, 401);
    const observed = () => store.listSpaceComments(main.id).comments;
    await until(() => observed().find(c => c.id === second.id)?.reply, 'selective reply');
    const [replied, skipped] = observed();
    assert.deepEqual([replied.id, replied.postId, replied.authorName, skipped.id, skipped.authorName, skipped.reply],
      [second.id, main.id, '青禾', first.id, '山竹', null]);
    assert.match(replied.reply.text, /船底/);
    const decisions = await calls();
    assert.deepEqual(decisions.map(d => d.choice.action), ['skip', 'reply']);
    assert.deepEqual(decisions.map(d => JSON.parse(d.prompt.split('\n').at(-1))),
      [draftA, draftB].map(d => ({ post: main.text, comment: d.text })));
    assert.deepEqual((await call(port, path, a)).data, (await call(port, path, b)).data);
    assert.deepEqual((await call(port, base + '/' + other.id + '/comments', a)).data.comments, []);
    assert.doesNotMatch(JSON.stringify([decisions, observed(), (await call(port, base, a)).data]),
      /ONLY_PRIVATE_|qq:private:|private:user:/);
    assert.doesNotMatch(JSON.stringify(decisions), /OTHER_POST_ONLY/);
    await stop();
    await start(true);
    assert.equal((await call(port, path, b, draftB)).status, 503);
    assert.deepEqual((await call(port, path, b)).data.comments, [replied, skipped]);
    await stop();
    await start();
    for (const [account, draft, id] of [[a, draftA, first.id], [b, draftB, second.id]]) {
      const replay = await call(port, path, account, draft);
      assert.equal(replay.data.duplicate, true);
      assert.equal(replay.data.comment.id, id);
    }
    await delay(850);
    assert.deepEqual(await calls(), decisions);
    assert.deepEqual((await call(port, path, b)).data.comments, [replied, skipped]);
    assert.equal(store.listMessages(a.user.id).messages.length, 2);
    assert.equal((await call(port, '/api/pwa/messages', b)).status, 403);
    const inspected = new Database(dbPath, { readonly: true });
    try {
      assert.equal(inspected.prepare('SELECT count(*) AS total FROM messages WHERE user_id=?').get(b.user.id).total, 0);
      assert.equal(inspected.prepare('SELECT count(*) AS total FROM push_jobs').get().total, 0);
    } finally { inspected.close(); }
    const usage = await summarizeRuntimeUsage({ directory: join(dir, 'data/runtime-usage') });
    const observedCalls = usage.days.flatMap(day => day.purposes).filter(row => row.purpose === 'space-comment-reply');
    assert.equal(observedCalls.reduce((sum, row) => sum + row.succeeded, 0), 2);
    assert.equal(observedCalls.reduce((sum, row) => sum + row.knownTokens.output_tokens, 0), 42);
    console.log('S140_HUB ' + JSON.stringify({ starts: 3, authors: [skipped.authorName, replied.authorName],
      postId: main.id, repliedTo: replied.id, skipped: skipped.id, modelCalls: decisions.length,
      replayAdded: 0, extraPrivateMessages: 0, guest: 401, maintenance: 503 }));
  });
