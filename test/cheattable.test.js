/**
 * 地址表 + Cheat Table 读写测试（真实跨进程）。
 */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { useFixture } = require('./helpers/fixture');

const {
  AddressList,
  MemoryRecord,
  VariableType,
  ScanOption,
  RoundingType,
  ScanSession,
  addScanResults,
  buildRecordsFromScan,
  loadCheatTable,
  saveCheatTable,
  parseCheatTable,
  writeCheatTable,
  variableTypeToString,
  stringToVariableType,
  resolveAddress,
  normalizeCtAddress,
  ctAddressForFile,
} = require('../dist/cjs/index');

// 每个用例一个独立夹具，避免用例之间互相污染内存状态
const env = useFixture();
beforeEach(() => env.setup());
afterEach(() => env.teardown());

test('地址表达式：直接地址 / 模块相对 / 解引用 / 算术', () => {
  const proc = env.box.ctx.process;
  const base = env.box.ctx.base;

  // 1) 直接十六进制地址
  assert.equal(resolveAddress('0x' + base.toString(16), { process: proc }), base);
  // 2) 十进制
  assert.equal(resolveAddress(base.toString(10), { process: proc }), base);
  // 3) 算术 + 括号 + 位运算
  assert.equal(resolveAddress(`0x${base.toString(16)} + 0x10`, { process: proc }), base + 16n);
  assert.equal(resolveAddress(`(0x${base.toString(16)} + 0x20) - 0x10`, { process: proc }), base + 16n);
  assert.equal(resolveAddress('(2+3)*4', { process: proc }), 20n);
  assert.equal(resolveAddress('1 << 4', { process: proc }), 16n);
  assert.equal(resolveAddress('0xFF & 0x0F', { process: proc }), 15n);
  assert.equal(resolveAddress('0xF0 | 0x0F', { process: proc }), 0xffn);

  // 4) 解引用：指针链 chainA -> chainB -> target
  const chainA = base + BigInt(env.box.ctx.info.offsets.chainA);
  const target = base + BigInt(env.box.ctx.info.offsets.targetValue);
  // [chainA] = chainB 的地址，[[chainA]] = target 的地址
  assert.equal(resolveAddress(`[0x${chainA.toString(16)}]`, { process: proc }), base + BigInt(env.box.ctx.info.offsets.chainB));
  assert.equal(resolveAddress(`[[0x${chainA.toString(16)}]]`, { process: proc }), target);

  // 5) 模块相对地址
  const mods = proc.modules();
  assert.ok(mods.length > 0, '应能枚举到模块');
  const m = mods[0];
  const got = resolveAddress(`"${m.name}"+0`, { process: proc });
  assert.equal(got, m.baseAddress);
  // 带引号与不带引号都应支持
  const got2 = resolveAddress(`${m.name}+0x10`, { process: proc });
  assert.equal(got2, m.baseAddress + 16n);

  // 6) GetModuleBase 函数
  const got3 = resolveAddress(`GetModuleBase("${m.name}")`, { process: proc });
  assert.equal(got3, m.baseAddress);

  // 7) 寄存器在无调试器上下文时必须明确报错
  assert.throws(() => resolveAddress('[RAX]', { process: proc }), /寄存器/);

  // 8) 语法错误要能定位
  assert.throws(() => resolveAddress('0x100 +', { process: proc }), /意外的记号/);
  assert.throws(() => resolveAddress('(0x100', { process: proc }), /缺少 "\)"/);
  assert.throws(() => resolveAddress('[0x100', { process: proc }), /缺少 "\]"/);
  assert.throws(() => resolveAddress('0x100 + badident', { process: proc }), /未知的符号或模块/);
  assert.throws(() => resolveAddress('', { process: proc }), /空表达式/);
});

test('MemoryRecord：读 / 写 / 指针偏移链 / 锁定', () => {
  const proc = env.box.ctx.process;
  const L = env.box.ctx.info.offsets;
  const list = new AddressList(proc);

  // 直接地址 + int32
  const health = list.add({
    address: '0x' + (env.box.ctx.base + BigInt(L.health)).toString(16),
    variableType: VariableType.DWord,
    description: '生命值',
  });
  assert.equal(health.read(), '1000', '每个用例使用独立夹具，初始 health 必为 1000');

  // 写入 + 回读
  assert.equal(health.write('4321'), true);
  assert.equal(health.read(), '4321');
  assert.equal(health.write('1000'), true);

  // float
  const pos = list.add({
    address: '0x' + (env.box.ctx.base + BigInt(L.position)).toString(16),
    variableType: VariableType.Single,
    description: '坐标',
  });
  assert.equal(Number(pos.read()), 3.5, '独立夹具的初始 position = 3.5');
  pos.write('9.25');
  assert.equal(Number(pos.read()), 9.25);

  // double
  const money = list.add({
    address: '0x' + (env.box.ctx.base + BigInt(L.money)).toString(16),
    variableType: VariableType.Double,
  });
  assert.equal(Number(money.read()), 1234.5678);
  money.write('9876.5432');
  assert.equal(Number(money.read()), 9876.5432);

  // qword 大数（超过双精度安全整数）
  const big = list.add({
    address: '0x' + (env.box.ctx.base + BigInt(L.bigCounter)).toString(16),
    variableType: VariableType.QWord,
  });
  assert.equal(big.readValue(), 9007199254740993n);

  // 字符串
  const name = list.add({
    address: '0x' + (env.box.ctx.base + BigInt(L.nameString)).toString(16),
    variableType: VariableType.String,
    stringLength: 18,
  });
  assert.equal(name.read(), 'HELLO CHEAT ENGINE');

  // Unicode
  const wide = list.add({
    address: '0x' + (env.box.ctx.base + BigInt(L.wideString)).toString(16),
    variableType: VariableType.UnicodeString,
    stringLength: 14,
  });
  assert.equal(wide.read(), 'WideString测试');

  // 指针 + 偏移链：base = chainA，offsets = [0,0] => [ [chainA] + 0 ] + 0 == target
  const viaChain = list.add({
    address: '0x' + (env.box.ctx.base + BigInt(L.chainA)).toString(16),
    variableType: VariableType.DWord,
    offsets: [0, 0],
  });
  const ev = viaChain.resolve();
  assert.equal(ev.address, env.box.ctx.base + BigInt(L.targetValue));
  assert.equal(Number(viaChain.read()), 4242);

  // 十六进制显示
  const hexRec = list.add({
    address: '0x' + (env.box.ctx.base + BigInt(L.targetValue)).toString(16),
    variableType: VariableType.DWord,
    hexadecimal: true,
  });
  assert.equal(hexRec.read(), '0x1092');

  // 锁定写回
  const frozen = list.add({
    address: '0x' + (env.box.ctx.base + BigInt(L.ammo)).toString(16),
    variableType: VariableType.DWord,
    value: '777',
    frozen: true,
  });
  assert.equal(list.tickFrozen(), 1);
  assert.equal(frozen.read(), '777');

  // 停用后不参与锁定
  frozen.active = false;
  assert.equal(list.tickFrozen(), 0);
});

