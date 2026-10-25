// 上架素材机制(2026-10,Phase 1)
// 设计文档:docs/上架素材机制-设计方案.md
//
// Phase 1 范围:
//   - 生成:同一源商品 → N 份素材(模板化标题变体 + 图片乱序 + 唯一型号名称)
//   - 保存:listing_materials + listing_material_versions(首版本快照)
//   - 审核:draft → ready
//   - 发布:素材 → buildListingMessageFromMaterial → executeListing(复用现有上架管线)
//   - 记录:listing_material_publishes(素材→店铺发布历史,防重复投放)
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { buildSynthesizedFromCache } from '../modules/cache.js';
import { transformItemForPortal, extractCategoryIds } from './prepare-bundle.js';
import { buildListingMessageFromMaterial, executeListing } from './listing-builder.js';
import { rewriteVariants } from './enrichments/ai-rewrite.js';

// ── 常量 ─────────────────────────────────────────────
const MAX_GENERATE_COUNT = 5;

// ── 类目名查询(从 ozon_meta_category_tree 缓存树中查找) ──
// 返回 { categoryName, typeName },找不到返回空串
export function lookupCategoryNames(descriptionCategoryId, typeId, language = 'ZH_HANS') {
  if (!descriptionCategoryId) return { categoryName: '', typeName: '' };
  try {
    const row = db.prepare(`SELECT payload FROM ozon_meta_category_tree WHERE language=?`).get(language);
    if (!row) return { categoryName: '', typeName: '' };
    const tree = JSON.parse(row.payload);
    let categoryName = '';
    let typeName = '';
    const walk = (nodes, parentName) => {
      for (const n of nodes || []) {
        if (Number(n.description_category_id) === Number(descriptionCategoryId)) {
          categoryName = n.category_name || parentName || '';
          if (Array.isArray(n.children)) {
            const t = n.children.find((c) => Number(c.type_id) === Number(typeId));
            typeName = t?.type_name || '';
          }
          return true;
        }
        if (walk(n.children, n.category_name || parentName)) return true;
      }
      return false;
    };
    walk(tree, '');
    return { categoryName, typeName };
  } catch (e) {
    logger.warn({ descriptionCategoryId, typeId, err: e.message }, 'lookupCategoryNames 失败');
    return { categoryName: '', typeName: '' };
  }
}

// ── 标题模板 ─────────────────────────────────────────
// 支持占位符:{name} {typeName} {categoryName} {modelName}
// 未提供模板时按 typeName 是否可用生成默认差异化模板
function normalizeTitleTemplates(templates, typeName) {
  if (Array.isArray(templates)) {
    const valid = templates.map((t) => String(t || '').trim()).filter(Boolean);
    if (valid.some((t) => t.includes('{name}'))) return valid;
  }
  return typeName
    ? ['{name}', '{name} {typeName}', '{name} — {typeName}']
    : ['{name}', '{name} — {modelName}', '{name} | {modelName}'];
}

function renderTitle(template, vars) {
  return String(template || '{name}')
    .replace(/\{name\}/g, vars.name || '')
    .replace(/\{typeName\}/g, vars.typeName || '')
    .replace(/\{categoryName\}/g, vars.categoryName || '')
    .replace(/\{modelName\}/g, vars.modelName || '')
    .trim()
    .replace(/\s{2,}/g, ' ');
}

// ── 图片乱序(仅打乱非主图,主图位置不变) ────────────────
function shuffleNonPrimary(images) {
  const arr = Array.isArray(images) ? images : [];
  if (arr.length <= 2) return arr;
  const primaryIdx = arr.findIndex((im) => im && im.default);
  if (primaryIdx < 0) return arr;
  const primary = arr[primaryIdx];
  const rest = arr.filter((_, i) => i !== primaryIdx);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [primary, ...rest];
}

