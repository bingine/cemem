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
import * as koffi from 'koffi';
declare const PROCESSENTRY32W: koffi.IKoffiCType;
declare const THREADENTRY32: koffi.IKoffiCType;
declare const MODULEENTRY32W: koffi.IKoffiCType;
/** MEMORY_BASIC_INFORMATION (x64)。sizeof = 48。 */
declare const MEMORY_BASIC_INFORMATION: koffi.IKoffiCType;
/** SECURITY_ATTRIBUTES，用于 CreateFileMapping 共享内存。 */
declare const SECURITY_ATTRIBUTES: koffi.IKoffiCType;
export declare const CreateToolhelp32Snapshot: koffi.KoffiFunction;
/**
 * 关于 koffi 的结构体出入参约定（实测结论，勿改）：
 *   - 用 `koffi.pointer(STRUCT)` 作为参数类型，**不要**再套 `koffi.out()`；
 *     套了 out() 会让 koffi 只写不回，传对象时字段读不到（全为 0/undefined）。
 *   - 调用时传一块 `Buffer`（首字节按结构体布局写入入参字段）最稳，
 *     也可以传 `koffi.alloc(STRUCT, 1)` 并用 `koffi.decode(ptr, STRUCT)` 取回。
 *   - 结构体返回值无法直接用 JS 对象承接，必须走上面两种方式之一。
 */
export declare const Process32FirstW: koffi.KoffiFunction;
export declare const Process32NextW: koffi.KoffiFunction;
export declare const Thread32First: koffi.KoffiFunction;
export declare const Thread32Next: koffi.KoffiFunction;
export declare const Module32FirstW: koffi.KoffiFunction;
export declare const Module32NextW: koffi.KoffiFunction;
export declare const OpenProcess: koffi.KoffiFunction;
export declare const CloseHandle: koffi.KoffiFunction;
export declare const GetCurrentProcess: koffi.KoffiFunction;
export declare const GetCurrentProcessId: koffi.KoffiFunction;
export declare const GetProcessId: koffi.KoffiFunction;
export declare const TerminateProcess: koffi.KoffiFunction;
export declare const IsWow64Process: koffi.KoffiFunction;
/**
 * 等待一个内核对象（这里只用来判断**目标进程是否还活着**）。
 *
 * 超时给 0：进程已退出时返回 `WAIT_OBJECT_0`，仍存活时返回 `WAIT_TIMEOUT`。
 * 用它而不是 `GetExitCodeProcess`：不需要 out 参数缓冲区，语义更直接
 * （CE 内部判断目标存活走的也是 `WaitForSingleObject(h, 0)`）。
 */
export declare const WaitForSingleObject: koffi.KoffiFunction;
/** 等待结果：对象已 signaled（进程已退出） */
export declare const WAIT_OBJECT_0 = 0;
/** 等待结果：超时（对象仍未 signaled，即进程还在跑） */
export declare const WAIT_TIMEOUT = 258;
export declare const ReadProcessMemory: koffi.KoffiFunction;
export declare const WriteProcessMemory: koffi.KoffiFunction;
export declare const VirtualQueryEx: koffi.KoffiFunction;
export declare const VirtualProtectEx: koffi.KoffiFunction;
export declare const VirtualAllocEx: koffi.KoffiFunction;
export declare const VirtualFreeEx: koffi.KoffiFunction;
export declare const OpenThread: koffi.KoffiFunction;
export declare const SuspendThread: koffi.KoffiFunction;
export declare const ResumeThread: koffi.KoffiFunction;
export declare const GetThreadContext: koffi.KoffiFunction;
export declare const SetThreadContext: koffi.KoffiFunction;
export declare const CreateFileMappingW: koffi.KoffiFunction;
export declare const OpenFileMappingW: koffi.KoffiFunction;
export declare const MapViewOfFile: koffi.KoffiFunction;
export declare const UnmapViewOfFile: koffi.KoffiFunction;
export declare const GetLastError: koffi.KoffiFunction;
/**
 * `CreateFileW`。
 *
 * 用于打开内核驱动暴露的设备对象，例如 `\\.\CEDRIVER73`（CE 的 DBK 驱动）。
 * 句柄返回 `void*`，失败时是 `INVALID_HANDLE_VALUE`。
 */
export declare const CreateFileW: koffi.KoffiFunction;
/**
 * `DeviceIoControl`。
 *
 * 输入/输出缓冲区都按 `void*` 传：传 `Buffer` 时用 `bufferAsPointer(buf)` 换指针。
 * 对 `METHOD_BUFFERED` 的 ioctl，输入与输出都经系统缓冲区中转，
 * 因此**同一块 Buffer 同时当 in/out 是合法的** —— CE 的写内存就是这么用的
 * （`deviceiocontrol(hdevice, cc, @ao[0], 512, @ao[0], 512, br, nil)`）。
 */
