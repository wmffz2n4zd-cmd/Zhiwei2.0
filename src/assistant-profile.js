import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Every model entry reads the same optional profile, without a stale cache or
// truncation. An explicitly configured but unreadable file is an error: never
// quietly replace the intended character with a different/default persona.
export async function loadAssistantProfile({ projectDir, config = {}, env = process.env } = {}) {
  const selected = env.CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH || config.assistantProfile;
  if (!selected) return '';
  return readFile(resolve(projectDir, selected), 'utf8');
}
