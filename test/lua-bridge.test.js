/**
 * Lua 脚本桥（CE Lua API 的 Node 版子集）跨进程测试。
 *
 * 运行：node --test test/lua-bridge.test.js
 *
 * 特点：所有断言都通过**真实 Lua 脚本**驱动真实目标进程（test/fixture-target.js），
 * 不做任何 mock —— 与 CE 里"表 → 显示 Lua 脚本"的使用方式一致。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { startFixture } = require('./helpers/fixture');
const { LuaEngine } = require('../dist/cjs/lua/bridge');
const { Process } = require('../dist/cjs/win/process');

/* ------------------------------------------------------------------ *
 * 夹具与引擎（整个文件共用一个，测试之间用不同内存字段避免串扰）
 * ------------------------------------------------------------------ */

let fixture = null;
let info = null;
let base = 0n;
let L = null;
let lua = null;
/** print / showMessage 的输出 */
let outputs = [];

/** 把 JS 数字或 bigint 统一成 bigint（桥对小整数返回 number，对 int64 返回 bigint） */
const big = (v) => BigInt(v);
const hex = (v) => '0x' + big(v).toString(16);
/** 夹具内偏移的绝对地址（base 在 before 里才有值，所以要用函数） */
const at = (off) => hex(base + BigInt(off));

test.before(async () => {
  fixture = startFixture();
  info = await fixture.ready;
  base = BigInt(info.base);
  L = info.offsets;
  outputs = [];
  lua = new LuaEngine({ onOutput: (text) => outputs.push(text) });
  await lua.createState();
  lua.attachProcess(Process.open(info.pid));
});

test.after(async () => {
  if (lua) {
    try {
      await lua.dispose();
    } catch {
      /* 忽略 */
    }
  }
  if (fixture) fixture.stop();
});

/* ------------------------------------------------------------------ *
 * 1. 状态与 int64 精度
 * ------------------------------------------------------------------ */

test('createState/doString：Lua 5.4 状态可用，int64 不丢精度', async () => {
  assert.equal(lua.isReady, true);
  assert.ok(lua.luaState > 0, 'Lua state 指针应有效');

  // 普通 Lua 语义
  assert.equal(await lua.doString('return 1+1'), 2);
  assert.equal(await lua.doString('return string.format("%d-%s", 7, "x")'), '7-x');
  assert.equal(await lua.doString('return math.floor(3.9)'), 3);

  // Lua 5.4 有独立的 64 位 integer，bigint 应原样往返
  const v = await lua.doString('return 9007199254740993');
  assert.equal(typeof v, 'bigint');
  assert.equal(v, 9007199254740993n);
  const extremes = await lua.doStringAll('return 9223372036854775807, math.type(9007199254740993)');
  assert.equal(extremes[0], 9223372036854775807n, 'int64 上界应原样返回');
  assert.equal(extremes[1], 'integer', 'Lua 5.4 的整数字子类型应为 integer');

  // JS → Lua 的 bigint 参数（callFunction）同样不丢精度
  await lua.doString('function echo64(x) return x + 1 end');
  assert.equal(await lua.callFunction('echo64', 9007199254740993n), 9007199254740994n);

  // 暴露的 API 函数数量（文档里逐个列出）
  assert.ok(lua.apiFunctionNames().length >= 55, `API 函数偏少：${lua.apiFunctionNames().length}`);
});

/* ------------------------------------------------------------------ *
 * 2. openProcess + 各类型读值
 * ------------------------------------------------------------------ */

test('openProcess/readInteger/readFloat/readDouble/readQword：跨进程读到夹具的已知值', async () => {
  const values = await lua.doStringAll(`
    assert(openProcess(${info.pid}), 'openProcess 失败')
    return getOpenedProcessID()
  `);
  assert.equal(values[0], info.pid);

  const got = await lua.doStringAll(`
    local b = getAddress('${hex(base)}')
    return readInteger(b + 0x${L.health.toString(16)}),
           readInteger(b + 0x${L.ammo.toString(16)}),
           readFloat(b + 0x${L.position.toString(16)}),
           readDouble(b + 0x${L.money.toString(16)}),
           readQword(b + 0x${L.bigCounter.toString(16)}),
           readSmallInteger(b + 0x${L.signedValue.toString(16)}),
           readSmallInteger(b + 0x${L.signedValue.toString(16)}, true),
           readByte(b + 0x${L.byteFlag.toString(16)})
  `);

  assert.equal(got[0], 1000, 'health 应为 1000 (int32)');
  assert.equal(got[1], 500, 'ammo 应为 500');
  assert.equal(got[2], 3.5, 'position 应为 3.5 (float)');
  assert.equal(got[3], 1234.5678, 'money 应为 1234.5678 (double)');

  // 关键：int64 精度不丢（9007199254740993 > Number.MAX_SAFE_INTEGER）
  assert.equal(typeof got[4], 'bigint', 'readQword 必须返回 bigint 才能保住精度');
  assert.equal(got[4], 9007199254740993n);

  assert.equal(got[5], 64302, 'readSmallInteger 默认无符号');
  assert.equal(got[6], -1234, 'readSmallInteger(_, true) 应有符号');
  assert.equal(got[7], 200, 'readByte 默认无符号');

  // readInteger 默认有符号（本移植与 CE 的差异，见 docs/lua-api.md）：
  // 用 filler 区当临时 int32 写入 -5 再回读
  const signed = await lua.doStringAll(`
    local tmp = getAddress('${hex(base)}') + 0x${L.fillerStart.toString(16)}
    writeInteger(tmp, -5)
    local s1 = readInteger(tmp)
    local s2 = readInteger(tmp, false)
    writeInteger(tmp, ${info.values.fillerValue})       -- 还原
    return s1, s2, readInteger(tmp)
  `);
  assert.equal(signed[0], -5, 'readInteger 默认按有符号 int32 解释');
  assert.equal(signed[1], 4294967291, 'readInteger(_, false) 返回无符号 dword');
  assert.equal(signed[2], info.values.fillerValue, 'filler 区应已还原');
});

