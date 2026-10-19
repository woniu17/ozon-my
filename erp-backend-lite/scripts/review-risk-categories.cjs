// 复查脚本:1) 列出全部一级类目 2) 扫描未覆盖的潜在风险关键词 3) 对比已加入黑名单的类目
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const ERP_DB = path.join(__dirname, '../data/erp.db');
const COLLECT_DB = path.join(__dirname, '../data/collect.db');
const erp = new DatabaseSync(ERP_DB, { readOnly: true });
const collect = new DatabaseSync(COLLECT_DB, { readOnly: true });

const row = erp.prepare("SELECT payload FROM ozon_meta_category_tree WHERE language='ZH_HANS'").get();
const tree = JSON.parse(row.payload);

// 扁平化
const all = [];
function walk(node, ancestors, lvl) {
  const isType = node.type_id != null;
  const catId = node.description_category_id ? Number(node.description_category_id) : null;
  const typeId = node.type_id ? Number(node.type_id) : null;
  const name = node.category_name || node.type_name || '';
  const nodePath = ancestors.concat(name || String(catId || typeId));
  all.push({
    descriptionCategoryId: catId, categoryName: node.category_name || '',
    typeId, typeName: node.type_name || '', path: nodePath.join(' / '),
    isType: isType ? 1 : 0, level: lvl,
  });
  if (Array.isArray(node.children)) for (const c of node.children) walk(c, nodePath, lvl + 1);
}
for (const root of tree) walk(root, [], 1);

// 已加入黑名单的 descriptionCategoryId(含 type_id=0 和 type_id>0 两种)
const black = new Set();
for (const r of collect.prepare('SELECT description_category_id FROM ozon_filtered_categories').all()) {
  black.add(Number(r.description_category_id));
}

// ── 1. 一级类目总览 ──
const l1 = all.filter((x) => x.level === 1 && !x.isType);
console.log('==== 一级类目总览 ====');
for (const c of l1.sort((a, b) => b.path.length - a.path.length)) {
  const sub = all.filter((x) => !x.isType && x.path.startsWith(c.path + ' / ') || (x.path === c.path));
  const types = all.filter((x) => x.isType && x.path.startsWith(c.path + ' / '));
  console.log(`  ${c.descriptionCategoryId} | ${c.categoryName} | 子类目 ${sub.length} / 类型 ${types.length}`);
}

// ── 2. 潜在风险关键词扫描(排除已加入黑名单的类目) ──
const riskKeywords = [
  '烟草', '吸烟', '烟', '电子烟', '酒', '酒精', '成人', '性爱', '情趣', '武器', '弹药', '爆炸', '火药',
  '易燃', '腐蚀', '毒', '放射性', '辐射', '激光', '高压', '医用', '药用', '麻醉', '化工', '危险',
  '压缩气体', '气罐', '农药', '除草', '杀虫', '灭菌', '消毒', '酸', '碱', '氧化剂', '汽油', '煤油',
  '火柴', '打火机', '烟花', '爆竹', '种子', '植物', '化肥', '饲料', '药品', '保健品', '膳食补充',
  '化妆品', '护肤', '彩妆', '香水', '食品', '饮料', '乳制品', '肉', '鱼', '冷冻',
];
console.log('\n==== 潜在风险类目扫描(尚未加入黑名单) ====');
const seen = new Set();
for (const it of all) {
  if (it.isType) continue;
  const texts = [it.categoryName, it.path].join(' ');
  const kw = riskKeywords.find((k) => texts.includes(k));
  if (!kw) continue;
  if (black.has(it.descriptionCategoryId)) continue;
  const k = it.descriptionCategoryId;
  if (seen.has(k)) continue;
  seen.add(k);
  const subTypes = all.filter((x) => x.isType && x.descriptionCategoryId === k);
  console.log(`  ${k} | ${it.categoryName} | 命中:${kw} | 子类型 ${subTypes.length} | 路径:${it.path}`);
}
console.log(`\n未加入黑名单的潜在风险描述类目数: ${seen.size}`);