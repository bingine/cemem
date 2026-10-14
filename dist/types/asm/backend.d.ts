/**
 * 反汇编/汇编的后端封装（x86 / x64 / ARM / ARM64）。
 *
 * ## 为什么用外部引擎而不是手写指令表
 *
 * Cheat Engine 自己**也不手写 x86 解码器**：Windows 上它优先用 binutils 的
 * `objdump`（见 `binutils.pas` 的 `TBinUtils.disassemble` → `CreateProcess objdump`），
 * `disassembler.pas` 那 13,933 行只是无 binutils 时的回退路径。
 * ARM 那套（`disassemblerarm64.pas` 4,608 行、`disassemblerthumb.pas` 4,414 行、
 * `assemblerarm.pas` 1,074 行）同理。
 *
 * 本移植沿用这一架构，选两个成熟引擎，两者都覆盖 x86/x64/ARM/ARM64：
 *   - **capstone-wasm**：Capstone 官方 WASM 绑定（反汇编）
 *   - **keystone-wasm**：Keystone 官方 WASM 绑定（v0.9，汇编）
 *
 * ## 支持的架构
 *
 * | 架构名 | 说明 | 对齐 |
 * | --- | --- | --- |
 * | `x86` / `x64` | 32 / 64 位 x86 | 可变长度（1–15 字节），无对齐 |
 * | `arm` | ARM A32（ARMv7 及以前） | 固定 4 字节，4 字节对齐 |
 * | `thumb` | ARM Thumb / Thumb-2 | 2 或 4 字节，2 字节对齐 |
 * | `arm64` | AArch64（ARMv8） | 固定 4 字节，4 字节对齐 |
 *
 * ## 实测踩到的坑（都在这里处理掉）
 *
 * 1. **Capstone 不接受 bigint 地址** —— 传 bigint 会在 WASM 边界抛错。
 *    这里统一转 number，并在超过 `Number.MAX_SAFE_INTEGER` 时**明确报错**。
 * 2. **`disasm()` 返回的 address 相对缓冲区起点**，不是绝对地址。本模块加回基址。
 * 3. **`disasm()` 的参数是选项对象**（`{address, count}`），不是位置参数。
 * 4. **Capstone 构造器只有 `(arch, mode)`**；x86 的 Intel 语法靠
 *    `CS_OPT_SYNTAX` 设置。注意 `capstone-wasm` 的 `Const` **没有导出
 *    `CS_OPT_SYNTAX`**（实测为 undefined），因此本移植不设语法选项 ——
 *    好在 x86 默认就是 Intel 语法，ARM 也只有一种语法。
 * 5. **Capstone 不暴露 `readInsn`/detail**，拿不到操作数与分组结构；
 *    语义分类由上层按助记符表处理（见 disassembler.ts）。
 * 6. **Thumb 指令长度可变**（2 或 4 字节），且 `disasm()` 的 count 语义
 *    与 x86 一致，无需特殊处理 —— 但**地址必须是 2 的倍数**。
 */
import type { Keystone as KeystoneType, Const as KeystoneConstType } from 'keystone-wasm';
import type { Capstone as CapstoneType, Const as CapstoneConstType } from 'capstone-wasm';
/** 支持的架构 */
export type AsmArchitecture = 'x86' | 'x64' | 'arm' | 'thumb' | 'arm64';
/** 大端模式（CE 的 ARM 目标可能是大端） */
export type AsmEndianness = 'little' | 'big';
/** 架构静态属性（与引擎无关的元信息，上层用来决定对齐与默认值） */
export interface ArchitectureInfo {
    /** 规范化名称 */
    arch: AsmArchitecture;
    /** 引擎用的家族：'x86' | 'arm' | 'arm64' */
    family: 'x86' | 'arm' | 'arm64';
    /** 指令对齐（字节）：决定反汇编推进的最小步长 */
    alignment: number;
    /** 指令是否定长；定长时 `fixedSize` 有效 */
    fixedSize: boolean;
    /** 定长指令的宽度（字节）；变长时为 0 */
    instructionSize: number;
    /** 显示用地址宽度（十六进制字符数） */
    addressWidth: number;
    /** 是否为 64 位目标 */
    is64Bit: boolean;
}
/** 取架构元信息 */
export declare function architectureInfo(arch: AsmArchitecture): ArchitectureInfo;
/**
 * 把宽松的架构写法规范化为 `AsmArchitecture`。
 *
 * 接受：`x64`/`amd64`/`x86_64`/`64`、`x86`/`i386`/`ia32`/`32`、
 *       `arm`/`arm32`/`a32`/`armv7`、`thumb`/`t32`/`thumb2`、
 *       `arm64`/`aarch64`/`armv8`/`x64arm`。
 */
