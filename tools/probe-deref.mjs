/**
 * 直接对内核求值地址表达式，定位 `[[addr]]` 解析异常出在内核还是插件层。
 *
 * 现象：`ce_read address="[[0x7FF7F4F59000]]"` 解出 0x14D00000309（错误），
 * 而单层 `[0x7FF7F4F59000]` 正确解出 0x7FF7F4F59010。
 *
 * 用法: node probe-deref.mjs <pid>
 */
import { createRequire } from "node:module";

// 从本脚本位置推导内核入口，避免写死绝对路径（本文件位于 <内核>/tools/）
const KERNEL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cjs", "index.js");
const require = createRequire(import.meta.url);
const ce = require(KERNEL);

const PID = Number(process.argv[2]);
if (!Number.isFinite(PID) || PID <= 0) {
	console.error("用法: node probe-deref.mjs <pid>");
	process.exit(1);
}

const proc = ce.Process.open(PID);
const ctx = { process: proc };

/** 读指针值（8 字节）用于手工核对期望值。 */
const ptr = (addr) => proc.readMemory(BigInt(addr), 8).readBigUInt64LE(0);

const p1 = 0x7ff7f4f59000n; // 存放 g_pStats 的地址
const p2 = 0x7ff7f4f5e030n; // 存放 g_pHeapStats 的地址
const v1 = ptr(p1);
const v2 = ptr(p2);

console.log(`目标 pid=${PID}`);
console.log(`手工核对: [0x${p1.toString(16)}] = 0x${v1.toString(16)}   [0x${p2.toString(16)}] = 0x${v2.toString(16)}\n`);

const CASES = [
	["0x7FF7F4F59000", "直接地址（不解引用）"],
	["[0x7FF7F4F59000]", `单层 → 期望 0x${v1.toString(16)}`],
	["[[0x7FF7F4F59000]]", `双层 → 期望 ${proc.readMemory(v1, 4).readInt32LE(0)} (g_stats.hp)`],
	["[[0x7FF7F4F59000]+8]", `双层+8 → 期望 ${proc.readMemory(v1 + 8n, 4).readInt32LE(0)} (g_stats.gold)`],
	["[[[0x7FF7F4F59000]]]", "三层（对照：多一层也不该错）"],
	[`[0x${p2.toString(16)}]`, `堆指针单层 → 期望 0x${v2.toString(16)}`],
	[`[[0x${p2.toString(16)}]]`, `堆指针双层 → 期望 ${proc.readMemory(v2, 4).readInt32LE(0)}`]
];

for (const [expr, desc] of CASES) {
	let out;
	try {
		const v = BigInt(ce.resolveAddress(expr, ctx));
		out = `0x${v.toString(16)}  (${v})`;
	} catch (error) {
		out = `❌ 抛错: ${error.message}`;
	}
	console.log(`${desc}`);
	console.log(`  ${expr}`);
	console.log(`  → ${out}\n`);
}

// 额外：把表达式的 token 序列与 AST 打出来，便于定位解析问题
try {
	const compiled = ce.compileExpression("[[0x7FF7F4F59000]]");
	console.log("compileExpression('[[0x7FF7F4F59000]]') 成功");
	console.log("  AST:", JSON.stringify(compiled, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
} catch (error) {
	console.log("compileExpression 抛错:", error.message);
}

proc.close?.();
