/**
 * 后端抽象测试。
 *
 * 重点验证：
 *   1. 上层 API 在两种后端下**签名与语义一致**；
 *   2. `NativeCeBackend` 的协议组帧/解析正确 —— 用一个按 `ceserver.h` 实现的
 *      本地假服务端逐字段核对（不依赖真实 ceserver 二进制）；
 *   3. 无服务端时给出**可操作**的错误信息，而不是静默失败。
 *
 * 真机联调需要用户提供一个正在运行的 ceserver，见 docs/backends.md。
 */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { useFixture } = require('./helpers/fixture');

const {
  Process,
  SelfBackend,
  NativeCeBackend,
  CESERVER_CMD,
  CESERVER_DEFAULT_PORT,
  getDefaultBackend,
  setDefaultBackend,
  listProcesses,
  listProcessesAsync,
  findProcessesByName,
  BackendUnsupportedError,
  VariableType,
  ScanSession,
  ScanOption,
  RoundingType,
} = require('../dist/cjs/index');

const env = useFixture();
beforeEach(() => env.setup());
afterEach(() => env.teardown());

/* ================================================================== *
 * SelfBackend
 * ================================================================== */

test('SelfBackend：能力声明与实际行为一致', async () => {
  const b = new SelfBackend();
  assert.equal(b.name, 'self');
  assert.equal(b.capabilities.local, true);
  assert.equal(b.capabilities.requiresServer, false);
  assert.equal(b.capabilities.enumerateProcesses, true);
  assert.equal(b.capabilities.queryRegions, true);
  assert.equal(b.capabilities.queryModules, true);

  const procs = b.listProcesses();
  assert.ok(procs.length > 0);
  assert.ok(procs.every((p) => typeof p.pid === 'number' && typeof p.name === 'string'));
});

test('SelfBackend：句柄生命周期与关闭后行为', async () => {
  const b = new SelfBackend();
  const pid = env.box.ctx.info.pid;
  const h = await b.openProcess(pid);
  assert.equal(h.pid, pid);
  assert.ok(h.id > 0);

  const buf = b.readProcessMemory(h, env.box.ctx.base, 16);
  assert.equal(buf.length, 16);

  b.closeProcess(h);
  assert.throws(() => b.readProcessMemory(h, env.box.ctx.base, 16), /句柄已关闭/);
  b.closeProcess(h); // 幂等
});

test('SelfBackend：打开不存在的进程给出 Win32 错误码', async () => {
  const b = new SelfBackend();
  assert.throws(
    () => b.openProcess(0x7ffffff0),
    (e) => {
      assert.equal(e.name, 'ProcessOpenError');
      assert.ok(typeof e.win32Code === 'number');
      assert.match(e.message, /无法打开进程/);
      return true;
    },
  );
});

test('SelfBackend：queryRegions 的过滤条件生效', async () => {
  const b = new SelfBackend();
  const h = await b.openProcess(env.box.ctx.info.pid);

  const all = b.queryRegions(h, { includeFree: true });
  assert.ok(all.length > 0);
  assert.ok(all.some((r) => r.state === 0x1000), '至少应有一个已提交区域');

  const committed = b.queryRegions(h, {});
  assert.ok(committed.length > 0);
  assert.ok(committed.every((r) => r.state === 0x1000), '默认只返回已提交区域');

  const writable = b.queryRegions(h, { writableOnly: true });
  assert.ok(
    writable.every((r) => {
      const base = r.protect & 0xff;
      return base === 0x04 || base === 0x08 || base === 0x40 || base === 0x80;
    }),
    'writableOnly 只应返回可写区域',
  );

  const noImages = b.queryRegions(h, { includeImage: false });
  assert.ok(noImages.every((r) => r.type !== 0x1000000), 'includeImage=false 不应包含映像区');

  b.closeProcess(h);
  await b.dispose();
});

