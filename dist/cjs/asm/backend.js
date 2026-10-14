"use strict";
/**
 * 反汇编/汇编的后端封装（x86 / x64 / ARM / ARM64）。
 *
 * ## 为什么用外部引擎而不是手写指令表
 *
 * Cheat Engine 自己**也不手写 x86 解码器**：Windows 上它优先用 binutils 的
 * `objdump`（见 `binutils.pas` 的 `TBinUtils.disassemble` → `CreateProcess objdump`），
 * `disassembler.pas` 那 13,933 行只是无 binutils 时的回退路径。
 * ARM 那套（`disassemblerarm64.pas` 4,608 行、`disassemblerthumb.pas` 4,414 行、
 * `assemblerarm.pas` 1,074 行）同理。
 *
 * 本移植沿用这一架构，选两个成熟引擎，两者都覆盖 x86/x64/ARM/ARM64：
 *   - **capstone-wasm**：Capstone 官方 WASM 绑定（反汇编）
 *   - **keystone-wasm**：Keystone 官方 WASM 绑定（v0.9，汇编）
 *
 * ## 支持的架构
 *
 * | 架构名 | 说明 | 对齐 |
 * | --- | --- | --- |
 * | `x86` / `x64` | 32 / 64 位 x86 | 可变长度（1–15 字节），无对齐 |
 * | `arm` | ARM A32（ARMv7 及以前） | 固定 4 字节，4 字节对齐 |
 * | `thumb` | ARM Thumb / Thumb-2 | 2 或 4 字节，2 字节对齐 |
 * | `arm64` | AArch64（ARMv8） | 固定 4 字节，4 字节对齐 |
 *
 * ## 实测踩到的坑（都在这里处理掉）
 *
 * 1. **Capstone 不接受 bigint 地址** —— 传 bigint 会在 WASM 边界抛错。
 *    这里统一转 number，并在超过 `Number.MAX_SAFE_INTEGER` 时**明确报错**。
 * 2. **`disasm()` 返回的 address 相对缓冲区起点**，不是绝对地址。本模块加回基址。
 * 3. **`disasm()` 的参数是选项对象**（`{address, count}`），不是位置参数。
 * 4. **Capstone 构造器只有 `(arch, mode)`**；x86 的 Intel 语法靠
 *    `CS_OPT_SYNTAX` 设置。注意 `capstone-wasm` 的 `Const` **没有导出
 *    `CS_OPT_SYNTAX`**（实测为 undefined），因此本移植不设语法选项 ——
 *    好在 x86 默认就是 Intel 语法，ARM 也只有一种语法。
 * 5. **Capstone 不暴露 `readInsn`/detail**，拿不到操作数与分组结构；
 *    语义分类由上层按助记符表处理（见 disassembler.ts）。
 * 6. **Thumb 指令长度可变**（2 或 4 字节），且 `disasm()` 的 count 语义
 *    与 x86 一致，无需特殊处理 —— 但**地址必须是 2 的倍数**。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AsmBackendError = void 0;
exports.architectureInfo = architectureInfo;
exports.normalizeArchitecture = normalizeArchitecture;
exports.archFromBitness = archFromBitness;
exports.toSafeNumberAddress = toSafeNumberAddress;
exports.ensureAsmBackend = ensureAsmBackend;
exports.isAsmBackendReady = isAsmBackendReady;
exports.resetAsmBackendForTests = resetAsmBackendForTests;
exports.disassembleRaw = disassembleRaw;
exports.instructionNameOf = instructionNameOf;
exports.assembleRaw = assembleRaw;
exports.backendVersions = backendVersions;
exports.isArchitectureSupported = isArchitectureSupported;
const ARCH_INFO = {
    x86: { arch: 'x86', family: 'x86', alignment: 1, fixedSize: false, instructionSize: 0, addressWidth: 8, is64Bit: false },
    x64: { arch: 'x64', family: 'x86', alignment: 1, fixedSize: false, instructionSize: 0, addressWidth: 16, is64Bit: true },
    arm: { arch: 'arm', family: 'arm', alignment: 4, fixedSize: true, instructionSize: 4, addressWidth: 8, is64Bit: false },
    thumb: { arch: 'thumb', family: 'arm', alignment: 2, fixedSize: false, instructionSize: 0, addressWidth: 8, is64Bit: false },
    arm64: { arch: 'arm64', family: 'arm64', alignment: 4, fixedSize: true, instructionSize: 4, addressWidth: 16, is64Bit: true },
};
/** 取架构元信息 */
function architectureInfo(arch) {
    const info = ARCH_INFO[arch];
    if (!info)
        throw new AsmBackendError(`不支持的架构：${arch}`);
    return info;
}
/**
 * 把宽松的架构写法规范化为 `AsmArchitecture`。
 *
 * 接受：`x64`/`amd64`/`x86_64`/`64`、`x86`/`i386`/`ia32`/`32`、
 *       `arm`/`arm32`/`a32`/`armv7`、`thumb`/`t32`/`thumb2`、
 *       `arm64`/`aarch64`/`armv8`/`x64arm`。
 */
