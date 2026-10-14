/**
 * Lua 原始 C API 的 JS 封装（栈操作 + 值编解码）。
 *
 * 为什么不用 wasmoon 的高层 JS↔Lua 函数桥：
 *   wasmoon 的 `global.set(fn)` 走的是它自己的类型扩展，Lua integer → JS number
 *   （>2^53 直接丢精度），且**不支持 JS bigint 返回值**（抛
 *   "The type 'bigint' is not supported by Lua"）。
 *   地址是本项目的核心数据（64 位），因此本桥直接用 Lua C API：
 *     - JS → Lua：lua_pushinteger(L, BigInt)
 *     - Lua → JS：lua_tointegerx(L, i) —— wasmoon 的绑定在 wasm64/BIGINT 构建下返回 BigInt
 *   实测（Node v24 + wasmoon 1.16.0，Lua 5.4）9007199254740993 可以原样往返。
 *
 * 所有在 C 闭包里执行的栈操作都必须使用闭包收到的那个 `state`
 *   —— 如果 Lua 脚本在协程里调用我们的函数，state 是协程的 state，
 *      在它上面压栈/取值才是正确的（注册表是全局共享的，仍可用）。
 */
import type { ILuaBridgeObject, LuaTable, LuaValue } from './types';
import { MultiReturn } from './types';
export declare const LUA_TNONE = -1;
export declare const LUA_TNIL = 0;
export declare const LUA_TBOOLEAN = 1;
export declare const LUA_TLIGHTUSERDATA = 2;
export declare const LUA_TNUMBER = 3;
export declare const LUA_TSTRING = 4;
export declare const LUA_TTABLE = 5;
export declare const LUA_TFUNCTION = 6;
export declare const LUA_TUSERDATA = 7;
export declare const LUA_TTHREAD = 8;
/** lua_pcallk / lua_resume 的状态码 */
export declare const LUA_OK = 0;
export declare const LUA_YIELD = 1;
export declare const LUA_ERRRUN = 2;
export declare const LUA_ERRSYNTAX = 3;
export declare const LUA_ERRMEM = 4;
/** LUAI_MAXSTACK = 1000000；LUA_REGISTRYINDEX = -LUAI_MAXSTACK - 1000 */
export declare const LUA_REGISTRYINDEX = -1001000;
export declare const LUA_MULTRET = -1;
export interface LuaRawModule {
    ccall(name: string, returnType: string | null, argTypes: string[], args: unknown[]): unknown;
    addFunction(fn: (...args: number[]) => number, signature: string): number;
    removeFunction(pointer: number): void;
    setValue(pointer: number, value: number, type: string): void;
    getValue(pointer: number, type: string): number;
    _malloc(size: number): number;
    _free(pointer: number): void;
    stringToUTF8(str: string, pointer: number, maxBytes: number): void;
    lengthBytesUTF8(str: string): number;
}
/** wasmoon 的 LuaWasm 实例（LuaEngine 的私有字段 cmodule），只列出用到的部分。 */
export interface LuaRaw {
    module: LuaRawModule;
    lua_gettop(L: number): number;
    lua_settop(L: number, idx: number): void;
    lua_rotate(L: number, idx: number, n: number): void;
    lua_type(L: number, idx: number): number;
    lua_typename(L: number, tp: number): string;
    lua_isinteger(L: number, idx: number): number;
    lua_isnumber(L: number, idx: number): number;
    lua_isstring(L: number, idx: number): number;
    lua_toboolean(L: number, idx: number): number;
    lua_tonumberx(L: number, idx: number, isnum: number | null): number;
    lua_tointegerx(L: number, idx: number, isnum: number | null): bigint;
    lua_tolstring(L: number, idx: number, len: number | null): string;
    lua_rawlen(L: number, idx: number): bigint;
    lua_touserdata(L: number, idx: number): number;
    lua_pushnil(L: number): void;
    lua_pushboolean(L: number, b: number): void;
    lua_pushinteger(L: number, n: bigint): void;
    lua_pushnumber(L: number, n: number): void;
    lua_pushlstring(L: number, s: string, len: number): string;
    lua_pushstring(L: number, s: string): string;
    lua_pushvalue(L: number, idx: number): void;
    lua_pushcclosure(L: number, fn: number, n: number): void;
    lua_createtable(L: number, narr: number, nrec: number): void;
    lua_newuserdatauv(L: number, size: number, nuvalue: number): number;
    lua_setglobal(L: number, name: string): void;
    lua_getglobal(L: number, name: string): number;
    lua_getfield(L: number, idx: number, k: string): number;
    lua_setfield(L: number, idx: number, k: string): void;
    lua_rawgeti(L: number, idx: number, n: bigint): number;
    lua_rawseti(L: number, idx: number, n: bigint): void;
    lua_rawget(L: number, idx: number): number;
    lua_rawset(L: number, idx: number): void;
    lua_gettable(L: number, idx: number): number;
    lua_settable(L: number, idx: number): void;
    lua_next(L: number, idx: number): number;
    lua_setmetatable(L: number, objindex: number): number;
    lua_getmetatable(L: number, objindex: number): number;
    lua_rawequal(L: number, idx1: number, idx2: number): number;
    luaL_ref(L: number, t: number): number;
    luaL_unref(L: number, t: number, ref: number): void;
    luaL_loadbufferx(L: number, buff: number, sz: number, name: string, mode: string | null): number;
    luaL_tolstring(L: number, idx: number, len: number | null): string;
    luaL_traceback(L: number, L1: number, msg: string | null, level: number): void;
    lua_pcallk(L: number, nargs: number, nresults: number, errfunc: number, ctx: number, k: number | null): number;
    lua_error(L: number): number;
    lua_upvalueindex(index: number): number;
    lua_pop(L: number, count: number): void;
}
/** 桥接对象层需要向 marshal 暴露的最小能力。 */
export interface MarshalObjectAccess {
    /** 若该索引是桥的 userdata，返回宿主 JS 对象 */
    readUserdata(m: LuaMarshal, index: number): {
        found: boolean;
        value?: unknown;
    };
    /** 把一个桥接对象压栈（返回 true 表示已处理） */
    pushObject(m: LuaMarshal, obj: ILuaBridgeObject): boolean;
}
/** 一个 Lua 值的来源类型（错误提示用）。 */
export declare function describeValue(v: LuaValue): string;
/** 当前使用的哨兵值（测试与诊断用；注意它不是 JSON 可序列化的）。 */
export declare function currentLongjmpSentinel(): unknown;
/**
 * 手动指定 longjmp 哨兵值。
 *
 * 仅在确认 emscripten/wasmoon 换了实现时使用。
 */
