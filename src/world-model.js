import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { codexCommand, resolveCodex } from './portable.js';

export const worldDecisionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['rest', 'search', 'follow', 'note'] },
    query: { type: ['string', 'null'] },
    linkIndex: { type: ['integer', 'null'] },
    summary: { type: ['string', 'null'] },
    comment: { type: ['string', 'null'] }
  },
  required: ['action', 'query', 'linkIndex', 'summary', 'comment']
};

// Disable supported capability groups explicitly. unified_exec=false is not a
// control: recent CLI versions ignore user opt-outs. shell_tool is the gate.
// These settings reduce capabilities, but do not certify that every future CLI
// builtin is absent. The event guard below is detection, not an OS boundary.
export const worldModelConfig = Object.freeze({
  'features.shell_tool': false,
  'features.shell_snapshot': false,
  'features.apps': false,
  'features.plugins': false,
  'features.remote_plugin': false,
  'features.memories': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.browser_use': false,
  'features.browser_use_external': false,
  'features.computer_use': false,
  'features.in_app_browser': false,
  'features.image_generation': false,
  'features.hooks': false,
  'features.code_mode.enabled': false,
  'features.code_mode_host': false,
  'features.skill_search': false,
  'features.skill_mcp_dependency_install': false,
  'features.skip_host_skill_discovery': true,
  'features.tool_suggest': false,
  'features.goals': false,
  'features.sleep_tool': false,
  'features.request_permissions_tool': false,
  'skills.bundled.enabled': false,
  'memories.use_memories': false,
  'memories.generate_memories': false,
  'project_doc_max_bytes': 0,
  'web_search': 'disabled',
  'approval_policy': 'never',
  'history.persistence': 'none',
  'analytics.enabled': false,
  'suppress_unstable_features_warning': true,
  'forced_login_method': 'chatgpt'
});

export function worldModelEnvironment(source = process.env, proxy) {
  // Preserve the login location, never read/copy auth files, and do not inherit
  // API keys, app bridges, MCP credentials, NODE_OPTIONS or arbitrary secrets.
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|HOME|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|CODEX_HOME|LANG|LC_ALL)$/i;
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key)));
  if (proxy) {
    const url = new URL(proxy);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) throw Error('阅读模型代理协议无效');
    env.HTTP_PROXY = proxy; env.HTTPS_PROXY = proxy;
    env.NO_PROXY = 'localhost,127.0.0.1,::1';
  }
  return env;
}

export function buildWorldModelArgs({ cwd, schemaPath, model, reasoningEffort, imagePaths = [], platform = process.platform }) {
  const config = { ...worldModelConfig, model_reasoning_effort: reasoningEffort };
  if (platform === 'win32') config['windows.sandbox'] = 'elevated';
  // Mark the fresh directory untrusted so ancestor project config is skipped.
  const args = ['--no-daemon', 'exec', '--ignore-user-config', '--ignore-rules', '--strict-config',
    '--ephemeral', '--skip-git-repo-check', '--json', '--color', 'never', '-s', 'read-only',
    '-m', model, '-C', cwd, '--output-schema', schemaPath];
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${JSON.stringify(value)}`);
  args.push('-c', 'mcp_servers={}', '-c', `projects.${JSON.stringify(cwd)}.trust_level="untrusted"`);
  for (const path of imagePaths) args.push('--image', path);
  args.push('-');
  return args;
}

export function parseWorldUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const keys = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
  if (!keys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || value.cached_input_tokens > value.input_tokens) return null;
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function invoke({ command, args, cwd, env, prompt, timeoutMs }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', text = '', usage = null, completed = false, failure = null, bytes = 0;
    const fail = message => { failure ||= Error(message); child.kill(); };
    const timer = setTimeout(() => fail('阅读模型调用超时'), timeoutMs);
    const line = raw => {
      if (!raw.trim() || failure) return;
      let event;
      try { event = JSON.parse(raw); } catch { fail('阅读模型返回了无效的事件格式'); return; }
      if (event.type === 'error' || event.type === 'turn.failed') { fail('阅读模型调用失败'); return; }
      if (event.type?.startsWith('item.')) {
        if (event.item?.type === 'error') {
          // CLI 0.164 emits this capability-disabled notice as an error item.
          // The disabled code-mode host is intentional; it cannot execute tools.
          if (event.item.message === 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.') return;
          fail('阅读模型报告了运行错误');
          failure.diagnostic = String(event.item.message || '').slice(0, 1000);
          return;
        }
        if (!['agent_message', 'reasoning'].includes(event.item?.type)) {
          const itemType = String(event.item?.type || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
          fail(`阅读模型出现了不允许的工具或操作事件（${itemType}），已终止`); return;
        }
        if (event.type === 'item.completed' && event.item.type === 'agent_message') text = event.item.text || '';
      }
      if (event.type === 'turn.completed') { completed = true; usage = parseWorldUsage(event.usage); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) { fail('阅读模型输出超过限制'); return; }
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    // Drain diagnostics without storing prompts, credentials or model content.
    child.stderr.on('data', () => {});
    child.on('error', error => { clearTimeout(timer); reject(Object.assign(Error('无法启动阅读模型'), { code: error.code })); });
    child.on('close', code => {
      clearTimeout(timer);
      if (buffer.trim()) line(buffer);
      if (failure) return reject(Object.assign(failure, { usage }));
      if (code !== 0 || !completed) return reject(Object.assign(Error(`阅读模型未正常完成（退出码 ${code}）`), { usage }));
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
      } catch { return reject(Object.assign(Error('阅读模型没有返回有效的JSON对象'), { usage })); }
      resolveRun({ text, usage });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

export function createWorldModel({ directory, model = 'gpt-6.1-sol', reasoningEffort = 'low',
  proxy, codexPath, schema = worldDecisionSchema, timeoutMs = 180000 } = {}) {
  if (typeof directory !== 'string' || !directory) throw Error('阅读模型需要独立工作目录');
  if (!/^[a-zA-Z0-9._:-]+$/.test(model)) throw Error('阅读模型名称无效');
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort)) throw Error('阅读模型推理等级无效');
  if (!schema || schema.type !== 'object') throw Error('阅读模型需要JSON对象schema');
  const root = resolve(directory);
  return async ({ prompt, imagePaths = [] } = {}) => {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000) throw Error('阅读模型输入为空或过长');
    if (!Array.isArray(imagePaths) || imagePaths.length > 8 || imagePaths.some(path => typeof path !== 'string' || !isAbsolute(path))) throw Error('阅读模型图片路径无效');
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(join(root, 'run-'));
    try {
      const schemaPath = join(cwd, 'response.schema.json');
      await writeFile(schemaPath, JSON.stringify(schema));
      const args = buildWorldModelArgs({ cwd, schemaPath, model, reasoningEffort, imagePaths });
      const invocation = codexCommand(codexPath || resolveCodex(), args);
      return await invoke({ ...invocation, cwd, env: worldModelEnvironment(process.env, proxy), prompt,
        timeoutMs: Math.max(100, Math.min(300000, timeoutMs)) });
    } finally {
      const childPath = relative(root, cwd);
      if (!childPath || childPath.startsWith('..' + sep) || isAbsolute(childPath)) throw Error('阅读模型临时目录超出范围');
      await rm(cwd, { recursive: true, force: true });
    }
  };
}
