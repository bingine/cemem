# 两种内存后端：自研引擎 与 原生 CE

本移植提供**统一接口 + 两个可切换后端**。上层 API（扫描、地址表、`.CT` 读写、
地址表达式）对两者一视同仁，因为它们都只依赖 `MemoryBackend` 接口。

| | `SelfBackend`（默认） | `NativeCeBackend` |
| --- | --- | --- |
| 名称 | `'self'` | `'native-ce'` |
| 原理 | 本进程内通过 koffi 直接调 Win32 API | 作为客户端连接 CE 官方 `ceserver` 的 TCP 协议 |
| 外部依赖 | 无 | 需要运行中的 `ceserver` |
| 同步性 | **同步**（`capabilities.sync === true`） | **异步**（返回 Promise） |
| 需要管理员 | 视目标而定 | 视目标与 ceserver 而定 |
| 受保护进程 | 读不到（无内核驱动） | 取决于服务端权限与扩展 |

---

## 一、自研后端（默认，推荐先用这个）

开箱即用、无外部依赖，覆盖 Cheat Engine 在**未加载内核驱动**时能做的全部用户态操作。

```js
const { Process, ScanSession, VariableType, ScanOption, RoundingType } = require('@bingine/cemem');

// 默认就是 SelfBackend
const proc = Process.open(1234);
const s = new ScanSession(proc);
s.firstScan({
  variableType: VariableType.DWord,
  scanOption: ScanOption.ExactValue,
  roundingType: RoundingType.Rounded,
  floatAccuracy: 0,
  value1: '1000',
});
console.log('命中', s.resultCount, '个');

proc.close();
```

显式指定后端：

```js
const { Process, SelfBackend } = require('@bingine/cemem');

const backend = new SelfBackend();
const proc = Process.open(1234, { backend });
// ...
proc.close();
backend.dispose();
```

全局切换默认后端：

```js
const { setDefaultBackend, NativeCeBackend } = require('@bingine/cemem');
setDefaultBackend(new NativeCeBackend({ host: '127.0.0.1', port: 52736 }));
setDefaultBackend(null); // 恢复自研后端
```

---

## 二、原生 CE 后端（通过 ceserver）

### 2.1 先准备一个 ceserver

`ceserver` 是 Cheat Engine 官方仓库里的服务端程序（源码在
`Cheat Engine/ceserver/`），它把 CE 的内存能力通过 TCP 暴露出来。
本仓库**不含它的可执行文件**，你需要自己准备：

1. 从 Cheat Engine 官方发行版中查找 `ceserver` / `ceserver.exe`；
2. 或者用 CE 源码里的 `Cheat Engine/ceserver/` 自行编译
   （Linux/Android 版本在 CE 源码中；Windows 版本同样位于该目录）；
3. 启动它，默认监听 **52736** 端口。

先用 telnet / 自备脚本确认端口可达，再跑下面的代码。

### 2.2 用法（注意 `await`）

```js
const { NativeCeBackend, openProcessAsync, ScanSession } = require('@bingine/cemem');

const backend = new NativeCeBackend({ host: '127.0.0.1', port: 52736 });

// 版本探测（可选，用于确认连通）
console.log('ceserver 版本:', await backend.getVersion());

// 打开进程：必须用异步入口
const proc = await openProcessAsync(1234, { backend });

// 读内存：用异步变体
const buf = await proc.readMemoryAsync(0x7ff000001000n, 16);

// 写内存
await proc.writeMemoryAsync(0x7ff000001000n, Buffer.from([1, 2, 3, 4]));

// 区域与模块
const regions = await proc.regionsAsync();
const modules = await proc.modulesAsync();

await proc.closeAsync();
await backend.dispose();
```

### 2.3 也可以用异步版的进程枚举

```js
const { listProcessesAsync, findProcessesByNameAsync } = require('@bingine/cemem');
const all = await listProcessesAsync(backend);
const notepads = await findProcessesByNameAsync('notepad', backend);
```

