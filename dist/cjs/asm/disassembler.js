"use strict";
/**
 * 反汇编器（x86 / x64 / ARM / Thumb / ARM64）—— 输出对齐 Cheat Engine 的
 * `TLastDisassembleData`。
 *
 * 后端是 Capstone（见 `backend.ts` 里关于"CE 自己也用 binutils 而非手写解码器"的说明）。
 * 本文件负责把 Capstone 的原始结果加工成 CE 需要的那套字段与文本格式。
 *
 * CE 的字段定义见 `lastdisassembledata.pas` 的 `TLastDisassembleData`：
 *   address / prefix / opcode / parameters / description / Bytes /
 *   SeperatorCount+Seperators / modrmValue / parameterValue /
 *   datasize / isfloat / isfloat64 / hasSib / sibIndex / sibScaler /
 *   isjump / iscall / isret / isrep / isconditionaljump / riprelative
 *   / Disassembler（dcX86 / dcArm / dcArm64 / dcThumb）
 *
 * ## 文本格式
 * CE 在 binutils 分支下产出 `"地址 - 字节 - 操作码 参数"`。
 * 本模块的 `formatDisassembled` 产同样形状的字符串，同时把 opcode / parameters
 * 分开保留（CE 内部也是分开存的，显示时才拼）。
 *
 * ## 多架构差异（这里是最容易出错的地方）
 *
 * | 项目 | x86/x64 | ARM/Thumb | ARM64 |
 * | --- | --- | --- | --- |
 * | 指令长度 | 1–15 字节，可变 | 4（Thumb 2/4） | 4 |
 * | 前缀 | `rep`/`lock`/段前缀 | 无 | 无 |
 * | 条件执行 | `jcc` 助记符（7x/0F 8x） | **指令后缀**（`moveq`/`addne`） | `b.eq` 助记符 |
 * | 返回 | `ret`/`retf`/`iret` | `bx lr`/`pop {...,pc}`/`mov pc,lr` | `ret` |
 * | 调用 | `call` | `bl`/`blx` | `bl`/`blr` |
 * | 寄存器 | `rax`/`eax`/`al`… | `r0`–`r15`、`sp`/`lr`/`pc` | `x0`–`x30`、`w0`–`w30`、`sp`/`xzr`/`wzr` |
 * | RIP 相对 | 有（`[rip+disp]`） | 无 | 有（`adrp`/`ldr xN, [pc,...]`、`b`/`bl` 的 PC 相对） |
 *
 * ## 已知限制
 * `capstone-wasm` 不暴露 detail（`readInsn` 是私有的），因此拿不到
 * "操作数类型/寄存器使用/内存操作数宽度"等结构信息。
 * 本模块改用**助记符表**判定流程控制与数据宽度，对主流指令足够；
 * 冷门指令会被标成 `isjump=false`（宁可少标，不要错标）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisassemblerClass = exports.DisasmValueType = void 0;
exports.disassemble = disassemble;
exports.disassembleOne = disassembleOne;
exports.disassembleAt = disassembleAt;
exports.alignmentOf = alignmentOf;
exports.formatBytes = formatBytes;
exports.formatDisassembled = formatDisassembled;
exports.instructionText = instructionText;
exports.splitDisassembledString = splitDisassembledString;
exports.branchTarget = branchTarget;
const backend_1 = require("./backend");
/* ------------------------------------------------------------------ *
 * 输出类型
 * ------------------------------------------------------------------ */
/** 值类型提示，对齐 CE 的 TDisAssemblerValueType */
var DisasmValueType;
(function (DisasmValueType) {
    DisasmValueType[DisasmValueType["None"] = 0] = "None";
    DisasmValueType[DisasmValueType["Address"] = 1] = "Address";
    DisasmValueType[DisasmValueType["Value"] = 2] = "Value";
})(DisasmValueType || (exports.DisasmValueType = DisasmValueType = {}));
/** 反汇编器类型，对齐 CE 的 TDisassemblerClass */
var DisassemblerClass;
(function (DisassemblerClass) {
    DisassemblerClass["X86"] = "dcX86";
    DisassemblerClass["Arm"] = "dcArm";
    DisassemblerClass["Arm64"] = "dcArm64";
    DisassemblerClass["Thumb"] = "dcThumb";
})(DisassemblerClass || (exports.DisassemblerClass = DisassemblerClass = {}));
/* ------------------------------------------------------------------ *
 * 各架构的流程控制判定表
 *
 * Capstone-wasm 不给分组，所以按助记符判定。宁可少标也不要错标。
 * ------------------------------------------------------------------ */
