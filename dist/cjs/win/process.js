"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PROCESS_ACCESS = exports.MEM_PRIVATE = exports.MEM_MAPPED = exports.MEM_IMAGE = exports.MEM_COMMIT = exports.PAGE_GUARD = exports.MAX_ADDRESS = exports.Process = exports.ProcessOpenError = exports.isExecutable = exports.isWritable = exports.isReadable = void 0;
exports.getDefaultBackend = getDefaultBackend;
exports.setDefaultBackend = setDefaultBackend;
exports.listProcesses = listProcesses;
exports.findProcessesByName = findProcessesByName;
exports.listProcessesAsync = listProcessesAsync;
exports.findProcessesByNameAsync = findProcessesByNameAsync;
exports.enumerateRegions = enumerateRegions;
exports.selectScannableRegions = selectScannableRegions;
exports.openProcessAsync = openProcessAsync;
exports.openProcessByNameAsync = openProcessByNameAsync;
exports.regionTypeName = regionTypeName;
const types_1 = require("../types");
Object.defineProperty(exports, "DEFAULT_PROCESS_ACCESS", { enumerable: true, get: function () { return types_1.DEFAULT_PROCESS_ACCESS; } });
Object.defineProperty(exports, "MEM_COMMIT", { enumerable: true, get: function () { return types_1.MEM_COMMIT; } });
Object.defineProperty(exports, "MEM_IMAGE", { enumerable: true, get: function () { return types_1.MEM_IMAGE; } });
Object.defineProperty(exports, "MEM_MAPPED", { enumerable: true, get: function () { return types_1.MEM_MAPPED; } });
Object.defineProperty(exports, "MEM_PRIVATE", { enumerable: true, get: function () { return types_1.MEM_PRIVATE; } });
Object.defineProperty(exports, "PAGE_GUARD", { enumerable: true, get: function () { return types_1.PAGE_GUARD; } });
const self_backend_1 = require("../backend/self-backend");
var self_backend_2 = require("../backend/self-backend");
Object.defineProperty(exports, "isReadable", { enumerable: true, get: function () { return self_backend_2.isReadable; } });
Object.defineProperty(exports, "isWritable", { enumerable: true, get: function () { return self_backend_2.isWritable; } });
Object.defineProperty(exports, "isExecutable", { enumerable: true, get: function () { return self_backend_2.isExecutable; } });
/* ------------------------------------------------------------------ *
 * 后端解析
 * ------------------------------------------------------------------ */
let defaultBackend = null;
/** 取进程内共享的默认后端（自研引擎）。 */
function getDefaultBackend() {
    if (!defaultBackend)
        defaultBackend = new self_backend_1.SelfBackend();
    return defaultBackend;
}
/** 替换默认后端（例如全局切到原生 CE）。传入 null 恢复自研后端。 */
function setDefaultBackend(backend) {
    defaultBackend = backend;
}
function resolveBackend(options) {
    if (options?.backend)
        return options.backend;
    if (options?.access !== undefined) {
        return new self_backend_1.SelfBackend({ access: options.access });
    }
    return getDefaultBackend();
}
/**
 * 断言后端是同步的，并把返回值收窄为 T。
 *
 * 用途：`Process` 的同步方法（`readMemory` 等）只能用于同步后端。
 * 若换成了 `NativeCeBackend`（socket，异步），同步方法无法工作 ——
 * 这时要给出**明确、可操作**的错误，而不是让调用方拿到一个 Promise 当 Buffer 用。
 */
function syncResult(backend, value, operation) {
    if (backend.capabilities.sync)
        return value;
    throw new Error(`后端 "${backend.name}" 是异步的，不能使用同步方法 ${operation}()。` +
        `请改用异步变体（例如 readMemoryAsync()）并 await，` +
        `或改用同步后端 SelfBackend。`);
}
/** 枚举全部进程（使用默认后端；同步后端专用，异步后端请用 listProcessesAsync） */
function listProcesses(backend) {
    const b = backend ?? getDefaultBackend();
    const out = syncResult(b, b.listProcesses(), 'listProcesses').map((p) => ({
        pid: p.pid,
        name: p.name,
        parentPid: p.parentPid,
        threadCount: p.threadCount,
    }));
    // 标记同名进程，便于 CLI 提示用户选择
    const counts = new Map();
    for (const p of out) {
        const k = p.name.toLowerCase();
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const p of out) {
        if ((counts.get(p.name.toLowerCase()) ?? 0) > 1)
            p.duplicateName = true;
    }
    return out;
}
/** 按名字查进程（不区分大小写，包含匹配） */
function findProcessesByName(name, backend) {
    const needle = name.toLowerCase();
    return listProcesses(backend).filter((p) => p.name.toLowerCase() === needle || p.name.toLowerCase().includes(needle));
}
/* ------------------------------------------------------------------ *
 * 异步变体（原生 CE 后端必须用这些）
 * ------------------------------------------------------------------ */
