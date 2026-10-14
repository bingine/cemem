/**
 * 扫描引擎测试 —— 全部在真实跨进程条件下运行。
 *
 * 覆盖：全部扫描选项、全部数值类型、字符串/AOB/二进制/分组长、
 * 并行与单线程一致性、指针扫描、内存读写与区域枚举。
 */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { useFixture } = require('./helpers/fixture');

const {
  VariableType,
  ScanOption,
  RoundingType,
  ScanSession,
  PointerScanner,
  applyPointerPath,
  formatPointerPath,
  compileConfig,
  scanBlock,
  listProcesses,
  findProcessesByName,
  isReadable,
  isWritable,
  isExecutable,
  roundTo,
  parseAob,
  MEM_IMAGE,
  MEM_MAPPED,
  MEM_PRIVATE,
  PAGE_READONLY,
  PAGE_READWRITE,
} = require('../dist/cjs/index');

const env = useFixture();
beforeEach(() => env.setup());
afterEach(() => env.teardown());

/** 常用缩写 */
const L = () => env.box.ctx.info.offsets;
const base = () => env.box.ctx.base;
const proc = () => env.box.ctx.process;

function scanFirst(cfg, opts) {
  const s = new ScanSession(proc(), { blockSize: 1 << 20, parallel: false, ...opts });
  const st = s.firstScan({
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    includeImage: false,
    includeMapped: false,
    ...cfg,
  });
  return { session: s, stats: st };
}

/* ================================================================== *
 * 1. 纯函数：编解码与舍入策略
 * ================================================================== */

test('roundTo 复刻 FPC 的半值取偶（banker\'s rounding）', () => {
  assert.equal(roundTo(3.5, 0), 4);
  assert.equal(roundTo(2.5, 0), 2);
  assert.equal(roundTo(1.5, 0), 2);
  assert.equal(roundTo(0.5, 0), 0);
  assert.equal(roundTo(-0.5, 0), 0);
  assert.equal(roundTo(-1.5, 0), -2);
  // 保留 1 位小数
  assert.equal(roundTo(3.45, 1), 3.4);
  assert.equal(roundTo(3.55, 1), 3.6);
  assert.equal(roundTo(1234.5678, 1), 1234.6);
  assert.equal(roundTo(1234.5678, 4), 1234.5678);
  // 非有限值原样返回
  assert.ok(Number.isNaN(roundTo(NaN, 2)));
  assert.equal(roundTo(Infinity, 2), Infinity);
});

test('parseAob 支持通配字节与半字节通配', () => {
  // 完整字节
  let p = parseAob('DE AD BE EF');
  assert.equal(p.length, 4);
  assert.deepEqual(p.map((b) => b.value), [0xde, 0xad, 0xbe, 0xef]);
  assert.ok(p.every((b) => !b.wildcard && b.mask === 0xff));

  // 全通配
  p = parseAob('90 ?? xx *');
  assert.equal(p.length, 4);
  assert.equal(p[0].value, 0x90);
  assert.equal(p[1].wildcard, true);
  assert.equal(p[2].wildcard, true);
  assert.equal(p[3].wildcard, true);

  // 半字节通配：7* 表示高半字节必须为 7
  p = parseAob('7*');
  assert.equal(p.length, 1);
  assert.equal(p[0].wildcard, false);
  assert.equal(p[0].value, 0x70);
  assert.equal(p[0].mask, 0xf0);

  // *7 表示低半字节必须为 7
  p = parseAob('*7');
  assert.equal(p[0].value, 0x07);
  assert.equal(p[0].mask, 0x0f);

  // 分隔符：空格 / 逗号 / 短横线，且允许连写
  assert.equal(parseAob('DE,AD BE-EF').length, 4);
  assert.equal(parseAob('DEADBEEF').length, 4);
  assert.equal(parseAob('').length, 0);
});

/* ================================================================== *
 * 2. 进程与内存基础
 * ================================================================== */

test('进程枚举、模块枚举、内存区域分类', () => {
  const all = listProcesses();
  assert.ok(all.length > 50, `应枚举到大量进程，实际 ${all.length}`);
  const self = all.find((p) => p.pid === process.pid);
  assert.ok(self, '应能枚举到自己');
  assert.match(self.name.toLowerCase(), /node/);

  const hits = findProcessesByName('node.exe');
  assert.ok(hits.length > 0, '应能按名字找到 node.exe');

  const p = proc();
  const mods = p.modules();
  assert.ok(mods.length > 0);
  assert.ok(mods.every((m) => typeof m.name === 'string' && m.baseAddress > 0n));

  const regions = p.regions();
  assert.ok(regions.length > 0);
  // 区域必须是已提交或已保留，且保护属性分类自洽
  const committed = regions.filter((r) => r.committed);
  assert.ok(committed.length > 0);
  assert.ok(
    committed.some((r) => r.type === MEM_IMAGE || r.type === MEM_MAPPED || r.type === MEM_PRIVATE),
    '应至少出现一种分配类型',
  );
  // 保护属性分类函数自洽性
  assert.equal(isReadable(PAGE_READWRITE), true);
  assert.equal(isWritable(PAGE_READWRITE), true);
  assert.equal(isExecutable(PAGE_READWRITE), false);
  assert.equal(isReadable(PAGE_READONLY), true);
  assert.equal(isWritable(PAGE_READONLY), false);
  assert.equal(isReadable(0x01 /* PAGE_NOACCESS */), false);
  assert.equal(isReadable(0x104 /* RW | PAGE_GUARD */), false, 'PAGE_GUARD 区域不应视为可读');
});

