// Read-only notification fact projection, using real SQLite and synthetic users.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPwaStore } from '../src/pwa-store.js';
import vm from 'node:vm';
import { enabledCreativeKinds } from '../src/private-creative-work.js';
import { buildRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { isPwaEvent, pwaIdentityCurrent } from '../src/private-transport.js';

const DAY = 86400000;
async function fixture(t) {
  const parent = resolve('runtime/tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 't062-notification-'));
  let at = Date.UTC(2026, 10, 17);
  const store = createPwaStore({ path: join(directory, 'pwa.sqlite'), now: () => at });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  function user(name, memoryScope = null) {
    const invite = store.createInvitation({ role: 'friend', memoryScope });
    const claimed = store.claimInvitation({ token: invite.token, username: name, displayName: name, passwordHash: 'synthetic-password-hash' });
    return { ...claimed, ...store.createSession({ userId: claimed.user.userId, deviceName: 'synthetic' }) };
  }
  function subscribe(account) {
    return store.upsertSubscription({ userId: account.user.userId, sessionId: account.session.id,
      subscription: { endpoint: `https://web.push.apple.com/synthetic-${account.session.id}`,
        keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } } });
  }
  return { store, user, subscribe, advance: ms => { at += ms; } };
}

test('T062 notification fact is per-user and ignores disabled or removed subscriptions', async t => {
  const f = await fixture(t), a = f.user('alice'), b = f.user('bravo');
  assert.equal(f.store.notificationEligibility(a.user.userId), false);
  const sub = f.subscribe(a);
  assert.equal(f.store.notificationEligibility(a.user.userId), true);
  assert.equal(f.store.notificationEligibility(b.user.userId), false);
  assert.equal(f.store.notificationEligibility('nonexistent'), false);
  f.store.invalidateSubscription(sub.id);
  assert.equal(f.store.notificationEligibility(a.user.userId), false);
  f.subscribe(a); f.store.removeSubscription(a.session.id);
  assert.equal(f.store.notificationEligibility(a.user.userId), false);
});

test('T062 revoked and expired sessions cannot establish notification eligibility', async t => {
  const f = await fixture(t), a = f.user('alice'); f.subscribe(a);
  f.store.revokeSession(a.session.id);
  assert.equal(f.store.notificationEligibility(a.user.userId), false);
  const next = { ...a, ...f.store.createSession({ userId: a.user.userId }) }; f.subscribe(next);
  assert.equal(f.store.notificationEligibility(a.user.userId), true);
  f.advance(31 * DAY);
  assert.equal(f.store.notificationEligibility(a.user.userId), false);
});

test('T062 notification eligibility follows active binding, channel and account auth state', async t => {
  const f = await fixture(t), a = f.user('legacy', 'qq:private:900000101');
  assert.equal(f.store.notificationEligibility(a.user.userId), false);
  f.store.verifyBinding(a.user.userId); f.subscribe(a);
  assert.equal(f.store.notificationEligibility(a.user.userId), true);
  assert.throws(() => f.store.setPreferredChannel(a.user.userId, 'qq'), /invalid-channel/);
  assert.equal(f.store.notificationEligibility(a.user.userId), true, 'retired channel cannot replace current PWA route');
  f.store.setPreferredChannel(a.user.userId, 'pwa');
  assert.equal(f.store.notificationEligibility(a.user.userId), true);
  f.store.disableUser(a.user.userId);
  assert.equal(f.store.notificationEligibility(a.user.userId), false);
  f.store.disableUser(a.user.userId, false);
  assert.equal(f.store.notificationEligibility(a.user.userId), false, 'enabling user cannot revive revoked auth');
});

test('T062 notification projection is read-only and a surviving authorized device remains eligible', async t => {
  const f = await fixture(t), a = f.user('alice'); f.subscribe(a);
  const next = { ...a, ...f.store.createSession({ userId: a.user.userId }) }; f.subscribe(next);
  const before = f.store.getSession(next.session.id);
  f.store.revokeSession(a.session.id);
  for (let i = 0; i < 3; i++) assert.equal(f.store.notificationEligibility(a.user.userId), true);
  assert.deepEqual(f.store.getSession(next.session.id), before);
  f.store.createPasswordReset(a.user.userId);
  assert.equal(f.store.notificationEligibility(a.user.userId), false);
});

test('T062 real server fact provider keeps public entries recipient-free and current turn tools accurate', async t => {
  const f = await fixture(t), a = f.user('alice'), b = f.user('bravo'); f.subscribe(a);
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function creativeKindsFor('), end = source.indexOf('\nfunction currentCapabilityText', start);
  assert.ok(start >= 0 && end > start);
  let writable = true;
  const sandbox = { buildRuntimeCapabilities, isPwaEvent, pwaIdentityCurrent, enabledCreativeKinds,
    pwaStore: f.store, pwaMedia: {}, pwaPush: {}, pwaConfig: { enabled: true, pushEnabled: true, creativeTools: { drawing: true, design: false } },
    pwaWritable: () => writable, serviceLifecycle: { stopping: false }, privateVisionAvailable: true,
    pwaHistory: {}, pwaStickers: {},
    videoReader: null, videoTurnFacts: new WeakMap(), privateThoughtActions: null,
    world: { readiness: () => ({ enabled: true, busy: false, browser: { mode: 'closed', busy: false } }),
      accountFacts: () => ({ x: { owned: true, configured: true, sessionStatus: 'unknown' } }) },
    localConfig: { world: { xBrowser: {} } }, state: { privateChat: { webLookup: { enabled: false } } },
    replySettings: { mode: 'single' }, browseIntentsAvailable: () => true, lifeAvailable: () => true,
    unifiedMemory: { captureEpoch() {}, listPrivateExchanges() {}, readPrivateExchanges() {} },
    lifeProactive: {}, lifeContacts: { isPaused: () => false }, isLifeContactEligible: () => true,
    memoryScope: event => event.privateIdentity.memoryScope };
  const provider = vm.runInNewContext(source.slice(start, end) + '\ncurrentRuntimeCapabilities', sandbox);
  const eventA = { channel: 'pwa', privateIdentity: f.store.getIdentity(a.user.userId) };
  const eventB = { channel: 'pwa', privateIdentity: f.store.getIdentity(b.user.userId) };
  for (const entry of ['chat', 'busy', 'proactive']) {
    assert.deepEqual(provider({ entry, event: eventA }).pwa.creativeKinds, ['drawing']);
    assert.equal(provider({ entry }).pwa.creativeKinds, undefined);
  }
  const mismatched = { ...eventA, privateIdentity: { ...eventA.privateIdentity, userId: b.user.userId } };
  for (const event of [mismatched, { ...eventA, backendCommand: true }, { ...eventA, hubPreview: true }]) {
    assert.equal(provider({ event }).pwa.creativeKinds, undefined);
  }
  for (const entry of ['planner', 'browse', 'reading', 'conversation']) {
    assert.equal(provider({ entry, event: eventA }).pwa.creativeKinds, undefined);
  }
  assert.equal(provider({ event: eventA }).pwa.thoughtReview, false);
  sandbox.privateThoughtActions = {};
  assert.equal(provider({ event: eventA }).pwa.thoughtReview, true);
  assert.equal(provider({ entry: 'planner' }).pwa.thoughtReview, false);
  assert.equal(provider({ event: eventA }).video.available, false);
  sandbox.videoReader = {};
  sandbox.localConfig.video = { enabled: true };
  sandbox.videoTurnFacts.set(eventA, { status: 'ok', subtitleCount: 1, frameCount: 3 });
  assert.equal(provider({ event: eventA }).video.evidence.hasMaterial, true);
  assert.equal(provider({ event: eventB }).video.evidence.hasMaterial, false);
  assert.equal(provider({ entry: 'planner' }).video.turnAvailable, false);
  assert.equal(provider({ event: eventA }).pwa.notificationRecipientEligible, true);
  assert.equal(provider({ event: eventB }).pwa.notificationRecipientEligible, false);
  assert.equal(provider().pwa.notificationRecipientEligible, null);
  for (const entry of ['planner', 'browse', 'reading', 'proactive', 'conversation']) {
    const snapshot = provider({ entry });
    assert.equal(snapshot.pwa.currentConversation, false);
    assert.equal(snapshot.pwa.notificationRecipientEligible, null);
    assert.equal(snapshot.chatSearch.nativeEnabled, false);
    assert.equal(JSON.stringify(snapshot).includes(a.user.userId), false);
  }
  for (const entry of ['chat', 'busy']) assert.equal(provider({ entry, event: eventA }).chatSearch.nativeEnabled, false);
  sandbox.state.privateChat.webLookup.enabled = true;
  for (const entry of ['chat', 'busy']) assert.equal(provider({ entry, event: eventA }).chatSearch.nativeEnabled, false);
  sandbox.state.privateChat.webLookup.enabled = false;
  sandbox.replySettings.mode = 'two-stage';
  assert.equal(provider({ event: eventA }).chatSearch.nativeEnabled, false);
  writable = false;
  const maintained = provider({ event: eventA });
  assert.equal(maintained.pwa.writable, false);
  assert.equal(maintained.pwa.creativeKinds, undefined);
  assert.equal(maintained.pwa.thoughtReview, false);
  assert.equal(maintained.pwa.notificationServiceEnabled, false);
  assert.equal(maintained.pwa.notificationRecipientEligible, false);
});