---

## 三、同步与异步的分工（重要）

`MemoryBackend` 的方法返回 `MaybePromise<T>`：

- **同步后端**（`SelfBackend`）直接返回值，**不**返回 Promise；
- **异步后端**（`NativeCeBackend`）返回 Promise。

`Process` 同时提供两套方法：

| 同步（仅同步后端可用） | 异步（两种后端都可用） |
| --- | --- |
| `Process.open(pid)` | `await openProcessAsync(pid)` |
| `proc.readMemory(addr, n)` | `await proc.readMemoryAsync(addr, n)` |
| `proc.writeMemory(addr, buf)` | `await proc.writeMemoryAsync(addr, buf)` |
| `proc.regions()` | `await proc.regionsAsync()` |
| `proc.modules()` | `await proc.modulesAsync()` |
| `proc.threadIds()` | `await proc.threadIdsAsync()` |
| `proc.allocate(...)` | `await proc.allocateAsync(...)` |
| `proc.protect(...)` | `await proc.protectAsync(...)` |
| `proc.isWow64()` | `await proc.isWow64Async()` |
| `proc.close()` | `await proc.closeAsync()` |

在异步后端上误用同步方法时，会得到**明确错误**而不是崩掉：

```
后端 "native-ce" 是异步的，不能使用同步方法 readMemory()。
请改用异步变体（例如 readMemoryAsync()）并 await，
或改用同步后端 SelfBackend。
```

`await` 对两种后端都安全（`await` 一个非 Promise 值会原样返回），
所以如果你只写一套代码，统一用 `await` + `*Async` 即可。

---

## 四、为什么原生 CE 后端必须是异步的

这不是偷懒，而是**已证明技术上不可行**。曾尝试两种同步包装方式，都实测死锁：

### 尝试 1：主线程 `Promise` + `Atomics.wait`

```js
// 反例（不要这么写）
const p = socketRoundTrip();
while (!done) Atomics.wait(ctrl, 0, 0, 50);   // ← 卡死
```

`Atomics.wait` 会完全阻塞当前线程的事件循环，socket 的 `connect`/`data`
回调与 Promise 微任务都永远得不到执行。
最小复现：`docs/evidence/atomics-wait-io.js` → 输出 `FAIL: 死锁/未完成`。

### 尝试 2：socket 放 worker 线程，主线程仍 `Atomics.wait`

```js
// 同样反例：worker 里也阻塞
worker: Atomics.wait(ctrl, 0, seq, 20)   // ← worker 自己的事件循环也停了
```

**worker 线程被阻塞后，它自己的 socket 回调同样不会执行**，
于是主线程每次都等到超时。最小复现：`docs/evidence/mini-repro.js`。

（补充验证：`setImmediate` 自旋轮询会饥饿 I/O 阶段；`setTimeout` 轮询也不行，
因为阻塞发生在同一线程。）

### 结论

`Atomics.wait` 与 socket I/O **无法在任何同一线程内共存**。
子进程方案也验证失败（沙箱下 `spawnSync` 子进程的 socket 无响应）。

因此选择最诚实的做法：**原生 CE 后端暴露为异步 API**，
而不是用子进程或忙轮询把复杂度藏到别处。

---

## 五、能力矩阵（用于运行时判断）

```js
const { SelfBackend, NativeCeBackend } = require('@bingine/cemem');

console.table({
  SelfBackend: new SelfBackend().capabilities,
  NativeCeBackend: new NativeCeBackend({ port: 1 }).capabilities,
});
```

| 能力 | SelfBackend | NativeCeBackend |
| --- | --- | --- |
| `sync`（同步完成） | `true` | `false` |
| `enumerateProcesses` | ✅ | ✅ |
| `queryRegions` | ✅ | ✅ |
| `queryModules` | ✅ | ✅ |
| `queryThreads` | ✅ | ❌（明确抛错） |
| `suspendThreads` | ✅ | ❌ |
| `allocateMemory` | ✅ | ✅ |
| `changeProtection` | ✅ | ✅ |
| `local` | `true` | `false` |
| `requiresServer` | `false` | `true` |

