"use strict";
/**
 * Windows 原生 API 绑定层。
 *
 * 通过 koffi 直接绑定 kernel32/psapi 等导出函数，替代 Cheat Engine 里的
 * `NewKernelHandler.pas` / `ProcessHandlerUnit.pas`（用户态部分）。
 *
 * 注意：CE 在内核态做的部分（dbk32/DBKKernel 驱动读写物理内存、
 * 绕过 ObRegisterCallbacks 等）在 Node 中不存在实现路径，见 PORT-SCOPE.md。
 * 本模块只覆盖 CE 的"无驱动回退路径"所使用的那套用户态 API。
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
exports.THREAD_SUSPEND_RESUME = exports.TH32CS_SNAPALL = exports.TH32CS_SNAPMODULE32 = exports.TH32CS_SNAPMODULE = exports.TH32CS_SNAPTHREAD = exports.TH32CS_SNAPPROCESS = exports.EnumProcessModules = exports.GetModuleFileNameExW = exports.INVALID_HANDLE_VALUE = exports.FILE_ATTRIBUTE_NORMAL = exports.CREATE_EXISTING = exports.FILE_SHARE_WRITE = exports.FILE_SHARE_READ = exports.GENERIC_WRITE = exports.GENERIC_READ = exports.DeviceIoControl = exports.CreateFileW = exports.GetLastError = exports.UnmapViewOfFile = exports.MapViewOfFile = exports.OpenFileMappingW = exports.CreateFileMappingW = exports.SetThreadContext = exports.GetThreadContext = exports.ResumeThread = exports.SuspendThread = exports.OpenThread = exports.VirtualFreeEx = exports.VirtualAllocEx = exports.VirtualProtectEx = exports.VirtualQueryEx = exports.WriteProcessMemory = exports.ReadProcessMemory = exports.WAIT_TIMEOUT = exports.WAIT_OBJECT_0 = exports.WaitForSingleObject = exports.IsWow64Process = exports.TerminateProcess = exports.GetProcessId = exports.GetCurrentProcessId = exports.GetCurrentProcess = exports.CloseHandle = exports.OpenProcess = exports.Module32NextW = exports.Module32FirstW = exports.Thread32Next = exports.Thread32First = exports.Process32NextW = exports.Process32FirstW = exports.CreateToolhelp32Snapshot = void 0;
exports.koffi = exports.SECURITY_ATTRIBUTES = exports.MEMORY_BASIC_INFORMATION = exports.MODULEENTRY32W = exports.THREADENTRY32 = exports.PROCESSENTRY32W = exports.ACCESS = exports.PAGE_PROTECT_NAMES = exports.MEM_TYPE_NAMES = exports.MEM_STATE_NAMES = exports.PAGE_READWRITE_MAP = exports.FILE_MAP_ALL_ACCESS = exports.PAGE_GUARD_FLAG = exports.PAGE_PROTECTION_MASK = exports.PAGE_EXECUTE_READWRITE_FLAG = exports.PAGE_EXECUTE_READ_FLAG = exports.PAGE_EXECUTE_FLAG = exports.PAGE_READWRITE_FLAG = exports.PAGE_READONLY_FLAG = exports.MEM_COMMIT_FLAG = exports.MEM_RESERVE_FLAG = exports.MEM_RELEASE = exports.THREAD_QUERY_INFORMATION = exports.THREAD_SET_CONTEXT = exports.THREAD_GET_CONTEXT = void 0;
exports.win32ErrorMessage = win32ErrorMessage;
exports.lastErrorMessage = lastErrorMessage;
exports.isValidHandle = isValidHandle;
exports.handleToBigInt = handleToBigInt;
exports.asPointer = asPointer;
exports.bufferAsPointer = bufferAsPointer;
const koffi = __importStar(require("koffi"));
exports.koffi = koffi;
const types_1 = require("../types");
/* ------------------------------------------------------------------ *
 * 结构体
 * ------------------------------------------------------------------ */