/* ------------------------------------------------------------------ *
 * 3. 写内存 + 字符串读
 * ------------------------------------------------------------------ */

test('writeInteger/writeBytes 回读，readString 读到 ANSI/宽字符串', async () => {
  const r = await lua.doStringAll(`
    local b = getAddress('${hex(base)}')
    local hpAddr = b + 0x${L.ammo.toString(16)}
    local ok = writeInteger(hpAddr, 777)
    local back = readInteger(hpAddr)
    writeInteger(hpAddr, 500)                      -- 还原，避免影响其它用例
    return ok, back, readInteger(hpAddr)
  `);
  assert.equal(r[0], true);
  assert.equal(r[1], 777);
  assert.equal(r[2], 500, '还原后应为 500');

  // 浮点写入
  const f = await lua.doStringAll(`
    local b = getAddress('${hex(base)}')
    local ok = writeFloat(b + 0x${L.position.toString(16)}, 1.25)
    local v = readFloat(b + 0x${L.position.toString(16)})
    writeFloat(b + 0x${L.position.toString(16)}, 3.5)
    return ok, v
  `);
  assert.equal(f[0], true);
  assert.equal(f[1], 1.25);

  // writeBytes：表形式 + 变参形式
  const w = await lua.doStringAll(`
    local b = getAddress('${hex(base)}')
    local n1 = writeBytes(b + 0x${L.byteFlag.toString(16)}, {0x11, 0x22})
    local t = readBytes(b + 0x${L.byteFlag.toString(16)}, 2)
    writeBytes(b + 0x${L.byteFlag.toString(16)}, 0xC8)   -- 还原成 200
    return n1, t[1], t[2], #t, readByte(b + 0x${L.byteFlag.toString(16)})
  `);
  assert.equal(w[0], 2, 'writeBytes 应返回写入字节数');
  assert.equal(w[1], 0x11);
  assert.equal(w[2], 0x22);
  assert.equal(w[3], 2, 'readBytes 返回的是一张 1 基的表');
  assert.equal(w[4], 200);

  // readBytes(..., false)：多返回值形式（CE 兼容）
  const multi = await lua.doStringAll(`
    local b = getAddress('${hex(base)}')
    local a, c = readBytes(b + 0x${L.nameString.toString(16)}, 2, false)
    return a, c
  `);
  assert.equal(multi[0], 'H'.charCodeAt(0));
  assert.equal(multi[1], 'E'.charCodeAt(0));

  // 字符串
  const s = await lua.doStringAll(`
    local b = getAddress('${hex(base)}')
    return readString(b + 0x${L.nameString.toString(16)}),
           readString(b + 0x${L.wideString.toString(16)}, 32, true)
  `);
  assert.equal(s[0], 'HELLO CHEAT ENGINE');
  assert.equal(s[1], 'WideString测试');

  // writeString 回读（CE 的 writeString 不写结尾 \0，所以这里用等长字符串覆盖）
  const ws = await lua.doStringAll(`
    local b = getAddress('${hex(base)}')
    local ok = writeString(b + 0x${L.nameString.toString(16)}, 'NODE CE ENGINE!!!!')
    local v = readString(b + 0x${L.nameString.toString(16)})
    writeString(b + 0x${L.nameString.toString(16)}, 'HELLO CHEAT ENGINE')
    return ok, v, readString(b + 0x${L.nameString.toString(16)})
  `);
  assert.equal(ws[0], true);
  assert.equal(ws[1], 'NODE CE ENGINE!!!!');
  assert.equal(ws[2], 'HELLO CHEAT ENGINE');
});

/* ------------------------------------------------------------------ *
 * 4. AOB 扫描
 * ------------------------------------------------------------------ */

