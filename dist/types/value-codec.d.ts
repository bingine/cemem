/**
 * 数值编解码层 —— 与 Cheat Engine `memscan.pas` 的变量类型语义严格对齐。
 *
 * 本模块负责三件事：
 *  1. 从 Buffer 中按 CE 的变量类型读写数值（含大小端、精度、有符号/无符号）；
 *  2. 复刻 CE 的扫描值解析（十六进制前缀、区间、百分比、小数位数 floataccuracy）；
 *  3. 复刻 CE 的浮点比较策略（rtRounded / rtExtremerounded / rtTruncated）。
 *
 * 对齐依据：`memscan.pas` 的 SingleExact/DoubleExact/SingleBetween 等
 *   以及 setScanValueFloat 片段（floataccuracy 计算、RoundTo 调用、min/max 边界）。
 */
import { RoundingType, VariableType } from './types';
export declare function readUInt8(buf: Buffer, off: number): number;
export declare function readInt8(buf: Buffer, off: number): number;
export declare function readUInt16(buf: Buffer, off: number): number;
export declare function readInt16(buf: Buffer, off: number): number;
export declare function readUInt32(buf: Buffer, off: number): number;
export declare function readInt32(buf: Buffer, off: number): number;
export declare function readUInt64(buf: Buffer, off: number): bigint;
export declare function readInt64(buf: Buffer, off: number): bigint;
export declare function readSingle(buf: Buffer, off: number): number;
export declare function readDouble(buf: Buffer, off: number): number;
export declare function writeUInt8(buf: Buffer, off: number, v: number | bigint): void;
export declare function writeUInt16(buf: Buffer, off: number, v: number | bigint): void;
export declare function writeUInt32(buf: Buffer, off: number, v: number | bigint): void;
export declare function writeUInt64(buf: Buffer, off: number, v: number | bigint): void;
export declare function writeSingle(buf: Buffer, off: number, v: number): void;
export declare function writeDouble(buf: Buffer, off: number, v: number): void;
/** 按变量类型把值写入 buffer（写入路径的统一起点）。 */
export declare function writeValue(buf: Buffer, off: number, type: VariableType, value: number | bigint | string): void;
export declare function roundTo(value: number, decimals: number): number;
export interface ParsedNumber {
    /** 解析出的原始数值（无符号 64 位语义） */
    raw: bigint;
    /** 该值是否为负数写法（决定区间比较时用有符号解释） */
    negative: boolean;
    /** 是否按十六进制解析 */
    hex: boolean;
}
/**
 * 解析 CE 风格的整数字面量。
 * 支持：十进制、`$`/`0x` 前缀十六进制、可选的 `+`/`-` 前缀。
 * 无效时抛错，便于 CLI 给出明确提示。
 */
export declare function parseIntegerLiteral(input: string, forceHex?: boolean): ParsedNumber;
/** 解析浮点字面量（支持科学计数法）。 */
export declare function parseFloatLiteral(input: string): number;
/** 统计字符串中的小数位数，对齐 CE 的 floataccuracy 推导。 */
export declare function decimalsOf(input: string): number;
export interface FloatCompareParams {
    /** 目标值（double 语义） */
    value: number;
    /** 目标值（single 语义，CE: svalue） */
    single: number;
    /** 小数位数 */
    accuracy: number;
    /** 区间上界 */
    value2?: number;
    single2?: number;
    /** extreme-rounded 边界 */
    minSingle: number;
    maxSingle: number;
    minDouble: number;
    maxDouble: number;
    /** truncated 上界 */
    maxTruncSingle: number;
    maxTruncDouble: number;
    /** 百分比模式下已换算为倍率的值 */
    isPercentage: boolean;
}
/**
 * 由用户输入推导浮点比较参数。
 *
 * 对齐 CE `setScanValueFloat`：
 *   - floataccuracy = 去掉小数点后的位数（含 E 时置 0）
 *   - 非百分比且 accuracy != 0 时，对 svalue/svalue2/dvalue/dvalue2 做 RoundTo(., -accuracy)
 *   - accuracy != 0: min/max = value ∓ 1/10^accuracy
 *     否则:        min/max = value ∓ 1
 *   - truncated 模式 CE 使用 maxsvalue/maxdvalue 作为上界
 */
export declare function buildFloatCompareParams(value1: string, value2: string | undefined, isPercentage: boolean): FloatCompareParams;
/** 对齐 TScanner.SingleExact（注意 rtExtremerounded 用闭区间 ≥/≤）。 */
export declare function singleMatches(actual: number, p: FloatCompareParams, rounding: RoundingType): boolean;
/** 对齐 TScanner.DoubleExact（注意 rtExtremerounded 用开区间 >/<）。 */
export declare function doubleMatches(actual: number, p: FloatCompareParams, rounding: RoundingType): boolean;
/** AOB 的单个字节模式：wildcard 或带可选半字节掩码。 */
export interface PatternByte {
    /** 是否为完全通配 */
    wildcard: boolean;
    /** 必须匹配的值 */
    value: number;
    /** 掩码（与上内存字节后的结果需等于 value） */
    mask: number;
}
/**
 * 解析 AOB 字符串，对齐 `parsers.ConvertStringToBytes` + 半字节通配支持。
 *
 * 支持：
 *   - `90 90 ??`、`90,90,xx`、`9090??`（- 、 , 、空格均为分隔符，且允许两字符一组连写）
 *   - 半字节通配 `7*`、`*7`，对齐 CE 的 $8000f070 / $80000f07 编码语义
 */
export declare function parseAob(input: string, hexadecimal?: boolean): PatternByte[];
/** 判断 AOB 模式中是否含有半字节级通配（决定是否走慢路径）。 */
export declare function aobHasNibbleWildcard(pattern: PatternByte[]): boolean;
/** 在缓冲区指定偏移处比较 AOB 模式。 */
export declare function aobMatchesAt(buf: Buffer, off: number, pattern: PatternByte[], nibbleSupport: boolean): boolean;
/** vtBinary 的匹配参数，对齐 CE 的 andmask / bitmask 推导。 */
export interface BinaryPattern {
    andMask: bigint;
    bitMask: bigint;
    bitCount: number;
}
/**
 * 由位串推导 andmask/bitmask，对齐 CE setScanValue 中 vtBinary 分支：
 *   '?' 或 '*' → andmask 位 0，bitmask 位 0
 *   '0' / '1'  → andmask 位 1，bitmask 位取该数字
 */
export declare function parseBinaryPattern(input: string): BinaryPattern;
/** 位串在内存中的字节宽度（向上取整）。 */
export declare function binaryByteWidth(bitCount: number): number;
/** 对齐 testString：区分大小写 */
export declare function testString(buf: Buffer, off: number, target: string): boolean;
/** 对齐 testWideString：UTF-16LE 区分大小写 */
export declare function testWideString(buf: Buffer, off: number, target: string): boolean;
/** 对齐 CaseInsensitiveAnsiStringExact：仅 ASCII a-z 折叠为大写。 */
export declare function testStringCI(buf: Buffer, off: number, upperTarget: string): boolean;
/** 对齐 CaseInsensitiveUnicodeStringExact：用 UpCase 逐字符比较。 */
export declare function testWideStringCI(buf: Buffer, off: number, target: string): boolean;
/**
 * 对齐 FPC 的 system.UpCase（宽字符版）：
 * 只处理 Latin-1 的 a-z / à-þ 等基本区段，这里复刻 ASCII + Latin-1 行为。
 */
export declare function upCaseWide(c: number): number;
//# sourceMappingURL=value-codec.d.ts.map