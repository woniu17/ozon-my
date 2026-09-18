// 价格管理(2026-09,商品维度定价基准)
// 设计文档: docs/价格管理-概要设计.md
// 职责:
//   - 手动同步 Ozon 价格(本地 product_id 映射 + v5 按 id 批量并发拉取)落 op_product_price_cache
//   - 商品列表:售价/采购价/重量 → 预估利润/利润率(共享 profit-estimator,全 CNY)
//   - 维护 product_data_cache.custom_purchase_price / custom_weight_g
//   - 单品改价(/v1/product/import/prices,price + old_price×2 + min_price,限频+日志+30s回读)
import { Router } from 'express';
import config from '../config/index.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';
import * as priceDao from '../db/dao/sqlite/price-dao.js';
import { productInfoPricesV5, productImportPrices } from '../services/ozon-opi.js';
import {
  DEFAULT_COMMISSION_RATE,
  DELIVERY_BASE_CNY,
  DELIVERY_PER_G_CNY,
  suggestPrice,
} from '../services/profit-estimator.js';

const router = Router();

// DAO SQL 内联公式参数(与 profit-estimator 单点一致)
const ESTIMATOR_PARAMS = {
  commissionRate: DEFAULT_COMMISSION_RATE,
  deliveryBase: DELIVERY_BASE_CNY,
  deliveryPerGram: DELIVERY_PER_G_CNY,
};

// Ozon 限频:每商品每小时改价 ≤10 次
const PRICE_UPDATE_HOURLY_LIMIT = 10;
// 改价提交后延迟回读校验(价格生效是异步的,参考备货轮询经验)
const PRICE_REREAD_DELAY_MS = 30_000;

function resolveStore(storeId) {
  return (config.loadStores() || []).find((s) => s.id === storeId) || null;
}

// v5 批量拉取参数(实测 2026-09-18:per-item 成本恒定 ~86ms,limit=1000 单页 87s 导致同步挂起;
// 200/批 × 并发4 全店约 1 分钟,且单请求远低于 undici 60s 超时)
const SYNC_BATCH_SIZE = 200;
const SYNC_CONCURRENCY = 4;

// ── 价格同步(手动):本地 product_id 映射 → v5 按 id 批量并发拉 → 落缓存 ──
router.post('/admin/api/price-manage/prices/sync', async (req, res, next) => {
  try {
    const { storeId } = req.body || {};
    const store = resolveStore(storeId);
    if (!store) return res.status(400).json({ ok: false, message: `店铺 ${storeId} 不存在或未配置凭据` });

    const started = Date.now();
    const syncedAt = new Date().toISOString();

    // 映射源:本地 product_data_cache(data JSON 的 $.id 即 product_id),零 API 调用
    // 语义:价格管理面向本系统商品;不在本地商品缓存的商品不参与(也无采购价/重量可维护)
    const local = priceDao.getLocalProductIdMap(store.id);
    if (!local.length) {
      return res.json(ok({
        storeId, count: 0, localTotal: 0, fetched: 0, failedBatches: 0, unmapped: 0,
        durationMs: Date.now() - started,
        note: '该店铺本地无商品记录,请先在商品列表同步商品后再同步价格',
      }));
    }

    // 并发拉 v5:按本地 product_id 分批(失败批次计数,不中断整体)
    const queue = [...local];
    const v5Items = [];
    let failedBatches = 0;
    const worker = async () => {
      while (queue.length) {
        const batch = queue.splice(0, SYNC_BATCH_SIZE);
        try {
          const resp = await productInfoPricesV5(store, {
            productIds: batch.map((x) => x.pid),
            limit: batch.length,
          });
          v5Items.push(...(resp?.items || []));
        } catch (e) {
          failedBatches++;
          logger.warn({ storeId, batchSize: batch.length, err: e?.message }, '[price-sync] 批次拉取失败');
        }
      }
    };
    const workers = Array.from({ length: Math.min(SYNC_CONCURRENCY, Math.ceil(local.length / SYNC_BATCH_SIZE)) }, worker);
    await Promise.all(workers);

    // 组装落库行(仅能映射到本地 sku 的商品)
    const map = new Map(local.map((x) => [x.pid, x]));
    const rows = [];
    for (const it of v5Items) {
      const m = map.get(it.product_id);
      if (!m) continue;
      rows.push({
        sku: m.sku,
        storeId: store.id,
        productId: it.product_id,
        offerId: it.offer_id ?? null,
        price: it.price?.price ?? null,
        oldPrice: it.price?.old_price ?? null,
        minPrice: it.price?.min_price ?? null,
        currencyCode: it.price?.currency_code || 'CNY',
        salesPercentFbs: it.commissions?.sales_percent_fbs ?? null,
        marketMinPriceRub: it.price_indexes?.ozon_index_data?.min_price ?? null,
        priceIndexColor: it.price_indexes?.color_index ?? null,
        name: m.name,
        image: m.image,
        rawJson: JSON.stringify(it),
        syncedAt,
      });
    }
    const count = priceDao.upsertPriceCacheRows(rows);
    // 同步后回填:有订单的商品用"最新一个有采购的订单"填默认采购价/称重重量(只填未维护的)
    const backfill = priceDao.backfillCustomsFromOrders();
    const durationMs = Date.now() - started;
    logger.info({ storeId, localTotal: local.length, fetched: v5Items.length, mapped: rows.length, failedBatches, backfill, durationMs }, '[price-sync] 同步完成');
    res.json(ok({
      storeId, count,
      localTotal: local.length,
      fetched: v5Items.length,
      unmapped: local.length - rows.length,
      failedBatches,
      backfill,
      durationMs,
    }));
  } catch (e) {
    next(e);
  }
});