test('AddressList：增删查、符号、扫描结果导入', () => {
  const proc = env.box.ctx.process;
  const list = new AddressList(proc);

  const a = list.add({ address: '0x1000', variableType: VariableType.Byte, description: 'A' });
  const b = list.add({ address: '0x2000', variableType: VariableType.Byte, description: 'B' });
  assert.equal(list.count, 2);
  assert.equal(list.get(0), a);
  assert.equal(list.getByDescription('B'), b);
  assert.equal(list.get(1), b);

  assert.equal(list.remove(a), true);
  assert.equal(list.count, 1);
  assert.equal(list.getByDescription('A'), undefined);

  // 符号注册后可用于地址表达式
  list.registerSymbol('mySymbol', 0x1234n);
  assert.equal(list.resolveExpression('mySymbol'), 0x1234n);
  assert.equal(list.resolveExpression('mySymbol + 0x10'), 0x1244n);
  list.unregisterSymbol('mySymbol');
  assert.throws(() => list.resolveExpression('mySymbol'), /未知的符号/);

  // 扫描结果导入
  const scan = new ScanSession(proc, { blockSize: 1 << 20 });
  scan.firstScan({
    variableType: VariableType.DWord,
    scanOption: ScanOption.ExactValue,
    roundingType: RoundingType.Rounded,
    floatAccuracy: 0,
    value1: String(env.box.ctx.info.values.fillerValue),
    includeImage: false,
    includeMapped: false,
  });
  const recs = buildRecordsFromScan(list, scan.results.slice(0, 5), VariableType.DWord, '填充');
  assert.equal(recs.length, 5);
  assert.ok(recs.every((r) => r instanceof MemoryRecord));
  assert.equal(recs[0].read(), String(env.box.ctx.info.values.fillerValue));
});

test('Cheat Table：类型名映射与 CE 一致', () => {
  assert.equal(variableTypeToString(VariableType.Byte), 'Byte');
  assert.equal(variableTypeToString(VariableType.Word), '2 Bytes');
  assert.equal(variableTypeToString(VariableType.DWord), '4 Bytes');
  assert.equal(variableTypeToString(VariableType.QWord), '8 Bytes');
  assert.equal(variableTypeToString(VariableType.Single), 'Float');
  assert.equal(variableTypeToString(VariableType.Double), 'Double');
  assert.equal(variableTypeToString(VariableType.String), 'String');
  assert.equal(variableTypeToString(VariableType.UnicodeString), 'Unicode String');
  assert.equal(variableTypeToString(VariableType.ByteArray), 'Array of byte');
  assert.equal(variableTypeToString(VariableType.Pointer), 'Pointer');

  // 反向映射
  for (const t of [
    VariableType.Byte,
    VariableType.Word,
    VariableType.DWord,
    VariableType.QWord,
    VariableType.Single,
    VariableType.Double,
    VariableType.String,
    VariableType.UnicodeString,
    VariableType.ByteArray,
    VariableType.Pointer,
  ]) {
    assert.equal(stringToVariableType(variableTypeToString(t)), t);
  }
  // 未知字符串按 CE 一样回落到 Byte
  assert.equal(stringToVariableType('不认识'), VariableType.Byte);
});

test('Cheat Table：写入格式符合 CE（元素名/属性/引号）', () => {
  const proc = env.box.ctx.process;
  const L = env.box.ctx.info.offsets;
  const list = new AddressList(proc);
  list.add({
    id: 1,
    description: '生命值',
    address: `"node.exe"+0`,
    variableType: VariableType.DWord,
    value: '1000',
    offsets: [16, 8],
    hexadecimal: true,
  });
  list.add({ id: 2, description: '坐标', address: '0x1234', variableType: VariableType.Single, value: '3.5' });

  const xml = saveCheatTable(list, { version: 46, comment: '测试表' });

  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
  assert.match(xml, /<CheatTable CheatEngineTableVersion="46">/);
  assert.match(xml, /<Comment>测试表<\/Comment>/);
  assert.match(xml, /<CheatEntries>/);
  assert.match(xml, /<CheatEntry>/);
  assert.match(xml, /<ID>1<\/ID>/);
  // 描述在 CE 表里带引号
  assert.match(xml, /<Description>"生命值"<\/Description>/);
  // 变量类型用 CE 的字符串
  assert.match(xml, /<VariableType>4 Bytes<\/VariableType>/);
  assert.match(xml, /<VariableType>Float<\/VariableType>/);
  // ⚠️ 地址**不带外层引号**（只有描述带），而且裸数字按 CE 的写法（不写 `0x` 前缀）。
  //
  // 这条断言**曾经钉住的是错误行为**：早先写的是
  //   assert.match(xml, /<Address>""node\.exe"\+0"<\/Address>/);
  // 也就是"给地址再包一层引号"，还注释成"正是 CE 的格式"。查证 CE 源码：
  //   · CE 写地址是**原样**的（`MemoryRecordUnit.pas:1764` `TextContent:=interpretableaddress`），
  //     只有描述才加引号（`:1818`）；
  //   · CE 自己生成地址时也不带引号（`symbolhandler.pas:5045`
  //     `result:=mi.modulename+'+'+inttohex(address-mi.baseaddress,1)`）；
  //   · CE 的 `tokenize`（`symbolhandler.pas:3125-3154`）遇到引号只切换 `inQuote`、
  //     不产生分隔符 ⇒ `"node.exe+0"` 是**一个** token，`val('$node.exe+0')` 与
  //     `getmodulebyname('node.exe+0')` 都失败 ⇒ 这条地址在 CE 里根本无法解析。
  // 所以是我们写错了，改实现并修这条测试（不是迁就实现）。
  assert.match(xml, /<Address>"node\.exe"\+0<\/Address>/);
  // 同理：`0x1234` 要写回 CE 的裸十六进制形态 `1234`（CE 的解析器只在**整条**
  // 表达式是 `0x…` 时认这个前缀，见 `symbolhandler.pas:5228`；表达式中间带 `0x`
  // 会解析失败）。读回来时本移植会重新补上 `0x`，所以往返的值不变。
  assert.match(xml, /<Address>1234<\/Address>/);
  assert.doesNotMatch(xml, /<Address>""/, '地址绝不能整体再包一层引号（旧写法 `""node.exe"+0"`）');
  // 偏移链。
  // ⚠️ `.CT` 的 `<Offset>` 是**十六进制文本**（读端按 parseInt(text,16) 解析），
  // 所以写出的也必须是十六进制：`[16, 8]` 这组十进制值应写成 `10` 与 `8`。
  // 早先断言写的是 `<Offset>16</Offset>`，把「写入端按十进制写、与读端不对称」
  // 这个真 bug（会导致每次往返偏移漂移）当成了正确行为。
  assert.match(xml, /<Offsets>\s*<Offset>10<\/Offset>\s*<Offset>8<\/Offset>\s*<\/Offsets>/);
  assert.match(xml, /<ShowAsHex>1<\/ShowAsHex>/);
  assert.match(xml, /<LastState Value="1000"\/>/);
  // 元素顺序：ID → Description → VariableType → Address → Offsets → LastState
  const order = ['<ID>', '<Description>', '<VariableType>', '<Address>', '<Offsets>', '<LastState'];
  let last = -1;
  for (const tag of order) {
    const idx = xml.indexOf(tag);
    assert.ok(idx > last, `元素 ${tag} 顺序不正确`);
    last = idx;
  }

  void L;
});

