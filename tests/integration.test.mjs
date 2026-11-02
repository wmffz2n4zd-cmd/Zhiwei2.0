import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, cp, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await sleep(30); }
  throw Error('Condition timed out');
}
test('private Hub → signed OneBot → CLI subprocess, Skill, media and retired-command isolation', { timeout: 180000 }, async t => {
  const testsDir = join(root, 'runtime', 'tests');
  await mkdir(testsDir, { recursive: true });
  const fixture = await mkdtemp(join(testsDir, 'integration-'));
  let child;
  const sent = [];
  const rejected = [];
  let rejectText = null;
  const groupSent = [];
  const imageRequests = [];
  const bridge = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer api-secret');
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/send_private_msg') {
      const message = JSON.parse(body);
      if (rejectText && message.message.some(s => s.type === 'text' && s.data.text === rejectText)) {
        rejected.push(message);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'failed', retcode: 1200 }));
        return;
      }
      sent.push(message);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', data: { message_id: 10000 + sent.length } }));
      return;
    }
    if (req.url === '/send_group_msg') groupSent.push(JSON.parse(body));
    if (req.url === '/get_image') {
      imageRequests.push(JSON.parse(body).file);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', data: { file: join(fixture, 'data', 'qq-stickers', '笑死.png') } }));
      return;
    }
    if (req.url === '/get_msg' && String(JSON.parse(body).message_id) === '901') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', data: { message_id: 901, user_id: 123456,
        message: [{ type: 'image', data: { file: 'quoted-private-image' } }] } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', data: { user_id: 999999, nickname: 'test bridge' } }));
  });
  await new Promise(r => bridge.listen(0, '127.0.0.1', r));
  const portProbe = createServer();
  await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
  const port = portProbe.address().port;
  await new Promise(r => portProbe.close(r));
  t.after(async () => {
    if (child && child.exitCode == null) { const closed = once(child, 'close'); child.kill(); await closed; }
    bridge.closeAllConnections(); await new Promise(r => bridge.close(r));
    // Delete only the temporary fixture created by this test, inside runtime/tests.
    if (resolve(fixture).startsWith(resolve(testsDir) + sep)) await rm(fixture, { recursive: true, force: true });
  });
  await cp(join(root, 'src'), join(fixture, 'src'), { recursive: true });
  await cp(join(root, 'modules', 'web-console'), join(fixture, 'modules', 'web-console'), { recursive: true });
  await writeFile(join(fixture, 'package.json'), '{"type":"module"}');
  await mkdir(join(fixture, 'data'), { recursive: true });
  await mkdir(join(fixture, 'data', 'qq-stickers'), { recursive: true });
  await writeFile(join(fixture, 'data', 'qq-stickers', '笑死.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'));
  await mkdir(join(fixture, 'skill'), { recursive: true });
  await writeFile(join(fixture, 'skill', 'SKILL.md'), 'Feynman fixture: explain with plain words.');
  await writeFile(join(fixture, 'data', 'windows.local.json'), JSON.stringify({
    runtimeBudget: { enabled: false }, // Explicit legacy-behavior fixture; budget has separate integration cases.
    ownerUserIds: ['123456'], qqEnabled: true, qqPrivateOnly: false, remoteEnabled: true, webLookup: false, assistantName: '知微',
    // Legacy configuration cannot restore group behavior or private topic gates.
    chatModes: { enabled: true, defaultMode: 'bubble', groups: ['123456789'] },
    musicPlaylist: 'config/no-longer-present-songs.txt', // Retired config must not trigger a startup read.
    interests: { enabled: true, threshold: 10, topics: {} },
    oneBotSecret: 'callback-secret', oneBotAccessToken: 'api-secret',
    oneBotApiBase: `http://127.0.0.1:${bridge.address().port}`, skills: { feynman: 'skill/SKILL.md' },
    qqImageCacheRoots: [join(fixture, 'data', 'qq-stickers')]
  }));
  const fakeCli = join(fixture, 'fake-codex.mjs');
  await writeFile(fakeCli, `import {writeFile,appendFile} from 'node:fs/promises';
const args = process.argv.slice(2); let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;
await appendFile(${JSON.stringify(join(fixture, 'calls.jsonl'))}, JSON.stringify({args,prompt})+'\\n');
const output=args[args.indexOf('-o')+1];
const current=prompt.split(/收到的 QQ 私聊：/).at(-1);
if(current.includes('自然气泡测试')) {
  await writeFile(output, '好啊，先去书店。\\n\\n我还想顺路看看那家小店。\\n[[qq_sticker:笑死.png]]'); process.exit(0);
}
if(current.includes('气泡中途失败测试')) {
  await writeFile(output, '第一段确实送达。\\n\\n第二段被拒绝。\\n\\n第三段不应发送。\\n[[qq_sticker:笑死.png]]'); process.exit(0);
}
if(current.includes('单换行完整测试')) {
  await writeFile(output, '这两句需要放一起。\\n这里仍是同一条。'); process.exit(0);
}
if(current.includes('表情顺序测试')) {
  await writeFile(output, '这也太好笑了。\\n[[qq_sticker:笑死.png]]'); process.exit(0);
}
if(current.includes('流式结束测试')) {
  await writeFile(output, '不可发送的旧文件内容');
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'流式最终回复'}}));
  console.log(JSON.stringify({type:'turn.completed'}));
  await new Promise(r => setTimeout(r, 3000));
  await writeFile(${JSON.stringify(join(fixture, 'stream-exited'))}, 'closed');
  process.exit(0);
}
if(current.includes('补查上限测试')) {
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'[[qq_context_more]]'}}));
  console.log(JSON.stringify({type:'turn.completed'}));
  process.exit(0);
}
if(prompt.includes('触发模拟CLI故障')) { console.error('PRIVATE_PERSONA secret_token'); console.log(JSON.stringify({type:'turn.failed',error:{message:'Usage limit exceeded'}})); process.exit(1); }
await writeFile(output, args.includes('workspace-write') ? '任务执行完成' : '普通回复完成');`);
  let logs = '';
  child = spawn(process.execPath, ['src/server.js'], { cwd: fixture, env: { ...process.env, PORT: String(port), CODEX_CLI_PATH: fakeCli, CODEX_REMOTE_CONTACT_QQ_WEB_LOOKUP: '0' }, windowsHide: true });
  child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  const url = `http://127.0.0.1:${port}`;
  try { await until(() => fetch(url + '/api/platform').then(r => r.ok).catch(() => false)); }
  catch (error) { throw new Error(error.message + '\nHub output: ' + logs); }
  const platform = await fetch(url + '/api/platform').then(r => r.json());
  assert.equal(platform.imessage, process.platform === 'darwin');
  assert.equal(platform.qqPrivateOnly, true, 'legacy false cannot restore group mode');
  assert.ok(platform.skills.includes('feynman'));
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url + '/api/platform', { headers: { Origin: 'http://untrusted.example' } })).status, 403);
  if (process.platform !== 'darwin') assert.equal((await fetch(url + '/api/channel', { method: 'POST', body: JSON.stringify({ channel: 'imessage', enabled: true }) })).status, 400);
  assert.equal((await fetch(url + '/api/onebot/event', { method: 'POST', body: '{}' })).status, 401);
  let id = 0;
  async function send(text, overrides = {}, expectIgnored = false) {
    const payload = { post_type: 'message', message_type: 'private', self_id: 999999, user_id: 123456,
      message_id: ++id, raw_message: text, message: [{ type: 'text', data: { text } }], ...overrides };
    const raw = JSON.stringify(payload);
    const signature = 'sha1=' + createHmac('sha1', 'callback-secret').update(raw).digest('hex');
    const response = await fetch(url + '/api/onebot/event', { method: 'POST', headers: { 'x-signature': signature }, body: raw });
    assert.equal(response.status, 200);
    if (expectIgnored) assert.equal((await response.json()).ignored, true);
    return payload.message_id;
  }
  const waitReplies = count => until(() => sent.length >= count);
  const completed = messageId => until(async () => (await fetch(url + '/api/state').then(r => r.json())).qq.events.find(e => e.event.raw?.message_id === messageId && e.completedAt));
  const callCount = async () => (await readFile(join(fixture, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).length;
  const latestCall = async () => JSON.parse((await readFile(join(fixture, 'calls.jsonl'), 'utf8')).trim().split('\n').at(-1));
  // Check the current input description, not recalled history from prior cases.
  const incomingPromptText = call => call.prompt.split('收到的 QQ 私聊：\n').at(-1).split('\n')[0];
  await send('/技能 feynman'); await waitReplies(1);
  const timedId = await send('解释惯性'); await waitReplies(2);
  const timedRecord = await until(async () => {
    const state = await fetch(url + '/api/state').then(r => r.json());
    return state.qq.events.find(e => e.event.raw?.message_id === timedId && e.completedAt);
  });
  assert.equal(timedRecord.timings.modelCalls, 1);
  assert.ok(timedRecord.timings.modelMs > 0);
  assert.ok(timedRecord.timings.batchMs >= 2500);
  assert.equal(typeof timedRecord.timings.sendMs, 'number');
  assert.ok(timedRecord.timings.totalMs >= timedRecord.timings.modelMs + timedRecord.timings.batchMs);
  const diagnostic = await until(async () => {
    const lines = await readFile(join(fixture, 'runtime', 'logs', 'qq-timings.jsonl'), 'utf8').catch(() => '');
    return lines.trim().split('\n').filter(Boolean).map(JSON.parse).find(e => e.messageId === timedId);
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /解释惯性|Feynman|api-secret/);
  await send('/执行 创建一个测试文件'); await waitReplies(3);
  const confirmId = await send('/确认'); await waitReplies(4);
  await send('/确认', { message_id: confirmId }); // Same message must not run twice.
  await send('/执行 不允许', { user_id: 654321 });
  await sleep(150);
  const calls = (await readFile(join(fixture, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.match(calls[0].prompt, /Feynman fixture/);
  assert.ok(calls[0].args.includes('read-only'));
  assert.ok(calls[1].args.includes('workspace-write'));
  assert.equal(calls[1].args.includes('danger-full-access'), false);
  assert.match(calls[1].prompt, /Feynman fixture/);
  assert.equal(calls[1].args[calls[1].args.indexOf('-C') + 1], join(fixture, 'workspaces', 'remote'));
  assert.equal(sent.length, 4);
  assert.equal(sent[3].user_id, 123456);
  assert.match(JSON.stringify(sent[3]), /任务执行完成/);
  assert.doesNotMatch(logs, /ENOENT.*osascript|ENOENT.*sqlite3/);
  const beforeGroups = await callCount(), beforeGroupImages = imageRequests.length;
  const groupAllowList = await fetch(url + '/api/qq/groups', { method: 'POST', body: JSON.stringify({ allowedGroups: ['123456789'] }) });
  assert.equal(groupAllowList.status, 404);
  for (const type of ['group_message', 'group_at']) {
    const response = await fetch(url + '/api/qq/event', { method: 'POST', body: JSON.stringify({ type, groupId: '123456789', senderId: '123456', text: '@知微 巧克力 GROUP_IGNORED' }) });
    assert.equal((await response.json()).ignored, true);
  }
  await send('@知微 GROUP_IGNORED', {
    message_type: 'group', group_id: 123456789,
    message: [{ type: 'reply', data: { id: '901' } }, { type: 'at', data: { qq: '999999' } },
      { type: 'image', data: { file: 'ignored-group-image' } }, { type: 'text', data: { text: '@知微 GROUP_IGNORED' } }]
  }, true);
  await sleep(1200);
  assert.equal(await callCount(), beforeGroups);
  assert.equal(imageRequests.length, beforeGroupImages, 'group rejection must precede media reads');
  assert.equal(sent.length, 4);
  assert.equal(groupSent.length, 0);
  assert.equal(Object.hasOwn((await fetch(url + '/api/state').then(r => r.json())).qq, 'allowedGroups'), false);

  const memoryBeforeRetired = await readFile(join(fixture, 'data', 'unified-memory.json'), 'utf8');
  const beforeRetired = await callCount();
  for (const command of ['/活跃模式', '/冒泡模式', '/兴趣', '/兴趣测试 雪莉桶威士忌', '/兴趣添加 新话题 新词', '/兴趣删除 旧话题', '/开始聊天测试 兴趣']) {
    const count = sent.length, commandId = await send(command);
    await waitReplies(count + 1); await completed(commandId);
    assert.match(JSON.stringify(sent.at(-1)), /已停用|已退役|不再支持/);
  }
  assert.equal(await callCount(), beforeRetired, 'retired commands must never call the model');
  assert.equal(await readFile(join(fixture, 'data', 'unified-memory.json'), 'utf8'), memoryBeforeRetired, 'retired command feedback must not become chat memory');
  const ordinaryCount = sent.length, ordinaryCalls = await callCount();
  const ordinaryId = await send('公交车晚点了'); await waitReplies(ordinaryCount + 1); await completed(ordinaryId);
  assert.equal(await callCount(), ordinaryCalls + 1, 'ordinary owner speech needs no test mode or topic keyword');
  assert.match(JSON.stringify(sent.at(-1)), /普通回复完成/);
  assert.doesNotMatch(JSON.stringify(sent.at(-1)), /指令|兴趣门槛|【测试】/);
  for (const text of ['推荐一首歌', '知微在听什么歌']) {
    const count = sent.length, before = await callCount();
    // A reply segment bypasses batching, so this exercises the same chat route without extra timer waits.
    const musicId = await send(text, { message: [{ type: 'reply', data: { id: '88' } }, { type: 'text', data: { text } }] });
    await waitReplies(count + 1); await completed(musicId);
    assert.equal(await callCount(), before + 1, 'music questions use ordinary model context');
    assert.match(JSON.stringify(sent.at(-1)), /普通回复完成/);
    assert.doesNotMatch(JSON.stringify(sent.at(-1)), /在听《|那就来一首《/);
  }
  const beforeCommands = await callCount();
  for (const command of ['/状态', '/记住 喜欢甜巧克力', '/记忆', '/关闭QQ', '/开启QQ']) {
    const count = sent.length;
    await send(command); await waitReplies(count + 1);
  }
  assert.equal(await callCount(), beforeCommands, 'backend commands must not start Codex');
  assert.match(JSON.stringify(sent.at(-3)), /甜巧克力/);
  const afterCommands = await fetch(url + '/api/state').then(r => r.json());
  assert.equal(afterCommands.channels.qq, true);
  const count = sent.length; await send('我喜欢哪种巧克力'); await waitReplies(count + 1);
  const lastCall = JSON.parse((await readFile(join(fixture, 'calls.jsonl'), 'utf8')).trim().split('\n').at(-1));
  assert.match(lastCall.prompt, /喜欢甜巧克力/);
  const failureCount = sent.length; await send('触发模拟CLI故障'); await waitReplies(failureCount + 1);
  assert.match(JSON.stringify(sent.at(-1)), /额度/);
  assert.doesNotMatch(JSON.stringify(sent.at(-1)), /PRIVATE_PERSONA|secret_token|Codex CLI exited/);
  const memoryAfterFailure = JSON.parse(await readFile(join(fixture, 'data', 'unified-memory.json'), 'utf8'));
  assert.equal(memoryAfterFailure.entries.some(e => e.summary.includes('触发模拟CLI故障')), false);

  // Short private-message bursts remain one generation and one reply.
  const beforeBatch = sent.length, callsBeforeBatch = await callCount();
  const firstBatchId = await send('私聊分段一');
  const secondBatchId = await send('私聊分段二');
  await waitReplies(beforeBatch + 1);
  const batchRecord = await completed(firstBatchId);
  assert.match(batchRecord.event.text, /私聊分段一\n私聊分段二/);
  assert.deepEqual(batchRecord.event.raw.batched_message_ids, [firstBatchId, secondBatchId]);
  assert.equal(batchRecord.timings.modelCalls, 1);
  assert.equal(await callCount(), callsBeforeBatch + 1);
  assert.equal(sent.length, beforeBatch + 1);

  const quickMessage = text => send(text, { message: [{ type: 'reply', data: { id: '88' } }, { type: 'text', data: { text } }] });
  const streamCount = sent.length;
  await quickMessage('流式结束测试'); await waitReplies(streamCount + 1);
  assert.match(JSON.stringify(sent.at(-1)), /流式最终回复/);
  assert.doesNotMatch(JSON.stringify(sent.at(-1)), /不可发送的旧文件内容/);
  assert.equal(await readFile(join(fixture, 'stream-exited'), 'utf8').catch(() => null), null, 'reply must arrive before CLI shutdown');
  const beforeExpand = await callCount(), expandCount = sent.length;
  const expandId = await quickMessage('补查上限测试'); await waitReplies(expandCount + 1);
  assert.equal(await callCount() - beforeExpand, 2, 'only one context retry is allowed');
  assert.doesNotMatch(JSON.stringify(sent.at(-1)), /qq_context_more/);
  const expandRecord = await until(async () => (await fetch(url + '/api/state').then(r => r.json())).qq.events.find(e => e.event.raw?.message_id === expandId && e.completedAt));
  assert.equal(expandRecord.timings.modelCalls, 2);
  // Finish the background process before removing its temporary workspace.
  await until(() => readFile(join(fixture, 'stream-exited'), 'utf8').catch(() => null));

  const beforeSticker = sent.length;
  await quickMessage('表情顺序测试'); await waitReplies(beforeSticker + 2);
  assert.deepEqual(sent[beforeSticker].message.map(s => s.type), ['text']);
  assert.deepEqual(sent[beforeSticker + 1].message.map(s => s.type), ['image']);

  // A single generation can produce several bubbles; one exchange retains all
  // delivered IDs. Failed continuation text is never remembered as spoken.
  const bubbleBefore = sent.length, bubbleCalls = await callCount();
  const bubbleId = await quickMessage('自然气泡测试');
  const bubbleRecord = await completed(bubbleId);
  assert.equal(sent.length, bubbleBefore + 3);
  assert.deepEqual(sent.slice(bubbleBefore).map(item => item.message.map(s => s.type)), [['text'], ['text'], ['image']]);
  assert.equal(sent[bubbleBefore].message[0].data.text, '好啊，先去书店。');
  assert.equal(sent[bubbleBefore + 1].message[0].data.text, '我还想顺路看看那家小店。');
  assert.equal(await callCount(), bubbleCalls + 1);
  assert.equal(bubbleRecord.timings.modelCalls, 1);
  assert.match((await latestCall()).prompt, /用空行分成完整语义段/);
  let memory = JSON.parse(await readFile(join(fixture, 'data', 'unified-memory.json'), 'utf8'));
  const bubbleExchange = memory.entries.find(e => e.exchange?.messageId === String(bubbleId)).exchange;
  assert.deepEqual(bubbleExchange.sentMessageIds, [1, 2, 3].map(n => String(10000 + bubbleBefore + n)));
  assert.match(bubbleExchange.replyText, /好啊，先去书店。[\s\S]*我还想顺路看看那家小店。/);

  const oneBefore = sent.length;
  await completed(await quickMessage('单换行完整测试'));
  assert.equal(sent.length, oneBefore + 1);
  assert.equal(sent.at(-1).message[0].data.text, '这两句需要放一起。\n这里仍是同一条。');

  rejectText = '第二段被拒绝。';
  const partialBefore = sent.length, partialCalls = await callCount();
  const partialId = await quickMessage('气泡中途失败测试');
  const partialRecord = await completed(partialId);
  rejectText = null;
  assert.equal(sent.length, partialBefore + 1, 'do not send the third bubble or sticker');
  assert.equal(rejected.length, 1, 'do not retry a rejected continuation');
  assert.equal(await callCount(), partialCalls + 1);
  assert.equal(partialRecord.send.partial, true);
  assert.equal(partialRecord.send.textComplete, false);
  assert.equal(partialRecord.decision.status, '部分已回复');
  assert.equal(partialRecord.reply, '第一段确实送达。');
  memory = JSON.parse(await readFile(join(fixture, 'data', 'unified-memory.json'), 'utf8'));
  const partialExchange = memory.entries.find(e => e.exchange?.messageId === String(partialId)).exchange;
  assert.equal(partialExchange.replyText, '第一段确实送达。');
  assert.deepEqual(partialExchange.sentMessageIds, [String(10001 + partialBefore)]);
  assert.doesNotMatch(JSON.stringify(memory), /第二段被拒绝|第三段不应发送/);

  // A later private question can refer to the image from an earlier batch.
  const firstImageId = await send('[CQ:image,file=recent-private-image]', {
    message: [{ type: 'image', data: { file: 'recent-private-image' } }]
  });
  const imageRecord = await completed(firstImageId);
  assert.equal(imageRecord.timings.modelCalls, 1);
  assert.equal(imageRecord.event.imagePaths.length, 1);
  const imageOnlyCall = await latestCall();
  assert.ok(imageOnlyCall.args.includes('--image'), 'a truthful text description must preserve visual input');
  assert.match(incomingPromptText(imageOnlyCall), /发送了图片或表情，没有附文字/);
  assert.doesNotMatch(incomingPromptText(imageOnlyCall), /只\s*@|叫你/);
  const imageQuestionId = await send('请读出图中文字');
  const imageQuestion = await completed(imageQuestionId);
  assert.equal(imageQuestion.event.reusedRecentImages, true);
  assert.equal(imageQuestion.event.imagePaths.length, 1);
  assert.equal(imageQuestion.timings.modelCalls, 1);
  assert.equal(imageRequests.at(-1), 'recent-private-image');
  const imageCall = JSON.parse((await readFile(join(fixture, 'calls.jsonl'), 'utf8')).trim().split('\n').at(-1));
  assert.ok(imageCall.args.includes('--image'));
  assert.match(imageCall.prompt, /可查看的本地图片数量：1/);

  const quotedQuestionId = await send('请看引用的这张图', {
    message: [{ type: 'reply', data: { id: '901' } },
      { type: 'text', data: { text: '请看引用的这张图' } }]
  });
  const quotedQuestion = await completed(quotedQuestionId);
  assert.equal(Boolean(quotedQuestion.event.reusedRecentImages), false);
  assert.equal(quotedQuestion.event.imagePaths.length, 1);
  assert.equal(imageRequests.at(-1), 'quoted-private-image', 'explicit quotation must win over implicit recent images');
  assert.equal(incomingPromptText(await latestCall()), '请看引用的这张图');

  // Empty text has several distinct meanings; only a real self-mention is a call.
  const mediaPromptCases = [
    { label: 'QQ face', raw: '[CQ:face,id=14]', message: [{ type: 'face', data: { id: '14' } }],
      expected: /发送了QQ表情，没有附文字/ },
    { label: 'QQ mface', raw: '[CQ:mface,emoji_id=fixture-emoji]', message: [{ type: 'mface', data: { emoji_id: 'fixture-emoji' } }],
      expected: /发送了QQ表情，没有附文字/ },
    { label: 'self mention', raw: '[CQ:at,qq=999999]', message: [{ type: 'at', data: { qq: '999999' } }],
      expected: /对方只 @ 了你/, selfMention: true },
    { label: 'other mention', raw: '[CQ:at,qq=654321]', message: [{ type: 'at', data: { qq: '654321' } }],
      expected: /对方没有附文字/ },
    { label: 'empty message', raw: '', message: [], expected: /对方没有附文字/ },
    { label: 'image with caption', raw: '这张图是我刚画的[CQ:image,file=captioned-private-image]',
      message: [{ type: 'text', data: { text: '这张图是我刚画的' } }, { type: 'image', data: { file: 'captioned-private-image' } }],
      expected: /^这张图是我刚画的$/, visual: true },
    { label: 'image with self mention', raw: '[CQ:image,file=mentioned-private-image][CQ:at,qq=999999]',
      message: [{ type: 'image', data: { file: 'mentioned-private-image' } }, { type: 'at', data: { qq: '999999' } }],
      expected: /发送了图片或表情，没有附文字/, visual: true },
    { label: 'quoted image without new image', raw: '[CQ:reply,id=901]', message: [{ type: 'reply', data: { id: '901' } }],
      expected: /对方引用了前面的消息，没有附文字/, visual: true },
    { label: 'quoted image with automatic self mention', raw: '[CQ:reply,id=901][CQ:at,qq=999999]',
      message: [{ type: 'reply', data: { id: '901' } }, { type: 'at', data: { qq: '999999' } }],
      expected: /对方引用了前面的消息，没有附文字/, visual: true }
  ];
  for (const entry of mediaPromptCases) {
    const before = await callCount();
    const messageId = await send(entry.raw, { message: entry.message });
    const record = await completed(messageId);
    assert.equal(record.timings.modelCalls, 1, entry.label);
    assert.equal(await callCount(), before + 1, entry.label);
    const call = await latestCall(), description = incomingPromptText(call);
    assert.match(description, entry.expected, entry.label);
    if (!entry.selfMention) assert.doesNotMatch(description, /只\s*@|叫你/, entry.label);
    assert.equal(call.args.includes('--image'), Boolean(entry.visual), entry.label);
  }
  assert.equal(groupSent.length, 0);
  const finalState = await fetch(url + '/api/state').then(r => r.json());
  assert.equal(finalState.qq.events.some(e => e.event.groupId), false);
  assert.doesNotMatch(await readFile(join(fixture, 'data', 'unified-memory.json'), 'utf8'), /GROUP_IGNORED/);
});
