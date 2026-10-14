/**
 * DBK 内核驱动后端的测试。
 *
 * ## 能测什么、不能测什么（诚实划分）
 *
 * 本机**没有加载内核驱动**（加载需要管理员权限），所以 `\\.\CEDRIVER73` 打不开，
 * 真正走驱动的读写**无法端到端验证**。因此这里测的是**协议实现的正确性**：
 *
 *   1. **ioctl 码必须与 CE 源码算出来的一致** —— 这是最容易错且后果最严重的地方
 *      （码错了驱动会返回 STATUS_INVALID_DEVICE_REQUEST，而且很难看出原因）。
 *      期望值是从 `DBK32functions.pas` 的编码宏手算的，写死在断言里当基准。
 *   2. **输入结构必须是 packed 布局**（18 字节、字段偏移精确）——
 *      若按自然对齐会变成 24 字节，驱动读到的偏移就全错了。
 *   3. **设备名解析**要能处理 driver.dat 覆盖与默认值。
 *   4. **设备不可用时必须明确报错**，不能静默回退到用户态
 *      （那会让人误以为已经绕过了进程保护）。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DBK_IOCTL,
  DBK_READ_INPUT_SIZE,
  DBK_WRITE_INPUT_SIZE,
  DBK_WRITE_BUFFER_SIZE,
  DBK_MAX_WRITE_PAYLOAD,
  DBK_ALLOC_INPUT_SIZE,
  packAllocInput,
  readAllocResult,
  DEFAULT_DBK_SERVICE_NAME,
  DbkBackend,
  DbkDeviceError,
  packReadInput,
  packWriteBuffer,
  readServiceNameFromDriverDat,
  resolveDevicePath,
} = require('../dist/cjs/backend/dbk-backend');

/* ================================================================== *
 * 1. ioctl 码（最重要的基准）
 * ================================================================== */

test('ioctl 码与 CE 源码的编码宏一致（手算基准）', () => {
  // CE 的宏：  (DeviceType << 16) | (Function << 2) | Method | (Access << 14)
  // DeviceType = FILE_DEVICE_UNKNOWN = 0x22  →  0x22 << 16 = 0x00220000
  // Access     = FILE_RW_ACCESS = 3          →  3 << 14      = 0x0000C000
  // Method     = METHOD_BUFFERED = 0
  const base = 0x00220000 | 0x0000c000;

  assert.equal(DBK_IOCTL.READ_MEMORY, base | (0x0800 << 2), 'READ_MEMORY 功能号 0x0800');
  assert.equal(DBK_IOCTL.WRITE_MEMORY, base | (0x0801 << 2), 'WRITE_MEMORY 功能号 0x0801');
  assert.equal(DBK_IOCTL.OPEN_PROCESS, base | (0x0802 << 2), 'OPEN_PROCESS 功能号 0x0802');
  assert.equal(DBK_IOCTL.QUERY_VIRTUAL_MEMORY, base | (0x0803 << 2));
  assert.equal(DBK_IOCTL.GET_VERSION, base | (0x0816 << 2));
  assert.equal(DBK_IOCTL.MAKE_WRITABLE, base | (0x0819 << 2));
  assert.equal(DBK_IOCTL.ALLOCATE_MEM, base | (0x081f << 2));
  assert.equal(DBK_IOCTL.SUSPEND_PROCESS, base | (0x0824 << 2));
  assert.equal(DBK_IOCTL.RESUME_PROCESS, base | (0x0825 << 2));
});

