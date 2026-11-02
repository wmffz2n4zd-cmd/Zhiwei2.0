export function classifyCliFailure(stdout = '', stderr = '') {
  const messages = [];
  for (const line of stdout.split('\n')) {
    try { const event = JSON.parse(line); if (['error', 'turn.failed'].includes(event.type)) messages.push(JSON.stringify(event)); } catch {}
  }
  messages.push(...stderr.split('\n').filter(line => /^ERROR:/.test(line)));
  const error = messages.join('\n');
  if (/usage.limit|quota|insufficient_quota|credit.balance|hit your.*limit/i.test(error)) return 'Codex 额度已用尽或达到使用限制，请等待恢复后再试。';
  if (/rate.limit|too many requests|429/i.test(error)) return 'Codex 请求暂时受限，请稍后再试。';
  if (/authentication|unauthorized|401|login required/i.test(error)) return 'Codex 登录状态失效，需要在电脑上重新登录。';
  if (/model.*(not found|not supported|unavailable|does not exist)/i.test(error)) return '当前模型不可用，请检查模型配置或账号权限。';
  if (/connect|timeout|timed out|stream.*disconnect|network/i.test(error)) return 'Codex 连接中断或超时，请检查代理后重试。';
  if (/plugin.*assets|plugin.*manifest/i.test(error)) return 'Codex 插件配置加载失败，需要检查本机插件。';
  return 'Codex 本次运行失败，详细诊断已保存在电脑本地。';
}
export function publicFailure(error) {
  return error?.safeForChat === true ? error.message : '本次处理失败，需在电脑上查看后台诊断；没有完成的任务请勿视为已执行成功。';
}
