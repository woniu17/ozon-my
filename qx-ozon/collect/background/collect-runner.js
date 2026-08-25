/* =========================================================
 * 采集执行层(采集代码隔离 Phase 3)
 *
 * 从 service-worker.js 提取的采集执行相关代码,采用 init 桥接模式:
 *   - 注册 globalThis.__jzCollect.setupRunner 函数
 *   - 由 __jzCollect.init() 在 IIFE 工具函数就绪后调用
 *   - 通过 this._sw 访问 SW 工具(getBackendUrl/apiRequest/getStorage/setStorage/
 *     removeStorage/STORAGE_KEYS/loadAutoCollectConfig)
 *   - 通过 __jzCollect.xxx 访问缓存/配置层暴露的函数
 *
 * 覆盖范围(A 类:纯函数 + 仅依赖 Cache/Bridge 的函数):
 *   - normalizeSearchVariantToSv(/search → sv shape 归一,纯函数)
 *   - classifyStoreByRules(店铺中国身份分类规则引擎,纯函数)
 *   - _erpStoreClassGet/Set(ERP 店铺分类 CRUD)
 *   - _erpStoreSkuReport(ERP 店铺-SKU 关联上报)
 *   - checkStoreClassification(三层查询:L1 chrome.storage → L2 MongoDB → 规则引擎)
 *   - manualClassifyStore(人工确认分类)
 *   - _handleAntibot(反爬熔断:暂停 10 分钟 + 通知 + 写日志)
 *   - _checkAllCachesHit(7 类缓存前置检查)
 *
 * 暂留 service-worker.js(B 类:依赖未迁移的 Tab/限流层):
 *   - fetchBundleByVariantId(依赖 fetchSellerPortal)
 *   - transferVideoToOzon(依赖 ensureSellerTab)
 *   - fetchPdpBundleViaBuyerTab(依赖 ensureBuyerTab)
 *   - _fetchMarketStatsDirect(依赖 ensureSellerTab + _sellerPortalGate)
 *   - _doAutoCollect(依赖 fetchSellerPortal + 上述 4 个 B 类函数)
 *   - _isCircuitBreakerActive(依赖 _loadQueueMeta)
 *   - _acquireAutoCollectSlot/_releaseAutoCollectSlot + 4 个并发状态变量(仅 _doAutoCollect 调用)
 *   - normalizeMarketItem/_isRichDoc/_extract*FromStates(仅 B 类函数调用)
 *
 * 待 Phase 3 后续阶段迁移 Tab/限流层后,B 类函数可统一迁入本文件。
 * ========================================================= */

