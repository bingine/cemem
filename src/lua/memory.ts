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
import {
  MEM_COMMIT,
  MEM_FREE,
  MEM_IMAGE,
  MEM_MAPPED,
  MEM_PRIVATE,
  MEM_RESERVE,
  PAGE_EXECUTE,
  PAGE_EXECUTE_READ,
  PAGE_EXECUTE_READWRITE,
  PAGE_EXECUTE_WRITECOPY,
  PAGE_GUARD,
  PAGE_NOACCESS,
  PAGE_READONLY,
  PAGE_READWRITE,
  PAGE_WRITECOPY,
} from '../types';

/* ------------------------------------------------------------------ *
 * 保护属性：数值 ↔ 名字
 * ------------------------------------------------------------------ */

/** 保护属性名 → 数值。名字与 CE Lua 脚本里常用的写法一致。 */
const PROTECT_BY_NAME: Record<string, number> = {
  n: PAGE_NOACCESS,
  na: PAGE_NOACCESS,
  noaccess: PAGE_NOACCESS,
  r: PAGE_READONLY,
  ro: PAGE_READONLY,
  readonly: PAGE_READONLY,
  w: PAGE_READWRITE,
  rw: PAGE_READWRITE,
  readwrite: PAGE_READWRITE,
  wc: PAGE_WRITECOPY,
  wcw: PAGE_WRITECOPY,
  writecopy: PAGE_WRITECOPY,
  x: PAGE_EXECUTE,
  rwx: PAGE_EXECUTE_READWRITE,
  xw: PAGE_EXECUTE_READWRITE,
  execute_readwrite: PAGE_EXECUTE_READWRITE,
  rx: PAGE_EXECUTE_READ,
  xr: PAGE_EXECUTE_READ,
  execute_read: PAGE_EXECUTE_READ,
  wcx: PAGE_EXECUTE_WRITECOPY,
  xcw: PAGE_EXECUTE_WRITECOPY,
  execute_writecopy: PAGE_EXECUTE_WRITECOPY,
  guard: PAGE_GUARD,
  '?g': PAGE_GUARD,
};

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
export function parseProtectName(input: string | number): number | null {
  if (typeof input === 'number') {
    return Number.isInteger(input) ? input : null;
  }
  const text = input.trim();
  if (text === '') return null;

  // 纯数字：支持十进制与 0x 前缀（脚本里常写 setMemoryProtection(a, 4096, 0x40)）
  if (/^(0x[0-9a-f]+|\d+)$/i.test(text)) {
    const n = Number(text);
    return Number.isInteger(n) ? n : null;
  }

  const key = text.toLowerCase();
  const direct = PROTECT_BY_NAME[key];
  if (direct !== undefined) return direct;

  // 组合式：按字符集合推导（例如 'RWX'、'XW'、'WX'）
  const has = (c: string): boolean => key.includes(c);
  const guard = has('g') || key.includes('?');
  const exec = has('x');
  const write = has('w');
  const read = has('r') || !exec;

  if (has('c')) {
    // copy-on-write：写但不共享
    if (exec) return PAGE_EXECUTE_WRITECOPY | (guard ? PAGE_GUARD : 0);
    return PAGE_WRITECOPY | (guard ? PAGE_GUARD : 0);
  }
  if (exec && write) return PAGE_EXECUTE_READWRITE | (guard ? PAGE_GUARD : 0);
  if (exec) return PAGE_EXECUTE_READ | (guard ? PAGE_GUARD : 0);
  if (write) return PAGE_READWRITE | (guard ? PAGE_GUARD : 0);
  if (has('n') || key.includes('noaccess')) return PAGE_NOACCESS;
  return PAGE_READONLY | (guard ? PAGE_GUARD : 0);
}

/**
 * Win32 保护值 → CE 风格的名字（`'?'` 无法直接展示，返回可读描述）。
 *
 * 优先用 CE 自己的字母序（`X`/`W`/`R`），因为脚本通常拿它做字符串比较。
 */
