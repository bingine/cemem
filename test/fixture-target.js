/**
 * 测试夹具：一个持有"可预测内存"的目标进程（纯 JavaScript）。
 *
 * 用途：让扫描器在**真实跨进程**条件下被验证，而不是只跑内存内的单元测试。
 * 与 CE 自带的 Tutorial 目标进程思路一致。
 *
 * stdout 首行输出一行 JSON：{"ready":true,"pid":..,"base":"0x..","values":{..},"offsets":{..}}
 * stdin 指令：
 *   mutate          把已知变量按固定规则变动，用于验证 next scan
 *   write <addr> <hex>  直接改内存
 *   quit            退出
 */

'use strict';

const { createInterface } = require('node:readline');
const koffi = require('koffi');

const L = {
  health: 0x0000,
  ammo: 0x0004,
  position: 0x0008,
  money: 0x0010,
  bigCounter: 0x0018,
  targetValue: 0x0020,
  pointerToTarget: 0x0028,
  nameString: 0x0040,
  wideString: 0x0060,
  aobSignature: 0x0080,
  /**
   * **唯一** AOB 标记：专供 `AOBScanUnique` / `AOBScanModuleUnique` 之类的"唯一命中"语义测试。
   *
   * 为什么不复用 `aobSignature`：那段特征（`DE AD BE EF 90 90 ?? 7*`）**并不唯一** ——
   * 实测在进程里能命中 2 处（另一处出现在别的模块中）。
   * 于是 `AOBScanUnique` 返回哪一处取决于扫描顺序，测试**偶发失败**；
   * 而失败信息只说 "aobSignature"，完全看不出是"特征不唯一"导致的。
   *
   * 长度取 **16 字节**（128 位），由下面的确定性序列生成（不用随机数，保证可复现）：
   * 短特征在这个进程里被巧合打破过一次（7 字节时仍能命中 2 处），
   * 16 字节的空间是 2^128，巧合重复在物理上不可能。
   *
   * 位置选 0x0088：紧接在 `aobSignature`(0x0080，8 字节) 之后。
   * ⚠️ 它占 16 字节（0x0088–0x0097），所以 `signedValue` 从原来的 0x0090 后移到 0x00a0。
   *    调这个偏移时必须同步检查后面几个字段别被覆盖。
   */
  uniqueAob: 0x0088,
  signedValue: 0x00a0,
  byteFlag: 0x00a2,
  fillerStart: 0x0100,
  fillerCount: 512,
  // 指针链：chainA -> chainB -> targetValue，用于验证指针扫描
  chainA: 0x0200,
  chainB: 0x0208,
  /**
   * 非零偏移指针：用于回归"指针扫描的 maxOffset 必须真正生效"。
   *
   * 原来的指针链 offset 全是 0（chainA→chainB→target 都直接指向），
   * 于是 `findValueRange` 退回成"值恰好等于目标"的精确查找也照样能通过测试 ——
   * 真实游戏里几乎总要带偏移，这个缺陷因此长期潜伏。
   *
   * 设计要点（刻意如此，别改坏）：
   *   - 槽 `pointerToOffset` 存放 `offsetTarget - 8` 的地址；
   *   - 于是扫描 `offsetTarget` 时，正确路径是 `[base+pointerToOffset]+8`（非零偏移）；
   *   - 位置选在填充区里，且**不构成任何多级链**，避免改变既有
   *     targetValue 指针链的真实深度（那会影响"自动降层"类测试）。
   */
  pointerToOffset: 0x02d0,
  offsetTarget: 0x02d8,
  totalSize: 0x4000,
};

const SIZE = L.totalSize;

const k32 = koffi.load('kernel32.dll');
const VirtualAlloc = k32.func('VirtualAlloc', 'void*', ['void*', 'size_t', 'uint32', 'uint32']);
const GetCurrentProcess = k32.func('GetCurrentProcess', 'void*', []);
const WriteProcessMemory = k32.func('WriteProcessMemory', 'bool', [
  'void*', 'void*', 'void*', 'size_t', koffi.out(koffi.pointer('size_t')),
]);

