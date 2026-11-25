import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceCommentReplies, spaceCommentReplySchema } from '../src/space-comment-replies.js';

const post = { id: 18, kind: 'share', text: '纸船底部摊宽后更稳。', source: {
  title: '手工笔记', url: 'https://example.org/notes', basisText: 'internal-source-evidence' } };
const comment = { id: 29, postId: post.id, authorName: '访客', text: '底部怎么摊宽？', account: 'internal-account' };
const reply = { action: 'reply', text: '  轻轻掰开折痕，再把底压平。  ' };
const skip = { action: 'skip', text: null };

function fixture({ decide = () => reply, canReply, item = { post, comment }, duplicate = false, failure = 'retry' } = {}) {
  let finished = false;
  const inputs = [], failures = [], releases = [], commits = [];
  const store = {
    claimSpaceComment() { return finished || !item ? null : { ...item, claim: 'internal-claim' }; },
    failSpaceComment(target) { failures.push(target); finished = failure === 'failed'; return failure; },
    releaseSpaceComment(target) { releases.push(target); },
    finishSpaceComment(target) { commits.push(target); finished = !duplicate; return { duplicate }; }
  };
  const worker = createSpaceCommentReplies({ store, canReply, decide(input) { inputs.push(input); return decide(input); } });
  return { worker, inputs, failures, releases, commits };
}

test('only public post text, source title and the chosen comment reach the model', async () => {
  const { worker, inputs, commits } = fixture({ decide: () => JSON.stringify(reply) });
  assert.equal(await worker.tick(), 'replied');
  assert.equal(await worker.tick(), 'idle');
  assert.equal(inputs.length, 1);
  const [{ prompt, schema }] = inputs;
  assert.deepEqual(JSON.parse(prompt.split('\n').at(-1)), { post: post.text, comment: comment.text, sourceTitle: post.source.title });
  assert.doesNotMatch(prompt, /internal-|example\.org|访客/);
  assert.deepEqual(schema, spaceCommentReplySchema);
  assert.deepEqual(commits, [{ claim: 'internal-claim', commentId: comment.id, text: reply.text.trim() }]);
  await worker.close();
});

test('a deliberate skip is a completed decision on the same comment', async () => {
  const item = { post: { ...post, kind: 'daily', source: null }, comment };
  const { worker, inputs, commits, releases } = fixture({ decide: () => skip, item });
  assert.equal(await worker.tick(), 'skipped');
  assert.equal(await worker.tick(), 'idle');
  assert.deepEqual(JSON.parse(inputs[0].prompt.split('\n').at(-1)), { post: post.text, comment: comment.text });
  assert.deepEqual(commits, [{ claim: 'internal-claim', commentId: comment.id, text: null }]);
  assert.equal(releases.length, 0);
});

test('a model failure or invalid outcome delays this comment, preserving its decision for a later tick', async () => {
  for (const bad of [() => { throw Error('model unavailable'); }, () => 'not JSON',
    () => ({ ...reply, commentId: 3 }), () => ({ action: 'skip', text: '' }), () => ({ action: 'reply', text: null }),
    () => ({ action: 'reply', text: ' ' }), () => ({ action: 'reply', text: 'x'.repeat(1001) }),
    () => ({ action: 'reply', text: 'abc\u0080' }), () => ({ action: 'reply', text: 'abc\ud800' }),
    () => ({ action: 'reply', text: 'x'.padEnd(1001, ' ') })]) {
    const { worker, commits, releases, failures } = fixture({ decide: bad });
    assert.equal(await worker.tick(), 'unavailable');
    assert.equal(commits.length, 0);
    assert.deepEqual(failures, [{ claim: 'internal-claim', commentId: comment.id }]);
    assert.equal(releases.length, 0);
  }
});

test('the store owns the persistent attempt budget and rejects failures from stale claims', async () => {
  for (const failure of ['failed', 'stale']) {
    const { worker, commits, releases, failures } = fixture({ decide: () => 'invalid', failure });
    assert.equal(await worker.tick(), failure);
    assert.deepEqual(failures, [{ claim: 'internal-claim', commentId: comment.id }]);
    assert.equal(releases.length, 0);
    assert.equal(commits.length, 0);
    if (failure === 'failed') assert.equal(await worker.tick(), 'idle');
  }
});

test('a mismatched post never reaches the model, and an expired lease never publishes', async () => {
  const mismatch = fixture({ item: { post, comment: { ...comment, postId: post.id + 1 } } });
  assert.equal(await mismatch.worker.tick(), 'unavailable');
  assert.equal(mismatch.inputs.length, 0);
  assert.equal(mismatch.commits.length, 0);
  const stale = fixture({ duplicate: true });
  assert.equal(await stale.worker.tick(), 'stale');
  assert.equal(stale.inputs.length, 1);
});

test('concurrent ticks share the claim, closing interrupts the model and drains before releasing', async () => {
  let entered, resume;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const resumePromise = new Promise(resolve => { resume = resolve; });
  const { worker, inputs, releases, commits, failures } = fixture({ decide: async input => {
    entered(input);
    await resumePromise;
    input.signal.throwIfAborted();
    return reply;
  } });
  const first = worker.tick(), second = worker.tick();
  assert.equal(first, second);
  const input = await enteredPromise;
  const closed = worker.close();
  assert(input.signal.aborted);
  assert.equal(input.canContinue(), false);
  resume();
  assert.equal(await first, 'cancelled');
  await closed;
  assert.equal(await worker.tick(), 'cancelled');
  assert.deepEqual(releases, [{ claim: 'internal-claim', commentId: comment.id }]);
  assert.equal(failures.length, 0);
  assert.equal(inputs.length, 1);
  assert.equal(commits.length, 0);
});

test('availability and abort are checked both before claiming and before publishing late output', async () => {
  let allowed = true;
  const { worker, inputs, commits, releases, failures } = fixture({
    canReply: () => allowed, decide: () => { allowed = false; return reply; }
  });
  assert.equal(await worker.tick({ signal: AbortSignal.abort() }), 'cancelled');
  assert.equal(inputs.length, 0);
  assert.equal(await worker.tick(), 'cancelled');
  assert.equal(await worker.tick(), 'cancelled');
  assert.equal(inputs.length, 1);
  assert.deepEqual(releases, [{ claim: 'internal-claim', commentId: comment.id }]);
  assert.equal(failures.length, 0);
  assert.equal(commits.length, 0);
});
