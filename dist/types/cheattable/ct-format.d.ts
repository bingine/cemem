/**
 * Cheat Table (.CT) 读写 —— 对齐 Cheat Engine 的 XML 表格式。
 *
 * 元素与属性名严格对齐 `MemoryRecordUnit.pas` / `addresslist.pas` 的写出逻辑：
 *
 * ```xml
 * <?xml version="1.0" encoding="utf-8"?>
 * <CheatTable CheatEngineTableVersion="46">
 *   <CheatEntries>
 *     <CheatEntry>
 *       <ID>1</ID>
 *       <Description>"生命值"</Description>
 *       <VariableType>4 Bytes</VariableType>
 *       <Address>"game.exe"+0012AB34</Address>
 *       <Offsets><Offset>10</Offset><Offset>8</Offset></Offsets>
 *       <LastState Value="1000" RealAddress="7FF6..."/>
 *       <ShowAsHex>1</ShowAsHex>
 *       <Color>FF0000</Color>
 *       <CheatEntries> ... 子条目 ... </CheatEntries>
 *     </CheatEntry>
 *   </CheatEntries>
 * </CheatTable>
 * ```
 *
 * 关键映射（来自 CEFuncProc.VariableTypeToString / StringToVariableType）：
 *   Byte→'Byte'、Word→'2 Bytes'、DWord→'4 Bytes'、QWord→'8 Bytes'、
 *   Single→'Float'、Double→'Double'、String→'String'、UnicodeString→'Unicode String'、
 *   ByteArray→'Array of byte'、Binary→'Binary'、All→'All'、Pointer→'Pointer'、
 *   AutoAssembler→'Auto Assembler Script'、Custom→'Custom'
 *
 * 关于 XML 解析：这里用自写的轻量解析器而不是 DOMParser，
 * 目的是**保留原始元素顺序与未知元素**，从而做到"读进来再写出去不丢信息"
 * （CE 表里存在大量本移植不关心的元素，例如 Hotkeys、Color、DropDownList）。
 * 未知元素统一收进 MemoryRecordData.extra，写回时原样附着。
 */
import { AddressList, MemoryRecord, MemoryRecordData } from '../addresslist/memory-record';
import { VariableType } from '../types';
/** 变量类型 → CE 表里的字符串 */
export declare function variableTypeToString(type: VariableType): string;
/** CE 表里的字符串 → 变量类型（未知时按 CE 一样回落到 Byte） */
export declare function stringToVariableType(s: string): VariableType;
interface XmlElement {
    kind: 'element';
    name: string;
    attributes: Record<string, string>;
    children: XmlNode[];
    /** 直接文本内容（拼接所有文本子节点，已 trim） */
    text: string;
    /**
     * 该元素在**原文里的切片**（含起止标签与内部一切内容）。
     *
     * 用途只有一个：根级元素里那些本移植不建模的部分（`<Structures>` /
     * `<LuaScript>` / `<Forms>` / `<Files>` / `<CheatCodes>` / `<Comments>`…）
     * 在 `save` 时要**原样写回去**。按解析树重新序列化会丢掉属性顺序、
     * 自闭合写法、内部空白与 CDATA，而"原样切片"不会。
     */
    raw: string;
}
interface XmlText {
    kind: 'text';
    value: string;
}
type XmlNode = XmlElement | XmlText;
/** 解析 XML 为元素树（保留顺序与未知元素）。 */
export declare function parseXml(source: string): XmlElement;
/**
 * 把 `.CT` 里的地址规范化成**显式十六进制**的表达式。
 *
 * ## 为什么必须按"逐 token 都是十六进制"来处理（不是"整条是裸数字"才算）
 *
 * `.CT` 是 Cheat Engine 自己的格式，它里面的地址**每一个裸数字都是十六进制**，
 * 没有解释成十进制的余地。查证 CE 的实现（`symbolhandler.pas` `getAddressFromName`）：
 *
 * ```pascal
 *   for i:=0 to length(tokens)-1 do            // 5264
 *     if (length(tokens[i])>0) and (not (tokens[i][1] in ['[',']','+','-','*','(',')'])) then
 *     begin
 *       val('$'+tokens[i],v64,j);              // 5268 ← 逐 token 按 $（十六进制）解析
 *       if j>0 then ... getmodulebyname ... GetUserdefinedSymbolByName ...
 * ```
 *
 * 也就是：`00401000`、`"cmd.exe"+1000`、`+18`、`1000+1000`、`10*2`、
 * `["x.exe"+9000]+10` 里的**每一段**裸数字都是十六进制。早先只把"整条是裸数字"
 * （`00401000`）或者"紧跟模块名的偏移"（`game.exe+1000`）当十六进制，
 * 于是 `+18`、`[...]+10`、`1000+1000` 这些形态**静默算出十进制**的错误地址
 * （例如 `+18` 变成绝对地址 0x12，而 CE 的语义是"父条目 +0x18"）。
 *
 * ## 为什么这条规则**只**用在 .CT 解析路径上
 *
 * 工具的参数框（`ce_read` / `ce_cheat_table add` 的 `address`）面对的是
 * **用户手输**，那里"裸数字＝十进制"是刻意的约定（与 CE 的扫描数值框一致，
 * 见 `lib/values.js` 的 `toAddressExpression`）。两条路必须不同 ——
 * 曾经因为混用而让同一个 `cmd.exe+1000` 在 `ce_read` 与地址表里给出不同地址。
 *
 * 已经显式写了 `0x` / `$` 的 token **不动**（`0x1000`、`$1A2B`）。
 *
 * @param input `.CT` 里 `<Address>` 的**已解码**文本
 * @returns 裸数字已改写成 `0x…` 的表达式
 */
