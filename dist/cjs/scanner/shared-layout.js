"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SAB_MAX_BYTES = exports.CTRL_ARENA_USED = exports.CTRL_FAILED = exports.CTRL_DONE = exports.CTRL_PENDING = exports.CONTROL_INTS = exports.DEFAULT_SLOT_CAPACITY = void 0;
exports.createBatchLayout = createBatchLayout;
exports.resetShared = resetShared;
exports.writeSlot = writeSlot;
exports.readSlot = readSlot;
exports.writeSnapshot = writeSnapshot;
exports.readSnapshot = readSnapshot;
exports.markDone = markDone;
exports.markHandled = markHandled;
exports.waitAll = waitAll;
exports.createWorkerRequestLayout = createWorkerRequestLayout;
exports.createWorkerReplyLayout = createWorkerReplyLayout;
/** 默认每块结果槽可容纳的偏移数（64KB / 4B） */
exports.DEFAULT_SLOT_CAPACITY = 16 * 1024;
/** control 区 Int32 数量 */
exports.CONTROL_INTS = 8;
exports.CTRL_PENDING = 0;
exports.CTRL_DONE = 1;
exports.CTRL_FAILED = 2;
exports.CTRL_ARENA_USED = 3;
/** V8 对 SharedArrayBuffer 的实际上限（留出安全余量） */
exports.SAB_MAX_BYTES = 1_000_000_000;
/**
 * 构建一个批次用的共享布局。
 *
 * @param jobCount      本批次的块数
 * @param slotCapacity  每块的偏移容量
 * @param arenaCapacity 快照区容量（字节）
 * @param existing      已存在的共享内存（worker 侧重建视图时传入）；
 *                      省略则新建一块。
 */
function createBatchLayout(jobCount, slotCapacity, arenaCapacity, existing) {
    const slotStride = 2 + slotCapacity;
    const slotsInts = jobCount * slotStride;
    const markersBytes = align8(jobCount * 4);
    const handledBytes = align8(jobCount * 4);
    const controlBytes = exports.CONTROL_INTS * 4;
    const slotsBytes = slotsInts * 4;
    const baseBytes = controlBytes + slotsBytes + markersBytes + handledBytes;
    let buffer;
    let arena;
    if (existing) {
        buffer = existing;
        arena = Math.max(0, existing.byteLength - baseBytes);
    }
    else {
        // 容量保护：确保单个 SAB 不超过 V8 上限
        arena = Math.max(0, Math.min(arenaCapacity, exports.SAB_MAX_BYTES - baseBytes));
        buffer = new SharedArrayBuffer(baseBytes + arena);
    }
    const control = new Int32Array(buffer, 0, exports.CONTROL_INTS);
    const slots = new Int32Array(buffer, controlBytes, slotsInts);
    const markers = new Int32Array(buffer, controlBytes + slotsBytes, jobCount);
    const handled = new Int32Array(buffer, controlBytes + slotsBytes + markersBytes, jobCount);
    const arenaView = new Uint8Array(buffer, baseBytes, arena);
    const layout = {
        buffer,
        slots,
        markers,
        handled,
        arena: arenaView,
        control,
        slotStride,
        slotCapacity,
        jobCount,
        arenaCapacity: arena,
    };
    if (!existing)
        resetShared(layout);
    return layout;
}
function align8(n) {
    return (n + 7) & ~7;
}
/** 重置共享区状态。 */
function resetShared(layout) {
    Atomics.store(layout.control, exports.CTRL_PENDING, layout.jobCount);
    Atomics.store(layout.control, exports.CTRL_DONE, 0);
    Atomics.store(layout.control, exports.CTRL_FAILED, 0);
    Atomics.store(layout.control, exports.CTRL_ARENA_USED, 0);
    for (let i = 0; i < layout.jobCount; i++) {
        const b = i * layout.slotStride;
        Atomics.store(layout.slots, b, 0);
        Atomics.store(layout.slots, b + 1, 0);
        layout.markers[i] = -1;
        Atomics.store(layout.handled, i, 0);
    }
}
/** worker 侧：写入某块的命中偏移列表。 */
function writeSlot(layout, index, offsets) {
    const base = index * layout.slotStride;
    const n = Math.min(offsets.length, layout.slotCapacity);
    const truncated = offsets.length > layout.slotCapacity ? 1 : 0;
    // 先写数据与头，最后原子写命中数，保证主线程看到 cnt 时数据已就绪
    for (let i = 0; i < n; i++)
        layout.slots[base + 2 + i] = offsets[i];
    Atomics.store(layout.slots, base + 1, truncated);
    Atomics.store(layout.slots, base, n);
}
/** 主线程侧：读取某块的命中偏移。 */
function readSlot(layout, index) {
    const base = index * layout.slotStride;
    const n = Atomics.load(layout.slots, base);
    const truncated = Atomics.load(layout.slots, base + 1) === 1;
    const offsets = new Array(n);
    for (let i = 0; i < n; i++)
        offsets[i] = layout.slots[base + 2 + i];
    return { offsets, truncated };
}
/**
 * worker 侧：在快照竞技场中为某块抢占空间并写入。
 * 空间不足时放弃保留（next scan 会退化为"无旧值可用"）。
 */
