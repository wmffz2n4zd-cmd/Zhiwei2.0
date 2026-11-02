import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createUnifiedMemory } from '../src/unified-memory/index.js';

const day = 86400000;
const origin = Date.parse('2026-10-28T06:00:00Z');
const scope = 'qq:private:alice', otherScope = 'qq:private:bob';

async function fixture(t) {
  const root = resolve('runtime/tests');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'private-memory-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const memoryPath = join(dir, 'memory.json'); let time = origin;
  const memory = () => createUnifiedMemory({ memoryPath, now: () => time });
  return { dir, memoryPath, memory: memory(), reload: memory, setTime: value => { time = value; }, advance: value => { time += value; } };
}

test('private exchange preserves both tails, quote and numbered correction through reload and old recall', async t => {
  const f = await fixture(t);
  const userText = '背景情况需要逐步核查。'.repeat(100) + '\n第一方案是周三出发。第二方案不是周四，是周五乘火车。';
  const replyText = '我把这些背景放在一起理解。'.repeat(90) + '\n更正：第二方案对应周五火车，不能订周四的航班。';
  const saved = await f.memory.writeExchange({ scope, senderLabel: 'Alice', userText, replyText,
    quotedText: '之前的第二方案只是草稿。', messageId: 'm-1', replyMessageId: 'quoted-1' });
  assert.equal(saved.ok, true);
  assert.equal(saved.entry.exchange.userText, userText);
  assert.equal(saved.entry.exchange.replyText, replyText);
  assert.equal(saved.entry.exchange.truncated, false);
  f.advance(230 * day);
  const before = await readFile(f.memoryPath, 'utf8');
  const recall = await f.reload().recall({ scope, query: '第二方案应该订哪天火车' });
  assert.match(recall.context, /第二方案不是周四，是周五乘火车/);
  assert.match(recall.context, /不能订周四的航班/);
  assert.match(recall.context, new RegExp(saved.entry.id));
  assert.ok(recall.context.length <= 6000);
  assert.equal(await readFile(f.memoryPath, 'utf8'), before, 'reading must not migrate or rewrite data');
});

test('relevance retains old facts against unrelated recent entries and excludes another person', async t => {
  const f = await fixture(t);
  f.setTime(origin - 400 * day);
  const saved = await f.memory.write({ scope, summary: '天文摄影需要赤道仪，镜头口径为85毫米。' });
  await f.memory.write({ scope: otherScope, summary: '天文摄影的私密密码是BOB_PRIVATE。' });
  f.setTime(origin);
  for (let i = 0; i < 35; i++) await f.memory.writeExchange({ scope, userText: `早餐是面包编号${i}。`, replyText: '配牛奶很合适。' });
  const recall = await f.memory.recall({ scope, query: '天文摄影的镜头口径' });
  assert.equal(recall.entries.length, 1);
  assert.equal(recall.entries[0].id, saved.entry.id);
  assert.match(recall.context, /85毫米/);
  assert.doesNotMatch(recall.context, /面包|BOB_PRIVATE/);
});

test('demonstratives in a new topic do not fill the prompt with long unrelated recent exchanges', async t => {
  const f = await fixture(t);
  f.setTime(origin - 400 * day);
  await f.memory.write({ scope, summary: '火星计划的最终发射口令为ORBIT_SECRET，必须保留此事实。' });
  f.setTime(origin);
  for (let i = 0; i < 3; i++) await f.memory.writeExchange({ scope, userText: '晚饭吃面条。'.repeat(180), replyText: `配蔬菜第${i}次。` });
  const topical = await f.memory.recall({ scope, query: '这个火星计划口令是什么' });
  assert.match(topical.context, /ORBIT_SECRET/);
  assert.doesNotMatch(topical.context, /晚饭/);
  assert.equal((await f.memory.recall({ scope, query: '这个寿司该怎么吃' })).context, '');
});

test('overlapping Chinese pairs and whole English words avoid boundary misses and substring matches', async t => {
  const f = await fixture(t);
  await f.memory.write({ scope, summary: '我在练习古琴曲《流水》。' });
  await f.memory.write({ scope, summary: 'The cart is in the garden.' });
  assert.match((await f.memory.recall({ scope, query: '琴曲' })).context, /流水/);
  assert.equal((await f.memory.recall({ scope, query: 'art' })).context, '');
  assert.match((await f.memory.recall({ scope, query: 'garden' })).context, /cart/);
});