test('ioctl 码的具体数值（防常量漂移）', () => {
  // 具体数值必须写死 —— 这处极易算错，而在真机上 ioctl 码错了
  // 只表现为「驱动返回无效请求」，几乎无法从现象反推原因。
  //
  // 逐项代入 CE 源码那行（**不要**把三段重新拼成 0x22C000 之类的"整齐"值，
  // 因为 `0x22 << 16` 会占用 bit 17/21，与 func 字段（bit 11–13）以外的高位区域叠加）：
  //   IOCTL_UNKNOWN_BASE = FILE_DEVICE_UNKNOWN = 0x22
  //   0x22 << 16     = 0x220000
  //   0x0800 << 2    = 0x002000   → 前两项 OR 得 0x222000
  //   3 << 14        = 0x00C000
  //   0x222000 | 0xC000 = 0x22E000
  //
  // 这一步我算错过两次（先误以为结果该是 0x22C000，又误以为 `0x22<<16` 与
  // `0x800<<2` 不重叠），所以下面用**逐项累加**的方式再自检一遍。
  let acc = 0;
  acc = (acc | (0x22 << 16)) >>> 0;
  assert.equal(acc, 0x220000, '第一步：deviceType << 16');
  acc = (acc | (0x0800 << 2)) >>> 0;
  assert.equal(acc, 0x222000, '第二步：0x220000 | 0x2000 = 0x222000（注意不是 0x22C000）');
  acc = (acc | 0) >>> 0;
  acc = (acc | (3 << 14)) >>> 0;
  assert.equal(acc, 0x22e000, '第三步：| 0xC000 得 0x22E000');

  assert.equal(DBK_IOCTL.READ_MEMORY, 0x22e000, '读内存 ioctl 应为 0x22E000');
  assert.equal(DBK_IOCTL.WRITE_MEMORY, 0x22e004, '写内存 ioctl 应为 0x22E004');
  assert.equal(DBK_IOCTL.OPEN_PROCESS, 0x22e008, 'OPENPROCESS 应为 0x22E008');
  assert.equal(DBK_IOCTL.GET_VERSION, 0x22e058, 'GETVERSION 应为 0x22E058（功能号 0x16）');
  assert.equal(DBK_IOCTL.SUSPEND_PROCESS, 0x22e090, 'SUSPENDPROCESS 应为 0x22E090（功能号 0x24）');

  // 所有码都必须落在 0x22xxxx 段（DeviceType=0x22），且步长是 4
  for (const [name, code] of Object.entries(DBK_IOCTL)) {
    assert.equal(code >>> 16, 0x22, `${name} 的 DeviceType 应为 0x22`);
    assert.equal(code & 0x3, 0, `${name} 应为 4 字节对齐（功能号 << 2）`);
  }
});

/* ================================================================== *
 * 2. packed 结构布局
 * ================================================================== */

test('读内存输入结构是 packed 的 18 字节，字段偏移精确', () => {
  assert.equal(DBK_READ_INPUT_SIZE, 18, 'packed record 应为 8+8+2=18 字节（不是 24）');

  const pid = 0x1234;
  const addr = 0x7ff000001234n;
  const size = 0x1234;
  const buf = packReadInput(pid, addr, size);

  assert.equal(buf.length, 18);
  assert.equal(buf.readBigUInt64LE(0), BigInt(pid), 'processid 在偏移 0（uint64）');
  assert.equal(buf.readBigUInt64LE(8), addr, 'startaddress 在偏移 8（uint64）');
  assert.equal(buf.readUInt16LE(16), size, 'bytestoread 在偏移 16（word）');
  // 确认没有多余的填充字节（若按自然对齐，偏移 16 的 word 后面应有 6 字节 padding）
});

test('读内存输入结构能装下 64 位地址（不丢精度）', () => {
  const addr = 0x7fffffffffffn; // x64 用户态上限
  const buf = packReadInput(1, addr, 1);
  assert.equal(buf.readBigUInt64LE(8), addr);
});

test('bytestoread 超出 word 范围时按 16 位截断（与 CE 的 word 类型一致）', () => {
  const buf = packReadInput(1, 0x1000n, 0x10000);
  assert.equal(buf.readUInt16LE(16), 0, '0x10000 按 word 截断成 0');
});

