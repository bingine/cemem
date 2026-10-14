"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LuaError = exports.LuaMarshal = exports.LuaEngine = exports.LuaScriptError = void 0;
const wasmoon_1 = require("wasmoon");
const node_path_1 = require("node:path");
const node_fs_1 = require("node:fs");
const matcher_1 = require("../scanner/matcher");
const scanner_1 = require("../scanner/scanner");
const backend_1 = require("../asm/backend");
const marshal_1 = require("./marshal");
const objects_1 = require("./objects");
const api_1 = require("./api");
const types_1 = require("./types");
/** Lua 脚本执行失败（语法错误 / 运行时错误）。 */
class LuaScriptError extends Error {
    luaMessage;
    constructor(message, luaMessage) {
        super(message);
        this.luaMessage = luaMessage;
        this.name = 'LuaScriptError';
    }
}
exports.LuaScriptError = LuaScriptError;
exports.LuaError = LuaScriptError;
class LuaEngine {
    /** 输出历史（print / showMessage） */
    outputLines = [];
    /** 符号表 */
    symbols = new types_1.SymbolTable();
    options;
    factory = null;
    wasm = null;
    raw = null;
    statePointer = 0;
    marshal = null;
    objects = null;
    api = null;
    proc = null;
    chunkRefs = new Set();
    functionPointers = [];
    messageHandlerPointer = 0;
    moduleCache = null;
    session = null;
    apiRegistered = false;
    disposed = false;
    /** 扫描能力外观（转发给 src/scanner，不重复实现算法）。 */
    scanner = {
        compile: (config) => (0, matcher_1.compileConfig)(config),
        scanBlock: (cc, buf, prev, out) => (0, matcher_1.scanBlock)(cc, buf, prev, out),
        createSession: (proc, options) => new scanner_1.ScanSession(proc, options),
    };
    constructor(options = {}) {
        this.options = {
            process: options.process,
            onOutput: options.onOutput,
            captureOutput: options.captureOutput !== false,
            maxSleepMs: options.maxSleepMs ?? 60000,
            moduleCacheMs: options.moduleCacheMs ?? 2000,
        };
        if (options.process)
            this.proc = options.process;
    }
    /* ---------------------------------------------------------------- *
     * 状态管理
     * ---------------------------------------------------------------- */
    get isReady() {
        return this.raw !== null && !this.disposed;
    }
    get maxSleepMs() {
        return this.options.maxSleepMs;
    }
    /** 主 Lua state（仅在 createState 之后可用）。 */
    get luaState() {
        return this.statePointer;
    }
    /** 创建（或重建）Lua 状态并注册 API。 */
    async createState() {
        if (this.disposed)
            throw new Error('LuaEngine 已销毁，不能再次 createState');
        if (this.raw) {
            this.registerApiNow();
            return this;
        }
        const factory = new wasmoon_1.LuaFactory();
        const engine = (await factory.createEngine({ openStandardLibs: true }));
        this.factory = factory;
        this.wasm = engine;
        this.raw = engine.cmodule;
        this.statePointer = engine.global.address;
        // 说明：曾尝试在这里"主动探测 longjmp 哨兵值"，但 wasmoon 并未把
        // emscripten 的 `_emscripten_throw_longjmp` 暴露出来（cmodule 上无该符号），
        // 因此改为在 marshal.ts 里做保守判定。详见那段注释。
        this.objects = new objects_1.LuaObjectBridge(this.raw);
        (0, objects_1.registerBuiltinClasses)(this.objects);
        this.marshal = new marshal_1.LuaMarshal(this.raw, this.statePointer, this.objects);
        this.api = (0, api_1.createApi)(this);
        this.registerApiNow();
        // 预热汇编/反汇编后端（WASM 需要异步装载）。
        //
        // 为什么必须在这里等：`assemble` / `disassemble` 这些 API 是**同步**的
        // （Lua 的 C 闭包不能 await），而后端的加载是异步的。若不在建 state 时
        // 预热，脚本里第一次调 `assemble` 就会撞上「后端尚未初始化」。
        //
        // 失败不致命：只是汇编/反汇编不可用，其余 API（读写内存、扫描等）照常工作，
        // 调用者仍可稍后手动 `await ensureAsmBackend()` 重试。
        try {
            await (0, backend_1.ensureAsmBackend)();
        }
        catch {
            /* 保留错误：真正调用汇编 API 时会给出可读提示 */
        }
        return this;
    }
    /**
     * 注册 CE Lua API。
     *
     * 如果还没 createState，会记下请求并在 createState 时自动注册 ——
     * 也就是说 `new LuaEngine(); engine.registerApi(); await engine.createState();` 也能工作。
     */
    registerApi() {
        if (!this.raw)
            return; // createState 时会自动注册
        this.registerApiNow();
    }
    /** 已注册的 API 函数名（按字典序）。 */
    apiFunctionNames() {
        return this.api ? Object.keys(this.api.functions).sort() : [];
    }
    /** 直接以 JS 参数调用某个 API（不需要写 Lua 代码，便于测试与集成）。 */
    invoke(name, ...args) {
        if (!this.api || !this.raw || !this.objects) {
            throw new Error('请先 await createState()');
        }
        const fn = this.api.functions[name];
        if (!fn)
            throw new Error(`未知的 API 函数：${name}`);
        // 用 SafeMarshal：raise() 直接抛 JS 异常，不触发 Lua 的 lua_error（否则会 panic）
        const safe = new SafeMarshal(this.raw, this.statePointer, this.objects);
        const result = fn(args, safe);
        if (result === undefined)
            return undefined;
        if (Array.isArray(result))
            return result;
        return result;
    }
    /* ---------------------------------------------------------------- *
     * 脚本执行
     * ---------------------------------------------------------------- */
    /** 编译一段 Lua 代码，返回可复用的函数句柄。 */
    async loadString(code, chunkName = 'lua-bridge') {
        await this.ensureState();
        const raw = this.raw;
        const base = raw.lua_gettop(this.statePointer);
        this.compileChunk(code, chunkName);
        const ref = raw.luaL_ref(this.statePointer, marshal_1.LUA_REGISTRYINDEX);
        if (raw.lua_gettop(this.statePointer) !== base) {
            raw.lua_settop(this.statePointer, base);
        }
        this.chunkRefs.add(ref);
        return ref;
    }
    /** 从文件加载 Lua 脚本（对应 CE 的 doFile）。 */
    async loadFile(path) {
        const code = (0, node_fs_1.readFileSync)(path, 'utf8');
        return this.loadString(code, path);
    }
    /** 执行 Lua 代码，返回**第一个**返回值（无返回值时返回 undefined）。 */
    async doString(code) {
        const values = await this.doStringAll(code);
        return values.length > 0 ? values[0] : undefined;
    }
    /** 执行 Lua 代码，返回全部返回值。 */
    async doStringAll(code) {
        await this.ensureState();
        return this.protectedCall(() => this.compileChunk(code, 'lua-bridge'), []);
    }
    /** 执行 Lua 文件，返回第一个返回值。 */
    async doFile(path) {
        const values = await this.doStringAll((0, node_fs_1.readFileSync)(path, 'utf8'));
        return values.length > 0 ? values[0] : undefined;
    }
    /** 调用 Lua 全局函数或 loadString 得到的句柄，返回第一个返回值。 */
    async callFunction(nameOrHandle, ...args) {
        const values = await this.callFunctionAll(nameOrHandle, ...args);
        return values.length > 0 ? values[0] : undefined;
    }
    /** 调用 Lua 函数，返回全部返回值。 */
    async callFunctionAll(nameOrHandle, ...args) {
        await this.ensureState();
        const raw = this.raw;
        const setup = () => {
            if (typeof nameOrHandle === 'number') {
                raw.lua_rawgeti(this.statePointer, marshal_1.LUA_REGISTRYINDEX, BigInt(nameOrHandle));
                return;
            }
            const type = raw.lua_getglobal(this.statePointer, nameOrHandle);
            // LUA_TFUNCTION = 6
            if (type !== 6) {
                raw.lua_pop(this.statePointer, 1);
                throw new LuaScriptError(`全局名字 ${nameOrHandle} 不是函数（类型码 ${type}）`, `not a function`);
            }
        };
        return this.protectedCall(setup, args);
    }
    /* ---------------------------------------------------------------- *
     * ApiContext 实现
     * ---------------------------------------------------------------- */
    currentProcess() {
        return this.proc;
    }
    requireProcess() {
        if (!this.proc)
            throw new Error('尚未打开目标进程，请先调用 openProcess(...) 或 attachProcess(proc)');
        return this.proc;
    }
    processId() {
        return this.proc ? this.proc.pid : 0;
    }
    /** 绑定（或解绑）目标进程；旧进程句柄会被关闭，扫描会话与模块缓存会失效。 */
    attachProcess(proc) {
        if (this.proc && this.proc !== proc) {
            try {
                this.proc.close();
            }
            catch {
                /* 忽略 */
            }
        }
        const changed = this.proc !== proc;
        this.proc = proc;
        this.moduleCache = null;
        this.dropDefaultScanSession();
        // 换进程后 Auto Assembler 的 alloc 记录与还原历史对新进程没有意义
        // （旧进程的内存已消失），因此丢弃重建。
        if (changed && this.api)
            this.api.autoAssembler.invalidate();
    }
    listModules() {
        const proc = this.proc;
        if (!proc)
            return [];
        const now = Date.now();
        if (this.moduleCache && now - this.moduleCache.time < this.options.moduleCacheMs) {
            return this.moduleCache.modules;
        }
        const modules = proc.modules();
        this.moduleCache = { time: now, modules };
        return modules;
    }
    /** 按名字找模块：大小写不敏感，支持全路径、带/不带扩展名。 */
    findModule(name) {
        const needle = name.trim().toLowerCase();
        if (needle === '')
            return null;
        const modules = this.listModules();
        const fileOf = (p) => (0, node_path_1.basename)(p).toLowerCase();
        const stripExt = (s) => s.replace(/\.[a-z0-9]+$/, '');
        return (modules.find((m) => fileOf(m.name) === needle) ??
            modules.find((m) => m.path.toLowerCase() === needle) ??
            modules.find((m) => fileOf(m.path) === needle) ??
            modules.find((m) => stripExt(fileOf(m.name)) === stripExt(needle)) ??
            modules.find((m) => stripExt(fileOf(m.path)) === stripExt(needle)) ??
            modules.find((m) => fileOf(m.name).includes(needle)) ??
            null);
    }
    output(text, kind) {
        if (this.options.captureOutput)
            this.outputLines.push(text);
        if (this.options.onOutput) {
            this.options.onOutput(text, kind);
            return;
        }
        process.stdout.write(text + '\n');
    }
    /** 当前捕获到的输出历史（print / showMessage）。 */
    get capturedOutput() {
        return this.outputLines;
    }
    clearOutput() {
        this.outputLines.length = 0;
    }
    defaultScanSession() {
        if (!this.proc) {
            throw new Error('尚未打开目标进程，请先调用 openProcess(...)');
        }
        if (!this.session) {
            this.session = new objects_1.LuaScanSession(this.proc, this.scanner);
        }
        return this.session;
    }
    dropDefaultScanSession() {
        if (this.session) {
            try {
                this.session.destroy();
            }
            catch {
                /* 忽略 */
            }
            this.session = null;
        }
    }
    /* ---------------------------------------------------------------- *
     * 销毁
     * ---------------------------------------------------------------- */
    /** 释放 Lua 状态、注册的 C 函数与本引擎打开的进程句柄。 */
    async dispose(options = {}) {
        if (this.disposed)
            return;
        this.disposed = true;
        const raw = this.raw;
        if (raw) {
            for (const ref of this.chunkRefs) {
                try {
                    raw.luaL_unref(this.statePointer, marshal_1.LUA_REGISTRYINDEX, ref);
                }
                catch {
                    /* 忽略 */
                }
            }
            this.chunkRefs.clear();
            raw.lua_settop(this.statePointer, 0);
        }
        this.objects?.dispose();
        for (const ptr of this.functionPointers) {
            try {
                raw?.module.removeFunction(ptr);
            }
            catch {
                /* 忽略 */
            }
        }
        this.functionPointers.length = 0;
        if (raw && this.messageHandlerPointer) {
            try {
                raw.module.removeFunction(this.messageHandlerPointer);
            }
            catch {
                /* 忽略 */
            }
            this.messageHandlerPointer = 0;
        }
        this.dropDefaultScanSession();
        try {
            this.wasm?.global.close();
        }
        catch {
            /* 忽略 */
        }
        if (options.closeProcess !== false && this.proc) {
            try {
                this.proc.close();
            }
            catch {
                /* 忽略 */
            }
            this.proc = null;
        }
        this.raw = null;
        this.wasm = null;
        this.factory = null;
        this.marshal = null;
        this.api = null;
        this.apiRegistered = false;
    }
    /* ---------------------------------------------------------------- *
     * 内部实现
     * ---------------------------------------------------------------- */
    async ensureState() {
        if (this.raw)
            return;
        if (this.disposed)
            throw new Error('LuaEngine 已销毁');
        await this.createState();
    }
    /** 注册全部 API 为 Lua 全局函数（用原始 C 闭包，保住 int64 精度）。 */
    registerApiNow() {
        const raw = this.raw;
        const marshal = this.marshal;
        const api = this.api;
        if (!raw || !marshal || !api || this.apiRegistered)
            return;
        // 错误消息处理器：pcall 出错时补上 Lua 侧的调用栈
        this.messageHandlerPointer = raw.module.addFunction((state) => this.messageHandler(state), 'ii');
        for (const [name, fn] of Object.entries(api.functions)) {
            const pointer = raw.module.addFunction((state) => this.invokeApi(name, fn, state), 'ii');
            this.functionPointers.push(pointer);
            marshal.pushClosure(pointer, []);
            raw.lua_setglobal(this.statePointer, name);
        }
        this.apiRegistered = true;
    }
    /** API 闭包的统一入口：把 Lua 栈上的参数解码成 JS 值，再把结果编码回 Lua。 */
    invokeApi(name, fn, state) {
        const base = this.marshal;
        const m = base.withState(state);
        try {
            const argc = m.top();
            const args = [];
            for (let i = 1; i <= argc; i++)
                args.push(m.read(i));
            const result = fn(args, m);
            return m.pushResult(result);
        }
        catch (e) {
            if ((0, marshal_1.isLuaLongjmp)(e))
                throw e; // lua_error 的 longjmp 哨兵必须原样抛出
            m.raise(`${name}: ${(0, marshal_1.describeError)(e)}`);
            return 0;
        }
    }
    /** pcall 的错误消息处理器（errfunc）：补 traceback。 */
    messageHandler(state) {
        const raw = this.raw;
        raw.luaL_tolstring(state, 1, null); // 把任意错误对象转成字符串压栈
        const message = raw.lua_tolstring(state, -1, null);
        raw.lua_pop(state, 1);
        raw.luaL_traceback(state, state, message, 1);
        return 1;
    }
    /** 把一段代码编译成函数压栈；出错抛 LuaScriptError。 */
    compileChunk(code, chunkName) {
        const raw = this.raw;
        const base = raw.lua_gettop(this.statePointer);
        const bytes = Buffer.byteLength(code, 'utf8');
        const pointer = raw.module._malloc(bytes + 1);
        try {
            raw.module.stringToUTF8(code, pointer, bytes + 1);
            const status = raw.luaL_loadbufferx(this.statePointer, pointer, bytes, chunkName, null);
            if (status !== marshal_1.LUA_OK) {
                const message = raw.lua_tolstring(this.statePointer, -1, null) ?? '未知的编译错误';
                raw.lua_settop(this.statePointer, base);
                throw new LuaScriptError(`Lua 语法错误：${message}`, message);
            }
        }
        finally {
            raw.module._free(pointer);
        }
    }
    /**
     * 受保护地调用栈上的函数。
     *
     * 栈布局：base+1 = 错误处理器，base+2 = 被调函数，随后是参数。
     * setup 负责压入函数（编译好的 chunk / 全局函数 / 注册表句柄）。
     */
    protectedCall(setup, args) {
        const raw = this.raw;
        const marshal = this.marshal;
        const L = this.statePointer;
        const base = raw.lua_gettop(L);
        try {
            setup();
        }
        catch (e) {
            raw.lua_settop(L, base);
            throw e;
        }
        if (raw.lua_gettop(L) !== base + 1) {
            raw.lua_settop(L, base);
            throw new Error('内部错误：setup 必须压入恰好一个函数');
        }
        raw.lua_pushcclosure(L, this.messageHandlerPointer, 0); // base+2
        raw.lua_rotate(L, base + 1, 1); // 交换 → [错误处理器, 函数]
        for (const a of args)
            marshal.push(a);
        const status = raw.lua_pcallk(L, args.length, marshal_1.LUA_MULTRET, base + 1, 0, null);
        if (status !== marshal_1.LUA_OK) {
            let message = '未知的 Lua 错误';
            try {
                message = raw.lua_tolstring(L, -1, null) ?? message;
            }
            catch {
                /* 忽略 */
            }
            raw.lua_settop(L, base);
            throw new LuaScriptError(`Lua 运行时错误：${message}`, message);
        }
        const count = raw.lua_gettop(L) - (base + 1);
        const values = [];
        for (let i = 0; i < count; i++) {
            values.push(marshal.read(base + 2 + i));
        }
        raw.lua_settop(L, base);
        return values;
    }
}
exports.LuaEngine = LuaEngine;
/**
 * 只能在 Lua 之外使用的 Marshal：`raise` 直接抛 JS 异常。
 *
 * 直接调用 lua_error 在 pcall 之外会导致 Lua panic（进程 abort），
 * 因此 engine.invoke() 用这个子类。
 */
class SafeMarshal extends marshal_1.LuaMarshal {
    raise(message) {
        throw new Error(message);
    }
}
var marshal_2 = require("./marshal");
Object.defineProperty(exports, "LuaMarshal", { enumerable: true, get: function () { return marshal_2.LuaMarshal; } });
//# sourceMappingURL=bridge.js.map