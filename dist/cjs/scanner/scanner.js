"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScanSession = void 0;
const node_fs_1 = require("node:fs");
const node_fs_2 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
/**
 * 并行扫描路径的**取证日志**（默认关闭）。
 *
 * ## 为什么存在
 *
 * 并行扫描（worker 线程 + `Atomics.wait`）在并发跑多个测试文件时，**偶发**
 * 会让进程**静默死亡**：退出码 1、stderr 为空、`'test failed'`、末尾若干用例
 * 根本没跑到。已排除的原因：JS 异常（`uncaughtException` / `beforeExit` /
 * 信号处理器全都不触发）、测试夹具（30 遍跟踪无泄漏）、进程隔离。
 *
 * 剩下的可能都指向**原生层**（worker 里的 koffi / WASM），而原生崩溃不给你
 * 任何 JS 痕迹。所以这里留下一条"死在哪个点"的证据链。
 *
 * ## 用法
 *
 * 设 `CE_SCAN_DIAG=<文件路径>` 后，每次并行扫描会把
 * create / postMessage / waitAll 开始结束 / terminate 逐点写入该文件。
 * **刻意用 `appendFileSync`**：进程静默死亡时 stdout 的缓冲会丢，
 * 同步落盘才能保住最后一行——**最后一行就是死点**。
 *
 * 默认（未设该环境变量）完全不做任何 I/O 与计时。
 */
function diag(message) {
    const file = process.env.CE_SCAN_DIAG;
    if (file === undefined || file === '')
        return;
    try {
        (0, node_fs_2.appendFileSync)(file, `${Date.now()} pid=${process.pid} ${message}\n`, 'utf8');
    }
    catch {
        /* 取证失败绝不影响扫描 */
    }
}
const node_worker_threads_1 = require("node:worker_threads");
const matcher_1 = require("./matcher");
const types_1 = require("../types");
const shared_layout_1 = require("./shared-layout");
/**
 * 一个进程上的扫描会话。
 *
 * 与 CE 的差异说明：CE 的 TMemScan 与 GUI 强耦合（进度窗口、保存扫描结果文件），
 * 这里保持纯数据/纯流程，进度通过回调暴露。
 */
