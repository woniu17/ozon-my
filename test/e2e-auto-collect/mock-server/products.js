// 测试商品数据(供 mock-server 与 puppeteer-runner 共用)
// SKU 命名规则: 100001+ 5 位数字,与 ozon-data-panel.js 的 /-(\d{5,})/ 正则匹配

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
    ratingCount: '4.8 · 1 234',
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
    ratingCount: '4.6 · 567',
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
    ratingCount: '4.9 · 89',
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
    ratingCount: '4.7 · 321',
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
    ratingCount: '4.5 · 456',
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
    ratingCount: '4.4 · 789',
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
    ratingCount: '4.6 · 234',
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
    ratingCount: '4.3 · 678',
    sellerSlug: CHINA_SHOP.slug,
    sellerId: CHINA_SHOP.sellerId,
  },
];

// 按 SKU 索引,方便 mock 路由快速查找
export const PRODUCT_MAP = Object.fromEntries(PRODUCTS.map((p) => [p.sku, p]));

// 获取一个商品的完整 URL(/product/slug-sku/)
export function productUrl(sku) {
  const p = PRODUCT_MAP[sku];
  if (!p) return null;
  return `/product/${p.slug}-${p.sku}/`;
}