function normalizeArchitecture(input, fallback = 'x64') {
    if (input === undefined || input === null)
        return fallback;
    if (typeof input === 'number') {
        if (input === 64)
            return 'x64';
        if (input === 32)
            return 'x86';
        return fallback;
    }
    const s = input.trim().toLowerCase().replace(/[\s_-]/g, '');
    switch (s) {
        case 'x64':
        case 'amd64':
        case 'x8664':
        case '64':
            return 'x64';
        case 'x86':
        case 'i386':
        case 'i686':
        case 'ia32':
        case '32':
            return 'x86';
        case 'arm':
        case 'arm32':
        case 'a32':
        case 'armv7':
        case 'armv6':
            return 'arm';
        case 'thumb':
        case 't32':
        case 'thumb2':
            return 'thumb';
        case 'arm64':
        case 'aarch64':
        case 'armv8':
            return 'arm64';
        default:
            throw new AsmBackendError(`不支持的架构 "${input}"。支持：x86、x64、arm、thumb、arm64。`);
    }
}
/** 兼容旧的 `bitness` 写法（32/64）→ 架构名 */
function archFromBitness(bitness) {
    if (bitness === undefined)
        return 'x64';
    return bitness === 32 ? 'x86' : 'x64';
}
/** 后端不可用/参数错误时的错误 */
class AsmBackendError extends Error {
    /** 底层原因（不用 `Error.cause` 的名字，避免与标准属性冲突） */
    underlying;
    constructor(message, underlying) {
        super(message);
        this.name = 'AsmBackendError';
        this.underlying = underlying;
    }
}
exports.AsmBackendError = AsmBackendError;
/* ------------------------------------------------------------------ *
 * 地址转换守卫
 * ------------------------------------------------------------------ */
/** 把 bigint 地址转成 Capstone/Keystone 能接受的 number，并守卫精度 */
function toSafeNumberAddress(address, context) {
    if (address < 0n) {
        throw new AsmBackendError(`${context}: 地址不能为负（0x${address.toString(16)}）`);
    }
    if (address > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new AsmBackendError(`${context}: 地址 0x${address.toString(16)} 超出 JS 安全整数范围，` +
            `无法传给 WASM 后端（x64 用户态地址应远小于此值，请检查地址来源）`);
    }
    return Number(address);
}
let state = null;
let initPromise = null;
/**
 * 确保后端已初始化（WASM 需要异步装载）。
 *
 * 幂等；初始化失败时**不缓存失败结果**，允许重试。
 */
async function ensureAsmBackend() {
    if (state)
        return state;
    if (initPromise)
        return initPromise;
    initPromise = (async () => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const csMod = require('capstone-wasm');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const ksMod = require('keystone-wasm');
            await csMod.loadCapstone();
            await ksMod.loadKeystone();
            state = {
                capstone: csMod.Capstone,
                capstoneConst: csMod.Const,
                keystone: ksMod.Keystone,
                keystoneConst: ksMod.Const,
            };
            return state;
        }
        catch (e) {
            initPromise = null;
            throw new AsmBackendError(`反汇编/汇编后端初始化失败：${e.message}。` +
                `请确认已安装 capstone-wasm 与 keystone-wasm（npm install）。`, e);
        }
    })();
    return initPromise;
}
/** 后端是否已就绪（同步查询，不会触发初始化） */
function isAsmBackendReady() {
    return state !== null;
}
/** 测试用：重置后端单例 */
function resetAsmBackendForTests() {
    state = null;
    initPromise = null;
}
/* ------------------------------------------------------------------ *
 * 引擎的 arch/mode 映射
 * ------------------------------------------------------------------ */
