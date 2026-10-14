/**
 * Lua 桥的扫描支持层。
 *
 * 负责两件事：
 *  1. 把 Lua 传过来的「扫描配置表」翻译成引擎的 `ScanConfig`（字段名对齐 CE Lua 习惯）；
 *  2. AOB 扫描（AOBScan / AOBScanUnique / AOBScanModule*）。
 *
 * AOB 扫描的两条路径：
 *   - 全地址空间且保护属性只做「包含」过滤时，直接复用 `ScanSession`（可走 worker 并行，
 *     并且快照上限设为 0，避免为一次性 AOB 扫描白白占用几百 MB）；
 *   - 需要排除某类内存、或限定模块范围时，用 `scannableRegions()` + `scanBlock()`
 *     自己做分块扫描（本文件内的 `scanAobManual`）。
 *   两条路径都复用 `matcher.compileConfig / scanBlock`，不重复实现匹配算法。
 */

import { Process, isExecutable, isWritable } from '../win/process';
import { CompiledConfig, compileConfig, scanBlock } from '../scanner/matcher';
import {
  FastScanMethod,
  MemoryRegion,
  RoundingType,
  ScanConfig,
  ScanOption,
  VARIABLE_TYPE_SIZES,
  VariableType,
} from '../types';
import { LuaMarshal, describeValue } from './marshal';
import type { LuaValue, ScannerFacade } from './types';

/* ------------------------------------------------------------------ *
 * 名称 → 枚举
 * ------------------------------------------------------------------ */

const TYPE_ALIASES: Record<string, VariableType> = {
  byte: VariableType.Byte,
  uint8: VariableType.Byte,
  int8: VariableType.Byte,
  shortint: VariableType.Byte,
  word: VariableType.Word,
  uint16: VariableType.Word,
  int16: VariableType.Word,
  smallint: VariableType.Word,
  short: VariableType.Word,
  dword: VariableType.DWord,
  uint32: VariableType.DWord,
  int32: VariableType.DWord,
  integer: VariableType.DWord,
  int: VariableType.DWord,
  qword: VariableType.QWord,
  uint64: VariableType.QWord,
  int64: VariableType.QWord,
  single: VariableType.Single,
  float: VariableType.Single,
  double: VariableType.Double,
  string: VariableType.String,
  ascii: VariableType.String,
  text: VariableType.String,
  unicodestring: VariableType.UnicodeString,
  unicode: VariableType.UnicodeString,
  wide: VariableType.UnicodeString,
  utf16: VariableType.UnicodeString,
  aob: VariableType.ByteArray,
  bytearray: VariableType.ByteArray,
  arrayofbytes: VariableType.ByteArray,
  binary: VariableType.Binary,
  all: VariableType.All,
  pointer: VariableType.Pointer,
  grouped: VariableType.Grouped,
  group: VariableType.Grouped,
  codepagestring: VariableType.CodePageString,
};

const OPTION_ALIASES: Record<string, ScanOption> = {
  unknown: ScanOption.UnknownValue,
  unknownvalue: ScanOption.UnknownValue,
  exact: ScanOption.ExactValue,
  exactvalue: ScanOption.ExactValue,
  equal: ScanOption.ExactValue,
  between: ScanOption.ValueBetween,
  valuebetween: ScanOption.ValueBetween,
  bigger: ScanOption.BiggerThan,
  biggerthan: ScanOption.BiggerThan,
  greater: ScanOption.BiggerThan,
  smaller: ScanOption.SmallerThan,
  smallerthan: ScanOption.SmallerThan,
  less: ScanOption.SmallerThan,
  increased: ScanOption.IncreasedValue,
  increasedvalue: ScanOption.IncreasedValue,
  increasedby: ScanOption.IncreasedValueBy,
  increasedvalueby: ScanOption.IncreasedValueBy,
  decreased: ScanOption.DecreasedValue,
  decreasedvalue: ScanOption.DecreasedValue,
  decreasedby: ScanOption.DecreasedValueBy,
  decreasedvalueby: ScanOption.DecreasedValueBy,
  changed: ScanOption.Changed,
  unchanged: ScanOption.Unchanged,
  increasedbypercentage: ScanOption.IncreasedValueByPercentage,
  decreasedbypercentage: ScanOption.DecreasedValueByPercentage,
  valuebetweenpercentage: ScanOption.ValueBetweenPercentage,
};