/** 枚举全部进程（异步；对同步与异步后端都可用） */
async function listProcessesAsync(backend) {
    const b = backend ?? getDefaultBackend();
    const out = (await b.listProcesses()).map((p) => ({
        pid: p.pid,
        name: p.name,
        parentPid: p.parentPid,
        threadCount: p.threadCount,
    }));
    const counts = new Map();
    for (const p of out) {
        const k = p.name.toLowerCase();
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const p of out) {
        if ((counts.get(p.name.toLowerCase()) ?? 0) > 1)
            p.duplicateName = true;
    }
    return out;
}
/** 按名字查进程（异步） */
async function findProcessesByNameAsync(name, backend) {
    const needle = name.toLowerCase();
    return (await listProcessesAsync(backend)).filter((p) => p.name.toLowerCase() === needle || p.name.toLowerCase().includes(needle));
}
/** 把后端区域转成对外暴露的 MemoryRegion */
function toMemoryRegion(r) {
    return {
        baseAddress: r.baseAddress,
        memorySize: r.regionSize,
        committed: r.state === types_1.MEM_COMMIT,
        protect: r.protect,
        type: r.type,
    };
}
/**
 * 枚举进程内存区域。
 *
 * 只接受 `Process` 实例（早期版本接受裸 Win32 句柄，那样无法支持原生 CE 后端，
 * 因此移除；请用 `process.regions()`）。
 */
function enumerateRegions(process, options = {}) {
    if (!(process instanceof Process)) {
        throw new TypeError('enumerateRegions 需要传入 Process 实例（裸 Win32 句柄已不再支持，请用 process.regions()）');
    }
    return process.regions(options);
}
/** 选出"可扫描"的内存区域（对齐 CE 首次扫描的默认行为） */
function selectScannableRegions(process, filter = {}) {
    return process.scannableRegions(filter);
}
/* ------------------------------------------------------------------ *
 * Process
 * ------------------------------------------------------------------ */
