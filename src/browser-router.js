import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createBrowserReader, isXBrowserUrl } from './browser-reader.js';

// This exact read-only query was checked against X's published client bundle.
// A query-id change must be rechecked, not broadened into a GraphQL wildcard.
export const X_HOME_TIMELINE_ENDPOINT = 'https://x.com/i/api/graphql/fedFLLzmiCAuzPgA8lyh8Q/HomeTimeline';

function failure(message) { const error = new Error(message); error.name = 'BrowserReadPolicyError'; return error; }
function overlap(left, right) { return left === right || left.startsWith(right + sep) || right.startsWith(left + sep); }
function checkSeparate(paths) {
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    if (overlap(paths[i], paths[j])) throw failure('X与默认浏览器的登录资料和截图必须使用互不重叠的独立目录。');
  }
}
async function resolvedLocation(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await resolvedLocation(dirname(path)), basename(path));
  }
}
function platformKey(platform) {
  const value = String(platform || '').toLowerCase();
  if (value === 'x' || value === 'twitter') return 'x';
  if (value === 'xiaohongshu' || value === 'xhs') return 'default';
  throw failure('人工登录只支持 x/twitter 或 xiaohongshu/xhs。');
}

// Keep the existing reader contract. Only one persistent browser may be open;
// selecting another platform waits for the previous browser's normal close.
export function createBrowserRouter({ defaultOptions, xOptions, browserFactory = createBrowserReader } = {}) {
  if (!xOptions) return browserFactory(defaultOptions);
  const options = {
    default: { ...defaultOptions, readNavigationScope: 'default' },
    x: { ...xOptions, readNavigationScope: 'x' }
  };
  const paths = Object.values(options).flatMap(item => [item.profileDir, item.screenshotDir]);
  if (paths.some(path => typeof path !== 'string' || !isAbsolute(path))) throw failure('X与默认浏览器资料目录必须使用绝对路径。');
  checkSeparate(paths.map(path => resolve(path)));
  const endpoints = options.x.readonlyPostEndpoints || [];
  if (!Array.isArray(endpoints) || endpoints.some(endpoint => endpoint !== X_HOME_TIMELINE_ENDPOINT)) {
    throw failure('X只读POST仅允许已核验的精确HomeTimeline查询端点。');
  }
  const readers = new Map();
  let active = null, busy = false;
  const selected = () => active && readers.get(active);
  const anyLogin = () => [...readers.values()].some(reader => reader.status().mode === 'login');
  function status() {
    const current = selected()?.status() || { running: false, mode: 'closed', busy: false,
      channel: null, headed: false, proxyConfigured: Boolean(defaultOptions?.proxy), readonlyPostEndpointCount: 0, lastBlockedReason: null };
    return { ...current, busy: busy || [...readers.values()].some(reader => reader.status().busy),
      platform: active, isolatedX: true };
  }
  async function locked(action) {
    if (busy || [...readers.values()].some(reader => reader.status().busy)) throw failure('浏览器正在处理另一个操作，请稍后重试。');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  function requireReadMode() {
    if (anyLogin()) throw failure('人工登录模式正在进行；请先结束登录再让知微读取网页。');
  }
  async function choose(key) {
    // Also resolve existing ancestors, so a not-yet-created child of a symlink
    // cannot alias the other profile or its screenshots.
    checkSeparate(await Promise.all(paths.map(path => resolvedLocation(resolve(path)))));
    if (active !== key && selected()) {
      await selected().close();
      const old = selected().status();
      if (old.running || old.busy || old.mode !== 'closed') throw failure('旧浏览器尚未正常关闭，不能切换登录资料。');
    }
    if (!readers.has(key)) readers.set(key, browserFactory(options[key]));
    active = key;
    return selected();
  }
  return Object.freeze({
    status,
    start: () => locked(async () => { requireReadMode(); await (await choose(active || 'default')).start(); return status(); }),
    read: url => locked(async () => {
      requireReadMode();
      return (await choose(isXBrowserUrl(url) ? 'x' : 'default')).read(url);
    }),
    search: (query, searchOptions = {}) => locked(async () => {
      requireReadMode();
      const platform = searchOptions.platform || 'web';
      const key = platform === 'web' ? 'default' : platformKey(platform);
      return (await choose(key)).search(query, searchOptions);
    }),
    openLogin: platform => locked(async () => {
      const key = platformKey(platform);
      if (anyLogin() && active !== key) throw failure('请先完成当前平台的人工登录，再切换平台。');
      const result = await (await choose(key)).openLogin(platform);
      return { ...result, ...status() };
    }),
    finishLogin: () => locked(async () => {
      if (selected()) await selected().finishLogin();
      return status();
    }),
    close: () => locked(async () => {
      const errors = [];
      for (const reader of readers.values()) {
        try {
          await reader.close();
          const value = reader.status();
          if (value.running || value.busy || value.mode !== 'closed') throw failure('浏览器尚未正常关闭。');
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors[0];
      active = null;
      return status();
    })
  });
}
