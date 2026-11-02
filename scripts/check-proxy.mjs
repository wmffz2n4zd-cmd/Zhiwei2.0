import { fileURLToPath } from 'node:url';
import { loadLocalConfig } from '../src/portable.js';
import { HubCommands, proxyRequest } from '../src/hub-commands.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const config = loadLocalConfig(root);
const commands = new HubCommands({ config });
const event = text => ({ text, senderId: config.ownerUserIds[0], isOwner: true, type: 'private_message' });
console.log(await commands.handle(event('/节点检查')));
const listing = await commands.handle(event('/节点列表'));
console.log(listing.split('\n')[0]);
if (process.argv.includes('--verify-write')) {
  const before = await proxyRequest(config.proxyControl, '/proxies');
  const current = before.proxies[config.proxyControl.group].now;
  // Exercise the exact command handler while preserving the current selection.
  console.log(await commands.handle(event('/切换节点 ' + current)));
  const after = await proxyRequest(config.proxyControl, '/proxies');
  if (after.proxies[config.proxyControl.group].now !== current) throw Error('Selection verification failed');
  console.log('Write interface verified; selected node unchanged.');
}
