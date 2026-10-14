/**
 * Lua 脚本桥 —— Cheat Engine Lua API 的 Node 版子集。
 *
 * 依赖选型：**wasmoon**（真实 Lua 5.4 的 WASM 构建）。
 *   理由：CE 用的就是 Lua 5.3/5.4，wasmoon 提供的是 Lua 5.4，
 *   整数语义（64 位 integer + float）、`string.format("%d")`、协程、goto 等
 *   都与 CE 一致；fengari 是纯 JS 的 Lua 5.1，没有整数子类型
 *   （所有数字都是 double），地址精度会对不上。
 *
 * 但 wasmoon 的高层 JS↔Lua 函数桥不能直接用：
 *   实测 `global.set('f', f)` 之后，Lua 的 integer 会被转成 JS number
 *   （9007199254740993 → 9007199254740992，丢精度），而且 JS 返回 bigint 会抛
 *   "The type 'bigint' is not supported by Lua"。
 *   所以本桥绕过它，直接用 Lua C API 注册 C 闭包：
 *     - 入参：lua_tointegerx 返回 BigInt（原始精度）
 *     - 出参：lua_pushinteger 接受 BigInt
 *
 * 用法：
 * ```ts
 * const lua = new LuaEngine({ onOutput: (t) => console.log(t) });
 * await lua.createState();
 * lua.attachProcess(Process.open(pid));            // 或者脚本里 openProcess(pid)
 * const value = await lua.doString('return readInteger(getAddress("0x7ff00000"))');
 * await lua.dispose();
 * ```
 */
import type { Process, ProcessModule } from '../win/process';
import { LuaScanSession } from './objects';
import { SymbolTable, type ApiContext, type LuaEngineOptions, type LuaValue, type ScannerFacade } from './types';
/** Lua 脚本执行失败（语法错误 / 运行时错误）。 */
export declare class LuaScriptError extends Error {
    readonly luaMessage: string;
    constructor(message: string, luaMessage: string);
}
export declare class LuaEngine implements ApiContext {
    /** 输出历史（print / showMessage） */
    readonly outputLines: string[];
    /** 符号表 */
    readonly symbols: SymbolTable;
    private readonly options;
    private factory;
    private wasm;
    private raw;
    private statePointer;
    private marshal;
    private objects;
    private api;
    private proc;
    private readonly chunkRefs;
    private readonly functionPointers;
    private messageHandlerPointer;
    private moduleCache;
    private session;
    private apiRegistered;
    private disposed;
    /** 扫描能力外观（转发给 src/scanner，不重复实现算法）。 */
    readonly scanner: ScannerFacade;
    constructor(options?: LuaEngineOptions);
    get isReady(): boolean;
    get maxSleepMs(): number;
    /** 主 Lua state（仅在 createState 之后可用）。 */
    get luaState(): number;
    /** 创建（或重建）Lua 状态并注册 API。 */
    createState(): Promise<this>;
    /**
     * 注册 CE Lua API。
     *
     * 如果还没 createState，会记下请求并在 createState 时自动注册 ——
     * 也就是说 `new LuaEngine(); engine.registerApi(); await engine.createState();` 也能工作。
     */
    registerApi(): void;
    /** 已注册的 API 函数名（按字典序）。 */
    apiFunctionNames(): string[];
    /** 直接以 JS 参数调用某个 API（不需要写 Lua 代码，便于测试与集成）。 */
    invoke(name: string, ...args: LuaValue[]): LuaValue | undefined;
    /** 编译一段 Lua 代码，返回可复用的函数句柄。 */
    loadString(code: string, chunkName?: string): Promise<number>;
    /** 从文件加载 Lua 脚本（对应 CE 的 doFile）。 */
    loadFile(path: string): Promise<number>;
    /** 执行 Lua 代码，返回**第一个**返回值（无返回值时返回 undefined）。 */
    doString(code: string): Promise<LuaValue | undefined>;
    /** 执行 Lua 代码，返回全部返回值。 */
    doStringAll(code: string): Promise<LuaValue[]>;
    /** 执行 Lua 文件，返回第一个返回值。 */
    doFile(path: string): Promise<LuaValue | undefined>;
    /** 调用 Lua 全局函数或 loadString 得到的句柄，返回第一个返回值。 */
    callFunction(nameOrHandle: string | number, ...args: LuaValue[]): Promise<LuaValue | undefined>;
    /** 调用 Lua 函数，返回全部返回值。 */
    callFunctionAll(nameOrHandle: string | number, ...args: LuaValue[]): Promise<LuaValue[]>;
    currentProcess(): Process | null;
    requireProcess(): Process;
    processId(): number;
    /** 绑定（或解绑）目标进程；旧进程句柄会被关闭，扫描会话与模块缓存会失效。 */
    attachProcess(proc: Process | null): void;
    listModules(): ProcessModule[];
    /** 按名字找模块：大小写不敏感，支持全路径、带/不带扩展名。 */
    findModule(name: string): ProcessModule | null;
    output(text: string, kind: 'print' | 'message'): void;
    /** 当前捕获到的输出历史（print / showMessage）。 */
    get capturedOutput(): readonly string[];
    clearOutput(): void;
    defaultScanSession(): LuaScanSession;
    dropDefaultScanSession(): void;
    /** 释放 Lua 状态、注册的 C 函数与本引擎打开的进程句柄。 */
    dispose(options?: {
        closeProcess?: boolean;
    }): Promise<void>;
    private ensureState;
    /** 注册全部 API 为 Lua 全局函数（用原始 C 闭包，保住 int64 精度）。 */
    private registerApiNow;
    /** API 闭包的统一入口：把 Lua 栈上的参数解码成 JS 值，再把结果编码回 Lua。 */
    private invokeApi;
    /** pcall 的错误消息处理器（errfunc）：补 traceback。 */
    private messageHandler;
    /** 把一段代码编译成函数压栈；出错抛 LuaScriptError。 */
    private compileChunk;
    /**
     * 受保护地调用栈上的函数。
     *
     * 栈布局：base+1 = 错误处理器，base+2 = 被调函数，随后是参数。
     * setup 负责压入函数（编译好的 chunk / 全局函数 / 注册表句柄）。
     */
    private protectedCall;
}
export { LuaMarshal } from './marshal';
export type { LuaValue, LuaEngineOptions } from './types';
export type { ApiFunction } from './api';
export { LuaScriptError as LuaError };
//# sourceMappingURL=bridge.d.ts.map