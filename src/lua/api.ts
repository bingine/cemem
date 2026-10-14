/**
 * Cheat Engine Lua API 的 Node 版实现（子集）。
 *
 * 约定（与 CE 官方 Lua API 的对齐与差异都写在 docs/lua-api.md）：
 *   - 参数顺序尽量与 CE 一致，方便直接搬运脚本；
 *   - 读内存失败返回 nil（CE 风格）；参数错误 / 地址无法解析直接抛 Lua 错误
 *     （CE 的 getAddress 也是抛错，脚本可以用 pcall 捕获）；
 *   - 地址参数可以是整数，也可以是字符串表达式（'base+40'、'kernel32.dll+1000'、'mySymbol'）。
 *
 * 类型映射：
 *   - readInteger 返回 32 位整数，**默认按有符号解释**（signed=true）；
 *     CE 官方默认 signed=false（返回 dword）。这是本移植与 CE 的**有意差异**，
 *     需要无符号语义时显式传 readInteger(addr, false)。
 *   - readByte / readSmallInteger 保持 CE 默认（无符号）。
 *   - readQword 返回 64 位整数（Lua 5.4 的 integer 是 int64，超出 2^63-1 按位回绕）。
 */

import { uptime } from 'node:os';
import { Process, listProcesses } from '../win/process';
import { AddressResolver } from './addressing';
import { MultiReturn, type ApiContext, type LuaValue } from './types';
import { describeError, describeValue, type LuaMarshal } from './marshal';
import { LuaAddressList, LuaScanSession, LuaStringList, type RecordHost } from './objects';
import {
  addressToCeHex,
  parseScanConfig,
  scanAob,
  scanAobFirst,
  type AobScanOptions,
} from './scan';
import { createAutoAssemblerApi, type LuaAutoAssembler } from './aa';
import {
  describeProtect,
  enumRegions,
  parseProtectName,
  regionAt,
  regionSizeAt,
} from './memory';
import { createAsmApi } from './asm';

/** 一个 CE Lua API 函数的实现签名。 */
export type ApiFunction = (args: LuaValue[], m: LuaMarshal) => LuaValue | MultiReturn | void;

/** 引擎当前的最后一条错误信息（对齐 CE 的 getLastError 思路）。 */
export class ErrorSink {
  private message = '';
  set(text: string): void {
    this.message = text;
  }
  clear(): void {
    this.message = '';
  }
  get(): string {
    return this.message;
  }
}

export interface ApiBundle {
  functions: Record<string, ApiFunction>;
  errorSink: ErrorSink;
  resolver: AddressResolver;
  /** 共享的地址列表（getAddressList 每次返回同一个对象，和 CE 一致） */
  addressList: LuaAddressList;
  /** Auto Assembler 绑定实例（LuaEngine 换进程时需要 invalidate） */
  autoAssembler: LuaAutoAssembler;
}

/**
 * 创建全部 API 函数。
 *
 * @param ctx 引擎能力（进程、符号表、扫描会话、输出）
 */