test('model recall can be empty while management listing and full active count remain available', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 36; i++) await f.memory.write({ scope, summary: `星图编号${i}记录。` });
  assert.equal((await f.memory.read({ scope, limit: 100 })).entries.length, 30);
  assert.equal((await f.memory.status({ scope })).active, 36);
  for (const query of ['', '你好', '谢谢', 'what is this please', '没有任何匹配的陶瓷器具']) {
    assert.equal((await f.memory.recall({ scope, query })).context, '', query);
  }
  assert.equal(await f.memory.formatForPrompt({ scope }), '');
  assert.equal((await f.memory.read({ scope, query: '不存在的咖啡杯' })).entries.length, 0);
});

test('bare recent followup preserves three exchange relationships and expansion adds actual older sources', async t => {
  const f = await fixture(t), ids = [];
  for (let i = 0; i < 12; i++) {
    f.advance(60000);
    const saved = await f.memory.writeExchange({ scope, userText: `第${i}轮独立备忘。`, replyText: i === 2 ? '前文原始原因是EARLIER_FACT。' : `回应编号${i}。` });
    ids.push(saved.entry.id);
  }
  await f.memory.writeExchange({ scope: otherScope, userText: '刚才是BOB_PRIVATE。', replyText: '保密。' });
  const first = await f.memory.recall({ scope, query: '刚才那个为什么？' });
  assert.equal(first.entries.length, 3);
  assert.doesNotMatch(first.context, /EARLIER_FACT|BOB_PRIVATE/);
  const second = await f.memory.recall({ scope, query: '刚才那个为什么？', expanded: true, previous: first });
  assert.equal(second.entries.length, 12);
  assert.equal(second.hasNewEvidence, true);
  assert.match(second.context, /EARLIER_FACT/);
  assert.match(second.context, new RegExp(ids[2]));
  assert.doesNotMatch(second.context, /BOB_PRIVATE/);
  const repeat = await f.memory.recall({ scope, query: '刚才那个为什么？', expanded: true, previous: second });
  assert.equal(repeat.hasNewEvidence, false);
  f.advance(3 * 60 * 60 * 1000);
  assert.equal((await f.memory.recall({ scope, query: '刚才那个为什么？' })).context, '');
});

test('second option pointer retains the proposal and response instead of isolated keywords', async t => {
  const f = await fixture(t);
  await f.memory.writeExchange({ scope, userText: '第一方案先买相机，第二方案先租相机。', replyText: '第二方案花钱更少，适合试过再决定。' });
  const recalled = await f.memory.recall({ scope, query: '第二个方案有什么区别？' });
  assert.match(recalled.context, /第一方案先买相机，第二方案先租相机/);
  assert.match(recalled.context, /第二方案花钱更少/);
});

test('explicit expansion crosses the initial two-hour window for a next-day followup', async t => {
  const f = await fixture(t);
  const saved = await f.memory.writeExchange({ scope, userText: '昨晚约定的细节是NEXT_DAY_SOURCE。', replyText: '保留这一段原始约定。' });
  await f.memory.writeExchange({ scope: otherScope, userText: 'BOB_NEXT_DAY_PRIVATE', replyText: '其他人的约定。' });
  f.advance(3 * day);
  const first = await f.memory.recall({ scope, query: '继续上次那个' });
  assert.equal(first.context, '');
  const expanded = await f.memory.recall({ scope, query: '继续上次那个', expanded: true, previous: first });
  assert.equal(expanded.hasNewEvidence, true);
  assert.match(expanded.context, /NEXT_DAY_SOURCE/);
  assert.match(expanded.context, new RegExp(saved.entry.id));
  assert.doesNotMatch(expanded.context, /BOB_NEXT_DAY_PRIVATE/);
});

