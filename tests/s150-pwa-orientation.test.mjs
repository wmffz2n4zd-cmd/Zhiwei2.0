import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createPwaMedia } from '../src/pwa-media.js';
import { createPwaStore } from '../src/pwa-store.js';

// Storage order: A B / C D. These are the visual corner positions specified by EXIF.
const cornersByOrientation = ['ABCD', 'ABCD', 'BADC', 'DCBA', 'CDAB', 'ACBD', 'CADB', 'DBCA', 'BDAC'];
const colors = { A: [224, 40, 40], B: [30, 186, 57], C: [37, 78, 217], D: [226, 174, 32] };

// Independent Pillow-encoded 48×32 fixtures. Frame 1 is ABCD, frame 2 is DCBA.
// Both carry 100/230-ms delays and a finite loop count. Only the third has EXIF.
const animations = [
  ['gif', 0, 'R0lGODlhMAAgAIEAAOKuIB66OSVO2eAoKCH/C05FVFNDQVBFMi4wAwEDAAAh+QQACgAAACwAAAAAMAAgAAAIsAAHCBxIsKDBgQESKlzIsKHCgxAjOpxIMaLFghQzMrzIcYDGjwE6XgSpUaRFkhlNSkQ5USVEli1dGoTpUOZMmhttEsSZU6dAngt9IgSaUOhPoiGNIk0qdKmAp1CjSp0KFYDVq1izar1KtavXrWDDeh0rNazZrGTTCjjLFoBasm3Pvh0b1+zcr3XB3u2aV+/eqX23/gUcGO3gqIUNH36aGOviqo2tPmYc2e3kypYfYw4IACH5BAEXAAQALAAAAAAwACAAgeKuIB66OSVO2eAoKAiwAAEIHEiwoMGBAhIqXMiwocKDECM6nEgxosWCFDMyvMgRgMaPAjpeBKlRpEWSGU1KRDlRJUSWLV0ahOlQ5kyaG20SxJlTp0CeC30iBJpQ6E+iIY0iTSp0aYCnUKNKnQp1gNWrWLNqvUq1q9etYMN6HSs1rNmsZNMGOMt2gFqybc++HRvX7NyvdcHe7ZpX796pfbf+BRwY7eCohQ0ffpoY6+Kqja0+ZhzZ7eTKlh9jDggAOw=='],
  ['webp', 0, 'UklGRuQAAABXRUJQVlA4WAoAAAACAAAALwAAHwAAQU5JTQYAAAAAAAAAAwBBTk1GWAAAAAAAAAAAAC8AAB8AAGQAAAJWUDhMPwAAAC8vwAcAHyAQIO4VqJGiTEHbKNC94AL/HjAnJCB2WeGimeL8R0c3v9BAmG00yUme5AzuHdH/2LYNAD6ralVdDgBBTk1GWAAAAAAAAAAAAC8AAB8AAOYAAABWUDhMPwAAAC8vwAcAHyAQIO4VqJGiTEHbKNC94AL/HjAnJCB2WeGimeL8R0c3v9BAmG00yUlO8gzuHdH/2LZNVT8DQFVdDgA='],
  ['webp', 6, 'UklGRgwBAABXRUJQVlA4WAoAAAAKAAAALwAAHwAAQU5JTQYAAAAAAAAAAwBBTk1GWAAAAAAAAAAAAC8AAB8AAGQAAAJWUDhMPwAAAC8vwAcAHyAQIO4VqJGiTEHbKNC94AL/HjAnJCB2WeGimeL8R0c3v9BAmG00yUme5AzuHdH/2LYNAD6ralVdDgBBTk1GWAAAAAAAAAAAAC8AAB8AAOYAAABWUDhMPwAAAC8vwAcAHyAQIO4VqJGiTEHbKNC94AL/HjAnJCB2WeGimeL8R0c3v9BAmG00yUlO8gzuHdH/2LZNVT8DQFVdDgBFWElGIAAAAEV4aWYAAE1NACoAAAAIAAEBEgADAAAAAQAGAAAAAAAA']
];

function animationInputs() {
  const inputs = animations.slice(0, 2).map(([format, orientation, b64]) => [format, orientation, Buffer.from(b64, 'base64')]);
  const taggedWebp = Buffer.from(animations[2][2], 'base64');
  // Pillow wrote a big-endian TIFF short in the 0x0112 EXIF entry. Change only that short.
  const tag = taggedWebp.indexOf(Buffer.from('011200030000000100060000', 'hex'));
  assert.notEqual(tag, -1);
  for (let orientation = 1; orientation <= 8; orientation++) {
    const frameBytes = Buffer.from(taggedWebp);
    frameBytes.writeUInt16BE(orientation, tag + 8);
    inputs.push(['webp', orientation, frameBytes]);
  }
  return inputs;
}

