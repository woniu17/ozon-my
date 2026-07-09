import * as request from './request.js';

// 灰度开关(当前用户视角,后端原样返回配置对象)
export function getFeatureFlags() {
  return request.get('/feature-flags/me');
}

// 更新单个灰度开关(RESTful 约定,后端尚未实现该写接口)
export function updateFeatureFlag(key, value) {
  return request.put('/feature-flags/' + encodeURIComponent(key), { value });
}

// 应用配置(扁平 key-value)
export function getConfig() {
  return request.get('/app-config');
}

// 批量更新应用配置
export function updateConfig(body) {
  return request.put('/app-config', body);
}
