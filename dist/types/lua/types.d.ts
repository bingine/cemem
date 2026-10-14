/**
 * Lua 桥的公共类型定义。
 *
 * 桥的两侧类型约定（重要）：
 *   - JS 侧地址一律用 `bigint`；Lua 侧（Lua 5.4）是 64 位 integer。
 *   - `wasmoon` 自带的 JS↔Lua 函数桥会把 Lua integer 转成 JS `number`，
 *     超过 2^53 就丢精度，而且不支持 bigint 返回值。
 *     因此本桥**不使用** wasmoon 的高层函数注册（`global.set`），
 *     而是用 Lua 原始 C API（lua_pushcclosure + addFunction）自建桥，
 *     整数通过 `lua_pushinteger` / `lua_tointegerx` 以 BigInt 原样传递。
 *
 * 该文件只放类型与纯数据类，不放任何 Lua 依赖，便于被其它模块安全引用。
 */
import type { Process, ProcessModule } from '../win/process';
import type { LuaMarshal } from './marshal';
/** 可以跨桥传递的 Lua 值（JS 侧表示）。 */
export type LuaValue = null | undefined | boolean | number | bigint | string | LuaValue[] | LuaTable | Map<LuaValue, LuaValue> | ILuaBridgeObject;
/** 普通 Lua table（字符串键）。 */
export interface LuaTable {
    [key: string]: LuaValue;
}
/**
 * 多返回值标记。
 *
 * Lua 函数可以返回多个值，但 JS 的数组语义被占用为「Lua table」，
 * 因此用本类显式表示多返回值（与 wasmoon 的 LuaMultiReturn 同款思路）：
 *   return new MultiReturn(1n, 'abc', true);
 */
export declare class MultiReturn extends Array<LuaValue> {
    constructor(...values: LuaValue[]);
}
/** 可以被桥接成 Lua userdata 的 JS 对象。 */
export interface ILuaBridgeObject {
    readonly luaClass: BridgeClass;
}
/** 判断是否是桥接对象。 */
export declare function isBridgeObject(v: unknown): v is ILuaBridgeObject;
/** 对象方法：obj 是宿主 JS 对象，args 是除 self 以外的参数。 */
export type BridgeMethod = (obj: any, args: LuaValue[], m: LuaMarshal) => LuaValue | MultiReturn | void;
/** 对象属性访问器。 */
export interface BridgeProperty {
    get?: (obj: any, m: LuaMarshal) => LuaValue;
    set?: (obj: any, value: LuaValue, m: LuaMarshal) => void;
}
/**
 * 一个 Lua 侧的「类」描述。
 *
 * 实现方式与 Cheat Engine 的 luaclass 一致：Lua 对象是带元表的 userdata，
 * 元表的 `__index` 先查方法表（命中的是原始 C 函数，`self` 作为第 1 个参数），
 * 查不到再调用属性 getter。
 */
export interface BridgeClass {
    /** 元表名（`getmetatable(obj).__name`） */
    readonly name: string;
    /** 方法名 → 实现 */
    readonly methods: Record<string, BridgeMethod>;
    /** 属性名 → getter/setter */
    readonly properties: Record<string, BridgeProperty>;
    /** 数字下标的读取（CE 的 default array property，如 list[0]） */
    indexKey?(obj: any, key: number): LuaValue;
    /** 数字下标的写入 */
    newIndexKey?(obj: any, key: number, value: LuaValue): void;
    /** 字符串键的兜底读取 */
    extraIndex?(obj: any, key: string): LuaValue;
    /** 字符串键的兜底写入（没有 setter 的未知属性会走这里） */
    extraNewIndex?(obj: any, key: string, value: LuaValue): void;
    /** 对象被 Lua GC 回收时调用 */
    onGc?(obj: any): void;
}
export interface LuaEngineOptions {
    /** 初始目标进程（可选；之后仍可用 openProcess/attachProcess 切换） */
    process?: Process;
    /**
     * print / showMessage 的输出回调。默认写 process.stdout。
     * 第二个参数是来源：'print' 或 'message'。
     */
    onOutput?: (text: string, kind: 'print' | 'message') => void;
    /** 是否在引擎内保存输出历史（engine.output），默认 true */
    captureOutput?: boolean;
    /** sleep 的最大毫秒数，默认 60000；防止脚本误写 sleep(1e9) 卡死 */
    maxSleepMs?: number;
    /** 模块列表缓存时长（毫秒），默认 2000。设为 0 表示每次都重新枚举 */
    moduleCacheMs?: number;
}
/** API 实现需要的引擎能力（由 LuaEngine 提供，避免 api.ts 反向依赖 bridge.ts）。 */
export interface ApiContext {
    /** 当前已打开进程，未打开返回 null */
    currentProcess(): Process | null;
    /** 当前已打开进程，未打开时抛中文错误 */
    requireProcess(): Process;
    /** 切换当前进程（会清掉共享的扫描会话与模块缓存） */
    attachProcess(proc: Process | null): void;
    /** 官方 API 里的进程号（0 表示未打开） */
    processId(): number;
    /** 符号表 */
    readonly symbols: SymbolTable;
    /** 按名字找模块（大小写不敏感；可省略扩展名） */
    findModule(name: string): ProcessModule | null;
    /** 列出模块（带缓存） */
    listModules(): ProcessModule[];
    /** 输出一行文本 */
    output(text: string, kind: 'print' | 'message'): void;
    /** sleep 上限 */
    readonly maxSleepMs: number;
    /** 默认扫描会话（首次使用时按需创建） */
    defaultScanSession(): any;
    /** 清掉默认扫描会话 */
    dropDefaultScanSession(): void;
    /** 直接执行 scanBlock 用的原始配置编译入口（见 scan.ts） */
    readonly scanner: ScannerFacade;
}
/** 扫描相关能力的外观（由 bridge.ts 组装，内部委托 src/scanner）。 */
export interface ScannerFacade {
    /** 编译扫描配置（转发 matcher.compileConfig） */
    compile(config: any): any;
    /** 单块扫描（转发 matcher.scanBlock） */
    scanBlock(cc: any, buf: Buffer, prev: Buffer | null, out: number[]): void;
    /** 创建 ScanSession */
    createSession(proc: Process, options?: any): any;
}
/** 符号表：registerSymbol / unregisterSymbol / getAddress 用。 */
export declare class SymbolTable {
    private readonly map;
    private readonly lower;
    register(name: string, address: bigint): void;
    unregister(name: string): boolean;
    /** 精确查找（CE 的符号区分大小写） */
    get(name: string): bigint | undefined;
    /** 大小写不敏感查找（用于 getAddress 的兜底） */
    getCaseInsensitive(name: string): bigint | undefined;
    has(name: string): boolean;
    entries(): Array<[string, bigint]>;
    /**
     * 导出符号表快照（浅拷贝）。
     *
     * 用途：Auto Assembler 的引擎需要一个 `Map<string, bigint>` 作为初值
     * （它内部会在脚本执行过程中往这份 Map 里加 `alloc`/`label`/`aobscan` 的结果）。
     * 传快照而不是内部 Map，是为了让"AA 注册了哪些符号"这件事可被显式同步回来。
     */
    snapshot(): Map<string, bigint>;
    /** 从一份 Map 批量灌入（用于把 AA 的结果同步回来） */
    mergeFrom(source: Map<string, bigint>): void;
    clear(): void;
    get size(): number;
}
//# sourceMappingURL=types.d.ts.map