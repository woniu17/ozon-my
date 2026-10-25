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

// AI 多风格重写:为素材生成 count 个风格变体(标题+描述)
// 返回 [{ name, description }] 数组;openai 不可用/未配置时返回 null(调用方回退模板)
// 风格见 STYLE_PROMPTS,生成失败的单变体会被跳过,最终返回成功的变体
const STYLE_PROMPTS = {
  marketing: '营销风格:突出卖点与使用场景,适当使用吸引人的修饰词,但不夸大、不虚构参数',
  simple: '简洁风格:只保留核心参数与类型,去掉冗余修饰词与空话',
  seo: 'SEO 风格:自然融入搜索高频词(材质/用途/参数/场景),保持可读性',
  default: '电商标题优化:保留真实参数,使其更吸引俄罗斯买家',
};

export async function rewriteVariants({ name, description = '', styles = [], count = 1, language = 'ru' } = {}) {
  if (!openai || !API_KEY) {
    logger.warn('openai 未安装或 OPENAI_API_KEY 未配置,AI 多风格重写不可用');
    return null;
  }
  if (!name) return null;
  const client = new openai({ apiKey: API_KEY });
  const countInt = Math.max(1, Math.min(5, Math.floor(count) || 1));
  const langName = language === 'ru' ? '俄语' : '俄语';
  const variants = [];

  for (let i = 0; i < countInt; i++) {
    const style = styles?.[i] || 'default';
    const stylePrompt = STYLE_PROMPTS[style] || STYLE_PROMPTS.default;
    try {
      const titleResp = await client.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content: `你是 Ozon 电商文案专家。请用${langName}重写商品标题。要求:${stylePrompt};不超过 200 字符;只输出标题,不要引号、编号或多余解释。`,
          },
          { role: 'user', content: name },
        ],
        max_tokens: 120,
        temperature: 0.85,
      });
      const newTitle = titleResp.choices?.[0]?.message?.content?.trim();
      if (!newTitle || newTitle.length === 0 || newTitle.length > 200) continue;

      let newDesc = '';
      if (description && description.length > 20) {
        const descResp = await client.chat.completions.create({
          model: MODEL,
          messages: [
            {
              role: 'system',
              content: `你是 Ozon 电商文案专家。请用${langName}重写商品描述。要求:风格与标题变体一致(${style}风格);保留所有真实参数(尺寸/材质/压力/温度等),不得虚构;不超过 4096 字符;只输出描述正文。`,
            },
            { role: 'user', content: String(description).slice(0, 2000) },
          ],
          max_tokens: 600,
          temperature: 0.8,
        });
        const newDescRaw = descResp.choices?.[0]?.message?.content?.trim();
        if (newDescRaw && newDescRaw.length > 0 && newDescRaw.length <= 4096) newDesc = newDescRaw;
      }

      variants.push({ name: newTitle, description: newDesc || description || '' });
    } catch (e) {
      logger.warn({ style, err: e?.message }, 'AI 重写单个变体失败,跳过该变体');
    }
  }

  return variants.length ? variants : null;
}

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
            {
              role: 'system',
              content: '你是电商文案专家。重写商品标题使其更吸引俄罗斯买家,保持俄文,不超过 200 字符,只输出标题。',
            },
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
            {
              role: 'system',
              content: '你是电商文案专家。优化商品描述,突出卖点,保持俄文,不超过 4096 字符,只输出描述。',
            },
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