test('explicit message reference finds an old source without exposing another scope', async t => {
  const f = await fixture(t);
  f.setTime(origin - 80 * day);
  const saved = await f.memory.writeExchange({ scope, messageId: 'original-quote', userText: '展览约在东门。', replyText: '东门碰面。' });
  await f.memory.writeExchange({ scope: otherScope, messageId: 'original-quote', userText: 'BOB_PRIVATE', replyText: '其他人的约定。' });
  f.setTime(origin);
  const recalled = await f.memory.recall({ scope, query: '哪里？', replyMessageId: 'original-quote' });
  assert.equal(recalled.entries[0].id, saved.entry.id);
  assert.match(recalled.context, /东门/);
  assert.doesNotMatch(recalled.context, /BOB_PRIVATE/);
});

test('delivered reply ids survive reload and prove only the matching private destination', async t => {
  const f = await fixture(t);
  await f.memory.writeExchange({ scope, messageId: 'user-msg-1', replyMessageId: 'unverified-quoted-id',
    sentMessageIds: ['delivered-1', 'delivered-2'], userText: '约在哪里？', replyText: '在东门等你。' });
  const restarted = f.reload();
  assert.equal(await restarted.hasDeliveredMessage({ scope, messageId: 'delivered-1' }), true);
  assert.equal(await restarted.hasDeliveredMessage({ scope, messageId: 'delivered-2' }), true);
  assert.equal(await restarted.hasDeliveredMessage({ scope: otherScope, messageId: 'delivered-1' }), false);
  assert.equal(await restarted.hasDeliveredMessage({ scope, messageId: 'user-msg-1' }), false);
  assert.equal(await restarted.hasDeliveredMessage({ scope, messageId: 'unverified-quoted-id' }), false);
  assert.equal(await restarted.hasDeliveredMessage({ scope, messageId: 'unknown' }), false);
  assert.equal(await restarted.hasDeliveredMessage({ scope: 'qq:group:123', messageId: 'delivered-1' }), false);
  const recalled = await restarted.recall({ scope, query: '哪里？', replyMessageId: 'delivered-2' });
  assert.match(recalled.context, /东门/);
  assert.doesNotMatch(recalled.context, /delivered-1|delivered-2|unverified-quoted-id/);
  assert.equal((await f.memory.writeExchange({ scope, replyText: '不会保存。', sentMessageIds: ['', 'valid'] })).ok, false);
  assert.equal((await f.memory.writeExchange({ scope, replyText: '不会保存。', sentMessageIds: Array(9).fill('many') })).ok, false);
});

test('expanded excerpts of the same source count only sentences actually injected as new evidence', async t => {
  const f = await fixture(t);
  const summary = Array.from({ length: 60 }, (_, i) => `星图资料第${i}项的背景说明：${'需要继续核对观测记录'.repeat(6)}。`).join('\n');
  await f.memory.write({ scope, summary });
  const first = await f.memory.recall({ scope, query: '星图资料' });
  const second = await f.memory.recall({ scope, query: '星图资料', expanded: true, previous: first });
  assert.equal(first.entries.length, 1); assert.equal(second.entries.length, 1);
  assert.ok(second.context.length > first.context.length);
  assert.equal(second.hasNewEvidence, true);
  assert.ok(second.evidenceKeys.some(key => !first.evidenceKeys.includes(key)));
  assert.equal((await f.memory.recall({ scope, query: '星图资料', expanded: true, previous: second })).hasNewEvidence, false);
  assert.ok(first.context.length <= 6000 && second.context.length <= 12000);
});

test('a matching tail correction survives many equally matching earlier sentences', async t => {
  const f = await fixture(t);
  await f.memory.write({ scope, summary: '预约时间的背景说明很长。'.repeat(400) + '更正：预约时间不是周三，是周五。' });
  const recall = await f.memory.recall({ scope, query: '预约时间' });
  assert.match(recall.context, /更正：预约时间不是周三，是周五。/);
  assert.ok(recall.context.length <= 6000);
});

