import Database from 'better-sqlite3';
import { creativeSchema, createCreativeStorage } from './pwa-creative-works.js';
import { mkdirSync, chmodSync, lstatSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isPrivateScope, isPrivateUserId, createPrivateIdentity } from './private-identity.js';
import { approvePublicTopics } from './chat-retrieval.js';
import { publicHttpUrl } from './chat-retrieval-http.js';

const DAY = 86400000;
const THOUGHT_LEASE = 10 * 60000;
const SPACE_DECISION_LEASE = 10 * 60000;
const SPACE_COMMENT_MAX_FAILURES = 3;
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const json = value => JSON.stringify(value);
const parse = (value, fallback = null) => value == null ? fallback : JSON.parse(value);
const integer = (value, low = 0) => Number.isSafeInteger(value) && value >= low;
const safeText = (value, max, empty = false) => typeof value === 'string' && value.length <= max
  && (empty || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const singleLine = (value, max) => safeText(value, max) && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
export class PwaStoreError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status = 400) => { throw new PwaStoreError(code, status); };
const assert = (condition, code, status) => { if (!condition) fail(code, status); };
export const pwaTokenHash = hash;
export function equalPwaSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y);
}

/** All mutations are synchronous SQLite transactions. No transaction spans await. */
export function createPwaStore({ path, now = Date.now, readOnly = false } = {}) {
  assert(typeof path === 'string' && path.length > 0, 'database-path-required');
  const databasePath = path === ':memory:' ? path : resolve(path);
  if (databasePath !== ':memory:') {
    if(!readOnly) mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(databasePath));
    assert(parent.isDirectory() && !parent.isSymbolicLink(), 'unsafe-database-directory');
    try { const info = lstatSync(databasePath); assert(info.isFile() && !info.isSymbolicLink(), 'unsafe-database-file'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const db = new Database(databasePath,{readonly:readOnly,fileMustExist:readOnly});
  db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
  if(!readOnly){db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');}
  if (databasePath !== ':memory:'&&!readOnly) chmodSync(databasePath, 0o600);
  const version = db.pragma('user_version', { simple: true });
  assert(version <= 1 && (!readOnly || version===1), 'unsupported-database-version', 503);
  if(!readOnly) db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('friend','admin')),
        enabled INTEGER NOT NULL DEFAULT 1, auth_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(user_id TEXT PRIMARY KEY REFERENCES users(id), memory_scope TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('pending','active')), route_version INTEGER NOT NULL DEFAULT 1,
        preferred_channel TEXT NOT NULL DEFAULT 'pwa', generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, memory_scope TEXT,
        role TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, claimed_by TEXT REFERENCES users(id), revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT NOT NULL, auth_version INTEGER NOT NULL, device_name TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS password_resets(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id), direction TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
        media_json TEXT NOT NULL DEFAULT '[]', reply_to TEXT, source TEXT NOT NULL, logical_reply_id TEXT,
        segment_index INTEGER, client_id TEXT, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(user_id,client_id), UNIQUE(user_id,logical_reply_id,segment_index));
      CREATE INDEX IF NOT EXISTS messages_user_sequence ON messages(user_id,seq);
      ${creativeSchema}
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        message_seq INTEGER NOT NULL UNIQUE REFERENCES messages(seq), state TEXT NOT NULL DEFAULT 'accepted',
        context_json TEXT NOT NULL DEFAULT '{}', reason TEXT, generation INTEGER NOT NULL, route_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        memory_scope TEXT NOT NULL, logical_reply_id TEXT NOT NULL, content_hash TEXT NOT NULL, message_ids TEXT NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projections(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        memory_scope TEXT NOT NULL, delivery_id TEXT NOT NULL, projection_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', result_json TEXT, reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS projections_scope_sequence ON projections(memory_scope,sequence);
      CREATE TABLE IF NOT EXISTS private_thoughts(
        user_id TEXT NOT NULL REFERENCES users(id), memory_scope TEXT NOT NULL, epoch TEXT NOT NULL,
        logical_reply_id TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL,
        inbound_ids TEXT NOT NULL, sent_message_ids TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,logical_reply_id));
      CREATE INDEX IF NOT EXISTS private_thoughts_recent ON private_thoughts(user_id,memory_scope,epoch,created_at);
      CREATE TABLE IF NOT EXISTS private_thought_reviews(
        user_id TEXT NOT NULL, logical_reply_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        next_at INTEGER, decided_at INTEGER, token TEXT, lease_until INTEGER, route_version INTEGER,
        source_id TEXT, source_url TEXT, receipt_json TEXT, deferrals INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,logical_reply_id),
        FOREIGN KEY(user_id,logical_reply_id) REFERENCES private_thoughts(user_id,logical_reply_id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS private_thought_reviews_due ON private_thought_reviews(status,next_at);
      CREATE TABLE IF NOT EXISTS space_posts(
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('daily','share')),
        body TEXT NOT NULL, published_at INTEGER NOT NULL, source_url TEXT, source_title TEXT,
        source_hash TEXT, observed_at INTEGER, basis_kind TEXT, basis_text TEXT, basis_hash TEXT,
        CHECK((kind='daily' AND source_url IS NULL AND source_title IS NULL AND source_hash IS NULL AND observed_at IS NULL
                    AND basis_kind IS NULL AND basis_text IS NULL AND basis_hash IS NULL)
           OR (kind='share' AND source_url IS NOT NULL AND source_title IS NOT NULL AND source_hash IS NOT NULL AND observed_at IS NOT NULL
                    AND basis_kind IS NOT NULL AND basis_kind IN ('article-excerpt','video-subtitles') AND basis_text IS NOT NULL AND basis_hash IS NOT NULL)));
      CREATE TABLE IF NOT EXISTS space_decisions(
        event_key TEXT PRIMARY KEY NOT NULL, claim TEXT, lease_until INTEGER, post_id INTEGER UNIQUE REFERENCES space_posts(id),
        CHECK((claim IS NULL AND lease_until IS NULL) OR (claim IS NOT NULL AND lease_until IS NOT NULL AND post_id IS NULL)));
      CREATE TABLE IF NOT EXISTS space_timeline_cursor(
        id INTEGER PRIMARY KEY CHECK(id=1), event_count INTEGER NOT NULL CHECK(event_count>=0));
      CREATE TABLE IF NOT EXISTS space_comments(
        id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES space_posts(id),
        user_id TEXT NOT NULL REFERENCES users(id), author_name TEXT NOT NULL, client_id TEXT NOT NULL,
        body TEXT NOT NULL, created_at INTEGER NOT NULL, available_at INTEGER NOT NULL,
        claim TEXT, claim_auth_version INTEGER, decided_at INTEGER, reply_body TEXT,
        outcome TEXT CHECK(outcome IN ('replied','skipped','failed')),
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND ${SPACE_COMMENT_MAX_FAILURES}),
        UNIQUE(user_id,client_id),
        CHECK((claim IS NULL) = (claim_auth_version IS NULL)),
        CHECK(decided_at IS NULL OR claim IS NULL),
        CHECK((outcome IS NULL) = (decided_at IS NULL)),
        CHECK((outcome IS 'replied') = (reply_body IS NOT NULL)),
        CHECK((outcome IS 'failed') = (failure_count=${SPACE_COMMENT_MAX_FAILURES})));
      CREATE INDEX IF NOT EXISTS space_comments_post ON space_comments(post_id,id);
      CREATE INDEX IF NOT EXISTS space_comments_due ON space_comments(available_at,id) WHERE decided_at IS NULL;
      INSERT OR IGNORE INTO private_thought_reviews(user_id,logical_reply_id,next_at)
        SELECT user_id,logical_reply_id,created_at+86400000 FROM private_thoughts;
      CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), path TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sticker_entries(user_id TEXT NOT NULL REFERENCES users(id), media_id TEXT NOT NULL REFERENCES media(id),
        name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_used_at INTEGER,
        favourite INTEGER NOT NULL DEFAULT 1, source_key TEXT, PRIMARY KEY(user_id,media_id), UNIQUE(user_id,source_key));
      CREATE TABLE IF NOT EXISTS read_cursors(user_id TEXT PRIMARY KEY REFERENCES users(id), seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id), endpoint TEXT NOT NULL, endpoint_hash TEXT NOT NULL,
        keys_json TEXT NOT NULL, authorization_version INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        preview INTEGER NOT NULL DEFAULT 0, reason TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS subscriptions_endpoint ON subscriptions(endpoint_hash);
      CREATE TABLE IF NOT EXISTS push_jobs(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        subscription_id TEXT NOT NULL REFERENCES subscriptions(id), authorization_version INTEGER NOT NULL,
        message_seq INTEGER NOT NULL REFERENCES messages(seq), logical_reply_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER,
        reason TEXT, status_code INTEGER, apns_id TEXT, UNIQUE(subscription_id,logical_reply_id));
      CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        action TEXT NOT NULL, user_id TEXT, detail_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS external_incoming(memory_scope TEXT NOT NULL, source_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(memory_scope,source_id));
    `);
    db.exec("CREATE INDEX IF NOT EXISTS creative_draft_age ON creative_works(touched_at) WHERE state<>'delivered'");
    db.pragma('user_version = 1');
  })();
  const q = sql => db.prepare(sql);
  const referenceAdmissions = new WeakMap();
  const transaction = fn => db.transaction(fn).immediate();
  const stamp = () => { const at = now(); assert(integer(at), 'invalid-clock', 503); return at; };
  const audit = (action, userId, detail = {}) => q('INSERT INTO audit(at,action,user_id,detail_json) VALUES(?,?,?,?)').run(stamp(), action, userId, json(detail));
  const publicUser = row => row ? { id: row.id, userId: row.id, username: row.username, displayName: row.display_name,
    role: row.role, enabled: Boolean(row.enabled), active: Boolean(row.enabled), authorizationVersion: row.auth_version, createdAt: row.created_at } : null;
  const userRow = userId => q('SELECT * FROM users WHERE id=?').get(userId);
  function identity(userId) {
    const row = q('SELECT u.id,u.role,u.enabled,u.display_name,b.* FROM users u JOIN bindings b ON b.user_id=u.id WHERE u.id=?').get(userId);
    return row ? createPrivateIdentity({ userId: row.id, memoryScope: row.memory_scope, role: row.role,
      enabled: Boolean(row.enabled), routeVersion: row.route_version, preferredChannel: row.preferred_channel,
      generation: row.generation, bindingStatus: row.status, displayName: row.display_name }) : null;
  }
  const active = userId => {
    const value = identity(userId);
    assert(value?.enabled, 'account-unavailable', 403); assert(value.bindingStatus === 'active', 'binding-pending', 403);
    return value;
  };
  const works = createCreativeStorage({ q, transaction, active, stamp, assert,
    available:Boolean(q("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creative_works'").get()) });
  function message(row) {
    if (!row) return null;
    const work = row.type === 'work' ? works.forMessage(row.user_id,row.id) : undefined;
    return { id:row.id, seq:row.seq, userId:row.user_id, direction:row.direction, type:row.type,
      text:work === null ? '先前会话中的作品' : row.text, mediaIds:parse(row.media_json,[]), replyTo:row.reply_to, source:row.source,
      ...(work === undefined ? {} : {work}), logicalReplyId:row.logical_reply_id, segmentIndex:row.segment_index,
      clientMessageId:row.client_id, createdAt:row.created_at };
  }
  const imageInboxSelect = `SELECT m.id,m.seq,m.created_at,m.text,m.media_json,m.reply_to,i.route_version,i.state,i.context_json
    FROM messages m JOIN inbox i ON i.message_seq=m.seq AND i.user_id=m.user_id WHERE m.user_id=?`;
  const imageInbox = row => row && ({ id: row.id, seq: row.seq, createdAt: row.created_at, text: row.text,
    mediaIds: parse(row.media_json, []), replyTo: row.reply_to, routeVersion: row.route_version, state: row.state,
    context: parse(row.context_json, {}) });
  const inboxValue = row => row ? { id: row.id, state: row.state, reason: row.reason, generation: row.generation,
    message: message(q('SELECT * FROM messages WHERE seq=?').get(row.message_seq)), user: publicUser(userRow(row.user_id)),
    identity: { ...identity(row.user_id), generation: row.generation, routeVersion: row.route_version }, context: parse(row.context_json, {}) } : null;
  function revokeSessionInner(sessionId, reason = 'signed-out') {
    q('UPDATE sessions SET revoked=1 WHERE id=?').run(sessionId);
    q('UPDATE subscriptions SET enabled=0, reason=? WHERE session_id=?').run(reason, sessionId);
    q(`UPDATE push_jobs SET state='cancelled',reason=? WHERE state IN ('pending','retry','sending')
      AND subscription_id IN (SELECT id FROM subscriptions WHERE session_id=?)`).run(reason, sessionId);
  }
  function revokeUserInner(userId, reason) {
    q('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(userId);
    q('UPDATE bindings SET route_version=route_version+1,generation=generation+1 WHERE user_id=?').run(userId);
    for (const row of q('SELECT id FROM sessions WHERE user_id=?').all(userId)) revokeSessionInner(row.id, reason);
  }
  function sessionValue(row) {
    if (!row) return null;
    const user = userRow(row.user_id), at = stamp();
    if (!user?.enabled || row.revoked || row.auth_version !== user.auth_version || row.expires_at <= at || row.absolute_expires_at <= at) return null;
    return { session: { id: row.id, userId: row.user_id, deviceName: row.device_name, expiresAt: row.expires_at,
      absoluteExpiresAt: row.absolute_expires_at, authorizationVersion: row.auth_version, csrfToken: row.csrf_token },
      user: publicUser(user), identity: identity(user.id), csrfToken: row.csrf_token };
  }
  function projectionValue(row) {
    return row ? { id: row.id, sequence: row.sequence, scope: row.memory_scope, deliveryId: row.delivery_id,
      projectionKey: row.projection_key, payload: parse(row.payload_json), state: row.state,
      result: parse(row.result_json), reason: row.reason, attempts: row.attempts } : null;
  }
  const hasStickerTable = Boolean(q("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sticker_entries'").get());
  const hasThoughtTable = Boolean(q("SELECT 1 FROM sqlite_master WHERE type='table' AND name='private_thoughts'").get());
  const hasReviewTable = Boolean(q("SELECT 1 FROM sqlite_master WHERE type='table' AND name='private_thought_reviews'").get());
  const hasSpaceTable = Boolean(q("SELECT 1 FROM sqlite_master WHERE type='table' AND name='space_posts'").get());
  const hasSpaceCursor = Boolean(q("SELECT 1 FROM sqlite_master WHERE type='table' AND name='space_timeline_cursor'").get());
  const hasSpaceComments = Boolean(q("SELECT 1 FROM sqlite_master WHERE type='table' AND name='space_comments'").get());
  function thoughtBinding(userId, scope) {
    const binding = identity(userId);
    return binding?.enabled && binding.bindingStatus === 'active' && binding.memoryScope === scope ? binding : null;
  }
  function liveReview(ticket) {
    if (!ticket || !isPrivateUserId(ticket.userId) || !isPrivateScope(ticket.scope)
      || !singleLine(ticket.epoch, 128) || !singleLine(ticket.token, 128) || !safeText(ticket.logicalReplyId, 160)
      || !integer(ticket.routeVersion, 1)) return null;
    return q(`SELECT t.*, r.status, r.source_id, r.source_url FROM private_thought_reviews r
      JOIN private_thoughts t USING(user_id,logical_reply_id)
      WHERE r.user_id=? AND r.logical_reply_id=? AND r.token=? AND r.route_version=? AND r.lease_until>?
        AND t.memory_scope=? AND t.epoch=? AND r.status IN ('reviewing','reading')`)
      .get(ticket.userId,ticket.logicalReplyId,ticket.token,ticket.routeVersion,stamp(),ticket.scope,ticket.epoch);
  }
  function reviewBinding(ticket) {
    const binding = thoughtBinding(ticket.userId, ticket.scope);
    return binding?.routeVersion === ticket.routeVersion && binding.preferredChannel === 'pwa';
  }
  function originalThoughtMessages(row, ticket) {
    const invalid = { valid: false, inbound: [], sent: [] };
    const source = q(`SELECT p.payload_json FROM projections p JOIN deliveries d ON d.id=p.delivery_id
      WHERE p.projection_key=? AND p.memory_scope=? AND d.user_id=? AND d.memory_scope=? AND d.logical_reply_id=?`)
      .get(ticket.logicalReplyId,ticket.scope,ticket.userId,ticket.scope,ticket.logicalReplyId);
    const material = parse(source?.payload_json);
    const event = material?.event;
    if (material?.version !== 1 || material.kind !== 'exchange' || material.skipMemory || event?.channel !== 'pwa'
      || event.type !== 'private_message' || event.backendCommand || event.skipExchangeMemory
      || event.privateIdentity?.userId !== ticket.userId || event.privateIdentity.memoryScope !== ticket.scope
      || event.privateIdentity.routeVersion !== ticket.routeVersion
      || event.memoryEpochToken?.scope !== ticket.scope || event.memoryEpochToken.epoch !== ticket.epoch
      || event.privateThought?.action !== row.action || event.privateThought.subject !== row.subject
      || json(material.thoughtInboundIds) !== row.inbound_ids || json(material.sentMessageIds) !== row.sent_message_ids) return invalid;
    const inbound = new Map();
    const original = q(`SELECT m.*,i.context_json FROM inbox i JOIN messages m ON m.seq=i.message_seq AND m.id=i.id AND m.user_id=i.user_id
      WHERE i.id=? AND i.user_id=? AND i.route_version=? AND m.direction='inbound' AND m.source='pwa'`);
    const intact = msg => msg && msg.content_hash === hash(json({text:msg.text,mediaIds:parse(msg.media_json),replyTo:msg.reply_to}));
    for (const id of material.thoughtInboundIds) {
      const msg = original.get(id,ticket.userId,ticket.routeVersion);
      if (!intact(msg)) return invalid;
      inbound.set(id,{ id, text:msg.text });
      if (!isPrivateUserId(msg.reply_to)) continue;
      // Only an explicitly quoted inbound share, projected by the Hub in the
      // same memory generation, can supply another original link. One hop only.
      const quote = original.get(msg.reply_to,ticket.userId,ticket.routeVersion);
      if (!intact(quote) || quote.seq >= msg.seq) continue;
      const context = parse(quote.context_json);
      if (context?.channel === 'pwa' && context.privateIdentity?.userId === ticket.userId
        && context.privateIdentity.memoryScope === ticket.scope && context.privateIdentity.routeVersion === ticket.routeVersion
        && context.memoryEpochToken?.scope === ticket.scope && context.memoryEpochToken.epoch === ticket.epoch) {
        inbound.set(quote.id,{ id:quote.id, text:quote.text });
      }
    }
    const sent = q(`SELECT id,text FROM messages WHERE user_id=? AND logical_reply_id=? AND direction='outbound' AND source='pwa'
      ORDER BY segment_index`).all(ticket.userId,ticket.logicalReplyId);
    if (!inbound.size || !sent.length || json(sent.map(msg => msg.id)) !== row.sent_message_ids) return invalid;
    return { valid: true, inbound:[...inbound.values()], sent };
  }
  function validThoughtReceipt(row, status, receipt) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
    if (status === 'read') {
      const complete = receipt.coverage === 'complete-article';
      return Object.keys(receipt).every(key => ['url','title','excerpt','fetchedAt','coverage','contentHash','textLength'].includes(key))
        && receipt.url === row.source_url && singleLine(receipt.title,300) && safeText(receipt.excerpt,complete ? 12000 : 600)
        && integer(receipt.fetchedAt) && ['complete-article','page-excerpt'].includes(receipt.coverage)
        && typeof receipt.contentHash === 'string' && /^[0-9a-f]{64}$/.test(receipt.contentHash)
        && integer(receipt.textLength,receipt.excerpt.length)
        && (!complete || (receipt.textLength === receipt.excerpt.length && hash(receipt.excerpt) === receipt.contentHash));
    }
    return Object.keys(receipt).every(key => ['url','fetchedAt','reason'].includes(key))
      && typeof receipt.reason === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(receipt.reason)
      && (receipt.url === undefined || receipt.url === row.source_url)
      && (receipt.fetchedAt === undefined || integer(receipt.fetchedAt));
  }
  const stickerValue = row => row ? { id: row.media_id, mediaId: row.media_id, name: row.name,
    favourite: Boolean(row.favourite), sourceKey: row.source_key, createdAt: row.created_at,
    lastUsedAt: row.last_used_at, mime: row.mime } : null;
  const spacePost = row => row ? {
    id:row.id, kind:row.kind, text:row.body, publishedAt:row.published_at,
    source:row.kind === 'share' ? {url:row.source_url,title:row.source_title} : null
  } : null;
  const validEventKey = key => singleLine(key,240) && key.trim() === key;
  const spaceComment = row => row ? {
    id:row.id, postId:row.post_id, authorName:row.author_name, text:row.body, createdAt:row.created_at,
    reply:row.reply_body === null ? null : {text:row.reply_body,createdAt:row.decided_at}
  } : null;
  const commentRow = id => q('SELECT * FROM space_comments WHERE id=?').get(id);
  // Evaluate ownership, current lease and account authorization in the decision write.
  const liveCommentClaim = `id=? AND claim=? AND available_at>? AND decided_at IS NULL
    AND EXISTS(SELECT 1 FROM users WHERE id=space_comments.user_id AND enabled=1 AND auth_version=space_comments.claim_auth_version)`;
  function commentText(text) {
    assert(safeText(text,1000) && !/[\u007f-\u009f\p{Surrogate}]/u.test(text), 'invalid-space-comment');
    return text.trim();
  }
  function validateSpacePost(post) {
    assert(post && Object.keys(post).every(key => ['kind','text','source'].includes(key))
      && ['daily','share'].includes(post.kind) && safeText(post.text,2000), 'invalid-space-post');
    if (post.kind === 'daily') {
      assert(post.source === null, 'invalid-space-source');
      return;
    }
    const source = post.source;
    assert(source && Object.keys(source).every(key => ['url','title','contentHash','observedAt','basisKind','basisText','basisHash'].includes(key))
      && singleLine(source.title,300) && typeof source.contentHash === 'string' && /^[a-f0-9]{64}$/.test(source.contentHash)
      && integer(source.observedAt) && ['article-excerpt','video-subtitles'].includes(source.basisKind)
      && safeText(source.basisText,2000) && source.basisHash === hash(source.basisText), 'invalid-space-source');
    let url;
    try { url = publicHttpUrl(source.url); } catch { fail('invalid-space-source'); }
    assert(url.protocol === 'https:' && url.href === source.url, 'invalid-space-source');
  }
  const api = {
    path: databasePath,
    ...works.api,
    spaceEventOffset(initialCount) {
      assert(integer(initialCount), 'invalid-space-offset');
      if (!hasSpaceCursor) return initialCount;
      const existing = q('SELECT event_count FROM space_timeline_cursor WHERE id=1').get();
      if (existing || readOnly) return existing?.event_count ?? initialCount;
      return transaction(() => {
        q('INSERT OR IGNORE INTO space_timeline_cursor(id,event_count) VALUES(1,?)').run(initialCount);
        return q('SELECT event_count FROM space_timeline_cursor WHERE id=1').get().event_count;
      });
    },
    advanceSpaceEventOffset(expected,next) {
      assert(integer(expected) && integer(next) && next>expected, 'invalid-space-offset');
      assert(!readOnly, 'read-only-maintenance', 503);
      return Boolean(q('UPDATE space_timeline_cursor SET event_count=? WHERE id=1 AND event_count=?').run(next,expected).changes);
    },
    hasSpaceDecision(eventKey) {
      assert(validEventKey(eventKey), 'invalid-space-event');
      return hasSpaceTable && Boolean(q('SELECT 1 FROM space_decisions WHERE event_key=? AND claim IS NULL').get(eventKey));
    },
    beginSpaceDecision(eventKey) {
      assert(validEventKey(eventKey), 'invalid-space-event');
      assert(!readOnly, 'read-only-maintenance', 503);
      return transaction(() => {
        const at = stamp(), claim = randomUUID();
        const result = q(`INSERT INTO space_decisions(event_key,claim,lease_until) VALUES(?,?,?)
          ON CONFLICT(event_key) DO UPDATE SET claim=excluded.claim,lease_until=excluded.lease_until
          WHERE space_decisions.claim IS NOT NULL AND space_decisions.lease_until<=?`)
          .run(eventKey,claim,at+SPACE_DECISION_LEASE,at);
        return result.changes ? claim : null;
      });
    },
    releaseSpaceDecision({eventKey,claim} = {}) {
      assert(validEventKey(eventKey) && singleLine(claim,64), 'invalid-space-claim');
      assert(!readOnly, 'read-only-maintenance', 503);
      return Boolean(q('DELETE FROM space_decisions WHERE event_key=? AND claim=? AND post_id IS NULL')
        .run(eventKey,claim).changes);
    },
    finishSpaceDecision({eventKey,claim,post} = {}) {
      assert(validEventKey(eventKey) && singleLine(claim,64), 'invalid-space-claim');
      assert(!readOnly, 'read-only-maintenance', 503);
      return transaction(() => {
        const at = stamp(), row = q('SELECT claim,lease_until,post_id FROM space_decisions WHERE event_key=?').get(eventKey);
        if (!row || row.claim !== claim || row.lease_until <= at) {
          return {duplicate:true,post:row?.post_id ? api.getSpacePost(row.post_id) : null};
        }
        let postId = null;
        if (post !== null) {
          validateSpacePost(post);
          const source = post.source;
          postId = q(`INSERT INTO space_posts(kind,body,published_at,source_url,source_title,source_hash,observed_at,
            basis_kind,basis_text,basis_hash) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(post.kind,post.text.trim(),at,
              source?.url ?? null,source?.title.trim() ?? null,source?.contentHash ?? null,source?.observedAt ?? null,
              source?.basisKind ?? null,source?.basisText ?? null,source?.basisHash ?? null).lastInsertRowid;
        }
        q('UPDATE space_decisions SET claim=NULL,lease_until=NULL,post_id=? WHERE event_key=?').run(postId,eventKey);
        return {duplicate:false,post:postId === null ? null : api.getSpacePost(postId)};
      });
    },
    getSpacePost(id) {
      assert(integer(id,1), 'invalid-space-post-id');
      return hasSpaceTable ? spacePost(q('SELECT * FROM space_posts WHERE id=?').get(id)) : null;
    },
    listSpacePosts({before,limit=20} = {}) {
      assert((before === undefined || integer(before,1)) && integer(limit,1) && limit <= 100, 'invalid-cursor');
      if (!hasSpaceTable) return {posts:[],nextBefore:null};
      const rows = before === undefined
        ? q('SELECT * FROM space_posts ORDER BY id DESC LIMIT ?').all(limit+1)
        : q('SELECT * FROM space_posts WHERE id<? ORDER BY id DESC LIMIT ?').all(before,limit+1);
      const posts = rows.slice(0,limit).map(spacePost);
      return {posts,nextBefore:rows.length > limit ? posts.at(-1).id : null};
    },
    listSpaceComments(postId,{before,limit=20} = {}) {
      assert((before === undefined || integer(before,1)) && integer(limit,1) && limit <= 100, 'invalid-cursor');
      assert(api.getSpacePost(postId), 'not-found', 404);
      if (!hasSpaceComments) return {comments:[],nextBefore:null};
      const rows = before === undefined
        ? q('SELECT * FROM space_comments WHERE post_id=? ORDER BY id DESC LIMIT ?').all(postId,limit+1)
        : q('SELECT * FROM space_comments WHERE post_id=? AND id<? ORDER BY id DESC LIMIT ?').all(postId,before,limit+1);
      const comments = rows.slice(0,limit).map(spaceComment);
      return {comments,nextBefore:rows.length > limit ? comments.at(-1).id : null};
    },
    addSpaceComment({userId,postId,clientCommentId,text} = {}) {
      assert(!readOnly, 'read-only-maintenance', 503);
      assert(singleLine(clientCommentId,120) && /^[A-Za-z0-9_.:-]+$/.test(clientCommentId), 'invalid-comment-id');
      const normalized = commentText(text);
      return transaction(() => {
        const user = q('SELECT display_name,enabled FROM users WHERE id=?').get(userId);
        assert(user?.enabled, 'account-unavailable', 403);
        assert(api.getSpacePost(postId), 'not-found', 404);
        const previous = q('SELECT * FROM space_comments WHERE user_id=? AND client_id=?').get(userId,clientCommentId);
        if (previous) {
          assert(previous.post_id === postId && previous.body === normalized, 'comment-id-conflict', 409);
          return {comment:spaceComment(previous),duplicate:true};
        }
        const at = stamp();
        const result = q(`INSERT INTO space_comments(post_id,user_id,author_name,client_id,body,created_at,available_at)
          VALUES(?,?,?,?,?,?,?)`).run(postId,userId,user.display_name,clientCommentId,normalized,at,at);
        return {comment:spaceComment(commentRow(result.lastInsertRowid)),duplicate:false};
      });
    },
    claimSpaceComment() {
      assert(!readOnly, 'read-only-maintenance', 503);
      return transaction(() => {
        const at = stamp();
        const row = q(`SELECT c.*,u.auth_version FROM space_comments c JOIN users u ON u.id=c.user_id
          WHERE c.decided_at IS NULL AND c.available_at<=? AND u.enabled=1 ORDER BY c.available_at,c.id LIMIT 1`).get(at);
        if (!row) return null;
        const claim = randomUUID();
        q('UPDATE space_comments SET claim=?,claim_auth_version=?,available_at=? WHERE id=?')
          .run(claim,row.auth_version,at+SPACE_DECISION_LEASE,row.id);
        return {claim,post:api.getSpacePost(row.post_id),comment:spaceComment(row)};
      });
    },
    releaseSpaceComment({commentId,claim} = {}) {
      assert(!readOnly, 'read-only-maintenance', 503);
      assert(integer(commentId,1) && singleLine(claim,64), 'invalid-space-claim');
      const at = stamp();
      return Boolean(q(`UPDATE space_comments SET claim=NULL,claim_auth_version=NULL,available_at=?
        WHERE id=? AND claim=? AND available_at>?`).run(at,commentId,claim,at).changes);
    },
    failSpaceComment({commentId,claim} = {}) {
      assert(!readOnly, 'read-only-maintenance', 503);
      assert(integer(commentId,1) && singleLine(claim,64), 'invalid-space-claim');
      const at = stamp();
      const result = q(`UPDATE space_comments SET claim=NULL,claim_auth_version=NULL,failure_count=failure_count+1,
        available_at=@retryAt, decided_at=CASE WHEN failure_count+1=@maxFailures THEN @at END,
        outcome=CASE WHEN failure_count+1=@maxFailures THEN 'failed' END
        WHERE ${liveCommentClaim} RETURNING outcome`)
        .get({retryAt:at+SPACE_DECISION_LEASE,maxFailures:SPACE_COMMENT_MAX_FAILURES,at},commentId,claim,at);
      return result ? (result.outcome ?? 'retry') : 'stale';
    },
    finishSpaceComment({commentId,claim,text} = {}) {
      assert(!readOnly, 'read-only-maintenance', 503);
      assert(integer(commentId,1) && singleLine(claim,64), 'invalid-space-claim');
      const reply = text === null ? null : commentText(text);
      return transaction(() => {
        const at = stamp();
        const result = q(`UPDATE space_comments SET reply_body=?,outcome=?,decided_at=?,claim=NULL,claim_auth_version=NULL
          WHERE ${liveCommentClaim}`).run(reply,reply === null ? 'skipped' : 'replied',at,commentId,claim,at);
        return {duplicate:!result.changes,comment:spaceComment(commentRow(commentId))};
      });
    },
    getUser: userId => publicUser(userRow(userId)),
    getCredentials(username) { return q('SELECT * FROM users WHERE username=?').get(String(username).trim().toLowerCase()) || null; },
    getIdentity: identity,
    getIdentityForScope(scope) { const row = q('SELECT user_id FROM bindings WHERE memory_scope=?').get(scope); return row ? identity(row.user_id) : null; },
    hasAcceptedInbox(scope) {return Boolean(q("SELECT 1 FROM inbox i JOIN bindings b ON b.user_id=i.user_id WHERE b.memory_scope=? AND i.state='accepted'").get(scope));},
    hasNewerPendingInbox({ userId, routeVersion, generation } = {}) {
      assert(isPrivateUserId(userId) && integer(routeVersion, 1) && integer(generation), 'invalid-inbox-query');
      return Boolean(q("SELECT 1 FROM inbox WHERE user_id=? AND route_version=? AND generation>? AND state IN ('accepted','projected','processing') LIMIT 1")
        .get(userId, routeVersion, generation));
    },
    listUsers() { return q('SELECT id FROM users ORDER BY created_at').all().map(row => ({ user: api.getUser(row.id), identity: identity(row.id) })); },
    createInvitation({ memoryScope = null, role = 'friend', expiresAt = stamp() + 3 * DAY } = {}) {
      assert(memoryScope === null || /^qq:private:[1-9]\d{0,127}$/.test(memoryScope), 'invalid-binding');
      assert(['friend', 'admin'].includes(role) && integer(expiresAt) && expiresAt > stamp(), 'invalid-invitation');
      return transaction(() => {
        assert(!memoryScope || !q('SELECT 1 FROM bindings WHERE memory_scope=?').get(memoryScope), 'identity-already-bound', 409);
        const id = randomUUID(), token = secret();
        q('INSERT INTO invitations(id,token_hash,memory_scope,role,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(id, hash(token), memoryScope, role, stamp(), expiresAt);
        audit('invitation-created', null, { invitationId: id, legacyBinding: Boolean(memoryScope), role });
        return { id, token, expiresAt };
      });
    },
    revokeInvitation(id) { return transaction(() => { const result = q('UPDATE invitations SET revoked=1 WHERE id=? AND claimed_by IS NULL').run(id); audit('invitation-revoked', null, { invitationId: id }); return { ok: result.changes > 0 }; }); },
    claimInvitation({ token, username, displayName, passwordHash } = {}) {
      username = String(username || '').trim().toLowerCase();
      assert(/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) && safeText(displayName, 80) && safeText(passwordHash, 1024), 'registration-unavailable');
      return transaction(() => {
        const invite = q('SELECT * FROM invitations WHERE token_hash=?').get(hash(token));
        assert(invite && !invite.revoked && !invite.claimed_by && invite.expires_at > stamp()
          && !q('SELECT 1 FROM users WHERE username=?').get(username)
          && (!invite.memory_scope || !q('SELECT 1 FROM bindings WHERE memory_scope=?').get(invite.memory_scope)), 'registration-unavailable', 400);
        const userId = randomUUID(), scope = invite.memory_scope || `private:user:${userId}`;
        q('INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(userId, username, displayName.trim(), passwordHash, invite.role, stamp());
        q('INSERT INTO bindings(user_id,memory_scope,status,preferred_channel) VALUES(?,?,?,?)').run(userId, scope,
          invite.memory_scope ? 'pending' : 'active', 'pwa');
        q('UPDATE invitations SET claimed_by=? WHERE id=?').run(userId, invite.id);
        q('INSERT INTO read_cursors(user_id,seq) VALUES(?,0)').run(userId);
        audit('invitation-claimed', userId, { invitationId: invite.id, pendingVerification: Boolean(invite.memory_scope) });
        return { user: publicUser(userRow(userId)), identity: identity(userId) };
      });
    },
    verifyBinding(userId) { return transaction(() => {
      assert(userRow(userId)?.enabled, 'account-unavailable', 404);
      q("UPDATE bindings SET status='active',preferred_channel='pwa',route_version=route_version+1,generation=generation+1 WHERE user_id=? AND status='pending'").run(userId);
      audit('legacy-binding-verified', userId); return identity(userId);
    }); },
    setPreferredChannel(userId, channel) { return transaction(() => {
      active(userId); assert(channel === 'pwa', 'invalid-channel');
      q('UPDATE bindings SET preferred_channel=?,route_version=route_version+1,generation=generation+1 WHERE user_id=? AND preferred_channel<>?').run(channel, userId, channel);
      audit('preferred-channel-changed', userId, { channel }); return identity(userId);
    }); },
    createSession({ userId, deviceName = '浏览器' } = {}) { return transaction(() => {
      const user = userRow(userId); assert(user?.enabled, 'login-unavailable', 401); assert(safeText(deviceName, 120), 'invalid-device');
      const id = randomUUID(), token = secret(), csrfToken = secret(), at = stamp();
      q(`INSERT INTO sessions(id,user_id,token_hash,csrf_token,auth_version,device_name,created_at,expires_at,absolute_expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, userId, hash(token), csrfToken, user.auth_version, deviceName, at, at + 30 * DAY, at + 90 * DAY);
      return { token, ...sessionValue(q('SELECT * FROM sessions WHERE id=?').get(id)) };
    }); },
    resolveSession(token, { touch = true } = {}) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const row = q('SELECT * FROM sessions WHERE token_hash=?').get(hash(token)), value = sessionValue(row);
      if (value && touch && row.expires_at < stamp() + 29 * DAY) {
        const expiresAt = Math.min(row.absolute_expires_at, stamp() + 30 * DAY);
        q('UPDATE sessions SET expires_at=? WHERE id=?').run(expiresAt, row.id); value.session.expiresAt = expiresAt;
      }
      return value;
    },
    getSession(sessionId) { return sessionValue(q('SELECT * FROM sessions WHERE id=?').get(sessionId)); },
    revokeSession(sessionId) { return transaction(() => { revokeSessionInner(sessionId); audit('session-revoked', null, { sessionId }); return { ok: true }; }); },
    disableUser(userId, disabled = true) { return transaction(() => {
      assert(userRow(userId), 'account-unavailable', 404); q('UPDATE users SET enabled=? WHERE id=?').run(disabled ? 0 : 1, userId);
      revokeUserInner(userId, disabled ? 'account-disabled' : 'account-reactivated'); audit(disabled ? 'account-disabled' : 'account-reactivated', userId);
      return publicUser(userRow(userId));
    }); },
    createPasswordReset(userId, { expiresAt = stamp() + 3600000 } = {}) { return transaction(() => {
      assert(userRow(userId), 'account-unavailable', 404); assert(integer(expiresAt) && expiresAt > stamp(), 'invalid-expiry');
      q('UPDATE password_resets SET used=1 WHERE user_id=?').run(userId); revokeUserInner(userId, 'password-reset-requested');
      const id = randomUUID(), token = secret(); q('INSERT INTO password_resets VALUES(?,?,?,?,0)').run(id, userId, hash(token), expiresAt);
      audit('password-reset-created', userId); return { id, token, expiresAt };
    }); },
    recoverUserAccess(userId,{expiresAt=stamp()+3600000}={}) {return transaction(()=>{
      assert(userRow(userId),'account-unavailable',404);
      // A restored/disabled person's old password is never re-enabled during recovery.
      q('UPDATE users SET enabled=1,password_hash=? WHERE id=?').run(`locked$${secret()}`,userId);
      const result=api.createPasswordReset(userId,{expiresAt});audit('account-recovery-created',userId);return result;
    });},
    quarantineAllAuthentication({reason='restored-authentication-quarantine'}={}) {return transaction(()=>{
      q('UPDATE users SET enabled=0,auth_version=auth_version+1').run();
      q('UPDATE bindings SET route_version=route_version+1,generation=generation+1').run();
      q('UPDATE invitations SET revoked=1').run();q('UPDATE password_resets SET used=1').run();q('UPDATE sessions SET revoked=1').run();
      q('UPDATE subscriptions SET enabled=0,authorization_version=authorization_version+1,reason=?').run(reason);
      q("UPDATE push_jobs SET state='cancelled',reason=? WHERE state IN ('pending','retry','sending')").run(reason);
      audit('all-authentication-quarantined',null);return {ok:true,disabledUsers:q('SELECT count(*) n FROM users').get().n};
    });},
    resetPassword({ token, passwordHash } = {}) { return transaction(() => {
      assert(safeText(passwordHash, 1024), 'reset-unavailable');
      const reset = q('SELECT * FROM password_resets WHERE token_hash=?').get(hash(token));
      assert(reset && !reset.used && reset.expires_at > stamp() && userRow(reset.user_id)?.enabled, 'reset-unavailable');
      q('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, reset.user_id); q('UPDATE password_resets SET used=1 WHERE id=?').run(reset.id);
      revokeUserInner(reset.user_id, 'password-reset'); audit('password-reset-completed', reset.user_id); return { ok: true };
    }); },
    addMedia({ userId, id = randomUUID(), path: mediaPath, mime, size, sha256 } = {}) {
      active(userId); assert(isPrivateUserId(id) && safeText(mediaPath, 4096) && ['image/png','image/jpeg','image/gif','image/webp'].includes(mime)
        && integer(size, 1) && size <= 20 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(sha256), 'invalid-media');
      q('INSERT INTO media VALUES(?,?,?,?,?,?,?)').run(id, userId, mediaPath, mime, size, sha256, stamp()); return api.getMedia(userId, id);
    },
    getMedia(userId, id) { active(userId); const row = q('SELECT * FROM media WHERE id=? AND user_id=?').get(id, userId); return row ? { id: row.id, userId: row.user_id, path: row.path, mime: row.mime, size: row.size, sha256: row.sha256 } : null; },
    getSticker(userId, mediaId) {
      active(userId); if (!hasStickerTable) return null;
      return stickerValue(q('SELECT s.*,m.mime FROM sticker_entries s JOIN media m ON m.id=s.media_id AND m.user_id=s.user_id WHERE s.user_id=? AND s.media_id=?').get(userId, mediaId));
    },
    findStickerBySource(userId, sourceKey) {
      active(userId); if (!hasStickerTable) return null;
      return stickerValue(q('SELECT s.*,m.mime FROM sticker_entries s JOIN media m ON m.id=s.media_id AND m.user_id=s.user_id WHERE s.user_id=? AND s.source_key=?').get(userId, sourceKey));
    },
    listStickers(userId, { kind = 'favourites', limit = 60, before = null } = {}) {
      active(userId); assert(['favourites','recent'].includes(kind) && integer(limit, 1) && limit <= 151
        && (before === null || before && integer(before.at) && isPrivateUserId(before.id)), 'invalid-sticker-query');
      if (!hasStickerTable) return [];
      const order = kind === 'favourites' ? 's.created_at' : 's.last_used_at';
      return q(`SELECT s.*,m.mime FROM sticker_entries s JOIN media m ON m.id=s.media_id AND m.user_id=s.user_id
        WHERE s.user_id=? AND ${kind === 'favourites' ? 's.favourite=1' : 's.last_used_at IS NOT NULL'}
        ${before ? `AND (${order}<? OR (${order}=? AND s.media_id<?))` : ''}
        ORDER BY ${order} DESC,s.media_id DESC LIMIT ?`).all(userId, ...(before ? [before.at,before.at,before.id] : []), limit).map(stickerValue);
    },
    saveSticker(userId, { mediaId, name, favourite = true, sourceKey = null } = {}) { return transaction(() => {
      active(userId); assert(isPrivateUserId(mediaId) && api.getMedia(userId, mediaId), 'media-unavailable', 404);
      assert((name === undefined || safeText(name, 80, true)) && typeof favourite === 'boolean'
        && (sourceKey === null || typeof sourceKey === 'string' && /^shared:[a-f0-9]{64}:[a-f0-9]{64}$/.test(sourceKey)), 'invalid-sticker');
      const old = api.getSticker(userId, mediaId), bySource = sourceKey && api.findStickerBySource(userId, sourceKey);
      const previous = old || bySource;
      if (bySource && bySource.mediaId !== mediaId) q('DELETE FROM sticker_entries WHERE user_id=? AND media_id=?').run(userId, bySource.mediaId);
      q(`INSERT INTO sticker_entries(user_id,media_id,name,created_at,last_used_at,favourite,source_key) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(user_id,media_id) DO UPDATE SET name=excluded.name,favourite=excluded.favourite,source_key=excluded.source_key`)
        .run(userId, mediaId, name === undefined ? previous?.name || '表情' : name.trim(), previous?.createdAt ?? stamp(),
          previous?.lastUsedAt ?? null, favourite || previous?.favourite ? 1 : 0, sourceKey || previous?.sourceKey || null);
      return api.getSticker(userId, mediaId);
    }); },
    removeSticker(userId, mediaId) { return transaction(() => {
      active(userId); assert(api.getSticker(userId, mediaId), 'sticker-unavailable', 404);
      q('UPDATE sticker_entries SET favourite=0 WHERE user_id=? AND media_id=?').run(userId, mediaId); return { ok: true };
    }); },
    touchSticker(userId, mediaId) { return transaction(() => {
      active(userId); assert(api.getMedia(userId, mediaId), 'media-unavailable', 404);
      if (!api.getSticker(userId, mediaId)) q("INSERT INTO sticker_entries(user_id,media_id,name,created_at,last_used_at,favourite) VALUES(?,?,'表情',?,?,0)").run(userId, mediaId, stamp(), stamp());
      else q('UPDATE sticker_entries SET last_used_at=? WHERE user_id=? AND media_id=?').run(stamp(), userId, mediaId);
      return api.getSticker(userId, mediaId);
    }); },
    authorizeLegacyReference(userId, ref) {
      const binding = active(userId);
      assert(typeof ref === 'string' && /^l1_[a-f0-9]{64}_[ua]$/.test(ref), 'reply-unavailable', 404);
      const token = Object.freeze({});
      referenceAdmissions.set(token, { userId, ref, scope: binding.memoryScope, route: binding.routeVersion, expires: stamp() + 1000 });
      return token;
    },
    getImageInbox(userId, id) {
      active(userId); return imageInbox(q(imageInboxSelect + ' AND m.id=?').get(userId, id));
    },
    *recentImageInbox(userId, before, since) {
      active(userId);
      const recent = q(imageInboxSelect + ' AND m.seq<? ORDER BY m.seq DESC').iterate(userId, before);
      for (const row of recent) {
        if (row.created_at < since) break;
        yield imageInbox(row);
      }
    },
    getMessageByClientId(userId, clientId) { active(userId); return typeof clientId === 'string' ? message(q('SELECT * FROM messages WHERE user_id=? AND client_id=?').get(userId, clientId)) : null; },
    readHistoryMessages(userId) { active(userId); return q('SELECT * FROM messages WHERE user_id=? ORDER BY seq').all(userId).map(message); },
    acceptInbound({ userId, clientMessageId, text = '', mediaIds = [], replyTo = null, referenceAdmission } = {}) { return transaction(() => {
      const binding = active(userId);
      assert(safeText(clientMessageId, 120) && /^[A-Za-z0-9_.:-]+$/.test(clientMessageId) && safeText(text, 16000, true)
        && Array.isArray(mediaIds) && mediaIds.length <= 4 && mediaIds.every(isPrivateUserId) && (text.trim() || mediaIds.length), 'invalid-message');
      const fingerprint = hash(json({ text, mediaIds, replyTo }));
      const old = q('SELECT * FROM messages WHERE user_id=? AND client_id=?').get(userId, clientMessageId);
      if (old) { assert(old.content_hash === fingerprint, 'message-id-conflict', 409); return { message: message(old), inboxId: old.id, identity: binding, duplicate: true }; }
      assert(mediaIds.every(id => q('SELECT 1 FROM media WHERE id=? AND user_id=?').get(id, userId)), 'media-unavailable', 404);
      const admitted = referenceAdmission && referenceAdmissions.get(referenceAdmission);
      if (referenceAdmission) referenceAdmissions.delete(referenceAdmission);
      assert(replyTo === null || typeof replyTo === 'string' && (q('SELECT 1 FROM messages WHERE id=? AND user_id=?').get(replyTo, userId)
        || admitted && admitted.userId === userId && admitted.ref === replyTo && admitted.scope === binding.memoryScope
          && admitted.route === binding.routeVersion && admitted.expires >= stamp()), 'reply-unavailable', 404);
      const id = randomUUID(), at = stamp();
      const inserted = q(`INSERT INTO messages(id,user_id,direction,type,text,media_json,reply_to,source,client_id,content_hash,created_at)
        VALUES(?,?,'inbound',?,?,?,?, 'pwa',?,?,?)`).run(id, userId, mediaIds.length ? 'mixed' : 'text', text, json(mediaIds), replyTo, clientMessageId, fingerprint, at);
      q('UPDATE bindings SET generation=generation+1 WHERE user_id=?').run(userId);
      const updated = identity(userId);
      q('INSERT INTO inbox(id,user_id,message_seq,generation,route_version) VALUES(?,?,?,?,?)').run(id, userId, inserted.lastInsertRowid, updated.generation, updated.routeVersion);
      return { message: message(q('SELECT * FROM messages WHERE id=?').get(id)), inboxId: id, identity: updated, duplicate: false };
    }); },
    getMessage(userId, id) { active(userId); return message(q('SELECT * FROM messages WHERE id=? AND user_id=?').get(id, userId)); },
    getOwnMessage(userId,id) { return api.getMessage(userId,id); },
    listMessages(userId, { after, before = null, limit = 50 } = {}) {
      active(userId); assert((after === undefined || integer(after)) && (before === null || integer(before, 1)) && integer(limit, 1) && limit <= 200
        && !(after !== undefined && before !== null), 'invalid-cursor');
      for (const cursor of [after, before]) if (cursor) assert(q('SELECT 1 FROM messages WHERE seq=? AND user_id=?').get(cursor, userId), 'invalid-cursor', 400);
      const rows = after !== undefined ? q('SELECT * FROM messages WHERE user_id=? AND seq>? ORDER BY seq LIMIT ?').all(userId, after, limit)
        : before !== null ? q('SELECT * FROM messages WHERE user_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(userId, before, limit).reverse()
          : q('SELECT * FROM messages WHERE user_id=? ORDER BY seq DESC LIMIT ?').all(userId,limit).reverse();
      const read = q('SELECT seq FROM read_cursors WHERE user_id=?').get(userId)?.seq || 0;
      return { messages: rows.map(message), readSeq: read,
        hasMore: rows.length > 0 && Boolean(after !== undefined
          ? q('SELECT 1 FROM messages WHERE user_id=? AND seq>? LIMIT 1').get(userId,rows.at(-1).seq)
          : q('SELECT 1 FROM messages WHERE user_id=? AND seq<? LIMIT 1').get(userId,rows[0].seq)),
        unread: q("SELECT count(*) n FROM messages WHERE user_id=? AND direction='outbound' AND seq>?").get(userId, read).n,
        latestSeq: q('SELECT COALESCE(MAX(seq),0) n FROM messages WHERE user_id=?').get(userId).n };
    },
    markRead(userId, seq) { return transaction(() => {
      active(userId); assert(integer(seq) && (seq === 0 || q('SELECT 1 FROM messages WHERE seq=? AND user_id=?').get(seq, userId)), 'invalid-cursor');
      q('UPDATE read_cursors SET seq=MAX(seq,?) WHERE user_id=?').run(seq, userId);
      q("UPDATE push_jobs SET state='cancelled',reason='already-read' WHERE user_id=? AND message_seq<=? AND state IN ('pending','retry')").run(userId, seq);
      return { readSeq: q('SELECT seq FROM read_cursors WHERE user_id=?').get(userId).seq };
    }); },
    getInbox(id) { return inboxValue(q('SELECT * FROM inbox WHERE id=?').get(id)); },
    getInboxByMessage(id) { return api.getInbox(id); },
    pendingInboxHighWatermark() { return q("SELECT COALESCE(MAX(message_seq),0) seq FROM inbox WHERE state IN ('accepted','projected','processing')").get().seq; },
    listPendingInbox({ limit = 50, afterSeq = 0, throughSeq = Number.MAX_SAFE_INTEGER } = {}) {
      assert(integer(limit, 1) && limit <= 1000, 'invalid-limit');
      assert(integer(afterSeq) && integer(throughSeq) && throughSeq >= afterSeq, 'invalid-inbox-cursor');
      return q("SELECT * FROM inbox WHERE state IN ('accepted','projected','processing') AND message_seq>? AND message_seq<=? ORDER BY message_seq LIMIT ?")
        .all(afterSeq, throughSeq, limit).map(inboxValue);
    },
    markInboxProjected(id, context = {}) { return transaction(() => {
      assert(json(context).length <= 64000, 'invalid-intake-context'); const row = q('SELECT * FROM inbox WHERE id=?').get(id); assert(row, 'inbox-unavailable', 404);
      if (row.state === 'accepted') q("UPDATE inbox SET state='projected',context_json=? WHERE id=?").run(json(context), id);
      return api.getInbox(id);
    }); },
    claimInbox(id) { return transaction(() => {
      const row = q('SELECT * FROM inbox WHERE id=?').get(id); assert(row, 'inbox-unavailable', 404); const binding = active(row.user_id);
      assert(!q("SELECT 1 FROM projections WHERE memory_scope=? AND state IN ('pending','processing','failed')").get(binding.memoryScope), 'projection-pending', 409);
      assert(['projected','processing'].includes(row.state), 'intake-not-projected', 409);
      q("UPDATE inbox SET state='processing' WHERE id=?").run(id); return api.getInbox(id);
    }); },
    completeInbox(id, { state = 'complete', reason = null } = {}) {
      assert(['complete','cancelled','failed'].includes(state), 'invalid-inbox-state'); q('UPDATE inbox SET state=?,reason=? WHERE id=?').run(state, reason ? String(reason).slice(0,120) : null, id); return { ok: true };
    },
    publishSegments({ userId, scope, routeVersion, generation, creativeContextKey = '', inboundIds = [], imageCursor, deliveryId, logicalReplyId = deliveryId,
      segmentIndex = 0, segments = [], projection = null, projectionKey = logicalReplyId, allowedPendingProjectionKey = null } = {}) { return transaction(() => {
      assert(safeText(deliveryId,160) && safeText(logicalReplyId,160) && safeText(projectionKey,160) && integer(segmentIndex)
        && Array.isArray(segments) && segments.length > 0 && segments.length <= 8, 'invalid-delivery');
      const normalized = segments.map(segment => {
        assert(segment && ['text','image','work'].includes(segment.type), 'invalid-segment');
        if (segment.type === 'work') {
          const work = works.forDelivery({ userId,scope,routeVersion,generation,logicalReplyId,workId:segment.workId,contextKey:creativeContextKey });
          assert(segment.text == null || safeText(segment.text,16000,true), 'invalid-segment');
          return { type:'work', text:segment.text?.trim() || work.title, mediaIds:[], workId:work.id };
        }
        if (segment.type === 'text') { assert(safeText(segment.text, 16000), 'invalid-segment'); return { type: 'text', text: segment.text, mediaIds: [] }; }
        assert(isPrivateUserId(segment.mediaId) && q('SELECT 1 FROM media WHERE id=? AND user_id=?').get(segment.mediaId, userId), 'media-unavailable', 404);
        return { type: 'image', text: '', mediaIds: [segment.mediaId] };
      });
      const fingerprint = hash(json({ userId,scope,logicalReplyId,segmentIndex,segments:normalized }));
      const old = q('SELECT * FROM deliveries WHERE id=?').get(deliveryId);
      if (old) { assert(old.user_id === userId && old.content_hash === fingerprint, 'delivery-id-conflict',409); return { ...api.getDelivery(deliveryId), duplicate: true }; }
      const binding = active(userId);
      assert(binding.memoryScope === scope && binding.routeVersion === routeVersion && binding.generation === generation, 'delivery-stale',409);
      assert(Array.isArray(inboundIds) && inboundIds.every(id => q('SELECT 1 FROM inbox WHERE id=? AND user_id=?').get(id,userId)), 'invalid-inbound-reference');
      assert(!q("SELECT 1 FROM inbox WHERE user_id=? AND state='accepted'").get(userId), 'intake-pending',409);
      const blocking = q("SELECT * FROM projections WHERE memory_scope=? AND state IN ('pending','processing','failed')").all(scope);
      assert(blocking.every(row => row.projection_key === allowedPendingProjectionKey && row.state === 'pending'), 'projection-pending',409);
      assert(projection && typeof projection === 'object' && json(projection).length <= 256000, 'projection-required');
      const oldProjection = q('SELECT * FROM projections WHERE projection_key=?').get(projectionKey);
      assert(!oldProjection || oldProjection.memory_scope === scope && oldProjection.state === 'pending', 'projection-already-committed',409);
      const at = stamp(), result = [];
      for (let index=0; index<normalized.length; index++) {
        const segment=normalized[index], id=randomUUID();
        q(`INSERT INTO messages(id,user_id,direction,type,text,media_json,source,logical_reply_id,segment_index,content_hash,created_at)
          VALUES(?,?,'outbound',?,?,?,'pwa',?,?,?,?)`).run(id,userId,segment.type,segment.text,json(segment.mediaIds),logicalReplyId,segmentIndex+index,fingerprint,at);
        if (segment.type === 'work') works.attach(segment.workId,id);
        result.push(message(q('SELECT * FROM messages WHERE id=?').get(id)));
      }
      q('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)').run(deliveryId,userId,scope,logicalReplyId,fingerprint,json(result.map(row=>row.id)),at);
      const published=q('SELECT id,seq FROM messages WHERE user_id=? AND logical_reply_id=? ORDER BY segment_index').all(userId,logicalReplyId);
      const durableProjection={...projection,logicalReplyId,deliveryId,sentMessageIds:published.map(row=>row.id),publishedThroughSeq:published.at(-1).seq};
      // Bind the model's proposal to the inbox rows validated in this publication transaction.
      if (projection.event?.privateThought) durableProjection.thoughtInboundIds = inboundIds;
      if (oldProjection) q('UPDATE projections SET payload_json=?,delivery_id=?,updated_at=? WHERE id=?').run(json(durableProjection),deliveryId,at,oldProjection.id);
      else q('INSERT INTO projections(id,memory_scope,delivery_id,projection_key,payload_json,updated_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),scope,deliveryId,projectionKey,json(durableProjection),at);
      if (imageCursor && inboundIds.length) {
        const latest = inboundIds.map(id => q('SELECT id,message_seq FROM inbox WHERE user_id=? AND id=?').get(userId,id))
          .reduce((a,b) => a.message_seq > b.message_seq ? a : b);
        q("UPDATE inbox SET context_json=json_set(context_json,'$.imageCursor',json(?)) WHERE user_id=? AND id=?")
          .run(json(imageCursor),userId,latest.id);
      }
      const last=result.at(-1), read=q('SELECT seq FROM read_cursors WHERE user_id=?').get(userId)?.seq||0;
      for (const subscription of q('SELECT * FROM subscriptions WHERE user_id=? AND enabled=1').all(userId)) {
        if (!api.getSession(subscription.session_id) || last.seq<=read) continue;
        q(`INSERT INTO push_jobs(id,user_id,subscription_id,authorization_version,message_seq,logical_reply_id,next_attempt_at,created_at,expires_at)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(subscription_id,logical_reply_id) DO UPDATE SET message_seq=excluded.message_seq
          WHERE push_jobs.state IN ('pending','retry')`).run(randomUUID(),userId,subscription.id,subscription.authorization_version,last.seq,logicalReplyId,at,at,at+3600000);
      }
      return { ok:true,messages:result,deliveryId,projectionId:oldProjection?.id || q('SELECT id FROM projections WHERE projection_key=?').get(projectionKey).id,duplicate:false };
    }); },
    getDelivery(deliveryId) { const row=q('SELECT * FROM deliveries WHERE id=?').get(deliveryId); return row ? {ok:true,deliveryId:row.id,userId:row.user_id,scope:row.memory_scope,logicalReplyId:row.logical_reply_id,
      messages:parse(row.message_ids,[]).map(id=>message(q('SELECT * FROM messages WHERE id=?').get(id)))} : null; },
    commitPrivateThought({ userId, scope, epoch, logicalReplyId, inboundIds, thought } = {}) {
      assert(isPrivateUserId(userId) && isPrivateScope(scope) && singleLine(epoch, 128)
        && safeText(logicalReplyId, 160) && Array.isArray(inboundIds) && inboundIds.length > 0
        && inboundIds.every(isPrivateUserId) && new Set(inboundIds).size === inboundIds.length
        && thought && Object.keys(thought).length === 2 && singleLine(thought.action, 160)
        && singleLine(thought.subject, 160), 'invalid-private-thought');
      return transaction(() => {
        const binding = thoughtBinding(userId, scope);
        if (!binding) return { ok: true, skipped: true, reason: 'private-route-changed' };
        const source = q(`SELECT p.payload_json, d.created_at FROM projections p JOIN deliveries d ON d.id=p.delivery_id
          WHERE p.projection_key=? AND p.memory_scope=? AND d.user_id=? AND d.memory_scope=? AND d.logical_reply_id=?`)
          .get(logicalReplyId, scope, userId, scope, logicalReplyId);
        const material = parse(source?.payload_json);
        const event = material?.event;
        assert(material?.version === 1 && material.kind === 'exchange' && !material.skipMemory
          && event?.channel === 'pwa' && event.type === 'private_message' && !event.backendCommand && !event.skipExchangeMemory
          && event.privateIdentity?.userId === userId && event.privateIdentity.memoryScope === scope
          && event.memoryEpochToken?.scope === scope && event.memoryEpochToken.epoch === epoch
          && event.privateThought?.action === thought.action && event.privateThought.subject === thought.subject
          && json(material.thoughtInboundIds) === json(inboundIds) && material.sentMessageIds?.length > 0,
        'private-thought-source-mismatch', 409);
        if (binding.routeVersion !== event.privateIdentity.routeVersion) {
          return { ok: true, skipped: true, reason: 'private-route-changed' };
        }
        const inserted = q(`INSERT INTO private_thoughts
          (user_id,memory_scope,epoch,logical_reply_id,action,subject,inbound_ids,sent_message_ids,created_at)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,logical_reply_id) DO NOTHING`)
          .run(userId, scope, epoch, logicalReplyId, thought.action, thought.subject,
            json(inboundIds), json(material.sentMessageIds), source.created_at);
        q('INSERT OR IGNORE INTO private_thought_reviews(user_id,logical_reply_id,next_at) VALUES(?,?,?)')
          .run(userId,logicalReplyId,source.created_at + DAY);
        return { ok: true, duplicate: inserted.changes === 0 };
      });
    },
    listPrivateThoughts({ userId, scope, epoch, limit = 5 } = {}) {
      assert(isPrivateUserId(userId) && isPrivateScope(scope) && singleLine(epoch, 128)
        && integer(limit, 1) && limit <= 20, 'invalid-private-thought-query');
      if (!hasThoughtTable || !thoughtBinding(userId, scope)) return [];
      const reviewColumns = hasReviewTable ? ',r.status,r.next_at,r.decided_at,r.source_id,r.receipt_json,r.deferrals' : '';
      const joinReview = hasReviewTable ? 'LEFT JOIN private_thought_reviews r USING(user_id,logical_reply_id)' : '';
      const recent = hasReviewTable ? 'max(t.created_at,coalesce(r.decided_at,0))' : 't.created_at';
      return q(`SELECT t.action,t.subject,t.created_at,t.logical_reply_id,t.inbound_ids,t.sent_message_ids${reviewColumns}
        FROM private_thoughts t ${joinReview} WHERE t.user_id=? AND t.memory_scope=? AND t.epoch=?
        ORDER BY ${recent} DESC,t.rowid DESC LIMIT ?`).all(userId, scope, epoch, limit)
        .map(row => ({ action: row.action, subject: row.subject, createdAt: row.created_at, logicalReplyId: row.logical_reply_id,
          inboundIds: parse(row.inbound_ids), sentMessageIds: parse(row.sent_message_ids),
          ...(row.status && row.status !== 'pending' ? { review: { status: row.status,
            nextConsiderAt: row.status === 'deferred' ? row.next_at : null, decidedAt: row.decided_at,
            sourceId: row.source_id, receipt: parse(row.receipt_json), deferrals: row.deferrals } } : {}) }));
    },
    claimDuePrivateThought() {
      if (readOnly) return null;
      return transaction(() => {
        const at = stamp();
        // The fetch might have completed just before a crash. Never dispatch it again.
        q(`UPDATE private_thought_reviews SET status='unknown',next_at=NULL,token=NULL,lease_until=NULL,decided_at=?,
          receipt_json=json_object('reason','reading-interrupted','url',source_url)
          WHERE status='reading' AND lease_until<=?`).run(at,at);
        const row = q(`SELECT t.*,b.route_version,r.deferrals,r.decided_at,r.next_at FROM private_thought_reviews r
          JOIN private_thoughts t USING(user_id,logical_reply_id)
          JOIN users u ON u.id=t.user_id AND u.enabled=1
          JOIN bindings b ON b.user_id=t.user_id AND b.memory_scope=t.memory_scope
            AND b.status='active' AND b.preferred_channel='pwa'
          WHERE (r.status IN ('pending','deferred') AND r.next_at<=?) OR (r.status='reviewing' AND r.lease_until<=?)
          ORDER BY CASE WHEN r.status='reviewing' THEN r.lease_until ELSE r.next_at END,t.created_at,t.rowid LIMIT 1`).get(at,at);
        if (!row) return null;
        const token = randomUUID(), until = at + THOUGHT_LEASE;
        q(`UPDATE private_thought_reviews SET status='reviewing',token=?,route_version=?,lease_until=?
          WHERE user_id=? AND logical_reply_id=?`).run(token,row.route_version,until,row.user_id,row.logical_reply_id);
        return { userId:row.user_id, scope:row.memory_scope, epoch:row.epoch, logicalReplyId:row.logical_reply_id,
          token, routeVersion:row.route_version, action:row.action, subject:row.subject, createdAt:row.created_at,
          deferrals:row.deferrals, lastConsideredAt:row.decided_at, scheduledFor:row.next_at };
      });
    },
    privateThoughtSource(ticket) {
      const row = liveReview(ticket);
      return row && reviewBinding(ticket) ? originalThoughtMessages(row,ticket) : null;
    },
    startPrivateThoughtRead(ticket, { sourceId, url } = {}) {
      return transaction(() => {
        const row = liveReview(ticket);
        if (row?.status !== 'reviewing' || !reviewBinding(ticket) || !singleLine(url,2048)) return false;
        const origin = originalThoughtMessages(row,ticket).inbound.find(msg => msg.id === sourceId);
        const topicId = 'public:url:' + hash(url).slice(0,24);
        if (!origin || !approvePublicTopics({explicitText:origin.text}).some(topic => topic.id === topicId)) return false;
        q(`UPDATE private_thought_reviews SET status='reading',next_at=NULL,lease_until=?,source_id=?,source_url=?
          WHERE token=? AND user_id=? AND logical_reply_id=?`).run(stamp()+THOUGHT_LEASE,sourceId,url,ticket.token,ticket.userId,ticket.logicalReplyId);
        return true;
      });
    },
    finishPrivateThought(ticket, { status, nextConsiderAt, receipt } = {}) {
      return transaction(() => {
        const row = liveReview(ticket);
        if (!row || (status !== 'stale' && !reviewBinding(ticket))) return false;
        const at = stamp();
        if (row.status === 'reviewing' ? !['deferred','abandoned','unavailable','stale'].includes(status)
          : !['read','unavailable','unknown','stale'].includes(status)) return false;
        if (status === 'deferred' && (!integer(nextConsiderAt) || nextConsiderAt <= at)) return false;
        const needsReceipt = ['read','unavailable','unknown'].includes(status);
        if (needsReceipt ? !validThoughtReceipt(row,status,receipt) : receipt != null) return false;
        if (['read','deferred','abandoned'].includes(status) && !originalThoughtMessages(row,ticket).valid) return false;
        q(`UPDATE private_thought_reviews SET status=?,next_at=?,decided_at=?,token=NULL,lease_until=NULL,receipt_json=?,
          deferrals=deferrals+? WHERE user_id=? AND logical_reply_id=?`)
          .run(status,status==='deferred' ? nextConsiderAt : null,at,receipt ? json(receipt) : null,
            status==='deferred' ? 1 : 0,ticket.userId,ticket.logicalReplyId);
        return true;
      });
    },
    listPendingProjections({limit=50}={}) { assert(integer(limit,1)&&limit<=1000,'invalid-limit'); return q("SELECT * FROM projections WHERE state IN ('pending','processing','failed') ORDER BY sequence LIMIT ?").all(limit).map(projectionValue); },
    hasPendingProjection(scope) { return Boolean(q("SELECT 1 FROM projections WHERE memory_scope=? AND state IN ('pending','processing','failed')").get(scope)); },
    claimProjection(id) { return transaction(()=>{
      const row=q('SELECT * FROM projections WHERE id=?').get(id); assert(row,'projection-unavailable',404);
      assert(!q("SELECT 1 FROM projections WHERE memory_scope=? AND sequence<? AND state IN ('pending','processing','failed')").get(row.memory_scope,row.sequence),'earlier-projection-pending',409);
      assert(row.state!=='complete','projection-already-committed',409);
      q("UPDATE projections SET state='processing',attempts=attempts+1,updated_at=? WHERE id=?").run(stamp(),id); return projectionValue(q('SELECT * FROM projections WHERE id=?').get(id));
    }); },
    completeProjection(id,result={}) { assert(json(result).length<=64000,'invalid-projection-result'); q("UPDATE projections SET state='complete',result_json=?,reason=NULL,updated_at=? WHERE id=? AND state<>'complete'").run(json(result),stamp(),id); return {ok:true}; },
    failProjection(id,reason='projection-failed') { q("UPDATE projections SET state='failed',reason=?,updated_at=? WHERE id=? AND state<>'complete'").run(String(reason).slice(0,120),stamp(),id); return {ok:true}; },
    upsertSubscription({userId,sessionId,subscription,preview=false}={}) { return transaction(()=>{
      active(userId); const session=api.getSession(sessionId); assert(session?.user.userId===userId,'session-unavailable',401);
      let endpoint; try {endpoint=new URL(subscription?.endpoint);} catch {fail('invalid-subscription');}
      assert(endpoint.protocol==='https:'&&!endpoint.username&&!endpoint.password&&!endpoint.hash&&(!endpoint.port||endpoint.port==='443')
        && endpoint.href.length<=4096,'invalid-subscription');
      const keys=subscription?.keys;
      assert(keys && /^[A-Za-z0-9_-]{87}$/.test(keys.p256dh) && /^[A-Za-z0-9_-]{22}$/.test(keys.auth),'invalid-subscription');
      const endpointHash=hash(endpoint.href), collision=q('SELECT * FROM subscriptions WHERE endpoint_hash=? AND enabled=1 AND session_id<>?').get(endpointHash,sessionId);
      assert(!collision||collision.user_id===userId,'subscription-already-bound',409);
      if(collision) {q('UPDATE subscriptions SET enabled=0,reason=? WHERE id=?').run('device-rebound',collision.id);q("UPDATE push_jobs SET state='cancelled',reason='device-rebound' WHERE subscription_id=? AND state IN ('pending','retry','sending')").run(collision.id);}
      const existing=q('SELECT * FROM subscriptions WHERE session_id=?').get(sessionId), id=existing?.id||randomUUID();
      if(existing) q("UPDATE push_jobs SET state='cancelled',reason='subscription-updated' WHERE subscription_id=? AND state IN ('pending','retry','sending')").run(id);
      q(`INSERT INTO subscriptions(id,user_id,session_id,endpoint,endpoint_hash,keys_json,authorization_version,preview,created_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET endpoint=excluded.endpoint,endpoint_hash=excluded.endpoint_hash,
        keys_json=excluded.keys_json,authorization_version=subscriptions.authorization_version+1,enabled=1,preview=excluded.preview,reason=NULL`).run(id,userId,sessionId,endpoint.href,endpointHash,json(keys),existing?existing.authorization_version+1:1,preview?1:0,stamp());
      return {id,enabled:true,preview:Boolean(preview)};
    }); },
    removeSubscription(sessionId) { return transaction(()=>{for(const row of q('SELECT id FROM subscriptions WHERE session_id=?').all(sessionId)) api.invalidateSubscription(row.id,{reason:'subscription-removed'});return {ok:true};}); },
    // Internal capability projection: never expose endpoints, keys or another user.
    notificationEligibility(userId) {
      const binding = identity(userId);
      if (!binding?.enabled || binding.bindingStatus !== 'active' || binding.preferredChannel !== 'pwa') return false;
      return q('SELECT s.* FROM sessions s JOIN subscriptions p ON p.session_id=s.id AND p.user_id=s.user_id WHERE p.user_id=? AND p.enabled=1')
        .all(userId).some(row => Boolean(sessionValue(row)));
    },
    getSubscription(sessionId) {const row=q('SELECT id,enabled,preview,reason FROM subscriptions WHERE session_id=?').get(sessionId);return row?{id:row.id,enabled:Boolean(row.enabled),preview:Boolean(row.preview),reason:row.reason}:null;},
    invalidateSubscription(id,{reason='subscription-invalid',expectedAuthorizationVersion=null}={}) { return transaction(()=>{
      const current=q('SELECT authorization_version FROM subscriptions WHERE id=?').get(id);
      if(!current||expectedAuthorizationVersion!==null&&current.authorization_version!==expectedAuthorizationVersion)return {ok:false};
      q('UPDATE subscriptions SET enabled=0,authorization_version=authorization_version+1,reason=? WHERE id=?').run(reason,id);
      q("UPDATE push_jobs SET state='cancelled',reason=? WHERE subscription_id=? AND state IN ('pending','retry','sending')").run(reason,id); return {ok:true};
    }); },
    claimPushJobs({now:at=stamp(),limit=10,leaseMs=30000}={}) {return transaction(()=>{
      assert(integer(at)&&integer(limit,1)&&limit<=100&&integer(leaseMs,1000)&&leaseMs<=300000,'invalid-push-claim');
      const rows=q("SELECT * FROM push_jobs WHERE ((state IN ('pending','retry') AND next_attempt_at<=?) OR (state='sending' AND lease_until<=?)) ORDER BY created_at LIMIT ?").all(at,at,limit), result=[];
      for(const row of rows){
        const authorization=api.getPushAuthorization(row.id,at);
        if(!authorization.ok){q('UPDATE push_jobs SET state=?,reason=? WHERE id=?').run(authorization.reason==='expired'?'expired':'cancelled',authorization.reason,row.id);continue;}
        const leaseToken=secret();q("UPDATE push_jobs SET state='sending',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?").run(leaseToken,at+leaseMs,row.id);
        const sub=q('SELECT * FROM subscriptions WHERE id=?').get(row.subscription_id),msg=q('SELECT * FROM messages WHERE seq=?').get(row.message_seq);
        result.push({id:row.id,userId:row.user_id,messageId:msg.id,logicalReplyId:row.logical_reply_id,seq:msg.seq,createdAt:row.created_at,expiresAt:row.expires_at,attempts:row.attempts+1,leaseToken,
          subscription:{id:sub.id,endpoint:sub.endpoint,keys:parse(sub.keys_json),authorizationVersion:sub.authorization_version,sessionId:sub.session_id},preview:Boolean(sub.preview),text:msg.text});
      } return result;
    });},
    getPushAuthorization(job,at=stamp()) {
      const row=q('SELECT * FROM push_jobs WHERE id=?').get(typeof job==='string'?job:job?.id);
      if(!row||!['pending','retry','sending'].includes(row.state))return {ok:false,reason:'job-inactive'};
      if(row.expires_at<=at)return {ok:false,reason:'expired'};
      const sub=q('SELECT * FROM subscriptions WHERE id=?').get(row.subscription_id),binding=identity(row.user_id);
      if(!sub?.enabled||sub.authorization_version!==row.authorization_version||!binding?.enabled||binding.bindingStatus!=='active'||!api.getSession(sub.session_id))return {ok:false,reason:'authorization-revoked'};
      if(typeof job==='object'&&job.leaseToken&&row.lease_token!==job.leaseToken)return {ok:false,reason:'lease-replaced'};
      if((q('SELECT seq FROM read_cursors WHERE user_id=?').get(row.user_id)?.seq||0)>=row.message_seq)return {ok:false,reason:'already-read'};
      return {ok:true};
    },
    finishPushJob(id,{state,reason=null,statusCode=null,apnsId=null,leaseToken=null}={}) {
      assert(['accepted','cancelled','expired','failed'].includes(state),'invalid-push-state');
      const row=q('SELECT * FROM push_jobs WHERE id=?').get(id);if(!row||leaseToken&&row.lease_token!==leaseToken||!['pending','retry','sending'].includes(row.state))return {ok:false};
      q('UPDATE push_jobs SET state=?,reason=?,status_code=?,apns_id=?,lease_token=NULL,lease_until=NULL WHERE id=?').run(state,reason,statusCode,apnsId,id);return {ok:true};
    },
    retryPushJob(id,{nextAttemptAt,reason=null,statusCode=null,leaseToken=null}={}) {
      assert(integer(nextAttemptAt),'invalid-push-time');const row=q('SELECT * FROM push_jobs WHERE id=?').get(id);
      if(!row||row.state!=='sending'||leaseToken&&row.lease_token!==leaseToken)return {ok:false};
      q("UPDATE push_jobs SET state='retry',next_attempt_at=?,reason=?,status_code=?,lease_token=NULL,lease_until=NULL WHERE id=?").run(nextAttemptAt,reason,statusCode,id);return {ok:true};
    },
    diagnostics() {return {schemaVersion:1,inbox:q("SELECT state,count(*) count FROM inbox WHERE state<>'complete' GROUP BY state").all(),
      projections:q("SELECT state,count(*) count FROM projections WHERE state<>'complete' GROUP BY state").all(),push:q('SELECT state,count(*) count FROM push_jobs GROUP BY state').all()};},
    async backup(destination) {
      assert(typeof destination==='string'&&destination.length>0,'backup-path-required');
      const target=resolve(destination);assert(target!==databasePath,'backup-must-be-separate');
      mkdirSync(dirname(target),{recursive:true,mode:0o700});
      const parent=lstatSync(dirname(target));assert(parent.isDirectory()&&!parent.isSymbolicLink(),'unsafe-backup-directory');
      // Never silently overwrite a newer recovery point, or follow a symlink.
      const descriptor=openSync(target,'wx',0o600);closeSync(descriptor);
      const result=await db.backup(target);chmodSync(target,0o600);return result;
    },
    close() {clearInterval(creativeMaintenance);db.close();}
  };
  let creativeMaintenance;
  if (!readOnly) {
    api.pruneCreativeDrafts();
    creativeMaintenance = setInterval(() => {
      try { api.pruneCreativeDrafts(); }
      catch { console.warn('Private work draft cleanup deferred'); }
    }, 3600000);
    creativeMaintenance.unref();
  }
  return api;
}