export function protectName(protect: number): string {
  if (protect & PAGE_GUARD) return 'G';
  const base = protect & 0xff;
  switch (base) {
    case PAGE_NOACCESS:
      return 'n';
    case PAGE_READONLY:
      return 'R';
    case PAGE_READWRITE:
      return 'RW';
    case PAGE_WRITECOPY:
      return 'WC';
    case PAGE_EXECUTE:
      return 'X';
    case PAGE_EXECUTE_READ:
      return 'RX';
    case PAGE_EXECUTE_READWRITE:
      return 'RWX';
    case PAGE_EXECUTE_WRITECOPY:
      return 'WCX';
    default:
      return `?0x${protect.toString(16)}`;
  }
}

/** CE 的 `getMemoryProtection` 返回的是可读串，这里同时给出数值（供脚本精确比较）。 */
export function describeProtect(protect: number): { name: string; readable: boolean; writable: boolean; executable: boolean; guard: boolean } {
  const base = protect & 0xff;
  return {
    name: protectName(protect),
    readable: base !== PAGE_NOACCESS && base !== 0 && !(protect & PAGE_GUARD),
    writable: base === PAGE_READWRITE || base === PAGE_WRITECOPY || base === PAGE_EXECUTE_READWRITE || base === PAGE_EXECUTE_WRITECOPY,
    executable: base === PAGE_EXECUTE || base === PAGE_EXECUTE_READ || base === PAGE_EXECUTE_READWRITE || base === PAGE_EXECUTE_WRITECOPY,
    guard: (protect & PAGE_GUARD) !== 0,
  };
}

/* ------------------------------------------------------------------ *
 * 区域查询
 * ------------------------------------------------------------------ */

/** CE 的 `getRegionSize(address)`：返回该地址所在区域的字节数。 */
export function regionSizeAt(proc: Process, address: bigint): number | null {
  // 不必扫全量区域：VirtualQueryEx 语义下相邻区域按 64KB 对齐，
  // 但精确做法仍然是遍历，这里限制只找第一个覆盖该地址的区域。
  for (const r of proc.regions({ includeFree: false })) {
    if (address >= r.baseAddress && address < r.baseAddress + r.memorySize) {
      return Number(r.memorySize);
    }
  }
  return null;
}

/** 找到覆盖某地址的区域。 */
export function regionAt(proc: Process, address: bigint) {
  for (const r of proc.regions({ includeFree: false })) {
    if (address >= r.baseAddress && address < r.baseAddress + r.memorySize) return r;
  }
  return null;
}

/** CE 的 `enumRegions` / `enumRegionsSQL`：返回目标进程已提交的区域列表。 */
export function enumRegions(proc: Process, filter: { protection?: string; type?: string } = {}) {
  let wanted: number | null = null;
  if (filter.type) {
    const t = filter.type.trim().toUpperCase();
    const map: Record<string, number> = {
      MEM_IMAGE: MEM_IMAGE,
      MEM_MAPPED: MEM_MAPPED,
      MEM_PRIVATE: MEM_PRIVATE,
    };
    wanted = map[t] ?? null;
  }
  const out = proc
    .regions({ includeFree: false })
    .filter((r) => r.committed || r.type !== MEM_FREE)
    .filter((r) => wanted === null || r.type === wanted)
    .map((r) => ({
      StartAddress: r.baseAddress,
      EndAddress: r.baseAddress + r.memorySize - 1n,
      Size: r.memorySize,
      Protect: describeProtect(r.protect).name,
      ProtectValue: r.protect,
      Type: regionTypeName(r.type),
      State: r.committed ? 'MEM_COMMIT' : 'MEM_RESERVE',
    }));
  if (filter.protection) {
    const want = parseProtectName(filter.protection);
    return want === null ? out : out.filter((r) => (r.ProtectValue & 0xff) === (want & 0xff));
  }
  return out;
}

function regionTypeName(type: number): string {
  if (type === MEM_IMAGE) return 'MEM_IMAGE';
  if (type === MEM_MAPPED) return 'MEM_MAPPED';
  if (type === MEM_PRIVATE) return 'MEM_PRIVATE';
  return `0x${type.toString(16)}`;
}

export { MEM_COMMIT, MEM_RESERVE, MEM_FREE, MEM_IMAGE, MEM_MAPPED, MEM_PRIVATE };
