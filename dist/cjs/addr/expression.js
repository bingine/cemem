"use strict";
/**
 * 地址表达式求值 —— 对齐 Cheat Engine `addressparser.pas` 的功能子集。
 *
 * CE 的地址栏支持这些写法（这也是本模块要支持的）：
 *   - 十六进制 / 十进制字面量：`1234ABCD`、`0x1234`、`$1234`、`1234`
 *   - 模块相对地址：`"game.exe"+1234`、`game.exe+1234`
 *   - 符号名：已注册的符号，或模块内的导出符号
 *   - 解引用：`[[ game.exe+1234 ]+10]`、`[rax]`（寄存器在脚本上下文才有意义）
 *   - 算术：`+ - * / % << >> & | ^ ~`，以及括号
 *   - 内置函数：`GetModuleBase("x")`、`GetModuleSize("x")`、`GetAddress("expr")`
 *   - 寄存器占位：`EAX`/`RAX` 等 —— 仅在提供了寄存器上下文的场景下解析，
 *     否则报错（本移植不含调试器，故没有真实的寄存器上下文）
 *
 * 设计说明：表达式先编译成 AST（可在表中反复复用，避免每次重解析），
 * 求值时再访问模块列表与符号表，这样模块基址变化（重启进程）不需要重编译。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompiledAddress = exports.ExpressionError = void 0;
exports.compileExpression = compileExpression;
exports.evaluateExpression = evaluateExpression;
exports.resolveAddress = resolveAddress;
const winapi_1 = require("../win/winapi");
/** 表达式求值错误 */
class ExpressionError extends Error {
    expression;
    position;
    constructor(message, expression, position) {
        super(position !== undefined ? `${message}（位置 ${position}）："${expression}"` : `${message}："${expression}"`);
        this.expression = expression;
        this.position = position;
        this.name = 'ExpressionError';
    }
}
exports.ExpressionError = ExpressionError;
const PUNCT = [
    '<<',
    '>>',
    '<=',
    '>=',
    '==',
    '!=',
    '&&',
    '||',
    '+',
    '-',
    '*',
    '/',
    '%',
    '&',
    '|',
    '^',
    '~',
    '(',
    ')',
    '[',
    ']',
    ',',
    '<',
    '>',
];
function isDigit(c) {
    return c >= '0' && c <= '9';
}
function isHexDigit(c) {
    return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
function isIdentStart(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '.' || c === ':' || c === '@' || c === '?';
}
function isIdentChar(c) {
    return isIdentStart(c) || isDigit(c) || c === '\\' || c === '/';
}
function tokenize(src) {
    const out = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
            i++;
            continue;
        }
        // 注释：// 到行尾
        if (c === '/' && src[i + 1] === '/') {
            while (i < n && src[i] !== '\n')
                i++;
            continue;
        }
        // 引号包裹的模块名或字符串
        if (c === '"' || c === "'") {
            const quote = c;
            const start = i;
            i++;
            let s = '';
            while (i < n && src[i] !== quote) {
                if (src[i] === '\\' && i + 1 < n) {
                    s += src[i + 1];
                    i += 2;
                    continue;
                }
                s += src[i];
                i++;
            }
            if (i >= n)
                throw new ExpressionError('字符串未闭合', src, start);
            i++; // 跳过收尾引号
            out.push({ type: 'string', text: s, pos: start });
            continue;
        }
        // 十六进制字面量：$1234 或 0x1234
        if (c === '$') {
            const start = i;
            i++;
            while (i < n && isHexDigit(src[i]))
                i++;
            const hex = src.slice(start + 1, i);
            if (hex === '')
                throw new ExpressionError('$ 后缺少十六进制数字', src, start);
            out.push({ type: 'number', text: src.slice(start, i), value: BigInt('0x' + hex), pos: start });
            continue;
        }
        if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
            const start = i;
            i += 2;
            while (i < n && isHexDigit(src[i]))
                i++;
            const hex = src.slice(start + 2, i);
            if (hex === '')
                throw new ExpressionError('0x 后缺少十六进制数字', src, start);
            out.push({ type: 'number', text: src.slice(start, i), value: BigInt('0x' + hex), pos: start });
            continue;
        }
        // 数字：十进制，或"看起来像十六进制"的裸串（含 A-F 且不是表达式运算符）
        if (isDigit(c)) {
            const start = i;
            while (i < n && isHexDigit(src[i]))
                i++;
            const text = src.slice(start, i);
            // 若紧跟着一个标识符字符，说明这是模块名的一部分（例如 1234abc.exe），
            // 但那种情况通常以引号给出；这里按裸十六进制处理
            const hasHexLetter = /[a-fA-F]/.test(text);
            const value = hasHexLetter ? BigInt('0x' + text) : BigInt(text);
            out.push({ type: 'number', text, value, pos: start });
            continue;
        }
        // 标识符（模块名/符号名/函数名/寄存器）
        if (isIdentStart(c)) {
            const start = i;
            while (i < n && isIdentChar(src[i]))
                i++;
            out.push({ type: 'ident', text: src.slice(start, i), pos: start });
            continue;
        }
        // 运算符
        let matched = false;
        for (const p of PUNCT) {
            if (src.startsWith(p, i)) {
                out.push({ type: 'punct', text: p, pos: i });
                i += p.length;
                matched = true;
                break;
            }
        }
        if (!matched) {
            throw new ExpressionError(`无法识别的字符 "${c}"`, src, i);
        }
    }
    out.push({ type: 'eof', text: '', pos: n });
    return out;
}
/* ------------------------------------------------------------------ *
 * 解析器（递归下降，按运算符优先级分层）
 * ------------------------------------------------------------------ */
