"use strict";
/**
 * node-cheat-engine —— Cheat Engine 核心引擎的 Node.js 移植版。
 *
 * 公共 API 入口。设计目标：用 Node 复刻 CE 在**用户态**能做的核心能力：
 * 跨进程内存读写、全类型内存扫描（对齐 memscan.pas 的比较语义）、
 * 指针扫描、地址表与 .CT 读写、地址表达式解析、脚本桥。
 *
 * 明确不在范围内（Node 中不存在实现路径，详见 PORT-SCOPE.md）：
 *   - dbk32/DBKKernel 内核驱动：ring-0 物理内存读写、绕过进程保护
 *   - dbvm/DBVM UEFI：VT-x/AMD-V hypervisor、硬件断点与隐身
 *   - LCL/VCL 图形界面（.lfm 窗体）
 *   - x86/x64 反汇编与汇编器（原样保留 AutoAssembler 语义需要独立移植）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DbkBackend = exports.CESERVER_DEFAULT_PORT = exports.CESERVER_CMD = exports.CeReader = exports.CeWriter = exports.CeServerConnection = exports.NativeCeBackend = exports.filterScanRegions = exports.SelfBackend = exports.BackendUnsupportedError = exports.aobHasNibbleWildcard = exports.aobMatchesAt = exports.doubleMatches = exports.singleMatches = exports.buildFloatCompareParams = exports.parseBinaryPattern = exports.parseAob = exports.decimalsOf = exports.parseFloatLiteral = exports.parseIntegerLiteral = exports.roundTo = exports.DEFAULT_PROCESS_ACCESS = exports.PROCESS_QUERY_INFORMATION = exports.PROCESS_VM_OPERATION = exports.PROCESS_VM_WRITE = exports.PROCESS_VM_READ = exports.PAGE_GUARD = exports.PAGE_EXECUTE_WRITECOPY = exports.PAGE_EXECUTE_READWRITE = exports.PAGE_EXECUTE_READ = exports.PAGE_EXECUTE = exports.PAGE_WRITECOPY = exports.PAGE_READWRITE = exports.PAGE_READONLY = exports.PAGE_NOACCESS = exports.MEM_IMAGE = exports.MEM_MAPPED = exports.MEM_PRIVATE = exports.MEM_FREE = exports.MEM_RESERVE = exports.MEM_COMMIT = exports.SCAN_OPTION_NAMES = exports.VARIABLE_TYPE_SIZES = exports.VARIABLE_TYPE_NAMES = exports.FastScanMethod = exports.PointerType = exports.ScanType = exports.RoundingType = exports.ScanOption = exports.VariableType = void 0;
exports.writeCheatTable = exports.parseCheatTable = exports.buildRecordsFromScan = exports.addScanResults = exports.MemoryRecord = exports.AddressList = exports.ExpressionError = exports.CompiledAddress = exports.resolveAddress = exports.evaluateExpression = exports.compileExpression = exports.applyPointerPath = exports.formatPointerPath = exports.PointerScanner = exports.optionNeedsOldValue = exports.scanBlock = exports.compileConfig = exports.ScanSession = exports.win32ErrorMessage = exports.findProcessesByNameAsync = exports.listProcessesAsync = exports.openProcessByNameAsync = exports.openProcessAsync = exports.regionTypeName = exports.setDefaultBackend = exports.getDefaultBackend = exports.isExecutable = exports.isWritable = exports.isReadable = exports.selectScannableRegions = exports.enumerateRegions = exports.findProcessesByName = exports.listProcesses = exports.ProcessOpenError = exports.Process = exports.readServiceNameFromDriverDat = exports.resolveDevicePath = exports.readAllocResult = exports.packAllocInput = exports.packWriteBuffer = exports.packReadInput = exports.DEFAULT_DBK_SERVICE_NAME = exports.DBK_ALLOC_INPUT_SIZE = exports.DBK_MAX_READ_CHUNK = exports.DBK_MAX_WRITE_PAYLOAD = exports.DBK_WRITE_BUFFER_SIZE = exports.DBK_WRITE_INPUT_SIZE = exports.DBK_READ_INPUT_SIZE = exports.DBK_IOCTL = exports.DbkDeviceError = void 0;
exports.bytesToDbArguments = exports.patternToDbArguments = exports.parsePseudoDirective = exports.encodeAlign = exports.encodeNop = exports.encodeDataDirective = exports.splitDirectiveArguments = exports.parseCeInteger = exports.autoAssemble = exports.AutoAssemblerError = exports.AutoAssembler = exports.AssemblerError = exports.assembleToBytes = exports.assembleLines = exports.assemble = exports.DisasmValueType = exports.instructionText = exports.branchTarget = exports.formatBytes = exports.splitDisassembledString = exports.formatDisassembled = exports.disassembleAt = exports.disassembleOne = exports.disassemble = exports.AsmBackendError = exports.toSafeNumberAddress = exports.backendVersions = exports.instructionNameOf = exports.assembleRaw = exports.disassembleRaw = exports.archFromBitness = exports.normalizeArchitecture = exports.architectureInfo = exports.isArchitectureSupported = exports.resetAsmBackendForTests = exports.isAsmBackendReady = exports.ensureAsmBackend = exports.LuaMarshal = exports.LuaError = exports.LuaScriptError = exports.LuaEngine = exports.stringToVariableType = exports.variableTypeToString = exports.ctAddressForFile = exports.normalizeCtAddress = exports.collectSymbols = exports.saveCheatTable = exports.loadCheatTable = void 0;
var types_1 = require("./types");
Object.defineProperty(exports, "VariableType", { enumerable: true, get: function () { return types_1.VariableType; } });
Object.defineProperty(exports, "ScanOption", { enumerable: true, get: function () { return types_1.ScanOption; } });
Object.defineProperty(exports, "RoundingType", { enumerable: true, get: function () { return types_1.RoundingType; } });
Object.defineProperty(exports, "ScanType", { enumerable: true, get: function () { return types_1.ScanType; } });
Object.defineProperty(exports, "PointerType", { enumerable: true, get: function () { return types_1.PointerType; } });
Object.defineProperty(exports, "FastScanMethod", { enumerable: true, get: function () { return types_1.FastScanMethod; } });
Object.defineProperty(exports, "VARIABLE_TYPE_NAMES", { enumerable: true, get: function () { return types_1.VARIABLE_TYPE_NAMES; } });
Object.defineProperty(exports, "VARIABLE_TYPE_SIZES", { enumerable: true, get: function () { return types_1.VARIABLE_TYPE_SIZES; } });
Object.defineProperty(exports, "SCAN_OPTION_NAMES", { enumerable: true, get: function () { return types_1.SCAN_OPTION_NAMES; } });
Object.defineProperty(exports, "MEM_COMMIT", { enumerable: true, get: function () { return types_1.MEM_COMMIT; } });
Object.defineProperty(exports, "MEM_RESERVE", { enumerable: true, get: function () { return types_1.MEM_RESERVE; } });
Object.defineProperty(exports, "MEM_FREE", { enumerable: true, get: function () { return types_1.MEM_FREE; } });
Object.defineProperty(exports, "MEM_PRIVATE", { enumerable: true, get: function () { return types_1.MEM_PRIVATE; } });
Object.defineProperty(exports, "MEM_MAPPED", { enumerable: true, get: function () { return types_1.MEM_MAPPED; } });
Object.defineProperty(exports, "MEM_IMAGE", { enumerable: true, get: function () { return types_1.MEM_IMAGE; } });
Object.defineProperty(exports, "PAGE_NOACCESS", { enumerable: true, get: function () { return types_1.PAGE_NOACCESS; } });
Object.defineProperty(exports, "PAGE_READONLY", { enumerable: true, get: function () { return types_1.PAGE_READONLY; } });
Object.defineProperty(exports, "PAGE_READWRITE", { enumerable: true, get: function () { return types_1.PAGE_READWRITE; } });
Object.defineProperty(exports, "PAGE_WRITECOPY", { enumerable: true, get: function () { return types_1.PAGE_WRITECOPY; } });
Object.defineProperty(exports, "PAGE_EXECUTE", { enumerable: true, get: function () { return types_1.PAGE_EXECUTE; } });
Object.defineProperty(exports, "PAGE_EXECUTE_READ", { enumerable: true, get: function () { return types_1.PAGE_EXECUTE_READ; } });
Object.defineProperty(exports, "PAGE_EXECUTE_READWRITE", { enumerable: true, get: function () { return types_1.PAGE_EXECUTE_READWRITE; } });
Object.defineProperty(exports, "PAGE_EXECUTE_WRITECOPY", { enumerable: true, get: function () { return types_1.PAGE_EXECUTE_WRITECOPY; } });
Object.defineProperty(exports, "PAGE_GUARD", { enumerable: true, get: function () { return types_1.PAGE_GUARD; } });
Object.defineProperty(exports, "PROCESS_VM_READ", { enumerable: true, get: function () { return types_1.PROCESS_VM_READ; } });
Object.defineProperty(exports, "PROCESS_VM_WRITE", { enumerable: true, get: function () { return types_1.PROCESS_VM_WRITE; } });
Object.defineProperty(exports, "PROCESS_VM_OPERATION", { enumerable: true, get: function () { return types_1.PROCESS_VM_OPERATION; } });
Object.defineProperty(exports, "PROCESS_QUERY_INFORMATION", { enumerable: true, get: function () { return types_1.PROCESS_QUERY_INFORMATION; } });
Object.defineProperty(exports, "DEFAULT_PROCESS_ACCESS", { enumerable: true, get: function () { return types_1.DEFAULT_PROCESS_ACCESS; } });
/* —— 值编解码 —— */
var value_codec_1 = require("./value-codec");
Object.defineProperty(exports, "roundTo", { enumerable: true, get: function () { return value_codec_1.roundTo; } });
Object.defineProperty(exports, "parseIntegerLiteral", { enumerable: true, get: function () { return value_codec_1.parseIntegerLiteral; } });
Object.defineProperty(exports, "parseFloatLiteral", { enumerable: true, get: function () { return value_codec_1.parseFloatLiteral; } });
Object.defineProperty(exports, "decimalsOf", { enumerable: true, get: function () { return value_codec_1.decimalsOf; } });
Object.defineProperty(exports, "parseAob", { enumerable: true, get: function () { return value_codec_1.parseAob; } });
Object.defineProperty(exports, "parseBinaryPattern", { enumerable: true, get: function () { return value_codec_1.parseBinaryPattern; } });
Object.defineProperty(exports, "buildFloatCompareParams", { enumerable: true, get: function () { return value_codec_1.buildFloatCompareParams; } });
Object.defineProperty(exports, "singleMatches", { enumerable: true, get: function () { return value_codec_1.singleMatches; } });
Object.defineProperty(exports, "doubleMatches", { enumerable: true, get: function () { return value_codec_1.doubleMatches; } });
Object.defineProperty(exports, "aobMatchesAt", { enumerable: true, get: function () { return value_codec_1.aobMatchesAt; } });
Object.defineProperty(exports, "aobHasNibbleWildcard", { enumerable: true, get: function () { return value_codec_1.aobHasNibbleWildcard; } });
var types_2 = require("./backend/types");
Object.defineProperty(exports, "BackendUnsupportedError", { enumerable: true, get: function () { return types_2.BackendUnsupportedError; } });
var self_backend_1 = require("./backend/self-backend");
Object.defineProperty(exports, "SelfBackend", { enumerable: true, get: function () { return self_backend_1.SelfBackend; } });
Object.defineProperty(exports, "filterScanRegions", { enumerable: true, get: function () { return self_backend_1.filterScanRegions; } });
var native_ce_backend_1 = require("./backend/native-ce-backend");
Object.defineProperty(exports, "NativeCeBackend", { enumerable: true, get: function () { return native_ce_backend_1.NativeCeBackend; } });
Object.defineProperty(exports, "CeServerConnection", { enumerable: true, get: function () { return native_ce_backend_1.CeServerConnection; } });
Object.defineProperty(exports, "CeWriter", { enumerable: true, get: function () { return native_ce_backend_1.CeWriter; } });
Object.defineProperty(exports, "CeReader", { enumerable: true, get: function () { return native_ce_backend_1.CeReader; } });
Object.defineProperty(exports, "CESERVER_CMD", { enumerable: true, get: function () { return native_ce_backend_1.CESERVER_CMD; } });
Object.defineProperty(exports, "CESERVER_DEFAULT_PORT", { enumerable: true, get: function () { return native_ce_backend_1.CESERVER_DEFAULT_PORT; } });
/* —— DBK 内核驱动后端 ——
 *
 * 通过 CE 自己的 DBK 驱动 ioctl 读写受保护进程内存。**需要驱动已加载**
 * （加载需要管理员权限，见 `ce_kernel`）。
 *
 * ⚠️ 能力边界：ioctl 码与输入结构是按 CE 源码逐行实现的，但
 * **结构布局未经真机验证**（本机无法加载驱动来试），详见
 * `docs/backend-dbk.md` 的"未验证部分"。
 */