const PROCESSENTRY32W = koffi.struct('NCE_PROCESSENTRY32W', {
    dwSize: 'uint32',
    cntUsage: 'uint32',
    th32ProcessID: 'uint32',
    th32DefaultHeapID: 'uintptr_t',
    th32ModuleID: 'uint32',
    cntThreads: 'uint32',
    th32ParentProcessID: 'uint32',
    pcPriClassBase: 'long',
    dwFlags: 'uint32',
    szExeFile: koffi.array('uint16', 260),
});
exports.PROCESSENTRY32W = PROCESSENTRY32W;
const THREADENTRY32 = koffi.struct('NCE_THREADENTRY32', {
    dwSize: 'uint32',
    cntUsage: 'uint32',
    th32ThreadID: 'uint32',
    th32OwnerProcessID: 'uint32',
    tpBasePri: 'long',
    tpDeltaPri: 'long',
    dwFlags: 'uint32',
});
exports.THREADENTRY32 = THREADENTRY32;
const MODULEENTRY32W = koffi.struct('NCE_MODULEENTRY32W', {
    dwSize: 'uint32',
    th32ModuleID: 'uint32',
    th32ProcessID: 'uint32',
    GlblcntUsage: 'uint32',
    ProccntUsage: 'uint32',
    modBaseAddr: 'void*',
    modBaseSize: 'uint32',
    hModule: 'void*',
    szModule: koffi.array('uint16', 256),
    szExePath: koffi.array('uint16', 260),
});
exports.MODULEENTRY32W = MODULEENTRY32W;
/** MEMORY_BASIC_INFORMATION (x64)。sizeof = 48。 */
const MEMORY_BASIC_INFORMATION = koffi.struct('NCE_MEMORY_BASIC_INFORMATION', {
    BaseAddress: 'void*',
    AllocationBase: 'void*',
    AllocationProtect: 'uint32',
    PartitionId: 'uint16',
    __pad1: 'uint16',
    RegionSize: 'size_t',
    State: 'uint32',
    Protect: 'uint32',
    Type: 'uint32',
    __pad2: 'uint32',
});
exports.MEMORY_BASIC_INFORMATION = MEMORY_BASIC_INFORMATION;
/** SECURITY_ATTRIBUTES，用于 CreateFileMapping 共享内存。 */
const SECURITY_ATTRIBUTES = koffi.struct('NCE_SECURITY_ATTRIBUTES', {
    nLength: 'uint32',
    __pad: 'uint32',
    lpSecurityDescriptor: 'void*',
    bInheritHandle: 'bool',
    __pad2: 'uint8[7]',
});
exports.SECURITY_ATTRIBUTES = SECURITY_ATTRIBUTES;
/* ------------------------------------------------------------------ *
 * 函数绑定
 * ------------------------------------------------------------------ */
const k32 = koffi.load('kernel32.dll');
const psapi = (() => {
    try {
        return koffi.load('psapi.dll');
    }
    catch {
        return null;
    }
})();
/* —— 进程/线程/模块枚举 —— */
exports.CreateToolhelp32Snapshot = k32.func('CreateToolhelp32Snapshot', 'void*', [
    'uint32',
    'uint32',
]);
/**
 * 关于 koffi 的结构体出入参约定（实测结论，勿改）：
 *   - 用 `koffi.pointer(STRUCT)` 作为参数类型，**不要**再套 `koffi.out()`；
 *     套了 out() 会让 koffi 只写不回，传对象时字段读不到（全为 0/undefined）。
 *   - 调用时传一块 `Buffer`（首字节按结构体布局写入入参字段）最稳，
 *     也可以传 `koffi.alloc(STRUCT, 1)` 并用 `koffi.decode(ptr, STRUCT)` 取回。
 *   - 结构体返回值无法直接用 JS 对象承接，必须走上面两种方式之一。
 */
exports.Process32FirstW = k32.func('Process32FirstW', 'bool', [
    'void*',
    koffi.pointer(PROCESSENTRY32W),
]);
exports.Process32NextW = k32.func('Process32NextW', 'bool', [
    'void*',
    koffi.pointer(PROCESSENTRY32W),
]);
exports.Thread32First = k32.func('Thread32First', 'bool', [
    'void*',
    koffi.pointer(THREADENTRY32),
]);
exports.Thread32Next = k32.func('Thread32Next', 'bool', [
    'void*',
    koffi.pointer(THREADENTRY32),
]);
exports.Module32FirstW = k32.func('Module32FirstW', 'bool', [
    'void*',
    koffi.pointer(MODULEENTRY32W),
]);
exports.Module32NextW = k32.func('Module32NextW', 'bool', [
    'void*',
    koffi.pointer(MODULEENTRY32W),
]);
/* —— 进程句柄 —— */
exports.OpenProcess = k32.func('OpenProcess', 'void*', ['uint32', 'bool', 'uint32']);
exports.CloseHandle = k32.func('CloseHandle', 'bool', ['void*']);
exports.GetCurrentProcess = k32.func('GetCurrentProcess', 'void*', []);
exports.GetCurrentProcessId = k32.func('GetCurrentProcessId', 'uint32', []);
exports.GetProcessId = k32.func('GetProcessId', 'uint32', ['void*']);
exports.TerminateProcess = k32.func('TerminateProcess', 'bool', ['void*', 'uint32']);
exports.IsWow64Process = k32.func('IsWow64Process', 'bool', ['void*', koffi.out(koffi.pointer('int'))]);
/**
 * 等待一个内核对象（这里只用来判断**目标进程是否还活着**）。
 *
 * 超时给 0：进程已退出时返回 `WAIT_OBJECT_0`，仍存活时返回 `WAIT_TIMEOUT`。
 * 用它而不是 `GetExitCodeProcess`：不需要 out 参数缓冲区，语义更直接
 * （CE 内部判断目标存活走的也是 `WaitForSingleObject(h, 0)`）。
 */
