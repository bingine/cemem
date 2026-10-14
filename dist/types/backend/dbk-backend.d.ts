/**
 * DBK 内核驱动后端 —— 通过 CE 自己的 DBK 驱动 ioctl 读写受保护进程内存。
 *
 * ## 为什么需要它
 *
 * `SelfBackend` 走用户态 `OpenProcess`/`ReadProcessMemory`，因此**受保护进程
 * （PPL、反作弊、以更高权限运行的进程）读不到**。CE 解决这个问题的办法是加载
 * 自己的内核驱动（DBK64），再用一组 ioctl 让内核代劳。
 * 本后端就是那组 ioctl 的 Node 实现。
 *
 * ## 协议来源（全部逐行核对 CE 源码，不是猜的）
 *
 * 1. **ioctl 码**（`Cheat Engine/dbk32/DBK32functions.pas` 第 26–93 行）：
 *
 *    ```pascal
 *    const METHOD_BUFFERED   = 0;
 *    const FILE_DEVICE_UNKNOWN = $00000022;
 *    const FILE_RW_ACCESS    = 3;
 *    IOCTL_CE_READMEMORY  = (IOCTL_UNKNOWN_BASE shl 16) or ($0800 shl 2) or METHOD_BUFFERED or (FILE_RW_ACCESS shl 14);
 *    IOCTL_CE_WRITEMEMORY = (IOCTL_UNKNOWN_BASE shl 16) or ($0801 shl 2) or ...
 *    ```
 *
 * 2. **读内存的调用形态**（`ReadProcessMemory64_Internal`，第 1523–1584 行）：
 *
 *    ```pascal
 *    type TInputstruct = packed record
 *      processid: uint64;
 *      startaddress: uint64;
 *      bytestoread: word;
 *    end;
 *    ...
 *    input.processid := processid;
 *    input.bytestoread := toread;
 *    input.startaddress := mempointer;
 *    deviceiocontrol(hdevice, cc, @input, sizeof(input), pointer(bufpointer), toread, br, nil)
 *    ```
 *
 *    注意 `packed record` —— **没有对齐填充**，所以输入是 8+8+2 = **18 字节**。
 *    输出直接写到调用方缓冲区。
 *
 * 3. **写内存的调用形态**（第 1620–1686 行）：
 *
 *    ```pascal
 *    input: TInputstruct absolute ao[0];   // 512 字节的固定缓冲
 *    zeromemory(@ao[0], 512);
 *    input.bytestowrite := towrite;
 *    input.startaddress := mempointer;
 *    copymemory(@ao[sizeof(tinputstruct)], bufpointer2, towrite);   // 数据紧跟头部
 *    deviceiocontrol(hdevice, cc, @ao[0], 512, @ao[0], 512, br, nil);  // 同一块缓冲 in/out
 *    ```
 *
 *    单次最多写 `512 - sizeof(TInputstruct)` 字节。
 *
 * 4. **设备名**：`CreateFileW('\\.\' + servicename, ...)`（第 3436 行），
 *    而 `servicename` 默认是 `'CEDRIVER73'`（第 3194 行），
 *    也可被 CE 目录下的 `driver.dat` / `driver64.dat` 覆盖
 *    （第 3217–3225 行按行读入）。因此设备名**不能写死**，本模块按
 *    `driver.dat` → 默认值 → 常见候选的顺序探测。
 *
 * ## 必须说明的风险（诚实部分）
 *
 * **本后端的 ioctl 结构布局无法在没有管理员权限的机器上验证。**
 * 原因是：只有内核驱动真正加载后 `\\.\CEDRIVER73` 才存在，而加载驱动需要管理员。
 * 因此：
 *   - `IOCTL` 码与输入结构是**按源码逐行实现**的，不是猜测；
 *   - 但"驱动侧实际期待的结构布局"只能靠**加载后实测**确认；
 *   - 所以本模块提供 `probe()`：它用 `IOCTL_CE_GETVERSION`（一个参数最少的 ioctl）
 *     验证设备是否真的响应，并如实报告结果，而不是假装能用。
 *
 * @module node-cheat-engine/backend/dbk-backend
 */
import { type BackendCapabilities, type BackendModuleInfo, type BackendProcessHandle, type BackendProcessInfo, type BackendRegion, type BackendRegionFilter, type MemoryBackend } from './types';
/**
 * 本后端用到的 ioctl（功能号来自 `DBK32functions.pas` 的常量定义）。
 *
 * 值可以直接算出来校验：`0x22 << 16 = 0x220000`，`access << 14 = 0xC000`，
 * 所以 READMEMORY（func 0）= `0x220000 | 0 | 0 | 0xC000` = **`0x22C000`**。
 */