test('Cheat Table：往返读写不丢信息（含未知元素）', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <Comment>往返测试</Comment>
  <UserdefinedSymbols>
    <SymbolEntry Name="myAddr" Address="0x1234"/>
  </UserdefinedSymbols>
  <CheatEntries>
    <CheatEntry>
      <ID>10</ID>
      <Description>"嵌套记录"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>"game.exe"+0012AB34</Address>
      <Offsets>
        <Offset>16</Offset>
        <Offset>-8</Offset>
      </Offsets>
      <ShowAsHex>1</ShowAsHex>
      <Color>FF0000</Color>
      <Options moHideChildren="1"/>
      <LastState Value="99" RealAddress="7FF600001234"/>
      <CheatEntries>
        <CheatEntry>
          <ID>11</ID>
          <Description>"子项"</Description>
          <VariableType>Float</VariableType>
          <Address>+8</Address>
          <LastState Value="1.5"/>
        </CheatEntry>
      </CheatEntries>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

  const parsed = parseCheatTable(xml);
  assert.equal(parsed.version, 46);
  assert.equal(parsed.comment, '往返测试');
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.symbols.length, 1);
  assert.equal(parsed.symbols[0].name, 'myAddr');

  const r = parsed.records[0];
  assert.equal(r.id, 10);
  assert.equal(r.description, '嵌套记录', '描述外层引号应被剥掉');
  assert.equal(r.variableType, VariableType.DWord);
  // ⚠️ 地址里的裸数字按 **.CT 语义（十六进制）** 规范化：
  // `"game.exe"+0012AB34` → `"game.exe"+0x12ab34`（0x12AB34，不是十进制 1223476）。
  // 这是本条测试的输入文本，规范化后进入 `MemoryRecord` 的构造函数，
  // 因此 `resolve()` 用的 `compiled` 也是这个表达式。
  assert.equal(r.address, '"game.exe"+0x12ab34');
  // ⚠️ 偏移在 .CT 里是**十六进制字面量**（CE 的 `parseAddress`/偏移解析都是 hex）。
  // 所以 `<Offset>16</Offset>` = 0x16 = 十进制 **22**，不是 16。
  // 早先这条断言写的是 `[16, -8]`（按十进制理解），把正确的实现当成了 bug ——
  // 这正是「加对照用例才发现的既有错误期望」的典型。
  assert.deepEqual(r.offsets, [0x16, -8], '偏移按十六进制解释（0x16 = 22），负偏移必须保留');
  assert.equal(r.hexadecimal, true);
  assert.equal(r.value, '99');
  assert.equal(r.children.length, 1);
  assert.equal(r.children[0].description, '子项');
  assert.equal(r.children[0].variableType, VariableType.Single);
  // 相对地址同样按十六进制规范化：`+8` → `+0x8`（值不变，但形态与 CE 一致）
  assert.equal(r.children[0].address, '+0x8');
  // 未知/未建模元素必须留下来
  assert.equal(r.extra.Color, 'FF0000');
  assert.ok(r.extra.Options !== undefined, 'Options 应保留');

  // 写回后再解析，关键字段必须一致
  const xml2 = writeCheatTable(parsed.records, { version: parsed.version, comment: parsed.comment });
  const parsed2 = parseCheatTable(xml2);
  assert.equal(parsed2.records.length, 1);
  const r2 = parsed2.records[0];
  assert.equal(r2.description, r.description);
  assert.equal(r2.variableType, r.variableType);
  assert.equal(r2.address, r.address);
  assert.deepEqual(r2.offsets, r.offsets);
  assert.equal(r2.hexadecimal, r.hexadecimal);
  assert.equal(r2.value, r.value);
  assert.equal(r2.children.length, 1);
  assert.equal(r2.children[0].address, '+0x8');
  assert.equal(r2.extra.Color, 'FF0000');
  assert.ok(r2.extra.Options !== undefined);
});

test('Cheat Table：加载后可真实求值（地址表达式 + 偏移链）', () => {
  const proc = env.box.ctx.process;
  const L = env.box.ctx.info.offsets;
  const base = env.box.ctx.base;

  // 指针链语义：base 处存放"下一级地址"，逐级解引用后加偏移。
  // 夹具里 chainA 存 chainB 的地址、chainB 存 targetValue 的地址，
  // 因此 base = chainA、offsets = [0, 0] 应解析到 targetValue 的地址。
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"目标值（经偏移链）"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>0x${(base + BigInt(L.chainA)).toString(16)}</Address>
      <Offsets>
        <Offset>0</Offset>
        <Offset>0</Offset>
      </Offsets>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

  const { list } = loadCheatTable(xml, proc);
  assert.equal(list.count, 1);
  const rec = list.get(0);
  const ev = rec.resolve();
  assert.equal(ev.address, base + BigInt(L.targetValue), '偏移链应解析到 targetValue 的地址');
  assert.equal(Number(rec.read()), 4242);

  // 偏移链断裂必须抛错，而不是静默给出一个"看起来对"的地址 —— 否则会写坏目标进程。
  // 这里把第一段偏移改成 256MB，解引用必然落到不可读地址。
  const brokenXml = xml.replace('<Offset>0</Offset>', '<Offset>268435456</Offset>');
  assert.notEqual(brokenXml, xml, '替换应生效');
  const { list: brokenList } = loadCheatTable(brokenXml, proc);
  assert.throws(() => brokenList.get(0).resolve(), /偏移链解引用失败/);

  // 基址引用不存在的模块时应按 tolerant 语义返回 null（便于加载别人的表）
  const { list: tolerantList } = loadCheatTable(
    xml.replace(/<Address>.*<\/Address>/, '<Address>"不存在的模块.exe"+1234</Address>'),
    proc,
  );
  const tolerantRec = tolerantList.get(0);
  assert.equal(tolerantRec.tolerant, true);
  assert.equal(tolerantRec.resolve().address, null);
  assert.ok(tolerantRec.resolve().error, '应给出失败原因');
});

/* ================================================================== *
 * `<Offset>` 的进制：CE 里是**十六进制文本**
 * ================================================================== */

/**
 * 钉死 `<Offset>` 的十六进制语义（外部实测发现的真 bug）。
 *
 * 早先 `parseCheatTable` 写的是 `Number.parseInt(o.text, 10)`，于是 CE 里
 * `<Offset>1000</Offset>`（= 0x1000 = 4096）被读成十进制 **1000** ——
 * **静默**读错地址，而且写回时又把 1000 写成 `3e8`，每往返一次偏移就漂移一次。
 *
 * 这条用例专门钉住 `1000` 这个十进制与十六进制**必然不同**的取值
 * （`<Offset>16</Offset>` 那种写法两个进制下只差一个数量级，容易被看漏）。
 */
test('Cheat Table：<Offset>1000</Offset> 必须按十六进制解析成 0x1000（不是十进制的 0x3e8）', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"偏移进制"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>"game.exe"+1234</Address>
      <Offsets>
        <Offset>1000</Offset>
      </Offsets>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

  const parsed = parseCheatTable(xml);
  assert.equal(parsed.records.length, 1);
  assert.deepEqual(
    parsed.records[0].offsets,
    [0x1000],
    '<Offset>1000</Offset> 是十六进制 0x1000（4096），不是十进制 1000',
  );

  // 写回必须仍是十六进制（与读端对称），否则每次往返都会漂移
  const xml2 = writeCheatTable(parsed.records, { version: parsed.version, comment: parsed.comment });
  assert.match(xml2, /<Offset>1000<\/Offset>/, '写回必须与读端同为十六进制');
  assert.doesNotMatch(xml2, /<Offset>3e8<\/Offset>/, '绝不能把十六进制值当十进制写出去');

  // 往返一次后偏移必须逐位相等
  assert.deepEqual(parseCheatTable(xml2).records[0].offsets, parsed.records[0].offsets);
});

