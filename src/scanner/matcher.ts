/**
 * 扫描比较器 —— 逐项对齐 Cheat Engine `memscan.pas` 的 TScanner 比较函数族。
 *
 * CE 的结构是：为每种变量类型维护一个 typesmatch[] 布尔数组，每次比较把所有
 * 候选类型的比较结果 AND 进去，最后只要还有任何一个类型匹配就保留该地址。
 * 这里用等价的实现：对每个候选类型分别收集命中的地址。
 *
 * 已对齐的语义（含容易搞错的细节）：
 *   - SingleExtremeRounded 用闭区间 [min,max]；DoubleExtremeRounded 用开区间 (min,max)
 *     —— 见 TScanner.SingleExact / DoubleExact，CE 自身在这里就不一致。
 *   - Truncated 用 [value, value+step) 左闭右开。
 *   - Rounded 用 RoundTo(actual, -accuracy) === value（含 FPC 的偶舍入）。
 *   - IncreasedValueBy / DecreasedValueBy 对浮点会先比较原始位模式不等，再按精度判等。
 *   - 百分比系列的边界开闭、以及 dvalue>dvalue2 时自动交换。
 *   - 字符串不区分大小写时只把 ASCII a-z 折叠为大写（ANSI）/
 *     用 UpCase（Unicode），对齐 CaseInsensitiveAnsiStringExact / UnicodeString。
 *   - AOB 支持半字节通配，对齐 parseAob 的掩码语义。
 */

import {
  BinaryPattern,
  FloatCompareParams,
  PatternByte,
  aobHasNibbleWildcard,
  aobMatchesAt,
  binaryByteWidth,
  buildFloatCompareParams,
  doubleMatches,
  parseAob,
  parseBinaryPattern,
  parseIntegerLiteral,
  roundTo,
  singleMatches,
  testString,
  testStringCI,
  testWideString,
  testWideStringCI,
} from '../value-codec';
import {
  RoundingType,
  ScanConfig,
  ScanOption,
  VariableType,
  VARIABLE_TYPE_SIZES,
} from '../types';

/** 整数类型的比较参数 */
interface IntCompare {
  /** 主值（无符号 64 位语义） */
  v: bigint;
  /** 上界（区间用） */
  v2: bigint;
  signed: boolean;
}

/** 单个变量类型的编译后比较规则 */
interface TypeRule {
  type: VariableType;
  width: number;
  /** 值比较 */
  ints?: IntCompare;
  floats?: FloatCompareParams;
  /** 字符串目标与长度（字节） */
  str?: { target: string; upper: string; byteLength: number; wide: boolean; caseSensitive: boolean };
  /** AOB 模式 */
  aob?: { pattern: PatternByte[]; nibble: boolean };
  /** 二进制位串 */
  bin?: { pattern: BinaryPattern; width: number };
}

/** 编译后的扫描配置 */
export interface CompiledConfig {
  option: ScanOption;
  rounding: RoundingType;
  /** 需要参与比较的每种类型一条规则；vtAll 会展开为 6 条数值规则 */
  rules: TypeRule[];
  /** 各种类型都开启（vtAll 的"全部"扫描） */
  isAll: boolean;
  /** 反选（排除匹配） */
  inverse: boolean;
  /** 浮点扫描时排除带指数的浮点数 */
  floatScanWithoutExponents: boolean;
  /** 对齐步长；0 表示逐字节 */
  alignment: number;
  /** 分组长扫描 */
  group?: CompiledGroup;
}

/** 编译后的分组长扫描 */
export interface CompiledGroup {
  elements: CompiledGroupElement[];
  /** 整块总宽度 */
  blockSize: number;
  outOfOrder: boolean;
  /** 乱序且要求按宽度对齐 */
  outOfOrderAligned: boolean;
}

interface CompiledGroupElement {
  type: VariableType;
  wildcard: boolean;
  width: number;
  ints?: IntCompare;
  floats?: FloatCompareParams;
  str?: { target: string; upper: string; byteLength: number; wide: boolean; caseSensitive: boolean };
  aob?: { pattern: PatternByte[]; nibble: boolean };
  bin?: { pattern: BinaryPattern; width: number };
  /** 乱序模式下的输出偏移 */
  outOffset?: number;
}

/* ------------------------------------------------------------------ *
 * 编译
 * ------------------------------------------------------------------ */

