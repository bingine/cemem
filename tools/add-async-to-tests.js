// 给含 await 的 test 回调补 async 关键字
const fs = require('node:fs');
const path = require('node:path');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node tools/add-async-to-tests.js <文件...>');
  process.exit(1);
}

for (const rel of files) {
  const file = path.isAbsolute(rel) ? rel : path.join(__dirname, '..', rel);
  let src = fs.readFileSync(file, 'utf8');

  // 匹配 test('名称', () => {   （单行回调头，尚未 async）
  const re = /test\((['"])([\s\S]*?)\1,\s*\(\)\s*=>\s*\{/g;
  let count = 0;
  src = src.replace(re, (match, quote, name) => {
    count++;
    return `test(${quote}${name}${quote}, async () => {`;
  });

  fs.writeFileSync(file, src);
  console.log(`${rel}: 补了 ${count} 个 async`);
}