const ROUNDING_ALIASES: Record<string, RoundingType> = {
  rounded: RoundingType.Rounded,
  round: RoundingType.Rounded,
  extreme: RoundingType.ExtremeRounded,
  extremerounded: RoundingType.ExtremeRounded,
  truncated: RoundingType.Truncated,
  truncate: RoundingType.Truncated,
};

/** 把字符串或数字翻译成枚举值。 */
function parseEnumValue<T extends number>(
  m: LuaMarshal,
  value: LuaValue | undefined,
  aliases: Record<string, T>,
  fieldName: string,
  min: number,
  max: number,
  def: T,
): T {
  if (value === undefined || value === null) return def;
  if (typeof value === 'number' || typeof value === 'bigint') {
    const n = Number(value);
    if (!Number.isInteger(n)) m.raise(`扫描配置 ${fieldName} 必须是整数，收到 ${n}`);
    if (n < min || n > max) m.raise(`扫描配置 ${fieldName} 超出范围 ${min}..${max}：${n}`);
    return n as T;
  }
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase().replace(/[\s_-]/g, '');
    const hit = aliases[key];
    if (hit !== undefined) return hit;
    const asNum = Number(key);
    if (Number.isInteger(asNum) && asNum >= min && asNum <= max) return asNum as T;
    m.raise(`扫描配置 ${fieldName} 的取值无法识别："${value}"`);
  }
  m.raise(`扫描配置 ${fieldName} 必须是字符串或整数，收到 ${describeValue(value as LuaValue)}`);
}

/** 读取配置表字段，兼容若干别名。 */
function pick(table: Record<string, LuaValue>, ...names: string[]): LuaValue | undefined {
  for (const n of names) {
    const v = table[n];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function toBigIntField(
  m: LuaMarshal,
  table: Record<string, LuaValue>,
  names: string[],
  fieldName: string,
): bigint | undefined {
  const v = pick(table, ...names);
  if (v === undefined) return undefined;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) m.raise(`扫描配置 ${fieldName} 必须是整数，收到 ${v}`);
    return BigInt(v);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    let negative = false;
    let body = s;
    if (body.startsWith('-')) {
      negative = true;
      body = body.slice(1);
    } else if (body.startsWith('+')) {
      body = body.slice(1);
    }
    let raw: bigint;
    try {
      if (/^\$/.test(body)) raw = BigInt('0x' + body.slice(1));
      else if (/^0x/i.test(body)) raw = BigInt(body);
      else if (/^[0-9]+$/.test(body)) raw = BigInt(body);
      else raw = BigInt('0x' + body);
    } catch {
      m.raise(`扫描配置 ${fieldName} 的数值非法："${v}"`);
    }
    return negative ? -raw : raw;
  }
  m.raise(`扫描配置 ${fieldName} 必须是数值，收到 ${describeValue(v)}`);
}

/**
 * 解析 Lua 的扫描配置表 → ScanConfig。
 *
 * 支持的键（别名用 `/` 分隔）：
 *   type / variableType      变量类型（名字或 NumericType 数值）
 *   option / scanOption      扫描选项（名字或数值）
 *   value / value1           扫描值
 *   value2                   区间上界
 *   hex / hexadecimal        按十六进制解析 value
 *   signed                   有符号解释
 *   caseSensitive            字符串区分大小写
 *   rounding                 浮点比较策略（rounded / extreme / truncated）
 *   accuracy / floatAccuracy 小数位数（默认 -1，即由字符串推导）
 *   writableOnly / executableOnly / includeImage / includeMapped / includePrivate / includeGuard
 *   is32Bit                  只扫 4GB 以下
 *   alignment                'unaligned' | 'aligned' | <数值/十六进制串>（末位对齐步长）
 *   group                    分组长扫描元素数组
 *   groupOutOfOrder / groupAligned
 *   floatScanWithoutExponents
 *   blockSize                扫描块大小
 *   aob / binary             附加的 AOB/位串（用于 ByteArray/Binary 类型时覆盖 value1）
 */
