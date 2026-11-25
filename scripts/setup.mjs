import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function setup(args) {
  if (args.length !== 1) throw Error('Usage: npm run setup -- https://chat.example.org');
  const [origin] = args;
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) {
    throw Error('Enter an HTTPS origin with no path, credentials, query, fragment or trailing slash.');
  }

  const dir = new URL('../data/', import.meta.url);
  const target = new URL('windows.local.json', dir);
  // Earlier public builds read local.json; a new template would select unrelated defaults.
  for (const name of ['local.json', 'local.json.previous', 'windows.local.json.previous']) {
    try {
      await lstat(new URL(name, dir));
      throw Error('Found data/' + name + '. Review your existing installation and set up v2.03 in a separate directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const settings = JSON.parse(await readFile(new URL('../config/windows.example.json', import.meta.url), 'utf8'));
  settings.pwa.origin = origin;
  await mkdir(dir, {recursive: true, mode: 0o700});
  const temporary = new URL('setup-' + randomUUID() + '.tmp', dir);
  await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  try {
    // Publish only complete contents. A concurrent setup or existing file wins.
    await link(temporary, target);
  } catch (error) {
    if (error.code === 'EEXIST') throw Error('Configuration already exists. Edit data/windows.local.json to change it.');
    throw error;
  } finally {
    await unlink(temporary);
  }
  console.log('Created ' + fileURLToPath(target));
}

try {
  await setup(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
