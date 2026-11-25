// Shared local media for private chat. Storage directory names and old model
// markers may retain "qq" for compatibility; this module has no QQ transport.
import { readdir, realpath, stat, readFile } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const extensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const maxBytes = 10 * 1024 * 1024;
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return '.gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return '.webp';
  return null;
}
async function allowedFile(path, roots) {
  if (String(path).startsWith('file:')) path = fileURLToPath(path);
  if (!isAbsolute(path) || String(path).startsWith('\\\\')) throw Error('Local image path required');
  const canonical = await realpath(path);
  let allowed = false;
  for (const root of roots) {
    const base = await realpath(root).catch(() => null); if (!base) continue;
    const rel = relative(base, canonical);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) { allowed = true; break; }
  }
  if (!allowed) throw Error('Image is outside configured media directories');
  const info = await stat(canonical);
  if (!info.isFile() || info.size > maxBytes) throw Error('Image exceeds 10 MB or is not a file');
  const bytes = await readFile(canonical), type = imageType(bytes);
  if (!type) throw Error('Unsupported image data');
  return { canonical, bytes, type };
}
export async function buildStickerCatalog(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  return entries.filter(e => e.isFile() && extensions.has(extname(e.name).toLowerCase()) && !/[\[\]\r\n]/.test(e.name))
    .slice(0, 150).map(e => ({ name: e.name, path: resolve(dir, e.name) }));
}
export const buildChatStyleInstructions = () => '';
export function formatStickerCatalog(catalog) { return catalog.map(e => e.name).join('、') || '暂无本地表情包'; }
export function stripImageAttachmentMarkers(text) {
  return String(text || '').replace(/\[\[(?:qq_)?(?:sticker|image):[^\]]*\]\]/g, '').trim();
}
export async function resolveReplyMedia(text, { stickerDir }) {
  const catalog = await buildStickerCatalog(stickerDir), paths = [];
  for (const match of String(text).matchAll(/\[\[(?:qq_)?sticker:([^\]]+)\]\]/g)) {
    const entry = catalog.find(e => e.name === match[1]);
    if (!entry) continue;
    const file = await allowedFile(entry.path, [stickerDir]).catch(() => null);
    if (file && !paths.includes(file.canonical)) paths.push(file.canonical);
    if (paths.length >= 2) break;
  }
  // Model output selects catalog entries only, never arbitrary filesystem paths.
  return paths;
}
export function buildImageSegment(path) { return { type: 'image', data: { file: pathToFileURL(path).href } }; }
export function formatImageSummary(images) { return `${images.length} 张图片（内容以实际视觉输入为准）`; }
