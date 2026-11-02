import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const placeholder = value => /^(?:set-your-secret|your-secret|changeme)$/i.test(String(value || '').trim());

function validateControl(config, platform = process.platform) {
  if (config?.pipe) {
    if (platform !== 'win32' || !/^\\\\\.\\pipe\\verge-mihomo-[a-zA-Z0-9-]+$/.test(config.pipe)) throw Error('无效的 Clash Verge 本机管道');
    return;
  }
  if (!config?.controller) throw Error('未找到 Clash Verge 本机控制接口，请先启动 Clash Verge。');
  let base;
  try { base = new URL(config.controller); } catch { throw Error('代理控制接口必须是本机 HTTP 地址'); }
  if (base.protocol !== 'http:' || !loopbackHosts.has(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw Error('代理控制接口必须是本机 HTTP 地址');
}

// Only top-level scalars used by Mihomo's local control API. No general YAML execution.
function yamlScalar(value) {
  value = value.trim();
  if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return undefined; } }
  if (value.startsWith("'")) {
    const match = value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    return match ? match[1].replaceAll("''", "'") : undefined;
  }
  if (/^[!&*|>\[{]/.test(value)) return undefined;
  return value.replace(/\s+#.*$/, '').trim();
}

export function parseClashControlYaml(text) {
  const scalars = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^(external-controller-pipe|external-controller|secret):\s*(.*)$/.exec(line);
    if (match) scalars[match[1]] = yamlScalar(match[2]);
  }
  return {
    ...(scalars['external-controller-pipe'] ? { pipe: scalars['external-controller-pipe'] } : {}),
    ...(scalars['external-controller'] ? { controller: /^https?:/.test(scalars['external-controller']) ? scalars['external-controller'] : 'http://' + scalars['external-controller'] } : {}),
    secret: scalars.secret || ''
  };
}

export async function proxyRequest(config, path, options = {}) {
  validateControl(config);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw Error('无效的控制接口路径');
  const base = config.pipe ? {} : new URL(config.controller);
  return new Promise((resolve, reject) => {
    const req = httpRequest(config.pipe ? {
      socketPath: config.pipe, path,
      method: options.method || 'GET',
      headers: { 'content-type': 'application/json', ...(config.secret ? { authorization: 'Bearer ' + config.secret } : {}) }
    } : {
      hostname: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || 80, path,
      method: options.method || 'GET',
      headers: { 'content-type': 'application/json', ...(config.secret ? { authorization: 'Bearer ' + config.secret } : {}) }
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 4 * 1024 * 1024) req.destroy(Error('代理接口响应过大')); });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(Error(`代理控制接口 HTTP ${res.statusCode}`));
        try { resolve(body.trim() ? JSON.parse(body) : {}); } catch { reject(Error('代理接口返回无效 JSON')); }
      });
    });
    const deadline = setTimeout(() => req.destroy(Error('代理控制接口超时')), options.timeoutMs || 3000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject); req.end(options.body);
  });
}

export async function resolveProxyControl(config = {}, { env = process.env, platform = process.platform, request = proxyRequest } = {}) {
  const candidates = [];
  const explicit = Boolean(config.pipe || config.controller);
  if (explicit) validateControl(config, platform);
  if (explicit && Object.hasOwn(config, 'secret') && !placeholder(config.secret)) candidates.push(config);
  if (platform === 'win32' && env.APPDATA) {
    const folder = join(env.APPDATA, 'io.github.clash-verge-rev.clash-verge-rev');
    // clash-verge.yaml is the generated runtime configuration; config.yaml is fallback.
    for (const name of ['clash-verge.yaml', 'config.yaml']) {
      const text = await readFile(join(folder, name), 'utf8').catch(() => null);
      if (!text) continue;
      const discovered = { ...parseClashControlYaml(text), group: config.group };
      if (discovered.pipe || discovered.controller) candidates.push(discovered);
    }
  }
  if (explicit && !Object.hasOwn(config, 'secret')) candidates.push(config);
  const transports = candidates.flatMap(candidate => candidate.pipe && candidate.controller
    ? [candidate, { ...candidate, pipe: undefined }] : [candidate]);
  for (const candidate of transports) {
    try {
      validateControl(candidate, platform);
      await request(candidate, '/version', { timeoutMs: 1500 });
      return candidate;
    } catch { /* Try the next local runtime config without exposing its secret. */ }
  }
  throw Error('Clash Verge 控制接口不可用，请确认客户端正在运行；已检查本机运行配置。');
}

export async function assertProxyReachable(proxy, { timeoutMs = 1000 } = {}) {
  if (!proxy) return;
  let target;
  try { target = new URL(proxy); } catch { throw Error('Codex 代理地址无效。'); }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(target.protocol)) throw Error('Codex 代理协议不受支持。');
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : /^socks/.test(target.protocol) ? 1080 : 80));
  await new Promise((resolve, reject) => {
    const socket = connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port });
    const fail = () => { socket.destroy(); reject(Error('Codex 配置的代理未连接，请先启动代理客户端；本次没有尝试直连。')); };
    const timer = setTimeout(fail, timeoutMs);
    socket.once('error', fail);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once('close', () => clearTimeout(timer));
  });
}
