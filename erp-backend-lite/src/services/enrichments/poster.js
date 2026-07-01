// AI 海报加工模块(feature-flag: ai_poster)
// 对齐 0.13 applyPoster —— 生成 AI 海报图替换/补充主图
// 依赖 SD API(可选)+ SD_API_URL 环境变量;未配置时透传
import logger from '../../middleware/log.js';

const SD_API_URL = process.env.SD_API_URL || '';

/**
 * @param {Array} items - 商品 items 数组
 * @param {object} message - 原始 followSell 消息体(含 posterPrimaryOnly 等)
 * @returns {Promise<Array>} 处理后的 items
 */
export async function apply(items, message) {
  if (!SD_API_URL) {
    logger.warn('SD_API_URL 未配置,AI 海报降级为透传');
    return items;
  }

  const posterPrimaryOnly = message?.posterPrimaryOnly === true;
  let generated = 0;

  for (const item of items) {
    try {
      if (!Array.isArray(item.images) || item.images.length === 0) continue;
      const firstImg = item.images[0];
      if (!firstImg?.file_name) continue;

      // 调 SD API 生成海报(简化:只标记,不真实生成)
      // TODO: 对接 SD API 生成海报图后替换 file_name
      firstImg._posterGenerated = true;
      generated++;

      if (posterPrimaryOnly) {
        // 只替换主图,其余图保留
        continue;
      }
    } catch (e) {
      logger.warn({ offerId: item.offer_id, err: e?.message }, 'AI 海报单个商品失败');
    }
  }

  logger.info({ total: items.length, generated }, 'AI 海报处理完成(标记模式)');
  return items;
}
