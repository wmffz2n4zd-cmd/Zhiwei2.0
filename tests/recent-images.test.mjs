import test from 'node:test';
import assert from 'node:assert/strict';
import { RecentImages } from '../src/recent-images.js';
test('separate image question reuses only recent private sender images', () => {
  let now = 0; const recent = new RecentImages({ now: () => now });
  const event = { type: 'private_message', senderId: '1', images: [{ file: 'example' }] };
  recent.attach(event);
  const ask = { type: 'private_message', senderId: '1', text: '请读出图中文字' };
  assert.deepEqual(recent.attach(ask).images, event.images);
  assert.equal(recent.attach({ ...ask, senderId: '2' }).images, undefined);
  assert.equal(recent.attach({ ...ask, type: 'group_message' }).images, undefined);
  assert.equal(recent.attach({ ...ask, text: '最近怎么样' }).images, undefined);
  assert.equal(recent.attach({ ...ask, hasReplySegment: true }).images, undefined);
  now = 120001; assert.equal(recent.attach(ask).images, undefined);
});

test('group events and disguised group events cannot seed or consume private image recall', () => {
  const recent = new RecentImages();
  const ask = { type: 'private_message', senderId: '1', text: '请读出图中文字' };
  for (const type of ['group_message', 'group_at', 'private_message']) {
    recent.attach({ type, groupId: 'g1', senderId: '1', images: [{ file: 'group-picture' }] });
    assert.equal(recent.attach(ask).images, undefined);
  }
  recent.attach({ ...ask, images: [{ file: 'private-picture' }] });
  for (const type of ['group_message', 'group_at', 'private_message']) {
    assert.equal(recent.attach({ ...ask, type, groupId: 'g1' }).images, undefined);
  }
  assert.deepEqual(recent.attach(ask).images, [{ file: 'private-picture' }]);
});

test('fresh and quoted private images take precedence over implicit recall', () => {
  const recent = new RecentImages();
  const picture = { type: 'private_message', senderId: '1', images: [{ file: 'first' }] };
  const ask = { type: 'private_message', senderId: '1', text: '这张图是什么' };
  recent.attach(picture);
  assert.equal(recent.attach({ ...ask, senderId: '2' }).images, undefined);
  assert.deepEqual(recent.attach(ask).images, picture.images, 'another private sender cannot invalidate this sender image');
  const quoted = recent.attach({ ...ask, hasReplySegment: true, replyContext: { images: [{ file: 'quoted' }] } });
  assert.equal(quoted.images, undefined);
  assert.deepEqual(quoted.replyContext.images, [{ file: 'quoted' }]);
  assert.equal(recent.attach({ ...ask, hasReplySegment: true }).images, undefined, 'failed quote lookup must not substitute a cached image');
  const fresh = recent.attach({ ...ask, images: [{ file: 'fresh' }] });
  assert.deepEqual(fresh.images, [{ file: 'fresh' }]);
  assert.deepEqual(recent.attach(ask).images, fresh.images);
});

test('commands do not inherit images and image follow-ups never extend their lifetime', () => {
  let now = 0;
  const recent = new RecentImages({ now: () => now });
  const picture = { type: 'private_message', senderId: '1', images: [{ file: 'first' }] };
  recent.attach(picture);
  const ask = { type: 'private_message', senderId: '1', text: '看图' };
  for (const text of ['/状态 看图', '@知微 /状态 看图', '[CQ:at,qq=99]/状态 看图']) {
    assert.equal(recent.attach({ ...ask, text }).images, undefined);
  }
  now = 119999;
  assert.equal(recent.attach(ask).images.length, 1);
  now = 120001;
  assert.equal(recent.attach(ask).images, undefined);
});
