import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateChatEvidence } from '../src/private-reply-context.js';

const scope = 'private:user:34eb645b-0221-4ee7-b729-8b88d938f038';
const core = (kind, length) => ({ kind, scope, text: '甲'.repeat(length) });
const thought = {
  action: '重读', subject: '《回音》', logicalReplyId: 'pwa:synthetic', createdAt: 100,
  review: { status: 'read', decidedAt: 300, nextConsiderAt: null,
    receipt: { coverage: 'complete-article', url: 'https://example.org/echo',
      title: '回音', fetchedAt: 290, excerpt: '乙'.repeat(11900) + '末句来自文章' } }
};

test('ordinary recall includes the complete short article, including its end', () => {
  const rows = createPrivateChatEvidence([core('current', 10)], [thought], { scope });
  assert.match(rows[1].text, /末句来自文章/);
  assert.equal(rows[1].scope, scope);
});

test('a large current conversation keeps priority over previously read articles', () => {
  const base = [core('current', 75000), core('memory', 84000)];
  const rows = createPrivateChatEvidence(base, [thought], { scope });
  assert.equal(rows[0].text, base[0].text);
  assert.equal(rows[1].text, base[1].text);
  assert.match(rows[2].text, /本轮只提供阅读回执/);
  assert.doesNotMatch(rows[2].text, /末句来自文章/);
  assert.equal(createPrivateChatEvidence([core('current', 80000), core('memory', 80000)], [thought], { scope }).length, 2);
});
