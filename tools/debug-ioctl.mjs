// 直接检查编译产物里的常量与计算过程
import fs from "node:fs";
const src = fs.readFileSync("dist/cjs/backend/dbk-backend.js", "utf8");

console.log("=== dist 里 ctlCode/ceIoctl/常量定义 ===");
const lines = src.split(/\r?\n/);
lines.forEach((line, i) => {
	if (/FILE_DEVICE_UNKNOWN|FILE_RW_ACCESS|METHOD_BUFFERED|function ctlCode|function ceIoctl|0x0800|DBK_IOCTL = |Object.freeze/.test(line)) {
		console.log(`${i + 1}: ${line.trim()}`);
	}
});

console.log("\n=== 手工按 dist 的公式重算 ===");
const FILE_DEVICE_UNKNOWN = 0x00000022;
const METHOD_BUFFERED = 0;
const FILE_RW_ACCESS = 3;
const ctlCode = (d, f, m, a) => (((d << 16) | (f << 2) | m | (a << 14)) >>> 0);
console.log("ctlCode(0x22, 0x0800, 0, 3) =", "0x" + ctlCode(FILE_DEVICE_UNKNOWN, 0x0800, METHOD_BUFFERED, FILE_RW_ACCESS).toString(16));

console.log("\n=== 运行时模块的实际导出 ===");
const mod = await import("../dist/cjs/backend/dbk-backend.js").catch(() => null);
const m = mod ?? (await import("../dist/cjs/backend/dbk-backend.js"));
void m;
