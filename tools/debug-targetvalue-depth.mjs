/**
 * 查夹具里 `targetValue` 的指针链真实深度，以及各深度的候选数。
 * 用于修正"自动降层"测试的期望值。
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const require = createRequire(import.meta.url);
const ce = require(path.join(ROOT, "dist/cjs/index.js"));

const child = spawn(process.execPath, [path.join(ROOT, "test/fixture-target.js")], {
	stdio: ["pipe", "pipe", "pipe"]
});
const line = await new Promise((resolve) => {
	let buf = "";
	child.stdout.on("data", (d) => {
		buf += d.toString();
		const nl = buf.indexOf("\n");
		if (nl !== -1) resolve(buf.slice(0, nl));
	});
});
const info = JSON.parse(line);
const base = BigInt(info.base);
const L = info.offsets;
const proc = ce.Process.open(info.pid);

const target = base + BigInt(L.targetValue);
console.log(`targetValue = base+0x${L.targetValue.toString(16)} = 0x${target.toString(16)}\n`);

console.log("=== 各 maxLevel 的候选数与路径 ===");
for (const maxLevel of [1, 2, 3, 4]) {
	const ps = new ce.PointerScanner(proc, { maxLevel, maxOffset: 0x1000, maxResults: 20 });
	const paths = ps.scan(target);
	console.log(`maxLevel=${maxLevel} → ${paths.length} 条  levelCounts=[${ps.stats.levelCounts.join(",")}]`);
	for (const p of paths.slice(0, 8)) {
		const b = BigInt(p.baseAddress);
		const inImage = b >= base && b < base + BigInt(L.totalSize);
		console.log(
			`    base=0x${b.toString(16)} (base+0x${(b - base).toString(16)})${inImage ? " [夹具]" : " [其它]"} offsets=[${(p.offsets ?? []).join(",")}]`
		);
	}
	console.log("");
}

proc.close?.();
child.stdin.write("quit\n");
child.kill();
