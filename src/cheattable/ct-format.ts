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

import {
  AddressList,
  MemoryRecord,
  MemoryRecordData,
} from '../addresslist/memory-record';
import { VariableType } from '../types';

/* ------------------------------------------------------------------ *
 * 类型名映射（严格对齐 CEFuncProc）
 * ------------------------------------------------------------------ */

const TYPE_TO_STRING: Partial<Record<VariableType, string>> = {
  [VariableType.All]: 'All',
  [VariableType.Binary]: 'Binary',
  [VariableType.ByteArray]: 'Array of byte',
  [VariableType.Byte]: 'Byte',
  [VariableType.Word]: '2 Bytes',
  [VariableType.DWord]: '4 Bytes',
  [VariableType.QWord]: '8 Bytes',
  [VariableType.Single]: 'Float',
  [VariableType.Double]: 'Double',
  [VariableType.String]: 'String',
  [VariableType.UnicodeString]: 'Unicode String',
  [VariableType.Pointer]: 'Pointer',
  [VariableType.AutoAssembler]: 'Auto Assembler Script',
  [VariableType.Custom]: 'Custom',
  [VariableType.Grouped]: 'Grouped',
  [VariableType.ByteArrays]: 'Array of byte',
  [VariableType.CodePageString]: 'String',
};

const STRING_TO_TYPE: Record<string, VariableType> = {
  all: VariableType.All,
  binary: VariableType.Binary,
  'array of byte': VariableType.ByteArray,
  byte: VariableType.Byte,
  '2 bytes': VariableType.Word,
  '4 bytes': VariableType.DWord,
  '8 bytes': VariableType.QWord,
  float: VariableType.Single,
  double: VariableType.Double,
  string: VariableType.String,
  'unicode string': VariableType.UnicodeString,
  pointer: VariableType.Pointer,
  custom: VariableType.Custom,
  grouped: VariableType.Grouped,
  'auto assembler script': VariableType.AutoAssembler,
};

/** 变量类型 → CE 表里的字符串 */
export function variableTypeToString(type: VariableType): string {
  return TYPE_TO_STRING[type] ?? 'Error';
}

/** CE 表里的字符串 → 变量类型（未知时按 CE 一样回落到 Byte） */
export function stringToVariableType(s: string): VariableType {
  const key = s.trim().toLowerCase();
  return STRING_TO_TYPE[key] ?? VariableType.Byte;
}

/* ------------------------------------------------------------------ *
 * 轻量 XML 解析
 * ------------------------------------------------------------------ */

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
export function parseXml(source: string): XmlElement {
  let i = 0;
  const n = source.length;
  const root: XmlElement = {
    kind: 'element',
    name: '#root',
    attributes: {},
    children: [],
    text: '',
    raw: '',
  };
  const stack: XmlElement[] = [root];
  /** 每个**尚未闭合**元素的起始下标（用于给它切出 raw 原文）。 */
  const starts: number[] = [0];

  const decode = (s: string): string =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
      .replace(/&amp;/g, '&');

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      const t = source.slice(i).trim();
      if (t) stack[stack.length - 1].children.push({ kind: 'text', value: decode(t) });
      break;
    }
    if (lt > i) {
      const t = source.slice(i, lt).trim();
      if (t) stack[stack.length - 1].children.push({ kind: 'text', value: decode(t) });
    }

    // 注释 / 声明 / CDATA
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt);
      const content = source.slice(lt + 9, end === -1 ? n : end);
      stack[stack.length - 1].children.push({ kind: 'text', value: content });
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }

    const gt = source.indexOf('>', lt);
    if (gt === -1) break;
    const raw = source.slice(lt + 1, gt);

    // 闭合标签
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      // 容错：找到匹配的祖先
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].name === name) {
          stack[k].raw = source.slice(starts[k], gt + 1);
          stack.length = k;
          starts.length = k;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;

    // 分离标签名与属性
    const nameMatch = body.match(/^([^\s/]+)/);
    const name = nameMatch ? nameMatch[1] : '';
    const attrStr = body.slice(name.length);
    const attributes: Record<string, string> = {};
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrStr)) !== null) {
      attributes[am[1]] = decode(am[3] ?? am[4] ?? '');
    }

    const el: XmlElement = {
      kind: 'element',
      name,
      attributes,
      children: [],
      text: '',
      raw: selfClosing ? source.slice(lt, gt + 1) : '',
    };
    stack[stack.length - 1].children.push(el);

    if (!selfClosing) {
      stack.push(el);
      starts.push(lt);
    }
    i = gt + 1;
  }

  // 计算每个元素的 text；顺手给**没有闭合标签**的元素（畸形 XML）补上 raw，
  // 否则根级 round-trip 会在这种输入上把内容写成空字符串（静默丢数据）。
  const computeText = (el: XmlElement): void => {
    let s = '';
    for (const c of el.children) {
      if (c.kind === 'text') s += c.value;
      else computeText(c);
    }
    el.text = s.trim();
  };
  computeText(root);
  for (let k = 1; k < stack.length; k++) {
    if (stack[k].raw === '') stack[k].raw = source.slice(starts[k]);
  }
  return root;
}

/** 在元素下找第一个指定名字的子元素 */
function child(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of el.children) {
    if (c.kind === 'element' && c.name === name) return c;
  }
  return undefined;
}

