/**
 * 指针扫描 —— 对齐 Cheat Engine `pointerscancontroller.pas` / `pointerscanstructures.pas`。
 *
 * 目标：找出 "基址 + 多级偏移" 表达式，使得
 *   `[ [ [base + off[N]] + off[N-1] ] ... + off[1] ] == targetAddress`
 *
 * CE 的做法分两步（本实现一致）：
 *  1. 建立**指针映射**（pointermap）：遍历目标进程所有可扫描段，
 *     把每个"看起来像指针"的槽位记为 (存放地址 storeAddr, 指向值 ptrValue)。
 *     只收对齐槽位，且 ptrValue 必须落在某个已提交区域内（否则不可能是有效指针）。
 *  2. **逐级回溯**：第 0 级的"待匹配地址集合"只有 targetAddress。
 *     对每一级，在指针映射里找那些 ptrValue ∈ 当前集合的槽位；
 *     于是 storeAddr 成为上一级的待匹配地址，偏移 = 当前地址 − ptrValue。
 *     重复 maxLevel 次，得到 基址 → 偏移链。
 *     最后按 maxOffset / maxDifferentOffsets / 是否允许负偏移做剪枝。
 *
 * 与 CE 的差异：
 *   - CE 把指针映射缓存为 .scandata 二进制文件（PSCAN 格式）可跨会话复用；
 *     本实现提供内存缓存，并支持导出为 JSON（格式见 docs/pscan-format.md），
 *     与 CE 的二进制格式不兼容。
 *   - CE 的 "Only find static addresses" 用模块列表判定；这里用 MEM_IMAGE 判定。
 */

import { Process, isReadable } from '../win/process';
import { MEM_IMAGE, PAGE_GUARD } from '../types';

/** 一条指针扫描结果：基址 + 偏移链 */
export interface PointerPath {
  /** 基址（第 maxLevel 级的存放地址，通常落在模块的静态区） */
  baseAddress: bigint;
  /**
   * 偏移链，按"从基址到目标"的顺序排列。
   * 应用方式：addr = base; for (const o of offsets) { addr = readPtr(addr) + o } —— 见 applyPointerPath。
   */
  offsets: number[];
  /** 该路径最终指向的地址（等于扫描时的 targetAddress） */
  targetAddress: bigint;
  /**
   * 该路径的层数（偏移链长度）。
   *
   * 仅在 `preferShallow: true` 时填充 —— 那种模式下会汇总多个层级的路径，
   * 调用方需要知道每条的层数才能做排序与展示。默认的单深度模式不填（保持原形状）。
   */
  depth?: number;
}

export interface PointerScanOptions {
  /** 最大层级（偏移个数）。CE 默认 5。 */
  maxLevel?: number;
  /** 单级偏移的最大绝对值。CE 默认 2048。 */
  maxOffset?: number;
  /**
   * 汇总"层数 ≤ maxLevel"的**全部**路径，而不是只返回恰好等于 maxLevel 的。
   *
   * 为什么需要：只返回精确深度的路径时，调用方为了拿到那条又浅又稳的路径，
   * 只能逐级重扫（慢），而且深层候选一多，浅层路径会被结果上限挤掉。
   * 打开这个开关后一次扫描就拿到全部层级，并按「静态基址优先、层数浅优先」排序，
   * 再由 maxResults 截断 —— 这正是 CE 指针扫描的实际语义。
   *
   * 打开时每条结果的 `depth` 会被填充。默认 false（保持原行为）。
   */
  preferShallow?: boolean;
  /** 每个存放地址允许的最大不同偏移数量（0 = 不限制）。 */
  maxDifferentOffsets?: number;
  /** 是否允许负偏移 */
  allowNegativeOffsets?: boolean;
  /** 是否只保留最终基址位于静态区（可执行映像）的路径 */
  staticOnly?: boolean;
  /** 指针宽度：4 或 8。默认按目标进程位数推断。 */
  pointerSize?: 4 | 8;
  /** 需要跳过的段（例如已知的栈区），避免噪声 */
  excludeSegments?: Array<{ start: bigint; end: bigint }>;
  /** 最多返回多少条路径（0 = 不限制）。默认 0。 */
  maxResults?: number;
  /** 最多处理多少个段（防护，0 = 不限制） */
  maxSegments?: number;
  /** 进度回调 */
  onProgress?: (stage: string, current: number, total: number) => void;
}

