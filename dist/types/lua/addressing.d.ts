/**
 * 地址表达式解析（CE 的 getAddress / getAddressFromName 的简化实现）。
 *
 * 支持的写法（与 CE Lua 脚本里常见的写法对齐）：
 *   1234 / 0012AB00     十六进制（CE 的地址表达式里裸数字按十六进制解释）
 *   0x7FF6A000 / $7FF6A000
 *   kernel32.dll        模块基址（大小写不敏感，可省略 .dll）
 *   kernel32.dll+1A2B   模块基址 + 偏移
 *   mySymbol+40         已注册符号 + 偏移
 *   a+b-c               多个项按 +/- 连接
 *
 * 注意：只有**字符串**里的裸数字按十六进制解释；
 * `getAddress(4096)` 传 Lua 数字时原样返回 4096。
 *
 * 不支持：括号、乘法/除法、指针解引用（CE 里靠 `[[addr]+4]` 这类写法，本移植未实现）。
 */
import type { ProcessModule } from '../win/process';
import type { LuaValue, SymbolTable } from './types';
export interface AddressResolverDeps {
    symbols: SymbolTable;
    /** 按名字找模块（大小写不敏感，可省略扩展名） */
    findModule(name: string): ProcessModule | null;
}
export declare class AddressResolver {
    private readonly deps;
    constructor(deps: AddressResolverDeps);
    /**
     * 解析地址。number/bigint 直接返回；字符串走表达式解析。
     * 解析失败抛 Error（中文信息），由调用方决定是抛 Lua 错误还是返回 nil。
     */
    resolve(value: LuaValue): bigint;
    /** 失败返回 null（对应 getAddressSafe 的语义）。 */
    tryResolve(value: LuaValue): bigint | null;
    /** 解析字符串表达式。 */
    parseExpression(expr: string): bigint;
    /** 按 +/- 切分表达式（不考虑括号）。 */
    private splitTerms;
    /** 解析单项：字面量、模块名或符号。 */
    private parseTerm;
}
//# sourceMappingURL=addressing.d.ts.map