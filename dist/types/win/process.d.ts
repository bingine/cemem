/**
 * 进程与内存访问层 —— 后端无关的门面。
 *
 * 本文件不再直接调用 Win32 API，而是委托给 `MemoryBackend`：
 *   - `SelfBackend`      → 自研引擎（默认，本进程内直接调用 Win32）
 *   - `NativeCeBackend`  → 原生 CE 兼容层（连接 ceserver 的 TCP 协议）
 *
 * 因此 `Process` 的用法在两种后端下完全一致：
 * ```ts
 * const p = Process.open(pid);                       // 默认自研后端
 * const p2 = Process.open(pid, { backend: native }); // 走原生 CE
 * ```
 *
 * 性能提示：CE 扫描时把整段内存拷进缓冲区再本地比较，本移植沿用同一思路，
 * 因此后端只需要提供一个"按块读内存"的原语即可，比较逻辑全在上层。
 */
import { DEFAULT_PROCESS_ACCESS, MEM_COMMIT, MEM_IMAGE, MEM_MAPPED, MEM_PRIVATE, MemoryRegion, PAGE_GUARD } from '../types';
import { BackendProcessHandle, BackendRegionFilter, MemoryBackend } from '../backend/types';
export { isReadable, isWritable, isExecutable } from '../backend/self-backend';
/** 取进程内共享的默认后端（自研引擎）。 */
export declare function getDefaultBackend(): MemoryBackend;
/** 替换默认后端（例如全局切到原生 CE）。传入 null 恢复自研后端。 */
export declare function setDefaultBackend(backend: MemoryBackend | null): void;
/** `Process.open` 的选项 */
export interface OpenProcessOptions {
    /** 使用哪个后端；省略则用默认后端 */
    backend?: MemoryBackend;
    /** 请求的进程访问权限（仅自研后端支持） */
    access?: number;
}
export interface ProcessInfo {
    pid: number;
    name: string;
    /** 父进程 pid；`null` = 当前后端不提供这个字段（**不是 0**） */
    parentPid: number | null;
    /** 线程数；`null` = 当前后端不提供这个字段（**不是 0**） */
    threadCount: number | null;
    /** 是否存在同名多进程 */
    duplicateName?: boolean;
}
/** 枚举全部进程（使用默认后端；同步后端专用，异步后端请用 listProcessesAsync） */
export declare function listProcesses(backend?: MemoryBackend): ProcessInfo[];
/** 按名字查进程（不区分大小写，包含匹配） */
export declare function findProcessesByName(name: string, backend?: MemoryBackend): ProcessInfo[];
/** 枚举全部进程（异步；对同步与异步后端都可用） */
export declare function listProcessesAsync(backend?: MemoryBackend): Promise<ProcessInfo[]>;
/** 按名字查进程（异步） */
export declare function findProcessesByNameAsync(name: string, backend?: MemoryBackend): Promise<ProcessInfo[]>;
/** 可扫描区域过滤条件，对齐 CE 的扫描设置 */
export interface RegionFilter extends BackendRegionFilter {
}
/**
 * 枚举进程内存区域。
 *
 * 只接受 `Process` 实例（早期版本接受裸 Win32 句柄，那样无法支持原生 CE 后端，
 * 因此移除；请用 `process.regions()`）。
 */
export declare function enumerateRegions(process: Process, options?: {
    includeFree?: boolean;
    maxAddress?: bigint;
}): MemoryRegion[];
/** 选出"可扫描"的内存区域（对齐 CE 首次扫描的默认行为） */
export declare function selectScannableRegions(process: Process, filter?: RegionFilter): MemoryRegion[];
/** 打开进程失败时抛出的错误，带 pid 与 Win32 错误码（若后端提供）。 */
export declare class ProcessOpenError extends Error {
    readonly pid: number;
    readonly win32Code: number;
    constructor(pid: number, win32Code: number, message?: string);
}
export interface ProcessModule {
    name: string;
    path: string;
    baseAddress: bigint;
    size: number;
}
/**
 * 一个已打开的目标进程。
 *
 * 生命周期：
 * ```ts
 * const p = Process.open(pid);
 * try { ... } finally { p.close(); }
 * ```
 * 也支持 `using`（Symbol.dispose）。
 */
