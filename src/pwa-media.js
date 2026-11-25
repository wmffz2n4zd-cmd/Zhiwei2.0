import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, open, unlink } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const MAX_BYTES = 10 * 1024 * 1024;
const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const inside = (base, target) => { const r = relative(base, target); return r && !r.startsWith('..') && !isAbsolute(r); };
const fail = (status, code) => Object.assign(Error(code), { status, code });
function signature(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())) return 'gif';
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'webp';
  return null;
}

async function encodeMedia(input, type, meta) {
  if ((meta.pages || 1) === 1) return input.autoOrient().toFormat(type).toBuffer();
  const orientation = meta.orientation;
  if (!(orientation >= 2 && orientation <= 8)) return input.toFormat(type).toBuffer();

  // sharp treats decoded animation frames as one vertical strip. Rotating
  // that strip would also move frames, so transform each frame independently.
  const { data, info } = await input.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width, height = meta.pageHeight, channels = info.channels;
  const frameBytes = width * height * channels;
  if (!height || frameBytes * meta.pages !== data.length) throw fail(415, 'invalid-image');
  for (let offset = 0; offset < data.length; offset += frameBytes) {
    const frame = sharp(data.subarray(offset, offset + frameBytes), { raw: { width, height, channels } });
    switch (orientation) {
      case 2: frame.flop(); break;
      case 3: frame.rotate(180); break;
      case 4: frame.flip(); break;
      case 5: frame.flip().rotate(90); break;
      case 6: frame.rotate(90); break;
      case 7: frame.flop().rotate(90); break;
      case 8: frame.rotate(270); break;
    }
    (await frame.raw().toBuffer()).copy(data, offset);
  }
  const swapAxes = orientation >= 5;
  const pageHeight = swapAxes ? width : height;
  return sharp(data, { raw: { width: swapAxes ? height : width, height: pageHeight * meta.pages, channels, pageHeight } })
    .toFormat(type, { delay: meta.delay, loop: meta.loop }).toBuffer();
}

export async function createPwaMedia({ directory, store, allowedOutboundRoots = [] }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  let decoding = 0;
  async function upload(userId, bytes, suppliedMime, canContinue = () => true) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw fail(413, 'image-too-large');
    const type = signature(bytes);
    if (!type || suppliedMime && MIME[type] !== suppliedMime) throw fail(415, 'unsupported-image');
    if (decoding >= 2) throw fail(429, 'image-busy');
    decoding++;
    let decoded = false;
    try {
      // Decode every frame, preserve animation and strip metadata. The original
      // private file name/path is never used as a storage path or exposed URL.
      const input = sharp(bytes, { animated: true, limitInputPixels: 40000000, failOn: 'warning' });
      const meta = await input.metadata();
      if (meta.format !== type || !meta.width || !meta.height || meta.width > 16384
        || (meta.pageHeight || meta.height) > 16384 || (meta.pages || 1) > 300) throw fail(415, 'invalid-image');
      const safe = await encodeMedia(input, type, meta);
      decoded = true;
      if (safe.length > MAX_BYTES) throw fail(413, 'image-too-large');
      canContinue();
      const id = randomUUID(), target = join(root, id + '.' + type);
      const file = await open(target, 'wx', 0o600);
      try { await file.writeFile(safe); await file.sync(); } finally { await file.close(); }
      const directoryHandle = await open(root, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      try { canContinue(); store.addMedia({ userId, id, path: target, mime: MIME[type], size: safe.length,
        sha256: createHash('sha256').update(safe).digest('hex') }); }
      catch (error) { await unlink(target); throw error; }
      return { id, type: MIME[type], url: `/api/pwa/media/${id}` };
    } catch (error) { if (error.status) throw error; throw decoded ? fail(503, 'media-storage-unavailable') : fail(415, 'invalid-image'); }
    finally { decoding--; }
  }
  async function read(userId, id) {
    const record = store.getMedia(userId, id);
    if (!record) throw fail(404, 'media-unavailable');
    const canonical = await realpath(record.path);
    if (!inside(root, canonical)) throw fail(404, 'media-unavailable');
    const info = await stat(canonical);
    if (!info.isFile() || info.size > MAX_BYTES) throw fail(404, 'media-unavailable');
    const bytes = await readFile(canonical);
    if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw fail(503, 'media-integrity');
    return { ...record, bytes };
  }
  return {
    upload, read,
    async prepareModelImages({ userId, mediaIds, outputDir }) {
      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      const paths = [];
      for (const id of mediaIds.slice(0,4)) {
        const media = await read(userId, id), path = join(outputDir, randomUUID() + '.' + signature(media.bytes));
        const file = await open(path, 'wx', 0o600);
        try { await file.writeFile(media.bytes); } finally { await file.close(); }
        paths.push(path);
      }
      return paths;
    },
    async publishOutboundMedia({ userId, segments }) {
      const result = [];
      for (const segment of segments.filter(s => s.type === 'image').slice(0,4)) {
        const raw = segment.data?.file;
        if (typeof raw !== 'string' || (!raw.startsWith('file:') && !isAbsolute(raw))) throw fail(400, 'invalid-outbound-image');
        const path = await realpath(raw.startsWith('file:') ? fileURLToPath(raw) : raw);
        const roots = await Promise.all(allowedOutboundRoots.map(r => realpath(r).catch(() => null)));
        if (!roots.some(r => r && inside(r,path))) throw fail(400, 'invalid-outbound-image');
        if ((await stat(path)).size > MAX_BYTES) throw fail(413, 'image-too-large');
        const image = await upload(userId, await readFile(path));
        result.push({ type: 'image', mediaId: image.id });
      }
      return result;
    }
  };
}
