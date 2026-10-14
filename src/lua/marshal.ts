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
import { MultiReturn, isBridgeObject } from './types';

/* ------------------------------------------------------------------ *
 * Lua 5.4 常量（lua.h / lauxlib.h）
 * ------------------------------------------------------------------ */

export const LUA_TNONE = -1;
export const LUA_TNIL = 0;
export const LUA_TBOOLEAN = 1;
export const LUA_TLIGHTUSERDATA = 2;
export const LUA_TNUMBER = 3;
export const LUA_TSTRING = 4;
export const LUA_TTABLE = 5;
export const LUA_TFUNCTION = 6;
export const LUA_TUSERDATA = 7;
export const LUA_TTHREAD = 8;

/** lua_pcallk / lua_resume 的状态码 */
export const LUA_OK = 0;
export const LUA_YIELD = 1;
export const LUA_ERRRUN = 2;
export const LUA_ERRSYNTAX = 3;
export const LUA_ERRMEM = 4;

/** LUAI_MAXSTACK = 1000000；LUA_REGISTRYINDEX = -LUAI_MAXSTACK - 1000 */
export const LUA_REGISTRYINDEX = -1001000;
export const LUA_MULTRET = -1;

/* ------------------------------------------------------------------ *
 * wasmoon 暴露的原始模块（只声明本桥用到的函数）
 * ------------------------------------------------------------------ */

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
  lua_pcallk(
    L: number,
    nargs: number,
    nresults: number,
    errfunc: number,
    ctx: number,
    k: number | null,
  ): number;
  lua_error(L: number): number;
  lua_upvalueindex(index: number): number;
  lua_pop(L: number, count: number): void;
}

/** 桥接对象层需要向 marshal 暴露的最小能力。 */
export interface MarshalObjectAccess {
  /** 若该索引是桥的 userdata，返回宿主 JS 对象 */
  readUserdata(m: LuaMarshal, index: number): { found: boolean; value?: unknown };
  /** 把一个桥接对象压栈（返回 true 表示已处理） */
  pushObject(m: LuaMarshal, obj: ILuaBridgeObject): boolean;
}

/** 一个 Lua 值的来源类型（错误提示用）。 */
export function describeValue(v: LuaValue): string {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'bigint') return 'integer';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return 'table';
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
const DEFAULT_LONGJMP_SENTINEL: unknown = Infinity;

let longjmpSentinel: unknown = DEFAULT_LONGJMP_SENTINEL;

/** 当前使用的哨兵值（测试与诊断用；注意它不是 JSON 可序列化的）。 */
export function currentLongjmpSentinel(): unknown {
  return longjmpSentinel;
}

/**
 * 手动指定 longjmp 哨兵值。
 *
 * 仅在确认 emscripten/wasmoon 换了实现时使用。
 */