export declare const DeviceIoControl: koffi.KoffiFunction;
/** 读写访问 */
export declare const GENERIC_READ = 2147483648;
export declare const GENERIC_WRITE = 1073741824;
/** 共享读写（CE 打开驱动时就是这么传的） */
export declare const FILE_SHARE_READ = 1;
export declare const FILE_SHARE_WRITE = 2;
/** `CREATE_EXISTING`：只打开已存在的设备，不创建 */
export declare const CREATE_EXISTING = 3;
/** `FILE_ATTRIBUTE_NORMAL` */
export declare const FILE_ATTRIBUTE_NORMAL = 128;
/** `INVALID_HANDLE_VALUE`（Win32 的 -1），用 bigint 表示避免 32 位截断 */
export declare const INVALID_HANDLE_VALUE = -1n;
export declare const GetModuleFileNameExW: koffi.KoffiFunction | null;
export declare const EnumProcessModules: koffi.KoffiFunction | null;
export declare function win32ErrorMessage(code: number): string;
/** 读取一句话的当前错误。 */
export declare function lastErrorMessage(): string;
/** 判断句柄是否有效（koffi 返回 bigint 指针）。 */
export declare function isValidHandle(h: unknown): boolean;
/** 把 koffi 返回的指针/HANDLE 统一成 bigint。 */
export declare function handleToBigInt(h: unknown): bigint;
/**
 * 把 bigint 地址转成 koffi 需要的指针参数。
 *
 * 关键约定（实测）：
 *   - `koffi.as(x, 'void*')` 只接受"外部指针/缓冲区"，传裸地址会抛错；
 *   - `koffi.address(x)` 是反方向（外部指针 → 地址），也不要在这里用；
 *   - koffi 直接接受 BigInt/number 作为指针参数的地址值，因此原样返回即可。
 */
export declare function asPointer(addr: bigint): bigint;
/**
 * 把 JS 缓冲区暴露为指针（用于把 Buffer 当作 OUT 参数传给原生函数）。
 * 与 asPointer 的区别：asPointer 转的是"裸地址"，这里转的是"缓冲区句柄"。
 */
export declare function bufferAsPointer(buf: Buffer): unknown;
export declare const TH32CS_SNAPPROCESS = 2;
export declare const TH32CS_SNAPTHREAD = 4;
export declare const TH32CS_SNAPMODULE = 8;
export declare const TH32CS_SNAPMODULE32 = 16;
export declare const TH32CS_SNAPALL: number;
export declare const THREAD_SUSPEND_RESUME = 2;
export declare const THREAD_GET_CONTEXT = 8;
export declare const THREAD_SET_CONTEXT = 16;
export declare const THREAD_QUERY_INFORMATION = 64;
export declare const MEM_RELEASE = 32768;
export declare const MEM_RESERVE_FLAG = 8192;
export declare const MEM_COMMIT_FLAG = 4096;
export declare const PAGE_READONLY_FLAG = 2;
export declare const PAGE_READWRITE_FLAG = 4;
export declare const PAGE_EXECUTE_FLAG = 16;
export declare const PAGE_EXECUTE_READ_FLAG = 32;
export declare const PAGE_EXECUTE_READWRITE_FLAG = 64;
export declare const PAGE_PROTECTION_MASK = 255;
export declare const PAGE_GUARD_FLAG = 256;
export declare const FILE_MAP_ALL_ACCESS = 983071;
export declare const PAGE_READWRITE_MAP = 4;
export declare const MEM_STATE_NAMES: Record<number, string>;
export declare const MEM_TYPE_NAMES: Record<number, string>;
export declare const PAGE_PROTECT_NAMES: Record<number, string>;
/** 常用进程访问权限（导出给调用方） */
export declare const ACCESS: {
    readonly TERMINATE: 1;
    readonly CREATE_THREAD: 2;
    readonly VM_OPERATION: 8;
    readonly VM_READ: 16;
    readonly VM_WRITE: 32;
    readonly QUERY_INFORMATION: 1024;
    readonly QUERY_LIMITED_INFORMATION: 4096;
    readonly SUSPEND_RESUME: 2048;
};
export { PROCESSENTRY32W, THREADENTRY32, MODULEENTRY32W, MEMORY_BASIC_INFORMATION, SECURITY_ATTRIBUTES, koffi, };
//# sourceMappingURL=winapi.d.ts.map