export interface PointerScanStats {
  /** 建档的段数 */
  segmentsScanned: number;
  /** 建档读取的字节数 */
  bytesIndexed: bigint;
  /** 指针映射条目数 */
  pointerEntries: number;
  /** 每一级找到的候选数量 */
  levelCounts: number[];
  elapsedMs: number;
  /** 最终返回的路径数（**已通过可解析性验证**） */
  resultCount: number;
  /**
   * 因**无法解析**（中间指针读不通，或解析结果不等于目标地址）而被丢弃的
   * 候选数量。见 `scan()` 里"返回值验证"那段的说明。
   *
   * 这个数字有意义：目标进程的动态内存越多（例如 V8 堆），按值匹配产生的
   * "值巧合"候选就越多，丢弃量也越大。数量异常大时说明结果被环境噪声稀释。
   */
  droppedUnresolvable: number;
  /**
   * **通过验证的候选总数**（尚未按 `maxResults` 截断）。
   *
   * 与 `resultCount` 的区别：`resultCount` 是最终返回的条数（已受上限约束），
   * 而它是在上限之外还剩多少可用路径。`candidateCount > resultCount`
   * 即说明**结果触及了上限**、可能有更多路径没返回 ——
   * 调用方据此决定是否提示用户调大 `maxResults`。
   */
  candidateCount: number;
}

/** 指针映射中的一个条目 */
interface PointerEntry {
  /** 存放地址 */
  store: bigint;
  /** 该处存放的指针值 */
  value: bigint;
}

/** 指针映射：按 value 排序，便于二分查找"哪些槽位指向给定地址" */
interface PointerMap {
  /** 按 value 升序排列的条目 */
  entries: PointerEntry[];
  /** 升序的 value 数组（与 entries 平行，便于二分） */
  sortedValues: BigUint64Array;
  /** 与实际 value 顺序对应的条目下标 */
  order: Uint32Array;
}

/** 一条中间路径（回溯过程中不断在头部补偏移） */
interface PartialPath {
  /** 当前层级的地址（下一轮要在指针映射里找"谁指向它"） */
  address: bigint;
  /** 已确定的偏移链（从基址到目标方向，越靠前越接近基址） */
  offsets: number[];
}

/**
 * 指针扫描器。
 *
 * ```ts
 * const ps = new PointerScanner(proc, { maxLevel: 5, maxOffset: 2048 });
 * const paths = ps.scan(targetAddress);
 * for (const p of paths) console.log(formatPointerPath(p));
 * ```
 */
export class PointerScanner {
  private readonly proc: Process;
  private readonly opts: Required<
    Pick<PointerScanOptions, 'maxLevel' | 'maxOffset' | 'maxDifferentOffsets' | 'allowNegativeOffsets' | 'staticOnly' | 'pointerSize' | 'maxResults' | 'maxSegments'>
  > &
    PointerScanOptions;

  /** 缓存的指针映射（同一进程可复用） */
  private pointerMap: PointerMap | null = null;
  /** 记录静态区范围，用于 staticOnly 判定 */
  private staticRanges: Array<{ start: bigint; end: bigint }> = [];
  /** 已提交区域范围（升序），用于判定某值是否可能是有效指针 */
  private committedRanges: Array<{ start: bigint; end: bigint }> = [];
  private lastStats: PointerScanStats | null = null;

