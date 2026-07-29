/**
 * 水印加工模块(feature-flag: watermark)
 *
 * 职责:
 *   在 prepareBundleItems 加工链中给 item.images 打水印并替换为图床 URL。
 *   真实下载原图 → sharp 渲染水印 → 落盘到图床目录 → 用公网 URL 替换 file_name。
 *
 * 触发条件:
 *   message.applyWatermark === true 且 message.watermarkTemplateId 为有效数字。
 *
 * 失败降级:
 *   - sharp 未安装 / 模板不存在 / config 无效 → 整批透传原图 URL,不阻断上架
 *   - 单图处理失败 → 该图透传原 URL,不影响其他图
 *
 * 水印模板 config JSON schema(与 schema.sql 注释一致):
 *   {
 *     "type": "text|border|image",
 *     "text":   { "content": "string", "fontSize": 32, "color": "#FFFFFF", "opacity": 0.6, "position": "bottom-right" },
 *     "border": { "width": 10, "color": "#000000", "opacity": 0.5 },
 *     "image":  { "url": "https://...", "scale": 0.2, "opacity": 0.5, "position": "bottom-right" }
 *   }
 *   position 枚举: top-left | top-right | bottom-left | bottom-right | center
 */
import logger from '../../middleware/log.js';
import { db } from '../../db/index.js';
import { processImageBatch, sharpAvailable } from '../image-host.js';

/**
 * @param {Array} items - 商品 items 数组
 * @param {object} message - 原始 followSell 消息体(含 watermarkTemplateId / applyWatermark)
 * @returns {Promise<Array>} 处理后的 items(图片 URL 已替换为图床 URL,失败图透传原 URL)
 */
export async function apply(items, message) {
  // 1. 前置检查:sharp 未安装 → 整批透传
  if (!sharpAvailable) {
    logger.warn('sharp 未安装,水印降级为透传');
    return items;
  }

  // 2. 解析 message 字段
  const templateId = Number(message?.watermarkTemplateId) || 0;
  if (!templateId) {
    logger.warn('watermarkTemplateId 为空,水印透传');
    return items;
  }

  // 3. 查 watermark_templates 表拿 config
  let templateConfig = null;
  try {
    const row = db.prepare('SELECT config FROM watermark_templates WHERE id=?').get(templateId);
    if (!row) {
      logger.warn({ templateId }, '水印模板不存在,水印透传');
      return items;
    }
    templateConfig = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
  } catch (e) {
    logger.warn({ templateId, err: e?.message }, '水印模板读取失败,水印透传');
    return items;
  }

  if (!templateConfig || !templateConfig.type) {
    logger.warn({ templateId }, '水印模板 config 无效(type 缺失),水印透传');
    return items;
  }

  // 4. 遍历 items 处理图片(每 item 一次批量调用,本地并行/远程 1 次 HTTP)
  let total = 0;
  let processed = 0;
  let fallback = 0;

  for (const item of items) {
    if (!Array.isArray(item.images)) continue;
    // SKU 提取:offer_id 形如 "4143566763-0718-qx",取首段;否则用 offer_id 整体
    const sku = String(item.offer_id || '').split('-')[0] || 'unknown';

    // 收集该 item 下所有 http(s) 图片 URL(跳过已是图床 URL 的 /images/... 相对路径或 data: URL)
    const urls = [];
    for (const img of item.images) {
      if (img?.file_name && /^https?:\/\//i.test(img.file_name)) {
        urls.push(img.file_name);
      }
    }
    if (urls.length === 0) continue;
    total += urls.length;

    try {
      // 批量处理:本地模式 Promise.all 并行渲染,远程模式 1 次 HTTP
      const { results } = await processImageBatch(urls, sku, templateConfig);
      // 构建 originalUrl → publicUrl 映射(失败项透传原图)
      const urlMap = new Map();
      for (const r of results) {
        if (r.ok) {
          urlMap.set(r.originalUrl, r.publicUrl);
          processed++;
        } else {
          urlMap.set(r.originalUrl, r.originalUrl);
          fallback++;
          logger.warn({ offerId: item.offer_id, url: r.originalUrl, err: r.error }, '水印处理失败,透传原图');
        }
      }
      // 回写到 item.images
      for (const img of item.images) {
        if (img?.file_name && urlMap.has(img.file_name)) {
          img.file_name = urlMap.get(img.file_name);
        }
      }
    } catch (e) {
      // 整体失败(远程网络异常等):该 item 所有图透传原图
      fallback += urls.length;
      logger.warn({ offerId: item.offer_id, err: e?.message }, '水印批量处理整体失败,该 item 透传原图');
    }
  }

  logger.info({ totalItems: items.length, total, processed, fallback }, '水印处理完成');
  return items;
}