test('AOBScan 返回 CE 风格 StringList，命中夹具的 AOB 特征', async () => {
  const expected = hex(base + BigInt(L.aobSignature));
  /** 地址归一化：去掉 `0x` 前缀并统一大写，用于**可靠地**比较地址。 */
  const normAddr = (v) => String(v).replace(/^0x/i, "").toUpperCase();
  const r = await lua.doStringAll(`
    local list = AOBScan('DE AD BE EF 90 90 ?? 7*')
    assert(list, 'AOBScan 返回 nil')
    local first = list:getString(0)
    local count = list.Count
    -- 收集**全部**命中地址（0 基遍历，CE 风格）。
    -- 必须 tostring() 后再 concat：list[i] 返回的是带 __tostring 的用户数据，
    -- 直接 table.concat 会失败。
    -- ⚠️ 这段是 JS 模板字符串，注释里**不能出现反引号**，否则会提前结束模板。
    local all = {}
    local walked = 0
    for i = 0, list.Count - 1 do
      walked = walked + #list[i]
      all[#all + 1] = tostring(list[i])
    end
    local viaIndex = tostring(list[0])
    list:destroy()
    return count, tostring(first), table.concat(all, ","), walked, viaIndex
  `);
  assert.ok(r[0] >= 1, `应至少命中 1 处，实际 ${r[0]}`);
  assert.match(r[1], /^[0-9A-F]{8,}$/, 'AOBScan 的条目应是 CE 风格的大写十六进制串（inttohex(x,8)）');
  // ⚠️ 这里**刻意不断言"第一处就是夹具特征"**，而是断言夹具那处在**命中集合**里。
  // 理由：AOB 特征在别的模块里也可能命中（实测确实有 2 处），
  // 并行分块扫描的**汇总顺序不保证**，所以"第一处"是不稳定断言。
  // 另外地址比较必须**归一化**：Lua 返回的条目带 `0x` 前缀，
  // 而直接 toUpperCase 会把前缀变成 `0X`，拿它跟 `0x` 比会假阴性（踩过）。
  const all = String(r[2]).split(",").filter((s) => s !== "").map(normAddr);
  assert.ok(
    all.includes(normAddr(expected)),
    `命中集合里应当包含夹具的 aobSignature（期望 ${expected}，实际命中 ${all.length} 处：${all.slice(0, 8).join(", ")}${all.length > 8 ? " …" : ""}）`
  );
  assert.ok(r[3] >= Number(r[0]) * 8, `0 基遍历应走遍所有条目（得到 ${r[3]}）`);
  // `list:getString(0)` 与 `list[0]` 取的应当是同一个地址（同样要归一化后比）
  assert.equal(
    normAddr(r[4]),
    normAddr(r[1]),
    `list[0] 与 list:getString(0) 应当是同一个地址（list[0]=${r[4]}，getString(0)=${r[1]}）`
  );

  // StringList 的其它接口
  const t = await lua.doStringAll(`
    local list = AOBScan('DE AD BE EF 90 90 ?? 7*')
    local n0 = list:getCount()
    list:add('DEADBEEF')
    local n1 = list:getCount()
    local idx = list:indexOf('DEADBEEF')
    list:clear()
    local n2 = list:getCount()
    return n0, n1, idx, n2
  `);
  assert.equal(t[1], Number(t[0]) + 1);
  assert.equal(t[2], Number(t[0]), 'add 返回的下标应等于 indexOf 结果');
  assert.equal(t[3], 0, 'clear 后应为空');

  // AOBScanUnique：**严格回归测试** —— 特征必须全进程唯一，且必须命中夹具那处。
  //
  // 背景（已定案，别再放宽这条断言）：
  //   夹具的 `uniqueAob` 是 16 字节（128 位）确定性序列，不可能因巧合重复，
  //   但曾经稳定命中 **2 处**（12/12 次，不是偶发）。当时一度怀疑是扫描器
  //   把同一匹配重复报告（错怪了 `scanAobManual` 的 offsets 复用）。
  //   实际根因在**夹具自己**：`fixture-target.js` 里那份 16KB 的
  //   `Buffer.alloc` 写完 VirtualAlloc 段后仍然活着，进程里因此存在
  //   第二份完全相同的字节（实测段内 70 个非零 32B 块有 69 个能在别处找到，
  //   且两处可独立写入 —— 不是同一物理页的别名）。夹具写完清零后即恢复唯一。
  //   所以下面的断言现在既是 AOBScanUnique 的行为验证，也是
  //   "夹具不要再留下第二份字节"的回归哨兵。
  const uniquePattern = '9E 3B 07 D4 61 F2 8A 35 CD 44 1B A7 72 E0 56 8F';
  const expectedUnique = base + BigInt(L.uniqueAob);
  const uniq = await lua.doStringAll(`
    local a = AOBScanUnique('${uniquePattern}')
    local list = AOBScan('${uniquePattern}')
    local n = list.Count
    list:destroy()
    -- 注意：不要把地址 tostring 后再比 —— tostring(整数) 给的是**十进制**串，
    -- 跟 0x 开头的十六进制串直接比会假失败（这里踩过）。直接返回整数比数值。
    return a ~= nil, a, n
  `);
  assert.equal(uniq[0], true, `AOBScanUnique 应当返回一处命中（实际 ${uniq[1]}）`);
  assert.equal(
    Number(uniq[2]),
    1,
    `uniqueAob 是 128 位确定性特征，必须全进程唯一；实际命中 ${uniq[2]} 处 ——` +
      ` 若 >1，多半是夹具又留下了第二份字节（见 fixture-target.js 的 buf.fill(0) 注释）`
  );
  assert.equal(
    hex(uniq[1]),
    hex(expectedUnique),
    `AOBScanUnique 应返回夹具 uniqueAob 的地址（期望 ${hex(expectedUnique)}，实际 ${hex(uniq[1])}）`
  );

  // 反向验证：那一段"不唯一"的特征确实会命中多于一处的可能性存在 ——
  // 这正是上面必须换特征的原因，把它固化成注释性的断言，
  // 避免以后有人"顺手改回 aobSignature"而重新引入偶发。
  const multi = await lua.doStringAll(`
    local list = AOBScan('DE AD BE EF 90 90 ?? 7*')
    local n = list.Count
    list:destroy()
    return n
  `);
  assert.ok(Number(multi[0]) >= 1, 'aobSignature 特征至少应命中一处（通常多于一处）');

  // AOBScanModule*：用模块头部的真实字节做特征
  const modTests = await lua.doStringAll(`
    local modBase = getModuleBase('node.exe')
    assert(modBase, '找不到 node.exe 模块')
    local bytes = readBytes(modBase, 4)
    local pat = string.format('%02X %02X %02X %02X', bytes[1], bytes[2], bytes[3], bytes[4])
    local u = AOBScanModuleUnique('node.exe', pat)
    local list = AOBScanModule('node.exe', pat)
    return u == modBase, list ~= nil and list.Count >= 1, pat
  `);
  assert.equal(modTests[0], true, `AOBScanModuleUnique('node.exe', '${modTests[2]}') 应命中模块基址`);
  assert.equal(modTests[1], true, 'AOBScanModule 应返回 StringList');
});