exports.WaitForSingleObject = k32.func('WaitForSingleObject', 'uint32', ['void*', 'uint32']);
/** 等待结果：对象已 signaled（进程已退出） */
exports.WAIT_OBJECT_0 = 0;
/** 等待结果：超时（对象仍未 signaled，即进程还在跑） */
exports.WAIT_TIMEOUT = 0x102;
/* —— 内存读写 —— */
exports.ReadProcessMemory = k32.func('ReadProcessMemory', 'bool', [
    'void*',
    'void*',
    'void*',
    'size_t',
    koffi.out(koffi.pointer('size_t')),
]);
exports.WriteProcessMemory = k32.func('WriteProcessMemory', 'bool', [
    'void*',
    'void*',
    'void*',
    'size_t',
    koffi.out(koffi.pointer('size_t')),
]);
/* —— 内存区域 —— */
exports.VirtualQueryEx = k32.func('VirtualQueryEx', 'size_t', [
    'void*',
    'void*',
    koffi.pointer(MEMORY_BASIC_INFORMATION),
    'size_t',
]);
exports.VirtualProtectEx = k32.func('VirtualProtectEx', 'bool', [
    'void*',
    'void*',
    'size_t',
    'uint32',
    koffi.out(koffi.pointer('uint32')),
]);
exports.VirtualAllocEx = k32.func('VirtualAllocEx', 'void*', [
    'void*',
    'void*',
    'size_t',
    'uint32',
    'uint32',
]);
exports.VirtualFreeEx = k32.func('VirtualFreeEx', 'bool', ['void*', 'void*', 'size_t', 'uint32']);
/* —— 线程控制 —— */
exports.OpenThread = k32.func('OpenThread', 'void*', ['uint32', 'bool', 'uint32']);
exports.SuspendThread = k32.func('SuspendThread', 'uint32', ['void*']);
exports.ResumeThread = k32.func('ResumeThread', 'uint32', ['void*']);
exports.GetThreadContext = k32.func('GetThreadContext', 'bool', ['void*', 'void*']);
exports.SetThreadContext = k32.func('SetThreadContext', 'bool', ['void*', 'void*']);
/* —— 共享内存 / 派发 —— */
exports.CreateFileMappingW = k32.func('CreateFileMappingW', 'void*', [
    'void*',
    'void*',
    'uint32',
    'uint32',
    'uint32',
    'str16',
]);
exports.OpenFileMappingW = k32.func('OpenFileMappingW', 'void*', ['uint32', 'bool', 'str16']);
exports.MapViewOfFile = k32.func('MapViewOfFile', 'void*', [
    'void*',
    'uint32',
    'uint32',
    'uint32',
    'size_t',
]);
exports.UnmapViewOfFile = k32.func('UnmapViewOfFile', 'bool', ['void*']);
/* —— 错误处理 —— */
exports.GetLastError = k32.func('GetLastError', 'uint32', []);
/* —— 设备 I/O（内核驱动通信用） —— */
/**
 * `CreateFileW`。
 *
 * 用于打开内核驱动暴露的设备对象，例如 `\\.\CEDRIVER73`（CE 的 DBK 驱动）。
 * 句柄返回 `void*`，失败时是 `INVALID_HANDLE_VALUE`。
 */
