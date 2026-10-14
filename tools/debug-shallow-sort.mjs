/**
 * 观察内核 `preferShallow` 聚合后的排序结果，定位"动态组内层数非递减"为何不成立。
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
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
const proc = ce.Process.open(info.pid);
const target = base + BigInt(info.offsets.targetValue);

const ps = new ce.PointerScanner(proc, {
	maxLevel: 3,
	maxOffset: 0x1000,
	maxResults: 200,
	preferShallow: true
});
const paths = ps.scan(target);
console.log(`共 ${paths.length} 条`);
console.log(`levelCounts=[${ps.stats.levelCounts.join(",")}]\n`);

// 用内核自己的 isStatic 语义判断静态：这里用 regions 判定
const imageRanges = proc
	.regions()
	.filter((r) => r.committed && r.type === 2 /* MEM_IMAGE */)
	.map((r) => ({ start: r.baseAddress, end: r.baseAddress + r.memorySize }));
const isStatic = (a) => imageRanges.some((r) => a >= r.start && a < r.end);

const seq = paths.map((p) => ({ d: p.depth, s: isStatic(BigInt(p.baseAddress)) }));
console.log(`前 30 条的 (depth, static)：`);
console.log("  " + seq.slice(0, 30).map((x) => `${x.d}${x.s ? "S" : "-"}`).join(" "));

const dyn = seq.filter((x) => !x.s).map((x) => x.d);
console.log(`\n动态组 depth 序列前 30: ${dyn.slice(0, 30).join(" ")}`);
const bad = dyn.findIndex((d, i) => i > 0 && d < dyn[i - 1]);
console.log(`动态组内第一处递减的下标: ${bad}${bad >= 0 ? ` (${dyn[bad - 1]} → ${dyn[bad]})` : ""}`);

const sta = seq.filter((x) => x.s).map((x) => x.d);
console.log(`静态组 depth 序列: ${sta.slice(0, 30).join(" ")}`);
const bad2 = sta.findIndex((d, i) => i > 0 && d < sta[i - 1]);
console.log(`静态组内第一处递减的下标: ${bad2}${bad2 >= 0 ? ` (${sta[bad2 - 1]} → ${sta[bad2]})` : ""}`);

fs.writeFileSync(path.join(ROOT, "tmp-depth-seq.txt"), JSON.stringify(seq.slice(0, 60)), "utf8");
proc.close?.();
child.stdin.write("quit\n");
child.kill();
