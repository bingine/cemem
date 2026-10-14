/**
 * 汇编器 —— 文本汇编 → 机器码，对齐 Cheat Engine `Assemblerunit.pas` 的对外行为。
 *
 * 后端是 Keystone（见 `backend.ts` 的说明：CE 在 Windows 上也是调 binutils 的 `as`）。
 * 本文件负责 Keystone 之外的那一层，也就是 CE 汇编器真正做的事：
 *
 *   1. **符号解析**：`jmp someLabel` 里的未定义符号要在编码前解析成地址。
 *      Keystone 支持通过符号回调注册，本模块提供 `symbols` 选项。
 *   2. **`nop` 与对齐**：CE 的 `nop` 可带数量（`nop 5` 表示填充 5 字节的 nop）。
 *   3. **CE 的强制宽度写法**：`mov [rax],1` 在 CE 里需要显式宽度，
 *      本模块会把 CE 风格的 `mov dword ptr [rax],1` 原样交给 Keystone，
 *      同时兼容省略写法（Keystone/NASM 语法自己会报错，错误信息里指明）。
 *   4. **`int 3` 特例**：Keystone 会把 `int 3` 编成 `CD 03`（两字节），
 *      而 x86 惯例与 CE 都用单字节 `CC`。这里做修正。
 *   5. **逐行模式**：CE 的 `assemble` 是`逐行`语义（每行一条指令），
 *      本模块提供 `assembleLines` 返回每行的字节边界，便于 Auto Assembler
 *      把脚本按行映射回地址。
 *
 * ## 与 CE 的差异
 *   - CE 支持 `E8 ?? ?? ?? ??` 这种"带通配的模板"，那属于 Auto Assembler 层
 *     （见 `autoassembler.ts`），不在汇编器里。
 *   - CE 的汇编器有大量针对旧语法的兼容分支（`$` 前缀十六进制、`offset` 关键字等），
 *     本模块只保留主流写法，遇到不支持时会给出明确的汇编错误。
 */
import { AsmBackendError, type AsmArchitecture, type AsmBitness, type AsmEndianness } from './backend';
/** 汇编选项 */
export interface AssembleOptions {
    /** 代码将放置的地址。**必需**：相对跳转/相对寻址的编码取决于它 */
    address: bigint;
    /**
     * 架构，默认 `x64`。
     * 支持 `x86` / `x64` / `arm`（A32）/ `thumb`（Thumb-2）/ `arm64`（AArch64）。
     */
    arch?: AsmArchitecture;
    /** 兼容旧写法：位数（32/64）。`arch` 优先 */
    bitness?: AsmBitness;
    /** 字节序，默认 little（ARM 目标可能用大端） */
    endianness?: AsmEndianness;
    /**
     * 符号表：名字 → 地址。
     * 用于解析 `jmp label` 这类引用（Auto Assembler 的 label/define/aobscan 结果）。
     */
    symbols?: Record<string, bigint> | Map<string, bigint>;
    /** x86 语法，默认 Intel（CE 用 Intel 语法）；ARM 只有一种语法，此选项无效 */
    syntax?: 'intel' | 'att' | 'nasm' | 'masm' | 'gas';
    /**
     * 是否自动为未定义符号抛出更友好的错误。
     * 默认 true：把 Keystone 的 "Cannot find a symbol" 换成"符号 X 未定义"。
     */
    friendlyErrors?: boolean;
}
/** 单行汇编的结果（`assembleLines` 用） */
export interface AssembledLine {
    /** 源文本（已 trim，注释已剥离） */
    source: string;
    /** 该行对应的字节 */
    bytes: Buffer;
    /** 该行在输出中的起始地址 */
    address: bigint;
    /** 该行是否为空行/纯注释（此时 bytes 为空） */
    empty: boolean;
}
/** 汇编结果 */
export interface AssembleResult {
    /** 完整机器码 */
    bytes: Buffer;
    /** 起始地址 */
    address: bigint;
    /** 编码结束后的下一个地址 */
    endAddress: bigint;
    /** 逐行结果（`assembleLines` 时填充；`assemble` 只有一行整体） */
    lines: AssembledLine[];
    /** 本次汇编用到的符号（诊断用） */
    usedSymbols: Record<string, string>;
}
/** 汇编失败 */
export declare class AssemblerError extends Error {
    readonly line?: string | undefined;
    readonly lineNumber?: number | undefined;
    constructor(message: string, line?: string | undefined, lineNumber?: number | undefined);
}
/**
 * 汇编一段文本（可多行）。
 *
 * ```ts
 * const r = assemble('mov rax, 1\nret', { address: 0x1000n });
 * r.bytes; // <Buffer b8 01 00 00 00 c3>
 * ```
 */
export declare function assemble(source: string, options: AssembleOptions): AssembleResult;
/**
 * 逐行汇编，返回每行的字节与地址。
 *
 * CE 的 Auto Assembler 需要"脚本行 → 地址"的映射
 * （`label`/`alloc` 之后要把行号换算成地址），所以逐行编码是必要的。
 *
 * 注意：逐行编码无法处理"跨行的局部标签"（`jmp short_label` 后紧跟标号定义）。
 * 调用方应先用 `assemble()` 传完整文本处理标签，或用 `symbols` 预解析。
 */
export declare function assembleLines(source: string, options: AssembleOptions): AssembleResult;
/**
 * 便捷函数：只拿字节。
 */
export declare function assembleToBytes(source: string, options: AssembleOptions): Buffer;
export { AsmBackendError };
//# sourceMappingURL=assembler.d.ts.map