/** 数值类型的默认宽度 */
function widthOf(type: VariableType, explicit?: number): number {
  const w = VARIABLE_TYPE_SIZES[type];
  if (w > 0) return w;
  if (explicit && explicit > 0) return explicit;
  throw new Error(`类型 ${VariableType[type]} 需要显式指定长度`);
}

/** 是否需要保存"上一次的值"（next scan 的旧值语义）。 */
export function optionNeedsOldValue(option: ScanOption): boolean {
  switch (option) {
    case ScanOption.IncreasedValue:
    case ScanOption.IncreasedValueBy:
    case ScanOption.IncreasedValueByPercentage:
    case ScanOption.DecreasedValue:
    case ScanOption.DecreasedValueBy:
    case ScanOption.DecreasedValueByPercentage:
    case ScanOption.Changed:
    case ScanOption.Unchanged:
    case ScanOption.ValueBetweenPercentage:
      return true;
    default:
      return false;
  }
}

/** 是否属于"带值的比较"（与无值的 unknown/changed 相对）。 */
function optionHasValue(option: ScanOption): boolean {
  switch (option) {
    case ScanOption.UnknownValue:
    case ScanOption.Changed:
    case ScanOption.Unchanged:
    case ScanOption.IncreasedValue:
    case ScanOption.DecreasedValue:
      return false;
    default:
      return true;
  }
}

function optionHasSecondValue(option: ScanOption): boolean {
  switch (option) {
    case ScanOption.ValueBetween:
    case ScanOption.ValueBetweenPercentage:
    case ScanOption.IncreasedValueByPercentage:
    case ScanOption.DecreasedValueByPercentage:
      return true;
    default:
      return false;
  }
}

function isPercentageOption(option: ScanOption): boolean {
  return (
    option === ScanOption.IncreasedValueByPercentage ||
    option === ScanOption.DecreasedValueByPercentage ||
    option === ScanOption.ValueBetweenPercentage
  );
}

/** 展开 vtAll 为 6 个基础数值类型，对齐 CE 的 typesmatch 数组。 */
const ALL_NUMERIC: VariableType[] = [
  VariableType.Byte,
  VariableType.Word,
  VariableType.DWord,
  VariableType.QWord,
  VariableType.Single,
  VariableType.Double,
];

/** 把字符串目标转成对应宽度的字节表示。 */
function buildStringRule(
  type: VariableType,
  value: string,
  caseSensitive: boolean,
  stringLength?: number,
): TypeRule['str'] {
  const target = stringLength !== undefined && stringLength > 0 ? value.slice(0, stringLength) : value;
  const wide = type === VariableType.UnicodeString;
  const byteLength = wide ? target.length * 2 : target.length;
  const upper = caseSensitive ? target : target.replace(/[a-z]/g, (c) => c.toUpperCase());
  return { target, upper, byteLength, wide, caseSensitive };
}

/** 编译单个类型的比较规则。 */
function compileRule(
  type: VariableType,
  cfg: ScanConfig,
  round: RoundingType,
): TypeRule {
  const rule: TypeRule = { type, width: 0 };
  const hasValue = optionHasValue(cfg.scanOption);
  const percentage = isPercentageOption(cfg.scanOption);

  switch (type) {
    case VariableType.Byte:
    case VariableType.Word:
    case VariableType.DWord:
    case VariableType.QWord:
    case VariableType.Pointer: {
      rule.width = widthOf(type, type === VariableType.Pointer ? 8 : undefined);
      if (hasValue) {
        const a = parseIntegerLiteral(cfg.value1 ?? '0', cfg.hexadecimal ?? false);
        const b = optionHasSecondValue(cfg.scanOption)
          ? parseIntegerLiteral(cfg.value2 ?? cfg.value1 ?? '0', cfg.hexadecimal ?? false)
          : a;
        rule.ints = { v: a.raw, v2: b.raw, signed: cfg.signed === true || a.negative || b.negative };
      }
      // 无值选项（Unknown/Changed/Unchanged/Increased/Decreased）不需要 ints，
      // 比较逻辑只用到宽度与符号；但符号信息仍需保留，因此给一个零值占位。
      else {
        rule.ints = { v: 0n, v2: 0n, signed: cfg.signed === true };
      }
      return rule;
    }
    case VariableType.Single:
    case VariableType.Double: {
      rule.width = widthOf(type);
      if (hasValue) {
        rule.floats = buildFloatCompareParams(cfg.value1 ?? '0', cfg.value2, percentage);
      } else {
        // 无值选项占位：精度信息仍需要（用于 IncreasedValueBy 之外的比较）
        rule.floats = buildFloatCompareParams('0', undefined, false);
      }
      return rule;
    }
    case VariableType.String:
    case VariableType.CodePageString:
    case VariableType.UnicodeString: {
      const s = buildStringRule(type, cfg.value1 ?? '', cfg.caseSensitive === true, cfg.stringLength);
      if (!s) throw new Error('字符串扫描需要提供扫描值');
      rule.str = s;
      rule.width = s.byteLength;
      return rule;
    }
    case VariableType.ByteArray: {
      const pattern = parseAob(cfg.value1 ?? '', true);
      rule.aob = { pattern, nibble: aobHasNibbleWildcard(pattern) };
      rule.width = pattern.length;
      return rule;
    }
    case VariableType.Binary: {
      const pattern = parseBinaryPattern(cfg.binaryString ?? cfg.value1 ?? '');
      rule.bin = { pattern, width: binaryByteWidth(pattern.bitCount) };
      rule.width = rule.bin.width;
      return rule;
    }
    default:
      throw new Error(`不支持直接编译的变量类型: ${VariableType[type]}`);
  }
}