test('Cheat Table：偏移里的十六进制字母与负偏移都要保住（且往返不漂移）', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <CheatEntries>
    <CheatEntry>
      <ID>7</ID>
      <Description>"多级偏移"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>"game.exe"+0</Address>
      <Offsets>
        <Offset>1A2B</Offset>
        <Offset>-8</Offset>
        <Offset>0</Offset>
      </Offsets>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

  const parsed = parseCheatTable(xml);
  assert.deepEqual(parsed.records[0].offsets, [0x1a2b, -8, 0]);

  const xml2 = writeCheatTable(parsed.records, {});
  assert.match(xml2, /<Offset>1a2b<\/Offset>/);
  assert.match(xml2, /<Offset>-8<\/Offset>/);
  assert.deepEqual(parseCheatTable(xml2).records[0].offsets, [0x1a2b, -8, 0]);
});

/* ================================================================== *
 * 条目备注（comment）与冻结（frozen）的持久化
 *
 * 这两条都曾经是「写端完全不输出」的**静默丢数据**：
 * `MemoryRecord.comment` / `.frozen` 一直存在、`toData()` 也一直带上它们，
 * 但 `writeEntry` 一个都不写 —— 于是插件工具报告添加成功、`.CT` 里却搜不到，
 * 往返一圈就没了。
 * ================================================================== */

test('Cheat Table：条目备注必须写进 .CT 并能读回来（往返不丢）', () => {
  // ⚠️ 关于元素名：CE 的 `TMemoryRecord` **根本没有"备注"字段**
  // （查证 `ce-src/Cheat Engine/MemoryRecordUnit.pas`：`getXMLNode` 写出的子元素
  // 只有 ID/Description/Options/DropDownList*/LastState/ShowAsHex/ShowAsSigned/
  // Color/GroupHeader/VariableType/CustomType/BitStart/BitLength/ShowAsBinary/
  // Length/Unicode/CodePage/ZeroTerminate/ByteLength/AssemblerScript/Hotkeys/CheatEntries；
  // 读端 `setXMLnode` 也只按这些固定名字 `FindNode`）。
  // 所以**不存在**一个"与 CE 同名"的备注元素可选。这里用 `<Comment>`：
  // CE 的读端不认识的多余子元素会被**直接忽略**（它是按名字 FindNode，不做校验），
  // 因此写出去不会破坏互通；本移植的读端认它，于是往返能带回来。
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"带备注"</Description>
      <Comment>这是我的备注 X</Comment>
      <VariableType>4 Bytes</VariableType>
      <Address>"game.exe"+10</Address>
      <LastState Value="7"/>
    </CheatEntry>
    <CheatEntry>
      <ID>2</ID>
      <Description>"没备注"</Description>
      <VariableType>Byte</VariableType>
      <Address>"game.exe"+20</Address>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

  const parsed = parseCheatTable(xml);
  assert.equal(parsed.records[0].comment, '这是我的备注 X', '备注必须被读出来');
  assert.equal(parsed.records[1].comment, undefined, '没有备注时不该凭空造一个');
  // 备注被当成已知元素，不能漏进 extra（否则会被按未知元素再写一遍）
  assert.equal(parsed.records[0].extra?.Comment, undefined, 'Comment 是已知元素，不该进 extra');

  const xml2 = writeCheatTable(parsed.records, {});
  assert.match(xml2, /<Comment>这是我的备注 X<\/Comment>/, `备注必须写回：\n${xml2}`);
  assert.equal(parseCheatTable(xml2).records[0].comment, '这是我的备注 X', '往返后备注不能丢');
  assert.equal(parseCheatTable(xml2).records[1].comment, undefined);
  // 二次往返必须**逐字节一致**（幂等，不会每次多写一层）
  assert.equal(writeCheatTable(parseCheatTable(xml2).records, {}), xml2, '二次往返必须逐字节一致');
});

test('Cheat Table：frozen 按 CE 的 <LastState Activated="1"/> 持久化，往返不丢', () => {
  // CE 写"启用/冻结"标记的唯一位置就是 `<LastState>` 的 **`Activated`** 属性
  // （`MemoryRecordUnit.pas:1926-1931`）。早先这里读的是 `Active`（代码注释也承认是在猜），
  // 而 CE **从不写** `Active` —— 于是本插件自己写出的冻结标记也读不回来。
  const list = new AddressList(null);
  list.add({
    description: '冻结的条目',
    address: '"game.exe"+10',
    variableType: VariableType.DWord,
    value: '1234',
    frozen: true,
  });
  list.add({
    description: '普通条目',
    address: '"game.exe"+20',
    variableType: VariableType.DWord,
    value: '5',
  });

  const xml = saveCheatTable(list, { includeLastState: true });
  assert.match(xml, /<LastState Activated="1" Value="1234"\/>/, `冻结必须写成 CE 的形式：\n${xml}`);
  assert.match(xml, /<LastState Value="5"\/>/, '没冻结的条目不带 Activated');

  const back = loadCheatTable(xml, null).list;
  const records = back.toData();
  assert.equal(records[0].frozen, true, '往返后 frozen 必须还在');
  assert.equal(records[1].frozen, undefined, '没冻结的条目不该变成 frozen');

  // 即使调用方不要 LastState，冻结状态也不能丢 —— 它是唯一可持久化的位置
  const xmlNoLastState = saveCheatTable(list, { includeLastState: false });
  assert.match(xmlNoLastState, /Activated="1"/, 'includeLastState=false 时仍要保住冻结');
  assert.equal(loadCheatTable(xmlNoLastState, null).list.toData()[0].frozen, true);
});

test('Cheat Table：快照必须带上 comment（工具层 list 读的就是它）', () => {
  // `ce_cheat_table action: list` 读的是 `AddressList.snapshot()`。
  // 早先 snapshot 没有 comment 字段，于是即便 `MemoryRecord.comment` 有值，
  // list 里也看不见 —— "add 显示得出来、list 却看不到"的不一致。
  const list = new AddressList(null);
  list.add({
    description: 'A',
    address: '"game.exe"+10',
    variableType: VariableType.DWord,
    comment: '备注 A',
    frozen: true,
  });
  list.add({ description: 'B', address: '"game.exe"+20', variableType: VariableType.DWord });

  const snapshot = list.snapshot();
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].comment, '备注 A', 'snapshot 必须带 comment');
  assert.equal(snapshot[0].frozen, true, 'snapshot 必须带 frozen');
  assert.equal(snapshot[1].comment, '', '没有备注时是空串（不是 undefined）');
  assert.equal(snapshot[1].frozen, false);
});

test('Cheat Table：老表的 Active="1" 仍然兼容（向后不破坏）', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"旧写法"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>"game.exe"+10</Address>
      <LastState Value="5" Active="1"/>
    </CheatEntry>
    <CheatEntry>
      <ID>2</ID>
      <Description>"显式停用"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>"game.exe"+20</Address>
      <LastState Value="6" Active="0"/>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;
  const parsed = parseCheatTable(xml);
  assert.equal(parsed.records[0].frozen, true, '旧写法 Active="1" 也要认成冻结');
  assert.equal(parsed.records[1].active, false, 'Active="0" 是显式停用');
});

