import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageBatches } from '../src/message-batches.js';
const message = (id, type = 'text', user = 1) => ({ post_type: 'message', message_type: 'private', user_id: user, message_id: id, message: [{ type, data: type === 'text' ? { text: '收到' } : { file: 'sticker.jpg' } }] });
test('default window combines an image and text arriving two seconds apart', async () => {
  const sent = []; const b = new MessageBatches({ deliver: async p => sent.push(p) });
  const first = b.push(message(11, 'image'));
  await new Promise(resolve => setTimeout(resolve, 2000));
  const second = b.push(message(12));
  await Promise.all([first, second]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].batched_message_ids, [11, 12]);
});
test('both text-image orders produce one delivery with both segments', async () => {
  for (const order of [['text', 'image'], ['image', 'text']]) {
    const sent = []; const b = new MessageBatches({ deliver: async p => sent.push(p), delay: 15 });
    await Promise.all([b.push(message(1, order[0])), b.push(message(2, order[1]))]);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].message.filter(s => s.data.text !== '\n').map(s => s.type), order);
    assert.deepEqual(sent[0].batched_message_ids, [1, 2]);
    assert.deepEqual(sent[0].hubBatchMessages.map(item => item.message_id), [1, 2]);
    assert.deepEqual(sent[0].hubBatchMessages.map(item => item.message[0].type), order);
  }
});
test('different users, commands and quoted messages stay separate; retries do not repeat segments', async () => {
  const sent = []; const b = new MessageBatches({ deliver: async p => sent.push(p), delay: 15 });
  await Promise.all([b.push(message(1)), b.push(message(1)), b.push(message(2, 'image', 2))]);
  assert.equal(sent.length, 2); assert.equal(sent[0].message.length, 1);
  assert.equal(sent[0].hubBatchMessages.length, 1);
  const cmd = message(3); cmd.message[0].data.text = '/关机';
  await b.push(cmd); assert.equal(sent.at(-1).message_id, 3);
  const quote = message(4, 'reply'); await b.push(quote);
  assert.equal(sent.at(-1).message_id, 4);
});

test('timing starts at local first receipt and ignores sender-provided timing fields', async () => {
  let now = 1000; const sent = [];
  const b = new MessageBatches({ deliver: async p => sent.push(p), now: () => now });
  const first = b.push({ ...message(1), hubReceivedAt: -99999,
    hubBatchMessages: [{ message_id: 'forged' }], batched_message_ids: ['forged'] });
  now = 1800; const second = b.push(message(2, 'image'));
  now = 2000; b.flush('p:1'); await Promise.all([first, second]);
  assert.equal(sent[0].hubReceivedAt, 1000);
  assert.equal(sent[0].hubBatchCompletedAt, 2000);
  assert.deepEqual(sent[0].hubBatchMessages.map(item => item.message_id), [1, 2]);
});

test('group payloads go directly to the rejection boundary without flushing private batches', async () => {
  const sent = [];
  const b = new MessageBatches({ deliver: async p => sent.push(p), delay: 10000 });
  const first = b.push(message(1));
  for (const message_type of ['group', 'private']) {
    const group = { ...message(2), message_type, group_id: 99 };
    await b.push(group);
    assert.equal(sent.at(-1).message_id, 2);
    assert.equal(sent.at(-1).batched_message_ids, undefined);
    assert.equal(sent.at(-1).hubBatchMessages, undefined);
    assert.equal(b.pending.has('p:1'), true);
    assert.equal(b.pending.size, 1);
  }
  const second = b.push(message(3));
  b.flush('p:1'); await Promise.all([first, second]);
  assert.deepEqual(sent.at(-1).batched_message_ids, [1, 3]);
});

const contact = (epoch, sequence = 1, scope = 'qq:private:1') => ({ scope, epoch, sequence, stop: false, duplicate: false });

test('a stopped epoch cannot lend its old messages to a fresh conversation batch', async () => {
  const delivered = [];
  const batches = new MessageBatches({ delay: 10000, deliver: async (payload, context) => delivered.push({ payload, context }) });
  const beforeStop = batches.push(message(1), { contactToken: contact(0) });
  const afterStop = batches.push(message(2), { contactToken: contact(1, 3) });
  const continuation = batches.push(message(3), { contactToken: contact(1, 4) });
  batches.flush('p:1');
  await Promise.all([beforeStop, afterStop, continuation]);
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered.map(item => item.payload.batched_message_ids), [[1], [2, 3]]);
  assert.deepEqual(delivered.map(item => item.context.contactToken.epoch), [0, 1]);
});

test('contact tokens are trusted out-of-band snapshots and payload lookalikes are removed', async () => {
  const delivered = [];
  const batches = new MessageBatches({ delay: 10000, deliver: async (payload, context) => delivered.push({ payload, context }) });
  const context = { contactToken: contact(2) };
  const first = batches.push({ ...message(1), lifeContactToken: contact(999),
    hubContactToken: contact(999), hubContactContext: { contactToken: contact(999) } }, context);
  context.contactToken.epoch = 999;
  const second = batches.push(message(2, 'image'), { contactToken: contact(2, 2) });
  batches.flush('p:1'); await Promise.all([first, second]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].context.contactToken.epoch, 2);
  assert.equal(delivered[0].payload.lifeContactToken, undefined);
  assert.equal(delivered[0].payload.hubContactToken, undefined);
  assert.equal(delivered[0].payload.hubContactContext, undefined);
  assert.deepEqual(delivered[0].payload.batched_message_ids, [1, 2]);
});

test('missing or different-scope contact metadata never joins a fenced private batch', async () => {
  const delivered = [];
  const batches = new MessageBatches({ delay: 10000, deliver: async (payload, context) => delivered.push({ payload, context }) });
  const pending = [batches.push(message(1), { contactToken: contact(0) }),
    batches.push(message(2)), batches.push(message(3), { contactToken: contact(0, 1, 'qq:private:2') })];
  batches.flush('p:1'); await Promise.all(pending);
  assert.deepEqual(delivered.map(item => item.payload.batched_message_ids), [[1], [2], [3]]);
});
