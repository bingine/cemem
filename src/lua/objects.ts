/**
 * Lua userdata 对象桥 + CE 风格的宿主对象。
 *
 * 实现方式对齐 Cheat Engine 的 luaclass：
 *   - 每个「类」有一个元表，元表的 `__index` 是一个 C 闭包，先查方法表
 *     （方法表里存的是原始 C 函数），命中就直接返回该函数 —— Lua 用冒号调用时
 *     `self` 作为第 1 个参数传进来，与 CE 的 luaclass_getClassObject 一致；
 *   - 查不到方法就按属性 getter 处理（`list.Count`、`record.Value` 这类活属性）；
 *   - 对象本身是 4 字节 userdata，里面存 JS 侧句柄（i32），
 *     JS 侧用 Map<句柄, 对象> 保存真实对象。
 *
 * 之所以不用普通 Lua table 模拟：table 承载不了「活属性」，
 * 也没有 CE 对象该有的 destroy()/GC 语义；CE 的对象本来就是 userdata。
 */

import type { Process } from '../win/process';
import { VariableType, type ScanConfig } from '../types';
import type { ScanSession } from '../scanner/scanner';
import {
  LUA_REGISTRYINDEX,
  LUA_TUSERDATA,
  LuaMarshal,
  type LuaRaw,
  describeError,
  isLuaLongjmp,
} from './marshal';
import { parseScanConfig, parseVariableType, variableWidth } from './scan';
import type { BridgeClass, ILuaBridgeObject, LuaValue, ScannerFacade } from './types';

/** userdata 里存的句柄宽度（wasm32 下是 4 字节，正好放一个 i32 句柄）。 */
const USERDATA_SIZE = 4;

/** 默认字符串长度（CE 的 MemoryRecord 有可配置的字符串长度，这里给固定默认值）。 */
const ANSI_STRING_LENGTH = 64;
const WIDE_STRING_LENGTH = 32;

/* ------------------------------------------------------------------ *
 * 对象桥
 * ------------------------------------------------------------------ */

export class LuaObjectBridge {
  private readonly objects = new Map<number, any>();
  /**
   * 每个句柄当前有多少个**活的 userdata** 指向它。
   *
   * 只有当计数归零时才能真正从 `objects` 里摘除宿主对象 ——
   * 详见 `closureGc` 与 `handleOf` 的注释。
   */
  private readonly handleRefs = new Map<number, number>();
  private readonly handleOfObject = new WeakMap<object, number>();
  private readonly classes = new Map<number, BridgeClass>();
  private readonly classIds = new Map<string, number>();
  private readonly metatableRefs = new Map<string, number>();
  /** 未声明 setter 的属性写入会落到这里（脚本可以往对象上挂自己的字段） */
  private readonly extras = new WeakMap<object, Record<string, LuaValue>>();
  private readonly fnPtrs: number[] = [];
  private readonly indexPtr: number;
  private readonly newIndexPtr: number;
  private readonly methodPtr: number;
  private readonly gcPtr: number;
  private nextHandle = 1;
  private nextClassId = 1;

  constructor(private readonly cm: LuaRaw) {
    this.indexPtr = cm.module.addFunction((state: number) => this.closureIndex(state), 'ii');
    this.newIndexPtr = cm.module.addFunction((state: number) => this.closureNewIndex(state), 'ii');
    this.methodPtr = cm.module.addFunction((state: number) => this.closureMethod(state), 'ii');
    this.gcPtr = cm.module.addFunction((state: number) => this.closureGc(state), 'ii');
    this.fnPtrs.push(this.indexPtr, this.newIndexPtr, this.methodPtr, this.gcPtr);
  }

  /** 注册一个类（同名只注册一次），返回类 id。 */
  registerClass(cls: BridgeClass): number {
    const existing = this.classIds.get(cls.name);
    if (existing !== undefined) return existing;
    const id = this.nextClassId++;
    this.classIds.set(cls.name, id);
    this.classes.set(id, cls);
    return id;
  }

  /**
   * 对象 → 句柄（同一个存活对象复用同一个句柄）。
   *
   * ## 为什么必须校验 `objects` 里还存在
   *
   * 句柄缓存用的是 `WeakMap<object, number>`，但**同一对象可能被多个 userdata 共用**——
   * 典型例子是 `getAddressList()`：它每次都返回**同一个** `LuaAddressList` 单例，
   * 于是所有拿到的 userdata 都写着同一个 handle。
   *
   * 只要其中**任意一个** userdata 被 Lua GC 回收，`__gc`（`closureGc`）就会执行
   * `objects.delete(handle)`。此时 `WeakMap` 里的缓存还在（宿主对象仍被强引用），
   * 但 `objects` 表里已经没有这个 handle 了。若 `handleOf` 无脑返回缓存值，
   * 新压栈的 userdata 就会指向一个空槽位，之后任何一次属性/方法访问都会得到
   * `readUserdata → found:false`，最终抛出误导性的
   * 「self 不是本引擎的对象（收到 userdata）」——而且是**永久性**的，
   * 该类对象从此再也不能用（`__gc` 删表是单向的，没有任何路径会把它加回来）。
   *
   * 因此这里必须同时检查「WeakMap 命中」**且**「objects 里确实还有这个 handle」，
   * 不一致就重新分配一个新句柄。
   */
  handleOf(obj: any): number {
    const cached = this.handleOfObject.get(obj);
    // 必须同时校验 `objects` 里确实还有这个 handle：WeakMap 的缓存不会随
    // `objects.delete` 一起失效，若无脑返回缓存值，新压栈的 userdata 会指向空槽位。
    if (cached !== undefined && this.objects.has(cached)) return cached;
    const h = this.nextHandle++;
    this.handleOfObject.set(obj, h);
    this.objects.set(h, obj);
    // 新句柄的引用数由 pushObject 紧接着 +1，这里先置 0
    this.handleRefs.set(h, 0);
    return h;
  }

