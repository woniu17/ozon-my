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
//   1: 剥掉按钮文案后为空(纯按钮文案) 或 开头命中"加载失败"关键词(占位文案)
//   2: 含按钮文案但剥后非空(真描述末尾粘 Читать далее 等,源数据需清洗)
//   3: 其余非空(正常描述)
export function classifyDescriptionQuality(descRaw) {
  if (!descRaw) return 0;
  const cleaned = String(descRaw).replace(DESCRIPTION_UI_CHROME_RE, ' ').trim();
  if (!cleaned || DESCRIPTION_LOAD_FAIL_RE.test(cleaned.slice(0, 120))) return 1;
  if (DESCRIPTION_UI_CHROME_RE.test(String(descRaw))) return 2;
  return 3;
}