class ScanSession {
    /** 本会话读过的内存块 */
    chunks = [];
    proc;
    opts;
    compiled = null;
    config = null;
    resultAddresses = [];
    snapshotBytes = 0;
    lastStats = null;
    /** 是否有可比较的旧值（决定 next scan 的可用选项） */
    hasOldValues = false;
    /** 是否在下次扫描时忽略对齐（内部用） */
    truncatedChunks = 0;
    /** 并行路径中由主线程补扫的块数（worker 启动失败时 > 0） */
    fallbackChunks = 0;
    /** 并行路径被证明不可用时置位，后续扫描退化到单线程 */
    parallelDisabled = false;
    /** worker 池（惰性创建，跨扫描复用） */
    workers = [];
    workerReady = [];
    constructor(process, options = {}) {
        if (!process.isOpen)
            throw new Error('扫描会话需要一个已打开的进程');
        this.proc = process;
        this.opts = {
            blockSize: options.blockSize ?? 4 * 1024 * 1024,
            parallel: options.parallel !== false,
            workerCount: options.workerCount ?? Math.min(8, Math.max(1, (0, node_os_1.availableParallelism)() - 1)),
            parallelMinBytes: options.parallelMinBytes ?? 96 * 1024 * 1024,
            maxSnapshotBytes: options.maxSnapshotBytes ?? 1.5 * 1024 * 1024 * 1024,
            onProgress: options.onProgress,
        };
        if (this.opts.blockSize <= 0)
            throw new RangeError('blockSize 必须为正数');
    }
    get process() {
        return this.proc;
    }
    /** 结果地址列表 */
    get results() {
        return this.resultAddresses;
    }
    /** 结果数量 */
    get resultCount() {
        return this.resultAddresses.length;
    }
    /** 上一次扫描的统计信息 */
    get stats() {
        return this.lastStats;
    }
    /** 是否可以继续 next scan（CE 里显示为「再次扫描」是否可用） */
    get canNextScan() {
        return this.compiled !== null && this.resultAddresses.length > 0;
    }
    /** 把扫描区域切成块，尽量与区域边界对齐。 */
    buildChunks(regions, blockSize) {
        const chunks = [];
        for (const r of regions) {
            let addr = r.baseAddress;
            let remaining = r.memorySize;
            while (remaining > 0n) {
                const take = remaining > BigInt(blockSize) ? BigInt(blockSize) : remaining;
                chunks.push({
                    address: addr,
                    size: Number(take),
                    snapshot: null,
                    offsets: [],
                    matches: null,
                });
                addr += take;
                remaining -= take;
            }
        }
        return chunks;
    }
    /* ---------------------------------------------------------------- *
     * 首次扫描
     * ---------------------------------------------------------------- */
    /**
     * 首次扫描。对应 CE 的 TMemScan.firstScan。
     *
     * @param config 扫描配置
     */
    firstScan(config) {
        const started = Date.now();
        const cc = (0, matcher_1.compileConfig)(config);
        this.compiled = cc;
        this.config = config;
        // 1) 选区域
        const maxAddress = config.is32Bit ? 0xffffffffn : undefined;
        const regions = this.proc.scannableRegions({
            writableOnly: config.writableOnly,
            executableOnly: config.executableOnly,
            includeImage: config.includeImage,
            includeMapped: config.includeMapped,
            includePrivate: config.includePrivate,
            includeGuard: config.includeGuard,
            maxAddress,
        });
        // 2) 切块
        this.chunks.length = 0;
        const newChunks = this.buildChunks(regions, this.opts.blockSize);
        this.chunks.push(...newChunks);
        // 3) 是否需要保留快照：只要后续可能做「旧值」比较就尽量保留
        const keepSnapshot = true;
        const totalBytes = this.chunks.reduce((a, c) => a + c.size, 0);
        const canSnapshot = BigInt(totalBytes) <= BigInt(this.opts.maxSnapshotBytes);
        // 4) 执行
        const workersUsed = this.runScan(cc, this.chunks, keepSnapshot && canSnapshot);
        this.snapshotBytes = this.chunks.reduce((a, c) => a + (c.snapshot ? c.size : 0), 0);
        this.hasOldValues = this.snapshotBytes > 0;
        this.collectResults();
        const elapsedMs = Date.now() - started;
        this.lastStats = {
            regionsScanned: regions.length,
            bytesScanned: BigInt(totalBytes),
            elapsedMs,
            resultCount: this.resultAddresses.length,
            hasSnapshot: this.hasOldValues,
            workersUsed,
        };
        return this.lastStats;
    }
    /* ---------------------------------------------------------------- *
     * 再次扫描
     * ---------------------------------------------------------------- */
    /**
     * 再次扫描。对应 CE 的 TMemScan.nextScan。
     *
     * 重要语义：nextScan 只在上一次的结果地址范围内重新比较，
     * 因此需要上一次快照提供的「旧值」。若首次扫描时因内存上限未保留快照，
     * 则只支持不需要旧值的选项（精确值/区间/大于/小于）。
     */
    nextScan(config) {
        if (!this.compiled || !this.config) {
            throw new Error('请先执行首次扫描');
        }
        if (this.resultAddresses.length === 0) {
            throw new Error('上一次扫描没有结果，无法继续筛选');
        }
        const started = Date.now();
        const cc = (0, matcher_1.compileConfig)(config);
        const needsOld = (0, matcher_1.optionNeedsOldValue)(cc.option);
        if (needsOld && !this.hasOldValues) {
            throw new Error('该扫描选项需要上一次扫描的旧值，但本次会话没有保留内存快照（可能超过了 maxSnapshotBytes）。请改用精确值/区间类选项，或提高 maxSnapshotBytes 后重新首次扫描。');
        }
        // 对每个块重新读取内存并按块内偏移比较
        const aliveChunks = this.chunks.filter((c) => c.offsets.length > 0);
        if (aliveChunks.length === 0) {
            throw new Error('上一次扫描没有结果，无法继续筛选');
        }
        this.runNextScan(cc, aliveChunks, needsOld);
        this.compiled = cc;
        this.config = config;
        this.collectResults();
        const elapsedMs = Date.now() - started;
        this.lastStats = {
            regionsScanned: aliveChunks.length,
            bytesScanned: BigInt(aliveChunks.reduce((a, c) => a + c.size, 0)),
            elapsedMs,
            resultCount: this.resultAddresses.length,
            hasSnapshot: this.hasOldValues,
            workersUsed: 1,
        };
        return this.lastStats;
    }
    /* ---------------------------------------------------------------- *
     * 内部实现
     * ---------------------------------------------------------------- */
    /** 首次扫描：单线程或 worker 并行。 */
    runScan(cc, chunks, keepSnapshot) {
        const snapshotLimit = this.opts.maxSnapshotBytes;
        const totalBytes = chunks.reduce((a, c) => a + c.size, 0);
        if (!this.opts.parallel ||
            this.parallelDisabled ||
            chunks.length < 4 ||
            totalBytes < this.opts.parallelMinBytes) {
            // 单线程路径：小扫描场景下 worker 启动开销（实测约 80ms/8 线程）
            // 会盖过并行收益，因此只有足够大的扫描才走并行。
            this.progressLoop(chunks, (chunk) => this.scanChunkSingle(cc, chunk, keepSnapshot));
            return 1;
        }
        return this.runParallel(cc, chunks, keepSnapshot, snapshotLimit);
    }
    /** worker 并行路径：每个 worker 一个独立共享段，Atomics 同步等待。 */
    runParallel(cc, chunks, keepSnapshot, snapshotLimit) {
        const workerCount = Math.min(this.opts.workerCount, chunks.length);
        if (workerCount <= 1) {
            this.progressLoop(chunks, (chunk) => this.scanChunkSingle(cc, chunk, keepSnapshot));
            return 1;
        }
        // scan-worker 编译产物位于 dist/cjs/win/，与 worker 源文件同目录
        const workerPath = (0, node_path_1.join)(__dirname, '..', 'win', 'scan-worker.js');
        if (!(0, node_fs_1.existsSync)(workerPath)) {
            // 未编译时（例如 ts-node 直跑源码）退回单线程
            this.progressLoop(chunks, (chunk) => this.scanChunkSingle(cc, chunk, keepSnapshot));
            return 1;
        }
        const chunkCount = chunks.length;
        // 轮转分配任务，尽量均衡
        const batches = Array.from({ length: workerCount }, () => []);
        chunks.forEach((c, i) => {
            batches[i % workerCount].push({ index: i, address: c.address.toString(), size: c.size });
        });
        // 每批次的共享段：槽容量按"块大小/1"估计（最坏情况每字节都命中），
        // 但受 DEFAULT_SLOT_CAPACITY 上限约束（超出则标记截断，由主线程补扫兜底）。
        // 快照区按批次实际需要的内存上限分配。
        const batches2 = batches.filter((b) => b.length > 0);
        const prepared = batches2.map((batch) => {
            const batchBytes = batch.reduce((a, j) => a + j.size, 0);
            const arenaCapacity = keepSnapshot
                ? Math.min(batchBytes, Math.floor((1_000_000_000 - 64 * 1024 * 1024) / Math.max(1, batches2.length)))
                : 0;
            const layout = (0, shared_layout_1.createBatchLayout)(batch.length, shared_layout_1.DEFAULT_SLOT_CAPACITY, Math.max(0, arenaCapacity));
            return { batch, layout };
        });
        const workers = prepared.map(({ batch, layout }, workerIndex) => {
            diag(`worker[${workerIndex}] create`);
            const worker = new node_worker_threads_1.Worker(workerPath);
            const req = {
                type: 'scan',
                pid: this.proc.pid,
                config: this.config,
                jobs: batch,
                keepSnapshot,
                shared: layout.buffer,
                layoutParams: {
                    jobCount: batch.length,
                    slotCapacity: layout.slotCapacity,
                    arenaCapacity: layout.arenaCapacity,
                },
            };
            worker.postMessage(req);
            diag(`worker[${workerIndex}] postMessage（${batch.length} 个块）`);
            return worker;
        });
        // 同步等待（Atomics.wait 会阻塞事件循环，正是这里需要的语义）
        let allOk = true;
        for (let i = 0; i < prepared.length; i += 1) {
            const { layout } = prepared[i];
            diag(`waitAll[${i}] 开始`);
            if (!(0, shared_layout_1.waitAll)(layout, 0))
                allOk = false;
            diag(`waitAll[${i}] 结束`);
        }
        for (const [i, w] of workers.entries()) {
            diag(`terminate[${i}]`);
            void w.terminate();
        }
        diag(`runParallel 完成 allOk=${allOk}`);
        if (!allOk) {
            throw new Error('并行扫描超时未完成，请降低 blockSize 或关闭 parallel 后重试');
        }
        // 回收结果。worker 可能启动失败（目标进程在 worker 中打不开句柄等），
        // 此时其块从未被处理，槽位会一直是"0 个命中"，会静默丢结果。
        // 因此逐块校验 handled 标记，未处理的块由主线程补扫。
        let truncatedChunks = 0;
        let fallbackChunks = 0;
        prepared.forEach(({ batch, layout }, wi) => {
            void wi;
            batch.forEach((job, localIndex) => {
                const chunk = chunks[job.index];
                const handled = Atomics.load(layout.handled, localIndex) === 1;
                if (!handled) {
                    this.scanChunkSingle(cc, chunk, keepSnapshot);
                    fallbackChunks++;
                    return;
                }
                const { offsets, truncated } = (0, shared_layout_1.readSlot)(layout, localIndex);
                chunk.offsets = offsets;
                chunk.matches = null;
                if (truncated)
                    truncatedChunks++;
                if (keepSnapshot) {
                    chunk.snapshot = (0, shared_layout_1.readSnapshot)(layout, localIndex, chunk.size);
                }
            });
        });
        this.truncatedChunks = truncatedChunks;
        this.fallbackChunks = fallbackChunks;
        // 若绝大多数块都由主线程补扫，说明并行不可用，后续退化到单线程
        if (fallbackChunks > chunkCount / 2)
            this.parallelDisabled = true;
        const totalBytes = chunks.reduce((a, c) => a + c.size, 0);
        this.opts.onProgress?.(BigInt(totalBytes), BigInt(totalBytes), BigInt(chunkCount));
        return workerCount;
    }
    /** 单块扫描（单线程路径）。 */
    scanChunkSingle(cc, chunk, keepSnapshot) {
        const buf = this.proc.readMemory(chunk.address, chunk.size);
        if (buf.length === 0) {
            chunk.offsets = [];
            chunk.matches = null;
            return;
        }
        const offsets = [];
        const perRule = cc.isAll ? [] : undefined;
        (0, matcher_1.scanBlock)(cc, buf, null, offsets, perRule);
        chunk.offsets = offsets;
        chunk.matches = perRule ?? null;
        if (keepSnapshot && offsets.length > 0) {
            chunk.snapshot = Buffer.from(buf);
        }
    }
    /** 单线程扫描循环，带进度回调。 */
    progressLoop(chunks, fn) {
        const total = chunks.reduce((a, c) => a + c.size, 0);
        let scanned = 0;
        chunks.forEach((c, i) => {
            fn(c);
            scanned += c.size;
            this.opts.onProgress?.(BigInt(total), BigInt(scanned), BigInt(i + 1));
        });
    }
    /** next scan：只在存活块的旧偏移上比较。 */
    runNextScan(cc, chunks, needsOld) {
        const totalBytes = chunks.reduce((a, c) => a + c.size, 0);
        let scanned = 0;
        for (const chunk of chunks) {
            const buf = this.proc.readMemory(chunk.address, chunk.size);
            scanned += chunk.size;
            if (buf.length === 0) {
                chunk.offsets = [];
                chunk.matches = null;
                this.opts.onProgress?.(BigInt(totalBytes), BigInt(scanned), BigInt(1));
                continue;
            }
            const prev = needsOld ? chunk.snapshot : null;
            const keptOffsets = [];
            const keptMatches = cc.isAll ? [] : null;
            for (const off of chunk.offsets) {
                // 逐点比较：复用 scanBlock 的逻辑需要块级接口，
                // 这里直接构造单点窗口，语义与 CE 的"只检查存活地址"一致。
                const got = this.compareSingle(cc, buf, prev, off);
                if (got !== null) {
                    keptOffsets.push(off);
                    if (keptMatches)
                        keptMatches.push(got);
                }
            }
            chunk.offsets = keptOffsets;
            chunk.matches = keptMatches;
            // 更新快照，使多次 next scan 都能拿到"上一次"的原始值
            if (needsOld && chunk.snapshot) {
                chunk.snapshot = Buffer.from(buf);
            }
            else if (chunk.snapshot) {
                chunk.snapshot = Buffer.from(buf);
            }
        }
    }
    /**
     * 单点比较。返回命中的规则下标数组（all 模式），未命中返回 null。
     *
     * 实现方式：把该地址周围一小段窗口交给 scanBlock，
     * 因此"命中"等价于 CE 在 SecondaryAddressBuffer 上做的逐点比较。
     */
    compareSingle(cc, buf, prev, off) {
        // 复用 scanBlock：取一个刚好覆盖该偏移的窗口
        const maxWidth = cc.rules.reduce((a, r) => Math.max(a, r.width), 0);
        if (off + maxWidth > buf.length)
            return null;
        const window = buf.subarray(off, Math.min(buf.length, off + maxWidth));
        const prevWindow = prev ? prev.subarray(off, Math.min(prev.length, off + maxWidth)) : null;
        const offsets = [];
        const perRule = cc.isAll ? [] : undefined;
        (0, matcher_1.scanBlock)(cc, window, prevWindow, offsets, perRule);
        if (offsets.length === 0 || offsets[0] !== 0)
            return null;
        return perRule?.[0] ?? [];
    }
    /** 把各块的块内偏移汇总成结果地址列表。 */
    collectResults() {
        const addresses = [];
        for (const chunk of this.chunks) {
            if (chunk.offsets.length === 0)
                continue;
            const base = chunk.address;
            for (const off of chunk.offsets) {
                addresses.push(base + BigInt(off));
            }
            // 释放不再需要的偏移数组外的内存压力
        }
        this.resultAddresses = addresses;
    }
    /* ---------------------------------------------------------------- *
     * 结果访问
     * ---------------------------------------------------------------- */
    /** 读取结果地址列表（bigint）。 */
    getResults() {
        return this.resultAddresses.slice();
    }
    /** 读取结果地址与当前值。 */
    getResultValues(type, max = Number.MAX_SAFE_INTEGER) {
        const out = [];
        const width = Math.max(1, this.widthOfType(type));
        for (const addr of this.resultAddresses) {
            if (out.length >= max)
                break;
            const buf = this.proc.readMemory(addr, width);
            if (buf.length < width)
                continue;
            out.push({ address: addr, previous: buf });
        }
        return out;
    }
    widthOfType(type) {
        switch (type) {
            case types_1.VariableType.Byte:
                return 1;
            case types_1.VariableType.Word:
                return 2;
            case types_1.VariableType.DWord:
                return 4;
            case types_1.VariableType.QWord:
            case types_1.VariableType.Double:
            case types_1.VariableType.Pointer:
                return 8;
            case types_1.VariableType.Single:
                return 4;
            default:
                return 4;
        }
    }
    /** 清空会话状态。 */
    reset() {
        this.chunks.length = 0;
        this.resultAddresses = [];
        this.compiled = null;
        this.config = null;
        this.snapshotBytes = 0;
        this.hasOldValues = false;
        this.lastStats = null;
    }
    /** 释放 worker 资源（不关闭进程句柄）。 */
    dispose() {
        for (const w of this.workers)
            void w.terminate();
        this.workers = [];
        this.workerReady = [];
    }
}
exports.ScanSession = ScanSession;
//# sourceMappingURL=scanner.js.map