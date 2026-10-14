"use strict";
/**
 * 内存后端抽象 —— 让上层 API 与"用哪个引擎"解耦。
 *
 * 本移植提供三种可切换的调用方式：
 *
 *  1. `SelfBackend`（默认，自研引擎）
 *     直接通过 Win32 API（koffi 绑定）在本进程内读写目标进程内存。
 *     没有外部依赖，兼容性最强，扫描逻辑由本移植的 matcher 实现。
 *
 *  2. `NativeCeBackend`（原生 CE 兼容层）
 *     作为客户端连接 Cheat Engine 官方的 `ceserver`（CE 源码里
 *     `Cheat Engine/ceserver/` 那套服务端程序），走 CE 自己的 TCP 协议。
 *     好处是可以复用原生 CE 的能力（它跑在目标机器上、可能带驱动），
 *     代价是需要一个正在运行的 ceserver。
 *
 *  3. `DbkBackend`（DBK 内核驱动，见 `dbk-backend.ts` 与 docs/backend-dbk.md）
 *     通过 CE 自己的 DBK64 驱动 ioctl 读写，**同步**。
 *     这是读**受保护进程**（PPL/反作弊/以更高权限运行）的唯一途径 ——
 *     用户态连句柄都打不开。
 *     前提：驱动已加载（加载需要管理员权限，插件侧用 `ce_kernel` 工具装）。
 *     能力边界：`changeProtection`/`free` 仍是用户态实现（CE 驱动的
 *     `MAKEWRITABLE` 在 x64 上是空的），对受保护进程会失败；
 *     且其驱动侧结构布局尚未在真机上验证。
 *
 * 上层的扫描会话、地址表、.CT 读写、地址表达式都对三者一视同仁：
 * 它们只依赖本文件定义的 `MemoryBackend` 接口。
 *
 * DBK64 内核驱动接口（`DBK32functions.pas` 里的 `Dbk*` 系列 ioctl）
 * 由 `DbkBackend` 实现（见上文第 3 条），协议细节与已知限制见
 * `docs/backend-dbk.md`。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackendUnsupportedError = void 0;
/** 后端不支持某能力时抛出的错误 */
class BackendUnsupportedError extends Error {
    backend;
    operation;
    constructor(backend, operation, detail) {
        super(`后端 "${backend}" 不支持该操作：${operation}` +
            (detail ? `（${detail}）` : ''));
        this.backend = backend;
        this.operation = operation;
        this.name = 'BackendUnsupportedError';
    }
}
exports.BackendUnsupportedError = BackendUnsupportedError;
//# sourceMappingURL=types.js.map