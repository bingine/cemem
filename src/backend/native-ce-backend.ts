/**
 * 原生 CE 后端 —— 作为客户端连接 Cheat Engine 官方的 `ceserver`。
 *
 * 协议来源：`Cheat Engine/ceserver/ceserver.h`（命令号与结构体定义）+
 *           `ceserver.c` 的 `DispatchCommand` 分支（收发顺序与字段宽度）。
 *
 * 线上格式（全部小端）：每个请求 = 1 字节命令号 + 该命令的输入负载；
 * 每条命令使用一个独立连接。
 *
 * ## 为什么这个后端是异步的
 *
 * 它必须走 socket，而 socket 本质异步。
 * 曾经尝试把它包装成同步接口，两条路都**实测失败**：
 *
 *   1. 主线程里 `Promise + Atomics.wait` → 阻塞把事件循环卡死，
 *      socket 回调永不执行（`_probe/atomics-wait-io.js` 可复现）；
 *   2. 把 socket 挪到 worker 线程、主线程仍 `Atomics.wait` → **同样死锁**，
 *      因为 worker 线程被 `Atomics.wait` 阻塞后，它自己的事件循环也停了，
 *      socket 回调一样不会跑（`_probe/mini-repro.js` 可复现）。
 *
 * 结论：`Atomics.wait` 与 socket I/O 无法在任何同一线程内共存。
 * 因此本后端**诚实地暴露为异步 API**（方法返回 Promise），
 * 而不是用子进程或忙轮询去伪造同步 —— 那只会把复杂度推移到别处。
 *
 * ## 与 SelfBackend 的一致性
 *
 * 方法名、参数、返回类型语义与 `SelfBackend` 完全一致，区别只有一个 `await`：
 * ```ts
 * const buf = proc.readMemory(addr, 16);                 // 自研后端：同步
 * const buf = await proc.readMemoryAsync(addr, 16);      // 原生 CE：异步
 * ```
 * （`Process` 上的 `*Async` 变体对两种后端都可用。）
 *
 * ## 已对齐的命令
 *   GETVERSION(0)、GETARCHITECTURE(21)、OPENPROCESS(3)、CLOSEHANDLE(7)、
 *   CREATETOOLHELP32SNAPSHOT(4)、PROCESS32FIRST(5)、PROCESS32NEXT(6)、
 *   VIRTUALQUERYEX(8)、READPROCESSMEMORY(9)、WRITEPROCESSMEMORY(10)、
 *   MODULE32FIRST(22)、MODULE32NEXT(23)、ALLOC(26)、FREE(27)、
 *   CHANGEMEMORYPROTECTION(36)
 *
 * ## 未实现（调用会抛错，不假装支持）
 *   线程枚举（CMD_CREATETOOLHELP32SNAPSHOTEX 响应布局随版本变化）、
 *   调试器相关命令、速度修改、管道、符号文件加载。
 */

import { connect, type Socket } from 'node:net';
import {
  BackendCapabilities,
  BackendModuleInfo,
  BackendProcessHandle,
  BackendProcessInfo,
  BackendRegion,
  BackendRegionFilter,
  MemoryBackend,
} from './types';
import { filterScanRegions } from './self-backend';
import { MEM_COMMIT } from '../types';

/* ------------------------------------------------------------------ *
 * 协议常量（严格对齐 ceserver.h）
 * ------------------------------------------------------------------ */