export declare function normalizeCtAddress(input: string): string;
/**
 * `normalizeCtAddress` 的**反向**：把内部表达式还原成 CE 自己会写的形态。
 *
 * CE 生成地址文本时用的是 `modulename+'+'+inttohex(offset,1)`
 * （`symbolhandler.pas:5045`）—— **裸十六进制、无 `0x` 前缀**；
 * 用户手输的地址也是同样的形态（否则 CE 自己都解析不了，见下）。
 *
 * ## 为什么写出去必须去掉 `0x`（否则 CE 读不了我们写的表）
 *
 * CE 的地址解析器只在**整条表达式**是 `0x…` 时才认这个前缀
 * （`symbolhandler.pas:5228-5232`）；表达式**中间**的 `0x` 会走到
 * `val('$0x1000')` 失败 → 模块名/符号名查找失败 ⇒ 该条目地址解析失败。
 * 也就是说 `"mod.exe"+0x9024` 在 CE 里是**坏地址**，而 `"mod.exe"+9024`
 * 才是 CE 的写法（`9024` 按十六进制 = 0x9024）。本移植内部统一用显式 `0x`
 * （因为内核表达式引擎的裸数字默认是十进制），所以在**写出文件时**必须换回
 * CE 的裸十六进制形态。
 *
 * ## ⚠️ 纯十进制 token 必须**换算成等值十六进制**（否则往返静默改地址）
 *
 * 内部表达式里裸数字是**十进制**（内核 `addr/expression.ts:152-162`，
 * 也就是用户 `add 1000` 得到的 `0x3e8`），而 `.CT` 里裸数字是**十六进制**。
 * 早先这里只处理带 `0x`/`$`/`0d`/`0b` 前缀的 token，裸十进制**原样写出** ——
 * 于是 `add 1000+1000`（内部 0x7d0）写出 `<Address>1000+1000</Address>`，
 * 再 load 回来变成 `0x1000+0x1000 = 0x2000`：**save → load 静默改地址**。
 * 所以纯数字 token（`/^[0-9]+$/`）必须按十进制解析、写成十六进制。
 *
 * 其余形态**一律不动**，因为内核词法器对它们的读法与 CE 一致：
 *   · 以字母开头的纯 `[0-9a-f]` 串 —— CE 的 `val('$'+token)`（`:5268`）先于
 *     模块/符号查找，所以它本来就是**十六进制数**（`0d20` 是 `0xd20`、
 *     `1a3f` 是 `0x1a3f`），原样写出、读回来还是同一个值；
 *   · `0d20`/`0b101` 这类"看着像前缀"的裸串**不是**十进制/二进制字面量：
 *     CE 与内核词法器都按十六进制读（`0d20` = 0xd20、`0b101` = 0xb101）。
 *     早先这里按十进制/二进制换算，与内核求值器**互相矛盾** ——
 *     同一张表里 3360 经过一次 save→load 变成 20（见 kernel 测试的反向验证）。
 *
 * 读回来由 `normalizeCtAddress` 再补上 `0x`，因此
 * `load → save → load` 的地址**逐位相同**（内核测试与插件端到端测试都钉住）。
 *
 * @param input 内部地址表达式（可能带 `0x` / `$`，或裸十进制数字）
 * @returns 按 CE 习惯书写的 `.CT` 地址文本
 */
export declare function ctAddressForFile(input: string): string;
/**
 * 根级**本移植不建模**的元素（原样保留，save 时写回）。
 *
 * 为什么必须保留：CE 的表里除了条目还有结构体定义（`<Structures>`）、
 * 表级 Lua（`<LuaScript>`）、窗体（`<Forms>`）、内嵌文件（`<Files>`）、
 * 代码列表（`<CheatCodes>`）、表级注释（`<Comments>`）等。早先
 * `writeCheatTable` 只写 `<Comment>`/`<UserdefinedSymbols>`/`<CheatEntries>`，
 * 于是**别人的表被我们 save 一次，这些东西全部消失** —— 静默丢用户数据。
 */
