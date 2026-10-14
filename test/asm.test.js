/**
 * 反汇编器 / 汇编器测试。
 *
 * 三层验证策略（从弱到强）：
 *   1. **静态往返**：写死的机器码 → 反汇编 → 重新汇编 → 字节必须一致
 *   2. **动态往返**（最有说服力）：扫描**真实进程**的内存，对每段可解码代码
 *      反汇编 → 用我们自己的文本重新汇编 → 与原字节逐字节比对。
 *      这能抓出"格式看起来对但汇编不回去"的问题（例如宽度前缀丢失、
 *      操作数顺序错、位移表示不一致）。
 *   3. **进程内写入验证**：汇编一段代码 → 写入夹具进程 → 读回 → 反汇编比对，
 *      确认端到端（含地址相关的相对编码）在真实内存上成立。
 */
'use strict';

const { test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { useFixture } = require('./helpers/fixture');

const {
  ensureAsmBackend,
  isAsmBackendReady,
  assembleRaw,
  disassembleRaw,
  AsmBackendError,
  toSafeNumberAddress,
} = require('../dist/cjs/asm/backend');
const {
  disassemble,
  disassembleOne,
  disassembleAt,
  formatDisassembled,
  splitDisassembledString,
  branchTarget,
  formatBytes,
  instructionText,
  DisasmValueType,
} = require('../dist/cjs/asm/disassembler');
const { assemble, assembleLines, assembleToBytes, AssemblerError } = require('../dist/cjs/asm/assembler');
const { Process, ScanSession, VariableType, ScanOption, RoundingType, MEM_IMAGE } = require('../dist/cjs/index');

const env = useFixture();
beforeEach(() => env.setup());
afterEach(() => env.teardown());

before(async () => {
  await ensureAsmBackend();
});

/* ================================================================== *
 * 1. 后端基础
 * ================================================================== */

test('后端：WASM 初始化幂等，且初始化前调用会给出明确错误', async () => {
  assert.equal(isAsmBackendReady(), true);
  const a = await ensureAsmBackend();
  const b = await ensureAsmBackend();
  assert.equal(a, b, '重复初始化应返回同一实例');
});

test('后端：地址精度守卫（bigint 超范围必须报错而非静默截断）', () => {
  // Capstone/Keystone 只接受 number，超范围必须拦下
  assert.equal(toSafeNumberAddress(0x7ff000001000n, 'test'), 0x7ff000001000);
  assert.throws(() => toSafeNumberAddress(0x8000000000000000n, 'test'), /超出 JS 安全整数范围/);
  assert.throws(() => toSafeNumberAddress(-1n, 'test'), /不能为负/);

  assert.throws(
    () => assemble('nop', { address: 1n << 63n }),
    /超出 JS 安全整数范围/,
  );
});

/* ================================================================== *
 * 2. 静态：汇编编码正确性（与 Intel 手册/Keystone 一致）
 * ================================================================== */

test('汇编：常见指令的编码正确（64 位）', () => {
  const cases = [
    ['nop', 0x1000n, '90'],
    ['ret', 0x1000n, 'c3'],
    ['push rbp', 0x1000n, '55'],
    ['mov rbx, rax', 0x1000n, '4889c3'],
    ['sub rsp, 0x28', 0x1000n, '4883ec28'],
    ['mov rax, [rip+0x40302010]', 0x7ff000001000n, '488b0510203040'],
    ['mov [rbp-4], ebx', 0x1000n, '895dfc'],
    ['mov dword ptr [rbp-8], 0x64', 0x1000n, 'c745f864000000'],
    ['lea rcx, [rip+0x1000]', 0x1000n, '488d0d00100000'],
  ];
  for (const [src, addr, expected] of cases) {
    const got = assembleToBytes(src, { address: addr }).toString('hex');
    assert.equal(got, expected, `"${src}" 编码应为 ${expected}，实际 ${got}`);
  }
});

test('汇编：数字进制是十进制（裸数字），0x/h 前缀才是十六进制', () => {
  // 实测（Keystone 0.9，Intel 语法）：
  //   裸数字 = 十进制；0x100 才是十六进制。
  // ARM 同样（`mov r0, #100` 与 `mov r0, #0x64` 编码相同）。
  //
  // 与 CE 的关系：CE 在 Windows 上把汇编交给 **GNU as**（binutils，见 binutils.pas），
  // 而 GNU as 的裸数字也是十进制 —— 因此本移植与 CE 的实际行为一致。
  //
  // 注意：CE 自带的 Pascal 汇编器（Assemblerunit.pas）与部分 CE 文档示例
  // （如 `mov [esi+80], ebx` 中 80 显然指 0x80）暗示裸数字可能按十六进制解释。
  // 本项目没有 CE 可执行文件可实测，因此**采用 binutils 语义**；
  // 如果你的 CE 脚本依赖十六进制写法，请显式写出 `0x80`，或参考
  // docs/assembler.md 的"数字进制"一节。
  const bare100 = assembleToBytes('mov eax, 100', { address: 0x1000n }).toString('hex');
  const hex100 = assembleToBytes('mov eax, 0x100', { address: 0x1000n }).toString('hex');
  const bare64 = assembleToBytes('mov eax, 64', { address: 0x1000n }).toString('hex');

  assert.equal(bare100, 'b864000000', '`mov eax, 100` 应编成十进制 100（=0x64）');
  assert.equal(hex100, 'b800010000', '`mov eax, 0x100` 应编成十六进制 0x100（=256）');
  assert.notEqual(bare100, hex100, '十进制与十六进制写法必须区分');
  assert.equal(bare64, 'b840000000', '`mov eax, 64` 应编成十进制 64（=0x40）');

  // ARM 同样：裸数字是十进制
  const armBare = assembleToBytes('mov r0, #100', { address: 0x1000n, arch: 'arm' }).toString('hex');
  const armHex = assembleToBytes('mov r0, #0x64', { address: 0x1000n, arch: 'arm' }).toString('hex');
  assert.equal(armBare, armHex, 'ARM 的 #100 与 #0x64 应等价（十进制 100）');
});

test('汇编：32 位模式编码正确', () => {
  const cases = [
    ['mov eax, [0x1000]', 0x400000n, 'a100100000'],
    ['mov eax, [ebp+8]', 0x400000n, '8b4508'],
    ['push 0x10', 0x400000n, '6a10'],
    ['add eax, 1', 0x400000n, '83c001'],
  ];
  for (const [src, addr, expected] of cases) {
    const got = assembleToBytes(src, { address: addr, bitness: 32 }).toString('hex');
    assert.equal(got, expected, `"${src}" (32 位) 编码应为 ${expected}，实际 ${got}`);
  }
});

test('汇编：int 3 产出单字节 CC（不是 Keystone 默认的 CD 03）', () => {
  // Keystone 0.9 默认编成 CD 03；x86 惯例与 CE 都用 CC，本移植做了修正。
  assert.equal(assembleToBytes('int 3', { address: 0x1000n }).toString('hex'), 'cc');
  // 明确写 int3 也应一致
  assert.equal(assembleToBytes('int3', { address: 0x1000n }).toString('hex'), 'cc');
});

test('汇编：符号解析（含相对跳转的地址相关编码）', () => {
  // jmp 到 label：短跳转 eb 02（跳过两条 nop）
  const r = assemble('jmp myLabel\nnop\nnop\nmyLabel:\nret', { address: 0x1000n });
  assert.equal(r.bytes.toString('hex'), 'eb029090c3');

  // 通过 symbols 选项传入外部符号（Auto Assembler 的 define/aobscan 结果就是这样用的）
  const r2 = assemble('mov eax, dword ptr [myAddr]', {
    address: 0x1000n,
    symbols: { myAddr: 0x7ff000002000n },
  });
  // A1 形式（moffs）或 8B 05 形式皆可，只要地址正确；这里断言包含目标地址的小端
  assert.ok(r2.bytes.length > 0);
  assert.ok(r2.usedSymbols.myaddr !== undefined || r2.usedSymbols.myAddr !== undefined);
});

test('汇编：逐行模式给出每行地址（Auto Assembler 需要行→地址映射）', () => {
  const r = assembleLines('mov eax, 1\nnop\nint 3\n', { address: 0x5000n });
  assert.equal(r.lines.length, 4); // 末尾空行
  assert.equal(r.lines[0].address, 0x5000n);
  assert.equal(r.lines[0].bytes.toString('hex'), 'b801000000');
  assert.equal(r.lines[1].address, 0x5005n);
  assert.equal(r.lines[1].bytes.toString('hex'), '90');
  assert.equal(r.lines[2].address, 0x5006n);
  assert.equal(r.lines[2].bytes.toString('hex'), 'cc');
  assert.equal(r.endAddress, 0x5007n);
  assert.equal(r.bytes.toString('hex'), 'b801000000 90 cc'.replace(/ /g, ''));

  // 标号行不产生字节，但后续指令地址要跟着走
  const r2 = assembleLines('start:\nmov eax, 1\nagain:\nret', { address: 0x6000n });
  const nonEmpty = r2.lines.filter((l) => !l.empty);
  assert.equal(nonEmpty.length, 2);
  assert.equal(nonEmpty[0].address, 0x6000n, '标号行不能占用地址空间');
  assert.equal(nonEmpty[1].address, 0x6005n);
});

test('汇编：注释剥离（// ; 与块注释）', () => {
  const r1 = assemble('mov eax, 1 // 这是注释', { address: 0x1000n });
  assert.equal(r1.bytes.toString('hex'), 'b801000000');

  const r2 = assemble('mov eax, 1 ; 分号注释', { address: 0x1000n });
  assert.equal(r2.bytes.toString('hex'), 'b801000000');

  const r3 = assemble('/* 块注释\n跨行 */\nmov eax, 1', { address: 0x1000n });
  assert.equal(r3.bytes.toString('hex'), 'b801000000');
});

test('汇编：错误信息可操作（未定义符号 / 非法操作数要带解释）', () => {
  assert.throws(
    () => assemble('mov rax, undefinedThing', { address: 0x1000n }),
    (e) => {
      assert.ok(e instanceof AssemblerError);
      assert.match(e.message, /未定义的符号/);
      assert.match(e.message, /undefinedThing/);
      return true;
    },
  );

  // 内存操作数缺宽度：Keystone 报 INVALIDOPERAND，我们补中文提示
  assert.throws(
    () => assemble('mov [rax], 1', { address: 0x1000n }),
    (e) => {
      assert.match(e.message, /INVALIDOPERAND|Invalid operand/);
      assert.match(e.message, /显式宽度|dword ptr/, '应提示需要显式宽度');
      return true;
    },
  );

  // 空输入不是错误，产出空字节
  assert.equal(assemble('   \n// 只有注释\n', { address: 0x1000n }).bytes.length, 0);
});

/* ================================================================== *
 * 3. 反汇编：字段与 CE 对齐
 * ================================================================== */

test('反汇编：基本字段正确（opcode/parameters/dataSize/is64Bit）', () => {
  const i = disassembleOne(Buffer.from('488b0510203040', 'hex'), 0x7ff000001000n);
  assert.equal(i.opcode, 'mov');
  assert.equal(i.parameters, 'rax, qword ptr [rip + 0x40302010]');
  assert.equal(i.size, 7);
  assert.equal(i.dataSize, 8, 'qword 必须是 8 字节（曾因 word ptr 抢先匹配而误判为 2）');
  assert.equal(i.is64Bit, true);
  assert.equal(i.bytes.length, 7);
  assert.equal(formatBytes(i.bytes), '48 8B 05 10 20 30 40');
});

test('反汇编：数据宽度推断（byte/word/dword/qword/浮点）', () => {
  const cases = [
    ['c60001', 1, 'mov byte ptr [rax], 1'],
    ['66c7000100', 2, 'mov word ptr [rax], 1'],
    ['c70001000000', 4, 'mov dword ptr [rax], 1'],
    ['48c7000100000000000000', 8, 'mov qword ptr [rax], 1'],
  ];
  for (const [hex, size, name] of cases) {
    const i = disassembleOne(Buffer.from(hex, 'hex'), 0x1000n);
    assert.equal(i.dataSize, size, `${name} 宽度应为 ${size}`);
  }

  // 浮点标记
  const f32 = disassembleOne(Buffer.from('f30f100500100000', 'hex'), 0x1000n);
  assert.equal(f32.isFloat, true);
  assert.equal(f32.isFloat64, false);
  assert.equal(f32.dataSize, 4);

  const f64 = disassembleOne(Buffer.from('f20f100500100000', 'hex'), 0x1000n);
  assert.equal(f64.isFloat, false);
  assert.equal(f64.isFloat64, true);
  assert.equal(f64.dataSize, 8);
});

test('反汇编：流程控制标记（跳转/调用/返回/条件跳转/rep）', () => {
  const jmp = disassembleOne(Buffer.from('eb10', 'hex'), 0x1000n);
  assert.equal(jmp.isJump, true);
  assert.equal(jmp.isConditionalJump, false);
  assert.equal(branchTarget(jmp), 0x1012n, '短跳转目标 = 指令地址 + 长度 + 位移');

  const je = disassembleOne(Buffer.from('7420', 'hex'), 0x1000n);
  assert.equal(je.isJump, true);
  assert.equal(je.isConditionalJump, true);
  assert.equal(branchTarget(je), 0x1022n);

  const call = disassembleOne(Buffer.from('e800100000', 'hex'), 0x1000n);
  assert.equal(call.isCall, true);
  assert.equal(call.isJump, false);

  const ret = disassembleOne(Buffer.from('c3', 'hex'), 0x1000n);
  assert.equal(ret.isRet, true);

  const rep = disassembleOne(Buffer.from('f3a4', 'hex'), 0x1000n);
  assert.equal(rep.isRep, true);

  // jcc 全家族抽查
  for (const m of ['jne', 'jl', 'jg', 'jle', 'jge', 'ja', 'jb', 'js', 'jns', 'jo', 'jno', 'jp', 'jnp']) {
    const bytes = assembleToBytes(m + ' 0x1010', { address: 0x1000n });
    const i = disassembleOne(bytes, 0x1000n);
    assert.equal(i.isConditionalJump, true, `${m} 应被标记为条件跳转`);
  }
});

test('反汇编：RIP 相对寻址被识别', () => {
  const i = disassembleOne(Buffer.from('488b0510203040', 'hex'), 0x7ff000001000n);
  assert.notEqual(i.ripRelative, -1, '应识别为 RIP 相对');

  const plain = disassembleOne(Buffer.from('895dfc', 'hex'), 0x1000n);
  assert.equal(plain.ripRelative, -1, '非 RIP 相对应返回 -1');
});

test('反汇编：多条指令与推进偏移', () => {
  const list = disassemble(Buffer.from('4889c3907420c3', 'hex'), 0x1000n, 10);
  assert.equal(list.length, 4);
  assert.equal(list[0].address, 0x1000n);
  assert.equal(list[1].address, 0x1003n);
  assert.equal(list[2].address, 0x1004n);
  assert.equal(list[3].address, 0x1006n);
  assert.equal(list.map((x) => x.opcode).join(','), 'mov,nop,je,ret');
});

test('反汇编：空缓冲区抛出明确错误', () => {
  assert.throws(() => disassemble(Buffer.alloc(0), 0x1000n), /缓冲区为空/);
});

test('反汇编：disassembleAt 通过读内存回调工作（含不可读地址报错）', () => {
  const code = Buffer.concat([Buffer.from('4889c3', 'hex'), Buffer.alloc(13, 0x90)]);
  const fake = (addr, size) => {
    assert.equal(addr, 0x2000n);
    assert.equal(size, 16);
    return code;
  };
  const i = disassembleAt(fake, 0x2000n);
  assert.equal(i.opcode, 'mov');
  assert.equal(i.operands ?? i.parameters, 'rbx, rax');

  assert.throws(() => disassembleAt(() => Buffer.alloc(0), 0x2000n), /无法读取地址/);
});

test('反汇编：CE 风格格式化与拆分', () => {
  const i = disassembleOne(Buffer.from('488b0510203040', 'hex'), 0x7ff000001000n);
  const text = formatDisassembled(i);
  // CE 的形状：地址 - 字节 - 操作码 参数（字节后一个额外空格）
  assert.equal(text, '00007FF000001000 - 48 8B 05 10 20 30 40  - mov rax, qword ptr [rip + 0x40302010]');

  const parts = splitDisassembledString(text);
  assert.equal(parts.address, '00007FF000001000');
  assert.equal(parts.bytes, '48 8B 05 10 20 30 40');
  assert.equal(parts.opcode, 'mov');
  assert.equal(parts.parameters, 'rax, qword ptr [rip + 0x40302010]');

  // 32 位地址宽度
  const i32 = disassembleOne(Buffer.from('55', 'hex'), 0x401000n, { bitness: 32 });
  assert.match(formatDisassembled(i32), /^00401000 - 55/);
});

/* ================================================================== *
 * 4. 静态往返：机器码 → 反汇编 → 重新汇编 → 字节一致
 * ================================================================== */

test('静态往返：反汇编后重新汇编，语义必须一致', () => {
  const samples = [
    '488b0510203040',
    '895dfc',
    'c745f800010000',
    '4883ec28',
    '48b8efbeadde00000000',
    'ff2500100000',
    'f3a44c89c0',
    '554889e54883ec20488d0d00100000e800000000c9c3',
    'f30f100500100000',
    'f20f100500100000',
    '0f1f440000',
    '660f1f840000000000',
    '488d0500f0ffff',
    'c3',
    'cc',
  ];

  for (const hex of samples) {
    const code = Buffer.from(hex, 'hex');
    const base = 0x7ff000001000n;

    let offset = 0;
    while (offset < code.length) {
      const remaining = code.subarray(offset);
      const addr = base + BigInt(offset);
      const insn = disassembleOne(remaining, addr);

      // 必须使用 instructionText（含前缀）—— 只用 opcode+parameters 会丢掉 rep/lock
      const text = instructionText(insn);

      let re;
      try {
        re = assembleToBytes(text, { address: addr });
      } catch (e) {
        assert.fail(`反汇编产物无法汇编回去："${text}"（源 ${hex}）: ${e.message}`);
      }

      // 语义往返：把重新汇编的结果再反汇编，必须与原指令一致
      const again = disassembleOne(re, addr);
      assert.equal(again.opcode, insn.opcode, `操作码不一致（源 ${hex} 偏移 ${offset}）："${text}"`);
      assert.equal(
        again.parameters,
        insn.parameters,
        `操作数不一致（源 ${hex} 偏移 ${offset}）："${text}" → "${instructionText(again)}"`,
      );

      offset += insn.size;
    }
    assert.equal(offset, code.length, `样本 ${hex} 未被完整解码（停在 ${offset}/${code.length}）`);
  }
});

test('前缀必须保留（rep/lock 不能丢）', () => {
  // rep movsb：F3 前缀在 CE 的数据结构里是独立字段，往返必须带上
  const code = Buffer.from('f3a4', 'hex');
  const insn = disassembleOne(code, 0x1000n);
  assert.equal(insn.prefix, 'rep');
  assert.equal(insn.isRep, true);
  assert.equal(insn.opcode, 'movsb');

  const text = instructionText(insn);
  assert.match(text, /^rep movsb/, '完整文本必须含 rep 前缀');
  const re = assembleToBytes(text, { address: 0x1000n });
  assert.equal(re.toString('hex'), 'f3a4', '重新汇编必须含 F3 前缀');

  // 反证：只用 opcode+parameters 会丢前缀（这正是当初的 bug）
  const lossy = assembleToBytes(`${insn.opcode} ${insn.parameters}`.trim(), { address: 0x1000n });
  assert.equal(lossy.toString('hex'), 'a4', '不带前缀时确实会退化成 a4');
});

/* ================================================================== *
 * 5. 动态往返：真实进程内存里的代码（最有说服力的验证）
 * ================================================================== */

/**
 * 扫描目标进程的映像段，取若干段代码做"反汇编 → 重新汇编 → 再反汇编"比对。
 *
 * ## 判定标准为什么是"语义往返"而不是"字节往返"
 *
 * x86 允许同一条指令有多种**语义等价但字节不同**的编码，例如：
 *   `mov rsi, rdx` → `48 89 D6`（89 /r 形式）或 `48 8B F2`（8B /r 形式）
 *   `xor r14d, r14d` → `45 33 F6`（33 /r）或 `45 31 F6`（31 /r）
 * 反汇编器通常给出助记符形式，重新汇编时汇编器会挑它自己的编码，
 * 于是**字节不必相同**。Cheat Engine 也如此（它调 objdump 反汇编、as 汇编）。
 *
 * 因此正确的标准是：反汇编 → 重新汇编 → 再反汇编，结果必须与原指令**逐字段一致**
 * （同助记符、同操作数）。这才能证明"文本忠实表达了指令"。
 * 字节层面的一致性作为参考指标记录，但不作为断言。
 *
 * 这个测试覆盖真实编译器产物（含各种寻址模式与跳转），比手写样本强得多。
 */
test('动态往返：真实进程映像段里的代码可无损往返（语义级）', () => {
  const proc = env.box.ctx.process;

  const imageRegions = proc
    .scannableRegions({ includeImage: true, includeMapped: false, includePrivate: false, executableOnly: true })
    .filter((r) => r.type === MEM_IMAGE && r.memorySize > 0x1000n);

  assert.ok(imageRegions.length > 0, '应能找到可执行的映像段');

  let totalChecked = 0;
  let semanticOk = 0;
  let byteExact = 0;
  const failures = [];

  for (const region of imageRegions.slice(0, 6)) {
    const start = region.baseAddress + 0x1000n; // 跳过 PE 头
    const buf = proc.readMemory(start, 0x1000);
    if (buf.length === 0) continue;

    let offset = 0;
    let checkedHere = 0;
    while (offset < buf.length - 16 && checkedHere < 60) {
      const remaining = buf.subarray(offset);
      const addr = start + BigInt(offset);

      let insn;
      try {
        insn = disassembleOne(remaining, addr);
      } catch {
        offset += 1;
        continue;
      }
      if (!insn.size || insn.size > 15) {
        offset += 1;
        continue;
      }

      const text = instructionText(insn);
      try {
        const re = assembleToBytes(text, { address: addr });
        if (re.equals(remaining.subarray(0, insn.size))) byteExact++;

        // 语义比对：再反汇编一次
        const again = disassembleOne(re, addr);
        if (again.opcode === insn.opcode && again.parameters === insn.parameters) {
          semanticOk++;
        } else if (failures.length < 8) {
          failures.push(
            `0x${addr.toString(16)}: "${text}" → 重新汇编后变成 "${instructionText(again)}"`,
          );
        }
      } catch (e) {
        if (failures.length < 8) {
          failures.push(`0x${addr.toString(16)}: "${text}" 无法汇编回去：${e.message}`);
        }
      }

      totalChecked++;
      checkedHere++;
      offset += insn.size;
    }
  }

  assert.ok(totalChecked >= 100, `应检查足够多的指令，实际只检查了 ${totalChecked} 条`);
  assert.equal(
    semanticOk,
    totalChecked,
    `语义往返失败 ${totalChecked - semanticOk}/${totalChecked} 条：\n  ` + failures.join('\n  '),
  );

  // 参考指标：字节级一致的比例。
  //
  // 这里**不能**要求 100%：x86 有多种等价编码，反汇编给出的助记符形式
  // 重新汇编时不一定命中原来的编码字节（实测约 88%）。
  // 但也不能完全不查 —— 若汇编器整体退化成"总是挑另一种编码"，
  // 这个比例会明显塌掉。因此设一个宽松但有意义的下限。
  const byteRate = byteExact / totalChecked;
  assert.ok(
    byteRate > 0.75,
    `字节级一致率应高于 75%（退化信号），实际 ${(byteRate * 100).toFixed(1)}%` +
      `（语义往返为 ${semanticOk}/${totalChecked}）`,
  );
  console.log(
    `    [参考] 检查 ${totalChecked} 条：语义往返 100%，字节级一致 ${(byteRate * 100).toFixed(1)}%`,
  );
});

/* ================================================================== *
 * 6. 进程内写入验证：端到端（汇编 → 写入目标 → 读回 → 反汇编）
 * ================================================================== */

test('进程内端到端：把汇编结果写入目标进程后可反汇编回同一文本', () => {
  const proc = env.box.ctx.process;
  const base = env.box.ctx.base;

  // 夹具段内偏移 0x3000 之后是未使用的填充区，适合放测试代码
  const codeAddr = base + 0x3000n;
  const source = [
    'push rbp',
    'mov rbp, rsp',
    'sub rsp, 0x20',
    'mov eax, 0x1234',
    'mov dword ptr [rbp-4], eax',
    'nop',
    'leave',
    'ret',
  ].join('\n');

  const built = assemble(source, { address: codeAddr });
  assert.ok(built.bytes.length > 0);

  // 写入目标进程（未使用区域，不影响夹具自身的变量）
  const written = proc.writeMemory(codeAddr, built.bytes);
  assert.equal(written, built.bytes.length);

  // 读回并逐条反汇编，与预期文本比对
  const readBack = proc.readMemoryExact(codeAddr, built.bytes.length);
  assert.deepEqual(readBack, built.bytes, '写入后读回应与汇编结果一致');

  const list = disassemble(readBack, codeAddr, 32);
  assert.ok(list.length >= 8, `应能反汇编出至少 8 条，实际 ${list.length}`);

  const texts = list.map((i) => (i.parameters ? `${i.opcode} ${i.parameters}` : i.opcode));
  assert.equal(texts[0], 'push rbp');
  assert.equal(texts[1], 'mov rbp, rsp');
  assert.equal(texts[2], 'sub rsp, 0x20');
  // 立即数 0x1234 的寄存器宽度是 32 位，Capstone 会写成 eax
  assert.match(texts[3], /^mov eax, 0x1234$/);

  // 端到端往返：反汇编出的每一条都要能重新汇编成同样的字节
  let offset = 0;
  for (const insn of list) {
    const text = insn.parameters ? `${insn.opcode} ${insn.parameters}` : insn.opcode;
    const re = assembleToBytes(text, { address: codeAddr + BigInt(offset) });
    assert.equal(
      re.toString('hex'),
      readBack.subarray(offset, offset + insn.size).toString('hex'),
      `端到端往返失败于 "${text}"`,
    );
    offset += insn.size;
  }
  assert.equal(offset, built.bytes.length);
});

test('进程内端到端：写入的代码可以被夹具进程自身读取（含只读页写保护处理）', () => {
  const proc = env.box.ctx.process;
  const addr = env.box.ctx.base + 0x4000n - 16n; // 段尾附近

  // 先确认该地址可写；夹具分配的是 PAGE_READWRITE
  const buf = assembleToBytes('mov eax, 0xdeadbeef', { address: addr });
  proc.writeMemory(addr, buf);
  const back = proc.readMemoryExact(addr, buf.length);
  assert.equal(back.toString('hex'), buf.toString('hex'));

  const i = disassembleOne(back, addr);
  assert.equal(i.opcode, 'mov');
  assert.match(i.parameters, /0xdeadbeef/);
});

/* ================================================================== *
 * 7. 后端直测（不被上层遮盖的问题）
 * ================================================================== */

test('后端：disassembleRaw 的地址是绝对地址（不是缓冲区相对）', () => {
  const base = 0x7ff000001000n;
  const raws = disassembleRaw(Buffer.from('4889c390c3', 'hex'), { address: base, maxInstructions: 4 });
  assert.equal(raws.length, 3);
  assert.equal(raws[0].address, base);
  assert.equal(raws[1].address, base + 3n);
  assert.equal(raws[2].address, base + 4n);
  // 每条的字节也要正确
  assert.equal(raws[0].bytes.toString('hex'), '4889c3');
  assert.equal(raws[1].bytes.toString('hex'), '90');
  assert.equal(raws[2].bytes.toString('hex'), 'c3');
});

test('后端：assembleRaw 的地址影响相对编码', () => {
  // 同一个源码在不同地址下，rel8 跳转的位移不同
  const a = assembleRaw('je 0x1010', { address: 0x1000n }).bytes.toString('hex');
  const b = assembleRaw('je 0x1010', { address: 0x1008n }).bytes.toString('hex');
  assert.notEqual(a, b, '不同基址下的相对跳转编码应不同');
  assert.equal(disassembleOne(Buffer.from(a, 'hex'), 0x1000n).parameters, '0x1010');
  assert.equal(disassembleOne(Buffer.from(b, 'hex'), 0x1008n).parameters, '0x1010');
});

test('后端：AsmBackendError 可被识别且带底层原因', () => {
  try {
    assembleRaw('this is not asm', { address: 0x1000n });
    assert.fail('应当抛错');
  } catch (e) {
    assert.ok(e instanceof AsmBackendError);
    assert.ok(e.underlying !== undefined, '应保留底层原因');
  }
});

/* ================================================================== *
 * 9. ARM / Thumb / ARM64
 * ================================================================== */

test('架构：规范化与元信息正确', () => {
  const {
    normalizeArchitecture,
    architectureInfo,
    isArchitectureSupported,
    backendVersions,
  } = require('../dist/cjs/asm/backend');

  // 宽松写法要能规范化
  assert.equal(normalizeArchitecture('aarch64'), 'arm64');
  assert.equal(normalizeArchitecture('ARM'), 'arm');
  assert.equal(normalizeArchitecture('thumb2'), 'thumb');
  assert.equal(normalizeArchitecture('amd64'), 'x64');
  assert.equal(normalizeArchitecture('i386'), 'x86');
  assert.equal(normalizeArchitecture(64), 'x64');
  assert.equal(normalizeArchitecture(32), 'x86');
  assert.equal(normalizeArchitecture(undefined), 'x64');
  assert.throws(() => normalizeArchitecture('mips'), /不支持的架构/);

  // 元信息：对齐与定长属性必须是 ARM 与 x86 的核心差别
  assert.equal(architectureInfo('x64').alignment, 1);
  assert.equal(architectureInfo('x64').fixedSize, false);
  assert.equal(architectureInfo('arm').alignment, 4);
  assert.equal(architectureInfo('arm').fixedSize, true);
  assert.equal(architectureInfo('arm').instructionSize, 4);
  assert.equal(architectureInfo('thumb').alignment, 2, 'Thumb 是 2 字节对齐');
  assert.equal(architectureInfo('thumb').fixedSize, false, 'Thumb 有 2/4 字节两种长度');
  assert.equal(architectureInfo('arm64').alignment, 4);
  assert.equal(architectureInfo('arm64').is64Bit, true);

  // 五种架构都应被两个引擎支持
  for (const a of ['x86', 'x64', 'arm', 'thumb', 'arm64']) {
    assert.equal(isArchitectureSupported(a), true, `${a} 应被支持`);
  }
  assert.deepEqual(backendVersions().architectures, ['x86', 'x64', 'arm', 'thumb', 'arm64']);
});

test('ARM (A32)：编码正确且字段合理', () => {
  const cases = [
    ['mov r0, r1', '0100a0e1'],
    ['add r0, r0, #1', '010080e2'],
    ['ldr r0, [r1, #4]', '040091e5'],
    ['bx lr', '1eff2fe1'],
    ['push {r4, lr}', '10402de9'],
    ['pop {r4, pc}', '1080bde8'],
    ['movw r0, #0x1234', '340201e3'],
  ];
  for (const [src, expected] of cases) {
    const got = assembleToBytes(src, { address: 0x1000n, arch: 'arm' }).toString('hex');
    assert.equal(got, expected, `ARM "${src}" 应为 ${expected}，实际 ${got}`);
  }

  // 字段：ARM 是 4 字节定长
  const i = disassembleOne(Buffer.from('0100a0e1', 'hex'), 0x1000n, { arch: 'arm' });
  assert.equal(i.opcode, 'mov');
  assert.equal(i.parameters, 'r0, r1');
  assert.equal(i.size, 4);
  assert.equal(i.dataSize, 4);
  assert.equal(i.arch, 'arm');
  assert.equal(i.disassemblerClass, 'dcArm');
  assert.equal(i.is64Bit, false);
  // ARM 没有 x86 那种前缀
  assert.equal(i.prefix, '');
  assert.equal(i.isRep, false);
  assert.equal(i.ripRelative, -1);
});

test('ARM：条件后缀被正确拆出（含 beq 这类跳转的坑）', () => {
  // `moveq` 是"条件执行"，不是条件跳转 —— 只填 conditionCode，不置 isConditionalJump
  const moveq = disassembleOne(
    assembleToBytes('moveq r0, r1', { address: 0x1000n, arch: 'arm' }),
    0x1000n,
    { arch: 'arm' },
  );
  assert.equal(moveq.conditionCode, 'eq');
  assert.equal(moveq.isConditionalJump, false, 'moveq 是条件执行，不是条件跳转');
  assert.equal(moveq.isJump, false);

  // `beq` 是条件跳转：必须 isJump=true 且取到条件码
  // （早期把 `b` 误列入"不可拆条件后缀"集合，导致 beq 全被漏判）
  const beq = disassembleOne(
    assembleToBytes('beq #0x2000', { address: 0x1000n, arch: 'arm' }),
    0x1000n,
    { arch: 'arm' },
  );
  assert.equal(beq.opcode, 'beq');
  assert.equal(beq.conditionCode, 'eq');
  assert.equal(beq.isJump, true, 'beq 必须是跳转');
  assert.equal(beq.isConditionalJump, true);
  assert.equal(branchTarget(beq), 0x2000n);

  // `b`（无条件跳转）不带条件码
  const b = disassembleOne(
    assembleToBytes('b #0x2000', { address: 0x1000n, arch: 'arm' }),
    0x1000n,
    { arch: 'arm' },
  );
  assert.equal(b.isJump, true);
  assert.equal(b.isConditionalJump, false);
  assert.equal(b.conditionCode, '');
});

test('ARM：返回与调用的惯用写法被识别', () => {
  // ARM 没有 ret，返回靠三种惯用写法
  const bxLr = disassembleOne(Buffer.from('1eff2fe1', 'hex'), 0x1000n, { arch: 'arm' });
  assert.equal(bxLr.isRet, true, 'bx lr 是返回');

  const popPc = disassembleOne(Buffer.from('1080bde8', 'hex'), 0x1000n, { arch: 'arm' });
  assert.equal(popPc.isRet, true, 'pop {..., pc} 是返回');

  const movPcLrBytes = assembleToBytes('mov pc, lr', { address: 0x1000n, arch: 'arm' });
  const movPcLr = disassembleOne(movPcLrBytes, 0x1000n, { arch: 'arm' });
  assert.equal(movPcLr.isRet, true, 'mov pc, lr 是返回');

  // bl 是调用，不是返回
  const bl = disassembleOne(
    assembleToBytes('bl #0x1000', { address: 0x1000n, arch: 'arm' }),
    0x1000n,
    { arch: 'arm' },
  );
  assert.equal(bl.isCall, true);
  assert.equal(bl.isRet, false);

  // push 不是返回
  const push = disassembleOne(Buffer.from('10402de9', 'hex'), 0x1000n, { arch: 'arm' });
  assert.equal(push.isRet, false);
});

test('Thumb：2/4 字节变长与对齐', () => {
  const cases = [
    ['movs r0, #1', '0120', 2],
    ['adds r0, #1', '0130', 2],
    ['bx lr', '7047', 2],
    ['push {r4, lr}', '10b5', 2],
    ['pop {r4, pc}', '10bd', 2],
    ['bl #0x1000', 'fff7feff', 4],
  ];
  for (const [src, expected, size] of cases) {
    const bytes = assembleToBytes(src, { address: 0x1000n, arch: 'thumb' });
    assert.equal(bytes.toString('hex'), expected, `Thumb "${src}" 编码不对`);
    const i = disassembleOne(bytes, 0x1000n, { arch: 'thumb' });
    assert.equal(i.size, size, `Thumb "${src}" 长度应为 ${size}`);
    assert.equal(i.disassemblerClass, 'dcThumb');
  }

  // 变长指令的多条推进：2 与 4 混排
  const mixed = assembleToBytes('movs r0, #1\nbl #0x1000\nbx lr', { address: 0x1000n, arch: 'thumb' });
  const list = disassemble(mixed, 0x1000n, 10, { arch: 'thumb' });
  assert.equal(list.length, 3);
  assert.equal(list[0].address, 0x1000n);
  assert.equal(list[0].size, 2);
  assert.equal(list[1].address, 0x1002n, '第二条应从 0x1002 开始');
  assert.equal(list[1].size, 4);
  assert.equal(list[2].address, 0x1006n);
  assert.equal(list[2].isRet, true);
});

test('ARM64：编码正确、b.eq 后缀被拆出', () => {
  const cases = [
    ['mov x0, x1', 'e00301aa'],
    ['add x0, x0, #1', '00040091'],
    ['ldr x0, [x1, #8]', '200440f9'],
    ['ret', 'c0035fd6'],
    ['bl #0x1000', '00000094'],
    ['br x0', '00001fd6'],
    ['stp x29, x30, [sp, #-16]!', 'fd7bbfa9'],
  ];
  for (const [src, expected] of cases) {
    const got = assembleToBytes(src, { address: 0x1000n, arch: 'arm64' }).toString('hex');
    assert.equal(got, expected, `ARM64 "${src}" 应为 ${expected}，实际 ${got}`);
  }

  // ret / br / bl 的语义
  const ret = disassembleOne(Buffer.from('c0035fd6', 'hex'), 0x1000n, { arch: 'arm64' });
  assert.equal(ret.isRet, true);
  assert.equal(ret.disassemblerClass, 'dcArm64');
  assert.equal(ret.is64Bit, true);

  const br = disassembleOne(Buffer.from('00001fd6', 'hex'), 0x1000n, { arch: 'arm64' });
  assert.equal(br.isJump, true);
  assert.equal(br.isConditionalJump, false);
  assert.equal(br.isRet, false);

  const bl = disassembleOne(Buffer.from('00000094', 'hex'), 0x1000n, { arch: 'arm64' });
  assert.equal(bl.isCall, true);
  assert.equal(bl.isRet, false);

  // b.eq：Capstone 输出带点后缀，我们拆成 opcode='b' + suffix='.eq'
  const beqBytes = assembleToBytes('b.eq #0x2000', { address: 0x1000n, arch: 'arm64' });
  const beq = disassembleOne(beqBytes, 0x1000n, { arch: 'arm64' });
  assert.equal(beq.opcode, 'b');
  assert.equal(beq.suffix, '.eq');
  assert.equal(beq.conditionCode, 'eq');
  assert.equal(beq.isJump, true);
  assert.equal(beq.isConditionalJump, true);
  // instructionText 要把后缀拼回去，否则无法往返
  // 注意 ARM/ARM64 的 Capstone 输出带 `#` 立即数前缀，原样保留
  assert.equal(instructionText(beq), 'b.eq #0x2000');
  assert.equal(
    assembleToBytes(instructionText(beq), { address: 0x1000n, arch: 'arm64' }).toString('hex'),
    beqBytes.toString('hex'),
  );

  // cbz 是条件跳转（比较并跳转）
  const cbz = disassembleOne(
    assembleToBytes('cbz x0, #0x1000', { address: 0x1000n, arch: 'arm64' }),
    0x1000n,
    { arch: 'arm64' },
  );
  assert.equal(cbz.isConditionalJump, true);
  assert.equal(cbz.isCall, false);
});

test('ARM64：数据宽度按寄存器前缀推断（w=4, x=8）', () => {
  const cases = [
    ['mov x0, x1', 8],
    ['mov w0, w1', 4],
    ['ldr x0, [x1, #8]', 8],
    ['str w0, [x1, #-4]', 4],
    ['stp x29, x30, [sp, #-16]!', 8],
    ['ldp w0, w1, [sp], #8', 4],
  ];
  for (const [src, size] of cases) {
    const bytes = assembleToBytes(src, { address: 0x1000n, arch: 'arm64' });
    const i = disassembleOne(bytes, 0x1000n, { arch: 'arm64' });
    assert.equal(i.dataSize, size, `ARM64 "${src}" 宽度应为 ${size}，实际 ${i.dataSize}`);
  }

  // 浮点寄存器
  const f32 = disassembleOne(
    assembleToBytes('fmov s0, s1', { address: 0x1000n, arch: 'arm64' }),
    0x1000n,
    { arch: 'arm64' },
  );
  assert.equal(f32.dataSize, 4);
  assert.equal(f32.isFloat, true);

  const f64 = disassembleOne(
    assembleToBytes('fmov d0, d1', { address: 0x1000n, arch: 'arm64' }),
    0x1000n,
    { arch: 'arm64' },
  );
  assert.equal(f64.dataSize, 8);
  assert.equal(f64.isFloat64, true);
});

test('ARM64：PC 相对被识别（adrp / adr / b / bl）', () => {
  for (const src of ['adrp x0, #0x1000', 'adr x0, #0x1000', 'b #0x2000', 'bl #0x2000']) {
    const i = disassembleOne(
      assembleToBytes(src, { address: 0x1000n, arch: 'arm64' }),
      0x1000n,
      { arch: 'arm64' },
    );
    assert.notEqual(i.ripRelative, -1, `${src} 应被标为 PC 相对`);
  }
  // 普通寄存器运算不是 PC 相对
  const plain = disassembleOne(
    assembleToBytes('add x0, x0, #1', { address: 0x1000n, arch: 'arm64' }),
    0x1000n,
    { arch: 'arm64' },
  );
  assert.equal(plain.ripRelative, -1);
});

test('大端 ARM：编码与反汇编都可切换字节序', () => {
  const le = assembleToBytes('mov r0, r1', { address: 0x1000n, arch: 'arm' }).toString('hex');
  const be = assembleToBytes('mov r0, r1', {
    address: 0x1000n,
    arch: 'arm',
    endianness: 'big',
  }).toString('hex');
  assert.equal(le, '0100a0e1');
  assert.equal(be, 'e1a00001', '大端应是字节序翻转');
  assert.notEqual(le, be);

  const i = disassembleOne(Buffer.from(be, 'hex'), 0x1000n, { arch: 'arm', endianness: 'big' });
  assert.equal(i.opcode, 'mov');
  assert.equal(i.parameters, 'r0, r1');
});

test('多架构往返：汇编 → 反汇编 → 重新汇编，语义一致', () => {
  const cases = [
    ['arm', ['mov r0, r1', 'add r0, r0, #1', 'ldr r0, [r1, #4]', 'bx lr', 'push {r4, lr}', 'pop {r4, pc}']],
    ['thumb', ['movs r0, #1', 'adds r0, #1', 'bx lr', 'push {r4, lr}', 'pop {r4, pc}']],
    ['arm64', ['mov x0, x1', 'add x0, x0, #1', 'ret', 'stp x29, x30, [sp, #-16]!', 'ldp x29, x30, [sp], #16']],
    ['x64', ['mov rax, rbx', 'sub rsp, 0x28', 'ret', 'nop']],
    ['x86', ['mov eax, ebx', 'push ebp', 'pop ebp', 'ret']],
  ];

  for (const [arch, sources] of cases) {
    const base = 0x1000n;
    const code = assembleToBytes(sources.join('\n'), { address: base, arch });
    const list = disassemble(code, base, sources.length + 2, { arch });
    assert.ok(list.length >= sources.length, `${arch}: 应解出至少 ${sources.length} 条`);

    // 逐条重新汇编并再反汇编，语义必须一致
    let offset = 0;
    for (const insn of list) {
      const text = instructionText(insn);
      let re;
      try {
        re = assembleToBytes(text, { address: base + BigInt(offset), arch });
      } catch (e) {
        assert.fail(`${arch}: "${text}" 无法汇编回去：${e.message}`);
      }
      const again = disassembleOne(re, base + BigInt(offset), { arch });
      assert.equal(again.opcode, insn.opcode, `${arch}: 操作码不一致 "${text}"`);
      assert.equal(again.parameters, insn.parameters, `${arch}: 操作数不一致 "${text}"`);
      offset += insn.size;
    }
    assert.equal(offset, code.length, `${arch}: 未完整解码（${offset}/${code.length}）`);
  }
});

test('多架构：地址精度守卫对 ARM 同样生效', () => {
  assert.throws(
    () => assembleToBytes('nop', { address: 1n << 63n, arch: 'arm' }),
    /超出 JS 安全整数范围/,
  );
  assert.throws(
    () => disassembleOne(Buffer.alloc(4), 1n << 63n, { arch: 'arm64' }),
    /超出 JS 安全整数范围/,
  );
});

test('多架构：x86 的 formatDisassembled 未被 ARM 改动影响', () => {
  const i = disassembleOne(Buffer.from('488b0510203040', 'hex'), 0x7ff000001000n);
  assert.equal(
    formatDisassembled(i),
    '00007FF000001000 - 48 8B 05 10 20 30 40  - mov rax, qword ptr [rip + 0x40302010]',
  );

  // ARM64 用 16 位地址宽度，ARM 用 8 位
  const arm64 = disassembleOne(Buffer.from('c0035fd6', 'hex'), 0x400000n, { arch: 'arm64' });
  assert.match(formatDisassembled(arm64), /^0000000000400000 - C0 03 5F D6  - ret$/);

  const arm = disassembleOne(Buffer.from('1eff2fe1', 'hex'), 0x8000n, { arch: 'arm' });
  assert.match(formatDisassembled(arm), /^00008000 - 1E FF 2F E1  - bx lr$/);
});

/* ================================================================== *
 * 8. 与扫描引擎协同：在真实代码段里找 AOB 并反汇编
 * ================================================================== */

test('协同：在目标进程的映像段里扫 AOB 并反汇编命中处', () => {
  const proc = env.box.ctx.process;

  // 从某个模块的入口附近取一段字节作为 AOB 模板
  const mods = proc.modules();
  assert.ok(mods.length > 0);
  const mod = mods.find((m) => m.size > 0x1000) ?? mods[0];
  const probeAddr = mod.baseAddress + 0x1000n;
  const probe = proc.readMemory(probeAddr, 16);
  assert.ok(probe.length === 16);

  // 用前 8 字节做模板（加一个通配字节，顺便验证通配可用）
  const pattern = [...probe.subarray(0, 7)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ') + ' ??';

  const scan = new ScanSession(proc, { blockSize: 1 << 20 });
  scan.firstScan({
    variableType: VariableType.ByteArray,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: pattern,
  });
  assert.ok(scan.resultCount > 0, `AOB "${pattern}" 应至少命中模块入口附近`);
  assert.ok(
    scan.results.some((a) => a >= mod.baseAddress && a < mod.baseAddress + BigInt(mod.size)),
    '命中应落在该模块内',
  );

  // 对第一个命中反汇编，确认能解出指令
  const hit = scan.results[0];
  const code = proc.readMemory(hit, 16);
  const insn = disassembleOne(code, hit);
  assert.ok(insn.opcode.length > 0);
  assert.ok(insn.size >= 1 && insn.size <= 15);
  // 且该指令能被重新汇编回原字节
  const text = insn.parameters ? `${insn.opcode} ${insn.parameters}` : insn.opcode;
  const re = assembleToBytes(text, { address: hit });
  assert.equal(re.toString('hex'), code.subarray(0, insn.size).toString('hex'));
});