test('写内存缓冲是 512 字节，头部 18 字节 + 数据紧跟其后', () => {
  assert.equal(DBK_WRITE_BUFFER_SIZE, 512, 'CE 源码里写死 512');
  assert.equal(DBK_WRITE_INPUT_SIZE, 18);
  assert.equal(DBK_MAX_WRITE_PAYLOAD, 494, '单次最多 512-18=494 字节');

  const pid = 0x4321;
  const addr = 0x7ff000005000n;
  const data = Buffer.from('deadbeef', 'hex');
  const buf = packWriteBuffer(pid, addr, data);

  assert.equal(buf.length, 512);
  assert.equal(buf.readBigUInt64LE(0), BigInt(pid), 'processid 偏移 0');
  assert.equal(buf.readBigUInt64LE(8), addr, 'startaddress 偏移 8');
  assert.equal(buf.readUInt16LE(16), data.length, 'bytestowrite 偏移 16');
  assert.equal(buf.subarray(18, 22).toString('hex'), 'deadbeef', '数据从偏移 18 开始');
  // 头部与数据之间的区域填充任意值都不影响驱动，但数据之后应当是 0（CE 会 zeromemory）
  assert.ok(buf.subarray(22).every((b) => b === 0), '数据之后应清零（CE 的做法）');
});

test('写内存超过 494 字节时明确报错（要求调用方分块）', () => {
  assert.throws(
    () => packWriteBuffer(1, 0x1000n, Buffer.alloc(495)),
    /超过驱动上限 494/,
  );
  // 边界：正好 494 应当可以
  assert.equal(packWriteBuffer(1, 0x1000n, Buffer.alloc(494)).length, 512);
});

/* ================================================================== *
 * 3. 设备名解析
 * ================================================================== */

test('设备名默认值是 CEDRIVER73（CE 源码的出厂值）', () => {
  assert.equal(DEFAULT_DBK_SERVICE_NAME, 'CEDRIVER73');
  assert.equal(resolveDevicePath({}), '\\\\.\\CEDRIVER73');
});

test('设备名：显式服务名优先，且自动补 \\\\.\\ 前缀', () => {
  assert.equal(resolveDevicePath({ serviceName: 'DBK64' }), '\\\\.\\DBK64');
  assert.equal(resolveDevicePath({ serviceName: '\\\\.\\DBK64' }), '\\\\.\\DBK64', '已带前缀不应重复补');
  assert.equal(resolveDevicePath({ serviceName: '  MYDRV  ' }), '\\\\.\\MYDRV');
  // 显式值优先于 driver.dat
  assert.equal(
    resolveDevicePath({ serviceName: 'EXPLICIT', cheatEngineDir: os.tmpdir() }),
    '\\\\.\\EXPLICIT',
  );
});