export interface RootExtraElement {
    /** 元素名 */
    name: string;
    /** 原文切片（含起止标签与内部内容） */
    xml: string;
    /** 它在原文里是否出现在 `<CheatEntries>` **之后**（写回时保持相对次序） */
    afterEntries: boolean;
}
export interface ParsedCheatTable {
    version: number;
    comment: string;
    records: MemoryRecordData[];
    /** 用户自定义符号（<UserdefinedSymbols>） */
    symbols: Array<{
        name: string;
        address: string;
    }>;
    /** 原始根元素属性，便于往返保留 */
    rootAttributes: Record<string, string>;
    /**
     * 作为表根的元素的**名字**（正常是 `CheatTable`）。
     *
     * 用途：区分「合法的空 .CT」（`<CheatTable><CheatEntries/></CheatTable>`，
     * 必须能载入）与「根本不是 .CT 的文件」（空文件 / 非 XML / 二进制垃圾，
     * 此时这里是 `#root` 或别的元素名）。插件据此给出**如实**的错误信息。
     */
    rootName: string;
    /** 根级未建模元素（原样保留，见 RootExtraElement） */
    rootExtra: RootExtraElement[];
}
/**
 * 解析 .CT 内容为地址表数据。
 */
export declare function parseCheatTable(xml: string): ParsedCheatTable;
export interface WriteCheatTableOptions {
    /**
     * `CheatEngineTableVersion` 属性值。
     *
     * ⚠️ 默认 **45**，与参照源码一致：`ce-src/Cheat Engine/OpenSave.pas:24`
     * 是 `const _CurrentTableVersion=45;`，CE 自己写出时用的就是它（`:1218`
     * `SetAttribute('CheatEngineTableVersion',IntToStr(CurrentTableVersion))`）。
     *
     * 早先这里硬编码 46（注释还写着"46 是 CE 6.x/7.x 常见值"，而参照源码**不支持**
     * 这个说法），后果有两个，都是实测过的：
     *   1. 载入一张 version=45 的表、save 一次就变成 46 —— **悄悄改了别人表的版本号**；
     *   2. CE 打开时会走 `OpenSave.pas:401-402`
     *      （`if (version>CurrentTableVersion) then showmessage(rsOSThereIsANewerVersion…)`）
     *      ⇒ 用 CE 7.51 打开我们写出的**任何** .CT 都会弹"有更新版本"的对话框。
     *
     * 载入过的表请把 `<AddressList>.version` 传进来（`saveCheatTable` 会默认这么做），
     * 这样 `load → save` 的版本号逐字不变。
     */
    version?: number;
    /** 表注释 */
    comment?: string;
    /** 是否写入 <LastState>（默认写入当前值，便于 CE 打开时直接显示） */
    includeLastState?: boolean;
    /** 用户自定义符号 */
    symbols?: Array<{
        name: string;
        address: string;
    }>;
    /** 根级其它属性（`CheatEngineTableVersion` 由 version 决定，其余原样写回） */
    rootAttributes?: Record<string, string>;
    /** 根级未建模元素（原样写回，见 ParsedCheatTable.rootExtra） */
    rootExtra?: RootExtraElement[];
}
/**
 * 把地址表序列化为 .CT 内容。
 *
 * @param list 地址表；若为纯数据数组也可直接传
 */
export declare function writeCheatTable(list: AddressList | MemoryRecord[] | MemoryRecordData[], options?: WriteCheatTableOptions): string;
/**
 * 收集地址表里的用户自定义符号，供写出 .CT 使用。
 *
 * 两件事都必须做对，否则 save 会**静默丢数据**或写出重复项：
 *
 *  1. **去重必须大小写不敏感**：`AddressList.registerSymbol` 为了支持
 *     `MyStat` / `mystat` 两种写法，会把同一个符号按**原名与小写名**各存一份。
 *     早先这里只按"原样名字"去重（`seen.add(name)`），于是每个符号都被写出**两遍**
 *     （`<SymbolEntry Name="myAddr">` 与 `<SymbolEntry Name="myaddr">`）。
 *  2. **优先写原文**：`.CT` 里符号的 `Address` 是"用户当初写的字符串"
 *     （CE 只存 `addressstring`，见 `symbolhandler.pas:3714` 的 `ReinitializeUserdefinedSymbolList`）。
 *     若符号写的是模块相对形式（`game.exe+10`），换算成绝对地址写出去就会
 *     **在对方进程重启后失效**。所以注册时记下的原文（`symbolSources`）优先。
 */
export declare function collectSymbols(list: AddressList): Array<{
    name: string;
    address: string;
}>;
/** 从 .CT 文本构建 AddressList（不改动传入的 XML） */
export declare function loadCheatTable(xml: string, process?: Parameters<typeof AddressList.prototype.attachProcess>[0]): {
    list: AddressList;
    parsed: ParsedCheatTable;
};
/** 把地址表写回 .CT 文本 */
export declare function saveCheatTable(list: AddressList, options?: WriteCheatTableOptions): string;
export {};
//# sourceMappingURL=ct-format.d.ts.map