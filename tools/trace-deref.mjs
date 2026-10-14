/**
 * 逐步追踪 `[[addr]]` 的求值，定位内核 bug。
 *
 * 已知：AST 正确（deref(deref(number))），单层解引用正确，双层就错。
 * 这里打印每一步的类型与数值，找出错在哪一环。
 */
import { createRequire } from "node:module";

// 从本脚本位置推导内核入口，避免写死绝对路径（本文件位于 <内核>/tools/）
const KERNEL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cjs", "index.js");
const require = createRequire(import.meta.url);
const ce = require(KERNEL);

const PID = Number(process.argv[2]);
const proc = ce.Process.open(PID);
const ctx = { process: proc };

const A = 0x7ff7f4f59000n;

console.log("=== 第 1 步：读 [0x" + A.toString(16) + "] 的 8 字节 ===");
const buf1 = proc.readMemory(A, 8);
console.log(`  类型: ${buf1?.constructor?.name}  isBuffer=${Buffer.isBuffer(buf1)}  length=${buf1?.length}`);
console.log(`  十六进制: ${Buffer.from(buf1 ?? []).toString("hex")}`);
const raw1 = Buffer.from(buf1 ?? []).readBigUInt64LE(0);
console.log(`  作为 u64 LE: 0x${raw1.toString(16)}  (期望 0x7ff7f4f59010)`);

console.log("\n=== 第 2 步：读 [0x" + raw1.toString(16) + "] 的 8 字节 ===");
const buf2 = proc.readMemory(raw1, 8);
console.log(`  类型: ${buf2?.constructor?.name}  isBuffer=${Buffer.isBuffer(buf2)}  length=${buf2?.length}`);
console.log(`  十六进制: ${Buffer.from(buf2 ?? []).toString("hex")}`);
const raw2 = Buffer.from(buf2 ?? []).readBigUInt64LE(0);
console.log(`  作为 u64 LE: 0x${raw2.toString(16)}`);

console.log("\n=== 手工拼装期望值 ===");
console.log(`  g_stats.hp   (offset 0) = ${proc.readMemory(raw1, 4).readInt32LE(0)}`);
console.log(`  g_stats.mp   (offset 4) = ${proc.readMemory(raw1 + 4n, 4).readInt32LE(0)}`);
const expect = proc.readMemory(raw1, 8).readBigUInt64LE(0);
console.log(`  正确双层解引用应返回: 0x${expect.toString(16)}`);

console.log("\n=== 内核实际返回 ===");
const actual = ce.resolveAddress("[[0x7ff7f4f59000]]", ctx);
console.log(`  ce.resolveAddress → 0x${BigInt(actual).toString(16)}`);
console.log(`  期望              → 0x${expect.toString(16)}`);
console.log(`  ${BigInt(actual) === expect ? "✅ 一致" : "❌ 不一致 —— 内核 bug 确认"}`);

/* ---------- 关键：怀疑求值器把"解引用"当成了浅层解析 ---------- */
console.log("\n=== 对照：三层表达式能正确抛错说明它确实在递归 ===");
try {
	const three = ce.resolveAddress("[[[0x7ff7f4f59000]]]", ctx);
	console.log(`  三层 → 0x${BigInt(three).toString(16)}`);
} catch (e) {
	console.log(`  三层 → 抛错: ${e.message.slice(0, 90)}`);
}

console.log("\n=== 关键对照：内层用括号强制分组 ===");
for (const expr of ["[[0x7ff7f4f59000]]", "[( [0x7ff7f4f59000] )]", "[[0x7ff7f4f59000] ]", "[[0x7ff7f4f59000]+0]"]) {
	try {
		const v = BigInt(ce.resolveAddress(expr, ctx));
		console.log(`  ${expr.padEnd(26)} → 0x${v.toString(16)}  ${v === expect ? "✅" : "❌"}`);
	} catch (e) {
		console.log(`  ${expr.padEnd(26)} → 抛错: ${e.message.slice(0, 60)}`);
	}
}
