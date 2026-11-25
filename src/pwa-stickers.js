import { createHash } from 'node:crypto';
import { readdir, realpath, stat, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import sharp from 'sharp';

const MAX_BYTES = 10 * 1024 * 1024;
const extensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const mime = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (status, code) => Object.assign(Error(code), { status, code });
const ownId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const sharedId = id => typeof id === 'string' && /^shared:[a-f0-9]{64}$/.test(id);
const inside = (base, target) => { const part = relative(base, target); return part && !part.startsWith('..') && !isAbsolute(part); };
const unavailable = error => ['ENOENT', 'ENOTDIR', 'media-unavailable', 'media-integrity', 'sticker-unavailable'].includes(error.code)
  || error.status === 404;
function decodeCursor(value, userId, view) {
  if (value == null || value === '') return null;
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed.v !== 1 || parsed.u !== userId || parsed.k !== view) throw Error();
    if (view === 'shared') {
      if (typeof parsed.n !== 'string' || parsed.n.length > 255 || !sharedId(parsed.id)) throw Error();
    } else if (!Number.isSafeInteger(parsed.t) || parsed.t < 0 || !ownId(parsed.id)) throw Error();
    return parsed;
  } catch { throw fail(400, 'invalid-sticker-cursor'); }
}
const encodeCursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A user's collection only points at their already-authorized PWA media.
 * The bot's existing shared library remains read-only; selection copies a
 * decoded image into the selecting account. No private collection is public.
 */