(() => {
  globalThis.__jzCollect.setupRunner = function () {
    const sw = this._sw;

    // ── /search → sv shape 归一(纯函数) ──────────────────────────────────────
    // /api/v1/search 不返物理 attributes(weight/dimensions/description),需把扁平字段
    // 转成 attributes 数组(shape 与 create-bundle-by-variant-id 一致)。
    // 已是 sv shape(含 attributes 数组)→ 原样返回。
    this.normalizeSearchVariantToSv = (v) => {
      if (!v) return null;
      // 已是 sv shape(含 attributes 数组)→ 原样返回
      if (Array.isArray(v.attributes) && v.attributes.length > 0) return v;
      const attributes = [];
      if (v.description_type_name) attributes.push({ key: '8229', value: v.description_type_name });
      if (v.brand_name) attributes.push({ key: '85', value: v.brand_name });
      // /search 商品名实际字段是 variant_name;title/name 兜底(少数 shape 用过)
      const productName = v.variant_name || v.title || v.name;
      if (productName) attributes.push({ key: '4180', value: productName });
      if (v.description) attributes.push({ key: '4191', value: v.description });
      if (v.main_image) attributes.push({ key: '4194', value: v.main_image });
      const secondaries = Array.isArray(v.secondary_images) ? v.secondary_images : [];
      if (secondaries.length > 0) attributes.push({ key: '4195', collection: secondaries });
      // GTIN(7822) — 从 /search 的 barcodes 兜底,后端 mapping 时若目标类目含 7822 会自动 copy 进 item.attributes
      if (Array.isArray(v.barcodes) && v.barcodes.length > 0) {
        const gtin = String(v.barcodes[0] || '').trim();
        if (gtin) attributes.push({ key: '7822', value: gtin });
      }
      return {
        // variant_id 优先 /search 真返的 variant_id,barcode 兜底
        variant_id: v.variant_id || (v.barcodes && v.barcodes[0]) || '',
        description_category_id: Number(v.description_type_dict_value) || 0,
        categories: (v.categories || []).map((c) => ({
          id: Number(c.id),
          level: Number(c.level),
          name: c.name || '',
          title: c.title || c.name || '',
        })),
        // 把 /search 的额外字段也带上,方便上层(如跟卖面板的 is_copy_allowed 检查)使用
        _searchMeta: {
          skus: v.skus || [],
          barcodes: v.barcodes || [],
          brand_id: v.brand_id,
          is_copy_allowed: v.is_copy_allowed,
          is_content_copy_allowed: v.is_content_copy_allowed,
          rating: v.rating,
        },
        attributes,
      };
    };

    // ── 店铺中国身份分类:规则引擎(纯函数) ─────────────────────────────────────
    // 规则覆盖 known 列表 + companyInfo.country,无匹配返回 null(等待人工确认)。
    // 2026-08:改用 sellerId 作为店铺主键,slug 不再参与分类(可变,不稳定)
    this.classifyStoreByRules = (sellerId, name, companyInfo, config) => {
      if (!config) {
        console.log('[store-class] classifyStoreByRules: no config, returning null', { sellerId });
        return { isMainlandChina: null, by: null };
      }
      console.log('[store-class] classifyStoreByRules input:', {
        sellerId,
        name,
        companyInfo,
        knownMainlandChinaSellerIds: config.knownMainlandChinaSellerIds,
        knownNonMainlandChinaSellerIds: config.knownNonMainlandChinaSellerIds,
      });
      // Rule 1: knownMainlandChinaSellerIds
      if (Array.isArray(config.knownMainlandChinaSellerIds) && config.knownMainlandChinaSellerIds.includes(sellerId)) {
        console.log('[store-class] Rule 1 hit: knownMainlandChinaSellerIds → isMainlandChina=true');
        return { isMainlandChina: true, by: 'rule:known-list' };
      }
      // Rule 2: knownNonMainlandChinaSellerIds
      if (Array.isArray(config.knownNonMainlandChinaSellerIds) && config.knownNonMainlandChinaSellerIds.includes(sellerId)) {
        console.log('[store-class] Rule 2 hit: knownNonMainlandChinaSellerIds → isMainlandChina=false');
        return { isMainlandChina: false, by: 'rule:known-list' };
      }
      // Rule 3: companyInfo.country === 'CN'
      if (companyInfo && companyInfo.country === 'CN') {
        console.log('[store-class] Rule 3 hit: companyInfo.country=CN → isMainlandChina=true');
        return { isMainlandChina: true, by: 'rule:company-country' };
      }
      // Rule 4: companyInfo.country 已知且非 CN
      if (companyInfo && companyInfo.country && companyInfo.country !== 'CN') {
        console.log('[store-class] Rule 4 hit: companyInfo.country=' + companyInfo.country + ' → isMainlandChina=false');
        return { isMainlandChina: false, by: 'rule:company-country' };
      }
      console.log('[store-class] No rule matched → isMainlandChina=null (need manual confirm)');
      return { isMainlandChina: null, by: null };
    };

    // ── ERP 店铺分类 CRUD(L2 MongoDB) ────────────────────────────────────────
    // 2026-08:彻底去 slug,只用 sellerId(稳定主键,_id = sellerId)
    // GET /admin/api/store-classification/:sellerId — 返回分类记录或 null
    this._erpStoreClassGet = async (sellerId) => {
      if (!sellerId) return null;
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        const r = await sw.apiRequest(
          'GET',
          `${url}/admin/api/store-classification/${encodeURIComponent(sellerId)}`,
          null,
          stored[sw.STORAGE_KEYS.token]
        );
        // ERP 返回 { ok: true, data: { isMainlandChina, classifiedBy, ... } },解包取 data
        return r?.data || null;
      } catch (e) {
        console.warn(`[store-class] ERP get failed sellerId=${sellerId}:`, e?.message || e);
        return null;
      }
    };

    // POST /admin/api/store-classification/:sellerId(upsert)
    // record: { sellerName, isMainlandChina, classifiedBy, companyInfo, lastSeenAt }
    this._erpStoreClassSet = async (sellerId, record) => {
      if (!sellerId || !/^\d+$/.test(String(sellerId))) {
        console.warn('[store-class] ERP set skipped: sellerId missing or non-numeric', { sellerId, recordSellerId: record?.sellerId });
        return false;
      }
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        await sw.apiRequest(
          'POST',
          `${url}/admin/api/store-classification/${encodeURIComponent(sellerId)}`,
          record,
          stored[sw.STORAGE_KEYS.token]
        );
        return true;
      } catch (e) {
        console.warn(`[store-class] ERP set failed sellerId=${sellerId}:`, e?.message || e);
        return false;
      }
    };

    // POST /admin/api/store-sku(upsert SKU-店铺关联)
    // 由 content script panel 加载时(reportStoreSku 消息)和 SW autoCollect 完成时调用。
    // payload: { sku, sellerId, sellerSlug, sellerName, lastCollectAt?, lastCollectStatus?, lastCollectResults? }
    this._erpStoreSkuReport = async (payload) => {
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        await sw.apiRequest('POST', `${url}/admin/api/store-sku`, payload, stored[sw.STORAGE_KEYS.token]);
        return true;
      } catch (e) {
        console.warn(`[store-sku] ERP report failed sku=${payload?.sku}:`, e?.message || e);
        return false;
      }
    };

    // ── L1 命中时异步补查 L2 一致性 ────────────────────────────────────────────
    // 场景:L1 缓存命中直接返回,但 L2(ERP)可能因历史写入失败(后端不可达/401/网络)
    // 而缺失。此方法后台静默检查 L2 是否存在且有效,缺失则补写,补写失败则清 L1
    // 避免脏缓存(下次访问将重新走 L2 → 规则引擎)。
    // 不阻塞 checkStoreClassification 返回(店铺分类非关键路径)。
    this._ensureL2Consistency = async (sellerId, name, companyInfo, l1) => {
      const l2 = await this._erpStoreClassGet(sellerId);
      console.log('[store-class] L2 consistency check, L2:', l2);
      if (l2 && l2.isMainlandChina !== null && l2.isMainlandChina !== undefined && l2.classifiedBy) {
        return; // L2 有效,无需补写
      }
      // L2 缺失或脏数据,补写
      const ok = await this._erpStoreClassSet(
        sellerId,
        {
          sellerId,
          sellerName: name,
          isMainlandChina: l1.isMainlandChina,
          classifiedBy: l1.classifiedBy,
          companyInfo: companyInfo || null,
          lastSeenAt: new Date().toISOString(),
        }
      );
      if (!ok) {
        // L2 补写失败,清 L1 避免下次还走脏缓存(下次会重新走 L2 → 规则引擎)
        try {
          await sw.removeStorage([`jz-store-class-${sellerId}`]);
        } catch (_) {
          /* ignore */
        }
        console.warn(`[store-class] L2 补写失败,L1 已清除 sellerId=${sellerId}(下次访问将重新分类)`);
      } else {
        console.log(`[store-class] L2 补写成功 sellerId=${sellerId}`);
      }
    };

    // ── 三层查询:L1 chrome.storage.local → L2 MongoDB → 规则引擎 ────────────────
    // 返回 { isMainlandChina, classifiedBy, sellerId } | null(未分类,等待人工确认)。
    // 2026-08:彻底去 slug,只用 sellerId(稳定主键,slug 可变不再参与分类)
    this.checkStoreClassification = async (sellerId, name, companyInfo) => {
      if (!sellerId) return null;
      console.log('[store-class] checkStoreClassification called:', { sellerId, name, companyInfo });
      const config = await sw.loadAutoCollectConfig();
      console.log('[store-class] config loaded:', {
        knownMainlandChinaSellerIds: config?.knownMainlandChinaSellerIds,
        knownNonMainlandChinaSellerIds: config?.knownNonMainlandChinaSellerIds,
      });

      // L1: chrome.storage.local
      // 注意:classifiedBy 为空字符串的记录视为无效(历史 bug:ERP 前端 updateStoreClass
      // 不传 classifiedBy 导致后端写空字符串),不信任 L1,继续查 L2 让规则引擎重新分类。
      const l1Key = `jz-store-class-${sellerId}`;
      try {
        const l1 = (await sw.getStorage([l1Key]))?.[l1Key];
        console.log('[store-class] L1 chrome.storage:', l1);
        if (l1 && l1.isMainlandChina !== null && l1.isMainlandChina !== undefined && l1.classifiedBy) {
          console.log('[store-class] L1 hit →', { isMainlandChina: l1.isMainlandChina, classifiedBy: l1.classifiedBy });
          // 异步补查 L2 一致性:若 L2 缺失(历史写入失败)则补写,补写失败则清 L1。
          // 不阻塞返回(店铺分类非关键路径,L2 修复后台静默进行)
          this._ensureL2Consistency(sellerId, name, companyInfo, l1).catch((e) => {
            console.warn(`[store-class] L2 consistency check failed sellerId=${sellerId}:`, e?.message || e);
          });
          return { isMainlandChina: l1.isMainlandChina, classifiedBy: l1.classifiedBy, sellerId };
        }
        // L1 无效或 classifiedBy 为空:清除旧记录,避免下次再被读到
        if (l1 && (!l1.classifiedBy || l1.isMainlandChina === null || l1.isMainlandChina === undefined)) {
          await sw.removeStorage([l1Key]);
          console.log('[store-class] L1 cleared (invalid classifiedBy):', l1);
        }
      } catch (e) {
        console.warn(`[store-class] L1 get failed sellerId=${sellerId}:`, e?.message || e);
      }

      // L2: MongoDB
      // 注意:与 L1 同样的校验 — classifiedBy 为空字符串的记录视为无效(历史 bug:
      // ERP 前端 updateStoreClass 不传 classifiedBy 导致后端写空字符串),不信任 L2,
      // 继续走规则引擎让 country=CN 等规则重新分类并覆盖脏记录。
      const l2 = await this._erpStoreClassGet(sellerId);
      console.log('[store-class] L2 MongoDB:', l2);
      if (l2 && l2.isMainlandChina !== null && l2.isMainlandChina !== undefined && l2.classifiedBy) {
        console.log('[store-class] L2 hit →', { isMainlandChina: l2.isMainlandChina, classifiedBy: l2.classifiedBy });
        try {
          await sw.setStorage({
            [l1Key]: { isMainlandChina: l2.isMainlandChina, classifiedBy: l2.classifiedBy, sellerId },
          });
        } catch (e) {
          console.warn(`[store-class] L1 set failed sellerId=${sellerId}:`, e?.message || e);
        }
        return { isMainlandChina: l2.isMainlandChina, classifiedBy: l2.classifiedBy, sellerId };
      }
      // L2 无效或 classifiedBy 为空:记录日志,后续规则引擎重新分类后会覆盖
      if (l2 && (!l2.classifiedBy || l2.isMainlandChina === null || l2.isMainlandChina === undefined)) {
        console.log('[store-class] L2 ignored (invalid classifiedBy):', l2);
      }

      // 规则引擎
      const ruleResult = this.classifyStoreByRules(sellerId, name, companyInfo, config);
      console.log('[store-class] rule engine result:', ruleResult);
      if (ruleResult.isMainlandChina !== null) {
        const record = {
          sellerId,
          sellerName: name,
          isMainlandChina: ruleResult.isMainlandChina,
          classifiedBy: ruleResult.by,
          companyInfo: companyInfo || null,
          lastSeenAt: new Date().toISOString(),
        };
        try {
          await sw.setStorage({
            [l1Key]: { isMainlandChina: ruleResult.isMainlandChina, classifiedBy: ruleResult.by, sellerId },
          });
        } catch (e) {
          console.warn(`[store-class] L1 set failed sellerId=${sellerId}:`, e?.message || e);
        }
        // await L2 写入:失败时清 L1,避免下次 L1 命中但 L2 缺失的脏缓存
        const l2Ok = await this._erpStoreClassSet(sellerId, record);
        if (!l2Ok) {
          console.warn(`[store-class] L2 write failed, clearing L1 for sellerId=${sellerId}`);
          try {
            await sw.removeStorage([l1Key]);
          } catch (_) {
            /* ignore */
          }
        } else {
          console.log('[store-class] rule result persisted to L1+L2:', record);
        }
        return { isMainlandChina: ruleResult.isMainlandChina, classifiedBy: ruleResult.by, sellerId };
      }

      // 未分类:写 L2 记录(isMainlandChina=null,等待人工确认)
      console.log('[store-class] unclassified, writing null record to L2 (waiting manual confirm)');
      await this._erpStoreClassSet(sellerId, {
        sellerId,
        sellerName: name,
        isMainlandChina: null,
        classifiedBy: null,
        companyInfo: companyInfo || null,
        lastSeenAt: new Date().toISOString(),
      });
      return null;
    };

    // ── 人工确认分类:写 L1 + L2(classifiedBy:'manual') ────────────────────────
    // 入参 { sellerId, name, isMainlandChina } → 返回 { ok: true }
    this.manualClassifyStore = async (sellerId, name, isMainlandChina) => {
      if (!sellerId) return { ok: false, error: 'missing sellerId' };
      const classifiedBy = 'manual';
      const classifiedAt = new Date().toISOString();
      const l1Key = `jz-store-class-${sellerId}`;
      try {
        await sw.setStorage({ [l1Key]: { isMainlandChina, classifiedBy, sellerId } });
      } catch (e) {
        console.warn(`[store-class] L1 set failed sellerId=${sellerId}:`, e?.message || e);
      }
      await this._erpStoreClassSet(sellerId, {
        sellerId,
        sellerName: name,
        isMainlandChina,
        classifiedBy,
        classifiedAt,
        companyInfo: null,
        lastSeenAt: classifiedAt,
      });
      return { ok: true };
    };

    // ── ANTIBOT 分支处理:暂停 10 分钟 + 写日志 + 更新计数器 ────────
    // 由 Step 4/5/6 检测到反爬时调用。返回 { status:'antibot', pausedUntil } 给调用方。
    // sellerId 用于日志写入(稳定主键,slug 可变)
    // 注:antibotDetected 广播已删除 — 前端页面不再展示深度采集状态;
    // saveAutoCollectConfig 写入 paused:true 后,chrome.storage.onChanged 自动触发 popup 重渲,
    // queue 监控页通过自身的 5s 轮询感知状态变化,无需主动广播。
    this._handleAntibot = async (sku, source, sellerSlug, storeClassified, depth, startTime, results, sellerId) => {
      // 熔断时长优先级:ERP app_config.antibot_pause_min > 本地 chrome.storage.antibotPauseMin > 默认 10
      // ERP 配置由采集队列监控页设置,允许运维不依赖扩展 popup 调整熔断策略
      let pauseMin = 10;
      try {
        const cfg = await this.loadAutoCollectConfig();
        pauseMin = Math.max(1, Math.min(120, Math.round(cfg?.antibotPauseMin ?? 10)));
      } catch (_) { /* loadAutoCollectConfig 失败时用默认 10 */ }
      try {
        const sw = this._sw;
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        const token = stored[sw.STORAGE_KEYS.token];
        if (url && token) {
          // 用原生 fetch 而非 sw.apiRequest:apiRequest 在 401 时会清 token,
          // 反爬时 token 过期会导致整个采集流程因缺 token 崩溃,这里不能有副作用。
          // 2s 超时:反爬时需尽快写入 paused:true,不能让 ERP 慢响应拖延熔断生效
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 2000);
          try {
            const resp = await fetch(`${url}/admin/api/app-config?scope=extension`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: ctrl.signal,
            });
            clearTimeout(timer);
            if (resp.ok) {
              const r = await resp.json();
              const erpVal = r?.data?.antibot_pause_min;
              if (typeof erpVal === 'number' && erpVal >= 1 && erpVal <= 120) {
                pauseMin = Math.round(erpVal);
              }
            }
          } catch (e) {
            clearTimeout(timer);
            throw e;
          }
        }
      } catch (e) {
        // ERP 不可达 / 未授权 / 超时:静默回退本地配置
        console.warn('[antibot] 读取 ERP antibot_pause_min 失败,回退本地配置:', e?.message || e);
      }
      const pausedUntil = Date.now() + pauseMin * 60 * 1000;
      await this.saveAutoCollectConfig({ paused: true, pausedUntil });

      // 写日志(fire-and-forget,不阻塞)
      this.writeAutoCollectLog({
        sku,
        source,
        sellerSlug,
        sellerId: sellerId || '',
        storeClassified,
        depth,
        status: 'antibot',
        results,
        totalDuration: Date.now() - startTime,
      });

      // 更新内存计数器
      this.pushAutoCollectRecent(sku, 'antibot', source, storeClassified, results, startTime, 'antibot');

      return { status: 'antibot', pausedUntil };
    };

    // ── 类目黑名单 SW 内存缓存(2026-08 新增) ─────────────────────────────────
    // 深度采集门控B 使用:search+bundle 采集后,检查商品类目是否在黑名单。
    // 数据来源:GET /admin/api/filtered-categories → Map<descCatId, Set<typeId>>
    // TTL 5 分钟(懒刷新),SW 休眠后内存清空,下次使用时重新加载。
    let _filteredCategoriesCache = null; // { map: Map<descCatId, Set<typeId>>, expiresAt }
    const _FILTERED_CATEGORIES_TTL = 5 * 60 * 1000;

    this._loadFilteredCategories = async (force = false) => {
      if (!force && _filteredCategoriesCache && _filteredCategoriesCache.expiresAt > Date.now()) {
        return _filteredCategoriesCache.map;
      }
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        const token = stored[sw.STORAGE_KEYS.token];
        const resp = await sw.apiRequest('GET', `${url}/admin/api/filtered-categories`, null, token);
        // ERP 统一 ok() 包装:{ok:true, data:{items}}(裸 items 兼容旧后端)
        const items = Array.isArray(resp?.data?.items)
          ? resp.data.items
          : Array.isArray(resp?.items)
            ? resp.items
            : [];
        const map = new Map();
        for (const it of items) {
          const descCatId = Number(it.descriptionCategoryId);
          const typeId = Number(it.typeId) || 0;
          if (!Number.isFinite(descCatId) || descCatId <= 0) continue;
          if (!map.has(descCatId)) map.set(descCatId, new Set());
          map.get(descCatId).add(typeId);
        }
        _filteredCategoriesCache = { map, expiresAt: Date.now() + _FILTERED_CATEGORIES_TTL };
        if (map.size === 0) {
          // 空名单大概率异常(响应结构变化/后端数据丢失),warn 提示避免门控B静默失效
          console.warn('[category-filter] 黑名单加载成功但为 0 条(检查后端 /admin/api/filtered-categories 返回结构)');
        } else {
          console.log(`[category-filter] 黑名单加载成功,共 ${map.size} 个类目`);
        }
        return map;
      } catch (e) {
        console.warn('[category-filter] 黑名单加载失败:', e?.message || e);
        // 加载失败时返回空 Map(不阻断采集,等同门控B关闭)
        if (_filteredCategoriesCache?.map) return _filteredCategoriesCache.map;
        return new Map();
      }
    };

    // 检查类目是否在黑名单。typeId 为 0 时(数据缺失)按 descCatId 单维度匹配。
    this._isCategoryFiltered = (descCatId, typeId, map) => {
      if (!map || !descCatId) return false;
      const typeSet = map.get(Number(descCatId));
      if (!typeSet) return false;
      const tid = Number(typeId) || 0;
      // 命中条件:精确 typeId 匹配,或黑名单中存在 typeId=0 的条目(单维度过滤)
      return typeSet.has(tid) || typeSet.has(0);
    };

    // ── 从 search variant + bundle 提取类目 ID(与 index-dao.js syncSku 同源) ────
    // typeId:优先 search variant 的 description_type_dict_value(字段名误用,实际是 type_id);
    //         fallback bundle.type_id(几乎总为空)
    // descCatId:优先 search variant.categories 中 level=3 的类目(OPI 字典要求 level_3_id);
    //           fallback bundle.description_category_id(通常是 level_4,不保证正确);
    //           再 fallback search variant.categories 最深层
    this.extractCategoryIds = (searchVariant, bundleData) => {
      let typeId = 0;
      let descCatId = 0;

      // search variant 优先
      if (searchVariant && typeof searchVariant === 'object') {
        // typeId:description_type_dict_value(字段名误用,实际是 type_id)
        const sTi = Number(searchVariant.description_type_dict_value);
        if (Number.isFinite(sTi) && sTi > 0) typeId = sTi;
        // descCatId:categories 中 level=3 的类目
        if (Array.isArray(searchVariant.categories)) {
          const level3 = searchVariant.categories.find((c) => Number(c.level) === 3);
          if (level3) descCatId = Number(level3.id) || 0;
          // fallback:最深层类目
          if (!descCatId) {
            let deepest = null;
            for (const c of searchVariant.categories) {
              if (!deepest || Number(c.level) > Number(deepest.level)) deepest = c;
            }
            if (deepest) descCatId = Number(deepest.id) || 0;
          }
        }
      }

      // bundle fallback(几乎只有 descCatId,type_id 通常为空)
      if ((!descCatId || !typeId) && bundleData && typeof bundleData === 'object') {
        if (!descCatId) {
          const bDci = Number(bundleData.description_category_id);
          if (Number.isFinite(bDci) && bDci > 0) descCatId = bDci;
        }
        if (!typeId) {
          const bTi = Number(bundleData.type_id);
          if (Number.isFinite(bTi) && bTi > 0) typeId = bTi;
        }
      }

      return { descCatId, typeId };
    };

    // ── 超轻小件判定(2026-08 新增) ─────────────────────────────────────────────
    // 与 index-dao.js buildFilterWhere ultraLight SQL 阈值一致(Ozon Extra Small 官方标准):
    //   重量 < 500g AND 三边之和 < 900mm(90cm)
    // bundle 数据缺失物理参数(weight/depth/width/height 为空或0)→ 视为非超轻小件,返回 false
    this.isUltraLight = (bundleData) => {
      if (!bundleData || typeof bundleData !== 'object') return false;
      const weightG = Number(bundleData.weight);
      const depth = Number(bundleData.depth);
      const width = Number(bundleData.width);
      const height = Number(bundleData.height);
      // 任一参数缺失/无效 → 非超轻小件
      if (![weightG, depth, width, height].every((v) => Number.isFinite(v) && v > 0)) return false;
      const dimSumMm = depth + width + height;
      return weightG < 500 && dimSumMm < 900;
    };

    // ── 前置缓存检查:并行查 5 类合并缓存,返回是否全部命中 ──────────────────────
    // 用于 _handleSubmitTask 入队前快速判断,避免缓存命中任务占用 15s 队列 slot。
    // 逻辑与 _doAutoCollect Step1+Step5 内部缓存查询保持一致,但不做 L1/L2 同步(仅查询)。
    this._checkAllCachesHit = async (sku) => {
      const results = [
        { type: 'card', hit: false },
        { type: 'detail', hit: false },
        { type: 'richMedia', hit: false },
        { type: 'search', hit: false },
        { type: 'bundle', hit: false },
        { type: 'marketStats', hit: false },
        { type: 'followSell', hit: false },
      ];

      try {
        // search 查询:attributeCacheGet('search') 返回 searchData(即 { items: [...] })
        const searchHitP = (async () => {
          try {
            const cached = await this.attributeCacheGet(sku, 'search');
            return !!(cached && Array.isArray(cached.items) && cached.items.length > 0);
          } catch (e) {
            return false;
          }
        })();

        // bundle 查询:attributeCacheGet('bundle') 返回 { data, bundleId, attrsEmptyVerifiedAt, fetchedAt }
        const bundleHitP = (async () => {
          try {
            const cached = await this.attributeCacheGet(sku, 'bundle');
            return this.bundleUsable(cached);
          } catch (e) {
            return false;
          }
        })();

        // 5 类合并缓存 + search + bundle,全部并行
        const [card, detail, pdp, marketStats, followSell, searchHit, bundleHit] = await Promise.all([
          this.domCacheGet(sku, 'card').catch(() => null),
          this.domCacheGet(sku, 'detail').catch(() => null),
          this.richMediaCacheGet(sku).catch(() => null),
          this.marketStatsCacheGet(sku).catch(() => null),
          this.followSellCacheGet(sku).catch(() => null),
          searchHitP,
          bundleHitP,
        ]);

        results[0].hit = !!card;
        results[1].hit = !!detail;
        results[2].hit = !!pdp;
        results[3].hit = !!searchHit;
        results[4].hit = !!bundleHit;
        results[5].hit = !!marketStats;
        results[6].hit = !!followSell;
      } catch (e) {
        console.warn('[SW autoCollect] _checkAllCachesHit error:', sku, e?.message || e);
      }

      const allHit = results.every((r) => r.hit);
      return { allHit, results };
    };
  };
})();
