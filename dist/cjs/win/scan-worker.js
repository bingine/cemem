"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const node_worker_threads_1 = require("node:worker_threads");
const process_1 = require("./process");
const matcher_1 = require("../scanner/matcher");
const shared_layout_1 = require("../scanner/shared-layout");
let proc = null;
let currentPid = -1;
function ensureProcess(pid) {
    if (proc && currentPid === pid && proc.isOpen)
        return proc;
    proc?.close();
    proc = process_1.Process.open(pid);
    currentPid = pid;
    return proc;
}
const port = node_worker_threads_1.parentPort;
if (!port) {
    throw new Error('scan-worker 必须在 worker_threads 中运行');
}
port.on('message', (msg) => {
    if (msg.type !== 'scan')
        return;
    const layout = (0, shared_layout_1.createBatchLayout)(msg.layoutParams.jobCount, msg.layoutParams.slotCapacity, msg.layoutParams.arenaCapacity, msg.shared);
    let p = null;
    let failed = 0;
    try {
        p = ensureProcess(msg.pid);
    }
    catch {
        p = null;
    }
    const cc = (0, matcher_1.compileConfig)(msg.config);
    for (let i = 0; i < msg.jobs.length; i++) {
        const job = msg.jobs[i];
        if (!p) {
            (0, shared_layout_1.writeSlot)(layout, i, []);
            (0, shared_layout_1.markHandled)(layout, i);
            (0, shared_layout_1.markDone)(layout, true);
            failed++;
            continue;
        }
        try {
            const buf = p.readMemory(BigInt(job.address), job.size);
            if (buf.length === 0) {
                (0, shared_layout_1.writeSlot)(layout, i, []);
                (0, shared_layout_1.markHandled)(layout, i);
                (0, shared_layout_1.markDone)(layout, false);
                continue;
            }
            const offsets = [];
            (0, matcher_1.scanBlock)(cc, buf, null, offsets, undefined);
            (0, shared_layout_1.writeSlot)(layout, i, offsets);
            if (msg.keepSnapshot && offsets.length > 0) {
                (0, shared_layout_1.writeSnapshot)(layout, i, buf);
            }
            (0, shared_layout_1.markHandled)(layout, i);
            (0, shared_layout_1.markDone)(layout, false);
        }
        catch {
            (0, shared_layout_1.writeSlot)(layout, i, []);
            (0, shared_layout_1.markHandled)(layout, i);
            (0, shared_layout_1.markDone)(layout, true);
            failed++;
        }
    }
    port.postMessage({ type: 'batchDone', failed });
});
port.postMessage({ type: 'ready' });
//# sourceMappingURL=scan-worker.js.map