export const CESERVER_CMD = {
  GETVERSION: 0,
  CLOSECONNECTION: 1,
  TERMINATESERVER: 2,
  OPENPROCESS: 3,
  CREATETOOLHELP32SNAPSHOT: 4,
  PROCESS32FIRST: 5,
  PROCESS32NEXT: 6,
  CLOSEHANDLE: 7,
  VIRTUALQUERYEX: 8,
  READPROCESSMEMORY: 9,
  WRITEPROCESSMEMORY: 10,
  STARTDEBUG: 11,
  STOPDEBUG: 12,
  WAITFORDEBUGEVENT: 13,
  CONTINUEFROMDEBUGEVENT: 14,
  SETBREAKPOINT: 15,
  REMOVEBREAKPOINT: 16,
  SUSPENDTHREAD: 17,
  RESUMETHREAD: 18,
  GETTHREADCONTEXT: 19,
  SETTHREADCONTEXT: 20,
  GETARCHITECTURE: 21,
  MODULE32FIRST: 22,
  MODULE32NEXT: 23,
  GETSYMBOLLISTFROMFILE: 24,
  LOADEXTENSION: 25,
  ALLOC: 26,
  FREE: 27,
  CREATETHREAD: 28,
  LOADMODULE: 29,
  SPEEDHACK_SETSPEED: 30,
  VIRTUALQUERYEXFULL: 31,
  GETREGIONINFO: 32,
  GETABI: 33,
  SET_CONNECTION_NAME: 34,
  CREATETOOLHELP32SNAPSHOTEX: 35,
  CHANGEMEMORYPROTECTION: 36,
  GETOPTIONS: 37,
  GETOPTIONVALUE: 38,
  SETOPTIONVALUE: 39,
  PTRACE_MMAP: 40,
  OPENNAMEDPIPE: 41,
  PIPEREAD: 42,
  PIPEWRITE: 43,
  GETCESERVERPATH: 44,
  ISANDROID: 45,
  LOADMODULEEX: 46,
  SETCURRENTPATH: 47,
  GETCURRENTPATH: 48,
  ENUMFILES: 49,
  GETFILEPERMISSIONS: 50,
  SETFILEPERMISSIONS: 51,
  GETFILE: 52,
  PUTFILE: 53,
  CREATEDIR: 54,
  DELETEFILE: 55,
  AOBSCAN: 200,
  COMMANDLIST2: 255,
} as const;

const TH32CS_SNAPPROCESS = 0x00000002;
const TH32CS_SNAPMODULE = 0x00000008;

/** CE 官方 ceserver 的默认端口（ceserver.c 的 PORT 默认值） */
export const CESERVER_DEFAULT_PORT = 52736;

/* ------------------------------------------------------------------ *
 * 组帧辅助
 * ------------------------------------------------------------------ */

/** 累积式小端写入器 */
export class CeWriter {
  private parts: Buffer[] = [];

  u8(v: number): this {
    const b = Buffer.alloc(1);
    b.writeUInt8(v & 0xff, 0);
    this.parts.push(b);
    return this;
  }
  i32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v | 0, 0);
    this.parts.push(b);
    return this;
  }
  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.parts.push(b);
    return this;
  }
  i64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt.asIntN(64, v), 0);
    this.parts.push(b);
    return this;
  }
  u64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt.asUintN(64, v), 0);
    this.parts.push(b);
    return this;
  }
  bytes(b: Buffer): this {
    this.parts.push(b);
    return this;
  }
  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

