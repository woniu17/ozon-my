// 模拟手动上架(viaPortal=true)编排核心 —— 对齐原项目 importViaPortal (service-worker.js:644)。
//
// 三段式编排:
//   6a. ErpClient.prepareBundleItems        🔴 ERP 备料+加工+公司校验(真实 /ozon/products/prepare-bundle-items)
//   6b. MockSellerPortal.createBundle       🟢 建空草稿
//   6c. MockSellerPortal.updateBundleItems  🟢 写入商品数据
//   6d. MockSellerPortal.uploadBundle       🟢 提交发布 → upload_task_id
//
// 公司一致性护栏:ERP 给的 store_company_id 必须与浏览器当前登录 seller.ozon.ru 的
// sc_company_id 一致,否则立即中止(对齐原项目 service-worker.js:658-666)。
//
// 失败处理:逐 bundle try/catch,单个失败不阻断其余,最终聚合成 bundleErrors。
// 全部失败抛错(对齐原项目 行 683-685)。

(function () {
  'use strict';

  async function importViaPortal(message, token, targetStoreId) {
    console.log('[importViaPortal] start: items=', message?.items?.length);

    // ── 6a. ERP prepare-bundle-items(🔴 必经) ──────────────────────
    const prep = await self.ErpClient.prepareBundleItems(message, token, targetStoreId);
    const result = prep?.result || {};
    const bundles = Array.isArray(result.bundles) ? result.bundles : [];
    if (bundles.length === 0) {
      throw new Error(result.message || '无可上架商品(源数据不可用或被严格模式跳过)');
    }
    console.log('[importViaPortal] 6a prepare → bundles=', bundles.length);

    // ── 解析当前登录 seller.ozon.ru 的 sc_company_id(真实读 cookie) ──
    const companyId = await self.SellerPortalClient.resolveSellerCompanyId();
    if (!companyId) {
      throw new Error('sc_company_id cookie 未找到,请先登录 seller.ozon.ru');
    }

    // ── 公司一致性护栏 ───────────────────────────────────────────────
    // 后端给了目标店铺的 company_id 且与当前登录不一致 → 会建到错误店铺,立即中止并提示。
    const storeCompanyId = result.store_company_id ? String(result.store_company_id) : '';
    if (storeCompanyId && storeCompanyId !== String(companyId)) {
      throw new Error(
        `所选店铺与当前 seller.ozon.ru 登录店铺不一致(目标 ${storeCompanyId} / 当前 ${companyId}),` +
          '门户上架请先在浏览器切换到该店铺登录'
      );
    }

    // ── 6b/6c/6d:逐 bundle 三步建品(🟢 seller portal,绕官方限流) ──
    const taskIds = [];
    const bundleIds = [];
    const bundleErrors = [];

    for (const b of bundles) {
      try {
        // 6b. 建空草稿
        const bundleId = await self.MockSellerPortal.createBundle(companyId);
        // 6c. 写入商品数据
        await self.MockSellerPortal.updateBundleItems(
          bundleId,
          companyId,
          b.items,
          b.source,
          b.description_category_lvl3_name
        );
        // 6d. 提交发布 → upload_task_id
        const taskId = await self.MockSellerPortal.uploadBundle(bundleId, companyId);
        bundleIds.push(bundleId);
        taskIds.push(taskId);
        console.log(`[importViaPortal] bundle ${bundleId} → task ${taskId}`);
      } catch (e) {
        const offers = Array.isArray(b.items) ? b.items.map((x) => x.offer_id).filter(Boolean) : [];
        bundleErrors.push({ offers, error: e?.message || String(e) });
        console.warn('[importViaPortal] bundle 失败:', offers.join(','), e?.message || e);
      }
    }

    if (taskIds.length === 0) {
      throw new Error(`门户上架失败: ${bundleErrors.map((x) => x.error).join('; ') || '未知错误'}`);
    }

    // 返回形状对齐原项目(行 686-697)
    return {
      result: {
        viaPortal: true,
        task_id: taskIds[0],
        task_ids: taskIds,
        bundle_ids: bundleIds,
        company_id: companyId,
        strictSkipped: result.strictSkipped || [],
        invalidImage: result.invalidImage || [],
        bundleErrors,
      },
    };
  }

  self.importViaPortal = importViaPortal;
})();