/* —— x86 —— */
const X86_UNCONDITIONAL_JUMPS = new Set(['jmp', 'ljmp', 'jmpf']);
const X86_CONDITIONAL_JUMPS = new Set([
    'ja', 'jae', 'jb', 'jbe', 'jc', 'je', 'jg', 'jge', 'jl', 'jle', 'jna', 'jnae',
    'jnb', 'jnbe', 'jnc', 'jne', 'jng', 'jnge', 'jnl', 'jnle', 'jno', 'jnp', 'jns',
    'jnz', 'jo', 'jp', 'jpe', 'jpo', 'js', 'jz',
    'jcxz', 'jecxz', 'jrcxz',
    'loop', 'loope', 'loopne', 'loopz', 'loopnz',
]);
const X86_CALLS = new Set(['call', 'lcall', 'callf']);
const X86_RETURNS = new Set(['ret', 'retf', 'iret', 'iretd', 'iretq', 'sysret', 'sysexit']);
const X86_REP_PREFIXES = new Set(['rep', 'repe', 'repz', 'repne', 'repnz']);
/* —— ARM（A32 / Thumb）——

 * ARM 的"条件跳转"有两条完全不同的路：
 *   1. 专门的跳转指令 `b` + 条件后缀（`beq`/`bne`…）
 *   2. **几乎所有指令都带条件后缀**（`moveq r0,r1`）—— 严格说这是"条件执行"而非跳转，
 *      但 CE 把它归到 isconditionaljump（`disassembler.pas` 对 ARM 的处理）。
 *      因此这里只把**跳转类**带后缀的算作 isConditionalJump，
 *      其它带后缀的只填 `conditionCode`，不置 isConditionalJump ——
 *      否则 `moveq` 会被误报成条件跳转，界面会乱。
 */
const ARM_CONDITION_SUFFIXES = [
    'eq', 'ne', 'cs', 'hs', 'cc', 'lo', 'mi', 'pl', 'vs', 'vc',
    'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al',
];
/** ARM 跳转族基名（去掉条件后缀后判断） */
const ARM_JUMP_BASES = new Set(['b', 'bx', 'bl', 'blx', 'cbz', 'cbnz', 'tbb', 'tbh']);
/** ARM 无条件返回/跳转（按完整助记符） */
const ARM_RETURNS = new Set(['bx', 'bxeq', 'bxne', 'bxls', 'bxge', 'bxlt', 'bxgt', 'bxle']);
/* —— ARM64 —— */
const ARM64_UNCONDITIONAL_JUMPS = new Set(['b', 'br']);
const ARM64_CONDITIONAL_JUMPS = new Set(['cbz', 'cbnz', 'tbz', 'tbnz']);
const ARM64_CALLS = new Set(['bl', 'blr']);
const ARM64_RETURNS = new Set(['ret', 'eret']);
/** ARM64 的 `b.eq` 之类：Capstone 输出 `b.eq`，基名是 `b` */
const ARM64_COND_SUFFIX_RE = /\.(eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)$/;
/* —— 浮点提示 —— */
/** x86 单精度 */
const X86_FLOAT32_HINT = /\b(movss|addss|subss|mulss|divss|sqrtss|minss|maxss|cmpss|comiss|ucomiss)\b/i;
/** x86 双精度 */
const X86_FLOAT64_HINT = /\b(movsd|addsd|subsd|mulsd|divsd|sqrtsd|minsd|maxsd|cmpsd|comisd|ucomisd)\b/i;
/** ARM/ARM64 单精度：寄存器 `s0`–`s31` */
const ARM_FLOAT32_HINT = /\bs\d+\b/i;
/** ARM/ARM64 双精度：寄存器 `d0`–`d31` */
const ARM_FLOAT64_HINT = /\bd\d+\b/i;
/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */
/**
 * 反汇编内存中的一段代码。
 *
 * @param code 机器码缓冲区
 * @param address 该缓冲区在目标进程中的地址
 * @param maxInstructions 最多解多少条，默认 1
 * @param options 架构/字节序
 */
