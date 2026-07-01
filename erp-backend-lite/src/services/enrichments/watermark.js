// 水印加工模块(feature-flag: watermark)
// 对齐 0.13 applyWatermark —— 给商品图片打水印
// 依赖 sharp(可选原生编译);未安装时透传
import logger from '../../middleware/log.js';

let sharp = null;
try {
  const mod = await import('sharp');
  sharp = mod.default || mod;
} catch {
  sharp = null;
}

/**
 * @param {Array} items - 商品 items 数组
 * @param {object} message - 原始 followSell 消息体(含 watermarkTemplateId 等)
 * @returns {Promise<Array>} 打水印后的 items
 */
export async function apply(items, message) {
  if (!sharp) {
    logger.warn('sharp 未安装,水印降级为透传');
    return items;
  }

  const templateId = message?.watermarkTemplateId || 'default';
  let watermarked = 0;

  for (const item of items) {
    if (!Array.isArray(item.images)) continue;
    for (const img of item.images) {
      try {
        // 只处理 http(s) URL(跳过已转存的 ir.ozone.ru)
        if (!img.file_name || !/^https?:\/\//i.test(img.file_name)) continue;

        // 拉图 → 打水印 → 上传(个人版:暂只标记,不真实上传到 CDN)
        // 完整实现需对接 Ozon media-storage/upload-file,此处打标后透传
        // TODO: 对接 CDN 上传后替换 file_name
        img._watermarked = true;
        img._watermarkTemplate = templateId;
        watermarked++;
      } catch (e) {
        logger.warn({ offerId: item.offer_id, img: img.file_name, err: e?.message }, '水印单图失败');
      }
    }
  }

  logger.info({ total: items.length, watermarked }, '水印处理完成(标记模式)');
  return items;
}
