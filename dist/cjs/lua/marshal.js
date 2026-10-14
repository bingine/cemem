"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LuaMarshal = exports.LUA_MULTRET = exports.LUA_REGISTRYINDEX = exports.LUA_ERRMEM = exports.LUA_ERRSYNTAX = exports.LUA_ERRRUN = exports.LUA_YIELD = exports.LUA_OK = exports.LUA_TTHREAD = exports.LUA_TUSERDATA = exports.LUA_TFUNCTION = exports.LUA_TTABLE = exports.LUA_TSTRING = exports.LUA_TNUMBER = exports.LUA_TLIGHTUSERDATA = exports.LUA_TBOOLEAN = exports.LUA_TNIL = exports.LUA_TNONE = void 0;
exports.describeValue = describeValue;
exports.currentLongjmpSentinel = currentLongjmpSentinel;
exports.setLongjmpSentinel = setLongjmpSentinel;
exports.isLuaLongjmp = isLuaLongjmp;
exports.describeError = describeError;
const types_1 = require("./types");
/* ------------------------------------------------------------------ *
 * Lua 5.4 常量（lua.h / lauxlib.h）
 * ------------------------------------------------------------------ */
exports.LUA_TNONE = -1;
exports.LUA_TNIL = 0;
exports.LUA_TBOOLEAN = 1;
exports.LUA_TLIGHTUSERDATA = 2;
exports.LUA_TNUMBER = 3;
exports.LUA_TSTRING = 4;
exports.LUA_TTABLE = 5;
exports.LUA_TFUNCTION = 6;
exports.LUA_TUSERDATA = 7;
exports.LUA_TTHREAD = 8;
/** lua_pcallk / lua_resume 的状态码 */
exports.LUA_OK = 0;
exports.LUA_YIELD = 1;
exports.LUA_ERRRUN = 2;
exports.LUA_ERRSYNTAX = 3;
exports.LUA_ERRMEM = 4;
/** LUAI_MAXSTACK = 1000000；LUA_REGISTRYINDEX = -LUAI_MAXSTACK - 1000 */
exports.LUA_REGISTRYINDEX = -1001000;
exports.LUA_MULTRET = -1;
/** 一个 Lua 值的来源类型（错误提示用）。 */
function describeValue(v) {
    if (v === null || v === undefined)
        return 'nil';
    if (typeof v === 'bigint')
        return 'integer';
    if (typeof v === 'number')
        return 'number';
    if (typeof v === 'string')
        return 'string';
    if (typeof v === 'boolean')
        return 'boolean';
    if (Array.isArray(v))
        return 'table';
    return 'userdata';
}
const MAX_TABLE_DEPTH = 16;
/**
 * `lua_error` 的 longjmp 哨兵。
 *
 * ## 为什么需要这个东西
 * 桥里很多地方要从 JS 回调里"报错给 Lua"，用的是 `lua_error`，
 * 它通过 emscripten 的 longjmp 把控制权交回 Lua 的 `pcall`。
 * emscripten 的 JS 版 longjmp 实现是 `_emscripten_throw_longjmp:()=>{throw Infinity}`，
 * 也就是抛一个 **Infinity**（可在 `node_modules/wasmoon/dist/index.js` 里 grep 到）。
 * 桥里**每一个** try/catch 都必须先把这个哨兵原样抛出，否则会把它当普通异常吞掉，
 * 导致 Lua 状态错乱且后续操作静默出错。
 *
 * ## 为什么保留硬编码的 Infinity（而不是运行时探测）
 * 试过主动探测，**行不通**：wasmoon 并没有把 `_emscripten_throw_longjmp`
 * 暴露到 `cmodule` / `cmodule.module` 上（实测 cmodule 的 153 个键里没有任何
 * emscripten 符号），因此拿不到"抛哨兵"的入口去观察它抛什么。
 *
 * 因此采用**保守判定**，这也是安全的关键：
 *   - 只有"非 Error 值"才可能是哨兵；
 *   - 若未来 emscripten/wasmoon 改了哨兵值（比如改成某个 Error 子类），
 *     判定会返回 false → 走正常错误路径（上抛并带堆栈），
 *     **不会**静默吞掉、也不会错乱 Lua 状态。宁可显式报错，不要静默出错。
 *   - 同时提供 `setLongjmpSentinel()` 作为逃生口，便于将来适配。
 *
 * 注：wasmoon 1.16.0 自己在 `Thread` 里也是用 `err === Infinity` 判断
 * （`node_modules/wasmoon/dist/index.js` 第 698 行），所以 Infinity 是当前事实行为。
 */
