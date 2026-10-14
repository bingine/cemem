/**
 * 地址表与内存记录 —— 对齐 Cheat Engine `MemoryRecordUnit.pas` / `addresslist.pas`。
 *
 * CE 的地址表（Cheat Table）是一棵树 + 一组带类型的条目：
 *   - 每个条目有：描述、地址表达式、变量类型、当前值、偏移链、是否锁定（frozen）
 *   - 条目可以互相引用（`Address` 写 `+8` 表示"上一项的地址 +8"），
 *     也可以引用其它条目的描述作为基址
 *   - "锁定"条目会由后台定时器不断写回固定值（CE 的 freeze）
 *
 * 本模块提供纯数据模型 + 求值 + 读写，定时锁定由宿主调用 `tickFrozen()` 驱动
 * （不在这里起定时器，避免与宿主的生命周期纠缠）。
 */
import { EvalContext } from '../addr/expression';
import { Process } from '../win/process';
import type { RootExtraElement } from '../cheattable/ct-format';
import { RoundingType, ScanOption, VariableType } from '../types';
/** 一个地址表条目 */
export interface MemoryRecordData {
    /** 稳定 id（保存/加载表时用来还原引用关系） */
    id: number;
    description: string;
    /** 地址表达式，例如 `"game.exe"+12AB34`、`[[base]+10]+8`、`+8`（相对上级） */
    address: string;
    variableType: VariableType;
    /** 写入用的值（字符串形式，便于精确保留用户输入） */
    value?: string;
    /** 指针偏移链（CE 表里 <Offsets> 的等价物）；给出时 address 视为基址表达式 */
    offsets?: number[];
    /**
     * 解析不出**十六进制数**的 `<Offset>` 原文（下标 → 已按 .CT 语义规范化的表达式）。
     *
     * CE 允许偏移写成符号/表达式（`<Offset>mySym</Offset>`）——
     * `TMemrecOffset.setOffsetText`（`MemoryRecordUnit.pas:631-696`）会依次尝试
     * 十六进制解析、`getAddressFromNameShallow`（符号）、Lua、`getAddressFromName`。
     * 这种位置在 `offsets` 里放 0 占位，**链长一级都不少**（CE 的 `GetRealAddress`
     * `:3683-3691` 在偏移无效时把整条标成 `UnreadablePointer`，也不会缩短链），
     * 真正的值在求值时才解析；解析不出来就**如实报错**。
     */
    offsetExpressions?: Record<number, string>;
    /** 是否锁定（持续写回 value） */
    frozen?: boolean;
    /** 是否启用（未启用的条目不求值也不显示） */
    active?: boolean;
    /** 备注/注释 */
    comment?: string;
    /** 是否按十六进制显示 */
    hexadecimal?: boolean;
    /** 布尔显示（CE 的 "Show as binary"） */
    binary?: boolean;
    /** 显示用的字符编码（字符串类型） */
    codePage?: number;
    /** 字符串长度（字符数） */
    stringLength?: number;
    /**
     * 解析地址失败时是否忽略该条目（CE 表里常见 "address failed" 的容错）。
     * 默认 true：求值失败时不抛错，返回 null。
     */
    tolerant?: boolean;
    /** 子条目（CE 的树形结构） */
    children?: MemoryRecordData[];
    /** 来源文件（表里的 <FileOffset> 之类，保留原字段以便往返不丢信息） */
    extra?: Record<string, string>;
}
/** 求值结果 */
export interface RecordEvaluation {
    /** 最终地址（解引用、加偏移之后） */
    address: bigint | null;
    /** 求值失败原因 */
    error?: string;
}
/**
 * 归一化 CE 风格的带引号地址。
 *
 * 关键语义区分（早期实现搞错了，会破坏模块相对地址）：
 *   - `"生命值"` —— 引号是**外层包裹**，内容才是真正的地址表达式；要剥掉引号。
 *   - `"node.exe"+0` —— 引号是**表达式内部的模块名定界符**，是地址的一部分；
 *     绝不能剥掉，否则表达式变成 `node.exe"+0` 直接解析失败。
 *
 * 另外 CE 里还有 `"a"+"b"` 这种拼接，所以剥引号前要求"去掉首尾后内部不再有引号"。
 */
export declare function normalizeAddressExpression(s: string): string;
/**
 * 一个内存记录（运行时对象）。对应 CE 的 TMemoryRecord。
 */
