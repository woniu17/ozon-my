// 类目元数据 DAO(SQLite)
// 持久化 OPI description-category 系列响应,跨店铺共享(平台级数据)
// 设计:每个查询维度一行,完整 JSON 存 payload
// 失效策略:永久缓存,仅管理员手动清空(refresh 路由触发 delete)
import { db } from '../../index.js';

function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ── 类目树(/v1/description-category/tree) ──────────────────
// 主键:language(整棵树按语言存一行)

export function getCategoryTree(language) {
  const row = db
    .prepare('SELECT payload FROM ozon_meta_category_tree WHERE language = ?')
    .get(language);
  return row ? parseJson(row.payload) : null;
}

export function upsertCategoryTree(language, payload) {
  db.prepare(
    `INSERT INTO ozon_meta_category_tree (language, payload, fetched_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(language) DO UPDATE
       SET payload = excluded.payload, fetched_at = datetime('now')`
  ).run(language, JSON.stringify(payload));
}

export function deleteCategoryTree(language) {
  db.prepare('DELETE FROM ozon_meta_category_tree WHERE language = ?').run(language);
}

// ── 类目+类型下属性(/v1/description-category/attribute) ──────
// 主键:(description_category_id, type_id, language)

export function getCategoryAttributes(descriptionCategoryId, typeId, language) {
  const row = db
    .prepare(
      `SELECT payload FROM ozon_meta_category_attributes
       WHERE description_category_id = ? AND type_id = ? AND language = ?`
    )
    .get(descriptionCategoryId, typeId, language);
  return row ? parseJson(row.payload) : null;
}

export function upsertCategoryAttributes(descriptionCategoryId, typeId, language, payload) {
  db.prepare(
    `INSERT INTO ozon_meta_category_attributes (description_category_id, type_id, language, payload, fetched_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(description_category_id, type_id, language) DO UPDATE
       SET payload = excluded.payload, fetched_at = datetime('now')`
  ).run(descriptionCategoryId, typeId, language, JSON.stringify(payload));
}

// 精确删除:传 categoryId+typeId 删单条;不传删该 language 全部
export function deleteCategoryAttributes(language, categoryId = null, typeId = null) {
  if (categoryId != null && typeId != null) {
    db.prepare(
      `DELETE FROM ozon_meta_category_attributes
       WHERE language = ? AND description_category_id = ? AND type_id = ?`
    ).run(language, categoryId, typeId);
  } else {
    db.prepare('DELETE FROM ozon_meta_category_attributes WHERE language = ?').run(language);
  }
}

// ── 字典属性可选值(/v1/description-category/attribute/values) ─
// 主键:(description_category_id, type_id, attribute_id, language)

export function getAttributeValues(descriptionCategoryId, typeId, attributeId, language) {
  const row = db
    .prepare(
      `SELECT payload FROM ozon_meta_attribute_values
       WHERE description_category_id = ? AND type_id = ? AND attribute_id = ? AND language = ?`
    )
    .get(descriptionCategoryId, typeId, attributeId, language);
  return row ? parseJson(row.payload) : null;
}

export function upsertAttributeValues(
  descriptionCategoryId,
  typeId,
  attributeId,
  language,
  payload
) {
  db.prepare(
    `INSERT INTO ozon_meta_attribute_values (description_category_id, type_id, attribute_id, language, payload, fetched_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(description_category_id, type_id, attribute_id, language) DO UPDATE
       SET payload = excluded.payload, fetched_at = datetime('now')`
  ).run(descriptionCategoryId, typeId, attributeId, language, JSON.stringify(payload));
}

// 精确删除:传 attributeId 删单条;传 categoryId+typeId 删该类目下全部;
// 都不传删该 language 全部
export function deleteAttributeValues(
  language,
  categoryId = null,
  typeId = null,
  attributeId = null
) {
  if (categoryId != null && typeId != null && attributeId != null) {
    db.prepare(
      `DELETE FROM ozon_meta_attribute_values
       WHERE language = ? AND description_category_id = ? AND type_id = ? AND attribute_id = ?`
    ).run(language, categoryId, typeId, attributeId);
  } else if (categoryId != null && typeId != null) {
    db.prepare(
      `DELETE FROM ozon_meta_attribute_values
       WHERE language = ? AND description_category_id = ? AND type_id = ?`
    ).run(language, categoryId, typeId);
  } else {
    db.prepare('DELETE FROM ozon_meta_attribute_values WHERE language = ?').run(language);
  }
}
