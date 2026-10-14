/**
 * 原生 CE 后端 —— 作为客户端连接 Cheat Engine 官方的 `ceserver`。
 *
 * 协议来源：`Cheat Engine/ceserver/ceserver.h`（命令号与结构体定义）+
 *           `ceserver.c` 的 `DispatchCommand` 分支（收发顺序与字段宽度）。
 *
 * 线上格式（全部小端）：每个请求 = 1 字节命令号 + 该命令的输入负载；
 * 每条命令使用一个独立连接。
 *
 * ## 为什么这个后端是异步的
 *
 * 它必须走 socket，而 socket 本质异步。
 * 曾经尝试把它包装成同步接口，两条路都**实测失败**：
 *
 *   1. 主线程里 `Promise + Atomics.wait` → 阻塞把事件循环卡死，
 *      socket 回调永不执行（`_probe/atomics-wait-io.js` 可复现）；
 *   2. 把 socket 挪到 worker 线程、主线程仍 `Atomics.wait` → **同样死锁**，
 *      因为 worker 线程被 `Atomics.wait` 阻塞后，它自己的事件循环也停了，
 *      socket 回调一样不会跑（`_probe/mini-repro.js` 可复现）。
 *
 * 结论：`Atomics.wait` 与 socket I/O 无法在任何同一线程内共存。
 * 因此本后端**诚实地暴露为异步 API**（方法返回 Promise），
 * 而不是用子进程或忙轮询去伪造同步 —— 那只会把复杂度推移到别处。
 *
 * ## 与 SelfBackend 的一致性
 *
 * 方法名、参数、返回类型语义与 `SelfBackend` 完全一致，区别只有一个 `await`：
 * ```ts
 * const buf = proc.readMemory(addr, 16);                 // 自研后端：同步
 * const buf = await proc.readMemoryAsync(addr, 16);      // 原生 CE：异步
 * ```
 * （`Process` 上的 `*Async` 变体对两种后端都可用。）
 *
 * ## 已对齐的命令
 *   GETVERSION(0)、GETARCHITECTURE(21)、OPENPROCESS(3)、CLOSEHANDLE(7)、
 *   CREATETOOLHELP32SNAPSHOT(4)、PROCESS32FIRST(5)、PROCESS32NEXT(6)、
 *   VIRTUALQUERYEX(8)、READPROCESSMEMORY(9)、WRITEPROCESSMEMORY(10)、
 *   MODULE32FIRST(22)、MODULE32NEXT(23)、ALLOC(26)、FREE(27)、
 *   CHANGEMEMORYPROTECTION(36)
 *
 * ## 未实现（调用会抛错，不假装支持）
 *   线程枚举（CMD_CREATETOOLHELP32SNAPSHOTEX 响应布局随版本变化）、
 *   调试器相关命令、速度修改、管道、符号文件加载。
 */
import { BackendCapabilities, BackendModuleInfo, BackendProcessHandle, BackendProcessInfo, BackendRegion, BackendRegionFilter, MemoryBackend } from './types';
export declare const CESERVER_CMD: {
    readonly GETVERSION: 0;
    readonly CLOSECONNECTION: 1;
    readonly TERMINATESERVER: 2;
    readonly OPENPROCESS: 3;
    readonly CREATETOOLHELP32SNAPSHOT: 4;
    readonly PROCESS32FIRST: 5;
    readonly PROCESS32NEXT: 6;
    readonly CLOSEHANDLE: 7;
    readonly VIRTUALQUERYEX: 8;
    readonly READPROCESSMEMORY: 9;
    readonly WRITEPROCESSMEMORY: 10;
    readonly STARTDEBUG: 11;
    readonly STOPDEBUG: 12;
    readonly WAITFORDEBUGEVENT: 13;
    readonly CONTINUEFROMDEBUGEVENT: 14;
    readonly SETBREAKPOINT: 15;
    readonly REMOVEBREAKPOINT: 16;
    readonly SUSPENDTHREAD: 17;
    readonly RESUMETHREAD: 18;
    readonly GETTHREADCONTEXT: 19;
    readonly SETTHREADCONTEXT: 20;
    readonly GETARCHITECTURE: 21;
    readonly MODULE32FIRST: 22;
    readonly MODULE32NEXT: 23;
    readonly GETSYMBOLLISTFROMFILE: 24;
    readonly LOADEXTENSION: 25;
    readonly ALLOC: 26;
    readonly FREE: 27;
    readonly CREATETHREAD: 28;
    readonly LOADMODULE: 29;
    readonly SPEEDHACK_SETSPEED: 30;
    readonly VIRTUALQUERYEXFULL: 31;
    readonly GETREGIONINFO: 32;
    readonly GETABI: 33;
    readonly SET_CONNECTION_NAME: 34;
    readonly CREATETOOLHELP32SNAPSHOTEX: 35;
    readonly CHANGEMEMORYPROTECTION: 36;
    readonly GETOPTIONS: 37;
    readonly GETOPTIONVALUE: 38;
    readonly SETOPTIONVALUE: 39;
    readonly PTRACE_MMAP: 40;
    readonly OPENNAMEDPIPE: 41;
    readonly PIPEREAD: 42;
    readonly PIPEWRITE: 43;
    readonly GETCESERVERPATH: 44;
    readonly ISANDROID: 45;
    readonly LOADMODULEEX: 46;
    readonly SETCURRENTPATH: 47;
    readonly GETCURRENTPATH: 48;
    readonly ENUMFILES: 49;
    readonly GETFILEPERMISSIONS: 50;
    readonly SETFILEPERMISSIONS: 51;
    readonly GETFILE: 52;
    readonly PUTFILE: 53;
    readonly CREATEDIR: 54;
    readonly DELETEFILE: 55;
    readonly AOBSCAN: 200;
    readonly COMMANDLIST2: 255;
};
/** CE 官方 ceserver 的默认端口（ceserver.c 的 PORT 默认值） */
export declare const CESERVER_DEFAULT_PORT = 52736;
/** 累积式小端写入器 */
export declare class CeWriter {
    private parts;
    u8(v: number): this;
    i32(v: number): this;
    u32(v: number): this;
    i64(v: bigint): this;
    u64(v: bigint): this;
    bytes(b: Buffer): this;
    build(): Buffer;
}
/** 顺序小端读取器 */
export declare class CeReader {
    private readonly buf;
    private pos;
    constructor(buf: Buffer);
    get remaining(): number;
    u8(): number;
    i32(): number;
    u32(): number;
    i64(): bigint;
    u64(): bigint;
    bytes(n: number): Buffer;
    skip(n: number): void;
}
export interface NativeCeBackendOptions {
    /** ceserver 主机，默认 127.0.0.1 */
    host?: string;
    /** ceserver 端口，默认 52736 */
    port?: number;
    /** 单次命令超时（毫秒），默认 15000 */
    timeoutMs?: number;
}
/**
 * 原生 CE 后端（通过 ceserver 的 TCP 协议）。
 *
 * 所有方法都是**异步**的（返回 Promise），因为 socket 本质异步 —— 原因见文件头注释。
 *
 * ```ts
 * const backend = new NativeCeBackend({ host: '127.0.0.1', port: 52736 });
 * const h = await backend.openProcess(pid);
 * const buf = await backend.readProcessMemory(h, addr, 64);
 * await backend.dispose();
 * ```
 */
