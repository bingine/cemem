# node-cheat-engine

**Cheat Engine 核心引擎的 Node.js 移植版** —— 跨进程内存扫描 / 修改引擎，
算法语义逐行对齐 Cheat Engine 源码，提供 npm 类库与 TypeScript 类型。

> ⚠️ **先读这个**：本移植**不是**整个 Cheat Engine 的逐行重写。
> 原始代码约 **562,000 行**，其中约 **8 万行是 ring-0 内核驱动与 hypervisor**，
> 在 Node 用户态里**不存在实现路径**。已移植与未移植部分的完整清单、
> 以及每一项"为什么做不到"，见 **[PORT-SCOPE.md](PORT-SCOPE.md)**。

## 特性

- **完整的内存扫描引擎**：14 种扫描选项 × 6 种数值类型，另含
  字符串 / Unicode / AOB（支持半字节通配）/ 二进制位串 / 全部类型 / 分组长扫描
- **浮点语义对齐**：复刻 FPC 的偶舍入（banker's rounding）与 CE 的
  `rtRounded` / `rtExtremeRounded` / `rtTruncated` 三种策略（**含 CE 自身
  在 Single 用闭区间、Double 用开区间的不一致行为**）
- **指针扫描**：指针映射 + 逐级回溯，结果可用 `applyPointerPath` 验证
- **地址表与 `.CT` 读写**：与 CE 的 Cheat Table XML 双向兼容，未知元素往返不丢
- **地址表达式**：`"game.exe"+1234`、`[[base]+10]+8`、`GetModuleBase(...)` 等
- **反汇编 / 汇编**：x86/x64 **及 ARM / Thumb / ARM64** 反汇编
  （字段对齐 CE 的 `TLastDisassembleData`）与汇编（含符号解析、逐行地址映射）
- **Auto Assembler**：CE 脚本的 `alloc`/`label`/`aobscan`/`[ENABLE]`/`[DISABLE]` 等，
  x86/x64 与 ARM 目标都支持
- **Lua 脚本桥**：61 个 CE Lua API 函数 + `autoAssemble`/`autoAssembleCheck`
  （Lua 5.4，int64 全程不丢精度）
- **并行扫描**：worker + SharedArrayBuffer，已校验与单线程结果**逐地址一致**
- **三种可切换后端**：自研引擎（同步、开箱即用）、原生 CE（连接 `ceserver`）、DBK 内核驱动（读受保护进程）
- **无 GUI 依赖**：纯类库，可嵌入任何 Node 程序

## 安装

```bash
npm install node-cheat-engine
```

要求：Node.js ≥ 18，Windows x64（使用 Win32 原生 API）。

## 快速开始

```js
const {
  Process,
  ScanSession,
  VariableType,
  ScanOption,
  RoundingType,
} = require('@bingine/cemem');

// 1) 打开目标进程（默认使用自研后端）
const proc = Process.openByName('notepad.exe');
console.log(`已附加：${proc.name} (pid ${proc.pid})`);

try {
  // 2) 首次扫描：找 int32 值 1000
  const scan = new ScanSession(proc);
  scan.firstScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: '1000',
    includeImage: false,   // 不扫模块映像区，减少噪声
    includeMapped: false,
  });
  console.log(`首次扫描命中 ${scan.resultCount} 个`);

  // 3) 游戏里让数值变化后，再次扫描缩小范围
  scan.nextScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.DecreasedValue,   // 减少了
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    includeImage: false,
    includeMapped: false,
  });
  console.log(`再次扫描后剩 ${scan.resultCount} 个`);

  // 4) 对结果写入新值
  for (const addr of scan.results.slice(0, 5)) {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(999999, 0);
    proc.writeMemory(addr, buf);
  }
} finally {
  proc.close();
}
```

## 常用片段

### AOB 扫描（含通配）

```js
const { Process, ScanSession, VariableType, ScanOption, RoundingType } = require('@bingine/cemem');

const proc = Process.open(1234);
const scan = new ScanSession(proc);
scan.firstScan({
  variableType: VariableType.ByteArray,
  scanOption: ScanOption.ExactValue,
  roundingType: RoundingType.Rounded,
  floatAccuracy: 0,
  value1: 'DE AD BE EF 90 90 ?? 7*',   // ?? = 通配字节；7* = 高半字节必须为 7
});
console.log(scan.results.map((a) => '0x' + a.toString(16)));
proc.close();
```

### 指针扫描

```js
const { Process, PointerScanner, applyPointerPath, formatPointerPath } = require('@bingine/cemem');

const proc = Process.open(1234);
const ps = new PointerScanner(proc, { maxLevel: 5, maxOffset: 2048, staticOnly: true });
const paths = ps.scan(0x1234abcdn);

for (const p of paths.slice(0, 10)) {
  console.log(formatPointerPath(p));
  // 验证：沿路径解析应回到目标地址
  console.assert(applyPointerPath(p, (a) => ps.readPointer(a)) === 0x1234abcdn);
}
proc.close();
```