function disassemble(code, address, maxInstructions = 1, options = {}) {
    if (code.length === 0) {
        throw new backend_1.AsmBackendError('反汇编失败：给定的代码缓冲区为空');
    }
    const arch = options.arch ?? (0, backend_1.archFromBitness)(options.bitness);
    const endianness = options.endianness ?? 'little';
    const raws = (0, backend_1.disassembleRaw)(code, { address, arch, endianness, maxInstructions });
    return raws.map((raw) => convert(raw, arch));
}
/** 反汇编一条指令 */
function disassembleOne(code, address, options = {}) {
    const list = disassemble(code, address, 1, options);
    if (list.length === 0) {
        const arch = options.arch ?? (0, backend_1.archFromBitness)(options.bitness);
        throw new backend_1.AsmBackendError(`反汇编失败：在地址 0x${address.toString(16)} 处无法解码出 ${arch} 指令` +
            `（字节 ${code.subarray(0, 16).toString('hex')}）`);
    }
    return list[0];
}
/**
 * 从目标进程读内存并反汇编一条。
 *
 * 读取长度按架构取：x86 最长指令 15 字节（读 16 留余量），
 * ARM/ARM64 定长 4 字节（读 16 同样够用，且便于 Thumb 的 4 字节指令）。
 */
function disassembleAt(readMemory, address, options = {}) {
    const buf = readMemory(address, 16);
    if (buf.length === 0) {
        throw new backend_1.AsmBackendError(`反汇编失败：无法读取地址 0x${address.toString(16)} 的内存`);
    }
    return disassembleOne(buf, address, options);
}
/** 按架构取"对齐步长"（用于在解不出指令时安全推进） */
function alignmentOf(arch) {
    return (0, backend_1.architectureInfo)(arch).alignment;
}
/* ------------------------------------------------------------------ *
 * 转换
 * ------------------------------------------------------------------ */