// ── 入库 ─────────────────────────────────────────────
const INSERT_MATERIAL = db.prepare(`
  INSERT INTO listing_materials (
    material_no, group_id, source_sku, source_store_id, source_product_id,
    name, description, rich_content, description_category_id, type_id,
    primary_image, images, attributes, item_json, model_name, video_url,
    price_config, default_stock, offer_id, status, created_by
  ) VALUES (
    :material_no, :group_id, :source_sku, :source_store_id, :source_product_id,
    :name, :description, :rich_content, :description_category_id, :type_id,
    :primary_image, :images, :attributes, :item_json, :model_name, :video_url,
    :price_config, :default_stock, :offer_id, :status, :created_by
  )
`);
export function insertMaterial(m) {
  const r = INSERT_MATERIAL.run({
    material_no: m.material_no,
    group_id: m.group_id,
    source_sku: m.source_sku,
    source_store_id: m.source_store_id || null,
    source_product_id: m.source_product_id || null,
    name: m.name,
    description: m.description || '',
    rich_content: m.rich_content || null,
    description_category_id: m.description_category_id || 0,
    type_id: m.type_id || 0,
    primary_image: m.primary_image || '',
    images: m.images || '[]',
    attributes: m.attributes || '[]',
    item_json: m.item_json,
    model_name: m.model_name || '',
    video_url: m.video_url || '',
    price_config: m.price_config || '{}',
    default_stock: m.default_stock || 0,
    offer_id: m.offer_id || '',
    status: m.status || 'draft',
    created_by: m.created_by || null,
  });
  return Number(r.lastInsertRowid);
}

const INSERT_VERSION = db.prepare(`
  INSERT INTO listing_material_versions (material_id, version, snapshot, change_note, created_by)
  VALUES (?, ?, ?, ?, ?)
`);
export function insertVersion(materialId, version, snapshot, changeNote, createdBy) {
  INSERT_VERSION.run(materialId, version, JSON.stringify(snapshot ?? null), changeNote || null, createdBy || null);
}

// 生成素材时使用的完整快照(含 item_json,便于回溯发布时的原始内容)
function snapshotFromMaterial(m) {
  return {
    id: m.id,
    material_no: m.material_no,
    group_id: m.group_id,
    source_sku: m.source_sku,
    source_store_id: m.source_store_id,
    name: m.name,
    description: m.description,
    description_category_id: m.description_category_id,
    type_id: m.type_id,
    primary_image: m.primary_image,
    images: m.images,
    attributes: m.attributes,
    item_json: m.item_json,
    model_name: m.model_name,
    video_url: m.video_url,
    price_config: m.price_config,
    default_stock: m.default_stock,
    offer_id: m.offer_id,
    status: m.status,
    created_by: m.created_by,
  };
}

// 从 Ozon 商品数据缓存合成插件格式 item(product 源,离线可用)
// 数据来源:
//   product_data_cache.data         — /v3/product/info/list(名称/图片/价格/类目/类型)
//   product_attributes_cache.attributes_data — /v4/product/info/attributes(属性/物理参数)
//   product_attributes_cache.description_data — /v1/product/info/description(描述)
// 返回 { item } 或 null
function buildItemFromProductCache(sku) {
  const dataRow = db.prepare(`SELECT data FROM product_data_cache WHERE sku=?`).get(String(sku));
  if (!dataRow) return null;
  let d = null;
  try {
    d = JSON.parse(dataRow.data);
  } catch {
    return null;
  }
  const attrRow = db.prepare(`SELECT attributes_data, description_data FROM product_attributes_cache WHERE sku=?`).get(String(sku));
  let a = null;
  let description = '';
  if (attrRow) {
    try {
      a = JSON.parse(attrRow.attributes_data);
    } catch {}
    try {
      const descObj = JSON.parse(attrRow.description_data);
      description = descObj?.result?.description || '';
    } catch {}
  }

  // 把 v4 属性(/v4/product/info/attributes)映射为 bundleItem.attributes 形状,
  // 供 transformItemForPortal 提取 v3 属性数组(含 dictionary_value_id)
  const bundleAttrs = (a?.attributes || []).map((at) => ({
    attribute_id: Number(at.id || 0),
    values: (at.values || []).map((v) => ({
      value: String(v.value ?? ''),
      ...(v.dictionary_value_id != null && Number(v.dictionary_value_id) > 0
        ? { dictionary_value_id: Number(v.dictionary_value_id) }
        : {}),
    })),
  }));

  const primaryImage = a?.primary_image || d.images?.[0] || '';
  const images = [
    ...(primaryImage ? [{ file_name: primaryImage, default: true }] : []),
    ...(d.images || []).filter((u) => u !== primaryImage).map((u) => ({ file_name: u, default: false })),
  ];
  const descriptionCategoryId = Number(d.description_category_id) || 0;
  const typeId = Number(d.type_id) || 0;

  const item = {
    // 最小 _sourceVariant:transformItemForPortal 依赖它提取类目/类型/属性
    _sourceVariant: {
      description_category_id: typeId, // 字段名误用,实际是 type_id(与 prepare-bundle.js 一致)
      categories: descriptionCategoryId ? [{ id: descriptionCategoryId, level: 3 }] : [],
      _bundleItem: { attributes: bundleAttrs },
      attributes: [],
    },
    images,
    name: d.name || '',
    price: d.price != null ? String(d.price) : '',
    old_price: d.old_price != null ? String(d.old_price) : '',
    offer_id: d.offer_id || `SKU${sku}`,
    weight: a?.weight != null ? String(a.weight) : '',
    depth: a?.depth != null ? String(a.depth) : '',
    width: a?.width != null ? String(a.width) : '',
    height: a?.height != null ? String(a.height) : '',
    weight_unit: a?.weight_unit || 'g',
    dimension_unit: a?.dimension_unit || 'mm',
    scraped_description: description,
    barcode: a?.barcode || '',
    videoUrl: a?.video_url || '',
    videoCover: '',
    description_category_id: descriptionCategoryId,
    type_id: typeId,
  };
  return { item };
}

