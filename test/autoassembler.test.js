/**
 * Auto Assembler 测试 —— 全部在**真实跨进程**条件下运行（夹具见 test/fixture-target.js）。
 *
 * 覆盖：
 *   1. 纯函数：CE 数字解析、db/dw/dd/dq、多字节 nop、align
 *   2. 脚本解析与汇编（syntaxCheckOnly，无目标进程）
 *   3. 跨进程执行：aobscan / alloc / label / 写码 / [ENABLE]-[DISABLE] 往返还原 /
 *      define 常量替换 / readmem / db ?? / assert / createthread 参数校验 / 错误行号
 */
'use strict';

const { describe, test, beforeEach, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { useFixture } = require('./helpers/fixture');

const { ensureAsmBackend } = require('../dist/cjs/asm/backend');
const { disassemble } = require('../dist/cjs/asm/disassembler');
const { assemble, assembleToBytes } = require('../dist/cjs/asm/assembler');
const { AutoAssembler, AutoAssemblerError, autoAssemble } = require('../dist/cjs/asm/autoassembler');
const {
  parseCeInteger,
  encodeNop,
  encodeAlign,
  encodeDataDirective,
  splitDirectiveArguments,
  parsePseudoDirective,
} = require('../dist/cjs/asm/autoassembler-directives');

/* ------------------------------------------------------------------ *
 * 公共工具
 * ------------------------------------------------------------------ */

/** 十六进制字面量（脚本里直接写 0x... 即可） */
const hex = (value) => '0x' + value.toString(16);

/** 生成「把 value（32 位）写到 addr」的脚本段（ENABLE 用 db，便于逐字节断言） */
function dbScript(address, bytesHex) {
  return `${hex(address)}:\n  db ${bytesHex}\n`;
}

const env = useFixture();
const proc = () => env.box.ctx.process;
const base = () => env.box.ctx.base;
const L = () => env.box.ctx.info.offsets;

before(async () => {
  await ensureAsmBackend();
});

/* ================================================================== *
 * 1. 纯函数
 * ================================================================== */

describe('纯函数：CE 数字解析与伪指令编码', () => {
  test('parseCeInteger 复刻 CE 的 HexStrToInt（裸数字 = 十六进制）', () => {
    assert.equal(parseCeInteger('90'), 0x90n);
    assert.equal(parseCeInteger('FF'), 0xffn);
    assert.equal(parseCeInteger('ff'), 0xffn);
    assert.equal(parseCeInteger('#1000'), 1000n, '# 前缀是十进制');
    assert.equal(parseCeInteger('0x10'), 16n);
    assert.equal(parseCeInteger('$10'), 16n);
    assert.equal(parseCeInteger('-10'), -0x10n);
    assert.equal(parseCeInteger('+10'), 0x10n);
    assert.equal(parseCeInteger('10', false), 10n, 'hexDefault=false 时裸数字按十进制');
    assert.equal(parseCeInteger('zz'), null);
    assert.equal(parseCeInteger(''), null);
    assert.equal(parseCeInteger('#xx'), null);
  });

  test('encodeNop 使用 CE 的多字节 NOP 表', () => {
    assert.equal(encodeNop(0).toString('hex'), '');
    assert.equal(encodeNop(1).toString('hex'), '90');
    assert.equal(encodeNop(2).toString('hex'), '6690');
    assert.equal(encodeNop(3).toString('hex'), '0f1f00');
    assert.equal(encodeNop(4).toString('hex'), '0f1f4000');
    assert.equal(encodeNop(5).toString('hex'), '0f1f440000');
    assert.equal(encodeNop(9).toString('hex'), '660f1f840000000000');
    // 10 = 9 + 1
    assert.equal(encodeNop(10).toString('hex'), '660f1f840000000000' + '90');
    assert.equal(encodeNop(10).length, 10);
    assert.equal(encodeNop(64).length, 64);
  });

  test('encodeAlign 填充到对齐边界（默认填 0，可指定填充字节）', () => {
    assert.equal(encodeAlign(0x1000n, 16n).length, 0, '已对齐时不填充');
    assert.equal(encodeAlign(0x1005n, 16n).toString('hex'), '00'.repeat(11));
    assert.equal(encodeAlign(0x1005n, 16n, 0x90).toString('hex'), '90'.repeat(11));
    assert.equal(encodeAlign(0x1001n, 8n).length, 7);
    assert.throws(() => encodeAlign(0n, 0n), /对齐值必须为正数/);
  });

  test('encodeDataDirective：db/dw/dd/dq（裸数字十六进制，与 CE 一致）', () => {
    const ctx = { address: 0x1000n };
    assert.equal(encodeDataDirective('db', '90 90', ctx).bytes.toString('hex'), '9090');
    assert.equal(encodeDataDirective('db', "'AB'", ctx).bytes.toString('hex'), '4142');
    assert.equal(encodeDataDirective('db', "'A,B'", ctx).bytes.toString('hex'), '412c42');
    assert.equal(encodeDataDirective('dw', "'AB'", ctx).bytes.toString('hex'), '41004200');
    assert.equal(encodeDataDirective('dd', '12345678', ctx).bytes.toString('hex'), '78563412');
    assert.equal(encodeDataDirective('dq', '1', ctx).bytes.toString('hex'), '0100000000000000');
    assert.equal(encodeDataDirective('db', '#255', ctx).bytes.toString('hex'), 'ff');
    // 负数按位宽回绕
    assert.equal(encodeDataDirective('db', '-1', ctx).bytes.toString('hex'), 'ff');
    assert.throws(() => encodeDataDirective('db', 'zz', ctx), /无法解析参数/);
    assert.throws(() => encodeDataDirective('dd', "'AB'", ctx), /不支持字符串/);
  });

  test('encodeDataDirective：通配 ?? 读目标进程原字节，+N 做相对调整', () => {
    const memory = new Map([
      [0x2000n, 0x11],
      [0x2001n, 0x22],
      [0x2002n, 0x33],
    ]);
    const ctx = {
      address: 0x2000n,
      readByte: (addr) => (memory.has(addr) ? memory.get(addr) : null),
    };
    assert.equal(encodeDataDirective('db', '?? ?? ??', ctx).bytes.toString('hex'), '112233');
    assert.equal(encodeDataDirective('db', '+2', ctx).bytes.toString('hex'), '13', '0x11 + 2');
    assert.equal(encodeDataDirective('db', '-1', ctx).bytes.toString('hex'), '10');
    // 没有目标进程时退化为 0 并给出警告
    const noProc = encodeDataDirective('db', '??', { address: 0x2000n });
    assert.equal(noProc.bytes.toString('hex'), '00');
    assert.equal(noProc.warnings.length, 1);
  });

  test('参数切分与伪指令识别', () => {
    assert.deepEqual(splitDirectiveArguments("90 90, 'a b',ff"), ['90', '90', "'a b'", 'ff']);
    assert.deepEqual(parsePseudoDirective('db 90 90'), { kind: 'db', args: '90 90' });
    assert.deepEqual(parsePseudoDirective('nop 5'), { kind: 'nop', args: '5' });
    assert.equal(parsePseudoDirective('nop'), null, '裸 nop 交给汇编器');
    assert.equal(
      parsePseudoDirective('nop dword ptr [rax]'),
      null,
      'nop 后面不是数字时应回退给汇编器（CE 也是这么做的）',
    );
    assert.deepEqual(parsePseudoDirective('align 10, 90'), { kind: 'align', args: '10, 90' });
    assert.equal(parsePseudoDirective('mov eax, 1'), null);
  });
});

/* ================================================================== *
 * 2. 脚本解析与汇编（无目标进程 = syntaxCheckOnly）
 * ================================================================== */

describe('脚本解析与汇编（syntaxCheckOnly）', () => {
  const mem = (addr) => ({ startAddress: addr });

  test('db / nop N / align 在同一段里顺序排布，地址连续', () => {
    const aa = new AutoAssembler(mem(0x1000n));
    const result = aa.check(
      [
        'db 90 90', //          0x1000, 2 字节
        "db 'AB'", //           0x1002, 2 字节
        'nop 5', //             0x1004, 5 字节
        'db 41', //             0x1009, 1 字节
        'align 10, 90', //      0x100A 对齐到 0x1010 → 填 6 个 0x90
        'db 42', //             0x1010
      ].join('\n'),
    );

    const texts = result.lines.map((l) => [l.text, l.address, l.bytes.toString('hex')]);
    assert.deepEqual(texts[0], ['db 90 90', 0x1000n, '9090']);
    assert.deepEqual(texts[1], ["db 'AB'", 0x1002n, '4142']);
    assert.deepEqual(texts[2], ['nop 5', 0x1004n, '0f1f440000']);
    assert.deepEqual(texts[4], ['align 10, 90', 0x100an, '90'.repeat(6)]);
    assert.deepEqual(texts[5], ['db 42', 0x1010n, '42']);
  });

  test('注释：// ; /* */ 与 { } 都能处理，且不误伤字符串里的分号', () => {
    const aa = new AutoAssembler(mem(0x1000n));
    const result = aa.check(
      [
        '// 整行注释',
        'db 90 ; 分号行尾注释',
        'db 91 // 双斜线行尾注释',
        '/* 块注释',
        '   还在块里 */',
        'db 92',
        'db 93 /* 行内块注释 */',
        '{ 花括号注释 }',
        'db 94',
        "db 'a;b' ; 字符串里的分号不能被吃掉",
      ].join('\n'),
    );

    const hexes = result.lines.filter((l) => l.bytes.length > 0).map((l) => l.bytes.toString('hex'));
    assert.deepEqual(hexes, ['90', '91', '92', '93', '94', '613b62']);
  });

  test('[ENABLE]/[DISABLE] 分段：外层代码两边都执行，段内代码各归各的', () => {
    const aa = new AutoAssembler(mem(0x1000n));
    const script = [
      'db 11', //            外层：两边都执行
      '[ENABLE]',
      'db 22', //            enable 专属
      '[DISABLE]',
      'db 33', //            disable 专属
    ].join('\n');

    const enabled = aa.autoAssemble(script, { enable: true, syntaxCheckOnly: true });
    assert.deepEqual(enabled.lines.map((l) => l.bytes.toString('hex')), ['11', '22']);

    const disabled = aa.autoAssemble(script, { enable: false, syntaxCheckOnly: true });
    assert.deepEqual(disabled.lines.map((l) => l.bytes.toString('hex')), ['11', '33']);
    assert.equal(disabled.sections.enableLine, 2);
    assert.equal(disabled.sections.disableLine, 4);
  });

  test('label + registersymbol 放前放后都能解析（registersymbol 延后到布局之后）', () => {
    const aa = new AutoAssembler(mem(0x1000n));
    const result = aa.check(
      [
        'label(skiplabel)',
        'registersymbol(skiplabel)', // 此时标签还没定义
        'start:',
        '  jmp skiplabel',
        '  nop',
        'skiplabel:',
        '  ret',
      ].join('\n'),
    );
    assert.ok(result.symbols.get('skiplabel') !== undefined, '标签地址应进入符号表');
    // jmp（短跳 2 字节）+ nop（1 字节）之后就是标签
    assert.equal(result.symbols.get('skiplabel'), result.symbols.get('start') + 3n);
    // jmp 的目标应等于 skiplabel 的地址（前向引用已收敛）
    const jmpLine = result.lines.find((l) => l.text === 'jmp skiplabel');
    const jmp = disassemble(jmpLine.bytes, jmpLine.address, 1)[0];
    assert.equal(jmp.opcode, 'jmp');
    const target = BigInt('0x' + /0x([0-9a-f]+)/i.exec(jmp.parameters)[1]);
    assert.equal(target, result.symbols.get('skiplabel'));
    // 语法检查模式没有副作用，因此不会真的"注册"符号
    assert.deepEqual(result.registeredSymbols, []);
  });

  test('[32-BIT] / [64-BIT] 段按目标位数裁剪', () => {
    const script = [
      '[64-BIT]',
      'db 64',
      '[/64-BIT]',
      '[32-BIT]',
      'db 32',
      '[/32-BIT]',
      'db ff',
    ].join('\n');

    const x64 = new AutoAssembler({ startAddress: 0x1000n, bitness: 64 }).check(script);
    assert.deepEqual(x64.lines.map((l) => l.bytes.toString('hex')), ['64', 'ff']);

    const x86 = new AutoAssembler({ startAddress: 0x1000n, bitness: 32 }).check(script);
    assert.deepEqual(x86.lines.map((l) => l.bytes.toString('hex')), ['32', 'ff']);
  });

  test('define 是纯文本替换（含早先 define 应用到后面的 define）', () => {
    const aa = new AutoAssembler(mem(0x1000n));
    const result = aa.check(
      ['define(base, 40)', 'define(off, base)', 'db off'].join('\n'),
    );
    // base → 40，off → base → 40（十六进制 0x40）
    assert.deepEqual(result.lines.map((l) => l.bytes.toString('hex')), ['40']);
  });

  test('include 把被包含文件的内容就地展开', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-include-'));
    try {
      fs.writeFileSync(path.join(dir, 'part.cea'), 'db aa\ndb bb ; 注释\n', 'utf8');
      const aa = new AutoAssembler({ startAddress: 0x1000n, includeDirs: [dir] });
      const result = aa.check(['db 11', 'include(part.cea)', 'db 22'].join('\n'));
      assert.deepEqual(
        result.lines.map((l) => l.bytes.toString('hex')),
        ['11', 'aa', 'bb', '22'],
      );
      assert.equal(result.lines[1].file, path.join(dir, 'part.cea'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('include 文件不存在时报错并指出行号', () => {
    const aa = new AutoAssembler({ startAddress: 0x1000n, includeDirs: [os.tmpdir()] });
    assert.throws(
      () => aa.check('db 11\ninclude(这个文件根本不存在_zzz.cea)'),
      (e) => {
        assert.ok(e instanceof AutoAssemblerError);
        assert.equal(e.lineNumber, 2);
        assert.match(e.message, /include 的文件找不到/);
        return true;
      },
    );
  });

  test('aobscan 在语法检查模式下用 0 占位并给出警告', () => {
    const aa = new AutoAssembler({ startAddress: 0x1000n });
    const result = aa.check('aobscan(sig, DE AD BE EF)\ndb 90\n');
    assert.equal(result.symbols.get('sig'), 0n);
    assert.equal(result.syntaxCheckOnly, true);
    assert.ok(result.warnings.some((w) => /占位/.test(w)));
    assert.equal(result.lines.find((l) => l.text === 'db 90').bytes.toString('hex'), '90');
  });

  /* ---------------- check 模式必须能过含块标签的正常脚本 ---------------- *
   *
   * 回归背景（外部实测发现的纯误报）：任何含**代码块标签**的脚本
   * （`newmem:` / `mz:` / `"cmd.exe":`）在 `action: check` 下都失败，报
   * 「第 N 行定义了标签 "newmem"，但此前没有任何地址定义行」——
   * 而它建议的写法恰恰就是用户已经写的。纯指令脚本却能过。
   *
   * 两处成因，缺一不可：
   *   1. check 模式下 `alloc` 声明的符号没有参与布局（`addressSet` 恒为 false）；
   *   2. 没有目标进程时，`"cmd.exe":` 这类**模块地址定义行**直接无法求值。
   */

  test('check 模式：含 alloc + 块标签的脚本能通过（不再误报"没有任何地址定义行"）', () => {
    const aa = new AutoAssembler(mem(0x1000n));
    const result = aa.check(
      [
        'alloc(newmem,$1000)',
        'label(returnhere)',
        'label(originalcode)',
        'newmem:',
        'originalcode:',
        '  mov eax, 1234',
        '  jmp returnhere',
        'returnhere:',
        '  nop',
      ].join('\n'),
    );
    assert.equal(result.syntaxCheckOnly, true);
    // 块标签必须有地址，且 newmem 与 originalcode 指向同一处（同一行两个标签）
    assert.ok(result.symbols.get('newmem') !== undefined, 'newmem 应进入符号表');
    assert.equal(result.symbols.get('newmem'), result.symbols.get('originalcode'));
    // check 模式下 alloc 只是一个**占位**（0），不会真的分配；
    // 而布局必须照样跑完 —— 指令真的被编码了，说明"没有任何地址定义行"的误报已经消失
    assert.equal(result.symbols.get('newmem'), 0n, 'check 模式的 alloc 是 0 占位');
    assert.ok(result.entries.length > 0, '指令必须真的被汇编出来（布局跑通了）');
    assert.ok(aa.allocationsList.length === 0, 'check 模式不产生真实分配');
  });

  test('check 模式：模块地址定义行（含裸模块名与十六进制偏移）能通过', () => {
    const aa = new AutoAssembler(mem(0x1000n));
    // 裸模块名（不带引号）
    const bare = aa.check('cmd.exe:\n  nop\n');
    assert.equal(bare.syntaxCheckOnly, true);
    assert.ok(bare.symbols.get('cmd.exe') !== undefined, '裸模块名标签应被解析');

    // 带引号 + 偏移：偏移按 CE 惯例是**十六进制**
    const withOffset = aa.check('"cmd.exe"+1000:\n  nop\n"cmd.exe"+2000:\n  nop\n');
    assert.ok(withOffset.symbols.get('"cmd.exe"+1000') !== undefined);
    assert.equal(
      withOffset.symbols.get('"cmd.exe"+2000') - withOffset.symbols.get('"cmd.exe"+1000'),
      0x1000n,
      '偏移必须按十六进制解释（1000 → 0x1000）',
    );
  });

  test('check 模式的模块兜底只对"像模块表达式"的写法生效，真正的错仍要报', () => {
    const aa = new AutoAssembler(mem(0x1000n));
    // 少了右引号：不是合法的模块地址表达式，不能被兜底掩盖
    assert.throws(() => aa.check('"cmd.exe+0:\n  nop\n'), /无法求值地址表达式/);
    // 纯符号标签（既不是模块也不是已声明符号）同样要报
    assert.throws(() => aa.check('完全没声明的名字:\n  nop\n'), /无法求值地址表达式/);
  });
});

/* ================================================================== *
 * 3. 跨进程执行
 * ================================================================== */

describe('跨进程执行（真实目标进程）', () => {
  beforeEach(() => env.setup());
  afterEach(() => env.teardown());

  /* ---------------- check 模式：附加了真实进程也不许碰它 ---------------- */

  test('check 即使附加了真实进程也绝不写内存、绝不分配（外部调用的真实形态）', () => {
    const target = proc();
    const address = base() + BigInt(L().health);
    const before = target.readMemoryExact(address, 16);

    const aa = new AutoAssembler({ process: target, bitness: 64 });
    const result = aa.check(
      [
        'alloc(newmem,$1000)',
        'newmem:',
        '  mov eax, 1234',
        '  nop',
      ].join('\n'),
    );

    assert.equal(result.syntaxCheckOnly, true);
    assert.ok(result.entries.length > 0, 'check 必须真的把指令汇编出来（否则等于没检查）');
    // 核心：目标进程的内存一个字节都没变
    assert.deepEqual(
      target.readMemoryExact(address, 16),
      before,
      'check 模式不允许改动目标进程内存',
    );
    // 核心：不产生真实分配（真的 VirtualAllocEx 过就会出现在 allocationsList 里）
    assert.deepEqual(aa.allocationsList, [], 'check 模式不允许真的分配内存');
  });

  /* ---------------- aobscan ---------------- */

  test('aobscan 在夹具进程里命中 DE AD BE EF 90 90 ?? 7* 并返回正确地址', () => {
    const expected = base() + BigInt(L().aobSignature);
    const aa = new AutoAssembler({ process: proc() });
    const result = aa.enable('aobscan(sig, DE AD BE EF 90 90 ?? 7*)\n');

    // 夹具里还有一份同样的字节（fixture-target.js 里构造 buf 用的 Node Buffer），
    // 因此全进程扫描会命中多处；这里断言"夹具里那一处确实被扫到了"。
    assert.equal(result.aobScans.length, 1);
    assert.equal(result.aobScans[0].scope, 'all');
    assert.ok(
      result.aobScans[0].matches.includes(expected),
      `aobscan 应命中 0x${expected.toString(16)}，实际命中 ` +
        result.aobScans[0].matches.map((a) => '0x' + a.toString(16)).join('、'),
    );

    // CE 取第一处（最低地址），并且"取到的那一处"必须是真实命中
    const chosen = result.symbols.get('sig');
    assert.equal(chosen, result.aobScans[0].matches[0]);
    const atChosen = proc().readMemoryExact(chosen, 8);
    assert.equal(atChosen.subarray(0, 6).toString('hex'), 'deadbeef9090');
    assert.equal(atChosen[7] & 0xf0, 0x70, '第 8 字节应满足 7* 的高半字节约束');
    assert.equal(result.syntaxCheckOnly, false);
    assert.equal(result.entries.length, 0, 'aobscan 本身不写内存');
  });

  test('aobscanregion 命中夹具的 AOB 后可以当地址用（写码并校验寻址正确）', () => {
    const expected = base() + BigInt(L().aobSignature);
    const aa = new AutoAssembler({ process: proc() });

    const script = [
      '[ENABLE]',
      `aobscanregion(sig, ${hex(base())}, ${hex(base() + BigInt(L().totalSize))}, DE AD BE EF 90 90 ?? 7*)`,
      'alloc(code, 128)',
      'code:',
      '  mov dword ptr [sig], 4242',
      '  ret',
      '[DISABLE]',
      // 故意不写 dealloc：这样 DISABLE 之后还能读回被覆盖的分配块，验证精确还原
    ].join('\n');

    const enabled = aa.enable(script);
    assert.equal(enabled.symbols.get('sig'), expected, '限定区域的扫描应是确定性的');
    const code = enabled.symbols.get('code');
    assert.ok(code !== undefined && code > 0n);

    // 写进去的是"指令"而不是执行结果：必须解码校验它的寻址确实指向 sig
    const bytes = proc().readMemoryExact(code, 11);
    assert.equal(bytes[0], 0xc7);
    assert.equal(bytes[1], 0x05, 'ModRM=05 → RIP 相对寻址（x64）');
    const effective = code + 10n + BigInt(bytes.readInt32LE(2));
    assert.equal(effective, expected, '指令里的地址必须解析为 aobscan 命中的地址');
    // 立即数是**十进制** 4242（=0x1092）。
    // 依据：CE 帮助文档里十六进制一律带 `h` 后缀（`mov eax, 403045h`），
    // 裸数字按十进制解读；Keystone 的裸数字同样是十进制。
    // 若要写十六进制请用 `0x1092` 或 `1092h`。
    assert.equal(bytes.readUInt32LE(6), 4242, '立即数应为十进制 4242（=0x1092）');
    assert.equal(bytes[10], 0xc3, 'ret');

    // 结果里的 lines 与目标内存一致
    const written = enabled.lines.filter((l) => l.bytes.length > 0);
    assert.equal(
      Buffer.concat(written.map((l) => l.bytes)).toString('hex'),
      bytes.toString('hex'),
    );

    // DISABLE 应把被覆盖的分配块还原成分配时的内容（全 0）
    aa.disable(script);
    assert.equal(
      proc().readMemoryExact(code, 11).toString('hex'),
      '00'.repeat(11),
      'DISABLE 应精确还原被 ENABLE 覆盖的原字节',
    );
    // 上面刻意没 dealloc，这里显式释放
    aa.enable('dealloc(code)\n');
  });

  test('aobscanregion 只扫指定区域，aobscanmodule 找不到模块时报错', () => {
    const expected = base() + BigInt(L().aobSignature);
    const start = base();
    const stop = base() + BigInt(L().totalSize);

    const aa = new AutoAssembler({ process: proc() });
    const result = aa.enable(
      `aobscanregion(rsig, ${hex(start)}, ${hex(stop)}, DE AD BE EF 90 90 ?? 7*)\n`,
    );
    assert.equal(result.symbols.get('rsig'), expected);

    // 区域外不应命中
    assert.throws(
      () =>
        aa.enable(
          `aobscanregion(none, ${hex(start)}, ${hex(start + 0x40n)}, DE AD BE EF 90 90 ?? 7*)\n`,
        ),
      (e) => {
        assert.ok(e instanceof AutoAssemblerError);
        assert.match(e.message, /找不到特征码/);
        return true;
      },
    );

    assert.throws(
      () => aa.enable('aobscanmodule(m, 这个模块不存在.dll, DE AD BE EF)\n'),
      /aobscanmodule 找不到模块/,
    );
  });

  test('aobscanunique 命中多处时报错，并列出前几处地址', () => {
    // 故意把同一段 AOB 再抄两份，保证"多处命中"这个前提成立
    const target = base() + BigInt(L().aobSignature);
    const pattern = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x90, 0x90, 0x11, 0x7a]);
    const dup1 = base() + BigInt(L().fillerStart + 0x100);
    const dup2 = base() + BigInt(L().fillerStart + 0x200);
    proc().writeMemory(dup1, pattern);
    proc().writeMemory(dup2, pattern);

    const aa = new AutoAssembler({ process: proc() });
    assert.throws(
      () => aa.enable('aobscanunique(u, DE AD BE EF 90 90 ?? 7*)\n'),
      (e) => {
        assert.ok(e instanceof AutoAssemblerError);
        assert.match(e.message, /期望唯一命中/);
        assert.match(e.message, /0x/);
        return true;
      },
    );
    void target;
  });

  /* ---------------- alloc + label + 写码 ---------------- */

  test('alloc + label + 汇编写入目标进程，读回字节与预期逐字节一致', () => {
    const aa = new AutoAssembler({ process: proc() });
    const script = [
      '[ENABLE]',
      'alloc(code, 512)',
      'label(skip)',
      'code:',
      '  mov eax, 0x1234',
      '  jmp skip',
      '  mov eax, 0xDEAD',
      'skip:',
      '  ret',
      '[DISABLE]',
      'dealloc(code)',
    ].join('\n');

    const result = aa.enable(script);
    const code = result.symbols.get('code');
    assert.ok(typeof code === 'bigint' && code > 0n, 'alloc 的地址应成为符号');

    // 预期编码：mov eax,0x1234 (5) + jmp skip (2，Keystone 自动选短跳) +
    //           mov eax,0xDEAD (5) + ret (1)
    const expected = 'b834120000' + 'eb05' + 'b8adde0000' + 'c3';
    assert.equal(proc().readMemoryExact(code, expected.length / 2).toString('hex'), expected);

    // 前向引用 label(skip) 应解析到 code+12，jmp 的目标必须真的是它
    assert.equal(result.symbols.get('skip'), code + 12n);
    const jmpInsn = disassemble(proc().readMemoryExact(code + 5n, 2), code + 5n, 1)[0];
    assert.equal(jmpInsn.opcode, 'jmp');
    assert.equal(jmpInsn.parameters, hex(code + 12n));

    // 结果里的 lines 也应一致
    assert.equal(
      Buffer.concat(result.lines.filter((l) => l.bytes.length > 0).map((l) => l.bytes)).toString('hex'),
      expected,
    );

    // dealloc 之后地址应被释放（不再存在于符号表）
    const disabled = aa.disable(script);
    assert.equal(disabled.symbols.get('code'), undefined);
  });

  test('alloc 的符号可以在后续 alloc 的前置地址参数里使用（首选地址不可用则退化）', () => {
    const aa = new AutoAssembler({ process: proc() });
    // 首选地址已被 a 自己占用 → VirtualAllocEx 返回 487，此时应退化为任意地址分配
    const result = aa.enable(['alloc(a, 64)', 'alloc(b, 64, a)', 'registersymbol(a)'].join('\n'));
    assert.ok(result.symbols.get('a') > 0n);
    assert.ok(result.symbols.get('b') > 0n);
    assert.notEqual(result.symbols.get('a'), result.symbols.get('b'));
    assert.equal(result.registeredSymbols.includes('a'), true);
    assert.equal(result.allocations.length, 2);
    assert.ok(
      result.warnings.some((w) => /首选地址不可用/.test(w)),
      '首选地址不可用时应给出警告',
    );
    aa.cleanup();
  });

  test('globalalloc 分配并登记为全局符号；realloc 改变大小', () => {
    const aa = new AutoAssembler({ process: proc() });
    const first = aa.enable(['globalalloc(ga, 32)', 'registersymbol(ga)'].join('\n'));
    assert.equal(first.registeredSymbols.includes('ga'), true);
    const address = first.symbols.get('ga');
    assert.ok(address > 0n);
    assert.equal(first.allocations.find((a) => a.name === 'ga').global, true);

    const second = aa.enable('realloc(ga, 128)\n');
    assert.ok(second.symbols.get('ga') > 0n, 'realloc 后符号仍可用');
    assert.equal(second.allocations.find((a) => a.name === 'ga').size, 128);

    aa.enable('dealloc(ga)\n');
    assert.equal(aa.symbols.get('ga'), undefined);
  });

  test('unregistersymbol 取消登记；dealloc(*) 释放全部块', () => {
    const aa = new AutoAssembler({ process: proc() });
    aa.enable('alloc(g, 32)\nregistersymbol(g)\n');
    assert.equal(aa.symbols.get('g') > 0n, true);

    const unregistered = aa.enable('unregistersymbol(g)\n');
    assert.deepEqual(unregistered.registeredSymbols, []);
    assert.equal(unregistered.symbols.get('g'), undefined);
    assert.equal(unregistered.allocations.length, 1, '取消登记不会释放内存');

    const cleared = aa.enable('dealloc(*)\n');
    assert.equal(cleared.allocations.length, 0);
    assert.equal(cleared.symbols.get('g'), undefined);
  });

  test('dealloc 在结果里如实报告"真的释放了哪一块"（此前只有「还原 0 处」看不出）', () => {
    const aa = new AutoAssembler({ process: proc() });

    // ENABLE 只是分配，没有 dealloc
    const enabled = aa.enable('alloc(code_rep, 64)\ncode_rep:\n  nop\n');
    assert.deepEqual(enabled.deallocated, [], 'ENABLE 阶段没有释放任何东西');
    const address = enabled.symbols.get('code_rep');
    assert.ok(address > 0n);

    // 释放：结果里必须带上名字 / 地址 / 大小（工具层据此打印"已释放…"）
    const freed = aa.enable('dealloc(code_rep)\n');
    assert.deepEqual(
      freed.deallocated,
      [{ name: 'code_rep', address, size: 64 }],
      'dealloc 必须如实报告释放的块',
    );
    assert.equal(freed.allocations.length, 0);
    assert.equal(freed.symbols.get('code_rep'), undefined, '释放后符号应消失');

    // dealloc 一块不存在的：不算释放，也不该出现在报告里
    const nothing = aa.enable('dealloc(压根没分配过)\n');
    assert.deepEqual(nothing.deallocated, []);
    assert.ok(nothing.warnings.some((w) => /没有名为/.test(w)), '应给出"没有该分配"的警告');
  });

  test('loadbinary 把二进制文件写进目标进程', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-loadbin-'));
    try {
      const payload = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
      const file = path.join(dir, 'payload.bin');
      fs.writeFileSync(file, payload);

      const aa = new AutoAssembler({ process: proc(), includeDirs: [dir] });
      const script = [
        '[ENABLE]',
        'alloc(code, 64)',
        `loadbinary(code, ${file})`,
        '[DISABLE]',
        'dealloc(code)',
      ].join('\n');

      const result = aa.enable(script);
      const code = result.symbols.get('code');
      assert.equal(proc().readMemoryExact(code, payload.length).toString('hex'), payload.toString('hex'));
      assert.equal(result.entries[0].originalBytes.toString('hex'), '00'.repeat(payload.length));

      // DISABLE 时该块被 dealloc，对应记录也应一起丢弃（否则会写已释放内存而报错）
      aa.disable(script);
      assert.equal(aa.symbols.get('code'), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* ---------------- ENABLE / DISABLE 往返 ---------------- */

  test('[ENABLE]/[DISABLE] 成对应用：记录原字节、改动、再逐字节精确还原', () => {
    const health = base() + BigInt(L().health);
    const before = proc().readMemoryExact(health, 8);
    assert.equal(before.readInt32LE(0), 1000);
    assert.equal(before.readInt32LE(4), 500, '夹具里 health 后面就是 ammo');

    const aa = new AutoAssembler({ process: proc() });
    // ENABLE 写 5 字节（mov eax, 1337 = B8 39 05 00 00，裸数字为十进制），
    // 会覆盖 health 与 ammo 的首字节
    const script = [
      '[ENABLE]',
      `${hex(health)}:`,
      '  mov eax, 1337',
      '[DISABLE]',
      `${hex(health)}:`,
      '  db e8 03 00 00 00',
    ].join('\n');

    const enabled = aa.enable(script);
    assert.equal(enabled.entries.length, 1);
    assert.equal(
      enabled.entries[0].originalBytes.toString('hex'),
      'e8030000f4',
      'ENABLE 前必须记录被覆盖处的原字节',
    );
    assert.equal(proc().readMemoryExact(health, 5).toString('hex'), 'b839050000');

    const disabled = aa.disable(script);
    assert.equal(disabled.entries.length, 1);
    assert.equal(disabled.entries[0].restoredFromOriginal, true, '应走"原字节还原"路径');
    // 逐字节断言
    assert.deepEqual(
      [...proc().readMemoryExact(health, 8)],
      [...before],
      'DISABLE 后必须与 ENABLE 之前逐字节一致',
    );
    assert.equal(proc().readMemoryExact(health, 4).readInt32LE(0), 1000);
    assert.equal(proc().readMemoryExact(health + 4n, 4).readInt32LE(0), 500);
  });

  test('[DISABLE] 段为空时也能靠记录的原字节精确还原', () => {
    const health = base() + BigInt(L().health);
    const before = proc().readMemoryExact(health, 16);

    const aa = new AutoAssembler({ process: proc() });
    const script = `[ENABLE]\n${dbScript(health, '39 05 00 00')}[DISABLE]\n`;
    aa.enable(script);
    assert.equal(proc().readMemoryExact(health, 4).readInt32LE(0), 1337, 'db 39 05 00 00 → 1337');

    aa.disable(script);
    assert.deepEqual([...proc().readMemoryExact(health, 16)], [...before]);
  });

  test("restoreMode: 'script' 时完全听 [DISABLE] 段（空段则不还原）", () => {
    const health = base() + BigInt(L().health);
    const aa = new AutoAssembler({ process: proc(), restoreMode: 'script' });
    const script = `[ENABLE]\n${dbScript(health, '39 05 00 00')}[DISABLE]\n`;

    aa.enable(script);
    assert.equal(proc().readMemoryExact(health, 4).readInt32LE(0), 1337);

    const disabled = aa.disable(script);
    assert.equal(disabled.entries.length, 0);
    assert.equal(
      proc().readMemoryExact(health, 4).readInt32LE(0),
      1337,
      'script 模式且 DISABLE 为空 → 保持被改后的值（与 CE 一致）',
    );
  });

  test('多个脚本各自独立启用/关闭，互不冲掉对方的还原记录', () => {
    const health = base() + BigInt(L().health);
    const ammo = base() + BigInt(L().ammo);
    const beforeHealth = proc().readMemoryExact(health, 4);
    const beforeAmmo = proc().readMemoryExact(ammo, 4);

    const scriptA = `[ENABLE]\n${dbScript(health, '39 05 00 00')}[DISABLE]\n`;
    const scriptB = `[ENABLE]\n${dbScript(ammo, 'c2 01 00 00')}[DISABLE]\n`;

    const aa = new AutoAssembler({ process: proc() });
    aa.enable(scriptA);
    aa.enable(scriptB);
    assert.equal(proc().readMemoryExact(health, 4).readInt32LE(0), 1337);
    assert.equal(proc().readMemoryExact(ammo, 4).readInt32LE(0), 450);

    aa.disable(scriptA);
    assert.deepEqual([...proc().readMemoryExact(health, 4)], [...beforeHealth]);
    assert.equal(proc().readMemoryExact(ammo, 4).readInt32LE(0), 450, '关闭 A 不应影响 B');

    aa.disable(scriptB);
    assert.deepEqual([...proc().readMemoryExact(ammo, 4)], [...beforeAmmo]);
  });

  /* ---------------- define ---------------- */

  test('define 常量被正确替换进指令（裸数字 = 十进制，与 CE 一致）', () => {
    const target = base() + BigInt(L().targetValue);
    assert.equal(proc().readMemoryExact(target, 4).readInt32LE(0), 4242);

    const aa = new AutoAssembler({ process: proc() });
    const script = [
      '[ENABLE]',
      'alloc(code, 128)',
      'define(myVal, 1337)',
      'code:',
      `  mov dword ptr [${hex(target)}], myVal`,
      '  ret',
      '[DISABLE]',
      'dealloc(code)',
    ].join('\n');

    const result = aa.enable(script);
    const code = result.symbols.get('code');

    // 立即数应为十进制 1337（=0x539）。
    //
    // 依据：CE 帮助文档里十六进制一律带 `h` 后缀
    // （`mov eax, 403045h ; make eax have the value 403045 hex`），
    // 而裸数字的示例（`mov edx, 5006`）按十进制解读。
    // Keystone 的裸数字同样是十进制，二者一致。
    const bytes = proc().readMemoryExact(code, 11);
    assert.equal(bytes.readUInt32LE(6), 1337, 'myVal 应替换为十进制 1337（=0x539）');
    // 寻址必须指向 define 引用之外的那个真实地址
    assert.equal(code + 10n + BigInt(bytes.readInt32LE(2)), target);
    assert.equal(bytes[10], 0xc3);

    // 与"手写等值常量"的汇编结果一致（1337 十进制 == 0x539 十六进制）
    const expected = assemble(`mov dword ptr [${hex(target)}], 0x539`, { address: code });
    assert.equal(bytes.subarray(0, 10).toString('hex'), expected.bytes.toString('hex'));
    // 反证：若按十六进制解释会得到 0x1337，与实测不符
    const asHex1337 = assemble(`mov dword ptr [${hex(target)}], 0x1337`, { address: code });
    assert.notEqual(bytes.subarray(0, 10).toString('hex'), asHex1337.bytes.toString('hex'));

    aa.disable(script);
  });

  test('h 后缀写法被支持（CE 文档的十六进制风格）', () => {
    // CE 文档用的是 `403045h` 这种后缀写法，Keystone 也认
    const a = assembleToBytes('mov eax, 403045h', { address: 0x1000n });
    const b = assembleToBytes('mov eax, 0x403045', { address: 0x1000n });
    assert.equal(a.toString('hex'), b.toString('hex'), 'h 后缀与 0x 前缀必须等价');

    // 与裸数字区分开：10h = 16，而 10 = 10
    assert.equal(
      assembleToBytes('mov eax, 10h', { address: 0x1000n }).readUInt32LE(1),
      16,
    );
    assert.equal(
      assembleToBytes('mov eax, 10', { address: 0x1000n }).readUInt32LE(1),
      10,
    );
  });

  test('define 的值也能用十六进制字面量写（0x 前缀）', () => {
    const target = base() + BigInt(L().targetValue);
    const aa = new AutoAssembler({ process: proc() });
    const script = [
      '[ENABLE]',
      'alloc(code, 128)',
      'define(myVal, 0x539)',
      'code:',
      `  mov dword ptr [${hex(target)}], myVal`,
      '[DISABLE]',
      'dealloc(code)',
    ].join('\n');
    const result = aa.enable(script);
    const code = result.symbols.get('code');
    const bytes = proc().readMemoryExact(code, 10);
    assert.equal(bytes.readUInt32LE(6), 0x539);
    aa.disable(script);
  });

  /* ---------------- readmem / db ?? / assert ---------------- */

  test('readmem 把目标进程的字节原样写进脚本位置', () => {
    const source = base() + BigInt(L().nameString); // 'HELLO CHEAT ENGINE'
    const aa = new AutoAssembler({ process: proc() });
    const script = [
      '[ENABLE]',
      'alloc(code, 64)',
      'code:',
      `  readmem(${hex(source)}, 5)`,
      '[DISABLE]',
      'dealloc(code)',
    ].join('\n');

    const result = aa.enable(script);
    const code = result.symbols.get('code');
    assert.equal(proc().readMemoryExact(code, 5).toString('latin1'), 'HELLO');
    aa.disable(script);
  });

  test('db ?? 读回目标进程当前字节（写回原值 → 内容不变）', () => {
    const nameString = base() + BigInt(L().nameString);
    const before = proc().readMemoryExact(nameString, 6);

    const aa = new AutoAssembler({ process: proc() });
    const script = `[ENABLE]\n${dbScript(nameString, '?? ?? ?? ?? ?? ??')}[DISABLE]\n`;
    const result = aa.enable(script);

    assert.equal(result.entries[0].bytes.toString('hex'), before.toString('hex'));
    assert.deepEqual([...proc().readMemoryExact(nameString, 6)], [...before]);

    aa.disable(script);
    assert.deepEqual([...proc().readMemoryExact(nameString, 6)], [...before]);
  });

  test('assert 校验通过/失败，并给出地址与期望值', () => {
    const aob = base() + BigInt(L().aobSignature);
    const aa = new AutoAssembler({ process: proc() });

    // 通过
    const ok = aa.enable(`assert(${hex(aob)}, DE AD BE EF ?? ??)\n`);
    assert.equal(ok.entries.length, 0);

    // 失败
    assert.throws(
      () => aa.enable(`assert(${hex(aob)}, 11 22 33 44)\n`),
      (e) => {
        assert.ok(e instanceof AutoAssemblerError);
        assert.match(e.message, /assert 失败/);
        assert.equal(e.lineNumber, 1);
        return true;
      },
    );
  });

  /* ---------------- createthread ---------------- */

  test('createthread 做参数校验但不创建远程线程', () => {
    const aa = new AutoAssembler({ process: proc() });
    const result = aa.enable(['alloc(code, 64)', 'code:', '  ret', 'createthread(code)'].join('\n'));

    assert.equal(result.createThreads.length, 1);
    assert.equal(result.createThreads[0], result.symbols.get('code'));
    assert.ok(
      result.warnings.some((w) => /createthread/.test(w) && /未创建线程/.test(w)),
      '应给出"未真正创建线程"的提示',
    );
  });

  test('createthread 参数非法时报错（括号缺失 / 地址无法解析）', () => {
    const aa = new AutoAssembler({ process: proc() });
    assert.throws(() => aa.enable('createthread()\n'), /createthread/);
    assert.throws(
      () => aa.enable('createthread(这个符号不存在)\n'),
      (e) => {
        assert.ok(e instanceof AutoAssemblerError);
        assert.equal(e.lineNumber, 1);
        return true;
      },
    );
  });

  test('allowCreateThread: true 时明确报「本移植不支持」', () => {
    const aa = new AutoAssembler({ process: proc(), allowCreateThread: true });
    assert.throws(
      () => aa.enable('alloc(code, 64)\ncreatethread(code)\n'),
      /不支持在目标进程创建远程线程/,
    );
  });

  /* ---------------- 错误路径：行号 ---------------- */

  test('语法错误能指出行号（未定义符号）', () => {
    const aa = new AutoAssembler({ process: proc() });
    const script = [
      '[ENABLE]',
      'alloc(code, 64)',
      'code:',
      '  mov eax, 这个符号不存在',
      '[DISABLE]',
      'dealloc(code)',
    ].join('\n');

    assert.throws(
      () => aa.enable(script),
      (e) => {
        assert.ok(e instanceof AutoAssemblerError, 'in: ' + e.constructor.name);
        assert.equal(e.lineNumber, 4);
        assert.equal(e.phase, 'assemble');
        assert.match(e.message, /第 4 行/);
        return true;
      },
    );
  });

  test('语法错误能指出行号（指令非法）', () => {
    const aa = new AutoAssembler({ process: proc() });
    assert.throws(
      () => aa.enable('alloc(code, 64)\ncode:\n  mov eax, 1 2\n'),
      (e) => {
        assert.ok(e instanceof AutoAssemblerError);
        assert.equal(e.lineNumber, 3);
        return true;
      },
    );
  });

  test('alloc 参数不足、指令未定位地址、段重复都报错并带行号', () => {
    const aa = new AutoAssembler({ process: proc() });

    assert.throws(
      () => aa.enable('alloc(newmem)\n'),
      (e) => {
        assert.equal(e.lineNumber, 1);
        assert.match(e.message, /alloc/);
        return true;
      },
    );

    assert.throws(
      () => aa.enable('mov eax, 1\n'),
      (e) => {
        assert.equal(e.lineNumber, 1);
        assert.equal(e.phase, 'assemble');
        assert.match(e.message, /地址/);
        return true;
      },
    );

    assert.throws(
      () => aa.check('[ENABLE]\ndb 1\n[ENABLE]\ndb 2\n'),
      (e) => {
        assert.equal(e.lineNumber, 3);
        assert.match(e.message, /重复定义/);
        return true;
      },
    );
  });

  test('明确不支持的指令给出可操作的中文错误', () => {
    const aa = new AutoAssembler({ process: proc() });
    assert.throws(() => aa.check('luaCall(print(1))\n'), /未实现/);
    assert.throws(() => aa.check('allocnx(x, 64)\n'), /未实现/);
  });

  test('aobscan 找不到特征码时报错（scan 阶段 + 行号）', () => {
    const aa = new AutoAssembler({ process: proc() });
    assert.throws(
      () => aa.enable('\naobscanregion(x, ' + hex(base()) + ', ' + hex(base() + 0x10n) + ', AA BB CC DD EE FF 11 22)\n'),
      (e) => {
        assert.ok(e instanceof AutoAssemblerError);
        assert.equal(e.lineNumber, 2);
        assert.equal(e.phase, 'scan');
        return true;
      },
    );
  });

  /* ---------------- 无目标进程时的行为 ---------------- */

  test('没有传入 process 时自动进入 syntaxCheckOnly（不写内存、不分配）', () => {
    const result = autoAssemble('db 90 90\n', { startAddress: 0x1000n });
    assert.equal(result.syntaxCheckOnly, true);
    // entries 描述"将要写入"的内容，但不会真的写
    assert.equal(result.entries.length, 1);
    assert.equal(result.bytesWritten, 0);
    assert.equal(result.entries[0].originalBytes, null);
    assert.equal(result.lines[0].bytes.toString('hex'), '9090');
    assert.equal(result.allocations.length, 0);
  });

  test('一次性便捷函数 autoAssemble 可用于一次性注入', () => {
    const health = base() + BigInt(L().health);
    const result = autoAssemble(`[ENABLE]\n${dbScript(health, '39 05 00 00')}[DISABLE]\n`, {
      process: proc(),
      enable: true,
    });
    assert.equal(result.entries.length, 1);
    assert.equal(proc().readMemoryExact(health, 4).readInt32LE(0), 1337);
  });

  /* ---------------- 与 assembler 的一致性 ---------------- */

  test('AA 写出的指令字节与直接调用 assemble() 一致', () => {
    const target = base() + BigInt(L().targetValue);
    const aa = new AutoAssembler({ process: proc() });
    const script = [
      '[ENABLE]',
      'alloc(code, 128)',
      'code:',
      `  mov dword ptr [${hex(target)}], 0x11223344`,
      '[DISABLE]',
      'dealloc(code)',
    ].join('\n');
    const result = aa.enable(script);
    const code = result.symbols.get('code');
    const expected = assemble(`mov dword ptr [${hex(target)}], 0x11223344`, { address: code }).bytes;
    assert.equal(proc().readMemoryExact(code, expected.length).toString('hex'), expected.toString('hex'));
    aa.disable(script);
  });
});
