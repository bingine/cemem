/**
 * 最小复现（self-contained）：验证
 *   主线程 `Atomics.wait` 阻塞  +  worker 里非阻塞轮询 + worker 里 socket I/O
 * 三者能否共存。
 *
 * 结论（跑通即证明）：worker 侧**必须全程非阻塞**（setImmediate 轮询）。
 * 若 worker 里用 `Atomics.wait` 阻塞，则 worker 自己的事件循环被卡死，
 * socket 回调与 postMessage 都执行不了 —— 主线程每次都超时。
 */
'use strict';

const { Worker } = require('node:worker_threads');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
const { connect } = require('node:net');

let shared = null, host = '127.0.0.1', port = 0;

parentPort.on('message', (msg) => {
  if (msg.type !== 'init') return;
  host = msg.host; port = msg.port; shared = msg.buf;

  const ctrl = new Int32Array(shared, 0, 4);
  let last = Atomics.load(ctrl, 0);

  const pump = () => {
    const seq = Atomics.load(ctrl, 0);
    if (seq === last) { setTimeout(pump, 1); return; }   // 关键：用 setTimeout 让出到"定时器阶段"，
                                                         // 事件循环才会进入 poll 阶段处理 socket I/O。
                                                         // 用 setImmediate 会自旋饥饿 I/O（实测超时）。
    last = seq;
    console.log('[worker] 收到请求 seq =', seq);
    const c = connect({ host, port });
    c.on('connect', () => c.write('ping'));
    c.on('data', (d) => {
      console.log('[worker] 收到响应:', d.toString());
      c.destroy();
      Atomics.store(ctrl, 3, seq);
      Atomics.notify(ctrl, 3);
      setTimeout(pump, 1);
    });
    c.on('error', (e) => {
      console.log('[worker] socket 错误', e.message);
      Atomics.store(ctrl, 3, seq);
      Atomics.notify(ctrl, 3);
      setTimeout(pump, 1);
    });
  };

  parentPort.postMessage({ type: 'ready' });
  setImmediate(pump);
});
`;

// 写入 worker 文件（每次运行重写，保证与上面的源码一致）
const workerPath = path.join(__dirname, '_mini-worker.js');
fs.writeFileSync(workerPath, WORKER_SRC, 'utf8');

const server = net.createServer((s) => {
  s.on('data', () => s.write('pong'));
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const buf = new SharedArrayBuffer(64);
  const ctrl = new Int32Array(buf, 0, 4);

  const w = new Worker(workerPath);
  w.on('message', (m) => {
    if (m.type !== 'ready') return;
    console.log('[main] worker 就绪，发请求并阻塞等待');
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);

    const t0 = Date.now();
    for (;;) {
      const done = Atomics.load(ctrl, 3);
      if (done === 1) {
        console.log(`[main] ✅ 成功，用时 ${Date.now() - t0}ms`);
        break;
      }
      if (Date.now() - t0 > 5000) {
        console.log('[main] ❌ 超时 5s');
        break;
      }
      Atomics.wait(ctrl, 3, done, 100);
    }
    void w.terminate();
    server.close();
    fs.unlinkSync(workerPath);
  });

  w.postMessage({ type: 'init', host: '127.0.0.1', port, buf });
});
