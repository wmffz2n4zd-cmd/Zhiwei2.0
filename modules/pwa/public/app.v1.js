const $ = (id) => document.getElementById(id);
const state = { user: null, csrf: '', me: null, generation: 0, verification: 0, messages: new Map(), pending: new Map(), attachments: [], replyTo: null, readSeq: 0, hasMore: false, stream: null, syncing: false, sending: false, uploading: false, sw: null, waiting: null, invite: '', reset: '', toastTimer: null, draftTimer: null, retryTimer: null, references: new Map(), referenceRequests: new Map(), preparing: false, search: { cursor: null, request: 0, query: null }, stickers: { view: 'favourites', request: 0, loading: false, cursor: null } };
const attachmentLimit = 4;
const attachmentCount = document.createElement('p');
attachmentCount.className = 'attachment-count';
attachmentCount.setAttribute('aria-live', 'polite');
$('attachments').before(attachmentCount);
let attachmentNotice = '';
const uploadTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const previewUrls = new Map();
let activeAttachmentUpload = null;
const incompleteAttachments = () => state.attachments.some(media => !safeId(media.id));
const transientCodes = new Set([408, 425, 429, 500, 502, 503, 504]);
const own = (m) => m.speaker === 'user' || ['in', 'inbound', 'user'].includes(m.direction);
const highestSeq = () => Math.max(0, ...[...state.messages.values()].map(m => Number(m.seq) || 0));
const atBottom = () => $('timeline').scrollHeight - $('timeline').scrollTop - $('timeline').clientHeight < 100;
const canChat = () => !!state.user && state.user.active !== false && state.me?.capabilities?.chat !== false;
const canRead = () => !!state.user && state.user.active !== false && !state.me?.pendingBinding;
const canReadSpace = () => !!state.user && state.user.active !== false && state.me?.capabilities?.space === true;
let spaceRequest = 0, spaceBefore = null, spaceSessionTimer;
let commentThread = null;
const commentDraftPrefix = 'zhiwei-space-comment:';
const commentDrafts = new Map();
const mediaUrl = (id) => `/api/pwa/media/${encodeURIComponent(id)}`;
const safeId = (id) => typeof id === 'string' && id.length > 0 && id.length < 200;
function toast(text) { for (const [dialog, status] of [['context-dialog','context-status'],['history-dialog','history-status'],['sticker-dialog','sticker-status']]) if ($(dialog)?.open) { $(status).textContent = text; break; } clearTimeout(state.toastTimer); $('toast').textContent = text; $('toast').hidden = false; state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
function friendly(error) {
  if (!navigator.onLine || error?.name === 'TypeError' || error?.name === 'AbortError') return '暂时连不上，消息会保留在待发区。';
  if (error?.status === 401) return '登录已过期，请重新登录。';
  if (error?.status === 403) return '当前操作不可用，请刷新登录状态后重试。';
  if (error?.status === 404) return '引用或图片已不可用，可修改后再发，或取消这条待发消息。';
  if (error?.status === 409) return '消息状态有冲突，请保持原条目并联系管理员核对。';
  if (error?.status === 413) return '图片或消息太大，请缩小后重试。';
  if (error?.status === 415) return '暂不支持这个图片格式，请选择 JPG、PNG、GIF 或 WebP。';
  if (error?.status === 429) return '操作有点快，请稍后再试。';
  if (error?.status >= 500) return '服务暂时没能保存，请稍后重试。';
  return '操作未完成，请检查输入后再试。';
}
async function api(path, { method = 'GET', body, raw = false, headers = {}, signal } = {}) {
  const requestHeaders = { 'X-PWA-Request': '1', ...headers };
  if (method !== 'GET' && state.csrf) requestHeaders['X-CSRF-Token'] = state.csrf;
  if (body !== undefined && !raw) requestHeaders['Content-Type'] = 'application/json';
  const controller = signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), raw ? 60000 : 25000) : null;
  try {
    const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: requestHeaders, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: signal || controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error('request_failed'); error.status = response.status; error.code = data.error?.code || data.error; throw error; }
    return data;
  } finally { clearTimeout(timer); }
}
function openDraftDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('zhiwei-private-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function draftOperation(mode, operation) {
  const db = await openDraftDb();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', mode); const request = operation(tx.objectStore('drafts'));
    tx.oncomplete = () => resolve(request?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
async function saveDraft() {
  if (!state.user) return false;
  const accountId = state.user.id; const generation = state.generation;
  const draft = { text: $('composer').value, attachments: state.attachments.map(media => media.file
    ? { file: media.file, error: media.error || '上次上传未完成。' } : { id: media.id }), replyTo: state.replyTo, pending: [...state.pending.values()].map(({ sending, ...m }) => m) };
  try { await draftOperation('readwrite', store => generation === state.generation && state.user?.id === accountId ? store.put(draft, accountId) : undefined); return generation === state.generation && state.user?.id === accountId; }
  catch {
    if (generation === state.generation && state.user?.id === accountId) {
      $('composer-status').textContent = '设备未允许保存待发草稿，请允许网站储存后重试；暂未提交新消息。';
    }
    return false;
  }
}
async function restoreDraft() {
  const generation = state.generation;
  try {
    const accountId = state.user.id;
    const draft = await draftOperation('readwrite', store => {
      if (generation !== state.generation || state.user?.id !== accountId) return;
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        if (generation !== state.generation || state.user?.id !== accountId) return;
        for (const key of keys.result) if (key !== accountId) store.delete(key);
      };
      return store.get(accountId);
    });
    if (generation !== state.generation || !draft) return;
    $('composer').value = typeof draft.text === 'string' ? draft.text.slice(0, 16000) : '';
    state.attachments = (Array.isArray(draft.attachments) ? draft.attachments : []).slice(0, attachmentLimit).flatMap(media => {
      if (safeId(media?.id)) return [{ id: media.id }];
      if (media?.file instanceof File && !fileProblem(media.file)) {
        return [{ file: media.file, status: 'failed', error: media.error || '上次上传未完成。' }];
      }
      return [];
    });
    state.replyTo = safeId(draft.replyTo) ? draft.replyTo : null;
    for (const p of draft.pending || []) if (safeId(p.clientMessageId) && typeof p.text === 'string' && Array.isArray(p.mediaIds)) state.pending.set(p.clientMessageId, { ...p, sending: false });
    renderComposer(); renderPending(); resizeComposer();
  } catch { /* A private draft is optional; never replace server history with local data. */ }
}
async function clearDrafts() { clearTimeout(state.draftTimer); try { await draftOperation('readwrite', store => store.clear()); } catch { /* DOM is still cleared below. */ } }
function scheduleDraft() { clearTimeout(state.draftTimer); state.draftTimer = setTimeout(saveDraft, 200); }
function disconnectStream() { state.stream?.close(); state.stream = null; clearTimeout(state.retryTimer); }
function clearPrivateUi({ keepCommentDraftsFor = null } = {}) {
  clearSpace();
  clearCommentDrafts(keepCommentDraftsFor);
  activeAttachmentUpload?.controller.abort();
  activeAttachmentUpload = null;
  for (const url of previewUrls.values()) URL.revokeObjectURL(url);
  previewUrls.clear();
  attachmentNotice = ''; attachmentCount.textContent = ''; $('composer-status').textContent = '';
  state.generation++; disconnectStream(); state.messages.clear(); state.pending.clear(); state.attachments = []; state.replyTo = null; state.readSeq = 0; state.hasMore = false;
  state.user = null; state.me = null; state.csrf = ''; state.sending = false; state.syncing = false; state.uploading = false;
  $('space-open').hidden = true;
  $('messages').replaceChildren(); $('pending-messages').replaceChildren(); $('attachments').replaceChildren(); $('composer').value = '';
  $('reply-preview').hidden = true; $('chat-app').hidden = true; $('gate').hidden = false; $('settings-dialog').close(); closeFeatureDialogs();
  clearFeatureUi();
  $('account-name').textContent = ''; $('password').value = ''; $('unread-jump').hidden = true;
}
function showLogin(message = '') {
  $('gate').hidden = false; $('chat-app').hidden = true; $('auth-form').hidden = false; $('gate-retry').hidden = true;
  $('gate-copy').textContent = state.reset ? '设置一个新密码，其他设备的旧登录将失效。' : state.invite ? '欢迎你。先给自己建一个账号。' : '回来啦，登录后继续聊。';
  $('username-field').hidden = !!state.reset; $('username').required = !state.reset; $('username-help').hidden = !state.invite;
  $('display-name-field').hidden = !state.invite; $('display-name').required = !!state.invite;
  $('password').autocomplete = state.invite || state.reset ? 'new-password' : 'current-password';
  $('auth-submit').textContent = state.reset ? '更新密码' : state.invite ? '接受邀请，建立账号' : '登录';
  $('auth-login-mode').hidden = !state.invite && !state.reset;
  $('auth-error').textContent = message;
}
function updateConnection() {
  $('connection-status').textContent = !navigator.onLine ? '网络已断开 · 待发消息会保留' : state.stream?.readyState === 1 ? '已连接' : '正在连接…';
  $('send-button').disabled = !canChat() || state.uploading || state.preparing || incompleteAttachments() || (state.replyTo && state.references.get(state.replyTo) === null) || (!$('composer').value.trim() && !state.attachments.length);
  $('attach-button').disabled = !canChat() || state.uploading || state.preparing; $('sticker-open').disabled = !canChat() || state.uploading || !!activeAttachmentUpload || state.preparing; $('history-open').disabled = !canRead();
}
async function verifySession({ initial = false } = {}) {
  const verification = ++state.verification;
  clearSpace();
  $('chat-app').hidden = true; $('gate').hidden = false; $('gate-copy').textContent = '正在确认登录状态…'; $('auth-form').hidden = true; $('gate-retry').hidden = true;
  try {
    if (localStorage.getItem('zhiwei-logout-pending') === '1') {
      const me = await api('/api/pwa/me').catch(error => { if (error.status === 401) return null; throw error; });
      if (me) { state.csrf = me.csrfToken; await api('/api/pwa/session', { method: 'DELETE' }); }
      localStorage.removeItem('zhiwei-logout-pending'); clearPrivateUi(); showLogin(); return;
    }
    const me = await api('/api/pwa/me');
    if (verification !== state.verification) return;
    if (!me.user?.id || !me.csrfToken) throw new Error('invalid_session');
    const changed = state.user?.id !== me.user.id;
    if (changed) clearPrivateUi({ keepCommentDraftsFor: me.user.id });
    state.user = me.user; state.me = me; state.csrf = me.csrfToken;
    $('auth-form').hidden = true;
    $('account-name').textContent = me.user.displayName || me.user.id;
    $('legacy-open').hidden = !me.capabilities?.legacyHistory;
    $('space-open').hidden = !canReadSpace();
    $('account-pending').hidden = canChat(); $('composer').disabled = !canChat();
    $('account-pending').textContent = me.pendingBinding ? '账号已建立，旧资料关联正在等待管理员核对。核对完成后即可聊天。' : '目前处于只读维护，历史消息仍可查看。草稿和待发消息会保留，恢复后再发送。';
    $('install-banner').hidden = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    if (changed) await restoreDraft();
    if (verification !== state.verification || document.hidden) return;
    $('gate').hidden = true;
    await showCurrentPage({ initial: changed || initial });
    void uploadNextAttachment();
    void refreshPushStatus();
  } catch (error) {
    if (verification !== state.verification) return;
    if (error.status === 401) { clearPrivateUi(); showLogin(); }
    else { $('gate-copy').textContent = '暂时无法确认登录状态，请联网后重试。'; $('gate-retry').hidden = false; }
  }
}
function clearSpace() {
  spaceRequest++;
  closeComments();
  clearInterval(spaceSessionTimer);
  spaceBefore = null;
  $('space-app').hidden = true;
  $('space-posts').replaceChildren();
  $('space-status').textContent = '';
  $('space-more').hidden = true;
}

function spacePostNode(post, detail) {
  const article = document.createElement('article');
  article.className = 'space-post';
  article.dataset.postId = String(post.id);
  const meta = document.createElement('header');
  const kind = document.createElement('span');
  kind.textContent = post.kind === 'share' ? '分享' : '日常';
  const time = document.createElement('time');
  const published = new Date(post.publishedAt);
  time.dateTime = published.toISOString();
  time.textContent = published.toLocaleString('zh-CN', {year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
  if (detail) {
    meta.append(kind, time);
  } else {
    const permalink = document.createElement('a');
    permalink.href = '/space/' + post.id;
    permalink.dataset.pageLink = '';
    permalink.setAttribute('aria-label', '查看' + time.textContent + '的' + kind.textContent);
    permalink.append(time);
    meta.append(kind, permalink);
  }
  const text = document.createElement('p');
  text.className = 'space-text';
  text.textContent = post.text;
  article.append(meta, text);
  if (!detail) {
    const link = document.createElement('a');
    link.className = 'space-nav comment-link';
    link.dataset.pageLink = '';
    link.href = '/space/' + post.id;
    link.textContent = '查看评论';
    article.append(link);
  }
  if (post.kind === 'share' && post.source) {
    let source;
    try { source = new URL(post.source.url); } catch { /* Keep the post available. */ }
    if (!source || source.protocol !== 'https:' || source.username || source.password) return article;
    const link = document.createElement('a');
    link.className = 'space-source';
    link.href = source.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const host = document.createElement('span');
    host.textContent = '来源 · ' + source.hostname;
    const title = document.createElement('strong');
    title.textContent = post.source.title;
    const arrow = document.createElement('span');
    arrow.className = 'source-arrow';
    arrow.textContent = '↗';
    arrow.setAttribute('aria-hidden', 'true');
    link.append(host, title, arrow);
    text.after(link);
  }
  return article;
}

function clearCommentDrafts(owner) {
  const keep = owner && commentDraftPrefix + owner + ':';
  const obsolete = key => key.startsWith(commentDraftPrefix) && !(keep && key.startsWith(keep));
  for (const key of commentDrafts.keys()) if (obsolete(key)) commentDrafts.delete(key);
  try {
    for (const key of Object.keys(sessionStorage)) if (obsolete(key)) sessionStorage.removeItem(key);
  } catch { /* In-memory drafts still work when browser storage is unavailable. */ }
}

function readCommentDraft(key) {
  let draft = commentDrafts.get(key);
  if (!draft) {
    try { draft = JSON.parse(sessionStorage.getItem(key)); } catch { /* Optional tab storage. */ }
  }
  return draft && typeof draft.text === 'string' && draft.text.length <= 1000 ? draft : { text: '' };
}

function saveCommentDraft(key, draft) {
  if (draft.text) commentDrafts.set(key, draft);
  else commentDrafts.delete(key);
  try {
    if (draft.text) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch { /* Keep the in-memory copy for this page. */ }
}

function closeComments() {
  commentThread = null;
  $('space-comments').hidden = true;
  $('comment-text').value = '';
  $('comment-list').replaceChildren();
  $('comment-send-status').textContent = $('comment-list-status').textContent = '';
  $('comment-more').hidden = true;
}

function commentNode(comment) {
  const item = document.createElement('li');
  item.className = 'space-comment';
  item.dataset.commentId = String(comment.id);
  const byline = document.createElement('div');
  byline.className = 'comment-byline';
  const author = document.createElement('strong');
  author.textContent = comment.authorName;
  const time = document.createElement('time');
  const posted = new Date(comment.createdAt);
  time.dateTime = posted.toISOString();
  time.textContent = posted.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const body = document.createElement('p');
  body.className = 'comment-body';
  body.textContent = comment.text;
  byline.append(author, time);
  item.append(byline, body);
  if (comment.reply) {
    const reply = document.createElement('div');
    reply.className = 'comment-reply';
    const label = document.createElement('strong');
    label.textContent = '知微回复';
    const message = document.createElement('p');
    message.className = 'comment-body';
    message.textContent = comment.reply.text;
    reply.append(label, message);
    item.append(reply);
  }
  return item;
}

function expireSpaceSession() {
  state.verification++;
  clearPrivateUi();
  showLogin('登录已过期，请重新登录。');
}

async function loadComments(thread) {
  if (thread.loading) return;
  thread.loading = true;
  $('comment-more').disabled = true;
  $('comment-list-status').textContent = '正在读取评论…';
  try {
    const result = await api(thread.url + '?limit=20' + (thread.before ? '&before=' + thread.before : ''));
    if (commentThread !== thread) return;
    const list = $('comment-list');
    for (const comment of result.comments) {
      if (comment.postId !== thread.postId || !Number.isSafeInteger(comment.id)) throw Error('invalid-comment');
      const existing = list.querySelector('[data-comment-id="' + comment.id + '"]');
      if (existing) existing.replaceWith(commentNode(comment));
      else list.append(commentNode(comment));
    }
    thread.before = result.nextBefore;
    $('comment-more').hidden = !thread.before;
    $('comment-list-status').textContent = list.childElementCount ? '' : '还没有评论。';
  } catch (error) {
    if (commentThread !== thread) return;
    if (error.status === 401) return expireSpaceSession();
    $('comment-list-status').textContent = '暂时无法读取评论，请重试。';
    $('comment-more').textContent = '重新读取评论';
    $('comment-more').hidden = false;
  } finally {
    thread.loading = false;
    if (commentThread === thread) $('comment-more').disabled = false;
  }
}

function openComments(postId) {
  const key = commentDraftPrefix + state.user.id + ':' + postId;
  const draft = readCommentDraft(key);
  commentThread = { postId, key, url: '/api/pwa/space/posts/' + postId + '/comments', before: null };
  $('space-comments').hidden = false;
  $('comment-form').hidden = !!state.me.readOnly;
  $('comment-text').value = draft.text;
  $('comment-text').readOnly = false;
  $('comment-submit').textContent = draft.clientCommentId ? '重试发表' : '发表评论';
  $('comment-submit').disabled = !draft.text.trim();
  $('comment-send-status').textContent = state.me.readOnly ? '维护期间暂时不能发表评论。' : draft.clientCommentId ? '上次发表结果待确认，可重试。' : '';
  $('comment-more').textContent = '查看更早的评论';
  void loadComments(commentThread);
}

$('comment-more').addEventListener('click', () => {
  if (commentThread) {
    $('comment-more').textContent = '查看更早的评论';
    void loadComments(commentThread);
  }
});
$('comment-text').addEventListener('input', () => {
  if (!commentThread) return;
  const text = $('comment-text').value;
  saveCommentDraft(commentThread.key, { text });
  $('comment-submit').textContent = '发表评论';
  $('comment-submit').disabled = !text.trim();
  $('comment-send-status').textContent = '';
});
$('comment-form').addEventListener('submit', async event => {
  event.preventDefault();
  const thread = commentThread;
  const text = $('comment-text').value.trim();
  if (!thread || thread.sending || !text || state.me.readOnly) return;
  const draft = readCommentDraft(thread.key);
  const clientCommentId = draft.text.trim() === text && draft.clientCommentId ? draft.clientCommentId : crypto.randomUUID();
  saveCommentDraft(thread.key, { text, clientCommentId });
  thread.sending = true;
  $('comment-text').readOnly = $('comment-submit').disabled = true;
  $('comment-send-status').textContent = '正在发表…';
  try {
    const { comment } = await api(thread.url, { method: 'POST', body: { text, clientCommentId } });
    if (!comment || comment.postId !== thread.postId || !Number.isSafeInteger(comment.id)) throw Error('invalid-comment');
    if (commentThread !== thread) return;
    saveCommentDraft(thread.key, { text: '' });
    const list = $('comment-list');
    const existing = list.querySelector('[data-comment-id="' + comment.id + '"]');
    if (existing) existing.replaceWith(commentNode(comment));
    else list.prepend(commentNode(comment));
    $('comment-text').value = '';
    $('comment-send-status').textContent = '评论已发表。';
    if ($('comment-list-status').textContent === '还没有评论。') $('comment-list-status').textContent = '';
    $('comment-submit').textContent = '发表评论';
  } catch (error) {
    if (commentThread !== thread) return;
    if (error.status === 401) return expireSpaceSession();
    if (error.status === 403) { void verifySession(); return; }
    $('comment-submit').textContent = '重试发表';
    const reasons = {
      400: '请检查评论内容，修改后再发表。',
      404: '这条动态已不可用。',
      409: '这次提交和已发表的评论有冲突，请刷新后核对。',
      503: '服务暂时无法接收评论，请稍后重试。'
    };
    $('comment-send-status').textContent = reasons[error.status] || '尚未确认评论是否发表，请重试。';
  } finally {
    thread.sending = false;
    if (commentThread === thread) {
      $('comment-text').readOnly = false;
      $('comment-submit').disabled = !$('comment-text').value.trim();
    }
  }
});

async function loadSpace(more = false) {
  if (!canReadSpace() || $('space-app').hidden || (more && !spaceBefore)) return;
  const request = ++spaceRequest;
  const detail = location.pathname.match(/^\/space\/([1-9]\d*)\/?$/)?.[1];
  const container = $('space-posts');
  if (!more) {
    closeComments();
    spaceBefore = null;
    container.replaceChildren();
    $('space-feed').scrollTop = 0;
  }
  $('space-all').hidden = !detail;
  $('space-more').hidden = !more;
  $('space-more').disabled = $('space-refresh').disabled = true;
  $('space-status').textContent = '正在读取动态…';
  try {
    const base = '/api/pwa/space/posts';
    const result = await api(detail ? base + '/' + detail : base + '?limit=20' + (more ? '&before=' + spaceBefore : ''));
    if (request !== spaceRequest) return;
    const posts = detail ? [result.post] : result.posts;
    if (!Array.isArray(posts) || !posts.every(post => post && Number.isSafeInteger(post.id) && post.id > 0 &&
        Number.isFinite(new Date(post.publishedAt).getTime()) && typeof post.text === 'string') ||
        (detail && String(posts[0].id) !== detail)) throw Error('invalid-posts');
    const fragment = document.createDocumentFragment();
    for (const post of posts) fragment.append(spacePostNode(post, !!detail));
    container.append(fragment);
    if (detail) openComments(posts[0].id);
    spaceBefore = !detail && Number.isSafeInteger(result.nextBefore) && result.nextBefore > 0 ? result.nextBefore : null;
    $('space-status').textContent = container.childElementCount ? '' : '知微还没发过动态。';
  } catch (error) {
    if (request !== spaceRequest) return;
    if (error.status === 401) {
      expireSpaceSession();
      return;
    }
    $('space-status').textContent = detail && error.status === 404 ? '这条动态已不可用。' : '暂时无法读取动态，请重试。';
  } finally {
    if (request === spaceRequest) {
      $('space-more').hidden = spaceBefore === null;
      $('space-more').disabled = $('space-refresh').disabled = false;
    }
  }
}

async function checkSpaceSession() {
  const timer = spaceSessionTimer;
  if ($('space-app').hidden) return;
  try {
    const me = await api('/api/pwa/me');
    if (timer !== spaceSessionTimer || $('space-app').hidden) return;
    if (me.user?.id !== state.user?.id || !me.capabilities?.space) return void verifySession();
  } catch {
    if (timer === spaceSessionTimer && !$('space-app').hidden) void verifySession();
  }
}

async function showCurrentPage({ initial = false, focus = false } = {}) {
  clearSpace();
  if (document.hidden || !state.user || !$('gate').hidden) return;
  if (/^\/space(?:\/[1-9]\d*)?\/?$/.test(location.pathname)) {
    if (canReadSpace()) {
      disconnectStream();
      $('chat-app').hidden = true;
      $('space-app').hidden = false;
      if (focus) $('space-title').focus();
      spaceSessionTimer = setInterval(checkSpaceSession, 60000);
      await loadSpace();
      return;
    }
    history.replaceState(null, '', '/');
  }
  $('chat-app').hidden = false;
  if (focus && !$('space-open').hidden) $('space-open').focus();
  if (canRead()) {
    await syncMessages({ initial: initial || !state.messages.size });
    if (!$('chat-app').hidden) { connectStream(); void sendPending(); }
  }
  updateConnection();
}

document.addEventListener('click', event => {
  const link = event.target.closest('a[data-page-link]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  history.pushState(null, '', link.href);
  void showCurrentPage({ focus: true });
});
window.addEventListener('popstate', () => { void showCurrentPage({ focus: true }); });
$('space-more').addEventListener('click', () => { void loadSpace(true); });
$('space-refresh').addEventListener('click', () => { void loadSpace(); });
$('space-settings').addEventListener('click', () => { $('settings-dialog').showModal(); void refreshPushStatus(); });

function mergeMessages(messages) {
  for (const m of messages || []) if (safeId(m.id) && Number.isSafeInteger(m.seq) && m.seq >= 0) state.messages.set(m.id, m);
}
function appendCreativeWork(container, work, messageText) {
  if (!work || !safeId(work.id) || !Array.isArray(work.downloads)) return;
  const base = `/api/pwa/media/works/${encodeURIComponent(work.id)}`;
  const card = document.createElement('div'); card.className = 'creative-work';
  if (work.title && messageText !== work.title) {
    const title = document.createElement('strong'); title.textContent = work.title; card.append(title);
  }
  const links = document.createElement('div'); links.className = 'work-links';
  const preview = document.createElement('a'); preview.href = `${base}/preview`; preview.target = '_blank'; preview.rel = 'noopener noreferrer';
  preview.textContent = '打开作品'; links.append(preview);
  const formats = { html:work.kind === 'model3d' ? '离线查看器' : '网页源码', svg:'可编辑设计', png:'PNG 图片', glb:'3D 模型', json:'模型参数' };
  for (const name of work.downloads) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,80}\.(html|svg|png|glb|json)$/.test(name)) continue;
    const download = document.createElement('a'); download.href = `${base}/download/${encodeURIComponent(name)}`;
    download.download = name; download.textContent = `下载${formats[name.split('.').at(-1)]}`; links.append(download);
  }
  card.append(links); container.append(card);
}
function messageNode(m, { pending = false } = {}) {
  const article = document.createElement('article'); article.className = `message${own(m) ? ' own' : ''}${pending ? ' pending' : ''}`; article.dataset.messageId = m.id || m.clientMessageId;
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const date = new Date(m.createdAt); meta.textContent = `${own(m) ? '你' : '知微'} · ${Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  if (m.replyTo) { const q = document.createElement('button'); q.type = 'button'; q.className = 'quote'; q.setAttribute('aria-label', '查看引用原文'); const original = state.references.has(m.replyTo) ? state.references.get(m.replyTo) : state.messages.get(m.replyTo); q.textContent = original ? referenceLabel(original) : state.references.get(m.replyTo) === null ? '引用原文已不可用' : '正在读取引用原文…'; q.addEventListener('click', () => { void openContext(m.replyTo); }); bubble.append(q); if (!state.references.has(m.replyTo)) void hydrateReference(m.replyTo); }
  if (m.text) { const text = document.createElement('p'); text.textContent = m.text; bubble.append(text); }
  for (const id of m.mediaIds || []) if (safeId(id)) {
    const link = document.createElement('a'); link.href = mediaUrl(id); link.target = '_blank'; link.rel = 'noopener'; link.className = 'media-link'; link.setAttribute('aria-label', '查看图片');
    const img = document.createElement('img'); img.src = mediaUrl(id); img.alt = '聊天图片'; img.className = 'message-image'; img.loading = 'lazy';
    img.onerror = () => { img.remove(); link.textContent = '图片暂时无法载入，点此重试'; }; link.append(img); bubble.append(link);
  }
  appendCreativeWork(bubble,m.work,m.text);
  article.append(meta, bubble); const tools = document.createElement('div'); tools.className = 'message-tools';
  if (!pending) { const reply = document.createElement('button'); reply.type = 'button'; reply.textContent = '引用'; reply.disabled = !canChat(); reply.addEventListener('click', () => { void chooseReference(m.id); }); tools.append(reply); }
  else { const status = document.createElement('span'); status.className = `delivery-state${m.error ? ' failed' : ''}`; status.textContent = m.sending ? '正在保存…' : m.error ? m.error : '等待发送'; tools.append(status);
    if (!m.sending) { const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.addEventListener('click', () => { const pending = state.pending.get(m.clientMessageId); if (pending) { pending.blocked = false; pending.error = ''; void sendPending(); } }); tools.append(retry);
      if (m.rejected && !m.uncertain) { const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '修改后再发'; edit.addEventListener('click', () => { if ($('composer').value.trim() || state.attachments.length) { toast('请先处理输入框里的草稿。'); return; } $('composer').value = m.text; state.attachments = m.mediaIds.map(id => ({ id })); state.replyTo = m.replyTo; state.pending.delete(m.clientMessageId); renderComposer(); renderPending(); resizeComposer(); void saveDraft(); }); tools.append(edit); const discard = document.createElement('button'); discard.type = 'button'; discard.textContent = '取消发送'; discard.addEventListener('click', () => { state.pending.delete(m.clientMessageId); renderPending(); void saveDraft().then(() => sendPending()); }); tools.append(discard); } }
  }
  if (!pending) for (const id of m.mediaIds || []) if (safeId(id)) tools.append(saveStickerButton(id));
  article.append(tools); return article;
}
function renderMessages({ bottom = false } = {}) {
  const fragment = document.createDocumentFragment(); for (const m of [...state.messages.values()].sort((a, b) => a.seq - b.seq)) fragment.append(messageNode(m));
  $('messages').replaceChildren(fragment); $('empty-chat').hidden = state.messages.size > 0 || state.pending.size > 0; $('load-history').hidden = !state.hasMore;
  if (bottom) scrollBottom(); else if (!atBottom()) $('unread-jump').hidden = false;
}
function renderPending() { const f = document.createDocumentFragment(); for (const p of state.pending.values()) f.append(messageNode({ ...p, direction: 'inbound' }, { pending: true })); $('pending-messages').replaceChildren(f); $('empty-chat').hidden = state.messages.size > 0 || state.pending.size > 0; }
function scrollBottom() { requestAnimationFrame(() => { $('timeline').scrollTop = $('timeline').scrollHeight; $('unread-jump').hidden = true; void markRead(); }); }
async function syncMessages({ initial = false } = {}) {
  if (!state.user || state.syncing || !canRead()) return;
  state.syncing = true; const generation = state.generation; const bottom = initial || atBottom(); let continueSync = false;
  try {
    let after = initial ? null : highestSeq(); let pages = 0;
    do {
      const result = await api(`/api/pwa/messages${after === null ? '' : `?after=${after}`}`);
      if (generation !== state.generation) return;
      mergeMessages(result.messages); state.readSeq = Math.max(state.readSeq, Number(result.readSeq) || 0);
      if (after === null) state.hasMore = !!result.hasMore;
      const next = highestSeq(); const more = after !== null && result.hasMore && next > after; after = next; continueSync = more;
      if (!more) break;
    } while (++pages < 20);
    renderMessages({ bottom }); if (bottom) void markRead();
  } catch (error) { continueSync = false; if (error.status === 401) { clearPrivateUi(); showLogin('登录已过期，请重新登录。'); } else updateConnection(); }
  finally { if (generation === state.generation) { state.syncing = false; if (continueSync && !document.hidden) setTimeout(() => { if (generation === state.generation) void syncMessages(); }, 0); } }
}
function connectStream() {
  disconnectStream(); if (!canRead() || document.hidden) return;
  const stream = new EventSource('/api/pwa/events', { withCredentials: true }); state.stream = stream;
  stream.onopen = () => { updateConnection(); void syncMessages(); };
  stream.onmessage = () => { void syncMessages(); };
  stream.addEventListener('revoke', () => { clearPrivateUi(); showLogin('登录已失效，请重新登录。'); });
  stream.addEventListener('auth', () => { void verifySession(); });
  stream.onerror = () => { updateConnection(); clearTimeout(state.retryTimer); state.retryTimer = setTimeout(() => { if (!document.hidden && state.user) void verifySession(); }, 15000); };
}
async function markRead() {
  if (!state.user || document.hidden || $('chat-app').hidden || !atBottom()) return;
  const seq = highestSeq(); if (!seq || seq <= state.readSeq) return;
  const generation = state.generation;
  try { await api('/api/pwa/read', { method: 'POST', body: { seq } }); if (generation === state.generation) { state.readSeq = Math.max(state.readSeq, seq); if ('clearAppBadge' in navigator) void navigator.clearAppBadge().catch(() => {}); } } catch { /* A failed receipt does not imply a read. */ }
}
function resizeComposer() { $('composer').style.height = 'auto'; $('composer').style.height = `${Math.min(150, $('composer').scrollHeight)}px`; updateConnection(); }
function renderComposer() {
  const original = state.references.has(state.replyTo) ? state.references.get(state.replyTo) : state.messages.get(state.replyTo); $('reply-preview').hidden = !state.replyTo; $('reply-copy').textContent = original ? referenceLabel(original) : state.references.get(state.replyTo) === null ? '原文已不可用，请取消这条引用' : '正在读取引用原文…'; if (state.replyTo && !state.references.has(state.replyTo)) void hydrateReference(state.replyTo);
  renderAttachments();
  updateConnection();
}
function renderAttachments() {
  const ready = state.attachments.filter(media => safeId(media.id)).length;
  const count = state.attachments.length;
  attachmentCount.textContent = [count ? `已选 ${count} 张 · 已上传 ${ready} 张` : '', attachmentNotice].filter(Boolean).join('。');
  const files = new Set(state.attachments.map(media => media.file));
  for (const [file, url] of previewUrls) if (!files.has(file)) {
    URL.revokeObjectURL(url);
    previewUrls.delete(file);
  }
  const fragment = document.createDocumentFragment();
  for (const [index, media] of state.attachments.entries()) {
    const order = `第 ${index + 1} 张`;
    const card = document.createElement('div');
    card.className = 'attachment';
    const img = document.createElement('img');
    if (media.file) {
      if (!previewUrls.has(media.file)) previewUrls.set(media.file, URL.createObjectURL(media.file));
      img.src = previewUrls.get(media.file);
    } else img.src = mediaUrl(media.id);
    img.alt = `${order}待发送图片`;
    const caption = document.createElement('span');
    const status = { queued: '待上传', uploading: '上传中', failed: '失败' }[media.status] || '就绪';
    caption.textContent = `${order} · ${status}`;
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'attachment-remove'; remove.textContent = '×';
    remove.setAttribute('aria-label', `移除${order}图片`);
    remove.addEventListener('click', () => {
      if (media === activeAttachmentUpload?.media) activeAttachmentUpload.controller.abort();
      attachmentNotice = '';
      state.attachments = state.attachments.filter(item => item !== media);
      renderComposer(); void saveDraft();
    });
    card.append(img, remove, caption);
    if (media.status === 'failed') {
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'attachment-retry'; retry.textContent = '重试上传';
      retry.setAttribute('aria-label', `重试上传${order}图片`);
      retry.title = media.error;
      retry.addEventListener('click', () => {
        if (!canChat() || media.status !== 'failed') return;
        media.status = 'queued'; media.error = '';
        renderComposer(); void uploadNextAttachment();
      });
      card.title = media.error; card.append(retry);
    }
    fragment.append(card);
  }
  $('attachments').replaceChildren(fragment);
}
function fileProblem(file) {
  if (!uploadTypes.includes(file.type)) return '请选择 JPG、PNG、GIF 或 WebP 图片。';
  if (file.size > 10 * 1024 * 1024) return '图片超过 10 MB，请缩小后再选。';
  return '';
}
async function uploadNextAttachment() {
  if (!canChat() || state.uploading || activeAttachmentUpload) return;
  const media = state.attachments.find(item => item.status === 'queued');
  if (!media) return;
  const generation = state.generation;
  const controller = new AbortController();
  activeAttachmentUpload = { media, controller };
  media.status = 'uploading'; renderComposer();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const result = await api('/api/pwa/media', { method: 'POST', raw: true, signal: controller.signal,
      body: media.file, headers: { 'Content-Type': media.file.type, 'X-File-Name': encodeURIComponent(media.file.name) } });
    if (generation !== state.generation || !state.attachments.includes(media)) return;
    if (!safeId(result.media?.id)) throw Error('invalid_media');
    media.id = result.media.id; delete media.file; delete media.status; delete media.error;
  } catch (error) {
    if (generation !== state.generation || !state.attachments.includes(media)) return;
    media.status = 'failed';
    media.error = error.name === 'AbortError' || error.name === 'TypeError' ? '没有收到上传回执，请联网后重试。' : friendly(error);
    toast(`第 ${state.attachments.indexOf(media) + 1} 张上传失败。${media.error}`);
  } finally {
    clearTimeout(timeout);
    if (generation === state.generation) {
      activeAttachmentUpload = null; renderComposer(); void saveDraft(); void uploadNextAttachment();
    }
  }
}
async function sendPending() {
  if (state.sending || !canChat() || !navigator.onLine || document.hidden || $('chat-app').hidden) return;
  state.sending = true; const generation = state.generation;
  try {
    if (!await saveDraft() || generation !== state.generation) return;
    for (const p of state.pending.values()) {
      if (p.blocked) break; p.sending = true; p.error = ''; renderPending();
      try {
        const result = await api('/api/pwa/messages', { method: 'POST', body: { clientMessageId: p.clientMessageId, text: p.text, mediaIds: p.mediaIds, replyTo: p.replyTo } });
        if (generation !== state.generation) return;
        const m = result.message || result; if (!m.id || !Number.isSafeInteger(m.seq)) throw new Error('invalid_acceptance');
        state.pending.delete(p.clientMessageId); mergeMessages([m]); renderMessages({ bottom: true }); renderPending(); await saveDraft();
      } catch (error) {
        if (generation !== state.generation) return;
        p.sending = false; p.error = friendly(error); p.blocked = !!error.status && !transientCodes.has(error.status); p.rejected = [400, 404, 413, 415].includes(error.status); p.uncertain = error.status === 404 ? false : !!p.uncertain || !error.status || error.status >= 500; renderPending(); await saveDraft();
        if (error.status === 401) { clearPrivateUi(); showLogin('登录已过期，重新登录后可继续发送。'); }
        break;
      }
    }
  } finally { if (generation === state.generation) state.sending = false; }
}
function closeFeatureDialogs() { for (const id of ['history-dialog', 'context-dialog', 'sticker-dialog']) $(id).close(); }
function clearFeatureUi() {
  state.references.clear(); state.referenceRequests.clear(); state.preparing = false;
  state.search = { cursor: null, request: state.search.request + 1, query: null };
  state.stickers = { view: 'favourites', request: state.stickers.request + 1, loading: false, cursor: null };
  for (const id of ['history-results', 'context-records', 'sticker-grid']) $(id).replaceChildren();
  for (const id of ['history-query', 'history-from', 'history-to']) $(id).value = '';
  for (const id of ['history-speaker', 'history-source']) $(id).value = 'all';
  for (const id of ['history-status', 'context-status', 'sticker-status']) $(id).textContent = '';
  $('history-more').hidden = true; $('sticker-more').hidden = true;
}
function recordDate(record) { const date = new Date(record.createdAt || record.at); return Number.isNaN(date.getTime()) ? '时间未留存' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function referenceLabel(record) { return `${record.source === 'qq' ? 'QQ 留存 · ' : ''}${own(record) ? '你' : '知微'} · ${recordDate(record)}：${record.text || (record.mediaIds?.length ? '[图片]' : record.quotedText ? `当时引用（原说话方未记录）：${record.quotedText}` : '[没有留存文字]')}${record.truncated ? '（仅保留部分原文）' : ''}`; }
async function resolveReference(id, force = false) {
  if (!safeId(id) || !canRead()) return null;
  if (!force && state.references.has(id)) return state.references.get(id);
  if (state.referenceRequests.has(id)) return state.referenceRequests.get(id);
  const generation = state.generation;
  const request = (async () => {
    try { const result = await api(`/api/pwa/references?ref=${encodeURIComponent(id)}`); if (generation !== state.generation) return null; const record = result.record?.id === id ? result.record : null; state.references.set(id, record); return record; }
    catch (error) { if (generation !== state.generation) return null; if (error.status === 404) { state.references.set(id, null); return null; } throw error; }
    finally { if (generation === state.generation) state.referenceRequests.delete(id); }
  })();
  state.referenceRequests.set(id, request); return request;
}
async function hydrateReference(id) {
  const generation = state.generation;
  try { await resolveReference(id); if (generation !== state.generation) return; renderComposer(); for (const article of $('messages').children) { const message = state.messages.get(article.dataset.messageId); if (message?.replyTo === id) { const q = article.querySelector('.quote'); const record = state.references.get(id); if (q) q.textContent = record ? referenceLabel(record) : '引用原文已不可用'; } } }
  catch { if (generation === state.generation && state.replyTo === id) $('reply-copy').textContent = '暂时无法读取原文，点击重试'; }
}
async function chooseReference(id) {
  if (!canChat()) return; const generation = state.generation;
  try { const record = await resolveReference(id, true); if (generation !== state.generation) return; if (!record) { toast('这条原文已不可用。'); return; } state.replyTo = id; closeFeatureDialogs(); renderComposer(); scheduleDraft(); $('composer').focus(); }
  catch (error) { if (generation === state.generation) toast(friendly(error)); }
}
function recordNode(record, { focused = false, context = false } = {}) {
  const article = document.createElement('article'); article.className = `history-record${focused ? ' focused' : ''}`; article.dataset.referenceId = record.id;
  const heading = document.createElement('p'); heading.className = 'record-heading'; heading.textContent = `${record.source === 'qq' ? 'QQ 留存' : '网页聊天'} · ${own(record) ? '你' : '知微'} · ${recordDate(record)}`;
  const text = document.createElement('p'); text.className = 'record-text'; text.textContent = record.text || (record.mediaIds?.length ? '[图片]' : '这条记录没有留存文字'); article.append(heading);
  if (typeof record.quotedText === 'string' && record.quotedText) { const quoted = document.createElement('aside'); quoted.className = 'retained-quote'; const label = document.createElement('p'); label.className = 'fine-print'; label.textContent = '当时引用的内容（原说话方未记录）'; const body = document.createElement('p'); body.className = 'record-text'; body.textContent = record.quotedText; quoted.append(label, body); if (record.quotedTruncated) { const missing = document.createElement('p'); missing.className = 'fine-print'; missing.textContent = '这段引用只保留了部分原文。'; quoted.append(missing); } article.append(quoted); }
  article.append(text);
  for (const id of record.mediaIds || []) if (safeId(id)) { const link = document.createElement('a'); link.href = mediaUrl(id); link.target = '_blank'; link.rel = 'noopener'; const img = document.createElement('img'); img.src = mediaUrl(id); img.alt = '原消息图片'; img.className = 'message-image'; img.loading = 'lazy'; img.onerror = () => { img.remove(); link.textContent = '图片已不可用'; }; link.append(img); article.append(link); }
  appendCreativeWork(article,record.work,record.text);
  if (record.truncated || record.mediaMissing) { const note = document.createElement('p'); note.className = 'fine-print'; note.textContent = [record.truncated ? '这里只保留了部分原文，未保存的内容无法补回。' : '', record.mediaMissing ? '原图片没有可用留存；需要的话，可以重新上传。' : ''].filter(Boolean).join(' '); article.append(note); }
  const actions = document.createElement('div'); actions.className = 'record-actions';
  const quote = document.createElement('button'); quote.type = 'button'; quote.textContent = '引用这句'; quote.disabled = !canChat(); quote.addEventListener('click', () => { void chooseReference(record.id); }); actions.append(quote);
  if (!context) { const locate = document.createElement('button'); locate.type = 'button'; locate.textContent = '查看上下文'; locate.addEventListener('click', () => { void openContext(record.id); }); actions.append(locate); }
  for (const id of record.mediaIds || []) if (safeId(id)) actions.append(saveStickerButton(id));
  article.append(actions); return article;
}
async function openContext(id) {
  if (!canRead() || !safeId(id)) return;
  const generation = state.generation; const request = ($('context-dialog').dataset.request = crypto.randomUUID());
  $('context-records').replaceChildren(); $('context-status').textContent = '正在读取原文…'; if (!$('context-dialog').open) $('context-dialog').showModal();
  try { const result = await api(`/api/pwa/history/context?ref=${encodeURIComponent(id)}`); if (generation !== state.generation || $('context-dialog').dataset.request !== request) return;
    if (result.record?.id !== id) throw Object.assign(Error('missing'), { status: 404 });
    state.references.set(id, result.record); const records = result.records?.length ? result.records : [result.record]; const fragment = document.createDocumentFragment();
    for (const record of records) if (safeId(record.id)) fragment.append(recordNode(record, { focused: record.id === id, context: true }));
    $('context-records').replaceChildren(fragment); $('context-status').textContent = result.record.source === 'qq' ? 'QQ 旧留存 · 相邻记录可能有缺失，边框标出你打开的原话。' : '网页聊天 · 边框标出你打开的消息。';
    requestAnimationFrame(() => $('context-records').querySelector('.focused')?.scrollIntoView({ block: 'center' }));
  } catch (error) { if (generation !== state.generation || $('context-dialog').dataset.request !== request) return; if (error.status === 404) { state.references.set(id, null); for (const article of $('messages').children) if (state.messages.get(article.dataset.messageId)?.replyTo === id) { const quote = article.querySelector('.quote'); if (quote) quote.textContent = '引用原文已不可用'; } $('context-status').textContent = '这条原文已删除、失效或不再可访问。'; renderComposer(); } else $('context-status').textContent = '暂时无法读取原文，请联网后重新打开。'; }
}
async function searchHistory(more = false) {
  if (!canRead()) return; const generation = state.generation; const request = ++state.search.request;
  if (!more) { state.search.query = { q: $('history-query').value.trim(), from: $('history-from').value, to: $('history-to').value, speaker: $('history-speaker').value, source: $('history-source').value, limit: '30' }; state.search.cursor = null; $('history-results').replaceChildren(); $('history-more').hidden = true; }
  if (state.search.query?.from && state.search.query?.to && state.search.query.from > state.search.query.to) { $('history-status').textContent = '开始日期不能晚于结束日期。'; return; }
  const query = new URLSearchParams(state.search.query || {}); if (more && state.search.cursor) query.set('cursor', state.search.cursor);
  $('history-status').textContent = '正在查找…'; $('history-submit').disabled = true; $('history-more').disabled = true;
  try { const result = await api(`/api/pwa/history/search?${query}`); if (generation !== state.generation || request !== state.search.request) return;
    const seen = new Set([...$('history-results').children].map(x => x.dataset.referenceId)); const fragment = document.createDocumentFragment();
    for (const record of result.records || []) if (safeId(record.id) && !seen.has(record.id)) { seen.add(record.id); fragment.append(recordNode(record)); }
    $('history-results').append(fragment); state.search.cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null; $('history-more').hidden = !result.hasMore || !state.search.cursor;
    $('history-status').textContent = seen.size ? `已显示 ${seen.size} 条。${result.scopeNotice || '日期按北京时间筛选，结果仅含实际留存的原文。'}` : '没有找到符合条件的留存记录。可以换个关键词或放宽日期。';
  } catch (error) { if (generation !== state.generation || request !== state.search.request) return; $('history-status').textContent = error.status === 400 ? '查询条件或翻页已失效，请调整条件后重新查找。' : '暂时无法查询，请联网后重试。'; }
  finally { if (generation === state.generation && request === state.search.request) { $('history-submit').disabled = false; $('history-more').disabled = false; } }
}
function showHistory(source = 'all') { if (!canRead()) return; $('settings-dialog').close(); $('history-source').value = source; if (!$('history-dialog').open) $('history-dialog').showModal(); void searchHistory(); }
function saveStickerButton(id) { const button = document.createElement('button'); button.type = 'button'; button.textContent = '收藏表情'; button.disabled = !canChat(); button.addEventListener('click', async () => { const generation = state.generation; button.disabled = true; try { await api('/api/pwa/stickers', { method: 'POST', body: { mediaId: id } }); if (generation === state.generation) { button.textContent = '已收藏'; toast('已加入你的表情收藏。'); } } catch (error) { if (generation === state.generation) { toast(error.status === 404 ? '图片已不可用，无法收藏。' : friendly(error)); button.disabled = false; } } }); return button; }
function stickerImageUrl(item) { if (safeId(item.mediaId)) return mediaUrl(item.mediaId); if (typeof item.url === 'string' && /^\/api\/pwa\/sticker-assets\/[a-f0-9]{64}$/.test(item.url)) return item.url; return null; }
async function loadStickers(view = state.stickers.view, more = false) {
  if (!canRead()) return; const generation = state.generation; const request = ++state.stickers.request; state.stickers.view = view; state.stickers.loading = true;
  for (const button of document.querySelectorAll('[data-sticker-view]')) button.setAttribute('aria-pressed', String(button.dataset.stickerView === view));
  if (!more) { $('sticker-grid').replaceChildren(); state.stickers.cursor = null; $('sticker-more').hidden = true; } $('sticker-more').disabled = true; $('sticker-status').textContent = '正在打开表情…'; $('sticker-upload').disabled = !canChat() || state.uploading;
  try { const result = await api(`/api/pwa/stickers?view=${encodeURIComponent(view)}${more && state.stickers.cursor ? `&cursor=${encodeURIComponent(state.stickers.cursor)}` : ''}`); if (generation !== state.generation || request !== state.stickers.request) return;
    const visibleIds = new Set([...$('sticker-grid').children].map(x => x.dataset.stickerId));
    for (const item of result.items || []) { if (!safeId(item.id) || visibleIds.has(item.id)) continue; visibleIds.add(item.id); const cell = document.createElement('div'); cell.className = 'sticker-cell'; cell.dataset.stickerId = item.id;
      const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'sticker-pick'; pick.setAttribute('aria-label', `选用表情：${item.name || '图片'}`); pick.disabled = !canChat() || item.available === false; const url = stickerImageUrl(item);
      if (url && item.available !== false) { const img = document.createElement('img'); img.src = url; img.alt = item.name || '表情'; img.loading = 'lazy'; img.onerror = () => { img.remove(); pick.disabled = true; title.textContent = '图片已不可用'; }; pick.append(img); }
      const title = document.createElement('span'); title.textContent = item.available === false ? '图片已不可用' : item.name || '表情'; pick.append(title);
      pick.addEventListener('click', async () => { if (state.attachments.length >= attachmentLimit) { $('sticker-status').textContent = '一次最多附上 4 张图片。'; return; } pick.disabled = true;
        try { const selected = await api(`/api/pwa/stickers/${encodeURIComponent(item.id)}/select`, { method: 'POST', body: {} }); if (generation !== state.generation) return; const media = selected.media || { id: selected.mediaId }; if (!safeId(media.id)) throw Error('invalid_media'); if (state.attachments.length >= attachmentLimit) { $('sticker-status').textContent = '一次最多附上 4 张图片。'; return; } state.attachments.push(media); $('sticker-dialog').close(); renderComposer(); await saveDraft(); $('composer').focus(); }
        catch (error) { if (generation === state.generation) $('sticker-status').textContent = error.status === 404 ? '这张表情已不可用，可以换一张。' : friendly(error); }
        finally { if (generation === state.generation) pick.disabled = !canChat() || item.available === false; }
      }); cell.append(pick);
      if (item.favourite) { const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'sticker-save'; remove.textContent = '取消收藏'; remove.disabled = !canChat(); remove.addEventListener('click', async () => { remove.disabled = true; try { await api(`/api/pwa/stickers/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); if (generation === state.generation) await loadStickers(); } catch (error) { if (generation === state.generation) { $('sticker-status').textContent = friendly(error); remove.disabled = false; } } }); cell.append(remove); }
      $('sticker-grid').append(cell);
    }
    state.stickers.cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null; $('sticker-more').hidden = !result.hasMore || !state.stickers.cursor;
    $('sticker-status').textContent = $('sticker-grid').childElementCount ? '点一张放入输入框，准备好后再发送。' : view === 'recent' ? '还没有最近用过的表情。' : view === 'shared' ? '暂时没有可用的共用表情。' : '还没有收藏。可以上传，或从聊天图片中收藏。';
  } catch (error) { if (generation === state.generation && request === state.stickers.request) $('sticker-status').textContent = '暂时无法读取表情，请联网后重试。'; }
  finally { if (generation === state.generation && request === state.stickers.request) { state.stickers.loading = false; $('sticker-more').disabled = false; } }
}
$('history-open').addEventListener('click', () => showHistory());
$('legacy-open').addEventListener('click', () => showHistory('qq'));
$('history-close').addEventListener('click', () => $('history-dialog').close());
$('context-close').addEventListener('click', () => $('context-dialog').close());
$('history-form').addEventListener('submit', event => { event.preventDefault(); void searchHistory(); });
$('history-more').addEventListener('click', () => { void searchHistory(true); });
$('reply-copy').addEventListener('click', () => { if (state.replyTo) void openContext(state.replyTo); });
$('sticker-open').addEventListener('click', () => { $('sticker-dialog').showModal(); void loadStickers(); });
$('sticker-close').addEventListener('click', () => $('sticker-dialog').close());
for (const button of document.querySelectorAll('[data-sticker-view]')) button.addEventListener('click', () => { void loadStickers(button.dataset.stickerView); });
$('sticker-more').addEventListener('click', () => { if (!state.stickers.loading) void loadStickers(state.stickers.view, true); });
$('sticker-upload').addEventListener('click', () => $('sticker-file').click());
$('sticker-file').addEventListener('change', async () => {
  const files = [...$('sticker-file').files]; $('sticker-file').value = ''; if (!files.length || !canChat() || state.uploading) return;
  const generation = state.generation; state.uploading = true; $('sticker-upload').disabled = true; updateConnection();
  try { for (const file of files) { if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) { $('sticker-status').textContent = '请选择 10 MB 以内的 JPG、PNG、GIF 或 WebP 图片。'; continue; } $('sticker-status').textContent = '正在保存表情…'; const result = await api('/api/pwa/media', { method: 'POST', raw: true, body: file, headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) } }); if (generation !== state.generation) return; if (!safeId(result.media?.id)) throw Error('invalid_media'); await api('/api/pwa/stickers', { method: 'POST', body: { mediaId: result.media.id, name: file.name.slice(0, 80) } }); if (generation !== state.generation) return; } await loadStickers('favourites'); }
  catch (error) { if (generation === state.generation) $('sticker-status').textContent = friendly(error); }
  finally { if (generation === state.generation) { state.uploading = false; $('sticker-upload').disabled = !canChat(); updateConnection(); } }
});
function pushSupport() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!state.sw; }
async function refreshPushStatus() {
  const supported = pushSupport(); $('enable-push').disabled = !supported || !state.me?.pushPublicKey || state.me?.capabilities?.notifications === false;
  $('notification-preview').disabled = state.me?.capabilities?.notifications === false;
  $('notification-preview').checked = !!(state.me?.push?.preview || state.me?.notificationPreview);
  if (!supported) { $('push-status').textContent = '请在支持通知的设备上从主屏幕打开知微。聊天仍可正常使用。'; return; }
  if (Notification.permission === 'denied') { $('push-status').textContent = '通知权限已关闭。请到手机“设置 → 通知 → 知微”中允许通知，再回到这里。'; $('enable-push').disabled = true; $('disable-push').hidden = true; return; }
  const subscription = await state.sw.pushManager.getSubscription();
  const saved = !!(state.me?.push?.subscribed || state.me?.push?.enabled || state.me?.pushSubscribed);
  $('push-status').textContent = subscription && saved ? '此设备已开启通知。系统设置仍会影响提醒的显示。' : '此设备尚未开启通知。';
  $('enable-push').textContent = subscription ? '重新关联此设备通知' : '开启通知'; $('disable-push').hidden = !subscription;
}
function applicationKey(value) { const base64 = value.replace(/-/g, '+').replace(/_/g, '/'); const text = atob(base64 + '='.repeat((4 - base64.length % 4) % 4)); return Uint8Array.from(text, c => c.charCodeAt(0)); }
async function saveSubscription(subscription) { await api('/api/pwa/push-subscription', { method: 'PUT', body: { subscription: subscription.toJSON(), preview: $('notification-preview').checked } }); state.me.push = { subscribed: true, preview: $('notification-preview').checked }; }
$('enable-push').addEventListener('click', async () => {
  if (!pushSupport() || !state.me?.pushPublicKey) return;
  $('settings-error').textContent = ''; $('enable-push').disabled = true;
  try {
    // Call subscribe directly in the user gesture; SW/key were prepared beforehand.
    const subscription = await state.sw.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(state.me.pushPublicKey) });
    await saveSubscription(subscription); toast('此设备已关联通知。');
  } catch (error) { $('settings-error').textContent = error.status === 400 ? '这个设备的推送服务暂未支持，仍可正常在前台聊天。' : error.name === 'NotAllowedError' ? '通知未获允许，可在手机系统设置中开启。' : friendly(error); }
  finally { await refreshPushStatus(); }
});
$('disable-push').addEventListener('click', async () => { try { await api('/api/pwa/push-subscription', { method: 'DELETE' }); const sub = await state.sw?.pushManager.getSubscription(); await sub?.unsubscribe(); state.me.push = { subscribed: false }; await refreshPushStatus(); } catch (error) { $('settings-error').textContent = friendly(error); } });
$('notification-preview').addEventListener('change', async () => { try { const sub = await state.sw?.pushManager.getSubscription(); if (sub) await saveSubscription(sub); } catch (error) { $('settings-error').textContent = friendly(error); $('notification-preview').checked = ! $('notification-preview').checked; } });
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('auth-submit').disabled = true; $('auth-error').textContent = '';
  try {
    if (state.reset) {
      await api('/api/pwa/password-reset', { method: 'POST', body: { token: state.reset, password: $('password').value } });
      state.reset = ''; state.verification++; clearPrivateUi(); await clearDrafts(); showLogin('密码已更新，请用新密码登录。'); return;
    }
    const body = { username: $('username').value.trim(), password: $('password').value };
    if (state.invite) { body.token = state.invite; body.displayName = $('display-name').value.trim(); }
    await api(state.invite ? '/api/pwa/invitations/claim' : '/api/pwa/session', { method: 'POST', body });
    const wasInvite = !!state.invite; state.invite = ''; $('password').value = ''; await verifySession({ initial: true });
    if (wasInvite) toast('账号已建立。可以把知微添加到主屏幕。');
  } catch (error) { $('auth-error').textContent = [400, 401, 403, 409].includes(error.status) ? (state.reset ? '重置链接不可用或密码未通过要求，请核对后重试。若此前已提交，可尝试用新密码登录。' : state.invite ? '邀请不可用或注册资料未通过，请检查后重试。若此前已提交，可尝试直接登录。' : '账号或密码不正确，请重试。') : friendly(error); }
  finally { $('auth-submit').disabled = false; }
});
$('auth-login-mode').addEventListener('click', () => { state.invite = ''; state.reset = ''; $('password').value = ''; showLogin(); });
$('message-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!canChat() || state.uploading || state.preparing || incompleteAttachments()) return;
  const text = $('composer').value.trim(); if (!text && !state.attachments.length) return;
  const generation = state.generation; const replyTo = state.replyTo; const mediaIds = state.attachments.map(m => m.id); state.preparing = true; updateConnection();
  try {
    if (replyTo && !await resolveReference(replyTo, true)) { toast('引用原文已不可用，请取消引用后再发。'); return; }
    if (generation !== state.generation || !canChat()) return;
    // Preserve edits made while the reference was being checked.
    if ($('composer').value.trim() !== text || state.replyTo !== replyTo || JSON.stringify(state.attachments.map(m => m.id)) !== JSON.stringify(mediaIds)) { toast('草稿已更新，请再点一次发送。'); return; }
    const p = { clientMessageId: crypto.randomUUID(), text, mediaIds, replyTo, createdAt: new Date().toISOString(), error: '', blocked: false, sending: false };
    attachmentNotice = '';
    state.pending.set(p.clientMessageId, p); $('composer').value = ''; state.attachments = []; state.replyTo = null; renderComposer(); resizeComposer(); renderPending(); scrollBottom(); await saveDraft(); void sendPending();
  } catch (error) { if (generation === state.generation) toast(friendly(error)); }
  finally { if (generation === state.generation) { state.preparing = false; renderComposer(); } }
});
$('composer').addEventListener('input', () => { resizeComposer(); scheduleDraft(); });
$('composer').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); $('message-form').requestSubmit(); } });
$('cancel-reply').addEventListener('click', () => { state.replyTo = null; renderComposer(); scheduleDraft(); });
$('attach-button').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', () => {
  const files = [...$('file-input').files]; $('file-input').value = '';
  if (!files.length || !canChat() || state.uploading || state.preparing) return;
  const problems = [];
  let extra = 0;
  for (const file of files) {
    const problem = fileProblem(file);
    if (problem) { problems.push(`${file.name}：${problem}`); continue; }
    if (state.attachments.length >= attachmentLimit) { extra++; continue; }
    state.attachments.push({ file, status: 'queued' });
  }
  if (extra) problems.push(`一次最多附上 ${attachmentLimit} 张，另有 ${extra} 张未加入。`);
  attachmentNotice = problems.join(' ');
  if (attachmentNotice) toast(attachmentNotice);
  renderComposer(); void saveDraft(); void uploadNextAttachment();
});
$('load-history').addEventListener('click', async () => {
  if (!state.messages.size) return; const oldHeight = $('timeline').scrollHeight; const generation = state.generation; $('load-history').disabled = true;
  try { const before = Math.min(...[...state.messages.values()].map(m => m.seq)); const data = await api(`/api/pwa/messages?before=${before}`); if (generation !== state.generation) return; mergeMessages(data.messages); state.hasMore = !!data.hasMore; renderMessages(); $('timeline').scrollTop += $('timeline').scrollHeight - oldHeight; }
  catch (error) { toast(friendly(error)); } finally { $('load-history').disabled = false; }
});
$('timeline').addEventListener('scroll', () => { if (atBottom()) { $('unread-jump').hidden = true; void markRead(); } }, { passive: true });
$('unread-jump').addEventListener('click', scrollBottom);
$('settings-open').addEventListener('click', () => { $('settings-dialog').showModal(); void refreshPushStatus(); });
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('install-info').addEventListener('click', () => $('settings-dialog').showModal());
$('gate-retry').addEventListener('click', () => { void verifySession(); });
$('logout-button').addEventListener('click', async () => {
  $('logout-button').disabled = true; localStorage.setItem('zhiwei-logout-pending', '1');
  const revocation = api('/api/pwa/session', { method: 'DELETE' }); state.verification++; clearPrivateUi();
  try { await revocation; localStorage.removeItem('zhiwei-logout-pending'); }
  catch { /* The marker blocks auto-login until the server confirms revocation. */ }
  try { const sub = await state.sw?.pushManager.getSubscription(); await sub?.unsubscribe(); } catch { /* Server session revocation also invalidates its subscription. */ }
  await clearDrafts(); clearPrivateUi(); $('logout-button').disabled = false;
  if (localStorage.getItem('zhiwei-logout-pending')) { $('gate-copy').textContent = '设备里的聊天和草稿已清理。联网后将完成退出。'; $('auth-form').hidden = true; $('gate-retry').hidden = false; }
  else showLogin('已退出登录。');
});
$('update-now').addEventListener('click', async () => {
  if (state.sending || state.uploading || activeAttachmentUpload || state.preparing) { toast('请等当前发送或图片上传结束，再更新。'); return; }
  if (!await saveDraft()) { toast('草稿暂时无法保存，请允许网站储存后再更新。'); return; }
  state.waiting?.postMessage({ type: 'ACTIVATE_UPDATE' });
});
window.addEventListener('online', () => { void verifySession(); });
window.addEventListener('offline', updateConnection);
window.addEventListener('storage', event => {
  if (event.key === 'zhiwei-logout-pending' && event.newValue === '1') {
    state.verification++;
    clearPrivateUi();
    showLogin('此设备已退出登录。');
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.user) { clearSpace(); void saveDraft(); disconnectStream(); $('chat-app').hidden = true; $('gate').hidden = false; $('gate-copy').textContent = '正在确认登录状态…'; $('auth-form').hidden = true; $('settings-dialog').close(); closeFeatureDialogs(); }
  else if (state.user || localStorage.getItem('zhiwei-logout-pending')) void verifySession();
});
window.addEventListener('pagehide', () => { clearSpace(); void saveDraft(); disconnectStream(); });
window.addEventListener('pageshow', event => { if (event.persisted) void verifySession(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', event => {
  if (event.data?.type !== 'OPEN_CONVERSATION') return;
  if (location.pathname.startsWith('/space')) history.pushState(null, '', '/');
  void verifySession().then(() => scrollBottom());
});
async function prepareServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    state.sw = await navigator.serviceWorker.ready;
    const offer = () => { if (registration.waiting && navigator.serviceWorker.controller) { state.waiting = registration.waiting; $('update-banner').hidden = false; } };
    offer(); registration.addEventListener('updatefound', () => { registration.installing?.addEventListener('statechange', offer); });
    let refreshing = false; navigator.serviceWorker.addEventListener('controllerchange', () => { if (!refreshing && state.waiting) { refreshing = true; location.reload(); } });
    if (state.user) void refreshPushStatus();
  } catch { /* HTTPS/unsupported browser keeps foreground chat usable. */ }
}
function consumeAuthFragment() {
  const fragment = new URLSearchParams(location.hash.slice(1)); state.invite = fragment.get('invite') || fragment.get('token') || '';
  state.reset = fragment.get('reset') || ''; if (state.reset) state.invite = '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return !!(state.invite || state.reset);
}
window.addEventListener('hashchange', async () => { if (!consumeAuthFragment()) return; state.verification++; $('chat-app').hidden = true; $('settings-dialog').close(); closeFeatureDialogs(); await saveDraft(); clearPrivateUi(); showLogin(); });
consumeAuthFragment();
void prepareServiceWorker();
if (state.invite || state.reset) showLogin(); else void verifySession({ initial: true });