test('跨进程读写内存（含 bigint 精度与回绕）', () => {
  const p = proc();
  const L0 = L();
  const healthAddr = base() + BigInt(L0.health);

  assert.equal(p.readMemoryExact(healthAddr, 4).readInt32LE(0), 1000);

  // int32 回绕：写入 -1 应读出 0xFFFFFFFF
  p.writeMemory(healthAddr, Buffer.from([0xff, 0xff, 0xff, 0xff]));
  assert.equal(p.readMemoryExact(healthAddr, 4).readUInt32LE(0), 0xffffffff);

  // 恢复
  const restore = Buffer.alloc(4);
  restore.writeInt32LE(1000, 0);
  p.writeMemory(healthAddr, restore);
  assert.equal(p.readMemoryExact(healthAddr, 4).readInt32LE(0), 1000);

  // int64 大数：必须走 BigInt，不能经过 double
  const bigAddr = base() + BigInt(L0.bigCounter);
  assert.equal(p.readMemoryExact(bigAddr, 8).readBigInt64LE(0), 9007199254740993n);

  // 不可读地址应返回空 buffer 而不是抛错（readMemory 是容错版）
  const empty = p.readMemory(0n, 16);
  assert.equal(empty.length, 0);
  // readMemoryExact 对不可读地址必须抛错
  assert.throws(() => p.readMemoryExact(0n, 16), /读取.*内存失败/);
});

/* ================================================================== *
 * 3. 各变量类型的首次扫描
 * ================================================================== */

test('精确扫描：int32 / int16 有符号 / int8', () => {
  // int32 = 1000
  {
    const { session } = scanFirst({
      variableType: VariableType.DWord,
      scanOption: ScanOption.ExactValue,
      value1: '1000',
    });
    assert.ok(session.results.includes(base() + BigInt(L().health)));
  }
  // int16 = -1234（有符号）
  {
    const { session } = scanFirst({
      variableType: VariableType.Word,
      scanOption: ScanOption.ExactValue,
      value1: '-1234',
      signed: true,
    });
    assert.ok(session.results.includes(base() + BigInt(L().signedValue)));
  }
  // int8 = 200（无符号）
  {
    const { session } = scanFirst({
      variableType: VariableType.Byte,
      scanOption: ScanOption.ExactValue,
      value1: '200',
    });
    assert.ok(session.results.includes(base() + BigInt(L().byteFlag)));
  }
  // int64 大数
  {
    const { session } = scanFirst({
      variableType: VariableType.QWord,
      scanOption: ScanOption.ExactValue,
      value1: '9007199254740993',
    });
    assert.ok(session.results.includes(base() + BigInt(L().bigCounter)));
  }
  // 十六进制输入
  {
    const { session } = scanFirst({
      variableType: VariableType.DWord,
      scanOption: ScanOption.ExactValue,
      value1: '3E8', // 1000
      hexadecimal: true,
    });
    assert.ok(session.results.includes(base() + BigInt(L().health)));
  }
});

test('浮点扫描：三种舍入策略（rtRounded / rtExtremeRounded / rtTruncated）', () => {
  const posAddr = base() + BigInt(L().position);

  // Rounded：按小数位数判等，should hit 3.5
  {
    const { session } = scanFirst({
      variableType: VariableType.Single,
      scanOption: ScanOption.ExactValue,
      roundingType: RoundingType.Rounded,
      floatAccuracy: 1,
      value1: '3.5',
    });
    assert.ok(session.results.includes(posAddr));
  }
  // ExtremeRounded：落在 ±eps 区间内
  {
    const { session } = scanFirst({
      variableType: VariableType.Single,
      scanOption: ScanOption.ExactValue,
      roundingType: RoundingType.ExtremeRounded,
      floatAccuracy: 1,
      value1: '3.5',
    });
    assert.ok(session.results.includes(posAddr), 'extremeRounded ±0.1 应包含 3.5');
  }
  // Truncated：[value, value+step) 左闭右开
  {
    const { session } = scanFirst({
      variableType: VariableType.Single,
      scanOption: ScanOption.ExactValue,
      roundingType: RoundingType.Truncated,
      floatAccuracy: 1,
      value1: '3.5',
    });
    assert.ok(session.results.includes(posAddr));
  }
  // double
  {
    const { session } = scanFirst({
      variableType: VariableType.Double,
      scanOption: ScanOption.ExactValue,
      roundingType: RoundingType.Rounded,
      floatAccuracy: 4,
      value1: '1234.5678',
    });
    assert.ok(session.results.includes(base() + BigInt(L().money)));
  }
});