/** 打开进程失败时抛出的错误，带 pid 与 Win32 错误码（若后端提供）。 */
class ProcessOpenError extends Error {
    pid;
    win32Code;
    constructor(pid, win32Code, message) {
        super(message ?? `无法打开进程 ${pid}：Win32 错误 ${win32Code}`);
        this.pid = pid;
        this.win32Code = win32Code;
        this.name = 'ProcessOpenError';
    }
}
exports.ProcessOpenError = ProcessOpenError;
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
class Process {
    pid;
    name;
    backend;
    handle;
    closed = false;
    constructor(pid, name, backend, handle) {
        this.pid = pid;
        this.name = name;
        this.backend = backend;
        this.handle = handle;
    }
    /** 按 pid 打开进程（同步后端专用；异步后端请用 openProcessAsync） */
    static open(pid, options) {
        const backend = resolveBackend(options);
        let handle;
        try {
            handle = syncResult(backend, backend.openProcess(pid), 'openProcess');
        }
        catch (e) {
            const err = e;
            if (err.name === 'ProcessOpenError' || err.win32Code !== undefined) {
                throw new ProcessOpenError(pid, err.win32Code ?? 0, err.message);
            }
            throw e;
        }
        const info = syncResult(backend, backend.listProcesses(), 'listProcesses').find((p) => p.pid === pid);
        return new Process(pid, info?.name ?? `<pid ${pid}>`, backend, handle);
    }
    /** 按进程名打开；同名多进程时选第一个 */
    static openByName(name, options) {
        const backend = resolveBackend(options);
        const matches = findProcessesByName(name, backend);
        if (matches.length === 0)
            throw new Error(`找不到进程：${name}`);
        return Process.open(matches[0].pid, options);
    }
    /** 按进程名打开全部同名进程 */
    static openByNameAll(name, options) {
        const backend = resolveBackend(options);
        return findProcessesByName(name, backend).map((p) => Process.open(p.pid, options));
    }
    /**
     * 由"已打开的后端句柄"构造 Process —— 供异步打开路径使用。
     * 一般业务代码请用 `Process.open` / `openProcessAsync`。
     */
    static fromHandle(pid, name, backend, handle) {
        return new Process(pid, name, backend, handle);
    }
    get isOpen() {
        return !this.closed;
    }
    /** 所属后端名称 */
    get backendName() {
        return this.backend.name;
    }
    /**
     * 底层后端句柄 —— 供需要直接调用后端的扩展代码使用
     * （例如 Lua 桥要把句柄转成整数传给脚本）。
     * 一般业务代码应优先使用 Process 的高层方法。
     */
    get backendHandle() {
        this.assertOpen();
        return this.handle;
    }
    assertOpen() {
        if (this.closed)
            throw new Error(`进程 ${this.pid} 的句柄已关闭`);
    }
    /** 是否为 WOW64（32 位）进程 */
    isWow64() {
        this.assertOpen();
        return syncResult(this.backend, this.backend.isWow64(this.handle), 'isWow64');
    }
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
    isProcessAlive() {
        if (this.closed)
            return false;
        const backend = this.backend;
        if (typeof backend.isProcessAlive !== 'function')
            return undefined;
        try {
            return syncResult(this.backend, backend.isProcessAlive(this.handle), 'isProcessAlive');
        }
        catch {
            // 判断本身失败不该让调用方炸掉：如实报"未知"，由上层按旧行为继续
            return undefined;
        }
    }
    /** 异步变体（原生 CE 后端走这条路） */
    async isProcessAliveAsync() {
        if (this.closed)
            return false;
        const backend = this.backend;
        if (typeof backend.isProcessAlive !== 'function')
            return undefined;
        try {
            return await backend.isProcessAlive(this.handle);
        }
        catch {
            return undefined;
        }
    }
    /** 列出全部内存区域 */
    regions(options) {
        this.assertOpen();
        const list = syncResult(this.backend, this.backend.queryRegions(this.handle, {
            includeFree: options?.includeFree ?? true,
            maxAddress: options?.maxAddress,
        }), 'regions');
        return list.map(toMemoryRegion);
    }
    /** 列出可扫描区域 */
    scannableRegions(filter) {
        this.assertOpen();
        const raw = syncResult(this.backend, this.backend.queryRegions(this.handle, filter ?? {}), 'scannableRegions');
        return raw.map(toMemoryRegion);
    }
    /**
     * 读取内存。整块读取失败时由后端做二分回退。
     * @returns 实际读到的数据（长度可能小于请求）
     */
    readMemory(address, size) {
        this.assertOpen();
        return syncResult(this.backend, this.backend.readProcessMemory(this.handle, address, size), 'readMemory');
    }
    /** 读取失败时抛错的严格版本 */
    readMemoryExact(address, size) {
        const buf = this.readMemory(address, size);
        if (buf.length !== size) {
            throw new Error(`读取进程 ${this.pid} 内存失败：地址 0x${address.toString(16)}，请求 ${size} 字节，实得 ${buf.length} 字节`);
        }
        return buf;
    }
    /**
     * 写入内存。默认在写只读页前临时改保护（与 CE 的 writeprocessmemory 行为一致）。
     * @returns 实际写入字节数
     */
    writeMemory(address, data, fixProtection = true) {
        this.assertOpen();
        return syncResult(this.backend, this.backend.writeProcessMemory(this.handle, address, data, fixProtection), 'writeMemory');
    }
    /** 在目标进程内分配内存 */
    allocate(size, protect = 0x04, address = 0n) {
        this.assertOpen();
        return syncResult(this.backend, this.backend.allocate(this.handle, size, protect, address), 'allocate');
    }
    /** 释放由 allocate 分配的内存 */
    free(address) {
        this.assertOpen();
        syncResult(this.backend, this.backend.free(this.handle, address), 'free');
    }
    /** 修改内存保护属性，返回旧保护值 */
    protect(address, size, newProtect) {
        this.assertOpen();
        return syncResult(this.backend, this.backend.changeProtection(this.handle, address, size, newProtect), 'protect');
    }
    /** 列出进程模块 */
    modules() {
        this.assertOpen();
        return syncResult(this.backend, this.backend.queryModules(this.handle), 'modules').map((m) => ({
            name: m.name,
            path: m.path,
            baseAddress: m.baseAddress,
            size: m.size,
        }));
    }
    /** 列出线程 id */
    threadIds() {
        this.assertOpen();
        return syncResult(this.backend, this.backend.queryThreads(this.handle), 'threadIds');
    }
    /**
     * 挂起进程全部线程，返回可传给 resume() 的令牌。
     * 仅自研后端支持（原生 CE 后端会抛错）。
     */
    suspend() {
        this.assertOpen();
        const b = this.backend;
        if (typeof b.suspendAllThreads !== 'function') {
            throw new Error(`后端 "${this.backend.name}" 不支持挂起线程（ceserver 的线程接口未实现）`);
        }
        return b.suspendAllThreads(this.handle);
    }
    /** 恢复之前挂起的线程 */
    resume(token) {
        const b = this.backend;
        if (typeof b.resumeThreads !== 'function') {
            throw new Error(`后端 "${this.backend.name}" 不支持恢复线程`);
        }
        b.resumeThreads(token);
    }
    /** 关闭句柄。可重复调用。 */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        void this.backend.closeProcess(this.handle);
    }
    /** 支持 `using` 语义 */
    [Symbol.dispose]() {
        this.close();
    }
    /* ---------------------------------------------------------------- *
     * 异步变体
     *
     * 存在的理由：`NativeCeBackend`（原生 CE / ceserver）本质是 socket 通信，
     * 只能是异步的；而 `SelfBackend` 是同步的。
     * 下面这些 `*Async` 方法**对两种后端都可用** ——
     * 同步后端会直接返回（`await` 一个非 Promise 值原样返回），
     * 因此调用方可以统一写 `await`，无需分支判断。
     * ---------------------------------------------------------------- */
    /** 异步关闭句柄 */
    async closeAsync() {
        if (this.closed)
            return;
        this.closed = true;
        await this.backend.closeProcess(this.handle);
    }
    /** 异步枚举全部内存区域 */
    async regionsAsync(options) {
        this.assertOpen();
        const list = await this.backend.queryRegions(this.handle, {
            includeFree: options?.includeFree ?? true,
            maxAddress: options?.maxAddress,
        });
        return list.map(toMemoryRegion);
    }
    /** 异步枚举可扫描区域 */
    async scannableRegionsAsync(filter) {
        this.assertOpen();
        const raw = await this.backend.queryRegions(this.handle, filter ?? {});
        return raw.map(toMemoryRegion);
    }
    /** 异步读取内存 */
    async readMemoryAsync(address, size) {
        this.assertOpen();
        return syncResult(this.backend, this.backend.readProcessMemory(this.handle, address, size), 'readMemory');
    }
    /** 异步读取内存（不足则抛错） */
    async readMemoryExactAsync(address, size) {
        const buf = await this.readMemoryAsync(address, size);
        if (buf.length !== size) {
            throw new Error(`读取进程 ${this.pid} 内存失败：地址 0x${address.toString(16)}，请求 ${size} 字节，实得 ${buf.length} 字节`);
        }
        return buf;
    }
    /** 异步写入内存 */
    async writeMemoryAsync(address, data, fixProtection = true) {
        this.assertOpen();
        return syncResult(this.backend, this.backend.writeProcessMemory(this.handle, address, data, fixProtection), 'writeMemory');
    }
    /** 异步枚举模块 */
    async modulesAsync() {
        this.assertOpen();
        const mods = await this.backend.queryModules(this.handle);
        return mods.map((m) => ({
            name: m.name,
            path: m.path,
            baseAddress: m.baseAddress,
            size: m.size,
        }));
    }
    /** 异步枚举线程 id */
    async threadIdsAsync() {
        this.assertOpen();
        return syncResult(this.backend, this.backend.queryThreads(this.handle), 'threadIds');
    }
    /** 异步分配内存 */
    async allocateAsync(size, protect = 0x04, address = 0n) {
        this.assertOpen();
        return syncResult(this.backend, this.backend.allocate(this.handle, size, protect, address), 'allocate');
    }
    /** 异步修改内存保护 */
    async protectAsync(address, size, newProtect) {
        this.assertOpen();
        return syncResult(this.backend, this.backend.changeProtection(this.handle, address, size, newProtect), 'protect');
    }
    /** 异步判断是否 WOW64 */
    async isWow64Async() {
        this.assertOpen();
        return syncResult(this.backend, this.backend.isWow64(this.handle), 'isWow64');
    }
}
exports.Process = Process;
/** 打开进程的异步变体（原生 CE 后端下必须用它）。 */
async function openProcessAsync(pid, options) {
    const backend = resolveBackend(options);
    const handle = await backend.openProcess(pid);
    const infos = await backend.listProcesses();
    const info = infos.find((p) => p.pid === pid);
    return Process.fromHandle(pid, info?.name ?? `<pid ${pid}>`, backend, handle);
}
/** 按名字打开进程（异步变体）。 */
async function openProcessByNameAsync(name, options) {
    const backend = resolveBackend(options);
    const all = (await backend.listProcesses()).map((p) => ({
        pid: p.pid,
        name: p.name,
        parentPid: p.parentPid,
        threadCount: p.threadCount,
    }));
    const needle = name.toLowerCase();
    const matches = all.filter((p) => p.name.toLowerCase() === needle || p.name.toLowerCase().includes(needle));
    if (matches.length === 0)
        throw new Error(`找不到进程：${name}`);
    return openProcessAsync(matches[0].pid, options);
}
/** 展示用：区域类型的可读名字 */
function regionTypeName(type) {
    if (type === types_1.MEM_IMAGE)
        return 'MEM_IMAGE';
    if (type === types_1.MEM_MAPPED)
        return 'MEM_MAPPED';
    if (type === types_1.MEM_PRIVATE)
        return 'MEM_PRIVATE';
    return 'MEM_FREE';
}
/** 默认最大用户态地址（供上层限制扫描范围） */
exports.MAX_ADDRESS = types_1.MAX_USER_ADDRESS_64;
//# sourceMappingURL=process.js.map