test('explicit expiry and supersession remain scoped and never resurrect an older claim', async t => {
  const f = await fixture(t);
  const old = await f.memory.write({ scope, summary: '预约时间为周三。' });
  const bob = await f.memory.write({ scope: otherScope, summary: '预约时间为周二。' });
  const before = await readFile(f.memoryPath, 'utf8');
  await assert.rejects(f.memory.write({ scope, summary: '越界替代。', supersedes: [bob.entry.id] }), /same scope/);
  assert.equal(await readFile(f.memoryPath, 'utf8'), before);
  await f.memory.write({ scope, summary: '更正：预约不是周三，是周五。', supersedes: [old.entry.id], validUntil: new Date(origin + day).toISOString() });
  const current = await f.memory.recall({ scope, query: '预约时间' });
  assert.equal(current.entries.length, 1);
  assert.match(current.context, /不是周三，是周五/);
  f.advance(2 * day);
  assert.equal((await f.memory.recall({ scope, query: '预约时间' })).context, '');
  assert.equal((await f.memory.status({ scope })).count, 2);
  assert.equal((await f.memory.status({ scope })).active, 0);
  assert.equal((await f.memory.read({ scope: otherScope })).entries.length, 1);
});

test('legacy format is read without mutation and restoring a backup recovers its exact data', async t => {
  const f = await fixture(t);
  const legacy = JSON.stringify({ version: 1, entries: [{ id: 'legacy-entry', scope, type: 'preference', source: 'manual',
    at: new Date(origin - 500 * day).toISOString(), summary: '早年的偏好是无糖咖啡。', nextActions: [] }] });
  await writeFile(f.memoryPath, legacy);
  const backup = join(f.dir, 'backup.json'); await copyFile(f.memoryPath, backup);
  assert.match(await f.memory.formatForPrompt({ scope, query: '无糖咖啡' }), /无糖咖啡/);
  assert.equal(await readFile(f.memoryPath, 'utf8'), legacy);
  await f.memory.writeExchange({ scope, userText: '新增普通私聊。', replyText: '保存完成。' });
  await copyFile(backup, f.memoryPath);
  assert.equal(await readFile(f.memoryPath, 'utf8'), legacy);
  assert.equal((await f.reload().read({ scope })).entries.length, 1);
  await writeFile(f.memoryPath, '{"version":99,"entries":[]}');
  await assert.rejects(f.reload().recall({ scope, query: '咖啡' }), /Unsupported/);
  assert.equal(await readFile(f.memoryPath, 'utf8'), '{"version":99,"entries":[]}');
});

test('private write rejects missing or group scope; runtime mood state stays hidden and compare-and-set remains atomic', async t => {
  const f = await fixture(t);
  for (const badScope of ['', 'owner', 'qq:private:', 'qq:private:undefined', 'qq:group:123']) {
    assert.equal((await f.memory.writeExchange({ scope: badScope, userText: '内容。', replyText: '回应。' })).ok, false);
  }
  const saved = await f.memory.compareAndSetState({ scope, source: 'qq-mood', topic: 'mood:alice', summary: 'HIDDEN_MOOD' });
  assert.equal(saved.ok, true);
  const results = await Promise.all([f.memory, f.reload()].map(memory => memory.compareAndSetState({ scope, source: 'qq-mood', topic: 'mood:alice', expectedId: saved.entry.id, summary: 'NEW_HIDDEN_MOOD' })));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal((await f.memory.recall({ scope, query: 'HIDDEN_MOOD' })).context, '');
  assert.equal((await f.memory.read({ scope })).entries.length, 0);
  assert.equal((await f.memory.status({ scope })).active, 0);
  await f.memory.write({ scope: 'qq:group:123', summary: '历史群内容。' });
  assert.equal((await f.memory.recall({ scope: 'qq:group:123', query: '历史群内容' })).context, '');
});

test('retention bounds mark omissions and never silently save half a negation sentence', async t => {
  const f = await fixture(t);
  const userText = '这是已保留的完整句。'.repeat(700) + '最后的不是周四而是周五。'.repeat(200);
  const saved = await f.memory.writeExchange({ scope, userText, replyText: '我记下已提供的部分。' });
  assert.equal(saved.ok, true);
  assert.equal(saved.entry.exchange.truncated, true);
  assert.ok(saved.entry.exchange.userText.length <= 8000);
  assert.match(saved.entry.exchange.userText, /。$/);
  assert.equal(saved.entry.exchange.originalLengths.userText, userText.length);
  const recall = await f.memory.recall({ scope, query: '已保留的完整句' });
  assert.match(recall.context, /超出上限的内容未保留/);
});

