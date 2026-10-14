"use strict";
/**
 * 数值编解码层 —— 与 Cheat Engine `memscan.pas` 的变量类型语义严格对齐。
 *
 * 本模块负责三件事：
 *  1. 从 Buffer 中按 CE 的变量类型读写数值（含大小端、精度、有符号/无符号）；
 *  2. 复刻 CE 的扫描值解析（十六进制前缀、区间、百分比、小数位数 floataccuracy）；
 *  3. 复刻 CE 的浮点比较策略（rtRounded / rtExtremerounded / rtTruncated）。
 *
 * 对齐依据：`memscan.pas` 的 SingleExact/DoubleExact/SingleBetween 等
 *   以及 setScanValueFloat 片段（floataccuracy 计算、RoundTo 调用、min/max 边界）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.readUInt8 = readUInt8;
exports.readInt8 = readInt8;
exports.readUInt16 = readUInt16;
exports.readInt16 = readInt16;
exports.readUInt32 = readUInt32;
exports.readInt32 = readInt32;
exports.readUInt64 = readUInt64;
exports.readInt64 = readInt64;
exports.readSingle = readSingle;
exports.readDouble = readDouble;
exports.writeUInt8 = writeUInt8;
exports.writeUInt16 = writeUInt16;
exports.writeUInt32 = writeUInt32;
exports.writeUInt64 = writeUInt64;
exports.writeSingle = writeSingle;
exports.writeDouble = writeDouble;
exports.writeValue = writeValue;
exports.roundTo = roundTo;
exports.parseIntegerLiteral = parseIntegerLiteral;
exports.parseFloatLiteral = parseFloatLiteral;
exports.decimalsOf = decimalsOf;
exports.buildFloatCompareParams = buildFloatCompareParams;
exports.singleMatches = singleMatches;
exports.doubleMatches = doubleMatches;
exports.parseAob = parseAob;
exports.aobHasNibbleWildcard = aobHasNibbleWildcard;
exports.aobMatchesAt = aobMatchesAt;
exports.parseBinaryPattern = parseBinaryPattern;
exports.binaryByteWidth = binaryByteWidth;
exports.testString = testString;
exports.testWideString = testWideString;
exports.testStringCI = testStringCI;
exports.testWideStringCI = testWideStringCI;
exports.upCaseWide = upCaseWide;
const types_1 = require("./types");
/* ------------------------------------------------------------------ *
 * 基础读取
 * ------------------------------------------------------------------ */
function readUInt8(buf, off) {
    return buf[off];
}
function readInt8(buf, off) {
    const v = buf[off];
    return v < 0x80 ? v : v - 0x100;
}
function readUInt16(buf, off) {
    return buf.readUInt16LE(off);
}
function readInt16(buf, off) {
    return buf.readInt16LE(off);
}
function readUInt32(buf, off) {
    return buf.readUInt32LE(off);
}
function readInt32(buf, off) {
    return buf.readInt32LE(off);
}
function readUInt64(buf, off) {
    return buf.readBigUInt64LE(off);
}
function readInt64(buf, off) {
    return buf.readBigInt64LE(off);
}
function readSingle(buf, off) {
    return buf.readFloatLE(off);
}
function readDouble(buf, off) {
    return buf.readDoubleLE(off);
}
/* ------------------------------------------------------------------ *
 * 基础写入（溢出按 CE 一样自然回绕）
 * ------------------------------------------------------------------ */
