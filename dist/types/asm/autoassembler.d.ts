/**
 * Auto Assembler —— Cheat Engine 脚本语言的解析与执行层。
 *
 * 对齐 `Cheat Engine/autoassembler.pas`（3752 行）与 `Assemblerunit.pas` 里
 * 属于 Auto Assembler 的那部分（`db/dw/dd/dq`、`nop N`、`align`）。
 *
 * ## 它解决什么问题
 *
 * CE 的 Auto Assembler 是"把一段脚本变成对目标进程内存的修改"的编译器 + 执行器：
 *
 * ```text
 * [ENABLE]
 * alloc(newmem,2048)                 // 1. 在目标进程分配内存
 * label(returnhere)                  // 2. 声明一个脚本内标签
 * aobscan(sig, DE AD BE EF 90 90 ?? 7*)   // 3. 在目标进程里搜特征码
 * newmem:                            // 4. 地址定位（后续指令从这里排布）
 *   mov dword ptr [sig], 1337        // 5. 写代码
 *   jmp returnhere
 * sig:                               // 6. 回到 aobscan 找到的地址
 *   jmp newmem
 * returnhere:
 * [DISABLE]
 * dealloc(newmem)
 * ```
 *
 * ## 执行流水线（与 CE 一一对应）
 *
 * ```
 *   stripComments        ← removecomments()          去 // ; {} 注释（字符串感知）
 *   expandIncludes       ← INCLUDE() 分支            把 include 的文件内容就地展开
 *   analyzeSections      ← getenableanddisablepos()  找 [ENABLE]/[DISABLE]
 *   selectLines          ← getEnableOrDisableScript() 取「外层代码 + 选中段」
 *   stripCpuSpecific     ← stripCPUspecificCode()    处理 [32-BIT]/[64-BIT]
 *   preprocess           ← autoassemble2 的解析循环   alloc/aobscan/label/define/db/...
 *   layout               ← AutoassemblerCodePass2()   逐行定地址 + 汇编（迭代到稳定）
 *   apply                ← 写内存分支                 写目标进程并记录原字节
 * ```
 *
 * ## 三个最容易静默出错、因此被重点处理的地方
 *
 * 1. **地址定位**。CE 的脚本不是"从头顺序汇编"，而是由**地址定义行**（`name:`）切块：
 *    遇到已知符号（alloc/aobscan/registered）或地址表达式（`"game.exe"+1234:`）时，
 *    当前地址被**重置**到该值；否则标签取当前地址。若不实现这条，
 *    `newmem:` 之后那段代码会被写到地址 0。
 * 2. **前向引用的指令长度**。`jmp returnhere` 里的 `returnhere` 定义在后面，
 *    它的地址又取决于前面指令的长度 —— 循环依赖。CE 的做法是用
 *    「当前地址 + 0xFFFFF」当远占位符、用「当前地址」当近占位符各编一次，
 *    取**较长**的那个，保证后续地址不会因为编码变短而漂移。本移植沿用这一策略，
 *    并额外做迭代收敛（见 `MAX_LAYOUT_PASSES`）。
 * 3. **原字节保留**。[ENABLE] 写入前逐字节记录被覆盖的原字节；[DISABLE] 时按记录
 *    逆序精确还原（`restoreMode: 'original'`，默认）。这正是 CE 教程里
 *    「关掉作弊后游戏恢复正常」的底层机制。
 *
 * ## 与 CE 的差异（完整清单见 docs/autoassembler.md）
 *
 * - **数字进制是一致的**（实测）：Keystone 的 Intel 语法把裸数字按**十六进制**解析，
 *   与 CE 相同 —— `mov eax, 100` 编出 `B8 00 01 00 00`（即 0x100）。
 *   想写十进制只能写 `0x` 形式的十六进制值（Keystone 不支持 CE 的 `#123`）。
 * - `db/dw/dd/dq`、`nop N`、`align N` 由本层自己实现，同样是十六进制语义。
 * - `alloc`/`readmem` 的**大小**参数按十进制（对齐 CE 的 `StrToInt`），
 *   需要十六进制时写 `0x` 或 `$` 前缀。
 * - `createthread`/`createthreadandwait` 只做参数校验与记录，不创建远程线程
 *   （Node 没有 CreateRemoteThread；见 `allowCreateThread`）。
 * - `luaCall`/`reassemble`/`struct`/`kalloc`/`sharedalloc`/`loadlibrary`/
 *   `allocnx`/`allocxo`/`aobscanex`/`{$...}` 条件编译未实现，会给出明确的中文错误。
 *
 * ## 用法
 *
 * ```ts
 * await ensureAsmBackend();                       // WASM 后端必须先初始化
 * const aa = new AutoAssembler({ process });
 * aa.autoAssemble(script, { enable: true });      // 注入并记录原字节
 * aa.autoAssemble(script, { enable: false });     // 精确还原
 * ```
 */
