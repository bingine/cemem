# Auto Assembler（CE 脚本语言）

把 Cheat Engine 的 **Auto Assembler 脚本**解析并执行到目标进程。
对齐 `Cheat Engine/autoassembler.pas`（3752 行）以及 `Assemblerunit.pas` 里
属于 Auto Assembler 的那部分（`db/dw/dd/dq`、`nop N`、`align`）。

- 实现：`src/asm/autoassembler.ts`（引擎）+ `src/asm/autoassembler-directives.ts`（伪指令编码）
- 测试：`test/autoassembler.test.js`（44 个用例，全部在真实跨进程条件下运行）
- 依赖：[assembler.md](assembler.md)（Keystone 汇编）、[backends.md](backends.md)（进程内存读写）

---

## 一、它解决什么问题

CE 的 Auto Assembler 是「把一段脚本变成对目标进程内存的修改」的编译器 + 执行器：

```text
[ENABLE]
alloc(newmem,2048)                       // 1. 在目标进程分配可执行内存
label(returnhere)                        // 2. 声明脚本内标签
aobscan(sig, DE AD BE EF 90 90 ?? 7*)     // 3. 在目标进程里搜特征码
newmem:                                  // 4. 地址定位：后续指令从这里开始排布
  mov dword ptr [sig], 1337              // 5. 写机器码
  jmp returnhere
sig:                                     // 6. 回到 aobscan 找到的地方
  jmp newmem
returnhere:
[DISABLE]
dealloc(newmem)                          // 关闭时释放
```

注意第 4/6 步：脚本里的 `sig:` / `newmem:` 是**地址定位行**，
它们决定了后面那段指令写到哪个地址去 —— 这是 CE 脚本最核心、也最容易被
重新实现时忽略的语义（详见第四节）。

---

## 二、快速上手

```js
const { ensureAsmBackend } = require('node-cheat-engine/dist/cjs/asm/backend');
const { AutoAssembler, AutoAssemblerError } = require('node-cheat-engine/dist/cjs/asm/autoassembler');
const { Process } = require('node-cheat-engine/dist/cjs/win/process');

await ensureAsmBackend();                    // WASM 后端必须先初始化

const proc = Process.open(pid);
const aa = new AutoAssembler({ process: proc });

try {
  aa.enable(script);      // 执行 [ENABLE]，写入前逐字节记录原字节
  // ... 用户玩游戏 ...
  aa.disable(script);     // 执行 [DISABLE]，精确还原
} catch (e) {
  if (e instanceof AutoAssemblerError) {
    console.error(`第 ${e.lineNumber} 行出错：${e.line}`);
    console.error(e.message);
  }
  throw e;
} finally {
  aa.cleanup();           // 释放本会话还留着的 alloc
  proc.close();
}
```

**成对往返必须复用同一个 `AutoAssembler` 实例** —— `[DISABLE]` 的精确还原依赖
`[ENABLE]` 时记录在实例里的原字节（对应 CE 的 `TDisableInfo`）。

只要做语法检查、不碰目标进程：

```js
const aa = new AutoAssembler({ startAddress: 0x1000n });   // 不给 process
const r = aa.check(script);   // 只解析 + 汇编，不分配、不写内存
r.lines.forEach(l => console.log(l.text, '->', l.bytes.toString('hex')));
```

---

## 三、执行流水线

每一步都对应 CE 的一个函数，便于对照源码排查：

| 阶段 | 本移植 | Cheat Engine |
| --- | --- | --- |
| 去注释 | `stripComments` | `removecomments`（autoassembler.pas:733） |
| 展开 include | `expandIncludes` | 解析循环里的 `INCLUDE()` 分支（:2240） |
| 找段 | `analyzeSections` | `getenableanddisablepos`（:4463） |
| 取段 | `selectLines` | `getEnableOrDisableScript`（:4511） |
| CPU 专属段 | `stripCpuSpecific` | `stripCPUspecificCode`（:4550） |
| 预处理 | `preprocess` | `autoassemble2` 的解析循环（:1499 起） |
| 布局 + 汇编 | `layout` / `encodeInstruction` | `AutoassemblerCodePass2`（:3550 起） |
| 写内存 | `apply` | 写内存分支（:4088 起） |