async function mediaFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 's150-orientation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createPwaStore({ path: ':memory:' });
  t.after(() => store.close());
  const { user } = store.claimInvitation({ token: store.createInvitation().token,
    username: 'orientation', displayName: 'orientation', passwordHash: 'synthetic-test-hash' });
  const media = await createPwaMedia({ store, directory: join(directory, 'media') });
  return async (input, mime) => {
    const saved = await media.upload(user.id, input, mime);
    const history = await media.read(user.id, saved.id);
    const paths = await media.prepareModelImages({ userId: user.id, mediaIds: [saved.id], outputDir: join(directory, 'model') });
    assert.equal(paths.length, 1);
    assert.equal(history.mime, mime);
    assert.deepEqual(await readFile(paths[0]), history.bytes, 'chat and model get the same sanitized bytes');
    return history.bytes;
  };
}

async function jpeg(width, height, orientation) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const corner = 'ABCD'[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)];
      pixels.set(colors[corner], (y * width + x) * 3);
    }
  }
  let image = sharp(pixels, { raw: { width, height, channels: 3 } });
  if (orientation) image = image.withMetadata({ orientation });
  return image.jpeg({ quality: 97, chromaSubsampling: '4:4:4' }).toBuffer();
}

async function assertFrame(bytes, frame, width, height, corners) {
  const { data, info } = await sharp(bytes, { page: frame, pages: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels], [width, height, 3]);
  const xs = [width / 4, 3 * width / 4], ys = [height / 4, 3 * height / 4];
  for (const [i, corner] of [...corners].entries()) {
    const offset = (ys[Math.floor(i / 2)] * width + xs[i % 2]) * 3;
    const rgb = [...data.subarray(offset, offset + 3)];
    assert.ok(rgb.every((v, channel) => Math.abs(v - colors[corner][channel]) < 25),
      `frame ${frame}, position ${i}, expected ${corner} but decoded RGB ${rgb}`);
  }
}

test('JPEGs retain visual orientation after storage and model preparation for EXIF 1–8 and untagged inputs', async t => {
  const upload = await mediaFixture(t);
  const cases = Array.from({ length: 9 }, (_, orientation) => [48, 32, orientation]);
  cases.push([32, 48, 0], [32, 48, 1]);
  for (const [width, height, orientation] of cases) {
    await t.test(`${width}×${height}, orientation ${orientation || 'untagged'}`, async () => {
      const input = await jpeg(width, height, orientation);
      assert.equal((await sharp(input).metadata()).orientation, orientation || undefined);
      const output = await upload(input, 'image/jpeg');
      const metadata = await sharp(output).metadata();
      assert.equal(metadata.orientation, undefined);
      assert.equal(metadata.exif, undefined);
      await assertFrame(output, 0, orientation >= 5 ? height : width,
        orientation >= 5 ? width : height, cornersByOrientation[orientation]);
    });
  }
});

test('animated chat and model media keep both frames, their orientation, timing and loop count', async t => {
  const upload = await mediaFixture(t);
  for (const [format, orientation, input] of animationInputs()) {
    await t.test(`${format} orientation ${orientation || 'untagged'}`, async () => {
      const before = await sharp(input, { animated: true }).metadata();
      assert.equal(before.orientation, orientation || undefined);
      assert.ok(before.loop > 0, 'fixture has a finite repeat count');
      const output = await upload(input, 'image/' + format);
      const after = await sharp(output, { animated: true }).metadata();
      assert.equal(after.format, format);
      assert.equal(after.pages, 2);
      assert.deepEqual(after.delay, [100, 230]);
      assert.equal(after.loop, before.loop);
      assert.equal(after.exif, undefined);
      assert.equal(after.orientation, undefined);
      const width = orientation >= 5 ? 32 : 48, height = orientation >= 5 ? 48 : 32;
      const first = cornersByOrientation[orientation];
      const second = [...first].map(corner => 'DCBA'['ABCD'.indexOf(corner)]).join('');
      await assertFrame(output, 0, width, height, first);
      await assertFrame(output, 1, width, height, second);
    });
  }
});