export function setLongjmpSentinel(sentinel: unknown): void {
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
export function isLuaLongjmp(e: unknown): boolean {
  if (e instanceof Error) return false;
  return e === longjmpSentinel;
}

/** 把任意异常转成可读的中文错误信息。 */
export function describeError(e: unknown): string {
  if (isLuaLongjmp(e)) return 'Lua error (longjmp)';
  if (e instanceof Error) return e.message;
  if (typeof e === 'bigint') return e.toString();
  return String(e);
}

/**
 * 绑定到某一个 Lua state（主 state 或协程 state）的栈操作器。
 *
 * 轻量对象：每个 C 闭包调用创建一个即可，不持有需要释放的资源。
 */
export class LuaMarshal {
  constructor(
    readonly cm: LuaRaw,
    readonly state: number,
    private readonly objects: MarshalObjectAccess | null = null,
  ) {}

  /** 换一个 state（协程场景）。 */
  withState(state: number): LuaMarshal {
    return new LuaMarshal(this.cm, state, this.objects);
  }

  /* ---------------- 栈 ---------------- */

  top(): number {
    return this.cm.lua_gettop(this.state);
  }

  setTop(n: number): void {
    this.cm.lua_settop(this.state, n);
  }

  pop(n = 1): void {
    this.cm.lua_pop(this.state, n);
  }

  /** 把（可能是负数的）索引转成绝对索引。 */
  abs(index: number): number {
    return index > 0 || index <= LUA_REGISTRYINDEX ? index : this.top() + index + 1;
  }

  /* ---------------- 类型判断 ---------------- */

  type(index: number): number {
    return this.cm.lua_type(this.state, index);
  }

  typeName(index: number): string {
    return this.cm.lua_typename(this.state, this.type(index));
  }

  isNil(index: number): boolean {
    return this.type(index) === LUA_TNIL;
  }

  isNone(index: number): boolean {
    return this.type(index) === LUA_TNONE;
  }

  isBoolean(index: number): boolean {
    return this.type(index) === LUA_TBOOLEAN;
  }

  isNumber(index: number): boolean {
    return this.type(index) === LUA_TNUMBER;
  }

  isInteger(index: number): boolean {
    return this.cm.lua_isinteger(this.state, index) !== 0;
  }

  isString(index: number): boolean {
    return this.type(index) === LUA_TSTRING;
  }

  /** 数字或数字字符串（对应 Lua 的 lua_isstring / lua_isnumber 语义） */
  isNumberOrString(index: number): boolean {
    return this.isNumber(index) || this.isString(index);
  }

  isTable(index: number): boolean {
    return this.type(index) === LUA_TTABLE;
  }

  isFunction(index: number): boolean {
    return this.type(index) === LUA_TFUNCTION;
  }

  isUserdata(index: number): boolean {
    return this.type(index) === LUA_TUSERDATA;
  }

  /* ---------------- 取值 ---------------- */

  toBigInt(index: number): bigint {
    return this.cm.lua_tointegerx(this.state, index, null);
  }

  toNumber(index: number): number {
    return this.cm.lua_tonumberx(this.state, index, null);
  }

  toString(index: number): string {
    return this.cm.lua_tolstring(this.state, index, null);
  }

  toBoolean(index: number): boolean {
    return this.cm.lua_toboolean(this.state, index) !== 0;
  }

  /**
   * 数字取值：Lua integer 在 JS 安全整数范围内返回 number，否则返回 bigint。
   *
   * 这样 `readInteger` 这种小值在 Lua/JS 两侧都是普通数字，
   * 而 64 位地址/计数不会丢精度。
   */
  toLuaNumber(index: number): number | bigint {
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
  read(index: number, depth = 0): LuaValue {
    const t = this.type(index);
    switch (t) {
      case LUA_TNIL:
      case LUA_TNONE:
        return null;
      case LUA_TBOOLEAN:
        return this.toBoolean(index);
      case LUA_TNUMBER:
        return this.toLuaNumber(index);
      case LUA_TSTRING:
        return this.toString(index);
      case LUA_TTABLE:
        return this.readTable(index, depth);
      case LUA_TUSERDATA: {
        const got = this.objects?.readUserdata(this, index);
        if (got?.found) return got.value as LuaValue;
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
  readTable(index: number, depth = 0): LuaTable | LuaValue[] {
    if (depth > MAX_TABLE_DEPTH) {
      throw new Error(`Lua table 嵌套超过 ${MAX_TABLE_DEPTH} 层，拒绝转换`);
    }
    const abs = this.abs(index);
    const len = Number(this.cm.lua_rawlen(this.state, abs));
    const arr: LuaValue[] = [];
    const map: Record<string, LuaValue> = {};
    let entries = 0;
    let allArray = true;

    this.cm.lua_pushnil(this.state);
    while (this.cm.lua_next(this.state, abs) !== 0) {
      entries++;
      const keyType = this.type(-2);
      let key: string | number;
      if (keyType === LUA_TNUMBER && this.isInteger(-2)) {
        const kn = this.toBigInt(-2);
        key = Number(kn);
        if (!(Number.isInteger(key) && key >= 1 && key <= len)) allArray = false;
      } else if (keyType === LUA_TSTRING) {
        key = this.toString(-2);
        allArray = false;
      } else {
        key = `[${this.typeName(-2)}]`;
        allArray = false;
      }
      const value = this.read(-1, depth + 1);
      if (typeof key === 'number') {
        arr[key - 1] = value;
      } else {
        map[key] = value;
      }
      this.pop(1); // 弹出 value，保留 key 给下一次 lua_next
    }

    if (allArray && entries === len) {
      const out: LuaValue[] = [];
      for (let i = 0; i < len; i++) out.push(arr[i] ?? null);
      return out;
    }
    // 混合表：数字键也放进对象里，便于 config 解析
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] !== undefined) map[String(i + 1)] = arr[i];
    }
    return map;
  }

  /** 读取一张 Lua 表为普通对象（数组表会变成 {'1': .., '2': ..}）。 */
  readTableObject(index: number): LuaTable {
    const v = this.readTable(index);
    if (Array.isArray(v)) {
      const out: LuaTable = {};
      v.forEach((item, i) => {
        out[String(i + 1)] = item;
      });
      return out;
    }
    return v;
  }

  /** 以字符串键读取表字段（不存在或非表时返回 undefined）。 */
  getTableField(index: number, key: string): LuaValue | undefined {
    if (!this.isTable(index)) return undefined;
    const abs = this.abs(index);
    this.cm.lua_getfield(this.state, abs, key);
    const v = this.read(-1);
    this.pop(1);
    return v;
  }

  /* ---------------- 压栈 ---------------- */

  pushNil(): void {
    this.cm.lua_pushnil(this.state);
  }

  pushBoolean(b: boolean): void {
    this.cm.lua_pushboolean(this.state, b ? 1 : 0);
  }

  pushInteger(v: bigint): void {
    this.cm.lua_pushinteger(this.state, v);
  }

  pushNumber(v: number): void {
    this.cm.lua_pushnumber(this.state, v);
  }

  /** 压入字符串（按 UTF-8 编码字节数给长度，避免 Lua 侧截断）。 */
  pushString(s: string): void {
    this.cm.lua_pushlstring(this.state, s, this.cm.module.lengthBytesUTF8(s));
  }

  /** 压入任意值。 */
  push(v: LuaValue): void {
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
        if (Number.isSafeInteger(v)) this.cm.lua_pushinteger(this.state, BigInt(v));
        else this.cm.lua_pushnumber(this.state, v);
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
        this.push(k as LuaValue);
        this.push(val as LuaValue);
        this.cm.lua_rawset(this.state, mt);
      }
      return;
    }
    if (isBridgeObject(v)) {
      if (this.objects?.pushObject(this, v)) return;
      throw new Error(`桥接对象 ${v.luaClass.name} 无法压入 Lua（当前 marshal 没有对象层）`);
    }
    this.pushTable(v as LuaTable);
  }

  /** 压入 1..n 的数组表。 */
  pushArray(items: LuaValue[]): void {
    this.cm.lua_createtable(this.state, items.length, 0);
    const t = this.top();
    items.forEach((item, i) => {
      this.push(item);
      this.cm.lua_rawseti(this.state, t, BigInt(i + 1));
    });
  }

  /** 压入字符串键的表。 */
  pushTable(entries: LuaTable): void {
    this.cm.lua_createtable(this.state, 0, 0);
    const t = this.top();
    for (const [k, val] of Object.entries(entries)) {
      this.pushString(k);
      this.push(val);
      this.cm.lua_rawset(this.state, t);
    }
  }

  /** 压入一个 C 闭包（先压 upvalue 再 pushcclosure）。 */
  pushClosure(pointer: number, upvalues: LuaValue[] = []): void {
    for (const up of upvalues) this.push(up);
    this.cm.lua_pushcclosure(this.state, pointer, upvalues.length);
  }

  /**
   * 把「处理结果」压栈，返回 Lua 返回值个数。
   * - undefined → 0 个返回值（CE 里大量 API 就是这样）
   * - MultiReturn → 多个返回值
   * - 其它 → 1 个返回值
   */
  pushResult(result: LuaValue | MultiReturn | void): number {
    if (result === undefined) return 0;
    if (result instanceof MultiReturn) {
      for (const v of result) this.push(v);
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
  raise(message: string): never {
    this.cm.lua_pushstring(this.state, message);
    this.cm.lua_error(this.state);
    // lua_error 不会返回；下面这行只为满足 TS 的 never 返回类型
    throw new Error(message);
  }

  /* ---------------- 参数辅助 ---------------- */

  /** 取第 n 个参数（1 基），越界返回 undefined。 */
  arg(args: LuaValue[], n: number): LuaValue | undefined {
    return args[n - 1];
  }

  /** 要求某个参数存在，否则抛 Lua 错误。 */
  requireArg(args: LuaValue[], n: number, funcName: string): LuaValue {
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
  argToBigInt(args: LuaValue[], n: number, funcName: string): bigint {
    const v = this.requireArg(args, n, funcName);
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || !Number.isInteger(v)) {
        this.raise(`${funcName}: 地址参数必须是整数，收到 ${v}`);
      }
      return BigInt(v);
    }
    this.raise(`${funcName}: 地址参数必须是整数，收到 ${describeValue(v)}`);
  }

  /** 整数参数（默认值可选）。 */
  argToInt(args: LuaValue[], n: number, funcName: string, def?: number): number {
    if (args[n - 1] === undefined || args[n - 1] === null) {
      if (def !== undefined) return def;
      this.raise(`${funcName}: 缺少第 ${n} 个整数参数`);
    }
    const v = args[n - 1] as number | bigint;
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) this.raise(`${funcName}: 第 ${n} 个参数必须是整数，收到 ${v}`);
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
  argToNumber(args: LuaValue[], n: number, funcName: string, def?: number): number {
    const v = args[n - 1];
    if (v === undefined || v === null) {
      if (def !== undefined) return def;
      this.raise(`${funcName}: 缺少第 ${n} 个数值参数`);
    }
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'string') {
      const parsed = Number(v);
      if (Number.isNaN(parsed)) this.raise(`${funcName}: 第 ${n} 个参数不是合法数值："${v}"`);
      return parsed;
    }
    this.raise(`${funcName}: 第 ${n} 个参数必须是数值，收到 ${describeValue(v)}`);
  }

  /** 字符串参数。 */
  argToString(args: LuaValue[], n: number, funcName: string, def?: string): string {
    const v = args[n - 1];
    if (v === undefined || v === null) {
      if (def !== undefined) return def;
      this.raise(`${funcName}: 缺少第 ${n} 个字符串参数`);
    }
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'bigint') return String(v);
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
  argToBoolean(args: LuaValue[], n: number, def = false): boolean {
    const v = args[n - 1];
    if (v === undefined) return def;
    if (v === null || v === false) return false;
    return true;
  }
}