export async function createPwaStickers({ store, media, sharedDirectory = null }) {
  if (!store || !media) throw Error('Sticker store and media are required');
  const selections = new Map();
  let decoding = 0;
  const waitingDecoders = [];
  async function acquireDecoder() {
    if (decoding < 2) { decoding++; return; }
    await new Promise(resolve => waitingDecoders.push(resolve));
  }
  function releaseDecoder() {
    const next = waitingDecoders.shift();
    if (next) next(); else decoding--;
  }
  function active(userId, check = () => {}) {
    check();
    const identity = store.getIdentity(userId);
    if (!identity?.enabled) throw fail(403, 'account-unavailable');
    if (identity.bindingStatus !== 'active') throw fail(403, 'binding-pending');
  }
  async function catalogue() {
    if (!sharedDirectory) return [];
    const root = await realpath(sharedDirectory).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!root) return [];
    const files = await readdir(root, { withFileTypes: true });
    return files.filter(entry => entry.isFile() && extensions.has(extname(entry.name).toLowerCase())
      && !/[\[\]\u0000-\u001f]/.test(entry.name))
      .map(entry => ({ id: `shared:${digest(entry.name)}`, name: entry.name, root, path: resolve(root, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  async function sharedBytes(userId, id, check = () => {}) {
    active(userId, check);
    if (!sharedId(id)) throw fail(404, 'sticker-unavailable');
    const entry = (await catalogue()).find(item => item.id === id);
    active(userId, check);
    if (!entry) throw fail(404, 'sticker-unavailable');
    // A grid may request many thumbnails together. Queue their decodes instead
    // of rejecting later thumbnails or decoding every animation simultaneously.
    await acquireDecoder();
    try {
      active(userId, check);
      const path = await realpath(entry.path);
      if (!inside(entry.root, path)) throw fail(404, 'sticker-unavailable');
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_BYTES) throw fail(404, 'sticker-unavailable');
      const original = await readFile(path);
      if (original.length > MAX_BYTES) throw fail(404, 'sticker-unavailable');
      const input = sharp(original, { animated: true, limitInputPixels: 40000000, failOn: 'warning' });
      const metadata = await input.metadata();
      if (!mime[metadata.format] || !metadata.width || !metadata.height || metadata.width > 16384
        || (metadata.pageHeight || metadata.height) > 16384 || (metadata.pages || 1) > 300) throw fail(404, 'sticker-unavailable');
      // Preview and private copy retain every frame and strip embedded metadata.
      const bytes = await input.toFormat(metadata.format).toBuffer();
      if (bytes.length > MAX_BYTES) throw fail(404, 'sticker-unavailable');
      active(userId, check);
      return { bytes, mime: mime[metadata.format], name: entry.name, sha256: digest(bytes) };
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error;
      throw fail(404, 'sticker-unavailable');
    } finally { releaseDecoder(); }
  }
  async function readOwned(userId, id) {
    try { return await media.read(userId, id); }
    catch (error) { if (unavailable(error)) throw fail(404, 'sticker-unavailable'); throw error; }
  }
  const publicMedia = record => ({ id: record.id, type: record.mime, url: `/api/pwa/media/${record.id}` });
  async function item(userId, row) {
    let record;
    try { record = await media.read(userId, row.mediaId); }
    catch (error) { if (!unavailable(error)) throw error; }
    active(userId);
    return { id: row.mediaId, mediaId: row.mediaId, name: row.name || '表情', favourite: Boolean(row.favourite),
      available: Boolean(record), type: record?.mime || row.mime, url: record ? `/api/pwa/media/${row.mediaId}` : null,
      createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
  }
  const service = {
    async list(userId, { view = 'favourites', limit = 60, cursor = null } = {}) {
      active(userId);
      if (!['favourites', 'recent', 'shared'].includes(view) || !Number.isSafeInteger(limit) || limit < 1 || limit > 150)
        throw fail(400, 'invalid-sticker-query');
      const before = decodeCursor(cursor, userId, view);
      if (view === 'shared') {
        const rows = (await catalogue()).filter(row => !before || row.name.localeCompare(before.n) > 0
          || row.name.localeCompare(before.n) === 0 && row.id > before.id); active(userId);
        const page = rows.slice(0, limit), hasMore = rows.length > limit;
        return { items: page.map(row => ({ id: row.id, name: row.name, favourite: false,
          available: true, url: `/api/pwa/sticker-assets/${row.id.slice(7)}`, type: 'image' })),
          hasMore, nextCursor: hasMore ? encodeCursor({ v: 1, u: userId, k: view, n: page.at(-1).name, id: page.at(-1).id }) : null };
      }
      const rows = store.listStickers(userId, { kind: view, limit: limit + 1,
        before: before ? { at: before.t, id: before.id } : null });
      const hasMore = rows.length > limit, page = rows.slice(0, limit);
      const items = [];
      for (const row of page) items.push(await item(userId, row));
      const last = page.at(-1);
      return { items, hasMore, nextCursor: hasMore ? encodeCursor({ v: 1, u: userId, k: view,
        t: view === 'favourites' ? last.createdAt : last.lastUsedAt, id: last.mediaId }) : null };
    },
    async save(userId, { mediaId, name } = {}, check = () => {}) {
      active(userId, check);
      if (!ownId(mediaId)) throw fail(404, 'media-unavailable');
      if (name !== undefined && (typeof name !== 'string' || name.length > 80 || /[\u0000-\u001f]/.test(name)))
        throw fail(400, 'invalid-sticker-name');
      const record = await readOwned(userId, mediaId); active(userId, check);
      const saved = store.saveSticker(userId, { mediaId, name: name?.trim() || undefined });
      return { item: { id: saved.mediaId, mediaId: saved.mediaId, name: saved.name || '表情', favourite: true,
        available: true, type: record.mime, url: `/api/pwa/media/${mediaId}`, createdAt: saved.createdAt, lastUsedAt: saved.lastUsedAt } };
    },
    remove(userId, id) {
      active(userId);
      if (!ownId(id)) throw fail(404, 'sticker-unavailable');
      store.removeSticker(userId, id); return { ok: true };
    },
    async select(userId, id, check = () => {}) {
      active(userId, check);
      if (ownId(id)) {
        // Selection requires membership, not a guessed UUID. Normal authorized
        // images can become stickers through the explicit save endpoint.
        if (!store.getSticker(userId, id)) throw fail(404, 'sticker-unavailable');
        const record = await readOwned(userId, id); active(userId, check);
        store.touchSticker(userId, id);
        return { media: publicMedia(record), mediaId: id };
      }
      if (!sharedId(id)) throw fail(404, 'sticker-unavailable');
      const key = `${userId}:${id}`;
      // Concurrent clicks in one process share the same authorized copy. SQLite
      // also makes source_key unique for concurrent independent processes.
      if (selections.has(key)) { const result = await selections.get(key); active(userId, check); return result; }
      const pending = (async () => {
        const source = await sharedBytes(userId, id, check);
        const sourceKey = `${id}:${source.sha256}`;
        let row = store.findStickerBySource(userId, sourceKey), record = null;
        if (row) {
          try { record = await media.read(userId, row.mediaId); }
          catch (error) { if (!unavailable(error)) throw error; }
        }
        active(userId, check);
        if (!record) {
          const uploaded = await media.upload(userId, source.bytes, source.mime, () => active(userId, check));
          active(userId, check);
          row = store.saveSticker(userId, { mediaId: uploaded.id, name: source.name.slice(0, 80),
            favourite: false, sourceKey });
          record = await media.read(userId, row.mediaId); active(userId, check);
        }
        store.touchSticker(userId, row.mediaId);
        return { media: publicMedia(record), mediaId: row.mediaId };
      })();
      selections.set(key, pending);
      try { return await pending; } finally { if (selections.get(key) === pending) selections.delete(key); }
    },
    readShared: sharedBytes
  };
  return service;
}