class Parser {
    tokens;
    src;
    pos = 0;
    constructor(tokens, src) {
        this.tokens = tokens;
        this.src = src;
    }
    peek() {
        return this.tokens[this.pos];
    }
    next() {
        return this.tokens[this.pos++];
    }
    eat(text) {
        if (this.peek().type === 'punct' && this.peek().text === text) {
            this.pos++;
            return true;
        }
        return false;
    }
    expect(text) {
        if (!this.eat(text)) {
            throw new ExpressionError(`缺少 "${text}"`, this.src, this.peek().pos);
        }
    }
    parse() {
        const e = this.parseLogicalOr();
        if (this.peek().type !== 'eof') {
            throw new ExpressionError(`表达式末尾有多余内容 "${this.peek().text}"`, this.src, this.peek().pos);
        }
        return e;
    }
    parseLogicalOr() {
        let left = this.parseLogicalAnd();
        while (this.peek().type === 'punct' && this.peek().text === '||') {
            this.next();
            left = { kind: 'binary', op: '||', left, right: this.parseLogicalAnd() };
        }
        return left;
    }
    parseLogicalAnd() {
        let left = this.parseBitOr();
        while (this.peek().type === 'punct' && this.peek().text === '&&') {
            this.next();
            left = { kind: 'binary', op: '&&', left, right: this.parseBitOr() };
        }
        return left;
    }
    parseBitOr() {
        let left = this.parseBitXor();
        while (this.peek().type === 'punct' && this.peek().text === '|') {
            this.next();
            left = { kind: 'binary', op: '|', left, right: this.parseBitXor() };
        }
        return left;
    }
    parseBitXor() {
        let left = this.parseBitAnd();
        while (this.peek().type === 'punct' && this.peek().text === '^') {
            this.next();
            left = { kind: 'binary', op: '^', left, right: this.parseBitAnd() };
        }
        return left;
    }
    parseBitAnd() {
        let left = this.parseEquality();
        while (this.peek().type === 'punct' && this.peek().text === '&') {
            this.next();
            left = { kind: 'binary', op: '&', left, right: this.parseEquality() };
        }
        return left;
    }
    parseEquality() {
        let left = this.parseRelational();
        for (;;) {
            const t = this.peek();
            if (t.type === 'punct' && (t.text === '==' || t.text === '!=')) {
                this.next();
                left = { kind: 'binary', op: t.text, left, right: this.parseRelational() };
            }
            else
                break;
        }
        return left;
    }
    parseRelational() {
        let left = this.parseShift();
        for (;;) {
            const t = this.peek();
            if (t.type === 'punct' && (t.text === '<' || t.text === '>' || t.text === '<=' || t.text === '>=')) {
                this.next();
                left = { kind: 'binary', op: t.text, left, right: this.parseShift() };
            }
            else
                break;
        }
        return left;
    }
    parseShift() {
        let left = this.parseAdditive();
        for (;;) {
            const t = this.peek();
            if (t.type === 'punct' && (t.text === '<<' || t.text === '>>')) {
                this.next();
                left = { kind: 'binary', op: t.text, left, right: this.parseAdditive() };
            }
            else
                break;
        }
        return left;
    }
    parseAdditive() {
        let left = this.parseMultiplicative();
        for (;;) {
            const t = this.peek();
            if (t.type === 'punct' && (t.text === '+' || t.text === '-')) {
                this.next();
                left = { kind: 'binary', op: t.text, left, right: this.parseMultiplicative() };
            }
            else
                break;
        }
        return left;
    }
    parseMultiplicative() {
        let left = this.parseUnary();
        for (;;) {
            const t = this.peek();
            if (t.type === 'punct' && (t.text === '*' || t.text === '/' || t.text === '%')) {
                this.next();
                left = { kind: 'binary', op: t.text, left, right: this.parseUnary() };
            }
            else
                break;
        }
        return left;
    }
    parseUnary() {
        const t = this.peek();
        if (t.type === 'punct' && (t.text === '-' || t.text === '+' || t.text === '~')) {
            this.next();
            return { kind: 'unary', op: t.text, operand: this.parseUnary() };
        }
        return this.parsePostfix();
    }
    /** 处理 `[expr]` 解引用 与 `ident+expr` 模块偏移 的后续运算 */
    parsePostfix() {
        let node = this.parsePrimary();
        // 模块名 + 偏移：`"game.exe"+1234` —— 在 primary 阶段已把 module 节点建好，
        // 这里的 additive 层会自然处理 "+1234"。但裸标识符后紧跟 + 时要区分
        // "符号 + 偏移" 与 "符号/模块 + 偏移"，两者语义相同（都是基址加偏移），
        // 因此在 primary 里把 ident 记为 symbol，模块解析延到求值期：若该名字
        // 命中已加载模块，就当作模块基址。
        return node;
    }
    parsePrimary() {
        const t = this.next();
        if (t.type === 'number') {
            return { kind: 'number', value: t.value };
        }
        if (t.type === 'string') {
            // 字符串作为模块名出现（`"game.exe"+1234` 的左侧）。
            // 注意：模块节点只表示"基址"，"+1234" 由上层 additive 处理，
            // 因此这里不能把 offset 也塞进去（否则偏移会被加两次）。
            return { kind: 'module', name: t.text, offset: { kind: 'number', value: 0n } };
        }
        if (t.type === 'punct' && t.text === '(') {
            const inner = this.parseLogicalOr();
            this.expect(')');
            return inner;
        }
        if (t.type === 'punct' && t.text === '[') {
            const inner = this.parseLogicalOr();
            this.expect(']');
            return { kind: 'deref', inner };
        }
        if (t.type === 'ident') {
            // 函数调用？
            if (this.peek().type === 'punct' && this.peek().text === '(') {
                this.next();
                const args = [];
                if (!(this.peek().type === 'punct' && this.peek().text === ')')) {
                    for (;;) {
                        args.push(this.parseLogicalOr());
                        if (this.eat(','))
                            continue;
                        break;
                    }
                }
                this.expect(')');
                return { kind: 'call', name: t.text, args };
            }
            // 寄存器名？
            if (REGISTER_NAMES.has(t.text.toUpperCase())) {
                return { kind: 'register', name: t.text.toUpperCase() };
            }
            // 其余按"符号名或模块名"处理：求值时先查模块，再查符号表
            return { kind: 'symbol', name: t.text };
        }
        throw new ExpressionError(`意外的记号 "${t.text || '文件末尾'}"`, this.src, t.pos);
    }
}
/** x86/x64 通用寄存器名（用于识别 `[rax]` 这类写法并给出明确错误） */
const REGISTER_NAMES = new Set([
    'AL', 'AH', 'AX', 'EAX', 'RAX',
    'BL', 'BH', 'BX', 'EBX', 'RBX',
    'CL', 'CH', 'CX', 'ECX', 'RCX',
    'DL', 'DH', 'DX', 'EDX', 'RDX',
    'SI', 'ESI', 'RSI', 'DI', 'EDI', 'RDI',
    'BP', 'EBP', 'RBP', 'SP', 'ESP', 'RSP',
    'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15',
    'R8D', 'R9D', 'R10D', 'R11D', 'R12D', 'R13D', 'R14D', 'R15D',
    'RIP', 'EIP', 'PC',
]);
const MASK64 = 0xffffffffffffffffn;
/** 编译表达式为 AST（可缓存复用）。 */
function compileExpression(expression) {
    const trimmed = expression.trim();
    if (trimmed === '')
        throw new ExpressionError('空表达式', expression);
    const tokens = tokenize(trimmed);
    return new Parser(tokens, trimmed).parse();
}
/** 模块名匹配：忽略大小写，允许省略路径。 */
function findModule(modules, name) {
    const needle = name.toLowerCase();
    // 精确名匹配优先
    let hit = modules.find((m) => m.name.toLowerCase() === needle);
    if (hit)
        return hit;
    // 允许带路径的写法
    hit = modules.find((m) => (m.path ?? '').toLowerCase() === needle);
    if (hit)
        return hit;
    // 退化为"去除扩展名比较"
    const bare = needle.replace(/\.(dll|exe|so)$/i, '');
    hit = modules.find((m) => m.name.toLowerCase().replace(/\.(dll|exe|so)$/i, '') === bare);
    if (hit)
        return hit;
    return modules.find((m) => m.name.toLowerCase().includes(needle));
}
/** 求值表达式为 64 位地址。 */
function evaluateExpression(node, ctx, expression = '') {
    const v = evalNode(node, ctx, expression);
    // CE 的地址空间是 64 位，负数按补码回绕
    return v & MASK64;
}
function evalNode(node, ctx, expression) {
    switch (node.kind) {
        case 'number':
            return node.value;
        case 'register': {
            const regs = ctx.registers;
            if (!regs || regs[node.name] === undefined) {
                throw new ExpressionError(`表达式引用了寄存器 ${node.name}，但当前上下文没有寄存器值（本移植不含调试器）`, expression);
            }
            return regs[node.name];
        }
        case 'symbol': {
            // 1) 已注册符号
            const sym = ctx.symbols?.get(node.name) ?? ctx.symbols?.get(node.name.toLowerCase());
            if (sym !== undefined)
                return sym;
            // 2) 模块名
            const mods = getModules(ctx);
            const m = findModule(mods, node.name);
            if (m)
                return m.baseAddress;
            throw new ExpressionError(`未知的符号或模块 "${node.name}"`, expression);
        }
        case 'deref': {
            if (ctx.mode === 'parseOnly') {
                throw new ExpressionError('parseOnly 模式下不允许解引用', expression);
            }
            const addr = evalNode(node.inner, ctx, expression);
            if (!ctx.process) {
                throw new ExpressionError('解引用需要已打开的目标进程', expression);
            }
            const buf = ctx.process.readMemory(addr & MASK64, 8);
            if (buf.length < 8) {
                throw new ExpressionError(`解引用失败：无法读取地址 0x${(addr & MASK64).toString(16)}（${(0, winapi_1.win32ErrorMessage)(998)}）`, expression);
            }
            return buf.readBigUInt64LE(0);
        }
        case 'unary': {
            const x = evalNode(node.operand, ctx, expression);
            switch (node.op) {
                case '-':
                    return (-x) & MASK64;
                case '+':
                    return x;
                case '~':
                    return ~x & MASK64;
                default:
                    throw new ExpressionError(`不支持的一元运算符 ${node.op}`, expression);
            }
        }
        case 'binary': {
            // 短路逻辑
            if (node.op === '&&') {
                return evalNode(node.left, ctx, expression) !== 0n && evalNode(node.right, ctx, expression) !== 0n ? 1n : 0n;
            }
            if (node.op === '||') {
                return evalNode(node.left, ctx, expression) !== 0n || evalNode(node.right, ctx, expression) !== 0n ? 1n : 0n;
            }
            const l = evalNode(node.left, ctx, expression);
            const r = evalNode(node.right, ctx, expression);
            switch (node.op) {
                case '+':
                    return (l + r) & MASK64;
                case '-':
                    return (l - r) & MASK64;
                case '*':
                    return (l * r) & MASK64;
                case '/':
                    if (r === 0n)
                        throw new ExpressionError('除以零', expression);
                    return (l / r) & MASK64;
                case '%':
                    if (r === 0n)
                        throw new ExpressionError('对零取模', expression);
                    return (l % r) & MASK64;
                case '&':
                    return l & r;
                case '|':
                    return l | r;
                case '^':
                    return l ^ r;
                case '<<':
                    return (l << (r & 63n)) & MASK64;
                case '>>':
                    return (l >> (r & 63n)) & MASK64;
                case '==':
                    return l === r ? 1n : 0n;
                case '!=':
                    return l !== r ? 1n : 0n;
                case '<':
                    return l < r ? 1n : 0n;
                case '>':
                    return l > r ? 1n : 0n;
                case '<=':
                    return l <= r ? 1n : 0n;
                case '>=':
                    return l >= r ? 1n : 0n;
                default:
                    throw new ExpressionError(`不支持的运算符 ${node.op}`, expression);
            }
        }
        case 'module': {
            const mods = getModules(ctx);
            const m = findModule(mods, node.name);
            if (!m)
                throw new ExpressionError(`找不到模块 "${node.name}"`, expression);
            const off = evalNode(node.offset, ctx, expression);
            return (m.baseAddress + off) & MASK64;
        }
        case 'call': {
            const name = node.name.toLowerCase();
            switch (name) {
                case 'getmodulebase': {
                    if (node.args.length !== 1)
                        throw new ExpressionError('GetModuleBase 需要 1 个参数', expression);
                    const modName = evalStringArg(node.args[0], ctx, expression);
                    const m = findModule(getModules(ctx), modName);
                    if (!m)
                        throw new ExpressionError(`找不到模块 "${modName}"`, expression);
                    return m.baseAddress;
                }
                case 'getmodulesize': {
                    if (node.args.length !== 1)
                        throw new ExpressionError('GetModuleSize 需要 1 个参数', expression);
                    const modName = evalStringArg(node.args[0], ctx, expression);
                    const m = findModule(getModules(ctx), modName);
                    if (!m)
                        throw new ExpressionError(`找不到模块 "${modName}"`, expression);
                    return BigInt(m.size);
                }
                case 'getaddress': {
                    if (node.args.length !== 1)
                        throw new ExpressionError('GetAddress 需要 1 个参数', expression);
                    const inner = evalStringArg(node.args[0], ctx, expression);
                    return evaluateExpression(compileExpression(inner), ctx, inner);
                }
                case 'readpointer': {
                    if (node.args.length !== 1)
                        throw new ExpressionError('readPointer 需要 1 个参数', expression);
                    const addr = evalNode(node.args[0], ctx, expression);
                    if (ctx.mode === 'parseOnly' || !ctx.process) {
                        throw new ExpressionError('readPointer 需要已打开的目标进程', expression);
                    }
                    const buf = ctx.process.readMemory(addr & MASK64, 8);
                    if (buf.length < 8)
                        throw new ExpressionError('readPointer 读取失败', expression);
                    return buf.readBigUInt64LE(0);
                }
                default:
                    throw new ExpressionError(`不支持的函数 ${node.name}`, expression);
            }
        }
        default:
            throw new ExpressionError('无法求值的表达式节点', expression);
    }
}
/** 把参数节点当作字符串（支持字符串字面量与符号名）。 */
function evalStringArg(node, ctx, expression) {
    if (node.kind === 'module')
        return node.name;
    if (node.kind === 'symbol') {
        // 若它不是已注册符号也不是模块名，就当作裸字符串（CE 允许 GetModuleBase(game.exe)）
        const sym = ctx.symbols?.get(node.name);
        if (sym !== undefined)
            return node.name;
        return node.name;
    }
    throw new ExpressionError('该参数需要字符串', expression);
}
/** 取模块列表（带缓存）。 */
function getModules(ctx) {
    if (ctx.moduleCache && ctx.moduleCache.length > 0)
        return ctx.moduleCache;
    if (!ctx.process)
        throw new ExpressionError('解析模块需要已打开的目标进程', '');
    const mods = ctx.process.modules().map((m) => ({
        name: m.name,
        baseAddress: m.baseAddress,
        size: m.size,
    }));
    ctx.moduleCache = mods;
    return mods;
}
/* ------------------------------------------------------------------ *
 * 便捷入口
 * ------------------------------------------------------------------ */
/**
 * 直接求值一个地址表达式。
 *
 * ```ts
 * const addr = resolveAddress('"notepad.exe"+1234', { process: proc });
 * const pointee = resolveAddress('[[notepad.exe+10]+8]', { process: proc });
 * ```
 */
function resolveAddress(expression, ctx) {
    const ast = compileExpression(expression);
    return evaluateExpression(ast, ctx, expression);
}
/** 已编译的表达式（便于在地址表里反复求值）。 */
class CompiledAddress {
    source;
    ast;
    error;
    constructor(expression) {
        this.source = expression;
        try {
            this.ast = compileExpression(expression);
            this.error = null;
        }
        catch (e) {
            this.ast = null;
            this.error = e;
        }
    }
    get isValid() {
        return this.ast !== null;
    }
    get parseError() {
        return this.error;
    }
    resolve(ctx) {
        if (!this.ast)
            throw this.error ?? new ExpressionError('表达式未编译', this.source);
        return evaluateExpression(this.ast, ctx, this.source);
    }
}
exports.CompiledAddress = CompiledAddress;
//# sourceMappingURL=expression.js.map