function writeUInt8(buf, off, v) {
    buf[off] = Number(BigInt.asUintN(8, BigInt(v)));
}
function writeUInt16(buf, off, v) {
    buf.writeUInt16LE(Number(BigInt.asUintN(16, BigInt(v))), off);
}
function writeUInt32(buf, off, v) {
    buf.writeUInt32LE(Number(BigInt.asUintN(32, BigInt(v))), off);
}
function writeUInt64(buf, off, v) {
    buf.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v)), off);
}
function writeSingle(buf, off, v) {
    buf.writeFloatLE(v, off);
}
function writeDouble(buf, off, v) {
    buf.writeDoubleLE(v, off);
}
/** 按变量类型把值写入 buffer（写入路径的统一起点）。 */
function writeValue(buf, off, type, value) {
    switch (type) {
        case types_1.VariableType.Byte:
            writeUInt8(buf, off, value);
            return;
        case types_1.VariableType.Word:
            writeUInt16(buf, off, value);
            return;
        case types_1.VariableType.DWord:
        case types_1.VariableType.Pointer:
            writeUInt32(buf, off, value);
            return;
        case types_1.VariableType.QWord:
            writeUInt64(buf, off, value);
            return;
        case types_1.VariableType.Single:
            writeSingle(buf, off, Number(value));
            return;
        case types_1.VariableType.Double:
            writeDouble(buf, off, Number(value));
            return;
        case types_1.VariableType.String:
        case types_1.VariableType.CodePageString: {
            const s = Buffer.from(String(value), 'latin1');
            s.copy(buf, off);
            return;
        }
        case types_1.VariableType.UnicodeString: {
            const s = Buffer.from(String(value), 'utf16le');
            s.copy(buf, off);
            return;
        }
        default:
            throw new Error(`writeValue 不支持的变量类型: ${types_1.VariableType[type]}`);
    }
}
/* ------------------------------------------------------------------ *
 * RoundTo —— 复刻 Delphi/FPC 的 RoundTo(Value, -Digits)
 *
 * 命名约定：CE 调用的是 RoundTo(x, -floataccuracy)，其中 floataccuracy 是
 * "保留的小数位数"。本函数直接接收**小数位数**，即 roundTo(x, 1) 等价于
 * FPC 的 RoundTo(x, -1)（保留 1 位小数）。请勿再对入参取负。
 *
 * FPC 的 RoundTo 对半值做"取偶"舍入（banker's rounding）：
 *   0.5 → 0，1.5 → 2，2.5 → 2，3.5 → 4。
 * CE 在浮点精确比较里大量依赖这一行为，因此必须复刻。
 * ------------------------------------------------------------------ */
/**
 * 小数位 → 缩放因子缓存。
 *
 * 扫描时 roundTo 会被每个字节调用一次（1GB 内存就是数亿次），
 * 因此不能每次调 Math.pow / toPrecision。这里只缓存因子，
 * 舍入本身用纯算术实现，保证热路径足够快。
 */
const FACTOR_CACHE = new Map();
function factorFor(decimals) {
    const cached = FACTOR_CACHE.get(decimals);
    if (cached !== undefined)
        return cached;
    const f = Math.pow(10, decimals);
    FACTOR_CACHE.set(decimals, f);
    return f;
}
function roundTo(value, decimals) {
    if (!Number.isFinite(value))
        return value;
    const factor = factorFor(decimals);
    if (!Number.isFinite(factor) || factor === 0)
        return value;
    const scaled = value * factor;
    if (!Number.isFinite(scaled))
        return value;
    // 半值取偶（FPC RoundTo 语义）：仅当恰好落在 .5 上才做奇偶判断
    const floor = Math.floor(scaled);
    const diff = scaled - floor;
    let rounded;
    if (diff > 0.5)
        rounded = floor + 1;
    else if (diff < 0.5)
        rounded = floor;
    else
        rounded = floor % 2 === 0 ? floor : floor + 1;
    return rounded / factor;
}
/**
 * 解析 CE 风格的整数字面量。
 * 支持：十进制、`$`/`0x` 前缀十六进制、可选的 `+`/`-` 前缀。
 * 无效时抛错，便于 CLI 给出明确提示。
 */