  constructor(process: Process, options: PointerScanOptions = {}) {
    if (!process.isOpen) throw new Error('指针扫描需要一个已打开的进程');
    this.proc = process;
    const pointerSize = options.pointerSize ?? (process.isWow64() ? 4 : 8);
    this.opts = {
      ...options,
      maxLevel: options.maxLevel ?? 5,
      maxOffset: options.maxOffset ?? 2048,
      preferShallow: options.preferShallow === true,
      maxDifferentOffsets: options.maxDifferentOffsets ?? 0,
      allowNegativeOffsets: options.allowNegativeOffsets === true,
      staticOnly: options.staticOnly === true,
      pointerSize,
      maxResults: options.maxResults ?? 0,
      maxSegments: options.maxSegments ?? 0,
    };
    if (this.opts.maxLevel < 1) throw new RangeError('maxLevel 必须 ≥ 1');
    if (this.opts.maxOffset < 0) throw new RangeError('maxOffset 不能为负');
  }

  get stats(): PointerScanStats | null {
    return this.lastStats;
  }

  /** 指针映射是否已建好（可跳过一次全量建档）。 */
  get hasPointerMap(): boolean {
    return this.pointerMap !== null;
  }

  /** 丢弃已建好的指针映射。 */
  clearPointerMap(): void {
    this.pointerMap = null;
  }

