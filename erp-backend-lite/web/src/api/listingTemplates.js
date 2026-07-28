import * as request from './request.js';

// 上架模板列表
export function getListingTemplates() {
  return request.get('/admin/api/listing-templates');
}

// 单个模板
export function getListingTemplate(id) {
  return request.get('/admin/api/listing-templates/' + encodeURIComponent(id));
}

// 新增模板
export function createListingTemplate(body) {
  return request.post('/admin/api/listing-templates', body);
}

// 更新模板(内置模板不可改)
export function updateListingTemplate(id, body) {
  return request.put('/admin/api/listing-templates/' + encodeURIComponent(id), body);
}

// 删除模板(内置模板不可删)
export function deleteListingTemplate(id) {
  return request.del('/admin/api/listing-templates/' + encodeURIComponent(id));
}

// 预览 OPI v3 请求体(把 items 转换为 OPI v3 schema,不实际发送)
// storeId 可选,传入则后端按类目字典过滤查不到含义的属性
export function previewOpi(items, storeId) {
  return request.post('/admin/api/preview-opi', { items, storeId });
}

// 批量水印预览:传入图片 URL 数组 + watermarkTemplateId,返回水印处理后的图床 URL
// 用途:上架预览页勾选水印时,展示水印后的图片 + OPI JSON 用图床 URL 替换原 URL
export function previewWatermark(urls, templateId, sku) {
  return request.post('/admin/api/preview/watermark', { urls, templateId, sku });
}
