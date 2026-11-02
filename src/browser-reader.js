import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

const LOGIN_URLS = Object.freeze({
  x: 'https://x.com/i/flow/login',
  twitter: 'https://x.com/i/flow/login',
  xiaohongshu: 'https://www.xiaohongshu.com/',
  xhs: 'https://www.xiaohongshu.com/'
});
const LOCAL_NAME = /(?:^|\.)(?:localhost|local|internal|lan|home|home\.arpa|test|invalid)$/i;
const SENSITIVE_QUERY = /^(?:password|passwd|secret|token|access_token|refresh_token|auth|authorization|session|sessionid|cookie|csrf|xsrf)$/i;
const ACTION_QUERY = /^(?:action|do|cmd|command|operation|method|_method)$/i;
const WRITE_SEGMENT = /(?:^|[/_.-])(?:logout|logoff|signout|delete|destroy|remove|unfollow|follow|like|unlike|favorite|unfavorite|retweet|repost|comment|reply|send|publish|compose|intent|settings|checkout|purchase|payment|subscribe|unsubscribe|authorize|oauth|callback|vote|report|block|unblock|mute|unmute|upload|create|update|edit|destroy|notifications|messages|direct_messages)(?:$|[/_.-])/i;
const WRITE_OPERATION = /\/(?:Create|Delete|Update|Destroy|Favorite|Unfavorite|Bookmark|Unbookmark|Send|Post|Publish|Follow|Unfollow|Block|Unblock|Mute|Unmute)[A-Z][a-zA-Z]*(?:[/.]|$)/;
const PRIVATE_DOM_SELECTOR = 'input,textarea,select,option,form,[contenteditable],script,style,noscript,template,[hidden],[aria-hidden="true"],[data-private],[autocomplete]';
const DISALLOWED_RESOURCE_TYPES = new Set(['websocket', 'eventsource', 'manifest', 'other']);
const EMPTY = () => ({ url: '', title: '', text: '', links: [], imagePaths: [], requiresLogin: false });
const X_BROWSER_HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

export function isXBrowserUrl(input) {
  try { return X_BROWSER_HOSTS.has(new URL(input).hostname.toLowerCase().replace(/\.$/, '')); } catch { return false; }
}
function isXAuthenticationUrl(input) {
  if (!isXBrowserUrl(input)) return false;
  return /^\/(?:login(?:\/|$)|signin(?:\/|$)|i\/(?:flow|jf)(?:\/|$))/.test(new URL(input).pathname);
}
function xContentTarget(input) {
  if (!isXBrowserUrl(input)) return null;
  const path = new URL(input).pathname;
  const status = /^\/[^/]+\/status\/(\d+)(?:\/|$)/.exec(path);
  return status ? { statusId: status[1] } : /^\/(?:home|search)?\/?$/.test(path) ? { statusId: null } : null;
}