test('Process 可显式指定后端，且后端信息可读', async () => {
  const backend = new SelfBackend();
  const p = Process.open(env.box.ctx.info.pid, { backend });
  assert.equal(p.backendName, 'self');
  assert.equal(p.backend, backend);
  assert.equal(p.backendHandle.pid, env.box.ctx.info.pid);
  assert.equal(
    Number(p.readMemoryExact(env.box.ctx.base + BigInt(env.box.ctx.info.offsets.health), 4).readInt32LE(0)),
    1000,
  );
  p.close();
  backend.dispose();
});

test('setDefaultBackend / getDefaultBackend 可全局切换后端', async () => {
  const original = getDefaultBackend();
  try {
    const custom = new SelfBackend();
    setDefaultBackend(custom);
    assert.equal(getDefaultBackend(), custom);

    const procs = listProcesses();
    assert.ok(procs.length > 0);
    const p = Process.open(env.box.ctx.info.pid);
    assert.equal(p.backend, custom);
    p.close();

    setDefaultBackend(null);
    assert.notEqual(getDefaultBackend(), custom);
    assert.ok(getDefaultBackend() instanceof SelfBackend);
  } finally {
    setDefaultBackend(original);
  }
});

test('上层扫描在显式后端下工作一致', async () => {
  const backend = new SelfBackend();
  const p = Process.open(env.box.ctx.info.pid, { backend });

  const s = new ScanSession(p, { blockSize: 1 << 20 });
  const st = s.firstScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1000',
    includeImage: false,
    includeMapped: false,
  });
  assert.ok(st.resultCount > 0);
  assert.ok(s.results.includes(env.box.ctx.base + BigInt(env.box.ctx.info.offsets.health)));

  p.close();
  backend.dispose();
});

test('findProcessesByName 在后端参数下工作', async () => {
  const backend = new SelfBackend();
  try {
    const hits = findProcessesByName('node', backend);
    assert.ok(hits.length > 0, '应能找到 node 进程');
    assert.ok(hits.some((p) => p.pid === process.pid));
  } finally {
    backend.dispose();
  }
});

/* ================================================================== *
 * 进程存活性与线程数（外部实测发现的两处真实缺陷）
 * ================================================================== */

/**
 * `listProcesses` 的 `threadCount` 曾经**恒为 0**。
 *
 * 成因是 `self-backend.ts` 里 `PROCESSENTRY32W` 的字段偏移按
 * 「th32DefaultHeapID 是 4 字节」算的（实际是 `uintptr_t`，x64 上 8 字节），
 * 于是 `threadCount` 读了 `th32ModuleID`（对齐填充，恒 0），
 * `parentPid` 读了 `th32ModuleID`。这里直接钉住真实值。
 */
test('进程枚举：threadCount / parentPid 必须是真实值（曾恒为 0）', () => {
  const all = listProcesses();
  assert.ok(all.length > 0);

  const self = all.find((p) => p.pid === process.pid);
  assert.ok(self !== undefined, '应能枚举到自己');
  assert.ok(
    self.threadCount > 0,
    `本进程的线程数必须 > 0（实际 ${self.threadCount}）—— 恒为 0 说明结构体偏移错了`,
  );
  assert.ok(self.parentPid > 0, `本进程的父进程 pid 必须 > 0（实际 ${self.parentPid}）`);

  // 线程数不能"整张表都是 0"：那是偏移错误的典型症状
  const nonZero = all.filter((p) => p.threadCount > 0);
  assert.ok(
    nonZero.length > all.length / 2,
    `绝大多数进程都该有线程（实际 ${nonZero.length}/${all.length} 非零）`,
  );
});

/**
 * `Process.isProcessAlive` 的语义：Windows 上**进程退出后句柄依然有效**，
 * 所以不看这一眼，上层会把"目标死了"退化成"0 个模块 / 读不到内存"。
 *
 * 这里同时验证**已退出**与**仍存活**两侧，以及"句柄已关闭 → false"。
 */