import { Process } from '../win/process';
import { type AsmArchitecture, type AsmBitness } from './backend';
import { type ParsedPseudoDirective, type PseudoDirectiveKind } from './autoassembler-directives';
/** 错误发生的阶段 */
export type AutoAssemblerPhase = 'parse' | 'scan' | 'assemble' | 'write';
/** Auto Assembler 错误（带脚本行号与列内容，便于定位） */
export declare class AutoAssemblerError extends Error {
    /** 出错的源码行（已去注释） */
    readonly line?: string;
    /** 出错的源码行号（1-based；include 的文件里是文件内行号） */
    readonly lineNumber?: number;
    /** 出错行所属文件（主脚本为 `<script>`） */
    readonly file?: string;
    /** 阶段 */
    readonly phase: AutoAssemblerPhase;
    constructor(message: string, options?: {
        line?: string;
        lineNumber?: number;
        file?: string;
        phase?: AutoAssemblerPhase;
    });
}
/** DISABLE 的还原策略 */
export type RestoreMode = 
/** 默认：优先用 [ENABLE] 时记录的原字节精确还原（等价于 CE 的还原效果，且不依赖脚本写全） */
'original'
/** CE 原生：完全听 [DISABLE] 段脚本的，历史记录只用于诊断 */
 | 'script';