// ── 生成:同一源商品 → N 份素材 ─────────────────────────
// 支持两种源:
//   sourceType='collect'(默认):采集缓存(ozon_dom_cache/attr/richmedia,即采集箱),
//      走 buildSynthesizedFromCache(与跟卖 buildListingMessage 同源)
//   sourceType='product':Ozon 商品数据缓存(product_data_cache + product_attributes_cache),
//      适用于从"商品列表"直接选 SKU 生成素材(无需采集箱),离线可用
//   未指定时:先尝试 collect,采集缓存缺失自动回退 product
export async function generateMaterials({
  sourceSku,
  sourceStoreId,
  sourceType,
  count = 1,
  titleTemplates = null,
  aiRewrite = false,
  aiStyles = [],
  imageMode = 'shuffle',
  templateId = null,
  defaultStock = 0,
  modelNamePrefix = 'MSJ',
  createdBy = null,
} = {}) {
  if (!sourceSku) throw new Error('sourceSku 必填');
  const countInt = Math.max(1, Math.min(MAX_GENERATE_COUNT, Math.floor(Number(count) || 1)));

  // 从缓存合成源 item(storeId 仅用于属性字典过滤,传空会退而取第一个店铺)
  const store = config.loadStores().find((s) => s.id === sourceStoreId) || config.loadStores()[0];
  const dictStoreId = sourceStoreId || store?.id;

  let synth;
  const wantCollect = sourceType !== 'product';
  if (wantCollect) {
    try {
      synth = await buildSynthesizedFromCache(sourceSku, dictStoreId);
    } catch (e) {
      logger.warn({ sourceSku, err: e.message }, 'generateMaterials: buildSynthesizedFromCache 失败,尝试 product 源');
      synth = null;
    }
  }
  // 采集缓存缺失或 partial(属性缓存不足)时,回退到 Ozon 商品数据缓存
  if (!synth || !synth.item || synth.partial) {
    if (sourceType === 'collect') {
      throw new Error(`SKU ${sourceSku} 采集缓存不足或不完整(ozon_dom_cache/attr/richmedia),无法生成素材`);
    }
    // product 源或自动回退:从 Ozon 商品数据缓存合成
    synth = buildItemFromProductCache(sourceSku);
    if (!synth || !synth.item) {
      throw new Error(`SKU ${sourceSku} 商品数据缓存不足(product_data_cache/product_attributes_cache),无法生成素材`);
    }
  }
  const baseItem = JSON.parse(JSON.stringify(synth.item));

  const cats = extractCategoryIds(baseItem);
  const typeId = Number(baseItem.type_id) || cats.typeId || 0;
  const descriptionCategoryId = Number(baseItem.description_category_id) || cats.descriptionCategoryId || 0;
  const { categoryName, typeName } = lookupCategoryNames(descriptionCategoryId, typeId);

  // 供前端预览的 v3 属性(与上架时的 transformItemForPortal 同源)
  let portalAttrs = [];
  try {
    const portal = transformItemForPortal(JSON.parse(JSON.stringify(baseItem)));
    portalAttrs = portal.attributes || [];
  } catch (e) {
    logger.warn({ sourceSku, err: e.message }, 'generateMaterials: transformItemForPortal 失败,attributes 置空');
  }

  const templates = normalizeTitleTemplates(titleTemplates, typeName);

  // AI 多风格重写:开启后为每份素材生成独立标题(和描述);AI 不可用时自动回退模板
  let aiVariants = null;
  if (aiRewrite) {
    aiVariants = await rewriteVariants({
      name: baseItem.name,
      description: baseItem.scraped_description || '',
      styles: aiStyles,
      count: countInt,
    });
    if (aiVariants) {
      logger.info({ sourceSku, generated: aiVariants.length }, 'generateMaterials: AI 多风格重写完成');
    }
  }

  const groupId = `g-${sourceSku}`;
  const created = [];
  const now = Date.now();

  for (let i = 0; i < countInt; i++) {
    const item = JSON.parse(JSON.stringify(baseItem));
    // 每份素材唯一型号名称(防 Ozon 同款合并;发布时注入到属性 9048)
    const modelName = `${modelNamePrefix}${now.toString(36).toUpperCase()}${i + 1}`;
    // 标题差异化:优先用 AI 变体,不足或未开启时用模板
    if (aiVariants && aiVariants[i]) {
      item.name = aiVariants[i].name;
      if (aiVariants[i].description) item.scraped_description = aiVariants[i].description;
    } else {
      item.name = renderTitle(templates[i % templates.length], {
        name: baseItem.name,
        typeName,
        categoryName,
        modelName,
        index: i + 1,
      });
    }
    // 图片差异化:打乱非主图顺序
    if (imageMode === 'shuffle') item.images = shuffleNonPrimary(item.images);

    const primaryImage =
      (Array.isArray(item.images) && item.images.find((im) => im && im.default)?.file_name) ||
      item.images?.[0]?.file_name ||
      '';
    const materialNo = `mat-${now.toString(36)}-${randomBytes(2).toString('hex')}`;

    const material = {
      material_no: materialNo,
      group_id: groupId,
      source_sku: String(sourceSku),
      source_store_id: dictStoreId || null,
      source_product_id: baseItem._sourceVariant?._bundleItem?.id ? String(baseItem._sourceVariant._bundleItem.id) : null,
      name: item.name,
      description: item.scraped_description || '',
      rich_content: null,
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      primary_image: primaryImage,
      images: JSON.stringify(item.images || []),
      attributes: JSON.stringify(portalAttrs),
      item_json: JSON.stringify(item),
      model_name: modelName,
      video_url: item.videoUrl || '',
      price_config: JSON.stringify({ templateId: templateId || null, sourcePrice: baseItem.price || '' }),
      default_stock: Math.max(0, Math.min(100000, Number(defaultStock) || 0)),
      offer_id: '',
      status: 'draft',
      created_by: createdBy,
    };
    const id = insertMaterial(material);
    insertVersion(id, 1, snapshotFromMaterial({ ...material, id }), '生成素材', createdBy);
    created.push({ ...material, id });
  }
  return created;
}

