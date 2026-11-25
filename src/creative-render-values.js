export function textField(value, limit = 600) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw Error('作品文字缺失或超长');
  return value.trim();
}
export function escapeMarkup(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
export function color(value) {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw Error('作品颜色格式无效');
  return value;
}
export function number(value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) throw Error('作品尺寸或坐标无效');
  return value;
}
export function list(value, max) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw Error('作品元素数量无效');
  return value;
}
export function file(name, mime, data) {
  return { name, mime, bytes: Buffer.from(data) };
}