  objectOf(handle: number): any {
    return this.objects.get(handle);
  }

  /* ---------------- MarshalObjectAccess ---------------- */

  /** 该索引是不是本桥的 userdata；是则返回宿主对象。 */
  readUserdata(m: LuaMarshal, index: number): { found: boolean; value?: unknown } {
    if (m.type(index) !== LUA_TUSERDATA) return { found: false };
    if (this.metatableRefs.size === 0) return { found: false };
    const abs = m.abs(index);
    if (m.cm.lua_getmetatable(m.state, abs) === 0) return { found: false };
    let matched = false;
    for (const ref of this.metatableRefs.values()) {
      m.cm.lua_rawgeti(m.state, LUA_REGISTRYINDEX, BigInt(ref));
      if (m.cm.lua_rawequal(m.state, -1, -2) !== 0) matched = true;
      m.pop(1);
      if (matched) break;
    }
    m.pop(1); // 真实元表
    if (!matched) return { found: false };
    const ptr = m.cm.lua_touserdata(m.state, abs);
    const handle = m.cm.module.getValue(ptr, 'i32');
    const obj = this.objects.get(handle);
    if (obj === undefined) return { found: false };
    return { found: true, value: obj };
  }

  /** 把宿主对象压栈成 userdata。 */
  pushObject(m: LuaMarshal, obj: ILuaBridgeObject): boolean {
    const cls = obj.luaClass;
    if (!cls) return false;
    this.registerClass(cls);
    // 顺序很重要：先压 userdata，再压元表，
    // 这样 lua_setmetatable(L, -2) 的 -2 才是 userdata（Lua 的约定是弹栈顶当元表）。
    const before = m.top();
    const handle = this.handleOf(obj);
    this.handleRefs.set(handle, (this.handleRefs.get(handle) ?? 0) + 1);
    const ptr = m.cm.lua_newuserdatauv(m.state, USERDATA_SIZE, 0);
    m.cm.module.setValue(ptr, handle, 'i32');
    this.pushMetatable(m, cls);
    m.cm.lua_setmetatable(m.state, -2);
    if (m.top() !== before + 1) {
      throw new Error(`内部错误：把 ${cls.name} 压栈后栈不平衡`);
    }
    return true;
  }

  /* ---------------- 元表 ---------------- */

  /** 把类的元表压栈（首次调用时创建并缓存到注册表）。 */
  private pushMetatable(m: LuaMarshal, cls: BridgeClass): void {
    const cached = this.metatableRefs.get(cls.name);
    if (cached !== undefined) {
      m.cm.lua_rawgeti(m.state, LUA_REGISTRYINDEX, BigInt(cached));
      return;
    }
    const classId = this.registerClass(cls);
    const base = m.top();
    m.cm.lua_createtable(m.state, 0, 6);
    const mt = m.top();

    // 1) 方法表：名字 → 原始 C 函数
    m.cm.lua_createtable(m.state, 0, Object.keys(cls.methods).length);
    const methodTable = m.top();
    for (const name of Object.keys(cls.methods)) {
      m.pushString(name);
      m.pushClosure(this.methodPtr, [BigInt(classId), name]);
      m.cm.lua_rawset(m.state, methodTable);
    }

    // 2) __index = C 闭包(classId, 方法表)
    m.pushInteger(BigInt(classId));
    m.cm.lua_pushvalue(m.state, methodTable);
    m.cm.lua_pushcclosure(m.state, this.indexPtr, 2);
    m.cm.lua_setfield(m.state, mt, '__index');

    // 3) __newindex = C 闭包(classId)
    m.pushInteger(BigInt(classId));
    m.cm.lua_pushcclosure(m.state, this.newIndexPtr, 1);
    m.cm.lua_setfield(m.state, mt, '__newindex');

    // 4) __gc（Lua 5.4 要求 setmetatable 之前元表里就有 __gc）
    m.pushInteger(BigInt(classId));
    m.cm.lua_pushcclosure(m.state, this.gcPtr, 1);
    m.cm.lua_setfield(m.state, mt, '__gc');

    m.pushString(cls.name);
    m.cm.lua_setfield(m.state, mt, '__name');
    // 与 CE 一样保护元表，避免脚本误改
    m.pushString('protected metatable');
    m.cm.lua_setfield(m.state, mt, '__metatable');

    // 此刻栈：[元表(mt) at mt, 方法表 at mt+1]。
    // luaL_ref 弹出的是**栈顶**，所以必须先把方法表弹掉，
    // 否则缓存到注册表里的会是方法表而不是元表（早期版本的踩坑点）。
    m.pop(1);
    if (m.top() !== mt) throw new Error('内部错误：元表不在栈顶');
    const newRef = m.cm.luaL_ref(m.state, LUA_REGISTRYINDEX);
    this.metatableRefs.set(cls.name, newRef);
    m.setTop(base);
    m.cm.lua_rawgeti(m.state, LUA_REGISTRYINDEX, BigInt(newRef));
  }