/** 在元素下找全部指定名字的子元素 */
function children(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) {
    if (c.kind === 'element' && c.name === name) out.push(c);
  }
  return out;
}

/** 描述在 CE 表里被引号包裹；去掉外层引号（若无引号则原样） */
function unquoteDescription(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/**
 * 给**描述**加 CE 约定的包裹引号（幂等）。
 *
 * CE 表里描述用一对字面量双引号包裹（`MemoryRecordUnit.pas:1818`：
 * `CreateElement('Description')).TextContent:='"'+s+'"'`）。若值自身已经是
 * "外层包裹"形式就不再重复加，避免写出 `""生命值""`。
 *
 * ⚠️ **地址（`<Address>`）绝不能走这条路**。CE 写地址是**原样**的
 * （`MemoryRecordUnit.pas:1764`：`TextContent:=interpretableaddress`），
 * 而它自己生成地址时也**不带外层引号**（`symbolhandler.pas:5045`：
 * `mi.modulename+'+'+inttohex(...)`）。给地址包一层引号会让 CE **解析不出来**：
 * CE 的 `tokenize`（`symbolhandler.pas:3125`）遇到引号只切换 `inQuote`、
 * **不产生分隔符**，于是 `"mod.exe+0x9024"` 变成**一个** token，
 * `val('$mod.exe+0x9024')` 失败、`getmodulebyname` 也失败 ⇒ 整条地址报错。
 * 早先这里误用了 `quoteDescription`，写出的表在 CE 里每条地址都是坏的。
 */
function quoteDescription(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"') && !t.slice(1, -1).includes('"')) {
    return t;
  }
  return `"${t}"`;
}

/* ------------------------------------------------------------------ *
 * `.CT` 地址语义：**裸数字就是十六进制**
 * ------------------------------------------------------------------ */

/**
 * CE `TSymhandler.tokenize` 用的分隔符集合。
 *
 * 逐字对齐 `ce-src/Cheat Engine/symbolhandler.pas:3125`：
 *   `if (s[i] in ['"', '[', ']', '+', '-', '*','(',')'])`
 *
 * 记住两条与"常规算术"不同的地方：
 *   · 引号只切换 `inQuote`，**本身不作为分隔符存进 token**（`3127-3154`）；
 *   · 引号内的一切（包括 `+`、`-`）都不切分，所以 `"cmd.exe"` 是**一个** token。
 */
const CT_TOKEN_SEPARATORS = new Set(['"', '[', ']', '+', '-', '*', '(', ')']);

/**
 * 按 CE 的切分规则遍历地址文本，对**每个 token** 调用 `map` 改写。
 *
 * ## ⚠️ 每个 token 都必须 **trim**（CE 就是这么做的）
 *
 * 查证 `ce-src/Cheat Engine/symbolhandler.pas` 的 `TSymHandler.tokenize`：
 * 分隔符处的片段是 `t:=trim(copy(s, last, i-last))`（`:3142`），
 * 末段同样 `t:=trim(copy(s, last,length(s)))`（`:3169`）。
 * 也就是**两处都 trim**，所以 `"mod.exe" + 9018` 里的 ` 9018` 在 CE 眼里
 * 就是 `9018`（一个十六进制数字）。
 *
 * 早先这里**不 trim**，于是带空白的地址静默走错语义：
 *   · `"CheatTestWindow.exe" + 9018` → token ` 9018` 不匹配 `/^[0-9a-f]+$/`
 *     → 原样保留 → 内核词法器按**十进制**读 ⇒ `base+0x233A`（CE 是 `base+0x9018`），
 *     而且 **error 为空**（静默算错地址）；
 *   · 反向（写出）时同理：内部 `"…" + 0x9018` 的 token ` 0x9018` 去不掉前缀，
 *     写出的 `<Address>` 里就带着 `0x` ⇒ **CE 解析不了我们写出的表**。
 *
 * 前后空白**原样保留在输出里**（只把 trim 后的文本交给 `map`），
 * 所以 `"a" + 10` 的形态不会被压成 `"a"+10` —— 文本形态尽量不动，只改语义。
 *
 * 与 CE 的唯一差异：CE 在 `""a"+1"` 这种"引号内又紧跟收尾引号"的写法上会
 * **丢掉最后一个 token**（`3150-3161` 只在 `not inQuote` 时 flush），
 * 这里在遇到引号时也 flush 一次，避免把数字吞掉。只会更宽容，不会更严格。
 *
 * @param text 地址表达式
 * @param map token 改写函数（收到的是**已 trim** 的 token）
 * @returns 改写后的文本（分隔符、引号与空白原样保留）
 */
function mapCtTokens(text: string, map: (token: string) => string): string {
  let out = '';
  let token = '';
  let inQuote = false;
  const flush = (): void => {
    if (token === '') return;
    const trimmed = token.trim();
    if (trimmed === '') {
      // 纯空白的片段（`"a" + 10` 里 `+` 后面那个空格）原样留着，不动它
      out += token;
      token = '';
      return;
    }
    // ⚠️ `map` 只看到 trim 后的 token（CE 语义），而**空白照原样留在输出里**：
    // 这样 `"m.exe"+ 9018` 与 `"m.exe" + 9018` 都不会被压成一种形态。
    const start = token.indexOf(trimmed);
    out += token.slice(0, start) + map(trimmed) + token.slice(start + trimmed.length);
    token = '';
  };
  for (const c of text) {
    if (c === '"') {
      flush();
      inQuote = !inQuote;
      out += c;
      continue;
    }
    if (!inQuote && CT_TOKEN_SEPARATORS.has(c)) {
      flush();
      out += c;
      continue;
    }
    token += c;
  }
  flush();
  return out;
}