test('Process.isProcessAlive：活着=true / 已退出=false / 句柄已关=false', async () => {
  // 1) 自己一定活着
  const selfProc = Process.open(process.pid);
  assert.equal(selfProc.isOpen, true);
  assert.equal(selfProc.isProcessAlive(), true);
  selfProc.close();
  assert.equal(selfProc.isProcessAlive(), false, '句柄已关闭必须报 false');

  // 2) 一个马上退出的子进程：退出前 true，退出后 false
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], { stdio: 'ignore' });
  const childProc = Process.open(child.pid);
  try {
    assert.equal(childProc.isProcessAlive(), true, '子进程还活着时应报 true');
    await new Promise((resolve) => child.once('exit', resolve));
    // 等一会儿让内核真的把进程对象置为 signaled
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      childProc.isProcessAlive(),
      false,
      '子进程退出后必须报 false（句柄此时仍然 isOpen —— 这正是本方法存在的理由）',
    );
    assert.equal(childProc.isOpen, true, '退出后句柄仍处于打开状态（Windows 语义）');
  } finally {
    try { childProc.close(); } catch { /* 已关闭 */ }
    try { child.kill(); } catch { /* 已退出 */ }
  }
});

test('NativeCeBackend：无从判断存活时如实返回 undefined（不猜）', () => {
  const b = new NativeCeBackend({ host: '127.0.0.1', port: 1 });
  assert.equal(b.isProcessAlive({ id: 1, pid: 4 }), undefined);
});

/* ================================================================== *
 * NativeCeBackend —— 假 ceserver 验证协议
 * ================================================================== */

/**
 * 最小假 ceserver。
 *
 * 关键：客户端的每条命令都会建立**新连接**（ceserver 每条命令一个连接），
 * 因此当某个命令需要两轮往返（例如先读计数再读数据）时，
 * 服务端会在两条独立连接上收到同一个命令 —— 假实现必须用**同一份状态**
 * 跨连接保持计数，否则第二轮会从头开始。
 */