function convert(raw, arch) {
    const info = (0, backend_1.architectureInfo)(arch);
    const mnemonic = raw.mnemonic.toLowerCase();
    const operands = raw.operands.trim();
    if (info.family === 'x86')
        return convertX86(raw, arch, info, mnemonic, operands);
    if (info.family === 'arm')
        return convertArm(raw, arch, info, mnemonic, operands);
    return convertArm64(raw, arch, info, mnemonic, operands);
}
/* —— x86 —— */
function convertX86(raw, arch, info, mnemonic, operands) {
    // 前缀与操作码分离：Capstone 把 rep/lock 之类并进 mnemonic，这里拆到 prefix
    let prefix = '';
    let opcode = mnemonic;
    const spaceIdx = mnemonic.indexOf(' ');
    if (spaceIdx > 0) {
        prefix = mnemonic.slice(0, spaceIdx);
        opcode = mnemonic.slice(spaceIdx + 1);
    }
    const isRep = X86_REP_PREFIXES.has(prefix) || X86_REP_PREFIXES.has(mnemonic);
    const isJump = X86_UNCONDITIONAL_JUMPS.has(opcode) || X86_CONDITIONAL_JUMPS.has(opcode);
    const isConditionalJump = X86_CONDITIONAL_JUMPS.has(opcode);
    const isCall = X86_CALLS.has(opcode);
    const isRet = X86_RETURNS.has(opcode);
    const dataSize = inferX86DataSize(operands, opcode);
    const isFloat = X86_FLOAT32_HINT.test(opcode) || X86_FLOAT32_HINT.test(operands);
    const isFloat64 = X86_FLOAT64_HINT.test(opcode) || X86_FLOAT64_HINT.test(operands);
    const ripRelative = detectRipRelative(operands);
    const hasSib = /\[[^\]]*(\*|\+ *r[a-z0-9]+ *\+)/i.test(operands);
    const parameterValue = extractDisplacement(operands);
    return {
        address: raw.address,
        prefix,
        prefixSize: prefix ? prefix.length : 0,
        opcode,
        suffix: '',
        parameters: operands,
        description: '',
        bytes: splitBytes(raw.bytes),
        separators: computeSeparators(raw.bytes.length, prefix, hasSib),
        separatorCount: 0,
        modrmValueType: parameterValue !== null ? DisasmValueType.Address : DisasmValueType.None,
        modrmValue: parameterValue ?? 0n,
        parameterValueType: parameterValue !== null ? DisasmValueType.Value : DisasmValueType.None,
        parameterValue: parameterValue ?? 0n,
        dataSize,
        isFloat: isFloat && !isFloat64,
        isFloat64,
        hasSib,
        sibIndex: -1,
        sibScaler: 0,
        isJump,
        isCall,
        isRet,
        isRep,
        isConditionalJump,
        conditionCode: x86ConditionCode(opcode),
        ripRelative,
        is64Bit: info.is64Bit,
        arch,
        disassemblerClass: DisassemblerClass.X86,
        mnemonic,
        size: raw.size,
    };
}
/** 从 x86 的 jcc 助记符里取条件码（`je`→`e`、`jne`→`ne`） */
function x86ConditionCode(opcode) {
    if (!X86_CONDITIONAL_JUMPS.has(opcode))
        return '';
    const cc = opcode.replace(/^j/, '').replace(/^loop/, '');
    return cc === opcode ? '' : cc;
}
/** 从操作数文本推断 x86 数据宽度（字节） */
function inferX86DataSize(operands, opcode) {
    // 注意顺序与边界：`qword ptr` 里包含子串 `word ptr`，
    // 若先匹配 `word ptr` 会把 qword 误判成 2 字节（踩过）。
    // 因此用一次性统一匹配，长的放前面，等价于"最长优先"。
    const ptrMatch = operands.match(/\b(byte|word|dword|qword|xmmword|ymmword|zmmword|tbyte)\s+ptr\b/i);
    if (ptrMatch) {
        switch (ptrMatch[1].toLowerCase()) {
            case 'byte':
                return 1;
            case 'word':
                return 2;
            case 'dword':
                return 4;
            case 'qword':
                return 8;
            case 'tbyte':
                return 10;
            case 'xmmword':
                return 16;
            case 'ymmword':
                return 32;
            case 'zmmword':
                return 64;
        }
    }
    if (/\b(r\d+b|spl|bpl|sil|dil|al|ah|bl|bh|cl|ch|dl|dh)\b/i.test(operands))
        return 1;
    if (/\b(r\d+w|ax|bx|cx|dx|si|di|bp|sp)\b/i.test(operands))
        return 2;
    if (/\b(r\d+d|eax|ebx|ecx|edx|esi|edi|ebp|esp)\b/i.test(operands))
        return 4;
    if (/\b(r\d+|rax|rbx|rcx|rdx|rsi|rdi|rbp|rsp)\b/i.test(operands))
        return 8;
    if (/\bxmm\d+\b/i.test(operands))
        return 16;
    if (/\bymm\d+\b/i.test(operands))
        return 32;
    const suffix = opcode.match(/(b|w|d|q)$/i);
    if (suffix) {
        switch (suffix[1].toLowerCase()) {
            case 'b':
                return 1;
            case 'w':
                return 2;
            case 'd':
                return 4;
            case 'q':
                return 8;
        }
    }
    return 0;
}
/* —— ARM（A32 / Thumb）—— */
function convertArm(raw, arch, info, mnemonic, operands) {
    // ARM 的条件码是助记符后缀，且**不是**所有后缀都是条件码
    // （例如 `b` 是跳转、`bl` 是调用、`blx`、`bx`、`cbz` 这些带 b/l/x 的都不是条件码）。
    const { base, cond } = splitArmCondition(mnemonic);
    const isJump = ARM_JUMP_BASES.has(base) && base !== 'bl' && base !== 'blx';
    const isCall = base === 'bl' || base === 'blx';
    const isRet = detectArmReturn(base, cond, operands);
    const isConditionalJump = isJump && cond !== '' && cond !== 'al';
    const dataSize = inferArmDataSize(operands, base);
    const isFloat = ARM_FLOAT32_HINT.test(operands) && !ARM_FLOAT64_HINT.test(operands);
    const isFloat64 = ARM_FLOAT64_HINT.test(operands);
    const parameterValue = extractDisplacement(operands);
    return {
        address: raw.address,
        prefix: '',
        prefixSize: 0,
        opcode: mnemonic,
        suffix: cond ? `.${cond}` : '',
        parameters: operands,
        description: '',
        bytes: splitBytes(raw.bytes),
        separators: [0],
        separatorCount: 0,
        modrmValueType: parameterValue !== null ? DisasmValueType.Address : DisasmValueType.None,
        modrmValue: parameterValue ?? 0n,
        parameterValueType: parameterValue !== null ? DisasmValueType.Value : DisasmValueType.None,
        parameterValue: parameterValue ?? 0n,
        dataSize,
        isFloat,
        isFloat64,
        hasSib: false,
        sibIndex: -1,
        sibScaler: 0,
        isJump,
        isCall,
        isRet,
        isRep: false,
        isConditionalJump,
        conditionCode: cond,
        // ARM 无 RIP 相对寻址；PC 相对字面量由 Capstone 直接给出绝对地址，故记 -1
        ripRelative: -1,
        is64Bit: info.is64Bit,
        arch,
        disassemblerClass: arch === 'thumb' ? DisassemblerClass.Thumb : DisassemblerClass.Arm,
        mnemonic,
        size: raw.size,
    };
}
/**
 * 拆出 ARM 的条件后缀。
 *
 * 难点：`bl`、`bx`、`blx`、`cbz` 里的 `b`/`l`/`x`/`z` 不是条件码。
 * 做法是先从**已知的条件后缀表**里匹配去掉后缀后的基名，
 * 并且要求基名非空。
 */