test('区间 / 大于 / 小于 扫描', () => {
  // 区间 [1300,1400] 覆盖填充值 1337
  {
    const { session } = scanFirst({
      variableType: VariableType.DWord,
      scanOption: ScanOption.ValueBetween,
      value1: '1300',
      value2: '1400',
    });
    assert.ok(session.results.includes(base() + BigInt(L().fillerStart)));
  }
  // 大于 999 应包含 health=1000
  {
    const { session } = scanFirst({
      variableType: VariableType.DWord,
      scanOption: ScanOption.BiggerThan,
      value1: '999',
    });
    assert.ok(session.results.includes(base() + BigInt(L().health)));
  }
  // 小于 1001 同样应包含 health=1000
  {
    const { session } = scanFirst({
      variableType: VariableType.DWord,
      scanOption: ScanOption.SmallerThan,
      value1: '1001',
    });
    assert.ok(session.results.includes(base() + BigInt(L().health)));
  }
  // 有符号区间：-2000..-1000 覆盖 -1234
  {
    const { session } = scanFirst({
      variableType: VariableType.Word,
      scanOption: ScanOption.ValueBetween,
      value1: '-2000',
      value2: '-1000',
      signed: true,
    });
    assert.ok(session.results.includes(base() + BigInt(L().signedValue)));
  }
});

test('字符串扫描：ANSI / UTF-16 / 大小写敏感度', () => {
  // ANSI 精确
  {
    const { session } = scanFirst({
      variableType: VariableType.String,
      scanOption: ScanOption.ExactValue,
      value1: 'HELLO CHEAT ENGINE',
      caseSensitive: true,
      stringLength: 18,
    });
    assert.ok(session.results.includes(base() + BigInt(L().nameString)));
  }
  // ANSI 不区分大小写（CE 默认）
  {
    const { session } = scanFirst({
      variableType: VariableType.String,
      scanOption: ScanOption.ExactValue,
      value1: 'hello cheat engine',
      caseSensitive: false,
      stringLength: 18,
    });
    assert.ok(session.results.includes(base() + BigInt(L().nameString)));
  }
  // ANSI 区分大小写时，全小写不应命中
  {
    const { session } = scanFirst({
      variableType: VariableType.String,
      scanOption: ScanOption.ExactValue,
      value1: 'hello cheat engine',
      caseSensitive: true,
      stringLength: 18,
    });
    assert.ok(!session.results.includes(base() + BigInt(L().nameString)));
  }
  // UTF-16
  {
    const { session } = scanFirst({
      variableType: VariableType.UnicodeString,
      scanOption: ScanOption.ExactValue,
      value1: 'WideString测试',
      caseSensitive: true,
      stringLength: 14,
    });
    assert.ok(session.results.includes(base() + BigInt(L().wideString)));
  }
});

test('AOB 扫描（含通配与半字节通配）', () => {
  const target = base() + BigInt(L().aobSignature);

  // 完全精确
  {
    const { session } = scanFirst({
      variableType: VariableType.ByteArray,
      scanOption: ScanOption.ExactValue,
      value1: 'DE AD BE EF 90 90 11 7A',
    });
    assert.ok(session.results.includes(target));
  }
  // 带全通配与半字节通配
  {
    const { session } = scanFirst({
      variableType: VariableType.ByteArray,
      scanOption: ScanOption.ExactValue,
      value1: 'DE AD BE EF 90 90 ?? 7*',
    });
    assert.ok(session.results.includes(target), '?? 与 7* 应都能匹配');
  }
  // 半字节通配必须真正生效：把最后一个字节写成 7B（高半字节仍是 7）也应命中
  {
    const p = proc();
    const lastByteAddr = target + 7n;
    const orig = p.readMemoryExact(lastByteAddr, 1);
    p.writeMemory(lastByteAddr, Buffer.from([0x7b]));
    const { session } = scanFirst({
      variableType: VariableType.ByteArray,
      scanOption: ScanOption.ExactValue,
      value1: 'DE AD BE EF 90 90 ?? 7*',
    });
    assert.ok(session.results.includes(target), '低半字节变化仍应命中 7*');
    p.writeMemory(lastByteAddr, orig);
  }
  // 半字节不匹配时不应命中
  {
    const p = proc();
    const lastByteAddr = target + 7n;
    const orig = p.readMemoryExact(lastByteAddr, 1);
    p.writeMemory(lastByteAddr, Buffer.from([0x8a])); // 高半字节 8 ≠ 7
    const { session } = scanFirst({
      variableType: VariableType.ByteArray,
      scanOption: ScanOption.ExactValue,
      value1: 'DE AD BE EF 90 90 ?? 7*',
    });
    assert.ok(!session.results.includes(target), '高半字节不匹配时不应命中');
    p.writeMemory(lastByteAddr, orig);
  }
});

