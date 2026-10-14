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
export { VariableType, ScanOption, RoundingType, ScanType, PointerType, FastScanMethod, VARIABLE_TYPE_NAMES, VARIABLE_TYPE_SIZES, SCAN_OPTION_NAMES, MEM_COMMIT, MEM_RESERVE, MEM_FREE, MEM_PRIVATE, MEM_MAPPED, MEM_IMAGE, PAGE_NOACCESS, PAGE_READONLY, PAGE_READWRITE, PAGE_WRITECOPY, PAGE_EXECUTE, PAGE_EXECUTE_READ, PAGE_EXECUTE_READWRITE, PAGE_EXECUTE_WRITECOPY, PAGE_GUARD, PROCESS_VM_READ, PROCESS_VM_WRITE, PROCESS_VM_OPERATION, PROCESS_QUERY_INFORMATION, DEFAULT_PROCESS_ACCESS, } from './types';
export type { ScanConfig, ScanResult, ScanProgressCallback, MemoryRegion, GroupElement, PointerTypes, AccessRights, } from './types';
export { roundTo, parseIntegerLiteral, parseFloatLiteral, decimalsOf, parseAob, parseBinaryPattern, buildFloatCompareParams, singleMatches, doubleMatches, aobMatchesAt, aobHasNibbleWildcard, } from './value-codec';
export type { ParsedNumber, FloatCompareParams, PatternByte, BinaryPattern } from './value-codec';
export type { MemoryBackend, BackendCapabilities, BackendProcessHandle, BackendProcessInfo, BackendRegion, BackendRegionFilter, BackendModuleInfo, } from './backend/types';
export { BackendUnsupportedError } from './backend/types';
export { SelfBackend, filterScanRegions } from './backend/self-backend';
export type { SelfBackendOptions } from './backend/self-backend';
export { NativeCeBackend, CeServerConnection, CeWriter, CeReader, CESERVER_CMD, CESERVER_DEFAULT_PORT, } from './backend/native-ce-backend';
export type { NativeCeBackendOptions } from './backend/native-ce-backend';
export { DbkBackend, DbkDeviceError, DBK_IOCTL, DBK_READ_INPUT_SIZE, DBK_WRITE_INPUT_SIZE, DBK_WRITE_BUFFER_SIZE, DBK_MAX_WRITE_PAYLOAD, DBK_MAX_READ_CHUNK, DBK_ALLOC_INPUT_SIZE, DEFAULT_DBK_SERVICE_NAME, packReadInput, packWriteBuffer, packAllocInput, readAllocResult, resolveDevicePath, readServiceNameFromDriverDat, } from './backend/dbk-backend';
export type { DbkBackendOptions } from './backend/dbk-backend';
export { Process, ProcessOpenError, listProcesses, findProcessesByName, enumerateRegions, selectScannableRegions, isReadable, isWritable, isExecutable, getDefaultBackend, setDefaultBackend, regionTypeName, openProcessAsync, openProcessByNameAsync, listProcessesAsync, findProcessesByNameAsync, } from './win/process';
export type { ProcessInfo, ProcessModule, RegionFilter, OpenProcessOptions } from './win/process';
export { win32ErrorMessage } from './win/winapi';
export { ScanSession } from './scanner/scanner';
export type { ScanSessionOptions, ScanStats, Chunk } from './scanner/scanner';
export { compileConfig, scanBlock, optionNeedsOldValue } from './scanner/matcher';
export type { CompiledConfig } from './scanner/matcher';
export { PointerScanner, formatPointerPath, applyPointerPath } from './scanner/pointer-scan';
export type { PointerPath, PointerScanOptions, PointerScanStats } from './scanner/pointer-scan';
export { compileExpression, evaluateExpression, resolveAddress, CompiledAddress, ExpressionError } from './addr/expression';
export type { EvalContext, ExprNode } from './addr/expression';
export { AddressList, MemoryRecord, addScanResults, buildRecordsFromScan } from './addresslist/memory-record';
export type { MemoryRecordData, RecordEvaluation } from './addresslist/memory-record';
export { parseCheatTable, writeCheatTable, loadCheatTable, saveCheatTable, collectSymbols, normalizeCtAddress, ctAddressForFile, variableTypeToString, stringToVariableType, } from './cheattable/ct-format';
export type { ParsedCheatTable, WriteCheatTableOptions, RootExtraElement } from './cheattable/ct-format';
export { LuaEngine, LuaScriptError, LuaError, LuaMarshal } from './lua/bridge';
export type { LuaValue, LuaEngineOptions } from './lua/types';
export type { ApiFunction } from './lua/api';
export { ensureAsmBackend, isAsmBackendReady, resetAsmBackendForTests, isArchitectureSupported, architectureInfo, normalizeArchitecture, archFromBitness, disassembleRaw, assembleRaw, instructionNameOf, backendVersions, toSafeNumberAddress, AsmBackendError, } from './asm/backend';
export type { AsmArchitecture, AsmEndianness, ArchitectureInfo, RawInstruction, RawAssembleResult, DisassembleRawOptions, AssembleRawOptions, } from './asm/backend';
export { disassemble, disassembleOne, disassembleAt, formatDisassembled, splitDisassembledString, formatBytes, branchTarget, instructionText, DisasmValueType, } from './asm/disassembler';
export type { DisassembledInstruction, DisassembleOptions } from './asm/disassembler';
export { assemble, assembleLines, assembleToBytes, AssemblerError } from './asm/assembler';
export type { AssembleOptions, AssembleResult, AssembledLine, } from './asm/assembler';
export { AutoAssembler, AutoAssemblerError, autoAssemble } from './asm/autoassembler';
export type { AutoAssemblerOptions, AutoAssembleResult, AutoAssemblerEntry, AutoAssemblerAllocation, AutoAssemblerLineInfo, AutoAssemblerPhase, AobScanRecord, RestoreMode, SourceLine, AsmLine, } from './asm/autoassembler';
export { parseCeInteger, splitDirectiveArguments, encodeDataDirective, encodeNop, encodeAlign, parsePseudoDirective, patternToDbArguments, bytesToDbArguments, } from './asm/autoassembler-directives';
export type { DataDirectiveKind, PseudoDirectiveKind, ParsedPseudoDirective, } from './asm/autoassembler-directives';
//# sourceMappingURL=index.d.ts.map