---

## 四、关键语义

### 4.1 地址定位行（脚本被切成若干"块"）

脚本**不是**从某个固定地址顺序汇编下来的。每一行形如 `xxx:` 的行都在设定"当前地址"：

| 写法 | 含义 |
| --- | --- |
| `newmem:` | `newmem` 是已知符号（`alloc` / `aobscan` / `registersymbol`）→ 当前地址**重置**为该符号的地址 |
| `returnhere:` | 纯脚本标签 → 该标签**取当前地址**（不改变当前地址） |
| `00401000:` | 地址字面量（**十六进制**）→ 当前地址重置为该值 |
| `"game.exe"+1234:` | 地址表达式（模块基址 + **十六进制**偏移）→ 当前地址重置 |

在出现任何地址定位行之前写代码，会直接报错
（CE 的 `rsThereIsCodeDefinedWithoutSpecifyingTheAddressItBel`），
避免把代码写到地址 0。可以用 `startAddress` 选项显式给一个起始地址。

### 4.2 前向引用与指令长度收敛

`jmp returnhere` 里的 `returnhere` 定义在后面，它的地址又取决于前面指令的长度 ——
循环依赖。CE 的做法（autoassembler.pas:3610~3763）是：

1. 用「当前地址」当**近**占位符编一次；
2. 用「当前地址 + 0xFFFFF」当**远**占位符再编一次；
3. 取**较长**的那个，保证后续地址不会因为编码变短而漂移。

本移植沿用该策略，并在此之上做**迭代收敛**：反复布局直到所有标签地址稳定
（上限 20 轮，仍不稳定则报错而不是产出错误字节）。
因此本移植允许标签定义在引用之后，且 `label(name)` 不是必需的（CE 里必需）。

> 差异：Keystone 会自动为已经解析出真实地址的 `jmp` 选择**最短编码**
> （能装进 rel8 就用 2 字节短跳）；CE 会先按长编码排布、最后补 NOP。
> 因此**同一个脚本，本移植的字节数可能比 CE 短**（例如 `jmp skip` 编成 `EB 05`
> 而不是 `E9 05 00 00 00`），但跳转目标一致、语义等价。

### 4.3 原字节记录与还原

`[ENABLE]` 每写一块内存之前，先把该区间的原字节读出来记录（按地址升序、互不重叠、相邻合并）。
`[DISABLE]` 时：

| `restoreMode` | 行为 |
| --- | --- |
| `'original'`（**默认**） | 先按记录**逆序**精确还原所有被覆盖区间；`[DISABLE]` 段里不与记录重叠的部分照常写入 |
| `'script'` | 完全按 `[DISABLE]` 段脚本写（CE 原生行为）；记录只用于诊断 |

默认值的好处：**即使 `[DISABLE]` 段是空的，也能逐字节还原**；
坏处：如果脚本作者故意想让 `[DISABLE]` 写出与原始内容不同的字节，需要显式切到 `'script'`。

两点实现细节（都是踩过的坑）：

- `dealloc`/`realloc` 释放内存后，必须把落在该块里的还原记录一起丢掉 ——
  否则关闭时会去写一块已经还给系统的内存，得到 `ERROR_INVALID_ADDRESS (487)`。
- **每个脚本一份记录**（key = 规范化后的脚本原文）。这样可以同时启用多个脚本、
  再各自独立关闭；共用一份记录会让后启用的脚本冲掉前一个的还原依据。
  记录本身可以通过 `historyOf(script)` / `hasHistory(script)` 查看。

### 4.4 数字进制（最容易静默出错的地方）

**指令操作数与 `db/dw/dd/dq`/`nop`/`align` 的裸数字都按十六进制**，与 CE 一致：

```asm
mov eax, 100        ; → B8 00 01 00 00   （即 0x100，不是十进制 100）
db 89 01 00 00 00   ; → 89 01 00 00 00   （真实 CE 脚本的写法，必须按十六进制）
```