test('vtAll：所有数值类型同时参与，任一命中即保留', () => {
  // value 200 会命中 byteFlag(200)，也可能命中其它类型的偶然匹配
  const { session } = scanFirst({
    variableType: VariableType.All,
    scanOption: ScanOption.ExactValue,
    value1: '200',
  });
  assert.ok(session.results.includes(base() + BigInt(L().byteFlag)));
});

test('分组长扫描（顺序排列）', () => {
  // 夹具 health(1000,int32) 紧跟 ammo(500,int32)，构成 [1000][500]
  const { session } = scanFirst({
    variableType: VariableType.Grouped,
    scanOption: ScanOption.ExactValue,
    groupElements: [
      { variableType: VariableType.DWord, value: '1000' },
      { variableType: VariableType.DWord, value: '500' },
    ],
  });
  assert.ok(
    session.results.includes(base() + BigInt(L().health)),
    `分组长扫描应命中 health 起始处，实际命中 ${session.resultCount} 个`,
  );
});

test('分组长扫描（乱序，含通配元素）', () => {
  const { session } = scanFirst({
    variableType: VariableType.Grouped,
    scanOption: ScanOption.ExactValue,
    groupOutOfOrder: true,
    groupElements: [
      { variableType: VariableType.DWord, value: '1000' },
      { variableType: VariableType.DWord, wildcard: true },
      { variableType: VariableType.DWord, value: '500' },
    ],
  });
  assert.ok(session.results.includes(base() + BigInt(L().health)));
});

/* ================================================================== *
 * 4. 再次扫描（next scan）—— 依赖旧值的选项
 * ================================================================== */

