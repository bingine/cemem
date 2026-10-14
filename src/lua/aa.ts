/**
 * Lua 的 Auto Assembler 绑定。
 *
 * 把引擎层的 `AutoAssembler`（见 `../asm/autoassembler.ts`）包成 CE 的 Lua 全局函数：
 *
 * | Lua 函数 | 对应 CE | 返回 |
 * | --- | --- | --- |
 * | `autoAssemble(script [, enable])` | `autoAssemble` | 成功 `true`，失败 `false`（原因进 sink） |
 * | `autoAssembleCheck(script [, enable])` | `autoAssembleCheck` | 同上，但不写目标进程 |
 * | `autoAssembleError()` | —（本移植扩展） | 最近一次 AA 错误文本，无错误返回 `nil` |
 *
 * ## 符号双向流通（只使用引擎的公开 API 实现）
 *
 * - **AA → Lua**：每次执行后，把 `AutoAssembleResult.symbols` 快照灌回 Lua 的
 *   `SymbolTable`，因此脚本里 `alloc`/`label`/`aobscan`/`registersymbol`
 *   产生的名字对 Lua 的 `getAddress()` 立即可见（与 CE 一致）。
 * - **Lua → AA**：执行前把 Lua 符号表里已有的名字**做文本替换**成
 *   `0x...` 字面量。之所以用替换而不是注入符号表：`AutoAssembler` 的
 *   `symbols` 是只读快照、构造器也不接受初值，
 *   而子串替换与 `assembler.ts` 的 `symbols` 选项语义一致、结果可预测。
 *
 * ## 与 CE 的差异（有意为之）
 *
 * 1. **不抛 Lua 错误，返回布尔值**。CE 的 `autoAssemble` 失败时会弹窗；
 *    本移植遵循 Lua 惯用法返回 `false`，原因用 `autoAssembleError()` 取，
 *    避免脚本因弹窗中断。
 * 2. **`createthread` 只校验不执行**（Node 没有 `CreateRemoteThread`）。
 *    脚本不会因此失败，但也不会真的建线程；错误文本里会写明。
 * 3. **`[ENABLE]`/`[DISABLE]` 必须成对**：还原记录按**脚本原文**分桶
 *    （等价 CE 每条 memoryrecord 一份 `TDisableInfo`），
 *    因此多个脚本各自独立开关互不影响。
 * 4. **换目标进程会重建 AA 实例**：旧的 alloc 记录对新进程没有意义
 *    （那块内存已随旧进程消失）。CE 在换进程时同样会清表。
 */

import {
  AutoAssembler,
  AutoAssemblerError,
  type AutoAssembleResult,
} from '../asm/autoassembler';
import type { Process } from '../win/process';
import type { LuaValue } from './types';
import { describeError } from './marshal';
import type { ErrorSink } from './api';

/** Lua 侧需要的引擎能力 */
export interface LuaAutoAssemblerContext {
  /** 取当前已打开的目标进程（没有则语法检查模式） */
  currentProcess(): Process | null;
  /** Lua 的符号表（getAddress / registerSymbol 用的那份） */
  symbols: {
    snapshot(): Map<string, bigint>;
    mergeFrom(source: Map<string, bigint>): void;
  };
}

/**
 * Lua 的 Auto Assembler 绑定对象。
 *
 * 生命期与 LuaEngine 一致：持有一个 `AutoAssembler` 实例，
 * 这样多次 `autoAssemble` 调用之间共享 alloc 记录与还原历史
 * （`[ENABLE]` 之后才能 `[DISABLE]`）。
 */
export class LuaAutoAssembler {
  private assembler: AutoAssembler | null = null;
  private lastError: string | null = null;
  /** 最近一次同步进 Lua 符号表的条目（诊断用） */
  private synced = new Map<string, bigint>();
  /** 缓存的进程引用：换了目标进程要重建 assembler */
  private boundProcess: Process | null = null;

  constructor(private readonly ctx: LuaAutoAssemblerContext) {}

  /** 按当前进程取（必要时重建）引擎实例 */
  private engine(): AutoAssembler {
    const proc = this.ctx.currentProcess();
    if (!this.assembler || this.boundProcess !== proc) {
      this.assembler = new AutoAssembler({
        ...(proc ? { process: proc } : {}),
      });
      this.boundProcess = proc;
    }
    return this.assembler;
  }

  /** 目标进程被关闭/更换时调用，丢弃旧状态 */
  invalidate(): void {
    this.assembler = null;
    this.boundProcess = null;
    this.synced = new Map();
  }

  /** 最近一次 AA 错误（无错误返回 null） */
  getLastError(): string | null {
    return this.lastError;
  }

  /** 最近一次同步进 Lua 符号表的条目 */
  getSyncedSymbols(): ReadonlyMap<string, bigint> {
    return this.synced;
  }

  /** 执行 `autoAssemble`（真正写目标进程） */
  run(script: string, enable: boolean): boolean {
    return this.execute(script, enable, false);
  }

  /** 执行 `autoAssembleCheck`（只检查语法与编码，不写目标进程） */
  check(script: string, enable: boolean): boolean {
    return this.execute(script, enable, true);
  }

  private execute(script: string, enable: boolean, syntaxCheckOnly: boolean): boolean {
    this.lastError = null;

    if (typeof script !== 'string' || script.trim() === '') {
      this.lastError = 'autoAssemble: 脚本不能为空';
      return false;
    }

    try {
      const prepared = this.injectLuaSymbols(script);
      const result: AutoAssembleResult = this.engine().autoAssemble(prepared, {
        enable,
        syntaxCheckOnly,
      });

      // AA → Lua：把本次的符号快照同步过去，让 getAddress() 立即可见
      this.ctx.symbols.mergeFrom(result.symbols);
      this.synced = new Map(result.symbols);

      // createthread 只校验不执行 —— 明确告知
      if (result.createThreads.length > 0) {
        this.lastError =
          `注意：createthread 仅做参数校验，未创建远程线程（Node 无 CreateRemoteThread）。` +
          `地址：${result.createThreads.map((a) => '0x' + a.toString(16)).join(', ')}`;
      }
      return true;
    } catch (e) {
      this.lastError = formatAutoAssemblerError(e);
      return false;
    }
  }

