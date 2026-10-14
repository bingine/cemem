"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_USER_ADDRESS_64 = exports.DEFAULT_PROCESS_ACCESS = exports.PROCESS_SYNCHRONIZE = exports.PROCESS_SUSPEND_RESUME = exports.PROCESS_QUERY_LIMITED_INFORMATION = exports.PROCESS_QUERY_INFORMATION = exports.PROCESS_VM_WRITE = exports.PROCESS_VM_READ = exports.PROCESS_VM_OPERATION = exports.PROCESS_CREATE_THREAD = exports.PROCESS_TERMINATE = exports.PAGE_WRITECOMBINE = exports.PAGE_NOCACHE = exports.PAGE_GUARD = exports.PAGE_EXECUTE_WRITECOPY = exports.PAGE_EXECUTE_READWRITE = exports.PAGE_EXECUTE_READ = exports.PAGE_EXECUTE = exports.PAGE_WRITECOPY = exports.PAGE_READWRITE = exports.PAGE_READONLY = exports.PAGE_NOACCESS = exports.MEM_IMAGE = exports.MEM_MAPPED = exports.MEM_PRIVATE = exports.MEM_FREE = exports.MEM_RESERVE = exports.MEM_COMMIT = exports.FastScanMethod = exports.PointerType = exports.ScanType = exports.RoundingType = exports.SCAN_OPTION_NAMES = exports.ScanOption = exports.VARIABLE_TYPE_SIZES = exports.VARIABLE_TYPE_NAMES = exports.VariableType = void 0;
exports.allPointerTypes = allPointerTypes;
/** CE 的 TVariableType，枚举值与源码一一对应。 */
var VariableType;
(function (VariableType) {
    VariableType[VariableType["Byte"] = 0] = "Byte";
    VariableType[VariableType["Word"] = 1] = "Word";
    VariableType[VariableType["DWord"] = 2] = "DWord";
    VariableType[VariableType["QWord"] = 3] = "QWord";
    VariableType[VariableType["Single"] = 4] = "Single";
    VariableType[VariableType["Double"] = 5] = "Double";
    VariableType[VariableType["String"] = 6] = "String";
    VariableType[VariableType["UnicodeString"] = 7] = "UnicodeString";
    VariableType[VariableType["ByteArray"] = 8] = "ByteArray";
    VariableType[VariableType["Binary"] = 9] = "Binary";
    VariableType[VariableType["All"] = 10] = "All";
    VariableType[VariableType["AutoAssembler"] = 11] = "AutoAssembler";
    VariableType[VariableType["Pointer"] = 12] = "Pointer";
    VariableType[VariableType["Custom"] = 13] = "Custom";
    VariableType[VariableType["Grouped"] = 14] = "Grouped";
    VariableType[VariableType["ByteArrays"] = 15] = "ByteArrays";
    VariableType[VariableType["CodePageString"] = 16] = "CodePageString";
})(VariableType || (exports.VariableType = VariableType = {}));
/** 类型名（用于命令行/日志） */
exports.VARIABLE_TYPE_NAMES = {
    [VariableType.Byte]: 'byte',
    [VariableType.Word]: 'word',
    [VariableType.DWord]: 'dword',
    [VariableType.QWord]: 'qword',
    [VariableType.Single]: 'float',
    [VariableType.Double]: 'double',
    [VariableType.String]: 'string',
    [VariableType.UnicodeString]: 'unicode',
    [VariableType.ByteArray]: 'aob',
    [VariableType.Binary]: 'binary',
    [VariableType.All]: 'all',
    [VariableType.AutoAssembler]: 'autoassembler',
    [VariableType.Pointer]: 'pointer',
    [VariableType.Custom]: 'custom',
    [VariableType.Grouped]: 'grouped',
    [VariableType.ByteArrays]: 'aobs',
    [VariableType.CodePageString]: 'codepagestring',
};
/** 每种类型占用的字节宽度；变长/特殊类型为 0（由使用者显式给长度）。 */
exports.VARIABLE_TYPE_SIZES = {
    [VariableType.Byte]: 1,
    [VariableType.Word]: 2,
    [VariableType.DWord]: 4,
    [VariableType.QWord]: 8,
    [VariableType.Single]: 4,
    [VariableType.Double]: 8,
    [VariableType.String]: 0,
    [VariableType.UnicodeString]: 0,
    [VariableType.ByteArray]: 0,
    [VariableType.Binary]: 0,
    [VariableType.All]: 0,
    [VariableType.AutoAssembler]: 0,
    [VariableType.Pointer]: 8,
    [VariableType.Custom]: 0,
    [VariableType.Grouped]: 0,
    [VariableType.ByteArrays]: 0,
    [VariableType.CodePageString]: 0,
};
/** CE 的 TScanOption */
var ScanOption;
(function (ScanOption) {
    ScanOption[ScanOption["UnknownValue"] = 0] = "UnknownValue";
    ScanOption[ScanOption["ExactValue"] = 1] = "ExactValue";
    ScanOption[ScanOption["ValueBetween"] = 2] = "ValueBetween";
    ScanOption[ScanOption["BiggerThan"] = 3] = "BiggerThan";
    ScanOption[ScanOption["SmallerThan"] = 4] = "SmallerThan";
    ScanOption[ScanOption["IncreasedValue"] = 5] = "IncreasedValue";
    ScanOption[ScanOption["IncreasedValueBy"] = 6] = "IncreasedValueBy";
    ScanOption[ScanOption["DecreasedValue"] = 7] = "DecreasedValue";
    ScanOption[ScanOption["DecreasedValueBy"] = 8] = "DecreasedValueBy";
    ScanOption[ScanOption["Changed"] = 9] = "Changed";
    ScanOption[ScanOption["Unchanged"] = 10] = "Unchanged";
    ScanOption[ScanOption["IncreasedValueByPercentage"] = 11] = "IncreasedValueByPercentage";
    ScanOption[ScanOption["DecreasedValueByPercentage"] = 12] = "DecreasedValueByPercentage";
    ScanOption[ScanOption["ValueBetweenPercentage"] = 13] = "ValueBetweenPercentage";
})(ScanOption || (exports.ScanOption = ScanOption = {}));
exports.SCAN_OPTION_NAMES = {
    [ScanOption.UnknownValue]: '未知初始值',
    [ScanOption.ExactValue]: '精确数值',
    [ScanOption.ValueBetween]: '数值介于',
    [ScanOption.BiggerThan]: '大于',
    [ScanOption.SmallerThan]: '小于',
    [ScanOption.IncreasedValue]: '增加了',
    [ScanOption.IncreasedValueBy]: '增加指定数值',
    [ScanOption.DecreasedValue]: '减少了',
    [ScanOption.DecreasedValueBy]: '减少指定数值',
    [ScanOption.Changed]: '变动了',
    [ScanOption.Unchanged]: '未变动',
    [ScanOption.IncreasedValueByPercentage]: '增加百分比',
    [ScanOption.DecreasedValueByPercentage]: '减少百分比',
    [ScanOption.ValueBetweenPercentage]: '数值介于百分比',
};
/** CE 的 TRoundingType：浮点比较策略 */
var RoundingType;
(function (RoundingType) {
    /** rtRounded=0 —— 四舍五入到小数位数后严格相等 */
    RoundingType[RoundingType["Rounded"] = 0] = "Rounded";
    /** rtExtremerounded=1 —— 落在 [value-eps, value+eps] 区间 */
    RoundingType[RoundingType["ExtremeRounded"] = 1] = "ExtremeRounded";
    /** rtTruncated=2 —— [value, value+step) 左闭右开 */
    RoundingType[RoundingType["Truncated"] = 2] = "Truncated";
})(RoundingType || (exports.RoundingType = RoundingType = {}));
/** CE 的 TScanType */
var ScanType;
(function (ScanType) {
    ScanType[ScanType["NewScan"] = 0] = "NewScan";
    ScanType[ScanType["FirstScan"] = 1] = "FirstScan";
    ScanType[ScanType["NextScan"] = 2] = "NextScan";
})(ScanType || (exports.ScanType = ScanType = {}));
/** CE 的 TPointerType */
var PointerType;
(function (PointerType) {
    PointerType[PointerType["Static"] = 0] = "Static";
    PointerType[PointerType["Dynamic"] = 1] = "Dynamic";
    PointerType[PointerType["Executable"] = 2] = "Executable";
})(PointerType || (exports.PointerType = PointerType = {}));
/** CE 的 TFastScanMethod */
var FastScanMethod;
(function (FastScanMethod) {
    FastScanMethod[FastScanMethod["NotAligned"] = 0] = "NotAligned";
    FastScanMethod[FastScanMethod["Aligned"] = 1] = "Aligned";
    FastScanMethod[FastScanMethod["LastDigits"] = 2] = "LastDigits";
})(FastScanMethod || (exports.FastScanMethod = FastScanMethod = {}));
/** 创建"全部指针类型"的便捷值，对齐 CE 默认。 */
function allPointerTypes() {
    return { static: true, dynamic: true, executable: true };
}
/** 内存保护常量 */
exports.MEM_COMMIT = 0x1000;
exports.MEM_RESERVE = 0x2000;
exports.MEM_FREE = 0x10000;
exports.MEM_PRIVATE = 0x20000;
exports.MEM_MAPPED = 0x40000;
exports.MEM_IMAGE = 0x1000000;
exports.PAGE_NOACCESS = 0x01;
exports.PAGE_READONLY = 0x02;
exports.PAGE_READWRITE = 0x04;
exports.PAGE_WRITECOPY = 0x08;
exports.PAGE_EXECUTE = 0x10;
exports.PAGE_EXECUTE_READ = 0x20;
exports.PAGE_EXECUTE_READWRITE = 0x40;
exports.PAGE_EXECUTE_WRITECOPY = 0x80;
exports.PAGE_GUARD = 0x100;
exports.PAGE_NOCACHE = 0x200;
exports.PAGE_WRITECOMBINE = 0x400;
/** 进程访问权限常量 */
exports.PROCESS_TERMINATE = 0x0001;
exports.PROCESS_CREATE_THREAD = 0x0002;
exports.PROCESS_VM_OPERATION = 0x0008;
exports.PROCESS_VM_READ = 0x0010;
exports.PROCESS_VM_WRITE = 0x0020;
exports.PROCESS_QUERY_INFORMATION = 0x0400;
exports.PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
exports.PROCESS_SUSPEND_RESUME = 0x0800;
/**
 * `SYNCHRONIZE` —— 等待进程对象（判断目标是否还活着）所必需的权限。
 *
 * `WaitForSingleObject(hProcess, 0)` 在缺少它时**不会**报"参数错误"，
 * 而是返回 `WAIT_FAILED` 且 `GetLastError() = 5 (ERROR_ACCESS_DENIED)`，
 * 于是"存活判断"会静默地把一切目标都判成已退出（真踩过）。
 */
exports.PROCESS_SYNCHRONIZE = 0x00100000;
/**
 * 打开进程所需的最小权限组合。
 * 对齐 CE 的 ProcessHandler：读写 + 查询 + 分配/保护内存，
 * 外加 `SYNCHRONIZE` —— 只有拿到它才能可靠地判断目标进程是否已退出
 * （见 `Process.isProcessAlive`）。
 */
exports.DEFAULT_PROCESS_ACCESS = exports.PROCESS_QUERY_INFORMATION |
    exports.PROCESS_VM_READ |
    exports.PROCESS_VM_WRITE |
    exports.PROCESS_VM_OPERATION |
    exports.PROCESS_CREATE_THREAD |
    exports.PROCESS_SUSPEND_RESUME |
    exports.PROCESS_SYNCHRONIZE;
/** 64 位用户态最高地址（不含），用于 VirtualQueryEx 遍历上界。 */
exports.MAX_USER_ADDRESS_64 = 0x7fffffffffffn;
//# sourceMappingURL=types.js.map