function splitArmCondition(mnemonic) {
    // 先从完整助记符里试去掉条件后缀
    for (const cond of ARM_CONDITION_SUFFIXES) {
        if (mnemonic.length > cond.length && mnemonic.endsWith(cond)) {
            const base = mnemonic.slice(0, -cond.length);
            // 排除把 `bx`/`bl`/`cbz` 误拆的情况：基名必须以字母结尾且不在已知非条件集合里
            if (base.length > 0 && !NON_CONDITION_BASES.has(base)) {
                return { base, cond };
            }
        }
    }
    return { base: mnemonic, cond: '' };
}
/**
 * 这些基名的结尾字母看起来像条件码，但**拆掉后剩下的基名**是指令本身的一部分，
 * 不能被 `splitArmCondition` 当成条件后缀处理。
 *
 * 注意：**不能把 `b` 放进来**。`b` 是合法的跳转基名，
 * `beq` 正是 `b` + 条件码 `eq`，把它排除会导致 `beq`/`bne` 全都被当成未知指令
 * （isJump=false、条件码为空）—— 这是踩过的 bug。
 * 这里列的是"拆完之后不该被接受"的基名，例如 `bxq` 拆成 `bx`+`q` 要拒绝。
 */
const NON_CONDITION_BASES = new Set([
    'bl', 'bx', 'blx', 'cbz', 'cbnz', 'tbb', 'tbh',
    'add', 'sub', 'and', 'orr', 'eor', 'mul', 'mla', 'mls',
    'ldr', 'ldrb', 'ldrh', 'ldrsb', 'ldrsh', 'ldrd',
    'str', 'strb', 'strh', 'strd',
    'push', 'pop', 'svc', 'nop', 'bkpt', 'clz', 'rev', 'sbfx', 'ubfx',
]);
/**
 * 判断 ARM 指令是否为返回。
 *
 * ARM 没有 x86 那样的 `ret`，返回是靠三种惯用写法：
 *   - `bx lr` / `bx<cond> lr`
 *   - `pop {..., pc}`（函数尾弹栈返回）
 *   - `mov pc, lr`
 */