这是个**实测结论**：Keystone 的 Intel 语法与 CE 的 `HexStrToInt` 行为相同。
因此本移植不需要做任何数字改写，真实 CE 脚本可以直接跑。

`db/dw/dd/dq` 额外支持 `#` 前缀写十进制（`db #255` → `FF`），
这是本移植的扩展（Keystone 不支持 `#`，所以**指令里**无法直接写十进制，
需要自己换算成十六进制）。

**例外：`alloc` / `globalalloc` / `realloc` / `readmem` 的"大小"参数按十进制**
（对齐 CE 的 `StrToInt`）：

```text
alloc(newmem, 2048)     ; 2048 字节
alloc(newmem, $800)     ; 也可以：0x800 = 2048 字节
readmem(addr, 16)       ; 16 字节
```

### 4.5 写入只读页

写入统一走 `Process.writeMemory(addr, bytes, true)`，`fixProtection=true`
会临时把页改成可写再写回（与 CE 的 `VirtualProtectEx + WriteProcessMemory` 流程一致），
所以往游戏代码段（`PAGE_EXECUTE_READ`）注入是可以的。

---

## 五、支持的指令

大小写不敏感。参数按 `,` 与空白切分；字符串用 `'` 或 `"` 包裹。

### 5.1 段

| 语法 | 说明 |
| --- | --- |
| `[ENABLE]` | 启用段。|
| `[DISABLE]` | 停用段。|
| `[32-BIT]` … `[/32-BIT]` | 仅在 32 位目标下编译。|
| `[64-BIT]` … `[/64-BIT]` | 仅在 64 位目标下编译。|

**两个段之外的代码在 enable 与 disable 时都会执行**（`alloc`/`registersymbol` 通常写在外面）。

段重复定义会报错；只写了一个段时给出警告（CE 会直接报错，见第六节）。

### 5.2 分配与释放

| 语法 | 说明 |
| --- | --- |
| `alloc(name, sizeinbytes)` | 在目标进程分配可写可执行内存，并注册符号 `name`。|
| `alloc(name, sizeinbytes, preferred)` | 额外给出首选地址（地址表达式）；不可用时自动退化为任意地址并记警告。|
| `globalalloc(name, size)` | 分配并登记为全局符号（后续脚本可见）。|
| `realloc(name, size)` | 释放同名块后重新分配同一大小（`name` 必须已分配）。|
| `dealloc(name)` / `dealloc(*)` | 释放指定块 / 本会话分配的全部块。|

`size` 为十进制（可用 `0x`/`$` 前缀）。重复 `alloc` 同一个名字时默认**复用**已有地址并警告
（`reuseAllocations: false` 可关闭）。

### 5.3 符号

| 语法 | 说明 |
| --- | --- |
| `label(name)` | 声明脚本内标签（`.`, `$`, `?`, `@` 与 `_` 允许出现在名字里）。可一次写多个：`label(a b c)`。|
| `define(name, whatever)` | **纯文本替换**：从该行往后，`name` 会被替换成 `whatever` 的原文。|
| `registersymbol(name)` | 把符号登记到会话的全局符号表（`unregistersymbol`/`cleanup` 之前一直有效）。|
| `unregistersymbol(name)` / `unregistersymbol(*)` | 取消登记。|

`define` 的细节与 CE 一致：定义行本身不参与替换；后面的 `define` 值里会先应用之前的 `define`；
同一名字重复定义时是"重新定义"，不是报错。

`registersymbol` 可以引用**布局之后才知道地址**的东西（`label` 定义的标签、`alloc`、`aobscan`），
因此写在定义之前也没问题；完全找不到符号时记警告并跳过。

### 5.4 特征码扫描

| 语法 | 说明 |
| --- | --- |
| `aobscan(name, 11 22 33 ** 55)` | 全进程扫描（可读内存）。|
| `aobscanmodule(name, module, 11 22 33)` | 限定在某个模块的映射范围内扫描。|
| `aobscanregion(name, start, stop, 11 22 33)` | 限定在 `[start, stop)` 区间扫描（地址表达式）。|
| `aobscanunique(name, 11 22 33)` | 命中多于一处的**报错**（用于要求唯一）。|