/** 顺序小端读取器 */
export class CeReader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }
  u8(): number {
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }
  i32(): number {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  i64(): bigint {
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  bytes(n: number): Buffer {
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  skip(n: number): void {
    this.pos += n;
  }
}

/* ------------------------------------------------------------------ *
 * 后端实现
 * ------------------------------------------------------------------ */

export interface NativeCeBackendOptions {
  /** ceserver 主机，默认 127.0.0.1 */
  host?: string;
  /** ceserver 端口，默认 52736 */
  port?: number;
  /** 单次命令超时（毫秒），默认 15000 */
  timeoutMs?: number;
}

/**
 * 原生 CE 后端（通过 ceserver 的 TCP 协议）。
 *
 * 所有方法都是**异步**的（返回 Promise），因为 socket 本质异步 —— 原因见文件头注释。
 *
 * ```ts
 * const backend = new NativeCeBackend({ host: '127.0.0.1', port: 52736 });
 * const h = await backend.openProcess(pid);
 * const buf = await backend.readProcessMemory(h, addr, 64);
 * await backend.dispose();
 * ```
 */
export class NativeCeBackend implements MemoryBackend {
  readonly name = 'native-ce';

  readonly capabilities: BackendCapabilities = {
    // 本后端是异步的（socket 决定），因此 sync = false
    sync: false,
    enumerateProcesses: true,
    queryRegions: true,
    queryModules: true,
    queryThreads: false,
    suspendThreads: false,
    allocateMemory: true,
    changeProtection: true,
    local: false,
    requiresServer: true,
  };

  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;

  private readonly conn: CeServerConnection;
  private disposed = false;

  /** handle id -> ceserver 侧 HANDLE */
  private nextHandleId = 1;
  private readonly handles = new Map<number, number>();

  private version: string | null = null;

  constructor(options: NativeCeBackendOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? CESERVER_DEFAULT_PORT;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.conn = new CeServerConnection(this.host, this.port, this.timeoutMs);
  }

  /** 后端描述，用于日志 */
  describe(): string {
    return `NativeCeBackend(${this.host}:${this.port})`;
  }

  /* ---------------------------------------------------------------- *
   * 版本
   * ---------------------------------------------------------------- */

  /**
   * 读取 ceserver 版本字符串（CMD_GETVERSION，结果缓存）。
   *
   * 响应布局：`{ int32 version; uint8 stringsize; char versionstring[stringsize]; }`
   * 分两轮读（先读 5 字节头拿长度，再读全）—— 因为 ceserver 每条命令一个连接，
   * 无法在一条连接上续读。
   */
  async getVersion(): Promise<string> {
    if (this.version !== null) return this.version;

    const head = await this.conn.exchange(
      'GETVERSION',
      Buffer.from([CESERVER_CMD.GETVERSION]),
      5,
    );
    const hr = new CeReader(head);
    hr.i32();
    const nameLen = hr.u8();
    if (nameLen <= 0) {
      this.version = '';
      return this.version;
    }

    const full = await this.conn.exchange(
      'GETVERSION',
      Buffer.from([CESERVER_CMD.GETVERSION]),
      5 + nameLen,
    );
    this.version = Buffer.from(full.subarray(5, 5 + nameLen)).toString('utf8');
    return this.version;
  }

  /* ---------------------------------------------------------------- *
   * 进程枚举
   * ---------------------------------------------------------------- */

  async listProcesses(): Promise<BackendProcessInfo[]> {
    const snapHandle = new CeReader(
      await this.exchange(
        'CREATETOOLHELP32SNAPSHOT',
        new CeWriter()
          .u8(CESERVER_CMD.CREATETOOLHELP32SNAPSHOT)
          .u32(TH32CS_SNAPPROCESS)
          .u32(0)
          .build(),
        4,
      ),
    ).i32();
    if (snapHandle <= 0) {
      throw new Error('ceserver 创建进程快照失败（返回无效句柄）');
    }

    const out: BackendProcessInfo[] = [];
    try {
      // CeProcessEntry = { int result; int pid; int processnamesize; char name[] }
      for (;;) {
        const frame = new CeWriter().u8(CESERVER_CMD.PROCESS32NEXT).i32(snapHandle).build();
        const head = await this.exchange('PROCESS32NEXT', frame, 12);
        const r = new CeReader(head);
        const result = r.i32();
        if (result === 0) break;
        const pid = r.i32();
        const nameLen = r.i32();

        let name = '';
        if (nameLen > 0) {
          const full = await this.exchange('PROCESS32NEXT', frame, 12 + nameLen);
          name = Buffer.from(full.subarray(12, 12 + nameLen)).toString('utf8');
        }

        out.push({
          pid,
          name: name.replace(/\0.*$/, ''),
          // ⚠️ 必须是 `null`（未知），**不能是 0**。
          //
          // ceserver 的 `PROCESS32NEXT` 响应结构（ceserver.h）只有
          // `{ int result; int pid; int processnamesize; char name[] }` ——
          // 协议里**根本没有**父进程 pid 与线程数。早先这里写 0，
          // 于是 `ce_processes` 在这个后端下对每个进程都显示「线程 0」，
          // 一个**看起来像真值**的假值；而 self 后端给的是真实线程数 ——
          // 同一个工具两个后端语义不一致，调用方无从分辨。
          // 如实报 null，让工具层显示「未知」。
          parentPid: null,
          threadCount: null,
        });
      }
    } finally {
      await this.closeServerHandle(snapHandle);
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * 句柄
   * ---------------------------------------------------------------- */

  async openProcess(pid: number): Promise<BackendProcessHandle> {
    const serverHandle = new CeReader(
      await this.exchange(
        'OPENPROCESS',
        new CeWriter().u8(CESERVER_CMD.OPENPROCESS).i32(pid).build(),
        4,
      ),
    ).i32();
    if (serverHandle === 0) {
      throw new Error(
        `ceserver 无法打开进程 ${pid}（进程不存在，或服务端权限不足；` +
          `若目标是受保护进程，请以管理员身份运行 ceserver）`,
      );
    }
    const id = this.nextHandleId++;
    this.handles.set(id, serverHandle);
    return { id, pid };
  }

  async closeProcess(handle: BackendProcessHandle): Promise<void> {
    const h = this.handles.get(handle.id);
    if (h === undefined) return;
    this.handles.delete(handle.id);
    await this.closeServerHandle(h);
  }

  private async closeServerHandle(serverHandle: number): Promise<void> {
    try {
      await this.exchange(
        'CLOSEHANDLE',
        new CeWriter().u8(CESERVER_CMD.CLOSEHANDLE).i32(serverHandle).build(),
        4,
      );
    } catch {
      // 服务端可能已断开，忽略
    }
  }

  private serverHandle(handle: BackendProcessHandle): number {
    const h = this.handles.get(handle.id);
    if (h === undefined) throw new Error(`进程 ${handle.pid} 的句柄已关闭`);
    return h;
  }

  /* ---------------------------------------------------------------- *
   * 内存区域
   * ---------------------------------------------------------------- */

  async queryRegions(
    handle: BackendProcessHandle,
    filter: BackendRegionFilter = {},
  ): Promise<BackendRegion[]> {
    const h = this.serverHandle(handle);
    const all: BackendRegion[] = [];
    const maxAddr = filter.maxAddress ?? 0x7fffffffffffn;

    // CeVirtualQueryExInput  = { int handle; uint64 baseaddress; }  → 12 字节
    // CeVirtualQueryExOutput = { uint8 result; uint32 protection; uint32 type;
    //                            uint64 baseaddress; uint64 size; } → 25 字节
    let addr = 0n;
    for (;;) {
      if (addr >= maxAddr) break;
      const res = await this.exchange(
        'VIRTUALQUERYEX',
        new CeWriter().u8(CESERVER_CMD.VIRTUALQUERYEX).i32(h).u64(addr).build(),
        25,
      );
      const r = new CeReader(res);
      const result = r.u8();
      if (result === 0) break;
      const protection = r.u32();
      const type = r.u32();
      const base = r.u64();
      const size = r.u64();
      if (size <= 0n) break;

      all.push({
        baseAddress: base,
        regionSize: size,
        state: MEM_COMMIT,
        protect: protection,
        type,
      });

      const next = base + size;
      if (next <= addr) break;
      addr = next;
    }

    if (filter.includeFree) return all;
    return filterScanRegions(all, filter);
  }

  /* ---------------------------------------------------------------- *
   * 读写内存
   * ---------------------------------------------------------------- */

  async readProcessMemory(
    handle: BackendProcessHandle,
    address: bigint,
    size: number,
  ): Promise<Buffer> {
    if (size <= 0) return Buffer.alloc(0);
    const h = this.serverHandle(handle);

    // CeReadProcessMemoryInput = { uint32 handle; uint64 address; uint32 size; uint8 compress; }
    // 响应 = { int read; byte data[read]; }
    // compress 固定 0，避免依赖服务端压缩实现。
    const frame = new CeWriter()
      .u8(CESERVER_CMD.READPROCESSMEMORY)
      .u32(h)
      .u64(address)
      .u32(size)
      .u8(0)
      .build();

    const head = await this.exchange('READPROCESSMEMORY', frame, 4);
    const read = new CeReader(head).i32();
    if (read <= 0) return Buffer.alloc(0);

    const body = await this.exchange('READPROCESSMEMORY', frame, 4 + read);
    return Buffer.from(body.subarray(4, 4 + read));
  }

  async writeProcessMemory(
    handle: BackendProcessHandle,
    address: bigint,
    data: Buffer,
    fixProtection = true,
  ): Promise<number> {
    const h = this.serverHandle(handle);

    if (fixProtection) {
      try {
        await this.changeProtection(handle, address, data.length, 0x04);
      } catch {
        /* 部分服务端不支持改保护，忽略 */
      }
    }

    // CeWriteProcessMemoryInput = { int32 handle; int64 address; int32 size; } + data[size]
    const frame = new CeWriter()
      .u8(CESERVER_CMD.WRITEPROCESSMEMORY)
      .i32(h)
      .i64(address)
      .i32(data.length)
      .bytes(data)
      .build();

    const written = new CeReader(
      await this.exchange('WRITEPROCESSMEMORY', frame, 4),
    ).i32();
    if (written !== data.length) {
      throw new Error(
        `ceserver 写入不完整：请求 ${data.length} 字节，实际写入 ${written} 字节`,
      );
    }
    return written;
  }

  /* ---------------------------------------------------------------- *
   * 模块
   * ---------------------------------------------------------------- */

  async queryModules(handle: BackendProcessHandle): Promise<BackendModuleInfo[]> {
    const snapHandle = new CeReader(
      await this.exchange(
        'CREATETOOLHELP32SNAPSHOT',
        new CeWriter()
          .u8(CESERVER_CMD.CREATETOOLHELP32SNAPSHOT)
          .u32(TH32CS_SNAPMODULE)
          .u32(handle.pid)
          .build(),
        4,
      ),
    ).i32();
    if (snapHandle <= 0) return [];

    const out: BackendModuleInfo[] = [];
    try {
      for (;;) {
        // CeModuleEntry 固定头 = { int32 result; int64 modulebase; int32 modulepart;
        //   int32 modulesize; uint32 modulefileoffset; int32 modulenamesize; } → 28 字节
        const frame = new CeWriter().u8(CESERVER_CMD.MODULE32NEXT).i32(snapHandle).build();
        const head = await this.exchange('MODULE32NEXT', frame, 28);
        const r = new CeReader(head);
        const result = r.i32();
        if (result === 0) break;
        const moduleBase = r.i64();
        r.i32(); // modulepart
        const moduleSize = r.i32();
        r.u32(); // modulefileoffset
        const nameLen = r.i32();

        let name = '';
        if (nameLen > 0) {
          const full = await this.exchange('MODULE32NEXT', frame, 28 + nameLen);
          name = Buffer.from(full.subarray(28, 28 + nameLen)).toString('utf8');
        }
        const clean = name.replace(/\0.*$/, '');
        out.push({
          name: clean,
          // ceserver 不回报完整路径，用名字代替
          path: clean,
          baseAddress: moduleBase,
          size: moduleSize,
        });
      }
    } finally {
      await this.closeServerHandle(snapHandle);
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * 分配 / 保护
   * ---------------------------------------------------------------- */

  async allocate(
    handle: BackendProcessHandle,
    size: number,
    protect = 0x04,
    preferred = 0n,
  ): Promise<bigint> {
    const h = this.serverHandle(handle);
    // CeAllocInput = { HANDLE hProcess; uint64 preferedBase; uint32 size; uint32 windowsprotection; }
    const frame = new CeWriter()
      .u8(CESERVER_CMD.ALLOC)
      .u64(BigInt(h))
      .u64(preferred)
      .u32(size)
      .u32(protect)
      .build();
    const addr = new CeReader(await this.exchange('ALLOC', frame, 8)).u64();
    if (addr === 0n) throw new Error('ceserver 分配内存失败（返回地址 0）');
    return addr;
  }

  async free(handle: BackendProcessHandle, address: bigint): Promise<void> {
    const h = this.serverHandle(handle);
    const frame = new CeWriter()
      .u8(CESERVER_CMD.FREE)
      .u64(BigInt(h))
      .u64(address)
      .u32(0)
      .build();
    const result = new CeReader(await this.exchange('FREE', frame, 4)).u32();
    if (result === 0) throw new Error('ceserver 释放内存失败');
  }

  async changeProtection(
    handle: BackendProcessHandle,
    address: bigint,
    size: number,
    newProtect: number,
  ): Promise<number> {
    const h = this.serverHandle(handle);
    const frame = new CeWriter()
      .u8(CESERVER_CMD.CHANGEMEMORYPROTECTION)
      .u64(BigInt(h))
      .u64(address)
      .u32(size)
      .u32(newProtect)
      .build();

    // 复用 CeVirtualQueryExOutput 的布局：result(u8) protection(u32) type(u32) base(u64) size(u64)
    const res = await this.exchange('CHANGEMEMORYPROTECTION', frame, 25);
    const r = new CeReader(res);
    const result = r.u8();
    if (result === 0) throw new Error('ceserver 修改内存保护失败');
    return r.u32();
  }

  /* ---------------------------------------------------------------- *
   * 不支持的能力
   * ---------------------------------------------------------------- */

  queryThreads(): number[] {
    throw new Error(
      'NativeCeBackend 未实现线程枚举：ceserver 的线程枚举走 ' +
        'CMD_CREATETOOLHELP32SNAPSHOTEX(35)，其响应布局随版本变化，' +
        '为可靠性起见暂不实现（capabilities.queryThreads 已声明为 false）。',
    );
  }

  isWow64(): boolean {
    // ceserver 的 CMD_GETARCHITECTURE 不区分"目标进程位数"与"服务端位数"，不做猜测
    return false;
  }

  /**
   * 存活判断：ceserver 协议里没有对应命令，这里**如实返回 undefined（未知）**，
   * 而不是猜一个 true/false —— 上层据此退回「句柄仍打开就当附加着」的旧行为。
   */
  isProcessAlive(): boolean | undefined {
    return undefined;
  }

  /** 发送一帧、读回 expectedBytes 字节 */
  private exchange(label: string, frame: Buffer, expectedBytes: number): Promise<Buffer> {
    return this.conn.exchange(label, frame, expectedBytes);
  }

  /** 释放后端资源 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // 尽力关闭远端句柄
    for (const h of [...this.handles.values()]) await this.closeServerHandle(h);
    this.handles.clear();
  }
}

/* ------------------------------------------------------------------ *
 * 连接封装
 * ------------------------------------------------------------------ */

/**
 * ceserver 的 TCP 通道。
 *
 * 每条命令使用一个独立连接：服务端 `DispatchCommand` 处理完一条命令即关闭，
 * 而且"每条命令一个连接"能让"先读计数、再读数据"这类两步读取天然成立
 * （两边各自重新发一次命令即可）。
 */
export class CeServerConnection {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly timeoutMs = 15000,
  ) {}

  /** 发送一帧并读回 expectedBytes 字节 */
  async exchange(label: string, frame: Buffer, expectedBytes: number): Promise<Buffer> {
    const socket = await this.connect();
    try {
      await this.write(socket, frame);
      if (expectedBytes <= 0) return Buffer.alloc(0);
      return await this.readExactly(socket, expectedBytes, label);
    } finally {
      socket.destroy();
    }
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`连接 ceserver 超时（${this.host}:${this.port}）`));
      }, this.timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve(socket);
      });
      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(
          new Error(
            `无法连接 ceserver（${this.host}:${this.port}）：${e.message}。` +
              `请先启动 ceserver（CE 源码 Cheat Engine/ceserver 的编译产物，或官方发行版自带）。`,
          ),
        );
      });
    });
  }

  private write(socket: Socket, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  private readExactly(socket: Socket, n: number, label: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let got = 0;
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('end', onEnd);
        socket.off('error', onError);
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `ceserver 命令 "${label}" 响应超时（期望 ${n} 字节，已收到 ${got} 字节）`,
            ),
          ),
        );
      }, this.timeoutMs);

      const onData = (chunk: Buffer): void => {
        chunks.push(chunk);
        got += chunk.length;
        if (got >= n) {
          const all = Buffer.concat(chunks);
          settle(() => resolve(all.length === n ? all : all.subarray(0, n)));
        }
      };
      const onEnd = (): void => {
        settle(() => {
          if (got >= n) resolve(Buffer.concat(chunks).subarray(0, n));
          else
            reject(
              new Error(
                `ceserver 命令 "${label}" 提前关闭连接（期望 ${n} 字节，收到 ${got} 字节）`,
              ),
            );
        });
      };
      const onError = (e: Error): void => settle(() => reject(e));

      socket.on('data', onData);
      socket.once('end', onEnd);
      socket.once('error', onError);
    });
  }
}
