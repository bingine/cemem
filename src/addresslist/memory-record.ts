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

import { CompiledAddress, EvalContext, resolveAddress } from '../addr/expression';
import { Process } from '../win/process';
// 仅类型：`import type` 会被 tsc 完全擦除，所以不会与 ct-format → memory-record 形成运行期循环。
import type { RootExtraElement } from '../cheattable/ct-format';
import {
  RoundingType,
  ScanOption,
  VariableType,
  VARIABLE_TYPE_SIZES,
} from '../types';
import {
  buildFloatCompareParams,
  parseFloatLiteral,
  parseIntegerLiteral,
  roundTo,
} from '../value-codec';

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
export function normalizeAddressExpression(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    const inner = t.slice(1, -1);
    if (!inner.includes('"')) return inner;
  }
  return t;
}

/**
 * 一个内存记录（运行时对象）。对应 CE 的 TMemoryRecord。
 */
export class MemoryRecord {
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
  children: MemoryRecord[] = [];
  parent: MemoryRecord | null = null;
  extra: Record<string, string>;

  /** 用户设定的值（字符串） */
  private userValue: string;
  /** 最近一次解析出的地址 */
  private cachedAddress: bigint | null = null;
  /** 最近一次读取到的原始字节 */
  private cachedBytes: Buffer | null = null;
  /** 最近一次错误 */
  private lastError: string | null = null;

  private readonly compiled: CompiledAddress;

  constructor(data: MemoryRecordData, private readonly list: AddressList) {
    this.id = data.id;
    this.description = data.description;
    this.address = normalizeAddressExpression(data.address);
    this.variableType = data.variableType;
    this.offsets = data.offsets ? data.offsets.slice() : [];
    this.offsetExpressions = new Map(
      Object.entries(data.offsetExpressions ?? {}).map(([key, value]) => [Number(key), value]),
    );
    this.frozen = data.frozen === true;
    this.active = data.active !== false;
    this.comment = data.comment ?? '';
    this.hexadecimal = data.hexadecimal === true;
    this.binary = data.binary === true;
    this.codePage = data.codePage ?? 0;
    this.stringLength = data.stringLength ?? 0;
    this.tolerant = data.tolerant !== false;
    this.userValue = data.value ?? '';
    this.extra = data.extra ? { ...data.extra } : {};
    this.compiled = new CompiledAddress(data.address);
    for (const c of data.children ?? []) {
      const child = new MemoryRecord(c, list);
      child.parent = this;
      this.children.push(child);
    }
  }

  /** 编译期语法错误（null 表示语法正确） */
  get parseError(): Error | null {
    return this.compiled.parseError;
  }

  /** 本记录占用的字节数；变长类型返回显式长度或 0 */
  get byteWidth(): number {
    const fixed = VARIABLE_TYPE_SIZES[this.variableType];
    if (fixed > 0) return fixed;
    if (this.variableType === VariableType.String || this.variableType === VariableType.CodePageString) {
      if (this.stringLength > 0) return this.stringLength;
      return Buffer.byteLength(this.userValue || '', 'latin1') || 1;
    }
    if (this.variableType === VariableType.UnicodeString) {
      if (this.stringLength > 0) return this.stringLength * 2;
      return (this.userValue || '').length * 2 || 2;
    }
    // ⚠️ 字节数组（AOB）同样是**变长**的：没有显式长度就完全读不出内容。
    // 早先这里落到最后 `return 0`，于是 `ce_cheat_table` 里加的 AOB 条目
    // 读出来永远是 undefined —— 而它的"长度"参数（CT 里的 `<StringLength>`）
    // 明明已经传进来了。这里让它与字符串类型一样尊重 stringLength。
    if (this.variableType === VariableType.ByteArray) {
      if (this.stringLength > 0) return this.stringLength;
      return 0;
    }
    return 0;
  }