特征串支持：`??` / `**` / `xx` / `?` / `*`（整字节通配）、`7*`（高半字节固定）、`*7`（低半字节固定）。
命中多处时取**最低地址**（CE 也是取第一处），并在 `warnings` 里说明命中了几处。
所有命中都会出现在结果的 `aobScans` 里（含 `matches` 数组），便于诊断。

### 5.5 数据与填充

| 语法 | 说明 |
| --- | --- |
| `db 90 90` / `db 'ABC'` | 1 字节/元素；字符串按 latin1 逐字节写入。|
| `dw 1234` / `dw 'AB'` | 2 字节小端；字符串按 UTF-16LE 写入。|
| `dd 12345678` | 4 字节小端。|
| `dq 1` | 8 字节小端。|
| `nop` | 交给汇编器（1 字节 `90`）。|
| `nop 5` | 5 字节多字节 NOP（用 CE 的表：`0F 1F 44 00 00`）。|
| `align 10` | 填充到 16 字节边界，**填 0x00**（与 CE 相同）。|
| `align 10, 90` | 填充到 16 字节边界，填 `0x90`。|

`db` 还支持 CE 的两个特殊写法（**需要目标进程**）：

| 写法 | 含义 |
| --- | --- |
| `db ?? ??` | 读目标进程当前字节并原样写回（"保持这一段的原内容"）。|
| `db +1` / `db -1` | 读目标进程当前字节后加减，按 1 字节回绕。|

### 5.6 其它

| 语法 | 说明 |
| --- | --- |
| `include(filename.cea)` | 就地插入另一个脚本文件；省略扩展名时补 `.cea`。搜索顺序：脚本所在目录 → cwd → `includeDirs`。递归上限 8 层。|
| `readmem(address, size)` | 读取目标进程 `size`（十进制）字节，作为 `db` 写进当前位置。|
| `loadbinary(address, filename)` | 把二进制文件内容写到目标进程的 `address`。|
| `assert(address, 11 22 33 ** 55)` | 校验目标内存**必须匹配**该特征串，否则报错并给出实际字节。|
| `createthread(address)` | **只做参数校验**，地址写入结果的 `createThreads`，不创建线程。|
| `createthreadandwait(label[, timeout])` | 同上（只校验）。|

### 5.7 注释

`//` 行尾注释、`;` 行尾注释、`/* ... */` 块注释、`{ ... }` 块注释。
引号内的内容不会被当成注释（`db 'a;b'` 会得到 `61 3B 62`）。

---

## 六、与 Cheat Engine 的差异

| 项 | CE | 本移植 | 影响 |
| --- | --- | --- | --- |
| 只写了 `[ENABLE]` 或只写了 `[DISABLE]` | 报错 | 警告，缺省段当空段 | 更宽松；往返还原仍正确（靠原字节记录） |
| `createthread` / `createthreadandwait` | 真的 `CreateRemoteThread` 执行注入的代码 | 只做参数校验并记录 | Node 无对应能力；`allowCreateThread: true` 会明确报错 |
| `label(x)` 声明后没有 `x:` 定义行 | 报错 | 警告 | 更宽松 |
| `registersymbol` 找不到符号 | 注册一个未解析符号（静默） | 警告并跳过 | 更容易发现拼写错误 |
| 前向跳转的编码 | 先按长编码排布，最后补 NOP | 让 Keystone 选最短编码 | 同样语义，**字节数可能更短** |
| `[DISABLE]` 的还原依据 | 以 `[DISABLE]` 脚本为准（memoryrecord 层另有原字节缓存） | 默认以记录的原字节为准（`restoreMode:'original'`） | 空 `[DISABLE]` 也能精确还原；要 CE 原生行为用 `'script'` |
| 一个会话多个脚本 | 每个内存记录各自一份 `TDisableInfo` | 每个脚本一份记录（按脚本原文分桶） | 行为等价 |
| `aobscan` 的多处命中 | 只暴露第一处 | 第一处 + `aobScans[].matches` 全部 | 纯增强 |
| `globalalloc(name,size)` 的前提 | 要求 `name` 已是已注册符号 | 直接分配并登记 | 更宽松 |
| `realloc(name,size)` | AA 脚本里有 `dealloc` 没有 `realloc`（在 Lua 层） | 脚本里可直接用（= 释放后重新分配） | 纯增强 |
| `aobscanregion` 的 `stop` | 含端点语义按 CE 的 `maxaddress` 处理 | 区间为 `[start, stop)` | 相差不超过 1 字节 |
| 同名 `db ??` 无目标进程 | 不可能（AA 总是对着进程跑） | 退化为 `00` 并给警告 | 仅语法检查模式会出现 |
| `include` 里的 `[ENABLE]` 标记 | 不参与分段 | 参与分段 | 超集 |
| `LuaCall` / `Reassemble` / `Struct` / `{$...}` 等 | 支持 | 明确报"未实现" | 见第七节 |