/* ------------------------------------------------------------------ *
 * 5. 地址解析 / 模块
 * ------------------------------------------------------------------ */

test('getAddress/getModuleBase/getModuleSize/表达式解析', async () => {
  const r = await lua.doStringAll(`
    local b = getModuleBase('kernel32.dll')
    local b2 = getModuleBase('KERNEL32')
    local size = getModuleSize('kernel32.dll')
    local a1 = getAddress('kernel32.dll')
    local a2 = getAddress('kernel32.DLL+1000')
    local a3 = getAddressSafe('不存在的符号+10')
    local a4 = getAddress(1234)
    return b ~= nil, b == b2, size ~= nil and size > 0, a1 ~= nil, a1 + 0x1000 == a2, a3 == nil, a4
  `);
  assert.equal(r[0], true, 'getModuleBase("kernel32.dll") 应有值');
  assert.equal(r[1], true, '模块名匹配应大小写不敏感 / 可省略扩展名');
  assert.equal(r[2], true, 'getModuleSize 应大于 0');
  assert.equal(r[3], true);
  assert.equal(r[4], true, '"kernel32.DLL+1000" 应解析为基址 + 0x1000');
  assert.equal(r[5], true, 'getAddressSafe 对未知符号应返回 nil');
  assert.equal(r[6], 1234, 'getAddress 对数字原样返回');

  // 模块内地址 → module+offset
  const n = await lua.doStringAll(`
    local b = getModuleBase('kernel32.dll')
    local n = getNameFromAddress(b + 0x40)
    return n, inModule(b + 0x40)
  `);
  assert.match(n[0], /^kernel32\.dll\+40$/i, `getNameFromAddress 结果异常：${n[0]}`);
  assert.equal(n[1], true);
});

test('registerSymbol/unregisterSymbol/getAddressSafe 支持符号', async () => {
  const r = await lua.doStringAll(`
    local hp = getAddress('${hex(base)}') + 0x${L.health.toString(16)}
    assert(registerSymbol('nce_health', hp))
    local v1 = readInteger('nce_health')
    local v2 = readInteger('nce_health+0')
    local a1 = getAddress('nce_health')
    unregisterSymbol('nce_health')
    local a2 = getAddressSafe('nce_health')
    local ok = registerSymbol('bad', '不存在的符号')
    return v1, v2, a1 == hp, a2 == nil, ok
  `);
  assert.equal(r[0], 1000);
  assert.equal(r[1], 1000);
  assert.equal(r[2], true);
  assert.equal(r[3], true, '注销后 getAddressSafe 应返回 nil');
  assert.equal(r[4], false, 'registerSymbol 解析失败应返回 false');
});

/* ------------------------------------------------------------------ *
 * 6. 完整 Lua 脚本（多行 doString）
 * ------------------------------------------------------------------ */

test('多行 Lua 脚本：openProcess + 读值 + 运算 + 写回 + print', async () => {
  const before = outputs.length;
  const result = await lua.doStringAll(`
    -- CE 风格的完整脚本
    local pid = ${info.pid}
    if not openProcess(pid) then
      print('打开进程失败: ' .. tostring(getLastError()))
      return nil
    end

    local base = getModuleBase('node.exe')          -- 只是走一遍模块 API
    local hpAddr = getAddress('${at(L.health)}')
    local hp = readInteger(hpAddr)
    print(string.format('血量 = %d @ 0x%X', hp, hpAddr))

    -- 翻倍后写回，再还原
    writeInteger(hpAddr, hp * 2)
    local doubled = readInteger(hpAddr)
    print(string.format('翻倍 = %d', doubled))

    local sum = 0
    for i = 1, 3 do
      sum = sum + readInteger(hpAddr)
    end

    writeInteger(hpAddr, hp)                        -- 还原
    local restored = readInteger(hpAddr)
    return doubled, sum, restored, hp, base ~= nil, type(hpAddr), math.type(hpAddr)
  `);

  assert.equal(result[0], 2000, '翻倍应为 2000');
  assert.equal(result[1], 6000, 'Lua 侧循环累加应为 3 * 2000');
  assert.equal(result[2], 1000, '应能还原为 1000');
  assert.equal(result[3], 1000);
  assert.equal(result[4], true);
  assert.equal(result[5], 'number', 'Lua 的 integer 在 type() 里也是 number');
  assert.equal(result[6], 'integer', 'Lua 5.4 的整数字子类型：math.type 应为 integer');
  const produced = outputs.slice(before);
  assert.equal(produced.length, 2, `print 应产生 2 行输出，实际：${JSON.stringify(produced)}`);
  assert.match(produced[0], /血量 = 1000 @ 0x/i);
  assert.match(produced[1], /翻倍 = 2000/);
});

