/**
 * 反汇编器（x86 / x64 / ARM / Thumb / ARM64）—— 输出对齐 Cheat Engine 的
 * `TLastDisassembleData`。
 *
 * 后端是 Capstone（见 `backend.ts` 里关于"CE 自己也用 binutils 而非手写解码器"的说明）。
 * 本文件负责把 Capstone 的原始结果加工成 CE 需要的那套字段与文本格式。
 *
 * CE 的字段定义见 `lastdisassembledata.pas` 的 `TLastDisassembleData`：
 *   address / prefix / opcode / parameters / description / Bytes /
 *   SeperatorCount+Seperators / modrmValue / parameterValue /
 *   datasize / isfloat / isfloat64 / hasSib / sibIndex / sibScaler /
 *   isjump / iscall / isret / isrep / isconditionaljump / riprelative
 *   / Disassembler（dcX86 / dcArm / dcArm64 / dcThumb）
 *
 * ## 文本格式
 * CE 在 binutils 分支下产出 `"地址 - 字节 - 操作码 参数"`。
 * 本模块的 `formatDisassembled` 产同样形状的字符串，同时把 opcode / parameters
 * 分开保留（CE 内部也是分开存的，显示时才拼）。
 *
 * ## 多架构差异（这里是最容易出错的地方）
 *
 * | 项目 | x86/x64 | ARM/Thumb | ARM64 |
 * | --- | --- | --- | --- |
 * | 指令长度 | 1–15 字节，可变 | 4（Thumb 2/4） | 4 |
 * | 前缀 | `rep`/`lock`/段前缀 | 无 | 无 |
 * | 条件执行 | `jcc` 助记符（7x/0F 8x） | **指令后缀**（`moveq`/`addne`） | `b.eq` 助记符 |
 * | 返回 | `ret`/`retf`/`iret` | `bx lr`/`pop {...,pc}`/`mov pc,lr` | `ret` |
 * | 调用 | `call` | `bl`/`blx` | `bl`/`blr` |
 * | 寄存器 | `rax`/`eax`/`al`… | `r0`–`r15`、`sp`/`lr`/`pc` | `x0`–`x30`、`w0`–`w30`、`sp`/`xzr`/`wzr` |
 * | RIP 相对 | 有（`[rip+disp]`） | 无 | 有（`adrp`/`ldr xN, [pc,...]`、`b`/`bl` 的 PC 相对） |
 *
 * ## 已知限制
 * `capstone-wasm` 不暴露 detail（`readInsn` 是私有的），因此拿不到
 * "操作数类型/寄存器使用/内存操作数宽度"等结构信息。
 * 本模块改用**助记符表**判定流程控制与数据宽度，对主流指令足够；
 * 冷门指令会被标成 `isjump=false`（宁可少标，不要错标）。
 */
import { type AsmArchitecture, type AsmEndianness } from './backend';
/** 值类型提示，对齐 CE 的 TDisAssemblerValueType */
export declare enum DisasmValueType {
    None = 0,
    Address = 1,
    Value = 2
}
/** 反汇编器类型，对齐 CE 的 TDisassemblerClass */
export declare enum DisassemblerClass {
    X86 = "dcX86",
    Arm = "dcArm",
    Arm64 = "dcArm64",
    Thumb = "dcThumb"
}
/**
 * 一条反汇编结果，字段对齐 CE 的 `TLastDisassembleData`。
 */