---

## 七、已知限制

1. **不创建远程线程**。`createthread` 只校验参数。因此"注入的代码被立刻执行"
   这条链路需要调用方自己用其它手段（例如让目标自己的线程走到注入点）完成。
2. **未实现的指令**（会抛出带行号的中文错误，而不是让 Keystone 抛怪错）：
   `LuaCall`、`Reassemble`、`Struct`、`Kalloc`、`sharedAlloc`、`FullAccess`、
   `LoadLibrary`、`AllocNX`、`AllocXO`、`AOBSCANEX`、CE 的条件编译 `{$...}`。
3. **没有 CE 调试器/异常处理的支持**：`try`/`except` 段、断点、寄存器上下文
   （`rax` 之类的寄存符号在地址表达式里没有值）都不存在。
4. **模块级扫描依赖进程模块列表**：`aobscanmodule` 用 `Process.modules()`；
   32/64 位跨架构（WOW64 目标）下模块枚举由后端决定。
5. **`createthreadandwait` 的标签参数在运行期才确定地址**时只给警告，不做延迟解析。
6. **不支持的 `db` 语法**：`dd 'ABC'` / `dq 'ABC'` 会报错
   （CE 会走 `HexStrToInt` 的字符分支，得到的字节很难预期）。
7. **段以外的"裸代码"必须能被汇编器编码**：本移植不做 CE 那种
   "先用占位符编一遍、失败就换个占位符" 的宽容回退；
   真正无法编码的指令会带行号报错。
8. **`readmem` / `loadbinary` 的路径解析**：`loadbinary` 相对路径以
   `scriptPath` 所在目录（未给则 cwd）为基准，不做 CE 的 `cheatenginedir` 搜索。

---

## 八、API 参考

### `new AutoAssembler(options)`

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `process` | 无 | 目标进程；**省略即进入 syntaxCheckOnly 模式**（只解析汇编） |
| `bitness` | 自动 | `32` / `64`；省略时按 `process.isWow64()` 推断 |
| `includeDirs` | `[]` | `include()` 的额外搜索目录 |
| `scriptPath` | 无 | 主脚本路径，用于解析 `include()` / `loadbinary` 的相对路径 |
| `allowCreateThread` | `false` | `true` 时遇到 `createthread` 直接报错（本移植不支持创建线程） |
| `restoreMode` | `'original'` | `'original'` / `'script'`，见 4.3 |
| `reuseAllocations` | `true` | 重复 `alloc` 同名时复用已有地址 |
| `scanBlockSize` | `1048576` | `aobscan` 的扫描块大小 |
| `scanParallel` | `false` | 是否用 worker 并行扫描（脚本场景要求确定性，故默认关） |
| `dataHexDefault` | `true` | `db/dw/dd/dq` 的裸数字是否按十六进制（CE 行为，别改） |
| `startAddress` | 无 | 显式起始地址；省略时"没定位就写代码"会报错 |

### 方法