/** 选项 */
export interface AutoAssemblerOptions {
    /**
     * 目标进程。**省略时自动进入 syntaxCheckOnly 模式**：
     * 只解析与汇编、不分配内存、不写内存，用于语法检查与"预演"。
     */
    process?: Process;
    /** 位数；省略时按 `process.isWow64()` 推断（推断失败按 64） */
    bitness?: AsmBitness;
    /**
     * 架构，支持 `x86` / `x64` / `arm` / `thumb` / `arm64`。
     * ARM 目标必须显式给（只给 bitness 无法区分 arm 与 thumb）。
     * 省略时按 `bitness` → 目标进程位数 → `x64` 推断。
     */
    arch?: AsmArchitecture;
    /** `include()` 的额外搜索目录（会在脚本目录、cwd 之后依次尝试） */
    includeDirs?: string[];
    /** 主脚本路径，用于解析 `include()` 的相对路径 */
    scriptPath?: string;
    /**
     * 是否真的执行 `createthread` 创建远程线程。
     * 本移植**不支持**（Node 无 CreateRemoteThread），因此 `true` 会直接报错；
     * 默认 `false` 时只做参数校验并记录到 `AutoAssembleResult.createThreads`。
     */
    allowCreateThread?: boolean;
    /** DISABLE 还原策略，默认 `'original'` */
    restoreMode?: RestoreMode;
    /** 重复 enable 时是否复用已分配的地址（默认 true，避免重复分配导致泄漏） */
    reuseAllocations?: boolean;
    /** aobscan 的扫描块大小，默认 1MB */
    scanBlockSize?: number;
    /** aobscan 是否使用 worker 并行（默认 false：脚本场景要求确定性） */
    scanParallel?: boolean;
    /**
     * `db/dw/dd/dq`、`nop N`、`align N` 的裸数字是否按十六进制解释。
     * 默认 true —— **CE 行为**，不要轻易改（真实脚本的 `db 89 01` 依赖它）。
     */
    dataHexDefault?: boolean;
    /**
     * 段内代码开始前的起始地址。默认 `undefined`：
     * 此时在出现任何地址定义行之前写代码会直接报错（与 CE 一致，防止写到地址 0）。
     */
    startAddress?: bigint;
}
/** 一次 alloc 的记录 */
export interface AutoAssemblerAllocation {
    name: string;
    address: bigint;
    size: number;
    protection: number;
    /** 是否由 `globalalloc` 申请（全局可见） */
    global: boolean;
}
/** 一条写入记录 */
export interface AutoAssemblerEntry {
    address: bigint;
    bytes: Buffer;
    /** 写入前该区间的原字节（写内存失败或只做语法检查时可能为 null） */
    originalBytes: Buffer | null;
    /** 该条目的字节是否来自"还原记录的原字节"（DISABLE 时） */
    restoredFromOriginal: boolean;
    /** 来源脚本行 */
    line: string;
    lineNumber: number;
    file: string;
}
/** 布局后的脚本行（诊断/测试用） */
export interface AutoAssemblerLineInfo {
    /** 该行对应的指令/伪指令文本（标签已剥离、define 已替换） */
    text: string;
    address: bigint;
    bytes: Buffer;
    /** 该行是否不产生字节（纯标签行/空行） */
    empty: boolean;
    /** 本行定义的标签名 */
    labels: string[];
    lineNumber: number;
    file: string;
}
/** 一次 aobscan 的结果 */
export interface AobScanRecord {
    name: string;
    /** 全部命中地址（升序） */
    matches: bigint[];
    /** 实际选用的地址（= matches[0]，对齐 CE"取第一处"） */
    address: bigint;
    /** 扫描形态 */
    scope: 'all' | 'module' | 'region' | 'unique';
}
/** 执行结果 */
export interface AutoAssembleResult {
    /** 本次执行的是 ENABLE（true）还是 DISABLE（false）段 */
    enable: boolean;
    /** 是否只做语法检查（未写目标进程） */
    syntaxCheckOnly: boolean;
    /** 实际写入（或"将要写入"）的条目 */
    entries: AutoAssemblerEntry[];
    /** 写入的总字节数 */
    bytesWritten: number;
    /** 布局后的全部脚本行 */
    lines: AutoAssemblerLineInfo[];
    /** 执行结束时的符号表快照（只读副本） */
    symbols: Map<string, bigint>;
    /** 当前会话的全部 alloc */
    allocations: AutoAssemblerAllocation[];
    /**
     * 本次运行里被 `dealloc`/`realloc` **真的释放掉**的内存块。
     *
     * 为什么单独给出来：实际释放发生在内核里，而工具层此前的输出只有
     * 「还原 0 处 / 0 字节」—— 用户看不出 alloc 的内存到底有没有还回去
     * （它其实真的还了，符号也确实消失了）。有这份记录，输出才能如实说一句。
     */
    deallocated: Array<{
        name: string;
        address: bigint;
        size: number;
    }>;
    /** 通过 registersymbol 注册（跨脚本可见）的符号名 */
    registeredSymbols: string[];
    /** createthread 校验通过的地址（本移植不执行） */
    createThreads: bigint[];
    /** 本次脚本里所有 aobscan 的命中情况（诊断用：CE 只暴露第一处，这里把全部给出） */
    aobScans: AobScanRecord[];
    /** 非致命问题 */
    warnings: string[];
    /** 段位置 */
    sections: {
        enableLine: number | null;
        disableLine: number | null;
    };
}
/** 一行源码（注释已剥离） */
export interface SourceLine {
    text: string;
    /** 1-based 行号（所属文件内） */
    number: number;
    file: string;
}
/** 一个待布局的汇编行 */
export interface AsmLine {
    /** 指令/伪指令文本（标签已剥离、define 已替换） */
    text: string;
    pseudo: ParsedPseudoDirective | null;
    /** readmem 预读出来的字节 */
    readmemBytes: Buffer | null;
    /** 本行定义的标签（`known` 非 null 表示地址来自 alloc/aobscan/registered/地址表达式） */
    labels: Array<{
        name: string;
        known: bigint | null;
    }>;
    /** 原始行内容（报错用） */
    raw: string;
    lineNumber: number;
    file: string;
    address: bigint;
    bytes: Buffer;
}
/**
 * 一个 Auto Assembler 会话。
 *
 * 会话保存跨调用的状态（符号表、alloc、原字节记录），因此
 * `autoAssemble(script, {enable:true})` 之后
 * `autoAssemble(script, {enable:false})` 才能精确还原。
 * 这与 CE 里 `TMemoryRecord` 持有 `TDisableInfo` 是同一个设计。
 */