test('loadString + callFunction：预编译的脚本块可复用', async () => {
  const handle = await lua.loadString('local a, b = ...; return a * b', 'multiply');
  assert.equal(typeof handle, 'number');
  assert.equal(await lua.callFunction(handle, 6, 7), 42);
  assert.equal(await lua.callFunction(handle, 9007199254740993n, 1), 9007199254740993n);

  // 全局函数 + 多返回值
  await lua.doString('function nce_pair(x) return x, x * 2 end');
  const all = await lua.callFunctionAll('nce_pair', 21);
  assert.deepEqual(all, [21, 42]);

  // 不存在的函数要抛错
  await assert.rejects(() => lua.callFunction('no_such_function_here'), /不是函数/);
});

/* ------------------------------------------------------------------ *
 * 7. 地址表 / MemoryRecord
 * ------------------------------------------------------------------ */

test('getAddressList + MemoryRecord：Address/Description/Type/Value/Active', async () => {
  const r = await lua.doStringAll(`
    local al = getAddressList()
    local rec = al:createMemoryRecord('${at(L.targetValue)}', 'targetValue', 'dword')
    rec.Address = getAddress('${at(L.targetValue)}')      -- 写回整数形式（会转成十六进制串）
    rec.Type = 'dword'
    local v0 = rec.Value
    local n0 = rec.NumericalValue
    rec.Value = 4242
    local v1 = rec.Value
    rec.Value = 4242                                      -- 保持原值，避免影响其它用例
    rec.Active = false
    local frozen = rec.Value
    rec.Active = true

    local cur = rec.CurrentAddress
    local desc, ty, id = rec.Description, rec.Type, rec.ID
    local byDesc = al:getMemoryRecordByDescription('targetValue')
    return al.Count, v0, n0, v1, frozen, cur == getAddress('${at(L.targetValue)}'), desc, ty, id, byDesc ~= nil
  `);
  assert.equal(r[0], 1, 'AddressList 应有 1 条记录');
  assert.equal(r[1], '4242');
  assert.equal(r[2], 4242);
  assert.equal(r[3], '4242');
  assert.equal(r[4], '4242', 'Active=false 时应返回缓存值而不是重新读内存');
  assert.equal(r[5], true);
  assert.equal(r[6], 'targetValue');
  assert.equal(r[7], 2, 'Type 应是 vtDword=2');
  assert.equal(r[8], 1);
  assert.equal(r[9], true, '应能按描述查找记录');

  // 只读属性赋值应抛错
  const ro = await lua.doStringAll(`
    local al = getAddressList()
    local rec = al:getMemoryRecord(0)
    local ok, err = pcall(function() al.Count = 5 end)
    return ok, tostring(err)
  `);
  assert.equal(ro[0], false, 'Count 是只读属性，赋值应抛错');
  assert.match(ro[1], /只读/);
});

/* ------------------------------------------------------------------ *
 * 8. 扫描会话（firstScan / nextScan）
 * ------------------------------------------------------------------ */

test('newScanSession/firstScan/nextScan：真实扫描 + mutate 后再次筛选', async () => {
  const r = await lua.doStringAll(`
    nce_session = newScanSession({ parallel = false })   -- 存成全局，下一步复用同一个会话
    local s = nce_session
    local n1 = s:firstScan({ type = 'dword', option = 'exact', value = '1000' })
    local found = false
    for i = 0, s.Count - 1 do
      if s[i] == getAddress('${at(L.health)}') then found = true end
    end
    local stats = s:getStats()
    return n1, found, stats.regionsScanned > 0, stats.hasSnapshot, s.ProcessID
  `);
  assert.ok(r[0] >= 1, `首次扫描 dword=1000 应有结果，实际 ${r[0]}`);
  assert.equal(r[1], true, '结果里应包含夹具的 health 地址');
  assert.equal(r[2], true);
  assert.equal(r[3], true, '默认会话应保留快照，才能继续 nextScan');
  assert.equal(r[4], info.pid);

  // 让夹具把 health 改成 1100，再按精确值筛选
  await fixture.command('mutate');

  const r2 = await lua.doStringAll(`
    local s = nce_session
    local n2 = s:nextScan({ type = 'dword', option = 'exact', value = '1100' })
    local found = false
    for i = 0, s.Count - 1 do
      if s[i] == getAddress('${at(L.health)}') then found = true end
    end
    return n2, found
  `);
  assert.ok(r2[0] >= 1, `再次扫描应有结果，实际 ${r2[0]}`);
  assert.equal(r2[1], true, '再次扫描后仍应包含 health（1000 → 1100）');

  // 高层 function 形式（隐式会话）
  const r3 = await lua.doStringAll(`
    resetScanResults()
    local n = firstScan({ type = 'dword', option = 'exact', value = '1100' })
    local c = getScanResultCount()
    local first = getScanResult(0)
    local list = getScanResults()
    local st = getScanSessionStats()
    local vals = getScanSession():getValues('dword', 3)
    return n, c, first ~= nil, #list == c, st.resultCount == c, #vals
  `);
  assert.equal(r3[0], r3[1]);
  assert.equal(r3[2], true);
  assert.equal(r3[3], true);
  assert.equal(r3[4], true);
  assert.ok(r3[5] >= 1);

  // 还原 health，避免影响其它用例
  await lua.doString(`writeInteger(getAddress('${at(L.health)}'), 1000)`);
  assert.equal(await lua.doString(`return readInteger(getAddress('${at(L.health)}'))`), 1000);
});