test('Cheat Table：真实 CE 表往返后 <Length> 与 Activated 都不丢、也不改名', () => {
  // 这一条防的是"内部自洽但和 CE 不通"：CE 的变长条目用 `<Length>`，
  // 冻结用 `Activated`。写出去必须仍是这两个名字（CE 才认）。
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"CE 真表"</Description>
      <VariableType>Array of byte</VariableType>
      <Address>"game.exe"+10</Address>
      <Length>6</Length>
      <LastState RealAddress="7FF600001000" Value="DE AD BE EF 90 90" Activated="1"/>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;
  const list = loadCheatTable(xml, null).list;
  const data = list.toData()[0];
  assert.equal(data.stringLength, 6, '长度必须读出来');
  assert.equal(data.frozen, true, 'Activated 必须读成冻结');
  assert.equal(data.comment, undefined, '不该凭空多出备注');

  const xml2 = writeCheatTable(list, { includeLastState: true });
  assert.match(xml2, /<Length>6<\/Length>/, `<Length> 必须原样写回：\n${xml2}`);
  assert.doesNotMatch(xml2, /StringLength/, '绝不能写成 CE 不认的 <StringLength>');
  assert.match(xml2, /<LastState Activated="1" Value="DE AD BE EF 90 90"\/>/, 'Activated 必须保住');
  assert.doesNotMatch(xml2, /<Comment>/, '源表没有备注，输出也不该有');
});

/* ================================================================== *
 * `.CT` 地址语义（裸数字＝十六进制）、子项相对地址、用户自定义符号
 *
 * 这三条 0.1.7 上都**实测出过静默错值**，而根因都在内核这一层：
 *   · 地址语义只在插件里用正则改写 XML（引号/实体/注释三类洞）；
 *   · `MemoryRecord.resolve()` 完全不看 `parent`（`+18` 变成绝对地址 0x12）；
 *   · `parsed.symbols` 读出来却从不注册、save 时整段消失。
 * 所以回归必须钉在**内核自己**的 API 上（插件层的端到端回归见主仓库的
 * `test/ct-address-semantics.test.mjs`）。
 * ================================================================== */

test('CT 地址语义：normalizeCtAddress 把**每个**裸数字 token 当十六进制（CE 的 val(\'$\'+token)）', () => {
  const cases = [
    ['00401000', '0x401000', '整条裸数字'],
    ['"cmd.exe"+1000', '"cmd.exe"+0x1000', '引号模块名 + 裸偏移'],
    ['cmd.exe+1000', 'cmd.exe+0x1000', '无引号模块名'],
    ['+18', '+0x18', '子项相对地址'],
    ['-8', '-0x8', '负的相对地址'],
    ['game.exe+1000+10', 'game.exe+0x1000+0x10', '多个 + 项'],
    ['1000+1000', '0x1000+0x1000', '纯算术'],
    ['10*2', '0x10*0x2', '纯乘法'],
    ['["a.exe"+9000]+10', '["a.exe"+0x9000]+0x10', '指针链里的算术'],
    ['"00401000"', '"0x401000"', '整条被引号包住（解析前会先剥引号，见 parseCheatEntry）'],
    ['1A2B', '0x1a2b', '含 a-f 的裸串'],
    ['0x1234', '0x1234', '已显式 0x：不动'],
    ['$1234', '$1234', '已显式 $：不动'],
    ['myStat+8', 'myStat+0x8', '符号名 + 裸偏移'],
    ['', '', '空'],
  ];
  for (const [input, want, note] of cases) {
    assert.equal(normalizeCtAddress(input), want, `${note}：${input}`);
  }
  // 引号内部的 `+`/`-` 不是分隔符（CE 的 tokenize 在引号内不切分）
  assert.equal(normalizeCtAddress('"my-mod.exe"+10'), '"my-mod.exe"+0x10');

  // 反向：写出时换回 CE 的裸十六进制（CE 只在**整条**是 0x… 时才认那个前缀）。
  // 不变量：`normalize(ctAddressForFile(x))` 与 `x` **求值相同** ——
  // 文本形态会变（`0x1234` ⇄ `1234`、`$1234` → `1234` → `0x1234`），值不能变。
  // ⚠️ 大小写不参与：CE 的 `val('$'+token)` 两种都收（Delphi 的 `inttohex` 输出大写，
  // 本移植内部统一小写，写出时不再改写大小写）。
  for (const [input, want] of cases) {
    if (want === '') continue;
    const file = ctAddressForFile(want);
    let before;
    try {
      before = resolveAddress(want, {});
    } catch {
      continue; // 模块/符号形态需要进程与符号表，端到端由主仓库的测试覆盖
    }
    assert.equal(resolveAddress(normalizeCtAddress(file), {}), before, `往返：${input} → ${file}`);
  }
  assert.equal(ctAddressForFile('0x12ab34'), '12ab34');
  assert.equal(ctAddressForFile('0x0'), '0', '前导零要收敛（CE 写的是 inttohex(...,1)）');
  assert.equal(ctAddressForFile('$1234'), '1234');
  // 空格只在 token 外面（CE 的 tokenize 对每个 token 都 trim，symbolhandler.pas:3142/:3169），
  // 不能因为它而漏掉改写（早先这里不 trim：`"m.exe" + 0x9018` 写出去带 `0x` ⇒ CE 读不了）。
  // ⚠️ 注意 `"m.exe" + 9018` 里的 `9018` 是**内部十进制**（内核表达式引擎的约定），
  // 换算成十六进制是 `233a` —— 这条路径上的裸数字本来就只可能来自内部表达式。
  assert.equal(ctAddressForFile('"m.exe" + 0x9018'), '"m.exe" + 9018');
  assert.equal(ctAddressForFile('"m.exe" + 9018'), '"m.exe" + 233a');
  assert.equal(ctAddressForFile('"m.exe"  +  0x9018'), '"m.exe"  +  9018');
});

test('CT 地址语义：`0d` / `0b` 开头的裸串按**十六进制**读（与内核求值器、与 CE 一致）', () => {
  // ⚠️ 这条测试**以前钉住的是错行为**，这里明确改正（附 ce-src 证据）：
  //
  //   旧的断言：`ctAddressForFile('0d20') === '14'`、`('0b101') === '5'`
  //   —— 把 `0d`/`0b` 当十进制/二进制前缀。但 CE 不认这两个前缀：
  //   `symbolhandler.pas:5264-5268` 对**每个 token** 做 `val('$'+tokens[i]),v64,j`，
  //   `0d20` 全是十六进制字符 ⇒ j=0（解析成功）⇒ 它就是 **0xd20**；
  //   `0b101` 同理是 **0xb101**。内核词法器（`addr/expression.ts:152-162`）
  //   对"含 a-f 的裸串"也按十六进制，行为与 CE 一致。
  //
  //   于是旧断言与**自己的求值器**矛盾：同一张表里 0xd20（3360）经过一次
  //   save → load 会变成 20 —— 又是静默改地址。现在两者一致了。
  assert.equal(normalizeCtAddress('0d20'), '0xd20');
  assert.equal(normalizeCtAddress('0b101'), '0xb101');
  assert.equal(resolveAddress('0d20', {}), 0xd20n, '内核求值器把 0d20 读成 0xd20（与 CE 一致）');
  assert.equal(resolveAddress('0b101', {}), 0xb101n);

  // 往返不变量（真正该钉的东西）：写出 → 读回，**求值不变**
  for (const text of ['0d20', '0b101', '0x401000', '0x1000+0x1000', '0x10*0x2']) {
    const file = ctAddressForFile(text);
    assert.equal(
      resolveAddress(normalizeCtAddress(file), {}),
      resolveAddress(text, {}),
      `往返：${text} → 文件 ${file}`,
    );
  }
});