调用前建议检查 `backend.capabilities.xxx`，不要假设能力存在。
`NativeCeBackend.queryThreads()` 会抛出带解释的错误（而不是返回空数组假装成功）。

---

## 六、ceserver 协议实现范围

完整命令号列表见 `CESERVER_CMD`（严格对齐 `ceserver.h`）。已实现：

| 命令 | 用途 |
| --- | --- |
| `GETVERSION(0)` | 版本探测 |
| `OPENPROCESS(3)` / `CLOSEHANDLE(7)` | 打开/关闭进程 |
| `CREATETOOLHELP32SNAPSHOT(4)` | 建进程/模块快照 |
| `PROCESS32FIRST(5)` / `PROCESS32NEXT(6)` | 进程枚举 |
| `VIRTUALQUERYEX(8)` | 内存区域枚举 |
| `READPROCESSMEMORY(9)` | 读内存（`compress=0`） |
| `WRITEPROCESSMEMORY(10)` | 写内存 |
| `MODULE32FIRST(22)` / `MODULE32NEXT(23)` | 模块枚举 |
| `ALLOC(26)` / `FREE(27)` | 目标内分配/释放 |
| `CHANGEMEMORYPROTECTION(36)` | 改内存保护 |

**未实现**（调用会抛 `BackendUnsupportedError` 或明确错误）：
线程枚举 `CREATETOOLHELP32SNAPSHOTEX(35)`（响应布局随版本变化）、
调试器命令（`STARTDEBUG`/`SETBREAKPOINT` 等）、速度修改 `SPEEDHACK_SETSPEED(30)`、
管道（`OPENNAMEDPIPE`/`PIPEREAD`/`PIPEWRITE`）、符号文件加载 `GETSYMBOLLISTFROMFILE(24)`。

协议组帧细节（字段宽度、响应布局、两轮读取的原因）都写在
`src/backend/native-ce-backend.ts` 的注释里，并有用本地假服务端逐字段核对的测试
（`test/backend.test.js`，20 个用例）。

---

## 七、联调排查

| 现象 | 原因与处理 |
| --- | --- |
| `无法连接 ceserver（host:port）：...` | 服务端没起、端口不对、或防火墙。错误信息里带了 host:port。 |
| `连接 ceserver 超时` | 地址不可达。确认 ceserver 在目标机器上监听。 |
| `ceserver 无法打开进程 N（...）` | 进程不存在，或服务端权限不足 → 以管理员身份运行 ceserver。 |
| `ceserver 命令 "X" 响应超时` | 服务端卡住或响应长度与预期不符。可调大 `timeoutMs`。 |
| `后端 "native-ce" 是异步的...` | 你用了同步方法。改用 `*Async` 变体 + `await`。 |
| `ceserver 写入不完整` | 服务端只写了部分字节（常见于保护页）。本实现会**抛错而不是静默通过**。 |

需要真实联调时，把 `ceserver` 起来后：

```bash
npm run test:backend
```

**注意**：`test/backend.test.js` 目前**全部**使用本地假服务端来逐字段核对协议
（20 个用例），**不含**依赖真实 `ceserver` 的用例 —— 因为本仓库不含该二进制，
测试必须能在没有它的环境下通过。因此这 20 个用例证明的是
**组帧/解析正确**，不证明"你的 ceserver 部署可用"。
后者请按上面的排查表手工验证：

```js
const { NativeCeBackend } = require('@bingine/cemem');
const b = new NativeCeBackend({ host: '127.0.0.1', port: 52736 });
console.log(await b.getVersion());      // 能打印版本即说明连通
console.log((await b.listProcesses()).length, '个进程');
await b.dispose();
```
