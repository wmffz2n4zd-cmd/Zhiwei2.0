import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureStickerLeadText, sendTextThenSticker, inReplyOrder } from '../src/sticker-replies.js';
const text = { type: 'text', data: { text: '这也太好笑了。' } };
const picture = { type: 'image', data: { file: 'file:///test/laugh.jpg' } };
const quote = { type: 'reply', data: { id: '123' } };

test('text is acknowledged before one sticker; quotations stay with text', async () => {
  const sent = []; let release;
  const done = sendTextThenSticker([quote, text, picture, picture], async message => {
    sent.push(message);
    if (sent.length === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, body: { id: sent.length } };
  });
  await Promise.resolve();
  assert.deepEqual(sent, [[quote, text]]);
  release(); const result = await done;
  assert.deepEqual(sent, [[quote, text], [picture]]);
  assert.equal(result.ok, true); assert.equal(result.stickerSent, true);
});

test('failed text never sends a sticker and image failure does not retry delivered text', async () => {
  let calls = 0;
  const failed = await sendTextThenSticker([text, picture], async () => { calls++; return { ok: false }; });
  assert.equal(calls, 1); assert.equal(failed.ok, false);
  calls = 0;
  const partial = await sendTextThenSticker([text, picture], async () => {
    if (++calls === 2) throw Error('network'); return { ok: true };
  });
  assert.equal(calls, 2); assert.equal(partial.ok, true);
  assert.equal(partial.partial, true); assert.equal(partial.stickerSent, false);
});

test('sticker-only model output gets a short lead without changing normal wording', () => {
  const marker = '[[qq_sticker:笑死.jpg]]';
  assert.equal(ensureStickerLeadText('我也笑了。\n' + marker), '我也笑了。\n' + marker);
  assert.match(ensureStickerLeadText(marker), /^我真的绷不住了。\n/);
  assert.equal(ensureStickerLeadText('普通回答'), '普通回答');
});

test('sender blocks unaccompanied images; text-only responses use a single send', async () => {
  let calls = 0;
  assert.equal((await sendTextThenSticker([quote, picture], async () => { calls++; })).ok, false);
  assert.equal(calls, 0);
  const result = await sendTextThenSticker([text], async message => { calls++; assert.deepEqual(message, [text]); return { ok: true }; });
  assert.equal(calls, 1); assert.equal(result.ok, true);
});

test('reply pairs stay adjacent per recipient, while other chats proceed and failures release the queue', async () => {
  const events = []; let release;
  const first = inReplyOrder('private:a', async () => {
    events.push('a:text'); await new Promise(r => { release = r; }); events.push('a:image');
  });
  const second = inReplyOrder('private:a', async () => { events.push('a:next'); });
  await inReplyOrder('private:b', async () => { events.push('b:text'); });
  assert.deepEqual(events, ['a:text', 'b:text']);
  release(); await Promise.all([first, second]);
  assert.deepEqual(events, ['a:text', 'b:text', 'a:image', 'a:next']);
  await assert.rejects(inReplyOrder('private:a', async () => { throw Error('failed'); }));
  assert.equal(await inReplyOrder('private:a', async () => 'ready'), 'ready');
});

const textOf = value => ({ type: 'text', data: { text: value } });
const plainText = message => message.filter(segment => segment.type === 'text').map(segment => segment.data.text).join('');

test('natural parts wait for acknowledgments, keep the quote first and the sticker last', async () => {
  const sent = []; let release;
  const reply = textOf('原来已经弄好了。\n\n那今晚总算能歇会儿了。');
  const done = sendTextThenSticker([quote, reply, picture, picture], async message => {
    sent.push(message);
    if (sent.length === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, body: { data: { message_id: sent.length } } };
  }, { splitText: true });
  await Promise.resolve();
  assert.deepEqual(sent, [[quote, textOf('原来已经弄好了。')]]);
  release();
  const result = await done;
  assert.deepEqual(sent, [[quote, textOf('原来已经弄好了。')], [textOf('那今晚总算能歇会儿了。')], [picture]]);
  assert.equal(result.textComplete, true);
  assert.equal(result.deliveredText, reply.data.text);
  assert.equal(result.stickerSent, true);
  assert.equal(result.parts.length, 3);
});

