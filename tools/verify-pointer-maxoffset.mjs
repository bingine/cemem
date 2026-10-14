/**
 * 受控验证指针扫描的 `maxOffset` 语义。
 *
 * 疑点：`findValueRange()` 的实现看起来是**精确匹配**（值恰好等于 target），
 * 那样 `maxOffset` 就完全失效；但实测 `maxOffset=4096` 比 `2048` 结果更多，
 * 两者矛盾。这里用同一目标、只变 maxOffset，做确定性对照。
 *
 * 用法: node verify-pointer-maxoffset.mjs <pid>
 */
import { createRequire } from "node:module";

// 从本脚本位置推导内核入口，避免写死绝对路径（本文件位于 <内核>/tools/）
const KERNEL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cjs", "index.js");
const require = createRequire(import.meta.url);
const ce = require(KERNEL);

const PID = Number(process.argv[2]);
if (!Number.isFinite(PID) || PID <= 0) {
	console.error("用法: node verify-pointer-maxoffset.mjs <pid>");
	process.exit(1);
}

const proc = ce.Process.open(PID);

// 权威结构：g_pStats @ +0x9000 存 &g_stats；g_stats.gold 在 +8
const slotAddr = 0x7ff7f4f59000n;
const ptrValue = proc.readMemory(slotAddr, 8).readBigUInt64LE(0);
const goldAddr = ptrValue + 8n;

console.log(`进程 pid=${PID}`);
console.log(`指针槽 0x${slotAddr.toString(16)} 的值 = 0x${ptrValue.toString(16)}`);
console.log(`目标 g_stats.gold = 0x${goldAddr.toString(16)}`);
console.log(`两者相差 ${goldAddr - ptrValue} 字节（offset=8 → 正确路径应为 [0x${slotAddr.toString(16)}]+8）`);
console.log(`正确路径的基址 0x${slotAddr.toString(16)} 是否静态(模块映像)：是的（CheatTestWindow.exe+0x9000）\n`);

/* 关键：正确路径要求 offset = 8。
 * 若 findValueRange 是精确匹配，那么"值恰好等于 goldAddr"的槽位才可能被找到，
 * 而值等于 ptrValue(=goldAddr-8) 的槽位会被漏掉。 */
console.log("=== 同一目标、只变 maxOffset（maxLevel=1, staticOnly=true）===");
for (const maxOffset of [0, 8, 64, 2048, 4096, 65536]) {
	let line;
	try {
		const s = new ce.PointerScanner(proc, { maxLevel: 1, maxOffset, staticOnly: true, maxResults: 10 });
		const paths = s.scan(goldAddr);
		const found = paths.some((p) => BigInt(p.baseAddress) === slotAddr);
		line = `paths=${paths.length}  正确的静态路径${found ? "✅ 找到" : "❌ 未找到"}`;
		if (paths.length > 0) {
			line += `  [${paths.map((p) => `0x${BigInt(p.baseAddress).toString(16)}+[${(p.offsets ?? []).join(",")}]`).join(" ; ")}]`;
		}
	} catch (error) {
		line = `❌ 抛错: ${error.message}`;
	}
	console.log(`  maxOffset=${String(maxOffset).padStart(6)}  ${line}`);
}

/* 对照：目标改成指针值本身（offset=0），应当无论 maxOffset 都能找到 */
console.log("\n=== 对照：目标 = 指针值本身（offset=0）===");
for (const maxOffset of [0, 2048]) {
	const s = new ce.PointerScanner(proc, { maxLevel: 1, maxOffset, staticOnly: true, maxResults: 10 });
	const paths = s.scan(ptrValue);
	const found = paths.some((p) => BigInt(p.baseAddress) === slotAddr);
	console.log(`  maxOffset=${String(maxOffset).padStart(6)}  paths=${paths.length}  静态路径${found ? "✅ 找到" : "❌ 未找到"}`);
}

proc.close?.();