test('candidate and context bounds apply to complete sources, not raw selected-but-omitted entries', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 28; i++) await f.memory.write({ scope, summary: `古琴记录第${i}项。` });
  const first = await f.memory.recall({ scope, query: '古琴', limit: 100 });
  const second = await f.memory.recall({ scope, query: '古琴', limit: 100, expanded: true, previous: first });
  assert.equal(first.entries.length, 8); assert.equal(second.entries.length, 20);
  assert.equal(second.hasNewEvidence, true);
  const long = await f.memory.write({ scope: otherScope, summary: '不存在句界但含有古琴' + '长'.repeat(13000) });
  assert.equal(long.ok, true);
  const omitted = await f.memory.recall({ scope: otherScope, query: '古琴', expanded: true });
  assert.deepEqual(omitted.entries, []); assert.deepEqual(omitted.evidenceKeys, []);
  assert.equal(omitted.hasNewEvidence, false); assert.equal(omitted.context, '');
});

test('opted-in short replies and new topics retain the latest three private turns in stable chronological order', async t => {
  const f = await fixture(t), ids = [];
  // Identical timestamps still have a stable insertion order, including after reload.
  for (const [userText, replyText] of [['更早的开场。', '第一轮旧回答。'], ['刚走到门口。', '外面有点冷。'],
    ['围巾已经戴好了。', '那就放心走吧。'], ['我又折回来拿伞。', '今天这雨确实说不准。']]) {
    ids.push((await f.memory.writeExchange({ scope, userText, replyText })).entry.id);
  }
  await f.memory.writeExchange({ scope: otherScope, userText: 'BOB_RECENT_PRIVATE。', replyText: '别人的回复。' });
  const before = await readFile(f.memoryPath, 'utf8');
  for (const query of ['嗯', '哈哈', '怎么煮一碗番茄汤']) {
    const recalled = await f.reload().recall({ scope, query, includeRecent: true });
    assert.deepEqual(recalled.entries.map(entry => entry.id), ids.slice(-3));
    assert.ok(recalled.entries.every(entry => entry.reason === 'recent'));
    assert.match(recalled.context, /刚走到门口[\s\S]*外面有点冷[\s\S]*围巾已经戴好了[\s\S]*今天这雨确实说不准/);
    assert.match(recalled.context, /当前消息优先，不要求继续旧话题/);
    assert.doesNotMatch(recalled.context, /第一轮旧回答|BOB_RECENT_PRIVATE/);
    assert.ok(recalled.context.length <= 6000);
  }
  assert.equal(await readFile(f.memoryPath, 'utf8'), before, 'recall remains read-only');
  assert.equal((await f.memory.recall({ scope, query: '嗯' })).context, '', 'default callers retain their old contract');
  assert.equal((await f.memory.recall({ scope, query: '嗯', includeRecent: false })).context, '');
  await f.memory.write({ scope: 'owner', source: 'qq', summary: 'OWNER_RECENT。' });
  assert.equal((await f.memory.recall({ scope: 'owner', query: '嗯', includeRecent: true })).context, '');
  await f.memory.clear({ scope });
  assert.equal((await f.reload().recall({ scope, query: '哈哈', includeRecent: true })).context, '', 'clear cannot be undone by a cache');
});

test('recent dialogue has protected slots and a bounded background pool beside noisy old relevant sources', async t => {
  const f = await fixture(t);
  f.setTime(origin - 100 * day);
  for (let i = 0; i < 12; i++) await f.memory.write({ scope,
    summary: `望远镜资料编号${i}。` + '望远镜背景说明需要核查。'.repeat(200) });
  const old = await f.memory.write({ scope, summary: '望远镜镜头口径为85毫米，观测参数必须保留。' });
  f.setTime(origin);
  const recentIds = [];
  for (let i = 0; i < 3; i++) recentIds.push((await f.memory.writeExchange({ scope,
    userText: `今天第${i}次出门买面包。`, replyText: `回来记得把第${i}把伞放门口。` })).entry.id);
  const recalled = await f.memory.recall({ scope, query: '望远镜镜头口径观测参数', includeRecent: true });
  assert.match(recalled.context, /85毫米/);
  assert.ok(recalled.entries.some(entry => entry.id === old.entry.id));
  assert.deepEqual(recalled.entries.filter(entry => entry.reason === 'recent').map(entry => entry.id), recentIds);
  assert.ok(recalled.entries.length <= 8 && recalled.context.length <= 6000);
  assert.ok(recalled.context.slice(recalled.context.indexOf('近期同对象对话')).length <= 1800);
  assert.equal(new Set(recalled.entries.map(entry => entry.id)).size, recalled.entries.length);
});

