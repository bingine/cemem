/**
 * 地址表达式求值 —— 对齐 Cheat Engine `addressparser.pas` 的功能子集。
 *
 * CE 的地址栏支持这些写法（这也是本模块要支持的）：
 *   - 十六进制 / 十进制字面量：`1234ABCD`、`0x1234`、`$1234`、`1234`
 *   - 模块相对地址：`"game.exe"+1234`、`game.exe+1234`
 *   - 符号名：已注册的符号，或模块内的导出符号
 *   - 解引用：`[[ game.exe+1234 ]+10]`、`[rax]`（寄存器在脚本上下文才有意义）
 *   - 算术：`+ - * / % << >> & | ^ ~`，以及括号
 *   - 内置函数：`GetModuleBase("x")`、`GetModuleSize("x")`、`GetAddress("expr")`
 *   - 寄存器占位：`EAX`/`RAX` 等 —— 仅在提供了寄存器上下文的场景下解析，
 *     否则报错（本移植不含调试器，故没有真实的寄存器上下文）
 *
 * 设计说明：表达式先编译成 AST（可在表中反复复用，避免每次重解析），
 * 求值时再访问模块列表与符号表，这样模块基址变化（重启进程）不需要重编译。
 */
import { Process } from '../win/process';
/** 表达式求值错误 */
export declare class ExpressionError extends Error {
    readonly expression: string;
    readonly position?: number | undefined;
    constructor(message: string, expression: string, position?: number | undefined);
}
export type ExprNode = {
    kind: 'number';
    value: bigint;
} | {
    kind: 'symbol';
    name: string;
} | {
    kind: 'module';
    name: string;
    offset: ExprNode;
} | {
    kind: 'deref';
    inner: ExprNode;
} | {
    kind: 'unary';
    op: string;
    operand: ExprNode;
} | {
    kind: 'binary';
    op: string;
    left: ExprNode;
    right: ExprNode;
} | {
    kind: 'call';
    name: string;
    args: ExprNode[];
} | {
    kind: 'register';
    name: string;
};
/** 求值上下文 */
export interface EvalContext {
    /** 目标进程（解析模块、解引用内存都要用） */
    process?: Process;
    /** 已注册符号表 */
    symbols?: Map<string, bigint>;
    /** 寄存器值（仅调试器场景才有） */
    registers?: Record<string, bigint>;
    /** 模块列表缓存（避免每次求值都枚举模块） */
    moduleCache?: Array<{
        name: string;
        baseAddress: bigint;
        size: number;
    }>;
    /**
     * 求值策略：
     *   - 'address'（默认）：解引用真的去读目标进程内存，得到最终地址
     *   - 'parseOnly'：只做算术，遇到解引用抛错（用于校验语法）
     */
    mode?: 'address' | 'parseOnly';
}
/** 编译表达式为 AST（可缓存复用）。 */
export declare function compileExpression(expression: string): ExprNode;
/** 求值表达式为 64 位地址。 */
export declare function evaluateExpression(node: ExprNode, ctx: EvalContext, expression?: string): bigint;
/**
 * 直接求值一个地址表达式。
 *
 * ```ts
 * const addr = resolveAddress('"notepad.exe"+1234', { process: proc });
 * const pointee = resolveAddress('[[notepad.exe+10]+8]', { process: proc });
 * ```
 */
export declare function resolveAddress(expression: string, ctx: EvalContext): bigint;
/** 已编译的表达式（便于在地址表里反复求值）。 */
export declare class CompiledAddress {
    readonly source: string;
    private readonly ast;
    private readonly error;
    constructor(expression: string);
    get isValid(): boolean;
    get parseError(): Error | null;
    resolve(ctx: EvalContext): bigint;
}
//# sourceMappingURL=expression.d.ts.map