  /** 执行指针扫描。 */
  scan(targetAddress: bigint): PointerPath[] {
    const started = Date.now();
    const map = this.ensurePointerMap();

    const levelCounts: number[] = [];
    // 第 0 级：只有目标地址
    let current: PartialPath[] = [{ address: targetAddress, offsets: [] }];
    const results: PointerPath[] = [];
    const preferShallow = this.opts.preferShallow === true;

    /**
     * 把某一层的候选收进结果。
     *
     * 偏移链顺序修正：回溯时每级是"由目标往基址方向"追加，
     * 而应用方向是"由基址往目标"，因此这里反转。
     */
    const collect = (level: number, paths: PartialPath[]): void => {
      for (const p of paths) {
        if (this.opts.staticOnly && !this.isStatic(p.address)) continue;
        const entry: PointerPath = {
          baseAddress: p.address,
          offsets: p.offsets.slice().reverse(),
          targetAddress,
        };
        // 只在汇总模式下填 depth：默认模式保持原有的对象形状不变
        if (preferShallow) entry.depth = level;
        results.push(entry);
      }
    };

    for (let level = 1; level <= this.opts.maxLevel; level++) {
      const next = this.expandLevel(map, current, level);
      levelCounts.push(next.length);

      if (preferShallow) {
        // 汇总模式：每一层都收，等全部层跑完再统一排序/截断。
        // 这里**不能**提前按 maxResults 截断，否则浅层噪声会把深层的有效路径挤掉。
        collect(level, next);
        if (next.length === 0) break;
        current = next;
        continue;
      }

      if (level === this.opts.maxLevel) {
        collect(level, next);
        if (this.opts.maxResults > 0 && results.length >= this.opts.maxResults) break;
        break;
      }

      if (next.length === 0) break;
      current = next;
      if (this.opts.maxResults > 0 && current.length > this.opts.maxResults * 64) {
        // 防护：中间层候选爆炸时截断（CE 也有类似上限）
        current = current.slice(0, this.opts.maxResults * 64);
      }
    }

    let finalResults = results;
    if (preferShallow && results.length > 0) {
      // 排序：**层数浅优先为主**，同层内静态基址优先。
      //
      // 为什么以层数为主：层数越少越稳定、越不容易断链，而且结果呈现为
      // 「1 级全部 → 2 级全部 → 3 级全部」这种可直接阅读的分组顺序。
      // 反之若以静态为主，序列会变成 3级静态 → 1级动态 → 2级动态 这种跳跃，
      // 使用者看到的第一条未必是最浅的，且难以按层数解读。
      const staticCache = new Map<bigint, boolean>();
      const isStaticCached = (address: bigint): boolean => {
        let v = staticCache.get(address);
        if (v === undefined) {
          v = this.isStatic(address);
          staticCache.set(address, v);
        }
        return v;
      };
      finalResults = results
        .map((path, index) => ({ path, index }))
        .sort((a, b) => {
          const da = a.path.depth ?? 0;
          const db = b.path.depth ?? 0;
          if (da !== db) return da - db;
          const sa = isStaticCached(a.path.baseAddress) ? 0 : 1;
          const sb = isStaticCached(b.path.baseAddress) ? 0 : 1;
          if (sa !== sb) return sa - sb;
          return a.index - b.index;
        })
        .map((entry) => entry.path);
      // ⚠️ **不要在这里截断**。上限统一放在下面的"返回值验证之后"应用。
      //
      // 早先这里按 maxResults 先截断，而验证会丢弃一部分路径（值巧合、
      // 页已回收），于是"请求 10 条"可能只返回 3 条甚至 0 条 ——
      // 明明还有可用的路径，却因为先截断、后丢弃而没机会进入结果。
      // 先验证、再截断，才能保证"最多 N 条"是**上限**而不是**目标值**。
    }

    // ── 返回值验证：丢掉**解析不通**的路径 ──────────────────────────────
    //
    // 为什么需要这一步（这是一个真实缺陷的修复）：
    //
    // 指针扫描是按**值匹配**找候选槽的 —— 只要某个 8 字节位置的值恰好落在
    // 目标地址 ±maxOffset 内，它就会被当成"指针槽"。这在真实进程里会大量命中
    // **动态内存**（V8 堆、临时缓冲）：里面常常恰好存着某个页基址、或者
    // 由 `base + offset` 这种算式留下的裸 8 字节。
    //
    // 问题在于这些槽**随时可能失效**：目标进程一空闲，GC 就回收那一页，
    // 于是"沿路径读指针"的中间步骤会失败（Win32 998 / 读指针失败），
    // 或者解析出来的地址根本不是原来那个目标。
    //
    // 而调用方对返回值的期望是"**可直接使用**"（`ce_pointer_scan` 会把
    // `expression` 直接交给 `ce_read`）。把验证不通的路径交出去，
    // 等于把这个不确定性转嫁给使用者 —— 实测表现为：
    //   · 工具返回的第一条路径 `ce_read` 报 998；
    //   · 内核自己的测试偶发失败（`路径 … 解析结果不对` / `读取指针失败`）。
    //
    // 所以这里在返回前**逐条解析一遍**，只保留能真正走通、且解析结果
    // 等于目标地址的路径。验证成本是每条路径几次读内存，相对整张指针映射的
    // 构建成本可以忽略。
    //
    // ⚠️ **失败必须重试，不能一次读失败就丢掉整条路径**。
    // 这是踩过的坑：目标进程是活的，验证那一瞬间某个中间页可能刚好处于
    // 正在被回收/迁移的状态，于是**本来有效的路径**读失败一次。
    // 若据此丢弃，就会出现"本该找到却返回 0 条"的偶发失败
    // （实测：e2e 的指针扫描用例约 4/6 失败）。
    //
    // 区分两种失败：
    //   · **地址无效**（算错、段不存在）→ 稳定失败，重试也不会好；
    //   · **瞬时读失败**（页正在回收）→ 重试通常立刻成功。
    // 所以"重试若干次仍失败"才丢弃 —— 前者被快速淘汰（每次都失败），
    // 后者被救回来，代价只是极小概率多读几次内存。
    //
    // 注意：这不改变"按值匹配"的召回语义（那与 CE 一致），只是不再把
    // **已经证明不可用**的候选当成结果交付。
    const VERIFY_ATTEMPTS = 3;
    const verified: PointerPath[] = [];
    let droppedUnresolvable = 0;
    for (const path of finalResults) {
      let ok = false;
      for (let attempt = 0; attempt < VERIFY_ATTEMPTS && !ok; attempt += 1) {
        try {
          ok = this.resolvePath(path) === targetAddress;
        } catch {
          // 读不通：可能是页面正在回收（瞬时失败），下一次多半就好
        }
      }
      if (ok) verified.push(path);
      else droppedUnresolvable += 1;
    }

    // ── 应用结果上限（**必须在验证之后**）──────────────────────────────
    //
    // 两种模式都要遵守 maxResults：
    //   · `preferShallow`（汇总模式）；
    //   · 默认模式（只返回恰好达到 maxLevel 的路径）。
    //
    // ⚠️ 早先**只有汇总模式**遵守上限，默认模式完全无视它 ——
    // 实测 `maxResults=3` 时默认模式返回了 **896 条**。
    // 而 `preferShallow` 那侧又把截断放在了验证**之前**，于是验证丢掉一些
    // 路径后，"最多 N 条"会变成"不足 N 条"（明明还有可用路径没被取到）。
    //
    // 现在统一：先验证（只看有效性）→ 再截断（只看上限）。
    const capped = this.opts.maxResults > 0 ? verified.slice(0, this.opts.maxResults) : verified;
    const elapsedMs = Date.now() - started;
    this.lastStats = {
      segmentsScanned: this.lastSegmentCount,
      bytesIndexed: this.lastBytesIndexed,
      pointerEntries: map.entries.length,
      levelCounts,
      elapsedMs,
      resultCount: capped.length,
      droppedUnresolvable,
      // 候选总数（未按上限截断前）。调用方据此判断"是否触及上限"。
      candidateCount: verified.length,
    };
    return capped;
  }