export function parseScanConfig(m: LuaMarshal, raw: LuaValue, funcName: string): ScanConfig {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    m.raise(
      `${funcName}: 第 1 个参数必须是配置表，例如 { type='dword', option='exact', value='1000' }，收到 ${describeValue(raw)}`,
    );
  }
  const table = raw as Record<string, LuaValue>;

  const variableType = parseEnumValue(
    m,
    pick(table, 'type', 'variableType', 'vartype'),
    TYPE_ALIASES,
    'type',
    0,
    16,
    VariableType.DWord,
  );
  const scanOption = parseEnumValue(
    m,
    pick(table, 'option', 'scanOption'),
    OPTION_ALIASES,
    'option',
    0,
    13,
    ScanOption.ExactValue,
  );
  const roundingType = parseEnumValue(
    m,
    pick(table, 'rounding', 'roundingType'),
    ROUNDING_ALIASES,
    'rounding',
    0,
    2,
    RoundingType.Rounded,
  );

  const cfg: ScanConfig = { variableType, scanOption, roundingType, floatAccuracy: -1 };

  const value1 = pick(table, 'value', 'value1');
  if (value1 !== undefined) cfg.value1 = value1 === null ? '' : String(value1);
  const value2 = pick(table, 'value2');
  if (value2 !== undefined && value2 !== null) cfg.value2 = String(value2);

  const aob = pick(table, 'aob');
  if (aob !== undefined && aob !== null) cfg.value1 = String(aob);
  const binary = pick(table, 'binary', 'binaryString');
  if (binary !== undefined && binary !== null) cfg.binaryString = String(binary);

  const hex = pick(table, 'hex', 'hexadecimal');
  if (hex !== undefined) cfg.hexadecimal = hex !== false && hex !== null;
  const signed = pick(table, 'signed');
  if (signed !== undefined) cfg.signed = signed !== false && signed !== null;
  const caseSensitive = pick(table, 'caseSensitive', 'casesensitive');
  if (caseSensitive !== undefined) cfg.caseSensitive = caseSensitive !== false && caseSensitive !== null;

  if (pick(table, 'accuracy', 'floatAccuracy') !== undefined) {
    cfg.floatAccuracy = Number(pick(table, 'accuracy', 'floatAccuracy'));
  }
  if (pick(table, 'codePage') !== undefined) cfg.codePage = Number(pick(table, 'codePage'));
  if (pick(table, 'stringLength', 'length') !== undefined) {
    cfg.stringLength = Number(pick(table, 'stringLength', 'length'));
  }

  cfg.writableOnly = boolField(table, 'writableOnly');
  cfg.executableOnly = boolField(table, 'executableOnly');
  cfg.includeImage = boolField(table, 'includeImage');
  cfg.includeMapped = boolField(table, 'includeMapped');
  cfg.includePrivate = boolField(table, 'includePrivate');
  cfg.includeGuard = boolField(table, 'includeGuard');
  cfg.is32Bit = boolField(table, 'is32Bit', 'is32bit');
  cfg.floatScanWithoutExponents = boolField(table, 'floatScanWithoutExponents');
  cfg.groupOutOfOrder = boolField(table, 'groupOutOfOrder');
  cfg.groupAligned = boolField(table, 'groupAligned');
  if (pick(table, 'blockSize') !== undefined) cfg.blockSize = Number(pick(table, 'blockSize'));

  // 对齐方式
  const alignment = pick(table, 'alignment', 'alignmentType', 'fastScanMethod');
  if (alignment !== undefined && alignment !== null) {
    if (typeof alignment === 'string') {
      const key = alignment.trim().toLowerCase().replace(/[\s_-]/g, '');
      if (key === 'unaligned' || key === 'notaligned' || key === 'none') {
        cfg.fastScanMethod = FastScanMethod.NotAligned;
      } else if (key === 'aligned') {
        cfg.fastScanMethod = FastScanMethod.Aligned;
      } else if (key === 'lastdigits' || key === 'lastdigit') {
        cfg.fastScanMethod = FastScanMethod.LastDigits;
      } else {
        const step = parseAlignmentParam(alignment);
        if (step !== null) {
          cfg.fastScanMethod = FastScanMethod.LastDigits;
          cfg.fastScanAlignmentLastDigits = step;
        } else {
          m.raise(`扫描配置 alignment 无法识别："${alignment}"`);
        }
      }
    } else {
      cfg.fastScanMethod = parseEnumValue(
        m,
        alignment,
        {},
        'alignment',
        0,
        2,
        FastScanMethod.NotAligned,
      );
    }
  }
  const alignmentParam = pick(table, 'alignmentParam', 'alignmentparam');
  if (alignmentParam !== undefined && alignmentParam !== null && cfg.fastScanAlignmentLastDigits === undefined) {
    const step = parseAlignmentParam(String(alignmentParam));
    if (step !== null) {
      cfg.fastScanMethod = FastScanMethod.LastDigits;
      cfg.fastScanAlignmentLastDigits = step;
    }
  }

  // 分组长扫描
  const group = pick(table, 'group', 'groupElements');
  if (group !== undefined && group !== null) {
    if (!Array.isArray(group)) m.raise('扫描配置 group 必须是数组');
    cfg.groupElements = group.map((elem, i) => {
      if (elem === null || typeof elem !== 'object' || Array.isArray(elem)) {
        m.raise(`扫描配置 group[${i + 1}] 必须是表`);
      }
      const e = elem as Record<string, LuaValue>;
      const wildcard = boolField(e, 'wildcard') === true;
      return {
        variableType: parseEnumValue(
          m,
          pick(e, 'type', 'variableType'),
          TYPE_ALIASES,
          `group[${i + 1}].type`,
          0,
          16,
          VariableType.DWord,
        ),
        wildcard,
        value: pick(e, 'value') === undefined || pick(e, 'value') === null ? undefined : String(pick(e, 'value')),
        value2: pick(e, 'value2') === undefined || pick(e, 'value2') === null ? undefined : String(pick(e, 'value2')),
        hexadecimal: boolField(e, 'hex', 'hexadecimal'),
        signed: boolField(e, 'signed'),
        floatAccuracy: pick(e, 'accuracy') === undefined ? -1 : Number(pick(e, 'accuracy')),
        roundingType: parseEnumValue(
          m,
          pick(e, 'rounding'),
          ROUNDING_ALIASES,
          `group[${i + 1}].rounding`,
          0,
          2,
          RoundingType.ExtremeRounded,
        ),
        stringLength: pick(e, 'length', 'stringLength') === undefined ? undefined : Number(pick(e, 'length', 'stringLength')),
        aob: pick(e, 'aob') === undefined || pick(e, 'aob') === null ? undefined : String(pick(e, 'aob')),
      };
    });
    cfg.variableType = VariableType.Grouped;
  }

  return cfg;
}