export declare class Process {
    readonly pid: number;
    readonly name: string;
    readonly backend: MemoryBackend;
    private readonly handle;
    private closed;
    private constructor();
    /** 按 pid 打开进程（同步后端专用；异步后端请用 openProcessAsync） */
    static open(pid: number, options?: OpenProcessOptions): Process;
    /** 按进程名打开；同名多进程时选第一个 */
    static openByName(name: string, options?: OpenProcessOptions): Process;
    /** 按进程名打开全部同名进程 */
    static openByNameAll(name: string, options?: OpenProcessOptions): Process[];
    /**
     * 由"已打开的后端句柄"构造 Process —— 供异步打开路径使用。
     * 一般业务代码请用 `Process.open` / `openProcessAsync`。
     */
    static fromHandle(pid: number, name: string, backend: MemoryBackend, handle: BackendProcessHandle): Process;
    get isOpen(): boolean;
    /** 所属后端名称 */
    get backendName(): string;
    /**
     * 底层后端句柄 —— 供需要直接调用后端的扩展代码使用
     * （例如 Lua 桥要把句柄转成整数传给脚本）。
     * 一般业务代码应优先使用 Process 的高层方法。
     */
    get backendHandle(): BackendProcessHandle;
    private assertOpen;
    /** 是否为 WOW64（32 位）进程 */
    isWow64(): boolean;
    /**
     * 目标进程是否**仍然存活**。
     *
     * 为什么需要它（真实踩过的坑）：Windows 上**进程对象在退出后句柄依然有效**，
     * 直到 `CloseHandle` 之前 `isOpen` 一直是 true。于是上层什么都察觉不到：
     * `modules()` 返回空数组、`regions()` 返回 0 条、`readMemory()` 返回 0 字节 ——
     * 调用方看到的是「0 个模块 / 0 个区域 / 读不到内存」，而不是「目标已经退出」。
     * 上层（DSH 插件的会话层）据此给出误导性的报错，只有 detach + 重新 attach 才恢复。
     *
     * @returns true=存活；false=已退出**或句柄已关闭**；undefined=后端无法判断（例如 ceserver）
     */
    isProcessAlive(): boolean | undefined;
    /** 异步变体（原生 CE 后端走这条路） */
    isProcessAliveAsync(): Promise<boolean | undefined>;
    /** 列出全部内存区域 */
    regions(options?: {
        includeFree?: boolean;
        maxAddress?: bigint;
    }): MemoryRegion[];
    /** 列出可扫描区域 */
    scannableRegions(filter?: RegionFilter): MemoryRegion[];
    /**
     * 读取内存。整块读取失败时由后端做二分回退。
     * @returns 实际读到的数据（长度可能小于请求）
     */
    readMemory(address: bigint, size: number): Buffer;
    /** 读取失败时抛错的严格版本 */
    readMemoryExact(address: bigint, size: number): Buffer;
    /**
     * 写入内存。默认在写只读页前临时改保护（与 CE 的 writeprocessmemory 行为一致）。
     * @returns 实际写入字节数
     */
    writeMemory(address: bigint, data: Buffer, fixProtection?: boolean): number;
    /** 在目标进程内分配内存 */
    allocate(size: number, protect?: number, address?: bigint): bigint;
    /** 释放由 allocate 分配的内存 */
    free(address: bigint): void;
    /** 修改内存保护属性，返回旧保护值 */
    protect(address: bigint, size: number, newProtect: number): number;
    /** 列出进程模块 */
    modules(): ProcessModule[];
    /** 列出线程 id */
    threadIds(): number[];
    /**
     * 挂起进程全部线程，返回可传给 resume() 的令牌。
     * 仅自研后端支持（原生 CE 后端会抛错）。
     */
    suspend(): unknown;
    /** 恢复之前挂起的线程 */
    resume(token: unknown): void;
    /** 关闭句柄。可重复调用。 */
    close(): void;
    /** 支持 `using` 语义 */
    [Symbol.dispose](): void;
    /** 异步关闭句柄 */
    closeAsync(): Promise<void>;
    /** 异步枚举全部内存区域 */
    regionsAsync(options?: {
        includeFree?: boolean;
        maxAddress?: bigint;
    }): Promise<MemoryRegion[]>;
    /** 异步枚举可扫描区域 */
    scannableRegionsAsync(filter?: RegionFilter): Promise<MemoryRegion[]>;
    /** 异步读取内存 */
    readMemoryAsync(address: bigint, size: number): Promise<Buffer>;
    /** 异步读取内存（不足则抛错） */
    readMemoryExactAsync(address: bigint, size: number): Promise<Buffer>;
    /** 异步写入内存 */
    writeMemoryAsync(address: bigint, data: Buffer, fixProtection?: boolean): Promise<number>;
    /** 异步枚举模块 */
    modulesAsync(): Promise<ProcessModule[]>;
    /** 异步枚举线程 id */
    threadIdsAsync(): Promise<number[]>;
    /** 异步分配内存 */
    allocateAsync(size: number, protect?: number, address?: bigint): Promise<bigint>;
    /** 异步修改内存保护 */
    protectAsync(address: bigint, size: number, newProtect: number): Promise<number>;
    /** 异步判断是否 WOW64 */
    isWow64Async(): Promise<boolean>;
}
/** 打开进程的异步变体（原生 CE 后端下必须用它）。 */
export declare function openProcessAsync(pid: number, options?: OpenProcessOptions): Promise<Process>;
/** 按名字打开进程（异步变体）。 */
export declare function openProcessByNameAsync(name: string, options?: OpenProcessOptions): Promise<Process>;
/** 展示用：区域类型的可读名字 */
export declare function regionTypeName(type: number): string;
/** 默认最大用户态地址（供上层限制扫描范围） */
export declare const MAX_ADDRESS = 140737488355327n;
/** 默认保护属性常量转发 */
export { PAGE_GUARD, MEM_COMMIT, MEM_IMAGE, MEM_MAPPED, MEM_PRIVATE, DEFAULT_PROCESS_ACCESS };
//# sourceMappingURL=process.d.ts.map