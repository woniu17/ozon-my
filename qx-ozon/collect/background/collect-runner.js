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
    this.classifyStoreByRules = (slug, name, companyInfo, config) => {
      if (!config) {
        console.log('[store-class] classifyStoreByRules: no config, returning null', { slug });
        return { isChinese: null, by: null };
      }
      console.log('[store-class] classifyStoreByRules input:', {
        slug,
        name,
        companyInfo,
        knownChineseSlugs: config.knownChineseSlugs,
        knownNonChineseSlugs: config.knownNonChineseSlugs,
      });
      // Rule 1: knownChineseSlugs
      if (Array.isArray(config.knownChineseSlugs) && config.knownChineseSlugs.includes(slug)) {
        console.log('[store-class] Rule 1 hit: knownChineseSlugs → isChinese=true');
        return { isChinese: true, by: 'rule:known-list' };
      }
      // Rule 2: knownNonChineseSlugs
      if (Array.isArray(config.knownNonChineseSlugs) && config.knownNonChineseSlugs.includes(slug)) {
        console.log('[store-class] Rule 2 hit: knownNonChineseSlugs → isChinese=false');
        return { isChinese: false, by: 'rule:known-list' };
      }
      // Rule 3: companyInfo.country === 'CN'
      if (companyInfo && companyInfo.country === 'CN') {
        console.log('[store-class] Rule 3 hit: companyInfo.country=CN → isChinese=true');
        return { isChinese: true, by: 'rule:company-country' };
      }
      // Rule 4: companyInfo.country 已知且非 CN
      if (companyInfo && companyInfo.country && companyInfo.country !== 'CN') {
        console.log('[store-class] Rule 4 hit: companyInfo.country=' + companyInfo.country + ' → isChinese=false');
        return { isChinese: false, by: 'rule:company-country' };
      }
      console.log('[store-class] No rule matched → isChinese=null (need manual confirm)');
      return { isChinese: null, by: null };
    };

    // ── ERP 店铺分类 CRUD(L2 MongoDB) ────────────────────────────────────────
    // 2026-07:路径参数改用 sellerId(稳定主键),sellerSlug 作为 fallback
    // GET /admin/api/store-classification/:sellerId — 返回分类记录或 null
    // 入参优先级:sellerId(主键) > slug(兼容 fallback)
    this._erpStoreClassGet = async (slug, sellerId) => {
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        // 优先用 sellerId 查(后端主键 _id = sellerId);无 sellerId 时用 slug(后端 fallback 到 slug 反查)
        const id = sellerId || slug;
        if (!id) return null;
        const r = await sw.apiRequest(
          'GET',
          `${url}/admin/api/store-classification/${encodeURIComponent(id)}`,
          null,
          stored[sw.STORAGE_KEYS.token]
        );
        // ERP 返回 { ok: true, data: { isChinese, classifiedBy, ... } },解包取 data
        return r?.data || null;
      } catch (e) {
        console.warn(`[store-class] ERP get failed sellerId=${sellerId} slug=${slug}:`, e?.message || e);
        return null;
      }
    };

    // POST /admin/api/store-classification/:sellerId(upsert)
    // 2026-07:路径参数改用 sellerId(稳定主键);sellerId 为空时 fallback 到 slug
    // record: { sellerSlug?, sellerName, isChinese, classifiedBy, companyInfo, lastSeenAt }
    this._erpStoreClassSet = async (slug, record, sellerId) => {
      try {
        const url = await sw.getBackendUrl();
        const stored = await sw.getStorage([sw.STORAGE_KEYS.token]);
        // 优先用 sellerId(主键);无 sellerId 时 fallback 到 slug(后端兼容路径)
        const id = sellerId || record?.sellerId || slug;
        if (!id) {
          console.warn('[store-class] ERP set skipped: missing identifier (sellerId/slug both empty)');
          return false;
        }
        await sw.apiRequest(
          'POST',
          `${url}/admin/api/store-classification/${encodeURIComponent(id)}`,
          record,
          stored[sw.STORAGE_KEYS.token]
        );
        return true;
      } catch (e) {
        console.warn(`[store-class] ERP set failed sellerId=${sellerId} slug=${slug}:`, e?.message || e);
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
    this._ensureL2Consistency = async (slug, name, companyInfo, sellerId, l1) => {
      const l2 = await this._erpStoreClassGet(slug, sellerId);
      console.log('[store-class] L2 consistency check, L2:', l2);
      if (l2 && l2.isChinese !== null && l2.isChinese !== undefined && l2.classifiedBy) {
        return; // L2 有效,无需补写
      }
      // L2 缺失或脏数据,补写
      const ok = await this._erpStoreClassSet(
        slug,
        {
          sellerSlug: slug,
          sellerId: sellerId || '',
          sellerName: name,
          isChinese: l1.isChinese,
          classifiedBy: l1.classifiedBy,
          companyInfo: companyInfo || null,
          lastSeenAt: new Date().toISOString(),
        },
        sellerId
      );
      if (!ok) {
        // L2 补写失败,清 L1 避免下次还走脏缓存(下次会重新走 L2 → 规则引擎)
        try {
          await sw.removeStorage([`jz-store-class-${slug}`]);
        } catch (_) {
          /* ignore */
        }
        console.warn(`[store-class] L2 补写失败,L1 已清除 slug=${slug}(下次访问将重新分类)`);
      } else {
        console.log(`[store-class] L2 补写成功 slug=${slug}`);
      }
    };

    // ── 三层查询:L1 chrome.storage.local → L2 MongoDB → 规则引擎 ────────────────
    // 返回 { isChinese, classifiedBy } | null(未分类,等待人工确认)。
    // sellerId 用于写入 L2 时带上(稳定主键,slug 可变)
    this.checkStoreClassification = async (slug, name, companyInfo, sellerId) => {
      if (!slug) return null;
      console.log('[store-class] checkStoreClassification called:', { slug, name, companyInfo, sellerId });
      const config = await sw.loadAutoCollectConfig();
      console.log('[store-class] config loaded:', {
        knownChineseSlugs: config?.knownChineseSlugs,
        knownNonChineseSlugs: config?.knownNonChineseSlugs,
      });

      // L1: chrome.storage.local
      // 注意:classifiedBy 为空字符串的记录视为无效(历史 bug:ERP 前端 updateStoreClass
      // 不传 classifiedBy 导致后端写空字符串),不信任 L1,继续查 L2 让规则引擎重新分类。
      const l1Key = `jz-store-class-${slug}`;
      try {
        const l1 = (await sw.getStorage([l1Key]))?.[l1Key];
        console.log('[store-class] L1 chrome.storage:', l1);
        if (l1 && l1.isChinese !== null && l1.isChinese !== undefined && l1.classifiedBy) {
          console.log('[store-class] L1 hit →', { isChinese: l1.isChinese, classifiedBy: l1.classifiedBy });
          // 异步补查 L2 一致性:若 L2 缺失(历史写入失败)则补写,补写失败则清 L1。
          // 不阻塞返回(店铺分类非关键路径,L2 修复后台静默进行)
          this._ensureL2Consistency(slug, name, companyInfo, sellerId, l1).catch((e) => {
            console.warn(`[store-class] L2 consistency check failed slug=${slug}:`, e?.message || e);
          });
          return { isChinese: l1.isChinese, classifiedBy: l1.classifiedBy };
        }
        // L1 无效或 classifiedBy 为空:清除旧记录,避免下次再被读到
        if (l1 && (!l1.classifiedBy || l1.isChinese === null || l1.isChinese === undefined)) {
          await sw.removeStorage([l1Key]);
          console.log('[store-class] L1 cleared (invalid classifiedBy):', l1);
        }
      } catch (e) {
        console.warn(`[store-class] L1 get failed slug=${slug}:`, e?.message || e);
      }

      // L2: MongoDB
      // 注意:与 L1 同样的校验 — classifiedBy 为空字符串的记录视为无效(历史 bug:
      // ERP 前端 updateStoreClass 不传 classifiedBy 导致后端写空字符串),不信任 L2,
      // 继续走规则引擎让 country=CN 等规则重新分类并覆盖脏记录。
      const l2 = await this._erpStoreClassGet(slug, sellerId);
      console.log('[store-class] L2 MongoDB:', l2);
      if (l2 && l2.isChinese !== null && l2.isChinese !== undefined && l2.classifiedBy) {
        console.log('[store-class] L2 hit →', { isChinese: l2.isChinese, classifiedBy: l2.classifiedBy });
        try {
          await sw.setStorage({
            [l1Key]: { isChinese: l2.isChinese, classifiedBy: l2.classifiedBy },
          });
        } catch (e) {
          console.warn(`[store-class] L1 set failed slug=${slug}:`, e?.message || e);
        }
        return { isChinese: l2.isChinese, classifiedBy: l2.classifiedBy };
      }
      // L2 无效或 classifiedBy 为空:记录日志,后续规则引擎重新分类后会覆盖
      if (l2 && (!l2.classifiedBy || l2.isChinese === null || l2.isChinese === undefined)) {
        console.log('[store-class] L2 ignored (invalid classifiedBy):', l2);
      }

      // 规则引擎
      const ruleResult = this.classifyStoreByRules(slug, name, companyInfo, config);
      console.log('[store-class] rule engine result:', ruleResult);
      if (ruleResult.isChinese !== null) {
        const record = {
          sellerSlug: slug,
          sellerId: sellerId || '',
          sellerName: name,
          isChinese: ruleResult.isChinese,
          classifiedBy: ruleResult.by,
          companyInfo: companyInfo || null,
          lastSeenAt: new Date().toISOString(),
        };
        try {
          await sw.setStorage({
            [l1Key]: { isChinese: ruleResult.isChinese, classifiedBy: ruleResult.by },
          });
        } catch (e) {
          console.warn(`[store-class] L1 set failed slug=${slug}:`, e?.message || e);
        }
        // await L2 写入:失败时清 L1,避免下次 L1 命中但 L2 缺失的脏缓存
        const l2Ok = await this._erpStoreClassSet(slug, record, sellerId);
        if (!l2Ok) {
          console.warn(`[store-class] L2 write failed, clearing L1 for slug=${slug}`);
          try {
            await sw.removeStorage([l1Key]);
          } catch (_) {
            /* ignore */
          }
        } else {
          console.log('[store-class] rule result persisted to L1+L2:', record);
        }
        return { isChinese: ruleResult.isChinese, classifiedBy: ruleResult.by };
      }

      // 未分类:写 L2 记录(isChinese=null,等待人工确认)
      console.log('[store-class] unclassified, writing null record to L2 (waiting manual confirm)');
      await this._erpStoreClassSet(slug, {
        sellerSlug: slug,
        sellerId: sellerId || '',
        sellerName: name,
        isChinese: null,
        classifiedBy: null,
        companyInfo: companyInfo || null,
        lastSeenAt: new Date().toISOString(),
      }, sellerId);
      return null;
    };

    // ── 人工确认分类:写 L1 + L2(classifiedBy:'manual') ────────────────────────
    // 入参 { slug, name, isChinese, sellerId } → 返回 { ok: true }
    this.manualClassifyStore = async (slug, name, isChinese, sellerId) => {
      if (!slug) return { ok: false, error: 'missing slug' };
      const classifiedBy = 'manual';
      const classifiedAt = new Date().toISOString();
      const l1Key = `jz-store-class-${slug}`;
      try {
        await sw.setStorage({ [l1Key]: { isChinese, classifiedBy } });
      } catch (e) {
        console.warn(`[store-class] L1 set failed slug=${slug}:`, e?.message || e);
      }
      await this._erpStoreClassSet(slug, {
        sellerSlug: slug,
        sellerId: sellerId || '',
        sellerName: name,
        isChinese,
        classifiedBy,
        classifiedAt,
        companyInfo: null,
        lastSeenAt: classifiedAt,
      }, sellerId);
      return { ok: true };
    };

    // ── ANTIBOT 分支处理:暂停 10 分钟 + 通知 popup + 写日志 + 更新计数器 ────────
    // 由 Step 4/5/6 检测到反爬时调用。返回 { status:'antibot', pausedUntil } 给调用方。
    // sellerId 用于日志写入(稳定主键,slug 可变)
    this._handleAntibot = async (sku, source, sellerSlug, storeClassified, depth, startTime, results, sellerId) => {
      const pausedUntil = Date.now() + 10 * 60 * 1000; // 10 分钟
      await this.saveAutoCollectConfig({ paused: true, pausedUntil });

      // 通知 QX面板 + popup(fire-and-forget,无监听者也不报错)
      chrome.runtime.sendMessage({ type: 'antibotDetected', pausedUntil }).catch(() => {});

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

    // ── 前置缓存检查:并行查 5 类合并缓存,返回是否全部命中 ──────────────────────
    // 用于 _handleSubmitTask 入队前快速判断,避免缓存命中任务占用 15s 队列 slot。
    // 逻辑与 _doAutoCollect Step1+Step5 内部缓存查询保持一致,但不做 L1/L2 同步(仅查询)。
    this._checkAllCachesHit = async (sku) => {
      const results = [
        { type: 'card', hit: false },
        { type: 'detail', hit: false },
        { type: 'pdp', hit: false },
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
        results[5].hit = !!marketStats && !marketStats.stale;
        results[6].hit = !!followSell && !followSell.stale;
      } catch (e) {
        console.warn('[SW autoCollect] _checkAllCachesHit error:', sku, e?.message || e);
      }

      const allHit = results.every((r) => r.hit);
      return { allHit, results };
    };
  };
})();
