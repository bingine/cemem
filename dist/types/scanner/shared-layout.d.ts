/**
 * 并行扫描的共享内存布局。
 *
 * 为什么需要共享内存：扫描 API 是同步的（对齐 CE 的 firstScan/nextScan 阻塞语义），
 * 而 Node 主线程在同步函数里无法 await worker 的 postMessage。
 * 因此主线程把结果区/快照区放在 SharedArrayBuffer 里，用 Atomics.wait 阻塞等待。
 *
 * 容量约束（重要）：
 *   V8 对单个 SharedArrayBuffer 约 1.5GB 上限（实测 1610612736 字节即抛
 *   RangeError）。因此**每个 worker 批次一个独立的、容量受控的共享段**，
 *   而不是"N 块 × 4MB"组成的单个大段。
 *
 * 布局（按 8 字节对齐）：
 *   [0] control：Int32Array(CONTROL_INTS)
 *        [0] 待处理块数   [1] 已完成块数   [2] 失败块数   [3] 快照区水位
 *   [1] slots：每块一个槽（2 个头 + slotCapacity 个偏移）
 *        slots[i*SLOT_STRIDE + 0] = 命中数
 *        slots[i*SLOT_STRIDE + 1] = 是否截断
 *        slots[i*SLOT_STRIDE + 2 ..] = 命中偏移
 *   [2] markers：每块 4 字节；-1 表示未保留快照，否则为 arena 内偏移
 *   [3] handled：每块 4 字节；1 表示该块已被 worker 处理（用于检测 worker 启动失败）
 *   [4] arena：快照数据区
 */
/** 默认每块结果槽可容纳的偏移数（64KB / 4B） */
export declare const DEFAULT_SLOT_CAPACITY: number;
/** control 区 Int32 数量 */
export declare const CONTROL_INTS = 8;
export declare const CTRL_PENDING = 0;
export declare const CTRL_DONE = 1;
export declare const CTRL_FAILED = 2;
export declare const CTRL_ARENA_USED = 3;
/** V8 对 SharedArrayBuffer 的实际上限（留出安全余量） */
export declare const SAB_MAX_BYTES = 1000000000;
export interface SharedLayout {
    /** 共享内存本体 */
    buffer: SharedArrayBuffer;
    /** 结果槽区 */
    slots: Int32Array;
    /** 快照标记区 */
    markers: Int32Array;
    /** 块处理标记区 */
    handled: Int32Array;
    /** 快照数据区 */
    arena: Uint8Array;
    /** 控制区 */
    control: Int32Array;
    /** 每块的槽跨度（Int32 个数） */
    slotStride: number;
    slotCapacity: number;
    jobCount: number;
    arenaCapacity: number;
}
/**
 * 构建一个批次用的共享布局。
 *
 * @param jobCount      本批次的块数
 * @param slotCapacity  每块的偏移容量
 * @param arenaCapacity 快照区容量（字节）
 * @param existing      已存在的共享内存（worker 侧重建视图时传入）；
 *                      省略则新建一块。
 */
export declare function createBatchLayout(jobCount: number, slotCapacity: number, arenaCapacity: number, existing?: SharedArrayBuffer): SharedLayout;
/** 重置共享区状态。 */
export declare function resetShared(layout: SharedLayout): void;
/** worker 侧：写入某块的命中偏移列表。 */
export declare function writeSlot(layout: SharedLayout, index: number, offsets: number[]): void;
/** 主线程侧：读取某块的命中偏移。 */
export declare function readSlot(layout: SharedLayout, index: number): {
    offsets: number[];
    truncated: boolean;
};
/**
 * worker 侧：在快照竞技场中为某块抢占空间并写入。
 * 空间不足时放弃保留（next scan 会退化为"无旧值可用"）。
 */
export declare function writeSnapshot(layout: SharedLayout, index: number, data: Buffer): boolean;
/** 主线程侧：读取某块的快照。 */
export declare function readSnapshot(layout: SharedLayout, index: number, size: number): Buffer | null;
/** worker 侧：标记本块已完成。 */
export declare function markDone(layout: SharedLayout, failed: boolean): void;
/** worker 侧：标记本块已被处理（无论成功与否）。 */
export declare function markHandled(layout: SharedLayout, index: number): void;
/** 主线程侧：同步等待本批次所有块完成。 */
export declare function waitAll(layout: SharedLayout, timeoutMs?: number): boolean;
export interface WorkerRequestLayout {
    buffer: SharedArrayBuffer;
    ctrl: Int32Array;
    data: Uint8Array;
    capacity: number;
}
export type WorkerReplyLayout = WorkerRequestLayout;
/** 创建请求/响应区（主线程侧） */
export declare function createWorkerRequestLayout(ctrlInts: number, capacity: number): WorkerRequestLayout;
/** 创建响应区（主线程侧）。与请求区布局相同，单独成函数便于两端语义对称。 */
export declare function createWorkerReplyLayout(ctrlInts: number, capacity: number): WorkerReplyLayout;
//# sourceMappingURL=shared-layout.d.ts.map