function writeSnapshot(layout, index, data) {
    if (data.length > layout.arenaCapacity) {
        layout.markers[index] = -1;
        return false;
    }
    const prev = Atomics.add(layout.control, exports.CTRL_ARENA_USED, data.length);
    if (prev + data.length > layout.arenaCapacity) {
        Atomics.sub(layout.control, exports.CTRL_ARENA_USED, data.length);
        layout.markers[index] = -1;
        return false;
    }
    layout.arena.set(data, prev);
    // 用 Atomics.store 发布，确保主线程看到偏移时数据已写入
    Atomics.store(layout.markers, index, prev);
    return true;
}
/** 主线程侧：读取某块的快照。 */
function readSnapshot(layout, index, size) {
    const off = Atomics.load(layout.markers, index);
    if (off < 0)
        return null;
    if (off + size > layout.arenaCapacity)
        return null;
    const copy = Buffer.allocUnsafe(size);
    copy.set(layout.arena.subarray(off, off + size));
    return copy;
}
/** worker 侧：标记本块已完成。 */
function markDone(layout, failed) {
    if (failed)
        Atomics.add(layout.control, exports.CTRL_FAILED, 1);
    Atomics.add(layout.control, exports.CTRL_DONE, 1);
    Atomics.notify(layout.control, exports.CTRL_DONE);
}
/** worker 侧：标记本块已被处理（无论成功与否）。 */
function markHandled(layout, index) {
    Atomics.store(layout.handled, index, 1);
}
/** 主线程侧：同步等待本批次所有块完成。 */
function waitAll(layout, timeoutMs = 0) {
    let waited = 0;
    for (;;) {
        const done = Atomics.load(layout.control, exports.CTRL_DONE);
        const pending = Atomics.load(layout.control, exports.CTRL_PENDING);
        if (done >= pending)
            return true;
        const r = Atomics.wait(layout.control, exports.CTRL_DONE, done, 1000);
        if (r === 'timed-out') {
            waited += 1000;
            if (timeoutMs > 0 && waited >= timeoutMs)
                return false;
        }
    }
}
/** 创建请求/响应区（主线程侧） */
function createWorkerRequestLayout(ctrlInts, capacity) {
    const buffer = new SharedArrayBuffer(ctrlInts * 4 + capacity);
    return {
        buffer,
        ctrl: new Int32Array(buffer, 0, ctrlInts),
        data: new Uint8Array(buffer, ctrlInts * 4, capacity),
        capacity,
    };
}
/** 创建响应区（主线程侧）。与请求区布局相同，单独成函数便于两端语义对称。 */
function createWorkerReplyLayout(ctrlInts, capacity) {
    return createWorkerRequestLayout(ctrlInts, capacity);
}
//# sourceMappingURL=shared-layout.js.map