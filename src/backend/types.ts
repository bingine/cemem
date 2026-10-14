/**
 * 内存后端抽象 —— 让上层 API 与"用哪个引擎"解耦。
 *
 * 本移植提供三种可切换的调用方式：
 *
 *  1. `SelfBackend`（默认，自研引擎）
 *     直接通过 Win32 API（koffi 绑定）在本进程内读写目标进程内存。
 *     没有外部依赖，兼容性最强，扫描逻辑由本移植的 matcher 实现。
 *
 *  2. `NativeCeBackend`（原生 CE 兼容层）
 *     作为客户端连接 Cheat Engine 官方的 `ceserver`（CE 源码里
 *     `Cheat Engine/ceserver/` 那套服务端程序），走 CE 自己的 TCP 协议。
 *     好处是可以复用原生 CE 的能力（它跑在目标机器上、可能带驱动），
 *     代价是需要一个正在运行的 ceserver。
 *
 *  3. `DbkBackend`（DBK 内核驱动，见 `dbk-backend.ts` 与 docs/backend-dbk.md）
 *     通过 CE 自己的 DBK64 驱动 ioctl 读写，**同步**。
 *     这是读**受保护进程**（PPL/反作弊/以更高权限运行）的唯一途径 ——
 *     用户态连句柄都打不开。
 *     前提：驱动已加载（加载需要管理员权限，插件侧用 `ce_kernel` 工具装）。
 *     能力边界：`changeProtection`/`free` 仍是用户态实现（CE 驱动的
 *     `MAKEWRITABLE` 在 x64 上是空的），对受保护进程会失败；
 *     且其驱动侧结构布局尚未在真机上验证。
 *
 * 上层的扫描会话、地址表、.CT 读写、地址表达式都对三者一视同仁：
 * 它们只依赖本文件定义的 `MemoryBackend` 接口。
 *
 * DBK64 内核驱动接口（`DBK32functions.pas` 里的 `Dbk*` 系列 ioctl）
 * 由 `DbkBackend` 实现（见上文第 3 条），协议细节与已知限制见
 * `docs/backend-dbk.md`。
 */

/**
 * 一个值或它的 Promise。
 *
 * 之所以引入它：内存后端有两种性质完全不同的实现 ——
 *   - `SelfBackend` / `DbkBackend`：**同步**（本进程内调 Win32 API / 发驱动 ioctl），直接返回值；
 *   - `NativeCeBackend`：socket 通信，**本质异步**。
 *
 * 这里**不**试图把异步"伪装"成同步：实测证明 `Atomics.wait` 会卡死所在线程的
 * 事件循环（无论 socket 放在哪个线程都不行，最小复现见 `_probe/mini-repro.js`），
 * 因此同步调用原生 CE 是不可实现的。诚实的设计是让接口允许返回 Promise。
 *
 * 约定：
 *   - 同步后端（`capabilities.sync === true`）**必须**直接返回值，不能返回 Promise；
 *   - 异步后端返回 Promise，调用方需要 `await`；
 *   - 使用 `await` 对两种情况都安全（`await` 一个非 Promise 值原样返回）。
 */
export type MaybePromise<T> = T | Promise<T>;

/** 一个进程的内存句柄（不透明） */
export interface BackendProcessHandle {
  /** 后端内部使用的句柄标识 */
  readonly id: number;
  /** 目标进程 id */
  readonly pid: number;
}

/** 内存区域信息（与 Win32 MEMORY_BASIC_INFORMATION 对齐） */
export interface BackendRegion {
  baseAddress: bigint;
  regionSize: bigint;
  /** MEM_COMMIT / MEM_RESERVE / MEM_FREE */
  state: number;
  /** 保护属性（PAGE_*） */
  protect: number;
  /** MEM_IMAGE / MEM_MAPPED / MEM_PRIVATE */
  type: number;
}

/**
 * 进程信息。
 *
 * ⚠️ `parentPid` / `threadCount` 是 **`number | null`**，`null` 表示
 * 「**该后端不提供这个字段**」，而不是「值是 0」。
 *
 * 为什么必须区分：`ceserver` 的 `PROCESS32NEXT` 响应里**只有 pid 与名字**
 * （见 `native-ce-backend.ts` 的协议说明），曾经把它硬编码成 `0`，
 * 于是 `ce_processes` 在 native-ce 后端下对每个进程都报「线程 0」——
 * 一个**看起来像真值**的假值，而同一个工具在 self 后端下给的是真实线程数。
 * 上层据此做判断就会得出错误结论，且完全看不出是后端不支持。
 */
export interface BackendProcessInfo {
  pid: number;
  name: string;
  /** 父进程 pid；`null` = 本后端不提供（**不是 0**） */
  parentPid: number | null;
  /** 线程数；`null` = 本后端不提供（**不是 0**） */
  threadCount: number | null;
}

/** 模块信息 */
export interface BackendModuleInfo {
  name: string;
  path: string;
  baseAddress: bigint;
  size: number;
}

/** 内存区域过滤条件 */
export interface BackendRegionFilter {
  includeFree?: boolean;
  maxAddress?: bigint;
  writableOnly?: boolean;
  executableOnly?: boolean;
  includeImage?: boolean;
  includeMapped?: boolean;
  includePrivate?: boolean;
  includeGuard?: boolean;
}

