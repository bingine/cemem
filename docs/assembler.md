# 反汇编器 / 汇编器

本移植提供 **x86 / x64 / ARM / Thumb / ARM64** 的反汇编与汇编能力，用于内存查看器、
代码分析、以及 Auto Assembler（见 [autoassembler.md](autoassembler.md)）。

## 一、为什么用外部引擎（而不是移植那 2 万行 Pascal）

`Cheat Engine/disassembler.pas` 有 **13,933 行**，`Assemblerunit.pas` 有 **7,218 行**，
ARM 侧另有 `disassemblerarm64.pas`（4,608）、`disassemblerthumb.pas`（4,414）、
`assemblerarm.pas`（1,074）等。但如果去看 CE 在 Windows 上的实际路径，会发现：

```pascal
// disassembler.pas, TDisassembler.disassemble
if defaultBinutils<>nil then
begin
  //use this
  LastDisassembleData.address:=offset;
  defaultBinutils.disassemble(LastDisassembleData);   // ← 调外部 objdump
  ...
  exit;
end;
```

即 **CE 自己优先调用 binutils 的 `objdump`**（见 `binutils.pas`：
`p.executable := '"...objdump"'`），自带的 Pascal 实现只是**没有 binutils 时的回退**
（Android 等场景）。汇编同理走 `as` / `ld`。

所以本移植遵循同一架构，选两个成熟引擎做后端：