### 读写 Cheat Table

```js
const fs = require('node:fs');
const { loadCheatTable, saveCheatTable, Process } = require('@bingine/cemem');

const proc = Process.open(1234);
const { list } = loadCheatTable(fs.readFileSync('my.CT', 'utf8'), proc);

// 读所有条目的当前值
for (const row of list.snapshot()) {
  console.log(row.description, row.addressText, '=', row.value, row.error ?? '');
}

// 改一个值并锁定
const rec = list.getByDescription('生命值');
rec.value = '9999';
rec.frozen = true;
setInterval(() => list.tickFrozen(), 100);   // 宿主自行驱动锁定写回

proc.close();
```

### Lua 脚本

```js
const { LuaEngine } = require('@bingine/cemem');

const lua = new LuaEngine();
await lua.doString(`
  openProcess("notepad.exe")
  local v = readInteger("0x7ff000001000")
  print("读到 " .. v)
`);
lua.dispose();
```

完整 API 见 [docs/lua-api.md](docs/lua-api.md)。

### 反汇编与汇编

```js
const {
  ensureAsmBackend, disassembleOne, formatDisassembled,
  assembleToBytes, instructionText,
} = require('@bingine/cemem');

await ensureAsmBackend();   // WASM 异步初始化，必须先调用

// 反汇编
const insn = disassembleOne(Buffer.from('488b0510203040', 'hex'), 0x7ff000001000n);
console.log(insn.opcode);       // 'mov'
console.log(insn.parameters);   // 'rax, qword ptr [rip + 0x40302010]'
console.log(insn.dataSize);     // 8
console.log(formatDisassembled(insn));
// 00007FF000001000 - 48 8B 05 10 20 30 40  - mov rax, qword ptr [rip + 0x40302010]

// 汇编
const bytes = assembleToBytes('mov rax, 1\nret', { address: 0x1000n });
console.log(bytes.toString('hex'));   // '48c7c001000000c3'

// 往返必须用 instructionText（含 rep/lock 前缀）
const rep = disassembleOne(Buffer.from('f3a4', 'hex'), 0x1000n);
instructionText(rep);                   // 'rep movsb'
assembleToBytes(instructionText(rep), { address: 0x1000n }); // f3a4
```

后端是 Capstone + Keystone —— **CE 自己也是调 binutils 的 objdump/as**，
自带 Pascal 实现只是回退路径（详见 [docs/assembler.md](docs/assembler.md)）。

**ARM / Thumb / ARM64** 用 `arch` 参数切换：

```js
const { assembleToBytes, disassemble, instructionText } = require('@bingine/cemem');

// ARM64
const a64 = assembleToBytes('stp x29, x30, [sp, #-16]!\nret', {
  address: 0x400000n, arch: 'arm64',
});
disassemble(a64, 0x400000n, 4, { arch: 'arm64' })
  .forEach((i) => console.log(instructionText(i)));
// stp x29, x30, [sp, #-0x10]!
// ret

// Thumb（2/4 字节变长）
assembleToBytes('movs r0, #1\nbx lr', { address: 0x1000n, arch: 'thumb' });

// 大端 ARM
assembleToBytes('mov r0, r1', { address: 0x1000n, arch: 'arm', endianness: 'big' });
```

> **数字进制**：汇编器里裸数字是**十进制**，十六进制写 `0x100` 或 `100h`
> （CE 帮助文档里十六进制一律带 `h` 后缀，与 GNU as 一致，Keystone 也支持 `h`）。
> 但 `db`/`dw`/`dd`/`dq` 的裸数字**是十六进制**（`db 89 01` 就是 `0x89 0x01`）。
> 这两套约定不同，别混。

### Lua 里调用 Auto Assembler

```js
const { LuaEngine } = require('@bingine/cemem');

const lua = new LuaEngine();

// 无进程时自动进入"只检查"模式；因此示例用绝对地址
// （alloc 块名标签需要真实进程才能解析，见下方 Auto Assembler 一节）
await lua.doString(`
  local ok = autoAssemble([[
[ENABLE]
define(hpAddr, 00401000)
hpAddr:
  mov dword ptr [rbp-4], 9999
  ret
]])
  if not ok then print("失败: " .. tostring(autoAssembleError())) end