function detectArmReturn(base, cond, operands) {
    const full = cond ? `${base}${cond}` : base;
    if (full === 'bx' && /(^|[\s,{])lr([\s,}]|$)/i.test(operands))
        return true;
    if (full === 'mov' && /^\s*pc\s*,\s*lr\s*$/i.test(operands))
        return true;
    if (full === 'pop' && /\bpc\b/i.test(operands))
        return true;
    if (base === 'ldm' && /\bpc\b/i.test(operands))
        return true;
    return false;
}
/** 从操作数推断 ARM 数据宽度 */
function inferArmDataSize(operands, base) {
    // 加载/存储指令的宽度由助记符后缀决定（arm 的惯例）
    if (/^(ldr|str)b$/.test(base))
        return 1;
    if (/^(ldr|str)h$/.test(base))
        return 2;
    if (/^(ldr|str)sb$/.test(base))
        return 1;
    if (/^(ldr|str)sh$/.test(base))
        return 2;
    if (/^(ldr|str)d$/.test(base))
        return 8;
    // ldm/stm 是块操作，没有单一宽度
    if (/^(ldm|stm|push|pop)/.test(base))
        return 0;
    // 浮点寄存器宽度
    if (/\bs\d+\b/i.test(operands))
        return 4;
    if (/\bd\d+\b/i.test(operands))
        return 8;
    if (/\bq\d+\b/i.test(operands))
        return 16;
    // 普通寄存器
    if (/\b(r\d+|sp|lr|pc)\b/i.test(operands))
        return 4;
    // 纯立即数运算（如 `add r0, r0, #1`）：按目标寄存器走，上面已覆盖
    return 0;
}
/* —— ARM64（AArch64）—— */
function convertArm64(raw, arch, info, mnemonic, operands) {
    // Capstone 输出 `b.eq` 这种带点后缀；为了与 x86 的 jcc 形态统一，
    // 这里拆成 opcode='b' + suffix='.eq'，并据此标记条件跳转。
    let base = mnemonic;
    let suffix = '';
    const dot = mnemonic.indexOf('.');
    if (dot > 0) {
        base = mnemonic.slice(0, dot);
        suffix = mnemonic.slice(dot);
    }
    const condMatch = suffix.match(ARM64_COND_SUFFIX_RE);
    const cond = condMatch ? condMatch[1] : '';
    const isJump = ARM64_UNCONDITIONAL_JUMPS.has(base) ||
        ARM64_CONDITIONAL_JUMPS.has(base) ||
        (base === 'b' && cond !== '');
    const isConditionalJump = ARM64_CONDITIONAL_JUMPS.has(base) || (base === 'b' && cond !== '' && cond !== 'al');
    const isCall = ARM64_CALLS.has(base);
    const isRet = ARM64_RETURNS.has(base);
    const dataSize = inferArm64DataSize(operands, base);
    const isFloat = ARM_FLOAT32_HINT.test(operands) && !ARM_FLOAT64_HINT.test(operands);
    const isFloat64 = ARM_FLOAT64_HINT.test(operands);
    // ARM64 的 PC 相对：adrp / adr / ldr xN,[pc,...] / b / bl
    const isPcRelative = base === 'adrp' ||
        base === 'adr' ||
        base === 'b' ||
        base === 'bl' ||
        /\bpc\b/i.test(operands);
    const parameterValue = extractDisplacement(operands);
    return {
        address: raw.address,
        prefix: '',
        prefixSize: 0,
        opcode: base,
        suffix,
        parameters: operands,
        description: '',
        bytes: splitBytes(raw.bytes),
        separators: [0],
        separatorCount: 0,
        modrmValueType: parameterValue !== null ? DisasmValueType.Address : DisasmValueType.None,
        modrmValue: parameterValue ?? 0n,
        parameterValueType: parameterValue !== null ? DisasmValueType.Value : DisasmValueType.None,
        parameterValue: parameterValue ?? 0n,
        dataSize,
        isFloat,
        isFloat64,
        hasSib: false,
        sibIndex: -1,
        sibScaler: 0,
        isJump,
        isCall,
        isRet,
        isRep: false,
        isConditionalJump,
        conditionCode: cond,
        // PC 相对的目标由 Capstone 直接给出绝对地址；下标按"操作数里出现 pc/相对"记 0
        ripRelative: isPcRelative ? 0 : -1,
        is64Bit: info.is64Bit,
        arch,
        disassemblerClass: DisassemblerClass.Arm64,
        mnemonic,
        size: raw.size,
    };
}
/** 从操作数推断 ARM64 数据宽度 */
function inferArm64DataSize(operands, base) {
    // 浮点/SIMD 寄存器优先（`s0`/`d0`/`q0`/`v0`）
    if (/\bs\d+\b/i.test(operands))
        return 4;
    if (/\bd\d+\b/i.test(operands))
        return 8;
    if (/\bq\d+\b/i.test(operands))
        return 16;
    if (/\bv\d+\.\d*b\b/i.test(operands))
        return 8;
    // 栈对操作 stp/ldp 的宽度由寄存器前缀决定
    if (/\b[xw]\d+\b/i.test(operands)) {
        // 取第一个寄存器判断
        const m = operands.match(/\b([xw])(\d+)\b/i);
        if (m)
            return m[1].toLowerCase() === 'x' ? 8 : 4;
    }
    if (/\b(w|x)zr\b/i.test(operands))
        return operands.includes('xzr') ? 8 : 4;
    if (/\bsp\b/i.test(operands)) {
        // `stp x29, x30, [sp, #-16]!` 之类：看另一个寄存器
        if (/\bx\d+\b/i.test(operands))
            return 8;
        if (/\bw\d+\b/i.test(operands))
            return 4;
    }
    // 无寄存器信息的加载/存储（少见）：按 ldrb/strb 之类后缀猜
    if (/b$/.test(base) && /^(ldr|str)/.test(base))
        return 1;
    if (/h$/.test(base) && /^(ldr|str)/.test(base))
        return 2;
    return 0;
}
/* ------------------------------------------------------------------ *
 * 公共小工具
 * ------------------------------------------------------------------ */