// ── 店铺分布(页面店铺 tab) ──
router.get('/admin/api/price-manage/stores', (_req, res) => {
  res.json(ok(priceDao.priceCacheStores()));
});

// ── 商品列表(筛选/排序/分页) ──
router.get('/admin/api/price-manage/list', (req, res) => {
  const q = req.query;
  res.json(ok(priceDao.listPriceProducts({
    storeId: q.storeId || undefined,
    keyword: (q.keyword || '').trim() || undefined,
    purchaseSet: ['set', 'unset'].includes(q.purchaseSet) ? q.purchaseSet : undefined,
    weightSet: ['set', 'unset'].includes(q.weightSet) ? q.weightSet : undefined,
    profitRateMin: q.profitRateMin || undefined,
    profitRateMax: q.profitRateMax || undefined,
    sort: q.sort || undefined,
    dir: q.dir || undefined,
    page: q.page || 1,
    pageSize: q.pageSize || 20,
    ...ESTIMATOR_PARAMS,
  })));
});

// ── 顶部统计条 ──
router.get('/admin/api/price-manage/summary', (_req, res) => {
  res.json(ok(priceDao.priceManageSummary(ESTIMATOR_PARAMS)));
});

// ── 维护采购价/重量(写 product_data_cache 自定义列) ──
router.put('/admin/api/price-manage/sku/:sku', (req, res, next) => {
  try {
    const { sku } = req.params;
    const { purchasePrice, weightG } = req.body || {};
    if (purchasePrice === undefined && weightG === undefined) {
      return res.status(400).json({ ok: false, message: '未提供要更新的字段(purchasePrice/weightG)' });
    }
    const r = priceDao.setSkuCustoms(sku, { purchasePrice, weightG });
    if (r.updated === 0) {
      return res.status(404).json({ ok: false, message: `SKU ${sku} 无本地商品记录(需先在商品列表同步该商品)` });
    }
    res.json(ok(r));
  } catch (e) {
    if (/必须为/.test(e?.message || '')) return res.status(400).json({ ok: false, message: e.message });
    next(e);
  }
});

// ── SKU 历史订单(展开行,最新在前) ──
router.get('/admin/api/price-manage/sku/:sku/orders', (req, res) => {
  const { sku } = req.params;
  const limit = Number(req.query.limit) || 20;
  res.json(ok(priceDao.skuOrderList(sku, limit)));
});

