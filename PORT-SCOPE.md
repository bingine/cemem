# Cheat Engine → Node.js 移植范围说明（PORT-SCOPE）

本文件说明：**哪些部分真正移植到了 Node.js、哪些在 Node 中不存在实现路径、以及为什么**。

原始代码规模（`cheat-engine-master.zip` 实测统计）：

| 部分 | 行数 | 说明 |
| --- | --- | --- |
| `Cheat Engine/`（Object Pascal / Lazarus） | 462,717 | 含 529 个 `.pas`、164 个 `.lfm` 窗体、C/C++ 内核驱动 |
| `dbvm/` | 65,545 | DBVM hypervisor（VT-x / AMD-V） |
| `lua/` | 17,039 | 随包 Lua 运行时（C） |
| `DBKKernel/` | 14,307 | Windows 内核驱动 |
| `DBVM UEFI/` | 2,337 | UEFI 引导层 |
| **合计** | **≈562,000** | |

**逐行等价重写整个 Cheat Engine 到 Node.js 是不可行的**，原因不是工作量，而是下列部分
在 Node/JS 的用户态运行时里**不存在实现路径**。因此本移植的策略是：
**把可移植的算法与协议层做到真实可用、语义逐行对齐；对不可移植部分给出明确边界与替代方案。**

---

## 一、已移植并验证可用

全部经**真实跨进程**测试验证（目标进程为 `test/fixture-target.js`，用 VirtualAlloc 分配可预测内存）。
`npm test` → **61 个测试全部通过**。

| 模块 | 对应 CE 源文件 | 状态 |
| --- | --- | --- |
| 变量类型与枚举 | `memscan.pas` 的 `TVariableType`（17 种） | ✅ 逐一对应 |
| 值编解码、浮点舍入策略 | `memscan.pas` 比较函数族、`parsers.pas` | ✅ 含 FPC 的偶舍入、AOB 半字节通配 |
| 内存扫描引擎 | `memscan.pas`（TMemScan / TScanner / TScanController） | ✅ 14 种扫描选项 × 6 种数值类型 + 字符串/Unicode/AOB/二进制/全部类型/分组长 |
| 指针扫描 | `pointerscancontroller.pas`、`pointerscanstructures.pas` | ✅ 指针映射 + 逐级回溯 + 结果可解析回目标 |
| 地址表达式解析 | `addressparser.pas` | ✅ 模块相对、解引用、算术、GetModuleBase 等 |
| 地址表与内存记录 | `MemoryRecordUnit.pas`、`addresslist.pas` | ✅ 记录/偏移链/锁定/快照 |
| Cheat Table (.CT) 读写 | `MemoryRecordUnit.pas` 的 XML 写出 | ✅ 元素名/属性/引号形式对齐，往返不丢信息 |
| 多线程并行扫描 | CE 的 TScanner 多线程 | ✅ worker + SharedArrayBuffer，已校验与单线程结果**完全一致** |
| 反汇编器 | `disassembler.pas`（经 binutils 路径） | ✅ 后端 Capstone，字段对齐 `TLastDisassembleData` |
| ARM/Thumb/ARM64 反汇编 | `disassemblerarm64.pas`、`disassemblerthumb.pas`、`disassemblerarm32*.pas` | ✅ 后端 Capstone，含条件码/PC 相对/数据宽度 |
| 汇编器 | `Assemblerunit.pas`（经 binutils 路径） | ✅ 后端 Keystone，含符号解析与逐行地址映射 |
| ARM 汇编 | `assemblerarm.pas`（1,074 行） | ✅ 后端 Keystone，A32/Thumb/AArch64 |
| Auto Assembler | `autoassembler.pas` | ✅ 见 [docs/autoassembler.md](docs/autoassembler.md) |
| Lua 脚本桥 | `LuaHandler.pas` / `LuaCaller.pas` | ✅ 61 个 CE Lua API 函数，Lua 5.4（wasmoon），int64 不丢精度 |
| 用户态内存后端 | `NewKernelHandler.pas` / `ProcessHandlerUnit.pas` | ✅ 自研后端（默认） |
| `ceserver` 协议客户端 | `ceserver/ceserver.h`+`ceserver.c` | ✅ 原生 CE 兼容层（异步） |