exports.CreateFileW = k32.func('CreateFileW', 'void*', [
    'str16', // lpFileName
    'uint32', // dwDesiredAccess
    'uint32', // dwShareMode
    'void*', // lpSecurityAttributes（NULL）
    'uint32', // dwCreationDisposition（OPEN_EXISTING）
    'uint32', // dwFlagsAndAttributes（FILE_ATTRIBUTE_NORMAL）
    'void*', // hTemplateFile（NULL）
]);
/**
 * `DeviceIoControl`。
 *
 * 输入/输出缓冲区都按 `void*` 传：传 `Buffer` 时用 `bufferAsPointer(buf)` 换指针。
 * 对 `METHOD_BUFFERED` 的 ioctl，输入与输出都经系统缓冲区中转，
 * 因此**同一块 Buffer 同时当 in/out 是合法的** —— CE 的写内存就是这么用的
 * （`deviceiocontrol(hdevice, cc, @ao[0], 512, @ao[0], 512, br, nil)`）。
 */
exports.DeviceIoControl = k32.func('DeviceIoControl', 'bool', [
    'void*', // hDevice
    'uint32', // dwIoControlCode
    'void*', // lpInBuffer
    'uint32', // nInBufferSize
    'void*', // lpOutBuffer
    'uint32', // nOutBufferSize
    koffi.out(koffi.pointer('uint32')), // lpBytesReturned
    'void*', // lpOverlapped
]);
/* —— CreateFile / CreateFileMapping 用到的常量 —— */
/** 读写访问 */
exports.GENERIC_READ = 0x80000000;
exports.GENERIC_WRITE = 0x40000000;
/** 共享读写（CE 打开驱动时就是这么传的） */
exports.FILE_SHARE_READ = 0x00000001;
exports.FILE_SHARE_WRITE = 0x00000002;
/** `CREATE_EXISTING`：只打开已存在的设备，不创建 */
exports.CREATE_EXISTING = 3;
/** `FILE_ATTRIBUTE_NORMAL` */
exports.FILE_ATTRIBUTE_NORMAL = 0x00000080;
/** `INVALID_HANDLE_VALUE`（Win32 的 -1），用 bigint 表示避免 32 位截断 */
exports.INVALID_HANDLE_VALUE = -1n;
/* —— psapi 扩展 —— */
exports.GetModuleFileNameExW = psapi?.func('GetModuleFileNameExW', 'uint32', ['void*', 'void*', 'void*', 'uint32']) ?? null;
exports.EnumProcessModules = psapi?.func('EnumProcessModules', 'bool', ['void*', 'void*', 'uint32', koffi.out(koffi.pointer('uint32'))]) ?? null;
/* ------------------------------------------------------------------ *
 * 高层封装
 * ------------------------------------------------------------------ */
/** 把 Windows 错误码翻成可读文本。 */
const ERROR_MESSAGES = {
    2: '系统找不到指定的文件',
    5: '拒绝访问（权限不足，通常需要以管理员身份运行，或目标进程受保护）',
    6: '句柄无效',
    8: '内存不足',
    24: '程序发出命令，但命令长度不正确',
    87: '参数错误',
    998: '对内存位置的访问无效',
    299: '仅完成了部分 ReadProcessMemory 或 WriteProcessMemory 请求',
};
function win32ErrorMessage(code) {
    const known = ERROR_MESSAGES[code];
    return known ? `${known} (Win32 错误 ${code})` : `Win32 错误 ${code}`;
}
/** 读取一句话的当前错误。 */
function lastErrorMessage() {
    return win32ErrorMessage((0, exports.GetLastError)());
}
/** 判断句柄是否有效（koffi 返回 bigint 指针）。 */
function isValidHandle(h) {
    if (h === null || h === undefined)
        return false;
    if (typeof h === 'bigint')
        return h !== 0n && h !== 0xffffffffffffffffn;
    if (typeof h === 'number')
        return h !== 0 && h !== -1;
    return true;
}
/** 把 koffi 返回的指针/HANDLE 统一成 bigint。 */
function handleToBigInt(h) {
    if (typeof h === 'bigint')
        return h;
    if (typeof h === 'number')
        return BigInt(Math.trunc(h));
    if (h === null || h === undefined)
        return 0n;
    return BigInt(koffi.address(h));
}
/**
 * 把 bigint 地址转成 koffi 需要的指针参数。
 *
 * 关键约定（实测）：
 *   - `koffi.as(x, 'void*')` 只接受"外部指针/缓冲区"，传裸地址会抛错；
 *   - `koffi.address(x)` 是反方向（外部指针 → 地址），也不要在这里用；
 *   - koffi 直接接受 BigInt/number 作为指针参数的地址值，因此原样返回即可。
 */
