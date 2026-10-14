/**
 * 扫描 worker —— 在独立线程中读取目标进程内存、执行比较，并把结果写入共享内存。
 *
 * 对应 CE 的 TScanner（TThread 子类）：CE 每条扫描线程负责一段内存，
 * 通过临界区/信号量把结果写回主线程的地址缓冲区。
 * 这里用 SharedArrayBuffer + Atomics 达到同样目的。
 *
 * 共享内存之所以必须共享：扫描 API 是同步的（对齐 CE 的阻塞语义），
 * 主线程用 Atomics.wait 等待，此时无法处理 worker 的 postMessage。
 *
 * 容量约束：V8 对单个 SharedArrayBuffer 有约 1.5GB 上限，
 * 因此每个 worker 批次使用**独立的、容量受控的**共享段，
 * 而不是一个大段。详见 shared-layout.ts 的 createBatchLayout。
 */
import { ScanConfig } from '../types';
/** 单个块的扫描任务 */
export interface ScanJob {
    /** 块的全局下标（用于主线程回收结果） */
    index: number;
    /** 块起始地址（十六进制字符串，避免 BigInt 在结构化克隆中的额外开销） */
    address: string;
    /** 块长度 */
    size: number;
}
/** worker 收到的一次扫描任务 */
export interface WorkerScanRequest {
    type: 'scan';
    /** 目标进程 pid */
    pid: number;
    /** 扫描配置 */
    config: ScanConfig;
    /** 本 worker 负责的块 */
    jobs: ScanJob[];
    /** 是否保留快照 */
    keepSnapshot: boolean;
    /** 本批次的共享内存本体（SAB 经结构化克隆后仍共享同一块内存） */
    shared: SharedArrayBuffer;
    /** 本批次的共享段容量参数 */
    layoutParams: {
        jobCount: number;
        slotCapacity: number;
        arenaCapacity: number;
    };
}
/** worker 发出的消息 */
export interface WorkerScanDone {
    type: 'batchDone';
    /** 本批次发生失败的块数 */
    failed: number;
}
//# sourceMappingURL=scan-worker.d.ts.map