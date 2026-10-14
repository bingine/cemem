/**
 * Lua 侧的汇编 / 反汇编绑定。
 *
 * 把引擎层的 `assemble` / `disassemble` 包成 CE 的 Lua 全局函数：
 *
 * | Lua 函数 | 语义 |
 * | --- | --- |
 * | `assemble(instruction [, targetAddress])` | 汇编成机器码**并写入当前打开的进程** |
 * | `assembleBytes(instruction [, targetAddress])` | 只汇编，返回字节表（**不写内存**） |
 * | `disassemble(address [, count])` | 读内存并反汇编，返回 CE 风格字符串数组 |
 * | `disassembleBytes(bytes [, address [, count]])` | 反汇编给定字节（不读内存） |
 *
 * ## 与 CE 的差异
 *
 * 1. **`assemble` 默认不写内存**。CE 的 `assemble(instruction)` 会直接写进
 *    当前打开的进程；为了避免脚本一个手滑就把代码段改坏，这里把
 *    「只编码」和「写内存」拆成两个函数（`assembleBytes` / `assemble`），
 *    需要写入时显式调用 `assemble`。
 * 2. **架构自动跟随目标进程**：`targetIs64Bit()` 为假时按 x86 编码，
 *    否则按 x64 —— 与 CE 的默认行为一致。需要覆盖时用 `assembleBytes`
 *    的第 3 个参数显式指定。
 * 3. 汇编失败**抛 Lua 错误**（CE 是弹窗），可用 `pcall` 捕获。
 */
import type { Process } from '../win/process';
import type { LuaValue } from './types';
export interface LuaAsmContext {
    /** 当前已打开的目标进程（没有则 assemble 无法写内存） */
    currentProcess(): Process | null;
    /** 符号表：让 `jmp label` 这类写法能在汇编里解析 */
    symbols(): Map<string, bigint>;
}
/**
 * 构造要注册进 Lua 的函数表。
 *
 * 单独成模块（与 `aa.ts` 同款做法）以保持 api.ts 的可读性。
 */
export declare function createAsmApi(ctx: LuaAsmContext, 
/** 抛 Lua 错误的回调（api.ts 传入 marshal.raise 的等价物） */
raise: (message: string) => never, 
/** 把解析结果当地址用（整数或字符串表达式） */
resolveAddress: (value: LuaValue) => bigint): Record<string, (args: LuaValue[]) => LuaValue>;
//# sourceMappingURL=asm.d.ts.map