export declare class NativeCeBackend implements MemoryBackend {
    readonly name = "native-ce";
    readonly capabilities: BackendCapabilities;
    readonly host: string;
    readonly port: number;
    readonly timeoutMs: number;
    private readonly conn;
    private disposed;
    /** handle id -> ceserver 侧 HANDLE */
    private nextHandleId;
    private readonly handles;
    private version;
    constructor(options?: NativeCeBackendOptions);
    /** 后端描述，用于日志 */
    describe(): string;
    /**
     * 读取 ceserver 版本字符串（CMD_GETVERSION，结果缓存）。
     *
     * 响应布局：`{ int32 version; uint8 stringsize; char versionstring[stringsize]; }`
     * 分两轮读（先读 5 字节头拿长度，再读全）—— 因为 ceserver 每条命令一个连接，
     * 无法在一条连接上续读。
     */
    getVersion(): Promise<string>;
    listProcesses(): Promise<BackendProcessInfo[]>;
    openProcess(pid: number): Promise<BackendProcessHandle>;
    closeProcess(handle: BackendProcessHandle): Promise<void>;
    private closeServerHandle;
    private serverHandle;
    queryRegions(handle: BackendProcessHandle, filter?: BackendRegionFilter): Promise<BackendRegion[]>;
    readProcessMemory(handle: BackendProcessHandle, address: bigint, size: number): Promise<Buffer>;
    writeProcessMemory(handle: BackendProcessHandle, address: bigint, data: Buffer, fixProtection?: boolean): Promise<number>;
    queryModules(handle: BackendProcessHandle): Promise<BackendModuleInfo[]>;
    allocate(handle: BackendProcessHandle, size: number, protect?: number, preferred?: bigint): Promise<bigint>;
    free(handle: BackendProcessHandle, address: bigint): Promise<void>;
    changeProtection(handle: BackendProcessHandle, address: bigint, size: number, newProtect: number): Promise<number>;
    queryThreads(): number[];
    isWow64(): boolean;
    /**
     * 存活判断：ceserver 协议里没有对应命令，这里**如实返回 undefined（未知）**，
     * 而不是猜一个 true/false —— 上层据此退回「句柄仍打开就当附加着」的旧行为。
     */
    isProcessAlive(): boolean | undefined;
    /** 发送一帧、读回 expectedBytes 字节 */
    private exchange;
    /** 释放后端资源 */
    dispose(): Promise<void>;
}
/**
 * ceserver 的 TCP 通道。
 *
 * 每条命令使用一个独立连接：服务端 `DispatchCommand` 处理完一条命令即关闭，
 * 而且"每条命令一个连接"能让"先读计数、再读数据"这类两步读取天然成立
 * （两边各自重新发一次命令即可）。
 */
export declare class CeServerConnection {
    readonly host: string;
    readonly port: number;
    readonly timeoutMs: number;
    constructor(host: string, port: number, timeoutMs?: number);
    /** 发送一帧并读回 expectedBytes 字节 */
    exchange(label: string, frame: Buffer, expectedBytes: number): Promise<Buffer>;
    private connect;
    private write;
    private readExactly;
}
//# sourceMappingURL=native-ce-backend.d.ts.map