var dbk_backend_1 = require("./backend/dbk-backend");
Object.defineProperty(exports, "DbkBackend", { enumerable: true, get: function () { return dbk_backend_1.DbkBackend; } });
Object.defineProperty(exports, "DbkDeviceError", { enumerable: true, get: function () { return dbk_backend_1.DbkDeviceError; } });
Object.defineProperty(exports, "DBK_IOCTL", { enumerable: true, get: function () { return dbk_backend_1.DBK_IOCTL; } });
Object.defineProperty(exports, "DBK_READ_INPUT_SIZE", { enumerable: true, get: function () { return dbk_backend_1.DBK_READ_INPUT_SIZE; } });
Object.defineProperty(exports, "DBK_WRITE_INPUT_SIZE", { enumerable: true, get: function () { return dbk_backend_1.DBK_WRITE_INPUT_SIZE; } });
Object.defineProperty(exports, "DBK_WRITE_BUFFER_SIZE", { enumerable: true, get: function () { return dbk_backend_1.DBK_WRITE_BUFFER_SIZE; } });
Object.defineProperty(exports, "DBK_MAX_WRITE_PAYLOAD", { enumerable: true, get: function () { return dbk_backend_1.DBK_MAX_WRITE_PAYLOAD; } });
Object.defineProperty(exports, "DBK_MAX_READ_CHUNK", { enumerable: true, get: function () { return dbk_backend_1.DBK_MAX_READ_CHUNK; } });
Object.defineProperty(exports, "DBK_ALLOC_INPUT_SIZE", { enumerable: true, get: function () { return dbk_backend_1.DBK_ALLOC_INPUT_SIZE; } });
Object.defineProperty(exports, "DEFAULT_DBK_SERVICE_NAME", { enumerable: true, get: function () { return dbk_backend_1.DEFAULT_DBK_SERVICE_NAME; } });
Object.defineProperty(exports, "packReadInput", { enumerable: true, get: function () { return dbk_backend_1.packReadInput; } });
Object.defineProperty(exports, "packWriteBuffer", { enumerable: true, get: function () { return dbk_backend_1.packWriteBuffer; } });
Object.defineProperty(exports, "packAllocInput", { enumerable: true, get: function () { return dbk_backend_1.packAllocInput; } });
Object.defineProperty(exports, "readAllocResult", { enumerable: true, get: function () { return dbk_backend_1.readAllocResult; } });
Object.defineProperty(exports, "resolveDevicePath", { enumerable: true, get: function () { return dbk_backend_1.resolveDevicePath; } });
Object.defineProperty(exports, "readServiceNameFromDriverDat", { enumerable: true, get: function () { return dbk_backend_1.readServiceNameFromDriverDat; } });
/* —— 进程与内存 —— */
var process_1 = require("./win/process");
Object.defineProperty(exports, "Process", { enumerable: true, get: function () { return process_1.Process; } });
Object.defineProperty(exports, "ProcessOpenError", { enumerable: true, get: function () { return process_1.ProcessOpenError; } });
Object.defineProperty(exports, "listProcesses", { enumerable: true, get: function () { return process_1.listProcesses; } });
Object.defineProperty(exports, "findProcessesByName", { enumerable: true, get: function () { return process_1.findProcessesByName; } });
Object.defineProperty(exports, "enumerateRegions", { enumerable: true, get: function () { return process_1.enumerateRegions; } });
Object.defineProperty(exports, "selectScannableRegions", { enumerable: true, get: function () { return process_1.selectScannableRegions; } });
Object.defineProperty(exports, "isReadable", { enumerable: true, get: function () { return process_1.isReadable; } });
Object.defineProperty(exports, "isWritable", { enumerable: true, get: function () { return process_1.isWritable; } });
Object.defineProperty(exports, "isExecutable", { enumerable: true, get: function () { return process_1.isExecutable; } });
Object.defineProperty(exports, "getDefaultBackend", { enumerable: true, get: function () { return process_1.getDefaultBackend; } });
Object.defineProperty(exports, "setDefaultBackend", { enumerable: true, get: function () { return process_1.setDefaultBackend; } });
Object.defineProperty(exports, "regionTypeName", { enumerable: true, get: function () { return process_1.regionTypeName; } });
Object.defineProperty(exports, "openProcessAsync", { enumerable: true, get: function () { return process_1.openProcessAsync; } });
Object.defineProperty(exports, "openProcessByNameAsync", { enumerable: true, get: function () { return process_1.openProcessByNameAsync; } });
Object.defineProperty(exports, "listProcessesAsync", { enumerable: true, get: function () { return process_1.listProcessesAsync; } });
Object.defineProperty(exports, "findProcessesByNameAsync", { enumerable: true, get: function () { return process_1.findProcessesByNameAsync; } });
var winapi_1 = require("./win/winapi");
Object.defineProperty(exports, "win32ErrorMessage", { enumerable: true, get: function () { return winapi_1.win32ErrorMessage; } });
/* —— 扫描 —— */
var scanner_1 = require("./scanner/scanner");
Object.defineProperty(exports, "ScanSession", { enumerable: true, get: function () { return scanner_1.ScanSession; } });
var matcher_1 = require("./scanner/matcher");
Object.defineProperty(exports, "compileConfig", { enumerable: true, get: function () { return matcher_1.compileConfig; } });
Object.defineProperty(exports, "scanBlock", { enumerable: true, get: function () { return matcher_1.scanBlock; } });
Object.defineProperty(exports, "optionNeedsOldValue", { enumerable: true, get: function () { return matcher_1.optionNeedsOldValue; } });
var pointer_scan_1 = require("./scanner/pointer-scan");
Object.defineProperty(exports, "PointerScanner", { enumerable: true, get: function () { return pointer_scan_1.PointerScanner; } });
Object.defineProperty(exports, "formatPointerPath", { enumerable: true, get: function () { return pointer_scan_1.formatPointerPath; } });
Object.defineProperty(exports, "applyPointerPath", { enumerable: true, get: function () { return pointer_scan_1.applyPointerPath; } });
/* —— 地址表达式 —— */
var expression_1 = require("./addr/expression");
Object.defineProperty(exports, "compileExpression", { enumerable: true, get: function () { return expression_1.compileExpression; } });
Object.defineProperty(exports, "evaluateExpression", { enumerable: true, get: function () { return expression_1.evaluateExpression; } });
Object.defineProperty(exports, "resolveAddress", { enumerable: true, get: function () { return expression_1.resolveAddress; } });
Object.defineProperty(exports, "CompiledAddress", { enumerable: true, get: function () { return expression_1.CompiledAddress; } });
Object.defineProperty(exports, "ExpressionError", { enumerable: true, get: function () { return expression_1.ExpressionError; } });
/* —— 地址表 —— */
var memory_record_1 = require("./addresslist/memory-record");
Object.defineProperty(exports, "AddressList", { enumerable: true, get: function () { return memory_record_1.AddressList; } });
Object.defineProperty(exports, "MemoryRecord", { enumerable: true, get: function () { return memory_record_1.MemoryRecord; } });
Object.defineProperty(exports, "addScanResults", { enumerable: true, get: function () { return memory_record_1.addScanResults; } });
Object.defineProperty(exports, "buildRecordsFromScan", { enumerable: true, get: function () { return memory_record_1.buildRecordsFromScan; } });
/* —— Cheat Table 读写 —— */
var ct_format_1 = require("./cheattable/ct-format");
Object.defineProperty(exports, "parseCheatTable", { enumerable: true, get: function () { return ct_format_1.parseCheatTable; } });
Object.defineProperty(exports, "writeCheatTable", { enumerable: true, get: function () { return ct_format_1.writeCheatTable; } });
Object.defineProperty(exports, "loadCheatTable", { enumerable: true, get: function () { return ct_format_1.loadCheatTable; } });
Object.defineProperty(exports, "saveCheatTable", { enumerable: true, get: function () { return ct_format_1.saveCheatTable; } });
Object.defineProperty(exports, "collectSymbols", { enumerable: true, get: function () { return ct_format_1.collectSymbols; } });
Object.defineProperty(exports, "normalizeCtAddress", { enumerable: true, get: function () { return ct_format_1.normalizeCtAddress; } });
Object.defineProperty(exports, "ctAddressForFile", { enumerable: true, get: function () { return ct_format_1.ctAddressForFile; } });
Object.defineProperty(exports, "variableTypeToString", { enumerable: true, get: function () { return ct_format_1.variableTypeToString; } });
Object.defineProperty(exports, "stringToVariableType", { enumerable: true, get: function () { return ct_format_1.stringToVariableType; } });
/* —— Lua 脚本桥 ——
 *
 * 61 个 CE Lua API 函数的实现，详见 docs/lua-api.md。
 * 需要 wasmoon（Lua 5.4，靠整数子类型保证 int64 地址不丢精度）。
 */
