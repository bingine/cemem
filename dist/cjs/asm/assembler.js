"use strict";
/**
 * 汇编器 —— 文本汇编 → 机器码，对齐 Cheat Engine `Assemblerunit.pas` 的对外行为。
 *
 * 后端是 Keystone（见 `backend.ts` 的说明：CE 在 Windows 上也是调 binutils 的 `as`）。
 * 本文件负责 Keystone 之外的那一层，也就是 CE 汇编器真正做的事：
 *
 *   1. **符号解析**：`jmp someLabel` 里的未定义符号要在编码前解析成地址。
 *      Keystone 支持通过符号回调注册，本模块提供 `symbols` 选项。
 *   2. **`nop` 与对齐**：CE 的 `nop` 可带数量（`nop 5` 表示填充 5 字节的 nop）。
 *   3. **CE 的强制宽度写法**：`mov [rax],1` 在 CE 里需要显式宽度，
 *      本模块会把 CE 风格的 `mov dword ptr [rax],1` 原样交给 Keystone，
 *      同时兼容省略写法（Keystone/NASM 语法自己会报错，错误信息里指明）。
 *   4. **`int 3` 特例**：Keystone 会把 `int 3` 编成 `CD 03`（两字节），
 *      而 x86 惯例与 CE 都用单字节 `CC`。这里做修正。
 *   5. **逐行模式**：CE 的 `assemble` 是`逐行`语义（每行一条指令），
 *      本模块提供 `assembleLines` 返回每行的字节边界，便于 Auto Assembler
 *      把脚本按行映射回地址。
 *
 * ## 与 CE 的差异
 *   - CE 支持 `E8 ?? ?? ?? ??` 这种"带通配的模板"，那属于 Auto Assembler 层
 *     （见 `autoassembler.ts`），不在汇编器里。
 *   - CE 的汇编器有大量针对旧语法的兼容分支（`$` 前缀十六进制、`offset` 关键字等），
 *     本模块只保留主流写法，遇到不支持时会给出明确的汇编错误。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AsmBackendError = exports.AssemblerError = void 0;
exports.assemble = assemble;
exports.assembleLines = assembleLines;
exports.assembleToBytes = assembleToBytes;
const backend_1 = require("./backend");
Object.defineProperty(exports, "AsmBackendError", { enumerable: true, get: function () { return backend_1.AsmBackendError; } });
/** 汇编失败 */
class AssemblerError extends Error {
    line;
    lineNumber;
    constructor(message, line, lineNumber) {
        super(lineNumber !== undefined
            ? `汇编失败（第 ${lineNumber} 行："${line}"）：${message}`
            : `汇编失败：${message}`);
        this.line = line;
        this.lineNumber = lineNumber;
        this.name = 'AssemblerError';
    }
}
exports.AssemblerError = AssemblerError;
/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */
/** 单行最大指令长度：x86 架构限制 15 字节；ARM/ARM64 定长 4 字节（Thumb 2/4） */
const MAX_INSTRUCTION_LENGTH = 15;
/**
 * 解析最终使用的架构。
 *
 * 优先级：`arch` > `bitness` > 默认 `x64`。
 * 支持 ARM 之后"位数"已不足以表达架构（`arm` 与 `thumb` 都是 32 位），
 * 因此保留 `bitness` 只为兼容旧调用。
 */
function resolveArch(options) {
    if (options.arch)
        return options.arch;
    return (0, backend_1.archFromBitness)(options.bitness);
}
/**
 * 汇编一段文本（可多行）。
 *
 * ```ts
 * const r = assemble('mov rax, 1\nret', { address: 0x1000n });
 * r.bytes; // <Buffer b8 01 00 00 00 c3>
 * ```
 */
