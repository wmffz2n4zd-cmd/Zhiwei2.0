import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeCapabilities, renderRuntimeCapabilities } from '../src/runtime-capabilities.js';

const now = Date.parse('2026-11-17T09:00:00Z');
const available = { now, worldEnabled: true, autonomousBrowsing: true, lifeEnabled: true,
  proactiveContactEnabled: true, memoryEnabled: true, stickersAvailable: true,
  platforms: ['web', 'x', 'xiaohongshu'], accounts: {
    x: { owned: true, configured: true, sessionStatus: 'unknown' },
    xiaohongshu: { owned: true, configured: true, sessionStatus: 'unknown' } } };
const web = { enabled: true, writable: true, currentConversation: true, images: true,
  references: true, history: true, legacyHistory: true, notificationServiceEnabled: true };

test('keyword searches use Xiaohongshu and explicitly shared URLs open directly', () => {
  const prompt = renderRuntimeCapabilities(buildRuntimeCapabilities({ ...available, chatLookupEnabled: true, nativeSearchEnabled: false }));
  assert.match(prompt, /关键词.*小红书站内搜索/);
  assert.match(prompt, /公共主题通过小红书站内搜索.*公开链接按原址读取/);
  assert.doesNotMatch(prompt, /内置联网搜索可用|已有入口为/);
  const offline = renderRuntimeCapabilities(buildRuntimeCapabilities({ ...available, worldEnabled: false, chatLookupEnabled: true, nativeSearchEnabled: false }));
  assert.match(offline, /按原址读取.*公开链接.*小红书站内搜索目前不可用/);
  for (const entry of ['chat', 'busy']) {
    assert.match(renderRuntimeCapabilities(buildRuntimeCapabilities({ ...available, chatLookupEnabled:true }), { entry }), /页面里的可选链接/);
  }
  for (const entry of ['planner', 'proactive', 'reading']) {
    assert.doesNotMatch(renderRuntimeCapabilities(buildRuntimeCapabilities({ ...available, chatLookupEnabled:true }), { entry }), /页面里的可选链接/);
  }
  assert.doesNotMatch(renderRuntimeCapabilities(buildRuntimeCapabilities(available)), /页面里的可选链接/);
});

test('registered ownership and configured session do not assert authenticated access', () => {
  const value = buildRuntimeCapabilities(available), prompt = renderRuntimeCapabilities(value);
  assert.equal(value.accounts.x.owned, true); assert.equal(value.accounts.x.configured, true);
  assert.equal(value.accounts.x.sessionStatus, 'unknown'); assert.equal(value.accounts.x.checkedAt, null);
  assert.match(prompt, /X：你有自己的账号/); assert.match(prompt, /小红书：你有自己的账号/);
  assert.match(prompt, /登录有效性尚未确认/); assert.doesNotMatch(prompt, /确认登录有效/);
});

test('session statuses require recent nonfuture evidence, independent of ownership', () => {
  const read = (sessionStatus, checkedAt, configured = true) => buildRuntimeCapabilities({ ...available,
    accounts: { x: { owned: true, configured, sessionStatus, checkedAt } } }).accounts.x;
  for (const status of ['valid', 'expired', 'blocked']) {
    assert.equal(read(status, now - 1000).sessionStatus, status);
    assert.equal(read(status, now - 25 * 3600000).sessionStatus, 'stale');
    assert.equal(read(status, undefined).sessionStatus, 'unknown');
    assert.equal(read(status, now + 1).sessionStatus, 'unknown');
    assert.equal(read(status, now, false).sessionStatus, 'unconfigured');
  }
  const value = buildRuntimeCapabilities({ ...available, accounts: { x: { configured: true, sessionStatus: 'valid', checkedAt: now } } });
  assert.equal(value.accounts.x.owned, false);
  assert.doesNotMatch(renderRuntimeCapabilities(value), /你有自己的账号/);
  assert.match(renderRuntimeCapabilities(value), /2026-11-17T09:00:00.000Z/);
});

test('disabled global service stays distinct from owned assets and enabled native search', () => {
  const value = buildRuntimeCapabilities({ ...available, worldEnabled: false, lifeEnabled: false,
    nativeSearchEnabled: true, chatLookupEnabled: false }), prompt = renderRuntimeCapabilities(value);
  assert.equal(value.browsing.autonomous, false); assert.equal(value.life.proactiveContact, false);
  assert.equal(value.accounts.x.owned, true);
  assert.match(prompt, /独立浏览服务目前不可用/); assert.match(prompt, /本轮内置联网搜索可用/);
  assert.doesNotMatch(prompt, /你可以上网冲浪/); assert.doesNotMatch(prompt, /本轮回复没有直接联网工具/);
  assert.doesNotMatch(renderRuntimeCapabilities(value, { entry: 'browse' }), /只是还没有读取/);
});