  /**
   * 沿着一条路径解析出最终地址（用于验证结果）。
   * `readPtr` 由调用方提供，便于在测试中注入。
   */
  resolvePath(path: PointerPath, readPtr?: (addr: bigint) => bigint): bigint {
    const read = readPtr ?? ((addr: bigint) => this.readPointer(addr));
    let addr = path.baseAddress;
    for (const off of path.offsets) {
      addr = read(addr) + BigInt(off);
    }
    return addr;
  }

  /** 读取目标进程中的一个指针值。 */
  readPointer(address: bigint): bigint {
    const size = this.opts.pointerSize;
    const buf = this.proc.readMemory(address, size);
    if (buf.length < size) {
      throw new Error(`读取指针失败：0x${address.toString(16)}`);
    }
    return size === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  }

  /* ---------------------------------------------------------------- *
   * 指针映射建档
   * ---------------------------------------------------------------- */

  private lastSegmentCount = 0;
  private lastBytesIndexed = 0n;

  /** 建立（或复用）指针映射。 */
  private ensurePointerMap(): PointerMap {
    if (this.pointerMap) return this.pointerMap;

    const pointerSize = this.opts.pointerSize;
    const regions = this.proc.regions();

    // ── 预扫一遍：先确定"哪些地址是有效地址" ──
    // 这一步必须在使用 isCommittedAddress 之前完成，
    // 否则建档时的有效性判定会全部落空（早期版本的顺序错误就出在这里）。
    const committedRanges: Array<{ start: bigint; end: bigint }> = [];
    for (const r of regions) {
      if (!r.committed || r.memorySize <= 0n) continue;
      committedRanges.push({ start: r.baseAddress, end: r.baseAddress + r.memorySize });
    }
    committedRanges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    this.committedRanges = committedRanges;

    // ── 选出要建档的段 ──
    const segments: Array<{ start: bigint; end: bigint }> = [];
    const staticRanges: Array<{ start: bigint; end: bigint }> = [];

    for (const r of regions) {
      if (!r.committed) continue;
      if ((r.protect & PAGE_GUARD) !== 0) continue;
      if (!isReadable(r.protect)) continue;
      if (r.memorySize <= 0n) continue;
      // 过大的段跳过（CE 也会限制单段大小，避免一次性读入几十 GB）
      if (r.memorySize > 0x40000000n) continue;
      const end = r.baseAddress + r.memorySize;
      if (this.isExcludedRange(r.baseAddress, end)) continue;
      segments.push({ start: r.baseAddress, end });
      if (r.type === MEM_IMAGE) staticRanges.push({ start: r.baseAddress, end });
    }

    // isCommittedAddress 依赖二分查找，因此必须按地址升序排序
    segments.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    staticRanges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    if (this.opts.maxSegments > 0) segments.length = Math.min(segments.length, this.opts.maxSegments);

    // ── 收集条目 ──
    // 关键剪枝（对齐 CE 的指针映射语义）：只有"指向已提交内存"的值才可能是有效指针。
    // 不做这层过滤时，任意 8 字节随机数据都会被当成指针，条目数会膨胀到几千万，
    // 既浪费内存也让后续匹配充满噪声。
    const entries: PointerEntry[] = [];
    let bytesIndexed = 0n;
    const CHUNK = 4 * 1024 * 1024;
    const maxPtr = pointerSize === 4 ? 0xffffffffn : 0x7fffffffffffn;

    for (const seg of segments) {
      let addr = seg.start;
      while (addr < seg.end) {
        const take = Number(seg.end - addr > BigInt(CHUNK) ? BigInt(CHUNK) : seg.end - addr);
        const buf = this.proc.readMemory(addr, take);
        bytesIndexed += BigInt(buf.length);
        if (buf.length < pointerSize) {
          addr += BigInt(take);
          continue;
        }

        // 只在指针对齐的槽位取值 —— 对齐 CE 的指针映射行为，也大幅减少条目数
        const limit = buf.length - pointerSize;
        for (let off = 0; off <= limit; off += pointerSize) {
          const v = pointerSize === 8 ? buf.readBigUInt64LE(off) : BigInt(buf.readUInt32LE(off));
          if (v < 0x10000n || v > maxPtr) continue;
          if (!this.isCommittedAddress(v)) continue;
          entries.push({ store: addr + BigInt(off), value: v });
        }

        addr += BigInt(take);
      }
      this.opts.onProgress?.('建立指针映射', entries.length, 0);
    }

    // 按 value 排序，供二分查找（用显式比较器，避免 BigUint64Array.sort 的数值语义差异）
    const n = entries.length;
    const valuesForSort = new Array<bigint>(n);
    for (let i = 0; i < n; i++) valuesForSort[i] = entries[i].value;
    const sortedIdx = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
      const x = valuesForSort[a];
      const y = valuesForSort[b];
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const sortedValues = new BigUint64Array(n);
    const sortedOrder = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      sortedValues[i] = valuesForSort[sortedIdx[i]];
      sortedOrder[i] = sortedIdx[i];
    }