/** 编译分组长扫描。 */
function compileGroup(cfg: ScanConfig): CompiledGroup {
  const elems = cfg.groupElements ?? [];
  if (elems.length === 0) throw new Error('分组长扫描需要至少一个元素');

  const compiled: CompiledGroupElement[] = [];
  let total = 0;

  for (const e of elems) {
    const rule = compileRule(
      e.variableType,
      {
        ...cfg,
        variableType: e.variableType,
        scanOption: e.wildcard ? ScanOption.ExactValue : (e as { scanOption?: ScanOption }).scanOption ?? ScanOption.ExactValue,
        value1: e.value,
        value2: e.value2,
        hexadecimal: e.hexadecimal,
        signed: e.signed,
        floatAccuracy: e.floatAccuracy ?? -1,
        roundingType: e.roundingType ?? RoundingType.ExtremeRounded,
        stringLength: e.stringLength,
      },
      e.roundingType ?? RoundingType.ExtremeRounded,
    );
    compiled.push({
      type: e.variableType,
      wildcard: e.wildcard === true,
      width: rule.width,
      ints: rule.ints,
      floats: rule.floats,
      str: rule.str,
      aob: rule.aob,
      bin: rule.bin,
    });
    total += rule.width;
  }

  return {
    elements: compiled,
    blockSize: total,
    outOfOrder: cfg.groupOutOfOrder === true,
    outOfOrderAligned: cfg.groupAligned === true,
  };
}