  /* ---------------- C 闭包实现 ---------------- */

  private header(state: number): LuaMarshal {
    return new LuaMarshal(this.cm, state, this);
  }

  private classFromUpvalue(m: LuaMarshal, upIndex: number): BridgeClass {
    const id = Number(m.toBigInt(m.cm.lua_upvalueindex(upIndex)));
    const cls = this.classes.get(id);
    if (!cls) m.raise('内部错误：找不到桥接类');
    return cls;
  }

  private objectAt(m: LuaMarshal, index: number, methodName: string): any {
    const got = this.readUserdata(m, index);
    if (!got.found) {
      m.raise(
        `调用 ${methodName} 时 self 不是本引擎的对象（收到 ${m.typeName(index)}）。` +
          `对象方法请用冒号调用，例如 obj:${methodName}(...)`,
      );
    }
    return got.value;
  }

  /** __index：先查方法表，再查属性 getter，最后查数字下标 / 附加字段。 */
  private closureIndex(state: number): number {
    const m: LuaMarshal = this.header(state);
    try {
      const cls = this.classFromUpvalue(m, 1);
      const key = m.read(2);

      // 方法表（rawget 避免递归触发 __index）
      m.cm.lua_pushvalue(m.state, 2);
      m.cm.lua_rawget(m.state, m.cm.lua_upvalueindex(2));
      if (!m.isNil(-1)) return 1;
      m.pop(1);

      const obj = this.objectAt(m, 1, String(key ?? '?'));

      if (typeof key === 'number' || typeof key === 'bigint') {
        if (cls.indexKey) {
          m.push(cls.indexKey(obj, Number(key)));
        } else {
          m.pushNil();
        }
        return 1;
      }

      const name = String(key);
      const prop = cls.properties[name];
      if (prop && prop.get) {
        m.push(prop.get(obj, m));
        return 1;
      }
      if (cls.extraIndex) {
        m.push(cls.extraIndex(obj, name));
        return 1;
      }
      const extra = this.extras.get(obj);
      if (extra && name in extra) {
        m.push(extra[name]);
        return 1;
      }
      m.pushNil();
      return 1;
    } catch (e) {
      if (isLuaLongjmp(e)) throw e;
      m.raise(`读取属性失败：${describeError(e)}`);
    }
  }

  /** __newindex：属性 setter / 数字下标 / 附加字段。 */
  private closureNewIndex(state: number): number {
    const m: LuaMarshal = this.header(state);
    try {
      const cls = this.classFromUpvalue(m, 1);
      const key = m.read(2);
      const value = m.read(3);
      const obj = this.objectAt(m, 1, String(key ?? '?'));

      if (typeof key === 'number' || typeof key === 'bigint') {
        if (!cls.newIndexKey) m.raise(`${cls.name} 不支持数字下标赋值`);
        cls.newIndexKey(obj, Number(key), value);
        return 0;
      }

      const name = String(key);
      const prop = cls.properties[name];
      if (prop && prop.set) {
        prop.set(obj, value, m);
        return 0;
      }
      if (prop && prop.get && !prop.set) {
        m.raise(`${cls.name}.${name} 是只读属性，不能赋值`);
      }
      if (cls.extraNewIndex) {
        cls.extraNewIndex(obj, name, value);
        return 0;
      }
      // 未声明的属性：存进附加字段
      let extra = this.extras.get(obj);
      if (!extra) {
        extra = {};
        this.extras.set(obj, extra);
      }
      extra[name] = value;
      return 0;
    } catch (e) {
      if (isLuaLongjmp(e)) throw e;
      m.raise(`写入属性失败：${describeError(e)}`);
    }
  }

  /** 方法分发：self 是参数 1，其余是方法参数。 */
  private closureMethod(state: number): number {
    const m: LuaMarshal = this.header(state);
    try {
      const cls = this.classFromUpvalue(m, 1);
      const name = m.toString(m.cm.lua_upvalueindex(2));
      const method = cls.methods[name];
      if (!method) m.raise(`${cls.name}.${name} 未实现`);
      const obj = this.objectAt(m, 1, name);
      const argc = m.top();
      const args: LuaValue[] = [];
      for (let i = 2; i <= argc; i++) args.push(m.read(i));
      const result = method(obj, args, m);
      return m.pushResult(result);
    } catch (e) {
      if (isLuaLongjmp(e)) throw e;
      m.raise(`调用对象方法失败：${describeError(e)}`);
    }
  }

