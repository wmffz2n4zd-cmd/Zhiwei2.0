import { constants } from 'node:fs';
import { access, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const sourceLimit = 64 * 1024;
const wireLimit = 4 * 1024 * 1024;
const maxClicks = 4;
const clickId = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const policy = "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; connect-src 'none'; " +
  "style-src 'unsafe-inline'; script-src 'unsafe-inline'; worker-src 'none'; img-src data:; media-src 'none'";
const attr = text => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const unattr = text => text.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
const outer = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<meta http-equiv="Content-Security-Policy" content="' + policy + '; frame-src about:">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">' +
  '<title>知微的网页作品</title><style>html,body,iframe{display:block;margin:0;border:0;width:100%;height:100%}</style>' +
  '</head><body><iframe title="网页作品" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="';
const inner = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + '; frame-src \'none\'">';
const tail = '"></iframe></body></html>';

function sourceText(html) {
  if (typeof html !== 'string' || html.length > 6 * sourceLimit) throw Error('网页源码过大或格式无效');
  // Reopening an exported artifact runs the same frame at the same depth.
  const prefix = outer + attr(inner);
  if (html.startsWith(prefix) && html.endsWith(tail)) {
    const recovered = unattr(html.slice(prefix.length, -tail.length));
    if (prefix + attr(recovered) + tail === html) html = recovered;
  }
  if (!html.trim() || html.includes('\0') || Buffer.byteLength(html) > sourceLimit) throw Error('网页源码过大或格式无效');
  return html;
}

export function buildCreativeProgramDocument(html) {
  return outer + attr(inner + sourceText(html)) + tail;
}

function validate(input) {
  const html = sourceText(input?.html);
  if (!Array.isArray(input.clicks) || input.clicks.length < 1 || input.clicks.length > maxClicks ||
      !input.clicks.every(id => typeof id === 'string' && clickId.test(id))) throw Error('请为网页提供一至四个有效的点击目标 ID');
  return { html, clicks: input.clicks };
}

function responseLine(stream, limit, signal) {
  return new Promise((resolve, reject) => {
    let count = 0;
    const parts = [];
    const done = (err, value) => {
      stream.off('data', onData).off('error', onError).off('end', onEnd).off('close', onEnd);
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(value);
    };
    const onAbort = () => done(signal.reason);
    const onEnd = () => done(Object.assign(Error('独立网页运行器中断'), {code:'ECONNRESET'}));
    const onError = err => done(Object.assign(Error('无法连接独立网页运行器'), {code:err.code}));
    const onData = bytes => {
      count += bytes.length;
      if (count > limit) return done(Error('独立网页运行器数据超过限制'));
      const end = bytes.indexOf(10);
      if (end < 0) { parts.push(bytes); return; }
      parts.push(bytes.subarray(0, end));
      try { done(null, JSON.parse(Buffer.concat(parts).toString('utf8'))); }
      catch { done(Error('独立网页运行器数据无效')); }
    };
    stream.on('data', onData).once('error', onError).once('end', onEnd).once('close', onEnd);
    signal.addEventListener('abort', onAbort, { once:true });
    if (signal.aborted) onAbort();
  });
}

// systemd may still be releasing the previous one-connection worker after it
// has sent its last byte. Retry *only* the readiness handshake, never a job.
async function connectWorker(path, signal) {
  let backoff = 50;
  for (;;) {
    signal.throwIfAborted();
    const socket = createConnection({path});
    try {
      const hello = responseLine(socket, 160, signal);
      socket.write('{"hello":1}\n');
      if ((await hello)?.ready !== true) throw Error('独立网页运行器未就绪');
      return socket;
    } catch (error) {
      socket.destroy();
      if (!['ECONNRESET','EPIPE'].includes(error.code)) throw error;
      await delay(backoff, undefined, {signal});
      backoff = Math.min(500, backoff * 2);
    }
  }
}

const queues = new Map();

function enqueue(path, signal, run) {
  return new Promise((resolve, reject) => {
    const queue = queues.get(path) || {active:false, waiting:[]};
    queues.set(path, queue);
    const next = () => {
      if (queue.active) return;
      const start = queue.waiting.shift();
      if (!start) { queues.delete(path); return; }
      queue.active = true;
      start();
    };
    const cancel = () => {
      queue.waiting.splice(queue.waiting.indexOf(start), 1);
      reject(signal.reason);
    };
    const start = () => {
      signal?.removeEventListener('abort', cancel);
      run().then(resolve, reject).finally(() => { queue.active = false; next(); });
    };
    signal?.addEventListener('abort', cancel, {once:true});
    queue.waiting.push(start);
    next();
  });
}

// The private reply process never starts a browser with its own data or identity.
export async function runCreativeProgram(input, options = {}) {
  const job = validate(input);
  options.signal?.throwIfAborted();
  const path = options.socketPath || process.env.ZHIWEI_CREATIVE_RUNNER_SOCKET || '/run/zhiwei-creative/program.sock';
  return enqueue(path, options.signal, () => sendJob(job, path, options.signal));
}

async function sendJob(job, path, caller) {
  const deadline = ms => caller ? AbortSignal.any([caller, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  const socket = await connectWorker(path, deadline(32000));
  try {
    caller?.throwIfAborted();
    const result = responseLine(socket, wireLimit, deadline(35000));
    socket.write(JSON.stringify(job) + '\n');
    const data = await result;
    if (data?.error) throw Error(String(data.error).slice(0, 360));
    if (!Array.isArray(data?.observations) || data.observations.length > job.clicks.length + 1 || !Array.isArray(data.errors) ||
        (!data.observations.length && !data.errors.length)) throw Error('独立网页运行器观测无效');
    const observations = data.observations.map((row, index) => {
      if (!row || row.action !== (index ? job.clicks[index-1] : null) || typeof row.text !== 'string' ||
          !Array.isArray(row.samples) || typeof row.screenshot !== 'string') throw Error('独立网页运行器观测无效');
      const screenshot = Buffer.from(row.screenshot, 'base64');
      if (screenshot.length < 4 || screenshot[0] !== 0xff || screenshot[1] !== 0xd8 ||
          screenshot.at(-2) !== 0xff || screenshot.at(-1) !== 0xd9) throw Error('独立网页运行器截图无效');
      return { ...row, screenshot };
    });
    return { observations, errors:data.errors.map(message => String(message).slice(0, 420)) };
  } finally {
    socket.destroy();
  }
}

// A document can also stall after DOMContentLoaded, including between a click
// and a style read. The deadline runs in the trusted worker, outside its renderer.
async function inspectWithin(frame) {
  let timer;
  try {
    return await Promise.race([frame.evaluate(inspectView), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('读取页面超时')), 2400);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertWorkerIsolation() {
  if (process.platform !== 'linux' || !process.getuid?.() || process.getuid() === 0) throw Error('网页运行器缺少独立 Linux 身份');
  const status = await readFile('/proc/self/status', 'utf8');
  const net = await readFile('/proc/net/dev', 'utf8');
  const interfaces = [...net.matchAll(/^\s*([^:\s]+):/gm)].map(match => match[1]);
  if (!/^NoNewPrivs:\s*1$/m.test(status) || !/^CapEff:\s*0+$/m.test(status) || !/^CapBnd:\s*0+$/m.test(status) ||
      interfaces.length !== 1 || interfaces[0] !== 'lo') throw Error('网页运行器需要无外网、无特权的独立服务');
  for (const path of ['/home/zhiwei', '/opt/zhiwei/shared', '/opt/zhiwei/backups', '/opt/zhiwei/operations']) {
    if (await readdir(path).then(() => true, () => false)) throw Error('网页运行器仍可访问业务资料目录');
  }
  if (await access('/proc/1/environ', constants.R_OK).then(() => true, () => false)) throw Error('网页运行器仍可读取其他进程环境');
  // The supplied unit uses an empty root with a read-only browser, Node and
  // runtime libraries. Refuse an ordinary host filesystem with a hidden home.
  const marker = await lstat('/.zhiwei-offline-worker').catch(() => null);
  if (!marker?.isFile() || marker.uid !== 0 || marker.mode & 0o022) throw Error('网页运行器缺少专用根文件系统');
}

function inspectView() {
  const body = document.body;
  if (!body) return { text:'', samples:[] };
  const samples = [];
  const rgba = value => {
    const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?\)$/.exec(value);
    return match && [Number(match[1]),Number(match[2]),Number(match[3]),Number(match[4] ?? 1)];
  };
  const over = (fg,bg) => fg.slice(0,3).map((v,i) => v*fg[3] + bg[i]*(1-fg[3]));
  const luminance = rgb => rgb.reduce((sum,value,i) => {
    const c = value/255;
    return sum + [0.2126,0.7152,0.0722][i]*(c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4);
  },0);
  const walker = document.createTreeWalker(body,NodeFilter.SHOW_ELEMENT);
  let count = 0;
  for (let el = body; el && samples.length < 24 && ++count <= 600; el = walker.nextNode()) {
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!rect.width || !rect.height || style.visibility !== 'visible' || !el.checkVisibility({checkOpacity:true})) continue;
    const text = Array.from(el.childNodes).filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent).join(' ').replace(/\s+/g,' ').trim().slice(0,140);
    if (!text) continue;
    const layers = [];
    let approximate = true;
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
      const computed = getComputedStyle(ancestor);
      if (computed.backgroundImage !== 'none' || computed.opacity !== '1' || computed.mixBlendMode !== 'normal') approximate = false;
      const color = rgba(computed.backgroundColor);
      if (!color) { approximate = false; break; }
      layers.push(color);
      if (color[3] === 1) break;
    }
    const bg = layers.reverse().reduce((base,layer) => over(layer,base), [255,255,255]);
    const fg = rgba(style.color);
    const values = fg && [luminance(bg),luminance(over(fg,bg))].sort((a,b)=>a-b);
    const contrast = approximate && values ? Number(((values[1]+0.05)/(values[0]+0.05)).toFixed(2)) : null;
    samples.push({ tag:el.localName, id:el.id.slice(0,64), text, color:style.color,
      background:approximate ? 'rgb('+bg.map(Math.round).join(', ')+')' : null, contrast });
  }
  return { text:body.innerText.trim().slice(0,1600), samples };
}

async function executeBrowser({html,clicks}, signal) {
  await assertWorkerIsolation();
  const executablePath = process.env.CREATIVE_PROGRAM_BROWSER;
  if (!executablePath || !isAbsolute(executablePath)) throw Error('离线服务缺少浏览器可执行路径');
  const { chromium } = await import('playwright-core');
  const home = await mkdtemp(join(tmpdir(), 'creative-browser-'));
  let browser;
  const abort = () => { void browser?.close().catch(() => {}); };
  const errors = [], observations = [];
  const record = value => {
    const message = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0,320);
    if (message && errors.length < 8 && !errors.includes(message)) errors.push(message);
  };
  try {
    signal.throwIfAborted();
    // The service's empty read-only root, private network, separate identity,
    // limits and per-connection lifetime are mandatory even on kernels where
    // Chromium cannot create its optional nested user namespace.
    browser = await chromium.launch({ executablePath, headless:true, timeout:6000, chromiumSandbox:false,
      env:{HOME:home,TMPDIR:home,PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},
      args:['--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions',
        '--disable-breakpad','--disable-dev-shm-usage','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--no-first-run','--no-default-browser-check','--js-flags=--max-old-space-size=128'] });
    signal.addEventListener('abort', abort, {once:true});
    signal.throwIfAborted();
    const ctx = await browser.newContext({ viewport:{width:864,height:640}, deviceScaleFactor:1, locale:'zh-CN',
      offline:true, acceptDownloads:false, serviceWorkers:'block', permissions:[], reducedMotion:'reduce' });
    await ctx.routeWebSocket('**/*', socket => socket.close());
    const page = await ctx.newPage();
    const url = 'http://creative.invalid/';
    let delivered = false;
    await ctx.route('**/*', async route => {
      const request = route.request();
      if (!delivered && request.isNavigationRequest() && request.frame() === page.mainFrame() && request.url() === url) {
        delivered = true;
        await route.fulfill({contentType:'text/html; charset=utf-8',body:buildCreativeProgramDocument(html)});
      } else await route.abort().catch(() => {});
    });
    page.on('pageerror', error => record(error.message));
    page.on('console', msg => { if (msg.type() === 'error') record(msg.text()); });
    page.on('dialog', dialog => { record('网页尝试打开对话框'); void dialog.dismiss().catch(() => {}); });
    page.on('crash', () => record('网页渲染进程终止'));
    page.setDefaultTimeout(2000);
    try {
      await page.goto(url, {waitUntil:'domcontentloaded', timeout:3500});
      const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
      if (!frame) throw Error('无法打开隔离网页');
      const observe = async action => {
        await page.waitForTimeout(120);
        const view = await inspectWithin(frame);
        const screenshot = await page.screenshot({type:'jpeg',quality:68,animations:'disabled',timeout:2400});
        observations.push({action,...view,screenshot:screenshot.toString('base64')});
      };
      await observe(null);
      for (const id of clicks) {
        signal.throwIfAborted();
        try { await frame.locator('[id="'+id+'"]').click({timeout:1500}); }
        catch { record('无法点击可见且唯一的控件 #'+id); break; }
        await observe(id);
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!delivered) throw error;
      record(error.name === 'TimeoutError' || error.message === '读取页面超时' ?
        '网页运行超时，未能完成加载或交互；请检查阻塞页面的脚本后重试' : '网页未能完成渲染或交互观测');
    }
    return {observations,errors};
  } finally {
    signal.removeEventListener('abort', abort);
    // The supervisor kills the entire per-request service on worker exit, even
    // for a renderer that no longer answers Chromium's graceful shutdown.
    if (browser) await Promise.race([browser.close().catch(() => {}), delay(1200, undefined, {ref:false})]);
    await rm(home, {force:true,recursive:true}).catch(() => {});
  }
}

async function handleWorker() {
  const gone = new AbortController();
  const signal = AbortSignal.any([gone.signal,AbortSignal.timeout(24500)]);
  let result;
  try {
    let request = await responseLine(process.stdin, 8*sourceLimit, signal);
    if (request?.hello === 1) {
      process.stdout.write('{"ready":true}\n');
      request = await responseLine(process.stdin, 8*sourceLimit, signal);
    }
    const job = validate(request);
    process.stdin.once('end', () => gone.abort()).once('error', () => gone.abort()).resume();
    result = await executeBrowser(job, signal);
  } catch (error) {
    result = {error: String(error.message || '离线网页运行失败').slice(0,360)};
  }
  process.stdout.on('error', () => process.exit(1));
  process.stdout.end(JSON.stringify(result) + '\n', () => process.exit(0));
  process.stdin.destroy();
}

if (process.argv[2] === '--worker' && process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await handleWorker();
}
