import { inspectXStatus } from './x-status.js';
import { publicPageLink } from './chat-retrieval-http.js';

// Render only the bytes returned by the anonymous, address-pinned reader.
// Each document gets a fresh browser; it receives no cookies or network access.
export function createPrivatePageRenderer({ executablePath, channel = 'msedge' } = {}) {
  let tail = Promise.resolve();
  async function render(response, signal, statusId) {
    signal.throwIfAborted();
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ headless: true, timeout: 3500,
      ...(executablePath ? { executablePath } : { channel }),
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions'] });
    const stop = () => { void browser.close().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      signal.throwIfAborted();
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', offline: true,
        acceptDownloads: false, permissions: [] });
      const page = await context.newPage();
      let delivered = false;
      await context.route('**/*', async route => {
        const request = route.request();
        if (delivered || request.url() !== response.url || !request.isNavigationRequest()
          || request.frame() !== page.mainFrame()) return route.abort();
        delivered = true;
        await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-src 'none'" }, body: response.body });
      });
      await page.goto(response.url, { waitUntil: 'domcontentloaded', timeout: 2500 });
      if (page.url() !== response.url || !delivered) return null;
      let view;
      if (statusId) {
        const post = await page.evaluate(inspectXStatus, { statusId, mode: 'snapshot', maxTextChars: 12000, maxLinks: 24 });
        if (post?.reason !== 'ready' || post.id !== statusId) return {
          text: '', links: [], password: post?.reason === 'login_required', restricted: post?.reason === 'human_verification_required' };
        view = { text: [post.text, ...(post.captions || [])].filter(Boolean).join('\n'), anchors: post.links };
      } else view = await page.evaluate(() => {
        const visible = element => {
          if (!element || !element.getClientRects().length || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
          for (let el = element; el; el = el.parentElement) {
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') return false;
          }
          return true;
        };
        const main = [...document.querySelectorAll('article,main,[role="main"]')].find(visible) || document.body;
        const anchors = [];
        for (const el of main.querySelectorAll('a[href]')) {
          if (!visible(el) || el.closest('nav,header,footer,form') || el.hasAttribute('download')) continue;
          const title = (el.innerText || el.getAttribute('aria-label') || el.querySelector('img')?.alt || '').trim().replace(/\s+/g, ' ').slice(0, 140);
          if (title && el.href.length <= 2048) anchors.push({ title, url: el.href });
          if (anchors.length >= 160) break;
        }
        return { text: main.innerText.trim().slice(0, 12000), anchors,
          password: [...document.querySelectorAll('input[type="password"]')].some(visible) };
      });
      const links = [], seen = new Set([response.url]);
      for (const anchor of view.anchors) {
        const url = publicPageLink(anchor.url, { observed: true });
        const title = anchor.title.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 140);
        if (!url || !title || seen.has(url)) continue;
        seen.add(url); links.push({ title, url });
        if (links.length === 24) break;
      }
      return { text: view.text, links, password: view.password, ...(statusId ? { statusId } : {}) };
    } finally {
      signal.removeEventListener('abort', stop);
      await browser.close().catch(() => {});
    }
  }
  return async (response, { signal, statusId }) => {
    // Bound this optional rendering step separately from the article GET.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(6500)]);
    let started = false;
    const next = tail.then(() => { deadline.throwIfAborted(); started = true; return render(response, deadline, statusId); });
    tail = next.catch(() => {});
    // An expired queue entry will be skipped when the previous browser closes.
    let abort;
    try {
      return await Promise.race([next, new Promise((_, reject) => {
        abort = () => reject(deadline.reason);
        deadline.addEventListener('abort', abort, { once: true });
        if (deadline.aborted) abort();
      })]);
    } finally {
      deadline.removeEventListener('abort', abort);
      if (started && deadline.aborted) await next.catch(() => {});
    }
  };
}
