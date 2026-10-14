# Lua 脚本桥 API 参考（node-cheat-engine）

> 目标：在 Node.js 里用 **Lua 脚本**驱动 Cheat Engine 的核心引擎，
> 等价于 CE 里「表 → 显示 Lua 脚本」能做的事：打开进程、读写内存、AOB 扫描、
> 数值扫描、地址表操作、符号注册、AOB 结果遍历。
>
> 本文档描述的是**本仓库实际实现**的 API（`src/lua/bridge.ts`、`api.ts`、`objects.ts`、
> `scan.ts`、`addressing.ts`、`marshal.ts`），
> 与 CE 官方 Lua API 的差异集中在 [第 6 节](#6-与-cheat-engine-官方-lua-api-的差异)。

---

## 目录

1. [选型与版本要求](#1-选型与版本要求)
2. [快速开始](#2-快速开始)
3. [类型映射约定](#3-类型映射约定)
4. [JS 侧 API：LuaEngine](#4-js-侧-apiluaengine)
5. [Lua 侧全局函数（共 61 个）](#5-lua-侧全局函数共-61-个)
6. [与 Cheat Engine 官方 Lua API 的差异](#6-与-cheat-engine-官方-lua-api-的差异)
7. [扫描配置表字段](#7-扫描配置表字段)
8. [已知限制](#8-已知限制)
9. [验证方式](#9-验证方式)

---

## 1. 选型与版本要求

| 项目 | 值 | 说明 |
| --- | --- | --- |
| Lua 实现 | **wasmoon 1.16.0**（Lua **5.4** 的 WASM 构建） | `package.json` 依赖：`"wasmoon": "^1.16.0"` |
| Node.js | **>= 18**（实测 Node **v24.19.0**）；`os: ["win32"]` | 依赖 `koffi` 调 Win32 API |
| 输出模块 | CommonJS（`dist/cjs/lua/bridge.js`） | `require('./dist/cjs/lua/bridge')` |

**为什么选 wasmoon 而不是 fengari**

- CE 内置的 Lua 是 5.3/5.4，**整数是 64 位 integer、浮点是 double**（`math.type` 有 `integer`/`float`）。
  wasmoon 就是 Lua 5.4，地址、`int64` 计数、`string.format("%d")` 语义与 CE 一致。
- fengari 是纯 JS 的 **Lua 5.1**：所有数字都是 double，`9007199254740993` 直接变成
  `9007199254740992`，64 位地址精度对不上；而且没有 `goto`、`//`、位运算符等 CE 脚本常见语法。
- 结论：wasmoon（Lua 5.4）是本任务的正确选择。

**为什么不用 wasmoon 的高层 JS↔Lua 函数桥（重要）**

wasmoon 的 `lua.global.set(name, fn)` 走它自己的类型扩展，实测（Node v24 + wasmoon 1.16.0）：

```js
lua.global.set('echo', (x) => x);
await lua.doString('return echo(9007199254740993)');   // → 9007199254740992  ❌ 丢精度
lua.global.set('mk', () => 9007199254740993n);
await lua.doString('return mk()');                      // → 抛错：The type 'bigint' is not supported by Lua
```

而地址是本项目的核心数据。因此本桥**绕过**该高层桥，直接用 Lua C API 注册 C 闭包：
入参 `lua_tointegerx`（返回 `BigInt`）、出参 `lua_pushinteger`（接收 `BigInt`），
实测 int64 可原样往返（见 [第 9 节](#9-验证方式)）。

---

## 2. 快速开始

```ts
// JS 侧
import { LuaEngine } from './dist/cjs/lua/bridge';
import { Process } from './dist/cjs/win/process';

const lua = new LuaEngine({
  onOutput: (text, kind) => console.log(`[${kind}] ${text}`),   // print / showMessage 的出口
  captureOutput: true,        // 同时保存到 lua.capturedOutput（默认 true）
  maxSleepMs: 60_000,         // sleep 上限，默认 60000
  moduleCacheMs: 2000,        // 模块列表缓存，默认 2000ms
});

await lua.createState();                 // 创建 Lua 5.4 状态并注册 API
lua.attachProcess(Process.open(pid));    // 也可以让脚本自己 openProcess(pid)

const count = await lua.doString(`
  local base = getAddress('0x140000000')
  local hp = readInteger(base + 0x40)
  print(string.format('hp = %d', hp))
  return hp
`);

await lua.dispose();                     // 关闭 Lua 状态 + 自己持有的进程句柄
```

等价的「纯 Lua」写法（脚本自己开进程）：

```lua
if not openProcess(1234) then error('打开失败: ' .. getLastError()) end
local base = getModuleBase('kernel32.dll')
print(string.format('kernel32 = 0x%X', base))
```

---

## 3. 类型映射约定

### 3.1 地址与整数

| 侧 | 表示 | 说明 |
| --- | --- | --- |
| JS 侧 | `bigint` | 所有地址、`int64`/`qword`、指针都是 `bigint` |
| Lua 侧 | `integer`（Lua 5.4，int64） | `math.type(x) == 'integer'` |
| 指针宽度 | **8 字节**（64 位目标）；WOW64 目标为 4 字节 | `readPointer`/`writePointer` 自动按 `Process.isWow64()` 选择 |

跨桥转换规则：

- **JS → Lua**：`bigint` → Lua integer；`number` 且为安全整数 → Lua integer；否则 → Lua float
  （`bigint` 超出 int64 范围时按位回绕，与 CE 的 `lua_pushinteger` 行为一致）。
- **Lua → JS**：Lua integer 在 `±(2^53-1)` 内 → JS `number`，超出 → JS `bigint`（**保证 int64 精度不丢**）；
  Lua float → JS `number`；`nil` → `null`；table → 数组（1..n 连续整数键）或对象；
  本引擎的对象（userdata）→ 对应的 JS 对象；其它 userdata → `null`。

因此 `readInteger(...)` 返回普通数字 `1000`，而 `readQword(...)` 读到
`9007199254740993` 时返回 `bigint`。

### 3.2 各读函数的宽度与符号

| 函数 | 宽度 | 默认符号 | 备注 |
| --- | --- | --- | --- |
| `readByte` / `readShortInteger` | 1 字节 | **无符号**（0..255） | 与 CE 默认一致；`signed=true` 得 −128..127 |
| `readSmallInteger` | 2 字节 | **无符号**（0..65535） | 与 CE 默认一致；`signed=true` 得 −32768..32767 |
| `readInteger` | 4 字节 | **有符号 int32**（−2^31..2^31−1） | ⚠️ **与 CE 默认相反**，见 6.1 |
| `readQword` | 8 字节 | 64 位（`asIntN(64)`） | 超过 2^63−1 按 int64 回绕（CE 同） |
| `readPointer` | 8 / 4 字节 | 无符号 | 64 位目标 8 字节，WOW64 目标 4 字节 |
| `readFloat` / `readDouble` | 4 / 8 字节 | — | IEEE-754 小端 |
| `readString` | 变长 | — | 默认最多 50 字节，读到 `\0` 截断 |

所有多字节数值都按 **小端（little-endian）** 解释。

### 3.3 字符串编码

- `readString(addr, n, false)`：按 **latin1（每字节一个字符）** 解码，遇到 `\0` 截断。
- `readString(addr, n, true)`：按 **UTF-16LE** 解码，遇到 `\0` 截断；`n` 按**字符**计
  （与 CE 一样内部会 `n+1`）。
- 字符串写回 Lua 时按 **UTF-8** 编码。CE 是把原始字节直接塞进 Lua 字符串，
  所以对 0x80 以上的非 ASCII 字节，两者字节序列可能不同（ASCII 完全一致）。
- `writeString` **不写结尾的 `\0`**（与 CE 一致）。这意味着写入更短的字符串后，
  再读回会看到尾部的旧字节 —— 需要覆盖时请写入等长或更长的内容。

---

## 4. JS 侧 API：`LuaEngine`

```ts
import { LuaEngine, LuaScriptError, LuaMarshal } from './dist/cjs/lua/bridge';
```

### 4.1 构造与选项

```ts
new LuaEngine(options?: LuaEngineOptions)
```

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `process` | `Process` | 无 | 初始目标进程（等价于构造后立刻 `attachProcess`） |
| `onOutput` | `(text, kind: 'print' \| 'message') => void` | 写 stdout | `print` / `showMessage` 的输出回调 |
| `captureOutput` | `boolean` | `true` | 是否把输出同时存进 `outputLines` |
| `maxSleepMs` | `number` | `60000` | Lua `sleep` 的上限（防脚本卡死） |
| `moduleCacheMs` | `number` | `2000` | 模块列表缓存时长；`0` 表示每次都重新枚举 |

### 4.2 生命周期与执行

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `createState()` | `Promise<this>` | 创建 Lua 5.4 状态、注册全部 API；可重复调用（幂等） |
| `registerApi()` | `void` | 手动注册 API；未 `createState` 时会被记为待注册，`createState` 时自动注册 |
| `isReady` | `boolean` | 状态是否可用（`dispose` 后为 `false`） |
| `luaState` | `number` | 主 Lua state 指针（调试用） |
| `maxSleepMs` | `number` | 当前 sleep 上限 |
| `dispose(options?: { closeProcess?: boolean })` | `Promise<void>` | 释放 Lua 状态 / C 函数指针 / 扫描会话；`closeProcess` 默认 `true`（关闭本引擎打开的进程句柄）。幂等 |
| `apiFunctionNames()` | `string[]` | 已注册的全部 API 函数名（字典序，共 61 个） |

### 4.3 执行 Lua

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `doString(code)` | `Promise<LuaValue \| undefined>` | 执行代码，返回**第一个**返回值；无返回值 `undefined` |
| `doStringAll(code)` | `Promise<LuaValue[]>` | 执行代码，返回**全部**返回值 |
| `loadString(code, chunkName?)` | `Promise<number>` | 预编译成函数句柄（注册表引用），可反复调用 |
| `loadFile(path)` | `Promise<number>` | 同上，从文件加载 |
| `doFile(path)` | `Promise<LuaValue \| undefined>` | 执行文件 |
| `callFunction(nameOrHandle, ...args)` | `Promise<LuaValue \| undefined>` | 调用全局函数或 `loadString` 的句柄，返回第一个返回值 |
| `callFunctionAll(nameOrHandle, ...args)` | `Promise<LuaValue[]>` | 同上，返回全部返回值 |
| `invoke(name, ...args)` | `LuaValue \| undefined` | **不写 Lua 代码**直接调 API（JS 参数 → API → JS 结果）；出错抛 JS `Error` |

`doString*` / `callFunction*` 失败时抛 `LuaScriptError`（`message` 为
`Lua 语法错误：...` 或 `Lua 运行时错误：...`，附 Lua 侧 `stack traceback`；
`luaMessage` 字段是原始 Lua 报文）。

```ts
const handle = await lua.loadString('local a, b = ...; return a * b');
await lua.callFunction(handle, 6, 7);          // → 42
await lua.callFunction('echo64', 9007199254740993n); // → 9007199254740994n
lua.invoke('readInteger', '0x7ff6a000');       // → 1000n
```

### 4.4 进程 / 输出 / 其它

| 成员 | 说明 |
| --- | --- |
| `attachProcess(proc \| null)` | 绑定目标进程；会关闭旧句柄、清空模块缓存与共享扫描会话 |
| `currentProcess()` / `requireProcess()` | 取当前进程；后者在未打开时抛中文错误 |
| `processId()` | 当前 pid，未打开为 `0` |
| `findModule(name)` / `listModules()` | 模块查找 / 列表（带缓存，大小写不敏感，可省略扩展名） |
| `outputLines` | 捕获到的输出（`readonly string[]`） |
| `capturedOutput` | 同上，只读 getter |
| `clearOutput()` | 清空输出历史 |
| `defaultScanSession()` / `dropDefaultScanSession()` | 隐式扫描会话（`firstScan`/`getScanResults` 等使用） |
| `symbols` | `SymbolTable` 实例（`register`/`unregister`/`entries`/`clear`） |
| `scanner` | 扫描能力外观（`compile`/`scanBlock`/`createSession`），转发给 `src/scanner` |

---

## 5. Lua 侧全局函数（共 76 个）

> 地址参数（下表记作 `addr`）可以是 **整数**，也可以是**字符串表达式**：
> `'0x7ff6a000'`、`'$7ff6a000'`、`'140000000'`（裸数字按**十六进制**）、
> `'kernel32.dll+1000'`、`'mySymbol+40'`、`'a+b-c'`。
> 不支持的写法：括号、乘除、`[[addr]+4]` 这类指针解引用。

### 5.1 进程（9）

| 函数 | 参数 | 返回值 | 示例 |
| --- | --- | --- | --- |
| `openProcess` | `pidOrName`（数字或进程名） | `true`/`false` | `openProcess(1234)` / `openProcess('notepad.exe')` |
| `closeProcess` | — | `true` | `closeProcess()` |
| `getOpenedProcessID` | — | 进程号，未打开为 `0` | `getOpenedProcessID()` |
| `getOpenedProcessHandle` | — | 后端句柄 id（`int64`） | `getOpenedProcessHandle()` |
| `getProcessName` | — | 进程名或 `nil` | `getProcessName()` |
| `getProcessIDFromProcessName` | `name` | pid 或 `nil`（找不到） | `getProcessIDFromProcessName('notepad.exe')` |
| `getProcessList` | — | 表：**整数 pid → 进程名** | `getProcessList()[1234]` |
| `targetIs64Bit` | — | `boolean`（`isWow64` 取反） | `targetIs64Bit()` |
| `cheatEngineIs64Bit` | — | `boolean`（Node 是否 64 位） | `cheatEngineIs64Bit()` |

补充说明：

- `openProcess` 按名字查找时**不区分大小写**，先精确匹配、再包含匹配，同名多进程取第一个；
  失败返回 `false`，原因可用 `getLastError()` 取。
- `attachProcess`/`openProcess` 会关闭**上一个**进程句柄。
- `getOpenedProcessHandle` 返回的是后端抽象层的句柄 id（自研后端即 Win32 `HANDLE` 的值，
  `native-ce` 后端下是 ceserver 侧的句柄），不是 CE 里那个裸 HANDLE 语义的完全等价物。

### 5.2 读写内存（20）

读取（10）：

| 函数 | 参数 | 返回值 | 示例 |
| --- | --- | --- | --- |
| `readBytes` | `addr [, count=1 [, asTable=true]]` | `asTable` 时返回 **1 基** 字节表；`asTable=false` 时返回多个返回值；读失败 `nil` | `local t = readBytes(a, 8)` / `local x, y = readBytes(a, 2, false)` |
| `readByte` | `addr [, signed=false]` | 1 字节整数 | `readByte(a)` |
| `readShortInteger` | `addr [, signed=false]` | 1 字节整数（等价 `readByte`） | `readShortInteger(a, true)` |
| `readSmallInteger` | `addr [, signed=false]` | 2 字节整数 | `readSmallInteger(a, true)` |
| `readInteger` | `addr [, signed=true]` | 4 字节整数 | `readInteger(a)` / `readInteger(a, false)` |
| `readQword` | `addr` | 8 字节整数 | `readQword(a)` |
| `readPointer` | `addr` | 8 字节（WOW64 目标 4 字节） | `readPointer(a)` |
| `readFloat` | `addr` | Lua float | `readFloat(a)` |
| `readDouble` | `addr` | Lua float | `readDouble(a)` |
| `readString` | `addr [, maxlength=50 [, widechar=false]]` | 字符串或 `nil` | `readString(a, 32, true)` |

写入（10）：

| 函数 | 参数 | 返回值 | 示例 |
| --- | --- | --- | --- |
| `writeBytes` | `addr, table` 或 `addr, b1, b2, ...` | 写入字节数（失败 `0`） | `writeBytes(a, {0x90, 0x90})` |
| `writeByte` | `addr, value` | `boolean` | `writeByte(a, 0xFF)` |
| `writeShortInteger` | `addr, value` | `boolean` | `writeShortInteger(a, -1)` |
| `writeSmallInteger` | `addr, value` | `boolean` | `writeSmallInteger(a, 1234)` |
| `writeInteger` | `addr, value` | `boolean` | `writeInteger(a, 9999)` |
| `writeQword` | `addr, value` | `boolean` | `writeQword(a, 9007199254740993)` |
| `writePointer` | `addr, value` | `boolean` | `writePointer(a, base + 0x40)` |
| `writeFloat` | `addr, value` | `boolean` | `writeFloat(a, 3.5)` |
| `writeDouble` | `addr, value` | `boolean` | `writeDouble(a, 1234.5678)` |
| `writeString` | `addr, text [, widechar=false]` | `boolean` | `writeString(a, 'HELLO')` |

补充说明：

- 读内存**长度不足即视为失败**（返回 `nil`），不会返回半截数据。
- 写整数按宽度回绕（`BigInt.asUintN`），与 CE 的隐式截断一致（`writeByte(a, 300)` 写入 `44`）。
- 写内存默认会先临时改页保护（与 CE 的 `writeprocessmemory` 一致）。
- `readBytes` 的表是 **1 基**（`t[1]` 是第一个字节）—— 与 CE 源码
  `LuaHandler.pas: readBytesEx`（`i+1` 作为键）一致；
  但**默认返回表**这一点与 CE 不同（CE 默认返回多返回值），见 6.1。

### 5.3 地址解析与模块（7）

| 函数 | 参数 | 返回值 | 示例 |
| --- | --- | --- | --- |
| `getAddress` | `expr`（整数或字符串） | `int64`；解析失败**抛 Lua 错误** | `getAddress('kernel32.dll+1000')` |
| `getAddressSafe` | `expr` | `int64` 或 `nil`（不抛错） | `getAddressSafe('未知符号')` → `nil` |
| `getModuleBase` | `name` | 模块基址或 `nil` | `getModuleBase('kernel32.dll')` |
| `getModuleSize` | `name` | 模块大小（字节）或 `nil` | `getModuleSize('kernel32')` |
| `enumModules` | — | 1 基数组，元素 `{ Name, Address, Size, Path }` | `enumModules()[1].Address` |
| `getNameFromAddress` | `addr` | `'模块名+偏移'` 或 `nil` | `getNameFromAddress(a)` → `'KERNEL32.DLL+1A2B'` |
| `inModule` | `addr` | `boolean` | `inModule(a)` |

补充说明：

- 模块名匹配**大小写不敏感**，支持全路径、带或不带扩展名（`'kernel32'` 等价 `'kernel32.dll'`）。
- 裸数字（纯 `[0-9a-f]`）按**十六进制**解释，这是 CE 地址表达式的习惯，
  也保证 `getAddress('0x' .. AOBScan 结果)` 之外的 `getAddress(list[0])` 也能工作。
  传 **Lua 数字**时不解析，原样返回（`getAddress(1234)` → `1234` 十进制）。
- 模块列表有 2 秒缓存（可配），`DLL` 中途加载/卸载时最多滞后 2 秒。

### 5.4 符号（5）

| 函数 | 参数 | 返回值 | 示例 |
| --- | --- | --- | --- |
| `registerSymbol` | `name, addr` | `true`；失败返回 `false, 错误信息`（两个返回值） | `registerSymbol('hp', base + 0x40)` |
| `unregisterSymbol` | `name` | 无 | `unregisterSymbol('hp')` |
| `getSymbols` | — | 1 基数组，元素 `{ Name, Address }` | `getSymbols()[1].Name` |
| `enumRegisteredSymbols` | — | 1 基数组，元素 `{ name, address }`（小写字段，CE 风格） | `enumRegisteredSymbols()[1].address` |
| `deleteAllRegisteredSymbols` | — | 无 | `deleteAllRegisteredSymbols()` |

- 符号只存在于内存里，**不会落盘**（本移植没有 CE 的符号文件概念）。
- 查找顺序：精确匹配 → 大小写不敏感匹配 → 模块名。
- CE 的 `registerSymbol(name, address, donotsave)` 第三个参数被忽略（接受但不生效）。

### 5.5 AOB 扫描（4）

| 函数 | 参数 | 返回值 | 示例 |
| --- | --- | --- | --- |
| `AOBScan` | `pattern [, protectionflags='' [, alignmenttype=0 [, alignmentparam='1']]]` | **StringList**（0 命中时仍返回空表对象） | `AOBScan('DE AD BE EF 90 90 ?? 7*')` |
| `AOBScanUnique` | 同上 | 第一个命中地址，未命中 `nil` | `AOBScanUnique('DE AD BE EF')` |
| `AOBScanModule` | `modulename, pattern [, protectionflags='*X*W*C' [, alignmenttype=0 [, alignmentparam='1']]]` | StringList（**本移植扩展**，CE 无此函数名） | `AOBScanModule('node.exe', '4D 5A')` |
| `AOBScanModuleUnique` | 同上 | 首个命中地址或 `nil` | `AOBScanModuleUnique('node.exe', '4D 5A')` |

- `pattern` 支持 `??`/`xx` 通配与**半字节通配**（`7*`、`*7`），分隔符为空格/逗号/连字符，
  也允许连写（`DEADBEEF`）。
- 命中结果的字符串格式与 CE 的 `inttohex(x, 8)` 一致：**大写十六进制、至少 8 位、无 `0x` 前缀**，
  例如 `'27C816F0080'`。转换回地址用 `getAddress('0x' .. s)` 或 `tonumber(s, 16)`。
- `protectionflags` 支持 CE 的语法：`-` 之后是排除、`+` 之后是包含、`*` 之后是无所谓，
  字母含义 `W`=可写、`X`=可执行、`C`=copy-on-write；空串表示都不关心。
  例：`'+W'` 只扫可写内存，`'-X'` 排除可执行内存。
- `alignmenttype`：`0` 不对齐（默认）、`1` 按类型/模式宽度对齐、`2` 末位对齐；
  `alignmentparam` 在类型 2 下解析为十进制或十六进制步长（`'4'`→4，`'A'`→10）。
- 实现路径：全地址空间且只做「包含」过滤时走 `ScanSession`（可 worker 并行，且不保留快照，
  省内存）；带排除标志或限定模块时走 4MB 分块的单线程扫描（跨块边界会带 `模式长度-1` 字节重叠）。

### 5.6 扫描会话（9）

显式会话：

```lua
local s = newScanSession({ parallel = true, maxSnapshotBytes = 0, blockSize = 4194304 })
local n = s:firstScan({ type = 'dword', option = 'exact', value = '1000' })
```

| 函数 / 成员 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `newScanSession` | `[options]` | ScanSession 对象 | `options`: `parallel`/`maxSnapshotBytes`/`blockSize`/`parallelMinBytes` |
| `s:firstScan` | `config` | 结果数（整数） | 对应 CE 的「首次扫描」 |
| `s:nextScan` | `config` | 结果数 | 需要上次扫描保留了旧值快照 |
| `s:getCount()` / `s.Count` | — | 结果数 | — |
| `s:getResult(i)` / `s[i]` | `i`（**0 基**） | 地址或 `nil` | 遍历：`for i = 0, s.Count - 1 do ... end` |
| `s:getResults()` | — | 1 基地址数组 | — |
| `s:getValues(type [, max=4096])` | 类型名/数值 | 值数组 | 读当前结果地址的值 |
| `s:getStats()` | — | `{ regionsScanned, bytesScanned, elapsedMs, resultCount, hasSnapshot, workersUsed }` | — |
| `s:reset()` / `s:destroy()` | — | — | 清空 / 释放（销毁后再用会抛错） |
| `s.ProcessID` / `s.HasSnapshot` | — | 整数 / 布尔 | 只读属性 |

隐式会话（等价 CE 的「当前扫描结果」）：

| 函数 | 参数 | 返回值 | 示例 |
| --- | --- | --- | --- |
| `firstScan` | `config` | 结果数 | `firstScan({ type='dword', value='1337' })` |
| `nextScan` | `config` | 结果数 | `nextScan({ option='increased' })` |
| `getScanSession` | — | 隐式 ScanSession 对象 | `getScanSession():getValues('dword', 5)` |
| `getScanResultCount` | — | 结果数 | `getScanResultCount()` |
| `getScanResult` | `i`（0 基） | 地址或 `nil` | `getScanResult(0)` |
| `getScanResults` | — | 1 基地址数组 | `#getScanResults()` |
| `resetScanResults` | — | — | 清空隐式会话 |
| `getScanSessionStats` | — | 统计表（同上） | `getScanSessionStats().resultCount` |

### 5.7 结果列表：StringList（`AOBScan*` 的返回值）

`AOBScan` 返回的是一张 CE 风格的 `TStrings` 对象（Lua 里是 userdata，
`getmetatable` 被保护，`__name` 为 `nceStringList`）。

| 成员 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `list.Count` | — | 条目数 | 活属性 |
| `list:getCount()` | — | 条目数 | 同上 |
| `list:getString(i)` / `list[i]` | `i`（**0 基**） | 字符串或 `nil` | CE 的默认数组属性语义 |
| `list:setString(i, s)` / `list[i] = s` | — | — | 越界写入被忽略 |
| `list:add(s [, data])` | — | 新条目下标 | `data` 是 CE 的关联整数（`getData`/`setData`） |
| `list:addText(text)` | 多行文本 | — | 按行追加 |
| `list:insert(i, s)` / `list:delete(i)` / `list:remove(s)` | — | — | 插入/按下标删/按值删 |
| `list:indexOf(s)` | — | 下标或 `-1` | — |
| `list:clear()` | — | — | — |
| `list:getText()` / `list:setText(text)` / `list.Text` | — | 以 `\n` 连接/分割 | — |
| `list:getData(i)` / `list:setData(i, v)` | — | 整数 | — |
| `list:destroy()` / `list.Destroyed` | — | — / 布尔 | 清空并标记销毁 |

```lua
local list = AOBScan('DE AD BE EF 90 90 ?? 7*')
for i = 0, list.Count - 1 do
  print(string.format('%d: %s', i, list:getString(i)))
end
list:destroy()
```

### 5.8 地址表与 MemoryRecord

| 函数 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `getAddressList` | — | AddressList 对象 | 每次返回**同一个**对象（与 CE 一致） |

AddressList（`__name` = `nceAddressList`）：

| 成员 | 参数 | 返回值 |
| --- | --- | --- |
| `al.Count` / `al:getCount()` | — | 记录数 |
| `al:getMemoryRecord(i)` / `al[i]` | `i`（**0 基**） | MemoryRecord 或 `nil` |
| `al:getMemoryRecordByDescription(s)` | — | MemoryRecord 或 `nil` |
| `al:getMemoryRecordByID(id)` | — | MemoryRecord 或 `nil` |
| `al:createMemoryRecord([address [, description [, type]]])` | — | 新 MemoryRecord |
| `al:getSelectedRecord()` / `al.SelectedRecord` | — | 当前选中记录（可读写） |
| `al:setSelectedRecord(rec)` | — | — |
| `al:delete(rec)` | — | 从表中移除 |

MemoryRecord（`__name` = `nceMemoryRecord`）。属性与 getter/setter 等价：

| 属性 / 方法 | 类型 | 说明 |
| --- | --- | --- |
| `Address` / `getAddress()` / `setAddress(v)` | **字符串** | 可解释地址表达式（传数字会被转成 `0x...` 串） |
| `CurrentAddress` / `getCurrentAddress()` | `int64` 或 `nil` | 解析 `Address` 得到的真实地址 |
| `Description` / `getDescription()` / `setDescription(s)` | 字符串 | — |
| `Type` / `getType()` / `setType(t)` | 整数（`VariableType`） | `setType` 也接受类型名（`'dword'`/`'float'`…） |
| `Value` / `getValue()` / `setValue(v)` | **字符串** | 读/写目标内存并格式化（与 CE 的 `MemoryRecord.Value` 一致） |
| `NumericalValue` / `getNumericalValue()` / `setNumericalValue(v)` | 数字 | 数值形式 |
| `Active` / `getActive()` / `setActive(b)` | 布尔 | `false` 时不读内存，返回缓存值（`setValue` 也只更新缓存） |
| `ID` / `getID()` | 整数 | 创建时自增 |
| `Selected` / `isSelected()` | 布尔 | — |
| `delete()` | — | 标记删除（表内移除请用 `al:delete(rec)`） |

```lua
local al = getAddressList()
local rec = al:createMemoryRecord('0x140000040', 'health', 'dword')
print(rec.Value, rec.NumericalValue, rec.CurrentAddress)
rec.Value = 9999
rec.Active = false
```

字符串类型的读写长度是固定的：`String` 默认 64 字节、`UnicodeString` 默认 32 字符
（CE 的 MemoryRecord 有可配置长度，本移植未暴露该字段）。

### 5.9 内存属性与分配（9）

| 函数 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `allocateMemory` | `size [, protection='RWX']` | 地址（`int64`） | 在目标进程里分配内存；**不会自动释放** |
| `deAlloc` | `addr` | `true`/`false` | 释放 `allocateMemory` 分配的内存 |
| `getMemoryProtection` | `addr` | 保护属性名（`'RW'`/`'RWX'`/`'R'`/`'n'`…）或 `nil` | 查该地址所在页的保护 |
| `getMemoryProtectionInfo` | `addr` | `{ name, value, readable, writable, executable, guard }` 或 `nil` | **本移植扩展**：带数值与布尔位，便于精确比较 |
| `setMemoryProtection` | `addr, protection` | 旧保护属性名 | 名字（`'R'`/`'RWX'`）或数值（`0x40`）都接受 |
| `fullAccess` | `addr` | 旧保护属性名 | 把该页改成 `RWX` |
| `getRegionSize` | `addr` | 区域字节数或 `nil` | 该地址所在区域的大小 |
| `enumRegions` | `[filterTable]` | 1 基数组 | **本移植扩展**；`filterTable = { protection=..., type='MEM_IMAGE'/'MEM_MAPPED'/'MEM_PRIVATE' }` |

`enumRegions` 的元素：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `StartAddress` | `int64` | 起始地址 |
| `EndAddress` | `int64` | 结束地址（**含**） |
| `Size` | `int64` | 字节数 |
| `Protect` | 字符串 | 保护属性名 |
| `ProtectValue` | 整数 | 原始 Win32 值 |
| `Type` | 字符串 | `'MEM_IMAGE'` / `'MEM_MAPPED'` / `'MEM_PRIVATE'` |
| `State` | 字符串 | `'MEM_COMMIT'` / `'MEM_RESERVE'` |

> ⚠️ **页粒度**：`setMemoryProtection` / `fullAccess` 改的是**整页**（Windows 4KB 页），
> 不是从 `addr` 起的 `size` 字节 —— 这与 CE 和 Win32 的语义一致。
> 地址落在未提交区域时，`getMemoryProtection` / `getRegionSize` 返回 `nil`（不抛错）。

### 5.10 汇编 / 反汇编（4）

| 函数 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `assemble` | `instruction [, targetAddress [, arch]]` | 写入字节数 | 汇编**并写入**目标进程 |
| `assembleBytes` | `instruction [, targetAddress [, arch]]` | 1 基字节表 | 只编码，**不碰内存** |
| `disassemble` | `addr [, count=1]` | 字符串数组 | 读目标内存并反汇编 |
| `disassembleBytes` | `bytes [, address [, count]]` | 字符串数组 | 反汇编给定字节（字节表或十六进制串） |

- `arch` 可选 `'x86'`/`'x64'`/`'arm'`/`'thumb'`/`'arm64'`；省略时按目标进程位数自动选。
- 反汇编输出是 CE 风格：`'0000000000001000 - B8 01 00 00 00  - mov eax, 1'`。
- **与 CE 的差异（有意为之）**：CE 的 `assemble(instruction)` 直接写目标进程；
  这里把「只编码」和「写内存」拆成 `assembleBytes` / `assemble` 两个函数，
  避免手滑就改坏代码段。`assemble` 省略 `targetAddress` 时会自动分配一块内存并写入。
- 汇编失败**抛 Lua 错误**（CE 是弹窗），用 `pcall` 捕获。
- 汇编能引用 `registerSymbol` 注册的符号：`assembleBytes('mov eax, [base+4]')`。

### 5.11 工具（6）

| 函数 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `sleep` | `ms` | 无 | **阻塞式**；上限 `maxSleepMs`（默认 60000），超出部分被截断 |
| `getTickCount` | — | 系统运行时间（毫秒） | 与 Win32 `GetTickCount64` 语义一致（`os.uptime()*1000`） |
| `showMessage` | `text` | `true` | 输出到 `onOutput(text, 'message')`，默认 stdout（**不弹窗**） |
| `print` | `...` | 无 | 覆盖 Lua 原生 `print`，用 `\t` 连接后走同一个输出通道 |
| `getLastError` | — | 字符串 | 最近一次 API 失败原因（`openProcess`/`registerSymbol` 等会写） |
| `clearLastError` | — | 无 | 清空 |

---

## 6. 与 Cheat Engine 官方 Lua API 的差异

### 6.1 已实现但语义/默认值不同

| API | CE 官方 | 本移植 | 影响 |
| --- | --- | --- | --- |
| `readInteger(addr, signed)` | `signed` 默认 **false**（返回 dword 0..4294967295） | `signed` 默认 **true**（返回 int32 −2^31..2^31−1） | ⚠️ 需要无符号时显式写 `readInteger(a, false)`；`readByte`/`readSmallInteger` 保持 CE 的无符号默认 |
| `readBytes(addr, n, asTable)` | 默认**不传** `asTable` → 返回**多个返回值** | 默认 `asTable = true` → 返回 **1 基表** | 想拿多返回值请显式传 `false`：`local a, b = readBytes(a, 2, false)` |
| `readString` 编码 | 按系统 ANSI 代码页（原始字节直塞 Lua 字符串） | ANSI 按 **latin1** 解码，回传 Lua 时按 **UTF-8** 编码 | 非 ASCII 字节序列可能不同；纯 ASCII 完全一致 |
| `writeString` | 不写结尾 `\0` | 同（**已对齐**） | 写短串后尾部残留旧字节，需自行覆盖 |
| `sleep(ms)` | 阻塞 CE 的 Lua 线程（CE 的 UI 仍可响应） | 用 `Atomics.wait` **阻塞 Node 事件循环**，上限 `maxSleepMs` | 长 `sleep` 会冻结整个 Node 进程；不可 yield |
| `showMessage` | 弹模态对话框 | 写输出回调/stdout，返回 `true` | 无 UI 环境可用，但脚本无法再「等用户点确定」 |
| `print` | 输出到 CE 的 Lua 引擎窗口 | 写输出回调/stdout | 同上 |
| `getOpenedProcessHandle` | 返回 Win32 `HANDLE` | 返回后端抽象层句柄 id | 自研后端下数值即句柄；`native-ce` 后端语义不同 |
| `enumModules([pid])` | 可传 pid | **忽略参数**，始终枚举当前进程 | 需要别的进程请先 `openProcess` |
| `getNameFromAddress` | `'kernel32.dll+1A2B'` | 同格式，但模块名用系统上报的大写名（`'KERNEL32.DLL+1A2B'`） | 仅大小写差异 |
| `getAddress` 表达式 | 支持括号、乘除、`[[addr]+4]` 指针解引用、符号文件 | 仅支持 `+`/`-` 链、十六进制裸数字、模块名、注册符号 | 复杂表达式会抛错（可用 `readPointer` 手动解引用） |
| `AOBScan` 结果 | `TStringList`（大写十六进制、≥8 位） | 同格式，但「0 命中」时返回**空表对象**而不是 `nil` | `if list.Count == 0` 判断是否命中 |
| `AOBScan` 的 `alignmenttype` | `TFastScanMethod` 全量 | 支持 `0/1/2`；`1` 在 `vtByteArray` 下对齐步长 = 模式长度（沿用引擎 `compileConfig` 语义） | 特殊对齐需求请显式用类型 2 + 步长 |
| `registerSymbol(name, addr, donotsave)` | 第三个参数控制是否落盘 | 接受但**忽略**（符号只驻留内存） | — |
| `firstScan` 的地址范围 | `firstscan` 支持 startaddress/stopaddress | 扫描配置表**不支持**地址范围限制，总是扫描全部可扫描区域 | 大进程扫描较慢；可用 `newScanSession({ blockSize, maxSnapshotBytes })` 调优 |
| 顶层 `coroutine.yield` | CE 的 Lua 引擎支持在脚本里 yield（管道/调试用） | 脚本在**主 state** 上执行，顶层 yield 会报 `attempt to yield from outside a coroutine` | 脚本内部自建协程完全可用（已测试） |

### 6.2 未实现（常见但本移植没有）

> **注（集成状态）**：下表的"汇编 / AA"一行已部分具备能力 ——
> 引擎层的 Auto Assembler 已实现并通过 44 个跨进程测试
> （见 [autoassembler.md](autoassembler.md)），可直接用
> `require('@bingine/cemem').autoAssemble(...)` 调用。
> 但**尚未把它包成 Lua 全局函数** `autoAssemble` / `autoAssembleCheck`，
> 因此从 Lua 脚本里还调不到。这是已知的集成缺口，不是能力缺失。

| 类别 | 未实现的 API（举例） |
| --- | --- |
| 汇编 / AA | ✅ 已实现：`autoAssemble` / `autoAssembleCheck` / `autoAssembleError` / `assemble` / `assembleBytes` / `disassemble` / `disassembleBytes` / `allocateMemory` / `deAlloc`。仅 `deAllocLocal`（本进程释放）未实现 |
| 调试器 | `debugProcess`、`debug_*` 全系列（断点、寄存器上下文、`debug_getContext`…）、`pause`/`unpause` |
| 进程注入 | `createProcess`、`injectDLL`、`injectLibrary`、`loadPlugin`、`getCEVersion` |
| 加速 | `speedhack_setSpeed`、`speedhack_getSpeed` |
| UI 组件 | `createLabel`/`createButton`/`createForm`… 全部 LCL 组件、`messageDialog`、`inputQuery`、`openDialog`/`saveDialog` |
| 输入 / 截屏 | `getPixel`、`getMousePos`、`setMousePos`、`keyDown`、`isKeyPressed`、`mouse_event` |
| 本进程读写 | `readIntegerLocal`、`writeIntegerLocal`、`readBytesLocal`、`writeBytesLocal` 等 `*Local` 系列 |
| 共享内存 / 映射 | `createSection`、`mapViewOfSection`、`allocateSharedMemory*` |
| 内核 | `dbk_*`、`dbvm_*` 全系列（ring-0，Node 无实现路径） |
| 符号高级功能 | `getSymbolInfo`、`getCommonModuleList`、`reinitializeSymbolhandler`、`waitForExports`/`waitForDotNet`/`waitForPDB`、`enumModules` 的 pid 参数 |
| 地址表高级 | `createTableEntry`、`getTableEntry`、热键（`createHotkey`）、`appendToEntry`、`.CT` 读写 |
| 扫描高级 | `AOBScanModuleUnique` 之外的 `firstscan` 参数（地址范围、`binary` 位串扫描的 Lua 入口）、指针扫描的 Lua 绑定 |
| 其它 | `getGlobalVariable`/`setGlobalVariable`、`inMainThread`/`synchronize`/`queue`（`fullAccess` / `setMemoryProtection` 已实现，见 5.9） |

> 说明：这些能力里有一部分在**引擎层已经存在**，只是没暴露到 Lua：
> 指针扫描（`src/scanner/pointer-scan.ts`）、地址表与 `.CT` 读写
> （`src/addresslist/memory-record.ts`、`src/cheattable/ct-format.ts`）、
> 地址表达式的高级语法（`src/addr/expression.ts`）。
> 需要时可以从 JS 侧调用这些模块，或后续把它们接到 Lua 全局函数上。

### 6.3 可直接搬运的脚本片段

下面这些 CE 常见写法在本桥里**可以原样运行**：

```lua
-- 打开进程并读值
if openProcess('notepad.exe') then
  local addr = getAddress('notepad.exe+1000')
  print(readInteger(addr))
end

-- 符号 + 相对偏移
registerSymbol('base', getAddress('notepad.exe'))
print(readQword('base+0x10'))
unregisterSymbol('base')

-- AOB 扫描 + 遍历
local list = AOBScan('48 8B 05 ?? ?? ?? ??')
for i = 0, list.Count - 1 do
  print(string.format('%s -> %d', list[i], readInteger(getAddress('0x' .. list[i]))))
end

-- 数值扫描（首次 + 再次）
firstScan({ type = 'dword', option = 'exact', value = '1000' })
nextScan({ type = 'dword', option = 'increased' })
for i = 0, getScanResultCount() - 1 do
  print(string.format('%X', getScanResult(i)))
end

-- 错误处理
local ok, err = pcall(function() return getAddress('不存在的符号') end)
if not ok then print('解析失败: ' .. tostring(err)) end

-- 分配内存 → 写 → 回读 → 释放
local p = allocateMemory(64)                 -- 默认 RWX
writeInteger(p, 0x1234ABCD)
print(string.format('%X', readInteger(p, false)))
deAlloc(p)                                  -- 必须手动释放，否则目标进程一直泄漏

-- 打补丁：改页保护 → 写入机器码 → 回读校验
local target = getAddress('kernel32.dll+1000')
fullAccess(target)                          -- 整页改成 RWX
local n = assemble('mov eax, 1', target)    -- 写入并返回写入字节数
print(string.format('patched %d bytes -> %s', n, disassemble(target, 1)[1]))

-- 只编码不写内存（安全预检）
local bytes = assembleBytes('mov eax, [base+4]', 0x1000)
print(#bytes, disassembleBytes(bytes, 0x1000, 1)[1])

-- 按属性过滤内存区域
for _, r in ipairs(enumRegions({ type = 'MEM_PRIVATE' })) do
  if r.Protect == 'RWX' then
    print(string.format('%X - %X  %s', r.StartAddress, r.EndAddress, r.Type))
  end
end
```

---

## 7. 扫描配置表字段

`firstScan` / `nextScan` / `s:firstScan` / `s:nextScan` 都接收一张配置表
（`src/lua/scan.ts: parseScanConfig`）。未知字段被忽略，取值非法会抛 Lua 错误。

| 字段（别名用 `/` 分隔） | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `type` / `variableType` | 字符串或数值 | `'dword'` | `byte, word, dword, qword, single/float, double, string, unicodeString, aob/byteArray, binary, all, pointer, grouped`；也接受 `VariableType` 数值 |
| `option` / `scanOption` | 字符串或数值 | `'exact'` | `unknown, exact, between, bigger, smaller, increased, increasedBy, decreased, decreasedBy, changed, unchanged, increasedByPercentage, decreasedByPercentage, valueBetweenPercentage` |
| `value` / `value1` | 字符串/数字 | — | 扫描值 |
| `value2` | 字符串/数字 | — | 区间上界 / 百分比上界 |
| `hex` / `hexadecimal` | 布尔 | `false` | 按十六进制解析 `value` |
| `signed` | 布尔 | `false` | 有符号解释 |
| `rounding` | 字符串或数值 | `'rounded'` | `rounded, extreme/extremeRounded, truncated` |
| `accuracy` / `floatAccuracy` | 整数 | `-1` | 浮点小数位数（`-1` 表示由字符串推导） |
| `caseSensitive` | 布尔 | `false` | 字符串扫描是否区分大小写 |
| `length` / `stringLength` | 整数 | — | 字符串扫描长度（字符数） |
| `codePage` | 整数 | — | `vtCodePageString` 用 |
| `writableOnly` / `executableOnly` / `includeImage` / `includeMapped` / `includePrivate` / `includeGuard` | 布尔 | 引擎默认 | 扫描区域过滤（注意：引擎目前只提供「只扫可写/可执行」的**包含**式过滤） |
| `is32Bit` | 布尔 | `false` | 只扫 4GB 以下 |
| `alignment` | 字符串或数值 | `'unaligned'` | `'unaligned'`/`'aligned'`/`'lastDigits'`，或直接给步长（十进制/十六进制串） |
| `alignmentParam` | 字符串 | — | `lastDigits` 的步长 |
| `group` / `groupElements` | 数组 | — | 分组长扫描：元素 `{ type, value, value2, wildcard, hex, signed, accuracy, rounding, aob, length }` |
| `groupOutOfOrder` / `groupAligned` | 布尔 | `false` | 分组长扫描的乱序/对齐 |
| `floatScanWithoutExponents` | 布尔 | `false` | 浮点扫描排除带指数的数 |
| `blockSize` | 整数 | 引擎默认 4MB | 扫描块大小（实际生效取决于 ScanSession 选项） |

> ⚠️ **不支持地址范围**（CE 的 `startaddress`/`stopaddress`）：配置表里没有对应字段，
> 扫描固定覆盖全部「可扫描区域」（`Process.scannableRegions()`）。

---

## 8. 已知限制

1. **`sleep` 是阻塞式的**，会冻结 Node 事件循环（包括同进程里其它定时器/HTTP 服务）。
   这是同步桥的固有代价；CE 里 `sleep` 只阻塞 Lua 线程。上限由 `maxSleepMs`（默认 60000）控制，
   超过上限的部分被静默截断。异步场景请用 JS 侧的 `setTimeout` 分段执行。
2. **没有异步/流水线**：`readBytes`、`AOBScan`、`firstScan` 都是同步调用，
   只在 JS 边界上返回 Promise。扫描本身是 CPU/IO 密集的，长扫描期间事件循环同样被占用
   （除非走 `ScanSession` 的 worker 并行路径，但 worker 的等待仍是同步 `Atomics.wait`）。
3. **协程**：脚本内部 `coroutine.create/wrap` 完全可用（已测试：`coroutine.wrap` 三次 `yield` 正常返回）；
   但顶层（`doString` 的 chunk 体里）`coroutine.yield` 会报
   `attempt to yield from outside a coroutine`
   —— 本桥在**主 state** 上执行脚本，没有像 CE 那样把脚本放进自己的协程调度器。
   另外本桥的 API 函数是通过 `lua_pushcclosure` 直接注册的 C 函数（无 continuation），
   因此也不存在「API 内部挂起、稍后恢复」这种异步语义。
4. **`AOBScan` 的性能**：默认路径会扫描全部可扫描内存（例如一个 Node 进程约 160MB，
   实测 ~0.5s，其中包含 worker 并行的启动开销）；需要频繁 AOB 时建议
   `AOBScanModule*`（限定模块内）或自行缓存结果。
5. **`firstScan`/`nextScan` 无地址范围限制**，大进程的首扫会保存全部内存快照
   （用于 `nextScan` 的旧值比较）。内存紧张时可用
   `newScanSession({ maxSnapshotBytes: 0 })` 关掉快照（此时只能做精确值/区间类 `nextScan`）。
6. **模块列表有 2 秒缓存**（`moduleCacheMs`），模块热加载/卸载后可能短暂不一致。
7. **符号不落盘**：`registerSymbol` 只影响当前 `LuaEngine` 实例，
   `dispose()` 后（或换一个 `LuaEngine`）就没了。
8. **字符串编码**：非 ASCII 字节在「内存 → JS → Lua」链路上可能被重新编码（见 3.3）。
9. **仅支持 Windows**（`koffi` + Win32 API；`package.json` 的 `os: ["win32"]`）。
10. **`lua_error` 的实现细节**：本桥在 C 闭包里通过 `lua_error` 抛 Lua 错误
    （emscripten 的 JS 版 longjmp 会 `throw Infinity`）。因此所有跨桥的
    `try/catch` 都必须把这个哨兵原样抛出 —— 这是 `src/lua/marshal.ts: isLuaLongjmp` 存在的原因，
    修改桥接代码时请保留该判断。

---

## 9. 验证方式

```bash
npx tsc -p tsconfig.json              # 零错误
node --test test/lua-bridge.test.js   # 13/13 通过
```

`test/lua-bridge.test.js` 用 `node:test` + `node:assert`，**真实跨进程**启动
`test/fixture-target.js`，覆盖：

- Lua 5.4 状态可用性与 int64（`9007199254740993`、`9223372036854775807`）精度往返；
- `openProcess(pid)` 后 `readInteger`=1000、`readFloat`=3.5、`readDouble`=1234.5678、
  `readQword`=9007199254740993（断言 `typeof === 'bigint'`）、有符号/无符号读法；
- `writeInteger`/`writeBytes`/`writeFloat`/`writeString` + 回读；
- `readString` 读到 `HELLO CHEAT ENGINE` 与宽字符 `WideString测试`；
- `AOBScan` 命中夹具的 `DE AD BE EF 90 90 ?? 7*` 特征（用 `offsets.aobSignature` 校验），
  `AOBScanUnique`/`AOBScanModule`/`AOBScanModuleUnique` 与 StringList 的 0 基遍历；
- `getModuleBase('kernel32.dll')`、`getModuleSize`、表达式解析、`getNameFromAddress`；
- `registerSymbol`/`unregisterSymbol`/`getAddressSafe`；
- 多行 Lua 脚本串起 openProcess + 读值 + 循环 + 写回 + `print`（校验输出内容）；
- `getAddressList` + `MemoryRecord`（Address/Description/Type/Value/NumericalValue/Active/只读属性报错）；
- `newScanSession`/`firstScan`/`nextScan` + 夹具 `mutate` 后再次筛选；
- 语法错误 / 运行时错误 / `pcall` 捕获 API 参数错误 / 未打开进程返回 `nil`；
- `sleep`/`getTickCount`/`showMessage`/`print`/`getProcessList`；
- `loadString` + `callFunction`（含 bigint 参数）、`invoke`、`dispose` 幂等。

调试入口：

```ts
lua.apiFunctionNames();     // 61 个已注册函数
lua.capturedOutput;         // print/showMessage 的历史
lua.invoke('readInteger', '0x7ff6a000');
```
