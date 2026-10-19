// 一次性脚本:把指定风险分组(食品饮料/化妆护肤/药品保健品/母婴儿童)的"描述类目"加入类目过滤黑名单
// 写入方式:直接 INSERT INTO ozon_filtered_categories(description_category_id, type_id=0, category_name)
// 整类目过滤:type_id=0 表示该类目下所有商品类型都命中黑名单
// 用法: node scripts/add-risk-categories-to-filter.cjs [--apply]  不加 --apply 只预览
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const ERP_DB = path.join(__dirname, '../data/erp.db');
const COLLECT_DB = path.join(__dirname, '../data/collect.db');
const apply = process.argv.includes('--apply');

// ── 1. 加载类目树并扁平化(与 export-risk-categories.cjs 相同逻辑) ──
const erp = new DatabaseSync(ERP_DB, { readOnly: true });
const row = erp.prepare("SELECT payload FROM ozon_meta_category_tree WHERE language='ZH_HANS'").get();
if (!row) { console.error('未找到类目树缓存'); process.exit(1); }
const tree = JSON.parse(row.payload);

const all = [];
function walk(node, ancestors) {
  const isType = node.type_id != null;
  const catId = node.description_category_id ? Number(node.description_category_id) : null;
  const typeId = node.type_id ? Number(node.type_id) : null;
  const name = node.category_name || node.type_name || '';
  const nodePath = ancestors.concat(name || String(catId || typeId));
  if (isType) {
    all.push({ descriptionCategoryId: catId, categoryName: node.category_name || '', typeId, typeName: node.type_name || '', path: nodePath.join(' / '), isType: 1 });
  } else if (catId) {
    all.push({ descriptionCategoryId: catId, categoryName: name, typeId: null, typeName: '', path: nodePath.join(' / '), isType: 0 });
  }
  if (Array.isArray(node.children)) for (const c of node.children) walk(c, nodePath);
}
for (const root of tree) walk(root, []);

// ── 2. 风险规则(与 export 脚本相同,只取 4 个分组) ──
const groups = ['明确高风险', '食品饮料', '化妆护肤', '药品保健品', '母婴儿童', '化工危险品'];
const riskRules = [
  // 明确高风险:吸烟(含一级+全部子类)、成人用品(含一级+全部子类)、武器、危险品、植物检疫
  { group: '明确高风险', catMatch: ['吸烟产品和配件', '水烟的配件和组件', '电子烟和加热型', '烟具', '成人用品', '性虐', '私处护理用品', '情趣玩具', '情趣纪念品和游戏', '性爱玩具护理和储存', '性爱家具和纺织品', '武器养护产品', '气动武器和弩', '打火机、火镰以及暖手袋', '电池和蓄电池', '种子和幼苗', '花与植物'], typeMatch: [] },
  { group: '食品饮料', catMatch: ['食品', '果汁、水、饮料', '乳制品', '肉类和鱼类美食', '谷物片，零食', '无酒精啤酒', '无酒精的葡萄酒和香槟', 'Ozon Fresh食品', 'Ozon Fresh新鲜及冷冻肉类', '盐、 糖、 香料', '面包和糖果点心', '油，酱汁，醋', '保存', '面食、米类、面粉', '食物贮藏', '成人的糖果点心'], typeMatch: [] },
  { group: '化妆护肤', catMatch: ['护理化妆品', '彩妆', '护发产品', '面膜', '脱毛品', '剃须用品', '香水', '家居香水', '费洛蒙香水'], typeMatch: [] },
  { group: '药品保健品', catMatch: ['保健品', '膳食补充剂和维生素', '运动营养品', '医用耗材', '医用服装', '医用纺织品', '用于消毒、治疗和疗程的化学产品', '矫形学、绷带、压缩制品、假肢', '兽医药房'], typeMatch: [] },
  { group: '母婴儿童', catMatch: ['儿童用品', '儿童安全座椅', '婴儿声画监视器', '童车', '儿童乐器', '自行车，滑步车，滑板车', '儿童洗澡', '儿童便盆和坐便器', '儿童秤', '儿童喂食产品', '儿童背带', '儿童房', '吸奶器', '婴儿餐椅', '积木玩具套装', '婴儿车及附属品', '瓶子和奶嘴', '玩具', '婴儿床悬挂式摇铃', '灭菌器和奶瓶加热器', '尿布和卫生用品', '教学和游戏垫', '儿童电动车', '儿童电动秋千和躺椅', '无线电遥控玩具', '铁路', '婴儿围栏', '婴儿服装', '婴儿内衣', '教学玩具', '户外游戏', '游戏及体育设施', '儿童安全', '儿童创意活动与发展', '儿童背包、书包、包'], typeMatch: [] },
  { group: '化工危险品', catMatch: ['害虫驱虫产品', '洗涤剂和清洁剂', '土壤、化肥和园艺化学品', '涂料， 胶水', '壁纸和涂料', '烟花和焰火', '喷漆枪、喷枪'], typeMatch: [] },
];