function asPointer(addr) {
    return addr;
}
/**
 * 把 JS 缓冲区暴露为指针（用于把 Buffer 当作 OUT 参数传给原生函数）。
 * 与 asPointer 的区别：asPointer 转的是"裸地址"，这里转的是"缓冲区句柄"。
 */
function bufferAsPointer(buf) {
    return koffi.as(buf, 'void*');
}
/* —— 常量（供内部与其他模块复用） —— */
exports.TH32CS_SNAPPROCESS = 0x00000002;
exports.TH32CS_SNAPTHREAD = 0x00000004;
exports.TH32CS_SNAPMODULE = 0x00000008;
exports.TH32CS_SNAPMODULE32 = 0x00000010;
exports.TH32CS_SNAPALL = exports.TH32CS_SNAPPROCESS | exports.TH32CS_SNAPTHREAD | exports.TH32CS_SNAPMODULE | exports.TH32CS_SNAPMODULE32;
exports.THREAD_SUSPEND_RESUME = 0x0002;
exports.THREAD_GET_CONTEXT = 0x0008;
exports.THREAD_SET_CONTEXT = 0x0010;
exports.THREAD_QUERY_INFORMATION = 0x0040;
exports.MEM_RELEASE = 0x8000;
exports.MEM_RESERVE_FLAG = types_1.MEM_RESERVE;
exports.MEM_COMMIT_FLAG = types_1.MEM_COMMIT;
exports.PAGE_READONLY_FLAG = types_1.PAGE_READONLY;
exports.PAGE_READWRITE_FLAG = types_1.PAGE_READWRITE;
exports.PAGE_EXECUTE_FLAG = types_1.PAGE_EXECUTE;
exports.PAGE_EXECUTE_READ_FLAG = types_1.PAGE_EXECUTE_READ;
exports.PAGE_EXECUTE_READWRITE_FLAG = types_1.PAGE_EXECUTE_READWRITE;
exports.PAGE_PROTECTION_MASK = 0xff;
exports.PAGE_GUARD_FLAG = types_1.PAGE_GUARD;
exports.FILE_MAP_ALL_ACCESS = 0xf001f;
exports.PAGE_READWRITE_MAP = 0x04;
exports.MEM_STATE_NAMES = {
    [types_1.MEM_COMMIT]: 'MEM_COMMIT',
    [types_1.MEM_RESERVE]: 'MEM_RESERVE',
    [types_1.MEM_FREE]: 'MEM_FREE',
};
exports.MEM_TYPE_NAMES = {
    [types_1.MEM_IMAGE]: 'MEM_IMAGE',
    [types_1.MEM_MAPPED]: 'MEM_MAPPED',
    [types_1.MEM_PRIVATE]: 'MEM_PRIVATE',
    0: 'MEM_FREE',
};
exports.PAGE_PROTECT_NAMES = {
    [types_1.PAGE_NOACCESS]: 'PAGE_NOACCESS',
    [types_1.PAGE_READONLY]: 'PAGE_READONLY',
    [types_1.PAGE_READWRITE]: 'PAGE_READWRITE',
    [types_1.PAGE_WRITECOPY]: 'PAGE_WRITECOPY',
    [types_1.PAGE_EXECUTE]: 'PAGE_EXECUTE',
    [types_1.PAGE_EXECUTE_READ]: 'PAGE_EXECUTE_READ',
    [types_1.PAGE_EXECUTE_READWRITE]: 'PAGE_EXECUTE_READWRITE',
    [types_1.PAGE_EXECUTE_WRITECOPY]: 'PAGE_EXECUTE_WRITECOPY',
};
/** 常用进程访问权限（导出给调用方） */
exports.ACCESS = {
    TERMINATE: types_1.PROCESS_TERMINATE,
    CREATE_THREAD: types_1.PROCESS_CREATE_THREAD,
    VM_OPERATION: types_1.PROCESS_VM_OPERATION,
    VM_READ: types_1.PROCESS_VM_READ,
    VM_WRITE: types_1.PROCESS_VM_WRITE,
    QUERY_INFORMATION: types_1.PROCESS_QUERY_INFORMATION,
    QUERY_LIMITED_INFORMATION: types_1.PROCESS_QUERY_LIMITED_INFORMATION,
    SUSPEND_RESUME: types_1.PROCESS_SUSPEND_RESUME,
};
//# sourceMappingURL=winapi.js.map