export declare const DBK_IOCTL: Readonly<{
    READ_MEMORY: number;
    WRITE_MEMORY: number;
    OPEN_PROCESS: number;
    QUERY_VIRTUAL_MEMORY: number;
    TEST: number;
    /** `IOCTL_CE_GETVERSION`：功能号 0x16，参数最少，适合当"驱动是否活着"的探针 */
    GET_VERSION: number;
    /** `IOCTL_CE_MAKEWRITABLE`：功能号 0x19，把只读页改成可写 */
    MAKE_WRITABLE: number;
    /** `IOCTL_CE_ALLOCATEMEM`：功能号 0x1F */
    ALLOCATE_MEM: number;
    /** `IOCTL_CE_SUSPENDPROCESS` / `RESUMEPROCESS`：功能号 0x24 / 0x25 */
    SUSPEND_PROCESS: number;
    RESUME_PROCESS: number;
}>;
/** 读内存输入结构的大小：`processid(8) + startaddress(8) + bytestoread(2)`。 */
export declare const DBK_READ_INPUT_SIZE = 18;
/** 写内存输入结构的大小：`processid(8) + startaddress(8) + bytestowrite(2)`。 */
export declare const DBK_WRITE_INPUT_SIZE = 18;
/** 写内存用的固定缓冲区总大小（CE 源码里写死 512）。 */
export declare const DBK_WRITE_BUFFER_SIZE = 512;
/** 单次写入能携带的最大数据量。 */
export declare const DBK_MAX_WRITE_PAYLOAD: number;
/** 读内存单次请求上限（CE 按 4096 分块）。 */
export declare const DBK_MAX_READ_CHUNK = 4096;
/**
 * 分配内存输入结构的大小。
 *
 * CE 源码（`DBK32functions.pas:2217-2223`）：
 * ```pascal
 * x: record
 *   processid: uint64;
 *   baseaddress: uint64;
 *   size: uint64;
 *   AllocationType: uint64;
 *   Protect: uint64;
 * end;
 * ```
 * 5 × uint64 = **40 字节**。
 *
 * ⚠️ 与读/写不同，这个记录**没有** `packed` 关键字 —— 但 5 个 uint64 本来
 * 就是 8 字节对齐的，所以 packed 与否大小相同（40），无需纠结。
 */
export declare const DBK_ALLOC_INPUT_SIZE = 40;
/**
 * 打包「读内存」的输入结构。
 *
 * `packed record` 语义：**没有对齐填充**，所以是紧凑的 18 字节。
 * 这一点很关键 —— 若按自然对齐会变成 24 字节，驱动读到的 `bytestoread` 位置就错了。
 *
 * @param pid 目标进程 id（CE 用 uint64 存）
 * @param address 起始地址
 * @param bytesToRead 要读的字节数（word，最大 65535）
 * @returns 18 字节的输入缓冲
 */
export declare function packReadInput(pid: number, address: bigint, bytesToRead: number): Buffer;
/**
 * 打包「写内存」的输入缓冲（512 字节固定大小，数据紧跟头部）。
 *
 * 与读不同，写是**同一块 512 字节缓冲同时当 in/out**：
 *   - 前 18 字节是 `{ processid, startaddress, bytestowrite }`；
 *   - 从第 18 字节起是要写的数据；
 *   - 调用时 in/out 都传这块缓冲。
 *
 * @param pid 目标进程 id
 * @param address 起始地址
 * @param data 要写入的数据（长度不得超过 `DBK_MAX_WRITE_PAYLOAD`）
 * @returns 512 字节的缓冲区
 */
export declare function packWriteBuffer(pid: number, address: bigint, data: Buffer): Buffer;
/**
 * 打包「分配内存」的输入缓冲（40 字节，5 个 uint64）。
 *
 * 驱动侧（`IOPLDispatcher.c` 的 `IOCTL_CE_ALLOCATEMEM` 分支）会
 * `KeAttachProcess` 到目标进程再调 `ZwAllocateVirtualMemory`，
 * 并**把结果地址写回同一块 SystemBuffer 的前 8 字节**：
 *
 * ```c
 * *(PUINT64)Irp->AssociatedIrp.SystemBuffer = 0;
 * *(PUINT_PTR)Irp->AssociatedIrp.SystemBuffer = (UINT_PTR)BaseAddress;
 * ```
 *
 * 所以调用方必须**用同一块缓冲同时作为 in 与 out**，再从偏移 0 读返回值。
 */
