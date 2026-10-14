// 验证 Lua 的 autoAssemble / autoAssembleCheck 包装
const { LuaEngine } = require('../dist/cjs/lua/bridge');
const { ensureAsmBackend } = require('../dist/cjs/asm/backend');

(async () => {
  await ensureAsmBackend();

  const engine = new LuaEngine({ captureOutput: true });
  const out = [];
  engine.onOutput = (t) => out.push(t);

  await engine.createState();
  console.log('已注册 API 数:', engine.apiFunctionNames().length);
  console.log('含 AA 函数:', ['autoAssemble', 'autoAssembleCheck', 'autoAssembleError']
    .map((f) => `${f}=${engine.apiFunctionNames().includes(f)}`).join(' '));

  /* ---------- 1. 语法检查：脚本可解析 ---------- */
  let r = await engine.doString(`
    local ok = autoAssembleCheck([[
[ENABLE]
define(hpAddr, 00401000)
hpAddr:
  mov dword ptr [rbp-4], 9999
]])
    return tostring(ok)
  `);
  console.log('\n1) autoAssembleCheck 可用脚本 ->', r);

  /* ---------- 2. 语法检查：出错时必须返回 false 且能取到行号 ---------- */
  r = await engine.doString(`
    local ok = autoAssembleCheck([[
[ENABLE]
alloc(x)
]])
    return tostring(ok) .. ' | ' .. tostring(autoAssembleError())
  `);
  console.log('2) 错误脚本 ->', r);

  /* ---------- 3. autoAssemble（无进程 → 自动进入语法检查，不写内存） ---------- */
  r = await engine.doString(`
    local ok = autoAssemble([[
[ENABLE]
define(v, 00401000)
v:
  nop
]])
    return tostring(ok)
  `);
  console.log('3) autoAssemble（无进程）->', r);

  /* ---------- 4. enable 参数：DISABLE 段 ---------- */
  r = await engine.doString(`
    local okOn  = autoAssemble([[
[ENABLE]
define(v, 00401000)
v:
  nop
]], true)
    local okOff = autoAssemble([[
[ENABLE]
define(v, 00401000)
v:
  nop
[DISABLE]
v:
  ret
]], false)
    return tostring(okOn) .. ',' .. tostring(okOff) .. ' | ' .. tostring(autoAssembleError())
  `);
  console.log('4) enable=true/false ->', r);

  /* ---------- 4b. 成对：先 ENABLE 再 DISABLE（用进程内真实内存） ---------- */
  r = await engine.doString(`
    -- 没有真实进程时 DISABLE 无原字节可还原，这属于正确行为；
    -- 这里验证"未启用过就 DISABLE"是否给出可理解的提示
    return tostring(autoAssembleError())
  `);
  console.log('4b) 上一轮错误文本 ->', r);

  /* ---------- 5. 空脚本与类型错误 ---------- */
  r = await engine.doString(`
    local a = autoAssemble("")
    local b = autoAssembleCheck("   ")
    return tostring(a) .. ',' .. tostring(b) .. ' | ' .. tostring(autoAssembleError())
  `);
  console.log('5) 空脚本 ->', r);

  /* ---------- 6. 用 pcall 包住，确认不会抛 Lua 错误 ---------- */
  r = await engine.doString(`
    local ok, err = pcall(function() return autoAssembleCheck("this is bogus [[[") end)
    return tostring(ok) .. ' | ' .. tostring(err)
  `);
  console.log('6) pcall 包裹 ->', r);

  /* ---------- 7. 符号双向流通：Lua registerSymbol 后 AA 脚本可引用 ---------- */
  r = await engine.doString(`
    registerSymbol("myAddr", 0x401000)
    local ok = autoAssembleCheck([[
[ENABLE]
myAddr:
  nop
]])
    return tostring(ok) .. ' | ' .. tostring(autoAssembleError())
  `);
  console.log('7) Lua 符号被 AA 引用 ->', r);

  console.log('\n--- 输出历史 ---');
  console.log(out.join('\n') || '(无)');

  engine.dispose();
})().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