    this.staticRanges = staticRanges;
    this.lastSegmentCount = segments.length;
    this.lastBytesIndexed = bytesIndexed;
    this.pointerMap = { entries, sortedValues, order: sortedOrder };
    return this.pointerMap;
  }

  /** 该值是否落在某个已提交区域（有效指针的基本条件）。 */
  private isCommittedAddress(addr: bigint): boolean {
    const ranges = this.committedRanges;
    // 线性扫描对每次调用都太慢，这里用二分（ranges 已按地址升序）
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const r = ranges[mid];
      if (addr < r.start) hi = mid - 1;
      else if (addr >= r.end) lo = mid + 1;
      else return true;
    }
    return false;
  }

  /**
   * 二分查找"落在 [lo, hi] 区间内"的条目下标范围 `[from, to)`。
   *
   * 这是指针扫描的关键索引操作：`expandLevel` 需要拿到**所有在 maxOffset 窗口内**
   * 指向当前层地址的槽位，再由调用方逐条算出精确偏移。
   *
   * ⚠️ 曾经的严重缺陷：这里原来做的是"值**恰好等于** target"的精确查找，
   * 于是 `expandLevel` 里 `offset = path.address - entry.value` **恒为 0**，
   * `maxOffset` 成了死代码 —— 表现为"只要偏移不为 0 就永远找不到指针路径"，
   * 而真实游戏里指针几乎总带偏移，等于指针扫描功能基本失效。
   * 回归测试见 `test/pointer-scan.test.js` 的 "maxOffset 必须真正生效"。
   */
  private findValueRange(map: PointerMap, target: bigint, maxOffset: number): [number, number] {
    const offset = BigInt(Math.max(0, Math.trunc(maxOffset)));
    const lo = target - offset < 0n ? 0n : target - offset;
    const hi = target + offset;
    return [this.lowerBound(map, lo), this.upperBound(map, hi)];
  }

  /** 第一个 `value >= bound` 的下标（标准 lower_bound）。 */
  private lowerBound(map: PointerMap, bound: bigint): number {
    const arr = map.sortedValues;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < bound) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 第一个 `value > bound` 的下标（标准 upper_bound）。 */
  private upperBound(map: PointerMap, bound: bigint): number {
    const arr = map.sortedValues;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] <= bound) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 展开一级：对当前每个"待匹配地址"，找出所有指向它的槽位，
   * 生成新的候选（存放地址 + 偏移）。
   */
  private expandLevel(map: PointerMap, current: PartialPath[], level: number): PartialPath[] {
    const out: PartialPath[] = [];
    const seen = new Set<string>();
    const { maxOffset, allowNegativeOffsets, maxDifferentOffsets } = this.opts;

    for (const path of current) {
      const [from, to] = this.findValueRange(map, path.address, maxOffset);
      if (from === to) continue;

      // 同一个 store 可能有多个偏移（若它指向当前层多个地址）
      const perStore = new Map<string, number[]>();

      for (let i = from; i < to; i++) {
        const entry = map.entries[map.order[i]];
        const offset = Number(path.address - entry.value);
        if (offset === 0 && !allowNegativeOffsets) {
          // 偏移 0 是合法的（指针直接指向目标），允许保留
        }
        if (Math.abs(offset) > maxOffset) continue;
        if (offset < 0 && !allowNegativeOffsets) continue;

        const key = entry.store.toString();
        let arr = perStore.get(key);
        if (!arr) {
          arr = [];
          perStore.set(key, arr);
        }
        if (!arr.includes(offset)) arr.push(offset);
      }

      for (const [storeKey, offsets] of perStore) {
        const store = BigInt(storeKey);
        if (this.isExcludedRange(store, store + 1n)) continue;
        const list =
          maxDifferentOffsets > 0 && offsets.length > maxDifferentOffsets
            ? offsets.slice(0, maxDifferentOffsets)
            : offsets;

        for (const off of list) {
          // 新路径：把"本级的偏移"补到偏移链末尾（靠近基址的一端先不加，
          // 因为回溯方向是从目标往基址走，所以这里用 unshift 的逆序语义）
          const newOffsets = path.offsets.slice();
          newOffsets.push(off);
          const dedupKey = storeKey + '|' + newOffsets.join(',');
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          out.push({ address: store, offsets: newOffsets });
        }
      }
    }

    void level;
    return out;
  }

  private isStatic(addr: bigint): boolean {
    for (const r of this.staticRanges) {
      if (addr >= r.start && addr < r.end) return true;
    }
    return false;
  }

  private isExcludedRange(start: bigint, end: bigint): boolean {
    const ex = this.opts.excludeSegments;
    if (!ex) return false;
    for (const r of ex) {
      if (start < r.end && end > r.start) return true;
    }
    return false;
  }
}

