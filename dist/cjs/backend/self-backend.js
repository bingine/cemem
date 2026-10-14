"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackendUnsupportedError = exports.SelfBackend = void 0;
exports.isReadable = isReadable;
exports.isWritable = isWritable;
exports.isExecutable = isExecutable;
exports.filterScanRegions = filterScanRegions;
const types_1 = require("../types");
const w = __importStar(require("../win/winapi"));
const types_2 = require("./types");
Object.defineProperty(exports, "BackendUnsupportedError", { enumerable: true, get: function () { return types_2.BackendUnsupportedError; } });
/* ------------------------------------------------------------------ *
 * 结构体字段偏移（x64）
 *
 * koffi 无法用 JS 对象承接"指针出参结构体"（实测结论），
 * 因此统一用 Buffer + 显式偏移读写，等价于 CE 里的 packed record 访问。
 * ------------------------------------------------------------------ */
const PE32W = {
    size: w.koffi.sizeof(w.PROCESSENTRY32W),
    processId: 8,
    // ⚠️ 这两个偏移**必须**与 winapi.ts 里 PROCESSENTRY32W 的字段顺序一致。
    //
    // 之前的 20 / 24 是按「th32DefaultHeapID 是 4 字节」算的，而它实际是
    // `uintptr_t`（x64 上 8 字节），于是后面每个字段都错了：
    //   dwSize 0 / cntUsage 4 / th32ProcessID 8 / th32DefaultHeapID 16(8B)
    //   / th32ModuleID 24 / **cntThreads 28** / **th32ParentProcessID 32**
    //   / pcPriClassBase 36 / dwFlags 40 / szExeFile 44
    // 读 20 会读到 th32ModuleID（下面还有 4 字节对齐填充，恒为 0），
    // 于是**所有进程的线程数都显示成 0**；读 24 则拿到 th32ModuleID。
    threadCount: 28,
    parentPid: 32,
    exeFile: 44,
    exeFileChars: 260,
};
const TE32 = {
    size: w.koffi.sizeof(w.THREADENTRY32),
    threadId: 8,
    ownerProcessId: 12,
};
const ME32W = {
    size: w.koffi.sizeof(w.MODULEENTRY32W),
    baseAddr: 24,
    baseSize: 32,
    // hModule 是 8 字节指针，其后字符串按 4 字节对齐，因此从 48 开始（实测确认）
    module: 48,
    moduleChars: 256,
    exePath: 560,
    exePathChars: 260,
};
/** MEMORY_BASIC_INFORMATION (x64) 的 Buffer 布局 */
const MBI = {
    size: 48,
    baseAddress: 0,
    regionSize: 24,
    state: 32,
    protect: 36,
    type: 40,
};
/** 读取 Buffer 内 UTF-16LE 定长字符串（去尾零） */
function readU16Fixed(buf, offset, chars) {
    let end = offset + chars * 2;
    for (let i = offset; i < offset + chars * 2; i += 2) {
        if (buf.readUInt16LE(i) === 0) {
            end = i;
            break;
        }
    }
    return buf.toString('utf16le', offset, end);
}
/* ------------------------------------------------------------------ *
 * 保护属性分类（导出给上层复用）
 * ------------------------------------------------------------------ */