/** CE 的 Bytes 是"每个字节一个元素的数组"，这里按字节拆开 */
function splitBytes(bytes) {
    const out = [];
    for (const b of bytes)
        out.push(Buffer.from([b]));
    return out;
}
/**
 * 计算字节分隔点。
 *
 * x86：CE 用 `Seperators` 记录 前缀/操作码/modrm/sib/额外 的边界下标。
 * 本移植没有完整编码结构，给出**保守**分界（单调递增、不越界），界面分段不会错位。
 * ARM/ARM64：指令是整体编码，只给 `[0]`。
 */
function computeSeparators(size, prefix, hasSib) {
    const prefixBytes = prefix ? (prefix.length > 3 ? 2 : 1) : 0;
    const seps = [0];
    if (prefixBytes > 0 && prefixBytes < size)
        seps.push(prefixBytes);
    const opcodeAt = Math.min(prefixBytes + 1, size);
    if (!seps.includes(opcodeAt))
        seps.push(opcodeAt);
    if (hasSib) {
        const sibAt = Math.min(size - 1, opcodeAt + 1);
        if (sibAt > seps[seps.length - 1])
            seps.push(sibAt);
    }
    return seps;
}
/**
 * 找出 RIP 相对操作数在字节数组里的下标；不是则返回 -1。
 *
 * 说明：Capstone 的 MODRM 字节位置随前缀长度变化，本移植不做完整指令编码解析，
 * 因此返回"相对指令起点"的近似下标（x64 下 RIP 相对的 ModRM 通常紧跟操作码）。
 */
function detectRipRelative(operands) {
    if (operands.toLowerCase().indexOf('rip') < 0)
        return -1;
    return 3;
}
/**
 * 抽取操作数里的位移/绝对地址值（十六进制 `0x...`、十进制，或 `#0x...`）。
 *
 * ARM 的立即数写作 `#1` / `#0x10`，偏移写作 `[sp, #-16]`，这里都覆盖。
 */
