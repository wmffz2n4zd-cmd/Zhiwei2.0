import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeRuntimeUsage } from '../src/runtime-usage.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const usage = 'Usage: node scripts/runtime-usage.mjs inspect [--project-dir DIR] [--from YYYY-MM-DD] [--to YYYY-MM-DD]';
function invalid() { return Object.assign(Error(usage), { code: 'USAGE_COMMAND_INVALID' }); }
export async function runUsageCommand({ argv = [], projectDir = root } = {}) {
  const [command, ...rest] = argv;
  if (command !== 'inspect') throw invalid();
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!['--project-dir', '--from', '--to'].includes(key) || !value || value.startsWith('--') || options[key] !== undefined) throw invalid();
    options[key] = value;
  }
  return summarizeRuntimeUsage({ directory: join(resolve(options['--project-dir'] || projectDir), 'data', 'runtime-usage'),
    from: options['--from'], to: options['--to'] });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runUsageCommand({ argv: process.argv.slice(2) }), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ ok: false, reason: error?.code === 'USAGE_COMMAND_INVALID' ? 'invalid-command' : 'usage-unavailable',
      message: error?.code === 'USAGE_COMMAND_INVALID' ? usage : 'Usage could not be read safely. No quota was queried and no model was called.' }));
    process.exitCode = 1;
  }
}