`);

// 有进程时可用 alloc / aobscan / 模块相对地址
lua.attachProcess(require('@bingine/cemem').Process.open(1234));
await lua.doString(`
  local ok = autoAssemble([[
[ENABLE]
aobscan(hp, 89 5D FC 8B 45 08)
alloc(newmem, 256)
label(returnhere)
newmem:
  mov dword ptr [rbp-4], 9999
  jmp returnhere
returnhere:
]])
  if not ok then print("失败: " .. tostring(autoAssembleError())) end
`);
lua.dispose();
```

`autoAssemble(script [, enable])` 与 `autoAssembleCheck(script [, enable])`
返回布尔值（不抛 Lua 错误），失败详情用 `autoAssembleError()` 取（含行号）。

### Auto Assembler（CE 脚本）

`autoAssemble` 是**独立函数**，脚本内容与进程都通过参数传入：

```js
const { Process, autoAssemble, ensureAsmBackend } = require('@bingine/cemem');

await ensureAsmBackend();
const proc = Process.openByName('notepad.exe');

const script = `
[ENABLE]
aobscanmodule(hp, notepad.exe, 89 5D FC 8B 45 08)
alloc(newmem, 256)
label(returnhere)

newmem:
  mov dword ptr [rbp-4], 9999
  jmp returnhere

"notepad.exe"+1234:
  jmp newmem
returnhere:

[DISABLE]
"notepad.exe"+1234:
  mov [rbp-4], ebx
`;

// 写入（[ENABLE] 段）
const on = autoAssemble(script, { process: proc, enable: true });
console.log('分配:', on.allocations, '写入条目:', on.entries.length);

// 还原（[DISABLE] 段）：用 ENABLE 前记录的原始字节精确还原
autoAssemble(script, { process: proc, enable: false });

proc.close();
```

**只做语法检查**（不分配、不写内存）——省略 `process` 即自动进入该模式：

```js
// 注意：无进程时无法求值地址表达式、也无法真正 alloc，
// 因此脚本必须用**绝对数字地址**定位，不能用 "mod.exe"+xxx 或 alloc 块名。
const checked = autoAssemble(`
[ENABLE]
define(hpAddr, 00401000)
hpAddr:
  mov dword ptr [rbp-4], 9999
`, { syntaxCheckOnly: true });

console.log('语法检查通过，将写入', checked.entries.length, '处');
```

支持：`[ENABLE]`/`[DISABLE]`、`alloc`/`dealloc`/`realloc`/`globalalloc`、
`label`/`define`/`registersymbol`、`aobscan`（+`module`/`region`/`unique`）、
`createthread`（仅参数校验，Node 无 `CreateRemoteThread`）、`include`、
`db`/`dw`/`dd`/`dq`、`nop`/`align`、`readmem`/`loadbinary`。

**关键机制**：`[ENABLE]` 写入前逐字节记录原始字节，`[DISABLE]` 逆序精确还原——
即使 `[DISABLE]` 段为空也能还原。失败时 `AutoAssemblerError` 会带**行号**。
详见 [docs/autoassembler.md](docs/autoassembler.md)。

> 注意：引擎层的 Auto Assembler 已完整可用，但**尚未包成 Lua 全局函数**
> `autoAssemble` / `autoAssembleCheck`，因此从 Lua 脚本里还调不到。

### 切换到原生 CE 后端

```js
const { NativeCeBackend, openProcessAsync } = require('@bingine/cemem');

const backend = new NativeCeBackend({ host: '127.0.0.1', port: 52736 });
console.log('ceserver:', await backend.getVersion());

const proc = await openProcessAsync(1234, { backend });
const buf = await proc.readMemoryAsync(0x7ff000001000n, 16);  // 注意 await

await proc.closeAsync();
await backend.dispose();
```

两种后端的对比、以及**为什么原生 CE 后端必须是异步的**（附最小复现），
见 [docs/backends.md](docs/backends.md)。

### 第三种：DBK 内核驱动后端

还有一个 `DbkBackend`，通过 CE 自己的 DBK 内核驱动 ioctl 读写 ——
这是**读受保护进程（PPL/反作弊）的唯一途径**（用户态连句柄都打不开）。

```js
const { DbkBackend, Process } = require('@bingine/cemem');

const backend = new DbkBackend({ cheatEngineDir: 'C:\\Program Files\\Cheat Engine' });
console.log(backend.probe());   // 设备能否打开、驱动版本

const proc = Process.open(1245, { backend });
proc.readMemory(0x7ff000001000n, 64);   // ← 走内核 ioctl
```

**前提**：驱动必须先加载（需要管理员权限；可用 DSH 插件的 `ce_kernel` 工具装）。