/** 去掉十六进制串的前导零（`00401000` → `401000`）；全零保留一位 `0`。 */
function trimHexZeros(digits: string): string {
  const trimmed = digits.replace(/^0+/, '').toLowerCase();
  return trimmed === '' ? '0' : trimmed;
}

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
export function normalizeCtAddress(input: string): string {
  const text = input.trim();
  if (text === '') return '';
  return mapCtTokens(text, (token) => {
    // 只有"纯十六进制串"才是 CE 眼里的裸数字字面量；
    // `0x1000` / `$1A2B` / `game.exe` / `myStat` 都不匹配，原样保留。
    if (!/^[0-9a-f]+$/i.test(token)) return token;
    return '0x' + trimHexZeros(token);
  });
}

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
export function ctAddressForFile(input: string): string {
  const text = input.trim();
  if (text === '') return '';
  return mapCtTokens(text, (token) => {
    let m = /^0x([0-9a-f]+)$/i.exec(token);
    if (m) return trimHexZeros(m[1]);
    m = /^\$([0-9a-f]+)$/i.exec(token);
    if (m) return trimHexZeros(m[1]);
    // 纯十进制（内部语义）→ 等值十六进制（.CT 语义）
    m = /^([0-9]+)$/.exec(token);
    if (m) return BigInt(m[1]).toString(16);
    return token;
  });
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

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
  symbols: Array<{ name: string; address: string }>;
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
export function parseCheatTable(xml: string): ParsedCheatTable {
  const root = parseXml(xml);
  const table =
    root.name === 'CheatTable' ? root : findFirstByName(root, 'CheatTable') ?? root;

  // 版本：**缺属性时按 45**（CE 的当前表版本），不是 1。
  //
  // 查证 `OpenSave.pas:397-408`：CE 只在 `CheatEngineTableVersion` 属性**存在**时才
  // 覆盖 `version` / `lastLoadedTableVersion`；属性缺失时两者保持
  // `_CurrentTableVersion`（=45）。而 `lastLoadedTableVersion` **是有语义的**：
  // `autoassembler.pas:2331` `if (lastLoadedTableVersion>0) and (lastLoadedTableVersion<=30)`
  // 会走老表的 CREATETHREADANDWAIT 兼容路径 —— 缺属性时我们若谎称"版本 1"，
  // 一张现代内容的新表会被 CE 按上古表处理（写出去的版本号还会是 1）。
  const versionRaw = table.attributes['CheatEngineTableVersion'];
  const version = versionRaw === undefined ? 45 : Number.parseInt(versionRaw, 10) || 45;

  const commentEl = child(table, 'Comment');
  const comment = commentEl ? commentEl.text : '';

  const symbols: Array<{ name: string; address: string }> = [];
  const symsEl = child(table, 'UserdefinedSymbols');
  if (symsEl) {
    for (const s of children(symsEl, 'SymbolEntry')) {
      // ⚠️ CE 写的是**子元素**，不是属性：
      //   `<SymbolEntry><Name>x</Name><Address>1234</Address></SymbolEntry>`
      // 查证 `OpenSave.pas:1300-1302`（写出）与 `OpenSave.pas:630-637`（读入，
      // 用 `SymbolEntry.FindNode('Name')` / `FindNode('Address')`）。
      // 早先本移植只认属性形式（`<SymbolEntry Name=".." Address=".."/>`），
      // 于是**读不到真实 CE 表里的符号**。属性形式保留为兼容分支
      // （0.1.7 及更早版本本移植自己写出的文件就是那样），CE 读端不认属性，
      // 所以新写出的一律用元素形式。
      const name = s.attributes['Name'] ?? child(s, 'Name')?.text ?? '';
      const address = s.attributes['Address'] ?? child(s, 'Address')?.text ?? '';
      if (name) symbols.push({ name, address });
    }
  }

  let records: MemoryRecordData[] = [];
  const entriesEl = child(table, 'CheatEntries');
  if (entriesEl) {
    records = children(entriesEl, 'CheatEntry').map((e) => parseCheatEntry(e));
  } else {
    // 少数表把 CheatEntry 直接放在 CheatTable 下
    records = children(table, 'CheatEntry').map((e) => parseCheatEntry(e));
  }

  // 根级未建模元素：原样收着，save 时写回。
  //
  // 这三个是**我们自己会重新生成**的，跳过它们以免写出重复段：
  //   Comment / UserdefinedSymbols / CheatEntries（以及裸的 CheatEntry）。
  const regenerated = new Set(['Comment', 'UserdefinedSymbols', 'CheatEntries', 'CheatEntry']);
  const entriesIndex = table.children.findIndex(
    (c) => c.kind === 'element' && c.name === 'CheatEntries',
  );
  const rootExtra: RootExtraElement[] = [];
  table.children.forEach((c, index) => {
    if (c.kind !== 'element') return;
    if (regenerated.has(c.name)) return;
    if (c.raw === '') return;
    rootExtra.push({
      name: c.name,
      xml: c.raw,
      afterEntries: entriesIndex !== -1 && index > entriesIndex,
    });
  });

  return {
    version,
    comment,
    records,
    symbols,
    rootAttributes: { ...table.attributes },
    rootName: table.name,
    rootExtra,
  };
}

function findFirstByName(el: XmlElement, name: string): XmlElement | null {
  for (const c of el.children) {
    if (c.kind !== 'element') continue;
    if (c.name === name) return c;
    const inner = findFirstByName(c, name);
    if (inner) return inner;
  }
  return null;
}

/** 解析单个 <CheatEntry> */
function parseCheatEntry(el: XmlElement): MemoryRecordData {
  const known = new Set([
    'ID',
    'Description',
    'VariableType',
    'Address',
    'Offsets',
    'CheatEntries',
    'LastState',
    'ShowAsHex',
    'ShowAsSigned',
    'Color',
    'GroupHeader',
    'Options',
    'Length',
    'Unicode',
    'CodePage',
    'ZeroTerminate',
    'ByteLength',
    'BitStart',
    'BitLength',
    'ShowAsBinary',
    'CustomType',
    'AssemblerScript',
    'DropDownListLink',
    'DropDownList',
    // 条目备注（本移植的扩展元素，见 writeEntry 里的说明）
    'Comment',
  ]);

  const idEl = child(el, 'ID');
  const id = idEl ? Number.parseInt(idEl.text, 10) || 0 : 0;

  const descEl = child(el, 'Description');
  const description = descEl ? unquoteDescription(descEl.text) : '';

  // 条目备注。
  //
  // ⚠️ 实测查证（`ce-src/Cheat Engine/MemoryRecordUnit.pas`）：**CE 的 TMemoryRecord
  // 没有"备注"字段** —— `getXMLNode` 写出的子元素只有 ID / Description / Options /
  // DropDownList* / LastState / ShowAsHex / ShowAsSigned / Color / GroupHeader /
  // VariableType / CustomType / BitStart / BitLength / ShowAsBinary / Length / Unicode /
  // CodePage / ZeroTerminate / ByteLength / AssemblerScript / Hotkeys / CheatEntries，
  // 读端 `setXMLnode` 也只按这些固定名字 `FindNode`。
  //
  // 所以**不存在**一个"与 CE 兼容的备注元素名"可选。这里用 `<Comment>`：
  //   · CE 的读端是 `FindNode` 逐个已知名字，**不认识的多余子元素会被直接忽略**，
  //     不会报错、不会被当成坏表 —— 因此写出去不会破坏互通；
  //   · 本移植的读端认它，于是 save → load 能真正把备注带回来。
  // 代价：CE 里看不到这条备注，而且在 CE 里重新保存一次就会丢掉它。
  const commentEl = child(el, 'Comment');
  const comment = commentEl ? commentEl.text : '';

  const typeEl = child(el, 'VariableType');
  const groupHeader = child(el, 'GroupHeader');
  let variableType = typeEl ? stringToVariableType(typeEl.text) : VariableType.Byte;
  if (!typeEl && groupHeader) {
    // 分组头在 CE 里没有 VariableType，用 Byte 占位
    variableType = VariableType.Byte;
  }

  // 地址：先剥掉可能的"整条外层引号"（`"00401000"`），再按 **.CT 的十六进制语义**
  // 改写每一个裸数字 token（见 normalizeCtAddress 的查证说明）。
  //
  // ⚠️ 规范化必须发生在**这里**（解析处）而不是调用方：`MemoryRecord` 在构造函数里
  // 就把地址编译成了 `compiled`，事后改 `record.address` 对求值毫无影响。
  // 早先的 0.1.7 版本是在插件里用正则改写 `<Address>` 的 XML 文本，那是**错层次**的修法：
  //   · 不认数字实体（`&#48;0401000` 漏过）；
  //   · 正则跨过注释/CDATA 边界，把良构 XML 改坏（注释永不闭合、条目全被吞）；
  //   · 与内核的 XML 解析器不是同一套"文本"定义，两边永远对不齐。
  // 下沉到这里之后，上面三类洞一次消失：拿到的就是**已解码**的文本。
  const addrEl = child(el, 'Address');
  const address = addrEl ? normalizeCtAddress(unquoteDescription(addrEl.text)) : '';

  const offsetsEl = child(el, 'Offsets');
  let offsets: number[] | undefined;
  /** 解析不出十六进制数的 `<Offset>` 原文（下标 → 已按 .CT 语义规范化的表达式） */
  const offsetExpressions: Record<number, string> = {};
  if (offsetsEl) {
    // ⚠️ `<Offset>` 里的值是**十六进制文本**，不是十进制 —— 必须按 16 解析。
    //
    // 这是实测发现的一个**静默算错地址**的严重缺陷：真实 CE 生成的 .CT 里
    // 偏移全是裸十六进制（形如 `<Offset>1A2B3C</Offset>`，CE 界面上显示为
    // `game.exe+1A2B3C`）。早先这里写 `Number.parseInt(o.text, 10)`，
    // 于是 `1000` 被当成十进制 → `0x3e8`，而 CE 的语义是 `0x1000`。
    //
    // 后果：载入真实的 .CT 会解析出一个**完全不同的地址，而且不报错** ——
    // 比报错危险得多。写入侧（`saveCheatTable`）本来就用 `toString(16)` 输出，
    // 所以这里按 16 解析才与它自洽。
    //
    // ⚠️⚠️ 解析不了的偏移**绝不能静默丢掉**（早先 `.filter(v => !Number.isNaN(v))`）。
    //
    // CE 允许偏移写成**符号/表达式**（`<Offset>mySym</Offset>`）：
    // `TMemrecOffset.setOffsetText`（`MemoryRecordUnit.pas:631-696`）先试
    // `StrToQWordEx(ConvertHexStrToRealStr(s))`，失败再 `getAddressFromNameShallow`
    // （符号），再失败退到 Lua，最后 `getAddressFromName`；全都失败才置 `finvalid`，
    // 而 `GetRealAddress`（`:3683-3691`）在这种情况下把整条条目标成
    // `UnreadablePointer`、地址归零 —— **链长一级都不少**。
    // 早先的过滤式写法让链**变短**：`[10, zz]` 变成 `[16]`（少一级、地址静默算错）、
    // 只有 `zz` 时 `offsets` 直接变成 `undefined`（条目从"指针"退化成"普通地址"）。
    //
    // 现在的做法：解析不了的位置**保留这一级**（先放 0 占位，链长不变），
    // 把原文（已按 .CT 语义规范化）记进 `offsetExpressions`，求值时真的去解析它；
    // 解析不出来就**如实报错**（地址为 null + 说明），而不是给一个静默错误的地址。
    const rawOffsets = children(offsetsEl, 'Offset');
    const parsed: number[] = [];
    rawOffsets.forEach((o, index) => {
      const text = o.text.trim();
      const value = Number.parseInt(text, 16);
      if (!Number.isNaN(value)) {
        parsed.push(value);
        return;
      }
      // 非十六进制：按 CE 一样当符号/表达式处理（规范化后交给求值器）
      const expression = normalizeCtAddress(text);
      offsetExpressions[index] = expression;
      parsed.push(0);
    });
    if (parsed.length > 0) offsets = parsed;
  }

  const hexEl = child(el, 'ShowAsHex');
  const hexadecimal = hexEl ? hexEl.text.trim() === '1' : false;

  const binEl = child(el, 'ShowAsBinary');
  const binary = binEl ? binEl.text.trim().toLowerCase() === 'true' || binEl.text.trim() === '1' : false;

  const lenEl = child(el, 'Length');
  const stringLength = lenEl ? Number.parseInt(lenEl.text, 10) || 0 : 0;

  const cpEl = child(el, 'CodePage');
  const codePageRaw = cpEl ? cpEl.text.trim() : '';
  const codePage = codePageRaw === '1' || codePageRaw.toLowerCase() === 'true' ? 1 : 0;

  const lastState = child(el, 'LastState');
  const value = lastState?.attributes['Value'];

  // 冻结状态。
  //
  // ⚠️ 属性名是 **`Activated`**，不是 `Active` —— 这是查证 CE 源码得到的更正。
  // `MemoryRecordUnit.pas:1926-1931` 在 `Active` 为真时写的是：
  //     a:=doc.CreateAttribute('Activated'); a.TextContent:='1';
  // 也就是 `<LastState RealAddress="…" Value="…" Activated="1"/>`。
  // 早先这里读的是 `Active`（代码注释也承认是在猜："表里常见 Active 属性"），
  // 而 CE **从不写** `Active` —— 于是本插件自己写出的冻结标记也读不回来，
  // 表现为「add 显示 [冻结]、list 里 frozen 是 undefined、save 出的 XML 里完全没有」。
  //
  // 关于 `active`：CE 的 `setXMLnode` 其实**不读** `Activated`（读端没有 LastState 的
  // FindNode），它只是写出来给界面一个"保存时是启用的"提示。本移植读回来是**超集**行为，
  // 只会让往返更完整，不会与 CE 冲突。为兼容旧版本写出的文件，仍接受 `Active`。
  const activatedAttr = lastState?.attributes['Activated'];
  const legacyActiveAttr = lastState?.attributes['Active'] ?? child(el, 'Active')?.text;
  const active = legacyActiveAttr === undefined
    ? true
    : legacyActiveAttr !== '0' && legacyActiveAttr.toLowerCase() !== 'false';
  // `Activated="1"` 或旧版 `Active="1"` 都视为"冻结/启用"标记
  const frozen = activatedAttr === '1' || legacyActiveAttr === '1';

  const data: MemoryRecordData = {
    id,
    description,
    address,
    variableType,
  };
  if (value !== undefined) data.value = value;
  if (offsets) data.offsets = offsets;
  // 解析不出十六进制数的偏移：原文（已规范化）留着，求值时真去解析它。
  if (Object.keys(offsetExpressions).length > 0) data.offsetExpressions = offsetExpressions;
  if (hexadecimal) data.hexadecimal = true;
  if (binary) data.binary = true;
  if (stringLength) data.stringLength = stringLength;
  if (codePage) data.codePage = codePage;
  if (!active) data.active = false;
  if (frozen) data.frozen = true;
  if (comment !== '') data.comment = comment;

  // 未知元素原样保留，保证往返不丢信息
  const extra: Record<string, string> = {};
  for (const c of el.children) {
    if (c.kind !== 'element') continue;
    if (known.has(c.name)) continue;
    extra[c.name] = c.text;
  }
  // 已知但本移植不建模的元素也保留下来（例如 Options / Color / AssemblerScript）
  for (const name of ['Options', 'Color', 'AssemblerScript', 'DropDownList', 'DropDownListLink', 'CustomType', 'GroupHeader']) {
    const c = child(el, name);
    if (c) extra[name] = c.text || '1';
  }
  if (Object.keys(extra).length > 0) data.extra = extra;

  const sub = child(el, 'CheatEntries');
  if (sub) {
    const kids = children(sub, 'CheatEntry').map((e) => parseCheatEntry(e));
    if (kids.length > 0) data.children = kids;
  }

  return data;
}

/* ------------------------------------------------------------------ *
 * 写出
 * ------------------------------------------------------------------ */

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
  symbols?: Array<{ name: string; address: string }>;
  /** 根级其它属性（`CheatEngineTableVersion` 由 version 决定，其余原样写回） */
  rootAttributes?: Record<string, string>;
  /** 根级未建模元素（原样写回，见 ParsedCheatTable.rootExtra） */
  rootExtra?: RootExtraElement[];
}

