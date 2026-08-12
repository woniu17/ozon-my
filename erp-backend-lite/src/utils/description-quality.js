// 描述质量分级(共享逻辑)
// 与 qx-ozon/lib/follow-sell-content-copy.js、scripts/backfill-description-quality.mjs 同口径
// 供 index-dao.js(采集箱 syncSku)、admin.js(商品列表同步)、index.js(回填迁移) 复用
//
// 按钮/展开文案 → 剥掉(真描述末尾偶尔会粘到)
const DESCRIPTION_UI_CHROME_RE = /(читать далее|показать полностью|свернуть описание|развернуть описание)/gi;
// 加载失败类提示 → 判占位
const DESCRIPTION_LOAD_FAIL_RE = /(не удалось загрузить|ошибка загрузки|попробуйте (обновить|позже)|failed to load)/i;

// 描述质量分级:0=空 1=占位 2=按钮污染 3=正常
//   0: description 为空/NULL
//   1: 剥掉按钮文案后为空(纯按钮文案) 或 任意位置命中"加载失败"关键词(占位文案)
//      注:加载失败关键词(Не удалось загрузить / Ошибка загрузки 等)无论出现在开头还是末尾
//      都是 Ozon 加载占位文案,属于质量问题,统一判占位(2026-08 修复:原仅看前 120 字会漏判末尾占位)
//   2: 含按钮文案但剥后非空(真描述末尾粘 Читать далее 等,源数据需清洗)
//   3: 其余非空(正常描述)
export function classifyDescriptionQuality(descRaw) {
  if (!descRaw) return 0;
  const cleaned = String(descRaw).replace(DESCRIPTION_UI_CHROME_RE, ' ').trim();
  if (!cleaned || DESCRIPTION_LOAD_FAIL_RE.test(cleaned)) return 1;
  if (DESCRIPTION_UI_CHROME_RE.test(String(descRaw))) return 2;
  return 3;
}
