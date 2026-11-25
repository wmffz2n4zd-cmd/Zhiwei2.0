import { configuredVideoPlatforms } from './video-reader.js';

const SITE_LABELS = Object.freeze({ web: '普通网页', x: 'X', xiaohongshu: '小红书' });
const SITES = Object.freeze(Object.keys(SITE_LABELS));
const DAY = 24 * 60 * 60 * 1000;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const flag = value => value === true;
const nullableFlag = value => typeof value === 'boolean' ? value : null;

function instant(value) {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(at) && at >= 0 && at <= 8640000000000000 ? at : null;
}

function accountFact(value, at, maxAge) {
  const input = plain(value) ? value : {};
  const configured = flag(input.configured), checked = instant(input.checkedAt);
  const checkedAt = checked !== null && checked <= at ? new Date(checked).toISOString() : null;
  const observed = ['valid', 'expired', 'blocked'].includes(input.sessionStatus) ? input.sessionStatus : 'unknown';
  const sessionStatus = !configured ? 'unconfigured' : checkedAt === null ? 'unknown'
    : observed !== 'unknown' && at - checked > maxAge ? 'stale' : observed;
  return Object.freeze({ owned: flag(input.owned), configured, sessionStatus, checkedAt });
}

function pwaFact(value) {
  const input = plain(value) ? value : {};
  const enabled = flag(input.enabled), writable = enabled && flag(input.writable);
  const notificationServiceEnabled = writable && flag(input.notificationServiceEnabled);
  const currentConversation = enabled && flag(input.currentConversation);
  return Object.freeze({ enabled, writable, currentConversation,
    space: enabled && flag(input.space),
    spaceReplies: writable && flag(input.space) && flag(input.spaceReplies),
    thoughtReview: writable && currentConversation && flag(input.thoughtReview),
    ...(writable && currentConversation && Array.isArray(input.creativeKinds) && input.creativeKinds.length
      ? { creativeKinds: ['drawing','website','design','model3d'].filter(kind => input.creativeKinds.includes(kind)) } : {}),
    ...(writable && currentConversation && input.programWebsite === true && Array.isArray(input.creativeKinds)
      && input.creativeKinds.includes('website') ? { programWebsite: true } : {}),
    images: enabled && flag(input.images), references: enabled && flag(input.references),
    history: enabled && flag(input.history), legacyHistory: currentConversation && flag(input.legacyHistory),
    legacyReferences: currentConversation && flag(input.legacyReferences),
    historySearch: enabled && flag(input.historySearch), stickerPicker: enabled && flag(input.stickerPicker),
    notificationServiceEnabled,
    notificationRecipientEligible: !notificationServiceEnabled ? false
      : currentConversation ? nullableFlag(input.notificationRecipientEligible) : null });
}

function videoFact(value, pwa) {
  const input = plain(value) ? value : {};
  const enabled = flag(input.enabled), engineReady = enabled && flag(input.engineReady);
  const platforms = enabled && engineReady ? configuredVideoPlatforms(input.platforms) : [];
  const available = platforms.length > 0;
  const turnAvailable = available && pwa.writable && pwa.currentConversation && flag(input.turnAvailable);
  const evidence = plain(input.evidence) ? input.evidence : {};
  let status = turnAvailable && ['ok', 'partial', 'restricted', 'unavailable', 'unsupported'].includes(evidence.status)
    ? evidence.status : 'none';
  const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
  const materialStatus = ['ok', 'partial'].includes(status);
  const subtitleCount = materialStatus ? count(evidence.subtitleCount, 2000) : 0;
  const frameCount = materialStatus ? count(evidence.frameCount, 4) : 0;
  const hasMaterial = materialStatus && (subtitleCount > 0 || frameCount > 0);
  if (materialStatus && !hasMaterial) status = 'unavailable';
  return Object.freeze({ enabled, engineReady, available, turnAvailable,
    platforms: Object.freeze(platforms),
    evidence: Object.freeze({ status, subtitleCount, frameCount, hasMaterial,
      completeViewing: false, audioTranscribed: false }) });
}

/** Whitelisted runtime facts, never a config dump or a historical self-description.
 * Callers supply operational booleans and verified registration/session evidence.
 * Per-recipient PWA facts belong only in that recipient's private model input. */
