// 验证：主线程 Atomics.wait 期间，Promise 微任务与 socket I/O 能否推进
const net = require('node:net');
const server = net.createServer(s => { s.on('data', d => s.write('pong')); });
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const state = new Int32Array(new SharedArrayBuffer(4));
  let done = false; let result = null;
  const p = new Promise((resolve, reject) => {
    const c = net.connect({ host: '127.0.0.1', port });
    c.on('connect', () => c.write('ping'));
    c.on('data', d => { result = d.toString(); c.destroy(); resolve(result); });
    c.on('error', reject);
  });
  p.then(v => { result = v; done = true; Atomics.store(state,0,1); Atomics.notify(state,0); },
         e => { result = 'ERR:'+e.message; done = true; Atomics.store(state,0,1); Atomics.notify(state,0); });
  const t0 = Date.now();
  while (!done && Date.now() - t0 < 3000) { Atomics.wait(state, 0, 0, 50); }
  console.log(done ? `OK: 主线程 Atomics.wait 期间 socket 往返成功 -> ${result} (${Date.now()-t0}ms)` : `FAIL: 死锁/未完成 (${Date.now()-t0}ms)`);
  server.close();
});
