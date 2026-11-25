import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, unlink, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createPwaStore } from '../src/pwa-store.js';
import { createPwaMedia } from '../src/pwa-media.js';
import { createPwaStickers } from '../src/pwa-stickers.js';

const png = colour => sharp({ create: { width: 4, height: 3, channels: 3, background: colour } }).png().toBuffer();
// Two literal one-pixel GIF frames, black then white; no remote fixture.
const animatedGif = Buffer.concat([
  Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
  Buffer.from('21ff0b4e45545343415045322e300301000000', 'hex'),
  Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex'),
  Buffer.from('21f904000a0000002c00000000010001000002024c01003b', 'hex')
]);
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 't062-sticker-'));
  const path = join(directory, 'pwa.sqlite'), shared = join(directory, 'shared'), mediaDirectory = join(directory, 'media');
  await mkdir(shared);
  let store, media, stickers, at = 1800000000000;
  async function open() {
    store = createPwaStore({ path, now: () => at });
    media = await createPwaMedia({ directory: mediaDirectory, store });
    stickers = await createPwaStickers({ store, media, sharedDirectory: shared });
  }
  await open();
  const user = name => store.claimInvitation({ token: store.createInvitation().token,
    username: name, displayName: name, passwordHash: 'synthetic-test-hash' }).user.id;
  const alice = user('alice'), bob = user('bob');
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, path, shared, mediaDirectory, alice, bob, advance: () => at += 1000,
    get store() { return store; }, get media() { return media; }, get stickers() { return stickers; },
    async reopen() { store.close(); await open(); } };
}

test('personal saved images stay account-private, idempotent, persistent and removable without deleting history media', async t => {
  const f = await setup(t), image = await f.media.upload(f.alice, await png('#abcdef'), 'image/png');
  await f.stickers.save(f.alice, { mediaId: image.id, name: '自己的表情' });
  await f.stickers.save(f.alice, { mediaId: image.id });
  assert.equal((await f.stickers.list(f.alice)).items.length, 1);
  assert.equal((await f.stickers.list(f.bob)).items.length, 0);
  await assert.rejects(() => f.stickers.save(f.bob, { mediaId: image.id }), /unavailable/);
  await assert.rejects(() => f.stickers.select(f.bob, image.id), /sticker-unavailable/);
  assert.throws(() => f.stickers.remove(f.bob, image.id));
  f.advance();
  assert.equal((await f.stickers.select(f.alice, image.id)).mediaId, image.id);
  await f.reopen();
  const recent = (await f.stickers.list(f.alice, { view: 'recent' })).items;
  assert.equal(recent.length, 1); assert.equal(recent[0].name, '自己的表情');
  assert.equal(recent[0].available, true); assert.ok(recent[0].lastUsedAt);
  f.stickers.remove(f.alice, image.id);
  assert.equal((await f.stickers.list(f.alice)).items.length, 0);
  assert.equal((await f.stickers.list(f.alice, { view: 'recent' })).items[0].favourite, false);
  assert.ok((await f.media.read(f.alice, image.id)).bytes.length);
});

test('picker preserves animated GIF and normal image formats; pure-image sends retain existing client-id dedupe', async t => {
  const f = await setup(t);
  assert.equal((await sharp(animatedGif, { animated: true }).metadata()).pages, 2);
  const samples = [
    ['image/gif', animatedGif], ['image/png', await png('#eeeeee')],
    ['image/jpeg', await sharp(await png('#cccccc')).jpeg().toBuffer()],
    ['image/webp', await sharp(await png('#bbbbbb')).webp().toBuffer()]
  ];
  for (const [type, bytes] of samples) {
    const image = await f.media.upload(f.alice, bytes, type);
    await f.stickers.save(f.alice, { mediaId: image.id });
    const selected = await f.stickers.select(f.alice, image.id);
    assert.equal(selected.media.type, type);
    const input = { userId: f.alice, clientMessageId: type.replace('/', ':'), text: '', mediaIds: [selected.mediaId] };
    const sent = f.store.acceptInbound(input), duplicate = f.store.acceptInbound(input);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.message.id, sent.message.id);
    assert.equal(sent.message.text, ''); assert.deepEqual(sent.message.mediaIds, [image.id]);
    if (type === 'image/gif') assert.equal((await sharp((await f.media.read(f.alice, image.id)).bytes, { animated: true }).metadata()).pages, 2);
  }
});