  /**
   * 把 Lua 符号表里已有的名字替换成 `0x...` 字面量。
   *
   * 边界：
   *   - 只替换**独立标识符**（两侧非标识符字符），避免误伤 `0xAB` 这类字面量与寄存器名；
   *   - 跳过 AA 自己的指令关键字行（`alloc(`/`label(`/`define(`/`registersymbol(`/
   *     `aobscan*`），否则 `alloc(newmem,256)` 里的 `newmem` 会被替换成地址，
   *     而那一行的语义是"声明名字"而不是"引用地址"。
   */
  private injectLuaSymbols(script: string): string {
    const symbols = this.ctx.symbols.snapshot();
    if (symbols.size === 0) return script;

    // 名字长的优先，避免 label 先于 label2 被匹配
    const names = [...symbols.keys()].sort((a, b) => b.length - a.length);

    const shouldSkip = (line: string): boolean => {
      const t = line.trim().toLowerCase();
      return (
        /^(alloc|dealloc|realloc|globalalloc|label|define|registersymbol|unregistersymbol)\s*\(/.test(t) ||
        /^aobscan(module|region|unique)?\s*\(/.test(t) ||
        /^(kalloc|sharedalloc|createthread|include|loadbinary|readmem)\s*\(/.test(t)
      );
    };

    return script
      .split(/\r?\n/)
      .map((line) => {
        if (shouldSkip(line)) return line;
        let out = line;
        for (const name of names) {
          const addr = symbols.get(name)!;
          const re = new RegExp(`(?<![\\w.$?@])${escapeRegExp(name)}(?![\\w.$?@])`, 'gi');
          if (re.test(out)) out = out.replace(re, '0x' + addr.toString(16));
        }
        return out;
      })
      .join('\n');
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把 AutoAssemblerError 转成带行号的可读文本 */
export function formatAutoAssemblerError(e: unknown): string {
  if (e instanceof AutoAssemblerError) {
    const line = e.lineNumber !== undefined ? `第 ${e.lineNumber} 行` : '';
    const phase = e.phase ? `[${e.phase}]` : '';
    const at = line || phase ? `（${[phase, line].filter(Boolean).join(' ')}）` : '';
    return `Auto Assembler 失败${at}：${e.message}`;
  }
  if (e instanceof Error) return `Auto Assembler 失败：${e.message}`;
  return `Auto Assembler 失败：${describeError(e)}`;
}

/* ------------------------------------------------------------------ *
 * 注册到 Lua
 * ------------------------------------------------------------------ */

/** 注册进 Lua 的函数实现签名（与 api.ts 的 ApiFunction 结构兼容） */
export type LuaAaFunction = (
  args: LuaValue[],
  m: {
    argToString(args: LuaValue[], n: number, funcName: string): string;
    argToBoolean(args: LuaValue[], n: number, def?: boolean): boolean;
  },
) => LuaValue;

/** 注册结果：函数表 + 绑定对象（后者供 LuaEngine 在换进程时 invalidate） */
export interface AutoAssemblerApiBundle {
  functions: Record<string, LuaAaFunction>;
  instance: LuaAutoAssembler;
}

/**
 * 构造要注册进 Lua 的函数表。
 *
 * 单独成函数（而不是塞进 api.ts）是为了让 Lua 的 AA 绑定与引擎层保持清晰边界，
 * 也便于单测。
 */
export function createAutoAssemblerApi(
  ctx: LuaAutoAssemblerContext,
  errorSink: ErrorSink,
): AutoAssemblerApiBundle {
  const instance = new LuaAutoAssembler(ctx);

  /** 把最近错误写进 sink，便于 Lua 侧统一读取 */
  const report = (): void => {
    const msg = instance.getLastError();
    if (msg) errorSink.set(msg);
    else errorSink.clear();
  };

  const functions: Record<string, LuaAaFunction> = {
    /**
     * `autoAssemble(script [, enable]) -> boolean`
     *
     * CE 里失败会弹窗；本移植返回 `false` 并把原因写进错误 sink，
     * 用 `autoAssembleError()` 取详情。
     */
    autoAssemble(args, m): LuaValue {
      const script = m.argToString(args, 1, 'autoAssemble');
      const enable = args[1] === undefined ? true : m.argToBoolean(args, 2, true);
      const ok = instance.run(script, enable);
      report();
      return ok;
    },

    /**
     * `autoAssembleCheck(script [, enable]) -> boolean`
     *
     * 只解析与编码，不分配内存、不写目标进程，用于"能不能用"的预检。
     */
    autoAssembleCheck(args, m): LuaValue {
      const script = m.argToString(args, 1, 'autoAssembleCheck');
      const enable = args[1] === undefined ? true : m.argToBoolean(args, 2, true);
      const ok = instance.check(script, enable);
      report();
      return ok;
    },

    /**
     * `autoAssembleError() -> string | nil`
     *
     * 本移植扩展：取最近一次 AA 失败的详情（含行号）。
     * CE 用弹窗报告，脚本里拿不到文本，因此这里额外提供。
     */
    autoAssembleError(): LuaValue {
      const msg = instance.getLastError();
      return msg === null || msg === '' ? null : msg;
    },
  };

  return { functions, instance };
}
