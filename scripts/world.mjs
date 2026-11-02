import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadLocalConfig } from '../src/portable.js';
import { createWorld, createWorldHttp } from '../src/world.js';
const projectDir = fileURLToPath(new URL('../', import.meta.url));
const config = loadLocalConfig(projectDir);
const world = await createWorld({ projectDir, config });
const handler = createWorldHttp(world, { projectDir });
const server = createServer(async (req,res) => {
  try { if (!(await handler(req,res))) { res.writeHead(404);res.end('Not found'); } }
  catch { res.writeHead(500);res.end('World service error'); }
});
const port = Number(process.env.WORLD_PORT || 3791);
server.listen(port,'127.0.0.1',()=>console.log(`知微阅读与留言板：http://127.0.0.1:${port}/world`));
world.startScheduler();
async function stop(){server.close();await world.close();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