const p = VirtualAlloc(null, SIZE, 0x3000, 0x04);
if (!p) {
  process.stderr.write('VirtualAlloc 失败\n');
  process.exit(1);
}
const base = BigInt(koffi.address(p));

function buildFixture() {
  const buf = Buffer.alloc(SIZE);
  buf.writeInt32LE(1000, L.health);
  buf.writeInt32LE(500, L.ammo);
  buf.writeFloatLE(3.5, L.position);
  buf.writeDoubleLE(1234.5678, L.money);
  buf.writeBigInt64LE(9007199254740993n, L.bigCounter);
  buf.writeInt32LE(4242, L.targetValue);
  buf.write('HELLO CHEAT ENGINE\0', L.nameString, 'latin1');
  buf.write('WideString测试\0', L.wideString, 'utf16le');

  // AOB：DE AD BE EF 90 90 ?? 7*
  const aob = [0xde, 0xad, 0xbe, 0xef, 0x90, 0x90, 0x11, 0x7a];
  aob.forEach((b, i) => buf.writeUInt8(b, L.aobSignature + i));

  // 唯一 AOB 标记：16 字节，**确定性生成**（不用随机数，保证每次一致、可复现）。
  // 详见 L.uniqueAob 的说明：短特征会被巧合打破，所以这里取 128 位。
  const uniqueAob = [
    0x9e, 0x3b, 0x07, 0xd4, 0x61, 0xf2, 0x8a, 0x35,
    0xcd, 0x44, 0x1b, 0xa7, 0x72, 0xe0, 0x56, 0x8f
  ];
  uniqueAob.forEach((b, i) => buf.writeUInt8(b, L.uniqueAob + i));

  buf.writeInt16LE(-1234, L.signedValue);
  buf.writeUInt8(200, L.byteFlag);

  for (let i = 0; i < L.fillerCount; i++) buf.writeInt32LE(1337, L.fillerStart + i * 4);

  const targetAddr = base + BigInt(L.targetValue);
  buf.writeBigUInt64LE(targetAddr, L.pointerToTarget);
  // 指针链：chainA 存 chainB 的地址，chainB 存 targetValue 的地址
  buf.writeBigUInt64LE(base + BigInt(L.chainB), L.chainA);
  buf.writeBigUInt64LE(targetAddr, L.chainB);
  // 非零偏移指针：槽里存放 offsetTarget-8 的地址，于是扫描 offsetTarget 时
  // 正确路径是 [base+pointerToOffset]+8（偏移非零，正是回归点）
  buf.writeBigUInt64LE(base + BigInt(L.offsetTarget - 8), L.pointerToOffset);
  return buf;
}

const buf = buildFixture();
const written = [0];
if (!WriteProcessMemory(GetCurrentProcess(), p, buf, SIZE, written)) {
  process.stderr.write('WriteProcessMemory 失败\n');
  process.exit(1);
}
/**
 * 写完立刻把这份 JS 侧缓冲清零，并**不要**保留对它的引用。
 *
 * 为什么必须清（实测结论，别删）：
 *   只要这份 16KB 的 Buffer 还活着，夹具进程里就会存在**第二份**与
 *   VirtualAlloc 段完全相同的字节（实测：段内 70 个非零 32B 块里有 69 个
 *   能在进程别处找到；两处可独立写入，**不是**同一物理页的别名）。
 *   于是夹具里那些"本应唯一"的 AOB 特征在进程内恒有 2 处命中：
 *
 *     V1  Buffer.alloc + 保留引用  → 特征命中 2 处
 *     V2  同上但写完清零            → 特征命中 1 处   ← 采用
 *     V3  Uint8Array 转 Buffer      → 命中 2 处
 *     V4  Buffer.allocUnsafe        → 命中 2 处
 *
 *   后果：`AOBScanUnique`（命中即停）返回哪一处取决于扫描顺序，
 *   任何"必须命中 1 处 / 必须等于夹具地址"的断言都会偶发失败，
 *   而且失败信息完全指不出真因（曾误判为扫描器把同一匹配报告两次）。
 *
 * 清零是安全的：`writeAt` 用的是它自己新建的小 Buffer，与本缓冲无关；
 * 夹具段的权威数据在 `p`（目标进程内存）里，这份 JS 缓冲只是搬运工。
 */