/** 计算 Capstone 的 (arch, mode) */
function capstoneArchMode(s, arch, endianness) {
    const c = s.capstoneConst;
    const endian = endianness === 'big' ? c.CS_MODE_BIG_ENDIAN : c.CS_MODE_LITTLE_ENDIAN;
    switch (arch) {
        case 'x86':
            return { arch: c.CS_ARCH_X86, mode: c.CS_MODE_32 | endian };
        case 'x64':
            return { arch: c.CS_ARCH_X86, mode: c.CS_MODE_64 | endian };
        case 'arm':
            return { arch: c.CS_ARCH_ARM, mode: c.CS_MODE_ARM | endian };
        case 'thumb':
            return { arch: c.CS_ARCH_ARM, mode: c.CS_MODE_THUMB | endian };
        case 'arm64':
            return { arch: c.CS_ARCH_ARM64, mode: endian };
        default:
            throw new AsmBackendError(`不支持的架构：${arch}`);
    }
}
/** 计算 Keystone 的 (arch, mode) */
function keystoneArchMode(s, arch, endianness) {
    const k = s.keystoneConst;
    const endian = endianness === 'big' ? k.KS_MODE_BIG_ENDIAN : k.KS_MODE_LITTLE_ENDIAN;
    switch (arch) {
        case 'x86':
            return { arch: k.KS_ARCH_X86, mode: k.KS_MODE_32 | endian };
        case 'x64':
            return { arch: k.KS_ARCH_X86, mode: k.KS_MODE_64 | endian };
        case 'arm':
            return { arch: k.KS_ARCH_ARM, mode: k.KS_MODE_ARM | endian };
        case 'thumb':
            return { arch: k.KS_ARCH_ARM, mode: k.KS_MODE_THUMB | endian };
        case 'arm64':
            return { arch: k.KS_ARCH_ARM64, mode: endian };
        default:
            throw new AsmBackendError(`不支持的架构：${arch}`);
    }
}
/** 反汇编一段机器码（多架构）。 */
function disassembleRaw(code, options) {
    const s = requireReadyState();
    const arch = options.arch ?? archFromBitness(options.bitness);
    const endianness = options.endianness ?? 'little';
    const base = toSafeNumberAddress(options.address, 'disassembleRaw');
    if (code.length === 0)
        return [];
    const { arch: csArch, mode } = capstoneArchMode(s, arch, endianness);
    const engine = new s.capstone(csArch, mode);
    try {
        // 实测：disasm 的第二参数是选项对象，且**不接受 bigint**
        const result = engine.disasm(code, {
            address: base,
            count: options.maxInstructions ?? 1,
        });
        const out = [];
        for (const insn of result) {
            // bytes 在不同版本里可能是 Uint8Array 或普通对象
            const bytesArr = insn.bytes instanceof Uint8Array
                ? Buffer.from(insn.bytes)
                : Buffer.from(Object.values(insn.bytes));
            out.push({
                address: options.address + BigInt(insn.address - base),
                size: insn.size,
                bytes: bytesArr,
                mnemonic: String(insn.mnemonic ?? ''),
                operands: String(insn.opStr ?? ''),
                id: Number(insn.id ?? 0),
                groups: [],
            });
        }
        return out;
    }
    catch (e) {
        throw new AsmBackendError(`反汇编失败（架构 ${arch}，地址 0x${options.address.toString(16)}）：${e.message}`, e);
    }
    finally {
        engine.close();
    }
}
/** 通过 Capstone 反查助记符（id → 名称，例如 260 → 'je'） */
function instructionNameOf(id, arch = 'x64') {
    if (!state)
        return '';
    const { arch: csArch, mode } = capstoneArchMode(state, arch, 'little');
    const engine = new state.capstone(csArch, mode);
    try {
        return engine.getInsnName(id) ?? '';
    }
    finally {
        engine.close();
    }
}
/** 把汇编文本编码成机器码（多架构）。 */
function assembleRaw(source, options) {
    const s = requireReadyState();
    const arch = options.arch ?? archFromBitness(options.bitness);
    const endianness = options.endianness ?? 'little';
    const address = toSafeNumberAddress(options.address, 'assembleRaw');
    const { arch: ksArch, mode } = keystoneArchMode(s, arch, endianness);
    const engine = new s.keystone(ksArch, mode);
    try {
        // 语法选项只在 x86 家族有意义；ARM 只有一种语法
        const family = architectureInfo(arch).family;
        if (family === 'x86' && options.syntax) {
            engine.setOption(s.keystoneConst.KS_OPT_SYNTAX, syntaxToConst(s, options.syntax));
        }
        const bytes = engine.asm(source, { address });
        return { bytes: Buffer.from(bytes), source };
    }
    catch (e) {
        throw new AsmBackendError(`汇编失败：${describeKeystoneError(s, engine, e)}`, e);
    }
    finally {
        engine.close();
    }
}
function syntaxToConst(s, syntax) {
    const c = s.keystoneConst;
    switch (syntax) {
        case 'att':
            return c.KS_OPT_SYNTAX_ATT;
        case 'nasm':
            return c.KS_OPT_SYNTAX_NASM;
        case 'masm':
            return c.KS_OPT_SYNTAX_MASM;
        case 'gas':
            return c.KS_OPT_SYNTAX_GAS;
        case 'intel':
        default:
            return c.KS_OPT_SYNTAX_INTEL;
    }
}
/** 把 Keystone 的错误码翻成可读文本（否则只有一个数字，很难排查） */
function describeKeystoneError(s, engine, e) {
    let errNo = null;
    try {
        errNo = engine.errNo();
    }
    catch {
        errNo = null;
    }
    const base = e instanceof Error ? e.message : String(e);
    if (errNo !== null && errNo !== 0) {
        let text = '';
        try {
            text = s.keystone.strError(errNo) ?? '';
        }
        catch {
            text = '';
        }
        return text
            ? `${base}（Keystone 错误码 ${errNo}：${text}）`
            : `${base}（Keystone 错误码 ${errNo}）`;
    }
    return base;
}
/** 取后端版本信息（诊断用） */
function backendVersions() {
    if (!state) {
        return { capstone: '未初始化', keystone: '未初始化', architectures: [] };
    }
    const kv = state.keystone.version();
    return {
        capstone: String(state.capstone.version?.() ?? 'unknown'),
        keystone: `${kv.major}.${kv.minor}`,
        architectures: ['x86', 'x64', 'arm', 'thumb', 'arm64'],
    };
}
/** 查询某架构是否被两个引擎都支持（都支持才可用） */
function isArchitectureSupported(arch) {
    if (!state)
        return false;
    const info = ARCH_INFO[arch];
    if (!info)
        return false;
    const csArch = info.family === 'x86'
        ? state.capstoneConst.CS_ARCH_X86
        : info.family === 'arm'
            ? state.capstoneConst.CS_ARCH_ARM
            : state.capstoneConst.CS_ARCH_ARM64;
    const ksArch = info.family === 'x86'
        ? state.keystoneConst.KS_ARCH_X86
        : info.family === 'arm'
            ? state.keystoneConst.KS_ARCH_ARM
            : state.keystoneConst.KS_ARCH_ARM64;
    try {
        return state.capstone.support(csArch) && state.keystone.archSupported(ksArch);
    }
    catch {
        return false;
    }
}
function requireReadyState() {
    if (!state) {
        throw new AsmBackendError('反汇编/汇编后端尚未初始化。请在调用前 await ensureAsmBackend()。');
    }
    return state;
}
//# sourceMappingURL=backend.js.map