/**
 * XML **文本节点**转义。
 *
 * 关键：这里**不转义双引号**。因为 CE 表约定描述与地址用字面量双引号包裹
 * （`<Description>"生命值"</Description>`），这些引号必须原样出现在文本里。
 * 文本节点里出现裸引号是合法 XML，CE 的解析器同样如此处理。
 *
 * 早期实现把引号转成 `&quot;` 再还原回 `"`，两次替换互相抵消等于没转义，
 * 却让"已带引号"的地址变成 `""game.exe"+0"` —— 请勿改回。
 * 属性值请用 escAttr（那里必须转义引号）。
 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** XML **属性值**转义（引号必须转义）。 */
function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把地址表序列化为 .CT 内容。
 *
 * @param list 地址表；若为纯数据数组也可直接传
 */
export function writeCheatTable(
  list: AddressList | MemoryRecord[] | MemoryRecordData[],
  options: WriteCheatTableOptions = {},
): string {
  // 传进来的若是 `AddressList`，根级信息**默认跟着它走**（版本/其它属性/未建模元素），
  // 这样连直接调 `writeCheatTable(list)` 也是"读进来再写出去不丢信息"。
  const table = list instanceof AddressList ? list : null;
  const version = options.version ?? table?.version ?? 45;
  const includeLastState = options.includeLastState !== false;

  let records: MemoryRecordData[];
  if (Array.isArray(list)) {
    records = list.map((r) =>
      typeof (r as MemoryRecord).toData === 'function' ? (r as MemoryRecord).toData() : (r as MemoryRecordData),
    );
  } else {
    records = list.toData();
  }

  const symbols =
    options.symbols ??
    (list instanceof AddressList ? collectSymbols(list) : []);

  // 根级属性：`CheatEngineTableVersion` 由 version 决定（不重复写），其余原样保留
  // —— 早先这里把 `rootAttributes` 解析出来却从不写出，别人的表 save 一次就丢
  // 掉根级上的所有其它属性（实测：`CustomRootAttr="keepme"` 消失）。
  const extraAttributes = Object.entries(options.rootAttributes ?? table?.rootAttributes ?? {}).filter(
    ([name]) => name !== 'CheatEngineTableVersion',
  );
  const attributeText = extraAttributes
    .map(([name, value]) => ` ${name}="${escAttr(value)}"`)
    .join('');

  // 根级未建模元素：按原本相对 `<CheatEntries>` 的位置分两批写回
  const rootExtra = (options.rootExtra ?? table?.rootExtra ?? []).filter((e) => e.xml !== '');
  const indentBlock = (xml: string): string =>
    xml
      .split('\n')
      .map((line) => (line.trim() === '' ? line : `  ${line}`))
      .join('\n');

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push(`<CheatTable CheatEngineTableVersion="${version}"${attributeText}>`);
  if (options.comment) {
    lines.push(`  <Comment>${esc(options.comment)}</Comment>`);
  }
  for (const e of rootExtra) {
    if (!e.afterEntries) lines.push(indentBlock(e.xml));
  }
  if (symbols.length > 0) {
    lines.push('  <UserdefinedSymbols>');
    for (const s of symbols) {
      // 元素形式（CE 的读端 `FindNode('Name')` / `FindNode('Address')` 才认），
      // 不是属性形式 —— 见 parseCheatTable 里的查证。
      lines.push('    <SymbolEntry>');
      lines.push(`      <Name>${esc(s.name)}</Name>`);
      lines.push(`      <Address>${esc(s.address)}</Address>`);
      lines.push('    </SymbolEntry>');
    }
    lines.push('  </UserdefinedSymbols>');
  }
  lines.push('  <CheatEntries>');
  for (const r of records) {
    writeEntry(lines, r, 2, includeLastState);
  }
  lines.push('  </CheatEntries>');
  for (const e of rootExtra) {
    if (e.afterEntries) lines.push(indentBlock(e.xml));
  }
  lines.push('</CheatTable>');
  return lines.join('\n') + '\n';
}