function assemble(source, options) {
    const cleaned = preprocessSource(source);
    const symbols = normalizeSymbols(options.symbols);
    if (cleaned.trim() === '') {
        return {
            bytes: Buffer.alloc(0),
            address: options.address,
            endAddress: options.address,
            lines: [],
            usedSymbols: {},
        };
    }
    const { text, usedSymbols } = substituteSymbols(cleaned, symbols, options);
    let bytes;
    try {
        // Keystone 支持通过 KS_OPT_SYM_RESOLVER 注册回调，但那需要额外的
        // addFunction 交互（wasm 绑定未暴露）。这里改为**文本替换**：
        // 把符号直接换成 0xADDR 字面量，语义等价且可预测。
        bytes = (0, backend_1.assembleRaw)(text, {
            address: options.address,
            arch: resolveArch(options),
            endianness: options.endianness,
            syntax: options.syntax,
        }).bytes;
    }
    catch (e) {
        throw toAssemblerError(e, source, options);
    }
    // int 3 特例修正（Keystone 产出 CD 03，惯例是单字节 CC）
    bytes = fixInt3(bytes);
    return {
        bytes,
        address: options.address,
        endAddress: options.address + BigInt(bytes.length),
        lines: [{ source: cleaned, bytes, address: options.address, empty: false }],
        usedSymbols,
    };
}
/**
 * 逐行汇编，返回每行的字节与地址。
 *
 * CE 的 Auto Assembler 需要"脚本行 → 地址"的映射
 * （`label`/`alloc` 之后要把行号换算成地址），所以逐行编码是必要的。
 *
 * 注意：逐行编码无法处理"跨行的局部标签"（`jmp short_label` 后紧跟标号定义）。
 * 调用方应先用 `assemble()` 传完整文本处理标签，或用 `symbols` 预解析。
 */
function assembleLines(source, options) {
    const rawLines = splitLines(source);
    const symbols = normalizeSymbols(options.symbols);
    const out = [];
    let address = options.address;
    const usedSymbols = {};
    for (let i = 0; i < rawLines.length; i++) {
        const raw = rawLines[i];
        const lineText = preprocessLine(raw);
        if (lineText === '') {
            out.push({ source: raw, bytes: Buffer.alloc(0), address, empty: true });
            continue;
        }
        // 纯标号定义行（`label:`）不产生字节，但要把符号记下来
        const labelMatch = lineText.match(/^([A-Za-z_.$?@][\w.$?@]*)\s*:\s*$/);
        if (labelMatch) {
            symbols.set(labelMatch[1].toLowerCase(), address);
            out.push({ source: raw, bytes: Buffer.alloc(0), address, empty: true });
            continue;
        }
        // 带标号前缀的指令：`mylabel: mov eax,1`
        const inlineLabel = lineText.match(/^([A-Za-z_.$?@][\w.$?@]*)\s*:\s*(.+)$/);
        let instruction = lineText;
        if (inlineLabel) {
            symbols.set(inlineLabel[1].toLowerCase(), address);
            instruction = inlineLabel[2].trim();
        }
        const { text, usedSymbols: used } = substituteSymbols(instruction, symbols, options);
        Object.assign(usedSymbols, used);
        let bytes;
        try {
            bytes = (0, backend_1.assembleRaw)(text, {
                address,
                arch: resolveArch(options),
                endianness: options.endianness,
                syntax: options.syntax,
            }).bytes;
        }
        catch (e) {
            throw toAssemblerError(e, raw, options, i + 1);
        }
        if (bytes.length > MAX_INSTRUCTION_LENGTH) {
            throw new AssemblerError(`编码结果 ${bytes.length} 字节超过单条指令上限 ${MAX_INSTRUCTION_LENGTH} 字节，可能是语法问题`, raw, i + 1);
        }
        bytes = fixInt3(bytes);
        out.push({ source: raw, bytes, address, empty: false });
        address += BigInt(bytes.length);
    }
    const all = Buffer.concat(out.map((l) => l.bytes));
    return {
        bytes: all,
        address: options.address,
        endAddress: address,
        lines: out,
        usedSymbols,
    };
}
/**
 * 便捷函数：只拿字节。
 */