test('CT 地址语义：纯十进制 token 写出时必须换算成十六进制（save → load 不改地址）', () => {
  // 产品内部表达式里裸数字是**十进制**（`addr/expression.ts:152-162`，
  // 用户 `add 1000` 得到 0x3e8），而 `.CT` 里裸数字是**十六进制**。
  // 早先 `ctAddressForFile` 只处理带前缀的 token，裸十进制**原样写出**：
  //   add `1000+1000`（内部 0x7d0）→ `<Address>1000+1000</Address>` → load 得 0x2000
  // —— save → load **静默改地址**。
  const cases = [
    ['1000', '3e8'],
    ['1000+1000', '3e8+3e8'],
    ['0x400000+20', '400000+14'],
    ['0x10+20', '10+14'],
  ];
  for (const [internal, want] of cases) {
    assert.equal(ctAddressForFile(internal), want, `写出：${internal}`);
    assert.equal(
      resolveAddress(normalizeCtAddress(ctAddressForFile(internal)), {}),
      resolveAddress(internal, {}),
      `往返求值不变：${internal}`,
    );
  }
  assert.equal(resolveAddress(ctAddressForFile('1000'), {}), 0x3e8n, '1000 是十进制 1000 = 0x3e8');
  assert.notEqual(resolveAddress(ctAddressForFile('1000'), {}), 0x1000n, '不能当成十六进制 1000 写出去');
});

test('CT 地址语义：真实 CE 表里数字 token 前后的**空白**不能改变语义（CE 会 trim）', () => {
  // CE 的 `tokenize`（symbolhandler.pas:3142 `t:=trim(copy(s,last,i-last))`、
  // :3169 末段同样 trim）对**每个** token 都 trim。早先本移植不 trim，于是
  // `"game.exe" + 9018` 里的 ` 9018` 不匹配 `/^[0-9a-f]+$/`、原样保留 ⇒
  // 内核词法器按**十进制**读 ⇒ 地址错，而且不报错。
  const cases = [
    ['"m.exe"+9018', '"m.exe"+0x9018'],
    ['"m.exe" +9018', '"m.exe" +0x9018'],
    ['"m.exe"+ 9018', '"m.exe"+ 0x9018'],
    ['"m.exe" + 9018', '"m.exe" + 0x9018'],
    ['["m.exe"+9000] + 10', '["m.exe"+0x9000] + 0x10'],
    // ⚠️ 整条表达式**首尾**的空白由 `normalizeCtAddress` 自己的 `trim()` 去掉
    // （CE 的 getAddressFromName 拿到的也是调用方 trim 过的字符串），
    // 但**中间**的空白必须原样保留。
    ['  1000  +  10  ', '0x1000  +  0x10'],
  ];
  for (const [input, want] of cases) {
    assert.equal(normalizeCtAddress(input), want, `读入：${input}`);
  }
  // 写出侧同理：token 带空白时也必须把 `0x` 去掉（否则 CE 解析不了我们写的表）
  assert.equal(ctAddressForFile('"m.exe" + 0x9018'), '"m.exe" + 9018');
  assert.equal(ctAddressForFile('"m.exe" - 0x8'), '"m.exe" - 8');
});


test('CT 地址语义：地址**不加外层引号**、裸十六进制写出（CE 才读得回来）', () => {
  const list = new AddressList(null);
  list.add({ description: '模块相对', address: '"game.exe"+0x12AB34', variableType: VariableType.DWord });
  list.add({ description: '绝对', address: '0x1234', variableType: VariableType.DWord });
  const xml = saveCheatTable(list, { includeLastState: false });

  // CE 写地址是原样的（MemoryRecordUnit.pas:1764），生成时也不带引号（symbolhandler.pas:5045）
  assert.match(xml, /<Address>"game\.exe"\+12ab34<\/Address>/, xml);
  assert.match(xml, /<Address>1234<\/Address>/, xml);
  assert.doesNotMatch(xml, /<Address>""/, '绝不能给地址再包一层引号（CE 的 tokenize 会当成一个 token）');

  // 读回来地址逐位相同（写出的裸十六进制会被重新补上 0x）
  const back = loadCheatTable(xml, null).list;
  assert.equal(back.get(0).address, '"game.exe"+0x12ab34');
  assert.equal(back.get(1).address, '0x1234');
});

test('CT 地址语义：子项相对地址以父条目为基准（CE 的 getBaseAddress/parseAddressString）', () => {
  const proc = env.box.ctx.process;
  const base = env.box.ctx.base;
  const L = env.box.ctx.info.offsets;

  // 用一个真实存在、且父/子地址**必然不同**的偏移（health=0x0000，targetValue=0x0020）
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"父"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>0x${(base + BigInt(L.health)).toString(16)}</Address>
      <CheatEntries>
        <CheatEntry>
          <ID>2</ID>
          <Description>"子（+20）"</Description>
          <VariableType>4 Bytes</VariableType>
          <Address>+20</Address>
        </CheatEntry>
      </CheatEntries>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

  const list = loadCheatTable(xml, proc).list;
  const parent = list.get(0);
  const child = parent.children[0];
  assert.equal(parent.resolve().address, base + BigInt(L.health));
  // `+20` 是**十六进制** 0x20：父 + 0x20 = targetValue（十进制会落到 health+20 字节处）
  assert.equal(child.resolve().address, base + BigInt(L.targetValue), '子项 = 父 + 0x20');
  assert.notEqual(child.resolve().address, base + BigInt(L.health) + 20n, '不能按十进制 20');
  assert.equal(Number(child.read()), 4242, 'targetValue 处的值');

  // 父条目解析不出来时，子项必须如实报错（不能静默给一个绝对地址）
  const broken = loadCheatTable(xml.replace(/<Address>0x[0-9a-f]+<\/Address>/, '<Address>"不存在的模块.exe"+10</Address>'), proc).list;
  const brokenChild = broken.get(0).children[0];
  const ev = brokenChild.resolve();
  assert.equal(ev.address, null);
  assert.match(String(ev.error), /相对地址|父条目/, String(ev.error));
});