**反汇编/汇编的实现策略**：CE 在 Windows 上**优先调用 binutils 的 objdump/as**
（`disassembler.pas` 里的 `if defaultBinutils<>nil` 分支 + `binutils.pas` 的
`CreateProcess objdump`），自带的 Pascal 实现只是无 binutils 时的回退路径。
本移植沿用同一架构，用 Capstone（反汇编）+ Keystone（汇编）做后端，
因此覆盖面（SSE/AVX 等）与正确性都优于手抄指令表；详见
[docs/assembler.md](docs/assembler.md)。**未覆盖 ARM/ARM64**
（CE 另有 `disassemblerarm64.pas` 4,608 行等）。

**实测性能**（本机）：读内存 2.4～3.3 GB/s；`VirtualQueryEx` 枚举 553 个区域 2ms；
DWord 精确扫描 64MB 约 310ms；并行扫描与单线程结果集逐地址一致。

---

## 二、无法移植（Node 中不存在实现路径）

这些不是"还没做"，而是**物理上做不到**——它们要求 ring-0 特权或硬件虚拟化。

### 1. 内核驱动（`DBKKernel/`、`Cheat Engine/dbk32/`，约 14,000 行）

CE 通过自签名的 `dbk64.sys` 内核驱动实现：读写任意进程物理内存、绕过
`ObRegisterCallbacks` 与 PPL 保护、句柄提权、内核态断点、内核符号枚举。

- **为什么不行**：内核驱动必须运行在 ring-0，由 Windows 内核加载并校验签名。
  Node.js 代码运行在用户态，无法安装内核回调、无法访问内核地址空间。
  这不是 API 缺失问题，而是特权级隔离。
- **替代方案**：本移植的 `SelfBackend` 覆盖了 CE 的"无驱动回退路径"能做的全部事情
  （`OpenProcess` + `ReadProcessMemory` + `VirtualQueryEx`）。
  受保护进程（反作弊、PPL 进程）读不到——这与 CE 在**未加载驱动**时的行为一致。
  真需要内核能力时，可选用 CE 官方的 `ceserver`（见 `NativeCeBackend`）。

### 2. DBVM hypervisor（`dbvm/`、`DBVM UEFI/`，约 68,000 行）

CE 自研的虚拟机监控器，实现硬件断点、隐身、指令级追踪、CR3 切换、
物理内存访问而无需驱动签名。

- **为什么不行**：需要 VT-x / AMD-V 虚拟化扩展与 UEFI 启动层，
  直接把 CPU 置于 VMX root 模式。JS 运行时无法执行 `VMXON`/`VMLAUNCH`，
  也无法在 UEFI 阶段加载代码。
- **替代方案**：无。需要这类能力请使用原生 CE。

### 3. LCL/VCL 图形界面（164 个 `.lfm` 窗体）

CE 的主界面、内存查看器、反汇编器窗口、结构体编辑器等都是 Lazarus 窗体。

- **为什么不行**：Node 没有 VCL/LCL 对应物。
- **替代方案**：本移植只提供**类库 + TypeScript 类型**（按你的选择，不做窗口化）。
  需要 GUI 时可由调用方自行套 Web UI 或 Electron —— 引擎层不依赖任何 UI。

### 4. 调试器相关（`WindowsDebugger.pas`、`KernelDebugger.pas`、VEH、注入）

CE 的断点、单步、调用栈、代码注入、`CreateRemoteThread` 注入。

- **为什么不行**：其中**用户态调试 API 部分是可移植的**
  （`DebugActiveProcess`/`WaitForDebugEvent`），但需要重写整个调试事件循环与线程上下文管理；
  **内核态部分**（`KernelDebugger.pas`）不可移植。
- **替代方案**：本轮未实现。注意 `Win32` 的 `DebugActiveProcess` 无法附加到
  自身进程，且受保护进程不可附加。