test('再次扫描：变动 / 未变动 / 增加 / 减少 / 增加指定值', async () => {
  const L0 = L();
  const healthAddr = base() + BigInt(L0.health);
  const fillerStart = L0.fillerStart;

  // 以"未变动"验证：填充区 512 个 1337 必须全部保留
  {
    const s = new ScanSession(proc(), { blockSize: 1 << 20 });
    const first = s.firstScan({
      variableType: VariableType.DWord,
      scanOption: ScanOption.ExactValue,
      roundingType: RoundingType.Rounded,
      floatAccuracy: 0,
      value1: '1337',
      includeImage: false,
      includeMapped: false,
    });
    assert.ok(first.resultCount >= 512, `填充区应有 ≥512 个命中，实际 ${first.resultCount}`);

    const st = s.nextScan({
      variableType: VariableType.DWord,
      scanOption: ScanOption.Unchanged,
      roundingType: RoundingType.Rounded,
      floatAccuracy: 0,
      includeImage: false,
      includeMapped: false,
    });
    assert.equal(st.resultCount, first.resultCount, '未变动的值应全部保留');
    assert.ok(s.results.includes(base() + BigInt(fillerStart)));
  }

  // 以"变动 / 未变动"验证：把填充区的一个值改掉
  {
    const s = new ScanSession(proc(), { blockSize: 1 << 20 });
    const first = s.firstScan({
      variableType: VariableType.DWord,
      scanOption: ScanOption.ExactValue,
      roundingType: RoundingType.Rounded,
      floatAccuracy: 0,
      value1: '1337',
      includeImage: false,
      includeMapped: false,
    });
    const someAddr = base() + BigInt(fillerStart);
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(9999, 0);
    proc().writeMemory(someAddr, buf);

    // "变动了"：只有被改掉的那个地址还留在候选集里（因为其它地址仍是 1337 未变）
    const changed = s.nextScan({
      variableType: VariableType.DWord,
      scanOption: ScanOption.Changed,
      roundingType: RoundingType.Rounded,
      floatAccuracy: 0,
      includeImage: false,
      includeMapped: false,
    });
    assert.equal(changed.resultCount, 1, `应只有 1 个地址发生变动，实际 ${changed.resultCount}`);
    assert.ok(s.results.includes(someAddr));

    // 还原回 1337 后，"未变动"应保留几乎全部（候选集现在只剩那 1 个地址，
    // 因此用新会话验证未变动的完整保留语义）
    const restore = Buffer.alloc(4);
    restore.writeInt32LE(1337, 0);
    proc().writeMemory(someAddr, restore);

    const s2 = new ScanSession(proc(), { blockSize: 1 << 20 });
    s2.firstScan({
      variableType: VariableType.DWord,
      scanOption: ScanOption.ExactValue,
      roundingType: RoundingType.Rounded,
      floatAccuracy: 0,
      value1: '1337',
      includeImage: false,
      includeMapped: false,
    });
    const unchanged = s2.nextScan({
      variableType: VariableType.DWord,
      scanOption: ScanOption.Unchanged,
      roundingType: RoundingType.Rounded,
      floatAccuracy: 0,
      includeImage: false,
      includeMapped: false,
    });
    assert.equal(unchanged.resultCount, first.resultCount, '还原后未变动应全部保留');
  }

  // 增加 / 减少：用 mutate 让 health 1000→1100
  {
    const s = new ScanSession(proc(), { blockSize: 1 << 20 });
    s.firstScan({
      variableType: VariableType.DWord,
      scanOption: ScanOption.ExactValue,
      roundingType: RoundingType.Rounded,
      floatAccuracy: 0,
      value1: '1000',
      includeImage: false,
      includeMapped: false,
    });
    await env.box.ctx.fixture.command('mutate');
    const st = s.nextScan({
      variableType: VariableType.DWord,
      scanOption: ScanOption.IncreasedValue,
      roundingType: RoundingType.Rounded,
      floatAccuracy: 0,
      includeImage: false,
      includeMapped: false,
    });
    assert.ok(s.results.includes(healthAddr), 'mutate 后 health 变大，应被"增加了"保留');
    assert.ok(st.resultCount >= 1);
  }

  // 增加指定值 100：1000 → 1100
  {
    const s = new ScanSession(proc(), { blockSize: 1 << 20 });
    // 先复位
    const restore = Buffer.alloc(4);
    restore.writeInt32LE(1000, 0);
    proc().writeMemory(healthAddr, restore);
    s.firstScan({
      variableType: VariableType.DWord,
      scanOption: ScanOption.ExactValue,
      roundingType: RoundingType.Rounded,
      floatAccuracy: 0,
      value1: '1000',
      includeImage: false,
      includeMapped: false,
    });
    // 直接改成 1100
    const next = Buffer.alloc(4);
    next.writeInt32LE(1100, 0);
    proc().writeMemory(healthAddr, next);
    s.nextScan({
      variableType: VariableType.DWord,
      scanOption: ScanOption.IncreasedValueBy,
      roundingType: RoundingType.Rounded,
      floatAccuracy: 0,
      value1: '100',
      includeImage: false,
      includeMapped: false,
    });
    assert.ok(s.results.includes(healthAddr), '1000 + 100 = 1100 应命中"增加指定数值"');
  }
});

test('再次扫描：无快照时对"依赖旧值"的选项给出明确错误', () => {
  const s = new ScanSession(proc(), {
    blockSize: 1 << 20,
    // 把快照上限设为 0，强制不保留原始内存
    maxSnapshotBytes: 0,
  });
  s.firstScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1337',
    includeImage: false,
    includeMapped: false,
  });
  assert.equal(s.stats.hasSnapshot, false, 'maxSnapshotBytes=0 时不应保留快照');
  assert.throws(
    () =>
      s.nextScan({
        variableType: VariableType.DWord,
        scanOption: ScanOption.Unchanged,
        roundingType: RoundingType.Rounded,
        floatAccuracy: 0,
        includeImage: false,
        includeMapped: false,
      }),
    /需要上一次扫描的旧值/,
  );
  // 不需要旧值的选项仍然可用
  const st = s.nextScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1337',
    includeImage: false,
    includeMapped: false,
  });
  assert.ok(st.resultCount > 0);
});

test('扫描会话的边界行为：未首次扫描就再次扫描 / 复位', () => {
  const s = new ScanSession(proc(), { blockSize: 1 << 20 });
  assert.throws(() => s.nextScan({ variableType: VariableType.DWord, scanOption: ScanOption.Unchanged, roundingType: RoundingType.Rounded, floatAccuracy: 0 }), /请先执行首次扫描/);
  assert.equal(s.canNextScan, false);

  s.firstScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1337',
    includeImage: false,
    includeMapped: false,
  });
  assert.equal(s.canNextScan, true);
  assert.ok(s.resultCount > 0);

  s.reset();
  assert.equal(s.resultCount, 0);
  assert.equal(s.canNextScan, false);
  assert.equal(s.chunks.length, 0);
});

/* ================================================================== *
 * 5. 并行一致性
 * ================================================================== */

