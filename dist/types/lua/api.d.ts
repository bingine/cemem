/**
 * Cheat Engine Lua API 的 Node 版实现（子集）。
 *
 * 约定（与 CE 官方 Lua API 的对齐与差异都写在 docs/lua-api.md）：
 *   - 参数顺序尽量与 CE 一致，方便直接搬运脚本；
 *   - 读内存失败返回 nil（CE 风格）；参数错误 / 地址无法解析直接抛 Lua 错误
 *     （CE 的 getAddress 也是抛错，脚本可以用 pcall 捕获）；
 *   - 地址参数可以是整数，也可以是字符串表达式（'base+40'、'kernel32.dll+1000'、'mySymbol'）。
 *
 * 类型映射：
 *   - readInteger 返回 32 位整数，**默认按有符号解释**（signed=true）；
 *     CE 官方默认 signed=false（返回 dword）。这是本移植与 CE 的**有意差异**，
 *     需要无符号语义时显式传 readInteger(addr, false)。
 *   - readByte / readSmallInteger 保持 CE 默认（无符号）。
 *   - readQword 返回 64 位整数（Lua 5.4 的 integer 是 int64，超出 2^63-1 按位回绕）。
 */
import { AddressResolver } from './addressing';
import { MultiReturn, type ApiContext, type LuaValue } from './types';
import { type LuaMarshal } from './marshal';
import { LuaAddressList } from './objects';
import { type LuaAutoAssembler } from './aa';
/** 一个 CE Lua API 函数的实现签名。 */
export type ApiFunction = (args: LuaValue[], m: LuaMarshal) => LuaValue | MultiReturn | void;
/** 引擎当前的最后一条错误信息（对齐 CE 的 getLastError 思路）。 */
export declare class ErrorSink {
    private message;
    set(text: string): void;
    clear(): void;
    get(): string;
}
export interface ApiBundle {
    functions: Record<string, ApiFunction>;
    errorSink: ErrorSink;
    resolver: AddressResolver;
    /** 共享的地址列表（getAddressList 每次返回同一个对象，和 CE 一致） */
    addressList: LuaAddressList;
    /** Auto Assembler 绑定实例（LuaEngine 换进程时需要 invalidate） */
    autoAssembler: LuaAutoAssembler;
}
/**
 * 创建全部 API 函数。
 *
 * @param ctx 引擎能力（进程、符号表、扫描会话、输出）
 */
export declare function createApi(ctx: ApiContext): ApiBundle;
//# sourceMappingURL=api.d.ts.map