  /**
   * 本条目是否是"**相对父条目**"的地址。
   *
   * CE 的判据是地址文本第一个字符是 `+` 或 `-` **且**有父条目
   * （`MemoryRecordUnit.pas:2833` `parseAddressString`、
   *   `:3650` `getBaseAddress`、`:2864` `fIsOffset`），地址表里的树形子项用它表示
   * "父条目的地址再加上一个偏移"。
   */
  get isOffset(): boolean {
    if (this.parent === null) return false;
    const s = this.address.trim();
    return s !== '' && (s[0] === '+' || s[0] === '-');
  }

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
  relativeAnchor(): MemoryRecord | null {
    if (!this.isOffset) return null;
    let anchor: MemoryRecord | null = this.parent;
    while (anchor !== null && (anchor.address.trim() === '' || anchor.address.trim() === '0')) {
      anchor = anchor.parent;
    }
    return anchor;
  }

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
  resolve(): RecordEvaluation {
    if (!this.active) {
      this.cachedAddress = null;
      return { address: null, error: '记录未启用' };
    }

    let base: bigint;
    try {
      if (!this.compiled.isValid) {
        throw this.compiled.parseError ?? new Error('地址表达式无效');
      }
      base = this.compiled.resolve(this.list.evalContext());

      const anchor = this.relativeAnchor();
      if (anchor !== null) {
        const parent = anchor.resolve();
        if (parent.address === null) {
          throw new Error(
            `相对地址 "${this.address}" 需要父条目 #${anchor.id}（${anchor.description}）的地址，` +
              `但它没解析出来${parent.error ? `：${parent.error}` : ''}`,
          );
        }
        base = BigInt.asUintN(64, parent.address + base);
      }
    } catch (e) {
      const msg = (e as Error).message;
      this.lastError = msg;
      this.cachedAddress = null;
      if (this.tolerant) return { address: null, error: msg };
      throw e;
    }

    // 指针偏移链：addr = readPtr(addr) + off ...（失败不吞）
    if (this.offsets.length > 0) {
      const proc = this.list.process;
      if (!proc) throw new Error('应用偏移链需要已打开的目标进程');
      let addr = base;
      for (let index = 0; index < this.offsets.length; index += 1) {
        const buf = proc.readMemory(addr, 8);
        if (buf.length < 8) {
          const msg = `偏移链解引用失败：无法读取 0x${addr.toString(16)}`;
          this.lastError = msg;
          this.cachedAddress = null;
          throw new Error(msg);
        }
        // 符号/表达式偏移（CE 的 `setOffsetText` 同样支持）：
        // 在**求值时**解析，用的是同一条地址表达式通路（符号表 + 模块缓存）。
        // ⚠️ 解析不出来必须**报错**，不能拿占位的 0 当偏移 —— 那会给出一个
        // 看起来正常、其实少了这一级的地址（CE 在这种情况下标 UnreadablePointer）。
        let offset = BigInt(this.offsets[index]);
        const expression = this.offsetExpressions.get(index);
        if (expression !== undefined) {
          try {
            offset = this.list.resolveExpression(expression);
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            const msg =
              `偏移链第 ${index + 1} 级「${expression}」解析不出来：${detail}` +
              `（CE 允许偏移写成符号/表达式，见 MemoryRecordUnit.pas:631-696；` +
              `解析不了时不给出地址）`;
            this.lastError = msg;
            this.cachedAddress = null;
            if (this.tolerant) return { address: null, error: msg };
            throw new Error(msg);
          }
        }
        addr = buf.readBigUInt64LE(0) + offset;
      }
      base = addr;
    }

    this.cachedAddress = base;
    this.lastError = null;
    return { address: base };
  }

  /** 最近一次解析结果（不重新求值） */
  get resolvedAddress(): bigint | null {
    return this.cachedAddress;
  }

  /** 最近一次错误 */
  get error(): string | null {
    return this.lastError;
  }

  /** 强制下次 resolve 重新求值 */
  invalidate(): void {
    this.cachedAddress = null;
    this.cachedBytes = null;
    for (const c of this.children) c.invalidate();
  }

