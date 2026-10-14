/**
 * 核心类型定义 —— 与 Cheat Engine 源码严格对齐。
 *
 * 对齐依据（`Cheat Engine/memscan.pas`）：
 *   type TScanType=(stNewScan=0, stFirstScan=1, stNextScan=2);
 *   type TRoundingType=(rtRounded=0,rtExtremerounded=1,rtTruncated=2);
 *   type TVariableType=(vtByte=0, vtWord=1, vtDword=2, vtQword=3, vtSingle=4, vtDouble=5,
 *      vtString=6, vtUnicodeString=7, vtByteArray=8, vtBinary=9, vtAll=10,
 *      vtAutoAssembler=11, vtPointer=12, vtCustom=13, vtGrouped=14, vtByteArrays=15,
 *      vtCodePageString=16);
 *   type TPointerType=(ptStatic, ptDynamic, ptExecutable);
 *   type TScanOption=(soUnknownValue, soExactValue, soValueBetween, soBiggerThan,
 *      soSmallerThan, soIncreasedValue, soIncreasedValueBy, soDecreasedValue,
 *      soDecreasedValueBy, soChanged, soUnchanged, soIncreasedValueByPercentage,
 *      soDecreasedValueByPercentage, soValueBetweenPercentage);
 */
/** CE 的 TVariableType，枚举值与源码一一对应。 */
export declare enum VariableType {
    Byte = 0,
    Word = 1,
    DWord = 2,
    QWord = 3,
    Single = 4,
    Double = 5,
    String = 6,
    UnicodeString = 7,
    ByteArray = 8,
    Binary = 9,
    All = 10,
    AutoAssembler = 11,
    Pointer = 12,
    Custom = 13,
    Grouped = 14,
    ByteArrays = 15,
    CodePageString = 16
}
/** 类型名（用于命令行/日志） */
export declare const VARIABLE_TYPE_NAMES: Record<VariableType, string>;
/** 每种类型占用的字节宽度；变长/特殊类型为 0（由使用者显式给长度）。 */
export declare const VARIABLE_TYPE_SIZES: Record<VariableType, number>;
/** CE 的 TScanOption */
export declare enum ScanOption {
    UnknownValue = 0,
    ExactValue = 1,
    ValueBetween = 2,
    BiggerThan = 3,
    SmallerThan = 4,
    IncreasedValue = 5,
    IncreasedValueBy = 6,
    DecreasedValue = 7,
    DecreasedValueBy = 8,
    Changed = 9,
    Unchanged = 10,
    IncreasedValueByPercentage = 11,
    DecreasedValueByPercentage = 12,
    ValueBetweenPercentage = 13
}
export declare const SCAN_OPTION_NAMES: Record<ScanOption, string>;
/** CE 的 TRoundingType：浮点比较策略 */
export declare enum RoundingType {
    /** rtRounded=0 —— 四舍五入到小数位数后严格相等 */
    Rounded = 0,
    /** rtExtremerounded=1 —— 落在 [value-eps, value+eps] 区间 */
    ExtremeRounded = 1,
    /** rtTruncated=2 —— [value, value+step) 左闭右开 */
    Truncated = 2
}
/** CE 的 TScanType */
export declare enum ScanType {
    NewScan = 0,
    FirstScan = 1,
    NextScan = 2
}
/** CE 的 TPointerType */
export declare enum PointerType {
    Static = 0,
    Dynamic = 1,
    Executable = 2
}
/** CE 的 TFastScanMethod */
export declare enum FastScanMethod {
    NotAligned = 0,
    Aligned = 1,
    LastDigits = 2
}
/** 指针类型集合（对齐 TPointerTypes = set of TPointerType） */
export interface PointerTypes {
    static?: boolean;
    dynamic?: boolean;
    executable?: boolean;
}
/** 创建"全部指针类型"的便捷值，对齐 CE 默认。 */
export declare function allPointerTypes(): Required<PointerTypes>;
/** 内存区域可读性/保护属性，对齐 TaccessRight */
export interface AccessRights {
    execute?: boolean;
    read?: boolean;
    write?: boolean;
}
/** CE 的 TMemoryRegion（精简，用于扫描配置） */
export interface MemoryRegion {
    baseAddress: bigint;
    memorySize: bigint;
    /** 该区域之前是否已有区域（CE: IsChild） */
    isChild?: boolean;
    /** VirtualQueryEx 的 State == MEM_COMMIT */
    committed: boolean;
    /** 原始 Protect 值 */
    protect: number;
    /** 分配类型：MEM_IMAGE / MEM_MAPPED / MEM_PRIVATE */
    type: number;
}
/** 扫描过程中缓存的一块内存（原始内存副本 + 每条记录对应的原始值） */
export interface ScannedRegion {
    baseAddress: bigint;
    size: number;
    /** 提交状态的保护属性 */
    protect: number;
    /** 分配类型 MEM_IMAGE/MEM_MAPPED/MEM_PRIVATE */
    memType: number;
}
/** 一条扫描结果 */
export interface ScanResult {
    address: bigint;
    /** 首次扫描时若需要保存原始值，此处为该地址在本次扫描快照中的原始字节 */
    previous?: Buffer;
}
/** 扫描进度回调，对齐 TMemScanGuiUpdateRoutine */
export type ScanProgressCallback = (totalAddressesToScan: bigint, currentlyScanned: bigint, foundCount: bigint) => void;
/** 扫描配置 */
export interface ScanConfig {
    /** 变量类型 */
    variableType: VariableType;
    /** 扫描选项 */
    scanOption: ScanOption;
    /** 浮点比较策略 */
    roundingType: RoundingType;
    /** 小数位数（CE: floataccuracy，-1 表示使用字符串中的小数位数） */
    floatAccuracy: number;
    /** 扫描值 1（字符串形式，便于精确复刻 CE 的解析行为） */
    value1?: string;
    /** 扫描值 2（区间上界 / 百分比上界） */
    value2?: string;
    /** 是否按十六进制解析输入值 */
    hexadecimal?: boolean;
    /** 符号有无（整数区间） */
    signed?: boolean;
    /** 字符串扫描是否区分大小写（CE 默认不区分） */
    caseSensitive?: boolean;
    /** 文本编码（vtString / vtCodePageString） */
    codePage?: number;
    /** 字符串/Unicode 长度（字符数）；未给出时由 value1 推导 */
    stringLength?: number;
    /** 是否仅在可写内存中扫描 */
    writableOnly?: boolean;
    /** 是否仅在可执行内存中扫描 */
    executableOnly?: boolean;
    /** 是否包含 MEM_IMAGE */
    includeImage?: boolean;
    /** 是否包含 MEM_MAPPED */
    includeMapped?: boolean;
    /** 是否包含 MEM_PRIVATE */
    includePrivate?: boolean;
    /** 是否包含 PAGE_GUARD 区域 */
    includeGuard?: boolean;
    /** 对齐方式 */
    fastScanMethod?: FastScanMethod;
    /** fsmLastDigits 时的最后一位数字 */
    fastScanAlignmentLastDigits?: number;
    /** 是否只在 4GB 以下地址扫描（32 位目标） */
    is32Bit?: boolean;
    /** 扫描块大小（字节），默认 4MB */
    blockSize?: number;
    /** 是否在浮点扫描时排除含指数的浮点数（CE: floatscanWithoutExponents） */
    floatScanWithoutExponents?: boolean;
    /** AOB 二进制串（vtBinary 用） */
    binaryString?: string;
    /** vtBinary 是否按十进制解析 */
    binaryStringAsDecimal?: boolean;
    /** 分组长扫描条目 */
    groupElements?: GroupElement[];
    /** 分组长扫描是否允许乱序 */
    groupOutOfOrder?: boolean;
    /** 分组长扫描是否要求按类型宽度对齐 */
    groupAligned?: boolean;
}
/** CE 分组长扫描的单个条目（对齐 TGroupData 内部 record） */
export interface GroupElement {
    variableType: VariableType;
    /** 通配符：只参与偏移计算，不比较数值 */
    wildcard?: boolean;
    value?: string;
    value2?: string;
    hexadecimal?: boolean;
    signed?: boolean;
    floatAccuracy?: number;
    roundingType?: RoundingType;
    /** 字符串长度（字符） */
    stringLength?: number;
    /** vtByteArray 数组 */
    aob?: string;
    /** 指针类型（通配符指针） */
    pointerTypes?: PointerTypes;
}
/** 内存保护常量 */
export declare const MEM_COMMIT = 4096;
export declare const MEM_RESERVE = 8192;
export declare const MEM_FREE = 65536;
export declare const MEM_PRIVATE = 131072;
export declare const MEM_MAPPED = 262144;
export declare const MEM_IMAGE = 16777216;
export declare const PAGE_NOACCESS = 1;
export declare const PAGE_READONLY = 2;
export declare const PAGE_READWRITE = 4;
export declare const PAGE_WRITECOPY = 8;
export declare const PAGE_EXECUTE = 16;
export declare const PAGE_EXECUTE_READ = 32;
export declare const PAGE_EXECUTE_READWRITE = 64;
export declare const PAGE_EXECUTE_WRITECOPY = 128;
export declare const PAGE_GUARD = 256;
export declare const PAGE_NOCACHE = 512;
export declare const PAGE_WRITECOMBINE = 1024;
/** 进程访问权限常量 */
export declare const PROCESS_TERMINATE = 1;
export declare const PROCESS_CREATE_THREAD = 2;
export declare const PROCESS_VM_OPERATION = 8;
export declare const PROCESS_VM_READ = 16;
export declare const PROCESS_VM_WRITE = 32;
export declare const PROCESS_QUERY_INFORMATION = 1024;
export declare const PROCESS_QUERY_LIMITED_INFORMATION = 4096;
export declare const PROCESS_SUSPEND_RESUME = 2048;
/**
 * `SYNCHRONIZE` —— 等待进程对象（判断目标是否还活着）所必需的权限。
 *
 * `WaitForSingleObject(hProcess, 0)` 在缺少它时**不会**报"参数错误"，
 * 而是返回 `WAIT_FAILED` 且 `GetLastError() = 5 (ERROR_ACCESS_DENIED)`，
 * 于是"存活判断"会静默地把一切目标都判成已退出（真踩过）。
 */
export declare const PROCESS_SYNCHRONIZE = 1048576;
/**
 * 打开进程所需的最小权限组合。
 * 对齐 CE 的 ProcessHandler：读写 + 查询 + 分配/保护内存，
 * 外加 `SYNCHRONIZE` —— 只有拿到它才能可靠地判断目标进程是否已退出
 * （见 `Process.isProcessAlive`）。
 */
export declare const DEFAULT_PROCESS_ACCESS: number;
/** 64 位用户态最高地址（不含），用于 VirtualQueryEx 遍历上界。 */
export declare const MAX_USER_ADDRESS_64 = 140737488355327n;
//# sourceMappingURL=types.d.ts.map