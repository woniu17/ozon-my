// FieldUpdater: 描述(description/4191/Аннотация)
// 替换 opiItem.attributes 中 id=4191 的值;不存在则追加
// 校验:必须是字符串(允许空字符串,用于清空描述)
const ATTR_ID_DESCRIPTION = 4191;

export default function updateDescription(pInfo, pAttrs, opiItem, newDescription) {
  if (typeof newDescription !== 'string') {
    throw new Error('新描述类型错误(应为字符串)');
  }
  const existing = opiItem.attributes.find((a) => Number(a.id) === ATTR_ID_DESCRIPTION);
  if (existing) {
    existing.values = [{ value: newDescription }];
  } else {
    opiItem.attributes.push({
      complex_id: 0,
      id: ATTR_ID_DESCRIPTION,
      values: [{ value: newDescription }],
    });
  }
}
