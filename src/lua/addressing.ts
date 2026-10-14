/**
 * 地址表达式解析（CE 的 getAddress / getAddressFromName 的简化实现）。
 *
 * 支持的写法（与 CE Lua 脚本里常见的写法对齐）：
 *   1234 / 0012AB00     十六进制（CE 的地址表达式里裸数字按十六进制解释）
 *   0x7FF6A000 / $7FF6A000
 *   kernel32.dll        模块基址（大小写不敏感，可省略 .dll）
 *   kernel32.dll+1A2B   模块基址 + 偏移
 *   mySymbol+40         已注册符号 + 偏移
 *   a+b-c               多个项按 +/- 连接
 *
 * 注意：只有**字符串**里的裸数字按十六进制解释；
 * `getAddress(4096)` 传 Lua 数字时原样返回 4096。
 *
 * 不支持：括号、乘法/除法、指针解引用（CE 里靠 `[[addr]+4]` 这类写法，本移植未实现）。
 */

import type { ProcessModule } from '../win/process';
import type { LuaValue, SymbolTable } from './types';

export interface AddressResolverDeps {
  symbols: SymbolTable;
  /** 按名字找模块（大小写不敏感，可省略扩展名） */
  findModule(name: string): ProcessModule | null;
}

interface Term {
  sign: 1 | -1;
  text: string;
}

export class AddressResolver {
  constructor(private readonly deps: AddressResolverDeps) {}

  /**
   * 解析地址。number/bigint 直接返回；字符串走表达式解析。
   * 解析失败抛 Error（中文信息），由调用方决定是抛 Lua 错误还是返回 nil。
   */
  resolve(value: LuaValue): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(`地址必须是整数，收到 ${value}`);
      }
      return BigInt(value);
    }
    if (typeof value === 'string') return this.parseExpression(value);
    throw new Error(`地址必须是整数或字符串，收到 ${value === null ? 'nil' : typeof value}`);
  }

  /** 失败返回 null（对应 getAddressSafe 的语义）。 */
  tryResolve(value: LuaValue): bigint | null {
    try {
      return this.resolve(value);
    } catch {
      return null;
    }
  }

  /** 解析字符串表达式。 */
  parseExpression(expr: string): bigint {
    const source = expr.trim();
    if (source === '') throw new Error('地址表达式为空');
    const terms = this.splitTerms(source);
    if (terms.length === 0) throw new Error(`地址表达式无法解析："${expr}"`);
    let total = 0n;
    for (const term of terms) {
      const v = this.parseTerm(term.text, source);
      total += term.sign === 1 ? v : -v;
    }
    return total;
  }

  /** 按 +/- 切分表达式（不考虑括号）。 */
  private splitTerms(source: string): Term[] {
    const terms: Term[] = [];
    let sign: 1 | -1 = 1;
    let buffer = '';
    const flush = (): void => {
      const text = buffer.trim();
      if (text !== '') terms.push({ sign, text });
      buffer = '';
    };
    for (const ch of source) {
      if (ch === '+' || ch === '-') {
        flush();
        sign = ch === '+' ? 1 : -1;
      } else if (ch === ' ' || ch === '\t') {
        // 允许空格分隔，但不作为运算符
        if (buffer !== '') buffer += ch;
      } else {
        buffer += ch;
      }
    }
    flush();
    return terms;
  }

  /** 解析单项：字面量、模块名或符号。 */
  private parseTerm(raw: string, source: string): bigint {
    const text = raw.trim();
    if (text === '') throw new Error(`地址表达式 "${source}" 中有空项`);

    if (/^\$[0-9a-fA-F]+$/.test(text)) return BigInt('0x' + text.slice(1));
    if (/^0x[0-9a-fA-F]+$/i.test(text)) return BigInt(text);
    if (/^[0-9a-fA-F]+$/.test(text)) {
      // CE 的地址表达式里裸数字一律按十六进制解释
      // （`kernel32.dll+1000` 是基址 +0x1000，AOBScan 输出的 8 位串也是十六进制）
      return BigInt('0x' + text);
    }

    const symbol = this.deps.symbols.get(text) ?? this.deps.symbols.getCaseInsensitive(text);
    if (symbol !== undefined) return symbol;

    const mod = this.deps.findModule(text);
    if (mod) return mod.baseAddress;

    throw new Error(
      `无法解析地址表达式 "${source}" 中的 "${text}"：既不是数字，也不是已注册符号或模块名`,
    );
  }
}
