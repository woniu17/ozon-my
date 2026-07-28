import * as request from './request.js';

// 水印模板列表
export function getWatermarkTemplates() {
  return request.get('/watermark-templates');
}

// 新增水印模板
export function createWatermarkTemplate(body) {
  return request.post('/watermark-templates', body);
}

// 更新水印模板
export function updateWatermarkTemplate(id, body) {
  return request.put('/watermark-templates/' + encodeURIComponent(id), body);
}

// 删除水印模板
export function deleteWatermarkTemplate(id) {
  return request.del('/watermark-templates/' + encodeURIComponent(id));
}