test('并行与单线程扫描结果集完全一致', () => {
  const cfg = {
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1337',
    includeImage: false,
    includeMapped: false,
  };

  const serial = new ScanSession(proc(), { blockSize: 1 << 20, parallel: false });
  serial.firstScan(cfg);
  const serialSet = new Set(serial.results.map(String));

  // 降低并行阈值，确保并行路径真的被触发（否则这个测试形同虚设）
  const parallel = new ScanSession(proc(), {
    blockSize: 1 << 20,
    parallel: true,
    parallelMinBytes: 1,
    workerCount: 4,
  });
  const st = parallel.firstScan(cfg);
  const parallelSet = new Set(parallel.results.map(String));

  assert.ok(st.workersUsed > 1, `应真的使用多 worker，实际 ${st.workersUsed}`);
  assert.equal(parallelSet.size, serialSet.size, '结果数量应一致');
  for (const a of serialSet) {
    assert.ok(parallelSet.has(a), `并行结果缺少 ${a}`);
  }
  for (const a of parallelSet) {
    assert.ok(serialSet.has(a), `并行结果多出 ${a}`);
  }
});

test('并行扫描也能保留快照并支持再次扫描', () => {
  const cfg = {
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1337',
    includeImage: false,
    includeMapped: false,
  };
  const s = new ScanSession(proc(), {
    blockSize: 1 << 20,
    parallel: true,
    parallelMinBytes: 1,
    workerCount: 4,
  });
  const st = s.firstScan(cfg);
  assert.ok(st.workersUsed > 1);
  assert.equal(st.hasSnapshot, true, '并行路径也应保留快照');

  const st2 = s.nextScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.Unchanged,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    includeImage: false,
    includeMapped: false,
  });
  assert.equal(st2.resultCount, st.resultCount, '未变动应全部保留');
});

/* ================================================================== *
 * 6. 指针扫描
 * ================================================================== */

test('指针扫描找到 chainA → chainB → target 的路径并可解析', () => {
  const p = proc();
  const L0 = L();
  const target = base() + BigInt(L0.targetValue);
  const chainA = base() + BigInt(L0.chainA);

  const ps = new PointerScanner(p, { maxLevel: 2, maxOffset: 0x10000, pointerSize: 8 });
  const paths = ps.scan(target);

  assert.ok(paths.length > 0, '应至少找到一条路径');
  assert.ok(ps.stats.pointerEntries > 0, '指针映射应有条目');

  const viaChainA = paths.filter((x) => x.baseAddress === chainA);
  assert.ok(viaChainA.length > 0, `应找到基址为 chainA 的路径，实际 ${paths.length} 条`);

  // 每条路径都必须能解析回目标地址。
  //
  // ⚠️ 这里**不能**直接用 `ps.readPointer` —— 它在读不通时会**抛错**
  // （见 pointer-scan.ts 的 readPointer：`读取指针失败：0x…`）。
  // 指针扫描是按**值匹配**找候选的，因此会带回"动态内存里的值巧合"路径：
  // 目标进程一空闲，GC 回收那一页，链就断了。
  //
  // 而断链的路径**不该让测试失败** —— 正确做法是把它排除在"可用路径"之外
  // （库侧 `scan()` 已做一次验证，但目标进程内存是活的，验证通过后仍可能失效）。
  // 早先这里直接调 `ps.readPointer`，于是偶发报
  //   `Error: 0x9a60`（读指针失败，报的是基址）
  // 干扰了"扫描结果是否正确"这个真正要测的东西。
  const safeReadPointer = (address) => {
    try {
      return ps.readPointer(address);
    } catch {
      return null; // 读不通 → 这条路径当前不可用
    }
  };

  let usable = 0;
  for (const path of paths) {
    let resolved = null;
    try {
      resolved = applyPointerPath(path, safeReadPointer);
    } catch {
      resolved = null; // 链中途读到 null（不可用）
    }
    if (resolved === null) continue; // 已失效的候选：跳过，不算失败
    usable += 1;
    assert.equal(resolved, target, `可解析的路径 ${formatPointerPath(path)} 解析结果必须等于目标`);
  }
  assert.ok(usable > 0, `应至少有一条**当前可用**的路径（共 ${paths.length} 条候选）`);

  // 偏移链顺序：chainA 存 chainB 地址、chainB 存 target 地址 → offsets 应为 [0,0]
  assert.deepEqual(viaChainA[0].offsets, [0, 0]);
  assert.equal(applyPointerPath(viaChainA[0], (a) => ps.readPointer(a)), target);
});