buf.fill(0);

function writeAt(offset, data) {
  return WriteProcessMemory(
    GetCurrentProcess(),
    base + BigInt(offset), // koffi 直接接受 BigInt 作为指针地址
    data,
    data.length,
    [0],
  );
}

process.stdout.write(
  JSON.stringify({
    ready: true,
    pid: process.pid,
    base: '0x' + base.toString(16),
    size: SIZE,
    values: {
      health: 1000,
      ammo: 500,
      position: 3.5,
      money: 1234.5678,
      bigCounter: '9007199254740993',
      targetValue: 4242,
      pointerToTarget: '0x' + (base + BigInt(L.targetValue)).toString(16),
      nameString: 'HELLO CHEAT ENGINE',
      wideString: 'WideString测试',
      signedValue: -1234,
      byteFlag: 200,
      fillerValue: 1337,
      fillerCount: L.fillerCount,
    },
    offsets: L,
  }) + '\n',
);

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = line.trim();
  if (cmd === 'quit') process.exit(0);
  if (cmd === 'mutate') {
    writeAt(L.health, Buffer.from([0x4c, 0x04, 0x00, 0x00])); // 1100
    writeAt(L.ammo, Buffer.from([0xc2, 0x01, 0x00, 0x00])); // 450
    const f = Buffer.alloc(4);
    f.writeFloatLE(7.0, 0);
    writeAt(L.position, f);
    const d = Buffer.alloc(8);
    d.writeDoubleLE(1235.5678, 0);
    writeAt(L.money, d);
    process.stdout.write('{"mutated":true}\n');
    return;
  }
  if (cmd.startsWith('write')) {
    const [, addrHex, dataHex] = cmd.split(/\s+/);
    const data = Buffer.from(dataHex, 'hex');
    const w = [0];
    const ok = WriteProcessMemory(
      GetCurrentProcess(),
      BigInt(addrHex),
      data,
      data.length,
      w,
    );
    /**
     * 写完立刻把本地那份十六进制解码缓冲清零。
     *
     * 为什么必须清（实测结论，别删）：
     *   `Buffer.from(dataHex,'hex')` 会在**本进程的 V8 堆**里留下一份
     *   解码结果的副本，且它是长寿命的（不被回收）。于是同一串字节在
     *   夹具进程里会出现在**两个地址**上：VirtualAlloc 段内的真实数据，
     *   以及 V8 堆里的这份残留。
     *
     *   这会直接毁掉 AOB 测试：`AOBScanUnique` 要求特征在进程内唯一，
     *   而"经 stdin 写入的字节"必然出现两处 → AOBScanUnique 返回哪一处
     *   取决于扫描顺序 → 测试偶发失败，且失败信息完全指不出真因。
     *   （实测：不清零 = 2 处命中；清零 = 1 处命中，5/5 稳定。）
     *
     * 安全性：清零只作用于这份解码缓冲，不会动到 `dataHex` 字符串本身
     *   （已实测：清零后重新按原串解析仍得到同样长度的数据）。
     */
    data.fill(0);
    process.stdout.write(JSON.stringify({ wrote: ok, bytes: w[0] }) + '\n');
    return;
  }
  process.stdout.write('{"echo":true}\n');
});

process.on('SIGINT', () => process.exit(0));