function boolField(table: Record<string, LuaValue>, ...names: string[]): boolean | undefined {
  const v = pick(table, ...names);
  if (v === undefined) return undefined;
  if (v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'number' || typeof v === 'bigint') return v !== 0;
  if (typeof v === 'string') return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  return true;
}

/** 把 CE 的 alignmentparam（十进制或十六进制串）解析成步长。 */
export function parseAlignmentParam(param: string): number | null {
  const s = param.trim().replace(/^0x/i, '');
  if (s === '') return null;
  if (!/^[0-9a-f]+$/i.test(s)) return null;
  const v = /[a-f]/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 把字符串或数字翻译成变量类型（供对象属性 setType 等复用）。 */
export function parseVariableType(
  m: LuaMarshal,
  value: LuaValue | undefined,
  funcName: string,
  def: VariableType = VariableType.DWord,
): VariableType {
  return parseEnumValue(m, value, TYPE_ALIASES, `${funcName} 的类型`, 0, 16, def);
}

/** 变量类型宽度（变长类型返回 0）。 */
export function variableWidth(type: VariableType): number {
  const w = VARIABLE_TYPE_SIZES[type];
  return w > 0 ? w : 0;
}

/* ------------------------------------------------------------------ *
 * 保护属性过滤（CE 的 parseProtectionflags）
 * ------------------------------------------------------------------ */

export type TriState = 'dontcare' | 'include' | 'exclude';

export interface ProtectionFilter {
  writable: TriState;
  executable: TriState;
  copyOnWrite: TriState;
}

/**
 * 解析 CE 的保护属性串，语义与 `TMemScan.parseProtectionflags` 一致：
 *   '-' 之后的字母为「排除」，'+' 之后为「包含」，'*' 之后为「无所谓」。
 *   W=可写，X=可执行，C=copy-on-write。
 * 空串（AOBScan 的默认值）表示三者都是 dontcare。
 */
export function parseProtectionFlags(flags: string): ProtectionFilter {
  const out: ProtectionFilter = { writable: 'dontcare', executable: 'dontcare', copyOnWrite: 'dontcare' };
  let current: TriState = 'dontcare';
  for (const ch of flags.toUpperCase()) {
    switch (ch) {
      case '-':
        current = 'exclude';
        break;
      case '+':
        current = 'include';
        break;
      case '*':
        current = 'dontcare';
        break;
      case 'W':
        out.writable = current;
        current = 'dontcare';
        break;
      case 'X':
        out.executable = current;
        current = 'dontcare';
        break;
      case 'C':
        out.copyOnWrite = current;
        current = 'dontcare';
        break;
      default:
        break;
    }
  }
  return out;
}

/** 区域是否满足保护属性过滤。 */
export function regionMatchesProtection(region: MemoryRegion, pf: ProtectionFilter): boolean {
  const base = region.protect & 0xff;
  const writable = isWritable(region.protect);
  const executable = isExecutable(region.protect);
  const copyOnWrite = base === 0x08 || base === 0x80;

  if (pf.writable === 'include' && !writable) return false;
  if (pf.writable === 'exclude' && writable) return false;
  if (pf.executable === 'include' && !executable) return false;
  if (pf.executable === 'exclude' && executable) return false;
  if (pf.copyOnWrite === 'include' && !copyOnWrite) return false;
  if (pf.copyOnWrite === 'exclude' && copyOnWrite) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * AOB 扫描
 * ------------------------------------------------------------------ */

export interface AobScanOptions {
  /** AOB 特征串，例如 'DE AD BE EF 90 90 ?? 7*' */
  pattern: string;
  /** CE 的保护属性串 */
  protection?: string;
  /** TFastScanMethod：0=不对齐 1=按类型宽度对齐 2=末位对齐 */
  alignmentType?: number;
  /** CE 的 alignmentparam */
  alignmentParam?: string;
  /** 限定模块名（AOBScanModule*） */
  moduleName?: string;
  /** 找到第一个就返回（AOBScanUnique） */
  unique?: boolean;
  /** 模块查找函数 */
  findModule: (name: string) => { baseAddress: bigint; size: number } | null;
}

/** CE 的 `inttohex(address, 8)`：至少 8 位大写十六进制，无 0x 前缀。 */
export function addressToCeHex(address: bigint): string {
  return address.toString(16).toUpperCase().padStart(8, '0');
}

/** 构造 AOB 的扫描配置。 */
export function buildAobConfig(m: LuaMarshal, opts: AobScanOptions): ScanConfig {
  const cfg: ScanConfig = {
    variableType: VariableType.ByteArray,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: opts.pattern,
  };
  const method = opts.alignmentType ?? FastScanMethod.NotAligned;
  if (method !== FastScanMethod.NotAligned) cfg.fastScanMethod = method;
  if (method === FastScanMethod.LastDigits) {
    const step = parseAlignmentParam(opts.alignmentParam ?? '1');
    if (step === null) m.raise(`AOBScan: alignmentparam 非法："${opts.alignmentParam}"`);
    cfg.fastScanAlignmentLastDigits = step;
  }
  return cfg;
}

/**
 * AOB 扫描入口。
 *
 * @returns 命中地址（升序，按区域顺序 + 块内偏移）
 */
export function scanAob(
  proc: Process,
  facade: ScannerFacade,
  m: LuaMarshal,
  opts: AobScanOptions,
): bigint[] {
  const pf = parseProtectionFlags(opts.protection ?? '');
  const cfg = buildAobConfig(m, opts);
  const needsManual =
    opts.moduleName !== undefined ||
    pf.writable === 'exclude' ||
    pf.executable === 'exclude' ||
    pf.copyOnWrite !== 'dontcare';

  if (needsManual) return scanAobManual(proc, facade, cfg, opts, pf);

  // 走 ScanSession：可并行、且不保留快照（AOB 不需要 nextScan 的旧值）
  const writableOnly = pf.writable === 'include';
  const executableOnly = pf.executable === 'include';
  const session = facade.createSession(proc, {
    parallel: true,
    maxSnapshotBytes: 0,
  });
  try {
    session.firstScan({
      ...cfg,
      writableOnly,
      executableOnly,
      includeGuard: false,
    });
    return (session.results as readonly bigint[]).slice();
  } finally {
    session.dispose();
  }
}

const SCAN_CHUNK = 4 * 1024 * 1024;

/**
 * 手工分块 AOB 扫描（限定模块 / 需要排除某类内存时使用）。
 *
 * 与 ScanSession 的差异：单线程、按 4MB 分块、块之间带 (模式长度-1) 字节重叠，
 * 保证跨块边界的特征也能命中。
 */
export function scanAobManual(
  proc: Process,
  facade: ScannerFacade,
  cfg: ScanConfig,
  opts: AobScanOptions,
  pf: ProtectionFilter,
): bigint[] {
  const cc: CompiledConfig = facade.compile(cfg);
  const width = cc.rules.reduce((a, r) => Math.max(a, r.width), 0) || 1;
  const alignment = Math.max(1, cc.alignment);

  let minAddress = 0n;
  let maxAddress = 0x7fffffffffffn;
  if (opts.moduleName !== undefined && opts.moduleName !== '') {
    const mod = opts.findModule(opts.moduleName);
    if (!mod) return [];
    minAddress = mod.baseAddress;
    maxAddress = mod.baseAddress + BigInt(Math.max(0, mod.size));
  }

  const regions = proc
    .scannableRegions({
      writableOnly: pf.writable === 'include',
      executableOnly: pf.executable === 'include',
      includeGuard: false,
    })
    .filter((r) => regionMatchesProtection(r, pf));

  const found: bigint[] = [];

  for (const region of regions) {
    const regionStart = region.baseAddress > minAddress ? region.baseAddress : minAddress;
    const regionEndRaw = region.baseAddress + region.memorySize;
    const regionEnd = regionEndRaw < maxAddress ? regionEndRaw : maxAddress;
    if (regionEnd <= regionStart) continue;

    let addr = regionStart;
    while (addr < regionEnd) {
      const remaining = regionEnd - addr;
      const take = Number(remaining > BigInt(SCAN_CHUNK) ? BigInt(SCAN_CHUNK) : remaining);
      const buf = proc.readMemory(addr, take + width - 1);
      if (buf.length > 0) {
        const offsets: number[] = [];
        facade.scanBlock(cc, buf, null, offsets);
        for (const off of offsets) {
          if (off >= take) continue; // 属于下一块的范围
          const hit = addr + BigInt(off);
          if (hit % BigInt(alignment) !== 0n) continue;
          found.push(hit);
          if (opts.unique) return found;
        }
      }
      addr += BigInt(take);
    }
  }

  return found;
}

/** 供 AOBScanUnique 使用：全地址空间的手工扫描（命中即停）。 */
export function scanAobFirst(
  proc: Process,
  facade: ScannerFacade,
  m: LuaMarshal,
  opts: AobScanOptions,
): bigint | null {
  const pf = parseProtectionFlags(opts.protection ?? '');
  const cfg = buildAobConfig(m, opts);
  const hits = scanAobManual(proc, facade, cfg, { ...opts, unique: true }, pf);
  return hits.length > 0 ? hits[0] : null;
}

/** 供引擎内部复用：把 ScanConfig 直接交给 compileConfig（避免重复 import）。 */
export function compileScanConfig(cfg: ScanConfig): CompiledConfig {
  return compileConfig(cfg);
}

/** 供引擎内部复用：单块扫描转发。 */
export function scanBuffer(cc: CompiledConfig, buf: Buffer, out: number[]): void {
  scanBlock(cc, buf, null, out);
}
