# DBK 内核驱动后端

让 `node-cheat-engine` 通过 Cheat Engine 自己的 **DBK 内核驱动**读写受保护进程内存。

## 一、为什么需要它

| 后端 | 走什么 | 受保护进程（PPL/反作弊/高权限） |
| --- | --- | --- |
| `SelfBackend`（默认） | 用户态 `OpenProcess` + `ReadProcessMemory` | ❌ 读不到 |
| `NativeCeBackend` | 连 `ceserver` 的 TCP 协议 | ✅（如果那个 ceserver 提权/带驱动） |
| **`DbkBackend`（本文）** | **DBK 驱动的 `DeviceIoControl`** | ✅ |

受保护进程连句柄都打不开，用户态无解 —— 唯一办法是让**内核**代劳。

## 二、协议（逐行核对 CE 源码，不是猜的）

### 2.1 ioctl 码

来源：`Cheat Engine/dbk32/DBK32functions.pas` 第 22–93 行。

```pascal
const FILE_READ_ACCESS  = $0001;
const FILE_WRITE_ACCESS = $0002;
const FILE_RW_ACCESS    = FILE_READ_ACCESS or FILE_WRITE_ACCESS;   // = 3
const METHOD_BUFFERED   = 0;
const FILE_DEVICE_UNKNOWN = $00000022;
const IOCTL_UNKNOWN_BASE  = FILE_DEVICE_UNKNOWN;

IOCTL_CE_READMEMORY  = (IOCTL_UNKNOWN_BASE shl 16) or ($0800 shl 2) or METHOD_BUFFERED or (FILE_RW_ACCESS shl 14);
IOCTL_CE_WRITEMEMORY = (IOCTL_UNKNOWN_BASE shl 16) or ($0801 shl 2) or ...
```

代入 READMEMORY：

```
(0x22 << 16) | (0x0800 << 2) | 0 | (3 << 14)
= 0x220000 | 0x2000 | 0 | 0xC000
= 0x220000 | 0x2000 = 0x222000
= 0x222000 | 0xC000  = 0x22E000
```

> ⚠️ **这一步很容易算错**。我在这上面错了两次：先后误以为结果是 `0x22C000`。
> 原因是 `0x22 << 16` 会占用 bit 17/21，与 `0x0800 << 2` 的 bit 13 **在同一数值区间叠加**，
> 不能凭"整齐的十六进制"直觉去拼。**必须逐项 OR 累加。**
> 真机上 ioctl 码错了只表现为"驱动返回无效请求"，几乎无法从现象反推原因 ——
> 所以测试里把具体数值写死了。

本后端用到的码（都由上面的公式算出）：

| 名称 | 功能号 | ioctl 码 |
| --- | --- | --- |
| `READ_MEMORY` | `$0800` | `0x22E000` |
| `WRITE_MEMORY` | `$0801` | `0x22E004` |
| `OPEN_PROCESS` | `$0802` | `0x22E008` |
| `QUERY_VIRTUAL_MEMORY` | `$0803` | `0x22E00C` |
| `GET_VERSION` | `$0816` | `0x22E058` |
| `MAKE_WRITABLE` | `$0819` | `0x22E064` |
| `ALLOCATE_MEM` | `$081F` | `0x22E07C` |
| `SUSPEND_PROCESS` / `RESUME_PROCESS` | `$0824` / `$0825` | `0x22E090` / `0x22E094` |

### 2.2 读内存

来源：`ReadProcessMemory64_Internal`，第 1523–1584 行。

```pascal
type TInputstruct = packed record     // ← packed：无对齐填充
  processid: uint64;
  startaddress: uint64;
  bytestoread: word;
end;
...
deviceiocontrol(hdevice, cc, @input, sizeof(input), pointer(bufpointer), toread, br, nil)
```

- 输入是 **18 字节**（8+8+2）。若按自然对齐会变成 24 字节，驱动读到的偏移就全错。
- 输出直接写到调用方缓冲区。
- CE 按 4096 字节分块，且**不跨页**：

  ```pascal
  if (mempointer and $fff) > 0 then
    toread := 4096 - (mempointer and $fff)
  else
    toread := 4096;
  ```

### 2.3 写内存

来源：第 1620–1686 行。

```pascal
input: TInputstruct absolute ao[0];        // 512 字节固定缓冲
zeromemory(@ao[0], 512);
input.bytestowrite := towrite;
input.startaddress := mempointer;
copymemory(@ao[sizeof(tinputstruct)], bufpointer2, towrite);   // 数据紧跟头部
deviceiocontrol(hdevice, cc, @ao[0], 512, @ao[0], 512, br, nil);  // ← in/out 同一块
```

- 缓冲固定 **512 字节**，单次最多 `512 - 18 = 494` 字节。
- **in 与 out 传同一块缓冲** —— 这是 `METHOD_BUFFERED` 允许的，也是 CE 的做法。

### 2.4 设备名

来源：第 3194 行与第 3436 行。

```pascal
servicename := 'CEDRIVER73';               // 出厂默认（第 3194 行）
...
hDevice := CreateFileW(pwidechar('\\.\'+servicename), GENERIC_READ or GENERIC_WRITE,
                       FILE_SHARE_READ or FILE_SHARE_WRITE, ...);
```

