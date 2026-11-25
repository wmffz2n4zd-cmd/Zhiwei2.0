import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createPwaStore } from '../src/pwa-store.js';
import { backupPwaDatabase, restorePwaDatabase } from '../scripts/pwa-backup.mjs';

const thought = { action: '过几天读完', subject: '刚聊到的那篇星图文章' };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pwa-private-thought-'));
  const path = join(dir, 'pwa.sqlite');
  let store = createPwaStore({ path });
  t.after(() => { store?.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    path,
    get store() { return store; },
    close() { store?.close(); store = null; },
    reopen(options = {}) { this.close(); store = createPwaStore({ path, ...options }); },
    user(username, options) {
      const { token } = store.createInvitation(options);
      return store.claimInvitation({ token, username, displayName: username, passwordHash: 'test' }).identity;
    }
  };
}

function exchange(store, userId) {
  const input = () => {
    const item = store.acceptInbound({ userId, clientMessageId: randomUUID(), text: '讨论星图' });
    store.markInboxProjected(item.inboxId);
    return item;
  };
  const first = input(), last = input();
  const { memoryScope: scope, routeVersion, generation } = last.identity;
  const epoch = randomUUID(), logicalReplyId = randomUUID();
  const inboundIds = [first.inboxId, last.inboxId];
  const event = { channel: 'pwa', type: 'private_message', privateIdentity: last.identity, memoryEpochToken: { scope, epoch },
    raw: { message_id: 'pwa:' + first.inboxId, batched_message_ids: inboundIds.map(id => 'pwa:' + id) } };
  return {
    input: { userId, scope, epoch, logicalReplyId, inboundIds, thought },
    publish(segmentIndex, material, kind = 'exchange') {
      return store.publishSegments({ userId, scope, routeVersion, generation, inboundIds,
        deliveryId: logicalReplyId + ':' + segmentIndex, logicalReplyId, segmentIndex,
        allowedPendingProjectionKey: logicalReplyId,
        segments: [{ type: 'text', text: '想之后接着看' }],
        projection: { version: 1, kind, event: { ...event, privateThought: material }, skipMemory: false } });
    }
  };
}

test('only a published exchange supplies a thought, its real inbound batch and every delivered segment survive retry and restart', t => {
  const env = fixture(t);
  const identity = env.user('alice'), turn = exchange(env.store, identity.userId), args = turn.input;
  assert.throws(() => env.store.commitPrivateThought(args), /source-mismatch/);
  const first = turn.publish(0, null);
  assert.throws(() => env.store.commitPrivateThought(args), /source-mismatch/);
  const last = turn.publish(1, thought);
  env.store.claimProjection(last.projectionId);
  // A later accepted turn changes the generation after the actual delivery.
  env.store.acceptInbound({ userId: identity.userId, clientMessageId: 'newer', text: '晚安' });
  assert.deepEqual(env.store.commitPrivateThought(args), { ok: true, duplicate: false });
  env.reopen();
  assert.deepEqual(env.store.commitPrivateThought(args), { ok: true, duplicate: true });
  const items = env.store.listPrivateThoughts(args);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { ...thought, logicalReplyId: args.logicalReplyId, inboundIds: args.inboundIds,
    sentMessageIds: [first.messages[0].id, last.messages[0].id], createdAt: last.messages[0].createdAt });
  assert.throws(() => env.store.commitPrivateThought({ ...args, thought: { ...thought, subject: '另一篇文章' } }), /source-mismatch/);
  assert.throws(() => env.store.commitPrivateThought({ ...args, inboundIds: args.inboundIds.slice(1) }), /source-mismatch/);
  assert.throws(() => env.store.commitPrivateThought({ ...args, inboundIds: [randomUUID()] }), /source-mismatch/);
  assert.throws(() => env.store.commitPrivateThought({ ...args, epoch: randomUUID() }), /source-mismatch/);
  assert.deepEqual(env.store.listPrivateThoughts({ ...args, epoch: randomUUID() }), []);
});

test('scope, binding and route fences protect capture and recall; the same user may have a verified legacy scope', t => {
  const env = fixture(t);
  const alice = env.user('alice', { memoryScope: 'qq:private:90001' }), bob = env.user('bob');
  env.store.verifyBinding(alice.userId);
  const turn = exchange(env.store, alice.userId), args = turn.input;
  turn.publish(0, thought);
  for (const foreign of [{ userId: bob.userId }, { scope: bob.memoryScope }]) {
    assert.equal(env.store.commitPrivateThought({ ...args, ...foreign }).skipped, true);
    assert.deepEqual(env.store.listPrivateThoughts({ ...args, ...foreign }), []);
  }
  assert.throws(() => env.store.commitPrivateThought({ ...args, userId: bob.userId, scope: bob.memoryScope }), /source-mismatch/);
  assert.deepEqual(env.store.listPrivateThoughts({ ...args, userId: bob.userId, scope: bob.memoryScope }), []);
  assert.equal(env.store.commitPrivateThought(args).ok, true);
  assert.equal(env.store.listPrivateThoughts(args)[0].subject, thought.subject);
  env.store.disableUser(alice.userId);
  assert.deepEqual(env.store.listPrivateThoughts(args), []);
  assert.equal(env.store.commitPrivateThought(args).skipped, true);
  env.store.disableUser(alice.userId, false);
  assert.equal(env.store.commitPrivateThought(args).reason, 'private-route-changed');
});