// ── 单品改价 ──
// body: { sku, newPrice, targetRate? }(targetRate 0.4=40% 成本利润率;缺省=手动改价)
// 改价参数(用户确认 2026-09-18):price=新价,old_price=新价×2,min_price=新价,currency_code='CNY'
router.post('/admin/api/price-manage/price-update', async (req, res, next) => {
  try {
    const { sku, newPrice, targetRate } = req.body || {};
    const cache = priceDao.getPriceCacheBySku(sku);
    if (!cache) return res.status(404).json({ ok: false, message: `SKU ${sku} 不在价格缓存中,请先同步价格` });
    if (!cache.product_id) return res.status(400).json({ ok: false, message: '该商品缺少 product_id,无法改价' });

    const price = Number(newPrice);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ ok: false, message: 'newPrice 必须为正数' });
    }

    // 服务端二次校验:目标定价场景重算建议价,偏差 >0.05 拒绝(防前端公式漂移)
    let source = 'manual';
    if (targetRate != null && targetRate !== '') {
      const pdc = priceDao.getSkuCustoms(sku);
      const suggested = suggestPrice({
        purchaseCny: pdc?.custom_purchase_price,
        weightG: pdc?.weight_g,
        targetRate: Number(targetRate),
      });
      if (suggested == null) {
        return res.status(400).json({ ok: false, message: '目标定价需先维护采购价与重量' });
      }
      if (Math.abs(price - suggested) > 0.05) {
        return res.status(400).json({ ok: false, message: `新价与服务端建议价不一致(建议 ¥${suggested}),请刷新后重试` });
      }
      source = 'target';
    }

    // Ozon 限频:每商品每小时 ≤10 次
    const since = new Date(Date.now() - 3600_000).toISOString();
    const recent = priceDao.countPriceChangesSince(sku, since);
    if (recent >= PRICE_UPDATE_HOURLY_LIMIT) {
      return res.status(429).json({ ok: false, code: 'RATE_LIMITED', message: `该商品 1 小时内已改价 ${recent} 次(Ozon 上限 10 次),请稍后再试` });
    }

    const store = resolveStore(cache.store_id);
    if (!store) return res.status(400).json({ ok: false, message: `店铺 ${cache.store_id} 不存在或未配置凭据` });

    const oldPrice = cache.price;
    const oldOldPrice = cache.old_price;
    const payload = {
      productId: cache.product_id,
      price,
      oldPrice: Math.round(price * 2 * 100) / 100,
      minPrice: price,
      currencyCode: cache.currency_code || 'CNY',
    };
    const resp = await productImportPrices(store, payload);
    // HTTP 200 不代表成功:校验 result[].updated(响应可能为 {result:[...]} 或平铺)
    const item = resp?.result?.[0] ?? resp;
    if (item?.updated !== true) {
      const errMsg = item?.errors?.map((e) => `${e.code}:${e.message}`).join('; ') || 'Ozon 未确认 updated=true';
      logger.warn({ sku, productId: cache.product_id, errors: item?.errors }, '[price-update] Ozon 拒绝改价');
      return res.status(502).json({ ok: false, code: 'OZON_REJECTED', message: `Ozon 改价未成功: ${errMsg}` });
    }

    // 落日志(限频依据+审计)
    priceDao.insertPriceChangeLog({
      storeId: cache.store_id,
      sku,
      productId: cache.product_id,
      oldPrice,
      newPrice: price,
      oldOldPrice,
      currencyCode: payload.currencyCode,
      targetRate: targetRate != null && targetRate !== '' ? Number(targetRate) : null,
      source,
    });
    // 乐观更新本地缓存(30s 后回读校准,价格生效是异步的)
    priceDao.upsertPriceCacheRows([{
      sku,
      storeId: cache.store_id,
      productId: cache.product_id,
      offerId: cache.offer_id,
      price,
      oldPrice: payload.oldPrice,
      minPrice: payload.minPrice,
      currencyCode: payload.currencyCode,
      salesPercentFbs: cache.sales_percent_fbs,
      marketMinPriceRub: cache.market_min_price_rub,
      priceIndexColor: cache.price_index_color,
      name: null, // null 保留原值
      image: null,
      rawJson: null,
      syncedAt: new Date().toISOString(),
    }]);
    schedulePriceReread(store, cache.product_id, sku, price);

    logger.info({ sku, productId: cache.product_id, oldPrice, newPrice: price, source }, '[price-update] 改价已提交');
    res.json(ok({ sku, oldPrice, newPrice: price, oldPriceNew: payload.oldPrice, submitted: true, note: '价格生效为异步,30秒后自动回读校准' }));
  } catch (e) {
    next(e);
  }
});

// 延迟回读:30s 后按 product_id 拉 v5 校验价格真正生效,并以 Ozon 值校准缓存
function schedulePriceReread(store, productId, sku, submittedPrice) {
  const timer = setTimeout(async () => {
    try {
      const resp = await productInfoPricesV5(store, { productIds: [productId] });
      const it = resp?.items?.find((x) => x.product_id === productId);
      if (!it) return;
      const actual = it.price?.price;
      const row = priceDao.getPriceCacheBySku(sku);
      if (!row) return;
      priceDao.upsertPriceCacheRows([{
        sku,
        storeId: row.store_id,
        productId: row.product_id,
        offerId: it.offer_id ?? row.offer_id,
        price: actual ?? null,
        oldPrice: it.price?.old_price ?? null,
        minPrice: it.price?.min_price ?? null,
        currencyCode: it.price?.currency_code || row.currency_code,
        salesPercentFbs: it.commissions?.sales_percent_fbs ?? null,
        marketMinPriceRub: it.price_indexes?.ozon_index_data?.min_price ?? null,
        priceIndexColor: it.price_indexes?.color_index ?? null,
        name: null,
        image: null,
        rawJson: JSON.stringify(it),
        syncedAt: new Date().toISOString(),
      }]);
      if (actual != null && Math.abs(actual - submittedPrice) > 0.01) {
        logger.warn({ sku, productId, submittedPrice, actual }, '[price-update] 回读价格与提交值不一致(可能被 Ozon 规则调整或促销改写)');
      } else {
        logger.info({ sku, productId, actual }, '[price-update] 回读校验通过');
      }
    } catch (e) {
      logger.warn({ sku, productId, err: e?.message }, '[price-update] 回读校验失败(忽略,缓存保持提交值)');
    }
  }, PRICE_REREAD_DELAY_MS);
  timer.unref?.();
}

export default router;
