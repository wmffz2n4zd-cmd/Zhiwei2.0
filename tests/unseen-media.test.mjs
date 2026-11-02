import test from 'node:test';
import assert from 'node:assert/strict';
import { unseenMediaDecision, hasUnseenMedia } from '../src/unseen-media.js';
test('unseen stickers cannot trigger invented visual responses', () => {
  for (const type of ['image', 'face', 'mface', 'video']) {
    const event = { text: `[CQ:${type},file=sample.gif]`, raw: { message: [{ type, data: { file: 'sample.gif' } }] } };
    assert.equal(hasUnseenMedia(event), true);
    assert.equal(unseenMediaDecision(event, false).ok, false);
    assert.match(unseenMediaDecision(event, true).reply, /看不到/);
  }
  assert.equal(unseenMediaDecision({text:'你好'}, false), null);
  assert.equal(unseenMediaDecision({text:'[CQ:image,file=a] 今天吃巧克力'}, false), null);
});