test('Hub lookup being off does not negate unknown native search or autonomous browsing', () => {
  const prompt = renderRuntimeCapabilities(buildRuntimeCapabilities(available));
  assert.match(prompt, /你可以上网冲浪/); assert.match(prompt, /自动预检索目前关闭/);
  assert.match(prompt, /以实际工具信息为准/); assert.doesNotMatch(prompt, /本轮回复没有直接联网工具/);
});

test('temporarily unready browsing and intent choice do not mean completed or unavailable capability', () => {
  const value = buildRuntimeCapabilities({ ...available, browsingReady: false, browseIntentAvailable: true });
  assert.equal(value.browsing.enabled, true); assert.equal(value.browsing.ready, false); assert.equal(value.browsing.intentAvailable, true);
  const prompt = renderRuntimeCapabilities(value);
  assert.match(prompt, /浏览功能已启用，但执行器当前未就绪/); assert.match(prompt, /提出意愿本身还不是已完成搜索/);
  assert.equal(buildRuntimeCapabilities(available).browsing.ready, null);
  const disabled = buildRuntimeCapabilities({ ...available, worldEnabled: false, browsingReady: true, browseIntentAvailable: true });
  assert.equal(disabled.browsing.ready, false); assert.equal(disabled.browsing.intentAvailable, false);
});

test('delegated planner browse and reading actions never claim direct native tools', () => {
  const value = buildRuntimeCapabilities({ ...available, nativeSearchEnabled: true });
  for (const entry of ['planner', 'browse', 'reading']) {
    const prompt = renderRuntimeCapabilities(value, { entry });
    assert.match(prompt, /通过已给出的行动选项安排浏览/);
    assert.doesNotMatch(prompt, /本轮内置联网搜索可用/);
    assert.match(prompt, /搜索摘要与正文区分/);
  }
  for (const entry of ['planner', 'browse']) assert.match(renderRuntimeCapabilities(value, { entry }), /这轮尚无网页材料只是还没有读取/);
  const noTools = renderRuntimeCapabilities(buildRuntimeCapabilities({ ...available, nativeSearchEnabled: false }), { entry: 'proactive' });
  assert.match(noTools, /本轮回复没有直接联网工具/); assert.match(noTools, /你可以上网冲浪/);
});

test('PWA describes existing references and history without enabling W1 W2 W3', () => {
  const value = buildRuntimeCapabilities({ ...available, pwa: { ...web, legacyReferences: true, historySearch: true, stickerPicker: true } });
  assert.equal(value.pwa.legacyReferences, true); assert.equal(value.pwa.historySearch, true); assert.equal(value.pwa.stickerPicker, true);
  const prompt = renderRuntimeCapabilities(value);
  assert.match(prompt, /当前通过邀请制网页\/PWA交流/); assert.match(prompt, /引用网页新消息及已保存的图片/);
  assert.match(prompt, /查看已关联的旧交流留存/); assert.match(prompt, /按关键词、日期和说话方查询/);
  assert.match(prompt, /选择、收藏和发送表情图片/); assert.doesNotMatch(prompt, /仍待补完/);
});

test('a text-only busy turn does not erase an existing sticker library', () => {
  const busy = buildRuntimeCapabilities({ ...available, stickersAvailable: true, stickerReplyAvailable: false });
  assert.equal(busy.stickers.available, true); assert.equal(busy.stickers.replyAvailable, false);
  const prompt = renderRuntimeCapabilities(busy, { entry: 'busy' });
  assert.match(prompt, /本地表情库可用；这轮只生成文字回复/);
  assert.doesNotMatch(prompt, /这轮按语境选用贴切的本地表情|暂无本地表情包/);
  const ordinary = buildRuntimeCapabilities({ ...available, stickerReplyAvailable: true });
  assert.equal(ordinary.stickers.replyAvailable, true);
  assert.match(renderRuntimeCapabilities(ordinary), /这轮按语境选用贴切的本地表情/);
  const uninspected = buildRuntimeCapabilities({ now });
  assert.equal(uninspected.stickers.available, null); assert.equal(uninspected.stickers.replyAvailable, null);
  assert.doesNotMatch(renderRuntimeCapabilities(uninspected), /本地表情库可用|暂无本地表情包/);
  const empty = buildRuntimeCapabilities({ now, stickersAvailable: false, stickerReplyAvailable: true });
  assert.equal(empty.stickers.available, false); assert.equal(empty.stickers.replyAvailable, false);
});