function startFakeCeServer(handlers) {
  const state = { requests: [], sockets: [], nextSnapHandle: 100 };

  const server = net.createServer((socket) => {
    state.sockets.push(socket);
    let acc = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      if (acc.length < 1) return;
      const command = acc[0];
      const payload = acc.subarray(1);
      acc = Buffer.alloc(0);
      state.requests.push({ command, payload });

      const handler = handlers[command];
      if (!handler) {
        socket.destroy();
        return;
      }
      const response = handler(payload, state);
      if (response) socket.write(response);
      socket.end();
    });
    socket.on('error', () => { /* 忽略 */ });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        close: () =>
          new Promise((r) => {
            for (const s of state.sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

function i32(v) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v, 0);
  return b;
}

/** 组 CMD_GETVERSION 响应：int32 version + uint8 size + string */
function versionResponse(text) {
  const str = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(5);
  head.writeInt32LE(6, 0);
  head.writeUInt8(str.length, 4);
  return Buffer.concat([head, str]);
}

test('NativeCeBackend：CMD_GETVERSION 解析正确且结果被缓存', async () => {
  const fake = await startFakeCeServer({
    [CESERVER_CMD.GETVERSION]: () => versionResponse('CHEATENGINE 7.5'),
  });
  try {
    const b = new NativeCeBackend({ host: '127.0.0.1', port: fake.port });
    assert.equal(await b.getVersion(), 'CHEATENGINE 7.5');
    // 第一轮读 5 字节头，第二轮读全
    assert.equal(fake.state.requests.length, 2);
    assert.ok(fake.state.requests.every((r) => r.command === CESERVER_CMD.GETVERSION));

    // 缓存：再取不应新增请求
    assert.equal(await b.getVersion(), 'CHEATENGINE 7.5');
    assert.equal(fake.state.requests.length, 2, '版本应被缓存');
    await b.dispose();
  } finally {
    await fake.close();
  }
});

test('NativeCeBackend：CMD_OPENPROCESS 组帧与失败处理', async () => {
  const fake = await startFakeCeServer({
    [CESERVER_CMD.OPENPROCESS]: (payload) => {
      const pid = payload.readInt32LE(0);
      // 偶数 pid 返回句柄，奇数返回 0（模拟失败）
      return i32(pid % 2 === 0 ? 42 : 0);
    },
  });
  try {
    const b = new NativeCeBackend({ host: '127.0.0.1', port: fake.port });

    const h = await b.openProcess(1000);
    assert.equal(h.pid, 1000);
    assert.equal(fake.state.requests[0].command, CESERVER_CMD.OPENPROCESS);
    assert.equal(fake.state.requests[0].payload.readInt32LE(0), 1000, 'payload 应是 pid');

    await assert.rejects(() => b.openProcess(1001), /无法打开进程 1001/);
    await b.dispose();
  } finally {
    await fake.close();
  }
});

test('NativeCeBackend：CMD_VIRTUALQUERYEX 循环读取区域并按末尾推进', async () => {
  const regions = [
    { protection: 0x04, type: 0x20000, base: 0x10000n, size: 0x1000n },
    { protection: 0x20, type: 0x1000000, base: 0x20000n, size: 0x2000n },
    { protection: 0x02, type: 0x40000, base: 0x30000n, size: 0x500n },
  ];
  let call = 0;
  const fake = await startFakeCeServer({
    [CESERVER_CMD.OPENPROCESS]: () => i32(7),
    [CESERVER_CMD.VIRTUALQUERYEX]: (payload) => {
      const requested = payload.readBigUInt64LE(4);
      if (call >= regions.length) {
        // 结束标记：客户端固定读 25 字节，所以必须补齐整个结构体，
        // 只把 result 置 0（真实 ceserver 也是这么写的）。
        // 只回 1 字节会触发客户端的"提前关闭连接"错误。
        const end = Buffer.alloc(25);
        end.writeUInt8(0, 0);
        return end;
      }
      const expected =
        call === 0 ? 0n : regions[call - 1].base + regions[call - 1].size;
      assert.equal(requested, expected, '客户端应从上一次区域末尾继续查询');
      const r = regions[call++];
      const out = Buffer.alloc(25);
      out.writeUInt8(1, 0);
      out.writeUInt32LE(r.protection, 1);
      out.writeUInt32LE(r.type, 5);
      out.writeBigUInt64LE(r.base, 9);
      out.writeBigUInt64LE(r.size, 17);
      return out;
    },
  });
  try {
    const b = new NativeCeBackend({ host: '127.0.0.1', port: fake.port });
    const h = await b.openProcess(1000);
    const got = await b.queryRegions(h, {
      includeFree: true,
      includeImage: true,
      includeMapped: true,
      includePrivate: true,
    });
    assert.equal(got.length, 3);
    assert.equal(got[0].baseAddress, 0x10000n);
    assert.equal(got[0].regionSize, 0x1000n);
    assert.equal(got[0].protect, 0x04);
    assert.equal(got[0].state, 0x1000, 'ceserver 只回报已映射区域，状态视为已提交');
    assert.equal(got[1].baseAddress, 0x20000n);
    assert.equal(got[2].regionSize, 0x500n);
    assert.equal(call, 3);
    await b.dispose();
  } finally {
    await fake.close();
  }
});

test('NativeCeBackend：CMD_READPROCESSMEMORY 按 read 计数分两轮读数据', async () => {
  const fake = await startFakeCeServer({
    [CESERVER_CMD.OPENPROCESS]: () => i32(9),
    [CESERVER_CMD.READPROCESSMEMORY]: (payload, state) => {
      const handle = payload.readUInt32LE(0);
      const address = payload.readBigUInt64LE(4);
      const size = payload.readUInt32LE(12);
      const compress = payload.readUInt8(16);
      assert.equal(handle, 9);
      assert.equal(address, 0xdeadbeefn);
      assert.equal(size, 8);
      assert.equal(compress, 0, '客户端应使用 compress=0，避免依赖解压');

      const data = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
      // 客户端会连两次：第一次只要 4 字节头，第二次要 4+8
      const attempt = state.requests.filter(
        (r) => r.command === CESERVER_CMD.READPROCESSMEMORY,
      ).length;
      const out = attempt <= 1 ? i32(data.length) : Buffer.concat([i32(data.length), data]);
      return out;
    },
  });
  try {
    const b = new NativeCeBackend({ host: '127.0.0.1', port: fake.port });
    const h = await b.openProcess(1000);
    const buf = await b.readProcessMemory(h, 0xdeadbeefn, 8);
    assert.deepEqual([...buf], [1, 2, 3, 4, 5, 6, 7, 8]);
    await b.dispose();
  } finally {
    await fake.close();
  }
});

test('NativeCeBackend：read=0 时返回空 Buffer（不报错）', async () => {
  const fake = await startFakeCeServer({
    [CESERVER_CMD.OPENPROCESS]: () => i32(4),
    [CESERVER_CMD.READPROCESSMEMORY]: () => i32(0),
  });
  try {
    const b = new NativeCeBackend({ host: '127.0.0.1', port: fake.port });
    const h = await b.openProcess(1000);
    const buf = await b.readProcessMemory(h, 0x1000n, 16);
    assert.equal(buf.length, 0);
    await b.dispose();
  } finally {
    await fake.close();
  }
});

test('NativeCeBackend：CMD_WRITEPROCESSMEMORY 组帧含数据尾部', async () => {
  const fake = await startFakeCeServer({
    [CESERVER_CMD.OPENPROCESS]: () => i32(11),
    [CESERVER_CMD.CHANGEMEMORYPROTECTION]: () => {
      const o = Buffer.alloc(25);
      o.writeUInt8(1, 0);
      o.writeUInt32LE(0x04, 1);
      return o;
    },
    [CESERVER_CMD.WRITEPROCESSMEMORY]: (payload) => {
      const handle = payload.readInt32LE(0);
      const address = payload.readBigInt64LE(4);
      const size = payload.readInt32LE(12);
      const data = payload.subarray(16, 16 + size);
      assert.equal(handle, 11);
      assert.equal(address, 0x1234n);
      assert.equal(size, 4);
      assert.deepEqual([...data], [0xaa, 0xbb, 0xcc, 0xdd]);
      return i32(size);
    },
  });
  try {
    const b = new NativeCeBackend({ host: '127.0.0.1', port: fake.port });
    const h = await b.openProcess(1000);
    const n = await b.writeProcessMemory(h, 0x1234n, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]));
    assert.equal(n, 4);
    await b.dispose();
  } finally {
    await fake.close();
  }
});

