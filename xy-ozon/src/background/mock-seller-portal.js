// Mock seller.ozon.ru portal —— 模拟原项目 fetchSellerPortal 的全部调用。
// 高仿真:保留 200ms 全局节流闸门、403 反爬细分(ANTIBOT_BLOCKED/AUTH_REQUIRED)、
// 草稿内存存储、async-upload 任务进度递增、可配失败率。
//
// 对应原项目接口:
//   /seller-prototype/create-bundle             → createBundle (6b)
//   /seller-prototype/update-bundle-items       → updateBundleItems (6c)
//   /seller-prototype/upload-bundle             → uploadBundle (6d)
//   /async-upload/v1/task/get-list              → getUploadTaskList (Phase 7)
//   /async-upload/v1/task/get-errors            → getUploadTaskErrors (Phase 7)
//   /api/v1/search                              → searchVariants (Phase 3,数据采集)
//   /seller-prototype/create-bundle-by-variant-id → fetchBundleByVariantId (Phase 3)
//   /api/media-storage/upload-file              → uploadVideo (Phase 4,视频转存 mock)

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // 配置
  // ────────────────────────────────────────────────────────────
  const SELLER_PORTAL_MIN_INTERVAL_MS = 200; // 全局节流闸门(对齐原项目)
  const DEFAULTS = {
    enabled: false, // ⬅️ mock 总开关:false=走真实 seller.ozon.ru;true=用 mock(离线测试/故障注入)
    antibotRate: 0, // 0~1,create/update/upload 命中 403 反爬概率
    authFailRate: 0, // 0~1,权限错( AUTH_REQUIRED ) 概率
    networkFailRate: 0, // 0~1,网络错概率
    taskProcessMs: 600, // async-upload 任务 processed 递增间隔
    companyId: '3891653', // 浏览器当前登录的 sc_company_id(必须与 mock-erp 的 mockStoreCompanyId 一致才能过护栏)
  };

  function cfg() {
    return Object.assign({}, DEFAULTS, self.MOCK_SELLER_CONFIG || {});
  }

  // ────────────────────────────────────────────────────────────
  // 全局节流闸门 —— 所有 portal 调用串行,相邻至少 200ms
  // ────────────────────────────────────────────────────────────
  let _gatePromise = Promise.resolve();
  let _gateLastTs = 0;

  function _sellerPortalGate(label) {
    const run = async () => {
      const now = Date.now();
      const wait = Math.max(0, SELLER_PORTAL_MIN_INTERVAL_MS - (now - _gateLastTs));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      _gateLastTs = Date.now();
    };
    _gatePromise = _gatePromise.then(run, run);
    return _gatePromise;
  }

  // ────────────────────────────────────────────────────────────
  // 错误分类(对齐原项目 classifyError)
  // ────────────────────────────────────────────────────────────
  function _maybeThrowError(label) {
    const c = cfg();
    if (c.authFailRate > 0 && Math.random() < c.authFailRate) {
      const err = new Error(`[mock-seller] ${label} 权限错:company_id/session 无效`);
      err.code = 'AUTH_REQUIRED';
      err.status = 403;
      throw err;
    }
    if (c.antibotRate > 0 && Math.random() < c.antibotRate) {
      const err = new Error(`[mock-seller] ${label} 命中反爬挑战页`);
      err.code = 'ANTIBOT_BLOCKED';
      err.status = 403;
      err.body = '<!doctype html><title>Just a moment...</title>';
      throw err;
    }
    if (c.networkFailRate > 0 && Math.random() < c.networkFailRate) {
      const err = new Error(`[mock-seller] ${label} 网络错`);
      err.code = 'NETWORK_ERROR';
      throw err;
    }
  }

  // ────────────────────────────────────────────────────────────
  // 草稿 & 任务内存存储
  // ────────────────────────────────────────────────────────────
  const _bundles = new Map(); // bundleId → { items, companyId, uploaded, uploadTaskId, createdAt }
  const _tasks = new Map(); // taskId → { id, size, processed, failed, warned, status, errors, companyId }
  const _taskSeq = { n: 1000 };
  const _bundleSeq = { n: 5000 };

  function _newId(prefix, seq) {
    seq.n += 1;
    return `${prefix}-${seq.n}`;
  }

  // 异步推进任务进度(processed 每 taskProcessMs 递增,直到 size)
  function _advanceTask(taskId) {
    const task = _tasks.get(taskId);
    if (!task) return;
    const tick = () => {
      if (task.processed >= task.size) {
        task.status = 'complete';
        return;
      }
      task.processed = Math.min(task.size, task.processed + 1);
      setTimeout(tick, cfg().taskProcessMs);
    };
    setTimeout(tick, cfg().taskProcessMs);
  }

  // ────────────────────────────────────────────────────────────
  // 公开 API
  // ────────────────────────────────────────────────────────────
  const MockSellerPortal = {
    // 解析当前登录店铺的 sc_company_id(对齐原项目 resolveSellerCompanyId)
    async resolveSellerCompanyId() {
      // 原项目读 chrome.cookies.getAll({url:'https://seller.ozon.ru/', name:'sc_company_id'})
      // 这里直接返回 mock 值,可被 MOCK_SELLER_CONFIG.companyId 覆盖
      return cfg().companyId;
    },

    // Phase 3:数据采集 —— /api/v1/search
    async searchVariants(sku) {
      await _sellerPortalGate('search');
      _maybeThrowError('search');
      if (!sku) throw Object.assign(new Error('sku required'), { code: 'UNKNOWN_ERROR' });
      // 返回归一化后的 sourceVariant(对齐原项目 normalizeSearchVariantToSv)
      return {
        variant_id: `var-${sku}`,
        sku,
        attributes: [
          { key: '4180', value: `Demo 商品 ${sku}` }, // 名称
          { key: '4194', value: 'https://via.placeholder.com/600/main.jpg' }, // 主图
          { key: '4195', collection: ['https://via.placeholder.com/600/g1.jpg'] }, // 图册
          { key: '8229', value: 'demo_type' }, // 类型
          { key: '85', value: 'DemoBrand' }, // 品牌
          { key: '7822', value: '1234567890123' }, // GTIN/barcode
          { key: '4191', value: '这是源商品的真实描述(Demo)。' }, // 描述
        ],
        description_category_id: 90401,
        categories: [{ id: 90401, name: 'Demo 类目' }],
      };
    },

    // Phase 3:数据采集 —— /seller-prototype/create-bundle-by-variant-id
    async fetchBundleByVariantId(sku, variantId, companyId) {
      await _sellerPortalGate('bundle-by-variant-id');
      _maybeThrowError('bundle-by-variant-id');
      return {
        variant_id: variantId,
        attributes: [
          { key: '4497', value: '500' }, // 重量(g)
          { key: '9454', value: '20' }, // 深度(cm)
          { key: '9455', value: '30' }, // 宽度(cm)
          { key: '9456', value: '10' }, // 高度(cm)
          { key: '7822', value: '1234567890123' }, // barcode
        ],
        _bundleComplexAttrs: [],
      };
    },

    // Phase 4:视频转存 —— /api/media-storage/upload-file
    async uploadVideo(srcUrl) {
      await _sellerPortalGate('upload-file');
      _maybeThrowError('upload-file');
      if (!srcUrl) return { ok: false, error: 'srcUrl required' };
      // 返回卖家自有 Ozon 视频地址(对齐原项目 ir.ozone.ru/s3/... 格式)
      return {
        ok: true,
        url: `https://ir.ozone.ru/s3/mock-video/${Date.now()}.mp4`,
      };
    },

    // Phase 6b:建空草稿 —— /seller-prototype/create-bundle
    async createBundle(companyId) {
      await _sellerPortalGate('create-bundle');
      _maybeThrowError('create-bundle');
      const bundleId = _newId('bdl', _bundleSeq);
      _bundles.set(bundleId, {
        bundleId,
        items: [],
        companyId: String(companyId),
        uploaded: false,
        uploadTaskId: null,
        createdAt: Date.now(),
      });
      console.log(`[mock-seller] createBundle → ${bundleId}`);
      return bundleId;
    },

    // Phase 6c:写入商品数据 —— /seller-prototype/update-bundle-items
    async updateBundleItems(bundleId, companyId, items, source, catName) {
      await _sellerPortalGate('update-bundle-items');
      _maybeThrowError('update-bundle-items');
      const b = _bundles.get(String(bundleId));
      if (!b) throw Object.assign(new Error('bundle 不存在'), { code: 'UNKNOWN_ERROR' });
      b.items = items;
      b.source = source || 'SOURCE_MERGED';
      b.catName = catName || '';
      console.log(`[mock-seller] updateBundleItems → ${bundleId}, items=${items?.length}`);
      return {};
    },

    // Phase 6d:提交发布 —— /seller-prototype/upload-bundle
    async uploadBundle(bundleId, companyId) {
      await _sellerPortalGate('upload-bundle');
      _maybeThrowError('upload-bundle');
      const b = _bundles.get(String(bundleId));
      if (!b) throw Object.assign(new Error('bundle 不存在'), { code: 'UNKNOWN_ERROR' });
      b.uploaded = true;
      // 创建 async-upload 任务
      const taskId = _newId('task', _taskSeq);
      const size = Array.isArray(b.items) ? b.items.length : 1;
      _tasks.set(taskId, {
        id: Number(taskId.replace('task-', '')),
        taskId,
        size,
        processed: 0,
        failed: 0,
        warned: 0,
        status: 'processing',
        errors: [],
        companyId: String(companyId),
      });
      b.uploadTaskId = taskId;
      _advanceTask(taskId);
      console.log(`[mock-seller] uploadBundle → ${bundleId}, taskId=${taskId}`);
      return taskId;
    },

    // Phase 7:任务进度 —— /async-upload/v1/task/get-list
    async getUploadTaskList(companyId, { limit = 30, page = 1 } = {}) {
      await _sellerPortalGate('get-list');
      const tasks = Array.from(_tasks.values()).filter((t) => t.companyId === String(companyId));
      return { tasks: tasks.slice((page - 1) * limit, page * limit) };
    },

    // Phase 7:失败明细 —— /async-upload/v1/task/get-errors
    async getUploadTaskErrors(companyId, taskId, { page = 1, page_size = 50 } = {}) {
      await _sellerPortalGate('get-errors');
      const task = _tasks.get(String(taskId));
      if (!task) return { task_item_errors: [] };
      return { task_item_errors: task.errors.slice((page - 1) * page_size, page * page_size) };
    },
  };

  self.MockSellerPortal = MockSellerPortal;
})();
