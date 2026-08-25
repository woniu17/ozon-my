/* =========================================================
 * Ozon 端点耗时监控 — 插件侧缓冲/上报模块(2026-08)
 *
 * 对齐 qxqx/metrics.js 语义(script='plugin'),适配 MV3 SW 生命周期:
 *   - 缓冲持久化到 chrome.storage.local(SW 随时可能被杀,重启后从盘恢复)
 *   - 满 20 条立即上报;chrome.alarms 每分钟唤醒兜底上报(MV3 无可靠 setInterval)
 *   - 出口 IP 探测(api.ip.sb,失败静默保留旧值;CORS 不放行则为 null)
 *   - 铁律:监控链路任何失败不得影响采集主流程(全部 try/catch 静默)
 *
 * 上报认证:复用插件 JWT(Bearer token,与 store-classification 等管理接口同路);
 * 不走 apiRequest(其 401 会清 token,监控不得有副作用)→ 用原生 fetch。
 *
 * 维度取值:
 *   machineId  = plugin-<random8>(chrome.storage 每安装一份,等价浏览器 profile 标识)
 *   profileId  = 'chrome-profile'(插件共用宿主浏览器 profile,常量)
 *   clientIp   = 出口 IP 探测结果(可为 null)
 *
 * 暴露(__jzCollect 命名空间):
 *   endpointMetricAdd(m)      SW 内部埋点(SW 侧调用)
 *   endpointMetricFlush()     手动触发上报(onMessage 'endpointMetric' 也顺带触发)
 */
(() => {
  globalThis.__jzCollect.setupMetrics = function () {
    const sw = this._sw;

    const FLUSH_SIZE = 5;
    const BATCH_LIMIT = 200; // 与后端 batch 接口单批上限一致
    const BUF_CAP = 400; // 持久化缓冲上限(2 批),超出丢最旧
    const IP_PROBE_INTERVAL_MS = 30 * 60 * 1000;
    const ALARM_NAME = 'qx-endpoint-metrics-flush';
    const BUF_KEY = 'jz-endpoint-metrics-buf';
    const INSTANCE_KEY = 'jz-plugin-instance-id';
    const IP_PROBE_URL = 'https://api.ip.sb/ip';

    // 运行时状态(模块闭包,SW 重启即重置;缓冲真身在 storage)
    let buf = [];
    let machineId = null;
    let clientIp = null;
    let lastIpProbeAt = 0;
    let flushing = false;
    let loaded = false; // storage → 内存是否已完成初载

    // ── 工具:storage 读写(全部容错) ─────────────────────────────
    const storageGet = (keys) =>
      new Promise((resolve) => {
        try {
          chrome.storage.local.get(keys, (d) => resolve(d || {}));
        } catch {
          resolve({});
        }
      });
    const storageSet = (obj) =>
      new Promise((resolve) => {
        try {
          chrome.storage.local.set(obj, () => resolve());
        } catch {
          resolve();
        }
      });

    const persist = () => {
      // 丢最旧保上限;fire-and-forget
      if (buf.length > BUF_CAP) buf = buf.slice(-BUF_CAP);
      storageSet({ [BUF_KEY]: buf }).catch(() => {});
    };

    const loadFromStorage = async () => {
      if (loaded) return;
      loaded = true;
      try {
        const d = await storageGet([BUF_KEY, INSTANCE_KEY]);
        if (Array.isArray(d[BUF_KEY])) buf = d[BUF_KEY];
        if (d[INSTANCE_KEY]) {
          machineId = d[INSTANCE_KEY];
        } else {
          // 首次安装:生成稳定实例 ID(等价浏览器 profile 标识)
          machineId = 'plugin-' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 8) : String(Date.now().toString(36)));
          storageSet({ [INSTANCE_KEY]: machineId }).catch(() => {});
        }
        if (buf.length > 0) endpointMetricFlush(); // SW 冷启动恢复积压
      } catch { /* 静默 */ }
    };

    // ── 出口 IP 探测(失败保留旧值;无 host_permissions 时依赖对方 CORS) ──
    const probeIp = async () => {
      if (Date.now() - lastIpProbeAt < IP_PROBE_INTERVAL_MS) return;
      lastIpProbeAt = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const resp = await fetch(IP_PROBE_URL, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!resp.ok) return;
        const text = (await resp.text()).trim();
        if (/^[\d.:a-fA-F]+$/.test(text) && text.length <= 45) clientIp = text;
      } catch { /* CORS 拦截/网络失败:保留旧值(可能为 null) */ }
    };

    // ── 上报 ────────────────────────────────────────────────────
    const endpointMetricFlush = async () => {
      if (flushing || buf.length === 0) return;
      flushing = true;
      try {
        await loadFromStorage(); // 确保实例 ID 就绪
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        const token = stored?.[sw.STORAGE_KEYS.token];
        if (!url || !token) return; // 未登录/后端未配置:静默留缓冲
        await probeIp();

        const items = buf.slice(0, BATCH_LIMIT).map((m) => ({
          ...m,
          script: 'plugin',
          machineId,
          profileId: 'chrome-profile',
          clientIp,
        }));
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        try {
          const resp = await fetch(`${url}/admin/api/endpoint-metrics/batch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ items }),
            signal: ctrl.signal,
          });
          if (resp.ok) {
            buf = buf.slice(items.length);
            persist();
          }
          // 非 2xx:静默保留缓冲,下轮 alarm 重试
        } finally {
          clearTimeout(timer);
        }
      } catch { /* 网络失败静默 */ } finally {
        flushing = false;
        // 积压超单批上限 → 立即继续(与 qxqx metrics.js 同语义)
        if (buf.length >= BATCH_LIMIT) endpointMetricFlush();
      }
    };
    this.endpointMetricFlush = endpointMetricFlush;

    // ── 埋点入口(SW 侧 + content 侧经 onMessage 中继) ───────────
    this.endpointMetricAdd = (m) => {
      try {
        if (!m || !m.endpoint || !Number.isFinite(Number(m.durationMs))) return;
        buf.push({
          endpoint: String(m.endpoint),
          method: m.method || 'GET',
          ts: m.ts || new Date().toISOString(),
          durationMs: Math.max(0, Math.round(Number(m.durationMs))),
          statusCode: Number.isFinite(Number(m.statusCode)) ? Number(m.statusCode) : null,
          ok: m.ok === false ? 0 : 1,
          errorKind: m.errorKind || null,
          sku: m.sku ? String(m.sku) : null,
          sellerId: m.sellerId ? String(m.sellerId) : null,
        });
        persist();
        if (!loaded) loadFromStorage();
        if (buf.length >= FLUSH_SIZE) endpointMetricFlush();
      } catch { /* 铁律:静默 */ }
    };

    // ── alarms 兜底上报(MV3 SW 空闲即被杀,setInterval 不可靠) ──
    try {
      if (chrome.alarms?.on?.addListener) {
        chrome.alarms.on.addListener((alarm) => {
          if (alarm?.name !== ALARM_NAME) return;
          loadFromStorage().then(() => endpointMetricFlush());
        });
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1, delayInMinutes: 1 });
      }
    } catch { /* Electron 宿主无 alarms:降级为满 20 条触发 */ }

    // SW 启动即恢复(登录态就绪时把积压冲掉)
    loadFromStorage();
  };
})();