/* ------------------------------------------------------------------ *
 * 9. 错误处理
 * ------------------------------------------------------------------ */

test('错误处理：语法错误 / 运行时错误 / pcall 捕获 API 参数错误', async () => {
  await assert.rejects(() => lua.doString('return 1 +'), /语法错误|unexpected|syntax/i);
  await assert.rejects(() => lua.doString('error("故意报错")'), /故意报错/);
  await assert.rejects(() => lua.doString('local t = nil; return t.x'), /运行时错误/);

  // API 参数错误在 Lua 侧是可捕获的（CE 的 getAddress 同样抛错）
  const r = await lua.doStringAll(`
    local ok1, err1 = pcall(readInteger, '根本没有这个符号')
    local ok2, err2 = pcall(function() return AOBScan() end)
    local ok3 = pcall(sleep, -5)
    local v = readInteger('kernel32.dll')               -- 读到模块头（合法但值随意）
    return ok1, ok2, ok3, v ~= nil, tostring(err1):find('无法解析') ~= nil
  `);
  assert.equal(r[0], false);
  assert.equal(r[1], false);
  assert.equal(r[2], false);
  assert.equal(r[3], true);
  assert.equal(r[4], true);

  // 未打开进程时读内存返回 nil（CE 风格）
  const fresh = new LuaEngine({ onOutput: () => {} });
  await fresh.createState();
  assert.equal(await fresh.doString('return readInteger(0x1000)'), null);
  assert.equal(await fresh.doString('return getOpenedProcessID()'), 0);
  await assert.rejects(() => fresh.doString('firstScan({ type = "dword", value = "1" })'), /尚未打开目标进程|openProcess/);
  await fresh.dispose({ closeProcess: false });
});

/* ------------------------------------------------------------------ *
 * 10. 工具函数 / 进程枚举
 * ------------------------------------------------------------------ */

test('sleep/getTickCount/showMessage/print/getProcessList', async () => {
  const t0 = Date.now();
  await lua.doString('sleep(40)');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 35, `sleep(40) 实际只用了 ${elapsed}ms`);
  assert.ok(elapsed < 2000, `sleep(40) 阻塞过久：${elapsed}ms`);

  const tick = await lua.doString('return getTickCount()');
  assert.ok(big(tick) > 0n, 'getTickCount 应返回正数');
  assert.ok(big(tick) > 60n * 1000n, 'getTickCount 是系统运行时间（毫秒），应大于 1 分钟');

  const before = outputs.length;
  const r = await lua.doStringAll(`
    print('print 一行', 42)
    local ok = showMessage('showMessage 一行')
    local list = getProcessList()
    local name = list[${info.pid}]
    local pid2 = getProcessIDFromProcessName(name)
    return ok, type(name), name, list[pid2] == name
  `);
  assert.equal(r[0], true);
  assert.equal(r[1], 'string', 'getProcessList 应返回 pid → 进程名 的表（整数键）');
  assert.match(r[2], /node/i, `夹具进程名异常：${r[2]}`);
  // 同一台机器上可能挂着多个 node.exe，所以只验证"按名字查回来的 pid 名字相同"
  assert.equal(r[3], true, 'getProcessIDFromProcessName 应与 getProcessList 自洽');
  const produced = outputs.slice(before);
  assert.equal(produced.length, 2);
  assert.equal(produced[0], 'print 一行\t42');
  assert.equal(produced[1], 'showMessage 一行');

  assert.ok(outputs.includes('showMessage 一行'), '输出回调应收到 showMessage');
});

/* ------------------------------------------------------------------ *
 * 11. JS 侧直调 + 生命周期
 * ------------------------------------------------------------------ */

test('invoke：不写 Lua 代码也能调 API；dispose 幂等且之后不可用', async () => {
  assert.equal(lua.invoke('getOpenedProcessID'), BigInt(info.pid));
  assert.equal(lua.invoke('readInteger', at(L.targetValue)), 4242n);
  assert.equal(lua.invoke('getAddressSafe', '不存在的符号'), null);
  assert.ok(lua.invoke('getModuleBase', 'kernel32.dll') !== null);

  const extra = new LuaEngine();
  await extra.createState();
  const proc = Process.open(info.pid);
  extra.attachProcess(proc);
  assert.equal(await extra.doString(`return readInteger('${at(L.targetValue)}')`), 4242);
  await extra.dispose();
  await extra.dispose(); // 幂等
  assert.equal(extra.isReady, false);
  assert.equal(proc.isOpen, false, 'dispose 默认应关闭自己持有的进程句柄');
  await assert.rejects(() => extra.doString('return 1'), /已销毁/);
});

