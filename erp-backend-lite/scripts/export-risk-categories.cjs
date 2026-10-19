// 一次性脚本:从本地缓存的 Ozon 类目树(ZH_HANS)导出全量类目 + 人工精选的销售风险类目
// 用法: node scripts/export-risk-categories.cjs [输出目录]
// 输出:
//   ozon-categories-all.json     全量类目(描述类目层 + 类型层,含层级路径)
//   ozon-categories-all.csv      全量类目 CSV
//   ozon-risk-categories.csv    精选销售风险类目(描述类目层 + 商品类型层,含匹配说明)
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = path.join(__dirname, '../data/erp.db');
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '../data');

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const row = db.prepare("SELECT payload, fetched_at FROM ozon_meta_category_tree WHERE language='ZH_HANS'").get();
if (!row) {
  console.error('未找到 ZH_HANS 类目树缓存,请先触发一次 getCategoryNameMaps 拉取 OPI 类目树');
  process.exit(1);
}
const tree = JSON.parse(row.payload);

// ── 1. 扁平化全量类目 ──────────────────────────────────────
const all = []; // { descriptionCategoryId, categoryName, typeId, typeName, path }
function walk(node, ancestors) {
  const isType = node.type_id != null;
  const catId = node.description_category_id ? Number(node.description_category_id) : null;
  const typeId = node.type_id ? Number(node.type_id) : null;
  const name = node.category_name || node.type_name || '';
  const nodePath = ancestors.concat(name || String(catId || typeId));
  if (isType) {
    all.push({
      descriptionCategoryId: catId,
      categoryName: node.category_name || '',
      typeId,
      typeName: node.type_name || '',
      path: nodePath.join(' / '),
      isType: 1,
    });
  } else if (catId) {
    all.push({
      descriptionCategoryId: catId,
      categoryName: name,
      typeId: null,
      typeName: '',
      path: nodePath.join(' / '),
      isType: 0,
    });
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) walk(c, nodePath);
  }
}
for (const root of tree) walk(root, []);

const categories = all.filter((x) => !x.isType);
const types = all.filter((x) => x.isType);

// ── 2. 人工精选高风险类目规则 ──────────────────────────────
// 每组: { group, catMatch: [类目名精确/包含], typeMatch: [类型名包含], reason }
// 规则按"描述类目名"和"商品类型名"分别匹配,命中即列入风险清单
const riskRules = [
  // 食品 / 饮料 / 酒精(需 EAC 食品认证、保质期短、仓储要求高)
  { group: '食品饮料', reason: '食品需EAC认证+保质期/仓储要求高', catMatch: ['食品', '果汁、水、饮料', '乳制品', '肉类和鱼类美食', '谷物片，零食', '无酒精啤酒', '无酒精的葡萄酒和香槟', 'Ozon Fresh食品', 'Ozon Fresh新鲜及冷冻肉类', '盐、 糖、 香料', '面包和糖果点心', '油，酱汁，醋', '保存', '面食、米类、面粉', '食物贮藏', '成人的糖果点心'], typeMatch: ['食品', '饮料', '酒', '啤酒', '葡萄酒', '香槟', '糖果', '巧克力', '茶叶', '咖啡', '奶粉', '婴儿食品', '零食', '罐头', '酱', '食用油', '蜂蜜', '坚果', '干果', '冷冻', '乳制品', '酸奶', '奶酪', '冰淇淋', '代餐', '蛋白棒', '能量棒', '果汁', '汽水', '能量饮料', '饮用水', '矿泉水'] },
  // 化妆品 / 护肤 / 美妆 / 个护(需国家注册/海关申报,部分成分受限)
  { group: '化妆护肤', reason: '化妆品需国家注册,成分受限', catMatch: ['护理化妆品', '彩妆', '护发产品', '面膜', '脱毛品', '剃须用品', '香水', '家居香水', '费洛蒙香水'], typeMatch: ['化妆品', '护肤', '面霜', '乳液', '爽肤水', '化妆水', '洗面奶', '面膜', '防晒', '口红', '唇膏', '粉底', '睫毛膏', '眼影', '腮红', '眉笔', '眼线', '指甲油', '卸妆', '粉饼', '遮瑕', '妆前', '定妆', '精油', '精华', '身体乳', '护手霜', '洗发水', '护发素', '染发', '香水', '沐浴露', '香皂', '牙膏', '漱口水', '除臭', '止汗', '剃须', '脱毛'] },
  // 药品 / 保健品 / 膳食补充 / 运动营养(需注册/受限)
  { group: '药品保健品', reason: '药品/保健品销售受限,需注册', catMatch: ['保健品', '膳食补充剂和维生素', '运动营养品', '医用耗材', '医用服装', '医用纺织品', '用于消毒、治疗和疗程的化学产品', '矫形学、绷带、压缩制品、假肢', '兽医药房'], typeMatch: ['药品', '药物', '保健品', '膳食补充', '维生素', '矿物质', '益生菌', '鱼油', '蛋白粉', '运动营养', '草药', '中药', '膏药', '医用', '口罩', '消毒', '抗菌', '避孕', '创可贴', '绷带', '体温计', '血压计', '按摩器', '针灸', '理疗'] },
  // 母婴 / 儿童玩具 / 婴儿食品(需 EAC 儿童用品认证)
  { group: '母婴儿童', reason: '儿童用品需EAC认证(玩具/纺织品/餐具)', catMatch: ['儿童用品', '儿童安全座椅', '婴儿声画监视器', '童车', '儿童乐器', '自行车，滑步车，滑板车', '儿童洗澡', '儿童便盆和坐便器', '儿童秤', '儿童喂食产品', '儿童背带', '儿童房', '吸奶器', '婴儿餐椅', '积木玩具套装', '婴儿车及附属品', '瓶子和奶嘴', '玩具', '婴儿床悬挂式摇铃', '灭菌器和奶瓶加热器', '尿布和卫生用品', '教学和游戏垫', '儿童电动车', '儿童电动秋千和躺椅', '无线电遥控玩具', '铁路', '婴儿围栏', '婴儿服装', '婴儿内衣', '教学玩具', '户外游戏', '游戏及体育设施', '儿童安全', '儿童创意活动与发展', '儿童背包、书包、包'], typeMatch: ['婴儿', '儿童', '玩具', '奶瓶', '安抚奶嘴', '纸尿裤', '尿布', '辅食', '孕妇', '哺乳', '婴儿食品', '奶粉'] },
  // 宠物食品 / 宠物用品(宠物食品需兽医认证)
  { group: '宠物相关', reason: '宠物食品需兽医认证', catMatch: ['宠物用品', '宠物护理用品', '宠物餐具', '兽医药房', '水族养殖化学品'], typeMatch: ['宠物食品', '猫粮', '狗粮', '饲料', '兽药', '动物'] },
  // 化工 / 危险品 / 杀虫剂 / 农药(需危险品运输认证/受限)
  { group: '化工危险品', reason: '危险品/化学品运输受限,需认证', catMatch: ['害虫驱虫产品', '洗涤剂和清洁剂', '土壤、化肥和园艺化学品', '涂料， 胶水', '壁纸和涂料', '烟花和焰火', '喷漆枪、喷枪'], typeMatch: ['杀虫剂', '灭鼠药', '除草剂', '农药', '漂白剂', '腐蚀', '易燃', '油漆', '涂料', '溶剂', '汽油', '煤油', '过氧化氢', '盐酸', '硫酸', '氨水', '烟花', '爆竹', '打火机', '火柴', '化肥'] },
  // 电池 / 电子烟 / 打火机 / 武器 / 其他受限
  { group: '其他受限', reason: '平台/法规明确受限类目', catMatch: ['电池和蓄电池', '电子烟和加热型', '打火机、火镰以及暖手袋', '气动武器和弩', '武器养护产品', '种子和幼苗', '花与植物', '情趣玩具', '性爱玩具护理和储存', '磁铁', '白酒'], typeMatch: ['电池', '锂电池', '充电宝', '电子烟', '打火机', '武器', '弹药', '刀具', '种子', '植物', '磁铁', '激光', 'GPS', '防身', '电击', '烟雾'] },
];