/** 后端能力声明，供上层做能力检查与降级 */
export interface BackendCapabilities {
  /**
   * 所有操作是否**同步**完成（直接返回值，而非 Promise）。
   * `true` 的后端必须同步返回；`false` 的后端返回 Promise，调用方需 await。
   */
  sync: boolean;
  /** 能否枚举进程 */
  enumerateProcesses: boolean;
  /** 能否枚举内存区域 */
  queryRegions: boolean;
  /** 能否枚举模块 */
  queryModules: boolean;
  /** 能否枚举线程 */
  queryThreads: boolean;
  /** 能否挂起/恢复线程 */
  suspendThreads: boolean;
  /** 能否在目标内分配内存 */
  allocateMemory: boolean;
  /** 能否修改内存保护属性 */
  changeProtection: boolean;
  /** 是否在目标机器本地运行 */
  local: boolean;
  /** 是否需要外部服务端 */
  requiresServer: boolean;
}

/**
 * 内存后端接口。
 *
 * ## 同步与异步
 * 方法返回 `MaybePromise<T>`：同步后端（`capabilities.sync === true`）直接返回值，
 * 异步后端返回 Promise。调用方一律可以 `await`，对两种后端都正确。
 *
 * ## 约定
 *   - 所有地址用 `bigint`（64 位语义），后端负责按目标进程位数处理；
 *   - 读内存失败（部分或全部）不抛错，返回实际读到的字节（长度可能小于请求）；
 *   - 写内存/分配/改保护失败必须抛错（这些操作静默失败会写坏目标）；
 *   - 句柄用 `BackendProcessHandle` 封装，关闭后所有操作应抛错。
 */
export interface MemoryBackend {
  /** 后端名称，用于日志与错误信息 */
  readonly name: string;

  /** 能力声明 */
  readonly capabilities: BackendCapabilities;

  /** 枚举进程。不支持时抛错（调用前应检查 capabilities） */
  listProcesses(): MaybePromise<BackendProcessInfo[]>;

  /** 打开进程，返回句柄 */
  openProcess(pid: number): MaybePromise<BackendProcessHandle>;

  /** 关闭句柄 */
  closeProcess(handle: BackendProcessHandle): MaybePromise<void>;

  /** 枚举内存区域 */
  queryRegions(
    handle: BackendProcessHandle,
    filter?: BackendRegionFilter,
  ): MaybePromise<BackendRegion[]>;

  /**
   * 读取内存。失败时返回空 Buffer 或比请求更短的 Buffer，不抛错。
   * @param address 起始地址
   * @param size 请求字节数
   */
  readProcessMemory(
    handle: BackendProcessHandle,
    address: bigint,
    size: number,
  ): MaybePromise<Buffer>;

  /**
   * 写入内存。返回实际写入字节数；失败抛错。
   * @param fixProtection 是否在写入前临时放开只读保护（本地后端支持）
   */
  writeProcessMemory(
    handle: BackendProcessHandle,
    address: bigint,
    data: Buffer,
    fixProtection?: boolean,
  ): MaybePromise<number>;

  /** 枚举模块。不支持时抛出明确错误 */
  queryModules(handle: BackendProcessHandle): MaybePromise<BackendModuleInfo[]>;

  /** 枚举线程 id。不支持时抛出明确错误 */
  queryThreads(handle: BackendProcessHandle): MaybePromise<number[]>;

  /** 在目标进程内分配内存，返回地址。不支持时抛出明确错误 */
  allocate(
    handle: BackendProcessHandle,
    size: number,
    protect?: number,
    preferred?: bigint,
  ): MaybePromise<bigint>;

  /** 释放内存 */
  free(handle: BackendProcessHandle, address: bigint): MaybePromise<void>;

  /** 修改内存保护，返回旧保护值 */
  changeProtection(
    handle: BackendProcessHandle,
    address: bigint,
    size: number,
    newProtect: number,
  ): MaybePromise<number>;

  /** 目标是否为 32 位（WOW64）。不确定时返回 false */
  isWow64(handle: BackendProcessHandle): MaybePromise<boolean>;

  /**
   * 目标进程是否**仍然存活**（可选能力）。
   *
   * 为什么必须单独有这么一个方法：Windows 上进程退出后，**句柄依然有效** ——
   * `CloseHandle` 之前 `isOpen` 一直是 true，而 `VirtualQueryEx` / `ReadProcessMemory`
   * 只会返回 0 条区域 / 0 字节。上层若不问一句，就会把"目标已经死了"退化成
   * 「0 个模块 / 0 个区域 / 读不到内存」这类**看起来像正常结果或误导性的报错**。
   *
   * 后端无法判断时应返回 `undefined`（不实现或抛错也可，上层会当作"未知"继续）。
   */
  isProcessAlive?(handle: BackendProcessHandle): MaybePromise<boolean | undefined>;

  /** 释放后端自身资源（不关闭已打开的进程句柄） */
  dispose?(): MaybePromise<void>;
}

/** 后端不支持某能力时抛出的错误 */
export class BackendUnsupportedError extends Error {
  constructor(
    readonly backend: string,
    readonly operation: string,
    detail?: string,
  ) {
    super(
      `后端 "${backend}" 不支持该操作：${operation}` +
        (detail ? `（${detail}）` : ''),
    );
    this.name = 'BackendUnsupportedError';
  }
}
