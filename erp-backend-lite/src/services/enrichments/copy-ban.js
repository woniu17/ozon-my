// 防搬运加工模块(feature-flag: copy_ban_solution)
// 对齐 0.13 enableCopyBanSolution —— 防止商品被其他卖家搬运
// 无外部依赖;在 item 上标记防搬运属性
import logger from '../../middleware/log.js';

/**
 * @param {Array} items - 商品 items 数组
 * @param {object} message - 原始 followSell 消息体
 * @returns {Promise<Array>} 标记防搬运后的 items
 */
export async function apply(items, message) {
  let marked = 0;

  for (const item of items) {
    try {
      // 防搬运:在描述末尾追加版权声明 + 在 attributes 标记
      const copyrightNotice = '\n\n⚠️ Данный товар защищен от копирования. Все права защищены.';
      if (item.scraped_description && !item.scraped_description.includes('защищен от копирования')) {
        item.scraped_description =
          String(item.scraped_description).slice(0, 4096 - copyrightNotice.length) + copyrightNotice;
      }

      // 标记防搬运属性(供后续 seller portal 写入时识别)
      item._copyBanEnabled = true;
      marked++;
    } catch (e) {
      logger.warn({ offerId: item.offer_id, err: e?.message }, '防搬运标记失败');
    }
  }

  logger.info({ total: items.length, marked }, '防搬运处理完成');
  return items;
}