| 能力 | 后端 | 说明 |
| --- | --- | --- |
| 反汇编 | [`capstone-wasm`](https://www.npmjs.com/package/capstone-wasm) | Capstone 官方 WASM 绑定 |
| 汇编 | [`keystone-wasm`](https://www.npmjs.com/package/keystone-wasm) | Keystone 官方 WASM 绑定（v0.9） |

好处是覆盖面与正确性远胜手抄指令表（SSE/AVX、ARM NEON/SVE 等都能处理），
代价是引入两个 WASM 依赖（合计约 3MB）并需要异步初始化。

> 也评估过 `iced-x86`（1.21.0）：它确实是很好的解码器，但这个 npm 包
> **只暴露 `Decoder`/`Encoder`/`BlockEncoder`，没有 `Assembler`**（文本→机器码），
> 且字段名与 C# 版不一致（`length` 而非 `len`）。要做文本汇编仍需自己写 ——
> 因此最终选了 Capstone + Keystone 的组合。

## 二、支持的架构

| 架构名 | 说明 | 指令长度 | 对齐 | 地址宽度 |
| --- | --- | --- | --- | --- |
| `x86` | 32 位 x86 | 1–15 字节，可变 | 1 | 8 |
| `x64` | 64 位 x86（默认） | 1–15 字节，可变 | 1 | 16 |
| `arm` | ARM A32（ARMv7 及以前） | 固定 4 | 4 | 8 |
| `thumb` | Thumb / Thumb-2 | 2 或 4 | 2 | 8 |
| `arm64` | AArch64（ARMv8） | 固定 4 | 4 | 16 |

架构名接受宽松写法（大小写、`_`/`-`/空格都忽略）：

```js
normalizeArchitecture('aarch64')  // 'arm64'
normalizeArchitecture('ARM')      // 'arm'
normalizeArchitecture('thumb2')   // 'thumb'
normalizeArchitecture('amd64')    // 'x64'
normalizeArchitecture('i386')     // 'x86'
normalizeArchitecture(64)         // 'x64'
```

字节序可选（CE 的 ARM 目标可能是大端）：

```js
assembleToBytes('mov r0, r1', { address: 0x1000n, arch: 'arm', endianness: 'big' });
// → e1 a0 00 01（小端为 01 00 a0 e1）
```

## 三、快速开始

```js
const {
  ensureAsmBackend,   // ← 必须先调用（WASM 异步初始化）
  disassembleOne,
  formatDisassembled,
  assembleToBytes,
  instructionText,
} = require('@bingine/cemem');

(async () => {
  await ensureAsmBackend();

  // 反汇编（x64）
  const insn = disassembleOne(Buffer.from('488b0510203040', 'hex'), 0x7ff000001000n);
  console.log(insn.opcode);        // 'mov'
  console.log(insn.parameters);    // 'rax, qword ptr [rip + 0x40302010]'
  console.log(insn.dataSize);      // 8
  console.log(formatDisassembled(insn));
  // → '00007FF000001000 - 48 8B 05 10 20 30 40  - mov rax, qword ptr [rip + 0x40302010]'

  // 汇编（x64）
  const bytes = assembleToBytes('mov rax, 1\nret', { address: 0x1000n });
  console.log(bytes.toString('hex'));   // '48c7c001000000c3'

  // ARM64
  const a64 = assembleToBytes('stp x29, x30, [sp, #-16]!\nret', {
    address: 0x400000n, arch: 'arm64',
  });
  const list = disassemble(a64, 0x400000n, 4, { arch: 'arm64' });
  list.forEach((i) => console.log(instructionText(i)));
  // stp x29, x30, [sp, #-0x10]!
  // ret
})();
```

### 反汇编目标进程的代码

```js
const { Process, ensureAsmBackend, disassembleAt, formatDisassembled } = require('@bingine/cemem');

await ensureAsmBackend();
const proc = Process.open(1234);
const mod = proc.modules()[0];

let addr = mod.baseAddress;
for (let i = 0; i < 10; i++) {
  const insn = disassembleAt((a, n) => proc.readMemory(a, n), addr);
  console.log(formatDisassembled(insn));
  addr += BigInt(insn.size);          // ARM 定长 4 / Thumb 2|4 / x86 变长
}
proc.close();
```

`disassembleAt` 固定读 16 字节（x86 单指令最长 15 字节，ARM/ARM64 定长 4，
Thumb 最多 4），一次读取足够覆盖任何架构的单条指令。

## 四、数字进制（重要，容易写错）

实测（Keystone 0.9）：

| 写法 | 含义 | 例 |
| --- | --- | --- |
| `100` | **十进制** 100 | `mov eax, 100` → `B8 64 00 00 00` |
| `0x100` | 十六进制 0x100 | `mov eax, 0x100` → `B8 00 01 00 00` |
| `100h` | 十六进制 0x100 | `mov eax, 100h` → `B8 00 01 00 00` |
| `#100`（ARM） | 十进制 100 | `mov r0, #100` 与 `#0x64` 编码相同 |

**与 CE 的一致性**：CE 帮助文档里十六进制一律用 `h` 后缀 ——
`mov eax, 403045h ; make eax have the value 403045 hex`、
`mov cl, byte ptr [34h]`；而裸数字的例子（`mov edx, 5006`）按十进制解读。
CE 在 Windows 上把汇编交给 **GNU as**（binutils），GNU as 的裸数字也是十进制 ——
因此本移植与 CE 的实际行为一致。Keystone 也支持 `h` 后缀，CE 脚本可直跑。

> 注意：CE 自带的 Pascal 汇编器与 CE 部分文档示例（如 `mov [esi+80], ebx`
> 里的 `80` 看起来像 0x80）暗示裸数字可能按十六进制解释。
> 本项目没有 CE 可执行文件可实测，因此**采用 binutils 语义**。
> 如果你的脚本依赖十六进制写法，请显式写 `0x80` 或 `80h`。
> 另外 `db`/`dw`/`dd`/`dq` 的裸数字**是十六进制**（`dataHexDefault` 默认 true，
> 与 CE 一致）：`db 89 01` 就是字节 `0x89 0x01`。这两套约定不同，别混。

## 五、API

### 5.1 初始化（必须）

```js
await ensureAsmBackend();          // 幂等；失败时不缓存失败结果，可重试
isAsmBackendReady();               // 同步查询是否就绪
backendVersions();                 // { capstone, keystone }
```

未初始化就调用其它 API 会抛 `AsmBackendError`，信息里会提示
`请在调用前 await ensureAsmBackend()`。

### 5.2 反汇编

```js
disassemble(code: Buffer, address: bigint, maxInstructions = 1, opts?): DisassembledInstruction[]
disassembleOne(code, address, opts?): DisassembledInstruction
disassembleAt(readMemory: (addr, size) => Buffer, address, opts?): DisassembledInstruction
```

- `opts.bitness`：`32 | 64`，默认 64
- `disassembleOne` 解不出指令时抛错（附上字节内容），不会返回 `null`
- `disassembleAt` 只读 16 字节（x86 单指令最长 15 字节）

`DisassembledInstruction` 的字段对齐 CE 的 `TLastDisassembleData`
（`lastdisassembledata.pas`）：

| 字段 | 说明 |
| --- | --- |
| `address` | 指令地址（bigint） |
| `prefix` / `prefixSize` | 前缀文本（`rep`/`lock`）与长度 |
| `opcode` | 助记符，例如 `mov` |
| `parameters` | 操作数文本，例如 `rax, qword ptr [rip + 0x40302010]` |
| `bytes` | 机器码，**每个字节一个 `Buffer`**（对齐 CE 的 `Bytes: array of byte`） |
| `separators` / `separatorCount` | 字节里的分段下标（前缀/操作码/modrm/sib），供界面高亮 |
| `modrmValueType` / `modrmValue` | 内存操作数指向的值（`DisasmValueType`） |
| `parameterValueType` / `parameterValue` | 立即数/位移值 |
| `dataSize` | 读写的数据宽度（字节） |
| `isFloat` / `isFloat64` | 是否单/双精度浮点 |
| `hasSib` / `sibIndex` / `sibScaler` | SIB 信息 |
| `isJump` / `isConditionalJump` / `isCall` / `isRet` / `isRep` | 流程控制标记 |
| `ripRelative` | RIP 相对偏移下标；`-1` 表示不是 |
| `is64Bit` | 是否 64 位模式解码 |
| `size` | 指令长度 |

### 5.3 格式化与解析

```js
formatDisassembled(insn, { addressWidth?, showAddress?, showBytes? }): string
instructionText(insn): string          // 含前缀的完整指令文本，用于重新汇编
splitDisassembledString(text): { address, bytes, opcode, parameters }
branchTarget(insn): bigint | null      // 跳转/调用目标，非流程指令返回 null
formatBytes(bytes): string             // '48 8B 05 10 20 30 40'
```

**`instructionText` 与 `opcode + parameters` 的区别很重要**：CE 把前缀单独存在
`prefix` 字段，所以 `opcode + parameters` **不含 `rep`/`lock`**。
想往返必须用 `instructionText`：

```js
const insn = disassembleOne(Buffer.from('f3a4', 'hex'), 0x1000n);
insn.prefix;                  // 'rep'
insn.opcode;                  // 'movsb'
instructionText(insn);        // 'rep movsb'   ← 用这个去汇编
`${insn.opcode} ${insn.parameters}`;  // 'movsb'  ← 会丢掉 F3 前缀（不要这样往返）
```

### 5.4 汇编

```js
assemble(source: string, opts): AssembleResult
assembleLines(source: string, opts): AssembleResult     // 逐行，带每行地址
assembleToBytes(source: string, opts): Buffer
```

`opts`：

| 选项 | 说明 |
| --- | --- |
| `address`（必需） | 代码将放置的地址。**相对跳转/相对寻址的编码取决于它** |
| `arch` | `x86` / `x64`（默认）/ `arm` / `thumb` / `arm64` |
| `bitness` | `32 \| 64`，兼容旧写法；`arch` 优先（`arm` 与 `thumb` 都是 32 位，光给位数无法区分） |
| `endianness` | `little`（默认）/ `big`。CE 的 ARM 目标可能是大端 |
| `symbols` | `Record<string, bigint> \| Map<string, bigint>`，用于解析 `jmp label` 这类引用 |
| `syntax` | `intel`（默认）`\| att \| nasm \| masm \| gas`；**仅 x86 有效**，ARM 只有一种语法 |
| `friendlyErrors` | 默认 `true`：把 Keystone 的报错换成更可读的中文说明 |

返回 `AssembleResult`：

```ts
{
  bytes: Buffer;          // 完整机器码
  address: bigint;        // 起始地址
  endAddress: bigint;     // 编码后的下一个地址
  lines: AssembledLine[]; // 逐行 { source, bytes, address, empty }
  usedSymbols: Record<string, string>;  // 本次用到的符号
}
```

`assembleLines` 每行都给出地址，这是 Auto Assembler 需要的
（`alloc`/`label` 之后要把脚本行映射回地址）。它同时识别两种标号写法：

```js
assembleLines('start:\nmov eax,1\ninline: ret', { address: 0x1000n });
// 'start:' 行 empty=true 且不占地址；'inline: ret' 记录标号后编码 ret
```

### 5.5 符号解析

Keystone 的 `KS_OPT_SYM_RESOLVER` 需要传 JS 函数指针，wasm 绑定未暴露，
因此本移植用**文本替换**实现符号解析（语义等价、可预测、报错能指出符号名）：

```js
assemble('mov eax, dword ptr [myAddr]', {
  address: 0x1000n,
  symbols: { myAddr: 0x7ff000002000n },
});
```

替换时按名字长度倒序、用词边界匹配，不会误伤 `0xAB` 这类十六进制字面量
或寄存器名。未在符号表里的标识符会被识别并给出：

```
汇编失败：未定义的符号 "someLabel"。请先用 label/define/registersymbol/aobscan 定义，
或通过 symbols 选项传入。
```

## 六、实测得到的关键行为（都是踩过的坑）

这几条都写进了代码注释，改动前请先读对应注释：

1. **`int 3` 修正**：Keystone 0.9 把 `int 3` 编成 `CD 03`（两字节），
   而 x86 惯例与 CE 都用单字节 `CC`。本移植在整段输出恰为 `CD 03` 时替换成 `CC`。

2. **`qword ptr` 不能被 `word ptr` 抢先匹配**：数据宽度推断最初按
   `byte ptr` → `word ptr` → `dword ptr` → `qword ptr` 的顺序逐个 `match`，
   结果 `qword ptr` 里的子串命中了 `word ptr`，宽度被误判成 2 字节。
   现在用一次性分组匹配（等价"最长优先"）。

3. **Capstone 不接受 bigint 地址**：传 bigint 会在 WASM 边界抛类型错误。
   统一转 `number`，并在超过 `Number.MAX_SAFE_INTEGER` 时**明确报错**
   （`toSafeNumberAddress`），绝不静默截断。

4. **`disasm()` 返回的 `address` 是缓冲区相对偏移**，不是绝对地址。
   `backend.ts` 负责加回基址。若忘了这一步，多指令反汇编的地址会从 0 开始。

5. **`disasm()` 的参数是选项对象**，不是位置参数：
   `engine.disasm(code, { address, count })`。传三个位置参数会静默失败。

6. **Capstone 的构造器只有 `(arch, mode)`**，语法要用
   `setOption(CS_OPT_SYNTAX, CS_OPT_SYNTAX_INTEL)` 设置。

7. **前缀必须靠 `instructionText` 拼回**：只用 `opcode + parameters` 往返会丢掉
   `F3`/`F2` 前缀（`rep movsb` 退化成 `movsb`）。

## 七、正确性判定标准：语义往返 ≠ 字节往返

x86 允许**语义等价但字节不同**的多种编码，例如：

| 指令 | 形式 A | 形式 B |
| --- | --- | --- |
| `mov rsi, rdx` | `48 89 D6`（89 /r） | `48 8B F2`（8B /r） |
| `xor r14d, r14d` | `45 33 F6`（33 /r） | `45 31 F6`（31 /r） |

反汇编器给出助记符形式，重新汇编时汇编器会挑它自己的编码，因此
**字节不必相同**。CE 也如此（objdump 反汇编 / as 汇编）。

所以本移植的验证标准是**语义往返**：`反汇编 → 重新汇编 → 再反汇编`，
结果必须与原指令的助记符与操作数**逐字段一致**。

实测（`test/asm.test.js`，对目标进程真实映像段抽样）：

```
[参考] 检查 360 条：语义往返 100%，字节级一致 88.1%
```

字节级 88.1% 是正常的；测试里只把它当作"汇编器是否整体退化"的信号
（断言 > 75%），真正的断言是语义往返 100%。

## 八、测试

```bash
npm run test:asm      # 或 node --test test/asm.test.js
```

26 → **39 个用例**，五层验证：

| 层次 | 内容 |
| --- | --- |
| 编码正确性 | 20 条指令与手册/Keystone 的期望字节逐一比对（x64 + x86 + ARM + Thumb + ARM64） |
| 字段正确性 | 数据宽度、浮点标记、流程控制标记、条件码、PC 相对、多条推进 |
| **动态语义往返** | 目标进程真实映像段抽样 360 条指令，语义往返必须 100% |
| 端到端 | 汇编 → 写入目标进程 → 读回 → 反汇编 → 重新汇编，逐条比对 |
| 多架构往返 | 5 种架构各一组指令，汇编 → 反汇编 → 重新汇编，语义一致 |

## 九、已知限制

- **Capstone 不暴露 `detail`**（`capstone-wasm` 的 `readInsn` 是私有的），
  因此拿不到结构化的操作数类型/寄存器使用信息。本移植改用**助记符表**判定
  流程控制与数据宽度，对主流指令足够；冷门指令可能被标成 `isjump=false`
  （宁可少标，不错标）。
- **`separators` 是保守近似**：没有完整编码器结构，无法精确给出
  前缀/操作码/modrm/sib 的字节分界，只保证单调递增且不越界（界面分段不会错位）。
- **`ripRelative` 是近似标记**：x86 上返回固定下标 3；ARM64 上只要有 PC 相对语义
  （`adrp`/`adr`/`b`/`bl` 或操作数里出现 `pc`）就置 0。都不是精确字节位置。
- **`hasSib` 用正则判断**，极端寻址写法可能误判。
- **ARM 的"条件执行"与"条件跳转"分开处理**：`moveq` 只填 `conditionCode`、
  不置 `isConditionalJump`（它是条件执行不是跳转）；`beq` 才置
  `isConditionalJump`。这与 CE 的处理一致，但用的时候要留意区别。
- **ARM 的数据宽度靠助记符/寄存器推断**：`ldrb`→1、`ldrh`→2、`ldrd`→8、
  `s0`→4、`d0`→8；`push`/`pop`/`ldm`/`stm` 是块操作，返回 0（没有单一宽度）。
- **ARM64 的 `str w0, [x1, #-4]` 可能被 Capstone 解码成 `stur w0, ...`**：
  这是同一指令的"非 scaled 形式"，属正常现象，不影响往返。
- **不支持 ARM 的 ThumbEE / Jazelle、ARM64 的 SVE2 全指令集**：
  Keystone/Capstone 支持到哪就是哪。
- **`dataSize` 对部分指令返回 0**（例如无操作数的 `ret`/`nop`），这是预期行为。
- 汇编语法以 Keystone/NASM 为准。CE 汇编器里那些针对旧语法的兼容分支
  （`$` 前缀十六进制、`offset` 关键字等）**未实现**，遇到时 Keystone 会报错。