但 `servicename` 可以被 CE 目录下的 `driver.dat` / `driver64.dat` **覆盖**
（第 3217–3225 行按行读入，第 1 行就是服务名）—— CE 安装时会把服务名**随机化**来降低被检测的概率。

因此本后端按以下顺序解析设备路径：

1. 显式配置的 `serviceName`；
2. `driver.dat` / `driver64.dat` 的第一行（需要给 `cheatEngineDir`）；
3. 默认 `CEDRIVER73`。

## 三、用法

### 3.1 在 node-cheat-engine 里直接用

```js
const { DbkBackend, Process, setDefaultBackend } = require('@bingine/cemem');

const backend = new DbkBackend({ cheatEngineDir: 'C:\\Program Files\\Cheat Engine' });

// 先自检：设备能不能打开、驱动版本能不能读到
const probe = backend.probe();
console.log(probe);
// { devicePath: '\\\\.\\CEDRIVER73', opened: false, version: null, error: '...' }

setDefaultBackend(backend);
const proc = Process.open(1234);
const buf = proc.readMemory(0x7ff000001000n, 64);   // ← 走内核 ioctl
proc.close();
backend.dispose();
```

### 3.2 在 DSH 插件里切换

```yaml
config:
  backend: dbk
  cheatEngineDir: 'C:\Program Files\Cheat Engine'   # 可选：让插件读 driver.dat 拿真实服务名
  dbkServiceName: ''                                # 可选：直接指定服务名
```

### 3.3 自检工具

```
ce_kernel { action: "probe_driver" }
```

这是**唯一能在真机上验证本后端的手段**（原因见下一节），它会报告：

```
设备路径：\\.\CEDRIVER73
能否打开：能 / 不能
驱动版本：x.y.z.w
内核服务 DBK64：RUNNING
```

## 五、支持的能力

| 操作 | 实现方式 | 说明 |
| --- | --- | --- |
| 读 / 写内存 | ✅ **驱动**（`READ_MEMORY` / `WRITE_MEMORY`） | 本后端存在的唯一理由；受保护进程也能读写 |
| **分配内存** | ✅ **驱动**（`IOCTL_CE_ALLOCATEMEM` = `0x22E07C`） | 驱动 `KeAttachProcess` 到目标进程再调 `ZwAllocateVirtualMemory`，**受保护进程也能分配** |
| 进程/模块/线程枚举 | 委托 `SelfBackend` | 本来就不受进程保护影响 |
| 内存区域枚举 | 委托 `SelfBackend`（`VirtualQueryEx`） | 同上 |
| 改内存保护 | ⚠️ **用户态**（`VirtualProtectEx`） | 见下方说明 —— 驱动侧在 x64 上是空的 |
| 释放内存 | ⚠️ **用户态**（`VirtualFreeEx`） | 驱动没有释放目标进程内存的 ioctl |
| 挂起/恢复线程 | ❌ 未实现 | 驱动有 `SUSPENDTHREAD`/`RESUMETHREAD`（`$0822`/`$0823`） |
| 物理内存读写 | ❌ 未实现 | `IOCTL_CE_READPHYSICALMEMORY`（`$0806`）等 |
| 内核调试（断点/单步） | ❌ 未实现 | 涉及驱动侧调试器状态机，风险高 |

### 5.1 为什么 `changeProtection` 不走驱动

CE 的驱动里**确实**有一个 `IOCTL_CE_MAKEWRITABLE`（功能号 `$0819`），但它在
**x64 驱动上是空的** —— `DBKKernel/IOPLDispatcher.c:474-491`：

```c
case IOCTL_CE_MAKEWRITABLE:
    {
#ifdef AMD64
        //untill I know how win64 handles paging, not implemented
#else
        struct InputBuf {
            UINT64 StartAddress;
            ULONG  Size;
            BYTE   CopyOnWrite;
        } *PInputBuf;
        PInputBuf = Irp->AssociatedIrp.SystemBuffer;
        ntStatus = MakeWritable(...) ? STATUS_SUCCESS : STATUS_UNSUCCESSFUL;
#endif
        break;
    }
```

所以 64 位 Windows 上发这个 ioctl 只会拿到「无效请求」（`STATUS_INVALID_DEVICE_REQUEST`）。

而且它的输入结构里**没有 `processid`** —— `MakeWritable` 是按**调用者进程**的页表
改 PTE（`deepkernel.c` 里那个 `x->RW=1` 直接写 PTE），本来也不适合"改另一个进程的保护"。

**因此 `changeProtection` 委托用户态 `VirtualProtectEx`**，并如实报告这一点。

> **好消息**：**写内存不需要先改保护**。驱动的写路径本身就在内核态执行，
> 只读页照样能写（`SelfBackend` 那种"先临时放开保护"的麻烦在 DBK 后端里不存在）。
> 需要 `changeProtection` 的场景主要是把页改成可执行、或让目标进程自己也能写。

### 5.2 `allocate` 的数据流（容易写错的地方）

CE 源码（`DBK32functions.pas:2217-2223`）的输入结构：

