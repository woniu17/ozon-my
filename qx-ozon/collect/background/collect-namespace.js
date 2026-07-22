/* =========================================================
 * 采集命名空间定义(采集代码隔离 Phase 3)
 *
 * 本文件在 IIFE 之前通过 importScripts 加载,定义 globalThis.__jzCollect
 * 命名空间。采集模块的外部文件(collect-cache.js 等)通过 __jzCollect
 * 注册 setup 函数;IIFE 在工具函数就绪后调用各 setup 函数完成初始化。
 *
 * 架构:
 *   1. importScripts 加载本文件 → 定义 __jzCollect 命名空间
 *   2. importScripts 加载 collect-cache.js 等 → 注册 __jzCollect.setupXxx
 *   3. IIFE 定义工具函数(getBackendUrl / apiRequest / STORAGE_KEYS 等)
 *   4. IIFE 调用 __jzCollect.init({ getBackendUrl, ... }) 传入桥接对象
 *   5. __jzCollect.init 依次调用各 setupXxx,完成采集函数注册
 *
 * 采集函数通过 __jzCollect.xxx 暴露给 IIFE 的 onMessage handler 和
 * 事件监听器调用。
 * ========================================================= */

(() => {
  if (globalThis.__jzCollect) return; // 防止重复加载

  const C = {
    // ── 采集运行时状态(原 IIFE 内的 let/const 变量)──
    state: {
      // 注:idbPromise / cacheSyncRunning 已废弃(取消 L1 IndexedDB 后不再需要)

      // 队列
      consuming: false,
      consumeStartedAt: 0, // _consumeOne 开始时间戳,供 _maybeStartConsume 检测卡死
      // 下次消费的预计触发时间戳(setTimeout 调度时刻),供监控页面精确倒计时。
      // 在 _consumeOne/_maybeStartConsume 计算出真实随机间隔后写入;
      // _consumeOne 开始时清零,SW 重启后自然丢失(前端回退到 lastConsumeAt+中点估算)。
      nextConsumeAt: 0,
      queueWriteLock: null,
      opsPollTimer: null,
      completedTodaySkus: new Set(),

      // 并发
      autoCollectRunning: 0,
      autoCollectQueue: [],

      // 限流
      sellerPortalGateChain: Promise.resolve(),
      sellerPortalLastAt: 0,

      // 配置
      autoCollectConfigCache: null,
      autoCollectRecent: [],
    },

    // ── SW 工具桥接(由 IIFE 的 init() 传入)──
    _sw: null,

    // ── 初始化入口 ──
    init(sw) {
      this._sw = sw;
      const setups = [this.setupCache, this.setupConfig, this.setupRunner, this.setupQueue, this.setupTab];
      for (const setup of setups) {
        if (typeof setup === 'function') {
          try {
            setup.call(this);
          } catch (e) {
            console.warn('[__jzCollect] setup failed:', e?.message || e);
          }
        }
      }
      this._inited = true;
    },

    _inited: false,
  };

  globalThis.__jzCollect = C;
})();
