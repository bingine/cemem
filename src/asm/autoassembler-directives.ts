/**
 * Auto Assembler 的「汇编器级」指令实现。
 *
 * Cheat Engine 里这些指令**不在** autoassembler.pas，而在 `Assemblerunit.pas`
 * 的 `Assemble()` 里（见该文件 4930~5100 行的 `case tokens[0][1] of`）：
 *
 *   - `db/dw/dd/dq` —— 数据定义（Assemblerunit 的 `DB`/`DW`/`DD`/`DQ` 分支）
 *   - `nop N`       —— 多字节 NOP 填充（Assemblerunit 的 `NOP HEXVALUE` 分支）
 *   - `align N[,b]` —— 对齐填充（Assemblerunit 的 `ALIGN` 分支）
 *
 * 本移植的汇编后端是 Keystone，它**只认指令**，不认这些伪指令
 * （`db`/`align` 会直接报错，`nop 5` 会被当成 `nop` 的操作数）。
 * 因此这一层必须在 Auto Assembler 里自己做，且要**逐字节对齐 CE 的产出**。
 *
 * ## 数字字面量的进制（最容易静默出错的地方）
 *
 * CE 的 `Assemblerunit` 对 `db/dw/dd/dq/nop/align` 的参数统一走
 * `HexStrToInt`（`parsers.pas` 的 `ConvertHexStrToRealStr`），规则是：
 *
 *   - **裸数字按十六进制解释**（`db 89 01 00 00 00` 是 0x89 0x01 ...，不是十进制 89）
 *   - `#123` 才是十进制（`#` 前缀）
 *   - `-` / `+` 前缀保留符号
 *
 * 这一条**必须**保持 CE 语义：真实 CE 脚本的 `[DISABLE]` 段几乎都是
 * `db 89 01 00 00 00` 这种写法，若按十进制解析会得到完全错误的字节（89 → 0x59）。
 *
 * 作为超集，本模块额外接受 `0x` 与 `$` 前缀（CE 的 HexStrToInt 其实不接受，
 * 会返回空串然后抛异常）。
 */

import { parseAob } from '../value-codec';

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 数据定义伪指令 */
export type DataDirectiveKind = 'db' | 'dw' | 'dd' | 'dq';

/** 本模块能编码的伪指令 */
export type PseudoDirectiveKind = DataDirectiveKind | 'nop' | 'align';

/** 伪指令编码上下文 */
export interface DirectiveContext {
  /** 该行将要放置的地址（`align` 需要它） */
  address: bigint;
  /**
   * 读取目标进程 1 字节（`db ??` / `db +1` 需要）。
   * 没有目标进程时返回 null —— `db ??` 会退化成 0 并记一条警告。
   */
  readByte?: (address: bigint) => number | null;
  /** 裸数字是否按十六进制解释，默认 true（CE 行为） */
  hexDefault?: boolean;
}

