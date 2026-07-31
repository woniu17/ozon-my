// FieldUpdater 注册表(2026-07)
// 商品信息更新任务的可拓展核心:每个可更新字段对应一个 updater 函数
// 接口契约:
//   updater(pInfo, pAttrs, opiItem, newValue)
//   - pInfo: /v3/product/info/list 返回的商品顶层字段
//   - pAttrs: /v4/product/info/attributes 返回的商品属性
//   - opiItem: 已构建好的 OPI v3 item(保留 Ozon 实时值),updater 修改对应字段
//   - newValue: 用户指定的新值
// 新增字段只需:
//   1. 在本目录新增 {field}.js
//   2. 在此 REGISTRY 注册
//   3. 前端弹窗加对应的输入控件
import updateName from './name.js';
import updateDescription from './description.js';

const REGISTRY = {
  name: updateName,
  description: updateDescription,
  // 后续拓展(本期不实现,留接口):
  // price: updatePrice,           // 替换 opiItem.price,同步调整 min_price 保证 < price
  // old_price: updateOldPrice,    // 替换 opiItem.old_price
  // weight: updateWeight,         // 替换 opiItem.weight + weight_unit
  // dimensions: updateDimensions, // 替换 opiItem.depth/width/height + dimension_unit
  // primary_image: updatePrimaryImage, // 替换 opiItem.primary_image
  // images: updateImages,         // 替换 opiItem.images
};

// 统一入口:按 updateFields 顺序应用对应 updater 修改 opiItem
export function applyFieldUpdaters(pInfo, pAttrs, opiItem, updateFields, newValues) {
  if (!Array.isArray(updateFields)) {
    throw new Error('updateFields 必须是数组');
  }
  for (const field of updateFields) {
    const updater = REGISTRY[field];
    if (!updater) {
      throw new Error(`不支持的更新字段: ${field}`);
    }
    updater(pInfo, pAttrs, opiItem, newValues[field]);
  }
  return opiItem;
}

// 查询当前支持更新的字段列表(供 /supported-fields 接口使用)
export function getSupportedFields() {
  return Object.keys(REGISTRY);
}