test('设备名：能读 driver.dat 的第一行作为服务名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbk-test-'));
  try {
    // CE 的 driver.dat 格式：第 1 行是服务名，后面还有若干行
    fs.writeFileSync(
      path.join(dir, 'driver.dat'),
      ['RANDOMNAME123', 'DBKProcList60', 'DBKThreadList60', 'dbk64.sys', '76543210'].join('\r\n'),
    );
    assert.equal(readServiceNameFromDriverDat(dir), 'RANDOMNAME123');
    assert.equal(resolveDevicePath({ cheatEngineDir: dir }), '\\\\.\\RANDOMNAME123');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('设备名：driver.dat 不存在/为空时安全回退', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbk-test2-'));
  try {
    assert.equal(readServiceNameFromDriverDat(dir), null, '目录里没有 driver.dat');
    assert.equal(readServiceNameFromDriverDat(undefined), null, '不给目录');
    assert.equal(readServiceNameFromDriverDat(''), null, '空目录');

    // 空文件
    fs.writeFileSync(path.join(dir, 'driver.dat'), '\r\nrest\r\n');
    assert.equal(readServiceNameFromDriverDat(dir), null, '第一行为空应视为读不到');
    assert.equal(resolveDevicePath({ cheatEngineDir: dir }), '\\\\.\\CEDRIVER73', '应回退到默认值');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('设备名：driver64.dat 作为次选（CE 在 wow64 下用这个）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbk-test3-'));
  try {
    fs.writeFileSync(path.join(dir, 'driver64.dat'), 'FROM64\r\nx\r\ny\r\nz\r\n');
    assert.equal(readServiceNameFromDriverDat(dir), 'FROM64');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * 3b. 分配内存的输入结构
 * ================================================================== */

test('分配内存输入结构是 40 字节（5 个 uint64），字段偏移精确', () => {
  assert.equal(DBK_ALLOC_INPUT_SIZE, 40, '5 × uint64 = 40 字节');

  const pid = 0x1234;
  const base = 0x10000000n;
  const size = 0x2000n;
  const allocType = 0x3000n; // MEM_COMMIT | MEM_RESERVE
  const protect = 0x40n; // PAGE_EXECUTE_READWRITE

  const buf = packAllocInput(pid, base, size, allocType, protect);
  assert.equal(buf.length, 40);
  assert.equal(buf.readBigUInt64LE(0), BigInt(pid), 'processid 偏移 0');
  assert.equal(buf.readBigUInt64LE(8), base, 'baseaddress 偏移 8');
  assert.equal(buf.readBigUInt64LE(16), size, 'size 偏移 16');
  assert.equal(buf.readBigUInt64LE(24), allocType, 'AllocationType 偏移 24');
  assert.equal(buf.readBigUInt64LE(32), protect, 'Protect 偏移 32');
});

test('分配结果从缓冲偏移 0 读回（驱动把结果写回 SystemBuffer 前 8 字节）', () => {
  // 模拟驱动写回：整个前 8 字节被替换成分配到的地址
  const buf = Buffer.alloc(DBK_ALLOC_INPUT_SIZE);
  const allocated = 0x7ff000123000n;
  buf.writeBigUInt64LE(allocated, 0);
  assert.equal(readAllocResult(buf), allocated, '应能从偏移 0 读出地址');

  // 缓冲过短必须明确报错，而不是读出垃圾
  assert.throws(() => readAllocResult(Buffer.alloc(4)), /读不出 8 字节地址/);
});

test('allocate 在设备打不开时明确报错（不会静默返回 0）', () => {
  const backend = new DbkBackend({ serviceName: 'CEDRIVER73' });
  const fakeHandle = { id: 1, pid: 1234 };
  // 本机没驱动 → 应当抛 DbkDeviceError，而不是返回 0n 让人以为分配成功
  assert.throws(
    () => backend.allocate(fakeHandle, 4096),
    (e) => {
      assert.ok(
        e.name === 'DbkDeviceError' || /打不开内核驱动设备/.test(e.message),
        `应为设备错误，实际 ${e.name}: ${e.message}`,
      );
      return true;
    },
  );
  backend.dispose();
});

test('allocate 的大小为 0 时直接拒绝（参数校验先于设备访问）', () => {
  const backend = new DbkBackend({ serviceName: 'CEDRIVER73' });
  const fakeHandle = { id: 1, pid: 1234 };
  // size <= 0 必须在 openDevice 之前就抛 RangeError，
  // 否则在没有驱动的机器上会被误报成「设备打不开」
  assert.throws(() => backend.allocate(fakeHandle, 0), RangeError);
  assert.throws(() => backend.allocate(fakeHandle, -1), RangeError);
  backend.dispose();
});

test('能力声明：allocate 与 changeProtection 都声明支持（方式不同）', () => {
  const backend = new DbkBackend({});
  assert.equal(backend.capabilities.allocateMemory, true, 'allocate 走驱动 IOCTL_CE_ALLOCATEMEM');
  assert.equal(backend.capabilities.changeProtection, true, 'changeProtection 走用户态 VirtualProtectEx');
  assert.equal(backend.capabilities.suspendThreads, false, '未实现就不能声称支持');
  assert.equal(backend.capabilities.queryRegions, true, '区域枚举走用户态，可用');
  backend.dispose();
});

test('changeProtection 委托用户态（驱动侧的 MAKEWRITABLE 在 x64 上是空的）', () => {
  const backend = new DbkBackend({ serviceName: 'CEDRIVER73' });
  // 用一个无效句柄调用，应当走到 SelfBackend 的路径并抛错 ——
  // 关键是**抛的不是 BackendUnsupportedError**（说明真的委托出去了）
  assert.throws(
    () => backend.changeProtection({ id: 0, pid: 1 }, 0x1000n, 4, 0x40),
    (e) => {
      assert.notEqual(e.name, 'BackendUnsupportedError', '不应该再报"不支持"');
      return true;
    },
  );
  backend.dispose();
});

test('free 委托用户态（驱动没有释放目标进程内存的 ioctl）', () => {
  const backend = new DbkBackend({ serviceName: 'CEDRIVER73' });
  assert.throws(
    () => backend.free({ id: 0, pid: 1 }, 0x1000n),
    (e) => {
      assert.notEqual(e.name, 'BackendUnsupportedError', '不应该再报"不支持"');
      return true;
    },
  );
  backend.dispose();
});

/* ================================================================== *
 * 4. 设备不可用时的行为（本机真实情况）
 * ================================================================== */

test('驱动未加载时打开设备必须明确报错，且不改动任何东西', () => {
  const backend = new DbkBackend({ serviceName: 'CEDRIVER73' });
  assert.equal(backend.isDeviceOpen, false, '构造后不应自动打开设备');

  // 本机没加载驱动，所以这里应当抛 DbkDeviceError
  let error = null;
  try {
    backend.openDevice();
  } catch (e) {
    error = e;
  }
  if (error === null) {
    // 万一机器上真加载了驱动，也要能正常打开 —— 那就不该报错
    assert.equal(backend.isDeviceOpen, true);
    backend.dispose();
    return;
  }
  assert.ok(error instanceof DbkDeviceError, `应为 DbkDeviceError，实际 ${error.name}`);
  assert.equal(error.devicePath, '\\\\.\\CEDRIVER73');
  // 错误信息必须给出可执行的下一步，而不是只说"失败"
  assert.match(error.message, /ce_kernel/, '应指向 ce_kernel 工具');
  assert.match(error.message, /install|load/, '应说明要先装并加载驱动');
  assert.match(error.message, /driver\.dat|CEDRIVER73/, '应说明服务名可能不同');
  backend.dispose();
});

test('probe() 给出结构化结论而不是抛错（供工具输出）', () => {
  const backend = new DbkBackend({});
  const result = backend.probe();
  assert.equal(typeof result.devicePath, 'string');
  assert.equal(typeof result.opened, 'boolean');
  if (result.opened) {
    assert.equal(result.error, null);
  } else {
    assert.equal(result.version, null);
    assert.ok(result.error !== null && result.error.length > 0, '打不开时必须给出原因');
  }
  backend.dispose();
});

test('未实现的操作用 BackendUnsupportedError 明确报错（不静默降级）', () => {
  // 说明：allocate / changeProtection / free 现在已经实现（见上面的用例），
  // 所以这里只断言**仍然不支持**的那个：挂起线程
  // （驱动有 SUSPENDTHREAD ioctl 但本后端未实现，能力声明里也是 false）。
  const backend = new DbkBackend({});
  assert.equal(backend.capabilities.suspendThreads, false, '未实现就不能声称支持');
  // 未实现的能力不暴露方法 → 调用会是 TypeError，而不是静默什么都不做
  assert.equal(typeof backend.suspendAllThreads, 'undefined');
  backend.dispose();
});

test('能力声明：同步后端（扫描/指针/AA 需要），分配与改保护都可用', () => {
  const backend = new DbkBackend({});
  assert.equal(backend.capabilities.sync, true, '驱动 ioctl 是同步调用，必须是同步后端');
  assert.equal(backend.capabilities.local, true);
  assert.equal(backend.capabilities.requiresServer, false);
  assert.equal(backend.capabilities.allocateMemory, true, 'allocate 走驱动 IOCTL_CE_ALLOCATEMEM');
  assert.equal(backend.capabilities.changeProtection, true, 'changeProtection 走用户态 VirtualProtectEx');
  assert.equal(backend.name, 'dbk');
  backend.dispose();
});

test('注入句柄时 isDeviceOpen 为 true（测试可注入，不真开设备）', () => {
  const fake = { fake: true };
  const backend = new DbkBackend({ deviceHandle: fake });
  assert.equal(backend.isDeviceOpen, true);
  backend.dispose();
  assert.equal(backend.isDeviceOpen, false, 'dispose 应关掉设备');
});