function writeEntry(
  lines: string[],
  r: MemoryRecordData,
  indent: number,
  includeLastState: boolean,
): void {
  const pad = '  '.repeat(indent);
  const pad2 = '  '.repeat(indent + 1);
  lines.push(`${pad}<CheatEntry>`);
  lines.push(`${pad2}<ID>${r.id}</ID>`);
  lines.push(`${pad2}<Description>${esc(quoteDescription(r.description))}</Description>`);

  // 条目备注（本移植的扩展元素；CE 忽略不认识的子元素，见 parseCheatEntry 里的查证说明）。
  //
  // ⚠️ 不写出去就是**静默丢数据**：`MemoryRecord.comment` 一直存在、
  // `toData()` 也一直带上它，但写端此前完全没有输出 —— 于是
  // `ce_cheat_table {action:"add", entries:[{comment:"X"}]}` 在 save 出的 .CT 里
  // **搜不到 X**，往返一圈备注就没了，而且工具从不提示。
  if (r.comment !== undefined && r.comment !== '') {
    lines.push(`${pad2}<Comment>${esc(r.comment)}</Comment>`);
  }

  // 分组头没有 VariableType
  const isGroupHeader = r.extra?.['GroupHeader'] !== undefined;
  if (!isGroupHeader) {
    lines.push(`${pad2}<VariableType>${esc(variableTypeToString(r.variableType))}</VariableType>`);
  }

  if (r.address) {
    // ⚠️ 地址**不加外层引号**、并换回 CE 的裸十六进制写法（`ctAddressForFile`）。
    // 这两点是"能被 CE 打开"的前提，都有 CE 源码依据，详见两个函数的注释。
    // 早先这里写成 `esc(quoteDescription(r.address))`，实测产出
    //   `<Address>"CheatTestWindow.exe+0x9024"</Address>`
    // —— CE 的 tokenize 会把整串引号内内容当成**一个** token，于是这条地址
    // 在 CE 里直接失效（而且当时的测试还把这个错行为钉成了"CE 的写法"）。
    lines.push(`${pad2}<Address>${esc(ctAddressForFile(r.address))}</Address>`);
  }

  if (r.offsets && r.offsets.length > 0) {
    lines.push(`${pad2}<Offsets>`);
    r.offsets.forEach((o, index) => {
      // ⚠️ 解析不出十六进制数的偏移（符号/表达式）要**按原文写回**，而不是写占位的 0：
      // 写 0 等于把用户的符号偏移**静默改成 0**（地址错了还不报错）。
      // 用 `ctAddressForFile` 换回 CE 的裸十六进制形态（CE 认不了表达式中间的 `0x`）。
      const expression = r.offsetExpressions?.[index];
      if (expression !== undefined) {
        lines.push(`${pad2}  <Offset>${esc(ctAddressForFile(expression))}</Offset>`);
        return;
      }
      // ⚠️ 必须按**十六进制**写出，与读端 `parseCheatTable` 的 `parseInt(text, 16)` 对称。
      //
      // 早先这里直接写 `${o}`（十进制），而读端按十六进制解析 —— 两端不对称，
      // 于是**每次 load→save 往返都会让偏移漂移一次**：
      // 22（十进制，内存里的真值）→ 写成 "22" → 读回按 0x22 解析成 34。
      // 反复几次偏移就面目全非了，属于会静默损坏用户数据的真 bug。
      //
      // 负偏移要保留符号：CE 用 `-8` 表示往回退，`(-n).toString(16)` 会得到 "-8"，
      // 与读端 `parseInt('-8', 16) === -8` 一致。
      lines.push(`${pad2}  <Offset>${o.toString(16)}</Offset>`);
    });
    lines.push(`${pad2}</Offsets>`);
  }

  // 变长类型（AOB / 字符串）的显式长度。
  //
  // ⚠️ 不写出去就是**丢数据**：写端此前完全没输出长度，于是「带长度的 AOB 条目」
  // save→load 之后长度归零，再也读不出内容。
  //
  // ⚠️⚠️ 元素名必须是 `<Length>`，**不是** `<StringLength>`。
  // 这里曾经写的是 `<StringLength>`，而读端（本文件 `parseCheatEntry`）只认 `<Length>`，
  // 两端不对称 —— 后果是**实测出来的**：
  //   · 插件自己 `add` 出来的 AOB/字符串条目，save→load 之后 `stringLength` 归零、
  //     读出 undefined（内容再也读不回来）；
  //   · 真实 CE 的表（`<Length>13</Length>`）被本插件 save 一次就变成
  //     `<StringLength>13</StringLength>` —— 读端不认，且 **CE 本身也不认这个名字**，
  //     等于把用户表里变长条目的长度弄丢了。
  // `<Length>` 同时与 CE 的真实格式一致，所以这里既修对称性、也修互通性。
  if (r.stringLength !== undefined && r.stringLength > 0) {
    lines.push(`${pad2}<Length>${r.stringLength}</Length>`);
  }

  // 未知/未建模元素原样写回
  if (r.extra) {
    for (const [name, text] of Object.entries(r.extra)) {
      if (name === 'GroupHeader') {
        lines.push(`${pad2}<GroupHeader>${esc(text || '1')}</GroupHeader>`);
        continue;
      }
      if (name === 'AssemblerScript') {
        lines.push(`${pad2}<AssemblerScript>${esc(text)}</AssemblerScript>`);
        continue;
      }
      if (name === 'Color') {
        lines.push(`${pad2}<Color>${esc(text)}</Color>`);
        continue;
      }
      // 其余按简单文本元素写回
      lines.push(`${pad2}<${name}>${esc(text)}</${name}>`);
    }
  }

  if (r.hexadecimal) lines.push(`${pad2}<ShowAsHex>1</ShowAsHex>`);

  // 冻结状态 → `<LastState ... Activated="1"/>`。
  //
  // ⚠️ 必须写在 `LastState` 的 **`Activated`** 属性上 —— 这是 CE 自己写冻结/启用
  // 标记的唯一位置（`MemoryRecordUnit.pas:1926`），详见 parseCheatEntry 的说明。
  //
  // 注意：即便 `includeLastState === false`，只要条目是冻结的也要写这个元素 ——
  // 否则「冻结」这个状态**没有任何其它可持久化的位置**，save→load 必然丢失，
  // 而 `add` 的输出行却会显示 `[冻结]`，同一功能两处表现不一致。
  const activatedAttr = r.frozen === true ? ' Activated="1"' : '';
  if (includeLastState && r.value !== undefined && r.value !== '') {
    lines.push(`${pad2}<LastState${activatedAttr} Value="${escAttr(r.value)}"/>`);
  } else if (includeLastState || activatedAttr !== '') {
    lines.push(`${pad2}<LastState${activatedAttr}/>`);
  }

  if (r.children && r.children.length > 0) {
    lines.push(`${pad2}<CheatEntries>`);
    for (const c of r.children) writeEntry(lines, c, indent + 2, includeLastState);
    lines.push(`${pad2}</CheatEntries>`);
  }

  lines.push(`${pad}</CheatEntry>`);
}

