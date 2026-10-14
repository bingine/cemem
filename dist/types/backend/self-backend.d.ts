/**
 * 自研后端 —— 在本进程内直接通过 Win32 API 操作目标进程。
 *
 * 这是默认后端，也是本移植的"自实现 CE"引擎本体：
 * 对应 Cheat Engine 在**没有内核驱动时**走的那套用户态路径
 * （`NewKernelHandler.pas` 的 `ReadProcessMemory`/`VirtualQueryEx` 分支）。
 *
 * 优点：无外部依赖，开箱即用，兼容性最强。
 * 局限：受 Windows 进程保护约束（受保护进程 / 反作弊 / PPL 进程读不到），
 *       也没有内核驱动那种绕过 ObRegisterCallbacks 的能力 —— 那需要 ring-0，
 *       Node 里不存在实现路径，见 PORT-SCOPE.md。
 */
import { BackendCapabilities, BackendModuleInfo, BackendProcessHandle, BackendProcessInfo, BackendRegion, BackendRegionFilter, BackendUnsupportedError, MemoryBackend } from './types';
/** 判断保护属性是否可读 */
export declare function isReadable(protect: number): boolean;
/** 判断保护属性是否可写 */
export declare function isWritable(protect: number): boolean;
/** 判断保护属性是否可执行 */
export declare function isExecutable(protect: number): boolean;
/** 按过滤条件筛出可扫描区域（与后端无关的纯函数，供两个后端共用） */
export declare function filterScanRegions(regions: BackendRegion[], filter?: BackendRegionFilter): BackendRegion[];
export interface SelfBackendOptions {
    /** 打开进程时请求的访问权限，默认 DEFAULT_PROCESS_ACCESS */
    access?: number;
}
/**
 * 自研后端（默认）。
 *
 * ```ts
 * const backend = new SelfBackend();
 * const h = backend.openProcess(pid);
 * const buf = backend.readProcessMemory(h, addr, 64);
 * ```
 */
export declare class SelfBackend implements MemoryBackend {
    readonly name = "self";
    readonly capabilities: BackendCapabilities;
    private readonly access;
    private nextHandleId;
    private readonly handles;
    private disposed;
    constructor(options?: SelfBackendOptions);
    listProcesses(): BackendProcessInfo[];
    openProcess(pid: number): BackendProcessHandle;
    closeProcess(handle: BackendProcessHandle): void;
    private raw;
    private assertNotDisposed;
    queryRegions(handle: BackendProcessHandle, filter?: BackendRegionFilter): BackendRegion[];
    readProcessMemory(handle: BackendProcessHandle, address: bigint, size: number): Buffer;
    writeProcessMemory(handle: BackendProcessHandle, address: bigint, data: Buffer, fixProtection?: boolean): number;
    queryModules(handle: BackendProcessHandle): BackendModuleInfo[];
    queryThreads(handle: BackendProcessHandle): number[];
    /**
     * 目标进程是否仍然存活。
     *
     * ⚠️ 不能靠 `isOpen` 判断：**进程退出后句柄依然有效**（直到 `CloseHandle`），
     * 于是 `VirtualQueryEx` 返回 0 条区域、`ReadProcessMemory` 返回 0 字节 ——
     * 上层看起来就像"目标还活着，只是什么都没有"。这里用句柄自己的
     * signaled 状态问一句真相（进程对象在进程终止时被置为 signaled）。
     *
     * 拿不到句柄（已被关闭）时返回 false —— 那种情况下调用方本来也不该继续用。
     */
    isProcessAlive(handle: BackendProcessHandle): boolean;
    allocate(handle: BackendProcessHandle, size: number, protect?: number, preferred?: bigint): bigint;
    free(handle: BackendProcessHandle, address: bigint): void;
    changeProtection(handle: BackendProcessHandle, address: bigint, size: number, newProtect: number): number;
    isWow64(handle: BackendProcessHandle): boolean;
    /** 挂起目标进程全部线程，返回可恢复的线程句柄 */
    suspendAllThreads(handle: BackendProcessHandle): bigint[];
    /** 恢复之前挂起的线程并关闭句柄 */
    resumeThreads(handles: bigint[]): void;
    dispose(): void;
}
export { BackendUnsupportedError };
//# sourceMappingURL=self-backend.d.ts.map