export declare class MemoryRecord {
    private readonly list;
    readonly id: number;
    description: string;
    /** 地址表达式（内部始终保存去引号形式） */
    address: string;
    variableType: VariableType;
    offsets: number[];
    /** 见 `MemoryRecordData.offsetExpressions`（下标 → 符号/表达式偏移） */
    offsetExpressions: Map<number, string>;
    frozen: boolean;
    active: boolean;
    comment: string;
    hexadecimal: boolean;
    binary: boolean;
    codePage: number;
    stringLength: number;
    tolerant: boolean;
    children: MemoryRecord[];
    parent: MemoryRecord | null;
    extra: Record<string, string>;
    /** 用户设定的值（字符串） */
    private userValue;
    /** 最近一次解析出的地址 */
    private cachedAddress;
    /** 最近一次读取到的原始字节 */
    private cachedBytes;
    /** 最近一次错误 */
    private lastError;
    private readonly compiled;
    constructor(data: MemoryRecordData, list: AddressList);
    /** 编译期语法错误（null 表示语法正确） */
    get parseError(): Error | null;
    /** 本记录占用的字节数；变长类型返回显式长度或 0 */
    get byteWidth(): number;
    /**
     * 本条目是否是"**相对父条目**"的地址。
     *
     * CE 的判据是地址文本第一个字符是 `+` 或 `-` **且**有父条目
     * （`MemoryRecordUnit.pas:2833` `parseAddressString`、
     *   `:3650` `getBaseAddress`、`:2864` `fIsOffset`），地址表里的树形子项用它表示
     * "父条目的地址再加上一个偏移"。
     */
    get isOffset(): boolean;
    /**
     * 相对地址要挂在哪个祖先上。
     *
     * 逐字对齐 CE(`MemoryRecordUnit.pas:3652-3653`)：
     * ```pascal
     *   parentMR:=parent;
     *   while ((parentMR.interpretableaddress='') or (parentMR.interpretableaddress='0'))
     *     and parentMR.hasParent do parentMR:=parentMR.parent;  // 找第一个有真地址的祖先
     * ```
     * 也就是**跳过**那些地址为空或正好是 `0` 的祖先；一个都没找到时返回 null，
     * CE 在这种情况下的行为是"不加父地址"（退化成绝对地址），本实现保持一致。
     */
    relativeAnchor(): MemoryRecord | null;
    /**
     * 解析最终地址（缓存到下次 invalidate）。
     *
     * 容错语义（重要）：
     *   - `tolerant` 只针对**基址表达式**（例如引用了当前进程里不存在的模块名）——
     *     这种失败在加载别人的表时很常见，返回 null 让调用方跳过即可。
     *   - **偏移链解引用失败必须抛错**：链断了意味着地址是错的，
     *     如果也静默返回 null/原地址，就会得到一个"看起来对其实错"的地址，
     *     进而写坏目标进程的内存。CE 在偏移链失败时同样不会给出地址。
     *
     * 相对地址（`+18` / `-8`）：
     *   `地址 = 最近的有地址的祖先的最终地址 + 本条目表达式的值`，
     *   与 CE 的 `getBaseAddress`/`parseAddressString` 完全一致。
     *   早先这里**完全不看 parent** —— 文件头注释声称支持，实现却没有：
     *   于是 `<Address>+18</Address>` 被解析成**绝对地址 0x12**（十进制 18），
     *   而且 `error` 是空的（静默给出错误地址）。
     *   ⚠️ 祖先的地址是它**应用完自己的偏移链之后**的最终地址（CE 的 `RealAddress`），
     *   所以这里递归调用 `anchor.resolve()`，并沿用同一套容错语义。
     */
    resolve(): RecordEvaluation;
    /** 最近一次解析结果（不重新求值） */
    get resolvedAddress(): bigint | null;
    /** 最近一次错误 */
    get error(): string | null;
    /** 强制下次 resolve 重新求值 */
    invalidate(): void;
    /** 读取当前值（返回字符串形式，便于显示） */
    read(): string | null;
    /** 把原始字节格式化成显示字符串 */
    formatBytes(buf: Buffer): string;
    private formatInt;
    /** 读取原始值（数值类型返回 number | bigint；字符串返回 string） */
    readValue(): number | bigint | string | null;
    /** 写入值（字符串形式，按变量类型解析）。返回是否成功。 */
    write(value?: string): boolean;
    /** 把字符串值编码成对应类型的字节 */
    encodeValue(v: string): Buffer | null;
    private intBuffer;
    /** 用户设定的值 */
    get value(): string;
    set value(v: string);
    /** 是否锁定且在本次 tick 中成功写回 */
    tickFrozen(): boolean;
    /** 转回纯数据（用于保存）。地址已在内部归一化为去引号形式。 */
    toData(): MemoryRecordData;
}
/**
 * 地址表 —— 对齐 CE 的 TAddressList + 表级设置。
 */
