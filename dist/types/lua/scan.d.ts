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
import { Process } from '../win/process';
import { CompiledConfig } from '../scanner/matcher';
import { MemoryRegion, ScanConfig, VariableType } from '../types';
import { LuaMarshal } from './marshal';
import type { LuaValue, ScannerFacade } from './types';
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
export declare function parseScanConfig(m: LuaMarshal, raw: LuaValue, funcName: string): ScanConfig;
/** 把 CE 的 alignmentparam（十进制或十六进制串）解析成步长。 */
export declare function parseAlignmentParam(param: string): number | null;
/** 把字符串或数字翻译成变量类型（供对象属性 setType 等复用）。 */
export declare function parseVariableType(m: LuaMarshal, value: LuaValue | undefined, funcName: string, def?: VariableType): VariableType;
/** 变量类型宽度（变长类型返回 0）。 */
export declare function variableWidth(type: VariableType): number;
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
export declare function parseProtectionFlags(flags: string): ProtectionFilter;
/** 区域是否满足保护属性过滤。 */
export declare function regionMatchesProtection(region: MemoryRegion, pf: ProtectionFilter): boolean;
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
    findModule: (name: string) => {
        baseAddress: bigint;
        size: number;
    } | null;
}
/** CE 的 `inttohex(address, 8)`：至少 8 位大写十六进制，无 0x 前缀。 */
export declare function addressToCeHex(address: bigint): string;
/** 构造 AOB 的扫描配置。 */
export declare function buildAobConfig(m: LuaMarshal, opts: AobScanOptions): ScanConfig;
/**
 * AOB 扫描入口。
 *
 * @returns 命中地址（升序，按区域顺序 + 块内偏移）
 */
export declare function scanAob(proc: Process, facade: ScannerFacade, m: LuaMarshal, opts: AobScanOptions): bigint[];
/**
 * 手工分块 AOB 扫描（限定模块 / 需要排除某类内存时使用）。
 *
 * 与 ScanSession 的差异：单线程、按 4MB 分块、块之间带 (模式长度-1) 字节重叠，
 * 保证跨块边界的特征也能命中。
 */
export declare function scanAobManual(proc: Process, facade: ScannerFacade, cfg: ScanConfig, opts: AobScanOptions, pf: ProtectionFilter): bigint[];
/** 供 AOBScanUnique 使用：全地址空间的手工扫描（命中即停）。 */
export declare function scanAobFirst(proc: Process, facade: ScannerFacade, m: LuaMarshal, opts: AobScanOptions): bigint | null;
/** 供引擎内部复用：把 ScanConfig 直接交给 compileConfig（避免重复 import）。 */
export declare function compileScanConfig(cfg: ScanConfig): CompiledConfig;
/** 供引擎内部复用：单块扫描转发。 */
export declare function scanBuffer(cc: CompiledConfig, buf: Buffer, out: number[]): void;
//# sourceMappingURL=scan.d.ts.map