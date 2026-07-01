// Service Worker —— 消息路由 + 全流程编排。
// MV3 SW 只能指定单入口文件,这里用 importScripts 加载所需模块。
//
// 消息路由(对齐原项目 SW case 列表):
//   login / logout / selectStore                                                    → 鉴权
//   getFeatureFlags / getMembershipSummary / getWarehouses / getStores / getAiQuota  → Phase 1 校验
//   searchVariants / fetchBundleByVariantId                                         → Phase 3 采集
//   uploadFollowSellVideo                                                            → Phase 4 视频转存
//   followSell (viaPortal=true)                                                      → Phase 6 提交
//   portalImportStatus                                                               → Phase 7 轮询

// 加载模块:
//   seller-portal-client.js  真实 seller portal 数据采集(Phase 3)
//   erp-client.js            真实 ERP HTTP 客户端(Phase 1 校验 + 6a 备料 + 官方 API)
//   mock-seller-portal.js    Mock seller portal 建品(6b-6d + Phase 7 轮询)
//   import-via-portal.js     viaPortal 编排核心(依赖前三个)
importScripts('seller-portal-client.js', 'erp-client.js', 'mock-seller-portal.js', 'import-via-portal.js');

// 鉴权数据(存 chrome.storage.local,由 erp-client.js 与 popup 共同维护)
const STORAGE_KEYS = self.ErpClient.STORAGE_KEYS;

async function getAuth() {
  // 读 chrome.storage;未登录则返回空字符串(由调用方/弹窗处理)
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.storeId]);
    return {
      token: stored[STORAGE_KEYS.token] || '',
      storeId: stored[STORAGE_KEYS.storeId] || '',
    };
  } catch {
    return { token: '', storeId: '' };
  }
}