// Executed in the page, with no values read from forms, cookies or storage.
// A navigation shell, hidden tweet, or an unrelated recommendation on a post page
// cannot satisfy the content contract. Authentication/challenge UI wins over tweets.
export function inspectXReadiness({ statusId = null } = {}) {
  const visible = node => {
    if (!node || !node.getClientRects().length || node.closest('[hidden],[aria-hidden="true"]')) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  };
  const bodyText = document.body?.innerText || '';
  if ([...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenge"],[id*="captcha"],[class*="captcha"]')].some(visible) || /(?:verify (?:you are|you're) human|checking your browser|security verification|安全验证|访问过于频繁|完成验证|拖动滑块|人机验证)/i.test(bodyText)) return 'human_verification_required';
  if (/^\/(?:login(?:\/|$)|signin(?:\/|$)|i\/(?:flow|jf)(?:\/|$))/.test(location.pathname) || [...document.querySelectorAll('input[type="password"],input[autocomplete="username"],input[autocomplete="current-password"]')].some(visible) || /(?:登录后(?:查看|浏览|继续)|请先登录|扫码登录|sign in to x|join x today)/i.test(bodyText)) return 'login_required';
  for (const tweet of document.querySelectorAll('[data-testid="tweet"]')) {
    if (!visible(tweet)) continue;
    const hasStatus = [...tweet.querySelectorAll('a[href]')].some(link => {
      if (!visible(link)) return false;
      try {
        const target = new URL(link.href);
        const match = /^\/[^/]+\/status\/(\d+)(?:\/|$)/.exec(target.pathname);
        return ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(target.hostname.replace(/\.$/, '')) && match && (!statusId || match[1] === statusId);
      } catch { return false; }
    });
    const hasText = [...tweet.querySelectorAll('[data-testid="tweetText"]')].some(node => visible(node) && node.textContent.trim());
    const hasMedia = [...tweet.querySelectorAll('[data-testid="tweetPhoto"] img,video')].some(node => visible(node) && (node.tagName === 'VIDEO' ? node.readyState >= 2 : node.complete && node.naturalWidth > 0));
    if (hasStatus && (hasText || hasMedia)) return 'ready';
  }
  return false;
}

function failure(message) { const error = new Error(message); error.name = 'BrowserReadPolicyError'; return error; }
function boundedInteger(value, fallback, low, high) {
  return Number.isInteger(value) ? Math.min(high, Math.max(low, value)) : fallback;
}

// Conservative global-unicast check. Reject transition/documentation/reserved networks,
// including IPv4-mapped IPv6, rather than treating every non-RFC1918 IP as public.
export function isPublicAddress(address) {
  const input = String(address).replace(/^\[|\]$/g, '');
  if (isIP(input) === 4) {
    const [a, b, c] = input.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(input) === 6) {
    const parts = input.toLowerCase().split(':');
    const first = parseInt(parts[0] || '0', 16);
    const second = parseInt(parts[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
      !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) &&
      !(first === 0x3fff && second <= 0x0fff);
  }
  return false;
}

function parsePublicUrl(input, { allowAccountActions = false } = {}) {
  if (typeof input !== 'string' || input.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(input)) throw failure('只接受完整的公开 HTTP(S) 地址。');
  let url;
  try { url = new URL(input); } catch { throw failure('网页地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('禁止危险协议或含账号密码的地址。');
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw failure('只允许标准 HTTP(S) 端口。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || LOCAL_NAME.test(hostname) || (!hostname.includes('.') && !isIP(hostname)) || (isIP(hostname) && !isPublicAddress(hostname))) throw failure('禁止访问本机、内网或保留地址。');
  if (!allowAccountActions) {
    let path = url.pathname;
    for (let i = 0; i < 3; i++) {
      try { const decoded = decodeURIComponent(path); if (decoded === path) break; path = decoded; } catch { throw failure('网页地址编码无效。'); }
    }
    if (WRITE_SEGMENT.test(path) || WRITE_OPERATION.test(path) || /^\/(?:account|accounts)(?:\/|$)/i.test(path) || /^\/i\/(?:flow|jf)\//i.test(path)) throw failure('只读模式禁止账号修改、互动或登录操作地址。');
    for (const key of url.searchParams.keys()) if (SENSITIVE_QUERY.test(key) || ACTION_QUERY.test(key)) throw failure('只读模式禁止凭证或动作参数。');
  }
  url.hash = '';
  return { url, hostname };
}

export async function validatePublicUrl(input, { lookup = dnsLookup, allowAccountActions = false, dnsTimeoutMs = 5000 } = {}) {
  const { url, hostname } = parsePublicUrl(input, { allowAccountActions });
  if (!isIP(hostname)) {
    let timer;
    let addresses;
    try {
      addresses = await Promise.race([
        lookup(hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure('网页域名解析超时。')), dnsTimeoutMs); })
      ]);
    } catch (error) {
      if (error?.name === 'BrowserReadPolicyError') throw error;
      throw failure('网页域名解析失败。');
    } finally { clearTimeout(timer); }
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw failure('网页域名解析到了内网或保留地址。');
  }
  return url.href;
}

export function checkReadRequest(input, { method = 'GET', resourceType = 'document', readonlyPostEndpoints = [] } = {}) {
  const parsed = parsePublicUrl(input);
  const verb = String(method).toUpperCase();
  const allowedPost = parsed.url.protocol === 'https:' && !parsed.url.search && readonlyPostEndpoints.includes(parsed.url.origin + parsed.url.pathname);
  if (verb === 'OPTIONS' && allowedPost) return parsed.url.href;
  if (DISALLOWED_RESOURCE_TYPES.has(resourceType)) throw failure('只读模式禁止此类后台连接。');
  if (verb === 'GET' || verb === 'HEAD') return parsed.url.href;
  if (verb === 'POST' && allowedPost && ['xhr', 'fetch'].includes(resourceType)) return parsed.url.href;
  throw failure('只读模式已阻止提交或写入请求。');
}

// This function is executed only by the reader, never supplied by the model. It reads
// rendered text nodes and visible anchors, never input values, cookies or page storage.
export function extractVisibleDocument({ maxTextChars = 18000, maxLinks = 40 } = {}) {
  const skip = 'input,textarea,select,option,form,[contenteditable],script,style,noscript,template,[hidden],[aria-hidden="true"],[data-private],[autocomplete]';
  const visible = node => {
    if (!node || node.closest(skip)) return false;
    if (!node.getClientRects().length) return false;
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  };
  const chunks = [];
  let length = 0;
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && length < maxTextChars) {
      const node = walker.currentNode;
      if (!visible(node.parentElement)) continue;
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text) { chunks.push(text); length += text.length + 1; }
    }
  }
  const links = [];
  for (const node of document.querySelectorAll('a[href]')) {
    if (links.length >= maxLinks) break;
    if (!visible(node) || node.hasAttribute('download')) continue;
    const title = node.innerText?.trim().slice(0, 160);
    if (title) links.push({ title, url: node.href });
  }
  // Only inspect presence, never values. Password/login/challenge UI is not captured.
  const password = [...document.querySelectorAll('input[type="password"]')].some(node => node.getClientRects().length > 0);
  const challenge = [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenge"],[id*="captcha"],[class*="captcha"]')].some(visible);
  const images = [];
  for (const [index, node] of [...document.images].entries()) {
    if (images.length >= 2) break;
    if (!visible(node) || !node.complete || node.naturalWidth < 280 || node.naturalHeight < 180) continue;
    if (!node.closest('article,main,[role="main"],.note-content,.note-detail,.note-container,.media-box,.feed-card')) continue;
    if (/avatar|profile|logo|icon|qr.?code|captcha/i.test(`${node.className} ${node.alt} ${node.currentSrc}`)) continue;
    const box = node.getBoundingClientRect();
    if (box.width >= 240 && box.height >= 160 && box.width <= 1800 && box.height <= 1800) images.push(index);
  }
  return { title: document.title.slice(0, 240), text: chunks.join('\n').slice(0, maxTextChars), links, images, password, challenge };
}

export function sanitizePageSnapshot(snapshot, url, { maxTextChars = 18000, maxLinks = 40, xContentReady } = {}) {
  const title = String(snapshot?.title || '').slice(0, 240);
  const text = String(snapshot?.text || '').slice(0, maxTextChars);
  const loginUrl = isXAuthenticationUrl(url) || /\/(?:login|signin|i\/flow\/login)(?:[/?]|$)/i.test(url);
  const loginText = /(?:登录后(?:查看|浏览|继续)|登录(?:即可|以)(?:查看|继续)|请先登录|扫码登录|账号密码登录|sign in to (?:continue|view)|log in to (?:continue|view)|sign in to x|join x today)/i.test(text);
  const challenge = Boolean(snapshot?.challenge) || /(?:verify (?:you are|you're) human|checking your browser|security verification|安全验证|访问过于频繁|完成验证|拖动滑块|人机验证)/i.test(text);
  const requiresLogin = Boolean(snapshot?.password) || loginUrl || loginText;
  const links = [];
  const seen = new Set();
  for (const entry of Array.isArray(snapshot?.links) ? snapshot.links : []) {
    if (links.length >= maxLinks) break;
    try {
      const safe = parsePublicUrl(String(entry?.url || '')).url.href;
      if (!seen.has(safe) && entry?.title) { seen.add(safe); links.push({ title: String(entry.title).slice(0, 160), url: safe }); }
    } catch { /* Do not show unsafe or credential-bearing anchors to the model. */ }
  }
  const result = { url, title, text, links, imagePaths: [], requiresLogin };
  if (requiresLogin || challenge) {
    result.text = requiresLogin ? '此页面需要人工登录后继续读取。' : '此页面要求人工完成安全验证。';
    result.links = [];
    result.blockedReason = requiresLogin ? 'login_required' : 'human_verification_required';
  } else if (xContentReady === false) {
    result.text = 'X 页面尚未出现可读取的帖子内容；未将导航或加载页面当作正文。';
    result.links = [];
    result.blockedReason = 'x_content_not_ready';
  } else if (text.trim().length < 30 && xContentReady !== true) result.blockedReason = 'no_readable_content';
  return result;
}

function validateProxy(proxy) {
  if (!proxy) return undefined;
  let parsed;
  try { parsed = new URL(typeof proxy === 'string' ? proxy : proxy.server); } catch { throw failure('浏览器代理必须是本机 HTTP 代理地址。'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw failure('浏览器代理必须是无凭证的本机 HTTP 代理地址。');
  return { server: parsed.origin, bypass: '<-loopback>' };
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink()) throw failure('浏览器数据目录不能是符号链接。');
  return realpath(path);
}

export function createBrowserReader(options = {}) {
  if (!options.profileDir || !options.screenshotDir || !isAbsolute(options.profileDir) || !isAbsolute(options.screenshotDir)) throw failure('浏览器 profileDir/screenshotDir 必须是独立的绝对路径。');
  const profileDir = resolve(options.profileDir);
  const screenshotDir = resolve(options.screenshotDir);
  if (profileDir === screenshotDir || profileDir.startsWith(screenshotDir + sep) || screenshotDir.startsWith(profileDir + sep)) throw failure('浏览器登录资料和截图必须使用分开的目录。');
  const proxy = validateProxy(options.proxy);
  const channel = options.channel || undefined;
  if (channel && !['msedge', 'chrome', 'chromium'].includes(channel)) throw failure('浏览器 channel 只支持 msedge、chrome 或 chromium。');
  if (options.executablePath && !isAbsolute(options.executablePath)) throw failure('浏览器可执行文件必须使用绝对路径。');
  const timeoutMs = boundedInteger(options.timeoutMs, 25000, 1000, 60000);
  const readNavigationScope = options.readNavigationScope;
  if (readNavigationScope && !['default', 'x'].includes(readNavigationScope)) throw failure('浏览器读取会话范围无效。');
  const wrongProfile = url => readNavigationScope && (isXBrowserUrl(url) !== (readNavigationScope === 'x'));
  const maxTextChars = boundedInteger(options.maxTextChars, 18000, 500, 30000);
  const maxLinks = boundedInteger(options.maxLinks, 40, 0, 80);
  const readonlyPostEndpoints = (options.readonlyPostEndpoints || []).map(endpoint => {
    const parsed = parsePublicUrl(endpoint).url;
    if (parsed.protocol !== 'https:' || parsed.search || parsed.hash || !['edith.xiaohongshu.com', 'www.xiaohongshu.com', 'x.com', 'api.x.com', 'twitter.com', 'api.twitter.com'].includes(parsed.hostname)) throw failure('只读 POST 白名单只支持平台 HTTPS 精确端点。');
    return parsed.origin + parsed.pathname;
  });
  const lookup = options.lookup || dnsLookup;
  let context = null;
  let page = null;
  let mode = 'closed';
  let busy = false;
  let lastBlockedReason = null;
  let requestBudget = 0;
  let actualChannel = null;
  let screenshotRoot = null;

  function usableContext() {
    if (!context) return false;
    try { return context.browser()?.isConnected() !== false; } catch { return false; }
  }
  function usablePage(candidate) { return Boolean(candidate && !candidate.isClosed()); }
  function status() {
    const running = usableContext();
    return { running, mode: running ? mode : 'closed', busy, channel: actualChannel, headed: mode === 'login' || options.headless !== true, proxyConfigured: Boolean(proxy), readonlyPostEndpointCount: readonlyPostEndpoints.length, lastBlockedReason };
  }
  async function locked(action) {
    if (busy) throw failure('浏览器正在处理另一个操作，请稍后重试。');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  async function closeContext() {
    const old = context;
    if (old) {
      try { await old.close(); }
      catch {
        let connected = true;
        try { connected = old.browser()?.isConnected() !== false; } catch { /* Unknown is not proof of a closed browser. */ }
        if (connected) throw failure('浏览器未能正常关闭；保留当前会话，停止切换登录资料。');
      }
    }
    if (context === old) { context = null; page = null; mode = 'closed'; }
  }
  async function launch(nextMode) {
    if (usableContext() && mode === nextMode) {
      try {
        if (!usablePage(page)) page = context.pages().find(usablePage) || await context.newPage();
        return;
      } catch { /* A window may close between its close event and this operation. Relaunch. */ }
    }
    await closeContext();
    await ensurePrivateDirectory(profileDir);
    screenshotRoot = await ensurePrivateDirectory(screenshotDir);
    let chromium;
    try { ({ chromium } = await (options.loadPlaywright ? options.loadPlaywright() : import('playwright-core'))); } catch { throw failure('缺少 playwright-core；请先在项目目录运行 npm install。'); }
    const channels = options.executablePath ? [null] : channel ? [channel] : ['msedge', 'chrome'];
    for (const candidate of channels) {
      try {
        context = await chromium.launchPersistentContext(profileDir, {
          ...(candidate && candidate !== 'chromium' ? { channel: candidate } : {}),
          ...(options.executablePath ? { executablePath: options.executablePath } : {}),
          headless: nextMode === 'login' ? false : options.headless === true,
          viewport: { width: 1280, height: 900 }, locale: 'zh-CN',
          acceptDownloads: false, serviceWorkers: 'block', permissions: [],
          offline: true, ...(proxy ? { proxy } : {}),
          args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-quic', '--disable-features=WebRtcHideLocalIpsWithMdns,Prerender2', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--no-default-browser-check']
        });
        actualChannel = candidate || (options.executablePath ? 'custom' : 'chromium');
        break;
      } catch { context = null; }
    }
    if (!context) throw failure('无法启动独立浏览器；请安装 Microsoft Edge/Google Chrome，或配置正确的浏览器路径。');
    mode = nextMode;
    const launchedContext = context;
    launchedContext.on('close', () => {
      if (context !== launchedContext) return;
      context = null; page = null; mode = 'closed';
    });
    try {
      if (typeof context.routeWebSocket !== 'function') throw failure('需要支持 routeWebSocket 的 playwright-core（至少 1.48）。');
      await context.routeWebSocket('**/*', async socket => {
        if (nextMode === 'read') return socket.close();
        try {
          // Human authentication may use WebSockets. Preserve them only in explicit
          // login mode, with the same public-host policy as ordinary requests.
          const address = new URL(socket.url());
          if (!['ws:', 'wss:'].includes(address.protocol)) throw failure('不支持的连接协议。');
          address.protocol = address.protocol === 'wss:' ? 'https:' : 'http:';
          await validatePublicUrl(address.href, { lookup, allowAccountActions: true });
          socket.connectToServer();
        } catch { await socket.close().catch(() => {}); }
      });
      await context.route('**/*', async route => {
        const request = route.request();
        try {
          if (context !== launchedContext) throw failure('浏览器已关闭。');
          if (nextMode === 'read') {
            if (++requestBudget > 350) throw failure('页面请求数量超过只读上限。');
            if (request.isNavigationRequest() && page && request.frame() === page.mainFrame() && wrongProfile(request.url())) throw failure('browser_profile_boundary');
            checkReadRequest(request.url(), { method: request.method(), resourceType: request.resourceType(), readonlyPostEndpoints });
            if (request.isNavigationRequest() && page && request.frame() !== page.mainFrame()) throw failure('只读模式已阻止内嵌页面导航。');
          }
          await validatePublicUrl(request.url(), { lookup, allowAccountActions: nextMode === 'login' });
          await route.continue();
        } catch (error) {
          if (nextMode === 'read' && request.isNavigationRequest()) lastBlockedReason = error.message === 'browser_profile_boundary' ? error.message : isXAuthenticationUrl(request.url()) ? 'login_required' : error.name === 'BrowserReadPolicyError' ? error.message : '页面导航被安全策略阻止。';
          await route.abort('blockedbyclient').catch(() => {});
        }
      });
      if (nextMode === 'read') await context.addInitScript(() => {
        for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
          try { Object.defineProperty(globalThis, key, { value: undefined, configurable: false }); } catch { /* Not exposed in every Chromium build. */ }
        }
        document.addEventListener('submit', event => event.preventDefault(), true);
      });
      const restoredPages = context.pages();
      context.on('page', opened => {
        opened.on('download', download => { download.cancel().catch(() => {}); });
        opened.on('close', () => {
          if (context === launchedContext && page === opened) page = launchedContext.pages().find(candidate => candidate !== opened && usablePage(candidate)) || null;
        });
        // Login popups/dialogs belong to the person at the keyboard, not to the
        // reader. Closing them here breaks OAuth and some verification flows.
        if (nextMode === 'read') {
          opened.on('dialog', dialog => { dialog.dismiss().catch(() => {}); });
          if (page && opened !== page) opened.close().catch(() => {});
        }
      });
      page = await context.newPage();
      // Keep one tab alive: a headed persistent browser may exit when its last
      // restored tab closes, before a replacement target can be created.
      for (const restored of restoredPages) await restored.close();
      await context.clearPermissions();
      await context.setOffline(false);
    } catch (error) { await closeContext(); throw error; }
  }

  async function readInternal(url) {
    if (mode === 'login') throw failure('人工登录模式正在进行；请先结束登录再让知微读取网页。');
    let validated;
    try { validated = await validatePublicUrl(url, { lookup }); } catch (error) { return { ...EMPTY(), requiresLogin: isXAuthenticationUrl(url), blockedReason: isXAuthenticationUrl(url) ? 'login_required' : error.message }; }
    if (wrongProfile(validated)) return { ...EMPTY(), blockedReason: 'browser_profile_boundary' };
    await launch('read');
    lastBlockedReason = null;
    requestBudget = 0;
    // A fresh tab prevents data from a previous site remaining visible after a failed navigation.
    const previous = page;
    page = null;
    try {
      page = await context.newPage();
      if (usablePage(previous)) await previous.close();
      await context.setOffline(false);
      await page.goto(validated, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: 3500 }).catch(() => {});
      const finalUrl = await validatePublicUrl(page.url(), { lookup });
      if (wrongProfile(finalUrl)) return { ...EMPTY(), blockedReason: 'browser_profile_boundary' };
      const target = xContentTarget(validated) || xContentTarget(finalUrl);
      let readiness;
      if (target) {
        try {
          const handle = await page.waitForFunction(inspectXReadiness, target, { polling: 100, timeout: Math.min(timeoutMs, 10000) });
          try { readiness = await handle.jsonValue(); } finally { await handle.dispose(); }
        } catch (error) { if (error.name !== 'TimeoutError') throw error; }
        // Recheck at capture time in case the loaded tweet disappeared again.
        if (readiness === 'ready') readiness = await page.evaluate(inspectXReadiness, target);
      }
      const snapshot = await page.evaluate(extractVisibleDocument, { maxTextChars, maxLinks });
      if (readiness === 'login_required') snapshot.password = true;
      if (readiness === 'human_verification_required') snapshot.challenge = true;
      const result = sanitizePageSnapshot(snapshot, finalUrl, { maxTextChars, maxLinks, ...(target ? { xContentReady: readiness === 'ready' } : {}) });
      if (!result.blockedReason) {
        const saveScreenshot = async (name, png) => {
          const path = join(screenshotRoot, name);
          if ((await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))?.isSymbolicLink()) throw failure('快照路径不能是符号链接。');
          await writeFile(path, png, { mode: 0o600, flag: 'w' });
          result.imagePaths.push(path);
        };
        // Always use a fixed file name inside the configured directory. Mask form fields
        // even if populated by a password manager or a user in the separate login session.
        const png = await page.screenshot({ fullPage: false, type: 'png', animations: 'disabled', timeout: 5000, mask: [page.locator(PRIVATE_DOM_SELECTOR)], maskColor: '#242424' });
        await saveScreenshot('page-1.png', png);
        for (const [index, imageIndex] of (snapshot.images || []).slice(0, 2).entries()) {
          if (!Number.isSafeInteger(imageIndex) || imageIndex < 0) continue;
          try {
            const image = page.locator('img').nth(imageIndex);
            const png = await image.screenshot({ type: 'png', animations: 'disabled', timeout: 3000 });
            await saveScreenshot(`image-${index + 1}.png`, png);
          } catch { /* A lazy image disappearing must not discard readable text. */ }
        }
      }
      return result;
    } catch (error) {
      const blockedReason = lastBlockedReason || (isXAuthenticationUrl(page?.url()) ? 'login_required' : error.name === 'BrowserReadPolicyError' ? error.message : '网页读取失败或超时；可能需要人工登录、验证码或站点不支持此读取方式。');
      return { ...EMPTY(), url: validated, requiresLogin: blockedReason === 'login_required', blockedReason };
    } finally { if (context && mode === 'read') await context.setOffline(true).catch(() => {}); }
  }

  return Object.freeze({
    status,
    start: () => locked(async () => { if (mode === 'login') throw failure('请先结束人工登录模式。'); await launch('read'); return status(); }),
    read: url => locked(() => readInternal(url)),
    search: (query, { platform = 'web' } = {}) => locked(async () => {
      if (typeof query !== 'string' || !query.trim() || query.length > 500) throw failure('搜索词须为 1–500 个字符。');
      const q = encodeURIComponent(query.trim());
      const url = platform === 'x' || platform === 'twitter' ? `https://x.com/search?q=${q}&src=typed_query&f=live` : platform === 'xiaohongshu' || platform === 'xhs' ? `https://www.xiaohongshu.com/search_result?keyword=${q}&source=web_search_result_notes` : platform === 'web' ? `https://www.bing.com/search?q=${q}` : null;
      if (!url) throw failure('不支持的搜索平台。');
      return readInternal(url);
    }),
    openLogin: platform => locked(async () => {
      const url = LOGIN_URLS[String(platform || '').toLowerCase()];
      if (!url) throw failure('人工登录只支持 x/twitter 或 xiaohongshu/xhs。');
      await validatePublicUrl(url, { lookup, allowAccountActions: true });
      await launch('login');
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }); }
      catch (error) {
        if (usableContext() && usablePage(page)) throw error;
        await closeContext();
        await launch('login');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      }
      return { ...status(), platform, message: '请在独立浏览器窗口中手动登录。此时自主阅读已暂停；完成后调用 finishLogin。' };
    }),
    finishLogin: () => locked(async () => { await closeContext(); await launch('read'); return status(); }),
    close: () => locked(async () => { await closeContext(); return status(); })
  });
}