export interface DisassembledInstruction {
    /** 指令地址 */
    address: bigint;
    /** 前缀文本（x86 的 `rep`/`lock`），ARM 上恒为空串 */
    prefix: string;
    /** 前缀字节数 */
    prefixSize: number;
    /**
     * 操作码。
     *
     * 多架构注意：
     *   - x86：`mov`、`je`
     *   - ARM/Thumb：Capstone 把条件后缀并进助记符（`moveq`），本字段保持原样；
     *     条件码另见 `conditionCode`。
     *   - ARM64：`b`、`b.eq` 会拆成 `opcode='b'` + `suffix='.eq'`
     *     （为与 x86 的 `jcc` 形态对齐，便于上层统一判断条件跳转）。
     */
    opcode: string;
    /** 助记符后缀（ARM64 的 `.eq` 等）；无后缀时为空串 */
    suffix: string;
    /** 参数部分 */
    parameters: string;
    /** 描述（本移植留空） */
    description: string;
    /** 机器码字节，**每个字节一个 `Buffer`**（对齐 CE 的 `Bytes: array of byte`） */
    bytes: Buffer[];
    /** 分隔点：字节数组里 前缀/操作码/modrm/sib/额外 的分界下标 */
    separators: number[];
    separatorCount: number;
    /** 内存操作数（modrm）指向的值 */
    modrmValueType: DisasmValueType;
    modrmValue: bigint;
    /** 其它参数里的值（立即数/位移） */
    parameterValueType: DisasmValueType;
    parameterValue: bigint;
    /** 该指令读写的数据宽度（字节）；不确定时为 0 */
    dataSize: number;
    /** 是否读写单精度浮点（仅在有把握时为 true） */
    isFloat: boolean;
    /** 是否读写双精度浮点 */
    isFloat64: boolean;
    /** 是否含 SIB 字节（仅 x86 有意义） */
    hasSib: boolean;
    sibIndex: number;
    sibScaler: number;
    /** 是否可能改变 pc/rip */
    isJump: boolean;
    /** 是否 call（含 `bl`） */
    isCall: boolean;
    /** 是否 ret（含 ARM 的 `bx lr`、`pop {...,pc}`） */
    isRet: boolean;
    /** 是否带 rep/repe/repne 前缀（仅 x86） */
    isRep: boolean;
    /** 是否条件跳转/条件执行 */
    isConditionalJump: boolean;
    /** 条件码文本（如 `eq`/`ne`）；无则空串 */
    conditionCode: string;
    /** RIP 相对（x86）或 PC 相对（ARM64）偏移下标；-1 表示不是 */
    ripRelative: number;
    /** 是否 64 位目标 */
    is64Bit: boolean;
    /** 使用的架构 */
    arch: AsmArchitecture;
    /** 反汇编器类型（对齐 CE 的 Disassembler 字段） */
    disassemblerClass: DisassemblerClass;
    /** 原始助记符（含后缀，小写） */
    mnemonic: string;
    /** 指令长度 */
    size: number;
}
export interface DisassembleOptions {
    /** 架构，默认 `x64` */
    arch?: AsmArchitecture;
    /** 兼容旧写法：位数。arch 优先 */
    bitness?: 32 | 64;
    /** 字节序，默认 little */
    endianness?: AsmEndianness;
}
/**
 * 反汇编内存中的一段代码。
 *
 * @param code 机器码缓冲区
 * @param address 该缓冲区在目标进程中的地址
 * @param maxInstructions 最多解多少条，默认 1
 * @param options 架构/字节序
 */
export declare function disassemble(code: Buffer, address: bigint, maxInstructions?: number, options?: DisassembleOptions): DisassembledInstruction[];
/** 反汇编一条指令 */
export declare function disassembleOne(code: Buffer, address: bigint, options?: DisassembleOptions): DisassembledInstruction;
/**
 * 从目标进程读内存并反汇编一条。
 *
 * 读取长度按架构取：x86 最长指令 15 字节（读 16 留余量），
 * ARM/ARM64 定长 4 字节（读 16 同样够用，且便于 Thumb 的 4 字节指令）。
 */
export declare function disassembleAt(readMemory: (address: bigint, size: number) => Buffer, address: bigint, options?: DisassembleOptions): DisassembledInstruction;
/** 按架构取"对齐步长"（用于在解不出指令时安全推进） */
export declare function alignmentOf(arch: AsmArchitecture): number;
/** 把字节数组格式化成 `48 8B 05 10 20 30 40`（大写、空格分隔） */
export declare function formatBytes(bytes: Buffer[] | Buffer): string;
/**
 * 格式化为 CE 风格的完整行：`地址 - 字节 - 操作码 参数`。
 *
 * 对齐 `disassembler.pas` 里 binutils 分支的写法。注意 CE 在字节与 ` - `
 * 之间**多一个空格**（逐字节拼接时末尾留了空格），本函数保留这一细节。
 */
export declare function formatDisassembled(insn: DisassembledInstruction, options?: {
    addressWidth?: number;
    showAddress?: boolean;
    showBytes?: boolean;
}): string;
/**
 * 取出一条指令的**完整文本**（含前缀与后缀），可用于重新汇编。
 *
 * 为什么需要单独的函数：
 *   - x86：CE 把 `rep`/`lock` 前缀单独存在 `prefix` 字段，
 *     只用 `opcode + parameters` 会丢掉 `F3`/`F2`。
 *   - ARM：条件码在助记符里，本模块已把它并回 `opcode`，
 *     但 ARM64 的 `.eq` 后缀需要补上。
 */
export declare function instructionText(insn: DisassembledInstruction): string;
/**
 * 把 CE 风格的整行拆回各段（对齐 `disassembler.pas` 的 `splitDisassembledString`）。
 */
export declare function splitDisassembledString(disassembled: string): {
    address: string;
    bytes: string;
    opcode: string;
    parameters: string;
};
/**
 * 计算跳转/调用的目标地址（非流程指令返回 null）。
 *
 * 覆盖形态：
 *   - x86：`0x...`
 *   - ARM：`#0x...`（Capstone 对 ARM 分支通常直接给绝对地址）
 *   - ARM64：`0x...`
 */
export declare function branchTarget(insn: DisassembledInstruction): bigint | null;
//# sourceMappingURL=disassembler.d.ts.map