"use strict";
/**
 * Auto Assembler —— Cheat Engine 脚本语言的解析与执行层。
 *
 * 对齐 `Cheat Engine/autoassembler.pas`（3752 行）与 `Assemblerunit.pas` 里
 * 属于 Auto Assembler 的那部分（`db/dw/dd/dq`、`nop N`、`align`）。
 *
 * ## 它解决什么问题
 *
 * CE 的 Auto Assembler 是"把一段脚本变成对目标进程内存的修改"的编译器 + 执行器：
 *
 * ```text
 * [ENABLE]
 * alloc(newmem,2048)                 // 1. 在目标进程分配内存
 * label(returnhere)                  // 2. 声明一个脚本内标签
 * aobscan(sig, DE AD BE EF 90 90 ?? 7*)   // 3. 在目标进程里搜特征码
 * newmem:                            // 4. 地址定位（后续指令从这里排布）
 *   mov dword ptr [sig], 1337        // 5. 写代码
 *   jmp returnhere
 * sig:                               // 6. 回到 aobscan 找到的地址
 *   jmp newmem
 * returnhere:
 * [DISABLE]
 * dealloc(newmem)
 * ```
 *
 * ## 执行流水线（与 CE 一一对应）
 *
 * ```
 *   stripComments        ← removecomments()          去 // ; {} 注释（字符串感知）
 *   expandIncludes       ← INCLUDE() 分支            把 include 的文件内容就地展开
 *   analyzeSections      ← getenableanddisablepos()  找 [ENABLE]/[DISABLE]
 *   selectLines          ← getEnableOrDisableScript() 取「外层代码 + 选中段」
 *   stripCpuSpecific     ← stripCPUspecificCode()    处理 [32-BIT]/[64-BIT]
 *   preprocess           ← autoassemble2 的解析循环   alloc/aobscan/label/define/db/...
 *   layout               ← AutoassemblerCodePass2()   逐行定地址 + 汇编（迭代到稳定）
 *   apply                ← 写内存分支                 写目标进程并记录原字节
 * ```
 *
 * ## 三个最容易静默出错、因此被重点处理的地方
 *
 * 1. **地址定位**。CE 的脚本不是"从头顺序汇编"，而是由**地址定义行**（`name:`）切块：
 *    遇到已知符号（alloc/aobscan/registered）或地址表达式（`"game.exe"+1234:`）时，
 *    当前地址被**重置**到该值；否则标签取当前地址。若不实现这条，
 *    `newmem:` 之后那段代码会被写到地址 0。
 * 2. **前向引用的指令长度**。`jmp returnhere` 里的 `returnhere` 定义在后面，
 *    它的地址又取决于前面指令的长度 —— 循环依赖。CE 的做法是用
 *    「当前地址 + 0xFFFFF」当远占位符、用「当前地址」当近占位符各编一次，
 *    取**较长**的那个，保证后续地址不会因为编码变短而漂移。本移植沿用这一策略，
 *    并额外做迭代收敛（见 `MAX_LAYOUT_PASSES`）。
 * 3. **原字节保留**。[ENABLE] 写入前逐字节记录被覆盖的原字节；[DISABLE] 时按记录
 *    逆序精确还原（`restoreMode: 'original'`，默认）。这正是 CE 教程里
 *    「关掉作弊后游戏恢复正常」的底层机制。
 *
 * ## 与 CE 的差异（完整清单见 docs/autoassembler.md）
 *
 * - **数字进制是一致的**（实测）：Keystone 的 Intel 语法把裸数字按**十六进制**解析，
 *   与 CE 相同 —— `mov eax, 100` 编出 `B8 00 01 00 00`（即 0x100）。
 *   想写十进制只能写 `0x` 形式的十六进制值（Keystone 不支持 CE 的 `#123`）。
 * - `db/dw/dd/dq`、`nop N`、`align N` 由本层自己实现，同样是十六进制语义。
 * - `alloc`/`readmem` 的**大小**参数按十进制（对齐 CE 的 `StrToInt`），
 *   需要十六进制时写 `0x` 或 `$` 前缀。
 * - `createthread`/`createthreadandwait` 只做参数校验与记录，不创建远程线程
 *   （Node 没有 CreateRemoteThread；见 `allowCreateThread`）。
 * - `luaCall`/`reassemble`/`struct`/`kalloc`/`sharedalloc`/`loadlibrary`/
 *   `allocnx`/`allocxo`/`aobscanex`/`{$...}` 条件编译未实现，会给出明确的中文错误。
 *
 * ## 用法
 *
 * ```ts
 * await ensureAsmBackend();                       // WASM 后端必须先初始化
 * const aa = new AutoAssembler({ process });
 * aa.autoAssemble(script, { enable: true });      // 注入并记录原字节
 * aa.autoAssemble(script, { enable: false });     // 精确还原
 * ```
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoAssembler = exports.AutoAssemblerError = void 0;
exports.autoAssemble = autoAssemble;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const scanner_1 = require("../scanner/scanner");
const types_1 = require("../types");
const value_codec_1 = require("../value-codec");
const expression_1 = require("../addr/expression");
const assembler_1 = require("./assembler");
const backend_1 = require("./backend");
const autoassembler_directives_1 = require("./autoassembler-directives");
/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */
/** 递归 include 的最大深度（防止 A include B include A 无限展开） */
const MAX_INCLUDE_DEPTH = 8;
/**
 * 前向引用占位符的"远"偏移量。
 *
 * 取 CE `autoassembler.pas` 3742~3747 行同样的值（`currentaddress+$FFFFF`）：
 * 足以让 `jmp`/`call` 落在 32 位相对位移范围内（因此是常规的 5 字节编码），
 * 又不会大到让 `mov r64, imm` 之类的指令换用更长的编码。
 */
const FAR_PLACEHOLDER_DELTA = 0xfffffn;
/** 地址布局的最大迭代轮数（超过仍未稳定就报错，避免产出错误字节） */
const MAX_LAYOUT_PASSES = 20;
/**
 * 语法检查模式（`syntaxCheckOnly`）使用的**合成起始地址**。
 *
 * 纯检查不写内存，因此这里没有真实地址可用；但布局器需要一个起点才能
 * 计算标签地址与相对跳转的编码距离。取 `0x140000000` —— x64 常见的模块基址区间，
 * 既能承载合法的相对编码，又明显不是任何真实地址（真执行时这些值会被丢弃）。
 */
const CHECK_LAYOUT_BASE_ADDRESS = 0x140000000n;
/**
 * 语法检查模式下，"看起来就是模块地址表达式"的形状。
 *
 * 纯检查常常**没有附加目标进程**（check 的本意就是"开工前先看看脚本对不对"），
 * 这时 `"cmd.exe":` / `"game.exe"+1000:` 这种地址定义行无法求值，于是直接抛
 * 「无法求值地址表达式」。可它恰恰是**每一份正常的 AA 脚本**的开头 ——
 * 换句话说 check 会对最该检查的那类脚本误报，正是这个功能最需要它的时候不可用。
 *
 * 只在**没有进程可解析**时才启用这条兜底，并且把偏移真的加进合成基址，
 * 这样"偏移写错"这类问题在布局阶段仍能被发现（例如负偏移越界）。
 * 有进程时一律走真实解析 —— 那时模块名打错必须照旧报错。
 */
const CHECK_MODULE_EXPRESSION_RE = /^\[?\s*(?:"([A-Za-z0-9_.\-\\/ ]+)"|'([A-Za-z0-9_.\-\\/ ]+)'|([A-Za-z_][A-Za-z0-9_.\-\\/]*\.(?:exe|dll|sys|node|so)))\s*(?:\+\s*(0[xX][0-9a-fA-F]+|[0-9a-fA-F]+|[0-9]+))?\s*\]?$/;
/**
 * 把"模块+偏移"形状的地址定义行在**纯语法检查**下换算成一个合成地址。
 *
 * 返回 null 表示"不该兜底"：要么这不像模块地址表达式，要么表达式里点名的模块
 * **根本不在**目标进程里 —— 后者是真实的脚本错误，必须照旧报出来。
 * 同理，模块存在时偏移写错（越界）也不会被这条兜底掩盖。
 *
 * `modules` 为空数组表示"当前没有目标进程可枚举"（最常见的 check 场景），
 * 此时无法核对模块名，按形状兜底。
 */
function checkModulePlaceholder(expression, modules) {
    const m = CHECK_MODULE_EXPRESSION_RE.exec(expression.trim());
    if (m === null)
        return null;
    const moduleName = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (modules.length > 0 && !moduleExists(modules, moduleName))
        return null;
    const offsetText = (m[4] ?? '').trim();
    if (offsetText === '')
        return CHECK_LAYOUT_BASE_ADDRESS;
    // CE 的地址表达式里裸数字是十六进制，与 hexifyBareNumbers 保持一致
    const offset = safeBigInt(/^0[xX]/.test(offsetText) ? offsetText : `0x${offsetText}`);
    if (offset === null)
        return CHECK_LAYOUT_BASE_ADDRESS;
    const address = CHECK_LAYOUT_BASE_ADDRESS + offset;
    return address >= 0n ? address : CHECK_LAYOUT_BASE_ADDRESS;
}
/** 模块名匹配：不区分大小写，且允许省略扩展名（与内核 addr/expression 的语义一致）。 */
function moduleExists(modules, wanted) {
    const needle = wanted.toLowerCase();
    const bare = needle.replace(/\.(exe|dll|sys|node|so)$/u, '');
    for (const module of modules) {
        const name = module.name.toLowerCase();
        if (name === needle || name.replace(/\.(exe|dll|sys|node|so)$/u, '') === bare)
            return true;
    }
    return false;
}
/** 默认扫描块大小 */
const DEFAULT_SCAN_BLOCK_SIZE = 1 << 20;
/** 本移植明确不支持的指令（给出可操作的中文报错，而不是让 Keystone 抛怪错误） */
const UNSUPPORTED_DIRECTIVES = [
    'luacall',
    'reassemble',
    'struct',
    'kalloc',
    'sharedalloc',
    'fullaccess',
    'loadlibrary',
    'allocnx',
    'allocxo',
    'aobscanex',
    'createthreadandwait',
];
/** Auto Assembler 错误（带脚本行号与列内容，便于定位） */
class AutoAssemblerError extends Error {
    /** 出错的源码行（已去注释） */
    line;
    /** 出错的源码行号（1-based；include 的文件里是文件内行号） */
    lineNumber;
    /** 出错行所属文件（主脚本为 `<script>`） */
    file;
    /** 阶段 */
    phase;
    constructor(message, options = {}) {
        const phase = options.phase ?? 'parse';
        let where = '';
        if (options.lineNumber !== undefined) {
            const file = options.file && options.file !== '<script>' ? ` @ ${options.file}` : '';
            where = `（第 ${options.lineNumber} 行${file}："${options.line ?? ''}"）`;
        }
        else if (options.file && options.file !== '<script>') {
            where = `（@ ${options.file}）`;
        }
        super(`Auto Assembler ${phase} 错误${where}：${message}`);
        this.name = 'AutoAssemblerError';
        this.line = options.line;
        this.lineNumber = options.lineNumber;
        this.file = options.file;
        this.phase = phase;
    }
}
exports.AutoAssemblerError = AutoAssemblerError;
/** 把脚本原文规范成历史记录的 key（容忍 CRLF 与首尾空白差异） */
function historyKey(script) {
    return script.replace(/\r\n/g, '\n').trim();
}
/** 判断 [address, address+length) 是否已被历史完整覆盖 */
function isCoveredByHistory(history, address, length) {
    const end = address + BigInt(length);
    for (const record of history) {
        const rEnd = record.address + BigInt(record.bytes.length);
        if (record.address <= address && rEnd >= end)
            return true;
    }
    return false;
}
/** 把一条记录插入历史（保持地址升序），并与相邻记录合并 */
function insertHistory(history, address, bytes) {
    if (bytes.length === 0)
        return;
    const record = { address, bytes };
    let index = 0;
    while (index < history.length && history[index].address < address)
        index++;
    history.splice(index, 0, record);
    // 与前一条合并
    if (index > 0) {
        const prev = history[index - 1];
        const cur = history[index];
        if (prev.address + BigInt(prev.bytes.length) === cur.address) {
            prev.bytes = Buffer.concat([prev.bytes, cur.bytes]);
            history.splice(index, 1);
            index--;
        }
    }
    // 与后一条合并
    if (index + 1 < history.length) {
        const cur = history[index];
        const next = history[index + 1];
        if (cur.address + BigInt(cur.bytes.length) === next.address) {
            cur.bytes = Buffer.concat([cur.bytes, next.bytes]);
            history.splice(index + 1, 1);
        }
    }
}
/* ------------------------------------------------------------------ *
 * 纯函数工具
 * ------------------------------------------------------------------ */