test('CT 地址语义：`<UserdefinedSymbols>` 载入即注册、save 时按原文保留', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <UserdefinedSymbols>
    <SymbolEntry><Name>myStat</Name><Address>0x1234</Address></SymbolEntry>
    <SymbolEntry><Name>other</Name><Address>myStat+10</Address></SymbolEntry>
  </UserdefinedSymbols>
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"引用符号"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>myStat+8</Address>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

  const { list, parsed } = loadCheatTable(xml, null);
  assert.equal(parsed.symbols.length, 2);
  // 真的注册了：大小写不敏感，且符号之间可以互相引用（`other = myStat+0x10`）
  assert.equal(list.symbols.get('myStat'), 0x1234n);
  assert.equal(list.symbols.get('mystat'), 0x1234n);
  assert.equal(list.symbols.get('other'), 0x1244n);
  assert.equal(list.resolveExpression('myStat'), 0x1234n);
  assert.equal(list.get(0).resolve().address, 0x123cn); // myStat+8 = 0x1234+0x8

  // save 必须把符号段写回去（元素形式，CE 的读端 FindNode('Name') 才认），
  // 且**原文保留**（模块相对形式换算成绝对地址会在对方重启后失效）
  const xml2 = saveCheatTable(list, { includeLastState: false });
  assert.match(xml2, /<UserdefinedSymbols>/, xml2);
  assert.match(xml2, /<Name>myStat<\/Name>/, xml2);
  assert.match(xml2, /<Address>0x1234<\/Address>/, xml2);
  assert.match(xml2, /<Name>other<\/Name>/, xml2);
  assert.match(xml2, /<Address>myStat\+10<\/Address>/, xml2);
  assert.doesNotMatch(xml2, /<SymbolEntry Name=/, '要用 CE 认的子元素形式');
  // 符号表内部一名两份（原名 + 小写名），但不能因此写出两份
  assert.equal((xml2.match(/<Name>myStat<\/Name>/g) || []).length, 1);

  // 旧版（0.1.7 及更早）写的属性形式仍要能读（向后兼容）
  const legacy = `<CheatTable CheatEngineTableVersion="46">
  <UserdefinedSymbols><SymbolEntry Name="legacy" Address="0x40"/></UserdefinedSymbols>
  <CheatEntries><CheatEntry><ID>1</ID><Description>"t"</Description><VariableType>4 Bytes</VariableType><Address>legacy</Address></CheatEntry></CheatEntries>
</CheatTable>`;
  const legacyList = loadCheatTable(legacy, null).list;
  assert.equal(legacyList.get(0).resolve().address, 0x40n, '属性形式的符号也要注册');
});

test('CT 地址语义：**没能解析**的符号也不能在 save 时被丢掉', () => {
  // 别人的表里常有引用"当前没装载的模块"的符号（游戏没开、DLL 没加载）。
  // 这种符号注册不进符号表 —— 但 save 绝不能因此把它删掉（又一处静默丢数据）。
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <UserdefinedSymbols>
    <SymbolEntry><Name>ghost</Name><Address>"没装载的模块.exe"+1000</Address></SymbolEntry>
    <SymbolEntry><Name>ok</Name><Address>0x40</Address></SymbolEntry>
  </UserdefinedSymbols>
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"t"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>ok</Address>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

  const list = loadCheatTable(xml, null).list;
  assert.equal(list.symbols.has('ghost'), false, '解析不了的符号不进符号表（宁可不解析，也不要一个静默的 0）');
  assert.equal(list.symbolSources.get('ghost'), '"没装载的模块.exe"+1000', '但原文必须留着');

  const xml2 = saveCheatTable(list, { includeLastState: false });
  assert.match(xml2, /<Name>ghost<\/Name>/, `没能解析的符号也必须写回去：\n${xml2}`);
  assert.match(xml2, /<Address>"没装载的模块\.exe"\+1000<\/Address>/, '原文形态保留');
  assert.match(xml2, /<Name>ok<\/Name>/, '能解析的符号当然也要在');
});

test('CT 地址语义：注释 / 数字实体 / CDATA 都不会破坏解析', () => {
  // 注释里出现**没闭合的 `<Address>`** 时，"正则改写 XML"的旧做法会跨过注释结尾
  // 吃掉后面真正条目的 `</Address>`、把 `-->` 转义掉 ⇒ 注释永不闭合、条目全被吞。
  // 语义下沉到 parseCheatEntry（拿到的是**已解码**文本）之后，这三类形态一次全好。
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <!-- 旧片段：<Address>game.exe+1000 到此为止 -->
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description><![CDATA["实体与 CDATA"]]></Description>
      <VariableType>4 Bytes</VariableType>
      <Address>&#48;0401000</Address>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

  const { list, parsed } = loadCheatTable(xml, null);
  assert.equal(parsed.records.length, 1, '注释不能把条目吞掉');
  assert.equal(parsed.records[0].description, '实体与 CDATA', 'CDATA 里的描述要能读出来');
  assert.equal(parsed.records[0].address, '0x401000', '数字实体解码后仍是裸数字 → 十六进制');
  assert.equal(list.get(0).resolve().address, 0x401000n);
});

/* ================================================================== *
 * 表版本 / 根级元数据：save 不能静默改写或丢弃它们
 * ================================================================== */

test('Cheat Table：写回**载入的版本号**（不再写死 46；CE 的 _CurrentTableVersion=45）', () => {
  // 查证 `ce-src/Cheat Engine/OpenSave.pas`：
  //   :24    `const _CurrentTableVersion=45;`
  //   :1218  `SetAttribute('CheatEngineTableVersion',IntToStr(CurrentTableVersion))`
  //   :401   `if (version>CurrentTableVersion) then showmessage(rsOSThereIsANewerVersion…)`
  // 所以"写死 46"有两个后果：悄悄改高别人表的版本号；CE 打开我们写出的表会弹对话框。
  const v45 = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="45">
  <CheatEntries>
    <CheatEntry><ID>1</ID><Description>"a"</Description><VariableType>4 Bytes</VariableType><Address>0x1234</Address></CheatEntry>
  </CheatEntries>
</CheatTable>`;
  const list = loadCheatTable(v45, null).list;
  assert.equal(list.version, 45, '载入时版本要存下来');
  const xml = saveCheatTable(list, { includeLastState: false });
  assert.match(xml, /CheatEngineTableVersion="45"/, `必须原样写回 45：\n${xml}`);
  assert.doesNotMatch(xml, /CheatEngineTableVersion="46"/, '不能把 45 悄悄改成 46');

  // 未指定 version 的裸数据（新建的表）也要写参照源码的当前版本，而不是 46
  assert.match(writeCheatTable(parseCheatTable(v45).records, {}), /CheatEngineTableVersion="45"/);

  // 属性**缺失**时按 45（不是 1）：CE 也只在属性存在时才覆盖 version
  // （`OpenSave.pas:397-408`），而 `lastLoadedTableVersion` 会影响
  // AutoAssembler 的老表兼容路径（`autoassembler.pas:2331`）——
  // 谎称"版本 1"会让 CE 把一张现代新表当上古表处理。
  const noAttr = '<CheatTable><CheatEntries></CheatEntries></CheatTable>';
  assert.equal(parseCheatTable(noAttr).version, 45, '缺属性时不该谎称版本 1');
  const noAttrList = loadCheatTable(noAttr, null).list;
  assert.match(saveCheatTable(noAttrList, { includeLastState: false }), /CheatEngineTableVersion="45"/);
});

test('Cheat Table：根级未建模元素与根属性必须原样保留（否则 save 一次就丢用户数据）', () => {
  const input = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="45" CustomRootAttr="keepme">
  <Comments>一段表级注释</Comments>
  <Structures>
    <Structure Name="MyStruct"><Element Type="dword" Offset="0" Name="a"/></Structure>
  </Structures>
  <LuaScript>print("hello from lua")</LuaScript>
  <CheatEntries>
    <CheatEntry><ID>1</ID><Description>"a"</Description><VariableType>4 Bytes</VariableType><Address>0x1234</Address></CheatEntry>
  </CheatEntries>
  <Forms><Form Name="f1"/></Forms>
  <Files><File Name="payload.bin"/></Files>
  <CheatCodes><CodeEntry>00401000</CodeEntry></CheatCodes>
</CheatTable>`;

  const { list, parsed } = loadCheatTable(input, null);
  assert.equal(parsed.rootName, 'CheatTable');
  assert.equal(parsed.rootAttributes.CustomRootAttr, 'keepme');

  const out = saveCheatTable(list, { includeLastState: false });
  for (const needle of [
    'CheatEngineTableVersion="45"',
    'CustomRootAttr="keepme"',
    '<Comments>',
    '一段表级注释',
    '<Structures>',
    'MyStruct',
    '<LuaScript>',
    'hello from lua',
    '<Forms>',
    '<Files>',
    '<CheatCodes>',
  ]) {
    assert.ok(out.includes(needle), `根级内容必须保留：${needle}\n${out}`);
  }
  // 相对位置也要保持：`<Forms>`/`<Files>`/`<CheatCodes>` 原本在 CheatEntries 之后
  assert.ok(
    out.indexOf('<CheatEntries>') < out.indexOf('<Forms>'),
    `<Forms> 应仍在 CheatEntries 之后：\n${out}`,
  );
  // 再读一遍仍然是同一张表（round-trip 稳定，不重复写出）
  const again = parseCheatTable(out);
  assert.equal(again.rootExtra.length, parsed.rootExtra.length, '不能越写越多');
  assert.equal(again.rootAttributes.CustomRootAttr, 'keepme');
  // 我们自己重新生成的元素不该被 rootExtra 重复写出来
  assert.equal((out.match(/<CheatEntries>/g) || []).length, 1);
  assert.equal((out.match(/<UserdefinedSymbols>/g) || []).length, 0);
});