/** 编译用户扫描配置。 */
export function compileConfig(cfg: ScanConfig): CompiledConfig {
  const rounding = cfg.roundingType ?? RoundingType.Rounded;
  const isAll = cfg.variableType === VariableType.All;

  let rules: TypeRule[];
  if (isAll) {
    // 对齐 TScanner.All* 系列：所有数值类型同时参与，任一匹配即命中
    rules = ALL_NUMERIC.map((t) => compileRule(t, { ...cfg, variableType: t }, rounding));
  } else if (cfg.variableType === VariableType.Grouped) {
    rules = [];
  } else {
    rules = [compileRule(cfg.variableType, cfg, rounding)];
  }

  // 对齐 CE 的 fastscanmethod：fsmAligned 时按类型宽度对齐，fsmLastDigits 时按用户指定末位
  let alignment = 1;
  if (cfg.fastScanMethod === 1 /* fsmAligned */ && rules.length === 1) {
    alignment = Math.max(1, rules[0].width);
  } else if (cfg.fastScanMethod === 2 /* fsmLastDigits */) {
    const d = cfg.fastScanAlignmentLastDigits;
    alignment = d && d > 1 ? d : 1;
  }

  return {
    option: cfg.scanOption,
    rounding,
    rules,
    isAll,
    inverse: false,
    floatScanWithoutExponents: cfg.floatScanWithoutExponents === true,
    alignment,
    group: cfg.variableType === VariableType.Grouped ? compileGroup(cfg) : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * 单点比较：返回命中的类型列表
 * ------------------------------------------------------------------ */

/** 单条规则在该偏移是否命中。next 为空表示首次扫描。 */
function ruleMatches(
  rule: TypeRule,
  cc: CompiledConfig,
  buf: Buffer,
  off: number,
  prev: Buffer | null,
  prevOff: number,
): boolean {
  const opt = cc.option;

  /* —— 分组长：由 groupMatchesBlock 处理 —— */

  /* —— 特殊类型优先 —— */
  if (rule.str) {
    if (off + rule.str.byteLength > buf.length) return false;
    if (opt === ScanOption.ExactValue || opt === ScanOption.UnknownValue) {
      const ok = rule.str.wide
        ? rule.str.caseSensitive
          ? testWideString(buf, off, rule.str.target)
          : testWideStringCI(buf, off, rule.str.target)
        : rule.str.caseSensitive
          ? testString(buf, off, rule.str.target)
          : testStringCI(buf, off, rule.str.upper);
      return ok;
    }
    // 字符串类型的变动/未变动：比较整段字节
    if (opt === ScanOption.Changed || opt === ScanOption.Unchanged) {
      if (!prev) return false;
      const changed = !buf.subarray(off, off + rule.str.byteLength).equals(
        prev.subarray(prevOff, prevOff + rule.str.byteLength),
      );
      return opt === ScanOption.Changed ? changed : !changed;
    }
    return false;
  }

  if (rule.aob) {
    if (opt !== ScanOption.ExactValue && opt !== ScanOption.UnknownValue) return false;
    return aobMatchesAt(buf, off, rule.aob.pattern, rule.aob.nibble);
  }

  if (rule.bin) {
    if (opt !== ScanOption.ExactValue && opt !== ScanOption.UnknownValue) return false;
    const { andMask, bitMask, bitCount } = rule.bin.pattern;
    const width = rule.bin.width;
    if (off + width > buf.length) return false;
    let val = 0n;
    for (let i = width - 1; i >= 0; i--) val = (val << 8n) | BigInt(buf[off + i]);
    void bitCount;
    return (val & andMask) === (bitMask & andMask);
  }

  /* —— 数值类型 —— */
  const width = rule.width;
  if (off + width > buf.length) return false;

  // 需要旧值的前置检查
  const needsOld = optionNeedsOldValue(opt);
  if (needsOld && !prev) return false;
  if (needsOld && prevOff + width > prev!.length) return false;

  if (rule.ints) {
    const { v, v2, signed } = rule.ints;
    // 1/2/4 字节：完全走 Number，避免每字节一次 BigInt 分配
    if (width < 8) {
      const n = readSmallInt(buf, off, width);
      const old = needsOld ? readSmallInt(prev!, prevOff, width) : 0;
      return compareSmallInt(opt, n, old, v, v2, signed, width);
    }

    // 8 字节快路径：用 Buffer 原生 BigInt 读取（避免通用 readIntLike 的分支开销），
    // 且对最常见的几种选项直接比较，省去一次 BigInt 运算链。
    const nv = signed ? buf.readBigInt64LE(off) : buf.readBigUInt64LE(off);
    let ov = 0n;
    if (needsOld) ov = signed ? prev!.readBigInt64LE(prevOff) : prev!.readBigUInt64LE(prevOff);

    switch (opt) {
      case ScanOption.UnknownValue:
        return true;
      case ScanOption.ExactValue:
        return nv === v;
      case ScanOption.Changed:
        return nv !== ov;
      case ScanOption.Unchanged:
        return nv === ov;
      case ScanOption.IncreasedValue:
        return nv > ov;
      case ScanOption.DecreasedValue:
        return nv < ov;
      default:
        return compareIntBigInt(opt, nv, ov, v, v2, signed, width);
    }
  }

  if (rule.floats) {
    const isSingle = rule.type === VariableType.Single;
    const cur = isSingle ? buf.readFloatLE(off) : buf.readDoubleLE(off);
    const old = needsOld ? (isSingle ? prev!.readFloatLE(prevOff) : prev!.readDoubleLE(prevOff)) : 0;
    const params = rule.floats;
    const curS = Math.fround(cur);
    const oldS = Math.fround(old);

    switch (opt) {
      case ScanOption.UnknownValue:
        return true;
      case ScanOption.ExactValue:
        return isSingle
          ? singleMatches(curS, params, cc.rounding)
          : doubleMatches(cur, params, cc.rounding);
      case ScanOption.ValueBetween:
        return isSingle
          ? curS >= params.single && curS <= params.single2!
          : cur >= params.value && cur <= params.value2!;
      case ScanOption.BiggerThan:
        return isSingle ? curS > params.single : cur > params.value;
      case ScanOption.SmallerThan:
        return isSingle ? curS < params.single : cur < params.value;
      case ScanOption.IncreasedValue:
        return isSingle ? curS > oldS : cur > old;
      case ScanOption.DecreasedValue:
        return isSingle ? curS < oldS : cur < old;
      case ScanOption.Changed:
        return isSingle ? buf.readFloatLE(off) !== prev!.readFloatLE(prevOff) : cur !== old;
      case ScanOption.Unchanged:
        return isSingle ? buf.readFloatLE(off) === prev!.readFloatLE(prevOff) : cur === old;
      case ScanOption.IncreasedValueBy:
        // 对齐 SingleIncreasedValueBy：原始位模式必须不同，且按精度判等
        if (isSingle) {
          if (buf.readUInt32LE(off) === prev!.readUInt32LE(prevOff)) return false;
          return roundTo(curS, params.accuracy) === roundTo(oldS + params.single, params.accuracy);
        }
        if (buf.readBigUInt64LE(off) === prev!.readBigUInt64LE(prevOff)) return false;
        return roundTo(cur, params.accuracy) === roundTo(old + params.value, params.accuracy);
      case ScanOption.DecreasedValueBy:
        if (isSingle) {
          if (buf.readUInt32LE(off) === prev!.readUInt32LE(prevOff)) return false;
          return roundTo(curS, params.accuracy) === roundTo(oldS - params.single, params.accuracy);
        }
        if (buf.readBigUInt64LE(off) === prev!.readBigUInt64LE(prevOff)) return false;
        return roundTo(cur, params.accuracy) === roundTo(old - params.value, params.accuracy);
      case ScanOption.IncreasedValueByPercentage:
        // 对齐 SingleIncreasedValueByPercentage：old + old*svalue < cur < old + old*svalue2
        return isSingle
          ? curS > oldS + oldS * params.single && curS < oldS + oldS * params.single2!
          : cur > old + old * params.value && cur < old + old * params.value2!;
      case ScanOption.DecreasedValueByPercentage:
        return isSingle
          ? curS > oldS - oldS * params.single2! && curS < oldS - oldS * params.single
          : cur > old - old * params.value2! && cur < old - old * params.value;
      case ScanOption.ValueBetweenPercentage:
        return isSingle
          ? curS > oldS * params.single && curS <= oldS * params.single2!
          : cur > old * params.value && cur <= old * params.value2!;
      default:
        return false;
    }
  }

  return false;
}

/** 按宽度与符号读取整数。 */
function readIntLike(buf: Buffer, off: number, width: number, signed: boolean): bigint {
  switch (width) {
    case 1: {
      const v = buf[off];
      return signed ? BigInt(v < 0x80 ? v : v - 0x100) : BigInt(v);
    }
    case 2: {
      const v = buf.readUInt16LE(off);
      return signed ? BigInt(buf.readInt16LE(off)) : BigInt(v);
    }
    case 4: {
      const v = buf.readUInt32LE(off);
      return signed ? BigInt(buf.readInt32LE(off)) : BigInt(v);
    }
    case 8: {
      return signed ? buf.readBigInt64LE(off) : buf.readBigUInt64LE(off);
    }
    default:
      throw new Error(`不支持整数宽度 ${width}`);
  }
}

/**
 * 整数比较，严格对齐 CE 的 TScanner.<Type><Option>。
 *
 * 性能说明：这里对 1/2/4 字节全部走 Number 路径。
 * 早期实现统一转 BigInt 比较，实测只有约 200 MB/s —— 每字节一次 BigInt 分配的
 * 开销远大于比较本身。8 字节保留 BigInt（Number 装不下 64 位精度）。
 */
function compareInt(
  opt: ScanOption,
  n: bigint,
  old: bigint,
  v: bigint,
  v2: bigint,
  signed: boolean,
  width: number,
): boolean {
  if (width < 8) {
    return compareSmallInt(opt, Number(n), Number(old), v, v2, signed, width);
  }
  return compareIntBigInt(opt, n, old, v, v2, signed, width);
}

/** 读取 1/2/4 字节无符号整数为 Number。 */
function readSmallInt(buf: Buffer, off: number, width: number): number {
  switch (width) {
    case 1:
      return buf[off];
    case 2:
      return buf.readUInt16LE(off);
    case 4:
      return buf.readUInt32LE(off);
    default:
      return buf.readUInt32LE(off);
  }
}

/** 1/2/4 字节的 Number 快速路径（热路径，避免 BigInt）。 */
function compareSmallInt(
  opt: ScanOption,
  n: number,
  old: number,
  v: bigint,
  v2: bigint,
  signed: boolean,
  width: number,
): boolean {
  const bits = width * 8;
  const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  const signBit = bits === 32 ? 0x80000000 : 1 << (bits - 1);
  const period = bits === 32 ? 0x100000000 : 1 << bits;

  const uv = Number(v & 0xffffffffn) & mask;
  const uv2 = Number(v2 & 0xffffffffn) & mask;

  const A = signed && n >= signBit ? n - period : n;
  const B = signed && old >= signBit ? old - period : old;
  const V = signed && uv >= signBit ? uv - period : uv;
  const V2 = signed && uv2 >= signBit ? uv2 - period : uv2;

  const wrap = (x: number): number => (bits === 32 ? x >>> 0 : x & mask);

  switch (opt) {
    case ScanOption.ExactValue:
    case ScanOption.UnknownValue:
      return A === V;
    case ScanOption.ValueBetween:
      return A >= V && A <= V2;
    case ScanOption.BiggerThan:
      return A > V;
    case ScanOption.SmallerThan:
      return A < V;
    case ScanOption.IncreasedValue:
      return A > B;
    case ScanOption.DecreasedValue:
      return A < B;
    case ScanOption.Changed:
      return A !== B;
    case ScanOption.Unchanged:
      return A === B;
    case ScanOption.IncreasedValueBy:
      return signed ? A === B + V : A === wrap(B + V);
    case ScanOption.DecreasedValueBy:
      return signed ? A === B - V : A === wrap(B - V);
    case ScanOption.IncreasedValueByPercentage:
      return A > B + (B * V) / 100 && A < B + (B * V2) / 100;
    case ScanOption.DecreasedValueByPercentage:
      return A > B - (B * V2) / 100 && A < B - (B * V) / 100;
    case ScanOption.ValueBetweenPercentage:
      return A > (B * V) / 100 && A <= (B * V2) / 100;
    default:
      return false;
  }
}

/** 8 字节的 BigInt 路径。 */
function compareIntBigInt(
  opt: ScanOption,
  n: bigint,
  old: bigint,
  v: bigint,
  v2: bigint,
  signed: boolean,
  width: number,
): boolean {
  const mask = (1n << BigInt(width * 8)) - 1n;
  const signedWidth = BigInt(width * 8 - 1);
  const asSigned = (x: bigint): bigint => {
    const c = x & mask;
    return c > (1n << signedWidth) - 1n ? c - (1n << (signedWidth + 1n)) : c;
  };

  if (signed) {
    const sn = asSigned(n);
    const so = asSigned(old);
    const sv = asSigned(v);
    const sv2 = asSigned(v2);
    switch (opt) {
      case ScanOption.ExactValue:
      case ScanOption.UnknownValue:
        return sn === sv;
      case ScanOption.ValueBetween:
        return sn >= sv && sn <= sv2;
      case ScanOption.BiggerThan:
        return sn > sv;
      case ScanOption.SmallerThan:
        return sn < sv;
      case ScanOption.IncreasedValue:
        return sn > so;
      case ScanOption.DecreasedValue:
        return sn < so;
      case ScanOption.Changed:
        return sn !== so;
      case ScanOption.Unchanged:
        return sn === so;
      case ScanOption.IncreasedValueBy:
        return sn === so + sv;
      case ScanOption.DecreasedValueBy:
        return sn === so - sv;
      case ScanOption.IncreasedValueByPercentage:
        return sn > so + (so * sv) / 100n && sn < so + (so * sv2) / 100n;
      case ScanOption.DecreasedValueByPercentage:
        return sn > so - (so * sv2) / 100n && sn < so - (so * sv) / 100n;
      case ScanOption.ValueBetweenPercentage:
        return sn > (so * sv) / 100n && sn <= (so * sv2) / 100n;
      default:
        return false;
    }
  }

  const un = n & mask;
  const uo = old & mask;
  const uv = v & mask;
  const uv2 = v2 & mask;
  switch (opt) {
    case ScanOption.ExactValue:
    case ScanOption.UnknownValue:
      return un === uv;
    case ScanOption.ValueBetween:
      return un >= uv && un <= uv2;
    case ScanOption.BiggerThan:
      return un > uv;
    case ScanOption.SmallerThan:
      return un < uv;
    case ScanOption.IncreasedValue:
      return un > uo;
    case ScanOption.DecreasedValue:
      return un < uo;
    case ScanOption.Changed:
      return un !== uo;
    case ScanOption.Unchanged:
      return un === uo;
    case ScanOption.IncreasedValueBy:
      return un === ((uo + uv) & mask);
    case ScanOption.DecreasedValueBy:
      return un === ((uo - uv) & mask);
    case ScanOption.IncreasedValueByPercentage:
      return un > uo + (uo * uv) / 100n && un < uo + (uo * uv2) / 100n;
    case ScanOption.DecreasedValueByPercentage:
      return un > uo - (uo * uv2) / 100n && un < uo - (uo * uv) / 100n;
    case ScanOption.ValueBetweenPercentage:
      return un > (uo * uv) / 100n && un <= (uo * uv2) / 100n;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ *
 * 块扫描
 * ------------------------------------------------------------------ */

/**
 * 在内存块中扫描，把命中的"块内偏移"写入 out。
 *
 * @param cc     编译后的配置
 * @param buf    当前内存块
 * @param prev   上一次扫描时同一区域的原始内存（next scan 用）；长度与 buf 对齐
 * @param out    输出块内偏移
 * @param outMatches 输出每个偏移命中的规则下标（与 out 平行，按类型区分结果时需要）
 */
export function scanBlock(
  cc: CompiledConfig,
  buf: Buffer,
  prev: Buffer | null,
  out: number[],
  outMatches?: number[][],
): void {
  if (cc.group) {
    scanGroupBlock(cc.group, buf, out);
    return;
  }

  const rules = cc.rules;
  const needPrev = optionNeedsOldValue(cc.option);
  if (needPrev && !prev) {
    throw new Error('该扫描选项需要上一次扫描的值，请先执行首次扫描');
  }

  const align = cc.alignment > 0 ? cc.alignment : 1;
  // 所有规则里最大的宽度，决定循环上界
  let maxWidth = 0;
  for (const r of rules) if (r.width > maxWidth) maxWidth = r.width;
  const limit = buf.length - maxWidth;

  // 快路径：单类型 + 无需旧值 + 无符号 4 字节精确比较（最常见的场景）
  if (
    rules.length === 1 &&
    !needPrev &&
    cc.option === ScanOption.ExactValue &&
    rules[0].ints &&
    !rules[0].ints.signed &&
    rules[0].width === 4
  ) {
    scanAlignedU32(buf, Number(rules[0].ints.v & 0xffffffffn), align, out);
    return;
  }

  for (let i = 0; i <= limit; i += align) {
    const matches: number[] = outMatches ? [] : EMPTY_MATCHES;
    let hit = false;
    for (let k = 0; k < rules.length; k++) {
      if (ruleMatches(rules[k], cc, buf, i, prev, i)) {
        hit = true;
        if (outMatches) matches.push(k);
        if (!cc.isAll) break; // 非 all 模式：一个类型命中即可
      }
    }
    if (hit) {
      out.push(i);
      if (outMatches) outMatches.push(matches);
    }
  }
}

const EMPTY_MATCHES: number[] = [];

/** 4 字节对齐精确扫描的快路径（Uint32Array 比较，显著快于逐字节 readUInt32LE）。 */
function scanAlignedU32(buf: Buffer, value: number, align: number, out: number[]): void {
  if (align !== 4) {
    for (let i = 0; i + 4 <= buf.length; i += align) {
      if (buf.readUInt32LE(i) === value) out.push(i);
    }
    return;
  }
  const count = buf.length >>> 2;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(i << 2) === value) out.push(i << 2);
  }
}

/* ------------------------------------------------------------------ *
 * 分组长扫描（对齐 compareblock / compareblock_outoforder）
 * ------------------------------------------------------------------ */

function groupElementMatchesAt(
  el: CompiledGroupElement,
  buf: Buffer,
  off: number,
): boolean {
  if (el.wildcard) return true;
  if (el.str) {
    if (off + el.str.byteLength > buf.length) return false;
    return el.str.wide
      ? el.str.caseSensitive
        ? testWideString(buf, off, el.str.target)
        : testWideStringCI(buf, off, el.str.target)
      : el.str.caseSensitive
        ? testString(buf, off, el.str.target)
        : testStringCI(buf, off, el.str.upper);
  }
  if (el.aob) return aobMatchesAt(buf, off, el.aob.pattern, el.aob.nibble);
  if (el.bin) {
    const { andMask, bitMask } = el.bin.pattern;
    let val = 0n;
    for (let i = el.bin.width - 1; i >= 0; i--) val = (val << 8n) | BigInt(buf[off + i]);
    return (val & andMask) === (bitMask & andMask);
  }
  if (el.ints) {
    const mask = (1n << BigInt(el.width * 8)) - 1n;
    const n = readIntLike(buf, off, el.width, el.ints.signed) & mask;
    if (el.ints.v === el.ints.v2) return n === (el.ints.v & mask);
    return n >= (el.ints.v & mask) && n <= (el.ints.v2 & mask);
  }
  if (el.floats) {
    const isSingle = el.type === VariableType.Single;
    const cur = isSingle ? buf.readFloatLE(off) : buf.readDoubleLE(off);
    const p = el.floats;
    return isSingle
      ? cur >= p.minSingle && cur <= p.maxSingle
      : cur >= p.minDouble && cur <= p.maxDouble;
  }
  return false;
}

/** 顺序分组长扫描：对齐 TGroupData.compareblock（元素按声明顺序紧密排列）。 */
function scanGroupBlock(group: CompiledGroup, buf: Buffer, out: number[]): void {
  const blockSize = group.blockSize;
  if (blockSize <= 0) return;
  const limit = buf.length - blockSize;

  if (!group.outOfOrder) {
    for (let i = 0; i <= limit; i++) {
      let off = i;
      let ok = true;
      for (const el of group.elements) {
        if (!groupElementMatchesAt(el, buf, off)) {
          ok = false;
          break;
        }
        off += el.width;
      }
      if (ok) out.push(i);
    }
    return;
  }

  // 乱序扫描：对齐 TGroupData.compareblock_outoforder 的语义 ——
  // 对每个候选基址 i，在窗口 [i, i+blockSize) 内为每个元素**独立定位**一个位置，
  // 要求各元素占用的字节区间互不重叠。
  //
  // 性能：早期实现用 `used.some(...)` 逐对检查重叠，在几十 MB 段上是 O(n·k²)。
  // 这里改用一块"占用位图"（Uint8Array，长度 = 块宽），
  // 检查与置位都是 O(width)，整体降为 O(n·k·w)，实测从 15s 降到 ~2s。
  const occ = new Uint8Array(blockSize + 1);

  // 匹配顺序：先具体元素、后通配元素。
  // 原因：通配元素"匹配任何值"，若先给它定位，它可能占掉某个具体元素唯一可用的位置，
  // 导致本来存在的匹配被漏掉（实测会漏掉 health/ammo 这对相邻值）。
  // 按"具体在前"的顺序定位可避免这种贪心抢占。
  const order = group.elements
    .map((_, idx) => idx)
    .sort((a, b) => {
      const wa = group.elements[a].wildcard ? 1 : 0;
      const wb = group.elements[b].wildcard ? 1 : 0;
      return wa - wb;
    });

  for (let i = 0; i <= limit; i++) {
    // 每轮重置占用位图（fill 比新建数组快）
    occ.fill(0, 0, blockSize + 1);

    let ok = true;
    for (const ei of order) {
      const el = group.elements[ei];
      const step = group.outOfOrderAligned && el.width > 1 ? el.width : 1;
      const winEnd = i + blockSize - el.width;
      let found = -1;

      for (let p = i; p <= winEnd; p += step) {
        // 与已占用区间重叠则跳过（相对 i 的偏移范围 [p-i, p-i+width)）
        const rel = p - i;
        let free = true;
        for (let q = rel; q < rel + el.width; q++) {
          if (occ[q] !== 0) {
            free = false;
            break;
          }
        }
        if (!free) continue;

        if (groupElementMatchesAt(el, buf, p)) {
          found = p;
          break;
        }
      }

      if (found === -1) {
        ok = false;
        break;
      }
      const rel = found - i;
      for (let q = rel; q < rel + el.width; q++) occ[q] = 1;
      el.outOffset = rel;
    }

    if (ok) out.push(i);
  }
}

/* ------------------------------------------------------------------ *
 * 导出给测试的辅助
 * ------------------------------------------------------------------ */

/** 用编译后的配置测试"某个值是否匹配"（便于单元测试，不依赖进程）。 */
export function testValueMatches(
  cfg: ScanConfig,
  current: Buffer,
  previous?: Buffer,
): boolean[] {
  const cc = compileConfig(cfg);
  const matches: number[] = [];
  const perRule: number[][] = [];
  scanBlock(cc, current, previous ?? null, matches, perRule);
  return perRule.map((m) => m.length > 0);
}

export { roundTo };
