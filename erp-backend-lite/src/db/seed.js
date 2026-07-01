// 数据库种子数据 —— 插入必要的测试数据用于本地开发与联调
// 运行方式:npm run seed
import { db, initSchema } from './index.js';
import { randomUUID } from 'node:crypto';

initSchema();

// 清空旧数据(保留表结构,方便重复运行)
console.log('[seed] 清空旧数据...');
for (const t of ['follow_sell_tasks', 'collect_box', 'favorites', 'product_data_cache', 'async_jobs']) {
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
// 2. 采集箱(collect_box)
// ────────────────────────────────────────────────────────────
console.log('[seed] 插入 collect_box...');
const collectItems = [
  {
    store_id: 'store-001',
    product: JSON.stringify({
      sku: 'ozon-sku-100001',
      title: '无线蓝牙耳机 降噪 入耳式',
      price: '1290.00',
      old_price: '1590.00',
      image: 'https://cdn1.ozone.ru/s3/multimedia-1/100001.jpg',
      source_url: 'https://www.ozon.ru/product/100001/',
      rating: 4.8,
      reviews: 1234,
    }),
    source: 'ozon',
    ai_draft: null,
    published: 0,
  },
  {
    store_id: 'store-001',
    product: JSON.stringify({
      sku: 'ozon-sku-100002',
      title: '手机壳 iPhone 15 Pro 硅胶',
      price: '199.00',
      old_price: '299.00',
      image: 'https://cdn1.ozone.ru/s3/multimedia-1/100002.jpg',
      source_url: 'https://www.ozon.ru/product/100002/',
      rating: 4.6,
      reviews: 567,
    }),
    source: 'ozon',
    ai_draft: JSON.stringify({ rewritten_title: '高品质硅胶手机壳 iPhone 15 Pro 防摔' }),
    published: 0,
  },
  {
    store_id: 'store-001',
    product: JSON.stringify({
      sku: 'ozon-sku-100003',
      title: '快充充电器 20W USB-C',
      price: '450.00',
      old_price: '',
      image: 'https://cdn1.ozone.ru/s3/multimedia-1/100003.jpg',
      source_url: 'https://www.ozon.ru/product/100003/',
      rating: 4.9,
      reviews: 2891,
    }),
    source: 'ozon',
    ai_draft: null,
    published: 1,
  },
  {
    store_id: 'store-001',
    product: JSON.stringify({
      sku: 'ozon-sku-100004',
      title: '机械键盘 87键 红轴',
      price: '899.00',
      old_price: '1099.00',
      image: 'https://cdn1.ozone.ru/s3/multimedia-1/100004.jpg',
      source_url: 'https://www.ozon.ru/product/100004/',
      rating: 4.7,
      reviews: 432,
    }),
    source: 'ozon',
    ai_draft: null,
    published: 0,
  },
];

const stmtCollect = db.prepare(`
  INSERT INTO collect_box (store_id, product, source, ai_draft, published)
  VALUES (?, ?, ?, ?, ?)
`);
for (const c of collectItems) {
  stmtCollect.run(c.store_id, c.product, c.source, c.ai_draft, c.published);
}

// ────────────────────────────────────────────────────────────
// 3. 收藏(favorites)
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
// 统计输出
// ────────────────────────────────────────────────────────────
console.log('\n[seed] 种子数据插入完成:');
for (const [name, sql] of Object.entries({
  follow_sell_tasks: 'SELECT COUNT(*) AS n FROM follow_sell_tasks',
  collect_box: 'SELECT COUNT(*) AS n FROM collect_box',
  favorites: 'SELECT COUNT(*) AS n FROM favorites',
  product_data_cache: 'SELECT COUNT(*) AS n FROM product_data_cache',
  async_jobs: 'SELECT COUNT(*) AS n FROM async_jobs',
})) {
  const row = db.prepare(sql).get();
  console.log(`  - ${name}: ${row.n} 条`);
}

db.close();
process.exit(0);
