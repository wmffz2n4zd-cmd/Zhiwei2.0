import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createUnifiedMemory } from '../src/unified-memory/index.js';

test('proactive delivery retains quote provenance without fabricating a user exchange or profile', async t => {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'outbound-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(base + sep)); await rm(directory, { recursive: true, force: true }); });
  const memoryPath = join(directory, 'memory.json'), scope = 'qq:private:123456';
  const store = createUnifiedMemory({ memoryPath });
  const value = { scope, intentId: 'contact:one', replyText: '刚想到那本书，并不是你上次推荐的那本。', sentMessageIds: ['101'] };
  assert.equal((await store.writeOutbound(value)).ok, true);
  assert.equal((await store.writeOutbound(value)).duplicate, true);
  assert.equal(await store.readPrivateProfile({ scope }), null);
  const saved = JSON.parse(await readFile(memoryPath));
  assert.equal(saved.entries.length, 1); assert.equal(saved.entries[0].exchange, undefined);
  const restored = createUnifiedMemory({ memoryPath });
  assert.equal(await restored.hasDeliveredMessage({ scope, messageId: '101' }), true);
  assert.equal(await restored.hasDeliveredMessage({ scope: 'qq:private:234567', messageId: '101' }), false);
  const recalled = await restored.recall({ scope, query: '你刚才主动说的那个', replyMessageId: '101' });
  assert.match(recalled.context, /并不是你上次推荐的那本/);
  assert.equal(recalled.entries[0].reason, 'reference');
  for (const query of ['刚才那个是什么？', '继续你说的那个', '你刚刚提到什么']) {
    assert.match((await restored.recall({ scope, query })).context, /并不是你上次推荐的那本/, query);
    assert.equal((await restored.recall({ scope: 'qq:private:234567', query })).entries.length, 0);
  }
  assert.equal((await restored.recall({ scope, query: '这个火星计划是什么？' })).entries.length, 0);
  await assert.rejects(restored.writeOutbound({ ...value, replyText: '另一个结果' }), /conflicts/);
  await assert.rejects(restored.writeOutbound({ ...value, sentMessageIds: [null] }), /Invalid/);
});
