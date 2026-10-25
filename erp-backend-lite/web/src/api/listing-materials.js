import * as request from './request.js';

// 上架素材机制(Phase 2)前端 API
export function getMaterials(params) {
  return request.get('/admin/api/listing-materials', params);
}
export function getMaterial(id) {
  return request.get('/admin/api/listing-materials/' + id);
}
export function generateMaterials(body) {
  return request.post('/admin/api/listing-materials/generate', body);
}
export function approveMaterial(id) {
  return request.post(`/admin/api/listing-materials/${id}/approve`);
}
export function publishMaterial(id, body) {
  return request.post(`/admin/api/listing-materials/${id}/publish`, body);
}
export function batchPublishMaterials(body) {
  return request.post('/admin/api/listing-materials/batch-publish', body);
}
export function getMaterialVersions(id) {
  return request.get(`/admin/api/listing-materials/${id}/versions`);
}
export function saveMaterialVersion(id, body) {
  return request.post(`/admin/api/listing-materials/${id}/versions`, body);
}
export function getMaterialPublishes(id) {
  return request.get(`/admin/api/listing-materials/${id}/publishes`);
}
export function deleteMaterial(id) {
  return request.del(`/admin/api/listing-materials/${id}`);
}