test('指针扫描：staticOnly 与排除段选项生效', () => {
  const p = proc();
  const L0 = L();
  const target = base() + BigInt(L0.targetValue);
  const fixtureStart = base();
  const fixtureEnd = base() + 0x4000n;

  // 排除夹具自身所在段（私有内存）→ chainA 位于其中，应当找不到
  const ps = new PointerScanner(p, {
    maxLevel: 2,
    maxOffset: 0x10000,
    pointerSize: 8,
    excludeSegments: [{ start: fixtureStart, end: fixtureEnd }],
  });
  const paths = ps.scan(target);
  assert.ok(
    !paths.some((x) => x.baseAddress >= fixtureStart && x.baseAddress < fixtureEnd),
    '被排除的段不应出现在结果中',
  );

  // staticOnly：基址必须落在 MEM_IMAGE 段内
  const ps2 = new PointerScanner(p, {
    maxLevel: 2,
    maxOffset: 0x10000,
    pointerSize: 8,
    staticOnly: true,
  });
  // 不用断言一定有结果（取决于目标进程布局），但结果必须都落在映像段内
  const paths2 = ps2.scan(target);
  const imageRanges = p
    .regions()
    .filter((r) => r.committed && r.type === MEM_IMAGE)
    .map((r) => ({ start: r.baseAddress, end: r.baseAddress + r.memorySize }));
  for (const x of paths2) {
    assert.ok(
      imageRanges.some((r) => x.baseAddress >= r.start && x.baseAddress < r.end),
      `staticOnly 结果的基址 0x${x.baseAddress.toString(16)} 不在映像段内`,
    );
  }
});

/* ================================================================== *
 * 6b. 回归：maxOffset 必须真正生效（非零偏移的指针路径）
 * ================================================================== */

test('回归：指针扫描必须能找到需要非零偏移的路径（maxOffset 真正生效）', () => {
  // 背景（真实缺陷）：findValueRange 原来做的是"值**恰好等于**目标"的精确查找，
  // 于是 expandLevel 里算出的 offset 恒为 0，maxOffset 完全失效 ——
  // 表现为"只要偏移不为 0 就永远找不到指针路径"。
  //
  // 夹具提供了 pointerToOffset @ +0x2D0，它指向 offsetTarget-8 @ +0x2D0，
  // 因此扫描 offsetTarget @ +0x2D8 必须得到非零偏移 +8。
  const p = proc();
  const L0 = L();
  const target = base() + BigInt(L0.offsetTarget);
  const slot = base() + BigInt(L0.pointerToOffset);
  const expectedOffset = 8;

  // maxLevel=1：只在"直接指向目标"这一层找，路径应为 [slot]+8
  const ps = new PointerScanner(p, {
    maxLevel: 1,
    maxOffset: expectedOffset,
    pointerSize: 8,
  });
  const paths = ps.scan(target);

  const viaSlot = paths.filter((x) => x.baseAddress === slot);
  assert.ok(
    viaSlot.length > 0,
    `应找到基址 0x${slot.toString(16)} 的路径（需要偏移 ${expectedOffset}），实际 ${paths.length} 条`,
  );
  assert.deepEqual(
    viaSlot[0].offsets,
    [expectedOffset],
    '偏移必须被正确算出，而不是恒为 0',
  );
  // 路径必须能解析回目标
  assert.equal(applyPointerPath(viaSlot[0], (a) => ps.readPointer(a)), target);

  // maxOffset 变小时该路径必须消失，否则说明 maxOffset 没起过滤作用
  const psTight = new PointerScanner(p, {
    maxLevel: 1,
    maxOffset: expectedOffset - 1,
    pointerSize: 8,
  });
  const tight = psTight.scan(target);
  assert.ok(
    !tight.some((x) => x.baseAddress === slot),
    `maxOffset 小于实际偏移 ${expectedOffset} 时不应再返回该路径`,
  );
});

test('回归：maxResults 在**两种模式**下都必须生效（曾被完全无视）', () => {
  // 这个 bug 是真的：`scan()` 里只有 `preferShallow`（汇总）分支应用了
  // maxResults，**默认模式完全无视它** —— 实测请求 maxResults=3 时
  // 默认模式返回了 896 条。而工具的 `maxResults` 参数就映射到它，
  // 等于对调用方"最多返回 N 条"的承诺是假的。
  //
  // 另外 `preferShallow` 那侧原先把截断放在**验证之前**，于是验证丢掉一些
  // 路径后，"最多 N 条"会退化成"不足 N 条"（明明还有可用路径没取到）。
  // 现在统一为：先验证（只看有效性）→ 再截断（只看上限）。
  const p = proc();
  const L0 = L();
  const target = base() + BigInt(L0.targetValue);

  for (const preferShallow of [true, false]) {
    for (const maxResults of [3, 10]) {
      const ps = new PointerScanner(p, {
        maxLevel: 2,
        maxOffset: 0x10000,
        pointerSize: 8,
        preferShallow,
        maxResults,
      });
      const paths = ps.scan(target);
      assert.ok(
        paths.length <= maxResults,
        `preferShallow=${preferShallow} maxResults=${maxResults} 时返回了 ${paths.length} 条，超出上限`,
      );
      // stats.resultCount 必须与真实返回条数一致（否则调用方会读到假数字）
      assert.equal(
        ps.stats.resultCount,
        paths.length,
        `stats.resultCount 应与实际返回条数一致（preferShallow=${preferShallow}）`,
      );
      // candidateCount 是"未截断前通过验证的总数"，必然 ≥ 返回条数
      assert.ok(
        ps.stats.candidateCount >= paths.length,
        `candidateCount(${ps.stats.candidateCount}) 应 ≥ 返回条数(${paths.length})`,
      );
    }
  }
});

