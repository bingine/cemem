/**
 * 冒烟测试：在真实跨进程条件下验证扫描引擎。
 * 运行：node tools/smoke.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const { Process } = require('../dist/cjs/win/process');
const { ScanSession } = require('../dist/cjs/scanner/scanner');
const {
  VariableType,
  ScanOption,
  RoundingType,
  FastScanMethod,
} = require('../dist/cjs/types');

const fixture = spawn(process.execPath, [path.join(__dirname, '..', 'test', 'fixture-target.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

async function main() {
let buf = '';
const info = await new Promise((resolve, reject) => {
  fixture.stdout.on('data', (d) => {
    buf += d.toString();
    const nl = buf.indexOf('\n');
    if (nl !== -1) {
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (e) {
        reject(e);
      }
    }
  });
  fixture.stderr.on('data', (d) => process.stderr.write('[fixture] ' + d));
  setTimeout(() => reject(new Error('夹具启动超时')), 15000);
});

const base = BigInt(info.base);
console.log(`夹具 pid=${info.pid} base=0x${base.toString(16)} size=${info.size}`);

const proc = Process.open(info.pid);
console.log(`已打开进程 ${proc.name} (pid ${proc.pid})`);

function report(name, ok, extra = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
}

const t0 = Date.now();
const session = new ScanSession(proc, { blockSize: 1 << 20, parallel: true });
console.log(`并行 worker 数 = ${session.opts?.workerCount ?? '默认'}`);

/* ---------- 1. 精确 int32 = 1000 ---------- */
{
  const st = session.firstScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1000',
    includeImage: false,
    includeMapped: false,
  });
  const hit = session.results.includes(base + BigInt(info.offsets.health));
  report(
    '首次扫描 int32 = 1000',
    hit,
    `命中 ${st.resultCount} 个, 扫 ${(Number(st.bytesScanned) / 1048576).toFixed(1)}MB, ${st.elapsedMs}ms, workers=${st.workersUsed}`,
  );
}

/* ---------- 2. next scan：精确 = 1000 后改成 1100 ---------- */
{
  await new Promise((res) => {
    fixture.stdout.once('data', () => res());
    fixture.stdin.write('mutate\n');
  });
  const st = session.nextScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1100',
    includeImage: false,
    includeMapped: false,
  });
  const hit = session.results.includes(base + BigInt(info.offsets.health));
  report('再次扫描（精确 = 1100）', hit, `剩余 ${st.resultCount} 个, ${st.elapsedMs}ms`);
}

/* ---------- 3. 全新会话：float 精确 = 3.5 ---------- */
{
  const s2 = new ScanSession(proc, { blockSize: 1 << 20 });
  const st = s2.firstScan({
    variableType: VariableType.Single,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 1,
    value1: '3.5',
    includeImage: false,
    includeMapped: false,
  });
  // 注意：position 已被 mutate 改成 7.0。
  // 进程 26MB 内存里"四舍五入到 1 位小数等于 3.5"的 4 字节模式仍会有少量偶然命中，
  // 因此这里校验的是"不再命中 position 那个地址"，而不是结果数为 0。
  report(
    'float 精确 = 3.5（position 已改为 7.0，不应命中该地址）',
    !s2.results.includes(base + BigInt(info.offsets.position)),
    `命中 ${st.resultCount} 个, ${st.elapsedMs}ms`,
  );

  const st2 = s2.firstScan({
    variableType: VariableType.Single,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 1,
    value1: '7.0',
    includeImage: false,
    includeMapped: false,
  });
  report(
    'float 精确 = 7.0（应命中 position）',
    s2.results.includes(base + BigInt(info.offsets.position)),
    `命中 ${st2.resultCount} 个`,
  );
}

/* ---------- 4. double = 1235.5678 ---------- */
{
  const s3 = new ScanSession(proc, { blockSize: 1 << 20 });
  s3.firstScan({
    variableType: VariableType.Double,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 4,
    value1: '1235.5678',
    includeImage: false,
    includeMapped: false,
  });
  report(
    'double 精确 = 1235.5678',
    s3.results.includes(base + BigInt(info.offsets.money)),
    `命中 ${s3.resultCount} 个`,
  );
}

/* ---------- 5. int64 大数精度 ---------- */
{
  const s4 = new ScanSession(proc, { blockSize: 1 << 20 });
  s4.firstScan({
    variableType: VariableType.QWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '9007199254740993',
    includeImage: false,
    includeMapped: false,
  });
  report(
    'int64 = 9007199254740993（超过双精度安全整数）',
    s4.results.includes(base + BigInt(info.offsets.bigCounter)),
    `命中 ${s4.resultCount} 个`,
  );
}

