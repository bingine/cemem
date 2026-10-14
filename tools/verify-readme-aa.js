// 验证 README 里的 Auto Assembler 示例
const { autoAssemble, ensureAsmBackend } = require('../dist/cjs/index.js');

(async () => {
  await ensureAsmBackend();

  /* ---------- 模式 1：带真实进程（完整功能） ---------- */
  // 该模式支持 "notepad.exe"+1234 这类模块相对地址、alloc 后以块名为标签定位。
  // 因为需要真实 notepad 进程，这里只做**解析路径**的说明，实际执行由
  // test/autoassembler.test.js 用夹具进程覆盖（44 个用例）。

  /* ---------- 模式 2：syntaxCheckOnly（无进程，预演） ---------- */
  // 限制（真实约束）：无进程时无法求值地址表达式，也无法真正 alloc，
  // 因此**脚本必须以绝对数字地址定位**，不能用模块相对地址或 alloc 块名。
  const checkableScript = `
[ENABLE]
define(hpAddr, 00401000)

hpAddr:
  mov dword ptr [rbp-4], 9999
  jmp hpAddr

[DISABLE]
hpAddr:
  mov [rbp-4], ebx
`;

  const r = autoAssemble(checkableScript, { syntaxCheckOnly: true });
  console.log('✅ 语法检查（syntaxCheckOnly）通过');
  console.log('   entries =', r.entries.length);
  if (r.entries.length > 0) {
    console.log(
      '   entries[0] 地址 = 0x' + r.entries[0].address.toString(16),
      ' 字节 =', r.entries[0].bytes.toString('hex'),
    );
  }

  /* ---------- 错误路径必须带行号 ---------- */
  try {
    autoAssemble('[ENABLE]\nalloc(x)\n', { syntaxCheckOnly: true });
    console.log('❌ 预期报错但没有');
    process.exit(1);
  } catch (e) {
    console.log('✅ 错误带行号: line =', e.lineNumber, '|', String(e.message).slice(0, 70));
    if (e.lineNumber !== 2) {
      console.log('❌ 行号应为 2（alloc 在第 2 行），实际', e.lineNumber);
      process.exit(1);
    }
  }

  /* ---------- 无进程时用模块相对地址，应给出明确错误（不是静默失败） ---------- */
  try {
    autoAssemble('[ENABLE]\n"notepad.exe"+1234:\n  nop\n', { syntaxCheckOnly: true });
    console.log('❌ 预期报错但没有');
    process.exit(1);
  } catch (e) {
    console.log('✅ 模块相对地址在无进程时明确报错:', String(e.message).slice(0, 60));
  }

  console.log('\n提示：带 process 时可写模块相对地址与 alloc 块名标签（见 test/autoassembler.test.js）。');
})().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