export declare class AutoAssembler {
    private readonly options;
    /** 跨脚本可见的符号（alloc / aobscan / registersymbol 的结果） */
    private readonly persistentSymbols;
    /** 当前会话的 alloc */
    private readonly allocations;
    /** registersymbol 注册的名字 */
    private readonly registeredSymbols;
    /**
     * 每个脚本 key 对应一份"ENABLE 期间记录的原字节"。
     *
     * 为什么按脚本分开存：CE 的 `TDisableInfo` 是**每个内存记录一份**的，
     * 因此可以同时启用多个脚本、再各自独立关闭。若共用一份历史，
     * 启用脚本 B 会冲掉脚本 A 的记录，导致 A 无法还原。
     */
    private readonly histories;
    /** 模块列表缓存（地址表达式反复求值用） */
    private moduleCache;
    constructor(options?: AutoAssemblerOptions);
    /** 目标进程（可能为 undefined：纯语法检查模式） */
    get process(): Process | undefined;
    /** 当前已知符号（只读快照） */
    get symbols(): ReadonlyMap<string, bigint>;
    /** 当前 alloc（只读快照） */
    get allocationsList(): readonly AutoAssemblerAllocation[];
    /** 释放本会话分配的全部内存并清空符号/历史 */
    cleanup(): void;
    /** 本会话是否记录过该脚本的 ENABLE 原字节 */
    hasHistory(script: string): boolean;
    /** 取某脚本记录的原字节（只读副本，诊断用） */
    historyOf(script: string): Array<{
        address: bigint;
        bytes: Buffer;
    }>;
    /** 执行 ENABLE 段 */
    enable(script: string): AutoAssembleResult;
    /** 执行 DISABLE 段（按 `restoreMode` 还原） */
    disable(script: string): AutoAssembleResult;
    /** 只做语法检查与汇编（不分配、不写内存、无副作用） */
    check(script: string): AutoAssembleResult;
    /**
     * 解析脚本并执行，对齐 CE 的 `autoassemble(code, enable)`。
     *
     * @param script 脚本原文
     * @param opts.enable 执行 ENABLE（默认）还是 DISABLE 段
     * @param opts.syntaxCheckOnly 只检查不执行（没有 process 时自动开启）
     */
    autoAssemble(script: string, opts?: {
        enable?: boolean;
        syntaxCheckOnly?: boolean;
    }): AutoAssembleResult;
    private toSourceLines;
    /** 展开 `include(file.cea)`（就地插入，保留被包含文件自己的行号） */
    private expandIncludes;
    private resolveIncludePath;
    /**
     * 遍历选中段的每一行，把 CE 指令转换成"汇编行"。
     *
     * 处理顺序与 CE 的解析循环一致：先做指令匹配，未匹配的按普通汇编行处理
     * （因此 `db/nop/align` 也走这里）。
     */
    private preprocess;
    /** 判断是否为明确不支持的指令；返回指令名（大写）或 null */
    private matchUnsupported;
    private tryAobScan;
    /** 按 `maxParts` 上限在顶层逗号处切分（引号内不切） */
    private splitTopLevel;
    private performAobScan;
    private tryCreateThread;
    private tryAlloc;
    private allocate;
    private deallocate;
    private trySymbolDirective;
    /**
     * `define(name, whatever)` —— **纯文本替换**，对齐 CE（autoassembler.pas 2004~2043）。
     *
     * 注意 CE 的语义细节：`whatever` 不是"值"而是"文本"。因此
     * `define(myVal, 1337)` 之后 `mov [x], myVal` 等价于 `mov [x], 1337`。
     * 值的解析发生在最终汇编/伪指令解析时，所以同一份 define 在指令里与
     * `db` 里的进制解释可能不同（详见 docs/autoassembler.md 的差异表）。
     */
    private handleDefine;
    /** 应用当前生效的全部 define（按定义顺序；跳过 `skipName` 自身，避免自替换） */
    private applyDefines;
    private tryMemoryUtility;
    /**
     * 解析地址定义行。支持三种形态：
     *
     *   1. `newmem:`                        —— 已知符号（alloc/aobscan/registered）→ 重置当前地址
     *   2. `returnhere:`                    —— 脚本标签 → 取当前地址
     *   3. `00401000:` / `"game.exe"+1234:` —— 地址表达式 → 重置当前地址
     *
     * 也支持 `name: 指令` 的同行写法（CE 只支持独立定义行，这里是超集）。
     */
    private parseAddressSetter;
    /**
     * 把布局得到的标签地址登记为符号。
     *
     * 对齐 CE：脚本里的 `label(x)` + `x:` 也会进入符号表
     * （`disableinfo.allsymbols`，autoassembler.pas 4350~4360），
     * 因此同一个会话里后续脚本 / [DISABLE] 段都能引用它。
     */
    private commitLabelSymbols;
    /**
     * 解析延后的 `registersymbol` 请求。
     *
     * 必须在布局之后调用：`registersymbol(mylabel)` 里的标签地址只有在
     * 所有指令长度确定之后才是最终值。
     */
    private resolvePendingRegisters;
    /** 查符号（alloc/aobscan/registered/持久符号），忽略大小写 */
    /**
   * 查符号 → 地址。
   *
   * ⚠️ **必须同时查 `run.symbols`**（本次运行内声明的名字）。
   *
   * 早先这里只查 `this.allocations` 与 `this.persistentSymbols` 两个**跨运行**的表，
   * 而 `run.symbols`（本次 `[ENABLE]` 段里 `alloc`/`label`/`define`/`aobscan`
   * 刚声明出来的名字）**完全没被查**。同文件的 `resolveExpression()` 却查了它 ——
   * 于是同一个符号，走表达式解析能用、走 `lookupSymbol` 就报「未定义的符号」。
   *
   * 在 `syntaxCheckOnly`（`ce_auto_assemble action=check`）下这个问题尤其致命：
   * check 模式不分配真实内存，所以这些名字**只会**存在于 `run.symbols` 里
   * （`allocate()` 走的是 `registerSymbol(name, 0n, run, line)`），
   * `persistentSymbols` 按设计不会被写入。于是任何引用自己 alloc 出来的块名的脚本
   * —— 也就是所有正常的 AA 脚本 —— 在 check 下都会报「未定义的符号」。
   * check 恰恰是"开工前安全预校验"的唯一手段，功能最需要它时反而不可用。
   */
    private lookupSymbol;
    /**
     * 求值地址表达式。
     *
     * 优先按 CE 的整数语义解析裸数字（十六进制），否则交给 `resolveAddress`；
     * 送进去之前会把裸数字改写成 `0x` 形式（`hexifyBareNumbers`），
     * 因为 `addr/expression.ts` 把无 a-f 字母的裸数字当十进制。
     */
    private resolveExpression;
    private registerSymbol;
    private layout;
    private sameLabelMap;
    /** 编码 `db/dw/dd/dq`、`nop N`、`align N[,b]` */
    private encodePseudo;
    /**
     * 编码一条指令。
     *
     * 前向引用的标签用「近/远两个占位符各编一次、取较长者」的策略
     * （对齐 CE autoassembler.pas 3741~3763 行），保证地址不会因为
     * 编码从长变短而漂移。
     */
    private encodeInstruction;
    private tryAssembleLine;
    private assembleLine;
    private apply;
    private readOriginal;
    private writeBlock;
    /**
     * 记录被覆盖的原字节。
     *
     * 记录集保持"按地址升序、互不重叠"：与已有记录重叠的部分会被裁掉
     * （保留最早的原始内容），相邻的会合并。
     */
    private recordOriginal;
    /**
     * 从历史里摘掉一段区间。
     *
     * `dealloc`/`realloc` 释放内存后必须调用：那块内存已经还给系统，
     * 再去"还原"它只会得到 ERROR_INVALID_ADDRESS（实测踩过）。
     */
    private dropHistoryRange;
    private resolveBitness;
    /**
     * 解析汇编用的架构。
     *
     * 优先级：显式 `arch` > 由 `bitness` 推断 > 按目标进程位数推断 > `x64`。
     * 支持 ARM 之后，只给 `bitness` 已不足以表达架构
     * （`arm` 与 `thumb` 都是 32 位），因此 ARM 目标请显式给 `arch`。
     */
    private resolveArch;
    /** 构造带行号/文件/阶段的错误 */
    private error;
}
/**
 * 一次性执行脚本（ENABLE 或 DISABLE）。
 *
 * 注意：**成对往返请用 `new AutoAssembler(...)` 复用同一个会话**，
 * 因为 [DISABLE] 的精确还原依赖 [ENABLE] 时记录的原字节。
 * 这个便捷函数适合"一次注入 / 语法检查"这类无状态场景。
 */
export declare function autoAssemble(script: string, options?: AutoAssemblerOptions & {
    enable?: boolean;
    syntaxCheckOnly?: boolean;
}): AutoAssembleResult;
/** 暴露给上层做"纯解析"的辅助类型（测试与文档用） */
export type { PseudoDirectiveKind };
//# sourceMappingURL=autoassembler.d.ts.map