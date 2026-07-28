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
import { processImage, sharpAvailable } from '../image-host.js';

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

  // 4. 遍历 items 处理图片
  let total = 0;
  let processed = 0;
  let fallback = 0;

  for (const item of items) {
    if (!Array.isArray(item.images)) continue;
    // SKU 提取:offer_id 形如 "4143566763-0718-qx",取首段;否则用 offer_id 整体
    const sku = String(item.offer_id || '').split('-')[0] || 'unknown';

    for (const img of item.images) {
      // 只处理 http(s) URL(跳过已是图床 URL 的 /images/... 相对路径或 data: URL)
      if (!img?.file_name || !/^https?:\/\//i.test(img.file_name)) continue;
      total++;
      try {
        const publicUrl = await processImage(img.file_name, sku, templateConfig);
        // 成功:替换 file_name,保留 default 字段不变
        img.file_name = publicUrl;
        processed++;
      } catch (e) {
        // 失败:透传原 URL,记录 warn
        logger.warn({ offerId: item.offer_id, url: img.file_name, err: e?.message }, '水印处理失败,透传原图');
        fallback++;
      }
    }
  }

  logger.info({ totalItems: items.length, total, processed, fallback }, '水印处理完成');
  return items;
}