/**
 * 把偏移链渲染成 CE 风格的表达式。
 *
 * CE 显示顺序是"从基址到目标"：
 *   `"game.exe"+00123ABC -> 0x10 -> 0x2C -> 0x8`
 * 本实现的 offsets 数组即该顺序。
 */
export function formatPointerPath(
  path: PointerPath,
  moduleOf?: (addr: bigint) => { name: string; base: bigint } | null,
): string {
  const mod = moduleOf?.(path.baseAddress);
  const baseStr = mod
    ? `"${mod.name}"+${(path.baseAddress - mod.base).toString(16).toUpperCase().padStart(8, '0')}`
    : `0x${path.baseAddress.toString(16).toUpperCase()}`;
  const offs = path.offsets
    .map((o) => (o < 0 ? `-${Math.abs(o).toString(16).toUpperCase()}` : o.toString(16).toUpperCase()))
    .join(' -> ');
  return offs ? `${baseStr} -> ${offs}` : baseStr;
}

/** 应用一条路径得到最终地址（便捷函数）。 */
export function applyPointerPath(
  path: PointerPath,
  readPointer: (addr: bigint) => bigint,
): bigint {
  let addr = path.baseAddress;
  for (const off of path.offsets) {
    addr = readPointer(addr) + BigInt(off);
  }
  return addr;
}
