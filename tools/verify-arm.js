// 多架构（ARM/Thumb/ARM64）反汇编/汇编验证
const b = require('../dist/cjs/asm/backend');
const d = require('../dist/cjs/asm/disassembler');
const a = require('../dist/cjs/asm/assembler');

(async () => {
  await b.ensureAsmBackend();
  console.log('架构支持:', b.backendVersions().architectures.map((x) => `${x}=${b.isArchitectureSupported(x)}`).join(' '));
  console.log('架构规范化:', ['aarch64', 'ARM', 'thumb2', 'amd64', 'i386', 64, 32].map((x) => b.normalizeArchitecture(x)).join(', '));

  console.log('\n=== ARM (A32) 汇编 → 反汇编 ===');
  for (const src of ['mov r0, r1', 'add r0, r0, #1', 'ldr r0, [r1, #4]', 'bx lr', 'bl #0x1000', 'push {r4, lr}', 'pop {r4, pc}', 'moveq r0, r1', 'beq #0x2000']) {
    const bytes = a.assembleToBytes(src, { address: 0x1000n, arch: 'arm' });
    const insn = d.disassembleOne(bytes, 0x1000n, { arch: 'arm' });
    const rt = a.assembleToBytes(d.instructionText(insn), { address: 0x1000n, arch: 'arm' });
    console.log(
      `  ${src.padEnd(18)} ${bytes.toString('hex').padEnd(12)} | ${insn.opcode.padEnd(8)} isRet=${insn.isRet ? 1 : 0} isCall=${insn.isCall ? 1 : 0} isJump=${insn.isJump ? 1 : 0} cond='${insn.conditionCode}' ds=${insn.dataSize} | 往返${rt.equals(bytes) ? '✅' : '❌ ' + rt.toString('hex')}`,
    );
  }

  console.log('\n=== Thumb 汇编 → 反汇编 ===');
  for (const src of ['movs r0, #1', 'adds r0, #1', 'bx lr', 'push {r4, lr}', 'pop {r4, pc}', 'bl #0x1000']) {
    const bytes = a.assembleToBytes(src, { address: 0x1000n, arch: 'thumb' });
    const insn = d.disassembleOne(bytes, 0x1000n, { arch: 'thumb' });
    const rt = a.assembleToBytes(d.instructionText(insn), { address: 0x1000n, arch: 'thumb' });
    console.log(
      `  ${src.padEnd(18)} ${bytes.toString('hex').padEnd(12)} | ${insn.opcode.padEnd(8)} size=${insn.size} isRet=${insn.isRet ? 1 : 0} isCall=${insn.isCall ? 1 : 0} ds=${insn.dataSize} | 往返${rt.equals(bytes) ? '✅' : '❌'}`,
    );
  }

  console.log('\n=== ARM64 汇编 → 反汇编 ===');
  for (const src of ['mov x0, x1', 'add x0, x0, #1', 'ldr x0, [x1, #8]', 'str w0, [x1, #-4]', 'ret', 'bl #0x1000', 'b.eq #0x2000', 'stp x29, x30, [sp, #-16]!', 'ldp x29, x30, [sp], #16', 'br x0', 'adrp x0, #0x1000', 'cbz x0, #0x1000']) {
    let bytes, insn;
    try {
      bytes = a.assembleToBytes(src, { address: 0x1000n, arch: 'arm64' });
      insn = d.disassembleOne(bytes, 0x1000n, { arch: 'arm64' });
    } catch (e) {
      console.log(`  ${src.padEnd(30)} 失败: ${e.message.slice(0, 60)}`);
      continue;
    }
    const rt = a.assembleToBytes(d.instructionText(insn), { address: 0x1000n, arch: 'arm64' });
    console.log(
      `  ${src.padEnd(30)} ${bytes.toString('hex').padEnd(10)} | op=${insn.opcode.padEnd(5)} sfx='${insn.suffix}' isRet=${insn.isRet ? 1 : 0} isCall=${insn.isCall ? 1 : 0} isJump=${insn.isJump ? 1 : 0} cond=${insn.isConditionalJump ? 1 : 0} ds=${insn.dataSize} | 往返${rt.equals(bytes) ? '✅' : '❌ ' + rt.toString('hex')}`,
    );
  }

  console.log('\n=== 多指令推进（ARM64） ===');
  const code = a.assembleToBytes('stp x29, x30, [sp, #-16]!\nmov x29, sp\nmov w0, #1\nldp x29, x30, [sp], #16\nret', { address: 0x400000n, arch: 'arm64' });
  const list = d.disassemble(code, 0x400000n, 10, { arch: 'arm64' });
  list.forEach((i) => console.log(`  0x${i.address.toString(16)} (${i.size}B) ${d.instructionText(i)}`));
  console.log('  endAddress = 0x' + (0x400000n + BigInt(code.length)).toString(16), ' 总长 =', code.length);

  console.log('\n=== x86 回归（确认没被破坏） ===');
  const x86 = a.assembleToBytes('mov rax, [rip+0x40302010]\nret', { address: 0x7ff000001000n });
  const xi = d.disassemble(x86, 0x7ff000001000n, 4);
  xi.forEach((i) => console.log(`  ${d.instructionText(i)}`));
  console.log('  格式化:', d.formatDisassembled(xi[0]));

  console.log('\n=== 大端 ARM ===');
  const be = a.assembleToBytes('mov r0, r1', { address: 0x1000n, arch: 'arm', endianness: 'big' });
  console.log('  big-endian mov r0,r1 =', be.toString('hex'), '(小端为 0100a0e1)');
  const bei = d.disassembleOne(be, 0x1000n, { arch: 'arm', endianness: 'big' });
  console.log('  大端反汇编:', d.instructionText(bei));
})();