export declare function normalizeArchitecture(input: string | number | undefined, fallback?: AsmArchitecture): AsmArchitecture;
/** 兼容旧的 `bitness` 写法（32/64）→ 架构名 */
export declare function archFromBitness(bitness: 32 | 64 | undefined): AsmArchitecture;
/**
 * @deprecated 用 `AsmArchitecture` 代替（支持 ARM 后"位数"无法表达架构）。
 * 保留此别名仅为兼容已有调用签名。
 */
export type AsmBitness = 32 | 64;
/** 反汇编出的一条指令（后端层，尽量少加工） */
export interface RawInstruction {
    /** 绝对地址（已把基址加回） */
    address: bigint;
    /** 指令长度（字节） */
    size: number;
    /** 机器码字节 */
    bytes: Buffer;
    /** 助记符（小写，Capstone 风格） */
    mnemonic: string;
    /** 操作数字符串（Capstone 风格） */
    operands: string;
    /** Capstone 指令 id */
    id: number;
    /** 该指令所属分组（当前后端拿不到 detail，恒为空数组） */
    groups: number[];
}
/** 汇编结果 */
export interface RawAssembleResult {
    /** 编码后的字节 */
    bytes: Buffer;
    /** 源文本 */
    source: string;
}
/** 后端不可用/参数错误时的错误 */
export declare class AsmBackendError extends Error {
    /** 底层原因（不用 `Error.cause` 的名字，避免与标准属性冲突） */
    readonly underlying?: unknown;
    constructor(message: string, underlying?: unknown);
}
/** 把 bigint 地址转成 Capstone/Keystone 能接受的 number，并守卫精度 */
export declare function toSafeNumberAddress(address: bigint, context: string): number;
interface BackendState {
    capstone: typeof CapstoneType;
    capstoneConst: typeof CapstoneConstType;
    keystone: typeof KeystoneType;
    keystoneConst: typeof KeystoneConstType;
}
/**
 * 确保后端已初始化（WASM 需要异步装载）。
 *
 * 幂等；初始化失败时**不缓存失败结果**，允许重试。
 */
export declare function ensureAsmBackend(): Promise<BackendState>;
/** 后端是否已就绪（同步查询，不会触发初始化） */
export declare function isAsmBackendReady(): boolean;
/** 测试用：重置后端单例 */
export declare function resetAsmBackendForTests(): void;
export interface DisassembleRawOptions {
    /** 代码所在地址（必需，用于计算相对跳转的绝对目标） */
    address: bigint;
    /** 架构，默认 `x64` */
    arch?: AsmArchitecture;
    /** 兼容旧写法：位数。arch 优先 */
    bitness?: 32 | 64;
    /** 字节序，默认 little */
    endianness?: AsmEndianness;
    /** 最多反汇编多少条（默认 1） */
    maxInstructions?: number;
}
/** 反汇编一段机器码（多架构）。 */
export declare function disassembleRaw(code: Buffer, options: DisassembleRawOptions): RawInstruction[];
/** 通过 Capstone 反查助记符（id → 名称，例如 260 → 'je'） */
export declare function instructionNameOf(id: number, arch?: AsmArchitecture): string;
export interface AssembleRawOptions {
    /** 代码将放置的地址（必需） */
    address: bigint;
    /** 架构，默认 `x64` */
    arch?: AsmArchitecture;
    /** 兼容旧写法：位数。arch 优先 */
    bitness?: 32 | 64;
    /** 字节序，默认 little */
    endianness?: AsmEndianness;
    /** x86 语法（仅 x86/x64 有意义），默认 intel */
    syntax?: 'intel' | 'att' | 'nasm' | 'masm' | 'gas';
}
/** 把汇编文本编码成机器码（多架构）。 */
export declare function assembleRaw(source: string, options: AssembleRawOptions): RawAssembleResult;
/** 取后端版本信息（诊断用） */
export declare function backendVersions(): {
    capstone: string;
    keystone: string;
    architectures: AsmArchitecture[];
};
/** 查询某架构是否被两个引擎都支持（都支持才可用） */
export declare function isArchitectureSupported(arch: AsmArchitecture): boolean;
export {};
//# sourceMappingURL=backend.d.ts.map