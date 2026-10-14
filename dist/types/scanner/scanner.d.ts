/**
 * 扫描会话 —— 对齐 Cheat Engine `memscan.pas` 的 TMemScan / TScanController。
 *
 * 一次会话的典型生命周期（与 CE 界面操作一一对应）：
 *   const scan = new ScanSession(process);
 *   scan.firstScan(cfg);        // 首次扫描（对应 CE「首次扫描」）
 *   scan.nextScan({ ...cfg, scanOption: ScanOption.DecreasedValue }); // 再次扫描
 *   scan.results                // bigint[] 结果地址
 *
 * 关键状态：
 *   - chunks：本会话实际读过的内存块（地址、长度）—— 对齐 CE 的 MemoryRegions 副本；
 *   - addressMap：块内偏移 → 结果地址 的换算依据；
 *   - snapshot：块原始内存副本 —— 对齐 CE 的 SecondaryAddressBuffer 机制，
 *     next scan 的「旧值」就来自这里。
 *
 * 性能：默认使用 worker 线程并行读取+比较（对齐 CE 的多线程扫描），
 * 实测本机 ReadProcessMemory 约 1.9 GB/s。
 */
import { Process } from '../win/process';
import { ScanConfig, ScanProgressCallback, ScanResult, VariableType } from '../types';
/** 一个已读取的内存块 */
export interface Chunk {
    /** 块在目标进程中的起始地址 */
    address: bigint;
    /** 块长度（字节） */
    size: number;
    /** 首次扫描时保留的原始内存副本（用于 next scan 的旧值比较与未变动检测） */
    snapshot: Buffer | null;
    /** 本块命中的块内偏移 */
    offsets: number[];
    /** 每个命中偏移对应的规则下标（all 模式用） */
    matches: number[][] | null;
}
export interface ScanSessionOptions {
    /** 扫描块大小（字节）。默认 4MB。 */
    blockSize?: number;
    /** 是否用 worker 线程并行扫描，默认 true（块数足够多时才生效） */
    parallel?: boolean;
    /** 并行 worker 数，默认 CPU 逻辑核数（上限 8） */
    workerCount?: number;
    /**
     * 启用并行的最小扫描体量（字节）。默认 96MB。
     * 小于该值时 worker 启动开销大于收益，直接用单线程。
     */
    parallelMinBytes?: number;
    /**
     * 原始内存快照的总字节上限。默认 1.5GB。
     * 超过时不保留快照（结果仍有效，但无法继续 next scan 的「旧值」类比较）。
     */
    maxSnapshotBytes?: number;
    /** 进度回调 */
    onProgress?: ScanProgressCallback;
}
export interface ScanStats {
    /** 扫描的区域数 */
    regionsScanned: number;
    /** 扫描的字节数 */
    bytesScanned: bigint;
    /** 本次扫描耗时（毫秒） */
    elapsedMs: number;
    /** 首次扫描后结果数 */
    resultCount: number;
    /** 是否保留了快照（可继续 next scan） */
    hasSnapshot: boolean;
    /** 实际使用的 worker 数 */
    workersUsed: number;
}
/**
 * 一个进程上的扫描会话。
 *
 * 与 CE 的差异说明：CE 的 TMemScan 与 GUI 强耦合（进度窗口、保存扫描结果文件），
 * 这里保持纯数据/纯流程，进度通过回调暴露。
 */
export declare class ScanSession {
    /** 本会话读过的内存块 */
    readonly chunks: Chunk[];
    private readonly proc;
    private readonly opts;
    private compiled;
    private config;
    private resultAddresses;
    private snapshotBytes;
    private lastStats;
    /** 是否有可比较的旧值（决定 next scan 的可用选项） */
    private hasOldValues;
    /** 是否在下次扫描时忽略对齐（内部用） */
    private truncatedChunks;
    /** 并行路径中由主线程补扫的块数（worker 启动失败时 > 0） */
    private fallbackChunks;
    /** 并行路径被证明不可用时置位，后续扫描退化到单线程 */
    private parallelDisabled;
    /** worker 池（惰性创建，跨扫描复用） */
    private workers;
    private workerReady;
    constructor(process: Process, options?: ScanSessionOptions);
    get process(): Process;
    /** 结果地址列表 */
    get results(): readonly bigint[];
    /** 结果数量 */
    get resultCount(): number;
    /** 上一次扫描的统计信息 */
    get stats(): ScanStats | null;
    /** 是否可以继续 next scan（CE 里显示为「再次扫描」是否可用） */
    get canNextScan(): boolean;
    /** 把扫描区域切成块，尽量与区域边界对齐。 */
    private buildChunks;
    /**
     * 首次扫描。对应 CE 的 TMemScan.firstScan。
     *
     * @param config 扫描配置
     */
    firstScan(config: ScanConfig): ScanStats;
    /**
     * 再次扫描。对应 CE 的 TMemScan.nextScan。
     *
     * 重要语义：nextScan 只在上一次的结果地址范围内重新比较，
     * 因此需要上一次快照提供的「旧值」。若首次扫描时因内存上限未保留快照，
     * 则只支持不需要旧值的选项（精确值/区间/大于/小于）。
     */
    nextScan(config: ScanConfig): ScanStats;
    /** 首次扫描：单线程或 worker 并行。 */
    private runScan;
    /** worker 并行路径：每个 worker 一个独立共享段，Atomics 同步等待。 */
    private runParallel;
    /** 单块扫描（单线程路径）。 */
    private scanChunkSingle;
    /** 单线程扫描循环，带进度回调。 */
    private progressLoop;
    /** next scan：只在存活块的旧偏移上比较。 */
    private runNextScan;
    /**
     * 单点比较。返回命中的规则下标数组（all 模式），未命中返回 null。
     *
     * 实现方式：把该地址周围一小段窗口交给 scanBlock，
     * 因此"命中"等价于 CE 在 SecondaryAddressBuffer 上做的逐点比较。
     */
    private compareSingle;
    /** 把各块的块内偏移汇总成结果地址列表。 */
    private collectResults;
    /** 读取结果地址列表（bigint）。 */
    getResults(): bigint[];
    /** 读取结果地址与当前值。 */
    getResultValues(type: VariableType, max?: number): ScanResult[];
    private widthOfType;
    /** 清空会话状态。 */
    reset(): void;
    /** 释放 worker 资源（不关闭进程句柄）。 */
    dispose(): void;
}
//# sourceMappingURL=scanner.d.ts.map