export function buildRuntimeCapabilities({ worldEnabled = false, autonomousBrowsing = false,
  browsingReady = null, browseIntentAvailable = false,
  chatLookupEnabled = false, nativeSearchEnabled = null, lifeEnabled = false,
  proactiveContactEnabled = false, memoryEnabled = false, stickersAvailable = null, stickerReplyAvailable = null,
  platforms = ['web'], accounts = {}, pwa = {}, video = {}, now = Date.now(), sessionMaxAgeMs = DAY } = {}) {
  const at = instant(typeof now === 'function' ? now() : now);
  if (at === null) throw TypeError('Invalid capability observation time');
  const maxAge = Number.isSafeInteger(sessionMaxAgeMs) && sessionMaxAgeMs >= 0 ? sessionMaxAgeMs : DAY;
  const enabled = flag(worldEnabled), life = flag(lifeEnabled);
  const supported = Array.isArray(platforms) ? SITES.filter(site => platforms.includes(site)) : [];
  const registered = plain(accounts) ? accounts : {};
  const currentPwa = pwaFact(pwa);
  return Object.freeze({ version: 1, observedAt: new Date(at).toISOString(),
    browsing: Object.freeze({ enabled, ready: enabled ? nullableFlag(browsingReady) : false,
      autonomous: enabled && flag(autonomousBrowsing), intentAvailable: enabled && flag(browseIntentAvailable),
      platforms: Object.freeze(supported) }),
    chatSearch: Object.freeze({ hubEnabled: flag(chatLookupEnabled), nativeEnabled: nullableFlag(nativeSearchEnabled) }),
    life: Object.freeze({ enabled: life, proactiveContact: life && flag(proactiveContactEnabled) }),
    memory: Object.freeze({ enabled: flag(memoryEnabled) }),
    stickers: Object.freeze({ available: nullableFlag(stickersAvailable),
      replyAvailable: stickersAvailable === true ? nullableFlag(stickerReplyAvailable) : stickersAvailable === false ? false : null }),
    pwa: currentPwa, video: videoFact(video, currentPwa),
    accounts: Object.freeze({ x: accountFact(registered.x, at, maxAge),
      xiaohongshu: accountFact(registered.xiaohongshu, at, maxAge) }) });
}

function accountLine(site, fact) {
  if (!fact?.owned && !fact?.configured) return '';
  const ownership = fact.owned ? '你有自己的账号' : '已配置浏览会话资料';
  const state = fact.sessionStatus === 'valid' && fact.checkedAt
    ? `最近于${fact.checkedAt}确认登录有效，访问时仍以实际页面为准`
    : fact.sessionStatus === 'stale' ? `最近验证时间为${fact.checkedAt}，已过时，当前有效性待实际访问确认`
      : fact.sessionStatus === 'expired' ? `最近于${fact.checkedAt}观察到会话失效，可请维护者协助登录`
        : fact.sessionStatus === 'blocked' ? `最近于${fact.checkedAt}观察到访问受限`
          : fact.sessionStatus === 'unconfigured' ? '浏览会话尚待接入'
            : '已保留会话资料，登录有效性尚未确认，可尝试读取并查看结果';
  return `${SITE_LABELS[site]}：${ownership}；${state}。`;
}