test('no source from commands, superseded proposals, malformed controls or an unfinalized split', t => {
  const env = fixture(t);
  const alice = env.user('alice');
  for (const kind of ['status', 'command', 'outbound']) {
    const turn = exchange(env.store, alice.userId), result = turn.publish(0, thought, kind);
    assert.throws(() => env.store.commitPrivateThought(turn.input), /source-mismatch/);
    env.store.completeProjection(result.projectionId);
  }
  const turn = exchange(env.store, alice.userId);
  turn.publish(0, null);
  for (const action of [' ', '第一行\n第二行', 'x'.repeat(161), 'x\u2028y']) {
    assert.throws(() => env.store.commitPrivateThought({ ...turn.input, thought: { ...thought, action } }), /invalid-private-thought/);
  }
  assert.throws(() => env.store.commitPrivateThought(turn.input), /source-mismatch/);
  turn.publish(1, thought);
  turn.publish(2, null);
  assert.throws(() => env.store.commitPrivateThought(turn.input), /source-mismatch/);
  assert.deepEqual(env.store.listPrivateThoughts(turn.input), []);
});

test('a pre-upgrade v1 database opens read-only, upgrades in place when writable and retains an old pending projection', t => {
  const env = fixture(t);
  const alice = env.user('alice'), turn = exchange(env.store, alice.userId), args = turn.input;
  const delivery = turn.publish(0, undefined);
  env.close();
  const db = new Database(env.path);
  db.exec('DROP TABLE private_thoughts');
  db.close();
  env.reopen({ readOnly: true });
  assert.deepEqual(env.store.listPrivateThoughts(args), []);
  assert.equal(env.store.listMessages(alice.userId).messages.length, 3);
  assert.equal(env.store.listPendingProjections()[0].id, delivery.projectionId);
  env.close();
  const check = new Database(env.path, { readonly: true });
  assert.equal(check.prepare("SELECT 1 FROM sqlite_schema WHERE name='private_thoughts'").get(), undefined);
  check.close();
  env.reopen();
  assert.equal(env.store.getDelivery(args.logicalReplyId + ':0').messages[0].id, delivery.messages[0].id);
  assert.throws(() => env.store.commitPrivateThought(args), /source-mismatch/);
  env.store.completeProjection(delivery.projectionId);
  const fresh = exchange(env.store, alice.userId);
  fresh.publish(0, thought);
  assert.equal(env.store.commitPrivateThought(fresh.input).duplicate, false);
  env.reopen({ readOnly: true });
  assert.equal(env.store.listPrivateThoughts(fresh.input)[0].action, thought.action);
});

test('a verified read-only backup restores the same thought and its messages while the original keeps its later exchange', async t => {
  const env = fixture(t), alice = env.user('alice');
  const turn = exchange(env.store, alice.userId);
  turn.publish(0, null);
  const sent = turn.publish(1, thought);
  env.store.commitPrivateThought(turn.input);
  env.store.completeProjection(sent.projectionId);
  const original = env.store.listPrivateThoughts(turn.input)[0];
  const refs = [...original.inboundIds, ...original.sentMessageIds];
  const messages = refs.map(id => env.store.getOwnMessage(alice.userId, id));
  assert.deepEqual(messages.map(message => message.direction), ['inbound', 'inbound', 'outbound', 'outbound']);

  const backup = env.path + '.backup', output = env.path + '.restore';
  const snapshot = await backupPwaDatabase({ database: env.path, output: backup });
  const later = exchange(env.store, alice.userId), additional = later.publish(0, thought);
  env.store.commitPrivateThought(later.input);
  env.store.completeProjection(additional.projectionId);

  const verification = await restorePwaDatabase({ backup, output });
  assert.equal(verification.verificationOnly, true);
  assert.equal(verification.activationAllowed, false);
  assert.equal(verification.sha256, snapshot.sha256);
  const copy = createPwaStore({ path: output, readOnly: true });
  try {
    assert.deepEqual(copy.listPrivateThoughts(turn.input), [original]);
    assert.deepEqual(refs.map(id => copy.getOwnMessage(alice.userId, id)), messages);
    assert.deepEqual(copy.listPrivateThoughts(later.input), []);
    assert.equal(copy.getOwnMessage(alice.userId, additional.messages[0].id), null);
  } finally { copy.close(); }
  assert.equal(env.store.listPrivateThoughts(later.input)[0].logicalReplyId, later.input.logicalReplyId);
  assert.deepEqual(env.store.getOwnMessage(alice.userId, additional.messages[0].id), additional.messages[0]);
});