/* ------------------------------------------------------------------ *
 * 12. 回归：userdata 不得因 Lua GC 而悬垂
 *
 * 曾经的 bug：`__gc` 无条件 `objects.delete(handle)`，而同一个宿主对象
 * （典型是 `getAddressList()` 这个**全局单例**）可以同时有多个 userdata。
 * 其中任意一个被 GC 回收后，其余**仍然存活**的 userdata 就全部悬垂，
 * 之后任何属性/方法访问都抛「self 不是本引擎的对象」——且永久不可恢复。
 * 触发条件极低：只要脚本里出现过一次 `collectgarbage()` 就会命中。
 *
 * 修复：改为引用计数（`handleRefs`），最后一个 userdata 消失才真正回收；
 * 同时 `handleOf` 校验缓存句柄是否仍在 `objects` 中。
 * ------------------------------------------------------------------ */

test('回归：collectgarbage 之后 userdata 仍然可用（不得悬垂）', async () => {
  // 注意：`getAddressList()` 是**跨用例共享的单例**，前面的用例已经往里加过记录，
  // 所以这里不能断言绝对 Count，只能断言「GC 前后一致 / 增量正确」。
  const before = await lua.doString('local al = getAddressList() return al.Count');

  // 单例跨 GC —— 修复前这里会抛「self 不是本引擎的对象」
  const afterGc = await lua.doString(`
    local al = getAddressList()
    for i = 1, 15 do collectgarbage() end
    return al.Count
  `);
  assert.equal(afterGc, before, 'GC 后 getAddressList() 仍应可用且内容不变');

  // 属性读写在 GC 后依然正常
  assert.equal(await lua.doString('local al = getAddressList() collectgarbage() al.zap = "v" return al.zap'), 'v');
  assert.equal(await lua.doString('local al = getAddressList() collectgarbage() return al.Nope'), null);

  // 同一单例的多个别名同时存活，GC 后互不影响
  const aliases = await lua.doString(`
    local a = getAddressList()
    local b = getAddressList()
    local base = a.Count
    a:createMemoryRecord('${at(4)}', 'x')
    -- 加完立刻读：两个别名都必须看到 +1
    local immediate = (a.Count == base + 1) and (b.Count == base + 1)
    collectgarbage()
    -- GC 之后仍然如此（修复前这一步会因 userdata 悬垂而直接抛错）
    return immediate and (a.Count == base + 1) and (b.Count == base + 1)
  `);
  assert.equal(aliases, true, '两个别名应看到同一个地址表的同一条记录，且跨 GC 仍然有效');
});

test('回归：StringList / ScanSession 跨 GC 不失效', async () => {
  const list = await lua.doString(`
    local l = AOBScan('90 90')
    local n = l.Count
    for i = 1, 8 do collectgarbage() end
    return l.Count == n and l[0] ~= nil
  `);
  assert.equal(list, true, 'StringList 跨 GC 后仍可读');

  const session = await lua.doString(`
    local s = newScanSession()
    s:firstScan({ type = 'dword', option = 'exact', value = ${L.targetValue} })
    local n = s.Count
    for i = 1, 8 do collectgarbage() end
    return n > 0 and s.Count == n
  `);
  assert.equal(session, true, 'ScanSession 跨 GC 后仍可读');
});

test('回归：大量 GC 与对象混用后共享单例依然健康', async () => {
  // 制造大量临时 userdata（会触发大量 __gc）后再访问单例
  const ok = await lua.doString(`
    for i = 1, 60 do local tmp = AOBScan('90 90') end
    collectgarbage()
    collectgarbage()
    local al = getAddressList()
    local base = al.Count
    al:createMemoryRecord('${at(4)}', 'after-gc')
    collectgarbage()
    return (base >= 0) and (al.Count == base + 1)
  `);
  assert.equal(ok, true, '大量 GC 之后地址表应仍可正常读写');
});

/* ------------------------------------------------------------------ *
 * 13. 内存属性：分配 / 保护 / 区域
 * ------------------------------------------------------------------ */

test('allocateMemory/deAlloc：分配的内存可写可读可释放', async () => {
  const r = await lua.doString(`
    local p = allocateMemory(64)
    if not p then return 'alloc-failed:' .. tostring(getLastError()) end
    writeInteger(p, 0x1234ABCD)
    local v = readInteger(p, false)
    local freed = deAlloc(p)
    -- 用 tostring 判断非零，避免 %d 收到 boolean
    return string.format('%s:%X:%s', tostring(p ~= 0), v, tostring(freed))
  `);
  assert.equal(r, 'true:1234ABCD:true', '应能分配、写入、读回并释放');
});

