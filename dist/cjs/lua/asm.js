"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAsmApi = createAsmApi;
const assembler_1 = require("../asm/assembler");
const disassembler_1 = require("../asm/disassembler");
const marshal_1 = require("./marshal");
/** 按目标的位数选默认架构。 */
function archFor(proc) {
    if (!proc)
        return 'x64';
    try {
        return proc.isWow64() ? 'x86' : 'x64';
    }
    catch {
        return 'x64';
    }
}
/** 把字节数组转成 Lua 的 1 基字节表。 */
function bytesToTable(bytes) {
    return [...bytes].map((b) => BigInt(b));
}
/** 解析可选的架构参数（字符串或数字），非法时抛错由调用方转译。 */
function parseArch(value, fallback) {
    if (value === undefined || value === null)
        return fallback;
    const text = (typeof value === 'bigint' || typeof value === 'number' ? String(value) : String(value))
        .trim()
        .toLowerCase();
    const map = {
        x86: 'x86', i386: 'x86', '32': 'x86', '32bit': 'x86',
        x64: 'x64', x86_64: 'x64', amd64: 'x64', '64': 'x64', '64bit': 'x64',
        arm: 'arm', a32: 'arm',
        thumb: 'thumb',
        arm64: 'arm64', aarch64: 'arm64',
    };
    return map[text] ?? fallback;
}
/**
 * 构造要注册进 Lua 的函数表。
 *
 * 单独成模块（与 `aa.ts` 同款做法）以保持 api.ts 的可读性。
 */