/* ---------- 6. 字符串 ---------- */
{
  const s5 = new ScanSession(proc, { blockSize: 1 << 20 });
  s5.firstScan({
    variableType: VariableType.String,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: 'HELLO CHEAT ENGINE',
    caseSensitive: true,
    includeImage: false,
    includeMapped: false,
  });
  report(
    'ANSI 字符串精确匹配',
    s5.results.includes(base + BigInt(info.offsets.nameString)),
    `命中 ${s5.resultCount} 个`,
  );

  const s6 = new ScanSession(proc, { blockSize: 1 << 20 });
  s6.firstScan({
    variableType: VariableType.UnicodeString,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: 'WideString测试',
    caseSensitive: true,
    includeImage: false,
    includeMapped: false,
  });
  report(
    'UTF-16 字符串精确匹配',
    s6.results.includes(base + BigInt(info.offsets.wideString)),
    `命中 ${s6.resultCount} 个`,
  );
}

/* ---------- 7. AOB（含通配与半字节通配） ---------- */
{
  const s7 = new ScanSession(proc, { blockSize: 1 << 20 });
  s7.firstScan({
    variableType: VariableType.ByteArray,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: 'DE AD BE EF 90 90 ?? 7*',
    includeImage: false,
    includeMapped: false,
  });
  report(
    'AOB DE AD BE EF 90 90 ?? 7*（含半字节通配）',
    s7.results.includes(base + BigInt(info.offsets.aobSignature)),
    `命中 ${s7.resultCount} 个`,
  );
}

/* ---------- 8. 有符号 int16 = -1234 ---------- */
{
  const s8 = new ScanSession(proc, { blockSize: 1 << 20 });
  s8.firstScan({
    variableType: VariableType.Word,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '-1234',
    signed: true,
    includeImage: false,
    includeMapped: false,
  });
  report(
    '有符号 int16 = -1234',
    s8.results.includes(base + BigInt(info.offsets.signedValue)),
    `命中 ${s8.resultCount} 个`,
  );
}

/* ---------- 9. 未变动 / 变动 ---------- */
{
  const s9 = new ScanSession(proc, { blockSize: 1 << 20 });
  s9.firstScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1337',
    includeImage: false,
    includeMapped: false,
  });
  const before = s9.resultCount;
  const st = s9.nextScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.Unchanged,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    includeImage: false,
    includeMapped: false,
  });
  report(
    '再次扫描「未变动」（1337 填充区应全部保留）',
    st.resultCount === before && before >= info.values.fillerCount,
    `${before} → ${st.resultCount}`,
  );
}

/* ---------- 10. 区间扫描 ---------- */
{
  const s10 = new ScanSession(proc, { blockSize: 1 << 20 });
  const st = s10.firstScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ValueBetween,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1300',
    value2: '1400',
    includeImage: false,
    includeMapped: false,
  });
  report(
    '区间扫描 [1300,1400]（含 1337 填充区）',
    s10.results.includes(base + BigInt(info.offsets.fillerStart)),
    `命中 ${st.resultCount} 个`,
  );
}

/* ---------- 11. all 类型同时扫描 ---------- */
{
  const s11 = new ScanSession(proc, { blockSize: 1 << 20 });
  const st = s11.firstScan({
    variableType: VariableType.All,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '200',
    includeImage: false,
    includeMapped: false,
  });
  report(
    'vtAll 扫描（byte 200 命中 byteFlag）',
    s11.results.includes(base + BigInt(info.offsets.byteFlag)),
    `命中 ${st.resultCount} 个`,
  );
}

/* ---------- 12. 读取/写入内存 ---------- */
{
  const cur = proc.readMemoryExact(base + BigInt(info.offsets.health), 4);
  const v = cur.readInt32LE(0);
  report('跨进程读取 health = 1100', v === 1100, `读到 ${v}`);

  proc.writeMemory(base + BigInt(info.offsets.health), Buffer.from([0xe8, 0x03, 0x00, 0x00]));
  const back = proc.readMemoryExact(base + BigInt(info.offsets.health), 4);
  report('跨进程写入 health = 1000', back.readInt32LE(0) === 1000, `读回 ${back.readInt32LE(0)}`);
}

/* ---------- 13. 模块枚举 ---------- */
{
  const mods = proc.modules();
  report('枚举进程模块', mods.length > 0, `${mods.length} 个模块，首个=${mods[0]?.name}`);
}

console.log(`\n总耗时 ${Date.now() - t0}ms`);
proc.close();
fixture.stdin.write('quit\n');
setTimeout(() => fixture.kill(), 500);
}

main().catch((e) => {
  console.error('冒烟测试异常:', e);
  try { fixture.kill(); } catch {}
  process.exit(1);
});
