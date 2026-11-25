import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeCapabilities, renderRuntimeCapabilities } from '../src/runtime-capabilities.js';

const now = Date.parse('2026-11-18T01:00:00+08:00');
const pwa = { enabled: true, writable: true, currentConversation: true };
const video = { enabled: true, engineReady: true, turnAvailable: true };
const build = extra => buildRuntimeCapabilities({ now, pwa, ...extra });

test('ready video means bounded platform attempts, not acquired evidence or full viewing', () => {
  const facts = build({ video });
  assert.deepEqual(facts.video.platforms, ['youtube', 'bilibili']);
  assert.equal(facts.video.evidence.status, 'none'); assert.equal(facts.video.evidence.hasMaterial, false);
  const text = renderRuntimeCapabilities(facts);
  assert.match(text, /可尝试读取.*YouTube\/B站/); assert.match(text, /登录、验证、地域/);
  assert.match(text, /尚无已取得的视频材料/); assert.match(text, /不包含逐帧观看、音轨转写或完整观看/);
  assert.doesNotMatch(text, /本轮已取得实际/);
});

test('only enabled video platforms are advertised and unusable configurations have no evidence', () => {
  const facts = build({ video: { ...video, platforms: ['bilibili'] } });
  assert.deepEqual(facts.video.platforms, ['bilibili']);
  assert.match(renderRuntimeCapabilities(facts), /引用的B站常规视频/);
  assert.doesNotMatch(renderRuntimeCapabilities(facts), /YouTube/);
  for (const platforms of [[], null, 'bilibili', ['bilibili', 'invalid-site']]) {
    const invalid = build({ video: { ...video, platforms, evidence: { status: 'ok', frameCount: 1 } } });
    assert.equal(invalid.video.available, false);
    assert.equal(invalid.video.evidence.hasMaterial, false);
  }
});

test('current partial evidence describes actual subtitles and sampled images separately', () => {
  const facts = build({ video: { ...video, evidence: { status: 'partial', subtitleCount: 7, frameCount: 3 } } });
  const text = renderRuntimeCapabilities(facts);
  assert.equal(facts.video.evidence.hasMaterial, true);
  assert.match(text, /本轮已取得实际可得的字幕资料和3张采样画面/);
  assert.match(text, /字幕可能截断或仅覆盖部分/);
  assert.equal(facts.video.evidence.completeViewing, false); assert.equal(facts.video.evidence.audioTranscribed, false);
  const silent = renderRuntimeCapabilities(build({ video: { ...video, evidence: { status: 'ok', subtitleCount: 0, frameCount: 1 } } }));
  assert.match(silent, /本轮没有可用字幕/); assert.match(silent, /不能根据画面编造未听到/);
  const subtitles = renderRuntimeCapabilities(build({ video: { ...video, evidence: { status: 'partial', subtitleCount: 1, frameCount: 0 } } }));
  assert.match(subtitles, /已取得实际可得的字幕资料/); assert.doesNotMatch(subtitles, /0张采样|本轮没有可用字幕/);
});

test('restricted, unavailable or invalid results cannot establish acquired material', () => {
  for (const status of ['restricted', 'unavailable', 'unsupported', 'available', 'invented']) {
    const facts = build({ video: { ...video, evidence: { status, subtitleCount: 100, frameCount: 4 } } });
    assert.equal(facts.video.evidence.hasMaterial, false);
    assert.equal(facts.video.evidence.subtitleCount, 0); assert.equal(facts.video.evidence.frameCount, 0);
  }
  const restricted = renderRuntimeCapabilities(build({ video: { ...video, evidence: { status: 'restricted' } } }));
  assert.match(restricted, /本轮视频来源访问受限/); assert.match(restricted, /未取得可理解的字幕或画面/);
  const empty = build({ video: { ...video, evidence: { status: 'ok', subtitleCount: 2001, frameCount: 5 } } });
  assert.equal(empty.video.evidence.status, 'unavailable'); assert.equal(empty.video.evidence.hasMaterial, false);
});

