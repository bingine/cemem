/**
 * 调试：查看夹具上 `pointerToOffset` 的目标在 maxLevel=1 下找到的真实路径与偏移。
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

const target = base + BigInt(L.offsetTarget);
const slot = base + BigInt(L.pointerToOffset);
console.log(`base=0x${base.toString(16)}`);
console.log(`pointerToOffset slot = base+0x${L.pointerToOffset.toString(16)} = 0x${slot.toString(16)}`);
console.log(`offsetTarget        = base+0x${L.offsetTarget.toString(16)} = 0x${target.toString(16)}`);
console.log(`槽里实际存放的值     = 0x${proc.readMemory(slot, 8).readBigUInt64LE(0).toString(16)}`);
console.log(`期望 offset         = 0x${(L.offsetTarget - L.pointerToOffset).toString(16)} (${L.offsetTarget - L.pointerToOffset})\n`);

for (const maxOffset of [L.offsetTarget - L.pointerToOffset - 1, L.offsetTarget - L.pointerToOffset, 0x1000]) {
	const ps = new ce.PointerScanner(proc, { maxLevel: 1, maxOffset, pointerSize: 8 });
	const paths = ps.scan(target);
	console.log(`maxOffset=0x${maxOffset.toString(16)} → ${paths.length} 条`);
	for (const p of paths.slice(0, 6)) {
		const isSlot = BigInt(p.baseAddress) === slot;
		console.log(
			`   ${isSlot ? "★" : " "} base=0x${BigInt(p.baseAddress).toString(16)} offsets=[${(p.offsets ?? [])
				.map((o) => "0x" + (o >>> 0).toString(16))
				.join(",")}]  ${ce.formatPointerPath(p)}`
		);
	}
}

proc.close?.();
child.stdin.write("quit\n");
child.kill();