function createAsmApi(ctx, 
/** 抛 Lua 错误的回调（api.ts 传入 marshal.raise 的等价物） */
raise, 
/** 把解析结果当地址用（整数或字符串表达式） */
resolveAddress) {
    /** 统一的汇编入口：返回字节 Buffer。 */
    const encode = (source, address, arch) => {
        try {
            return (0, assembler_1.assemble)(source, { address, arch, symbols: ctx.symbols() }).bytes;
        }
        catch (e) {
            raise(`assemble: ${(0, marshal_1.describeError)(e)}`);
        }
    };
    return {
        /**
         * `assemble(instruction [, targetAddress [, arch]])`
         *
         * 汇编**并写入**当前打开的进程，返回写入的字节数。
         * 省略 `targetAddress` 时用 `allocateMemory` 现分配一块可写内存。
         *
         * ⚠️ 这会真的改目标进程内存。只想看看编码结果请用 `assembleBytes`。
         */
        assemble(args) {
            const source = args[0] === undefined ? '' : String(args[0] ?? '');
            if (source.trim() === '')
                raise('assemble: 指令不能为空');
            const proc = ctx.currentProcess();
            if (!proc)
                raise('assemble: 尚未打开目标进程（先 openProcess）');
            let address;
            let allocated = false;
            if (args[1] === undefined || args[1] === null) {
                // 没给地址：先按「只编码一次的长度」分配一块内存
                const bytes = encode(source, 0n, parseArch(args[2], archFor(proc)));
                try {
                    address = proc.allocate(bytes.length, 0x04 /* PAGE_READWRITE */);
                    allocated = true;
                }
                catch (e) {
                    raise(`assemble: 分配内存失败 —— ${(0, marshal_1.describeError)(e)}`);
                }
                try {
                    proc.writeMemory(address, bytes);
                    return BigInt(bytes.length);
                }
                catch (e) {
                    if (allocated) {
                        try {
                            proc.free(address);
                        }
                        catch {
                            /* 忽略 */
                        }
                    }
                    raise(`assemble: 写入目标进程失败 —— ${(0, marshal_1.describeError)(e)}`);
                }
            }
            address = resolveAddress(args[1]);
            const bytes = encode(source, address, parseArch(args[2], archFor(proc)));
            try {
                proc.writeMemory(address, bytes);
                return BigInt(bytes.length);
            }
            catch (e) {
                raise(`assemble: 写入目标进程失败 —— ${(0, marshal_1.describeError)(e)}`);
            }
        },
        /**
         * `assembleBytes(instruction [, targetAddress [, arch]])`
         *
         * 只汇编、不碰目标进程，返回 1 基字节表。
         * `targetAddress` 只影响相对跳转的编码（CE 的 `assemble` 同理），
         * 省略时按 0 编码；脚本里编码 `jmp short` 之类建议显式给出。
         */
        assembleBytes(args) {
            const source = args[0] === undefined ? '' : String(args[0] ?? '');
            if (source.trim() === '')
                raise('assembleBytes: 指令不能为空');
            const address = args[1] === undefined || args[1] === null ? 0n : resolveAddress(args[1]);
            const arch = parseArch(args[2], archFor(ctx.currentProcess()));
            return bytesToTable(encode(source, address, arch));
        },
        /**
         * `disassemble(address [, count=1])`
         *
         * 读目标进程的内存并反汇编，返回 CE 风格字符串数组
         * （形如 `'00401000  E9 10 20 30 40  jmp 0x403020'`）。
         */
        disassemble(args) {
            const address = resolveAddress(args[0]);
            const count = args[1] === undefined || args[1] === null ? 1 : Number(args[1]);
            if (!Number.isInteger(count) || count <= 0) {
                raise(`disassemble: 第 2 个参数（条数）必须是正整数，收到 ${(0, marshal_1.describeValue)(args[1])}`);
            }
            const proc = ctx.currentProcess();
            if (!proc)
                raise('disassemble: 尚未打开目标进程（先 openProcess）');
            // 先读一块足够多的字节；反汇编自己会按指令长度停止
            const maxBytes = Math.min(count * 16, 0x1000);
            let buf;
            try {
                buf = proc.readMemory(address, maxBytes);
            }
            catch (e) {
                raise(`disassemble: 读取内存失败 —— ${(0, marshal_1.describeError)(e)}`);
            }
            if (buf.length === 0)
                raise('disassemble: 目标地址读不到任何字节');
            try {
                const list = (0, disassembler_1.disassemble)(buf, address, count, { arch: archFor(proc) });
                return list.map((insn) => (0, disassembler_1.formatDisassembled)(insn));
            }
            catch (e) {
                raise(`disassemble: ${(0, marshal_1.describeError)(e)}`);
            }
        },
        /**
         * `disassembleBytes(bytes [, address [, count]])`
         *
         * 反汇编一段给定的字节（1 基表或 `{0x90, 0x90}` 风格），不读目标内存。
         * 用于分析 AOB 命中的机器码。
         */
        disassembleBytes(args) {
            const src = args[0];
            const out = [];
            if (Array.isArray(src)) {
                for (const v of src) {
                    if (typeof v === 'bigint' || typeof v === 'number')
                        out.push(Number(BigInt.asUintN(8, BigInt(v))));
                }
            }
            else if (typeof src === 'string') {
                const hex = src.replace(/[^0-9a-fA-F]/g, '');
                for (let i = 0; i + 1 < hex.length; i += 2)
                    out.push(parseInt(hex.slice(i, i + 2), 16));
            }
            else {
                raise('disassembleBytes: 第 1 个参数必须是字节表或十六进制字符串');
            }
            const buf = Buffer.from(out);
            if (buf.length === 0)
                raise('disassembleBytes: 没有可反汇编的字节');
            const address = args[1] === undefined || args[1] === null ? 0n : resolveAddress(args[1]);
            const count = args[2] === undefined || args[2] === null ? 1 : Number(args[2]);
            try {
                return (0, disassembler_1.disassemble)(buf, address, count, { arch: archFor(ctx.currentProcess()) }).map((insn) => (0, disassembler_1.formatDisassembled)(insn));
            }
            catch (e) {
                raise(`disassembleBytes: ${(0, marshal_1.describeError)(e)}`);
            }
        },
    };
}
//# sourceMappingURL=asm.js.map