import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { buildCreativeProgramDocument, runCreativeProgram } from '../src/creative-program-runner.js';

const html = '<!doctype html><button id="switch">开启</button><script>document.getElementById("switch").onclick = e => { e.target.textContent = "A&B"; }</script>';
const job = {html,clicks:['switch']};

async function withSocket(reply, action, onHello) {
  const tmp = await mkdtemp(join(tmpdir(),'s156-socket-'));
  const path = process.platform === 'win32' ? '\\\\.\\pipe\\s156-'+randomUUID() : join(tmp,'worker.sock');
  const clients = new Set();
  const server = createServer(socket => {
    clients.add(socket);
    socket.once('close',()=>clients.delete(socket)).on('error',()=>{});
    let text = '';
    socket.on('data', bytes => {
      text += bytes;
      if (!text.endsWith('\n')) return;
      const request = JSON.parse(text);
      text = '';
      if (request.hello === 1) {
        if (onHello) onHello(socket); else socket.write('{"ready":true}\n');
      } else reply(socket, request);
    });
  });
  try {
    server.listen(path);
    await once(server,'listening');
    return await action(path);
  } finally {
    for (const client of clients) client.destroy();
    await new Promise(resolve=>server.close(resolve));
    await rm(tmp,{recursive:true,force:true});
  }
}

test('独立 HTML 导出完整保存原始程序且只能在不共享源的 iframe 中运行', () => {
  const source = html + '<p title="&quot;">&lt; &gt;</p></iframe>\n';
  const wrapped = buildCreativeProgramDocument(source);
  assert.equal(buildCreativeProgramDocument(wrapped),wrapped);
  assert.equal((wrapped.match(/<iframe\b/g)||[]).length,1);
  assert.equal((wrapped.match(/<\/iframe>/g)||[]).length,1);
  assert.ok(wrapped.includes('sandbox="allow-scripts"'));
  assert.ok(!wrapped.includes('allow-same-origin') && !wrapped.includes('<script>'));
  assert.ok(wrapped.includes("connect-src 'none'"));
  assert.throws(()=>buildCreativeProgramDocument(' '.repeat(70000)));
  assert.throws(()=>buildCreativeProgramDocument('\0'));
});

test('拒绝任意选择器、空操作和超量操作，调用者取消时不会启动任务', async () => {
  for (const clicks of [[],['#switch'],['a, iframe'],['按钮'],['a','b','c','d','e']]) {
    await assert.rejects(runCreativeProgram({html,clicks}),/点击/);
  }
  const controller = new AbortController();
  controller.abort(Error('已取消'));
  await assert.rejects(runCreativeProgram(job,{signal:controller.signal}),/取消/);
});

test('以独立 socket 收发源码和真实截图格式，下载重开可还原完全相同的被测程序', async () => {
  const screenshot = await sharp({create:{width:6,height:4,channels:3,background:'#a6880d'}}).jpeg().toBuffer();
  const row = {text:'开启',samples:[],screenshot:screenshot.toString('base64')};
  let received;
  await withSocket((socket, input) => {
    received = input;
    const message = JSON.stringify({observations:[{...row,action:null},{...row,action:'switch',text:'A&B'}],errors:[]})+'\n';
    socket.write(message.slice(0,55));
    socket.end(message.slice(55));
  }, async socketPath => {
    const response = await runCreativeProgram({...job,html:buildCreativeProgramDocument(html)}, {socketPath});
    assert.deepEqual(received,job);
    assert.deepEqual(response.observations.map(item=>item.action),[null,'switch']);
    assert.deepEqual(response.observations[1].screenshot,screenshot);
    assert.deepEqual(response.errors,[]);
  });
});

test('独立 worker 明确失败、返回错误结果或缺少正确动作对应截图均不交付', async () => {
  const bad = [{error:'隔离条件缺失'}, {observations:[],errors:[]},
    {observations:[{action:'wrong',text:'x',samples:[],screenshot:'xxx'}],errors:[]},
    {observations:[{action:null,text:'x',samples:[],screenshot:'xxx'}],errors:[]}];
  for (const data of bad) {
    await withSocket(socket => socket.end(JSON.stringify(data)+'\n'), async socketPath => {
      await assert.rejects(runCreativeProgram(job,{socketPath}));
    });
  }
});

test('等待 worker 时取消立即断开单次连接', async () => {
  const ctrl = new AbortController();
  let received = false;
  await withSocket(() => { received = true; ctrl.abort(Error('取消本作品')); }, async socketPath => {
    await assert.rejects(runCreativeProgram(job, {socketPath,signal:ctrl.signal}),/取消本作品/);
    assert.equal(received,true);
  });
});

test('同一 worker 串行执行多人的任务，排队取消后不消耗 worker，不阻塞下一人', async () => {
  const ctrl = new AbortController(), received = [];
  let active = 0, maxActive = 0;
  await withSocket((socket, request) => {
    received.push(request.clicks[0]);
    active += 1; maxActive = Math.max(maxActive,active);
    setTimeout(() => {
      active -= 1;
      socket.end(JSON.stringify({observations:[],errors:['网页加载超时']})+'\n');
    },25);
  }, async socketPath => {
    const first = runCreativeProgram({...job,clicks:['first']},{socketPath});
    const skipped = runCreativeProgram({...job,clicks:['cancelled']},{socketPath,signal:ctrl.signal});
    const last = runCreativeProgram({...job,clicks:['last']},{socketPath});
    ctrl.abort(Error('排队取消'));
    await assert.rejects(skipped,/排队取消/);
    const results = await Promise.all([first,last]);
    assert.deepEqual(received,['first','last']);
    assert.equal(maxActive,1);
    assert.deepEqual(results[0],{observations:[],errors:['网页加载超时']});
  });
});

test('仅重试就绪握手，作品提交后一旦连接丢失不得重跑或伪造成功', async () => {
  let hellos = 0, jobs = 0;
  await withSocket(socket => { jobs++; socket.destroy(); }, async socketPath => {
    await assert.rejects(runCreativeProgram(job,{socketPath}),/中断|连接/);
    assert.equal(hellos,2);
    assert.equal(jobs,1);
  }, socket => {
    if (++hellos === 1) socket.destroy(); else socket.write('{"ready":true}\n');
  });
});