var bridge_1 = require("./lua/bridge");
Object.defineProperty(exports, "LuaEngine", { enumerable: true, get: function () { return bridge_1.LuaEngine; } });
Object.defineProperty(exports, "LuaScriptError", { enumerable: true, get: function () { return bridge_1.LuaScriptError; } });
Object.defineProperty(exports, "LuaError", { enumerable: true, get: function () { return bridge_1.LuaError; } });
Object.defineProperty(exports, "LuaMarshal", { enumerable: true, get: function () { return bridge_1.LuaMarshal; } });
/* —— 反汇编 / 汇编 ——
 *
 * 后端是 capstone-wasm（反汇编）与 keystone-wasm（汇编）：
 * Cheat Engine 自己也是调 binutils 的 objdump/as，自带 Pascal 实现只是回退路径。
 * **使用前必须 await ensureAsmBackend()**（WASM 异步初始化）。
 * 详见 docs/assembler.md。
 */
var backend_1 = require("./asm/backend");
Object.defineProperty(exports, "ensureAsmBackend", { enumerable: true, get: function () { return backend_1.ensureAsmBackend; } });
Object.defineProperty(exports, "isAsmBackendReady", { enumerable: true, get: function () { return backend_1.isAsmBackendReady; } });
Object.defineProperty(exports, "resetAsmBackendForTests", { enumerable: true, get: function () { return backend_1.resetAsmBackendForTests; } });
Object.defineProperty(exports, "isArchitectureSupported", { enumerable: true, get: function () { return backend_1.isArchitectureSupported; } });
Object.defineProperty(exports, "architectureInfo", { enumerable: true, get: function () { return backend_1.architectureInfo; } });
Object.defineProperty(exports, "normalizeArchitecture", { enumerable: true, get: function () { return backend_1.normalizeArchitecture; } });
Object.defineProperty(exports, "archFromBitness", { enumerable: true, get: function () { return backend_1.archFromBitness; } });
Object.defineProperty(exports, "disassembleRaw", { enumerable: true, get: function () { return backend_1.disassembleRaw; } });
Object.defineProperty(exports, "assembleRaw", { enumerable: true, get: function () { return backend_1.assembleRaw; } });
Object.defineProperty(exports, "instructionNameOf", { enumerable: true, get: function () { return backend_1.instructionNameOf; } });
Object.defineProperty(exports, "backendVersions", { enumerable: true, get: function () { return backend_1.backendVersions; } });
Object.defineProperty(exports, "toSafeNumberAddress", { enumerable: true, get: function () { return backend_1.toSafeNumberAddress; } });
Object.defineProperty(exports, "AsmBackendError", { enumerable: true, get: function () { return backend_1.AsmBackendError; } });
var disassembler_1 = require("./asm/disassembler");
Object.defineProperty(exports, "disassemble", { enumerable: true, get: function () { return disassembler_1.disassemble; } });
Object.defineProperty(exports, "disassembleOne", { enumerable: true, get: function () { return disassembler_1.disassembleOne; } });
Object.defineProperty(exports, "disassembleAt", { enumerable: true, get: function () { return disassembler_1.disassembleAt; } });
Object.defineProperty(exports, "formatDisassembled", { enumerable: true, get: function () { return disassembler_1.formatDisassembled; } });
Object.defineProperty(exports, "splitDisassembledString", { enumerable: true, get: function () { return disassembler_1.splitDisassembledString; } });
Object.defineProperty(exports, "formatBytes", { enumerable: true, get: function () { return disassembler_1.formatBytes; } });
Object.defineProperty(exports, "branchTarget", { enumerable: true, get: function () { return disassembler_1.branchTarget; } });
Object.defineProperty(exports, "instructionText", { enumerable: true, get: function () { return disassembler_1.instructionText; } });
Object.defineProperty(exports, "DisasmValueType", { enumerable: true, get: function () { return disassembler_1.DisasmValueType; } });
var assembler_1 = require("./asm/assembler");
Object.defineProperty(exports, "assemble", { enumerable: true, get: function () { return assembler_1.assemble; } });
Object.defineProperty(exports, "assembleLines", { enumerable: true, get: function () { return assembler_1.assembleLines; } });
Object.defineProperty(exports, "assembleToBytes", { enumerable: true, get: function () { return assembler_1.assembleToBytes; } });
Object.defineProperty(exports, "AssemblerError", { enumerable: true, get: function () { return assembler_1.AssemblerError; } });
/* —— Auto Assembler（CE 脚本） ——
 *
 * 支持 [ENABLE]/[DISABLE]、alloc/dealloc/realloc/globalalloc、label/define、
 * registersymbol、aobscan(+module/region/unique)、createthread、include、
 * db/dw/dd/dq、nop/align、readmem/loadbinary。详见 docs/autoassembler.md。
 *
 * 核心机制：ENABLE 写入前逐字节记录原字节，DISABLE 精确还原（空 [DISABLE] 也能还原）。
 */
