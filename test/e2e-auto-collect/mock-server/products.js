// 测试商品数据(供 mock-server 与 puppeteer-runner 共用)
// SKU 命名规则: 100001+ 5 位数字,与 ozon-data-panel.js 的 /-(\d{5,})/ 正则匹配
//
// ratingCount 格式(对齐真实 Ozon 新版 DOM):
//   { score: "4.8", count: 1234 }  — 有评分 + 评价数
//   { score: "5.0", count: null }  — 有评分但无评价数(新品)
//   null                            — 无评分无评价数
// 真实 DOM 结构:评分和评价数是两个独立 span,不在同一元素内。

export const CHINA_SHOP = {
  slug: 'mock-china-shop',
  name: 'Mock China Shop 测试中国店铺',
  sellerId: '12345',
  companyInfo: {
    companyName: '厦门测试科技有限公司',
    legalAddress: '福建省厦门市思明区软件园二期',
    country: 'CN',
  },
};

export const FOREIGN_SHOP = {
  slug: 'mock-foreign-shop',
  name: 'Mock Foreign Shop Тестовый магазин',
  sellerId: '67890',
  companyInfo: {
    companyName: 'OOO Test Foreign',
    legalAddress: 'Moscow, Tverskaya 1',
    country: 'RU',
  },
};

// 店铺页商品列表(每个店铺展示这些 SKU)
export const PRODUCTS = [
  {
    sku: '100001',
    slug: 'test-product-1',
    name: '测试商品1 无线蓝牙耳机',
    price: '999 ₽',
    priceRub: 999,
    image: 'https://via.placeholder.com/300x300?text=Product1',
    ratingCount: { score: '4.8', count: 1234 },
    sellerSlug: CHINA_SHOP.slug,
    sellerId: CHINA_SHOP.sellerId,
  },
  {
    sku: '100002',
    slug: 'test-product-2',
    name: '测试商品2 智能手表',
    price: '2499 ₽',
    priceRub: 2499,
    image: 'https://via.placeholder.com/300x300?text=Product2',
    ratingCount: { score: '4.6', count: 567 },
    sellerSlug: CHINA_SHOP.slug,
    sellerId: CHINA_SHOP.sellerId,
  },
  {
    sku: '100003',
    slug: 'test-product-3',
    name: '测试商品3 USB-C 充电器',
    price: '599 ₽',
    priceRub: 599,
    image: 'https://via.placeholder.com/300x300?text=Product3',
    ratingCount: { score: '4.9', count: 89 },
    sellerSlug: CHINA_SHOP.slug,
    sellerId: CHINA_SHOP.sellerId,
  },
  {
    sku: '100004',
    slug: 'test-product-4',
    name: '测试商品4 蓝牙音箱',
    price: '1499 ₽',
    priceRub: 1499,
    image: 'https://via.placeholder.com/300x300?text=Product4',
    ratingCount: { score: '4.7', count: 321 },
    sellerSlug: CHINA_SHOP.slug,
    sellerId: CHINA_SHOP.sellerId,
  },
  {
    sku: '100005',
    slug: 'test-product-5',
    name: '测试商品5 机械键盘',
    price: '3499 ₽',
    priceRub: 3499,
    image: 'https://via.placeholder.com/300x300?text=Product5',
    ratingCount: { score: '4.5', count: 456 },
    sellerSlug: CHINA_SHOP.slug,
    sellerId: CHINA_SHOP.sellerId,
  },
  {
    sku: '100006',
    slug: 'test-product-6',
    name: '测试商品6 无线鼠标',
    price: '799 ₽',
    priceRub: 799,
    image: 'https://via.placeholder.com/300x300?text=Product6',
    ratingCount: { score: '4.4', count: 789 },
    sellerSlug: CHINA_SHOP.slug,
    sellerId: CHINA_SHOP.sellerId,
  },
  {
    sku: '100007',
    slug: 'test-product-7',
    name: '测试商品7 显示器支架',
    price: '1999 ₽',
    priceRub: 1999,
    image: 'https://via.placeholder.com/300x300?text=Product7',
    // 无评价数的新品(有评分但无 отзывов span)
    ratingCount: { score: '5.0', count: null },
    sellerSlug: CHINA_SHOP.slug,
    sellerId: CHINA_SHOP.sellerId,
  },
  {
    sku: '100008',
    slug: 'test-product-8',
    name: '测试商品8 USB 集线器',
    price: '499 ₽',
    priceRub: 499,
    image: 'https://via.placeholder.com/300x300?text=Product8',
    ratingCount: { score: '4.3', count: 678 },
    sellerSlug: CHINA_SHOP.slug,
    sellerId: CHINA_SHOP.sellerId,
  },
];

// 推荐区商品(非店铺商品,出现在店铺页底部的"你可能感兴趣"区域)
// 用于测试 isStoreSkuCard 能否正确区分店铺商品 vs 推荐区
export const RECOMMENDED_PRODUCTS = [
  {
    sku: '200001',
    slug: 'recommended-product-1',
    name: '推荐商品1 无线充电板',
    price: '1299 ₽',
    priceRub: 1299,
    image: 'https://via.placeholder.com/300x300?text=Recommended1',
    ratingCount: { score: '4.2', count: 234 },
  },
  {
    sku: '200002',
    slug: 'recommended-product-2',
    name: '推荐商品2 手机壳',
    price: '399 ₽',
    priceRub: 399,
    image: 'https://via.placeholder.com/300x300?text=Recommended2',
    ratingCount: { score: '4.6', count: 1024 },
  },
  {
    sku: '200003',
    slug: 'recommended-product-3',
    name: '推荐商品3 数据线',
    price: '199 ₽',
    priceRub: 199,
    image: 'https://via.placeholder.com/300x300?text=Recommended3',
    // 无评价数的新品
    ratingCount: { score: '4.9', count: null },
  },
];

// 按 SKU 索引,方便 mock 路由快速查找(含店铺商品 + 推荐区商品)
const ALL_PRODUCTS = [...PRODUCTS, ...RECOMMENDED_PRODUCTS];
export const PRODUCT_MAP = Object.fromEntries(ALL_PRODUCTS.map((p) => [p.sku, p]));

// 获取一个商品的完整 URL(/product/slug-sku/)
export function productUrl(sku) {
  const p = PRODUCT_MAP[sku];
  if (!p) return null;
  return `/product/${p.slug}-${p.sku}/`;
}