  /** 读取当前值（返回字符串形式，便于显示） */
  read(): string | null {
    const { address, error } = this.resolve();
    if (address === null) {
      void error;
      return null;
    }
    const proc = this.list.process;
    if (!proc) return null;
    const width = this.byteWidth;
    if (width <= 0) return null;
    const buf = proc.readMemory(address, width);
    if (buf.length < width) return null;
    this.cachedBytes = buf;
    return this.formatBytes(buf);
  }

  /** 把原始字节格式化成显示字符串 */
  formatBytes(buf: Buffer): string {
    const t = this.variableType;
    switch (t) {
      case VariableType.Byte: {
        const v = buf[0];
        return this.formatInt(BigInt(v), 8);
      }
      case VariableType.Word: {
        const v = buf.readUInt16LE(0);
        return this.formatInt(BigInt(v), 16);
      }
      case VariableType.DWord: {
        const v = buf.readUInt32LE(0);
        return this.formatInt(BigInt(v), 32);
      }
      case VariableType.QWord:
      case VariableType.Pointer: {
        const v = buf.readBigUInt64LE(0);
        return this.formatInt(v, 64);
      }
      case VariableType.Single: {
        const v = buf.readFloatLE(0);
        return String(v);
      }
      case VariableType.Double: {
        const v = buf.readDoubleLE(0);
        return String(v);
      }
      case VariableType.String:
      case VariableType.CodePageString: {
        return buf.toString('latin1').replace(/\0.*$/, '');
      }
      case VariableType.UnicodeString: {
        return buf.toString('utf16le').replace(/\0.*$/, '');
      }
      case VariableType.ByteArray: {
        const parts: string[] = [];
        for (const b of buf) parts.push(b.toString(16).toUpperCase().padStart(2, '0'));
        return parts.join(' ');
      }
      default:
        return buf.toString('hex').toUpperCase();
    }
  }

  private formatInt(v: bigint, bits: number): string {
    if (this.binary) return '0b' + v.toString(2).padStart(bits, '0');
    if (this.hexadecimal) {
      // 与 CE 一样按最少位数显示十六进制（不补满整个宽度），仅保证偶数位
      const digits = Math.max(2, Math.ceil(v.toString(16).length / 2) * 2);
      return '0x' + v.toString(16).toUpperCase().padStart(digits, '0');
    }
    return v.toString(10);
  }

  /** 读取原始值（数值类型返回 number | bigint；字符串返回 string） */
  readValue(): number | bigint | string | null {
    const s = this.read();
    if (s === null) return null;
    switch (this.variableType) {
      case VariableType.Single:
      case VariableType.Double:
        return Number(s);
      case VariableType.QWord:
      case VariableType.Pointer:
        return this.cachedBytes ? this.cachedBytes.readBigUInt64LE(0) : BigInt(s);
      case VariableType.String:
      case VariableType.UnicodeString:
      case VariableType.CodePageString:
      case VariableType.ByteArray:
        return s;
      default:
        return Number(s);
    }
  }

  /** 写入值（字符串形式，按变量类型解析）。返回是否成功。 */
  write(value?: string): boolean {
    const v = value ?? this.userValue;
    if (v === '') return false;
    const { address } = this.resolve();
    if (address === null) return false;
    const proc = this.list.process;
    if (!proc) return false;

    const buf = this.encodeValue(v);
    if (!buf) return false;
    proc.writeMemory(address, buf);
    if (value !== undefined) this.userValue = value;
    return true;
  }