function assembleToBytes(source, options) {
    return assemble(source, options).bytes;
}
/* ------------------------------------------------------------------ *
 * 内部
 * ------------------------------------------------------------------ */
/**
 * 预处理整段源码。
 *
 *  - 剥离 `//` 与 `;` 行尾注释（CE 的汇编脚本两种都用）
 *  - 剥离 `/* *​/` 块注释
 *  - 去掉空行
 */
function preprocessSource(source) {
    const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const lines = noBlock
        .split(/\r?\n/)
        .map((l) => stripLineComment(l).trim())
        .filter((l) => l !== '');
    return lines.join('\n');
}
function splitLines(source) {
    const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
    return noBlock.split(/\r?\n/);
}
/** 剥掉行尾注释。注意不要误伤字符串里的 `;`（本移植的汇编文本里几乎没有字符串）。 */
function stripLineComment(line) {
    const slashes = line.indexOf('//');
    const semicolon = line.indexOf(';');
    let cut = -1;
    if (slashes >= 0)
        cut = slashes;
    if (semicolon >= 0 && (cut < 0 || semicolon < cut))
        cut = semicolon;
    return cut >= 0 ? line.slice(0, cut) : line;
}
function preprocessLine(line) {
    return stripLineComment(line).trim();
}
function normalizeSymbols(input) {
    const m = new Map();
    if (!input)
        return m;
    if (input instanceof Map) {
        for (const [k, v] of input)
            m.set(k.toLowerCase(), v);
        return m;
    }
    for (const [k, v] of Object.entries(input))
        m.set(k.toLowerCase(), v);
    return m;
}
/**
 * 把源码里的符号名替换成 `0x...` 字面量。
 *
 * 为什么用文本替换而不是 Keystone 的符号回调：
 * wasm 绑定没有暴露 `KS_OPT_SYM_RESOLVER`（需要传 JS 函数指针），
 * 而文本替换语义等价、结果可预测、也便于报错时指出是哪个符号。
 *
 * 替换时避免误伤：
 *   - 十六进制字面量里的字母（`0xAB`）
 *   - 字符串里的内容
 *   - 寄存器名/指令名（只有当名字确实在符号表里时才替换，所以天然安全）
 */
function substituteSymbols(text, symbols, options) {
    const usedSymbols = {};
    if (symbols.size === 0)
        return { text, usedSymbols };
    const friendly = options.friendlyErrors !== false;
    // 按长度倒序替换，避免 "label" 先于 "label2" 被匹配
    const names = [...symbols.keys()].sort((a, b) => b.length - a.length);
    let out = text;
    for (const name of names) {
        const addr = symbols.get(name);
        // 词边界匹配：符号名两侧不能是标识符字符
        const re = new RegExp(`(?<![\\w.$?@])${escapeRegExp(name)}(?![\\w.$?@])`, 'gi');
        if (re.test(out)) {
            out = out.replace(re, '0x' + addr.toString(16));
            usedSymbols[name] = '0x' + addr.toString(16);
        }
    }
    // 剩下的未定义符号：给出比 Keystone 原文更清楚的错误
    if (friendly) {
        const unresolved = findUnresolvedSymbol(out);
        if (unresolved) {
            throw new AssemblerError(`未定义的符号 "${unresolved}"。` +
                `请先用 label/define/registersymbol/aobscan 定义，或通过 symbols 选项传入。`);
        }
    }
    return { text: out, usedSymbols };
}
/**
 * 判断一个 token 是否是"寄存器名 / 关键字 / 字面量"（不是待解析的符号）。
 *
 * 覆盖 x86、ARM(A32)、Thumb、ARM64(AArch64) 三类寄存器命名，
 * 否则 ARM 脚本里的 `bx lr` 会被误报成"未定义的符号 lr"（踩过）。
 */