```pascal
x: record
  processid: uint64;
  baseaddress: uint64;
  size: uint64;
  AllocationType: uint64;
  Protect: uint64;
end;   // 5 × 8 = 40 字节
```

驱动侧（`IOPLDispatcher.c` 的 `ALLOCATEMEM` 分支）**把结果写回同一块 SystemBuffer**：

```c
*(PUINT64)Irp->AssociatedIrp.SystemBuffer = 0;
*(PUINT_PTR)Irp->AssociatedIrp.SystemBuffer = (UINT_PTR)BaseAddress;
```

⚠️ 所以调用时 **in 与 out 必须是同一块缓冲**，再从**偏移 0** 读返回值：

```js
const buffer = packAllocInput(pid, preferred, BigInt(size), MEM_COMMIT | MEM_RESERVE, protect);
ioctl(DBK_IOCTL.ALLOCATE_MEM, buffer, buffer.length, buffer);  // in/out 同一块
const address = readAllocResult(buffer);                        // 偏移 0 的 uint64
```

若误把 out 传成另一块空缓冲，读到的永远是 0。

## 六、未验证部分（**请务必读完**）

### 4.1 为什么无法在本机验证

只有驱动**真正加载**后 `\\.\CEDRIVER73` 才存在，而**加载内核驱动需要管理员权限**
（Windows 硬边界，见 [README 的内核驱动一节](../README.md)）。
开发这个后端的环境没有管理员权限，因此：

| 项目 | 状态 |
| --- | --- |
| ioctl 码与 CE 源码一致 | ✅ 已用**逐项 OR 累加**核对，测试写死具体数值 |
| 输入结构是 packed 18 字节 | ✅ 已用字段偏移断言验证 |
| 设备名解析（含 driver.dat） | ✅ 已用真实文件格式测试 |
| 设备打不开时的错误路径 | ✅ 已测试（本机就是这种情况） |
| **驱动侧实际期待的结构布局** | ❌ **未验证** —— 只能在装好驱动的机器上试 |
| **读写在真实受保护进程上的效果** | ❌ **未验证** |

### 4.2 已知的具体风险

1. **`processid` 的宽度**。CE 的 Pascal 源码里是 `uint64`，但 32 位与 64 位构建的
   `packed record` 布局可能不同。本实现按 **8 字节**写（与 DBK64 的 64 位驱动对应）。
   若驱动侧实际期待 `dword`，读到的 `startaddress` 会错位 —— 表现为读到全 0 或乱码。
2. **驱动侧可能有额外的对齐要求**。CE 的 Pascal 用 `packed record`，
   但 C 侧（`DBKKernel/`）的结构体若未加 `#pragma pack(1)`，布局会不同。
   CE 的 `DBK32functions.pas` 是**用户态**那份，理论上与驱动侧一致，但这一点没能实测。
3. **`GET_VERSION` 的返回布局**。本实现把返回的前几个非零 dword 拼成版本号，
   布局未经确认，因此 `probe()` 里对"版本读不出来"单独给了一条提示
   （它意味着**协议可能不一致**，而不是驱动没工作）。

### 4.3 出问题时怎么排查

先跑 `ce_kernel action=probe_driver`：

- **打不开设备** → 驱动没加载 / 服务名不对 / 未提权。这一层与本后端无关，
  按输出里的三条原因逐条排。
- **能打开但版本读不到** → 高度怀疑 §4.2 的结构布局问题。
- **能打开、版本正常、但读到的字节不对** → 大概率是 §4.2 第 1 条
  （`processid` 宽度）。此时可以试着把 `packReadInput` / `packWriteBuffer` 里的
  `writeBigUInt64LE(pid, 0)` 改成 `writeUInt32LE(pid, 0)` 并把后续偏移整体前移 4 字节，
  对比两种布局哪个能读对。

## 七、尚未实现的能力

见 §五 的表格。要点复述：

- **挂起/恢复线程**：驱动有 `IOCTL_CE_SUSPENDTHREAD`（`$0822`）/
  `RESUMETHREAD`（`$0823`），未实现，能力声明里 `suspendThreads: false`。
- **物理内存读写**：`IOCTL_CE_READPHYSICALMEMORY`（`$0806`）/
  `WRITEPHYSICALMEMORY`（`$0807`）/ `GETPHYSICALADDRESS`（`$0808`），未实现。
- **内核调试**：断点、单步、`GETCR3`/`GETSDT`/`GETIDT` 等。涉及驱动侧调试器状态机，
  风险高，未做。
- **`ALLOCATEMEM_NONPAGED`**（`$0826`，内核态非分页内存）：CE 用它给驱动自己分配
  通信缓冲，与"目标进程内存"无关，本后端不需要。

> 这些**不声称支持**是刻意的：能力声明里对应的字段就是 `false`，
> 上层可以据此降级，而不是在运行时神秘失败。
>
> 另外要注意 `changeProtection` / `free` 虽然声明为 `true`，
> 但它们是**用户态**实现的 —— 对受保护进程会失败。
> 这是 CE 驱动本身的能力缺口（见 §5.1），不是本后端的偷懒。