  /** 把字符串值编码成对应类型的字节 */
  encodeValue(v: string): Buffer | null {
    const t = this.variableType;
    try {
      switch (t) {
        case VariableType.Byte:
          return this.intBuffer(parseIntegerLiteral(v, this.hexadecimal).raw, 1);
        case VariableType.Word:
          return this.intBuffer(parseIntegerLiteral(v, this.hexadecimal).raw, 2);
        case VariableType.DWord:
          return this.intBuffer(parseIntegerLiteral(v, this.hexadecimal).raw, 4);
        case VariableType.QWord:
        case VariableType.Pointer:
          return this.intBuffer(parseIntegerLiteral(v, this.hexadecimal).raw, 8);
        case VariableType.Single: {
          const b = Buffer.alloc(4);
          b.writeFloatLE(parseFloatLiteral(v), 0);
          return b;
        }
        case VariableType.Double: {
          const b = Buffer.alloc(8);
          b.writeDoubleLE(parseFloatLiteral(v), 0);
          return b;
        }
        case VariableType.String:
        case VariableType.CodePageString: {
          const width = this.byteWidth;
          const b = Buffer.alloc(width);
          Buffer.from(v, 'latin1').copy(b, 0, 0, width);
          return b;
        }
        case VariableType.UnicodeString: {
          const width = this.byteWidth;
          const b = Buffer.alloc(width);
          Buffer.from(v, 'utf16le').copy(b, 0, 0, width);
          return b;
        }
        case VariableType.ByteArray: {
          const bytes = v
            .trim()
            .split(/[\s,]+/)
            .filter((x) => x !== '')
            .map((x) => parseInt(x, 16));
          if (bytes.some((x) => Number.isNaN(x))) return null;
          return Buffer.from(bytes);
        }
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  private intBuffer(value: bigint, width: number): Buffer {
    const b = Buffer.alloc(width);
    const masked = BigInt.asUintN(width * 8, value);
    if (width === 1) b.writeUInt8(Number(masked), 0);
    else if (width === 2) b.writeUInt16LE(Number(masked), 0);
    else if (width === 4) b.writeUInt32LE(Number(masked), 0);
    else b.writeBigUInt64LE(masked, 0);
    return b;
  }

  /** 用户设定的值 */
  get value(): string {
    return this.userValue;
  }
  set value(v: string) {
    this.userValue = v;
  }

  /** 是否锁定且在本次 tick 中成功写回 */
  tickFrozen(): boolean {
    if (!this.frozen || !this.active) return false;
    return this.write();
  }

  /** 转回纯数据（用于保存）。地址已在内部归一化为去引号形式。 */
  toData(): MemoryRecordData {
    const data: MemoryRecordData = {
      id: this.id,
      description: this.description,
      address: this.address,
      variableType: this.variableType,
    };
    if (this.userValue !== '') data.value = this.userValue;
    if (this.offsets.length > 0) data.offsets = this.offsets.slice();
    if (this.offsetExpressions.size > 0) {
      const expressions: Record<number, string> = {};
      for (const [index, value] of this.offsetExpressions) expressions[index] = value;
      data.offsetExpressions = expressions;
    }
    if (this.frozen) data.frozen = true;
    if (!this.active) data.active = false;
    if (this.comment) data.comment = this.comment;
    if (this.hexadecimal) data.hexadecimal = true;
    if (this.binary) data.binary = true;
    if (this.codePage) data.codePage = this.codePage;
    if (this.stringLength) data.stringLength = this.stringLength;
    if (!this.tolerant) data.tolerant = false;
    if (Object.keys(this.extra).length > 0) data.extra = { ...this.extra };
    if (this.children.length > 0) data.children = this.children.map((c) => c.toData());
    return data;
  }
}

/**
 * 地址表 —— 对齐 CE 的 TAddressList + 表级设置。
 */
export class AddressList {
  private records: MemoryRecord[] = [];
  private nextId = 1;
  private processRef: Process | null = null;
  /** 已注册符号（供地址表达式引用） */
  readonly symbols = new Map<string, bigint>();
  /**
   * 符号的**原始地址文本**（.CT 里写的是什么就保留什么）。
   *
   * 用途只有一个：`saveCheatTable` 时把用户当初写的形态原样写回去。
   * CE 只保存用户输入的 `addressstring`（`symbolhandler.pas:3714`），
   * 而模块相对形式（`game.exe+10`）一旦被换算成绝对地址写出去，
   * 对方进程重启后就**全部失效** —— 所以不能只留 `symbols` 里的 bigint。
   */
  readonly symbolSources = new Map<string, string>();
  /** 模块列表缓存；为 null 时按需重新枚举 */
  private moduleCache: Array<{ name: string; baseAddress: bigint; size: number }> | null = null;
  /** 表级注释 */
  comment = '';
  /**
   * 表版本（CE 的 `<CheatTable CheatEngineTableVersion>` 属性）。
   *
   * 默认 **45** —— 与参照源码一致（`OpenSave.pas:24` `_CurrentTableVersion=45`，
   * `:1218` CE 自己写出时用的就是它）。新建（未载入过）的表 save 时写 45，
   * 载入过的表由 `loadCheatTable` 覆盖成**载入时的版本**并原样写回。
   */
  version = 45;
  /**
   * 根级其它属性（`CheatEngineTableVersion` 之外的全部原样保留）。
   * 见 `saveCheatTable`：不保留就是**静默丢用户数据**。
   */
  rootAttributes: Record<string, string> = {};
  /** 根级未建模元素（`<Structures>` / `<LuaScript>` / …），原样保留、原样写回 */
  rootExtra: RootExtraElement[] = [];

  constructor(process?: Process | null) {
    this.processRef = process ?? null;
  }

  get process(): Process | null {
    return this.processRef;
  }

  /** 绑定/切换目标进程（会清空模块缓存与所有记录的地址缓存）。 */
  attachProcess(process: Process | null): void {
    this.processRef = process;
    this.moduleCache = null;
    for (const r of this.records) r.invalidate();
  }

  get count(): number {
    return this.records.length;
  }

  /** 按索引取记录（CE 的 getMemoryRecord(i)，0 基） */
  get(index: number): MemoryRecord | undefined {
    return this.records[index];
  }

  /** 按 id 取记录 */
  getById(id: number): MemoryRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** 按描述取记录（CE 的 getRecordWithDescription） */
  getByDescription(description: string): MemoryRecord | undefined {
    return this.records.find((r) => r.description === description);
  }

  /** 全部记录（返回浅拷贝数组） */
  all(): MemoryRecord[] {
    return this.records.slice();
  }

  /** 追加一个条目 */
  add(data: Partial<MemoryRecordData> & { address: string; variableType: VariableType }): MemoryRecord {
    const id = data.id ?? this.nextId++;
    const full: MemoryRecordData = {
      ...data,
      id,
      description: data.description ?? `记录 ${id}`,
      address: data.address,
      variableType: data.variableType,
    };
    if (data.id !== undefined && data.id >= this.nextId) this.nextId = data.id + 1;
    const rec = new MemoryRecord(full, this);
    this.records.push(rec);
    return rec;
  }

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
  remove(record: MemoryRecord | number): boolean {
    const idx = typeof record === 'number' ? record : this.records.indexOf(record);
    if (idx < 0 || idx >= this.records.length) return false;
    const [removed] = this.records.splice(idx, 1);
    if (removed.parent) {
      const ci = removed.parent.children.indexOf(removed);
      if (ci >= 0) removed.parent.children.splice(ci, 1);
    }
    return true;
  }

  /**
   * 按 `id` 删除记录（`id` 来自 `add()`，从 1 开始）。
   *
   * 与 `remove(number)` 的区别：那个按下标，这个按 id。
   * 工具层展示给用户的就是 id，所以**面向用户的删除必须走这里**。
   *
   * @returns 找到并删除则 true；id 不存在则 false
   */
  removeById(id: number): boolean {
    const rec = this.getById(id);
    if (rec === undefined) return false;
    return this.remove(rec);
  }

  /** 清空 */
  clear(): void {
    this.records = [];
    this.nextId = 1;
  }

  /** 求值上下文（供地址表达式使用） */
  evalContext(): EvalContext {
    return {
      process: this.processRef ?? undefined,
      symbols: this.symbols,
      moduleCache: this.moduleCache ?? undefined,
    };
  }

  /** 预加载模块列表缓存（可选，避免每条记录都枚举一次模块） */
  preloadModules(): void {
    if (!this.processRef) return;
    this.moduleCache = this.processRef.modules().map((m) => ({
      name: m.name,
      baseAddress: m.baseAddress,
      size: m.size,
    }));
  }

  /**
   * 注册符号。
   *
   * @param name 符号名
   * @param address 解析出的地址
   * @param addressText 可选：符号在 .CT 里的**原始文本**（用于 save 时原样写回，
   *        见 `symbolSources` 的说明）。不给时会按十六进制补一个。
   */
  registerSymbol(name: string, address: bigint, addressText?: string): void {
    this.symbols.set(name, address);
    this.symbols.set(name.toLowerCase(), address);
    if (addressText !== undefined) this.symbolSources.set(name, addressText);
  }

  /** 注销符号 */
  unregisterSymbol(name: string): void {
    this.symbols.delete(name);
    this.symbols.delete(name.toLowerCase());
    this.symbolSources.delete(name);
  }

  /** 解析一个地址表达式（会用到符号表与模块列表）。 */
  resolveExpression(expression: string): bigint {
    return resolveAddress(expression, this.evalContext());
  }

  /** 驱动一次"锁定写回"；返回成功写回的条目数。宿主自行决定调用频率。 */
  tickFrozen(): number {
    let n = 0;
    const walk = (list: MemoryRecord[]): void => {
      for (const r of list) {
        if (r.tickFrozen()) n++;
        walk(r.children);
      }
    };
    walk(this.records);
    return n;
  }

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
  }> {
    const out: Array<{
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
    }> = [];
    const walk = (list: MemoryRecord[], depth: number): void => {
      for (const r of list) {
        const { address, error } = r.resolve();
        out.push({
          id: r.id,
          description: '  '.repeat(depth) + r.description,
          address,
          addressText: address === null ? '' : '0x' + address.toString(16).toUpperCase(),
          type: r.variableType,
          value: r.read(),
          frozen: r.frozen,
          active: r.active,
          // ⚠️ 必须带上 `comment`：工具层的 `ce_cheat_table action: list` 读的就是快照，
          // 少了它备注在会话内也看不见（`MemoryRecord.comment` 明明有值）。
          comment: r.comment,
          error: error ?? null,
        });
        walk(r.children, depth + 1);
      }
    };
    walk(this.records, 0);
    return out;
  }

  /** 转成纯数据（用于保存） */
  toData(): MemoryRecordData[] {
    return this.records.map((r) => r.toData());
  }

  /** 从纯数据恢复 */
  static fromData(data: MemoryRecordData[], process?: Process | null): AddressList {
    const list = new AddressList(process ?? null);
    for (const d of data) {
      const rec = list.add(d);
      void rec;
    }
    return list;
  }
}

/* ------------------------------------------------------------------ *
 * 与扫描结果联动
 * ------------------------------------------------------------------ */

/**
 * 把扫描结果导入地址表 —— 对齐 CE「把扫描结果加入地址表」。
 */
export function addScanResults(
  list: AddressList,
  addresses: readonly bigint[],
  variableType: VariableType,
  description?: string,
): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  addresses.forEach((addr, i) => {
    out.push(
      list.add({
        address: '0x' + addr.toString(16).toUpperCase(),
        variableType,
        description: description ? `${description} ${i + 1}` : `0x${addr.toString(16).toUpperCase()}`,
      }),
    );
  });
  return out;
}

/**
 * 用一次扫描结果构建地址表条目，并把当前值填入 value —— 便于导出成可用的表。
 */
export function buildRecordsFromScan(
  list: AddressList,
  addresses: readonly bigint[],
  variableType: VariableType,
  descriptionPrefix = '扫描结果',
): MemoryRecord[] {
  const recs = addScanResults(list, addresses, variableType, descriptionPrefix);
  for (const r of recs) {
    const v = r.read();
    if (v !== null) r.value = v;
  }
  return recs;
}

export { RoundingType, ScanOption, VariableType };
