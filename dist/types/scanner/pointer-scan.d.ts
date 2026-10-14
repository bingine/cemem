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
import { Process } from '../win/process';
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
    excludeSegments?: Array<{
        start: bigint;
        end: bigint;
    }>;
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
/**
 * 指针扫描器。
 *
 * ```ts
 * const ps = new PointerScanner(proc, { maxLevel: 5, maxOffset: 2048 });
 * const paths = ps.scan(targetAddress);
 * for (const p of paths) console.log(formatPointerPath(p));
 * ```
 */
export declare class PointerScanner {
    private readonly proc;
    private readonly opts;
    /** 缓存的指针映射（同一进程可复用） */
    private pointerMap;
    /** 记录静态区范围，用于 staticOnly 判定 */
    private staticRanges;
    /** 已提交区域范围（升序），用于判定某值是否可能是有效指针 */
    private committedRanges;
    private lastStats;
    constructor(process: Process, options?: PointerScanOptions);
    get stats(): PointerScanStats | null;
    /** 指针映射是否已建好（可跳过一次全量建档）。 */
    get hasPointerMap(): boolean;
    /** 丢弃已建好的指针映射。 */
    clearPointerMap(): void;
    /** 执行指针扫描。 */
    scan(targetAddress: bigint): PointerPath[];
    /**
     * 沿着一条路径解析出最终地址（用于验证结果）。
     * `readPtr` 由调用方提供，便于在测试中注入。
     */
    resolvePath(path: PointerPath, readPtr?: (addr: bigint) => bigint): bigint;
    /** 读取目标进程中的一个指针值。 */
    readPointer(address: bigint): bigint;
    private lastSegmentCount;
    private lastBytesIndexed;
    /** 建立（或复用）指针映射。 */
    private ensurePointerMap;
    /** 该值是否落在某个已提交区域（有效指针的基本条件）。 */
    private isCommittedAddress;
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
    private findValueRange;
    /** 第一个 `value >= bound` 的下标（标准 lower_bound）。 */
    private lowerBound;
    /** 第一个 `value > bound` 的下标（标准 upper_bound）。 */
    private upperBound;
    /**
     * 展开一级：对当前每个"待匹配地址"，找出所有指向它的槽位，
     * 生成新的候选（存放地址 + 偏移）。
     */
    private expandLevel;
    private isStatic;
    private isExcludedRange;
}
/**
 * 把偏移链渲染成 CE 风格的表达式。
 *
 * CE 显示顺序是"从基址到目标"：
 *   `"game.exe"+00123ABC -> 0x10 -> 0x2C -> 0x8`
 * 本实现的 offsets 数组即该顺序。
 */
export declare function formatPointerPath(path: PointerPath, moduleOf?: (addr: bigint) => {
    name: string;
    base: bigint;
} | null): string;
/** 应用一条路径得到最终地址（便捷函数）。 */
export declare function applyPointerPath(path: PointerPath, readPointer: (addr: bigint) => bigint): bigint;
//# sourceMappingURL=pointer-scan.d.ts.map