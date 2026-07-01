// AI 重写加工模块(feature-flag: ai_rewrite)
// 对齐 0.13 applyAiRewrite —— 重写标题/描述,提升搜索曝光
// 依赖 openai(可选)+ OPENAI_API_KEY 环境变量;未安装/未配置时透传
import logger from '../../middleware/log.js';

let openai = null;
try {
  const mod = await import('openai');
  openai = mod.default || mod;
} catch {
  openai = null;
}

const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/**
 * @param {Array} items - 商品 items 数组
 * @param {object} message - 原始 followSell 消息体(含 applyAiRewrite 等选项)
 * @returns {Promise<Array>} 重写后的 items(原地修改+返回)
 */
export async function apply(items, message) {
  if (!openai || !API_KEY) {
    logger.warn('openai 未安装或 OPENAI_API_KEY 未配置,AI 重写降级为透传');
    return items;
  }

  const client = new openai({ apiKey: API_KEY });
  let rewritten = 0;

  for (const item of items) {
    try {
      // 重写标题(保持 < 200 字符)
      if (item.name && item.name.length > 0) {
        const titleResp = await client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: 'system', content: '你是电商文案专家。重写商品标题使其更吸引俄罗斯买家,保持俄文,不超过 200 字符,只输出标题。' },
            { role: 'user', content: item.name },
          ],
          max_tokens: 100,
          temperature: 0.7,
        });
        const newTitle = titleResp.choices?.[0]?.message?.content?.trim();
        if (newTitle && newTitle.length > 0 && newTitle.length <= 200) {
          item.name = newTitle;
          rewritten++;
        }
      }

      // 重写描述(保持 < 4096 字符)
      if (item.scraped_description && item.scraped_description.length > 20) {
        const descResp = await client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: 'system', content: '你是电商文案专家。优化商品描述,突出卖点,保持俄文,不超过 4096 字符,只输出描述。' },
            { role: 'user', content: String(item.scraped_description).slice(0, 2000) },
          ],
          max_tokens: 500,
          temperature: 0.7,
        });
        const newDesc = descResp.choices?.[0]?.message?.content?.trim();
        if (newDesc && newDesc.length > 0 && newDesc.length <= 4096) {
          item.scraped_description = newDesc;
        }
      }
    } catch (e) {
      logger.warn({ offerId: item.offer_id, err: e?.message }, 'AI 重写单个商品失败,保留原文');
    }
  }

  logger.info({ total: items.length, rewritten }, 'AI 重写完成');
  return items;
}