/** 编码结果 */
export interface DirectiveEncodeResult {
  bytes: Buffer;
  /** 非致命问题（例如 `db ??` 在没有目标进程时按 0 处理） */
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * 数字解析
 * ------------------------------------------------------------------ */

/**
 * 按 CE 的 `HexStrToInt` 语义解析整数（裸数字 = 十六进制）。
 *
 * 支持 `#123`（十进制）、`0x1F`、`$1F`、裸 `1F`，以及 `-`/`+` 前缀。
 * 无法解析时返回 null（调用方负责给出带行号的中文错误）。
 */
export function parseCeInteger(text: string, hexDefault = true): bigint | null {
  let body = text.trim();
  if (body === '') return null;

  let sign = 1n;
  if (body[0] === '-') {
    sign = -1n;
    body = body.slice(1).trim();
  } else if (body[0] === '+') {
    body = body.slice(1).trim();
  }
  if (body === '') return null;

  try {
    // `#` 前缀 = 十进制（CE 的 escape hatch）
    if (body[0] === '#') {
      const digits = body.slice(1);
      if (!/^\d+$/.test(digits)) return null;
      return sign * BigInt(digits);
    }
    // `0x` / `$` 前缀 = 明确十六进制
    if (/^0x/i.test(body)) {
      const digits = body.slice(2);
      if (!/^[0-9a-f]+$/i.test(digits)) return null;
      return sign * BigInt('0x' + digits);
    }
    if (body[0] === '$') {
      const digits = body.slice(1);
      if (!/^[0-9a-f]+$/i.test(digits)) return null;
      return sign * BigInt('0x' + digits);
    }
    // 裸数字：CE 按十六进制（hexDefault=true），否则按十进制
    if (/^\d+$/.test(body)) {
      return hexDefault ? sign * BigInt('0x' + body) : sign * BigInt(body);
    }
    // 只含 0-9a-f 的裸串（例如 `db FF`）
    if (/^[0-9a-f]+$/i.test(body)) {
      return hexDefault ? sign * BigInt('0x' + body) : null;
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 参数切分
 * ------------------------------------------------------------------ */

/**
 * 把伪指令的参数串切成 token。
 *
 * 对齐 CE 的 `tokenize`（autoassembler.pas 383 行）的实用子集：
 *   - 分隔符：逗号、空格、制表符
 *   - 引号内的内容**不切分**（`db 'a b'` 是一个 token）
 *   - 保留引号本身（后续按字符串处理）
 */
export function splitDirectiveArguments(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === ',' || ch === ' ' || ch === '\t') {
      if (current !== '') {
        out.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current !== '') out.push(current);
  return out;
}

/* ------------------------------------------------------------------ *
 * 数据定义：db / dw / dd / dq
 * ------------------------------------------------------------------ */

/** 各数据伪指令的单元宽度 */
const DATA_WIDTHS: Record<DataDirectiveKind, number> = { db: 1, dw: 2, dd: 4, dq: 8 };

/**
 * 编码 `db/dw/dd/dq`。
 *
 * 对齐 `Assemblerunit.pas` 4964~5048 行：
 *   - `db 'abc'`  → latin1 字节（**不**反转，`AddString` 是按序拷贝）
 *   - `dw 'abc'`  → UTF-16LE（`AddWideString` 直接 copy 宽字符内存）
 *   - `db ??` / `db **` / `db *` → **读目标进程当前字节**（保持原样）
 *   - `db +1` / `db -1`        → 读目标进程当前字节后加/减
 *   - 其它 → 数字，按 CE 的十六进制语义
 *
 * 注意 `dd 'str'` / `dq 'str'` 在 CE 里会走 `HexStrToInt` 的字符分支（行为很怪），
 * 本移植直接报错，避免产生难以察觉的错误字节。
 */
export function encodeDataDirective(
  kind: DataDirectiveKind,
  args: string,
  ctx: DirectiveContext,
): DirectiveEncodeResult {
  const width = DATA_WIDTHS[kind];
  const tokens = splitDirectiveArguments(args);
  const warnings: string[] = [];
  const chunks: Buffer[] = [];

  if (tokens.length === 0) {
    throw new Error(`${kind} 需要一个或多个参数，例如 ${kind} 90 90`);
  }

  for (const token of tokens) {
    // 1) 字符串
    if (token[0] === "'" || token[0] === '"') {
      const quote = token[0];
      if (token.length < 2 || token[token.length - 1] !== quote) {
        throw new Error(`${kind} 的字符串字面量缺少收尾引号：${token}`);
      }
      const text = token.slice(1, -1);
      if (kind === 'db') {
        // latin1：CE 的 AddString 逐字节拷贝 AnsiString
        chunks.push(Buffer.from(text, 'latin1'));
      } else if (kind === 'dw') {
        chunks.push(Buffer.from(text, 'utf16le'));
      } else {
        throw new Error(`${kind} 不支持字符串字面量（CE 里该写法会得到意外的字节值）`);
      }
      continue;
    }

    // 2) 通配：读目标进程原字节（`?`、`*`、`x`、`??`、`**` 都是 CE 接受的写法）
    if (/^[?*x]{1,2}$/i.test(token)) {
      const b = readByteSafe(ctx, ctx.address + BigInt(byteCountOf(chunks)), warnings, token);
      chunks.push(encodeInteger(BigInt(b), width));
      continue;
    }

    // 3) 相对：+N / -N（基于目标进程原字节）
    if (/^[+-]/.test(token)) {
      const at = ctx.address + BigInt(byteCountOf(chunks));
      const original = readByteSafe(ctx, at, warnings, token);
      const delta = parseCeInteger(token, ctx.hexDefault ?? true);
      if (delta === null) throw new Error(`${kind} 无法解析相对偏移：${token}`);
      // CE 在 byte 上做 b:=b+j，回绕到 1 字节
      const value = ((BigInt(original) + delta) % 0x100n + 0x100n) % 0x100n;
      chunks.push(encodeInteger(value, width));
      continue;
    }

    // 4) 普通数字
    const value = parseCeInteger(token, ctx.hexDefault ?? true);
    if (value === null) {
      throw new Error(
        `${kind} 无法解析参数 "${token}"。` +
          (ctx.hexDefault === false
            ? '裸数字按十进制解释，十六进制请写 0x 前缀。'
            : 'CE 语义下裸数字按十六进制解释，十进制请写 # 前缀（例如 #1000）。'),
      );
    }
    chunks.push(encodeInteger(value, width));
  }

  return { bytes: Buffer.concat(chunks), warnings };
}

/** 取当前已累计的字节数（用于通配/相对寻址定位） */
function byteCountOf(chunks: Buffer[]): number {
  let n = 0;
  for (const c of chunks) n += c.length;
  return n;
}

/** 读目标进程 1 字节；无进程时退化为 0 并警告 */
function readByteSafe(
  ctx: DirectiveContext,
  address: bigint,
  warnings: string[],
  token: string,
): number {
  if (!ctx.readByte) {
    warnings.push(`db ${token}：没有目标进程，该字节按 0x00 处理`);
    return 0;
  }
  const b = ctx.readByte(address);
  if (b === null) {
    warnings.push(`db ${token}：地址 0x${address.toString(16)} 读取失败，该字节按 0x00 处理`);
    return 0;
  }
  return b & 0xff;
}

/** 把整数按小端写进 width 字节（超出部分截断，与 CE 的 byte()/word() 转换一致） */
function encodeInteger(value: bigint, width: number): Buffer {
  const buf = Buffer.alloc(width);
  let v = value < 0n ? value + (1n << BigInt(width * 8)) : value;
  v &= (1n << BigInt(width * 8)) - 1n;
  for (let i = 0; i < width; i++) {
    buf[i] = Number((v >> BigInt(i * 8)) & 0xffn);
  }
  return buf;
}

/* ------------------------------------------------------------------ *
 * nop N：多字节 NOP
 * ------------------------------------------------------------------ */

/**
 * CE 的多字节 NOP 表（`Assemblerunit.pas` 5065~5074 行，Intel/AMD 共用）。
 *
 * CE 只在「CPU 支持多字节 NOP」时用它，否则退化成 N 个 0x90。
 * 现代 x86 都支持，因此本移植固定用这张表；填充字节数与 CE 完全一致
 * （1→90，2→66 90，3→0F 1F 00，…… 9→66 0F 1F 84 00 00 00 00 00）。
 */
const MULTI_BYTE_NOP: Record<number, number[]> = {
  1: [0x90],
  2: [0x66, 0x90],
  3: [0x0f, 0x1f, 0x00],
  4: [0x0f, 0x1f, 0x40, 0x00],
  5: [0x0f, 0x1f, 0x44, 0x00, 0x00],
  6: [0x66, 0x0f, 0x1f, 0x44, 0x00, 0x00],
  7: [0x0f, 0x1f, 0x80, 0x00, 0x00, 0x00, 0x00],
  8: [0x0f, 0x1f, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00],
  9: [0x66, 0x0f, 0x1f, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00],
};

/** 生成 `count` 字节的 NOP 填充（count<=0 返回空） */
export function encodeNop(count: number): Buffer {
  if (!Number.isFinite(count) || count <= 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let left = Math.floor(count);
  while (left > 0) {
    const take = left > 9 ? 9 : left;
    chunks.push(Buffer.from(MULTI_BYTE_NOP[take]));
    left -= take;
  }
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ *
 * align
 * ------------------------------------------------------------------ */

/**
 * 计算对齐填充。对齐 `Assemblerunit.pas` 4938~4959 行：
 *
 * ```pascal
 * k := i - (address mod i);
 * if k = i then exit;          // 已对齐，不填
 * for ... do Add(bytes, b);    // b 默认 0
 * ```
 *
 * 注意 CE 的填充字节**默认是 0x00**（不是 0x90），第二个参数才是填充值：
 * `align 10, 90` 表示对齐到 16 字节边界并用 0x90 填充。
 */
export function encodeAlign(
  address: bigint,
  alignment: bigint,
  fillByte = 0,
): Buffer {
  if (alignment <= 0n) throw new Error(`align 的对齐值必须为正数，收到 ${alignment}`);
  const mod = ((address % alignment) + alignment) % alignment;
  if (mod === 0n) return Buffer.alloc(0);
  const pad = Number(alignment - mod);
  if (!Number.isSafeInteger(pad) || pad < 0) {
    throw new Error(`align 的填充长度 ${pad} 超出可处理范围（对齐值 ${alignment} 过大？）`);
  }
  return Buffer.alloc(pad, fillByte & 0xff);
}

/* ------------------------------------------------------------------ *
 * 伪指令识别
 * ------------------------------------------------------------------ */

/** 识别出的伪指令 */
export interface ParsedPseudoDirective {
  kind: PseudoDirectiveKind;
  /** 伪指令名之后的参数原文 */
  args: string;
}

/**
 * 判断一行是否是 `db/dw/dd/dq/nop/align` 伪指令。
 *
 * 返回 null 表示不是伪指令（交给 Keystone 汇编）。
 * 注意 `nop`（不带参数）**不算**伪指令 —— Keystone 自己能编成 0x90，
 * 保持与 `assembler.ts` 的行为一致。
 */
export function parsePseudoDirective(line: string): ParsedPseudoDirective | null {
  const m = line.match(/^([A-Za-z]+)([\s,]+([\s\S]*))?$/);
  if (!m) return null;

  const name = m[1].toLowerCase();
  const args = (m[3] ?? '').trim();

  if (name === 'db' || name === 'dw' || name === 'dd' || name === 'dq') {
    return { kind: name as DataDirectiveKind, args };
  }
  // `nop N` 只有 N 确实是数字才算填充伪指令。
  // 否则 `nop dword ptr [rax]` 这类合法指令会被误判成"填充 11 字节"
  // （CE 也是先 try HexStrToInt 失败后回退给普通汇编器）。
  if (name === 'nop' && args !== '' && firstArgumentIsInteger(args)) {
    return { kind: 'nop', args };
  }
  if (name === 'align' && args !== '' && firstArgumentIsInteger(args)) {
    return { kind: 'align', args };
  }
  return null;
}

/** 参数串的第一个 token 是否为可解析的整数（`align 10, 90` → true；`nop dword ptr [rax]` → false） */
function firstArgumentIsInteger(args: string): boolean {
  const first = splitDirectiveArguments(args)[0];
  if (first === undefined) return false;
  return parseCeInteger(first, true) !== null;
}

/**
 * 把 AOB 字符串转成伪指令用的 `db` 参数串（`aobscan` 回填原字节时用）。
 * 通配位被替换为 `??`，保留「读取原字节」语义。
 */
export function patternToDbArguments(patternText: string): string {
  const pattern = parseAob(patternText);
  return pattern
    .map((p) => {
      if (p.wildcard) return '??';
      if (p.mask === 0xff) return p.value.toString(16).padStart(2, '0');
      // 半字节通配无法用 db 表达，退化为完整字节（由调用方记警告）
      return p.value.toString(16).padStart(2, '0');
    })
    .join(' ');
}

/** 把一段内存按 `db` 参数串格式化（`readmem` 用） */
export function bytesToDbArguments(bytes: Buffer): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