test('missing and corrupt personal media are displayed unavailable and cannot be selected', async t => {
  const f = await setup(t);
  for (const mode of ['missing', 'corrupt']) {
    const image = await f.media.upload(f.alice, await png('#123456'), 'image/png');
    await f.stickers.save(f.alice, { mediaId: image.id, name: mode });
    const path = f.store.getMedia(f.alice, image.id).path;
    if (mode === 'missing') await unlink(path); else await writeFile(path, 'corrupted');
    const listed = (await f.stickers.list(f.alice)).items.find(item => item.id === image.id);
    assert.equal(listed.available, false); assert.equal(listed.url, null);
    await assert.rejects(() => f.stickers.select(f.alice, image.id));
    f.stickers.remove(f.alice, image.id);
  }
});

test('shared catalogue reads do not create private media; selection owns a safe copy and is stable after restart', async t => {
  const f = await setup(t);
  await writeFile(join(f.shared, '动画.gif'), animatedGif);
  const before = await readdir(f.mediaDirectory);
  const list = await f.stickers.list(f.alice, { view: 'shared' });
  assert.equal(list.items.length, 1); assert.match(list.items[0].id, /^shared:[a-f0-9]{64}$/);
  const preview = await f.stickers.readShared(f.alice, list.items[0].id);
  assert.equal((await sharp(preview.bytes, { animated: true }).metadata()).pages, 2);
  assert.deepEqual(await readdir(f.mediaDirectory), before);
  const selected = await Promise.all(Array.from({ length: 3 }, () => f.stickers.select(f.alice, list.items[0].id)));
  assert.equal(new Set(selected.map(item => item.mediaId)).size, 1);
  const id = selected[0].mediaId;
  assert.equal((await f.stickers.list(f.alice)).items.length, 0);
  assert.equal((await f.stickers.list(f.alice, { view: 'recent' })).items[0].id, id);
  await assert.rejects(() => f.media.read(f.bob, id), /media-unavailable/);
  const other = await f.stickers.select(f.bob, list.items[0].id);
  assert.notEqual(other.mediaId, id);
  await f.stickers.save(f.alice, { mediaId: id, name: '收藏共享动画' });
  await f.reopen();
  assert.equal((await f.stickers.select(f.alice, list.items[0].id)).mediaId, id);
  assert.equal((await f.stickers.list(f.alice)).items[0].favourite, true);
  await unlink(join(f.shared, '动画.gif'));
  assert.equal((await f.stickers.list(f.alice, { view: 'shared' })).items.length, 0);
  await assert.rejects(() => f.stickers.select(f.alice, list.items[0].id), /sticker-unavailable/);
  assert.equal((await f.stickers.select(f.alice, id)).mediaId, id);
});

test('shared files cannot escape through symlinks or disguised images; file replacement produces new source copy', async t => {
  const f = await setup(t), outside = join(f.directory, 'outside.png');
  await writeFile(outside, await png('#ff0000'));
  await symlink(outside, join(f.shared, 'link.png'));
  await writeFile(join(f.shared, 'fake.png'), '<svg onload="bad()"/>');
  await writeFile(join(f.shared, 'normal.png'), await png('#00ff00'));
  let list = (await f.stickers.list(f.alice, { view: 'shared' })).items;
  assert.equal(list.some(item => item.name === 'link.png'), false);
  await assert.rejects(() => f.stickers.select(f.alice, list.find(item => item.name === 'fake.png').id), /sticker-unavailable/);
  const normal = list.find(item => item.name === 'normal.png');
  const first = await f.stickers.select(f.alice, normal.id);
  await writeFile(join(f.shared, 'normal.png'), await png('#0000ff'));
  const second = await f.stickers.select(f.alice, normal.id);
  assert.notEqual(second.mediaId, first.mediaId);
  await assert.rejects(() => f.stickers.select(f.alice, '../outside.png'), /sticker-unavailable/);
});