  /**
   * `__gc`：某个 userdata 被 Lua GC 回收时调用。
   *
   * ## 这里**不能**无条件 `objects.delete(handle)`
   *
   * 同一个宿主对象会有**多个** userdata 指向它（`getAddressList()` 是全局单例，
   * 每调一次就多一个 userdata，但 handle 相同）。若某个 userdata 被回收就把
   * handle 从 `objects` 里摘掉，**其余仍然存活的 userdata 会全部悬垂**：
   * 它们读到的 handle 在表里查不到，`readUserdata` 返回 `found:false`，
   * 于是后续任何属性/方法访问都抛出误导性的
   * 「self 不是本引擎的对象（收到 userdata）」，而且是永久性的 ——
   * 没有任何路径会把条目加回 `objects`。
   *
   * 所以正确做法是**引用计数**：每次 `pushObject` 加一，这里减一，
   * 只有归零（即最后一个 userdata 也没了）才真正回收宿主对象。
   */
  private closureGc(state: number): number {
    const m: LuaMarshal = this.header(state);
    try {
      const cls = this.classFromUpvalue(m, 1);
      if (m.type(1) !== LUA_TUSERDATA) return 0;
      const ptr = m.cm.lua_touserdata(m.state, 1);
      const handle = m.cm.module.getValue(ptr, 'i32');
      const remaining = (this.handleRefs.get(handle) ?? 1) - 1;
      if (remaining > 0) {
        // 还有别的 userdata 指着它：只减计数，宿主对象必须留着
        this.handleRefs.set(handle, remaining);
        return 0;
      }
      this.handleRefs.delete(handle);
      const obj = this.objects.get(handle);
      if (obj !== undefined) {
        this.objects.delete(handle);
        if (cls.onGc) cls.onGc(obj);
      }
      return 0;
    } catch (e) {
      if (isLuaLongjmp(e)) throw e;
      return 0; // __gc 内不能再抛错
    }
  }

  /** 引擎销毁时释放 addFunction 注册的函数指针。 */
  dispose(): void {
    for (const p of this.fnPtrs) {
      try {
        this.cm.module.removeFunction(p);
      } catch {
        /* 忽略 */
      }
    }
    this.fnPtrs.length = 0;
    this.objects.clear();
    this.handleRefs.clear();
    this.metatableRefs.clear();
  }
}

/* ------------------------------------------------------------------ *
 * StringList —— 对齐 CE 的 TStrings Lua 绑定
 * ------------------------------------------------------------------ */

export class LuaStringList implements ILuaBridgeObject {
  readonly luaClass = STRING_LIST_CLASS;
  private items: string[] = [];
  private objects: number[] = [];
  private destroyed = false;

  constructor(initial: string[] = []) {
    this.items = initial.slice();
    this.objects = new Array(this.items.length).fill(0);
  }

  get count(): number {
    return this.items.length;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  toArray(): string[] {
    return this.items.slice();
  }

  add(s: string, data = 0): number {
    this.items.push(s);
    this.objects.push(data);
    return this.items.length - 1;
  }

  addText(text: string): void {
    for (const line of text.split(/\r?\n/)) this.add(line);
  }

  clear(): void {
    this.items = [];
    this.objects = [];
  }

  delete(index: number): void {
    if (index >= 0 && index < this.items.length) {
      this.items.splice(index, 1);
      this.objects.splice(index, 1);
    }
  }

  getString(index: number): string | null {
    return index >= 0 && index < this.items.length ? this.items[index] : null;
  }

  setString(index: number, value: string): void {
    if (index >= 0 && index < this.items.length) this.items[index] = value;
  }

  indexOf(value: string): number {
    return this.items.indexOf(value);
  }

  insert(index: number, value: string): void {
    const i = Math.max(0, Math.min(index, this.items.length));
    this.items.splice(i, 0, value);
    this.objects.splice(i, 0, 0);
  }

  remove(value: string): void {
    const i = this.items.indexOf(value);
    if (i !== -1) this.delete(i);
  }

  getText(): string {
    return this.items.join('\n');
  }

  setText(text: string): void {
    this.clear();
    this.addText(text);
  }

  getData(index: number): number {
    return this.objects[index] ?? 0;
  }

  setData(index: number, value: number): void {
    if (index >= 0 && index < this.items.length) this.objects[index] = value;
  }

  destroy(): void {
    this.clear();
    this.destroyed = true;
  }
}

export const STRING_LIST_CLASS: BridgeClass = {
  name: 'nceStringList',
  methods: {
    add(obj: LuaStringList, args, m) {
      const s = m.argToString(args, 1, 'StringList:add');
      const data = args[1] === undefined ? 0 : m.argToInt(args, 2, 'StringList:add', 0);
      return BigInt(obj.add(s, data));
    },
    addText(obj: LuaStringList, args, m) {
      obj.addText(m.argToString(args, 1, 'StringList:addText'));
    },
    clear(obj: LuaStringList) {
      obj.clear();
    },
    delete(obj: LuaStringList, args, m) {
      obj.delete(m.argToInt(args, 1, 'StringList:delete'));
    },
    getString(obj: LuaStringList, args, m) {
      return obj.getString(m.argToInt(args, 1, 'StringList:getString'));
    },
    setString(obj: LuaStringList, args, m) {
      obj.setString(
        m.argToInt(args, 1, 'StringList:setString'),
        m.argToString(args, 2, 'StringList:setString'),
      );
    },
    getCount(obj: LuaStringList) {
      return BigInt(obj.count);
    },
    indexOf(obj: LuaStringList, args, m) {
      return BigInt(obj.indexOf(m.argToString(args, 1, 'StringList:indexOf')));
    },
    insert(obj: LuaStringList, args, m) {
      obj.insert(
        m.argToInt(args, 1, 'StringList:insert'),
        m.argToString(args, 2, 'StringList:insert'),
      );
    },
    remove(obj: LuaStringList, args, m) {
      obj.remove(m.argToString(args, 1, 'StringList:remove'));
    },
    getText(obj: LuaStringList) {
      return obj.getText();
    },
    setText(obj: LuaStringList, args, m) {
      obj.setText(m.argToString(args, 1, 'StringList:setText'));
    },
    getData(obj: LuaStringList, args, m) {
      return BigInt(obj.getData(m.argToInt(args, 1, 'StringList:getData')));
    },
    setData(obj: LuaStringList, args, m) {
      obj.setData(m.argToInt(args, 1, 'StringList:setData'), m.argToInt(args, 2, 'StringList:setData'));
    },
    destroy(obj: LuaStringList) {
      obj.destroy();
    },
  },
  properties: {
    Count: { get: (obj: LuaStringList) => BigInt(obj.count) },
    Text: {
      get: (obj: LuaStringList) => obj.getText(),
      set: (obj: LuaStringList, v) => obj.setText(typeof v === 'string' ? v : String(v ?? '')),
    },
    Destroyed: { get: (obj: LuaStringList) => obj.isDestroyed },
  },
  // list[i] —— CE 的默认数组属性是 0 基
  indexKey: (obj: LuaStringList, key: number) => obj.getString(key),
  newIndexKey: (obj: LuaStringList, key: number, value: LuaValue) =>
    obj.setString(key, typeof value === 'string' ? value : String(value ?? '')),
};

/* ------------------------------------------------------------------ *
 * AddressList / MemoryRecord
 * ------------------------------------------------------------------ */

/** MemoryRecord 需要的宿主能力，由 api 层注入。 */
export interface RecordHost {
  resolve(expr: string): bigint;
  read(addr: bigint, size: number): Buffer;
  write(addr: bigint, data: Buffer): number;
}

export class LuaMemoryRecord implements ILuaBridgeObject {
  readonly luaClass = MEMORY_RECORD_CLASS;
  address: string;
  description: string;
  type: VariableType;
  active = true;
  selected = false;
  readonly id: number;
  private cachedValue = '';
  private deleted = false;
  private readonly host: RecordHost;