export declare function packAllocInput(pid: number, baseAddress: bigint, size: bigint, allocationType: bigint, protect: bigint): Buffer;
/** 从驱动写回的缓冲里读出分配到的地址（偏移 0 的 uint64）。 */
export declare function readAllocResult(buffer: Buffer): bigint;
/** 默认设备名（`DBK32functions.pas` 第 3194 行的出厂值）。 */
export declare const DEFAULT_DBK_SERVICE_NAME = "CEDRIVER73";
/**
 * 从 CE 目录的 `driver.dat` / `driver64.dat` 读取真实服务名。
 *
 * 文件格式（`DBK32functions.pas` 第 3217–3225 行，按行读）：
 *   ```
 *   第 1 行：servicename
 *   第 2 行：processeventname
 *   第 3 行：threadeventname
 *   第 4 行：sysfile
 *   ...
 *   ```
 * 只有第 1 行与本后端相关。
 *
 * @param ceDir Cheat Engine 安装目录（可选；给了才去读）
 * @returns 服务名，读不到返回 null
 */
export declare function readServiceNameFromDriverDat(ceDir: string | undefined): string | null;
/**
 * 解析要用的设备路径。
 *
 * 顺序：显式配置 → `driver.dat` → 默认 `CEDRIVER73`。
 *
 * @param options.serviceName 显式服务名
 * @param options.cheatEngineDir CE 安装目录（用于读 driver.dat）
 * @returns `\\.\<服务名>`
 */
export declare function resolveDevicePath(options?: {
    serviceName?: string;
    cheatEngineDir?: string;
}): string;
export interface DbkBackendOptions {
    /** 显式服务名（不加 `\\.\` 前缀也可）。默认按 driver.dat → CEDRIVER73 解析。 */
    serviceName?: string;
    /** Cheat Engine 安装目录（用于读 driver.dat 拿真实服务名）。 */
    cheatEngineDir?: string;
    /**
     * 允许在驱动不可用时**回退**到用户态实现（`SelfBackend`）。
     * 默认 `false`：本后端的语义就是"走驱动"，静默回退会让人误以为已经绕过了保护。
     */
    fallbackToSelf?: boolean;
    /** 设备已打开的句柄（测试注入用；给了一般不该再让本类自己开） */
    deviceHandle?: unknown;
}
/** 设备不可用（未加载驱动 / 权限不足）时抛出的错误。 */
export declare class DbkDeviceError extends Error {
    readonly devicePath: string;
    readonly win32Code?: number | undefined;
    constructor(message: string, devicePath: string, win32Code?: number | undefined);
}
/**
 * 通过 CE 的 DBK 内核驱动读写目标进程内存。
 *
 * ## 与其他后端的关系
 *
 * - 进程/模块/线程枚举、分配、改保护这些**不需要内核**的操作，直接委托给
 *   内部的 `SelfBackend`（避免重复实现，也避免为这些操作引入未验证的 ioctl）；
 * - **只有内存读写走驱动** —— 这正是受保护进程唯一需要内核的地方，
 *   也是风险最高、最需要精确复刻协议的部分。
 *
 * ## 为什么同步
 *
 * 驱动 ioctl 是同步的系统调用（`DeviceIoControl` 直接返回），
 * 因此本后端声明 `capabilities.sync === true`，扫描/指针扫描/AutoAssembler
 * 都能正常使用（它们内部要求同步后端）。
 */
