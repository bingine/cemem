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
import { LuaMarshal, type LuaRaw } from './marshal';
import type { BridgeClass, ILuaBridgeObject, ScannerFacade } from './types';
export declare class LuaObjectBridge {
    private readonly cm;
    private readonly objects;
    /**
     * 每个句柄当前有多少个**活的 userdata** 指向它。
     *
     * 只有当计数归零时才能真正从 `objects` 里摘除宿主对象 ——
     * 详见 `closureGc` 与 `handleOf` 的注释。
     */
    private readonly handleRefs;
    private readonly handleOfObject;
    private readonly classes;
    private readonly classIds;
    private readonly metatableRefs;
    /** 未声明 setter 的属性写入会落到这里（脚本可以往对象上挂自己的字段） */
    private readonly extras;
    private readonly fnPtrs;
    private readonly indexPtr;
    private readonly newIndexPtr;
    private readonly methodPtr;
    private readonly gcPtr;
    private nextHandle;
    private nextClassId;
    constructor(cm: LuaRaw);
    /** 注册一个类（同名只注册一次），返回类 id。 */
    registerClass(cls: BridgeClass): number;
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
    handleOf(obj: any): number;
    objectOf(handle: number): any;
    /** 该索引是不是本桥的 userdata；是则返回宿主对象。 */
    readUserdata(m: LuaMarshal, index: number): {
        found: boolean;
        value?: unknown;
    };
    /** 把宿主对象压栈成 userdata。 */
    pushObject(m: LuaMarshal, obj: ILuaBridgeObject): boolean;
    /** 把类的元表压栈（首次调用时创建并缓存到注册表）。 */
    private pushMetatable;
    private header;
    private classFromUpvalue;
    private objectAt;
    /** __index：先查方法表，再查属性 getter，最后查数字下标 / 附加字段。 */
    private closureIndex;
    /** __newindex：属性 setter / 数字下标 / 附加字段。 */
    private closureNewIndex;
    /** 方法分发：self 是参数 1，其余是方法参数。 */
    private closureMethod;
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
    private closureGc;
    /** 引擎销毁时释放 addFunction 注册的函数指针。 */
    dispose(): void;
}
export declare class LuaStringList implements ILuaBridgeObject {
    readonly luaClass: BridgeClass;
    private items;
    private objects;
    private destroyed;
    constructor(initial?: string[]);
    get count(): number;
    get isDestroyed(): boolean;
    toArray(): string[];
    add(s: string, data?: number): number;
    addText(text: string): void;
    clear(): void;
    delete(index: number): void;
    getString(index: number): string | null;
    setString(index: number, value: string): void;
    indexOf(value: string): number;
    insert(index: number, value: string): void;
    remove(value: string): void;
    getText(): string;
    setText(text: string): void;
    getData(index: number): number;
    setData(index: number, value: number): void;
    destroy(): void;
}
export declare const STRING_LIST_CLASS: BridgeClass;
/** MemoryRecord 需要的宿主能力，由 api 层注入。 */
export interface RecordHost {
    resolve(expr: string): bigint;
    read(addr: bigint, size: number): Buffer;
    write(addr: bigint, data: Buffer): number;
}
export declare class LuaMemoryRecord implements ILuaBridgeObject {
    readonly luaClass: BridgeClass;
    address: string;
    description: string;
    type: VariableType;
    active: boolean;
    selected: boolean;
    readonly id: number;
    private cachedValue;
    private deleted;
    private readonly host;
    constructor(host: RecordHost, address: string, description: string, type: VariableType, id: number);
    /** 解析出当前真实地址（对齐 CE 的 GetRealAddress）。 */
    currentAddress(): bigint;
    private width;
    /** 读值并格式化成字符串（CE 的 MemoryRecord.Value 就是字符串）。 */
    readValueString(): string;
    /** 写值（对齐 CE：setValue 会真的写进目标内存）。 */
    writeValueString(value: string): void;
    numericalValue(): number | bigint | null;
    setNumericalValue(value: number | bigint): void;
    markDeleted(): void;
    get isDeleted(): boolean;
}
/** 把读到的原始字节格式化成 CE 风格的字符串。 */
export declare function formatRecordValue(raw: Buffer, type: VariableType): string;
/** 把 CE 风格的字符串编码成要写入的字节。 */
export declare function encodeRecordValue(value: string, type: VariableType): Buffer;
export declare class LuaAddressList implements ILuaBridgeObject {
    readonly luaClass: BridgeClass;
    private readonly records;
    private selected;
    private nextId;
    private readonly host;
    constructor(host: RecordHost);
    get count(): number;
    createMemoryRecord(address?: string, description?: string, type?: VariableType): LuaMemoryRecord;
    getMemoryRecord(index: number): LuaMemoryRecord | null;
    getMemoryRecordByDescription(description: string): LuaMemoryRecord | null;
    getMemoryRecordByID(id: number): LuaMemoryRecord | null;
    select(rec: LuaMemoryRecord | null): void;
    get selectedRecord(): LuaMemoryRecord | null;
    remove(rec: LuaMemoryRecord): void;
}
export declare const ADDRESS_LIST_CLASS: BridgeClass;
export declare const MEMORY_RECORD_CLASS: BridgeClass;
export declare class LuaScanSession implements ILuaBridgeObject {
    readonly luaClass: BridgeClass;
    private readonly session;
    private readonly proc;
    private destroyed;
    constructor(proc: Process, facade: ScannerFacade, options?: {
        parallel?: boolean;
        maxSnapshotBytes?: number;
        blockSize?: number;
        parallelMinBytes?: number;
    });
    private assertAlive;
    firstScan(cfg: ScanConfig): number;
    nextScan(cfg: ScanConfig): number;
    get count(): number;
    result(index: number): bigint | null;
    all(): bigint[];
    /** 读取当前结果的值（按类型）。 */
    values(type: VariableType, max?: number): Array<number | bigint>;
    reset(): void;
    destroy(): void;
    get stats(): unknown;
    get processId(): number;
    get hasSnapshot(): boolean;
}
export declare const SCAN_SESSION_CLASS: BridgeClass;
/** 注册全部内置类。 */
export declare function registerBuiltinClasses(bridge: LuaObjectBridge): void;
//# sourceMappingURL=objects.d.ts.map