test('NativeCeBackend：写入不完整必须报错（不能静默）', async () => {
  const fake = await startFakeCeServer({
    [CESERVER_CMD.OPENPROCESS]: () => i32(3),
    [CESERVER_CMD.CHANGEMEMORYPROTECTION]: () => {
      const o = Buffer.alloc(25);
      o.writeUInt8(1, 0);
      return o;
    },
    // 只写 2 字节，但请求是 4
    [CESERVER_CMD.WRITEPROCESSMEMORY]: () => i32(2),
  });
  try {
    const b = new NativeCeBackend({ host: '127.0.0.1', port: fake.port });
    const h = await b.openProcess(1000);
    await assert.rejects(
      () => b.writeProcessMemory(h, 0x1000n, Buffer.from([1, 2, 3, 4])),
      /写入不完整/,
    );
    await b.dispose();
  } finally {
    await fake.close();
  }
});

test('NativeCeBackend：CMD_MODULE32NEXT 枚举模块', async () => {
  const fake = await startFakeCeServer({
    [CESERVER_CMD.OPENPROCESS]: () => i32(6),
    [CESERVER_CMD.CREATETOOLHELP32SNAPSHOT]: () => i32(5),
    [CESERVER_CMD.MODULE32NEXT]: (payload, state) => {
      const attempt = state.requests.filter(
        (r) => r.command === CESERVER_CMD.MODULE32NEXT,
      ).length;
      // 每个模块两轮连接：第 1 轮只读 28 字节头，第 2 轮读 28+nameLen。
      // 第 3 个模块时把 result 置 0 表示枚举结束（仍需写满 28 字节头）。
      if (attempt >= 5) {
        const end = Buffer.alloc(28);
        end.writeInt32LE(0, 0);
        return end;
      }
      const name = Buffer.from('kernel32.dll\0', 'utf8');
      const head = Buffer.alloc(28);
      head.writeInt32LE(1, 0); // result
      head.writeBigInt64LE(attempt <= 2 ? 0x7ff000001000n : 0x7ff100002000n, 4);
      head.writeInt32LE(1, 12); // modulepart
      head.writeInt32LE(0x100000, 16); // modulesize
      head.writeUInt32LE(0, 20); // modulefileoffset
      head.writeInt32LE(name.length, 24); // modulenamesize
      return attempt % 2 === 1 ? head : Buffer.concat([head, name]);
    },
  });
  try {
    const b = new NativeCeBackend({ host: '127.0.0.1', port: fake.port });
    const h = await b.openProcess(1000);
    const mods = await b.queryModules(h);
    assert.equal(mods.length, 2);
    assert.equal(mods[0].name, 'kernel32.dll');
    assert.equal(mods[0].baseAddress, 0x7ff000001000n);
    assert.equal(mods[0].size, 0x100000);
    assert.equal(mods[0].path, 'kernel32.dll', 'ceserver 不回报路径，用名字代替');
    await b.dispose();
  } finally {
    await fake.close();
  }
});

