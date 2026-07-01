// 解析 x-ozon-store-id header,并校验店铺存在
import config from '../config/index.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';

export function storeGuard(req, _res, next) {
  const storeId = req.headers['x-ozon-store-id'] || '';
  if (!storeId) {
    return next(new ApiError(ErrorCode.VALIDATION_ERROR, '缺少 x-ozon-store-id header'));
  }
  const stores = config.loadStores();
  const found = stores.find((s) => s.id === storeId);
  if (!found) {
    return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `店铺不存在: ${storeId}`));
  }
  req.storeId = storeId;
  req.store = found;
  next();
}
