// 实测 Capstone/Keystone 的 ARM 支持
const cs = require('capstone-wasm');
const ks = require('keystone-wasm');

(async () => {
  await cs.loadCapstone();
  await ks.loadKeystone();
  const C = cs.Capstone;
  const CC = cs.Const;
  const K = ks.Keystone;
  const KC = ks.Const;

  console.log('Capstone setOption 返回值测试:', new C(CC.CS_ARCH_ARM, CC.CS_MODE_ARM).setOption(CC.CS_OPT_MODE, CC.CS_MODE_ARM));

  /* ---------- Keystone 汇编 ---------- */
  console.log('\n=== Keystone: ARM (A32) ===');
  const kArm = new K(KC.KS_ARCH_ARM, KC.KS_MODE_ARM);
  for (const src of [
    'mov r0, r1',
    'add r0, r0, #1',
    'ldr r0, [r1, #4]',
    'str r0, [r1, #-4]',
    'bx lr',
    'bl #0x1000',
    'push {r4, lr}',
    'pop {r4, pc}',
    'movw r0, #0x1234',
    'nop',
    'b #0x2000',
  ]) {
    try {
      const b = kArm.asm(src, { address: 0x1000 });
      console.log(`  ${src.padEnd(24)} -> ${[...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`);
    } catch (e) {
      console.log(`  ${src.padEnd(24)} -> 失败: ${e.message}`);
    }
  }

  console.log('\n=== Keystone: Thumb (T32) ===');
  const kThumb = new K(KC.KS_ARCH_ARM, KC.KS_MODE_THUMB);
  for (const src of ['movs r0, #1', 'adds r0, #1', 'bx lr', 'push {r4, lr}', 'pop {r4, pc}', 'nop', 'bl #0x1000']) {
    try {
      const b = kThumb.asm(src, { address: 0x1000 });
      console.log(`  ${src.padEnd(24)} -> ${[...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`);
    } catch (e) {
      console.log(`  ${src.padEnd(24)} -> 失败: ${e.message}`);
    }
  }

  console.log('\n=== Keystone: ARM64 (A64) ===');
  const k64 = new K(KC.KS_ARCH_ARM64, KC.KS_MODE_LITTLE_ENDIAN);
  for (const src of [
    'mov x0, x1',
    'add x0, x0, #1',
    'ldr x0, [x1, #8]',
    'str w0, [x1, #-4]',
    'ret',
    'bl #0x1000',
    'stp x29, x30, [sp, #-16]!',
    'movz w0, #0x1234',
    'nop',
    'b #0x2000',
    'adrp x0, #0x1000',
    'br x0',
  ]) {
    try {
      const b = k64.asm(src, { address: 0x1000 });
      console.log(`  ${src.padEnd(30)} -> ${[...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`);
    } catch (e) {
      console.log(`  ${src.padEnd(30)} -> 失败: ${e.message}`);
    }
  }

  /* ---------- Capstone 反汇编 ---------- */
  console.log('\n=== Capstone: ARM64 反汇编 ===');
  {
    // mov x0, x1 (AA0103E0 little-endian: E0 03 01 AA)
    const bytes = k64.asm('mov x0, x1\nadd x0, x0, #1\nret\n', { address: 0x1000 });
    console.log('  源字节:', Buffer.from(bytes).toString('hex'));
    const eng = new C(CC.CS_ARCH_ARM64, CC.CS_MODE_LITTLE_ENDIAN);
    const r = eng.disasm(Buffer.from(bytes), { address: 0x1000, count: 10 });
    for (const i of r) {
      console.log(`    0x${i.address.toString(16)} (${i.size}B) ${i.mnemonic} ${i.opStr}  [id=${i.id}]`);
    }
    console.log('  getInsnName(1) =', eng.getInsnName(1));
    eng.close();
  }

  console.log('\n=== Capstone: ARM (A32) 反汇编 ===');
  {
    const bytes = kArm.asm('mov r0, r1\nadd r0, r0, #1\nbx lr\n', { address: 0x1000 });
    console.log('  源字节:', Buffer.from(bytes).toString('hex'));
    const eng = new C(CC.CS_ARCH_ARM, CC.CS_MODE_ARM);
    const r = eng.disasm(Buffer.from(bytes), { address: 0x1000, count: 10 });
    for (const i of r) console.log(`    0x${i.address.toString(16)} (${i.size}B) ${i.mnemonic} ${i.opStr}`);
    eng.close();
  }

  console.log('\n=== Capstone: Thumb 反汇编 ===');
  {
    const bytes = kThumb.asm('movs r0, #1\nadds r0, #1\nbx lr\n', { address: 0x1000 });
    console.log('  源字节:', Buffer.from(bytes).toString('hex'));
    const eng = new C(CC.CS_ARCH_ARM, CC.CS_MODE_THUMB);
    const r = eng.disasm(Buffer.from(bytes), { address: 0x1000, count: 10 });
    for (const i of r) console.log(`    0x${i.address.toString(16)} (${i.size}B) ${i.mnemonic} ${i.opStr}`);
    eng.close();
  }

  console.log('\n=== Capstone ARM 大端模式（CE 的 ARM 目标可能是大端） ===');
  {
    const eng = new C(CC.CS_ARCH_ARM, CC.CS_MODE_ARM | CC.CS_MODE_BIG_ENDIAN);
    const r = eng.disasm(Buffer.from('0100a0e1', 'hex'), { address: 0x1000, count: 4 });
    for (const i of r) console.log(`    0x${i.address.toString(16)} ${i.mnemonic} ${i.opStr}`);
    eng.close();
  }
})().catch((e) => console.error('未捕获:', e));
