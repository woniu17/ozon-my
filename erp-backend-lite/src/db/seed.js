// 数据库种子数据 —— 插入必要的测试数据用于本地开发与联调
// 运行方式:npm run seed
import { db, initSchema } from './index.js';
import { randomUUID } from 'node:crypto';

initSchema();

// 清空旧数据(保留表结构,方便重复运行)
console.log('[seed] 清空旧数据...');
for (const t of [
  'follow_sell_task_items',
  'follow_sell_tasks',
  'favorites',
  'product_data_cache',
  'product_attributes_cache',
  'async_jobs',
  'app_config',
  'watermark_templates',
  'batch_upload_items',
  'batch_upload_tasks',
  'audit_logs',
]) {
  db.exec(`DELETE FROM ${t};`);
}

// ────────────────────────────────────────────────────────────
// 1. 跟卖任务(follow_sell_tasks)
// ────────────────────────────────────────────────────────────
console.log('[seed] 插入 follow_sell_tasks...');
const tasks = [
  {
    local_task_id: 'task-portal-001',
    via_portal: 1,
    store_id: 'store-001',
    status: 'SUCCESS',
    items_count: 3,
    items_preview: JSON.stringify([
      { offer_id: 'demo-001', name: '无线蓝牙耳机', price: '1290.00' },
      { offer_id: 'demo-002', name: '手机壳', price: '199.00' },
      { offer_id: 'demo-003', name: '充电器', price: '450.00' },
    ]),
    ozon_task_id: null,
    bundle_ids: JSON.stringify(['bdl-001', 'bdl-002', 'bdl-003']),
    error_message: null,
    completed_at: '2026-06-30 10:23:45',
  },
  {
    local_task_id: 'task-portal-002',
    via_portal: 1,
    store_id: 'store-001',
    status: 'FAILED',
    items_count: 2,
    items_preview: JSON.stringify([
      { offer_id: 'demo-004', name: '保温杯', price: '350.00' },
      { offer_id: 'demo-005', name: '雨伞', price: '180.00' },
    ]),
    ozon_task_id: null,
    bundle_ids: null,
    error_message: '公司一致性护栏拦截:store_company_id 与 sc_company_id 不一致',
    completed_at: '2026-06-30 14:12:00',
  },
  {
    local_task_id: 'task-api-001',
    via_portal: 0,
    store_id: 'store-001',
    status: 'SUCCESS',
    items_count: 1,
    items_preview: JSON.stringify([{ offer_id: 'demo-006', name: '机械键盘', price: '899.00' }]),
    ozon_task_id: 'ozon-task-abc123',
    bundle_ids: null,
    error_message: null,
    completed_at: '2026-06-29 16:45:00',
  },
  {
    local_task_id: 'task-api-002',
    via_portal: 0,
    store_id: 'store-001',
    status: 'PENDING',
    items_count: 5,
    items_preview: JSON.stringify([{ offer_id: 'demo-007', name: '鼠标垫', price: '89.00' }]),
    ozon_task_id: 'ozon-task-def456',
    bundle_ids: null,
    error_message: null,
    completed_at: null,
  },
];