function parseIntegerLiteral(input, forceHex = false) {
    let s = input.trim().replace(/[\s_]/g, '');
    if (s === '')
        throw new Error('空数值');
    let negative = false;
    if (s.startsWith('+'))
        s = s.slice(1);
    else if (s.startsWith('-')) {
        negative = true;
        s = s.slice(1);
    }
    let hex = forceHex;
    if (s.startsWith('$')) {
        hex = true;
        s = s.slice(1);
    }
    else if (/^0x/i.test(s)) {
        hex = true;
        s = s.slice(2);
    }
    let raw;
    if (hex) {
        if (!/^[0-9a-f]+$/i.test(s))
            throw new Error(`无效的十六进制数值: "${input}"`);
        raw = BigInt('0x' + s);
    }
    else {
        if (!/^[0-9]+$/.test(s))
            throw new Error(`无效的整数值: "${input}"`);
        raw = BigInt(s);
    }
    if (negative)
        raw = BigInt.asUintN(64, -raw);
    return { raw, negative, hex };
}
/** 解析浮点字面量（支持科学计数法）。 */
function parseFloatLiteral(input) {
    const v = Number(input.trim());
    if (Number.isNaN(v))
        throw new Error(`无效的浮点数值: "${input}"`);
    return v;
}
/** 统计字符串中的小数位数，对齐 CE 的 floataccuracy 推导。 */
function decimalsOf(input) {
    if (/[eE]/.test(input))
        return 0; // CE: 含指数时 floataccuracy=0
    const m = input.match(/[.,](\d+)\s*$/);
    return m ? m[1].length : 0;
}
/**
 * 由用户输入推导浮点比较参数。
 *
 * 对齐 CE `setScanValueFloat`：
 *   - floataccuracy = 去掉小数点后的位数（含 E 时置 0）
 *   - 非百分比且 accuracy != 0 时，对 svalue/svalue2/dvalue/dvalue2 做 RoundTo(., -accuracy)
 *   - accuracy != 0: min/max = value ∓ 1/10^accuracy
 *     否则:        min/max = value ∓ 1
 *   - truncated 模式 CE 使用 maxsvalue/maxdvalue 作为上界
 */
function buildFloatCompareParams(value1, value2, isPercentage) {
    let dvalue = parseFloatLiteral(value1);
    let dvalue2 = value2 !== undefined && value2.trim() !== '' ? parseFloatLiteral(value2) : dvalue;
    if (isPercentage) {
        if (dvalue > dvalue2) {
            const t = dvalue;
            dvalue = dvalue2;
            dvalue2 = t;
        }
        dvalue = dvalue / 100;
        dvalue2 = dvalue2 / 100;
    }
    let svalue = dvalue;
    let svalue2 = dvalue2;
    const accuracy = decimalsOf(value1);
    if (accuracy !== 0 && !isPercentage) {
        svalue = roundTo(svalue, accuracy);
        svalue2 = roundTo(svalue2, accuracy);
        dvalue = roundTo(dvalue, accuracy);
        dvalue2 = roundTo(dvalue2, accuracy);
    }
    let minSingle, maxSingle, minDouble, maxDouble;
    if (accuracy !== 0) {
        const eps = 1 / Math.pow(10, accuracy);
        minDouble = dvalue - eps;
        maxDouble = dvalue + eps;
        minSingle = svalue - eps;
        maxSingle = svalue + eps;
    }
    else {
        minDouble = dvalue - 1;
        maxDouble = dvalue + 1;
        minSingle = svalue - 1;
        maxSingle = svalue + 1;
    }
    return {
        value: dvalue,
        single: svalue,
        accuracy,
        value2: dvalue2,
        single2: svalue2,
        minSingle,
        maxSingle,
        minDouble,
        maxDouble,
        maxTruncSingle: maxSingle,
        maxTruncDouble: maxDouble,
        isPercentage,
    };
}
/* ------------------------------------------------------------------ *
 * 按舍入策略的比较原语
 * ------------------------------------------------------------------ */