function extractDisplacement(operands) {
    // 优先取括号内的值（内存操作数）
    const inBracket = operands.match(/\[[^\]]*?(#?-?(?:0x)?[0-9a-f]+)\s*\]?/i);
    if (inBracket) {
        const v = parseNumeric(inBracket[1]);
        if (v !== null)
            return v;
    }
    // ARM 的立即数 `#0x1234`
    const hash = operands.match(/#(-?(?:0x)?[0-9a-f]+)\b/i);
    if (hash) {
        const v = parseNumeric(hash[1]);
        if (v !== null)
            return v;
    }
    // 跳转/调用的目标 `0x...`
    const target = operands.match(/\b(0x[0-9a-f]+)\b/i);
    if (target)
        return parseNumeric(target[1]);
    return null;
}
function parseNumeric(text) {
    const t = text.replace(/^#/, '').trim();
    try {
        if (/^-?0x[0-9a-f]+$/i.test(t)) {
            const neg = t.startsWith('-');
            const v = BigInt(neg ? t.slice(1) : t);
            return neg ? -v : v;
        }
        if (/^-?\d+$/.test(t))
            return BigInt(t);
        return null;
    }
    catch {
        return null;
    }
}
/* ------------------------------------------------------------------ *
 * 格式化（CE 风格）
 * ------------------------------------------------------------------ */
/** 把字节数组格式化成 `48 8B 05 10 20 30 40`（大写、空格分隔） */
function formatBytes(bytes) {
    const arr = Buffer.isBuffer(bytes) ? [bytes] : bytes;
    return arr
        .map((b) => b.toString('hex').toUpperCase().padStart(2, '0'))
        .join(' ');
}
/**
 * 格式化为 CE 风格的完整行：`地址 - 字节 - 操作码 参数`。
 *
 * 对齐 `disassembler.pas` 里 binutils 分支的写法。注意 CE 在字节与 ` - `
 * 之间**多一个空格**（逐字节拼接时末尾留了空格），本函数保留这一细节。
 */
function formatDisassembled(insn, options = {}) {
    const width = options.addressWidth ?? (0, backend_1.architectureInfo)(insn.arch).addressWidth;
    const parts = [];
    if (options.showAddress !== false) {
        parts.push(insn.address.toString(16).toUpperCase().padStart(width, '0'));
    }
    if (options.showBytes !== false) {
        const bytes = formatBytes(insn.bytes);
        parts.push(bytes.length > 0 ? bytes + ' ' : '');
    }
    const head = insn.suffix && insn.suffix.startsWith('.') && insn.opcode === 'b'
        ? `${insn.opcode}${insn.suffix}`
        : insn.opcode;
    const text = insn.parameters ? `${head} ${insn.parameters}` : head;
    parts.push(text);
    return parts.join(' - ');
}
/**
 * 取出一条指令的**完整文本**（含前缀与后缀），可用于重新汇编。
 *
 * 为什么需要单独的函数：
 *   - x86：CE 把 `rep`/`lock` 前缀单独存在 `prefix` 字段，
 *     只用 `opcode + parameters` 会丢掉 `F3`/`F2`。
 *   - ARM：条件码在助记符里，本模块已把它并回 `opcode`，
 *     但 ARM64 的 `.eq` 后缀需要补上。
 */
function instructionText(insn) {
    let head;
    if (insn.arch === 'arm64' && insn.suffix) {
        head = `${insn.opcode}${insn.suffix}`;
    }
    else if (insn.prefix) {
        head = `${insn.prefix} ${insn.opcode}`;
    }
    else {
        head = insn.opcode;
    }
    return insn.parameters ? `${head} ${insn.parameters}` : head;
}
/**
 * 把 CE 风格的整行拆回各段（对齐 `disassembler.pas` 的 `splitDisassembledString`）。
 */
function splitDisassembledString(disassembled) {
    const parts = disassembled.split(' - ');
    if (parts.length >= 3) {
        const [address, bytes, ...rest] = parts;
        const text = rest.join(' - ').trim();
        const sp = text.indexOf(' ');
        return {
            address: address.trim(),
            bytes: bytes.trim(),
            opcode: sp >= 0 ? text.slice(0, sp) : text,
            parameters: sp >= 0 ? text.slice(sp + 1).trim() : '',
        };
    }
    const text = disassembled.trim();
    const sp = text.indexOf(' ');
    return {
        address: '',
        bytes: '',
        opcode: sp >= 0 ? text.slice(0, sp) : text,
        parameters: sp >= 0 ? text.slice(sp + 1).trim() : '',
    };
}
/**
 * 计算跳转/调用的目标地址（非流程指令返回 null）。
 *
 * 覆盖形态：
 *   - x86：`0x...`
 *   - ARM：`#0x...`（Capstone 对 ARM 分支通常直接给绝对地址）
 *   - ARM64：`0x...`
 */
function branchTarget(insn) {
    if (!insn.isJump && !insn.isCall)
        return null;
    const m = insn.parameters.match(/#?(0x[0-9a-f]+)/i);
    if (!m)
        return null;
    try {
        return BigInt(m[1]);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=disassembler.js.map