export function createApi(ctx: ApiContext): ApiBundle {
  const errorSink = new ErrorSink();
  const resolver = new AddressResolver({
    symbols: ctx.symbols,
    findModule: (name) => ctx.findModule(name),
  });

  const recordHost: RecordHost = {
    resolve: (expr) => resolver.resolve(expr),
    read: (addr, size) => ctx.requireProcess().readMemory(addr, size),
    write: (addr, data) => ctx.requireProcess().writeMemory(addr, data),
  };
  const addressList = new LuaAddressList(recordHost);

  /** 解析地址参数：整数或字符串表达式；失败抛 Lua 错误。 */
  const addrOf = (m: LuaMarshal, args: LuaValue[], n: number, funcName: string): bigint => {
    const v = m.requireArg(args, n, funcName);
    try {
      return resolver.resolve(v);
    } catch (e) {
      m.raise(`${funcName}: ${describeError(e)}`);
    }
  };

  /** 读一段内存；长度不足视为失败返回 null（CE 风格）。 */
  const readOrNull = (addr: bigint, size: number): Buffer | null => {
    const proc = ctx.currentProcess();
    if (!proc || size < 0) return null;
    const buf = proc.readMemory(addr, size);
    return buf.length === size ? buf : null;
  };

  /** 写字节；失败返回 null。 */
  const writeBytesAt = (addr: bigint, data: Buffer): number | null => {
    try {
      return ctx.requireProcess().writeMemory(addr, data);
    } catch (e) {
      errorSink.set(describeError(e));
      return null;
    }
  };

  /** 读取整数（按宽度与符号）。 */
  const readInt = (addr: bigint, size: number, signed: boolean): bigint | null => {
    const buf = readOrNull(addr, size);
    if (!buf) return null;
    switch (size) {
      case 1:
        return signed ? BigInt(buf.readInt8(0)) : BigInt(buf.readUInt8(0));
      case 2:
        return signed ? BigInt(buf.readInt16LE(0)) : BigInt(buf.readUInt16LE(0));
      case 4:
        return signed ? BigInt(buf.readInt32LE(0)) : BigInt(buf.readUInt32LE(0));
      default:
        return signed ? buf.readBigInt64LE(0) : buf.readBigUInt64LE(0);
    }
  };

  /** 写整数（按宽度回绕，与 CE 的隐式截断一致）。 */
  const writeInt = (addr: bigint, value: bigint, size: number): boolean => {
    const buf = Buffer.alloc(size);
    const v = BigInt.asUintN(size * 8, value);
    if (size === 1) buf.writeUInt8(Number(v), 0);
    else if (size === 2) buf.writeUInt16LE(Number(v), 0);
    else if (size === 4) buf.writeUInt32LE(Number(v), 0);
    else buf.writeBigUInt64LE(v, 0);
    return writeBytesAt(addr, buf) !== null;
  };

  /** 组装 AOB 扫描参数。 */
  const aobOptions = (
    m: LuaMarshal,
    patternIndex: number,
    protectionIndex: number,
    alignmentIndex: number,
    alignParamIndex: number,
    funcName: string,
    args: LuaValue[],
    defaults: { protection?: string; moduleName?: string; unique?: boolean } = {},
  ): AobScanOptions => {
    const findModule = (name: string): { baseAddress: bigint; size: number } => {
      const mod = ctx.findModule(name);
      if (!mod) m.raise(`${funcName}: 找不到模块 "${name}"`);
      return { baseAddress: mod.baseAddress, size: mod.size };
    };
    return {
      pattern: m.argToString(args, patternIndex, funcName),
      protection:
        args[protectionIndex - 1] === undefined
          ? defaults.protection ?? ''
          : m.argToString(args, protectionIndex, funcName),
      alignmentType: args[alignmentIndex - 1] === undefined ? 0 : m.argToInt(args, alignmentIndex, funcName, 0),
      alignmentParam:
        args[alignParamIndex - 1] === undefined ? '1' : m.argToString(args, alignParamIndex, funcName, '1'),
      moduleName: defaults.moduleName,
      unique: defaults.unique,
      findModule,
    };
  };

  const functions: Record<string, ApiFunction> = {
    /* ---------------- 进程 ---------------- */

    openProcess(args, m) {
      const target = m.requireArg(args, 1, 'openProcess');
      errorSink.clear();
      let pid: number;
      if (typeof target === 'string') {
        const found = findProcessId(target);
        if (found === null) {
          errorSink.set(`找不到进程：${target}`);
          return false;
        }
        pid = found;
      } else if (typeof target === 'number' || typeof target === 'bigint') {
        pid = Number(target);
      } else {
        m.raise(`openProcess: 参数必须是进程名或进程号，收到 ${target === null ? 'nil' : typeof target}`);
        // m.raise 会抛错，这里给 TS 一个明确赋值以满足严格模式
        pid = 0;
      }
      try {
        const proc = Process.open(pid);
        ctx.attachProcess(proc);
        return true;
      } catch (e) {
        errorSink.set(describeError(e));
        return false;
      }
    },

    closeProcess() {
      const proc = ctx.currentProcess();
      if (proc) {
        ctx.attachProcess(null);
        proc.close();
      }
      return true;
    },

    getOpenedProcessID() {
      return BigInt(ctx.processId());
    },

    getOpenedProcessHandle() {
      const proc = ctx.currentProcess();
      if (!proc) return 0n;
      // 暴露"后端句柄 id"作为整数；原生 CE 后端下对应 ceserver 侧的句柄值
      return BigInt(proc.backendHandle.id);
    },

    getProcessName() {
      const proc = ctx.currentProcess();
      return proc ? proc.name : null;
    },

    getProcessIDFromProcessName(args, m) {
      const pid = findProcessId(m.argToString(args, 1, 'getProcessIDFromProcessName'));
      return pid === null ? null : BigInt(pid);
    },

    getProcessList() {
      const out = new Map<LuaValue, LuaValue>();
      for (const p of listProcesses()) out.set(BigInt(p.pid), p.name);
      return out;
    },

    targetIs64Bit() {
      const proc = ctx.currentProcess();
      return proc ? !proc.isWow64() : false;
    },

    cheatEngineIs64Bit() {
      return process.arch === 'x64' || process.arch === 'arm64';
    },

    /* ---------------- 读内存 ---------------- */

    readBytes(args, m) {
      const addr = addrOf(m, args, 1, 'readBytes');
      const count = m.argToInt(args, 2, 'readBytes', 1);
      const asTable = args[2] === undefined ? true : m.argToBoolean(args, 3, true);
      if (count < 0) m.raise(`readBytes: 字节数不能为负：${count}`);
      const buf = readOrNull(addr, count);
      if (!buf) return null;
      const bytes: LuaValue[] = [...buf].map((b) => BigInt(b));
      return asTable ? bytes : new MultiReturn(...bytes);
    },

    readByte(args, m) {
      const addr = addrOf(m, args, 1, 'readByte');
      const signed = args[1] === undefined ? false : m.argToBoolean(args, 2, false);
      return readInt(addr, 1, signed);
    },

    readShortInteger(args, m) {
      const addr = addrOf(m, args, 1, 'readShortInteger');
      const signed = args[1] === undefined ? false : m.argToBoolean(args, 2, false);
      return readInt(addr, 1, signed);
    },

    readSmallInteger(args, m) {
      const addr = addrOf(m, args, 1, 'readSmallInteger');
      const signed = args[1] === undefined ? false : m.argToBoolean(args, 2, false);
      return readInt(addr, 2, signed);
    },

    /** 注意：默认 signed=true，与 CE 官方（false）相反，见文件头说明。 */
    readInteger(args, m) {
      const addr = addrOf(m, args, 1, 'readInteger');
      const signed = args[1] === undefined ? true : m.argToBoolean(args, 2, true);
      return readInt(addr, 4, signed);
    },

    readQword(args, m) {
      const addr = addrOf(m, args, 1, 'readQword');
      const v = readInt(addr, 8, false);
      return v === null ? null : BigInt.asIntN(64, v);
    },

    readPointer(args, m) {
      const addr = addrOf(m, args, 1, 'readPointer');
      const proc = ctx.currentProcess();
      if (!proc) return null;
      return proc.isWow64() ? readInt(addr, 4, false) : readInt(addr, 8, false);
    },

    readFloat(args, m) {
      const addr = addrOf(m, args, 1, 'readFloat');
      const buf = readOrNull(addr, 4);
      return buf ? buf.readFloatLE(0) : null;
    },

    readDouble(args, m) {
      const addr = addrOf(m, args, 1, 'readDouble');
      const buf = readOrNull(addr, 8);
      return buf ? buf.readDoubleLE(0) : null;
    },

    /** readString(address [, maxlength=50 [, widechar=false]]) */
    readString(args, m) {
      const addr = addrOf(m, args, 1, 'readString');
      const maxLength = m.argToInt(args, 2, 'readString', 50);
      const wide = args[2] === undefined ? false : m.argToBoolean(args, 3, false);
      if (maxLength < 0) m.raise(`readString: 长度不能为负：${maxLength}`);
      // CE：widechar 时 maxsize := maxsize + 1（按字符计）
      const chars = wide ? maxLength + 1 : maxLength;
      const buf = readOrNull(addr, wide ? chars * 2 : chars);
      if (!buf) return null;
      if (wide) {
        let end = buf.length;
        for (let i = 0; i + 1 < buf.length; i += 2) {
          if (buf.readUInt16LE(i) === 0) {
            end = i;
            break;
          }
        }
        return buf.toString('utf16le', 0, end);
      }
      const nul = buf.indexOf(0);
      return buf.toString('latin1', 0, nul === -1 ? buf.length : nul);
    },

    /* ---------------- 写内存 ---------------- */

    writeBytes(args, m) {
      const addr = addrOf(m, args, 1, 'writeBytes');
      const bytes = collectBytes(m, args, 2, 'writeBytes');
      if (bytes.length === 0) return 0n;
      const written = writeBytesAt(addr, Buffer.from(bytes));
      return BigInt(written ?? 0);
    },

    writeByte(args, m) {
      return writeInt(addrOf(m, args, 1, 'writeByte'), m.argToBigInt(args, 2, 'writeByte'), 1);
    },

    writeShortInteger(args, m) {
      return writeInt(addrOf(m, args, 1, 'writeShortInteger'), m.argToBigInt(args, 2, 'writeShortInteger'), 1);
    },

    writeSmallInteger(args, m) {
      return writeInt(addrOf(m, args, 1, 'writeSmallInteger'), m.argToBigInt(args, 2, 'writeSmallInteger'), 2);
    },

    writeInteger(args, m) {
      return writeInt(addrOf(m, args, 1, 'writeInteger'), m.argToBigInt(args, 2, 'writeInteger'), 4);
    },

    writeQword(args, m) {
      return writeInt(addrOf(m, args, 1, 'writeQword'), m.argToBigInt(args, 2, 'writeQword'), 8);
    },

    writePointer(args, m) {
      const addr = addrOf(m, args, 1, 'writePointer');
      const proc = ctx.currentProcess();
      const size = proc && proc.isWow64() ? 4 : 8;
      return writeInt(addr, m.argToBigInt(args, 2, 'writePointer'), size);
    },

    writeFloat(args, m) {
      const addr = addrOf(m, args, 1, 'writeFloat');
      const buf = Buffer.alloc(4);
      buf.writeFloatLE(m.argToNumber(args, 2, 'writeFloat'), 0);
      return writeBytesAt(addr, buf) !== null;
    },

    writeDouble(args, m) {
      const addr = addrOf(m, args, 1, 'writeDouble');
      const buf = Buffer.alloc(8);
      buf.writeDoubleLE(m.argToNumber(args, 2, 'writeDouble'), 0);
      return writeBytesAt(addr, buf) !== null;
    },

    /** writeString(address, text [, widechar=false]) —— 不写结尾的 \0（与 CE 一致） */
    writeString(args, m) {
      const addr = addrOf(m, args, 1, 'writeString');
      const text = m.argToString(args, 2, 'writeString');
      const wide = args[2] === undefined ? false : m.argToBoolean(args, 3, false);
      const buf = wide ? Buffer.from(text, 'utf16le') : Buffer.from(text, 'latin1');
      return writeBytesAt(addr, buf) !== null;
    },

    /* ---------------- 地址 ---------------- */

    getAddress(args, m) {
      return addrOf(m, args, 1, 'getAddress');
    },

    getAddressSafe(args) {
      return args[0] === undefined ? null : resolver.tryResolve(args[0]);
    },

    getModuleBase(args) {
      const name = typeof args[0] === 'string' ? args[0] : String(args[0] ?? '');
      const mod = ctx.findModule(name);
      return mod ? mod.baseAddress : null;
    },

    getModuleSize(args) {
      const name = typeof args[0] === 'string' ? args[0] : String(args[0] ?? '');
      const mod = ctx.findModule(name);
      return mod ? BigInt(mod.size) : null;
    },

    enumModules() {
      return ctx.listModules().map((mod) => ({
        Name: mod.name,
        Address: mod.baseAddress,
        Size: BigInt(mod.size),
        Path: mod.path,
      }));
    },

    /** 地址落在哪个模块里（`module.dll+1A2B`），不在任何模块里返回 nil。 */
    getNameFromAddress(args, m) {
      const addr = addrOf(m, args, 1, 'getNameFromAddress');
      return moduleRelativeName(ctx, addr);
    },

    inModule(args, m) {
      return moduleRelativeName(ctx, addrOf(m, args, 1, 'inModule')) !== null;
    },

    /* ---------------- 内存属性（保护 / 区域 / 分配） ---------------- */

    /**
     * `getMemoryProtection(address)` → 可读的保护属性名（`'RW'`/`'RWX'`/`'n'`…）。
     * 找不到区域返回 nil。数值版本见 `getMemoryProtectionInfo`。
     */
    getMemoryProtection(args, m) {
      const addr = addrOf(m, args, 1, 'getMemoryProtection');
      const region = regionAt(ctx.requireProcess(), addr);
      return region ? describeProtect(region.protect).name : null;
    },

    /**
     * 本移植扩展：`getMemoryProtectionInfo(address)` → 带数值与布尔位的完整描述。
     * 脚本要精确比较 Win32 数值时用它，比字符串名字可靠。
     */
    getMemoryProtectionInfo(args, m) {
      const addr = addrOf(m, args, 1, 'getMemoryProtectionInfo');
      const region = regionAt(ctx.requireProcess(), addr);
      if (!region) return null;
      return { ...describeProtect(region.protect), value: region.protect };
    },

    /**
     * `setMemoryProtection(address, protection)` → 旧的保护属性名。
     * 第二个参数接受 CE 的名字（`'RWX'`）或 Win32 数值（`0x40`）。
     * 注意：只对**一整页**生效（Windows 页粒度），与 CE 行为一致。
     */
    setMemoryProtection(args, m) {
      const addr = addrOf(m, args, 1, 'setMemoryProtection');
      const raw = m.requireArg(args, 2, 'setMemoryProtection');
      const parsed = parseProtectName(typeof raw === 'bigint' || typeof raw === 'number' ? Number(raw) : String(raw));
      if (parsed === null) {
        m.raise(`setMemoryProtection: 无法识别的保护属性：${describeValue(raw)}`);
      }
      const region = regionAt(ctx.requireProcess(), addr);
      const size = region ? Number(region.memorySize) : 0x1000;
      try {
        // parsed 在上方的 null 分支已 raise；此处用 ?? 兜底仅为满足 TS 收窄
        const old = ctx.requireProcess().protect(addr, size, parsed ?? 0x04);
        return describeProtect(old).name;
      } catch (e) {
        errorSink.set(describeError(e));
        m.raise(`setMemoryProtection: ${describeError(e)}`);
      }
    },

    /**
     * `fullAccess(address)` → 把该地址所在页改成 `RWX`，返回旧保护属性名。
     * 常用于给自修改代码 / hook 打补丁。
     */
    fullAccess(args, m) {
      const addr = addrOf(m, args, 1, 'fullAccess');
      const region = regionAt(ctx.requireProcess(), addr);
      const size = region ? Number(region.memorySize) : 0x1000;
      try {
        const old = ctx.requireProcess().protect(addr, size, 0x40 /* PAGE_EXECUTE_READWRITE */);
        return describeProtect(old).name;
      } catch (e) {
        errorSink.set(describeError(e));
        m.raise(`fullAccess: ${describeError(e)}`);
      }
    },

    /** `getRegionSize(address)` → 该地址所在区域的字节数。 */
    getRegionSize(args, m) {
      const addr = addrOf(m, args, 1, 'getRegionSize');
      const size = regionSizeAt(ctx.requireProcess(), addr);
      return size === null ? null : BigInt(size);
    },

    /**
     * 本移植扩展：`enumRegions([filterTable])`。
     * filterTable 支持 `{ protection='RWX', type='MEM_PRIVATE' }`，均可省略。
     */
    enumRegions(args) {
      const table = args[0];
      const filter: { protection?: string; type?: string } = {};
      if (table && typeof table === 'object' && !Array.isArray(table)) {
        const t = table as Record<string, LuaValue>;
        if (typeof t.protection === 'string') filter.protection = t.protection;
        if (typeof t.type === 'string') filter.type = t.type;
      }
      return enumRegions(ctx.requireProcess(), filter);
    },

    /**
     * `allocateMemory(size [, protection])` → 在目标进程里分配一块内存的地址。
     * `protection` 默认 `'RWX'`（与 CE 一致：hook 场景最常用）。
     *
     * ⚠️ 分配结果**不会自动释放**：脚本结束/引擎销毁都不会 free，
     * 必须自己调用 `deAlloc(addr)`，否则目标进程会一直泄漏这段内存。
     */
    allocateMemory(args, m) {
      const size = m.argToInt(args, 1, 'allocateMemory');
      if (size <= 0) {
        m.raise(`allocateMemory: 大小必须为正数，收到 ${size}`);
      }
      const raw = args[1];
      const parsed = parseProtectName(
        raw === undefined || raw === null ? 'RWX' : typeof raw === 'bigint' || typeof raw === 'number' ? Number(raw) : String(raw),
      );
      if (parsed === null) {
        m.raise(`allocateMemory: 无法识别的保护属性：${describeValue(raw)}`);
      }
      try {
        // 同上：null 分支已 raise，兜底仅为满足 TS 收窄
        return ctx.requireProcess().allocate(size, parsed ?? 0x40);
      } catch (e) {
        errorSink.set(describeError(e));
        m.raise(`allocateMemory: ${describeError(e)}`);
      }
    },

    /** `deAlloc(address)` → 释放 allocateMemory 分配的内存，成功 true。 */
    deAlloc(args, m) {
      const addr = addrOf(m, args, 1, 'deAlloc');
      try {
        ctx.requireProcess().free(addr);
        return true;
      } catch (e) {
        errorSink.set(describeError(e));
        return false;
      }
    },

    /* ---------------- 符号 ---------------- */

    registerSymbol(args, m) {
      const name = m.argToString(args, 1, 'registerSymbol');
      const target = m.requireArg(args, 2, 'registerSymbol');
      try {
        ctx.symbols.register(name, resolver.resolve(target));
        return true;
      } catch (e) {
        errorSink.set(describeError(e));
        return new MultiReturn(false, describeError(e));
      }
    },

    unregisterSymbol(args, m) {
      ctx.symbols.unregister(m.argToString(args, 1, 'unregisterSymbol'));
    },

    getSymbols() {
      return ctx.symbols.entries().map(([name, address]) => ({ Name: name, Address: address }));
    },

    enumRegisteredSymbols() {
      return ctx.symbols.entries().map(([name, address]) => ({ name, address }));
    },

    deleteAllRegisteredSymbols() {
      ctx.symbols.clear();
    },

    /* ---------------- 扫描 ---------------- */

    AOBScan(args, m) {
      const opts = aobOptions(m, 1, 2, 3, 4, 'AOBScan', args);
      const hits = scanAob(ctx.requireProcess(), ctx.scanner, m, opts);
      return new LuaStringList(hits.map(addressToCeHex));
    },

    AOBScanUnique(args, m) {
      const opts = aobOptions(m, 1, 2, 3, 4, 'AOBScanUnique', args, { unique: true });
      return scanAobFirst(ctx.requireProcess(), ctx.scanner, m, opts);
    },

    /** 扩展：CE 只有 AOBScanModuleUnique，这里补一个返回 StringList 的版本。 */
    AOBScanModule(args, m) {
      const opts = aobOptions(m, 2, 3, 4, 5, 'AOBScanModule', args, {
        moduleName: m.argToString(args, 1, 'AOBScanModule'),
        protection: '*X*W*C',
      });
      const hits = scanAob(ctx.requireProcess(), ctx.scanner, m, opts);
      return new LuaStringList(hits.map(addressToCeHex));
    },

    AOBScanModuleUnique(args, m) {
      const opts = aobOptions(m, 2, 3, 4, 5, 'AOBScanModuleUnique', args, {
        moduleName: m.argToString(args, 1, 'AOBScanModuleUnique'),
        protection: '*X*W*C',
        unique: true,
      });
      return scanAobFirst(ctx.requireProcess(), ctx.scanner, m, opts);
    },

    /* ---------------- 扫描会话 ---------------- */

    /** 创建显式扫描会话：newScanSession({ parallel=true, maxSnapshotBytes=..., blockSize=... }) */
    newScanSession(args) {
      const proc = ctx.requireProcess();
      const opts: { parallel?: boolean; maxSnapshotBytes?: number; blockSize?: number; parallelMinBytes?: number } = {};
      const table = args[0];
      if (table && typeof table === 'object' && !Array.isArray(table)) {
        const t = table as Record<string, LuaValue>;
        if (t.parallel !== undefined) opts.parallel = t.parallel !== false;
        if (t.maxSnapshotBytes !== undefined) opts.maxSnapshotBytes = Number(t.maxSnapshotBytes);
        if (t.blockSize !== undefined) opts.blockSize = Number(t.blockSize);
        if (t.parallelMinBytes !== undefined) opts.parallelMinBytes = Number(t.parallelMinBytes);
      }
      return new LuaScanSession(proc, ctx.scanner, opts);
    },

    /** 隐式会话（等价于 CE 里的「当前扫描结果」） */
    firstScan(args, m) {
      const session = ctx.defaultScanSession() as LuaScanSession;
      return BigInt(session.firstScan(parseScanConfig(m, m.requireArg(args, 1, 'firstScan'), 'firstScan')));
    },

    nextScan(args, m) {
      const session = ctx.defaultScanSession() as LuaScanSession;
      return BigInt(session.nextScan(parseScanConfig(m, m.requireArg(args, 1, 'nextScan'), 'nextScan')));
    },

    getScanSession() {
      return ctx.defaultScanSession();
    },

    getScanResultCount() {
      return BigInt((ctx.defaultScanSession() as LuaScanSession).count);
    },

    getScanResult(args, m) {
      return (ctx.defaultScanSession() as LuaScanSession).result(m.argToInt(args, 1, 'getScanResult', 0));
    },

    getScanResults() {
      return (ctx.defaultScanSession() as LuaScanSession).all();
    },

    resetScanResults() {
      (ctx.defaultScanSession() as LuaScanSession).reset();
    },

    getScanSessionStats() {
      return (ctx.defaultScanSession() as LuaScanSession).stats as LuaValue;
    },

    /* ---------------- 表 ---------------- */

    getAddressList() {
      return addressList;
    },

    /* ---------------- 工具 ---------------- */

    sleep(args, m) {
      const ms = m.argToNumber(args, 1, 'sleep', 0);
      if (!Number.isFinite(ms) || ms < 0) m.raise(`sleep: 毫秒数非法：${ms}`);
      blockingSleep(Math.min(ms, ctx.maxSleepMs));
    },

    /** 系统运行时间（毫秒），对齐 Win32 的 GetTickCount64 */
    getTickCount() {
      return BigInt(Math.round(uptime() * 1000));
    },

    showMessage(args, m) {
      const text = args[0] === undefined ? '' : formatLuaValue(m.requireArg(args, 1, 'showMessage'));
      ctx.output(text, 'message');
      return true;
    },

    print(args) {
      ctx.output(args.map((v) => formatLuaValue(v)).join('\t'), 'print');
    },

    getLastError() {
      return errorSink.get();
    },

    clearLastError() {
      errorSink.clear();
    },
  };

  // Auto Assembler 的 Lua 绑定（autoAssemble / autoAssembleCheck / autoAssembleError）
  // 单独成模块（src/lua/aa.ts）以保持与引擎层的边界清晰。
  const aa = createAutoAssemblerApi(
    {
      currentProcess: () => ctx.currentProcess(),
      symbols: ctx.symbols,
    },
    errorSink,
  );
  Object.assign(functions, aa.functions);

  // 汇编 / 反汇编的 Lua 绑定（assemble / assembleBytes / disassemble / disassembleBytes）
  //
  // 这里的错误一律抛 JS Error：统一入口 `LuaEngine.invokeApi` 会用 `m.raise`
  // 把它翻译成真正的 Lua 错误（脚本侧可以用 pcall 捕获），
  // 效果与在各个 API 里直接 raise 一致，但不必把 marshal 传进子模块。
  Object.assign(
    functions,
    createAsmApi(
      {
        currentProcess: () => ctx.currentProcess(),
        symbols: () => ctx.symbols.snapshot(),
      },
      (message: string): never => {
        throw new Error(message);
      },
      (value) => {
        try {
          return resolver.resolve(value);
        } catch (e) {
          throw new Error(`地址解析失败：${describeError(e)}`);
        }
      },
    ),
  );

  return { functions, errorSink, resolver, addressList, autoAssembler: aa.instance };
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

/** 按名字查找 pid（大小写不敏感，先精确匹配再包含匹配）。 */
function findProcessId(name: string): number | null {
  const needle = name.trim().toLowerCase();
  if (needle === '') return null;
  const all = listProcesses();
  const exact = all.find((p) => p.name.toLowerCase() === needle);
  if (exact) return exact.pid;
  const partial = all.find((p) => p.name.toLowerCase().includes(needle));
  return partial ? partial.pid : null;
}

/** 地址是否落在某个模块里；是则返回 `module+OFFSET`。 */
function moduleRelativeName(ctx: ApiContext, addr: bigint): string | null {
  for (const mod of ctx.listModules()) {
    const base = mod.baseAddress;
    if (addr >= base && addr < base + BigInt(mod.size)) {
      return `${mod.name}+${(addr - base).toString(16).toUpperCase()}`;
    }
  }
  return null;
}

/** 把 Lua 值格式化成 print/showMessage 用的字符串。 */
function formatLuaValue(v: LuaValue): string {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return 'table';
  return 'userdata';
}

/** 把 writeBytes 的参数（表或变参）收集成字节数组。 */
function collectBytes(m: LuaMarshal, args: LuaValue[], startIndex: number, funcName: string): number[] {
  const out: number[] = [];
  const first = args[startIndex - 1];
  if (first === undefined || first === null) return out;

  const pushByte = (v: LuaValue, what: string): void => {
    if (typeof v === 'bigint' || typeof v === 'number') {
      out.push(Number(BigInt.asUintN(8, BigInt(v))));
      return;
    }
    m.raise(`${funcName}: ${what} 必须是整数 0..255，收到 ${v === null ? 'nil' : typeof v}`);
  };

  if (Array.isArray(first)) {
    first.forEach((v, i) => pushByte(v, `第 ${i + 1} 个字节`));
    return out;
  }
  if (typeof first === 'object') {
    const table = first as Record<string, LuaValue>;
    // CE 的字节表是 1 基；如果只给了 [0] 则按 0 基处理
    const base = table['0'] !== undefined && table['1'] === undefined ? 0 : 1;
    for (let i = base; table[String(i)] !== undefined; i++) pushByte(table[String(i)], `第 ${i} 个字节`);
    return out;
  }
  for (let i = startIndex; i <= args.length; i++) {
    pushByte(args[i - 1] as LuaValue, `第 ${i - startIndex + 1} 个字节`);
  }
  return out;
}

/**
 * 阻塞式 sleep。
 *
 * 本桥是同步桥，`sleep` 会真的阻塞 Node 主线程（事件循环也停），
 * 用 `Atomics.wait` 实现（实测请求 60ms 得到 72ms）。
 * CE 的 sleep 同样是阻塞的，脚本语义一致；上限由 LuaEngineOptions.maxSleepMs 控制。
 */
function blockingSleep(ms: number): void {
  if (ms <= 0) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}