export declare class AddressList {
    private records;
    private nextId;
    private processRef;
    /** 已注册符号（供地址表达式引用） */
    readonly symbols: Map<string, bigint>;
    /**
     * 符号的**原始地址文本**（.CT 里写的是什么就保留什么）。
     *
     * 用途只有一个：`saveCheatTable` 时把用户当初写的形态原样写回去。
     * CE 只保存用户输入的 `addressstring`（`symbolhandler.pas:3714`），
     * 而模块相对形式（`game.exe+10`）一旦被换算成绝对地址写出去，
     * 对方进程重启后就**全部失效** —— 所以不能只留 `symbols` 里的 bigint。
     */
    readonly symbolSources: Map<string, string>;
    /** 模块列表缓存；为 null 时按需重新枚举 */
    private moduleCache;
    /** 表级注释 */
    comment: string;
    /**
     * 表版本（CE 的 `<CheatTable CheatEngineTableVersion>` 属性）。
     *
     * 默认 **45** —— 与参照源码一致（`OpenSave.pas:24` `_CurrentTableVersion=45`，
     * `:1218` CE 自己写出时用的就是它）。新建（未载入过）的表 save 时写 45，
     * 载入过的表由 `loadCheatTable` 覆盖成**载入时的版本**并原样写回。
     */
    version: number;
    /**
     * 根级其它属性（`CheatEngineTableVersion` 之外的全部原样保留）。
     * 见 `saveCheatTable`：不保留就是**静默丢用户数据**。
     */
    rootAttributes: Record<string, string>;
    /** 根级未建模元素（`<Structures>` / `<LuaScript>` / …），原样保留、原样写回 */
    rootExtra: RootExtraElement[];
    constructor(process?: Process | null);
    get process(): Process | null;
    /** 绑定/切换目标进程（会清空模块缓存与所有记录的地址缓存）。 */
    attachProcess(process: Process | null): void;
    get count(): number;
    /** 按索引取记录（CE 的 getMemoryRecord(i)，0 基） */
    get(index: number): MemoryRecord | undefined;
    /** 按 id 取记录 */
    getById(id: number): MemoryRecord | undefined;
    /** 按描述取记录（CE 的 getRecordWithDescription） */
    getByDescription(description: string): MemoryRecord | undefined;
    /** 全部记录（返回浅拷贝数组） */
    all(): MemoryRecord[];
    /** 追加一个条目 */
    add(data: Partial<MemoryRecordData> & {
        address: string;
        variableType: VariableType;
    }): MemoryRecord;
    /**
     * 删除记录。
     *
     * ⚠️ **传数字时按「数组下标」解释，不是按 id**（保持既有语义）。
     *
     * 早先调用方（`lib/tools/table.js` 的 `ce_cheat_table action=remove`）直接把
     * 工具参数 `id` 透传进来，而 `add()` 生成的 `id` 是**从 1 开始**的 ——
     * 于是「list 显示 `#1`，remove 却要传 `id: 0`」，差一位，
     * 而一次误操作就会**删错条目**（删掉相邻的那条）。
     *
     * 为避免再有人踩这个坑，这里提供语义明确的 `removeById`；
     * 按 id 删除应当一律走它。
     */
    remove(record: MemoryRecord | number): boolean;
    /**
     * 按 `id` 删除记录（`id` 来自 `add()`，从 1 开始）。
     *
     * 与 `remove(number)` 的区别：那个按下标，这个按 id。
     * 工具层展示给用户的就是 id，所以**面向用户的删除必须走这里**。
     *
     * @returns 找到并删除则 true；id 不存在则 false
     */
    removeById(id: number): boolean;
    /** 清空 */
    clear(): void;
    /** 求值上下文（供地址表达式使用） */
    evalContext(): EvalContext;
    /** 预加载模块列表缓存（可选，避免每条记录都枚举一次模块） */
    preloadModules(): void;
    /**
     * 注册符号。
     *
     * @param name 符号名
     * @param address 解析出的地址
     * @param addressText 可选：符号在 .CT 里的**原始文本**（用于 save 时原样写回，
     *        见 `symbolSources` 的说明）。不给时会按十六进制补一个。
     */
    registerSymbol(name: string, address: bigint, addressText?: string): void;
    /** 注销符号 */
    unregisterSymbol(name: string): void;
    /** 解析一个地址表达式（会用到符号表与模块列表）。 */
    resolveExpression(expression: string): bigint;
    /** 驱动一次"锁定写回"；返回成功写回的条目数。宿主自行决定调用频率。 */
    tickFrozen(): number;
    /** 读取全部记录的当前值，返回便于展示的快照 */
    snapshot(): Array<{
        id: number;
        description: string;
        address: bigint | null;
        addressText: string;
        type: VariableType;
        value: string | null;
        frozen: boolean;
        active: boolean;
        /** 备注；空串表示没有备注 */
        comment: string;
        error: string | null;
    }>;
    /** 转成纯数据（用于保存） */
    toData(): MemoryRecordData[];
    /** 从纯数据恢复 */
    static fromData(data: MemoryRecordData[], process?: Process | null): AddressList;
}
/**
 * 把扫描结果导入地址表 —— 对齐 CE「把扫描结果加入地址表」。
 */
export declare function addScanResults(list: AddressList, addresses: readonly bigint[], variableType: VariableType, description?: string): MemoryRecord[];
/**
 * 用一次扫描结果构建地址表条目，并把当前值填入 value —— 便于导出成可用的表。
 */
export declare function buildRecordsFromScan(list: AddressList, addresses: readonly bigint[], variableType: VariableType, descriptionPrefix?: string): MemoryRecord[];
export { RoundingType, ScanOption, VariableType };
//# sourceMappingURL=memory-record.d.ts.map