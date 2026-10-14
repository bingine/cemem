/** 测试辅助：启动/关闭夹具进程（供 node:test 使用） */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

/** 启动夹具并等待它报告 ready */
function startFixture() {
  const proc = spawn(
    process.execPath,
    [path.join(__dirname, '..', 'fixture-target.js')],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );

  let buffer = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('夹具启动超时')), 20000);
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buffer.slice(0, nl)));
        } catch (e) {
          reject(e);
        }
      }
    });
    proc.on('error', reject);
  });

  /** 发送指令并等待一行回包 */
  const command = (cmd) =>
    new Promise((resolve) => {
      let acc = '';
      const onData = (chunk) => {
        acc += chunk.toString();
        const nl = acc.indexOf('\n');
        if (nl !== -1) {
          proc.stdout.off('data', onData);
          resolve(acc.slice(0, nl));
        }
      };
      proc.stdout.on('data', onData);
      proc.stdin.write(cmd + '\n');
    });

  const stop = () => {
    try {
      proc.stdin.write('quit\n');
    } catch { /* 已退出 */ }
    setTimeout(() => {
      try { proc.kill(); } catch { /* 已退出 */ }
    }, 200);
  };

  return { proc, ready, command, stop };
}

/** 便捷：启动一个独立夹具 + 打开它的进程句柄 */
async function openFixtureProcess() {
  const { Process } = require('../../dist/cjs/win/process');
  const fixture = startFixture();
  const info = await fixture.ready;
  const process_ = Process.open(info.pid);
  return { fixture, info, process: process_, base: BigInt(info.base) };
}

/**
 * 测试用例作用域内的夹具管理。
 *
 * 必须每个测试用例一个独立夹具：夹具进程里的内存会被测试改写
 * （写值、mutate 等），共用同一个夹具会让测试之间产生状态串扰
 * —— 早期版本就因此出现过"期望 1100 实际 1000"的假失败。
 *
 * 用法：
 * ```js
 * const env = useFixture();
 * test('...', async () => { const { process, base } = env.ctx; ... });
 * ```
 */
function useFixture() {
  const box = { ctx: null };
  const setup = async () => {
    box.ctx = await openFixtureProcess();
  };
  const teardown = () => {
    if (!box.ctx) return;
    try {
      box.ctx.process.close();
    } catch { /* 句柄可能已失效 */ }
    box.ctx.fixture.stop();
    box.ctx = null;
  };
  return { box, setup, teardown };
}

module.exports = { startFixture, openFixtureProcess, useFixture };
