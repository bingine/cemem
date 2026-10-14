/**
 * Lua 侧的内存属性层：保护属性解析、区域查询、分配/释放。
 *
 * 与 CE 的 `LuaHandler.pas` 里 `getMemoryProtection` / `setMemoryProtection` /
 * `fullAccess` / `allocateMemory` / `deAlloc` / `getRegionSize` 对齐。
 *
 * ## 为什么要单独成文件
 *
 * 这几组函数共享同一套底层能力（`Process.regions` / `Process.protect` /
 * `Process.allocate` / `Process.free`），并且都要处理**同一类语义问题**：
 * Win32 的页保护值是「一组位的组合」，而 CE 的 Lua 接口用的是**可读的名字**
 * （`'X' 'W' 'R' 'n'` 之类）。转换规则如果散落在各个 API 里，很容易出现
 * 「读的时候认得、的时候不认得」的不对称 bug，所以集中在这里维护。
 */
import type { Process } from '../win/process';
import { MEM_COMMIT, MEM_FREE, MEM_IMAGE, MEM_MAPPED, MEM_PRIVATE, MEM_RESERVE } from '../types';
/**
 * 把 CE 的保护属性名解析成 Win32 数值。
 *
 * 接受的写法（大小写不敏感）：
 *   `'X'` / `'WX'` / `'RWX'`      可执行 / 可写可执行 / 可读写可执行
 *   `'XW'`                        同上（顺序无关）
 *   `'?G'`                        PAGE_GUARD（CE 里 guard 用 `?G` 表示）
 *   数字 0x40                     原样使用（已带完整位，如 PAGE_GUARD 组合）
 *
 * @returns 数值；无法识别返回 null
 */
export declare function parseProtectName(input: string | number): number | null;
/**
 * Win32 保护值 → CE 风格的名字（`'?'` 无法直接展示，返回可读描述）。
 *
 * 优先用 CE 自己的字母序（`X`/`W`/`R`），因为脚本通常拿它做字符串比较。
 */
export declare function protectName(protect: number): string;
/** CE 的 `getMemoryProtection` 返回的是可读串，这里同时给出数值（供脚本精确比较）。 */
export declare function describeProtect(protect: number): {
    name: string;
    readable: boolean;
    writable: boolean;
    executable: boolean;
    guard: boolean;
};
/** CE 的 `getRegionSize(address)`：返回该地址所在区域的字节数。 */
export declare function regionSizeAt(proc: Process, address: bigint): number | null;
/** 找到覆盖某地址的区域。 */
export declare function regionAt(proc: Process, address: bigint): import("../types").MemoryRegion | null;
/** CE 的 `enumRegions` / `enumRegionsSQL`：返回目标进程已提交的区域列表。 */
export declare function enumRegions(proc: Process, filter?: {
    protection?: string;
    type?: string;
}): {
    StartAddress: bigint;
    EndAddress: bigint;
    Size: bigint;
    Protect: string;
    ProtectValue: number;
    Type: string;
    State: string;
}[];
export { MEM_COMMIT, MEM_RESERVE, MEM_FREE, MEM_IMAGE, MEM_MAPPED, MEM_PRIVATE };
//# sourceMappingURL=memory.d.ts.map