/** 判断保护属性是否可读 */
function isReadable(protect) {
    if (protect & types_1.PAGE_GUARD)
        return false;
    const base = protect & 0xff;
    if (base === types_1.PAGE_NOACCESS || base === 0)
        return false;
    return (base === 0x02 ||
        base === 0x04 ||
        base === 0x08 ||
        base === 0x10 ||
        base === 0x20 ||
        base === 0x40 ||
        base === 0x80);
}
/** 判断保护属性是否可写 */
function isWritable(protect) {
    if (protect & types_1.PAGE_GUARD)
        return false;
    const base = protect & 0xff;
    return base === 0x04 || base === 0x08 || base === 0x40 || base === 0x80;
}
/** 判断保护属性是否可执行 */
function isExecutable(protect) {
    const base = protect & 0xff;
    return base === 0x10 || base === 0x20 || base === 0x40 || base === 0x80;
}
/** 按过滤条件筛出可扫描区域（与后端无关的纯函数，供两个后端共用） */
function filterScanRegions(regions, filter = {}) {
    const includeImage = filter.includeImage !== false;
    const includeMapped = filter.includeMapped !== false;
    const includePrivate = filter.includePrivate !== false;
    return regions.filter((r) => {
        if (!filter.includeFree && r.state !== types_1.MEM_COMMIT)
            return false;
        if (!filter.includeGuard && (r.protect & types_1.PAGE_GUARD) !== 0)
            return false;
        if (!isReadable(r.protect))
            return false;
        if (filter.writableOnly && !isWritable(r.protect))
            return false;
        if (filter.executableOnly && !isExecutable(r.protect))
            return false;
        if (r.type === types_1.MEM_IMAGE && !includeImage)
            return false;
        if (r.type === 0x40000 /* MEM_MAPPED */ && !includeMapped)
            return false;
        if (r.type === 0x20000 /* MEM_PRIVATE */ && !includePrivate)
            return false;
        return true;
    });
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
class SelfBackend {
    name = 'self';
    capabilities = {
        // 纯同步：本进程内直接调 Win32 API，所有方法直接返回值
        sync: true,
        enumerateProcesses: true,
        queryRegions: true,
        queryModules: true,
        queryThreads: true,
        suspendThreads: true,
        allocateMemory: true,
        changeProtection: true,
        local: true,
        requiresServer: false,
    };
    access;
    nextHandleId = 1;
    handles = new Map();
    disposed = false;
    constructor(options = {}) {
        this.access = options.access ?? types_1.DEFAULT_PROCESS_ACCESS;
    }
    /* —— 进程枚举 —— */
    listProcesses() {
        const snap = w.CreateToolhelp32Snapshot(w.TH32CS_SNAPPROCESS, 0);
        if (!w.isValidHandle(snap)) {
            throw new Error(`创建进程快照失败：${w.lastErrorMessage()}`);
        }
        const out = [];
        try {
            const buf = Buffer.alloc(PE32W.size);
            buf.writeUInt32LE(PE32W.size, 0);
            if (!w.Process32FirstW(snap, buf))
                return out;
            do {
                out.push({
                    pid: buf.readUInt32LE(PE32W.processId),
                    name: readU16Fixed(buf, PE32W.exeFile, PE32W.exeFileChars),
                    parentPid: buf.readUInt32LE(PE32W.parentPid),
                    threadCount: buf.readUInt32LE(PE32W.threadCount),
                });
            } while (w.Process32NextW(snap, buf));
        }
        finally {
            w.CloseHandle(snap);
        }
        return out;
    }
    /* —— 句柄 —— */
    openProcess(pid) {
        this.assertNotDisposed();
        const h = w.OpenProcess(this.access, false, pid);
        if (!w.isValidHandle(h)) {
            const code = w.GetLastError();
            const err = new Error(`无法打开进程 ${pid}：${w.win32ErrorMessage(code)}`);
            err.name = 'ProcessOpenError';
            err.pid = pid;
            err.win32Code = code;
            throw err;
        }
        const id = this.nextHandleId++;
        this.handles.set(id, w.handleToBigInt(h));
        return { id, pid };
    }
    closeProcess(handle) {
        const h = this.handles.get(handle.id);
        if (h === undefined)
            return;
        this.handles.delete(handle.id);
        w.CloseHandle(w.asPointer(h));
    }
    raw(handle) {
        const h = this.handles.get(handle.id);
        if (h === undefined)
            throw new Error(`进程 ${handle.pid} 的句柄已关闭`);
        return h;
    }
    assertNotDisposed() {
        if (this.disposed)
            throw new Error('后端已释放');
    }
    /* —— 内存区域 —— */
    queryRegions(handle, filter = {}) {
        const h = this.raw(handle);
        const maxAddr = filter.maxAddress ?? types_1.MAX_USER_ADDRESS_64;
        const mbi = Buffer.alloc(MBI.size);
        const size = w.koffi.sizeof(w.MEMORY_BASIC_INFORMATION);
        const all = [];
        let addr = 0n;
        while (addr < maxAddr) {
            const got = w.VirtualQueryEx(h, w.asPointer(addr), mbi, size);
            if (!got)
                break;
            const base = mbi.readBigUInt64LE(MBI.baseAddress);
            const regionSize = mbi.readBigUInt64LE(MBI.regionSize);
            all.push({
                baseAddress: base,
                regionSize,
                state: mbi.readUInt32LE(MBI.state),
                protect: mbi.readUInt32LE(MBI.protect),
                type: mbi.readUInt32LE(MBI.type),
            });
            if (regionSize <= 0n)
                break;
            const next = base + regionSize;
            if (next <= addr) {
                // 防止异常返回值造成死循环
                const bumped = base + 0x1000n;
                if (bumped <= base)
                    break;
                addr = bumped;
            }
            else {
                addr = next;
            }
        }
        // includeFree 时由 filterScanRegions 之外的逻辑处理；这里按需返回
        if (filter.includeFree)
            return all;
        return filterScanRegions(all, filter);
    }
    /* —— 读写内存 —— */
    readProcessMemory(handle, address, size) {
        const h = this.raw(handle);
        if (size < 0)
            throw new RangeError('size 不能为负');
        if (size === 0)
            return Buffer.alloc(0);
        const buf = Buffer.allocUnsafe(size);
        const bytesRead = [0];
        const ok = w.ReadProcessMemory(w.asPointer(h), w.asPointer(address), buf, size, bytesRead);
        if (ok) {
            const n = Number(bytesRead[0]);
            return n === size ? buf : buf.subarray(0, n);
        }
        // 失败：二分回退，尽量读出可读部分（对齐 CE 的分段重试）
        if (size > 1) {
            const half = size >>> 1;
            const a = this.readProcessMemory(handle, address, half);
            if (a.length < half)
                return a;
            const b = this.readProcessMemory(handle, address + BigInt(half), size - half);
            return Buffer.concat([a, b]);
        }
        return Buffer.alloc(0);
    }
    writeProcessMemory(handle, address, data, fixProtection = true) {
        const h = this.raw(handle);
        const bytesWritten = [0];
        if (fixProtection) {
            const old = [0];
            const changed = w.VirtualProtectEx(w.asPointer(h), w.asPointer(address), data.length, 0x04, // PAGE_READWRITE
            old);
            if (changed) {
                const ok = w.WriteProcessMemory(w.asPointer(h), w.asPointer(address), data, data.length, bytesWritten);
                const restore = [0];
                w.VirtualProtectEx(w.asPointer(h), w.asPointer(address), data.length, old[0], restore);
                if (!ok) {
                    throw new Error(`写入进程 ${handle.pid} 内存失败：${w.lastErrorMessage()}`);
                }
                return Number(bytesWritten[0]);
            }
        }
        const ok = w.WriteProcessMemory(w.asPointer(h), w.asPointer(address), data, data.length, bytesWritten);
        if (!ok) {
            throw new Error(`写入进程 ${handle.pid} 内存失败：${w.lastErrorMessage()}`);
        }
        return Number(bytesWritten[0]);
    }
    /* —— 模块 / 线程 —— */
    queryModules(handle) {
        const h = this.raw(handle);
        const snap = w.CreateToolhelp32Snapshot(w.TH32CS_SNAPMODULE | w.TH32CS_SNAPMODULE32, handle.pid);
        if (!w.isValidHandle(snap))
            return [];
        const out = [];
        try {
            const buf = Buffer.alloc(ME32W.size);
            buf.writeUInt32LE(ME32W.size, 0);
            if (!w.Module32FirstW(snap, buf))
                return out;
            do {
                out.push({
                    name: readU16Fixed(buf, ME32W.module, ME32W.moduleChars),
                    path: readU16Fixed(buf, ME32W.exePath, ME32W.exePathChars),
                    baseAddress: buf.readBigUInt64LE(ME32W.baseAddr),
                    size: buf.readUInt32LE(ME32W.baseSize),
                });
            } while (w.Module32NextW(snap, buf));
        }
        finally {
            w.CloseHandle(snap);
        }
        void h;
        return out;
    }
    queryThreads(handle) {
        const snap = w.CreateToolhelp32Snapshot(w.TH32CS_SNAPTHREAD, 0);
        if (!w.isValidHandle(snap))
            return [];
        const out = [];
        try {
            const buf = Buffer.alloc(TE32.size);
            buf.writeUInt32LE(TE32.size, 0);
            if (!w.Thread32First(snap, buf))
                return out;
            do {
                if (buf.readUInt32LE(TE32.ownerProcessId) === handle.pid) {
                    out.push(buf.readUInt32LE(TE32.threadId));
                }
            } while (w.Thread32Next(snap, buf));
        }
        finally {
            w.CloseHandle(snap);
        }
        return out;
    }
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
    isProcessAlive(handle) {
        const h = this.handles.get(handle.id);
        if (h === undefined)
            return false;
        const waited = w.WaitForSingleObject(w.asPointer(h), 0);
        if (waited === w.WAIT_TIMEOUT)
            return true;
        if (waited === w.WAIT_OBJECT_0)
            return false;
        // 其他返回值（WAIT_FAILED / WAIT_ABANDONED）语义不明确：不谎报存活
        return false;
    }
    /* —— 内存分配 / 保护 —— */
    allocate(handle, size, protect = 0x04, preferred = 0n) {
        const h = this.raw(handle);
        const p = w.VirtualAllocEx(w.asPointer(h), preferred === 0n ? null : w.asPointer(preferred), size, 0x3000, // MEM_COMMIT | MEM_RESERVE
        protect);
        if (!w.isValidHandle(p))
            throw new Error(`分配内存失败：${w.lastErrorMessage()}`);
        return w.handleToBigInt(p);
    }
    free(handle, address) {
        const h = this.raw(handle);
        if (!w.VirtualFreeEx(w.asPointer(h), w.asPointer(address), 0, 0x8000 /* MEM_RELEASE */)) {
            throw new Error(`释放内存失败：${w.lastErrorMessage()}`);
        }
    }
    changeProtection(handle, address, size, newProtect) {
        const h = this.raw(handle);
        const old = [0];
        if (!w.VirtualProtectEx(w.asPointer(h), w.asPointer(address), size, newProtect, old)) {
            throw new Error(`修改内存保护失败：${w.lastErrorMessage()}`);
        }
        return old[0];
    }
    /* —— 位数 —— */
    isWow64(handle) {
        const h = this.raw(handle);
        const out = [0];
        if (!w.IsWow64Process(w.asPointer(h), out))
            return false;
        return out[0] !== 0;
    }
    /* —— 线程挂起/恢复（上层 Process 用到） —— */
    /** 挂起目标进程全部线程，返回可恢复的线程句柄 */
    suspendAllThreads(handle) {
        const handles = [];
        for (const tid of this.queryThreads(handle)) {
            const th = w.OpenThread(w.THREAD_SUSPEND_RESUME, false, tid);
            if (w.isValidHandle(th)) {
                const hb = w.handleToBigInt(th);
                w.SuspendThread(w.asPointer(hb));
                handles.push(hb);
            }
        }
        return handles;
    }
    /** 恢复之前挂起的线程并关闭句柄 */
    resumeThreads(handles) {
        for (const h of handles) {
            w.ResumeThread(w.asPointer(h));
            w.CloseHandle(w.asPointer(h));
        }
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const h of this.handles.values())
            w.CloseHandle(w.asPointer(h));
        this.handles.clear();
    }
}
exports.SelfBackend = SelfBackend;
//# sourceMappingURL=self-backend.js.map