  constructor(host: RecordHost, address: string, description: string, type: VariableType, id: number) {
    this.host = host;
    this.address = address;
    this.description = description;
    this.type = type;
    this.id = id;
  }

  /** 解析出当前真实地址（对齐 CE 的 GetRealAddress）。 */
  currentAddress(): bigint {
    return this.host.resolve(this.address);
  }

  private width(): number {
    switch (this.type) {
      case VariableType.String:
        return ANSI_STRING_LENGTH;
      case VariableType.UnicodeString:
        return WIDE_STRING_LENGTH * 2;
      default:
        return variableWidth(this.type) || 4;
    }
  }

  /** 读值并格式化成字符串（CE 的 MemoryRecord.Value 就是字符串）。 */
  readValueString(): string {
    if (!this.active) return this.cachedValue;
    try {
      const raw = this.host.read(this.currentAddress(), this.width());
      const text = formatRecordValue(raw, this.type);
      this.cachedValue = text;
      return text;
    } catch {
      return '';
    }
  }

  /** 写值（对齐 CE：setValue 会真的写进目标内存）。 */
  writeValueString(value: string): void {
    this.cachedValue = value;
    if (!this.active) return;
    this.host.write(this.currentAddress(), encodeRecordValue(value, this.type));
  }

  numericalValue(): number | bigint | null {
    if (!this.active) {
      const parsed = Number(this.cachedValue);
      return Number.isNaN(parsed) ? null : parsed;
    }
    try {
      return readNumerical(this.host.read(this.currentAddress(), this.width()), this.type);
    } catch {
      return null;
    }
  }

  setNumericalValue(value: number | bigint): void {
    this.writeValueString(String(value));
  }

  markDeleted(): void {
    this.deleted = true;
  }