> ⚠️ **诚实说明**：这个后端的 ioctl 码与输入结构是**逐行核对 CE 源码**
> （`DBK32functions.pas`）实现的，但**驱动侧实际期待的结构布局未经真机验证** ——
> 因为验证前提是加载驱动，而那需要管理员权限。
> 协议细节、已知风险与排查方法见 [docs/backend-dbk.md](docs/backend-dbk.md)。
> 提供 `probe()` 让你能在装好驱动的机器上确认连通性。

## 两条调用路径怎么选

| 场景 | 选择 |
| --- | --- |
| 想开箱即用、依赖最少 | `SelfBackend`（默认，同步） |
| 需要复用已部署的原生 CE / ceserver | `NativeCeBackend`（异步） |
| 目标进程受保护（反作弊/PPL） | `DbkBackend`（需要内核驱动 + 管理员）；或提权后的 ceserver |
| 想写一套代码适配两者 | 统一用 `*Async` 方法 + `await`（对两种后端都安全） |

## 开发

```bash
npm install
npm run build          # 编译到 dist/
npm test               # 169 个测试，全部真实跨进程运行
npm run smoke          # 16 项冒烟检查（人类可读输出）
```

测试文件：

| 文件 | 覆盖 | 用例 |
| --- | --- | --- |
| `test/scanner.test.js` | 扫描选项、类型、并行一致性、指针扫描、matcher 纯函数 | 21 |
| `test/asm.test.js` | 反汇编/汇编（5 种架构）、动态语义往返、端到端写入目标进程 | 39 |
| `test/autoassembler.test.js` | AA 全指令、ENABLE/DISABLE 还原、行号错误 | 45 |
| `test/cheattable.test.js` | 地址表达式、MemoryRecord、地址表、`.CT` 往返 | 7 |
| `test/backend.test.js` | 两个后端、ceserver 协议逐字段核对 | 20 |
| `test/dbk-backend.test.js` | DBK 内核驱动后端：ioctl 码、packed 结构、设备名解析、分配、错误路径 | 24 |
| `test/lua-bridge.test.js` | Lua 桥、int64 精度、AOBScan、autoAssemble、错误处理 | 13 |

测试目标是 `test/fixture-target.js` —— 一个用 `VirtualAlloc` 分配可预测内存的
真实子进程（含固定偏移的各类变量、指针链、AOB 特征），
因此所有断言都是**真实跨进程**验证，而不是内存内的模拟。

## 架构

```
src/
  types.ts                  变量类型/扫描选项等枚举（对齐 memscan.pas）
  value-codec.ts            值编解码、roundTo、AOB 解析
  backend/                  内存后端抽象
    types.ts                MemoryBackend 接口（同步/异步）
    self-backend.ts         自研后端（Win32 直调，同步）
    native-ce-backend.ts    原生 CE 后端（ceserver TCP，异步）
  win/
    winapi.ts               koffi 绑定
    process.ts              后端无关的 Process 门面
    scan-worker.ts          并行扫描 worker
  scanner/
    matcher.ts              比较规则编译与块扫描（对齐 TScanner）
    scanner.ts              ScanSession（对齐 TMemScan/TScanController）
    shared-layout.ts        跨线程共享内存布局
    pointer-scan.ts         指针扫描
  addr/expression.ts        地址表达式解析
  asm/                      反汇编与汇编
    backend.ts              Capstone/Keystone 封装 + 精度守卫
    disassembler.ts         反汇编，字段对齐 TLastDisassembleData
    assembler.ts            汇编，符号解析 + 逐行地址映射
    autoassembler.ts        Auto Assembler（alloc/label/aobscan/[ENABLE]）
  addresslist/memory-record.ts  地址表与内存记录
  cheattable/ct-format.ts   .CT 读写
  lua/                      Lua 脚本桥（61 个 CE API）
  index.ts                  公共 API 入口
```

## 已知限制

- 仅支持 Windows x64（依赖 Win32 原生 API）
- **无内核驱动**：受保护进程（反作弊、PPL）读不到 —— 这是与 CE 未加载驱动时相同的限制
- **无 GUI**：只提供类库（按设计要求，不做窗口化）
- **ARM 的 ThumbEE/Jazelle 与 ARM64 的 SVE2 全指令集**未覆盖
  （反汇编/汇编后端支持到哪就是哪）
- **无反汇编视图级别的注释**：CE 的 `disassemblerComments.pas`（433 行，
  给 `call`/`mov` 自动加注释）未移植
- 原生 CE 后端**必须异步**，且需要自行准备 `ceserver`
- 首次扫描会把命中块的原始内存留在快照里（默认上限 1.5GB），
  用于「再次扫描」的旧值比较；不需要时可调小 `maxSnapshotBytes`
- 反汇编/汇编需要 `await ensureAsmBackend()`（WASM 异步初始化）

## 许可

MIT。本移植为独立实现；Cheat Engine 本身版权归其作者，见原仓库 `LICENSE`。