const DEFAULT_LONGJMP_SENTINEL = Infinity;
let longjmpSentinel = DEFAULT_LONGJMP_SENTINEL;
/** 当前使用的哨兵值（测试与诊断用；注意它不是 JSON 可序列化的）。 */
function currentLongjmpSentinel() {
    return longjmpSentinel;
}
/**
 * 手动指定 longjmp 哨兵值。
 *
 * 仅在确认 emscripten/wasmoon 换了实现时使用。
 */
function setLongjmpSentinel(sentinel) {
    longjmpSentinel = sentinel;
}
/**
 * 判断是不是 `lua_error` 的 longjmp 哨兵。
 *
 * 判定规则：**非 Error 值** 且严格等于当前哨兵值。
 *
 * 额外排除 `Error` 实例是有意为之：某些实现可能把哨兵包装成 Error，
 * 那种情况宁可走正常错误路径（有堆栈可查），也不要静默吞掉。
 */
function isLuaLongjmp(e) {
    if (e instanceof Error)
        return false;
    return e === longjmpSentinel;
}
/** 把任意异常转成可读的中文错误信息。 */
function describeError(e) {
    if (isLuaLongjmp(e))
        return 'Lua error (longjmp)';
    if (e instanceof Error)
        return e.message;
    if (typeof e === 'bigint')
        return e.toString();
    return String(e);
}
/**
 * 绑定到某一个 Lua state（主 state 或协程 state）的栈操作器。
 *
 * 轻量对象：每个 C 闭包调用创建一个即可，不持有需要释放的资源。
 */