/** 对齐 TScanner.SingleExact（注意 rtExtremerounded 用闭区间 ≥/≤）。 */
function singleMatches(actual, p, rounding) {
    switch (rounding) {
        case types_1.RoundingType.Rounded:
            return roundTo(actual, p.accuracy) === p.single;
        case types_1.RoundingType.ExtremeRounded:
            return actual >= p.minSingle && actual <= p.maxSingle;
        case types_1.RoundingType.Truncated:
            return actual >= p.single && actual < p.maxTruncSingle;
        default:
            return false;
    }
}
/** 对齐 TScanner.DoubleExact（注意 rtExtremerounded 用开区间 >/<）。 */
function doubleMatches(actual, p, rounding) {
    switch (rounding) {
        case types_1.RoundingType.Rounded:
            return roundTo(actual, p.accuracy) === p.value;
        case types_1.RoundingType.ExtremeRounded:
            return actual > p.minDouble && actual < p.maxDouble;
        case types_1.RoundingType.Truncated:
            return actual >= p.value && actual < p.maxTruncDouble;
        default:
            return false;
    }
}
/**
 * 解析 AOB 字符串，对齐 `parsers.ConvertStringToBytes` + 半字节通配支持。
 *
 * 支持：
 *   - `90 90 ??`、`90,90,xx`、`9090??`（- 、 , 、空格均为分隔符，且允许两字符一组连写）
 *   - 半字节通配 `7*`、`*7`，对齐 CE 的 $8000f070 / $80000f07 编码语义
 */
function parseAob(input, hexadecimal = true) {
    const out = [];
    const trimmed = input.trim();
    if (trimmed === '')
        return out;
    // 对齐 CE: delims = [' ', ',', '-']
    const words = trimmed.split(/[\s,\-]+/).filter((w) => w !== '');
    for (const word of words) {
        if (!hexadecimal) {
            const n = Number(word);
            if (Number.isInteger(n) && n >= 0 && n <= 255) {
                out.push({ wildcard: false, value: n, mask: 0xff });
            }
            else {
                out.push({ wildcard: true, value: 0, mask: 0x00 });
            }
            continue;
        }
        // 十六进制：每两个字符一个字节
        let j = 0;
        while (j < word.length) {
            const pair = word.slice(j, j + 2);
            j += 2;
            if (/^[0-9a-f]{2}$/i.test(pair)) {
                out.push({ wildcard: false, value: parseInt(pair, 16), mask: 0xff });
                continue;
            }
            // 完全通配
            if (/^[?*x]{1,2}$/i.test(pair)) {
                out.push({ wildcard: true, value: 0, mask: 0x00 });
                continue;
            }
            // 半字节通配（仅当为完整两字符时，对齐 CE canHandleNibbleWildcards）
            if (pair.length === 2) {
                const hi = pair[0];
                const lo = pair[1];
                if (/[0-9a-f]/i.test(hi) && /[?*x]/i.test(lo)) {
                    // 形如 7* → 高半字节必须匹配
                    out.push({ wildcard: false, value: parseInt(hi, 16) << 4, mask: 0xf0 });
                    continue;
                }
                if (/[?*x]/i.test(hi) && /[0-9a-f]/i.test(lo)) {
                    // 形如 *7 → 低半字节必须匹配
                    out.push({ wildcard: false, value: parseInt(lo, 16), mask: 0x0f });
                    continue;
                }
            }
            out.push({ wildcard: true, value: 0, mask: 0x00 });
        }
    }
    return out;
}
/** 判断 AOB 模式中是否含有半字节级通配（决定是否走慢路径）。 */
function aobHasNibbleWildcard(pattern) {
    return pattern.some((b) => !b.wildcard && b.mask !== 0xff);
}
/** 在缓冲区指定偏移处比较 AOB 模式。 */
function aobMatchesAt(buf, off, pattern, nibbleSupport) {
    const n = pattern.length;
    if (off + n > buf.length)
        return false;
    if (!nibbleSupport) {
        for (let i = 0; i < n; i++) {
            const p = pattern[i];
            if (p.wildcard)
                continue;
            if (buf[off + i] !== p.value)
                return false;
        }
        return true;
    }
    for (let i = 0; i < n; i++) {
        const p = pattern[i];
        if (p.wildcard)
            continue;
        if ((buf[off + i] & p.mask) !== (p.value & p.mask))
            return false;
    }
    return true;
}
/**
 * 由位串推导 andmask/bitmask，对齐 CE setScanValue 中 vtBinary 分支：
 *   '?' 或 '*' → andmask 位 0，bitmask 位 0
 *   '0' / '1'  → andmask 位 1，bitmask 位取该数字
 */