function matchRule(rule, it) {
  const name = it.categoryName || it.typeName || '';
  const path = it.path || '';
  if (!it.isType && rule.catMatch) {
    for (const c of rule.catMatch) {
      if (name === c || name.includes(c) || path.includes(c)) return true;
    }
  }
  if (it.isType && rule.typeMatch) {
    for (const t of rule.typeMatch) {
      if (name.includes(t) || path.includes(t)) return true;
    }
  }
  return false;
}

const riskRows = [];
for (const it of all) {
  for (const rule of riskRules) {
    if (matchRule(rule, it)) {
      riskRows.push({ ...it, group: rule.group, reason: rule.reason });
      break;
    }
  }
}

// 描述类目层去重(整类目过滤候选)
const catSeen = new Set();
const riskCats = riskRows.filter((r) => !r.isType && (!catSeen.has(r.descriptionCategoryId) && catSeen.add(r.descriptionCategoryId)));
// 类型层去重(同一 type 只保留一次)
const typeSeen = new Set();
const riskTypes = riskRows.filter((r) => {
  const k = `${r.descriptionCategoryId}:${r.typeId}`;
  return r.isType && !typeSeen.has(k) && typeSeen.add(k);
});

// ── 3. 写文件 ──────────────────────────────────────────────
function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'ozon-categories-all.json'), JSON.stringify({ fetchedAt: row.fetched_at, categories, types }, null, 2));
fs.writeFileSync(path.join(outDir, 'ozon-categories-all.csv'), toCsv(all));
fs.writeFileSync(path.join(outDir, 'ozon-risk-categories.csv'),
  '## 风险「描述类目」层(整类目过滤:typeId 填 0)\n' + toCsv(riskCats) + '\n\n' +
  '## 风险「商品类型」层(精确过滤:typeId 填 typeId)\n' + toCsv(riskTypes)
);

console.log(`全量类目: 描述类目 ${categories.length} 个 / 商品类型 ${types.length} 个`);
console.log(`精选风险: 描述类目 ${riskCats.length} 个 / 商品类型 ${riskTypes.length} 个`);
console.log(`输出: ${outDir}/ozon-categories-all.json`);
console.log(`      ${outDir}/ozon-categories-all.csv`);
console.log(`      ${outDir}/ozon-risk-categories.csv`);