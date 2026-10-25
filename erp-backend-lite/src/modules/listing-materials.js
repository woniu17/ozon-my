// 上架素材机制路由(2026-10,Phase 1)
// 设计文档:docs/上架素材机制-设计方案.md
// 对应 services/listing-materials.js 的 API 出口
import { Router } from 'express';
import { ok } from '../utils/response.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import * as lm from '../services/listing-materials.js';

const router = Router();

// 生成:N 份素材(同一源商品)
router.post('/admin/api/listing-materials/generate', async (req, res, next) => {
  try {
    const body = req.body || {};
    const sourceSku = String(body.sourceSku || '').trim();
    if (!sourceSku) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'sourceSku 必填'));
    }
    const count = Math.max(1, Math.min(5, Math.floor(Number(body.count) || 1)));
    const materials = await lm.generateMaterials({
      sourceSku,
      sourceStoreId: body.sourceStoreId ? String(body.sourceStoreId) : undefined,
      sourceType: body.sourceType ? String(body.sourceType) : undefined,
      count,
      titleTemplates: Array.isArray(body.titleTemplates) ? body.titleTemplates : undefined,
      aiRewrite: !!body.aiRewrite,
      aiStyles: Array.isArray(body.aiStyles) ? body.aiStyles.map(String) : [],
      imageMode: body.imageMode || 'shuffle',
      templateId: body.templateId != null ? Number(body.templateId) : null,
      defaultStock: Number(body.defaultStock) || 0,
      modelNamePrefix: String(body.modelNamePrefix || 'MSJ'),
      createdBy: req.user?.phone || req.operator?.name || null,
    });
    res.json(ok({ materials, count: materials.length }));
  } catch (e) {
    next(e);
  }
});

// 素材列表
router.get('/admin/api/listing-materials', (req, res, next) => {
  try {
    const { sourceSku, groupId, status } = req.query || {};
    const items = lm.listMaterials({
      sourceSku: sourceSku ? String(sourceSku) : undefined,
      groupId: groupId ? String(groupId) : undefined,
      status: status ? String(status) : undefined,
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    });
    res.json(ok({ items, total: items.length }));
  } catch (e) {
    next(e);
  }
});

// 素材详情
router.get('/admin/api/listing-materials/:id', (req, res, next) => {
  try {
    const material = lm.getMaterialById(Number(req.params.id));
    if (!material) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '素材不存在'));
    res.json(ok(material));
  } catch (e) {
    next(e);
  }
});

// 版本历史
router.get('/admin/api/listing-materials/:id/versions', (req, res, next) => {
  try {
    const material = lm.getMaterialById(Number(req.params.id));
    if (!material) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '素材不存在'));
    res.json(ok({ items: lm.listMaterialVersions(material.id) }));
  } catch (e) {
    next(e);
  }
});

// 编辑并保存新版本(Phase 1:名称/描述/图片/价格)
router.post('/admin/api/listing-materials/:id/versions', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!lm.getMaterialById(id)) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '素材不存在'));
    const body = req.body || {};
    const updated = lm.saveMaterialVersion({
      materialId: id,
      name: body.name != null ? String(body.name) : undefined,
      description: body.description != null ? String(body.description) : undefined,
      images: Array.isArray(body.images) ? body.images : undefined,
      priceConfig: body.priceConfig != null ? body.priceConfig : undefined,
      changeNote: body.changeNote ? String(body.changeNote) : undefined,
      createdBy: req.user?.phone || req.operator?.name || null,
    });
    res.json(ok(updated));
  } catch (e) {
    next(e);
  }
});

// 审核通过 draft → ready
router.post('/admin/api/listing-materials/:id/approve', (req, res, next) => {
  try {
    const material = lm.approveMaterial(Number(req.params.id));
    res.json(ok(material));
  } catch (e) {
    next(e);
  }
});

// 发布到目标店铺
router.post('/admin/api/listing-materials/:id/publish', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const storeId = String(body.storeId || '').trim();
    if (!storeId) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'storeId 必填'));
    const result = await lm.publishMaterial({
      materialId: id,
      storeId,
      defaultStock: Number(body.defaultStock) || 10,
    });
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// 批量发布(多素材→多店铺,复用 batch-upload 两阶段框架)
router.post('/admin/api/listing-materials/batch-publish', (req, res, next) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'assignments 必填且非空'));
    }
    const assignments = body.assignments.map((a) => ({
      materialId: Number(a.materialId),
      targetStoreId: String(a.targetStoreId || ''),
      defaultStock: Number(a.defaultStock) || undefined,
    }));
    const result = lm.createBatchPublish({
      assignments,
      name: body.name ? String(body.name) : undefined,
      speedConfig: body.speedConfig || undefined,
    });
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// 发布历史
router.get('/admin/api/listing-materials/:id/publishes', (req, res, next) => {
  try {
    const material = lm.getMaterialById(Number(req.params.id));
    if (!material) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '素材不存在'));
    res.json(ok({ items: lm.listMaterialPublishes(material.id) }));
  } catch (e) {
    next(e);
  }
});

// 归档/删除
router.delete('/admin/api/listing-materials/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!lm.getMaterialById(id)) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '素材不存在'));
    const material = lm.archiveMaterial(id);
    res.json(ok({ archived: true, id, status: material.status }));
  } catch (e) {
    next(e);
  }
});

export default router;