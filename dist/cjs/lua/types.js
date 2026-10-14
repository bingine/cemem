"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SymbolTable = exports.MultiReturn = void 0;
exports.isBridgeObject = isBridgeObject;
/**
 * 多返回值标记。
 *
 * Lua 函数可以返回多个值，但 JS 的数组语义被占用为「Lua table」，
 * 因此用本类显式表示多返回值（与 wasmoon 的 LuaMultiReturn 同款思路）：
 *   return new MultiReturn(1n, 'abc', true);
 */
class MultiReturn extends Array {
    constructor(...values) {
        super(...values);
        Object.setPrototypeOf(this, MultiReturn.prototype);
    }
}
exports.MultiReturn = MultiReturn;
/** 判断是否是桥接对象。 */
function isBridgeObject(v) {
    return (typeof v === 'object' &&
        v !== null &&
        typeof v.luaClass === 'object' &&
        v.luaClass !== null);
}
/** 符号表：registerSymbol / unregisterSymbol / getAddress 用。 */
class SymbolTable {
    map = new Map();
    lower = new Map();
    register(name, address) {
        const key = name.trim();
        if (key === '')
            throw new Error('符号名不能为空');
        this.map.set(key, address);
        this.lower.set(key.toLowerCase(), key);
    }
    unregister(name) {
        const key = name.trim();
        if (this.map.delete(key)) {
            this.lower.delete(key.toLowerCase());
            return true;
        }
        const real = this.lower.get(key.toLowerCase());
        if (real !== undefined) {
            this.map.delete(real);
            this.lower.delete(key.toLowerCase());
            return true;
        }
        return false;
    }
    /** 精确查找（CE 的符号区分大小写） */
    get(name) {
        return this.map.get(name);
    }
    /** 大小写不敏感查找（用于 getAddress 的兜底） */
    getCaseInsensitive(name) {
        const real = this.lower.get(name.toLowerCase());
        return real === undefined ? undefined : this.map.get(real);
    }
    has(name) {
        return this.map.has(name);
    }
    entries() {
        return [...this.map.entries()];
    }
    /**
     * 导出符号表快照（浅拷贝）。
     *
     * 用途：Auto Assembler 的引擎需要一个 `Map<string, bigint>` 作为初值
     * （它内部会在脚本执行过程中往这份 Map 里加 `alloc`/`label`/`aobscan` 的结果）。
     * 传快照而不是内部 Map，是为了让"AA 注册了哪些符号"这件事可被显式同步回来。
     */
    snapshot() {
        return new Map(this.map);
    }
    /** 从一份 Map 批量灌入（用于把 AA 的结果同步回来） */
    mergeFrom(source) {
        for (const [name, address] of source)
            this.register(name, address);
    }
    clear() {
        this.map.clear();
        this.lower.clear();
    }
    get size() {
        return this.map.size;
    }
}
exports.SymbolTable = SymbolTable;
//# sourceMappingURL=types.js.map