test('revocation during async reads blocks saves and selection without adding collection state', async t => {
  const f = await setup(t), image = await f.media.upload(f.alice, await png('#111111'), 'image/png');
  let checks = 0;
  await assert.rejects(() => f.stickers.save(f.alice, { mediaId: image.id }, () => {
    if (++checks === 2) f.store.disableUser(f.alice);
  }), /account-unavailable/);
  f.store.disableUser(f.alice, false);
  assert.equal((await f.stickers.list(f.alice)).items.length, 0);
  await writeFile(join(f.shared, 'a.png'), await png('#222222'));
  const shared = (await f.stickers.list(f.alice, { view: 'shared' })).items[0]; checks = 0;
  await assert.rejects(() => f.stickers.select(f.alice, shared.id, () => {
    if (++checks === 3) f.store.disableUser(f.alice);
  }), /account-unavailable/);
  f.store.disableUser(f.alice, false);
  assert.equal((await f.stickers.list(f.alice, { view: 'recent' })).items.length, 0);
});

test('collection keyset pages remain scoped and reach older favourites while new images arrive', async t => {
  const f = await setup(t), original = [];
  for (let index = 0; index < 5; index++) {
    const image = await f.media.upload(f.alice, await png('#334455'), 'image/png');
    await f.stickers.save(f.alice, { mediaId: image.id, name: `第${index}张` });
    original.push(image.id); f.advance();
  }
  const first = await f.stickers.list(f.alice, { limit: 2 });
  assert.equal(first.hasMore, true); assert.ok(first.nextCursor);
  await assert.rejects(() => f.stickers.list(f.bob, { cursor: first.nextCursor }), /invalid-sticker-cursor/);
  await assert.rejects(() => f.stickers.list(f.alice, { view: 'recent', cursor: first.nextCursor }), /invalid-sticker-cursor/);
  const extra = await f.media.upload(f.alice, await png('#556677'), 'image/png');
  await f.stickers.save(f.alice, { mediaId: extra.id });
  let cursor = first.nextCursor, seen = first.items.map(item => item.id);
  while (cursor) {
    const page = await f.stickers.list(f.alice, { limit: 2, cursor });
    seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
  }
  assert.deepEqual(new Set(seen), new Set(original)); assert.equal(seen.length, original.length);
  await assert.rejects(() => f.stickers.list(f.alice, { cursor: 'invalid' }), /invalid-sticker-cursor/);
});

test('shared catalogue pagination reaches and selects files beyond the first 150 entries', async t => {
  const f = await setup(t), bytes = await png('#778899');
  await Promise.all(Array.from({ length: 151 }, (_, index) => writeFile(
    join(f.shared, `${String(index).padStart(3, '0')}.png`), bytes)));
  const first = await f.stickers.list(f.alice, { view: 'shared', limit: 150 });
  assert.equal(first.items.length, 150); assert.equal(first.hasMore, true); assert.ok(first.nextCursor);
  const second = await f.stickers.list(f.alice, { view: 'shared', limit: 150, cursor: first.nextCursor });
  assert.equal(second.items.length, 1); assert.equal(second.items[0].name, '150.png');
  assert.equal(second.hasMore, false); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 151);
  const selected = await f.stickers.select(f.alice, second.items[0].id);
  assert.ok((await f.media.read(f.alice, selected.mediaId)).bytes.length);
});

test('shared cursor uses a unique tie-breaker for differently encoded names with equal collation', async t => {
  const f = await setup(t), bytes = await png('#8899aa');
  await writeFile(join(f.shared, '\u00e9.png'), bytes);
  await writeFile(join(f.shared, 'e\u0301.png'), bytes);
  const first = await f.stickers.list(f.alice, { view: 'shared', limit: 1 });
  const second = await f.stickers.list(f.alice, { view: 'shared', limit: 1, cursor: first.nextCursor });
  assert.equal(first.items.length, 1); assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(second.nextCursor, null);
});
