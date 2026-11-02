import { readAccountQuota, quotaDiagnostics } from '../src/codex-quota.js';
import { loadLocalConfig } from '../src/portable.js';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const config = loadLocalConfig(projectDir);
try {
  const snapshot = await readAccountQuota({ proxy: config.codexProxy });
  console.log(JSON.stringify(quotaDiagnostics(snapshot), null, 2));
} catch {
  // Neither server diagnostics nor auth material should enter shared engineering records.
  console.error('Runtime quota unavailable; no model was called and no allowance was inferred.');
  process.exitCode = 1;
}