// ────────────────────────────────────────────────────────────
// 消息路由
// ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const { token, storeId } = await getAuth();
    const type = message?.type;
    try {
      switch (type) {
        // ── 鉴权 ───────────────────────────────────────────────
        // POST /auth/login-password → 存 token;随后拉取店铺并默认选第一个
        case 'login': {
          const { phoneNumber, password } = message;
          if (!phoneNumber || !password) {
            return sendResponse({ ok: false, error: 'phoneNumber 与 password 必填' });
          }
          const data = await self.ErpClient.login(phoneNumber, password);
          const stores = await self.ErpClient.getStores(data.accessToken);
          let selectedStoreId = '';
          if (Array.isArray(stores) && stores.length > 0) {
            selectedStoreId = stores[0].id;
            await chrome.storage.local.set({ [STORAGE_KEYS.storeId]: selectedStoreId });
          }
          return sendResponse({ ok: true, data: { user: data.user, stores, selectedStoreId } });
        }
        case 'logout': {
          await self.ErpClient.logout();
          return sendResponse({ ok: true });
        }
        // 切换当前店铺(写入 chrome.storage.local)
        case 'selectStore': {
          if (!message.storeId) return sendResponse({ ok: false, error: '缺少 storeId' });
          await chrome.storage.local.set({ [STORAGE_KEYS.storeId]: message.storeId });
          return sendResponse({ ok: true });
        }

        // ── Phase 1:配置 + 校验 ───────────────────────────────
        case 'getFeatureFlags': {
          const data = await self.ErpClient.getFeatureFlags(token, message.storeId || storeId);
          return sendResponse({ ok: true, data });
        }
        case 'getMembershipSummary': {
          const data = await self.ErpClient.getMembershipSummary(token, message.storeId || storeId);
          return sendResponse({ ok: true, data });
        }
        case 'getWarehouses': {
          const data = await self.ErpClient.getWarehouses(token, message.storeId || storeId);
          return sendResponse({ ok: true, data });
        }
        case 'getStores': {
          const data = await self.ErpClient.getStores(token);
          return sendResponse({ ok: true, data });
        }
        case 'getAiQuota': {
          const data = await self.ErpClient.getAiQuota(token, message.storeId || storeId);
          return sendResponse({ ok: true, data });
        }

        // ── Phase 3:数据采集(真实访问 seller.ozon.ru) ───────
        // searchVariants 内部已完整封装:/search 拿 variant_id + 基础 attr,
        // 再调 create-bundle-by-variant-id 补完整 attr(物理 4497/9454-9456 +
        // barcode 7822 + 40-63 个后台 attr + complex attr 视频/PDF)。
        // 跨域快路(www.ozon.ru tab MAIN world 直发)→ seller tab 回退 → 403 细分 → 重试。
        case 'searchVariants': {
          const senderTabId = sender?.tab?.id || null;
          const sv = await self.SellerPortalClient.searchVariants(message.sku, {
            preferTabId: senderTabId,
            forceRefresh: Boolean(message.forceRefresh),
          });
          if (!sv) {
            // /search 返空或 404:SKU 未在平台找到
            return sendResponse({ ok: false, error: 'NOT_FOUND', message: `SKU ${message.sku} 未在平台找到` });
          }
          return sendResponse({ ok: true, data: sv });
        }

        // searchProductBySku —— 降级链:searchVariants 没命中时全平台搜索
        // 对齐原项目 case 'searchProductBySku',只调 /search 不做 bundle 补充
        case 'searchProductBySku': {
          const senderTabId = sender?.tab?.id || null;
          const items = await self.SellerPortalClient.searchProductBySku(message.sku, { preferTabId: senderTabId });
          return sendResponse({ ok: true, data: { items } });
        }

        // syncSellerCookies —— 刷新 seller.ozon.ru 登录态(403/401 重试前调)
        case 'syncSellerCookies': {
          const r = await self.SellerPortalClient.syncSellerCookies();
          return sendResponse({ ok: true, data: { synced: r } });
        }

        // ── Phase 4:视频转存(mock 开关:false=真实 media-storage/upload-file;true=mock) ─
        case 'uploadFollowSellVideo': {
          const useMock = self.MOCK_SELLER_CONFIG?.enabled === true;
          try {
            const r = useMock
              ? await self.MockSellerPortal.uploadVideo(message.srcUrl)
              : await self.SellerPortalClient.transferVideoToOzon(message.srcUrl);
            if (!r.ok) return sendResponse({ ok: false, error: r.error, message: r.message });
            return sendResponse({ ok: true, data: { url: r.url } });
          } catch (e) {
            return sendResponse({ ok: false, error: e?.message || String(e) });
          }
        }

        // ── Phase 6:提交(viaPortal=true → importViaPortal) ───
        case 'followSell': {
          const targetStoreId = message.storeId || storeId;
          if (message.viaPortal) {
            console.log('[followSell] viaPortal: items=', message.items?.length);
            const preferTabId = sender?.tab?.id || null; // 透传给建品三步走跨域快路
            const portalResult = await self.importViaPortal(message, token, targetStoreId, preferTabId);
            console.log('[followSell] portal response:', JSON.stringify(portalResult).slice(0, 200));
            return sendResponse({ ok: true, data: portalResult });
          }
          // 官方 API 路径:POST /ozon/products/import(ERP 调 OPI /v3/product/import)
          console.log('[followSell] 官方 API 路径(/ozon/products/import)');
          const data = await self.ErpClient.importProducts(message, token, targetStoreId);
          return sendResponse({ ok: true, data });
        }

        // ── Phase 7:门户上架结果轮询(真实访问 seller.ozon.ru) ─
        // 对齐原项目 case 'portalImportStatus':
        //   getUploadTaskList 从 /async-upload/v1/task/get-list 找 taskId
        //   failed>0 时 getUploadTaskErrors 拉 /async-upload/v1/task/get-errors
        case 'portalImportStatus': {
          const taskId = message.taskId;
          if (!taskId) return sendResponse({ ok: false, error: '缺少 taskId' });
          const senderTabId = sender?.tab?.id || null;
          const companyId = message.companyId || (await self.SellerPortalClient.resolveSellerCompanyId());
          if (!companyId) return sendResponse({ ok: false, error: 'sc_company_id cookie 未找到' });
          const list = await self.SellerPortalClient.getUploadTaskList(companyId, { limit: 30, page: 1 }, senderTabId);
          const task = (list?.tasks || []).find((t) => String(t.id) === String(taskId)) || null;
          let errors = [];
          const failed = Number(task?.failed || 0);
          if (task && failed > 0) {
            const errResp = await self.SellerPortalClient.getUploadTaskErrors(
              companyId,
              taskId,
              { page: 1, page_size: 50 },
              senderTabId
            );
            errors = (errResp?.task_item_errors || []).map((e) => ({
              offer_id: e.offer_id,
              errors: (e.errors || []).map((x) => ({
                code: x.code,
                field: x.field,
                level: x.level,
                message: x?.texts?.description || x.code,
              })),
            }));
          }
          const size = Number(task?.size || 0);
          const processed = Number(task?.processed || 0);
          const warned = Number(task?.warned || 0);
          const done = !!task && size > 0 && processed >= size;
          return sendResponse({
            ok: true,
            data: {
              taskId: String(taskId),
              found: !!task,
              status: task?.status || null,
              size,
              processed,
              failed,
              warned,
              done,
              errors,
            },
          });
        }

        // 查询商品最终状态(创建/审核/可售) —— 走 OPI /v3/product/info/list
        // 上架后调用,确认商品是否真正创建成功
        case 'productInfo': {
          const offerIds = Array.isArray(message.offerIds) ? message.offerIds : [];
          if (offerIds.length === 0) return sendResponse({ ok: false, error: '缺少 offerIds' });
          const resp = await self.ErpClient.post('/ozon/products/info', { offer_ids: offerIds });
          return sendResponse({ ok: true, data: resp });
        }

        // 查询上架任务进度 —— 走 OPI /v1/product/import/info
        // 直接调 ERP /ozon/products/import-info 端点(不查本地表,viaPortal task_id 也能查)
        case 'productImportInfo': {
          const taskId = message.taskId;
          if (!taskId) return sendResponse({ ok: false, error: '缺少 taskId' });
          const resp = await self.ErpClient.post('/ozon/products/import-info', { task_id: String(taskId) });
          return sendResponse({ ok: true, data: resp });
        }

        default:
          return sendResponse({ ok: false, error: `未知消息类型: ${type}` });
      }
    } catch (e) {
      console.warn('[SW] message error:', type, e?.message || e);
      return sendResponse({ ok: false, error: e?.message || String(e), code: e?.code });
    }
  })();
  return true; // async
});

console.log(
  '[SW] booted: erp-client + mock-seller-portal + import-via-portal (base:',
  self.ErpClient.DEFAULT_BASE_URL,
  ')'
);

// ────────────────────────────────────────────────────────────
// 右键菜单 —— 搜索 1688 货源(以图搜货)
// ────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'xy-image-search-1688',
      title: '搜索1688货源',
      contexts: ['image'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'xy-image-search-1688' || !info.srcUrl) return;
  const encoded = encodeURIComponent(info.srcUrl);
  const targetUrl = `https://s.1688.com/youyuan/index.htm?tab=imageSearch&__xyOzonImg=${encoded}`;
  chrome.tabs.create({ url: targetUrl });
});