/**
 * `listProcesses` 的 `parentPid` / `threadCount` **必须如实为 `null`（未知）**，不能是 `0`。
 *
 * ## 为什么这条必须钉
 *
 * ceserver 的 `PROCESS32NEXT` 响应结构（`ceserver.h`）是
 * `{ int result; int pid; int processnamesize; char name[] }` ——
 * **协议里没有**父进程 pid 与线程数。早先它们被硬编码成 `0`，后果是：
 *   · `ce_processes` 在 native-ce 后端下对**每个进程**都显示「线程 0」——
 *     一个**看起来像真值的假值**；
 *   · 而同一个工具在 self 后端下给的是**真实线程数** —— 两个后端语义不一致，
 *     调用方从返回值上完全分辨不出来，据此做判断就会得出错误结论。
 *
 * 现在如实报 `null`（"本后端不提供"），由上层决定怎么展示。
 * `null` 与 `0` 的差别正是这条测试的全部意义，所以两边都要断言。
 */
test('NativeCeBackend：processes 的 parentPid/threadCount 如实为 null，绝不是 0', async () => {
  // 计数器按**快照句柄**分开存，而不是全局累加：本用例会枚举两次
  // （后端层一次、高层映射一次），全局累加会让第二次直接"枚举已结束"返回 0 个。
  const fake = await startFakeCeServer({
    [CESERVER_CMD.CREATETOOLHELP32SNAPSHOT]: (payload, state) => {
      state.procCall = state.procCall ?? new Map();
      const handle = 100 + state.procCall.size;
      state.procCall.set(handle, 0);
      return i32(handle);
    },
    [CESERVER_CMD.PROCESS32NEXT]: (payload, state) => {
      const handle = payload.readInt32LE(0);
      state.procCall = state.procCall ?? new Map();
      const callIndex = state.procCall.get(handle) ?? 0;
      state.procCall.set(handle, callIndex + 1);

      // 每个进程两轮连接：第 1 轮只读 12 字节头，第 2 轮读 12+nameLen。
      // 第 3 个进程时把 result 置 0 表示枚举结束（仍需写满 12 字节头）。
      if (callIndex >= 4) {
        const end = Buffer.alloc(12);
        end.writeInt32LE(0, 0);
        return end;
      }
      const entryIndex = Math.floor(callIndex / 2);
      const isHead = callIndex % 2 === 0;
      const name = Buffer.from(`proc${entryIndex}.exe\0`, 'utf8');
      const head = Buffer.alloc(12);
      head.writeInt32LE(1, 0); // result
      head.writeInt32LE(1000 + entryIndex, 4); // pid
      head.writeInt32LE(name.length, 8); // processnamesize
      return isHead ? head : Buffer.concat([head, name]);
    },
  });
  try {
    const b = new NativeCeBackend({ host: '127.0.0.1', port: fake.port });
    const list = await b.listProcesses();
    assert.equal(list.length, 2, '应当枚举到两个进程');
    assert.equal(list[0].pid, 1000);
    assert.equal(list[0].name, 'proc0.exe', '名字末尾的 \\0 必须剥掉');

    for (const entry of list) {
      assert.equal(
        entry.threadCount,
        null,
        `ceserver 协议不提供线程数，必须是 null —— 曾经是 0（看起来像真值的假值）。实际 ${JSON.stringify(entry)}`,
      );
      assert.equal(
        entry.parentPid,
        null,
        `ceserver 协议不提供父进程 pid，必须是 null。实际 ${JSON.stringify(entry)}`,
      );
      assert.notEqual(entry.threadCount, 0, '绝不能退化成 0');
      assert.notEqual(entry.parentPid, 0, '绝不能退化成 0');
    }

    // 高层映射也必须原样保留 null（否则后端改了、工具层又填回 0 就白改了）
    const mapped = await listProcessesAsync(b);
    assert.equal(mapped.length, 2);
    assert.equal(mapped[0].threadCount, null, 'listProcessesAsync 必须保留 null');
    assert.equal(mapped[0].parentPid, null, 'listProcessesAsync 必须保留 null');

    await b.dispose();
  } finally {
    await fake.close();
  }
});