var autoassembler_1 = require("./asm/autoassembler");
Object.defineProperty(exports, "AutoAssembler", { enumerable: true, get: function () { return autoassembler_1.AutoAssembler; } });
Object.defineProperty(exports, "AutoAssemblerError", { enumerable: true, get: function () { return autoassembler_1.AutoAssemblerError; } });
Object.defineProperty(exports, "autoAssemble", { enumerable: true, get: function () { return autoassembler_1.autoAssemble; } });
var autoassembler_directives_1 = require("./asm/autoassembler-directives");
Object.defineProperty(exports, "parseCeInteger", { enumerable: true, get: function () { return autoassembler_directives_1.parseCeInteger; } });
Object.defineProperty(exports, "splitDirectiveArguments", { enumerable: true, get: function () { return autoassembler_directives_1.splitDirectiveArguments; } });
Object.defineProperty(exports, "encodeDataDirective", { enumerable: true, get: function () { return autoassembler_directives_1.encodeDataDirective; } });
Object.defineProperty(exports, "encodeNop", { enumerable: true, get: function () { return autoassembler_directives_1.encodeNop; } });
Object.defineProperty(exports, "encodeAlign", { enumerable: true, get: function () { return autoassembler_directives_1.encodeAlign; } });
Object.defineProperty(exports, "parsePseudoDirective", { enumerable: true, get: function () { return autoassembler_directives_1.parsePseudoDirective; } });
Object.defineProperty(exports, "patternToDbArguments", { enumerable: true, get: function () { return autoassembler_directives_1.patternToDbArguments; } });
Object.defineProperty(exports, "bytesToDbArguments", { enumerable: true, get: function () { return autoassembler_directives_1.bytesToDbArguments; } });
//# sourceMappingURL=index.js.map