### 5. .NET / Mono / Java 数据收集器（`DotNetDataCollector/`、`MonoDataCollector/`、`Java/`）

- **为什么不行**：这些注入 .NET/Mono/JVM 进程并读取其对象图，
  依赖运行时特定的内部结构。
- **替代方案**：与本移植的纯内存扫描正交，可单独实现（例如走 ClrMD 的 .NET 绑定）。

### 6. Speedhack / D3D hook / 输入法 / 音频（`speedhack/`、`Direct x mess/`、`xmplayer/`）

- **为什么不行**：需要 API hooking（`SetWindowsHookEx`、IAT/inline hook）与
  DirectX COM 接口调用，Node 无对应能力。
- **替代方案**：无。

---

## 三、两种调用方式

按你的要求，本移植提供**统一接口 + 两个可切换后端**：

| | `SelfBackend`（默认） | `NativeCeBackend` |
| --- | --- | --- |
| 原理 | 本进程内直接调 Win32 API | 连接 CE 官方 `ceserver` 的 TCP 协议 |
| 依赖 | 无（koffi 绑定） | 需要运行中的 `ceserver` |
| 同步性 | **同步**（直接返回值） | **异步**（返回 Promise） |
| 受保护进程 | 读不到（无驱动） | 取决于 ceserver 权限与扩展 |
| 适用 | 开箱即用、兼容性最强 | 需要原生 CE 的能力时 |

两者共用同一套上层 API（扫描、地址表、.CT、地址表达式）。
详细用法与"为什么原生后端必须异步"的论证见 [docs/backends.md](docs/backends.md)。

### 关于"同步调用原生 CE"的结论

**已证明不可实现**，两条路都被实测堵死（最小复现保留在 `docs/evidence/` 下）：

1. 主线程 `Promise + Atomics.wait` → 阻塞卡死事件循环，socket 回调不执行
   （`docs/evidence/atomics-wait-io.js`）；
2. socket 挪到 worker 线程、主线程仍 `Atomics.wait` → **同样死锁**，
   因为 worker 被阻塞后它自己的事件循环也停了（`docs/evidence/mini-repro.js`）。

根本原因：`Atomics.wait` 与 socket I/O **无法在任何同一线程内共存**。
因此原生 CE 后端诚实地暴露为异步 API，而不是用子进程或忙轮询伪造同步。

---

## 四、与 CE 的已知语义差异

以下差异是**有意为之**的，均已写入对应代码注释或文档：

1. **浮点极值舍入的区间开闭**：CE 自身在 `SingleExact` 用闭区间 `[min,max]`、
   在 `DoubleExact` 用开区间 `(min,max)`。本移植**保持这个不一致**以对齐 CE 行为。
2. **`.scandata` 指针扫描文件格式**：CE 用自定义二进制 PSCAN 格式；
   本移植用内存缓存 + JSON，**与 CE 二进制格式不兼容**。
3. **地址表 `.CT` 格式兼容**：读写双向兼容（元素顺序、引号形式、未知元素保留），
   但不支持 Auto Assembler 脚本段的执行。
4. **Lua 桥的部分 API 语义**：`readInteger` 默认有符号、`readBytes` 默认返回表、
   `sleep` 阻塞事件循环等，详见 [docs/lua-api.md](docs/lua-api.md) 的差异章节。
5. **`NativeCeBackend` 未实现线程枚举**：ceserver 的
   `CMD_CREATETOOLHELP32SNAPSHOTEX(35)` 响应布局随版本变化，为可靠性起见不做猜测。

---

## 五、结论

- 需要 **CE 的扫描/指针/地址表/Lua 能力** → 本移植已覆盖，可直接用。
- 需要 **内核驱动 / DBVM / 反汇编 / 调试器 / GUI** → 请使用原生 CE；
  或者在 Node 侧通过 `NativeCeBackend` 调用一个运行中的 CE 服务端。
- 需要**逐行等价**的完整 CE → 不可行，原因见上。