test('notification eligibility remains recipient-specific and unknown without evidence', () => {
  const withEligibility = eligibility => buildRuntimeCapabilities({ ...available, pwa: { ...web, notificationRecipientEligible: eligibility } });
  assert.equal(withEligibility(undefined).pwa.notificationRecipientEligible, null);
  assert.match(renderRuntimeCapabilities(withEligibility(undefined)), /本轮未确认/);
  assert.match(renderRuntimeCapabilities(withEligibility(true)), /当前对象已有有效通知订阅/);
  assert.match(renderRuntimeCapabilities(withEligibility(false)), /当前对象没有可用通知资格/);
  assert.match(renderRuntimeCapabilities(withEligibility(true)), /当前接入Apple推送/);
  assert.match(renderRuntimeCapabilities(withEligibility(true)), /实际到达以设备情况为准/);
  const publicValue = buildRuntimeCapabilities({ ...available, pwa: { ...web, currentConversation: false, notificationRecipientEligible: true } });
  assert.equal(publicValue.pwa.notificationRecipientEligible, null); assert.equal(publicValue.pwa.legacyHistory, false);
  assert.doesNotMatch(renderRuntimeCapabilities(publicValue), /当前对象已有|查看已关联的旧交流留存/);
});

test('read-only or disabled PWA cannot claim sending or notification capability', () => {
  const value = buildRuntimeCapabilities({ ...available, pwa: { ...web, writable: false, notificationRecipientEligible: true } });
  assert.equal(value.pwa.notificationServiceEnabled, false); assert.equal(value.pwa.notificationRecipientEligible, false);
  const prompt = renderRuntimeCapabilities(value);
  assert.match(prompt, /只读维护状态/); assert.match(prompt, /回看当前账号已保存的网页聊天/);
  assert.doesNotMatch(prompt, /支持[^。]*收发图片|支持[^。]*引用网页新消息|当前对象已有有效通知订阅/);
  const disabled = buildRuntimeCapabilities({ ...available, pwa: { ...web, enabled: false } });
  assert.equal(disabled.pwa.writable, false); assert.equal(disabled.pwa.images, false);
  assert.doesNotMatch(renderRuntimeCapabilities(disabled), /已接入邀请制网页|当前通过邀请制网页/);
});

test('configuration credentials recipient identifiers and unknown platforms are discarded', () => {
  const secret = 'PRIVATE_SECRET_SENTINEL';
  const value = buildRuntimeCapabilities({ ...available, cookie: secret, userText: secret,
    platforms: ['x', secret, 'x'], accounts: { x: { owned: true, configured: true,
      sessionStatus: secret, checkedAt: secret, cookie: secret, profileDir: secret, handle: secret }, [secret]: { configured: true } },
    pwa: { ...web, userId: secret, memoryScope: secret, subscription: { endpoint: secret }, notificationRecipientEligible: secret } });
  assert.deepEqual(value.browsing.platforms, ['x']); assert.equal(value.accounts.x.sessionStatus, 'unknown');
  assert.equal(value.pwa.notificationRecipientEligible, null);
  assert.doesNotMatch(JSON.stringify(value), new RegExp(secret)); assert.doesNotMatch(renderRuntimeCapabilities(value), new RegExp(secret));
  assert.ok(Object.isFrozen(value.accounts.x)); assert.ok(Object.isFrozen(value.pwa)); assert.ok(Object.isFrozen(value.browsing.platforms));
});

test('flags are explicit booleans; invalid clock rejects rather than inventing facts', () => {
  const value = buildRuntimeCapabilities({ now: () => now, worldEnabled: 'true', platforms: {}, pwa: { enabled: 'true' } });
  assert.equal(value.browsing.enabled, false); assert.equal(value.pwa.enabled, false); assert.deepEqual(value.browsing.platforms, []);
  assert.equal(value.observedAt, '2026-11-17T09:00:00.000Z');
  assert.equal(renderRuntimeCapabilities(null), ''); assert.equal(renderRuntimeCapabilities({ version: 99 }), '');
  assert.throws(() => buildRuntimeCapabilities({ now: NaN }), /observation time/);
});