test('回归：candidateCount 能反映"结果是否触及上限"', () => {
  // 调用方靠 `candidateCount > resultCount` 判断"还有更多路径没返回"，
  // 从而提示用户调大 maxResults。这里钉住这个语义。
  //
  // ⚠️ 断言不能写成"上限小时**必然**被截断"：通过验证的路径有可能
  // 恰好少于或等于上限（夹具的指针链是确定的，但动态内存里那些
  // "值巧合"候选会随进程状态浮动）。所以这里只钉**两个方向的不变量**：
  //   · candidateCount ≥ 返回条数（永远是）；
  //   · 上限足够大时**不能**出现"被截断"的假信号。
  const p = proc();
  const L0 = L();
  const target = base() + BigInt(L0.targetValue);

  const tiny = new PointerScanner(p, {
    maxLevel: 2, maxOffset: 0x10000, pointerSize: 8, preferShallow: true, maxResults: 2,
  });
  const tinyPaths = tiny.scan(target);
  assert.ok(
    tiny.stats.candidateCount >= tinyPaths.length,
    `candidateCount(${tiny.stats.candidateCount}) 必然 ≥ 返回条数(${tinyPaths.length})`,
  );
  // 若确实触及上限，就能看出来"还有更多"
  if (tiny.stats.candidateCount > tinyPaths.length) {
    assert.equal(tinyPaths.length, 2, '触及上限时应返回恰好 maxResults 条');
  }

  const huge = new PointerScanner(p, {
    maxLevel: 2, maxOffset: 0x10000, pointerSize: 8, preferShallow: true, maxResults: 100000,
  });
  const hugePaths = huge.scan(target);
  assert.equal(
    huge.stats.candidateCount,
    hugePaths.length,
    '上限足够大时不应有"被截断"的假信号',
  );
});

/* ================================================================== *
 * 7. matcher 纯函数直测（不依赖进程，验证编译与块扫描）
 * ================================================================== */

test('compileConfig / scanBlock 在内存缓冲上的行为', () => {
  // 构造 16 字节缓冲：1337, 1337, 1000, 500
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(1337, 0);
  buf.writeUInt32LE(1337, 4);
  buf.writeUInt32LE(1000, 8);
  buf.writeUInt32LE(500, 12);

  const cc = compileConfig({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1337',
  });
  const out = [];
  scanBlock(cc, buf, null, out);
  assert.deepEqual(out, [0, 4]);

  // 区间
  const cc2 = compileConfig({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ValueBetween,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '500',
    value2: '1000',
  });
  const out2 = [];
  scanBlock(cc2, buf, null, out2);
  assert.deepEqual(out2, [8, 12]);

  // 对齐扫描（fsmAligned）：只检查 4 字节对齐位置
  const cc3 = compileConfig({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1337',
    fastScanMethod: 1,
  });
  assert.equal(cc3.alignment, 4);
  const out3 = [];
  scanBlock(cc3, buf, null, out3);
  assert.deepEqual(out3, [0, 4]);

  // 需要旧值但未提供 → 必须抛错而不是静默返回空
  const cc4 = compileConfig({
    variableType: VariableType.DWord,
    scanOption: ScanOption.Unchanged,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
  });
  assert.throws(() => scanBlock(cc4, buf, null, []), /需要上一次扫描的值/);

  // 提供 prev 后应正常工作。
  // 注意：Unchanged 的语义是"逐点比较"，块内任意偏移都会参与比较，
  // 因此 prev 与 current 完全相同（各 4 字节值都相等）时，
  // 除末尾不足一个宽度外的所有偏移都会命中（13 个位置）。
  const out5 = [];
  scanBlock(cc4, buf, Buffer.from(buf), out5);
  assert.ok(out5.length > 0, 'prev 提供后必须能命中');
  assert.equal(out5[0], 0);
  for (const expected of [0, 4, 8, 12]) {
    assert.ok(out5.includes(expected), `偏移 ${expected} 应命中`);
  }
});

test('vtAll 的编译会展开为 6 个数值类型', () => {
  const cc = compileConfig({
    variableType: VariableType.All,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '100',
  });
  assert.equal(cc.isAll, true);
  assert.equal(cc.rules.length, 6);
  assert.deepEqual(
    cc.rules.map((r) => r.type),
    [VariableType.Byte, VariableType.Word, VariableType.DWord, VariableType.QWord, VariableType.Single, VariableType.Double],
  );
});
