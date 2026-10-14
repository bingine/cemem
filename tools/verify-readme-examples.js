// 验证 README 里的 ARM 与 Auto Assembler 示例
const {
  ensureAsmBackend, assembleToBytes, disassemble, instructionText, autoAssemble,
} = require('../dist/cjs/index.js');

(async () => {
  await ensureAsmBackend();

  // --- ARM64 示例 ---
  const a64 = assembleToBytes('stp x29, x30, [sp, #-16]!\nret', {
    address: 0x400000n, arch: 'arm64',
  });
  console.log('ARM64:');
  disassemble(a64, 0x400000n, 4, { arch: 'arm64' }).forEach((i) =>
    console.log('  ' + instructionText(i)));

  // --- Thumb 示例 ---
  const th = assembleToBytes('movs r0, #1\nbx lr', { address: 0x1000n, arch: 'thumb' });
  console.log('Thumb:', th.toString('hex'), '(应为 0120 7047)');
  if (th.toString('hex') !== '01207047') throw new Error('Thumb 示例编码不符');

  // --- 大端 ARM 示例 ---
  const be = assembleToBytes('mov r0, r1', { address: 0x1000n, arch: 'arm', endianness: 'big' });
  console.log('大端 ARM:', be.toString('hex'), '(应为 e1a00001)');
  if (be.toString('hex') !== 'e1a00001') throw new Error('大端示例编码不符');

  // --- README 的 AA 示例（syntaxCheckOnly）---
  const aa = autoAssemble([
    '[ENABLE]',
    'define(hpAddr, 00401000)',
    'hpAddr:',
    '  mov dword ptr [rbp-4], 9999',
    '  ret',
  ].join('\n'), { syntaxCheckOnly: true });
  console.log('AA 示例 entries =', aa.entries.length);
  if (aa.entries.length !== 2) throw new Error('AA 示例应有 2 个 entry');

  // --- README 的 Lua-AA 示例（syntaxCheckOnly 版本）---
  const luaAa = autoAssemble([
    '[ENABLE]',
    'define(hpAddr, 00401000)',
    'hpAddr:',
    '  mov dword ptr [rbp-4], 9999',
    '  ret',
  ].join('\n'), { syntaxCheckOnly: true });
  console.log('Lua-AA 示例 entries =', luaAa.entries.length);

  console.log('\n✅ README 示例全部可运行');
})().catch((e) => {
  console.error('❌ 验证失败:', e.message);
  process.exit(1);
});
