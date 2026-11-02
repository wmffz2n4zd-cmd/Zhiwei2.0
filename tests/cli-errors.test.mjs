import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCliFailure, publicFailure } from '../src/cli-errors.js';
test('CLI errors classify structured failure without forwarding prompts or warnings', () => {
  const quota = JSON.stringify({ type: 'turn.failed', error: { message: 'You have hit your usage limit' } });
  assert.match(classifyCliFailure(quota, 'WARN PowerShell snapshot not supported'), /额度/);
  const raw = 'WARN plugin assets invalid\nuser\nPRIVATE_PERSONA secret_token\nquota';
  assert.equal(classifyCliFailure('', raw), 'Codex 本次运行失败，详细诊断已保存在电脑本地。');
  assert.doesNotMatch(publicFailure(new Error(raw)), /PRIVATE_PERSONA|secret_token|assets/);
  assert.match(classifyCliFailure(JSON.stringify({ type: 'error', message: 'stream disconnected' })), /连接/);
});