test('NativeCeBackend：连接失败时错误信息可操作', async () => {
  // 先占一个端口再立刻关掉，得到一个几乎不可能有服务端监听的端口
  const probe = net.createServer();
  const port = await new Promise((r) => probe.listen(0, '127.0.0.1', () => r(probe.address().port)));
  await new Promise((r) => probe.close(() => r()));

  const b = new NativeCeBackend({ host: '127.0.0.1', port, timeoutMs: 3000 });
  await assert.rejects(
    () => b.listProcesses(),
    (e) => {
      assert.match(e.message, /无法连接 ceserver|连接 ceserver 超时/);
      assert.match(e.message, /ceserver/, '错误信息要指向 ceserver');
      return true;
    },
  );
  await b.dispose();
});

test('NativeCeBackend：能力声明诚实（未实现的能力要抛错而不是假装支持）', async () => {
  const b = new NativeCeBackend({ host: '127.0.0.1', port: 1 });
  assert.equal(b.capabilities.requiresServer, true);
  assert.equal(b.capabilities.local, false);
  assert.equal(b.capabilities.queryThreads, false, '线程枚举未实现，能力声明必须是 false');

  assert.throws(() => b.queryThreads(), /未实现线程枚举/);
  assert.equal(b.isWow64(), false, '无法判断时返回 false，不猜测');
  assert.match(b.describe(), /NativeCeBackend\(127\.0\.0\.1:1\)/);
  await b.dispose();
});

test('NativeCeBackend：默认端口是 CE 官方 ceserver 的 52736', async () => {
  assert.equal(CESERVER_DEFAULT_PORT, 52736);
  const b = new NativeCeBackend();
  assert.match(b.describe(), /:52736\)/);
  await b.dispose();
});

test('BackendUnsupportedError 可被识别', async () => {
  const e = new BackendUnsupportedError('native-ce', '枚举线程', '协议布局不稳定');
  assert.equal(e.name, 'BackendUnsupportedError');
  assert.match(e.message, /native-ce/);
  assert.match(e.message, /枚举线程/);
  assert.match(e.message, /协议布局不稳定/);
});