export declare function setLongjmpSentinel(sentinel: unknown): void;
/**
 * 判断是不是 `lua_error` 的 longjmp 哨兵。
 *
 * 判定规则：**非 Error 值** 且严格等于当前哨兵值。
 *
 * 额外排除 `Error` 实例是有意为之：某些实现可能把哨兵包装成 Error，
 * 那种情况宁可走正常错误路径（有堆栈可查），也不要静默吞掉。
 */
export declare function isLuaLongjmp(e: unknown): boolean;
/** 把任意异常转成可读的中文错误信息。 */
export declare function describeError(e: unknown): string;
/**
 * 绑定到某一个 Lua state（主 state 或协程 state）的栈操作器。
 *
 * 轻量对象：每个 C 闭包调用创建一个即可，不持有需要释放的资源。
 */
export declare class LuaMarshal {
    readonly cm: LuaRaw;
    readonly state: number;
    private readonly objects;
    constructor(cm: LuaRaw, state: number, objects?: MarshalObjectAccess | null);
    /** 换一个 state（协程场景）。 */
    withState(state: number): LuaMarshal;
    top(): number;
    setTop(n: number): void;
    pop(n?: number): void;
    /** 把（可能是负数的）索引转成绝对索引。 */
    abs(index: number): number;
    type(index: number): number;
    typeName(index: number): string;
    isNil(index: number): boolean;
    isNone(index: number): boolean;
    isBoolean(index: number): boolean;
    isNumber(index: number): boolean;
    isInteger(index: number): boolean;
    isString(index: number): boolean;
    /** 数字或数字字符串（对应 Lua 的 lua_isstring / lua_isnumber 语义） */
    isNumberOrString(index: number): boolean;
    isTable(index: number): boolean;
    isFunction(index: number): boolean;
    isUserdata(index: number): boolean;
    toBigInt(index: number): bigint;
    toNumber(index: number): number;
    toString(index: number): string;
    toBoolean(index: number): boolean;
    /**
     * 数字取值：Lua integer 在 JS 安全整数范围内返回 number，否则返回 bigint。
     *
     * 这样 `readInteger` 这种小值在 Lua/JS 两侧都是普通数字，
     * 而 64 位地址/计数不会丢精度。
     */
    toLuaNumber(index: number): number | bigint;
    /** 读取任意 Lua 值。 */
    read(index: number, depth?: number): LuaValue;
    /**
     * 读取一张表：1..n 连续整数键 → JS 数组；否则 → 字符串键的对象。
     * 数字键在对象形式下转成十进制字符串（例如 `{1000, x=1}`）。
     */
    readTable(index: number, depth?: number): LuaTable | LuaValue[];
    /** 读取一张 Lua 表为普通对象（数组表会变成 {'1': .., '2': ..}）。 */
    readTableObject(index: number): LuaTable;
    /** 以字符串键读取表字段（不存在或非表时返回 undefined）。 */
    getTableField(index: number, key: string): LuaValue | undefined;
    pushNil(): void;
    pushBoolean(b: boolean): void;
    pushInteger(v: bigint): void;
    pushNumber(v: number): void;
    /** 压入字符串（按 UTF-8 编码字节数给长度，避免 Lua 侧截断）。 */
    pushString(s: string): void;
    /** 压入任意值。 */
    push(v: LuaValue): void;
    /** 压入 1..n 的数组表。 */
    pushArray(items: LuaValue[]): void;
    /** 压入字符串键的表。 */
    pushTable(entries: LuaTable): void;
    /** 压入一个 C 闭包（先压 upvalue 再 pushcclosure）。 */
    pushClosure(pointer: number, upvalues?: LuaValue[]): void;
    /**
     * 把「处理结果」压栈，返回 Lua 返回值个数。
     * - undefined → 0 个返回值（CE 里大量 API 就是这样）
     * - MultiReturn → 多个返回值
     * - 其它 → 1 个返回值
     */
    pushResult(result: LuaValue | MultiReturn | void): number;
    /**
     * 抛出一个 Lua 错误（等价于 Lua 的 error()）。
     *
     * 实测（wasmoon 1.16.0 / emscripten 的 JS 版 longjmp）：
     * 在 addFunction 的 JS 帧里调用 lua_error 可以正常被 pcall 捕获，
     * 且不需要返回值（longjmp 不会返回到 JS）。
     * 因此所有「参数错误 / 地址无法解析」都按 CE 的做法直接抛错，
     * 而不是静默返回 nil。
     */
    raise(message: string): never;
    /** 取第 n 个参数（1 基），越界返回 undefined。 */
    arg(args: LuaValue[], n: number): LuaValue | undefined;
    /** 要求某个参数存在，否则抛 Lua 错误。 */
    requireArg(args: LuaValue[], n: number, funcName: string): LuaValue;
    /**
     * 把参数转成 bigint 整数（**只接受 number / bigint**）。
     *
     * 注意：地址参数不要用这个函数 —— 地址还允许字符串表达式
     * （`"game.exe"+1000`），那要走 `api.ts` 里的 `addrOf`（它会调用地址表达式解析器）。
     * 这里刻意不做字符串解析，避免"看起来能传模块名其实只当字面量"的歧义。
     */
    argToBigInt(args: LuaValue[], n: number, funcName: string): bigint;
    /** 整数参数（默认值可选）。 */
    argToInt(args: LuaValue[], n: number, funcName: string, def?: number): number;
    /** 浮点参数。 */
    argToNumber(args: LuaValue[], n: number, funcName: string, def?: number): number;
    /** 字符串参数。 */
    argToString(args: LuaValue[], n: number, funcName: string, def?: string): string;
    /**
     * 布尔参数。
     *
     * 语义严格对齐 Lua 的 `lua_toboolean`：**只有 `nil` 和 `false` 为假**，
     * 其它一切都是真 —— 包括 `0`、`0.0`、空字符串 `""`、空表。
     *
     * 早期实现写成 `typeof v === 'string' ? v.length > 0 : ...`，
     * 把 `""` 判成了 false，这与 Lua 相反：CE 脚本里 `if flag then` 且 `flag = ""` 时
     * 行为会不一致。请勿改回。
     */
    argToBoolean(args: LuaValue[], n: number, def?: boolean): boolean;
}
//# sourceMappingURL=marshal.d.ts.map