/* ================================================================== *
 * `<Offset>` 里出现**非数字**（符号/表达式）：不能静默丢级、也不能静默算错
 * ================================================================== */

test('Cheat Table：<Offset> 非数字时**保留这一级**并如实报错（CE 的 setOffsetText/getOffset）', () => {
  // CE 允许偏移写成符号/表达式：`MemoryRecordUnit.pas:631-696` 的 setOffsetText 会依次
  // 尝试十六进制 → getAddressFromNameShallow（符号）→ Lua → getAddressFromName；
  // 全都失败时置 finvalid，而 `GetRealAddress`（:3683-3691）把整条标成
  // UnreadablePointer、地址归零 —— **链长一级都不少**。
  // 早先本移植用 `.filter(v => !Number.isNaN(v))` 把解析不了的偏移**静默丢掉**：
  // `[10, zz]` 变成 `[16]`（少一级、地址错、无报错）、只有 `zz` 时 `offsets` 变 undefined
  // （条目从"指针"退化成"普通地址"）。
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"含垃圾偏移"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>0x1000</Address>
      <Offsets>
        <Offset>10</Offset>
        <Offset>zz</Offset>
      </Offsets>
    </CheatEntry>
    <CheatEntry>
      <ID>2</ID>
      <Description>"唯一偏移是符号"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>0x1000</Address>
      <Offsets>
        <Offset>mySym+10</Offset>
      </Offsets>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

  const parsed = parseCheatTable(xml);
  assert.deepEqual(parsed.records[0].offsets, [0x10, 0], '链长必须是 2 级（占位 0），不是被截成 1 级');
  assert.deepEqual(parsed.records[0].offsetExpressions, { 1: 'zz' });
  assert.deepEqual(parsed.records[1].offsets, [0], '唯一偏移是符号时也不能退化成"不是指针"');
  assert.deepEqual(parsed.records[1].offsetExpressions, { 0: 'mySym+0x10' }, '偏移里的裸数字同样按 .CT 语义（十六进制）');

  // 写回必须**按原文**（写 0 就等于把用户的符号偏移静默改成 0）
  const out = writeCheatTable(parsed.records, {});
  assert.match(out, /<Offset>10<\/Offset>/, out);
  assert.match(out, /<Offset>zz<\/Offset>/, out);
  assert.match(out, /<Offset>mySym\+10<\/Offset>/, `表达式中间的 0x 必须去掉：\n${out}`);
  assert.doesNotMatch(out, /<Offset>mySym\+0x10<\/Offset>/, 'CE 认不了表达式中间的 0x');
});

test('Cheat Table：符号当偏移**真的可用**；解析不出来时不给假地址', () => {
  const proc = env.box.ctx.process;
  const base = env.box.ctx.base;
  const L = env.box.ctx.info.offsets;

  // 夹具：chainA 存 chainB 的地址、chainB 存 targetValue 的地址。
  // 偏移写成符号 `zero`（= 0）时，行为必须与写 `<Offset>0</Offset>` 完全一致。
  const make = (offsetText) => `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <UserdefinedSymbols>
    <SymbolEntry><Name>zero</Name><Address>0</Address></SymbolEntry>
  </UserdefinedSymbols>
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"符号偏移"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>0x${(base + BigInt(L.chainA)).toString(16)}</Address>
      <Offsets>
        <Offset>${offsetText}</Offset>
        <Offset>${offsetText}</Offset>
      </Offsets>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

  const ok = loadCheatTable(make('zero'), proc).list;
  assert.equal(ok.get(0).resolve().address, base + BigInt(L.targetValue), '符号偏移应解析成 0');
  assert.equal(Number(ok.get(0).read()), 4242);

  // 解析不出来的符号/表达式：地址为 null + 明确原因，**绝不是**"少了这一级"的错误地址
  const bad = loadCheatTable(make('zz'), proc).list;
  assert.equal(bad.get(0).offsets.length, 2, '链长必须保住');
  const ev = bad.get(0).resolve();
  assert.equal(ev.address, null, '不能给出一个静默错误的地址');
  assert.match(String(ev.error), /zz/, `错误里要指出是哪一级、原文是什么：${ev.error}`);
});

/* ================================================================== *
 * 合法空表 vs 不是 .CT：parseCheatTable.rootName 让调用方能区分
 * ================================================================== */

test('Cheat Table：rootName 能区分「合法空表」与「不是 .CT」', () => {
  // 插件据此给出**如实**的错误信息（早先两种情况共用一句"它不像是一个 .CT"）。
  assert.equal(
    parseCheatTable('<CheatTable CheatEngineTableVersion="46"><CheatEntries></CheatEntries></CheatTable>').rootName,
    'CheatTable',
  );
  assert.equal(parseCheatTable('<CheatTable/>').rootName, 'CheatTable');
  assert.equal(parseCheatTable('').rootName, '#root', '空文件不是 .CT');
  assert.equal(parseCheatTable('not xml at all').rootName, '#root', '非 XML 不是 .CT');
  // 有别的 XML 根但里面**找不到** CheatTable 时，rootName 是合成的 `#root`（不是 `CheatTable`）
  assert.notEqual(parseCheatTable('<?xml version="1.0"?><Other><A/></Other>').rootName, 'CheatTable');
  // 合法空表：解析出来 0 条记录，但 rootName 说明它确实是 .CT
  assert.equal(parseCheatTable('<CheatTable><CheatEntries></CheatEntries></CheatTable>').records.length, 0);
});

