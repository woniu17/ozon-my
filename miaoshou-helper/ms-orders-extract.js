/**
 * 妙手历史订单页数据提取(content script,隔离世界)
 * 注入到 erp.91miaoshou.com/order/package/all 页面。
 *
 * 职责:在页面同源 context 调用妙手内部 API,翻页提取全部订单数据
 *   (主列表 searchOrderPackageList + 采购信息 getOpOrderPackageIdAndOutboundInfoMap),
 *   精简后返回给 background.js → ERP 后端。
 *
 * 协议:background.js 通过 chrome.tabs.sendMessage 发 MS_EXTRACT_ORDERS →
 *       本脚本翻页提取 → 返回 { ok, orders } 给 background。
 *
 * 签名头策略:
 *   方案 A(首选):content script 直接 fetch,cookie 自动携带,不传 x-app-hippo
 *   方案 B(降级):若 A 返回 401/403,注入主世界脚本 hook window.fetch,
 *                 拦截页面自身 API 响应 + DOM 点击"下一页"驱动翻页
 */
(() => {
  'use strict';

  const MS_LIST_API = '/api/order/package/render_list/searchOrderPackageList';
  const MS_OUTBOUND_API = '/api/order/package/render_list/getOpOrderPackageIdAndOutboundInfoMap';
  const PAGE_SIZE = 20;
  const PAGE_DELAY_MS = 800; // 翻页间隔,避免频率限制
  const MAX_PAGES = 200; // 安全上限

  // 基础查询参数(对齐妙手历史订单页默认筛选)
  const BASE_PARAMS = {
    source: 'orderHistory',
    appPackageTab: 'all',
    sortField: 'gmtOrderStart',
    sortType: 'desc',
    waitProcessTab: 'all',
    supplierProcessStatus: 'all',
    isLogisticsCompanyGroupMode: '1',
    priceType: 'profit',
    // 搜索字段匹配模式(ss=模糊, eq=精确, g=大于)
    goodsSkuOuterIdRp: 'ss',
    platformOuterSkuIdRp: 'ss',
    purchaseLogisticsKeywordRp: 'eq',
    logisticsKeywordRp: 'eq',
    platformOrderSnsRp: 'eq',
    appPackageNosRp: 'eq',
    appPackageNos: '',
    purchaseOrderSnRp: 'eq',
    platformItemNumRp: 'eq',
    warehouseShelfCellCodeRp: 'ss',
    remarkRp: 'ss',
    skuSubNameRp: 'ss',
    packageWeighingWeightRp: 'g',
    itemTitleRp: 'ss',
    consigneeZipCodeRp: 'ss',
    sourceItemIdsRp: 'eq',
    platformOrderSns: '',
    gmtLastDeliveryFrom: '',
    gmtLastDeliveryTo: '',
    orderTagsRp: 'includeAll',
    logisticsGroupType: 'cascader',
  };

  let extracting = false;

  // ============ 方案 A:直接 fetch ============

  /**
   * 提取单页:主列表 + 采购信息
   * @returns {{ packages: Array, outbound: Object, total?: number }}
   */
  async function fetchPage(page) {
    const listBody = new URLSearchParams({ ...BASE_PARAMS, page: String(page), pageSize: String(PAGE_SIZE) });
    const listResp = await fetch(MS_LIST_API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: listBody.toString(),
    });
    if (listResp.status === 401 || listResp.status === 403) {
      throw new Error('MS_AUTH_REQUIRED: 妙手登录态失效,请在浏览器中重新登录 erp.91miaoshou.com');
    }
    if (!listResp.ok) throw new Error(`MS_HTTP_${listResp.status}`);
    const listData = await listResp.json().catch(() => null);
    if (!listData || listData.result !== 'success') {
      throw new Error('MS_BAD_RESPONSE: 主列表接口返回异常');
    }
    const packages = listData.packageList || [];

    // 批量获取采购信息
    const ids = packages.map((p) => p.opOrderPackageId).filter(Boolean);
    if (!ids.length) return { packages: [], outbound: {} };

    const obBody = new URLSearchParams();
    ids.forEach((id, i) => obBody.append(`opOrderPackageIds[${i}]`, id));
    const obResp = await fetch(MS_OUTBOUND_API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: obBody.toString(),
    });
    if (obResp.ok) {
      const obData = await obResp.json().catch(() => null);
      if (obData && obData.result === 'success') {
        return { packages, outbound: obData.opOrderPackageIdAndOutboundInfoMap || {} };
      }
    }
    // 采购信息获取失败不影响主数据
    return { packages, outbound: {} };
  }

  /**
   * 全量提取(自动翻页)
   * @param {{ onProgress?: Function, onBatch?: Function, maxPages?: number }} opts
   *   onBatch(orders): 每提取完一页立即回调该页精简订单(分批上报,页面侧逐批入库)
   * @returns {Array} 精简后的订单数组(全量,供调用方汇总)
   */
  async function extractAll({ onProgress, onBatch, maxPages = MAX_PAGES } = {}) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const { packages, outbound } = await fetchPage(page);
      if (!packages.length) break;

      // 合并采购信息到 package 并精简
      const pageOrders = packages.map((pkg) => {
        const ob = outbound[pkg.opOrderPackageId] || {};
        return simplify(pkg, ob);
      });
      all.push(...pageOrders);

      onProgress?.({ page, count: all.length });
      onBatch?.(pageOrders);

      // 不足一页 = 最后一页
      if (packages.length < PAGE_SIZE) break;

      // 翻页间隔
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
    return all;
  }

  // ============ 数据精简 ============

  /**
   * 将妙手 API 原始响应精简为 ERP 后端入库需要的字段
   * 对齐 miaoshou_package / miaoshou_purchase 表结构
   */
  function simplify(pkg, outbound) {
    const purchaseOrders = Object.values(outbound.purchaseOrders || {});
    const oi = pkg.orderInfo || {};
    return {
      // ── 主表 miaoshou_package ──
      opOrderPackageId: pkg.opOrderPackageId,
      appPackageNo: pkg.appPackageNo,
      postingNumber: pkg.platformPackageId,
      shopId: pkg.shopId,
      shopNick: pkg.shopNick,
      platformOrderSn: oi.platformOrderSn,
      orderAmount: oi.orderAmount ? parseFloat(oi.orderAmount) : null,
      buyerName: oi.buyerUsername || null,
      buyerCountry: oi.buyerCountry || null,
      gmtOrderStart: oi.gmtOrderStart || null,
      // ★称重重量 + 本地备注
      weighingWeight: pkg.packageWeighingWeight ? parseFloat(pkg.packageWeighingWeight) : null,
      note: pkg.appNote || null,
      operateStatus: pkg.appPackageOperateStatus || null,
      purchaseStatus: pkg.appPurchaseStatus || null,
      // ★妙手自身 tab 分组值(waitProcess/waitShip/submitPlatform/waitReceiverConfirm/closed/isolation)
      // 操作状态(appPackageOperateStatus)会分散在多个 tab(如 wait_audit 同时出现在待处理与已关闭),
      // tab 分类必须用 appPackageTab
      appPackageTab: pkg.appPackageTab || null,
      platformPackageStatus: pkg.platformPackageStatus || null,   // cancelled/...
      appPackageStatusText: pkg.appPackageStatusText || null,    // 已退款/...
      // ★妙手算好的采购金额(CNY,来自 orderPackageAmountDetail.CNYPurchasePrice)
      // outbound 接口的手工单(other 平台)purchaseOrderPayment 恒为 null,此字段可兜底
      purchaseAmount: pkg.orderPackageAmountDetail?.CNYPurchasePrice != null
        ? parseFloat(pkg.orderPackageAmountDetail.CNYPurchasePrice)
        : null,
      logisticsNo: pkg.logisticsNo || null,
      logisticsCompany: pkg.logisticsCompany || null,
      gmtCreate: pkg.gmtCreate || null,
      gmtModified: pkg.gmtModified || null,
      gmtDelivery: pkg.gmtDelivery || null,
      // ── 商品信息(pkg.items 按 opOrderItemId 键的对象,对齐订单处理页产品展示)──
      items: Object.values(pkg.items || {}).map((it) => ({
        title: it.title || null,
        skuSubName: it.skuSubName || null,
        sku: it.platformOuterSkuId || it.platformItemNum || null,
        quantity: parseInt(it.quantity, 10) || 1,
        price: it.discountedPrice != null ? parseFloat(it.discountedPrice)
          : (it.originalPrice != null ? parseFloat(it.originalPrice) : null),
        picUrl: it.originalPicUrl || it.picUrl || null, // 优先 Ozon CDN 直链
        pdpUrl: it.url || null,
      })),
      // raw 字段不传(减小 payload,避免 413;审计可随时从妙手重新提取)
      // ── 子表 miaoshou_purchase ──
      purchases: purchaseOrders.map((po) => {
        const pkg0 = (po.purchaseOrderPackages || [])[0] || {};
        return {
          purchaseOrderId: po.purchaseOrderId,
          purchaseSn: po.purchaseOrderSn,
          platform: po.purchasePlatform,
          platformName: po.purchasePlatformName || null,
          detailUrl: po.purchaseOrderDetailUrl || null,
          buyerAccount: po.purchaseOrderBuyer,
          sellerName: po.purchaseOrderSeller,
          paymentAmount: po.purchaseOrderPayment ? parseFloat(po.purchaseOrderPayment) : 0,
          items: (po.items || []).map((pi) => ({
            title: pi.purchaseOrderItemTitle || null,
            price: pi.purchasePrice != null ? parseFloat(pi.purchasePrice) : null,
            num: parseInt(pi.purchaseNum, 10) || 1,
          })),
          status: po.purchaseOrderStatus,
          purchaseStartTime: po.purchaseOrderStartTime,
          sendAt: po.purchaseOrderSendTime,
          logisticsCompany: pkg0.purchaseOrderLogisticsName || null,
          logisticsNo: pkg0.purchaseOrderWaybillCode || null,
          lastTrace: pkg0.lastLogisticsTrace || null,
        };
      }),
    };
  }

  // ============ 消息监听 ============

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;

    // 健康检查
    if (msg.type === 'MS_PING') {
      sendResponse({ ok: true, url: location.href });
      return false;
    }

    // 开始提取
    if (msg.type === 'MS_EXTRACT_ORDERS') {
      if (extracting) {
        sendResponse({ ok: false, error: '提取进行中,请等待完成' });
        return false;
      }
      extracting = true;
      const maxPages = msg.payload?.maxPages || MAX_PAGES;
      // 立即 ack(同步已启动);订单数据经 MS_BATCH 每页分批上报,
      // 结束/失败经 MS_DONE / MS_ERROR 通知(避免一次性大响应与超时)
      sendResponse({ ok: true, started: true });
      extractAll({
        maxPages,
        onProgress: (p) => {
          // 向 background 上报进度(非阻塞,失败忽略)
          try {
            chrome.runtime.sendMessage({ type: 'MS_PROGRESS', ...p });
          } catch { /* ignore */ }
        },
        onBatch: (orders) => {
          // 每页一批,立即上报给页面侧入库(非阻塞,失败忽略)
          try {
            chrome.runtime.sendMessage({ type: 'MS_BATCH', orders });
          } catch { /* ignore */ }
        },
      })
        .then((orders) => {
          extracting = false;
          try { chrome.runtime.sendMessage({ type: 'MS_DONE', count: orders.length }); } catch { /* ignore */ }
        })
        .catch((err) => {
          extracting = false;
          try { chrome.runtime.sendMessage({ type: 'MS_ERROR', error: String(err?.message || err) }); } catch { /* ignore */ }
        });
      return false; // 已同步 sendResponse
    }

    return false;
  });
})();
