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
import { BinaryPattern, FloatCompareParams, PatternByte, roundTo } from '../value-codec';
import { RoundingType, ScanConfig, ScanOption, VariableType } from '../types';
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
    str?: {
        target: string;
        upper: string;
        byteLength: number;
        wide: boolean;
        caseSensitive: boolean;
    };
    /** AOB 模式 */
    aob?: {
        pattern: PatternByte[];
        nibble: boolean;
    };
    /** 二进制位串 */
    bin?: {
        pattern: BinaryPattern;
        width: number;
    };
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
    str?: {
        target: string;
        upper: string;
        byteLength: number;
        wide: boolean;
        caseSensitive: boolean;
    };
    aob?: {
        pattern: PatternByte[];
        nibble: boolean;
    };
    bin?: {
        pattern: BinaryPattern;
        width: number;
    };
    /** 乱序模式下的输出偏移 */
    outOffset?: number;
}
/** 是否需要保存"上一次的值"（next scan 的旧值语义）。 */
export declare function optionNeedsOldValue(option: ScanOption): boolean;
/** 编译用户扫描配置。 */
export declare function compileConfig(cfg: ScanConfig): CompiledConfig;
/**
 * 在内存块中扫描，把命中的"块内偏移"写入 out。
 *
 * @param cc     编译后的配置
 * @param buf    当前内存块
 * @param prev   上一次扫描时同一区域的原始内存（next scan 用）；长度与 buf 对齐
 * @param out    输出块内偏移
 * @param outMatches 输出每个偏移命中的规则下标（与 out 平行，按类型区分结果时需要）
 */
export declare function scanBlock(cc: CompiledConfig, buf: Buffer, prev: Buffer | null, out: number[], outMatches?: number[][]): void;
/** 用编译后的配置测试"某个值是否匹配"（便于单元测试，不依赖进程）。 */
export declare function testValueMatches(cfg: ScanConfig, current: Buffer, previous?: Buffer): boolean[];
export { roundTo };
//# sourceMappingURL=matcher.d.ts.map