/** 是否是合法标识符（CE 用 `val('$'+s,x)` 做同样的判断） */
function isIdentifier(text) {
    return /^[A-Za-z_.$?@][\w.$?@]*$/.test(text);
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * 按 token 边界替换（对齐 `autoassembler.pas` 的 `replacetoken`）。
 *
 * 使用零宽断言而不是 `\b`，因为 CE 的标识符字符集包含 `.`、`$`、`?`、`@`。
 */
function replaceToken(text, token, value) {
    if (token === '')
        return text;
    const re = new RegExp(`(?<![\\w.$?@])${escapeRegExp(token)}(?![\\w.$?@])`, 'gi');
    return text.replace(re, value);
}
/**
 * 去注释，对齐 `removecomments()`（autoassembler.pas 733 行）并额外支持 `;`。
 *
 * 行为：
 *   - `//` 到行尾
 *   - `;` 到行尾（CE 的 Assembleunit 把 `;` 当注释；AA 层原本不处理，这里统一处理）
 *   - `/* ... *​/` 跨行块注释
 *   - `{ ... }` 跨行注释（CE 的 bracecomment；ARM 上 CE 不支持，本移植都支持）
 *   - 引号内的内容不当作注释（`db 'a//b'`）
 *   - 制表符→空格
 *
 * 与 CE 的差异：CE 的 `removecomments` 不处理 `;`，且块注释被替换为**等长空格**
 * 以便保持字符位置；本实现按行产出（不保留位置），因为后续使用的是行号而非列号。
 */
function stripComments(source) {
    const rawLines = source.split(/\r?\n/);
    const out = [];
    let inBlock = false; // /* */
    let inBrace = false; // { }
    for (const rawLine of rawLines) {
        let text = '';
        let inString = false;
        for (let i = 0; i < rawLine.length; i++) {
            const ch = rawLine[i];
            const next = i + 1 < rawLine.length ? rawLine[i + 1] : '';
            if (inBlock) {
                if (ch === '*' && next === '/') {
                    inBlock = false;
                    i++;
                }
                text += ' ';
                continue;
            }
            if (inBrace) {
                if (ch === '}')
                    inBrace = false;
                text += ' ';
                continue;
            }
            if (inString) {
                text += ch;
                if (ch === "'" || ch === '"')
                    inString = false;
                continue;
            }
            if (ch === "'" || ch === '"') {
                inString = true;
                text += ch;
                continue;
            }
            if (ch === '/' && next === '/')
                break; // 行注释
            if (ch === ';')
                break; // `;` 行注释
            if (ch === '/' && next === '*') {
                inBlock = true;
                i++;
                text += ' ';
                continue;
            }
            if (ch === '{') {
                inBrace = true;
                text += ' ';
                continue;
            }
            text += ch === '\t' ? ' ' : ch;
        }
        out.push(text.trim());
    }
    return out;
}
/**
 * 匹配 `NAME(参数)` 形式的指令。
 *
 * 参数用贪婪匹配到最后那个 `)`，因此 `include(c:\a)b.cea)` 这类怪写法也能工作
 * （CE 用的是 `pos('(')` + `pos(')')`，行为略有不同，但不影响正常脚本）。
 */
function parseCall(text, name) {
    const m = text.match(new RegExp(`^${escapeRegExp(name)}\\s*\\(([\\s\\S]*)\\)\\s*$`, 'i'));
    return m ? m[1] : null;
}
/** 去掉最外层引号（CE 的 AnsiDequotedStr 子集） */
function unquote(text) {
    const t = text.trim();
    if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
        return t.slice(1, -1);
    }
    return t;
}
/** 按 `,` 与空白切分符号名列表（CE 的 `Split([',',' '])`） */
function splitNames(text) {
    return text
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s !== '');
}
/** 解析"数量"参数：CE 里 alloc 大小 / readmem 长度走 StrToInt（十进制），这里额外接受 0x/$ */
function parseCount(text, context) {
    const t = text.trim();
    let value = null;
    if (/^0x/i.test(t))
        value = safeBigInt(t);
    else if (t[0] === '$')
        value = safeBigInt('0x' + t.slice(1));
    else if (/^\d+$/.test(t))
        value = safeBigInt(t);
    else
        value = (0, autoassembler_directives_1.parseCeInteger)(t, true);
    if (value === null || value < 0n) {
        throw new Error(`${context} 需要一个非负整数，收到 "${text}"`);
    }
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
        throw new Error(`${context} 的数值 ${value} 过大`);
    }
    return n;
}
function safeBigInt(text) {
    try {
        return BigInt(text);
    }
    catch {
        return null;
    }
}
/**
 * 把地址表达式里的裸数字改成 `0x` 形式。
 *
 * 为什么需要：CE 的地址表达式（`"game.exe"+1234`）里是**十六进制**，
 * 而本项目的 `addr/expression.ts` 对不含 a-f 字母的裸数字按**十进制**解析
 * （见该文件 152~163 行）。若不转换，`"exe"+1234` 会算成 +4660 而不是 +0x1234。
 *
 * 只处理不被标识符/`$`/`#` 包夹的纯数字串，引号内不动。
 */
