// 货源管理路由(2026-11-27)
// 独立「货源管理」页:维护 Ozon SKU 的平台货源商品(1688 / 拼多多 / 淘宝)
//   GET    /admin/api/supplier-products/list          货源列表
//   GET    /admin/api/supplier-products/candidates    待确认候选(SKU 分组)
//   GET    /admin/api/supplier-products/by-sku/:sku   单 SKU 货源 + 候选
//   POST   /admin/api/supplier-products/create        新增货源(可传 1688 链接/ID)
//   PUT    /admin/api/supplier-products/update/:id    编辑规格/配比/备注/启用
//   DELETE /admin/api/supplier-products/delete/:id    删除
//   POST   /admin/api/supplier-products/set-primary/:id 设为常用
//   POST   /admin/api/supplier-products/confirm       批量确认候选
//   POST   /admin/api/supplier-products/backfill      历史采购回填(仅无歧义单)
//   POST   /admin/api/supplier-products/sync-missing-goods        补齐缺失商品ID(后台任务)
//   GET    /admin/api/supplier-products/sync-missing-goods-status 任务进度
import { Router } from 'express';
import { ok } from '../utils/response.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import logger from '../middleware/log.js';
import {
  listSources,
  listCandidates,
  getSkuDetail,
  upsertSource,
  updateSource,
  deleteSource,
  setPrimary,
  confirmCandidates,
  dismissCandidates,
  backfillFromHistory,
  parseSourceItemId,
  buildSourceUrl,
  detectSourcePlatform,
  normalizeSourcePlatform,
} from '../services/supplier-products.js';
import { startMissingGoodsSync, getMissingSyncState } from '../services/supplier-source-sync.js';

const router = Router();

router.get('/admin/api/supplier-products/list', (req, res, next) => {
  try {
    const { storeId = '', platform = '', keyword = '', page = 1, pageSize = 20 } = req.query;
    res.json(ok(listSources({ storeId, platform, keyword, page, pageSize })));
  } catch (e) {
    next(e);
  }
});

router.get('/admin/api/supplier-products/candidates', (req, res, next) => {
  try {
    const { storeId = '', keyword = '', platform = '', page = 1, pageSize = 20 } = req.query;
    res.json(ok(listCandidates({ storeId, keyword, platform, page, pageSize })));
  } catch (e) {
    next(e);
  }
});

router.get('/admin/api/supplier-products/by-sku/:sku', (req, res, next) => {
  try {
    res.json(ok(getSkuDetail(req.params.sku)));
  } catch (e) {
    next(e);
  }
});

router.post('/admin/api/supplier-products/create', (req, res, next) => {
  try {
    const b = req.body || {};
    // 平台:显式传 platform 优先,否则按链接识别(1688 / 拼多多)
    const platform = b.platform
      ? normalizeSourcePlatform(b.platform)
      : detectSourcePlatform(b.sourceUrl || b.sourceItemId || '', '1688');
    // 允许直接提交链接:sourceUrl → 解析商品ID
    const sourceItemId = String(b.sourceItemId || '').trim() || parseSourceItemId(b.sourceUrl);
    if (!sourceItemId) throw new ApiError(ErrorCode.VALIDATION_ERROR, '请填写货源商品链接或商品ID(1688/拼多多)');
    const r = upsertSource({
      ...b,
      platform,
      sourceItemId,
      sourceUrl: b.sourceUrl || buildSourceUrl(platform, sourceItemId),
    });
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

router.put('/admin/api/supplier-products/update/:id', (req, res, next) => {
  try {
    res.json(ok(updateSource(req.params.id, req.body || {})));
  } catch (e) {
    next(e);
  }
});

router.delete('/admin/api/supplier-products/delete/:id', (req, res, next) => {
  try {
    res.json(ok(deleteSource(req.params.id)));
  } catch (e) {
    next(e);
  }
});

router.post('/admin/api/supplier-products/set-primary/:id', (req, res, next) => {
  try {
    res.json(ok(setPrimary(req.params.id)));
  } catch (e) {
    next(e);
  }
});

router.post('/admin/api/supplier-products/confirm', (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.json(ok({ created: 0, updated: 0, errors: [] }));
    res.json(ok(confirmCandidates(items)));
  } catch (e) {
    next(e);
  }
});

// 移除待确认候选(2026-11-28):写入忽略表,不再出现在候选列表
router.post('/admin/api/supplier-products/candidates/dismiss', (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json(ok(dismissCandidates(items)));
  } catch (e) {
    next(e);
  }
});

router.post('/admin/api/supplier-products/backfill', (req, res, next) => {
  try {
    const result = backfillFromHistory();
    logger.info(result, '[supplier-products] 历史采购回填完成');
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// 补齐缺失货源商品ID(2026-11-27):后台任务,重拉采购单商品行后自动积累货源
router.post('/admin/api/supplier-products/sync-missing-goods', (req, res, next) => {
  try {
    const platforms = Array.isArray(req.body?.platforms) ? req.body.platforms : undefined;
    res.json(ok(startMissingGoodsSync({ platforms })));
  } catch (e) {
    next(e);
  }
});

router.get('/admin/api/supplier-products/sync-missing-goods-status', (_req, res, next) => {
  try {
    res.json(ok(getMissingSyncState()));
  } catch (e) {
    next(e);
  }
});

export default router;