  get isDeleted(): boolean {
    return this.deleted;
  }
}

/** 把读到的原始字节格式化成 CE 风格的字符串。 */
export function formatRecordValue(raw: Buffer, type: VariableType): string {
  switch (type) {
    case VariableType.Byte:
      return String(raw.readUInt8(0));
    case VariableType.Word:
      return String(raw.readUInt16LE(0));
    case VariableType.DWord:
      return String(raw.readUInt32LE(0));
    case VariableType.QWord:
    case VariableType.Pointer:
      return raw.readBigUInt64LE(0).toString();
    case VariableType.Single:
      return String(raw.readFloatLE(0));
    case VariableType.Double:
      return String(raw.readDoubleLE(0));
    case VariableType.String:
    case VariableType.CodePageString: {
      const end = raw.indexOf(0);
      return raw.toString('latin1', 0, end === -1 ? raw.length : end);
    }
    case VariableType.UnicodeString: {
      let end = raw.length;
      for (let i = 0; i + 1 < raw.length; i += 2) {
        if (raw.readUInt16LE(i) === 0) {
          end = i;
          break;
        }
      }
      return raw.toString('utf16le', 0, end);
    }
    default: {
      const parts: string[] = [];
      for (const b of raw.subarray(0, 16)) parts.push(b.toString(16).toUpperCase().padStart(2, '0'));
      return parts.join(' ');
    }
  }
}

/** 把 CE 风格的字符串编码成要写入的字节。 */
export function encodeRecordValue(value: string, type: VariableType): Buffer {
  const text = value.trim();
  switch (type) {
    case VariableType.Byte: {
      const buf = Buffer.alloc(1);
      buf.writeUInt8(Number(parseIntLiteral(text) & 0xffn), 0);
      return buf;
    }
    case VariableType.Word: {
      const buf = Buffer.alloc(2);
      buf.writeUInt16LE(Number(parseIntLiteral(text) & 0xffffn), 0);
      return buf;
    }
    case VariableType.DWord: {
      const buf = Buffer.alloc(4);
      buf.writeUInt32LE(Number(parseIntLiteral(text) & 0xffffffffn), 0);
      return buf;
    }
    case VariableType.QWord:
    case VariableType.Pointer: {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(BigInt.asUintN(64, parseIntLiteral(text)), 0);
      return buf;
    }
    case VariableType.Single: {
      const buf = Buffer.alloc(4);
      buf.writeFloatLE(Number(text), 0);
      return buf;
    }
    case VariableType.Double: {
      const buf = Buffer.alloc(8);
      buf.writeDoubleLE(Number(text), 0);
      return buf;
    }
    case VariableType.String:
    case VariableType.CodePageString:
      return Buffer.from(value, 'latin1');
    case VariableType.UnicodeString:
      return Buffer.from(value, 'utf16le');
    default: {
      const hex = text.replace(/[^0-9a-fA-F]/g, '');
      const out: number[] = [];
      for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
      return Buffer.from(out);
    }
  }
}

/** 解析 CE 风格的整数字面量（十进制 / 0x / $ 前缀 / 纯十六进制）。 */
function parseIntLiteral(text: string): bigint {
  const s = text.trim();
  try {
    if (/^\$/.test(s)) return BigInt('0x' + s.slice(1));
    if (/^0x/i.test(s)) return BigInt(s);
    if (/^-?\d+$/.test(s)) return BigInt(s);
    return BigInt('0x' + s);
  } catch {
    return 0n;
  }
}

function readNumerical(raw: Buffer, type: VariableType): number | bigint {
  switch (type) {
    case VariableType.Byte:
      return raw.readUInt8(0);
    case VariableType.Word:
      return raw.readUInt16LE(0);
    case VariableType.DWord:
      return raw.readUInt32LE(0);
    case VariableType.QWord:
    case VariableType.Pointer: {
      const v = raw.readBigUInt64LE(0);
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    case VariableType.Single:
      return raw.readFloatLE(0);
    case VariableType.Double:
      return raw.readDoubleLE(0);
    default:
      return 0;
  }
}

export class LuaAddressList implements ILuaBridgeObject {
  readonly luaClass = ADDRESS_LIST_CLASS;
  private readonly records: LuaMemoryRecord[] = [];
  private selected: LuaMemoryRecord | null = null;
  private nextId = 1;
  private readonly host: RecordHost;

  constructor(host: RecordHost) {
    this.host = host;
  }

  get count(): number {
    return this.records.length;
  }

  createMemoryRecord(
    address = '',
    description = '',
    type: VariableType = VariableType.DWord,
  ): LuaMemoryRecord {
    const rec = new LuaMemoryRecord(this.host, address, description, type, this.nextId++);
    this.records.push(rec);
    return rec;
  }

  getMemoryRecord(index: number): LuaMemoryRecord | null {
    return index >= 0 && index < this.records.length ? this.records[index] : null;
  }

  getMemoryRecordByDescription(description: string): LuaMemoryRecord | null {
    return this.records.find((r) => r.description === description) ?? null;
  }

  getMemoryRecordByID(id: number): LuaMemoryRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  select(rec: LuaMemoryRecord | null): void {
    if (this.selected) this.selected.selected = false;
    this.selected = rec;
    if (rec) rec.selected = true;
  }

  get selectedRecord(): LuaMemoryRecord | null {
    return this.selected;
  }

  remove(rec: LuaMemoryRecord): void {
    const i = this.records.indexOf(rec);
    if (i !== -1) this.records.splice(i, 1);
    if (this.selected === rec) this.selected = null;
    rec.markDeleted();
  }
}

export const ADDRESS_LIST_CLASS: BridgeClass = {
  name: 'nceAddressList',
  methods: {
    getCount(obj: LuaAddressList) {
      return BigInt(obj.count);
    },
    getMemoryRecord(obj: LuaAddressList, args, m) {
      return obj.getMemoryRecord(m.argToInt(args, 1, 'AddressList:getMemoryRecord'));
    },
    getMemoryRecordByDescription(obj: LuaAddressList, args, m) {
      return obj.getMemoryRecordByDescription(
        m.argToString(args, 1, 'AddressList:getMemoryRecordByDescription'),
      );
    },
    getMemoryRecordByID(obj: LuaAddressList, args, m) {
      return obj.getMemoryRecordByID(m.argToInt(args, 1, 'AddressList:getMemoryRecordByID'));
    },
    createMemoryRecord(obj: LuaAddressList, args, m) {
      const address = args[0] === undefined ? '' : m.argToString(args, 1, 'AddressList:createMemoryRecord');
      const description =
        args[1] === undefined ? '' : m.argToString(args, 2, 'AddressList:createMemoryRecord');
      const type =
        args[2] === undefined
          ? VariableType.DWord
          : parseVariableType(m, args[2], 'AddressList:createMemoryRecord');
      return obj.createMemoryRecord(address, description, type);
    },
    getSelectedRecord(obj: LuaAddressList) {
      return obj.selectedRecord;
    },
    setSelectedRecord(obj: LuaAddressList, args) {
      obj.select((args[0] as LuaMemoryRecord | null) ?? null);
    },
    delete(obj: LuaAddressList, args) {
      const rec = args[0];
      if (rec) obj.remove(rec as LuaMemoryRecord);
    },
  },
  properties: {
    Count: { get: (obj: LuaAddressList) => BigInt(obj.count) },
    SelectedRecord: {
      get: (obj: LuaAddressList) => obj.selectedRecord,
      set: (obj: LuaAddressList, v) => obj.select((v as LuaMemoryRecord | null) ?? null),
    },
  },
  // addresslist[0] → getMemoryRecord(0)（CE 的默认数组属性）
  indexKey: (obj: LuaAddressList, key: number) => obj.getMemoryRecord(key),
};

export const MEMORY_RECORD_CLASS: BridgeClass = {
  name: 'nceMemoryRecord',
  methods: {
    getAddress(obj: LuaMemoryRecord) {
      return obj.address;
    },
    setAddress(obj: LuaMemoryRecord, args, m) {
      const v = m.requireArg(args, 1, 'MemoryRecord:setAddress');
      obj.address =
        typeof v === 'number' || typeof v === 'bigint'
          ? '0x' + BigInt(v).toString(16)
          : String(v);
    },
    getCurrentAddress(obj: LuaMemoryRecord) {
      try {
        return obj.currentAddress();
      } catch {
        return null;
      }
    },
    getDescription(obj: LuaMemoryRecord) {
      return obj.description;
    },
    setDescription(obj: LuaMemoryRecord, args, m) {
      obj.description = m.argToString(args, 1, 'MemoryRecord:setDescription');
    },
    getType(obj: LuaMemoryRecord) {
      return BigInt(obj.type);
    },
    setType(obj: LuaMemoryRecord, args, m) {
      obj.type = parseVariableType(m, m.requireArg(args, 1, 'MemoryRecord:setType'), 'MemoryRecord:setType');
    },
    getValue(obj: LuaMemoryRecord) {
      return obj.readValueString();
    },
    setValue(obj: LuaMemoryRecord, args, m) {
      const v = m.requireArg(args, 1, 'MemoryRecord:setValue');
      obj.writeValueString(typeof v === 'string' ? v : String(v));
    },
    getNumericalValue(obj: LuaMemoryRecord) {
      return obj.numericalValue();
    },
    setNumericalValue(obj: LuaMemoryRecord, args, m) {
      obj.setNumericalValue(m.argToNumber(args, 1, 'MemoryRecord:setNumericalValue'));
    },
    getActive(obj: LuaMemoryRecord) {
      return obj.active;
    },
    setActive(obj: LuaMemoryRecord, args) {
      obj.active = args[0] !== false && args[0] !== null && args[0] !== undefined;
    },
    getID(obj: LuaMemoryRecord) {
      return BigInt(obj.id);
    },
    delete(obj: LuaMemoryRecord) {
      obj.markDeleted();
    },
    isSelected(obj: LuaMemoryRecord) {
      return obj.selected;
    },
  },
  properties: {
    Address: {
      get: (obj: LuaMemoryRecord) => obj.address,
      set: (obj: LuaMemoryRecord, v) =>
        (obj.address = typeof v === 'number' || typeof v === 'bigint' ? '0x' + BigInt(v).toString(16) : String(v ?? '')),
    },
    CurrentAddress: {
      get: (obj: LuaMemoryRecord) => {
        try {
          return obj.currentAddress();
        } catch {
          return null;
        }
      },
    },
    Description: {
      get: (obj: LuaMemoryRecord) => obj.description,
      set: (obj: LuaMemoryRecord, v) => {
        obj.description = String(v ?? '');
      },
    },
    Type: {
      get: (obj: LuaMemoryRecord) => BigInt(obj.type),
      set: (obj: LuaMemoryRecord, v, m) => {
        obj.type = parseVariableType(m, v, 'MemoryRecord.Type');
      },
    },
    Value: {
      get: (obj: LuaMemoryRecord) => obj.readValueString(),
      set: (obj: LuaMemoryRecord, v) => obj.writeValueString(typeof v === 'string' ? v : String(v ?? '')),
    },
    NumericalValue: {
      get: (obj: LuaMemoryRecord) => obj.numericalValue(),
      set: (obj: LuaMemoryRecord, v) =>
        obj.setNumericalValue(typeof v === 'number' || typeof v === 'bigint' ? v : Number(v ?? 0)),
    },
    Active: {
      get: (obj: LuaMemoryRecord) => obj.active,
      set: (obj: LuaMemoryRecord, v) => {
        obj.active = v !== false && v !== null && v !== undefined;
      },
    },
    ID: { get: (obj: LuaMemoryRecord) => BigInt(obj.id) },
    Selected: { get: (obj: LuaMemoryRecord) => obj.selected },
  },
};

/* ------------------------------------------------------------------ *
 * ScanSession
 * ------------------------------------------------------------------ */

export class LuaScanSession implements ILuaBridgeObject {
  readonly luaClass = SCAN_SESSION_CLASS;
  private readonly session: ScanSession;
  private readonly proc: Process;
  private destroyed = false;

  constructor(
    proc: Process,
    facade: ScannerFacade,
    options: { parallel?: boolean; maxSnapshotBytes?: number; blockSize?: number; parallelMinBytes?: number } = {},
  ) {
    this.proc = proc;
    this.session = facade.createSession(proc, options) as ScanSession;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('扫描会话已销毁（destroy）');
  }

  firstScan(cfg: ScanConfig): number {
    this.assertAlive();
    return this.session.firstScan(cfg).resultCount;
  }

  nextScan(cfg: ScanConfig): number {
    this.assertAlive();
    return this.session.nextScan(cfg).resultCount;
  }

  get count(): number {
    return this.session.resultCount;
  }

  result(index: number): bigint | null {
    const all = this.session.results;
    return index >= 0 && index < all.length ? all[index] : null;
  }

  all(): bigint[] {
    return this.session.results.slice() as bigint[];
  }

  /** 读取当前结果的值（按类型）。 */
  values(type: VariableType, max = 4096): Array<number | bigint> {
    this.assertAlive();
    const width = variableWidth(type) || 4;
    const out: Array<number | bigint> = [];
    const all = this.session.results;
    for (const addr of all) {
      if (out.length >= max) break;
      const buf = this.proc.readMemory(addr, width);
      if (buf.length < width) continue;
      out.push(readNumerical(buf, type));
    }
    return out;
  }

  reset(): void {
    this.session.reset();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.session.dispose();
  }

  get stats(): unknown {
    return this.session.stats;
  }

  get processId(): number {
    return this.proc.pid;
  }

  get hasSnapshot(): boolean {
    return this.session.stats?.hasSnapshot ?? false;
  }
}

export const SCAN_SESSION_CLASS: BridgeClass = {
  name: 'nceScanSession',
  methods: {
    firstScan(obj: LuaScanSession, args, m) {
      const cfg = parseScanConfig(m, m.requireArg(args, 1, 'ScanSession:firstScan'), 'ScanSession:firstScan');
      return BigInt(obj.firstScan(cfg));
    },
    nextScan(obj: LuaScanSession, args, m) {
      const cfg = parseScanConfig(m, m.requireArg(args, 1, 'ScanSession:nextScan'), 'ScanSession:nextScan');
      return BigInt(obj.nextScan(cfg));
    },
    getCount(obj: LuaScanSession) {
      return BigInt(obj.count);
    },
    getResult(obj: LuaScanSession, args, m) {
      return obj.result(m.argToInt(args, 1, 'ScanSession:getResult'));
    },
    getResults(obj: LuaScanSession) {
      return obj.all();
    },
    getValues(obj: LuaScanSession, args, m) {
      const type = parseVariableType(m, m.requireArg(args, 1, 'ScanSession:getValues'), 'ScanSession:getValues');
      const max = args[1] === undefined ? 4096 : m.argToInt(args, 2, 'ScanSession:getValues');
      return obj.values(type, max);
    },
    getStats(obj: LuaScanSession) {
      const stats = obj.stats as Record<string, unknown> | null;
      if (!stats) return null;
      return {
        regionsScanned: Number(stats.regionsScanned),
        bytesScanned: stats.bytesScanned as bigint,
        elapsedMs: Number(stats.elapsedMs),
        resultCount: Number(stats.resultCount),
        hasSnapshot: Boolean(stats.hasSnapshot),
        workersUsed: Number(stats.workersUsed),
      };
    },
    reset(obj: LuaScanSession) {
      obj.reset();
    },
    destroy(obj: LuaScanSession) {
      obj.destroy();
    },
  },
  properties: {
    Count: { get: (obj: LuaScanSession) => BigInt(obj.count) },
    ProcessID: { get: (obj: LuaScanSession) => BigInt(obj.processId) },
    HasSnapshot: { get: (obj: LuaScanSession) => obj.hasSnapshot },
  },
  indexKey: (obj: LuaScanSession, key: number) => obj.result(key),
};

/** 注册全部内置类。 */
export function registerBuiltinClasses(bridge: LuaObjectBridge): void {
  bridge.registerClass(STRING_LIST_CLASS);
  bridge.registerClass(ADDRESS_LIST_CLASS);
  bridge.registerClass(MEMORY_RECORD_CLASS);
  bridge.registerClass(SCAN_SESSION_CLASS);
}