test('recent long turns retain complete question and response tails without a topic match', async t => {
  const f = await fixture(t);
  await f.memory.writeExchange({ scope,
    userText: '路上只是一些无关紧要的背景。'.repeat(200) + '更正：钥匙不是放在门口，是装进蓝色袋子了。',
    replyText: '这些路上的事情我听到了。'.repeat(180) + '那就找蓝色袋子，不用再翻门口。' });
  const recalled = await f.memory.recall({ scope, query: '嗯', includeRecent: true });
  assert.match(recalled.context, /用户\[userText:[\d-]+\]：[^\n]*钥匙不是放在门口，是装进蓝色袋子了。/);
  assert.match(recalled.context, /知微\[replyText:[\d-]+\]：[^\n]*那就找蓝色袋子，不用再翻门口。/);
  assert.match(recalled.context, /省略处不代表没有其他内容/);
  assert.ok(recalled.context.length <= 6000);
});

test('a recent matching source keeps its tail correction once, instead of being consumed as short background', async t => {
  const f = await fixture(t);
  const saved = await f.memory.writeExchange({ scope, messageId: 'recent-source', sentMessageIds: ['recent-delivered'],
    userText: '预约时间的背景说明需要核查。'.repeat(220) + '更正：预约时间不是周三，是周五。',
    replyText: '我会按照周五的预约时间来理解。' });
  await f.memory.writeExchange({ scope, userText: '我先去买杯饮料。', replyText: '回来再聊。' });
  for (const replyMessageId of [undefined, 'recent-delivered']) {
    const recalled = await f.memory.recall({ scope, query: '预约时间', replyMessageId, includeRecent: true });
    assert.match(recalled.context, /更正：预约时间不是周三，是周五。/);
    assert.match(recalled.context, /知微\[replyText:[\d-]+\]：我会按照周五的预约时间来理解。/);
    assert.equal(recalled.entries.filter(entry => entry.id === saved.entry.id).length, 1);
    assert.equal(new Set(recalled.evidenceKeys).size, recalled.evidenceKeys.length);
    assert.ok(recalled.context.length <= 6000);
  }
});

test('explicit long reference can take priority over optional recent background without cutting a sentence', async t => {
  const f = await fixture(t);
  f.setTime(origin - 20 * day);
  const full = '引用的完整约定是' + '长'.repeat(4750) + '，不是取消约定。';
  await f.memory.writeExchange({ scope, messageId: 'long-reference', userText: full, replyText: '我看到完整约定了。' });
  f.setTime(origin);
  await f.memory.writeExchange({ scope, userText: '我去买杯饮料。', replyText: '回来再聊。' });
  const recalled = await f.memory.recall({ scope, query: '嗯', replyMessageId: 'long-reference', includeRecent: true });
  assert.ok(recalled.context.includes(full));
  assert.equal(recalled.entries[0].reason, 'reference');
  assert.ok(recalled.context.length <= 6000);
});

test('the best old relevant complete sentence is not lost solely to the recent background reservation', async t => {
  const f = await fixture(t);
  f.setTime(origin - 40 * day);
  const full = '天文镜头的原始参数是' + '长'.repeat(4500) + '，最终口径不是80毫米而是85毫米。';
  await f.memory.write({ scope, summary: full });
  f.setTime(origin);
  await f.memory.writeExchange({ scope, userText: '我在买一杯饮料。', replyText: '回来慢慢说。' });
  const recalled = await f.memory.recall({ scope, query: '天文镜头参数口径', includeRecent: true });
  assert.ok(recalled.context.includes(full));
  assert.ok(recalled.context.length <= 6000);
});