const stmtTask = db.prepare(`
  INSERT INTO follow_sell_tasks
    (local_task_id, via_portal, store_id, status, items_count, items_preview,
     ozon_task_id, bundle_ids, error_message, completed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const t of tasks) {
  stmtTask.run(
    t.local_task_id,
    t.via_portal,
    t.store_id,
    t.status,
    t.items_count,
    t.items_preview,
    t.ozon_task_id,
    t.bundle_ids,
    t.error_message,
    t.completed_at
  );
}

// ────────────────────────────────────────────────────────────
// 1b. 上架记录明细(follow_sell_task_items)
// ────────────────────────────────────────────────────────────
console.log('[seed] 插入 follow_sell_task_items...');
const taskItems = [
  // task-portal-001: 3 个全部成功
  {
    local_task_id: 'task-portal-001',
    offer_id: 'demo-001',
    name: '无线蓝牙耳机',
    price: '1290.00',
    product_id: '100001',
    status: 'imported',
    errors: null,
  },
  {
    local_task_id: 'task-portal-001',
    offer_id: 'demo-002',
    name: '手机壳',
    price: '199.00',
    product_id: '100002',
    status: 'imported',
    errors: null,
  },
  {
    local_task_id: 'task-portal-001',
    offer_id: 'demo-003',
    name: '充电器',
    price: '450.00',
    product_id: '100003',
    status: 'imported',
    errors: null,
  },
  // task-portal-002: 2 个全部失败
  {
    local_task_id: 'task-portal-002',
    offer_id: 'demo-004',
    name: '保温杯',
    price: '350.00',
    product_id: null,
    status: 'failed',
    errors: JSON.stringify([{ code: 'COMPANY_MISMATCH', message: '公司一致性护栏拦截' }]),
  },
  {
    local_task_id: 'task-portal-002',
    offer_id: 'demo-005',
    name: '雨伞',
    price: '180.00',
    product_id: null,
    status: 'failed',
    errors: JSON.stringify([{ code: 'COMPANY_MISMATCH', message: '公司一致性护栏拦截' }]),
  },
  // task-api-001: 1 个成功
  {
    local_task_id: 'task-api-001',
    offer_id: 'demo-006',
    name: '机械键盘',
    price: '899.00',
    product_id: '100006',
    status: 'imported',
    errors: null,
  },
  // task-api-002: 5 个处理中(部分成功 + 部分 pending,模拟 OPI 队列未处理完)
  {
    local_task_id: 'task-api-002',
    offer_id: 'demo-007',
    name: '鼠标垫',
    price: '89.00',
    product_id: '100007',
    status: 'imported',
    errors: null,
  },
  {
    local_task_id: 'task-api-002',
    offer_id: 'demo-008',
    name: 'USB 集线器',
    price: '129.00',
    product_id: null,
    status: 'pending',
    errors: null,
  },
  {
    local_task_id: 'task-api-002',
    offer_id: 'demo-009',
    name: '显示器支架',
    price: '299.00',
    product_id: null,
    status: 'failed',
    errors: JSON.stringify([{ code: 'VALIDATION_ERROR', message: 'weight 必填', field: 'weight' }]),
  },
  {
    local_task_id: 'task-api-002',
    offer_id: 'demo-010',
    name: '键盘清洁刷',
    price: '39.00',
    product_id: null,
    status: 'pending',
    errors: null,
  },
  {
    local_task_id: 'task-api-002',
    offer_id: 'demo-011',
    name: '笔记本支架',
    price: '189.00',
    product_id: null,
    status: 'pending',
    errors: null,
  },
];

const stmtItem = db.prepare(`
  INSERT INTO follow_sell_task_items (local_task_id, offer_id, name, price, product_id, status, errors)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
for (const it of taskItems) {
  stmtItem.run(it.local_task_id, it.offer_id, it.name, it.price, it.product_id, it.status, it.errors);
}

// ────────────────────────────────────────────────────────────
// 2. 收藏(favorites)
// ────────────────────────────────────────────────────────────
console.log('[seed] 插入 favorites...');
const favs = [
  {
    sku: 'ozon-sku-200001',
    product: JSON.stringify({
      title: '保温杯 316不锈钢 500ml',
      price: '350.00',
      image: 'https://cdn1.ozone.ru/s3/multimedia-1/200001.jpg',
    }),
  },
  {
    sku: 'ozon-sku-200002',
    product: JSON.stringify({
      title: '折叠雨伞 防风防晒',
      price: '180.00',
      image: 'https://cdn1.ozone.ru/s3/multimedia-1/200002.jpg',
    }),
  },
  {
    sku: 'ozon-sku-200003',
    product: JSON.stringify({
      title: '运动水壶 户外便携',
      price: '120.00',
      image: 'https://cdn1.ozone.ru/s3/multimedia-1/200003.jpg',
    }),
  },
];

const stmtFav = db.prepare(`INSERT INTO favorites (product, sku) VALUES (?, ?)`);
for (const f of favs) {
  stmtFav.run(f.product, f.sku);
}

// ────────────────────────────────────────────────────────────
// 4. 商品数据缓存(product_data_cache)
// ────────────────────────────────────────────────────────────
console.log('[seed] 插入 product_data_cache...');
const caches = [
  {
    sku: 'ozon-sku-100001',
    data: JSON.stringify({
      id: 100001,
      name: '无线蓝牙耳机 降噪 入耳式',
      offer_id: 'demo-001',
      price: '1290.00',
      old_price: '1590.00',
      images: ['https://cdn1.ozone.ru/s3/multimedia-1/100001-1.jpg'],
      availability: 1,
      rating: 4.8,
      reviews_count: 1234,
    }),
  },
  {
    sku: 'ozon-sku-100002',
    data: JSON.stringify({
      id: 100002,
      name: '手机壳 iPhone 15 Pro 硅胶',
      offer_id: 'demo-002',
      price: '199.00',
      old_price: '299.00',
      images: ['https://cdn1.ozone.ru/s3/multimedia-1/100002-1.jpg'],
      availability: 1,
      rating: 4.6,
      reviews_count: 567,
    }),
  },
];

const stmtCache = db.prepare(`INSERT INTO product_data_cache (sku, data) VALUES (?, ?)`);
for (const c of caches) {
  stmtCache.run(c.sku, c.data);
}

// ────────────────────────────────────────────────────────────
// 4b. 商品属性缓存(product_attributes_cache)
// ────────────────────────────────────────────────────────────
console.log('[seed] 插入 product_attributes_cache...');
const attrCaches = [
  {
    sku: 'demo-001',
    attributes_data: JSON.stringify({
      attributes: [
        {
          id: 12345,
          complex_id: 0,
          values: [{ dictionary_value_id: 'brand-001', value: 'OEM' }],
        },
        {
          id: 67890,
          complex_id: 0,
          values: [{ dictionary_value_id: 'color-black', value: '黑色' }],
        },
      ],
      complex_attributes: [
        {
          attributes: [
            {
              id: 11223,
              complex_id: 1,
              values: [{ dictionary_value_id: 'size-std', value: '标准版' }],
            },
          ],
        },
      ],
      description_category_id: 9876543,
      type_id: 1234567,
      name: '无线蓝牙耳机 降噪 入耳式',
      offer_id: 'demo-001',
      sku: 100001,
      barcode: '2000000000017',
    }),
    description_data: JSON.stringify({
      description:
        '无线蓝牙耳机,主动降噪,入耳式设计,长效续航。内置高保真发声单元,低频浑厚、高频通透,适合通勤与运动场景。',
      id: 100001,
      name: '无线蓝牙耳机 降噪 入耳式',
      offer_id: 'demo-001',
    }),
  },
];

const stmtAttrCache = db.prepare(`
  INSERT OR REPLACE INTO product_attributes_cache (sku, attributes_data, description_data)
  VALUES (?, ?, ?)
`);
for (const c of attrCaches) {
  stmtAttrCache.run(c.sku, c.attributes_data, c.description_data);
}

// ────────────────────────────────────────────────────────────
// 5. 异步任务(async_jobs)
// ────────────────────────────────────────────────────────────
console.log('[seed] 插入 async_jobs...');
const jobs = [
  {
    id: randomUUID(),
    type: 'prepare-bundle',
    status: 'done',
    payload: JSON.stringify({ items_count: 3, store_id: 'store-001' }),
    result: JSON.stringify({ bundles_count: 3, store_company_id: '3891653' }),
    error: null,
  },
  {
    id: randomUUID(),
    type: 'import',
    status: 'processing',
    payload: JSON.stringify({ items_count: 5, via_portal: false }),
    result: null,
    error: null,
  },
];

const stmtJob = db.prepare(`
  INSERT INTO async_jobs (id, type, status, payload, result, error)
  VALUES (?, ?, ?, ?, ?, ?)
`);
for (const j of jobs) {
  stmtJob.run(j.id, j.type, j.status, j.payload, j.result, j.error);
}

// ────────────────────────────────────────────────────────────
// 6. 应用配置(app_config,替代插件端硬编码默认值)
// ────────────────────────────────────────────────────────────
console.log('[seed] 插入 app_config...');
const appConfigs = [
  // extension scope —— 跟卖面板默认值
  {
    key: 'price_max',
    value: 9999999,
    scope: 'extension',
    description: '售价上限(卢布),超过则面板校验失败',
  },
  {
    key: 'stock_max',
    value: 1000000,
    scope: 'extension',
    description: '库存上限,超过则面板校验失败',
  },
  {
    key: 'default_stock',
    value: 10,
    scope: 'extension',
    description: '默认库存(多变体/单变体均用此值预填)',
  },
  {
    key: 'old_price_ratio',
    value: 1.25,
    scope: 'extension',
    description: '默认划线价 = 售价 × 此比例',
  },
  {
    key: 'discount_threshold',
    value: 0.15,
    scope: 'extension',
    description: 'Ozon 折扣阈值(售价 / 划线价 不得低于此值,否则审核失败)',
  },
  {
    key: 'enable_video_transfer',
    value: false,
    scope: 'extension',
    description: '是否启用视频转存到 Ozon',
  },
  {
    key: 'enable_ai_rewrite',
    value: false,
    scope: 'extension',
    description: '是否启用 AI 标题改写',
  },
  {
    key: 'enable_watermark',
    value: false,
    scope: 'extension',
    description: '是否启用水印渲染',
  },
  // pricing scope —— 算价面板默认值
  {
    key: 'rate_rub',
    value: 11.08,
    scope: 'pricing',
    description: '人民币兑卢布汇率(1 CNY = ? RUB)',
  },
  {
    key: 'commission_rates',
    value: { beauty_mid: 0.15, beauty_high: 0.17, electronics: 0.13, apparel: 0.14, home: 0.12 },
    scope: 'pricing',
    description: '类目佣金率表',
  },
  {
    key: 'logistics_cost',
    value: { xs: 8, budget: 12, small: 18, big: 35 },
    scope: 'pricing',
    description: '物流费表(卢布)',
  },
  {
    key: 'profit_logistics',
    value: { guoo: 0.06, cel: 0.055, xy: 0.05, zto: 0.065 },
    scope: 'pricing',
    description: '利润物流系数表',
  },
];

const stmtCfg = db.prepare(`
  INSERT INTO app_config (key, value, scope, description) VALUES (?, ?, ?, ?)
`);
for (const c of appConfigs) {
  stmtCfg.run(c.key, JSON.stringify(c.value), c.scope, c.description);
}

// ────────────────────────────────────────────────────────────
// 7. 水印模板(watermark_templates)
// ────────────────────────────────────────────────────────────
console.log('[seed] 插入 watermark_templates...');
const wmTemplates = [
  {
    name: '默认水印',
    config: {
      text: 'MY',
      position: 'bottom-right',
      opacity: 0.5,
      fontSize: 24,
      color: '#ffffff',
      bgColor: 'rgba(0,0,0,0.4)',
      padding: 8,
    },
    is_default: 1,
  },
];

const stmtWm = db.prepare(`
  INSERT INTO watermark_templates (name, config, is_default) VALUES (?, ?, ?)
`);
for (const w of wmTemplates) {
  stmtWm.run(w.name, JSON.stringify(w.config), w.is_default);
}

// ────────────────────────────────────────────────────────────
// 8. 批量上架任务(batch_upload_tasks + batch_upload_items)
// ────────────────────────────────────────────────────────────
console.log('[seed] 插入 batch_upload_tasks...');
const batchTasks = [
  {
    local_task_id: 'batch-demo-001',
    store_id: 'store-001',
    status: 'SUCCESS',
    total_count: 3,
    success_count: 3,
    failed_count: 0,
    config: { defaultStock: 10, oldPriceRatio: 1.25 },
    error_message: null,
    completed_at: '2026-06-30 11:00:00',
  },
  {
    local_task_id: 'batch-demo-002',
    store_id: 'store-001',
    status: 'PARTIAL',
    total_count: 4,
    success_count: 2,
    failed_count: 2,
    config: { defaultStock: 10 },
    error_message: '2 项失败',
    completed_at: '2026-06-30 15:30:00',
  },
  {
    local_task_id: 'batch-demo-003',
    store_id: 'store-001',
    status: 'PENDING',
    total_count: 5,
    success_count: 0,
    failed_count: 0,
    config: null,
    error_message: null,
    completed_at: null,
  },
];

const stmtBatch = db.prepare(`
  INSERT INTO batch_upload_tasks (local_task_id, store_id, status, total_count, success_count, failed_count, config, error_message, completed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const t of batchTasks) {
  stmtBatch.run(
    t.local_task_id,
    t.store_id,
    t.status,
    t.total_count,
    t.success_count,
    t.failed_count,
    t.config ? JSON.stringify(t.config) : null,
    t.error_message,
    t.completed_at
  );
}

console.log('[seed] 插入 batch_upload_items...');
const batchItems = [
  {
    batch: 'batch-demo-001',
    sku: 'ozon-sku-100001',
    url: 'https://www.ozon.ru/product/100001/',
    status: 'SUCCESS',
    follow: 'task-portal-001',
  },
  {
    batch: 'batch-demo-001',
    sku: 'ozon-sku-100002',
    url: 'https://www.ozon.ru/product/100002/',
    status: 'SUCCESS',
    follow: 'task-portal-001',
  },
  {
    batch: 'batch-demo-001',
    sku: 'ozon-sku-100003',
    url: 'https://www.ozon.ru/product/100003/',
    status: 'SUCCESS',
    follow: 'task-portal-001',
  },
  {
    batch: 'batch-demo-002',
    sku: 'ozon-sku-100004',
    url: 'https://www.ozon.ru/product/100004/',
    status: 'SUCCESS',
    follow: 'task-portal-002',
  },
  {
    batch: 'batch-demo-002',
    sku: 'ozon-sku-200001',
    url: 'https://www.ozon.ru/product/200001/',
    status: 'FAILED',
    follow: null,
    err: '商品已下架',
  },
  {
    batch: 'batch-demo-002',
    sku: 'ozon-sku-200002',
    url: 'https://www.ozon.ru/product/200002/',
    status: 'SUCCESS',
    follow: 'task-portal-002',
  },
  {
    batch: 'batch-demo-002',
    sku: 'ozon-sku-200003',
    url: 'https://www.ozon.ru/product/200003/',
    status: 'FAILED',
    follow: null,
    err: 'weight 必填',
  },
  {
    batch: 'batch-demo-003',
    sku: 'ozon-sku-100001',
    url: 'https://www.ozon.ru/product/100001/',
    status: 'PENDING',
    follow: null,
  },
  {
    batch: 'batch-demo-003',
    sku: 'ozon-sku-100002',
    url: 'https://www.ozon.ru/product/100002/',
    status: 'PENDING',
    follow: null,
  },
  {
    batch: 'batch-demo-003',
    sku: 'ozon-sku-100003',
    url: 'https://www.ozon.ru/product/100003/',
    status: 'PENDING',
    follow: null,
  },
  {
    batch: 'batch-demo-003',
    sku: 'ozon-sku-100004',
    url: 'https://www.ozon.ru/product/100004/',
    status: 'PENDING',
    follow: null,
  },
  {
    batch: 'batch-demo-003',
    sku: 'ozon-sku-200001',
    url: 'https://www.ozon.ru/product/200001/',
    status: 'PENDING',
    follow: null,
  },
];

const stmtBatchItem = db.prepare(`
  INSERT INTO batch_upload_items (batch_task_id, source_sku, source_url, follow_task_id, status, error_message)
  VALUES (?, ?, ?, ?, ?, ?)
`);
for (const it of batchItems) {
  stmtBatchItem.run(it.batch, it.sku, it.url, it.follow || null, it.status, it.err || null);
}

// ────────────────────────────────────────────────────────────
// 9. 操作日志(audit_logs)
// ────────────────────────────────────────────────────────────
console.log('[seed] 插入 audit_logs...');
const auditLogs = [
  {
    action: 'store.create',
    target: 'store-001',
    store_id: 'store-001',
    operator: '13800138000',
    detail: { name: 'Demo 店铺 001' },
    ip: '127.0.0.1',
  },
  {
    action: 'listing.import',
    target: 'task-portal-001',
    store_id: 'store-001',
    operator: '13800138000',
    detail: { items_count: 3, via_portal: true },
    ip: '127.0.0.1',
  },
  {
    action: 'config.update',
    target: null,
    store_id: null,
    operator: '13800138000',
    detail: { key: 'price_max', value: 9999999 },
    ip: '127.0.0.1',
  },
  {
    action: 'batch.create',
    target: 'batch-demo-001',
    store_id: 'store-001',
    operator: '13800138000',
    detail: { items_count: 3 },
    ip: '127.0.0.1',
  },
  {
    action: 'collect.create',
    target: null,
    store_id: 'store-001',
    operator: '13800138000',
    detail: { sku: 'ozon-sku-100001' },
    ip: '127.0.0.1',
  },
];

const stmtAudit = db.prepare(`
  INSERT INTO audit_logs (action, target, store_id, operator, detail, ip)
  VALUES (?, ?, ?, ?, ?, ?)
`);
for (const a of auditLogs) {
  stmtAudit.run(a.action, a.target, a.store_id, a.operator, a.detail ? JSON.stringify(a.detail) : null, a.ip);
}

// ────────────────────────────────────────────────────────────
// 统计输出
// ────────────────────────────────────────────────────────────
console.log('\n[seed] 种子数据插入完成:');
for (const [name, sql] of Object.entries({
  follow_sell_tasks: 'SELECT COUNT(*) AS n FROM follow_sell_tasks',
  follow_sell_task_items: 'SELECT COUNT(*) AS n FROM follow_sell_task_items',
  favorites: 'SELECT COUNT(*) AS n FROM favorites',
  product_data_cache: 'SELECT COUNT(*) AS n FROM product_data_cache',
  product_attributes_cache: 'SELECT COUNT(*) AS n FROM product_attributes_cache',
  async_jobs: 'SELECT COUNT(*) AS n FROM async_jobs',
  app_config: 'SELECT COUNT(*) AS n FROM app_config',
  watermark_templates: 'SELECT COUNT(*) AS n FROM watermark_templates',
  batch_upload_tasks: 'SELECT COUNT(*) AS n FROM batch_upload_tasks',
  batch_upload_items: 'SELECT COUNT(*) AS n FROM batch_upload_items',
  audit_logs: 'SELECT COUNT(*) AS n FROM audit_logs',
})) {
  const row = db.prepare(sql).get();
  console.log(`  - ${name}: ${row.n} 条`);
}

db.close();
process.exit(0);
