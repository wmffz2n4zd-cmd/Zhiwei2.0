import { join } from 'node:path';
import { createRuntimeBudget, RuntimeBudgetError } from './runtime-budget.js';
import { readAccountQuota } from './codex-quota.js';
import { createRuntimeUsage } from './runtime-usage.js';

// Both runtime entry points use this directory. Developer smoke/benchmark tools
// are not Zhiwei runtime and must never be scheduled as a budget bypass.
export async function createConfiguredRuntimeBudget({ projectDir, config = {}, meter, now = Date.now } = {}) {
  if (config.runtimeBudget?.mode === 'observe') return createRuntimeUsage({
    directory: join(projectDir, 'data', 'runtime-usage'), now });
  if (config.runtimeBudget?.enabled === false) return {
    run: async (_request, action) => action(),
    getStatus: () => ({ enabled: false, enforced: false, reason: 'explicitly-disabled' }),
    close: async () => {}
  };
  try {
    return await createRuntimeBudget({ directory: join(projectDir, 'data', 'runtime-budget'),
      config: config.runtimeBudget || {}, now,
      meter: meter || (() => readAccountQuota({ cwd: projectDir, proxy: config.codexProxy, now })) });
  } catch {
    // A corrupt ledger/active other writer must not disable local management
    // commands or silently turn off admission. Preserve files for inspection.
    return {
      async run() { throw new RuntimeBudgetError('storage-unavailable'); },
      getStatus: () => ({ enabled: true, enforced: true, blocked: true, reason: 'storage-unavailable' }),
      close: async () => {}
    };
  }
}
