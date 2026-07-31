// FieldUpdater: 标题(name/4180)
// 替换 opiItem.name(顶层字段,非 attribute)
// 校验:非空字符串,trim 后长度 > 0
export default function updateName(pInfo, pAttrs, opiItem, newName) {
  if (typeof newName !== 'string' || !newName.trim()) {
    throw new Error('新标题不能为空');
  }
  opiItem.name = newName.trim();
}
