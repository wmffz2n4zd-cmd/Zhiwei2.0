import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createWorldExperiences, readingExperience, normalizeWorldScope } from '../src/world-experiences.js';

const NOW = Date.parse('2026-10-28T04:00:00Z');
const effects = { version: 't030-1', mood: { valence: 0.2, energy: 0, tension: 0 }, interest: null };
const payload = (extra = {}) => ({ id: 'world:test:0', scope: null, observedAt: NOW,
  page: { url: 'https://example.org/article?utm_source=test', title: '一篇文章', contentHash: 'a'.repeat(64) },
  summary: '实际阅读过页面，形成了一条本地感想。', effects,
  note: { summary: '实际文章摘要', comment: '本次感想' }, ...extra });
const event = value => ({ type: 'experience-recorded', source: value.source, experience: value });
async function fixture(t) {
  const base = resolve('runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'reading-outbox-')), opened = [];
  t.after(async () => { for (const box of opened) await box.close(); if (directory.startsWith(base + sep)) await rm(directory, { recursive: true, force: true }); });
  return { directory, async open(options = {}) {
    const box = await createWorldExperiences({ directory, now: () => NOW, appendNote: async () => {}, recordExperience: async value => event(value), ...options });
    opened.push(box); return box;
  } };
}

test('durable reading payload precedes notes and sink, preserves evidence and acknowledges once', async t => {
  const f = await fixture(t), order = [], input = payload({ scope: 'qq:private:123' });
  const box = await f.open({ appendNote: async (note, scope) => {
    const durable = JSON.parse(await readFile(box.file, 'utf8'));
    assert.equal(durable.entries[0].status, 'pending'); assert.equal(durable.entries[0].payload.scope, scope);
    assert.equal(note.url, 'https://example.org/article'); order.push('note');
  }, recordExperience: async value => {
    order.push('life'); assert.equal(value.observedAt, NOW); assert.equal(value.mode, 'external');
    assert.equal(value.source.scope, 'qq:private:123'); assert.equal(value.evidence.source.scope, 'qq:private:123');
    assert.match(value.evidence.ref, /https:\/\/example.org\/article\nsha256:/); return event(value);
  } });
  await box.enqueue(input); assert.deepEqual(order, []);
  assert.deepEqual(await box.flush(), { delivered: 1, pending: 0, notes: [] });
  assert.deepEqual(order, ['note', 'life']);
  await box.enqueue(input); await box.flush(); assert.deepEqual(order, ['note', 'life']);
});

test('a failed sink leaves its immutable payload pending and restart replays without new observation time', async t => {
  const f = await fixture(t); let notes = 0, attempts = 0;
  const first = await f.open({ appendNote: async () => { notes++; }, recordExperience: async () => { attempts++; throw Error('sink unavailable'); } });
  await first.enqueue(payload()); await assert.rejects(first.flush(), /sink unavailable/); await first.close();
  const restored = await f.open({ now: () => NOW + 86400000, appendNote: async () => { notes++; }, recordExperience: async value => {
    assert.equal(value.observedAt, NOW); assert.deepEqual(value.effects, effects); attempts++; return event(value);
  } });
  await restored.flush(); assert.equal(notes, 2); assert.equal(attempts, 2); assert.equal(restored.status().pending, 0);
});

test('a successful sink with a lost durable acknowledgement is safely replayed by the same id', async t => {
  const f = await fixture(t), committed = new Map(); let calls = 0;
  const sink = async value => { calls++; if (!committed.has(value.id)) committed.set(value.id, event(value)); return committed.get(value.id); };
  const first = await f.open({ recordExperience: async value => {
    const result = await sink(value);
    await rename(first.file, first.file + '.saved'); await mkdir(first.file);
    return result;
  } });
  await first.enqueue(payload({ note: null })); await assert.rejects(first.flush(), /regular/);
  assert.equal(first.status().failed, true); await assert.rejects(first.enqueue(payload({ id: 'world:second:0' })), /needs recovery/);
  await first.close(); await rmdir(first.file); await rename(first.file + '.saved', first.file);
  const restored = await f.open({ recordExperience: sink }); await restored.flush();
  assert.equal(calls, 2); assert.equal(committed.size, 1); assert.equal(restored.status().pending, 0);
});

test('failed write before enqueue prevents notes and delivery and preserves prior source', async t => {
  const f = await fixture(t); let writes = 0;
  const box = await f.open({ appendNote: async () => { writes++; }, recordExperience: async value => { writes++; return event(value); } });
  await rename(box.file, box.file + '.saved'); await mkdir(box.file);
  await assert.rejects(box.enqueue(payload()), /regular/); assert.equal(writes, 0);
  await assert.rejects(box.flush(), /needs recovery/); assert.equal(writes, 0);
});

test('undefined sink confirmation and failed note do not acknowledge a pending observation', async t => {
  const f = await fixture(t), box = await f.open({ recordExperience: async () => undefined });
  await box.enqueue(payload()); await assert.rejects(box.flush(), /did not confirm/);
  assert.equal(box.status().pending, 1); await box.close();
  const restored = await f.open({ appendNote: async () => { throw Error('render failed'); } });
  await assert.rejects(restored.flush(), /render failed/); assert.equal(restored.status().pending, 1);
});

test('changed id content is rejected before side effects, including after delivery', async t => {
  const f = await fixture(t), box = await f.open(); await box.enqueue(payload()); await box.flush();
  await assert.rejects(box.enqueue(payload({ summary: '另一份结论' })), /different committed result/);
  assert.equal(box.status().total, 1);
});

test('corrupt and missing initialized outboxes fail closed without rewriting', async t => {
  const f = await fixture(t), box = await f.open(); await box.enqueue(payload()); await box.close();
  const good = await readFile(box.file, 'utf8');
  const bad = good.replace('实际阅读过页面', '假冒来源'); await writeFile(box.file, bad);
  await assert.rejects(f.open(), /checksum/); assert.equal(await readFile(box.file, 'utf8'), bad);
  await unlink(box.file); await assert.rejects(f.open(), /missing/);
});

test('scope, timestamps, result fields and effects reject malformed input before persistence', async t => {
  const f = await fixture(t), box = await f.open();
  for (const value of [payload({ scope: 'qq:group:1' }), payload({ scope: 'qq:private:NaN' }), payload({ scope: 'qq:private:0' }),
    payload({ observedAt: NOW + 1 }), payload({ effects: { version: 't030-1', mood: {}, interest: null } }), payload({ extra: true })]) await assert.rejects(box.enqueue(value));
  assert.equal(box.status().total, 0);
  for (const value of ['', 'qq:private:01', 'qq:private:1 ', 'qq:private:1:2', 123]) assert.throws(() => normalizeWorldScope(value));
  assert.equal(normalizeWorldScope(undefined), null); assert.equal(normalizeWorldScope('qq:private:123'), 'qq:private:123');
});

test('long normalized URL remains in retained source while evidence uses a bounded reference', async t => {
  const f = await fixture(t), url = 'https://example.org/article?topic=' + 'a'.repeat(1600);
  const input = payload({ page: { ...payload().page, url } }), box = await f.open();
  const proof = readingExperience(input); assert.ok(proof.evidence.ref.length < 1000); assert.match(proof.evidence.ref, /^world-outbox:/);
  await box.enqueue(input); await box.flush();
  const durable = JSON.parse(await readFile(box.file, 'utf8')); assert.equal(durable.entries[0].payload.page.url, url);
  assert.equal(durable.entries[0].status, 'delivered');
});

test('concurrent flush calls serialize and delayed clock does not replay a future observation', async t => {
  const f = await fixture(t); let calls = 0, at = NOW;
  const box = await f.open({ now: () => at, recordExperience: async value => { calls++; return event(value); } });
  await box.enqueue(payload({ note: null })); at--;
  await assert.rejects(box.flush(), /clock/); assert.equal(calls, 0); at = NOW;
  await Promise.all([box.flush(), box.flush()]); assert.equal(calls, 1);
});