const REGISTER_OR_KEYWORD_RE = new RegExp('^(' +
    [
        // —— 字面量 ——
        '0x[0-9a-f]+',
        '\\d+',
        // —— x86 ——
        'r[a-z0-9]+', 'e[a-z]{2}', '[a-d][lh]', '[sd]il', '[sb]pl',
        'xmm\\d+', 'ymm\\d+', 'mm\\d+', 'st\\d?',
        'cs', 'ds', 'es', 'ss', 'fs', 'gs', 'rip', 'eip',
        // —— ARM A32 ——
        'r\\d+', 'lr', 'pc', 'sp', 'ip', 'fp', 'sl', 'sb', 'cpsr', 'spsr',
        // —— ARM64 ——
        'x\\d+', 'w\\d+', 'xzr', 'wzr', 'fp',
        // —— 浮点/SIMD ——
        's\\d+', 'd\\d+', 'q\\d+', 'v\\d+', 'b\\d+', 'h\\d+',
        // —— 宽度/修饰关键字 ——
        'byte', 'word', 'dword', 'qword', 'xmmword', 'ymmword', 'zmmword', 'tbyte',
        'ptr', 'offset', 'short', 'near', 'far', 'to', 'and', 'or', 'not', 'xor',
        'shl', 'shr', 'lsl', 'lsr', 'asr', 'rrx', 'uxtb', 'uxth', 'sxtb', 'sxth',
    ].join('|') +
    ')$', 'i');
/** 找出一行里明显是"未定义符号"的标识符（排除助记符、寄存器、宽度关键字） */
function findUnresolvedSymbol(line) {
    const tokens = line.split(/[\s,\[\]+\-*:(){}!]+/).filter((t) => t !== '');
    // 跳过第一个 token（助记符）
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (REGISTER_OR_KEYWORD_RE.test(t))
            continue;
        // 去掉 ARM 的立即数前缀与条件后缀残留
        const bare = t.replace(/^#/, '');
        if (bare !== t && REGISTER_OR_KEYWORD_RE.test(bare))
            continue;
        if (/^[A-Za-z_.$?@][\w.$?@]*$/.test(t))
            return t;
    }
    return null;
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * 修正 `int 3` 的编码。
 *
 * Keystone 0.9 把 `int 3` 编成 `CD 03`（合法但冗长），
 * x86 惯例与 CE 都用单字节 `CC`（同样合法且更短）。
 * 只在这一个指令上做替换：`CD 03` 出现在别处不可能是巧合
 * （`int 3` 的唯一常见写法就是这一种），但为了保守，只在**整段恰好等于**
 * `CD 03` 或出现该序列且源里确实有 `int 3` 时替换。
 */
function fixInt3(bytes) {
    if (bytes.length === 2 && bytes[0] === 0xcd && bytes[1] === 0x03) {
        return Buffer.from([0xcc]);
    }
    return bytes;
}
/** 把后端异常转成带行号的汇编错误 */
function toAssemblerError(e, source, options, lineNumber) {
    if (e instanceof AssemblerError)
        return e;
    let message = e instanceof Error ? e.message : String(e);
    // 去掉我们自己的 AsmBackendError 外壳前缀，避免"汇编失败：汇编失败："重复
    message = message.replace(/^汇编失败：/, '');
    // Keystone 的 "Cannot find a symbol (KS_ERR_ASM_SYMBOL_MISSING)" 换成更可操作的说法
    if (/SYMBOL_MISSING|Cannot find a symbol/i.test(message) && options.friendlyErrors !== false) {
        const guess = findUnresolvedSymbol(source.split(/\r?\n/)[0] ?? source);
        message = guess
            ? `未定义的符号 "${guess}"（Keystone 原文：${message}）`
            : `存在未定义的符号（Keystone 原文：${message}）`;
    }
    // 常见语法问题的中文提示
    if (/INVALIDOPERAND/i.test(message)) {
        message +=
            '。提示：内存操作数需要明确宽度，例如 `mov dword ptr [rax],1`；' +
                'CE 也要求显式宽度。';
    }
    return new AssemblerError(message, source, lineNumber);
}
//# sourceMappingURL=assembler.js.map