function hexifyBareNumbers(expression) {
    let out = '';
    let i = 0;
    let quote = null;
    while (i < expression.length) {
        const ch = expression[i];
        if (quote !== null) {
            out += ch;
            if (ch === quote)
                quote = null;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            out += ch;
            i++;
            continue;
        }
        // 已是 0x 前缀：原样保留
        if (ch === '0' && (expression[i + 1] === 'x' || expression[i + 1] === 'X')) {
            let j = i + 2;
            while (j < expression.length && /[0-9a-fA-F]/.test(expression[j]))
                j++;
            out += expression.slice(i, j);
            i = j;
            continue;
        }
        if (ch >= '0' && ch <= '9') {
            let j = i;
            while (j < expression.length && /[0-9a-fA-F]/.test(expression[j]))
                j++;
            const token = expression.slice(i, j);
            const prev = out.length > 0 ? out[out.length - 1] : '';
            const next = j < expression.length ? expression[j] : '';
            const partOfIdent = /[A-Za-z0-9_.$@?#\\/]/.test(prev) || /[A-Za-z_.$@?\\/]/.test(next);
            out += partOfIdent ? token : '0x' + token;
            i = j;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}
/* ------------------------------------------------------------------ *
 * AOB 扫描
 * ------------------------------------------------------------------ */
/** 扫描出全部匹配地址（升序） */
function scanAobUnrestricted(proc, patternText, blockSize, parallel) {
    const session = new scanner_1.ScanSession(proc, { blockSize, parallel });
    session.firstScan({
        variableType: types_1.VariableType.ByteArray,
        scanOption: types_1.ScanOption.ExactValue,
        roundingType: types_1.RoundingType.Rounded,
        floatAccuracy: 0,
        value1: patternText,
        includeImage: true,
        includeMapped: true,
        includePrivate: true,
        includeGuard: false,
    });
    return [...session.results].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
/**
 * 在限定区域内扫描 AOB。
 *
 * `ScanSession` 的 `ScanConfig` 没有地址范围字段，因此 module/region 版本自己实现：
 * 逐块读取（每块多读 `pattern.length-1` 字节以覆盖跨块边界），在块内做模式匹配。
 */
function scanAobInRegions(proc, patternText, regions, blockSize) {
    const pattern = (0, value_codec_1.parseAob)(patternText);
    if (pattern.length === 0)
        throw new Error(`AOB 特征串解析为空："${patternText}"`);
    const nibble = (0, value_codec_1.aobHasNibbleWildcard)(pattern);
    const overlap = pattern.length - 1;
    const results = [];
    const seen = new Set();
    for (const region of regions) {
        const start = region.baseAddress;
        const end = region.baseAddress + region.memorySize;
        let cursor = start;
        while (cursor < end) {
            const windowSize = Number(end - cursor > BigInt(blockSize) ? BigInt(blockSize) : end - cursor);
            const readSize = Math.min(windowSize + overlap, blockSize + overlap);
            const buf = proc.readMemory(cursor, readSize);
            if (buf.length >= pattern.length) {
                const limit = Math.min(windowSize, buf.length - pattern.length + 1);
                for (let off = 0; off < limit; off++) {
                    if ((0, value_codec_1.aobMatchesAt)(buf, off, pattern, nibble)) {
                        const address = cursor + BigInt(off);
                        const key = address.toString(16);
                        if (!seen.has(key)) {
                            seen.add(key);
                            results.push(address);
                        }
                    }
                }
            }
            cursor += BigInt(windowSize);
        }
    }
    return results.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
/** 按名字找模块（忽略大小写，允许省略扩展名、允许包含匹配） */
function findModule(modules, name) {
    const needle = name.trim().toLowerCase();
    const exact = modules.find((m) => m.name.toLowerCase() === needle);
    if (exact)
        return exact;
    const base = modules.find((m) => m.name.toLowerCase().replace(/\.(dll|exe|so)$/i, '') === needle.replace(/\.(dll|exe|so)$/i, ''));
    if (base)
        return base;
    const byPath = modules.find((m) => m.path.toLowerCase() === needle);
    if (byPath)
        return byPath;
    return modules.find((m) => m.name.toLowerCase().includes(needle)) ?? null;
}
/** 找出 [ENABLE] / [DISABLE] 的行号；重复出现时报错（对齐 getenableanddisablepos 的 -2 语义） */
function analyzeSections(lines) {
    let enableLine = null;
    let disableLine = null;
    for (const line of lines) {
        const upper = line.text.toUpperCase();
        if (upper === '[ENABLE]') {
            if (enableLine !== null) {
                throw new AutoAssemblerError('[ENABLE] 段重复定义', {
                    line: line.text,
                    lineNumber: line.number,
                    file: line.file,
                });
            }
            enableLine = line.number;
        }
        else if (upper === '[DISABLE]') {
            if (disableLine !== null) {
                throw new AutoAssemblerError('[DISABLE] 段重复定义', {
                    line: line.text,
                    lineNumber: line.number,
                    file: line.file,
                });
            }
            disableLine = line.number;
        }
    }
    return { enableLine, disableLine };
}
/**
 * 取出「外层代码 + 选中段」，对齐 `getEnableOrDisableScript`。
 *
 * 关键语义：**两个段之外的代码在 enable 与 disable 时都会执行**
 * （`alloc`/`registersymbol` 通常写在段外面）。段内的行按原顺序保留。
 */
function selectLines(lines, enable) {
    const out = [];
    let insideEnable = false;
    let insideDisable = false;
    for (const line of lines) {
        const upper = line.text.toUpperCase();
        if (upper === '[ENABLE]') {
            insideEnable = true;
            insideDisable = false;
            continue;
        }
        if (upper === '[DISABLE]') {
            insideEnable = false;
            insideDisable = true;
            continue;
        }
        const isOuter = !insideEnable && !insideDisable;
        if (isOuter || (insideEnable && enable) || (insideDisable && !enable))
            out.push(line);
    }
    return out;
}
/**
 * 处理 CPU 专属段，对齐 `stripCPUspecificCode`：
 *   - `[32-BIT]` … `[/32-BIT]`
 *   - `[64-BIT]` … `[/64-BIT]`
 * 目标为 64 位时丢弃 32 位块，反之亦然。标记行本身被移除。
 */
function stripCpuSpecific(lines, bitness) {
    const strip32 = bitness === 64;
    const out = [];
    let excluded = false;
    for (const line of lines) {
        const upper = line.text.toUpperCase();
        if (upper === '[32-BIT]') {
            if (strip32)
                excluded = true;
            continue;
        }
        if (upper === '[/32-BIT]') {
            if (strip32)
                excluded = false;
            continue;
        }
        if (upper === '[64-BIT]') {
            if (!strip32)
                excluded = true;
            continue;
        }
        if (upper === '[/64-BIT]') {
            if (!strip32)
                excluded = false;
            continue;
        }
        if (!excluded)
            out.push(line);
    }
    return out;
}
/* ------------------------------------------------------------------ *
 * AutoAssembler
 * ------------------------------------------------------------------ */
/**
 * 一个 Auto Assembler 会话。
 *
 * 会话保存跨调用的状态（符号表、alloc、原字节记录），因此
 * `autoAssemble(script, {enable:true})` 之后
 * `autoAssemble(script, {enable:false})` 才能精确还原。
 * 这与 CE 里 `TMemoryRecord` 持有 `TDisableInfo` 是同一个设计。
 */
class AutoAssembler {
    options;
    /** 跨脚本可见的符号（alloc / aobscan / registersymbol 的结果） */
    persistentSymbols = new Map();
    /** 当前会话的 alloc */
    allocations = new Map();
    /** registersymbol 注册的名字 */
    registeredSymbols = new Set();
    /**
     * 每个脚本 key 对应一份"ENABLE 期间记录的原字节"。
     *
     * 为什么按脚本分开存：CE 的 `TDisableInfo` 是**每个内存记录一份**的，
     * 因此可以同时启用多个脚本、再各自独立关闭。若共用一份历史，
     * 启用脚本 B 会冲掉脚本 A 的记录，导致 A 无法还原。
     */
    histories = new Map();
    /** 模块列表缓存（地址表达式反复求值用） */
    moduleCache = [];
    constructor(options = {}) {
        this.options = options;
    }
    /** 目标进程（可能为 undefined：纯语法检查模式） */
    get process() {
        return this.options.process;
    }
    /** 当前已知符号（只读快照） */
    get symbols() {
        return new Map(this.persistentSymbols);
    }
    /** 当前 alloc（只读快照） */
    get allocationsList() {
        return [...this.allocations.values()];
    }
    /** 释放本会话分配的全部内存并清空符号/历史 */
    cleanup() {
        const proc = this.options.process;
        if (proc && proc.isOpen) {
            for (const alloc of this.allocations.values()) {
                try {
                    proc.free(alloc.address);
                }
                catch {
                    /* 目标可能已退出 */
                }
            }
        }
        this.allocations.clear();
        this.persistentSymbols.clear();
        this.registeredSymbols.clear();
        this.histories.clear();
        this.moduleCache = [];
    }
    /** 本会话是否记录过该脚本的 ENABLE 原字节 */
    hasHistory(script) {
        const history = this.histories.get(historyKey(script));
        return history !== undefined && history.length > 0;
    }
    /** 取某脚本记录的原字节（只读副本，诊断用） */
    historyOf(script) {
        return (this.histories.get(historyKey(script)) ?? []).map((r) => ({
            address: r.address,
            bytes: Buffer.from(r.bytes),
        }));
    }
    /** 执行 ENABLE 段 */
    enable(script) {
        return this.autoAssemble(script, { enable: true });
    }
    /** 执行 DISABLE 段（按 `restoreMode` 还原） */
    disable(script) {
        return this.autoAssemble(script, { enable: false });
    }
    /** 只做语法检查与汇编（不分配、不写内存、无副作用） */
    check(script) {
        return this.autoAssemble(script, { syntaxCheckOnly: true });
    }
    /**
     * 解析脚本并执行，对齐 CE 的 `autoassemble(code, enable)`。
     *
     * @param script 脚本原文
     * @param opts.enable 执行 ENABLE（默认）还是 DISABLE 段
     * @param opts.syntaxCheckOnly 只检查不执行（没有 process 时自动开启）
     */
    autoAssemble(script, opts = {}) {
        const enable = opts.enable !== false;
        const proc = this.options.process;
        const syntaxCheckOnly = opts.syntaxCheckOnly === true || !proc;
        const bitness = this.resolveBitness();
        // ---- 1) 词法：去注释 + 展开 include -------------------------------
        const sourceLines = this.toSourceLines(script);
        const expanded = this.expandIncludes(sourceLines, 0);
        // ---- 2) 段选择 → CPU 专属段剥离 ----------------------------------
        const sections = analyzeSections(expanded);
        const selected = stripCpuSpecific(selectLines(expanded, enable), bitness);
        // ---- 3) 预处理：指令 ⇒ 汇编行 ------------------------------------
        const run = new RunState(enable, syntaxCheckOnly, bitness, this.resolveArch());
        const createdAllocations = [];
        // 历史记录：ENABLE 时新建一份空的；DISABLE 时取回同一脚本的记录
        const key = historyKey(script);
        if (enable) {
            run.history = [];
            this.histories.set(key, run.history);
        }
        else {
            const existing = this.histories.get(key);
            run.history = existing ?? [];
            if (!existing) {
                run.warnings.push('本会话没有找到该脚本的 ENABLE 原字节记录；将只执行 [DISABLE] 段脚本，' +
                    '可能无法完全还原（请确认 enable/disable 使用的是同一个 AutoAssembler 会话与同一份脚本）');
            }
        }
        // 段缺失时给出提示（CE 在这里直接报错；本移植因为 restoreMode 默认 'original'
        // 可以在没有 [DISABLE] 段的情况下依然精确还原，所以降级为警告）
        if ((sections.enableLine === null) !== (sections.disableLine === null)) {
            run.warnings.push(`脚本只定义了 ${sections.enableLine === null ? '[DISABLE]' : '[ENABLE]'} 段；` +
                `CE 会直接报错，本移植降级为警告（缺省段视为空段）`);
        }
        try {
            this.preprocess(selected, run, createdAllocations);
            run.warningBaseLength = run.warnings.length;
            this.layout(run);
            this.commitLabelSymbols(run);
            this.resolvePendingRegisters(run);
            // ---- 4) 写目标进程 ---------------------------------------------
            const { entries, bytesWritten } = this.apply(run, enable);
            return {
                enable: run.enable,
                syntaxCheckOnly,
                entries,
                bytesWritten,
                lines: run.asmLines.map((l) => ({
                    text: l.text,
                    address: l.address,
                    bytes: l.bytes,
                    empty: l.bytes.length === 0,
                    labels: l.labels.map((x) => x.name),
                    lineNumber: l.lineNumber,
                    file: l.file,
                })),
                symbols: new Map([...this.persistentSymbols, ...run.symbols]),
                allocations: [...this.allocations.values()],
                deallocated: [...run.deallocated],
                registeredSymbols: [...this.registeredSymbols],
                createThreads: [...run.createThreads],
                aobScans: run.aobScans.map((r) => ({
                    name: r.name,
                    matches: [...r.matches],
                    address: r.address,
                    scope: r.scope,
                })),
                warnings: [...run.warnings],
                sections: { enableLine: sections.enableLine, disableLine: sections.disableLine },
            };
        }
        catch (e) {
            // 脚本失败时回滚本次新建的 alloc，避免在目标进程里泄漏内存
            if (proc && !syntaxCheckOnly) {
                for (const name of createdAllocations.reverse()) {
                    const alloc = this.allocations.get(name);
                    if (!alloc)
                        continue;
                    try {
                        proc.free(alloc.address);
                    }
                    catch {
                        /* 尽力而为 */
                    }
                    this.allocations.delete(name);
                    if (this.persistentSymbols.get(name.toLowerCase()) === alloc.address) {
                        this.persistentSymbols.delete(name.toLowerCase());
                    }
                }
            }
            if (e instanceof AutoAssemblerError)
                throw e;
            throw new AutoAssemblerError(e.message || String(e), { phase: 'parse' });
        }
    }
    /* ---------------------------------------------------------------- *
     * 步骤 1：词法
     * ---------------------------------------------------------------- */
    toSourceLines(script) {
        return stripComments(script).map((text, i) => ({
            text,
            number: i + 1,
            file: '<script>',
        }));
    }
    /** 展开 `include(file.cea)`（就地插入，保留被包含文件自己的行号） */
    expandIncludes(lines, depth) {
        if (depth > MAX_INCLUDE_DEPTH) {
            throw new AutoAssemblerError(`include 递归层数超过 ${MAX_INCLUDE_DEPTH} 层，疑似循环引用`, {
                phase: 'parse',
            });
        }
        const out = [];
        for (const line of lines) {
            const arg = line.text ? parseCall(line.text, 'include') : null;
            if (arg === null) {
                out.push(line);
                continue;
            }
            const requested = unquote(arg);
            const resolved = this.resolveIncludePath(requested, line);
            const content = (0, node_fs_1.readFileSync)(resolved, 'utf8');
            const inner = stripComments(content).map((text, i) => ({
                text,
                number: i + 1,
                file: resolved,
            }));
            out.push(...this.expandIncludes(inner, depth + 1));
        }
        return out;
    }
    resolveIncludePath(requested, line) {
        let candidate = requested;
        const ext = (0, node_path_1.extname)(candidate).toUpperCase();
        if (ext === '')
            candidate = `${candidate}.cea`;
        else if (ext === '.')
            candidate = `${candidate.slice(0, -1)}.cea`;
        const tries = [];
        if ((0, node_path_1.isAbsolute)(candidate)) {
            tries.push(candidate);
        }
        else {
            if (this.options.scriptPath) {
                tries.push((0, node_path_1.resolve)((0, node_path_1.dirname)(this.options.scriptPath), candidate));
            }
            tries.push((0, node_path_1.resolve)(process.cwd(), candidate));
            for (const dir of this.options.includeDirs ?? []) {
                tries.push((0, node_path_1.resolve)(dir, candidate));
            }
        }
        for (const p of tries) {
            if ((0, node_fs_1.existsSync)(p))
                return p;
        }
        throw new AutoAssemblerError(`include 的文件找不到："${requested}"（尝试过：${tries.join('、')}）`, { line: line.text, lineNumber: line.number, file: line.file });
    }
    /* ---------------------------------------------------------------- *
     * 步骤 2/3：预处理
     * ---------------------------------------------------------------- */
    /**
     * 遍历选中段的每一行，把 CE 指令转换成"汇编行"。
     *
     * 处理顺序与 CE 的解析循环一致：先做指令匹配，未匹配的按普通汇编行处理
     * （因此 `db/nop/align` 也走这里）。
     */
    preprocess(lines, run, createdAllocations) {
        for (const line of lines) {
            const text = line.text;
            if (text === '')
                continue;
            // 已处理掉的段标记（保险）
            if (/^\[\/?\d+-?BIT\]$/i.test(text) || /^\[(ENABLE|DISABLE)\]$/i.test(text))
                continue;
            // 条件编译：CE 的 {$...}，本移植不支持
            if (/^\{\$/.test(text)) {
                throw this.error(line, 'CE 的条件编译指令 {$...} 未实现；请用 [32-BIT]/[64-BIT] 段或事先裁剪脚本');
            }
            // ---- include 已在上一步展开，这里不应再出现 ----
            if (parseCall(text, 'include') !== null) {
                throw this.error(line, 'include() 应在展开阶段处理（内部错误）');
            }
            // ---- aobscan 系列 ----
            if (this.tryAobScan(text, line, run))
                continue;
            // ---- createthread ----
            if (this.tryCreateThread(text, line, run))
                continue;
            // ---- 分配类 ----
            if (this.tryAlloc(text, line, run, createdAllocations))
                continue;
            // ---- 符号声明 ----
            if (this.trySymbolDirective(text, line, run))
                continue;
            // ---- define ----
            const defineArgs = parseCall(text, 'define');
            if (defineArgs !== null) {
                this.handleDefine(defineArgs, line, run);
                continue;
            }
            // ---- readmem / loadbinary / assert ----
            if (this.tryMemoryUtility(text, line, run))
                continue;
            // ---- 明确不支持的指令：给出可操作的中文错误 ----
            const unsupported = this.matchUnsupported(text);
            if (unsupported) {
                throw this.error(line, `指令 ${unsupported} 本移植未实现（详见 docs/autoassembler.md 的「已知限制」）`);
            }
            // ---- 普通汇编行：先应用 define 文本替换 ----
            const substituted = this.applyDefines(text, run);
            // 地址定义行（`name:` / `00401000:` / `"game.exe"+1234:`）
            // ⚠️ 必须把 `run` 传下去：`parseAddressSetter` 内部要靠它查
            // 「本次运行内声明的符号」（alloc/label/define/aobscan/check 模式的 alloc），
            // 不传就会把 `newmem:` 这类合法写法判成未定义（见 lookupSymbol 的注释）。
            const setter = this.parseAddressSetter(substituted, line, run);
            if (setter) {
                for (const lab of setter.labels)
                    run.definedLabelNames.add(lab.name.toLowerCase());
                run.asmLines.push({
                    text: setter.rest,
                    pseudo: setter.rest ? (0, autoassembler_directives_1.parsePseudoDirective)(setter.rest) : null,
                    readmemBytes: null,
                    labels: setter.labels,
                    raw: line.text,
                    lineNumber: line.number,
                    file: line.file,
                    address: 0n,
                    bytes: Buffer.alloc(0),
                });
                continue;
            }
            run.asmLines.push({
                text: substituted,
                pseudo: (0, autoassembler_directives_1.parsePseudoDirective)(substituted),
                readmemBytes: null,
                labels: [],
                raw: line.text,
                lineNumber: line.number,
                file: line.file,
                address: 0n,
                bytes: Buffer.alloc(0),
            });
        }
        // label() 声明了却从未定义：降级为警告（CE 这里直接报错）
        for (const [name, decl] of run.declaredLabels) {
            if (!run.definedLabelNames.has(name)) {
                run.warnings.push(`第 ${decl.lineNumber} 行 label(${name}) 声明了标签，但脚本里没有 "${name}:" 定义行` +
                    `（CE 会在此报错，本移植降级为警告）`);
            }
        }
    }
    /** 判断是否为明确不支持的指令；返回指令名（大写）或 null */
    matchUnsupported(text) {
        const m = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (!m)
            return null;
        const name = m[1].toLowerCase();
        for (const bad of UNSUPPORTED_DIRECTIVES) {
            if (name === bad)
                return m[1].toUpperCase();
        }
        return null;
    }
    /* ---------------------------------------------------------------- *
     * aobscan
     * ---------------------------------------------------------------- */
    tryAobScan(text, line, run) {
        // aobscanregion(name, start, stop, pattern)
        const regionArgs = parseCall(text, 'aobscanregion');
        if (regionArgs !== null) {
            const parts = this.splitTopLevel(regionArgs, 4);
            if (parts.length < 4) {
                throw this.error(line, 'aobscanregion 语法应为 aobscanregion(name, start, stop, 11 22 33 ** 55)');
            }
            const name = parts[0].trim();
            if (!isIdentifier(name))
                throw this.error(line, `aobscanregion 的名字 "${name}" 不是合法标识符`);
            const start = this.resolveExpression(parts[1].trim(), line, run);
            const stop = this.resolveExpression(parts[2].trim(), line, run);
            const pattern = parts[3].trim();
            this.performAobScan(name, pattern, line, run, { start, stop });
            return true;
        }
        // aobscanmodule(name, module, pattern)
        const moduleArgs = parseCall(text, 'aobscanmodule');
        if (moduleArgs !== null) {
            const parts = this.splitTopLevel(moduleArgs, 3);
            if (parts.length < 3) {
                throw this.error(line, 'aobscanmodule 语法应为 aobscanmodule(name, module, 11 22 33 ** 55)');
            }
            const name = parts[0].trim();
            if (!isIdentifier(name))
                throw this.error(line, `aobscanmodule 的名字 "${name}" 不是合法标识符`);
            const moduleName = unquote(parts[1].trim());
            const pattern = parts[2].trim();
            this.performAobScan(name, pattern, line, run, { module: moduleName });
            return true;
        }
        // aobscanunique(name, pattern) —— 命中多于一处的唯一性要求
        const uniqueArgs = parseCall(text, 'aobscanunique');
        if (uniqueArgs !== null) {
            const parts = this.splitTopLevel(uniqueArgs, 2);
            if (parts.length < 2) {
                throw this.error(line, 'aobscanunique 语法应为 aobscanunique(name, 11 22 33 ** 55)');
            }
            const name = parts[0].trim();
            if (!isIdentifier(name))
                throw this.error(line, `aobscanunique 的名字 "${name}" 不是合法标识符`);
            this.performAobScan(name, parts[1].trim(), line, run, { unique: true });
            return true;
        }
        // aobscan(name, pattern)
        const args = parseCall(text, 'aobscan');
        if (args !== null) {
            const parts = this.splitTopLevel(args, 2);
            if (parts.length < 2) {
                throw this.error(line, 'aobscan 语法应为 aobscan(name, 11 22 33 ** 55)');
            }
            const name = parts[0].trim();
            if (!isIdentifier(name))
                throw this.error(line, `aobscan 的名字 "${name}" 不是合法标识符`);
            this.performAobScan(name, parts[1].trim(), line, run, {});
            return true;
        }
        return false;
    }
    /** 按 `maxParts` 上限在顶层逗号处切分（引号内不切） */
    splitTopLevel(text, maxParts) {
        const out = [];
        let current = '';
        let quote = null;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (quote !== null) {
                current += ch;
                if (ch === quote)
                    quote = null;
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                current += ch;
                continue;
            }
            if (ch === ',' && out.length < maxParts - 1) {
                out.push(current);
                current = '';
                continue;
            }
            current += ch;
        }
        out.push(current);
        return out;
    }
    performAobScan(name, pattern, line, run, scope) {
        if (pattern === '')
            throw this.error(line, 'AOB 特征串不能为空');
        const proc = this.options.process;
        if (run.syntaxCheckOnly || !proc) {
            // 语法检查模式：拿不到地址，用 0 占位（对齐 CE 把 AOBSCAN 换成 DEFINE(name,0)）
            run.warnings.push(`第 ${line.number} 行 aobscan(${name}) 在语法检查模式下按地址 0 占位`);
            this.registerSymbol(name, 0n, run, line);
            return;
        }
        const blockSize = this.options.scanBlockSize ?? DEFAULT_SCAN_BLOCK_SIZE;
        let results;
        if (scope.module !== undefined) {
            const mod = findModule(proc.modules(), scope.module);
            if (!mod) {
                throw this.error(line, `aobscanmodule 找不到模块 "${scope.module}"`, 'scan');
            }
            results = scanAobInRegions(proc, pattern, [
                {
                    baseAddress: mod.baseAddress,
                    memorySize: BigInt(mod.size),
                    committed: true,
                    protect: 0,
                    type: 0,
                },
            ], blockSize);
        }
        else if (scope.start !== undefined && scope.stop !== undefined) {
            const start = scope.start < scope.stop ? scope.start : scope.stop;
            const stop = scope.start < scope.stop ? scope.stop : scope.start;
            const regions = proc
                .scannableRegions({})
                .filter((r) => r.baseAddress < stop && r.baseAddress + r.memorySize > start)
                .map((r) => ({
                ...r,
                baseAddress: r.baseAddress < start ? start : r.baseAddress,
                memorySize: (r.baseAddress + r.memorySize > stop ? stop : r.baseAddress + r.memorySize) -
                    (r.baseAddress < start ? start : r.baseAddress),
            }));
            results = scanAobInRegions(proc, pattern, regions, blockSize);
        }
        else {
            results = scanAobUnrestricted(proc, pattern, blockSize, this.options.scanParallel === true);
        }
        if (results.length === 0) {
            throw this.error(line, `aobscan(${name}) 在目标进程里找不到特征码 "${pattern}"`, 'scan');
        }
        if (scope.unique === true && results.length > 1) {
            throw this.error(line, `aobscanunique(${name}) 期望唯一命中，实际找到 ${results.length} 处` +
                `（前几处：${results.slice(0, 4).map((a) => '0x' + a.toString(16)).join('、')}）`, 'scan');
        }
        const address = results[0];
        const scanKind = scope.unique === true
            ? 'unique'
            : scope.module !== undefined
                ? 'module'
                : scope.start !== undefined
                    ? 'region'
                    : 'all';
        run.aobScans.push({ name, matches: [...results], address, scope: scanKind });
        if (results.length > 1) {
            run.warnings.push(`第 ${line.number} 行 aobscan(${name}) 命中 ${results.length} 处，取第一处 ` +
                `0x${address.toString(16)}（CE 同样取第一处；可用 aobscanunique 强制唯一）`);
        }
        this.registerSymbol(name, address, run, line);
    }
    /* ---------------------------------------------------------------- *
     * createthread
     * ---------------------------------------------------------------- */
    tryCreateThread(text, line, run) {
        const args = parseCall(text, 'createthreadandwait') ?? parseCall(text, 'createthread');
        if (args === null)
            return false;
        const isWait = /^createthreadandwait/i.test(text);
        const parts = this.splitTopLevel(args, isWait ? 2 : 1);
        if (isWait) {
            // createthreadandwait(name, timeout)：name 是标签，timeout 是毫秒（十进制）
            const name = parts[0].trim();
            if (name === '')
                throw this.error(line, 'createthreadandwait 需要一个标签参数');
            if (parts.length >= 2 && parts[1].trim() !== '') {
                const timeout = parseCount(parts[1].trim(), 'createthreadandwait 的超时');
                void timeout;
            }
            if (this.options.allowCreateThread === true) {
                throw this.error(line, '本移植不支持在目标进程创建远程线程（Node 无 CreateRemoteThread 对应能力）；' +
                    '请把 allowCreateThread 保持为 false，此时 createthreadandwait 只做参数校验');
            }
            // 校验标签可解析
            const address = run.symbols.get(name.toLowerCase());
            if (address === undefined && !run.declaredLabels.has(name.toLowerCase())) {
                run.warnings.push(`第 ${line.number} 行 createthreadandwait(${name})：标签未在此前定义，运行期才能确定地址`);
            }
            run.warnings.push(`第 ${line.number} 行 createthreadandwait(${name}) 仅做参数校验，未创建线程`);
            return true;
        }
        const expr = args.trim();
        if (expr === '') {
            throw this.error(line, 'createthread 语法应为 createthread(address)');
        }
        const address = this.resolveExpression(expr, line, run);
        if (this.options.allowCreateThread === true) {
            throw this.error(line, '本移植不支持在目标进程创建远程线程（Node 无 CreateRemoteThread 对应能力）；' +
                '请把 allowCreateThread 保持为 false，此时 createthread 只做参数校验');
        }
        run.createThreads.push(address);
        run.warnings.push(`第 ${line.number} 行 createthread(0x${address.toString(16)}) 仅做参数校验，未创建线程`);
        return true;
    }
    /* ---------------------------------------------------------------- *
     * alloc / dealloc / realloc / globalalloc
     * ---------------------------------------------------------------- */
    tryAlloc(text, line, run, createdAllocations) {
        // globalalloc(name, size)
        const globalArgs = parseCall(text, 'globalalloc');
        if (globalArgs !== null) {
            const parts = this.splitTopLevel(globalArgs, 2);
            if (parts.length < 2)
                throw this.error(line, 'globalalloc 语法应为 globalalloc(name, size)');
            const name = parts[0].trim();
            if (!isIdentifier(name))
                throw this.error(line, `globalalloc 的名字 "${name}" 不是合法标识符`);
            const size = parseCount(parts[1].trim(), 'globalalloc 的大小');
            this.allocate(name, size, run, line, true, 0n, createdAllocations);
            return true;
        }
        // alloc(name, size[, preferred])
        const allocArgs = parseCall(text, 'alloc');
        if (allocArgs !== null) {
            const parts = this.splitTopLevel(allocArgs, 3);
            if (parts.length < 2)
                throw this.error(line, 'alloc 语法应为 alloc(name, sizeinbytes)');
            const name = parts[0].trim();
            if (!isIdentifier(name))
                throw this.error(line, `alloc 的名字 "${name}" 不是合法标识符`);
            const size = parseCount(parts[1].trim(), 'alloc 的大小');
            const preferred = parts.length >= 3 && parts[2].trim() !== ''
                ? this.resolveExpression(parts[2].trim(), line, run)
                : 0n;
            this.allocate(name, size, run, line, false, preferred, createdAllocations);
            return true;
        }
        // realloc(name, size)
        const reallocArgs = parseCall(text, 'realloc');
        if (reallocArgs !== null) {
            const parts = this.splitTopLevel(reallocArgs, 2);
            if (parts.length < 2)
                throw this.error(line, 'realloc 语法应为 realloc(name, size)');
            const name = parts[0].trim();
            const size = parseCount(parts[1].trim(), 'realloc 的大小');
            const existing = this.allocations.get(name);
            if (!existing) {
                throw this.error(line, `realloc("${name}") 找不到已分配的块；请先用 alloc 分配`);
            }
            const proc = this.options.process;
            if (proc && !run.syntaxCheckOnly) {
                try {
                    proc.free(existing.address);
                }
                catch (e) {
                    throw this.error(line, `realloc 释放旧块失败：${e.message}`, 'write');
                }
                this.allocations.delete(name);
                this.persistentSymbols.delete(name.toLowerCase());
                this.dropHistoryRange(run.history, existing.address, existing.size);
                this.allocate(name, size, run, line, existing.global, 0n, createdAllocations);
            }
            else {
                existing.size = size;
                run.warnings.push(`第 ${line.number} 行 realloc(${name}) 在语法检查模式下未真正执行`);
            }
            return true;
        }
        // dealloc(name) / dealloc(*)
        const deallocArgs = parseCall(text, 'dealloc');
        if (deallocArgs !== null) {
            const target = deallocArgs.trim();
            if (target === '')
                throw this.error(line, 'dealloc 语法应为 dealloc(name)');
            if (target === '*') {
                for (const name of [...this.allocations.keys()])
                    this.deallocate(name, run, line);
            }
            else {
                for (const name of splitNames(target))
                    this.deallocate(name, run, line, false);
            }
            return true;
        }
        return false;
    }
    allocate(name, size, run, line, global, preferred, createdAllocations) {
        if (size <= 0)
            throw this.error(line, `alloc(${name}) 的大小必须为正数，收到 ${size}`);
        const proc = this.options.process;
        const existingNamed = this.allocations.get(name);
        const reuseAllowed = this.options.reuseAllocations !== false;
        if (existingNamed && reuseAllowed) {
            this.registerSymbol(name, existingNamed.address, run, line);
            if (global)
                existingNamed.global = true;
            run.warnings.push(`第 ${line.number} 行 alloc(${name})：该名字已分配在 0x${existingNamed.address.toString(16)}，` +
                `复用之（如需重新分配请先 dealloc 或设置 reuseAllocations:false）`);
            return;
        }
        if (run.syntaxCheckOnly || !proc) {
            // 语法检查：用 0 占位
            this.registerSymbol(name, 0n, run, line);
            return;
        }
        let address;
        try {
            address = proc.allocate(size, 0x40, preferred);
        }
        catch (e) {
            // 首选地址不可用时退化为"任意地址"分配（对齐 CE 的 lastChanceAllocPrefered）：
            // 真实场景里首选地址常常已被占用（VirtualAllocEx 返回 ERROR_INVALID_ADDRESS 487），
            // 这时 CE 也会放弃首选地址而不是让整个脚本失败。
            if (preferred !== 0n) {
                try {
                    address = proc.allocate(size, 0x40, 0n);
                    run.warnings.push(`第 ${line.number} 行 alloc(${name}, ${size}, 0x${preferred.toString(16)})：` +
                        `首选地址不可用（${e.message}），已改为任意地址分配`);
                }
                catch (e2) {
                    throw this.error(line, `alloc(${name}, ${size}) 在目标进程分配内存失败：${e2.message}`, 'write');
                }
            }
            else {
                throw this.error(line, `alloc(${name}, ${size}) 在目标进程分配内存失败：${e.message}`, 'write');
            }
        }
        this.allocations.set(name, {
            name,
            address,
            size,
            protection: 0x40,
            global,
        });
        createdAllocations.push(name);
        this.registerSymbol(name, address, run, line);
    }
    deallocate(name, run, line, quiet = false) {
        const alloc = this.allocations.get(name);
        if (!alloc) {
            if (quiet)
                return;
            // CE 的 dealloc 只释放"本脚本分配过的"内存；找不到时静默通过更接近用户预期
            run.warnings.push(`第 ${line.number} 行 dealloc(${name})：本会话没有名为 "${name}" 的分配，忽略`);
            return;
        }
        const proc = this.options.process;
        if (proc && !run.syntaxCheckOnly) {
            try {
                proc.free(alloc.address);
            }
            catch (e) {
                throw this.error(line, `dealloc(${name}) 释放内存失败：${e.message}`, 'write');
            }
        }
        // 内存已还给系统，对应的"原字节还原"记录必须一起丢掉
        this.dropHistoryRange(run.history, alloc.address, alloc.size);
        this.allocations.delete(name);
        this.persistentSymbols.delete(name.toLowerCase());
        // 如实记录"真的释放了哪一块"，供工具层在输出里确认（此前只有「还原 0 处」）
        run.deallocated.push({ name: alloc.name, address: alloc.address, size: alloc.size });
    }
    /* ---------------------------------------------------------------- *
     * label / registersymbol / unregistersymbol
     * ---------------------------------------------------------------- */
    trySymbolDirective(text, line, run) {
        const labelArgs = parseCall(text, 'label');
        if (labelArgs !== null) {
            const names = splitNames(labelArgs);
            if (names.length === 0)
                throw this.error(line, 'label 语法应为 label(name)');
            for (const name of names) {
                if (!isIdentifier(name))
                    throw this.error(line, `label("${name}") 不是合法标识符`);
                const key = name.toLowerCase();
                if (!run.declaredLabels.has(key)) {
                    run.declaredLabels.set(key, { name, lineNumber: line.number, file: line.file });
                }
            }
            return true;
        }
        const registerArgs = parseCall(text, 'registersymbol');
        if (registerArgs !== null) {
            const names = splitNames(registerArgs);
            if (names.length === 0)
                throw this.error(line, 'registersymbol 语法应为 registersymbol(name)');
            for (const name of names) {
                const key = name.toLowerCase();
                // CE 把 REGISTERSYMBOL 收集成一张表，等整个脚本汇编完（标签地址已知）
                // 再统一注册（autoassembler.pas 1971~1996 + 4350~4360）。这里同样延后解析。
                run.pendingRegisters.push({ name, line });
                const address = run.symbols.get(key) ?? this.persistentSymbols.get(key);
                if (address !== undefined) {
                    this.registeredSymbols.add(name);
                    this.persistentSymbols.set(key, address);
                }
            }
            return true;
        }
        const unregisterArgs = parseCall(text, 'unregistersymbol');
        if (unregisterArgs !== null) {
            const names = splitNames(unregisterArgs);
            if (names.length === 0)
                throw this.error(line, 'unregistersymbol 语法应为 unregistersymbol(name)');
            for (const name of names) {
                if (name === '*') {
                    for (const n of this.allocations.keys())
                        this.persistentSymbols.delete(n.toLowerCase());
                    this.registeredSymbols.clear();
                    continue;
                }
                this.registeredSymbols.delete(name);
                this.persistentSymbols.delete(name.toLowerCase());
            }
            return true;
        }
        return false;
    }
    /* ---------------------------------------------------------------- *
     * define
     * ---------------------------------------------------------------- */
    /**
     * `define(name, whatever)` —— **纯文本替换**，对齐 CE（autoassembler.pas 2004~2043）。
     *
     * 注意 CE 的语义细节：`whatever` 不是"值"而是"文本"。因此
     * `define(myVal, 1337)` 之后 `mov [x], myVal` 等价于 `mov [x], 1337`。
     * 值的解析发生在最终汇编/伪指令解析时，所以同一份 define 在指令里与
     * `db` 里的进制解释可能不同（详见 docs/autoassembler.md 的差异表）。
     */
    handleDefine(args, line, run) {
        const comma = args.indexOf(',');
        if (comma < 0) {
            throw this.error(line, 'define 语法应为 define(name,whatever)');
        }
        const name = args.slice(0, comma).trim();
        let value = args.slice(comma + 1).trim();
        if (name === '' || value === '') {
            throw this.error(line, 'define 语法应为 define(name,whatever)');
        }
        if (!isIdentifier(name))
            throw this.error(line, `define("${name}") 不是合法标识符`);
        // 早先的 define 会应用到后面的 define 值上（CE 同样如此）
        value = this.applyDefines(value, run, name);
        const key = name.toLowerCase();
        const existingIndex = run.defineOrder.indexOf(key);
        if (existingIndex >= 0) {
            run.defines.set(key, value);
            return;
        }
        run.defineOrder.push(key);
        run.defines.set(key, value);
    }
    /** 应用当前生效的全部 define（按定义顺序；跳过 `skipName` 自身，避免自替换） */
    applyDefines(text, run, skipName) {
        let out = text;
        for (const key of run.defineOrder) {
            if (skipName !== undefined && key === skipName.toLowerCase())
                continue;
            const value = run.defines.get(key);
            if (value === undefined)
                continue;
            out = replaceToken(out, key, value);
        }
        return out;
    }
    /* ---------------------------------------------------------------- *
     * readmem / loadbinary / assert
     * ---------------------------------------------------------------- */
    tryMemoryUtility(text, line, run) {
        // readmem(address, size)
        const readmemArgs = parseCall(text, 'readmem');
        if (readmemArgs !== null) {
            const parts = this.splitTopLevel(readmemArgs, 2);
            if (parts.length < 2)
                throw this.error(line, 'readmem 语法应为 readmem(address,size)');
            const address = this.resolveExpression(parts[0].trim(), line, run);
            const size = parseCount(parts[1].trim(), 'readmem 的长度');
            if (size <= 0)
                throw this.error(line, 'readmem 的长度必须为正数');
            const proc = this.options.process;
            let bytes;
            if (run.syntaxCheckOnly || !proc) {
                bytes = Buffer.alloc(size);
                run.warnings.push(`第 ${line.number} 行 readmem(0x${address.toString(16)}, ${size}) 在语法检查模式下按 0 填充`);
            }
            else {
                bytes = proc.readMemory(address, size);
                if (bytes.length !== size) {
                    throw this.error(line, `readmem(0x${address.toString(16)}, ${size}) 未能完整读取（实得 ${bytes.length} 字节）`, 'scan');
                }
            }
            run.asmLines.push({
                text: `db ${(0, autoassembler_directives_1.bytesToDbArguments)(bytes)}`,
                pseudo: { kind: 'db', args: (0, autoassembler_directives_1.bytesToDbArguments)(bytes) },
                readmemBytes: bytes,
                labels: [],
                raw: line.text,
                lineNumber: line.number,
                file: line.file,
                address: 0n,
                bytes: Buffer.alloc(0),
            });
            return true;
        }
        // loadbinary(address, filename)
        const loadArgs = parseCall(text, 'loadbinary');
        if (loadArgs !== null) {
            const comma = loadArgs.indexOf(',');
            if (comma < 0)
                throw this.error(line, 'loadbinary 语法应为 loadbinary(address,filename)');
            const address = this.resolveExpression(loadArgs.slice(0, comma).trim(), line, run);
            const filename = unquote(loadArgs.slice(comma + 1).trim());
            if (filename === '')
                throw this.error(line, 'loadbinary 需要一个文件名');
            const path = (0, node_path_1.isAbsolute)(filename)
                ? filename
                : (0, node_path_1.resolve)(this.options.scriptPath ? (0, node_path_1.dirname)(this.options.scriptPath) : process.cwd(), filename);
            if (!(0, node_fs_1.existsSync)(path)) {
                throw this.error(line, `loadbinary 的文件不存在："${filename}"（解析为 ${path}）`);
            }
            const bytes = (0, node_fs_1.readFileSync)(path);
            run.directWrites.push({
                address,
                bytes,
                raw: line.text,
                lineNumber: line.number,
                file: line.file,
            });
            return true;
        }
        // assert(address, aob)
        const assertArgs = parseCall(text, 'assert');
        if (assertArgs !== null) {
            const parts = this.splitTopLevel(assertArgs, 2);
            if (parts.length < 2) {
                throw this.error(line, 'assert 语法应为 assert(address,11 22 33 ** 55 66)');
            }
            const address = this.resolveExpression(parts[0].trim(), line, run);
            const patternText = parts[1].trim();
            const pattern = (0, value_codec_1.parseAob)(patternText);
            if (pattern.length === 0) {
                throw this.error(line, `assert 的特征串 "${patternText}" 无效`);
            }
            const proc = this.options.process;
            if (!run.syntaxCheckOnly && proc) {
                const actual = proc.readMemory(address, pattern.length);
                if (actual.length !== pattern.length) {
                    throw this.error(line, `assert：地址 0x${address.toString(16)} 的内存读不出来`, 'scan');
                }
                const nibble = (0, value_codec_1.aobHasNibbleWildcard)(pattern);
                if (!(0, value_codec_1.aobMatchesAt)(actual, 0, pattern, nibble)) {
                    throw this.error(line, `assert 失败：地址 0x${address.toString(16)} 处期望 ${patternText.toUpperCase()}，` +
                        `实际 ${(0, autoassembler_directives_1.bytesToDbArguments)(actual).toUpperCase()}（CE 的 rsTheBytesAtAreNotWhatWasExpected）`, 'scan');
                }
            }
            else {
                run.warnings.push(`第 ${line.number} 行 assert 在语法检查模式下跳过校验`);
            }
            return true;
        }
        return false;
    }
    /* ---------------------------------------------------------------- *
     * 地址定义行
     * ---------------------------------------------------------------- */
    /**
     * 解析地址定义行。支持三种形态：
     *
     *   1. `newmem:`                        —— 已知符号（alloc/aobscan/registered）→ 重置当前地址
     *   2. `returnhere:`                    —— 脚本标签 → 取当前地址
     *   3. `00401000:` / `"game.exe"+1234:` —— 地址表达式 → 重置当前地址
     *
     * 也支持 `name: 指令` 的同行写法（CE 只支持独立定义行，这里是超集）。
     */
    parseAddressSetter(text, line, run) {
        let rest = text;
        const labels = [];
        for (let guard = 0; guard < 4; guard++) {
            // 情况 A/B：标识符标签（`name:` 或 `name: insn`）
            const identMatch = rest.match(/^([A-Za-z_.$?@][\w.$?@]*)\s*:\s*([\s\S]*)$/);
            if (identMatch) {
                const name = identMatch[1];
                // ⚠️ 传 run：让本次运行内声明的符号（alloc/label/…）能被认出来。
                // 少这一句的话，check 模式下所有引用自己 alloc 出来的块名的脚本都会失败。
                const known = this.lookupSymbol(name, run);
                labels.push({ name, known });
                rest = identMatch[2].trim();
                if (rest === '')
                    break;
                continue;
            }
            // 情况 C：整行以 `:` 结尾且前半不是标识符 → 地址表达式
            const exprMatch = rest.match(/^([\s\S]*?):\s*$/);
            if (exprMatch && labels.length === 0) {
                const expression = exprMatch[1].trim();
                // allowCheckPlaceholder：check 模式（无目标进程）下，"模块+偏移"形状的
                // 地址定义行用一个合成地址继续布局，而不是直接误报。
                const address = this.resolveExpression(expression, line, run, true);
                labels.push({ name: expression, known: address });
                rest = '';
                break;
            }
            break;
        }
        if (labels.length === 0)
            return null;
        return { labels, rest };
    }
    /**
     * 把布局得到的标签地址登记为符号。
     *
     * 对齐 CE：脚本里的 `label(x)` + `x:` 也会进入符号表
     * （`disableinfo.allsymbols`，autoassembler.pas 4350~4360），
     * 因此同一个会话里后续脚本 / [DISABLE] 段都能引用它。
     */
    commitLabelSymbols(run) {
        for (const [name, address] of run.labelAddresses) {
            run.symbols.set(name, address);
            if (!run.syntaxCheckOnly)
                this.persistentSymbols.set(name, address);
        }
    }
    /**
     * 解析延后的 `registersymbol` 请求。
     *
     * 必须在布局之后调用：`registersymbol(mylabel)` 里的标签地址只有在
     * 所有指令长度确定之后才是最终值。
     */
    resolvePendingRegisters(run) {
        for (const pending of run.pendingRegisters) {
            const key = pending.name.toLowerCase();
            const address = run.symbols.get(key) ??
                run.labelAddresses.get(key) ??
                this.persistentSymbols.get(key);
            if (address === undefined) {
                run.warnings.push(`第 ${pending.line.number} 行 registersymbol(${pending.name})：脚本里找不到符号 ` +
                    `"${pending.name}"（CE 会注册一个未解析的符号，本移植记警告并跳过）`);
                continue;
            }
            run.symbols.set(key, address);
            if (!run.syntaxCheckOnly) {
                this.registeredSymbols.add(pending.name);
                this.persistentSymbols.set(key, address);
            }
        }
    }
    /** 查符号（alloc/aobscan/registered/持久符号），忽略大小写 */
    /**
   * 查符号 → 地址。
   *
   * ⚠️ **必须同时查 `run.symbols`**（本次运行内声明的名字）。
   *
   * 早先这里只查 `this.allocations` 与 `this.persistentSymbols` 两个**跨运行**的表，
   * 而 `run.symbols`（本次 `[ENABLE]` 段里 `alloc`/`label`/`define`/`aobscan`
   * 刚声明出来的名字）**完全没被查**。同文件的 `resolveExpression()` 却查了它 ——
   * 于是同一个符号，走表达式解析能用、走 `lookupSymbol` 就报「未定义的符号」。
   *
   * 在 `syntaxCheckOnly`（`ce_auto_assemble action=check`）下这个问题尤其致命：
   * check 模式不分配真实内存，所以这些名字**只会**存在于 `run.symbols` 里
   * （`allocate()` 走的是 `registerSymbol(name, 0n, run, line)`），
   * `persistentSymbols` 按设计不会被写入。于是任何引用自己 alloc 出来的块名的脚本
   * —— 也就是所有正常的 AA 脚本 —— 在 check 下都会报「未定义的符号」。
   * check 恰恰是"开工前安全预校验"的唯一手段，功能最需要它时反而不可用。
   */
    lookupSymbol(name, run) {
        const key = name.toLowerCase();
        // 本次运行内声明的符号优先（label/define/aobscan/registersymbol/check 模式的 alloc）
        const fromRun = run?.symbols.get(key);
        if (fromRun !== undefined)
            return fromRun;
        const fromAlloc = this.allocations.get(name);
        if (fromAlloc)
            return fromAlloc.address;
        const persisted = this.persistentSymbols.get(key);
        if (persisted !== undefined)
            return persisted;
        return null;
    }
    /**
     * 求值地址表达式。
     *
     * 优先按 CE 的整数语义解析裸数字（十六进制），否则交给 `resolveAddress`；
     * 送进去之前会把裸数字改写成 `0x` 形式（`hexifyBareNumbers`），
     * 因为 `addr/expression.ts` 把无 a-f 字母的裸数字当十进制。
     */
    resolveExpression(expression, line, run, allowCheckPlaceholder = false) {
        const expr = expression.trim();
        if (expr === '')
            throw this.error(line, '地址表达式为空');
        // 1) 纯数字：CE 十六进制语义
        const numeric = (0, autoassembler_directives_1.parseCeInteger)(expr, true);
        if (numeric !== null)
            return numeric;
        // 2) 已注册符号
        const key = expr.toLowerCase();
        const known = run?.symbols.get(key) ??
            this.allocations.get(expr)?.address ??
            this.persistentSymbols.get(key);
        if (known !== undefined)
            return known;
        // 3) 地址表达式（模块+偏移、指针解引用等）
        const proc = this.options.process;
        try {
            if (!proc) {
                // 没有进程时至少做语法校验
                void hexifyBareNumbers(expr);
                throw new Error('语法检查模式无法求值地址表达式（需要目标进程解析模块/指针）');
            }
            if (this.moduleCache.length === 0) {
                this.moduleCache = proc.modules().map((m) => ({
                    name: m.name,
                    baseAddress: m.baseAddress,
                    size: m.size,
                }));
            }
            if (allowCheckPlaceholder && (run?.syntaxCheckOnly ?? false)) {
                const placeholder = checkModulePlaceholder(expr, this.moduleCache);
                if (placeholder !== null)
                    return placeholder;
            }
            return (0, expression_1.resolveAddress)(hexifyBareNumbers(expr), {
                process: proc,
                symbols: run?.symbols ?? this.persistentSymbols,
                moduleCache: this.moduleCache,
            });
        }
        catch (e) {
            // check 模式下没有目标进程时，"模块+偏移"形状的地址定义行给一个合成地址 ——
            // 否则每一份以 `"game.exe"+1234:` 开头的正常脚本都会在 check 下误报。
            // 见 CHECK_MODULE_EXPRESSION_RE / checkModulePlaceholder 的说明。
            if (allowCheckPlaceholder && (run?.syntaxCheckOnly ?? false)) {
                const placeholder = checkModulePlaceholder(expr, this.moduleCache);
                if (placeholder !== null)
                    return placeholder;
            }
            throw this.error(line, `无法求值地址表达式 "${expr}"：${e.message}`, 'parse');
        }
    }
    /* ---------------------------------------------------------------- *
     * 符号注册
     * ---------------------------------------------------------------- */
    registerSymbol(name, address, run, line) {
        const key = name.toLowerCase();
        run.symbols.set(key, address);
        // 语法检查模式下不污染会话的持久符号表（那里会写入 0 占位地址）
        if (!run.syntaxCheckOnly)
            this.persistentSymbols.set(key, address);
        void line;
    }
    /* ---------------------------------------------------------------- *
     * 布局（迭代到指令长度稳定）
     * ---------------------------------------------------------------- */
    layout(run) {
        const asmLines = run.asmLines;
        const allLabelNames = new Set();
        for (const l of asmLines)
            for (const lab of l.labels)
                allLabelNames.add(lab.name.toLowerCase());
        let prevLabelAddrs = new Map();
        let converged = false;
        for (let pass = 0; pass < MAX_LAYOUT_PASSES; pass++) {
            const labelAddrs = new Map();
            const definedSoFar = new Set();
            // ⚠️ **语法检查模式必须给一个合成的起始地址**。
            //
            // 早先这里是 `this.options.startAddress ?? 0n` 且 `addressSet = startAddress !== undefined`，
            // 于是 check 模式下 `addressSet` **恒为 false**：即便脚本第一行是
            // `alloc(newmem,$1000)`（`allocate()` 已经用 `registerSymbol(name, 0n)`
            // 把 newmem 登记成符号了），布局器也认为"到目前为止没有任何地址定义"，
            // 于是从第一行代码开始全部抛「尚未指定它应写入的地址」/「此前没有任何地址定义行」。
            //
            // 后果是**含 alloc 的正常脚本在 check 下必失败**，而 check 恰恰是
            // "开工前安全预校验"的唯一手段 —— 等于这个功能最需要它的时候不能用。
            //
            // 真实执行路径（enable）里，`allocate()` 拿到的是 `VirtualAllocEx` 返回的
            // 真实地址，`lab.known !== null` 会把 `addressSet` 置 true，所以一直没问题。
            // 这里给 check 用一个**合成的、明显不是真实地址**的基准值：
            // 取 0x140000000（x64 常见的模块基址区间），既能承载相对跳转的编码计算，
            // 又不会和任何真实地址混淆（真执行时这些值会被丢弃）。
            const checkBase = run.syntaxCheckOnly ? CHECK_LAYOUT_BASE_ADDRESS : 0n;
            let address = this.options.startAddress ?? checkBase;
            let addressSet = this.options.startAddress !== undefined || run.syntaxCheckOnly;
            run.warnings.length = run.warningBaseLength;
            for (const asmLine of asmLines) {
                // 1) 先处理本行的标签定义（地址定义 / 标签取值）
                for (const lab of asmLine.labels) {
                    const key = lab.name.toLowerCase();
                    if (lab.known !== null) {
                        address = lab.known;
                        addressSet = true;
                        labelAddrs.set(key, address);
                    }
                    else {
                        if (!addressSet) {
                            throw new AutoAssemblerError(`第 ${asmLine.lineNumber} 行定义了标签 "${lab.name}"，但此前没有任何地址定义行；` +
                                `脚本开头需要先写 alloc 的块名（如 "newmem:"）或地址/模块表达式（如 "game.exe"+1234:）`, {
                                line: asmLine.raw,
                                lineNumber: asmLine.lineNumber,
                                file: asmLine.file,
                                phase: 'assemble',
                            });
                        }
                        labelAddrs.set(key, address);
                    }
                    definedSoFar.add(key);
                }
                asmLine.address = address;
                // 2) 空行（纯标签行）不产生字节
                if (asmLine.text === '' && asmLine.pseudo === null) {
                    asmLine.bytes = Buffer.alloc(0);
                    continue;
                }
                if (!addressSet) {
                    throw new AutoAssemblerError(`第 ${asmLine.lineNumber} 行有代码但尚未指定它应写入的地址；` +
                        `请先用 "allocname:" 或 "module+offset:" 这样的地址定义行定位`, {
                        line: asmLine.raw,
                        lineNumber: asmLine.lineNumber,
                        file: asmLine.file,
                        phase: 'assemble',
                    });
                }
                // 3) 编码
                if (asmLine.pseudo !== null) {
                    asmLine.bytes = this.encodePseudo(asmLine, run, address);
                }
                else {
                    asmLine.bytes = this.encodeInstruction(asmLine, run, address, allLabelNames, definedSoFar, prevLabelAddrs);
                }
                address += BigInt(asmLine.bytes.length);
            }
            // 4) 判断是否收敛
            run.labelAddresses = labelAddrs;
            if (this.sameLabelMap(prevLabelAddrs, labelAddrs)) {
                converged = true;
                break;
            }
            prevLabelAddrs = labelAddrs;
        }
        if (!converged) {
            throw new AutoAssemblerError(`地址布局在 ${MAX_LAYOUT_PASSES} 轮内没有稳定（前向引用的标签导致指令长度反复变化）。` +
                `请把被引用的标签定义移到引用之前，或改用固定长度的写法。`, { phase: 'assemble' });
        }
    }
    sameLabelMap(a, b) {
        if (a.size !== b.size)
            return false;
        for (const [k, v] of a) {
            const other = b.get(k);
            if (other === undefined || other !== v)
                return false;
        }
        return true;
    }
    /** 编码 `db/dw/dd/dq`、`nop N`、`align N[,b]` */
    encodePseudo(asmLine, run, address) {
        const pseudo = asmLine.pseudo;
        if (!pseudo)
            return Buffer.alloc(0);
        void run;
        try {
            if (pseudo.kind === 'db' || pseudo.kind === 'dw' || pseudo.kind === 'dd' || pseudo.kind === 'dq') {
                const proc = this.options.process;
                const result = (0, autoassembler_directives_1.encodeDataDirective)(pseudo.kind, pseudo.args, {
                    address,
                    hexDefault: this.options.dataHexDefault !== false,
                    readByte: proc && !run.syntaxCheckOnly
                        ? (addr) => {
                            const b = proc.readMemory(addr, 1);
                            return b.length === 1 ? b[0] : null;
                        }
                        : undefined,
                });
                for (const w of result.warnings) {
                    run.warnings.push(`第 ${asmLine.lineNumber} 行 ${w}`);
                }
                return result.bytes;
            }
            if (pseudo.kind === 'nop') {
                const count = (0, autoassembler_directives_1.parseCeInteger)(pseudo.args, true);
                if (count === null)
                    throw new Error(`nop 的数量 "${pseudo.args}" 无法解析`);
                const n = Number(count);
                if (!Number.isSafeInteger(n) || n < 0)
                    throw new Error(`nop 的数量 ${count} 不合法`);
                return (0, autoassembler_directives_1.encodeNop)(n);
            }
            if (pseudo.kind === 'align') {
                const tokens = (0, autoassembler_directives_1.splitDirectiveArguments)(pseudo.args);
                const alignment = (0, autoassembler_directives_1.parseCeInteger)(tokens[0], true);
                if (alignment === null || alignment <= 0n) {
                    throw new Error(`align 的对齐值 "${tokens[0]}" 无法解析或不是正数`);
                }
                const fill = tokens[1] !== undefined ? (0, autoassembler_directives_1.parseCeInteger)(tokens[1], true) : 0n;
                if (fill === null)
                    throw new Error(`align 的填充字节 "${tokens[1]}" 无法解析`);
                return (0, autoassembler_directives_1.encodeAlign)(address, alignment, Number(fill & 0xffn));
            }
        }
        catch (e) {
            if (e instanceof AutoAssemblerError)
                throw e;
            throw new AutoAssemblerError(e.message, {
                line: asmLine.raw,
                lineNumber: asmLine.lineNumber,
                file: asmLine.file,
                phase: 'assemble',
            });
        }
        throw new AutoAssemblerError(`未处理的伪指令 ${pseudo.kind}`, {
            line: asmLine.raw,
            lineNumber: asmLine.lineNumber,
            file: asmLine.file,
            phase: 'assemble',
        });
    }
    /**
     * 编码一条指令。
     *
     * 前向引用的标签用「近/远两个占位符各编一次、取较长者」的策略
     * （对齐 CE autoassembler.pas 3741~3763 行），保证地址不会因为
     * 编码从长变短而漂移。
     */
    encodeInstruction(asmLine, run, address, allLabelNames, definedSoFar, prevLabelAddrs) {
        const base = new Map();
        for (const [k, v] of this.persistentSymbols)
            base.set(k, v);
        for (const [k, v] of run.symbols)
            base.set(k, v);
        for (const [k, v] of definedSoFar) {
            const own = prevLabelAddrs.get(k);
            if (own !== undefined)
                base.set(k, own);
        }
        const unresolved = [];
        for (const name of allLabelNames) {
            if (base.has(name))
                continue;
            const prev = prevLabelAddrs.get(name);
            if (prev !== undefined)
                base.set(name, prev);
            else
                unresolved.push(name);
        }
        const bitness = run.bitness;
        const arch = run.arch;
        if (unresolved.length === 0) {
            return this.assembleLine(asmLine, asmLine.text, address, base, bitness, arch);
        }
        const closeSymbols = new Map(base);
        const farSymbols = new Map(base);
        for (const name of unresolved) {
            closeSymbols.set(name, address);
            farSymbols.set(name, address + FAR_PLACEHOLDER_DELTA);
        }
        const close = this.tryAssembleLine(asmLine, asmLine.text, address, closeSymbols, bitness, arch);
        const far = this.tryAssembleLine(asmLine, asmLine.text, address, farSymbols, bitness, arch);
        if (close === null && far === null) {
            // 两种占位符都失败：用近距离方案再跑一次以产生可读的错误
            return this.assembleLine(asmLine, asmLine.text, address, closeSymbols, bitness, arch);
        }
        if (close === null)
            return far;
        if (far === null)
            return close;
        return far.length >= close.length ? far : close;
    }
    tryAssembleLine(asmLine, text, address, symbols, bitness, arch) {
        try {
            return (0, assembler_1.assemble)(text, { address, arch, bitness, symbols }).bytes;
        }
        catch {
            void asmLine;
            return null;
        }
    }
    assembleLine(asmLine, text, address, symbols, bitness, arch) {
        try {
            return (0, assembler_1.assemble)(text, { address, arch, bitness, symbols }).bytes;
        }
        catch (e) {
            if (e instanceof assembler_1.AssemblerError) {
                throw new AutoAssemblerError(e.message.replace(/^汇编失败（第 \d+ 行："[^"]*"）：/, '').replace(/^汇编失败：/, ''), {
                    line: asmLine.raw,
                    lineNumber: asmLine.lineNumber,
                    file: asmLine.file,
                    phase: 'assemble',
                });
            }
            throw new AutoAssemblerError(e.message, {
                line: asmLine.raw,
                lineNumber: asmLine.lineNumber,
                file: asmLine.file,
                phase: 'assemble',
            });
        }
    }
    /* ---------------------------------------------------------------- *
     * 应用（写目标进程）
     * ---------------------------------------------------------------- */
    apply(run, enable) {
        const proc = this.options.process;
        const entries = [];
        let bytesWritten = 0;
        const failures = [];
        const history = run.history;
        // ---- DISABLE + restoreMode 'original'：先按历史逆序精确还原 ----------
        if (!enable && (this.options.restoreMode ?? 'original') === 'original') {
            for (const record of [...history].reverse()) {
                const entry = {
                    address: record.address,
                    bytes: record.bytes,
                    originalBytes: null,
                    restoredFromOriginal: true,
                    line: '<ENABLE 期间记录的原字节>',
                    lineNumber: 0,
                    file: '<history>',
                };
                if (proc && !run.syntaxCheckOnly) {
                    try {
                        this.writeBlock(proc, record.address, record.bytes, entry);
                    }
                    catch (e) {
                        if (e instanceof AutoAssemblerError) {
                            // 单条失败不应阻断其余还原：记录后继续，最后统一抛出
                            failures.push(e.message);
                            continue;
                        }
                        throw e;
                    }
                    bytesWritten += record.bytes.length;
                }
                entries.push(entry);
            }
        }
        // ---- 脚本自身产生的写入 -------------------------------------------
        const lineEntries = [];
        for (const asmLine of run.asmLines) {
            if (asmLine.bytes.length === 0)
                continue;
            lineEntries.push({
                address: asmLine.address,
                bytes: asmLine.bytes,
                line: asmLine.raw,
                lineNumber: asmLine.lineNumber,
                file: asmLine.file,
            });
        }
        for (const dw of run.directWrites) {
            lineEntries.push({
                address: dw.address,
                bytes: dw.bytes,
                line: dw.raw,
                lineNumber: dw.lineNumber,
                file: dw.file,
            });
        }
        for (const item of lineEntries) {
            // DISABLE + original 模式：与历史重叠的区间已经被精确还原，跳过
            if (!enable && (this.options.restoreMode ?? 'original') === 'original') {
                if (isCoveredByHistory(history, item.address, item.bytes.length))
                    continue;
            }
            const entry = {
                address: item.address,
                bytes: item.bytes,
                originalBytes: null,
                restoredFromOriginal: false,
                line: item.line,
                lineNumber: item.lineNumber,
                file: item.file,
            };
            if (proc && !run.syntaxCheckOnly) {
                entry.originalBytes = this.readOriginal(proc, item.address, item.bytes.length);
                this.writeBlock(proc, item.address, item.bytes, entry);
                bytesWritten += item.bytes.length;
            }
            entries.push(entry);
        }
        // ENABLE 期间记录的原字节：DISABLE 时就是靠它们精确还原的
        if (enable && proc && !run.syntaxCheckOnly) {
            for (const entry of entries) {
                if (entry.originalBytes && entry.originalBytes.length > 0) {
                    this.recordOriginal(history, entry.address, entry.originalBytes);
                }
            }
        }
        if (failures.length > 0) {
            throw new AutoAssemblerError(`还原原字节时有 ${failures.length} 处写入失败（其余已还原）：\n  ` + failures.join('\n  '), { phase: 'write' });
        }
        return { entries, bytesWritten };
    }
    readOriginal(proc, address, length) {
        try {
            const buf = proc.readMemory(address, length);
            if (buf.length !== length)
                return null;
            return Buffer.from(buf);
        }
        catch {
            return null;
        }
    }
    writeBlock(proc, address, bytes, entry) {
        try {
            const written = proc.writeMemory(address, bytes, true);
            if (written !== bytes.length) {
                throw new Error(`只写入了 ${written}/${bytes.length} 字节`);
            }
        }
        catch (e) {
            throw new AutoAssemblerError(`写入目标进程失败（地址 0x${address.toString(16)}，${bytes.length} 字节）：${e.message}`, {
                line: entry.line,
                lineNumber: entry.lineNumber || undefined,
                file: entry.file,
                phase: 'write',
            });
        }
    }
    /* ---------------------------------------------------------------- *
     * 原字节历史
     * ---------------------------------------------------------------- */
    /**
     * 记录被覆盖的原字节。
     *
     * 记录集保持"按地址升序、互不重叠"：与已有记录重叠的部分会被裁掉
     * （保留最早的原始内容），相邻的会合并。
     */
    recordOriginal(history, address, bytes) {
        if (bytes.length === 0)
            return;
        let pos = address;
        let rest = bytes;
        const pieces = [];
        for (const record of history) {
            if (rest.length === 0)
                break;
            const rEnd = record.address + BigInt(record.bytes.length);
            if (rEnd <= pos)
                continue;
            if (record.address >= pos + BigInt(rest.length))
                break;
            if (record.address > pos) {
                const cut = Number(record.address - pos);
                pieces.push({ address: pos, bytes: Buffer.from(rest.subarray(0, cut)) });
                rest = rest.subarray(cut);
                pos = record.address;
            }
            // 跳过已被记录覆盖的部分
            const skip = Number(rEnd - pos);
            if (skip >= rest.length) {
                rest = rest.subarray(rest.length);
                break;
            }
            rest = rest.subarray(skip);
            pos = rEnd;
        }
        if (rest.length > 0)
            pieces.push({ address: pos, bytes: Buffer.from(rest) });
        for (const piece of pieces)
            insertHistory(history, piece.address, piece.bytes);
    }
    /**
     * 从历史里摘掉一段区间。
     *
     * `dealloc`/`realloc` 释放内存后必须调用：那块内存已经还给系统，
     * 再去"还原"它只会得到 ERROR_INVALID_ADDRESS（实测踩过）。
     */
    dropHistoryRange(history, address, size) {
        if (history.length === 0)
            return;
        const start = address;
        const end = address + BigInt(size);
        const out = [];
        for (const record of history) {
            const recEnd = record.address + BigInt(record.bytes.length);
            if (recEnd <= start || record.address >= end) {
                out.push(record);
                continue;
            }
            if (record.address < start) {
                out.push({
                    address: record.address,
                    bytes: Buffer.from(record.bytes.subarray(0, Number(start - record.address))),
                });
            }
            if (recEnd > end) {
                out.push({
                    address: end,
                    bytes: Buffer.from(record.bytes.subarray(Number(end - record.address))),
                });
            }
        }
        history.length = 0;
        history.push(...out);
    }
    /* ---------------------------------------------------------------- *
     * 杂项
     * ---------------------------------------------------------------- */
    resolveBitness() {
        if (this.options.arch) {
            // ARM/Thumb 是 32 位目标，ARM64 是 64 位 —— 供 [32-BIT]/[64-BIT] 段剥离使用
            const a = this.options.arch;
            return a === 'arm64' || a === 'x64' ? 64 : 32;
        }
        if (this.options.bitness)
            return this.options.bitness;
        const proc = this.options.process;
        if (!proc)
            return 64;
        try {
            return proc.isWow64() ? 32 : 64;
        }
        catch {
            return 64;
        }
    }
    /**
     * 解析汇编用的架构。
     *
     * 优先级：显式 `arch` > 由 `bitness` 推断 > 按目标进程位数推断 > `x64`。
     * 支持 ARM 之后，只给 `bitness` 已不足以表达架构
     * （`arm` 与 `thumb` 都是 32 位），因此 ARM 目标请显式给 `arch`。
     */
    resolveArch() {
        if (this.options.arch)
            return this.options.arch;
        if (this.options.bitness)
            return (0, backend_1.archFromBitness)(this.options.bitness);
        const proc = this.options.process;
        if (!proc)
            return 'x64';
        try {
            return proc.isWow64() ? 'x86' : 'x64';
        }
        catch {
            return 'x64';
        }
    }
    /** 构造带行号/文件/阶段的错误 */
    error(line, message, phase) {
        return new AutoAssemblerError(message, {
            line: line.text,
            lineNumber: line.number,
            file: line.file,
            phase,
        });
    }
}
exports.AutoAssembler = AutoAssembler;
/* ------------------------------------------------------------------ *
 * 运行期状态
 * ------------------------------------------------------------------ */
/**
 * 一次 `autoAssemble` 调用的状态。
 *
 * `warnings.length = run.warningBaseLength` 在每轮布局开始时重置，
 * 避免同一批警告随迭代次数重复累积；`warningBaseLength` 在预处理结束时确定。
 */
class RunState {
    enable;
    syntaxCheckOnly;
    bitness;
    arch;
    /** 当前可见符号（预处理阶段逐步累积） */
    symbols = new Map();
    /** define 名字 → 替换文本 */
    defines = new Map();
    /** define 的定义顺序 */
    defineOrder = [];
    /** label() 声明的标签 */
    declaredLabels = new Map();
    /** 实际上出现了定义行的标签名 */
    definedLabelNames = new Set();
    /** 待布局的汇编行 */
    asmLines = [];
    /** loadbinary 之类的直接写入 */
    directWrites = [];
    /** createthread 校验通过的地址 */
    createThreads = [];
    /** 本次运行里被 dealloc/realloc 真正释放掉的内存块（供工具层如实汇报） */
    deallocated = [];
    /** aobscan 命中情况 */
    aobScans = [];
    /** 待注册（等布局完成后才能解析地址）的 registersymbol 请求 */
    pendingRegisters = [];
    /** 布局结束后各脚本标签的地址 */
    labelAddresses = new Map();
    /** 本次运行对应的原字节记录（ENABLE 时新建、DISABLE 时取回） */
    history = [];
    warnings = [];
    /** 布局迭代时警告回退的位置 */
    warningBaseLength = 0;
    constructor(enable, syntaxCheckOnly, bitness, arch) {
        this.enable = enable;
        this.syntaxCheckOnly = syntaxCheckOnly;
        this.bitness = bitness;
        this.arch = arch;
    }
}
/* ------------------------------------------------------------------ *
 * 便捷入口
 * ------------------------------------------------------------------ */
/**
 * 一次性执行脚本（ENABLE 或 DISABLE）。
 *
 * 注意：**成对往返请用 `new AutoAssembler(...)` 复用同一个会话**，
 * 因为 [DISABLE] 的精确还原依赖 [ENABLE] 时记录的原字节。
 * 这个便捷函数适合"一次注入 / 语法检查"这类无状态场景。
 */
function autoAssemble(script, options = {}) {
    const { enable, syntaxCheckOnly, ...sessionOptions } = options;
    const session = new AutoAssembler(sessionOptions);
    return session.autoAssemble(script, { enable, syntaxCheckOnly });
}
//# sourceMappingURL=autoassembler.js.map