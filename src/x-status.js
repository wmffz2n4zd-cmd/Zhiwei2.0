/**
 * Read only the visible author content of the status shown at the requested URL.
 * May be passed directly to page.evaluate. Query parameters cannot change the target.
 */
export function inspectXStatus({statusId: id, mode = 'wait', imageIndex = 0, maxTextChars = 18000, maxLinks = 40}) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const routeId = input => {
    try {
      const url = new URL(input, location.href);
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/i.test(url.hostname)) return null;
      return /^\/(?:[^/]+|i\/web)\/status\/(\d+)(?:\/(?:photo|video)\/[1-4])?\/?$/.exec(url.pathname)?.[1] || null;
    } catch {return null;}
  };
  const visible = element => {
    if (!element || !element.getClientRects().length || element.closest('[hidden],[aria-hidden="true"]')) return false;
    for (let el = element; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || /hidden|collapse/.test(style.visibility) || style.opacity === '0') return false;
    }
    return true;
  };
  const empty = reason => mode === 'image' ? null : mode === 'wait' ? false : {reason};
  const visibleSelector = selector => [...document.querySelectorAll(selector)].some(visible);
  const bodyText = document.body?.innerText || '';
  if (visibleSelector('iframe[src*="captcha"],iframe[src*="challenge"],[id*="captcha"],[class*="captcha"]') ||
      /verify (?:you are|you're) human|checking your browser|security verification|安全验证|访问过于频繁|完成验证|人机验证/i.test(bodyText)) {
    return mode === 'image' ? null : {reason:'human_verification_required'};
  }
  if (/^\/(?:login|signin|i\/(?:flow|jf))(?:\/|$)/.test(location.pathname) ||
      visibleSelector('input[type="password"],input[autocomplete="username"],input[autocomplete="current-password"]') ||
      /登录后(?:查看|浏览|继续)|请先登录|扫码登录|sign in to x|join x today/i.test(bodyText)) {
    return mode === 'image' ? null : {reason:'login_required'};
  }
  if (!clean(bodyText)) return empty('empty_shell');

  if (!/^\d+$/.test(id) || routeId(location.href) !== id) return empty('different_status');
  const primary = document.querySelector('[data-testid="primaryColumn"]');
  if (!primary) return empty('target_not_rendered');
  const articleSel = 'article[data-testid="tweet"]';
  for (const article of primary.querySelectorAll(articleSel)) {
    if (!visible(article)) continue;
    // Quoted posts may place tweetText inside a nested article or a role=link card.
    const own = element => {
      if (!visible(element) || element.closest(articleSel) !== article ||
          element.isContentEditable || element.closest('form,input,textarea,select,option,[autocomplete],[data-private],script,style,template,button,[role="button"]')) return false;
      const card = element.closest('[data-testid="quoteTweet"],[data-testid="card.wrapper"],[role="link"]:not(a)');
      return (!card || card === article || !article.contains(card)) && !element.closest('[data-testid="embeddedTweet"]');
    };
    const timeLinks = [...article.querySelectorAll('a[href]')].filter(link => {
      const time = link.querySelector('time');
      return own(link) && time && own(time);
    });
    if (timeLinks.length === 0 || timeLinks.some(link => routeId(link.href) !== id)) continue;
    const photos = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')].filter(own);
    const loadedPhotos = photos.filter(photo => {
      const rect = photo.getBoundingClientRect();
      return photo.complete && photo.naturalWidth > 0 && rect.width > 0 && rect.height > 0 && rect.width <= 1800 && rect.height <= 1800;
    });
    if (mode === 'image') return loadedPhotos[imageIndex] || null;
    const blocks = [...article.querySelectorAll('[data-testid="tweetText"]')].filter(own);
    // On status pages X renders Articles in a separate title and rich-text surface.
    const longform = [...article.querySelectorAll('[data-testid="twitterArticleReadView"]')].find(own);
    const articleTitle = [...article.querySelectorAll('[data-testid="twitter-article-title"]')].find(own);
    const articleBody = [...article.querySelectorAll('[data-testid="twitterArticleRichTextView"]')].find(own);
    const textFrom = block => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const pieces = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (own(node.parentElement)) {
          const value = clean(node.textContent);
          if (value) pieces.push(value);
        }
      }
      return pieces.join(' ');
    };
    // X Articles can display a title and hero photo before laying out their body.
    // A read-only rich-text renderer may itself declare contenteditable="false".
    if (longform || articleTitle || articleBody) {
      const content = articleBody && textFrom(articleBody);
      if (!content) return empty('article_body_not_rendered');
      blocks.length = 0;
      if (articleTitle) blocks.push(articleTitle);
      blocks.push(articleBody);
      if (mode === 'wait') return {reason:'ready'};
    }
    const captions = [...new Set(photos.map(photo => clean(photo.alt).slice(0,1000)).filter(caption =>
      caption && !/^(?:image|photo(?:graph)?|picture|画像|图(?:片|像)|圖片|照片|gif)(?:\s*\d+)?[.!。]?$/i.test(caption)))].slice(0,4);
    if (mode === 'wait') {
      return blocks.some(block => !!clean(block.innerText)) || captions.length || loadedPhotos.length ? {reason:'ready'} : false;
    }
    const text = clean(blocks.map(textFrom).filter(Boolean).join(' ')).slice(0, maxTextChars);
    const links = [];
    for (const block of blocks) {
      for (const link of block.querySelectorAll('a[href]')) {
        if (links.length >= maxLinks) break;
        if (own(link) && !link.hasAttribute('download') && clean(link.innerText)) links.push({url:link.href,title:clean(link.innerText).slice(0,160)});
      }
    }
    return {id, reason:text || captions.length || loadedPhotos.length ? 'ready' : 'no_author_text_or_caption',
      text, captions, links, imageCount:Math.min(2, loadedPhotos.length)};
  }
  return empty('target_not_rendered');
}