/* ------------------------------------------------------------------ *
 * 高层 API
 * ------------------------------------------------------------------ */

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
export function collectSymbols(list: AddressList): Array<{ name: string; address: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; address: string }> = [];
  const push = (name: string, address: string): void => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, address });
  };
  // ① 先写**原文**（`symbolSources`）：它同时装着"已注册符号的原始写法"与
  //    "**没能解析**的符号"（例如引用了当前没装载的模块）。
  //    ⚠️ 后者只存在于这里 —— 如果只遍历 `symbols`，这些符号会在 save 时**静默消失**，
  //    正是本函数要防的那类丢数据。
  for (const [name, text] of list.symbolSources) {
    if (text !== '') push(name, text);
  }
  // ② 再补上只有解析结果、没有原文的符号（直接调 `registerSymbol` 注册的）
  for (const [name, address] of list.symbols) {
    push(name, '0x' + address.toString(16));
  }
  return out;
}

/** 从 .CT 文本构建 AddressList（不改动传入的 XML） */
export function loadCheatTable(
  xml: string,
  process?: Parameters<typeof AddressList.prototype.attachProcess>[0],
): { list: AddressList; parsed: ParsedCheatTable } {
  const parsed = parseCheatTable(xml);
  const list = new AddressList(process ?? null);
  list.comment = parsed.comment;
  list.version = parsed.version;
  // 根级信息必须一起带上，否则 save 时**静默丢用户数据**：
  //   · rootAttributes —— 根级其它属性（`CustomRootAttr="…"`）；
  //   · rootExtra —— `<Structures>` / `<LuaScript>` / `<Forms>` / `<Files>` /
  //     `<CheatCodes>` / `<Comments>` 等本移植不建模的元素（原样切片）。
  list.rootAttributes = parsed.rootAttributes;
  list.rootExtra = parsed.rootExtra;
  // 模块缓存要在解析符号之前备好（符号地址可能写成模块相对形式）
  if (list.process) list.preloadModules();
  // ⚠️ 符号必须**真的注册**，否则条目里的 `myStat+8` 会报「未知的符号或模块 "myStat"」。
  // 早先 `parsed.symbols` 只是被解析出来、打印一行「自定义符号：N 个」，
  // **从来没有进入符号表**；再 save 一次连整段 `<UserdefinedSymbols>` 都会消失。
  //
  // 地址按 .CT 语义解析（裸数字＝十六进制，见 normalizeCtAddress），并且**按顺序**注册，
  // 所以符号之间可以互相引用（`b = a+10`）—— 与 CE 逐条 `AddUserdefinedSymbol` 一致。
  // 解析不了的（引用了不存在的模块/符号）不注册（宁可不解析，也不要一个静默的 0），
  // 但把原文记进 `symbolSources`，保证 save 不丢。
  for (const s of parsed.symbols) {
    try {
      const expression = normalizeCtAddress(s.address);
      const value = expression === '' ? 0n : list.resolveExpression(expression);
      list.registerSymbol(s.name, value, s.address);
    } catch {
      list.symbolSources.set(s.name, s.address);
    }
  }
  for (const r of parsed.records) list.add(r);
  return { list, parsed };
}

/** 把地址表写回 .CT 文本 */
export function saveCheatTable(
  list: AddressList,
  options: WriteCheatTableOptions = {},
): string {
  return writeCheatTable(list, {
    ...options,
    // ⚠️ 默认**写回载入的版本**（`list.version`），而不是写死的常量：
    // 否则 load 一张 version=45 的表、save 一次就变成别的版本号，
    // 而 CE 打开"版本比它新"的表会弹对话框（`OpenSave.pas:401-402`）。
    version: options.version ?? list.version,
    comment: options.comment ?? list.comment,
    symbols: options.symbols ?? collectSymbols(list),
    rootAttributes: options.rootAttributes ?? list.rootAttributes,
    rootExtra: options.rootExtra ?? list.rootExtra,
  });
}