test('natural splitting is optional, keeps single newlines and protects structured replies', async () => {
  for (const value of ['好。', '第一句。第二句。', '第一行\n第二行',
    '这段照抄就行。\n\n```js\nconst n = 1;\n\nconsole.log(n);\n```',
    '买这些：\n\n- 牛奶\n\n- 面包', '步骤：\n\n1. 先保存\n\n2. 再关闭',
    '步骤：\n\n一、先保存\n\n二、再关闭', '记录：\n\n|名字|数量|\n|杯子|2|']) {
    const message = [textOf(value)], sent = [];
    const result = await sendTextThenSticker(message, async part => { sent.push(part); return { ok: true }; }, { splitText: true });
    assert.deepEqual(sent, [message], value);
    assert.equal(result.deliveredText, value);
    assert.equal(result.textComplete, true);
  }
  const message = [textOf('菜单首段\n\n菜单次段')], sent = [];
  await sendTextThenSticker(message, async part => { sent.push(part); return { ok: true }; });
  assert.deepEqual(sent, [message], 'default callers retain their existing one-message contract');
});

test('natural parts ignore empty boundaries and merge excess paragraphs without losing content', async () => {
  const sent = [];
  const result = await sendTextThenSticker([textOf('\r\n\r\n甲\r\n \r\n\r\n乙\r\n\r\n丙\r\n\r\n丁\r\n\r\n戊\r\n')],
    async part => { sent.push(plainText(part)); return { ok: true }; }, { splitText: true });
  assert.deepEqual(sent, ['甲', '乙', '丙\n\n丁\n\n戊']);
  assert.equal(result.deliveredText, '甲\n\n乙\n\n丙\n\n丁\n\n戊');
  assert.equal(result.textComplete, true);
});

test('failed first natural part reports no delivered text and stops before later text or sticker', async () => {
  for (const throws of [false, true]) {
    const sent = [];
    const result = await sendTextThenSticker([textOf('第一段。\n\n第二段。'), picture], async part => {
      sent.push(part);
      if (throws) throw Error('network');
      return { ok: false, reason: 'contact-epoch-superseded' };
    }, { splitText: true });
    assert.equal(sent.length, 1);
    assert.equal(result.ok, false);
    assert.equal(result.deliveredText, '');
    assert.equal(result.textComplete, false);
    assert.equal(result.parts.length, 1);
  }
});

test('failed later natural part preserves only acknowledged text and never sends the remainder', async () => {
  for (const throws of [false, true]) {
    const sent = [];
    const result = await sendTextThenSticker([textOf('已送达。\n\n没有确认送达。\n\n不能追发。'), picture], async part => {
      sent.push(plainText(part));
      if (sent.length === 1) return { ok: true, body: { data: { message_id: 101 } } };
      if (throws) throw Error('connection lost');
      return { ok: false, reason: 'life-choice-replaced' };
    }, { splitText: true });
    assert.deepEqual(sent, ['已送达。', '没有确认送达。']);
    assert.equal(result.ok, true, 'do not retry an already delivered prefix');
    assert.equal(result.partial, true);
    assert.equal(result.deliveredText, '已送达。');
    assert.equal(result.textComplete, false);
    assert.equal(result.stickerSent, false);
    assert.equal(result.parts.length, 2);
  }
});

test('sticker failure after natural parts retains the complete delivered text', async () => {
  let calls = 0;
  const result = await sendTextThenSticker([textOf('第一段。\n\n第二段。'), picture], async () => {
    if (++calls === 3) throw Error('image unavailable');
    return { ok: true };
  }, { splitText: true });
  assert.equal(calls, 3);
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.textComplete, true);
  assert.equal(result.deliveredText, '第一段。\n\n第二段。');
  assert.equal(result.stickerSent, false);
});

test('whole natural reply stays in the recipient queue while other recipients proceed', async () => {
  const events = []; let release;
  const first = inReplyOrder('natural:a', () => sendTextThenSticker([textOf('甲\n\n乙'), picture], async message => {
    const value = plainText(message) || 'image';
    events.push(`a:${value}`);
    if (value === '甲') await new Promise(resolve => { release = resolve; });
    return { ok: true };
  }, { splitText: true }));
  const next = inReplyOrder('natural:a', async () => { events.push('a:next'); });
  await inReplyOrder('natural:b', async () => { events.push('b:reply'); });
  assert.deepEqual(events, ['a:甲', 'b:reply']);
  release(); await Promise.all([first, next]);
  assert.deepEqual(events, ['a:甲', 'b:reply', 'a:乙', 'a:image', 'a:next']);
});