export declare class DbkBackend implements MemoryBackend {
    private readonly options;
    readonly name = "dbk";
    readonly capabilities: BackendCapabilities;
    private readonly self;
    private device;
    private devicePath;
    private versionCache;
    constructor(options?: DbkBackendOptions);
    /** 当前使用的设备路径（诊断用）。 */
    get resolvedDevicePath(): string;
    /** 驱动是否已打开。 */
    get isDeviceOpen(): boolean;
    /**
     * 打开驱动设备。**需要驱动已加载**（加载驱动需要管理员权限，见 kernel-driver.js）。
     *
     * @throws DbkDeviceError 打开失败（未加载驱动 / 权限不足 / 名字不对）
     */
    openDevice(): void;
    /** 关闭设备句柄。 */
    closeDevice(): void;
    /**
     * 拿驱动版本，用来确认「设备真的在工作」。
     *
     * 这是**最有价值的自检**：它用参数最少的 ioctl，
     * 能区分「设备打不开」与「设备打开了但协议不对」这两种完全不同的故障。
     *
     * @returns 版本字符串；调用失败返回 null
     */
    queryVersion(): string | null;
    /**
     * 一次性自检：设备能否打开、版本能否读到。
     *
     * 供工具输出使用 —— 让"驱动到底通没通"变成一个明确的结论，而不是靠猜。
     */
    probe(): {
        devicePath: string;
        opened: boolean;
        version: string | null;
        error: string | null;
    };
    /** 发一个 ioctl。in/out 可以是同一块 Buffer（METHOD_BUFFERED 允许）。 */
    private ioctl;
    listProcesses(): BackendProcessInfo[];
    openProcess(pid: number): BackendProcessHandle;
    closeProcess(handle: BackendProcessHandle): void;
    queryModules(handle: BackendProcessHandle): BackendModuleInfo[];
    queryThreads(handle: BackendProcessHandle): number[];
    isWow64(handle: BackendProcessHandle): boolean;
    /** 存活判断与句柄形态无关，直接复用用户态实现（见 MemoryBackend.isProcessAlive）。 */
    isProcessAlive(handle: BackendProcessHandle): boolean;
    queryRegions(handle: BackendProcessHandle, filter?: BackendRegionFilter): BackendRegion[];
    /**
     * 读内存 —— 通过 `IOCTL_CE_READMEMORY`。
     *
     * 按 CE 的做法**分块**（每块最多 4096 字节，且不跨页边界，
     * 因为驱动侧按页处理）。读失败时返回已读到的部分，不抛错（与接口约定一致）。
     */
    readProcessMemory(handle: BackendProcessHandle, address: bigint, size: number): Buffer;
    /**
     * 写内存 —— 通过 `IOCTL_CE_WRITEMEMORY`。
     *
     * 按 CE 的做法分块：每块最多 `512 - 18 = 494` 字节，
     * 且 512 字节缓冲**同时作为 in 与 out**。
     *
     * 失败**抛错**（写失败静默化会写坏目标，接口约定要求抛错）。
     */
    writeProcessMemory(_handle: BackendProcessHandle, address: bigint, data: Buffer, _fixProtection?: boolean): number;
    /**
     * 在目标进程内分配内存 —— 通过 `IOCTL_CE_ALLOCATEMEM`。
     *
     * 驱动会 `KeAttachProcess` 到目标进程后用 `ZwAllocateVirtualMemory` 分配，
     * 因此**受保护进程也能分配**（这是用户态 `VirtualAllocEx` 做不到的）。
     *
     * @param size 请求大小（会被驱动按页向上取整）
     * @param protect 保护属性，默认 `PAGE_EXECUTE_READWRITE`
     * @param preferred 期望地址（`0n` 表示由系统选择），对应 `lpAddress`
     * @returns 实际分配到的基址
     */
    allocate(handle: BackendProcessHandle, size: number, protect?: number, preferred?: bigint): bigint;
    /**
     * 改变内存保护属性。
     *
     * ## 为什么这里**不走驱动**
     *
     * CE 的驱动里确实有一个 `IOCTL_CE_MAKEWRITABLE`（功能号 `$0819`），但它
     * **在 x64 驱动上是空的**（`DBKKernel/IOPLDispatcher.c:474-491`）：
     *
     * ```c
     * case IOCTL_CE_MAKEWRITABLE:
     * #ifdef AMD64
     *     //untill I know how win64 handles paging, not implemented
     * #else
     *     ... MakeWritable(...)
     * #endif
     * ```
     *
     * 所以 64 位 Windows 上发这个 ioctl 只会得到「无效请求」。
     * 而且它的输入结构里**没有 processid** —— 它是按调用者（驱动自己所在的
     * 进程上下文）的页表改 PTE 的，本来也不适合"改另一个进程的保护"。
     *
     * 因此本方法**委托 `SelfBackend`（用户态 `VirtualProtectEx`）**，并明确告知这一点。
     * 好消息是：**内存写入不需要先改保护** —— 驱动的写路径本身就绕过了页保护，
     * 只读页照样能写。需要 `changeProtection` 的场景主要是为了「把页改成可执行」
     * 或「让目标自己也能写」，那属于目标进程自身的权限，用户态调用是否成功取决于
     * 当前进程对目标的权限（受保护进程仍会失败）。
     *
     * @returns 旧保护值（用户态 `VirtualProtectEx` 的返回值）
     */
    changeProtection(handle: BackendProcessHandle, address: bigint, size: number, newProtect: number): number;
    /**
     * 释放内存。
     *
     * 驱动**没有**提供释放 ioctl（`KernelFree` 释放的是驱动自己内核态分配的内存，
     * 不是目标进程的）。因此这里委托用户态 `VirtualFreeEx`；
     * 对受保护进程会失败 —— 那种情况下这块内存会一直留在目标进程里，
     * 这是需要如实告诉调用方的限制。
     */
    free(handle: BackendProcessHandle, address: bigint): void;
    dispose(): void;
}
//# sourceMappingURL=dbk-backend.d.ts.map