function matchRule(rule, it) {
  if (it.isType) return false; // 本次只加"描述类目"层
  const name = it.categoryName || '';
  const path = it.path || '';
  for (const c of rule.catMatch) {
    if (name === c || name.includes(c) || path.includes(c)) return true;
  }
  return false;
}

// 去重:同一 descriptionCategoryId 只保留一条(整类目过滤)
const catMap = new Map();
for (const it of all) {
  if (it.isType || !it.descriptionCategoryId) continue;
  const rule = riskRules.find((r) => groups.includes(r.group) && matchRule(r, it));
  if (!rule) continue;
  const k = it.descriptionCategoryId;
  if (!catMap.has(k) || catMap.get(k).path.length > it.path.length) {
    catMap.set(k, { descriptionCategoryId: k, categoryName: it.categoryName, path: it.path, group: rule.group });
  }
}
// 排除误命中(明确高风险组已显式覆盖情趣玩具/性爱玩具护理,无需再排除)
const excludeCatIds = new Set([]);
const toAdd = [...catMap.values()]
  .filter((r) => !excludeCatIds.has(r.descriptionCategoryId))
  .sort((a, b) => a.group.localeCompare(b.group) || a.descriptionCategoryId - b.descriptionCategoryId);
const byGroup = {};
for (const r of toAdd) (byGroup[r.group] = byGroup[r.group] || []).push(r);

console.log(`待加入黑名单(整类目过滤,type_id=0): ${toAdd.length} 个描述类目\n`);
for (const [g, list] of Object.entries(byGroup)) {
  console.log(`==== ${g} (${list.length}) ====`);
  for (const r of list) console.log(`  ${r.descriptionCategoryId} | ${r.categoryName} | ${r.path}`);
}

// ── 3. 写入黑名单 ──
if (!apply) {
  console.log('\n[预览模式] 未写入。加 --apply 参数执行写入。');
  process.exit(0);
}
const collect = new DatabaseSync(COLLECT_DB);
const stmt = collect.prepare(
  `INSERT INTO ozon_filtered_categories (description_category_id, type_id, category_name, type_name, created_at)
   VALUES (?, 0, ?, NULL, datetime('now'))
   ON CONFLICT(description_category_id, type_id) DO UPDATE SET category_name = excluded.category_name`
);
let added = 0, updated = 0;
collect.exec('BEGIN');
try {
  for (const r of toAdd) {
    const res = stmt.run(r.descriptionCategoryId, r.categoryName || null);
    if (res.changes > 0) added++; else updated++;
  }
  collect.exec('COMMIT');
} catch (e) {
  collect.exec('ROLLBACK');
  throw e;
}
console.log(`\n写入完成:新增 ${added} 条,已存在并更新名称 ${updated} 条,合计黑名单描述类目 ${toAdd.length} 条。`);