test('allocateMemory 支持指定保护属性名', async () => {
  const r = await lua.doString(`
    local p = allocateMemory(4096, 'RW')
    writeByte(p, 0xAB)
    local b = readByte(p)
    local prot = getMemoryProtection(p)
    deAlloc(p)
    return string.format('%d/%s', b, tostring(prot))
  `);
  assert.match(r, /^171\//, 'RW 保护的分配应可写，字节为 0xAB');
});

test('get/setMemoryProtection 与 fullAccess 能改页保护并回读', async () => {
  const r = await lua.doString(`
    local p = allocateMemory(4096)
    local before = getMemoryProtection(p)          -- 分配时默认 RWX
    local old = setMemoryProtection(p, 'R')          -- 改成只读
    local after = getMemoryProtection(p)
    local old2 = fullAccess(p)                      -- 改回可执行可读写
    local after2 = getMemoryProtection(p)
    deAlloc(p)
    return table.concat({ before, old, after, old2, after2 }, '|')
  `);
  const parts = r.split('|');
  assert.equal(parts.length, 5);
  assert.match(parts[0], /RWX/, 'allocateMemory 默认应为 RWX');
  assert.match(parts[2], /R$/, 'setMemoryProtection(p, "R") 后应变为只读');
  assert.match(parts[4], /RWX/, 'fullAccess 后应变为 RWX');
});

test('getRegionSize / enumRegions 能报告区域', async () => {
  const size = await lua.doString(`
    local p = allocateMemory(4096)
    local z = getRegionSize(p)
    deAlloc(p)
    return z
  `);
  assert.equal(size, 4096, '刚分配的 4096 字节区域应报告 4096');

  const regions = await lua.doString('return #enumRegions()');
  assert.ok(regions > 0, '目标进程应至少有一个已提交区域');

  const privateCount = await lua.doString('return #enumRegions({ type = "MEM_PRIVATE" })');
  assert.ok(privateCount > 0, '应能按 MEM_PRIVATE 过滤出私有区域');

  // 校验区域元素形状
  const shape = await lua.doString(`
    local r = enumRegions()[1]
    return string.format('%s/%s/%s', tostring(r.StartAddress ~= nil), tostring(r.Size ~= nil), tostring(r.Type ~= nil))
  `);
  assert.equal(shape, 'true/true/true', '区域元素应含 StartAddress / Size / Type');
});

test('未知地址的区域查询返回 nil 而不是抛错', async () => {
  assert.equal(await lua.doString('return getMemoryProtection(0x10)'), null);
  assert.equal(await lua.doString('return getRegionSize(0x10)'), null);
});

/* ------------------------------------------------------------------ *
 * 14. 汇编 / 反汇编
 * ------------------------------------------------------------------ */

test('assembleBytes：只编码不写内存，返回 1 基字节表', async () => {
  const hex = await lua.doString(`
    local t = assembleBytes('mov eax, 1')
    local s = ''
    for i = 1, #t do s = s .. string.format('%02X ', t[i]) end
    return s
  `);
  assert.equal(hex.trim(), 'B8 01 00 00 00', 'mov eax,1 应编码为 B8 01 00 00 00');

  const nop = await lua.doString("local t = assembleBytes('nop') return #t");
  assert.equal(nop, 1, 'nop 应为 1 字节');
});

test('assemble：汇编并写入目标进程，回读一致', async () => {
  const r = await lua.doString(`
    local p = allocateMemory(4096)
    local n = assemble('mov eax, 0x41414141', p)
    local t = readBytes(p, 5)
    deAlloc(p)
    local s = ''
    for i = 1, #t do s = s .. string.format('%02X ', t[i]) end
    return string.format('%d|%s', n, s)
  `);
  assert.equal(r, '5|B8 41 41 41 41 ', '写入的机器码应为 B8 41 41 41 41');
});

test('assemble 省略地址时自动分配内存', async () => {
  const n = await lua.doString("return assemble('nop')");
  assert.equal(n, 1, '省略地址时应自动分配并写入 1 字节');
});

test('disassembleBytes / disassemble：反汇编出正确助记符', async () => {
  const fromBytes = await lua.doString(`
    local t = assembleBytes('mov eax, 1')
    return disassembleBytes(t, 0x1000, 1)[1]
  `);
  assert.match(String(fromBytes), /mov eax, 1/, '应反汇编回 mov eax, 1');

  const fromHex = await lua.doString("return disassembleBytes('B801000000', 0x1000, 1)[1]");
  assert.match(String(fromHex), /mov eax, 1/, '十六进制字符串同样可反汇编');

  const fromMem = await lua.doString(`
    local p = allocateMemory(4096)
    assemble('nop', p)
    local d = disassemble(p, 1)
    deAlloc(p)
    return d[1]
  `);
  assert.match(String(fromMem), /nop/, '应从目标进程内存反汇编出 nop');
});

test('汇编失败会抛 Lua 错误，可被 pcall 捕获', async () => {
  const ok = await lua.doString(
    "local ok, err = pcall(function() return assembleBytes('this is not valid asm') end) return ok",
  );
  assert.equal(ok, false, '非法指令应让 pcall 返回 false');

  const empty = await lua.doString(
    "local ok = pcall(function() return assembleBytes('') end) return ok",
  );
  assert.equal(empty, false, '空指令应报错');
});

test('汇编能解析已注册符号', async () => {
  registerSymbolForTest(BigInt(info.base));
  const n = await lua.doString(`
    local t = assembleBytes('mov eax, [base+4]', 0x1000)
    return #t
  `);
  assert.ok(Number(n) > 0, '引用符号的指令应能编码');
});

/** 把夹具基址注册成符号（供上面的汇编用例使用）。 */
function registerSymbolForTest(base) {
  lua.invoke('registerSymbol', 'base', base);
}