class LuaMarshal {
    cm;
    state;
    objects;
    constructor(cm, state, objects = null) {
        this.cm = cm;
        this.state = state;
        this.objects = objects;
    }
    /** 换一个 state（协程场景）。 */
    withState(state) {
        return new LuaMarshal(this.cm, state, this.objects);
    }
    /* ---------------- 栈 ---------------- */
    top() {
        return this.cm.lua_gettop(this.state);
    }
    setTop(n) {
        this.cm.lua_settop(this.state, n);
    }
    pop(n = 1) {
        this.cm.lua_pop(this.state, n);
    }
    /** 把（可能是负数的）索引转成绝对索引。 */
    abs(index) {
        return index > 0 || index <= exports.LUA_REGISTRYINDEX ? index : this.top() + index + 1;
    }
    /* ---------------- 类型判断 ---------------- */
    type(index) {
        return this.cm.lua_type(this.state, index);
    }
    typeName(index) {
        return this.cm.lua_typename(this.state, this.type(index));
    }
    isNil(index) {
        return this.type(index) === exports.LUA_TNIL;
    }
    isNone(index) {
        return this.type(index) === exports.LUA_TNONE;
    }
    isBoolean(index) {
        return this.type(index) === exports.LUA_TBOOLEAN;
    }
    isNumber(index) {
        return this.type(index) === exports.LUA_TNUMBER;
    }
    isInteger(index) {
        return this.cm.lua_isinteger(this.state, index) !== 0;
    }
    isString(index) {
        return this.type(index) === exports.LUA_TSTRING;
    }
    /** 数字或数字字符串（对应 Lua 的 lua_isstring / lua_isnumber 语义） */
    isNumberOrString(index) {
        return this.isNumber(index) || this.isString(index);
    }
    isTable(index) {
        return this.type(index) === exports.LUA_TTABLE;
    }
    isFunction(index) {
        return this.type(index) === exports.LUA_TFUNCTION;
    }
    isUserdata(index) {
        return this.type(index) === exports.LUA_TUSERDATA;
    }
    /* ---------------- 取值 ---------------- */
    toBigInt(index) {
        return this.cm.lua_tointegerx(this.state, index, null);
    }
    toNumber(index) {
        return this.cm.lua_tonumberx(this.state, index, null);
    }
    toString(index) {
        return this.cm.lua_tolstring(this.state, index, null);
    }
    toBoolean(index) {
        return this.cm.lua_toboolean(this.state, index) !== 0;
    }
    /**
     * 数字取值：Lua integer 在 JS 安全整数范围内返回 number，否则返回 bigint。
     *
     * 这样 `readInteger` 这种小值在 Lua/JS 两侧都是普通数字，
     * 而 64 位地址/计数不会丢精度。
     */
    toLuaNumber(index) {
        if (this.isInteger(index)) {
            const v = this.toBigInt(index);
            return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
                ? Number(v)
                : v;
        }
        return this.toNumber(index);
    }
    /* ---------------- 读值（含表与 userdata） ---------------- */
    /** 读取任意 Lua 值。 */
    read(index, depth = 0) {
        const t = this.type(index);
        switch (t) {
            case exports.LUA_TNIL:
            case exports.LUA_TNONE:
                return null;
            case exports.LUA_TBOOLEAN:
                return this.toBoolean(index);
            case exports.LUA_TNUMBER:
                return this.toLuaNumber(index);
            case exports.LUA_TSTRING:
                return this.toString(index);
            case exports.LUA_TTABLE:
                return this.readTable(index, depth);
            case exports.LUA_TUSERDATA: {
                const got = this.objects?.readUserdata(this, index);
                if (got?.found)
                    return got.value;
                return null;
            }
            default:
                return null;
        }
    }
    /**
     * 读取一张表：1..n 连续整数键 → JS 数组；否则 → 字符串键的对象。
     * 数字键在对象形式下转成十进制字符串（例如 `{1000, x=1}`）。
     */
    readTable(index, depth = 0) {
        if (depth > MAX_TABLE_DEPTH) {
            throw new Error(`Lua table 嵌套超过 ${MAX_TABLE_DEPTH} 层，拒绝转换`);
        }
        const abs = this.abs(index);
        const len = Number(this.cm.lua_rawlen(this.state, abs));
        const arr = [];
        const map = {};
        let entries = 0;
        let allArray = true;
        this.cm.lua_pushnil(this.state);
        while (this.cm.lua_next(this.state, abs) !== 0) {
            entries++;
            const keyType = this.type(-2);
            let key;
            if (keyType === exports.LUA_TNUMBER && this.isInteger(-2)) {
                const kn = this.toBigInt(-2);
                key = Number(kn);
                if (!(Number.isInteger(key) && key >= 1 && key <= len))
                    allArray = false;
            }
            else if (keyType === exports.LUA_TSTRING) {
                key = this.toString(-2);
                allArray = false;
            }
            else {
                key = `[${this.typeName(-2)}]`;
                allArray = false;
            }
            const value = this.read(-1, depth + 1);
            if (typeof key === 'number') {
                arr[key - 1] = value;
            }
            else {
                map[key] = value;
            }
            this.pop(1); // 弹出 value，保留 key 给下一次 lua_next
        }
        if (allArray && entries === len) {
            const out = [];
            for (let i = 0; i < len; i++)
                out.push(arr[i] ?? null);
            return out;
        }
        // 混合表：数字键也放进对象里，便于 config 解析
        for (let i = 0; i < arr.length; i++) {
            if (arr[i] !== undefined)
                map[String(i + 1)] = arr[i];
        }
        return map;
    }
    /** 读取一张 Lua 表为普通对象（数组表会变成 {'1': .., '2': ..}）。 */
    readTableObject(index) {
        const v = this.readTable(index);
        if (Array.isArray(v)) {
            const out = {};
            v.forEach((item, i) => {
                out[String(i + 1)] = item;
            });
            return out;
        }
        return v;
    }
    /** 以字符串键读取表字段（不存在或非表时返回 undefined）。 */
    getTableField(index, key) {
        if (!this.isTable(index))
            return undefined;
        const abs = this.abs(index);
        this.cm.lua_getfield(this.state, abs, key);
        const v = this.read(-1);
        this.pop(1);
        return v;
    }
    /* ---------------- 压栈 ---------------- */
    pushNil() {
        this.cm.lua_pushnil(this.state);
    }
    pushBoolean(b) {
        this.cm.lua_pushboolean(this.state, b ? 1 : 0);
    }
    pushInteger(v) {
        this.cm.lua_pushinteger(this.state, v);
    }
    pushNumber(v) {
        this.cm.lua_pushnumber(this.state, v);
    }
    /** 压入字符串（按 UTF-8 编码字节数给长度，避免 Lua 侧截断）。 */
    pushString(s) {
        this.cm.lua_pushlstring(this.state, s, this.cm.module.lengthBytesUTF8(s));
    }
    /** 压入任意值。 */
    push(v) {
        if (v === null || v === undefined) {
            this.pushNil();
            return;
        }
        switch (typeof v) {
            case 'boolean':
                this.pushBoolean(v);
                return;
            case 'bigint':
                // Lua 5.4 integer 是 int64：超范围按位回绕（与 CE 的 qword → lua_Integer 一致）
                this.cm.lua_pushinteger(this.state, BigInt.asIntN(64, v));
                return;
            case 'number':
                if (Number.isSafeInteger(v))
                    this.cm.lua_pushinteger(this.state, BigInt(v));
                else
                    this.cm.lua_pushnumber(this.state, v);
                return;
            case 'string':
                this.pushString(v);
                return;
            case 'object':
                break;
            default:
                throw new Error(`无法把 JS 的 ${typeof v} 推入 Lua`);
        }
        if (Array.isArray(v)) {
            this.pushArray(v);
            return;
        }
        if (v instanceof Map) {
            // Map → 整数/任意键的表（例如 getProcessList 的 pid → 进程名）
            this.cm.lua_createtable(this.state, 0, 0);
            const mt = this.top();
            for (const [k, val] of v.entries()) {
                this.push(k);
                this.push(val);
                this.cm.lua_rawset(this.state, mt);
            }
            return;
        }
        if ((0, types_1.isBridgeObject)(v)) {
            if (this.objects?.pushObject(this, v))
                return;
            throw new Error(`桥接对象 ${v.luaClass.name} 无法压入 Lua（当前 marshal 没有对象层）`);
        }
        this.pushTable(v);
    }
    /** 压入 1..n 的数组表。 */
    pushArray(items) {
        this.cm.lua_createtable(this.state, items.length, 0);
        const t = this.top();
        items.forEach((item, i) => {
            this.push(item);
            this.cm.lua_rawseti(this.state, t, BigInt(i + 1));
        });
    }
    /** 压入字符串键的表。 */
    pushTable(entries) {
        this.cm.lua_createtable(this.state, 0, 0);
        const t = this.top();
        for (const [k, val] of Object.entries(entries)) {
            this.pushString(k);
            this.push(val);
            this.cm.lua_rawset(this.state, t);
        }
    }
    /** 压入一个 C 闭包（先压 upvalue 再 pushcclosure）。 */
    pushClosure(pointer, upvalues = []) {
        for (const up of upvalues)
            this.push(up);
        this.cm.lua_pushcclosure(this.state, pointer, upvalues.length);
    }
    /**
     * 把「处理结果」压栈，返回 Lua 返回值个数。
     * - undefined → 0 个返回值（CE 里大量 API 就是这样）
     * - MultiReturn → 多个返回值
     * - 其它 → 1 个返回值
     */
    pushResult(result) {
        if (result === undefined)
            return 0;
        if (result instanceof types_1.MultiReturn) {
            for (const v of result)
                this.push(v);
            return result.length;
        }
        this.push(result);
        return 1;
    }
    /* ---------------- 错误 ---------------- */
    /**
     * 抛出一个 Lua 错误（等价于 Lua 的 error()）。
     *
     * 实测（wasmoon 1.16.0 / emscripten 的 JS 版 longjmp）：
     * 在 addFunction 的 JS 帧里调用 lua_error 可以正常被 pcall 捕获，
     * 且不需要返回值（longjmp 不会返回到 JS）。
     * 因此所有「参数错误 / 地址无法解析」都按 CE 的做法直接抛错，
     * 而不是静默返回 nil。
     */
    raise(message) {
        this.cm.lua_pushstring(this.state, message);
        this.cm.lua_error(this.state);
        // lua_error 不会返回；下面这行只为满足 TS 的 never 返回类型
        throw new Error(message);
    }
    /* ---------------- 参数辅助 ---------------- */
    /** 取第 n 个参数（1 基），越界返回 undefined。 */
    arg(args, n) {
        return args[n - 1];
    }
    /** 要求某个参数存在，否则抛 Lua 错误。 */
    requireArg(args, n, funcName) {
        const v = args[n - 1];
        if (v === undefined) {
            this.raise(`${funcName}: 缺少第 ${n} 个参数`);
        }
        return v;
    }
    /**
     * 把参数转成 bigint 整数（**只接受 number / bigint**）。
     *
     * 注意：地址参数不要用这个函数 —— 地址还允许字符串表达式
     * （`"game.exe"+1000`），那要走 `api.ts` 里的 `addrOf`（它会调用地址表达式解析器）。
     * 这里刻意不做字符串解析，避免"看起来能传模块名其实只当字面量"的歧义。
     */
    argToBigInt(args, n, funcName) {
        const v = this.requireArg(args, n, funcName);
        if (typeof v === 'bigint')
            return v;
        if (typeof v === 'number') {
            if (!Number.isFinite(v) || !Number.isInteger(v)) {
                this.raise(`${funcName}: 地址参数必须是整数，收到 ${v}`);
            }
            return BigInt(v);
        }
        this.raise(`${funcName}: 地址参数必须是整数，收到 ${describeValue(v)}`);
    }
    /** 整数参数（默认值可选）。 */
    argToInt(args, n, funcName, def) {
        if (args[n - 1] === undefined || args[n - 1] === null) {
            if (def !== undefined)
                return def;
            this.raise(`${funcName}: 缺少第 ${n} 个整数参数`);
        }
        const v = args[n - 1];
        if (typeof v === 'number') {
            if (!Number.isInteger(v))
                this.raise(`${funcName}: 第 ${n} 个参数必须是整数，收到 ${v}`);
            return v;
        }
        if (typeof v === 'bigint') {
            const num = Number(v);
            if (!Number.isSafeInteger(num)) {
                this.raise(`${funcName}: 第 ${n} 个参数超出安全整数范围：${v}`);
            }
            return num;
        }
        this.raise(`${funcName}: 第 ${n} 个参数必须是整数，收到 ${describeValue(v)}`);
    }
    /** 浮点参数。 */
    argToNumber(args, n, funcName, def) {
        const v = args[n - 1];
        if (v === undefined || v === null) {
            if (def !== undefined)
                return def;
            this.raise(`${funcName}: 缺少第 ${n} 个数值参数`);
        }
        if (typeof v === 'number')
            return v;
        if (typeof v === 'bigint')
            return Number(v);
        if (typeof v === 'string') {
            const parsed = Number(v);
            if (Number.isNaN(parsed))
                this.raise(`${funcName}: 第 ${n} 个参数不是合法数值："${v}"`);
            return parsed;
        }
        this.raise(`${funcName}: 第 ${n} 个参数必须是数值，收到 ${describeValue(v)}`);
    }
    /** 字符串参数。 */
    argToString(args, n, funcName, def) {
        const v = args[n - 1];
        if (v === undefined || v === null) {
            if (def !== undefined)
                return def;
            this.raise(`${funcName}: 缺少第 ${n} 个字符串参数`);
        }
        if (typeof v === 'string')
            return v;
        if (typeof v === 'number' || typeof v === 'bigint')
            return String(v);
        this.raise(`${funcName}: 第 ${n} 个参数必须是字符串，收到 ${describeValue(v)}`);
    }
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
    argToBoolean(args, n, def = false) {
        const v = args[n - 1];
        if (v === undefined)
            return def;
        if (v === null || v === false)
            return false;
        return true;
    }
}
exports.LuaMarshal = LuaMarshal;
//# sourceMappingURL=marshal.js.map