test('recent matches and background share one chronological section without repeating a source', async t => {
  const f = await fixture(t), ids = [];
  for (const [userText, replyText] of [['咖啡先放桌上。', '第一轮先晾着。'], ['我去把窗户关上。', '第二轮回来就能喝。'],
    ['咖啡现在不烫了。', '第三轮温度正合适。']]) {
    ids.push((await f.memory.writeExchange({ scope, userText, replyText })).entry.id);
  }
  const recalled = await f.memory.recall({ scope, query: '咖啡', includeRecent: true });
  assert.deepEqual(recalled.entries.map(entry => entry.id), ids);
  assert.match(recalled.context, /第一轮先晾着[\s\S]*第二轮回来就能喝[\s\S]*第三轮温度正合适/);
  assert.equal(recalled.context.split('近期同对象对话').length - 1, 1);
  assert.match(recalled.context, /与本次话题相关的近期原文/);
  assert.match(recalled.context, /近期互动背景/);
  assert.equal(new Set(recalled.evidenceKeys).size, recalled.evidenceKeys.length);
});

test('unrelated recent negation noise cannot outrank the actual matching fact', async t => {
  const f = await fixture(t);
  await f.memory.writeExchange({ scope,
    userText: '不要把饭盒放在窗台上，这不是今天要讨论的事情。'.repeat(180) + '天文镜头的口径是85毫米。',
    replyText: '我记下天文镜头的参数了。' });
  const recalled = await f.memory.recall({ scope, query: '天文镜头口径', includeRecent: true });
  assert.match(recalled.context, /天文镜头的口径是85毫米。/);
  assert.match(recalled.context, /我记下天文镜头的参数了。/);
  assert.ok(recalled.context.length <= 6000);
});

test('opted-in recency respects the two-hour boundary and active scoped source filtering', async t => {
  const f = await fixture(t);
  const boundary = await f.memory.writeExchange({ scope, userText: '两小时前的边界对话。', replyText: '边界仍有效。' });
  f.advance(2 * 60 * 60 * 1000);
  assert.ok((await f.memory.recall({ scope, query: '嗯', includeRecent: true })).entries.some(entry => entry.id === boundary.entry.id));
  f.advance(1);
  assert.equal((await f.memory.recall({ scope, query: '嗯', includeRecent: true })).context, '');
  const expired = await f.memory.write({ scope, source: 'qq', summary: 'EXPIRED_RECENT。', validUntil: new Date(origin).toISOString() });
  const old = await f.memory.write({ scope, source: 'qq', summary: 'SUPERSEDED_RECENT。' });
  await f.memory.write({ scope, summary: '最新有效替代。', supersedes: [old.entry.id] });
  await f.memory.compareAndSetState({ scope, source: 'qq-mood', topic: 'mood:alice', summary: 'HIDDEN_RECENT。' });
  await f.memory.writeExchange({ scope: otherScope, userText: 'OTHER_RECENT。', replyText: '其他人。' });
  f.advance(60000);
  await f.memory.writeExchange({ scope, userText: 'FUTURE_RECENT。', replyText: '未来信息。' });
  f.advance(-60000);
  const recalled = await f.memory.recall({ scope, query: '嗯', includeRecent: true });
  assert.equal(recalled.context, '');
  assert.ok(expired.ok);
  assert.equal((await f.memory.recall({ scope: 'qq:group:123', query: '嗯', includeRecent: true })).context, '');
});

test('opted-in expansion adds only actual evidence and a repeat or reordering is not new evidence', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 9; i++) {
    f.advance(60000);
    await f.memory.writeExchange({ scope, userText: `当前是第${i}轮出门的事情。`, replyText: `我记得第${i}轮这件事。` });
  }
  const first = await f.memory.recall({ scope, query: '嗯', includeRecent: true });
  assert.equal(first.entries.length, 3);
  const expanded = await f.memory.recall({ scope, query: '嗯', includeRecent: true, expanded: true, previous: first });
  assert.equal(expanded.entries.length, 9);
  assert.equal(expanded.hasNewEvidence, true);
  assert.ok(expanded.context.length <= 12000);
  const repeated = await f.reload().recall({ scope, query: '嗯', includeRecent: true, expanded: true, previous: expanded });
  assert.equal(repeated.hasNewEvidence, false);
  const normalAgain = await f.memory.recall({ scope, query: '嗯', includeRecent: true, previous: expanded });
  assert.equal(normalAgain.hasNewEvidence, false);
});
