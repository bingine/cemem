/**
 * Auto Assembler 的「汇编器级」指令实现。
 *
 * Cheat Engine 里这些指令**不在** autoassembler.pas，而在 `Assemblerunit.pas`
 * 的 `Assemble()` 里（见该文件 4930~5100 行的 `case tokens[0][1] of`）：
 *
 *   - `db/dw/dd/dq` —— 数据定义（Assemblerunit 的 `DB`/`DW`/`DD`/`DQ` 分支）
 *   - `nop N`       —— 多字节 NOP 填充（Assemblerunit 的 `NOP HEXVALUE` 分支）
 *   - `align N[,b]` —— 对齐填充（Assemblerunit 的 `ALIGN` 分支）
 *
 * 本移植的汇编后端是 Keystone，它**只认指令**，不认这些伪指令
 * （`db`/`align` 会直接报错，`nop 5` 会被当成 `nop` 的操作数）。
 * 因此这一层必须在 Auto Assembler 里自己做，且要**逐字节对齐 CE 的产出**。
 *
 * ## 数字字面量的进制（最容易静默出错的地方）
 *
 * CE 的 `Assemblerunit` 对 `db/dw/dd/dq/nop/align` 的参数统一走
 * `HexStrToInt`（`parsers.pas` 的 `ConvertHexStrToRealStr`），规则是：
 *
 *   - **裸数字按十六进制解释**（`db 89 01 00 00 00` 是 0x89 0x01 ...，不是十进制 89）
 *   - `#123` 才是十进制（`#` 前缀）
 *   - `-` / `+` 前缀保留符号
 *
 * 这一条**必须**保持 CE 语义：真实 CE 脚本的 `[DISABLE]` 段几乎都是
 * `db 89 01 00 00 00` 这种写法，若按十进制解析会得到完全错误的字节（89 → 0x59）。
 *
 * 作为超集，本模块额外接受 `0x` 与 `$` 前缀（CE 的 HexStrToInt 其实不接受，
 * 会返回空串然后抛异常）。
 */
/** 数据定义伪指令 */
export type DataDirectiveKind = 'db' | 'dw' | 'dd' | 'dq';
/** 本模块能编码的伪指令 */
export type PseudoDirectiveKind = DataDirectiveKind | 'nop' | 'align';
/** 伪指令编码上下文 */
export interface DirectiveContext {
    /** 该行将要放置的地址（`align` 需要它） */
    address: bigint;
    /**
     * 读取目标进程 1 字节（`db ??` / `db +1` 需要）。
     * 没有目标进程时返回 null —— `db ??` 会退化成 0 并记一条警告。
     */
    readByte?: (address: bigint) => number | null;
    /** 裸数字是否按十六进制解释，默认 true（CE 行为） */
    hexDefault?: boolean;
}
/** 编码结果 */
export interface DirectiveEncodeResult {
    bytes: Buffer;
    /** 非致命问题（例如 `db ??` 在没有目标进程时按 0 处理） */
    warnings: string[];
}
/**
 * 按 CE 的 `HexStrToInt` 语义解析整数（裸数字 = 十六进制）。
 *
 * 支持 `#123`（十进制）、`0x1F`、`$1F`、裸 `1F`，以及 `-`/`+` 前缀。
 * 无法解析时返回 null（调用方负责给出带行号的中文错误）。
 */
export declare function parseCeInteger(text: string, hexDefault?: boolean): bigint | null;
/**
 * 把伪指令的参数串切成 token。
 *
 * 对齐 CE 的 `tokenize`（autoassembler.pas 383 行）的实用子集：
 *   - 分隔符：逗号、空格、制表符
 *   - 引号内的内容**不切分**（`db 'a b'` 是一个 token）
 *   - 保留引号本身（后续按字符串处理）
 */
export declare function splitDirectiveArguments(text: string): string[];
/**
 * 编码 `db/dw/dd/dq`。
 *
 * 对齐 `Assemblerunit.pas` 4964~5048 行：
 *   - `db 'abc'`  → latin1 字节（**不**反转，`AddString` 是按序拷贝）
 *   - `dw 'abc'`  → UTF-16LE（`AddWideString` 直接 copy 宽字符内存）
 *   - `db ??` / `db **` / `db *` → **读目标进程当前字节**（保持原样）
 *   - `db +1` / `db -1`        → 读目标进程当前字节后加/减
 *   - 其它 → 数字，按 CE 的十六进制语义
 *
 * 注意 `dd 'str'` / `dq 'str'` 在 CE 里会走 `HexStrToInt` 的字符分支（行为很怪），
 * 本移植直接报错，避免产生难以察觉的错误字节。
 */
export declare function encodeDataDirective(kind: DataDirectiveKind, args: string, ctx: DirectiveContext): DirectiveEncodeResult;
/** 生成 `count` 字节的 NOP 填充（count<=0 返回空） */
export declare function encodeNop(count: number): Buffer;
/**
 * 计算对齐填充。对齐 `Assemblerunit.pas` 4938~4959 行：
 *
 * ```pascal
 * k := i - (address mod i);
 * if k = i then exit;          // 已对齐，不填
 * for ... do Add(bytes, b);    // b 默认 0
 * ```
 *
 * 注意 CE 的填充字节**默认是 0x00**（不是 0x90），第二个参数才是填充值：
 * `align 10, 90` 表示对齐到 16 字节边界并用 0x90 填充。
 */
export declare function encodeAlign(address: bigint, alignment: bigint, fillByte?: number): Buffer;
/** 识别出的伪指令 */
export interface ParsedPseudoDirective {
    kind: PseudoDirectiveKind;
    /** 伪指令名之后的参数原文 */
    args: string;
}
/**
 * 判断一行是否是 `db/dw/dd/dq/nop/align` 伪指令。
 *
 * 返回 null 表示不是伪指令（交给 Keystone 汇编）。
 * 注意 `nop`（不带参数）**不算**伪指令 —— Keystone 自己能编成 0x90，
 * 保持与 `assembler.ts` 的行为一致。
 */
export declare function parsePseudoDirective(line: string): ParsedPseudoDirective | null;
/**
 * 把 AOB 字符串转成伪指令用的 `db` 参数串（`aobscan` 回填原字节时用）。
 * 通配位被替换为 `??`，保留「读取原字节」语义。
 */
export declare function patternToDbArguments(patternText: string): string;
/** 把一段内存按 `db` 参数串格式化（`readmem` 用） */
export declare function bytesToDbArguments(bytes: Buffer): string;
//# sourceMappingURL=autoassembler-directives.d.ts.map