/** entry shapes wording, never authorizes actions or adds tools to a model call. */
export function renderRuntimeCapabilities(snapshot, { entry = 'chat' } = {}) {
  if (!snapshot || snapshot.version !== 1) return '';
  const browse = snapshot.browsing || {}, search = snapshot.chatSearch || {}, life = snapshot.life || {};
  const pwa = snapshot.pwa || {}, delegated = ['planner', 'browse', 'reading'].includes(entry);
  const lines = ['你的当前能力与账号事实：'];
  if (browse.enabled === true) {
    lines.push('你可以上网冲浪。独立浏览器可以按原址打开公开网页，按兴趣从当前页面选择链接去其他网站继续读，也可以留下札记。');
    if (browse.platforms?.includes('xiaohongshu')) lines.push('想按关键词找内容时，在小红书站内搜索。');
    if (browse.ready === false) lines.push('浏览功能已启用，但执行器当前未就绪；意愿与实际执行结果分别记录。');
    if (browse.autonomous === true) lines.push('你也能自己产生浏览念头，阅读结果可成为后续生活和聊天的话头。');
  } else lines.push('独立浏览服务目前不可用；本轮其他查询能力以实际提供的入口为准。');
  for (const site of ['x', 'xiaohongshu']) {
    const text = accountLine(site, snapshot.accounts?.[site]);
    if (text) lines.push(text);
  }
  if (delegated) {
    if (browse.enabled === true) lines.push('本轮通过已给出的行动选项安排浏览，由执行器返回结果；账号或浏览能力本身不等于模型有直接工具。');
  } else {
    if (browse.intentAvailable === true) lines.push('本轮可以提出独立浏览意愿，后续执行和结果会另行记录；提出意愿本身还不是已完成搜索。');
    if (search.nativeEnabled === true) lines.push('本轮内置联网搜索可用，值得查证的公开问题可以检索后结合来源回应。');
    if (search.hubEnabled === true) {
      lines.push(browse.enabled && browse.platforms?.includes('xiaohongshu')
        ? '本轮可以按需申请聊天联网查询。提供的公共主题通过小红书站内搜索，当前分享的安全公开链接按原址读取。'
        : '本轮可以按需申请聊天联网查询，按原址读取当前分享的安全公开链接。小红书站内搜索目前不可用。');
      if (['chat', 'busy'].includes(entry)) lines.push('读到公开网页后，如果提供了页面里的可选链接，你可以挑其中一个继续读，也可以直接回答。');
      lines.push('结合本轮实际返回的来源回应。遇到空结果、登录或访问限制时，按回执说明读到了哪里。');
    }
    else if (search.nativeEnabled !== false) lines.push('聊天自动预检索目前关闭；这不等于不能联网，本轮搜索工具以实际工具信息为准。');
    else lines.push('本轮回复没有直接联网工具；已有浏览结果可以使用，独立浏览按上方状态运行。');
  }
  if (pwa.enabled === true) {
    const features = [];
    if (pwa.history === true) features.push('回看当前账号已保存的网页聊天');
    if (pwa.legacyHistory === true) features.push('查看已关联的旧交流留存');
    if (pwa.writable === true && pwa.images === true) features.push('收发图片');
    if (pwa.writable === true && pwa.references === true) features.push('引用网页新消息及已保存的图片');
    if (pwa.writable === true && pwa.legacyReferences === true) features.push('引用有实际原文的旧交流留存');
    if (pwa.historySearch === true) features.push('按关键词、日期和说话方查询有权查看的聊天原文');
    if (!delegated && pwa.creativeKinds?.length) {
      const names = { drawing: '绘图', website: '制作单页网站', design: '制作平面设计', model3d: '制作简单三维模型' };
      features.push(pwa.creativeKinds.map(kind => names[kind]).join('、') + '，将作品在本私聊中供对方预览和下载');
      if (pwa.programWebsite) features.push('用网站工具亲自编写离线交互单页，指定按钮在独立浏览器里试点，查看实际截图或报错，按需改代码、复测并交付。请把要测试的交互和验收要求写进网站委托');
    }
    if (pwa.space) features.push('登录后查看知微空间里的日常、点评和原内容链接');
    if (pwa.space && pwa.writable) features.push('在动态下发表所有登录用户可见的评论');
    if (pwa.spaceReplies) features.push('知微可选择在原评论下回复');
    if (pwa.stickerPicker === true) features.push(pwa.writable === true ? '选择、收藏和发送表情图片' : '查看表情图片');
    lines.push(`${pwa.currentConversation ? '当前通过邀请制网页/PWA交流' : '已接入邀请制网页/PWA'}${features.length ? `，支持${features.join('、')}` : ''}${pwa.writable === false ? '；目前处于只读维护状态' : ''}。`);
    lines.push('聊天历史和引用按实际留存展示；没有保存的原文或图片无法凭空恢复。');
    if (!delegated && pwa.thoughtReview) {
      lines.push('聊天后你可以重新考虑自己在这里记下的念头，自行决定现在做、改天再想或放下。'
        + (search.hubEnabled ? '如果当时分享的是可核实的公开文章，可以按原链接尝试阅读。' : '当前网页取材关闭。')
        + '取材情况以这个私聊中实际保存的回执为准。');
    }
    if (pwa.notificationServiceEnabled === true) {
      const eligibility = pwa.notificationRecipientEligible === true
        ? '当前对象已有有效通知订阅，可尝试系统提醒'
        : pwa.notificationRecipientEligible === false ? '当前对象没有可用通知资格，消息仍保存在网页中'
          : '对象设备是否具备有效通知订阅，本轮未确认';
      lines.push(`网页通知当前接入Apple推送；${eligibility}，实际到达以设备情况为准。`);
    }
  }
  // These facts describe the wired PWA route. They do not grant planner or
  // reader calls a new action, nor turn an available engine into prior evidence.
  if (!delegated && (pwa.enabled === true || snapshot.video?.enabled === true)) {
    const video = snapshot.video || {};
    const sites = configuredVideoPlatforms(video.platforms).map(site => site === 'youtube' ? 'YouTube' : 'B站').join('/');
    if (video.available === true && sites) {
      lines.push(`网页私聊视频取材已接入，可尝试读取本人分享或已核验引用的${sites}常规视频链接；登录、验证、地域或来源限制可能使其不可读，实际可得性以当次回执为准。`);
      if (video.turnAvailable !== true) lines.push('本轮未提供视频取材入口，也没有本轮已取得的视频材料。');
      else if (video.evidence?.hasMaterial === true) {
        const materials = [];
        if (video.evidence.subtitleCount > 0) materials.push('实际可得的字幕资料');
        if (video.evidence.frameCount > 0) materials.push(`${video.evidence.frameCount}张采样画面`);
        lines.push(`本轮已取得${materials.join('和')}，只能根据随本轮提供的资料回应；字幕可能截断或仅覆盖部分内容，画面是有限采样。`);
        if (video.evidence.subtitleCount === 0) lines.push('本轮没有可用字幕，不能根据画面编造未听到的声音或台词。');
      } else if (video.evidence?.status === 'restricted') lines.push('本轮视频来源访问受限，未取得可理解的字幕或画面；不要声称已看过，可以请对方提供可访问的片段、字幕或截图。');
      else if (['unavailable', 'unsupported'].includes(video.evidence?.status)) lines.push('本轮未取得可理解的视频字幕或画面；链接与标题不能当作看过视频，可以请对方提供字幕或截图。');
      else lines.push('本轮尚无已取得的视频材料；可以尝试读取不等于已经看到了内容。');
      lines.push('视频取材不包含逐帧观看、音轨转写或完整观看；引用具体内容须说明实际字幕或采样时间点及覆盖限制。');
    } else if (video.enabled === true) lines.push('视频取材已配置，但执行器尚未确认就绪；本轮没有视频读取能力，不能声称取得了字幕或画面。');
    else lines.push('视频取材目前未启用；本轮不能声称读取或看过链接中的视频。');

  }
  const optional = [];
  if (life.enabled === true) optional.push('按兴趣安排生活');
  if (life.proactiveContact === true) optional.push('在合适时机主动找人聊聊');
  if (snapshot.memory?.enabled === true) optional.push('回忆同一对象的交流与有来源的旧札记');
  if (snapshot.stickers?.available === true) {
    if (snapshot.stickers.replyAvailable === false) lines.push('本地表情库可用；这轮只生成文字回复，普通聊天可在支持图片的入口按语境选用表情。');
    else if (snapshot.stickers.replyAvailable === true) optional.push('这轮按语境选用贴切的本地表情');
    else lines.push('本地表情库可用，能否随这轮发出以本轮回复格式为准。');
  }
  if (optional.length) lines.push(`你还可以${optional.join('，')}。按当下兴趣和语境选择就好。`);
  if (browse.enabled === true && ['planner', 'browse'].includes(entry)) lines.push('这轮尚无网页材料只是还没有读取，可以用已有兴趣选择接下来想看的内容。');
  lines.push('当前事实可更新旧聊天中的自我描述。有实际查询或阅读回执时才据此说“搜到了”“看到了”；搜索摘要与正文区分，用已有知识回答就按已有知识表达。站点会话用于只读浏览，发帖、互动须有另行接入的动作入口。');
  return lines.join('\n');
}