function parseBinaryPattern(input) {
    let andStr = '';
    let bitStr = '';
    for (const ch of input) {
        if (ch === '?' || ch === '*') {
            andStr += '0';
            bitStr += '0';
        }
        else if (ch === '0' || ch === '1') {
            andStr += '1';
            bitStr += ch;
        }
        else if (ch === ' ' || ch === '\b') {
            continue;
        }
        else {
            throw new Error(`无效的二进制记法: "${ch}"`);
        }
    }
    if (andStr.length === 0)
        throw new Error('二进制串为空');
    return {
        andMask: BigInt('0b' + andStr),
        bitMask: BigInt('0b' + bitStr),
        bitCount: andStr.length,
    };
}
/** 位串在内存中的字节宽度（向上取整）。 */
function binaryByteWidth(bitCount) {
    return Math.ceil(bitCount / 8);
}
/* ------------------------------------------------------------------ *
 * 字符串扫描
 * ------------------------------------------------------------------ */
/** 对齐 testString：区分大小写 */
function testString(buf, off, target) {
    if (off + target.length > buf.length)
        return false;
    for (let i = 0; i < target.length; i++) {
        if (buf[off + i] !== (target.charCodeAt(i) & 0xff))
            return false;
    }
    return true;
}
/** 对齐 testWideString：UTF-16LE 区分大小写 */
function testWideString(buf, off, target) {
    const need = target.length * 2;
    if (off + need > buf.length)
        return false;
    for (let i = 0; i < target.length; i++) {
        if (buf.readUInt16LE(off + i * 2) !== target.charCodeAt(i))
            return false;
    }
    return true;
}
/** 对齐 CaseInsensitiveAnsiStringExact：仅 ASCII a-z 折叠为大写。 */
function testStringCI(buf, off, upperTarget) {
    if (off + upperTarget.length > buf.length)
        return false;
    for (let i = 0; i < upperTarget.length; i++) {
        let c = buf[off + i];
        if (c >= 0x61 && c <= 0x7a)
            c -= 0x20;
        if (c !== upperTarget.charCodeAt(i))
            return false;
    }
    return true;
}
/** 对齐 CaseInsensitiveUnicodeStringExact：用 UpCase 逐字符比较。 */
function testWideStringCI(buf, off, target) {
    const need = target.length * 2;
    if (off + need > buf.length)
        return false;
    for (let i = 0; i < target.length; i++) {
        const c = buf.readUInt16LE(off + i * 2);
        if (upCaseWide(c) !== upCaseWide(target.charCodeAt(i)))
            return false;
    }
    return true;
}
/**
 * 对齐 FPC 的 system.UpCase（宽字符版）：
 * 只处理 Latin-1 的 a-z / à-þ 等基本区段，这里复刻 ASCII + Latin-1 行为。
 */
function upCaseWide(c) {
    if (c >= 0x61 && c <= 0x7a)
        return c - 0x20;
    if (c >= 0xe0 && c <= 0xfe && c !== 0xf7)
        return c - 0x20;
    return c;
}
//# sourceMappingURL=value-codec.js.map