| 方法 | 说明 |
| --- | --- |
| `enable(script)` | 执行 `[ENABLE]`（等价于 `autoAssemble(script,{enable:true})`） |
| `disable(script)` | 执行 `[DISABLE]`，并按 `restoreMode` 还原 |
| `check(script)` | 只做语法检查与汇编，不分配、不写内存 |
| `autoAssemble(script, {enable, syntaxCheckOnly})` | 通用入口 |
| `symbols` | 当前符号表（只读快照） |
| `allocationsList` | 当前分配（只读快照） |
| `historyOf(script)` / `hasHistory(script)` | 查看某脚本记录的原字节 |
| `cleanup()` | 释放本会话剩余的 `alloc`，清空符号与记录 |

### `autoAssemble(script, options)`

一次性执行（内部新建一个会话）。适合"注入一次 / 语法检查"这类无状态场景；
**成对往返请用 `new AutoAssembler(...)` 复用会话**。

### `AutoAssembleResult`

| 字段 | 说明 |
| --- | --- |
| `enable` / `syntaxCheckOnly` | 本次执行的是哪一段、是否只检查 |
| `entries[]` | 每条写入：`address` / `bytes` / `originalBytes`（写前原字节）/ `restoredFromOriginal` / `line` / `lineNumber` / `file` |
| `bytesWritten` | 实际写入的字节数 |
| `lines[]` | 布局后的每一行：`text` / `address` / `bytes` / `labels` / `lineNumber` / `file` |
| `symbols` | 执行结束时的符号表（含脚本标签） |
| `allocations[]` | 当前全部 alloc |
| `registeredSymbols[]` | 由 `registersymbol` 登记的名字 |
| `createThreads[]` | `createthread` 校验通过的地址（未执行） |
| `aobScans[]` | 每个 `aobscan` 的 `{name, matches[], address, scope}` |
| `warnings[]` | 非致命问题（中文） |
| `sections` | `{enableLine, disableLine}`（脚本里段所在行号） |

### `AutoAssemblerError`

```js
class AutoAssemblerError extends Error {
  line;        // 出错的源码行（已去注释）
  lineNumber;  // 1-based 行号（include 的文件里是文件内行号）
  file;        // 出错行所属文件（主脚本为 '<script>'）
  phase;       // 'parse' | 'scan' | 'assemble' | 'write'
}
```

错误信息形如：

```text
Auto Assembler assemble 错误（第 4 行："  mov eax, 这个符号不存在"）：未定义的符号 "这个符号不存在"...
```

### 底层伪指令（可直接复用）

`src/asm/autoassembler-directives.ts` 导出了与脚本解耦的纯函数，
方便"地址表 / 内存查看器"之类的地方复用：

`parseCeInteger`、`splitDirectiveArguments`、`encodeDataDirective`、
`encodeNop`、`encodeAlign`、`parsePseudoDirective`、`patternToDbArguments`、`bytesToDbArguments`。

---

## 九、测试

```bash
npx tsc -p tsconfig.json
node --test test/autoassembler.test.js
```

测试覆盖（44 个用例，约 6.5 秒）：

- 纯函数：CE 数字解析、`db/dw/dd/dq`、多字节 NOP、`align`、通配 `??`
- 脚本解析：段分离、注释、`define`、`include`、`[32-BIT]/[64-BIT]`、`label` 前向引用
- 跨进程：
  - `aobscan` 命中夹具的 `DE AD BE EF 90 90 ?? 7*` 并返回正确地址
  - `aobscanregion` / `aobscanmodule` / `aobscanunique`（含多处命中报错）
  - `alloc` + `label` + 汇编写入目标，读回逐字节校验，并解码校验寻址正确
  - `[ENABLE]`/`[DISABLE]` 成对往返 + 空 `[DISABLE]` 靠原字节还原 + `restoreMode:'script'` 对比
  - 多脚本各自独立启用/关闭，互不冲掉还原记录
  - `define` 常量替换（含立即数与寻址双重校验）
  - `readmem` / `db ??` / `assert` / `createthread` 参数校验 / `loadbinary`
  - `registersymbol` / `unregistersymbol` / `globalalloc` / `realloc` / `dealloc(*)`
  - 错误路径：语法错误、未定义符号、缺少地址定位、段重复、aobscan 找不到 —— 都断言**行号**
