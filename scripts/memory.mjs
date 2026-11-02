import { createUnifiedMemory } from '../src/unified-memory/index.js';
import { loadLocalConfig } from '../src/portable.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const config = loadLocalConfig(root);
const [action, owner, ...text] = process.argv.slice(2);
if (!['read', 'write', 'status'].includes(action) || !config.ownerUserIds?.includes(owner)) {
  console.error('用法：node scripts/memory.mjs read|write|status 管理员QQ [内容]'); process.exitCode = 1;
} else {
  const memory = createUnifiedMemory({ memoryPath: resolve(root, 'data/unified-memory.json') });
  const scope = `qq:private:${owner}`;
  const result = action === 'write' ? await memory.write({ scope, type: 'handoff', source: 'desktop-cli', summary: text.join(' ') }) :
    action === 'status' ? await memory.status({ scope }) : await memory.read({ scope, query: text.join(' ') });
  console.log(JSON.stringify(result, null, 2));
}