// ── 查询 ─────────────────────────────────────────────
export function getMaterialById(id) {
  return db.prepare(`SELECT * FROM listing_materials WHERE id=?`).get(Number(id)) || null;
}

export function listMaterials({ sourceSku, groupId, status, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = {};
  if (sourceSku) {
    where.push('source_sku = :sourceSku');
    params.sourceSku = String(sourceSku);
  }
  if (groupId) {
    where.push('group_id = :groupId');
    params.groupId = String(groupId);
  }
  if (status) {
    where.push('status = :status');
    params.status = String(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
  const off = Math.max(0, Number(offset) || 0);
  return db
    .prepare(`SELECT * FROM listing_materials ${whereSql} ORDER BY id DESC LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit: lim, offset: off });
}

export function listMaterialVersions(materialId) {
  return db
    .prepare(`SELECT id, material_id, version, change_note, created_by, created_at FROM listing_material_versions WHERE material_id=? ORDER BY version DESC`)
    .all(Number(materialId));
}

export function listMaterialPublishes(materialId) {
  return db
    .prepare(`SELECT * FROM listing_material_publishes WHERE material_id=? ORDER BY id DESC`)
    .all(Number(materialId));
}

// 当前素材版本号(版本历史最大值,至少 1)
function getCurrentMaterialVersion(materialId) {
  const r = db
    .prepare(`SELECT COALESCE(MAX(version),1) AS v FROM listing_material_versions WHERE material_id=?`)
    .get(Number(materialId));
  return r?.v || 1;
}

// ── 批量发布(复用 batch-upload 两阶段框架) ──────────────
// assignments: [{ materialId, targetStoreId, defaultStock? }]
// 流程:
//   1. 校验素材存在/未归档/未投过目标店铺
//   2. 创建 batch_upload_tasks(RUNNING) + batch_upload_items(material_id 指向素材)
//   3. 为每个合法分配插入 listing_material_publishes(pending, 关联 batch_item_id)
//   4. batch-image-poller / batch-upload-poller 处理阶段回写发布记录状态
// 返回 { task, batchNo, localTaskId, publishIds, validCount, skippedCount }
export function createBatchPublish({ assignments = [], name = null, speedConfig = null } = {}) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new Error('assignments 必填且非空');
  }
  const batchNo = `mbat-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const localTaskId = `batch-${randomUUID().slice(0, 8)}`;
  const storeIdSet = new Set();
  const validAssignments = [];
  const skippedItems = [];

  for (const a of assignments) {
    const materialId = Number(a.materialId);
    const material = getMaterialById(materialId);
    if (!material) {
      skippedItems.push({ materialId, reason: 'NOT_FOUND' });
      continue;
    }
    if (material.status === 'archived') {
      skippedItems.push({ materialId, reason: 'ARCHIVED' });
      continue;
    }
    if (!a.targetStoreId) {
      skippedItems.push({ materialId, reason: 'NO_STORE' });
      continue;
    }
    const dup = db
      .prepare(`SELECT id FROM listing_material_publishes WHERE material_id=? AND store_id=?`)
      .get(materialId, a.targetStoreId);
    if (dup) {
      skippedItems.push({ materialId, reason: 'ALREADY_PUBLISHED' });
      continue;
    }
    storeIdSet.add(a.targetStoreId);
    validAssignments.push({
      materialId,
      storeId: a.targetStoreId,
      defaultStock: Number(a.defaultStock) || material.default_stock || 0,
      material,
    });
  }
  validAssignments.forEach((a, i) => (a.seq = i));
  if (validAssignments.length === 0) {
    throw new Error('没有可发布的素材分配(全部被跳过)');
  }
  const storeIds = [...storeIdSet];
  const configJson = JSON.stringify({ materialMode: true });
  const speedJson = JSON.stringify(speedConfig || { intervalSec: 10, onFailure: 'continue' });

  db.prepare(`
    INSERT INTO batch_upload_tasks
      (local_task_id, batch_no, name, store_id, store_ids, status, total_count, skipped_count, config, speed_config)
    VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?)
  `).run(localTaskId, batchNo, name || null, storeIds[0], JSON.stringify(storeIds), validAssignments.length, skippedItems.length, configJson, speedJson);

  const stmtItem = db.prepare(`
    INSERT INTO batch_upload_items (batch_task_id, seq, source_sku, material_id, target_store_id, status)
    VALUES (?, ?, ?, ?, ?, 'PENDING')
  `);
  const stmtPublish = db.prepare(`
    INSERT INTO listing_material_publishes (material_id, material_version, store_id, batch_item_id, status)
    VALUES (?, ?, ?, ?, 'pending')
  `);
  const publishIds = [];
  for (const a of validAssignments) {
    const ir = stmtItem.run(localTaskId, a.seq, a.material.source_sku, a.materialId, a.storeId);
    const itemId = Number(ir.lastInsertRowid);
    const pr = stmtPublish.run(a.materialId, getCurrentMaterialVersion(a.materialId), a.storeId, itemId);
    publishIds.push(Number(pr.lastInsertRowid));
  }

  // 跳过项也入库(审计用)
  const stmtSkipped = db.prepare(`
    INSERT INTO batch_upload_items (batch_task_id, seq, source_sku, material_id, target_store_id, status, skip_reason, finished_at)
    VALUES (?, ?, ?, ?, ?, 'SKIPPED', ?, datetime('now'))
  `);
  let skipSeq = validAssignments.length;
  for (const s of skippedItems) {
    stmtSkipped.run(localTaskId, skipSeq++, s.materialId || null, s.materialId || null, null, s.reason);
  }

  const row = db.prepare(`SELECT * FROM batch_upload_tasks WHERE local_task_id=?`).get(localTaskId);
  return {
    task: row,
    batchNo,
    localTaskId,
    publishIds,
    validCount: validAssignments.length,
    skippedCount: skippedItems.length,
  };
}

// ── 状态流转 ─────────────────────────────────────────
export function approveMaterial(id) {
  const r = db.prepare(`UPDATE listing_materials SET status='ready', updated_at=datetime('now') WHERE id=? AND status='draft'`).run(Number(id));
  if (r.changes === 0) {
    const m = getMaterialById(id);
    if (!m) throw new Error('素材不存在');
    if (m.status !== 'draft') throw new Error(`素材当前状态为 ${m.status},仅 draft 可审核通过`);
  }
  return getMaterialById(id);
}

export function archiveMaterial(id) {
  db.prepare(`UPDATE listing_materials SET status='archived', updated_at=datetime('now') WHERE id=?`).run(Number(id));
  return getMaterialById(id);
}

// ── 编辑保存新版本(Phase 1:仅名称/描述/图片/价格可编辑,属性编辑留待 Phase 2) ──
export function saveMaterialVersion({
  materialId,
  name,
  description,
  images,
  priceConfig,
  changeNote,
  createdBy,
} = {}) {
  const material = getMaterialById(materialId);
  if (!material) throw new Error('素材不存在');
  if (material.status === 'archived') throw new Error('素材已归档,不能编辑');

  // 更新素材可编辑列
  db.prepare(`
    UPDATE listing_materials
    SET name = :name,
        description = :description,
        images = :images,
        price_config = :priceConfig,
        updated_at = datetime('now')
    WHERE id = :id
  `).run({
    id: materialId,
    name: name != null ? String(name) : material.name,
    description: description != null ? String(description) : material.description,
    images: images != null ? JSON.stringify(images) : material.images,
    priceConfig: priceConfig != null ? JSON.stringify(priceConfig) : material.price_config,
  });

  // 同步更新 item_json 中的对应字段,保证发布时以最新编辑为准
  let item = {};
  try {
    item = JSON.parse(material.item_json || '{}');
  } catch {}
  if (name != null) item.name = String(name);
  if (description != null) item.scraped_description = String(description);
  if (images != null && Array.isArray(images) && images.length > 0) item.images = images;
  db.prepare(`UPDATE listing_materials SET item_json=? WHERE id=?`).run(JSON.stringify(item), materialId);

  // 写入新版本快照
  const vRow = db.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM listing_material_versions WHERE material_id=?`).get(materialId);
  const nextVersion = vRow.v + 1;
  const updated = getMaterialById(materialId);
  insertVersion(materialId, nextVersion, snapshotFromMaterial(updated), changeNote || '手动编辑', createdBy);
  return updated;
}

// ── 发布:素材 → 目标店铺 ─────────────────────────────
export async function publishMaterial({ materialId, storeId, defaultStock = 10 } = {}) {
  if (!storeId) throw new Error('storeId 必填');
  const material = getMaterialById(materialId);
  if (!material) throw new Error('素材不存在');
  if (material.status === 'archived') throw new Error('素材已归档,不能发布');

  // 同一素材不能重复投同一店铺(UNIQUE(material_id, store_id))
  // 但失败的发布记录允许重试:先删除历史 failed 记录,非 failed 重复则拦截
  const dup = db.prepare(`SELECT id, status FROM listing_material_publishes WHERE material_id=? AND store_id=?`).get(materialId, storeId);
  if (dup) {
    if (dup.status === 'failed') {
      db.prepare(`DELETE FROM listing_material_publishes WHERE id=?`).run(dup.id);
    } else {
      throw new Error('该素材已发布到此店铺(处理中/已成功),不能重复发布');
    }
  }

  const vRow = db.prepare(`SELECT COALESCE(MAX(version),1) AS v FROM listing_material_versions WHERE material_id=?`).get(materialId);
  const version = vRow.v || 1;

  // 由素材重建上架 message(价格/offer_id/强制属性在 buildListingMessageFromMaterial 内处理)
  const { message, offerId } = buildListingMessageFromMaterial(material, storeId, { defaultStock });
  const result = await executeListing(message, storeId);

  const ok = !result.error;
  const r = db
    .prepare(`
      INSERT INTO listing_material_publishes
        (material_id, material_version, store_id, local_task_id, ozon_task_id, status, error_message, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `)
    .run(materialId, version, storeId, result.localTaskId || null, result.ozonTaskId || null, ok ? 'processing' : 'failed', result.error || null);
  if (ok) {
    db.prepare(`UPDATE listing_materials SET status='published', offer_id=?, updated_at=datetime('now') WHERE id=?`).run(offerId, materialId);
  }
  return { publishId: Number(r.lastInsertRowid), ...result, offerId };
}