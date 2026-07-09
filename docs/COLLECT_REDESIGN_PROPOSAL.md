# 一键采集重构设计方案：全数据源采集 + 来源标记 + 分源展示

> 落地路径：`c:\root\code\ozon-my\docs\COLLECT_REDESIGN_PROPOSAL.md`
> 关联文档：
> - [MY_COLLECTOR_DATA_SOURCES.md](file:///c:/root/code/ozon-my/docs/MY_COLLECTOR_DATA_SOURCES.md)
> - [MY_COLLECTOR_VS_FOLLOW_SELL_AND_PAGE_CARDS_FOLLOW_SELL.md](file:///c:/root/code/ozon-my/docs/MY_COLLECTOR_VS_FOLLOW_SELL_AND_PAGE_CARDS_FOLLOW_SELL.md)
> - [FOLLOW_SELL_DATA_SOURCES.md](file:///c:/root/code/ozon-my/docs/FOLLOW_SELL_DATA_SOURCES.md)

---

## 一、需求摘要

重构 PDP「一键采集」功能，实现 6 项目标：

1. **采集数据源与一键上架完全一致**：采集时跑全部数据源（DOM/Seller Portal/page-json/SSR aspects/video/hashtags/breadcrumbs/characteristics），不再只取母体 + 轻量变体行
2. **保留所有原始数据 + 来源标记**：每个字段标注来自哪个数据源（DOM / seller-portal / page-json / SSR / video-transcode / ui）
3. **ERP 后端设置相应接口接收数据**：扩展现有 `/ozon/collect-box` 接口，新增字段接收带来源标记的原始数据
4. **后端页面友好展示**：筛选数据格式化，可折叠可展开
5. **不同数据源不同子 tab 展示**：详情弹窗内按数据源分 sub-tab
6. **展示合成请求数据**：展示所有数据源合成的「用于提交创建 Ozon 商品的请求数据」，针对每个字段标注其数据源

---

## 二、现状分析

### 2.1 现有一键采集 vs 一键上架 数据源差距

| 数据源 | 现有一键采集 | 一键上架 | 差距 |
|--------|------------|---------|------|
| PDP DOM (extractProductData) | ✅ 锚点 name/image/统计/seller | ✅ 同 | 无 |
| PDP SSR aspects (extractAspectVariants) | ✅ Phase A 展开 | ✅ Phase A 展开 | 无 |
| 弹窗补全 (jzExpandVariantsViaModal) | ✅ | ✅ | 无 |
| composer-api page-json (fetchVariantGallery) | ⚠️ 仅富内容 11254 | ✅ 图册 + 富内容 | **图册缺失** |
| PDP gallery 视频 (captureAndTransferPageVideoMedia) | ✅ 转存 | ✅ 转存 | 无 |
| Seller Portal searchVariants | ⚠️ 可选（有则用） | ✅ 每变体必调 | **每变体 sv 不全** |
| breadcrumbs (extractBreadcrumbs) | ❌ 未采 | ✅ | **缺失** |
| hashtags (extractKeywords) | ⚠️ 仅 merge 进 variantData | ✅ sharedHashtags | **未独立保留** |
| characteristics (extractCharacteristics) | ❌ 未采 | ✅ pageScrapedDims | **缺失** |
| bundleComplexAttrs | ⚠️ 锚点共享 | ✅ 每变体独立 | **每变体不全** |

### 2.2 现有采集存储结构

```sql
-- erp-backend-lite/src/db/schema.sql L39-50
CREATE TABLE collect_box (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT,
  product TEXT NOT NULL,        -- JSON: 全部业务数据塞这里
  source TEXT DEFAULT 'ozon',
  ai_draft TEXT,
  published INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
```

**问题**：
- `product` 是一个大 JSON，无来源标记
- 多变体合并成「一条母体记录 + variantData.variants 轻量行」，丢失每变体的完整 sv / bundleComplexAttrs / 物理参数
- 无 breadcrumbs / hashtags / characteristics 独立字段
- 前端 admin 展示只提取 5 个字段（title/sku/image/price/url），深度数据不可见

### 2.3 现有 admin 前端

- 原生 JS，无框架
- 采集箱 Tab：`#tabCollectBox`，卡片网格，无折叠/展开
- 详情弹窗有 sub-tab 模式（admin.js:1033）
- 无 accordion 组件

---

## 三、总体方案

### 3.1 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│ 插件端 (qx-ozon/content/ozon-product.js)                     │
│                                                              │
│  一键采集 collectAllVariants 重构:                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 1. 全数据源采集(与一键上架同款)                         │   │
│  │    - extractProductData (DOM)                          │   │
│  │    - extractAspectVariants + Phase A SSR + Phase 0 弹窗 │   │
│  │    - searchVariants (每变体,含 bundle)                 │   │
│  │    - fetchVariantGallery (每变体图册+富内容)            │   │
│  │    - captureAndTransferPageVideoMedia (视频转存)        │   │
│  │    - extractBreadcrumbs / extractKeywords /            │   │
│  │      extractCharacteristics (PDP DOM state)            │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 2. 带 source 标记的数据组装                            │   │
│  │    每个字段: { value, source, sourceDetail }           │   │
│  │    原始响应: rawBySource { dom, sellerPortal,          │   │
│  │              pageJson, ssr, videoTranscode }           │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 3. 合成 Ozon import 请求预览(含字段来源)                │   │
│  │    synthesizedItems[]: 每字段标注一级来源              │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 4. 推送后端 POST /ozon/collect-box/v2                  │   │
│  │    body: { anchorSku, variants[], rawBySource,         │   │
│  │            synthesizedItems, collectedAt }             │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ ERP 后端 (erp-backend-lite)                                  │
│                                                              │
│  新表 collect_box_v2:                                         │
│    - id, store_id, anchor_sku, source_page_url               │
│    - variants_json (每变体完整数据 + 来源标记)                │
│    - raw_by_source_json (5 类数据源原始响应)                  │
│    - synthesized_items_json (合成请求 + 字段来源)             │
│    - collected_at, created_at                                 │
│                                                              │
│  新接口:                                                      │
│    - POST /ozon/collect-box/v2     (插件推送)                 │
│    - GET  /admin/api/collect-box-v2 (列表+筛选+分页)          │
│    - GET  /admin/api/collect-box-v2/:id (详情)               │
│    - DELETE /admin/api/collect-box-v2/:id                    │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ ERP admin 前端 (erp-backend-lite/src/public/admin.html)      │
│                                                              │
│  新 Tab: 采集箱(全源) #tabCollectBoxV2                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 列表页: 卡片网格 + 筛选(storeId/keyword/hasVideo/...)  │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 详情弹窗: 5 个 sub-tab                                 │   │
│  │   ① 概览 (Overview)                                    │   │
│  │   ② DOM 数据源 (PDP 页面元素)                          │   │
│  │   ③ Seller Portal (searchVariants + bundle)           │   │
│  │   ④ Page-JSON (图册 + 富内容)                          │   │
│  │   ⑤ 合成请求预览 (Synthesized Items)                  │   │
│  │ 每个 sub-tab: accordion 折叠面板,格式化展示             │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 设计原则

1. **不动现有 collect_box 表与接口**：新旧并行，旧表保留兼容，新数据进 v2 表
2. **来源标记下沉到字段级**：每个业务字段都带 `{ value, source, sourceDetail? }` 三元组
3. **原始响应完整保留**：5 类数据源的原始 JSON 响应全存 `raw_by_source_json`，便于审计与回放
4. **合成请求与字段来源同构**：`synthesized_items` 的每个字段都标注一级来源，与展示页对应
5. **前端原生 JS 实现**：沿用现有 admin 无框架模式，新增 accordion 组件

---

## 四、数据结构设计

### 4.1 带 source 标记的字段包装

每个业务字段统一包装为：

```ts
type SourcedField<T> = {
  value: T;                    // 字段值
  source: SourceTag;           // 来源标签
  sourceDetail?: string;       // 来源细节(可选,如端点/选择器)
  collectedAt: number;         // 采集时间戳
};

type SourceTag =
  | 'dom'                // PDP DOM 元素
  | 'seller-portal'      // seller.ozon.ru API (/search + /bundle)
  | 'page-json'          // /api/entrypoint-api.bx 或 composer-api.bx
  | 'ssr-aspects'        // PDP SSR HTML data-state aspects
  | 'video-transcode'    // PDP .mp4 经 SW 转存
  | 'ui'                 // 用户输入(采集场景一般为空)
  | 'computed'           // 前端计算(如 discount = (oldPrice-price)/oldPrice)
  | 'merged';            // 多源合并(如 name 优先 sv 4180 兜底 DOM)
```

### 4.2 单变体采集记录结构（每个变体一条完整记录）

```ts
type CollectedVariant = {
  // ── 标识 ──
  sku: SourcedField<string>;           // 来源: dom (URL 正则)
  url: SourcedField<string>;           // 来源: dom
  isAnchor: boolean;                   // 是否为母体(当前页 SKU)

  // ── 基础信息 ──
  name: SourcedField<string>;          // 来源: seller-portal (sv[4180]) > dom (aria-label)
  description: SourcedField<string>;   // 来源: computed (pickFollowSellDescription)
  brand: SourcedField<string>;         // 来源: seller-portal (sv[85])
  categoryPath: SourcedField<string[]>;// 来源: seller-portal (sv.categories)
  descriptionCategoryId: SourcedField<string>; // 来源: seller-portal

  // ── 价格(源商品价,非跟卖价) ──
  price: SourcedField<number>;         // 来源: dom (priceNode) > ssr-aspects
  priceCurrency: SourcedField<string>; // 来源: computed (_detectCurrencyFromPriceStr)
  priceRub: SourcedField<number>;      // 来源: computed (RUB 原值)
  priceCny: SourcedField<number>;      // 来源: computed (_rubToCny)
  oldPrice: SourcedField<number>;      // 来源: dom
  discount: SourcedField<number>;      // 来源: computed

  // ── 图片 ──
  mainImage: SourcedField<string>;     // 来源: seller-portal (sv[4194]) > dom
  images: SourcedField<string[]>;      // 来源: page-json (galleryMap) > seller-portal > dom
  imageSource: 'pageState' | 'sourceVariant' | 'coverImage' | 'none';

  // ── 视频 ──
  videoUrl: SourcedField<string | null>;   // 来源: video-transcode (转存后)
  videoCover: SourcedField<string | null>; // 来源: video-transcode

  // ── 物理参数 ──
  weight: SourcedField<number | null>;     // 来源: seller-portal (sv[4497]) > sv[4383]
  depth: SourcedField<number | null>;      // 来源: seller-portal (sv[9454])
  width: SourcedField<number | null>;      // 来源: seller-portal (sv[9455])
  height: SourcedField<number | null>;     // 来源: seller-portal (sv[9456])
  gtin: SourcedField<string | null>;       // 来源: seller-portal (sv[7822])

  // ── 富内容 ──
  richContent: SourcedField<string | null>;  // 来源: page-json (richAnnotationJson)

  // ── PDP DOM state 附加 ──
  breadcrumbs: SourcedField<string[] | null>;     // 来源: dom (extractBreadcrumbs)
  hashtags: SourcedField<string[] | null>;        // 来源: dom (extractKeywords/webHashtags)
  scrapedDims: SourcedField<{                     // 来源: dom (extractCharacteristics)
    weight?: number; depth?: number; width?: number; height?: number;
  } | null>;

  // ── 规格维度(aspect) ──
  aspectValues: SourcedField<Record<string, string>>; // 来源: ssr-aspects

  // ── Seller Portal 完整 sv(透传后端用) ──
  sourceVariant: SourcedField<object | null>;     // 来源: seller-portal (完整 sv 对象)
  bundleComplexAttrs: SourcedField<object[] | null>; // 来源: seller-portal (sv._bundleComplexAttrs)

  // ── 统计数据(仅母体有) ──
  statistics?: {
    soldCount: SourcedField<number | null>;       // 来源: dom (extractProductData.statistics)
    soldSum: SourcedField<number | null>;
    views: SourcedField<number | null>;
    convViewToOrder: SourcedField<number | null>;
    gmvSum: SourcedField<number | null>;
  };

  // ── 卖家信息(仅母体有) ──
  seller?: {
    name: SourcedField<string | null>;
    link: SourcedField<string | null>;
  };
};
```

### 4.3 完整采集记录（一次采集 = 一个母体 + N 个变体）

```ts
type CollectedRecord = {
  // ── 采集元信息 ──
  anchorSku: string;                 // 母体 SKU
  sourcePageUrl: string;             // 采集源 PDP URL
  collectedAt: number;               // 采集时间戳
  pluginVersion: string;             // 插件版本
  variantCount: number;              // 变体总数

  // ── 变体数组(每个变体一条完整记录) ──
  variants: CollectedVariant[];

  // ── 5 类数据源原始响应(审计/回放用) ──
  rawBySource: {
    dom: {
      productData: object;           // extractProductData 完整返回
      breadcrumbs: string[];         // extractBreadcrumbs
      hashtags: string[];            // extractKeywords
      characteristics: object[];     // extractCharacteristics
      aspectVariants: object[];      // extractAspectVariants
    };
    sellerPortal: {
      [sku: string]: {               // 每变体一份
        searchResponse: object;      // /api/v1/search 响应
        bundleResponse: object;      // /create-bundle-by-variant-id 响应
        pickedSv: object;            // pickItemForSku 选中的 sv
      };
    };
    pageJson: {
      [sku: string]: {               // 每变体一份
        endpoint: 'entrypoint-api' | 'composer-api';
        url: string;
        response: object;            // page-json 完整响应
        gallery: string[];           // 抽出的图册
        richContent: string | null;  // 抽出的富内容
      };
    };
    ssrAspects: {
      fetchedLinks: { sku: string; link: string; html: string }[]; // Phase A SSR 抓取记录
      mergedVariants: object[];      // 合并后的变体并集
    };
    videoTranscode: {
      originalMp4Url: string | null;
      transferredVideoUrl: string | null;
      transferredCoverUrl: string | null;
      swResponse: object;            // SW uploadFollowSellVideo 响应
    };
  };

  // ── 合成的 Ozon import 请求预览(含字段来源) ──
  synthesizedItems: SynthesizedItem[];
};

type SynthesizedItem = {
  // 与跟卖 items[] 同构,但每个字段带 source
  offer_id: SourcedField<string>;
  name: SourcedField<string>;
  price: SourcedField<string>;       // 注意:采集场景 price 来自源商品,非用户填
  old_price: SourcedField<string>;
  currency_code: SourcedField<string>;
  vat: SourcedField<string>;
  images: SourcedField<string[]>;
  bundleComplexAttrs: SourcedField<object[] | null>;
  videoUrl: SourcedField<string | null>;
  videoCover: SourcedField<string | null>;
  scraped_breadcrumbs: SourcedField<string[] | null>;
  scraped_description: SourcedField<string>;
  _aiHashtags: SourcedField<string[] | null>;
  scraped_sku: SourcedField<string>;
  scraped_brand: SourcedField<string>;
  scraped_brand_value: SourcedField<string | null>;
  scraped_model_name: SourcedField<string | null>;
  _sourceVariant: SourcedField<object | null>;
  weight: SourcedField<number | null>;
  depth: SourcedField<number | null>;
  width: SourcedField<number | null>;
  height: SourcedField<number | null>;
  scraped_weight: SourcedField<number | null>;
  scraped_depth: SourcedField<number | null>;
  scraped_width: SourcedField<number | null>;
  scraped_height: SourcedField<number | null>;
};
```

---

## 五、后端接口与存储设计

### 5.1 新表 `collect_box_v2`

```sql
-- 追加到 erp-backend-lite/src/db/schema.sql

CREATE TABLE IF NOT EXISTS collect_box_v2 (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id              TEXT,
  anchor_sku            TEXT NOT NULL,           -- 母体 SKU
  source_page_url       TEXT,                    -- 采集源 PDP URL
  variant_count         INTEGER DEFAULT 0,       -- 变体总数
  variants_json         TEXT NOT NULL,            -- JSON: CollectedVariant[]
  raw_by_source_json    TEXT,                     -- JSON: 5 类数据源原始响应
  synthesized_items_json TEXT,                    -- JSON: 合成请求预览(含字段来源)
  collected_at          INTEGER,                  -- 采集时间戳(ms)
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cbv2_store_created ON collect_box_v2(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cbv2_anchor_sku ON collect_box_v2(anchor_sku);
CREATE INDEX IF NOT EXISTS idx_cbv2_collected ON collect_box_v2(collected_at DESC);
```

**设计决策**：
- 不在 `variants_json` 上建索引 —— SQLite JSON 查询性能差，复杂筛选在前端做
- `anchor_sku` 单独列 + 索引 —— 支持按母体 SKU 查重
- `collected_at` 单独列 —— 支持时间范围筛选
- `raw_by_source_json` 可能较大（含完整 API 响应），但 SQLite TEXT 无长度限制，单条预估 200KB-2MB

### 5.2 新接口

#### 5.2.1 插件推送：`POST /ozon/collect-box/v2`

文件：`erp-backend-lite/src/modules/collect-box.js` 追加

```js
// POST /ozon/collect-box/v2 —— 全数据源采集推送
router.post('/ozon/collect-box/v2', storeGuard, (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.anchorSku) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'anchorSku 必填'));
    if (!Array.isArray(body.variants) || body.variants.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'variants 必填且非空'));
    }

    const info = db.prepare(`
      INSERT INTO collect_box_v2
        (store_id, anchor_sku, source_page_url, variant_count,
         variants_json, raw_by_source_json, synthesized_items_json, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.storeId,
      body.anchorSku,
      body.sourcePageUrl || '',
      body.variants.length,
      JSON.stringify(body.variants),
      JSON.stringify(body.rawBySource || {}),
      JSON.stringify(body.synthesizedItems || []),
      body.collectedAt || Date.now()
    );

    res.json({ id: info.lastInsertRowid, anchorSku: body.anchorSku, variantCount: body.variants.length });
  } catch (e) {
    next(e);
  }
});
```

#### 5.2.2 admin 列表：`GET /admin/api/collect-box-v2`

文件：`erp-backend-lite/src/modules/admin.js` 追加

```js
// GET /admin/api/collect-box-v2 —— 全源采集列表(筛选+分页)
// query: ?currentPage=1&pageSize=20&storeId=&keyword=&hasVideo=&minVariants=
router.get('/admin/api/collect-box-v2', (req, res, next) => {
  try {
    const current = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (current - 1) * pageSize;

    const where = [];
    const params = [];
    if (req.query.storeId) { where.push('store_id = ?'); params.push(String(req.query.storeId)); }
    if (req.query.keyword) {
      where.push('(anchor_sku LIKE ? OR variants_json LIKE ?)');
      params.push('%' + req.query.keyword + '%', '%' + req.query.keyword + '%');
    }
    if (req.query.minVariants) {
      where.push('variant_count >= ?');
      params.push(Number(req.query.minVariants));
    }
    // hasVideo=1 筛选:raw_by_source_json 含 transferredVideoUrl
    // (SQLite JSON 查询弱,这里用 LIKE 兜底,精确筛选在前端)
    if (req.query.hasVideo === '1') {
      where.push("raw_by_source_json LIKE '%transferredVideoUrl%'");
    }
    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const rows = db.prepare(
      `SELECT id, store_id, anchor_sku, source_page_url, variant_count,
              collected_at, created_at
       FROM collect_box_v2 ${whereSql}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);

    const total = db.prepare(
      `SELECT COUNT(*) as n FROM collect_box_v2 ${whereSql}`
    ).get(...params).n;

    res.json(ok({
      items: rows.map(r => ({
        id: r.id,
        storeId: r.store_id,
        anchorSku: r.anchor_sku,
        sourcePageUrl: r.source_page_url,
        variantCount: r.variant_count,
        collectedAt: r.collected_at,
        createdAt: r.created_at,
      })),
      total, current, pageSize,
    }));
  } catch (e) { next(e); }
});
```

> 列表页**不返回** `variants_json` / `raw_by_source_json`（可能 MB 级），只返回摘要字段。详情接口单独拉全量。

#### 5.2.3 admin 详情：`GET /admin/api/collect-box-v2/:id`

```js
// GET /admin/api/collect-box-v2/:id —— 全源采集详情
router.get('/admin/api/collect-box-v2/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = db.prepare(`SELECT * FROM collect_box_v2 WHERE id=?`).get(id);
    if (!row) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '记录不存在'));

    res.json(ok({
      id: row.id,
      storeId: row.store_id,
      anchorSku: row.anchor_sku,
      sourcePageUrl: row.source_page_url,
      variantCount: row.variant_count,
      variants: safeParseJson(row.variants_json),
      rawBySource: safeParseJson(row.raw_by_source_json),
      synthesizedItems: safeParseJson(row.synthesized_items_json),
      collectedAt: row.collected_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } catch (e) { next(e); }
});
```

#### 5.2.4 admin 删除：`DELETE /admin/api/collect-box-v2/:id`

```js
router.delete('/admin/api/collect-box-v2/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const info = db.prepare(`DELETE FROM collect_box_v2 WHERE id=?`).run(id);
    if (info.changes === 0) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '记录不存在'));
    res.json(ok({ deleted: true, id }));
  } catch (e) { next(e); }
});
```

---

## 六、插件端改造方案

### 6.1 改造 `collectAllVariants` 函数

文件：`qx-ozon/content/ozon-product.js` [L1368](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L1368)

**改造思路**：复用 `toggleFollowSellPanel` 的全部数据源采集逻辑，但**不打开面板**，而是组装成 `CollectedRecord` 推送后端。

```js
async function collectAllVariants(btn) {
  const setBtn = (text) => { /* ... */ };

  // ── Phase 0: composer-api 预热 ──
  if (window.ensurePdpState) {
    await Promise.race([window.ensurePdpState(), new Promise(r => setTimeout(r, 3000))]);
  }

  // ── Phase 1: 全数据源采集(与 toggleFollowSellPanel 同款) ──
  // 1.1 DOM 数据源
  const domProduct = extractProductData();
  const domBreadcrumbs = extractBreadcrumbs();
  const domHashtags = extractKeywords();
  const domCharacteristics = extractCharacteristics();
  const domAspects = extractAspectVariants();

  // 1.2 Phase 0 弹窗补全 + Phase A SSR 展开
  let variants = await jzExpandVariantsViaModal(domAspects, extractRawAspects(), setBtn);
  const ssrFetchLog = []; // 记录 SSR 抓取
  variants = await expandVariantsViaSSR(variants, ssrFetchLog, setBtn);

  // 1.3 Phase B: 每变体 searchVariants(含 bundle)
  const sourceMap = new Map(); // sku → sv
  await prefetchAllSourceVariants(variants, sourceMap, setBtn);

  // 1.4 每变体 fetchVariantGallery(图册 + 富内容)
  const galleryMap = new Map();  // sku → string[]
  const richContentMap = new Map(); // sku → string
  await fetchAllVariantGalleries(variants, galleryMap, richContentMap, setBtn);

  // 1.5 视频转存(listing 级,母体一次)
  setBtn('转存视频…');
  const videoMedia = await captureAndTransferPageVideoMedia(setBtn);

  // ── Phase 2: 组装带 source 标记的 CollectedVariant[] ──
  const collectedVariants = variants.map(v => buildCollectedVariant(v, {
    domProduct, domBreadcrumbs, domHashtags, domCharacteristics,
    sourceMap, galleryMap, richContentMap, videoMedia,
  }));

  // ── Phase 3: 组装合成请求预览(含字段来源) ──
  const synthesizedItems = collectedVariants.map(cv => buildSynthesizedItem(cv));

  // ── Phase 4: 组装 rawBySource(原始响应) ──
  const rawBySource = {
    dom: { productData: domProduct, breadcrumbs: domBreadcrumbs, hashtags: domHashtags,
           characteristics: domCharacteristics, aspectVariants: domAspects },
    sellerPortal: Object.fromEntries([...sourceMap.entries()].map(([sku, sv]) =>
      [sku, { pickedSv: sv, searchResponse: sv._searchMeta, bundleResponse: sv._bundleMeta }])),
    pageJson: Object.fromEntries([...galleryMap.keys()].map(sku => [sku, {
      gallery: galleryMap.get(sku), richContent: richContentMap.get(sku) || null,
    }])),
    ssrAspects: { fetchedLinks: ssrFetchLog, mergedVariants: variants },
    videoTranscode: { originalMp4Url: videoMedia?.originalUrl, ...videoMedia },
  };

  // ── Phase 5: 推送后端 ──
  setBtn('推送中…');
  const anchorSku = String(domProduct?.sku || '');
  const result = await window.sendMessage('pushCollectBoxV2', {
    anchorSku,
    sourcePageUrl: window.location.href,
    variants: collectedVariants,
    rawBySource,
    synthesizedItems,
    collectedAt: Date.now(),
  });

  return { multiVariant: true, total: collectedVariants.length, ...result };
}
```

### 6.2 新增辅助函数 `buildCollectedVariant` / `buildSynthesizedItem`

```js
// 把一个 aspect 变体 + 各数据源结果 组装成带 source 标记的 CollectedVariant
function buildCollectedVariant(v, ctx) {
  const { domProduct, domBreadcrumbs, domHashtags, domCharacteristics,
          sourceMap, galleryMap, richContentMap, videoMedia } = ctx;
  const sku = String(v.sku);
  const sv = sourceMap.get(sku);
  const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(sv) : null;
  const gallery = galleryMap.get(sku) || [];
  const richContent = richContentMap.get(sku) || '';
  const isAnchor = sku === String(domProduct?.sku || '');

  const now = Date.now();
  const sf = (value, source, sourceDetail) => ({ value, source, sourceDetail, collectedAt: now });

  return {
    sku: sf(sku, 'dom', 'URL 正则 /product/.*-(\\d{5,})'),
    url: sf(v.link || '', 'dom'),
    isAnchor,

    name: sf(
      svCat?.name || v.title || domProduct?.title || '',
      svCat?.name ? 'seller-portal' : 'dom',
      svCat?.name ? 'sv.attributes[4180]' : 'aria-label/alt/textContent'
    ),
    brand: sf(svCat?.brand || domProduct?.brand || null, svCat?.brand ? 'seller-portal' : 'dom',
              svCat?.brand ? 'sv.attributes[85]' : 'extractProductData'),
    categoryPath: sf(sv?.categories || [], 'seller-portal', 'sv.categories'),
    descriptionCategoryId: sf(sv?.description_category_id || null, 'seller-portal'),

    price: sf(v.priceRub || v.price || domProduct?.price || 0,
              v.priceRub ? 'ssr-aspects' : 'dom'),
    priceCurrency: sf(v.priceCurrency || 'CNY', 'computed', '_detectCurrencyFromPriceStr'),
    priceRub: sf(v.priceRub || 0, 'computed'),
    priceCny: sf(v.price || 0, 'computed', '_rubToCny'),
    oldPrice: sf(domProduct?.originalPrice || 0, 'dom'),
    discount: sf(domProduct?.statistics?.discount || 0, 'computed'),

    mainImage: sf(
      svCat?.mainImage || v.coverImage || domProduct?.mainImage || '',
      svCat?.mainImage ? 'seller-portal' : 'dom',
      svCat?.mainImage ? 'sv.attributes[4194]' : '<img src>'
    ),
    images: sf(
      gallery.length ? gallery : (svCat?.images || (v.coverImage ? [v.coverImage] : [])),
      gallery.length ? 'page-json' : (svCat?.images?.length ? 'seller-portal' : 'dom'),
      gallery.length ? 'fetchVariantGallery widgetStates' : 'sv.attributes[4195]'
    ),
    imageSource: gallery.length ? 'pageState' : (svCat?.images?.length ? 'sourceVariant' :
                  (v.coverImage ? 'coverImage' : 'none')),

    videoUrl: sf(videoMedia?.videoUrl || null, 'video-transcode', 'SW uploadFollowSellVideo'),
    videoCover: sf(videoMedia?.videoCover || null, 'video-transcode'),

    weight: sf(extractSourceInt(sv, '4497') || extractSourceWeightKg(sv) || null, 'seller-portal', 'sv[4497]||sv[4383]'),
    depth: sf(extractSourceInt(sv, '9454') || null, 'seller-portal', 'sv[9454]'),
    width: sf(extractSourceInt(sv, '9455') || null, 'seller-portal', 'sv[9455]'),
    height: sf(extractSourceInt(sv, '9456') || null, 'seller-portal', 'sv[9456]'),
    gtin: sf(extractSourceAttr(sv, '7822') || null, 'seller-portal', 'sv[7822]'),

    richContent: sf(richContent || null, 'page-json', 'richAnnotationJson'),

    breadcrumbs: sf(domBreadcrumbs || null, 'dom', 'extractBreadcrumbs'),
    hashtags: sf(domHashtags || null, 'dom', 'extractKeywords/webHashtags'),
    scrapedDims: sf(parseScrapedDimensionsFromCharacteristics(domCharacteristics || []) || null,
                    'dom', 'extractCharacteristics'),

    aspectValues: sf(v.aspectValues || {}, 'ssr-aspects'),

    sourceVariant: sf(sv || null, 'seller-portal', 'searchVariants picked'),
    bundleComplexAttrs: sf(sv?._bundleComplexAttrs || null, 'seller-portal', 'sv._bundleComplexAttrs'),

    ...(isAnchor ? {
      statistics: {
        soldCount: sf(domProduct?.statistics?.sold_count || null, 'dom'),
        soldSum: sf(domProduct?.statistics?.sold_sum || null, 'dom'),
        views: sf(domProduct?.statistics?.views || null, 'dom'),
        convViewToOrder: sf(domProduct?.statistics?.conv_view_to_order || null, 'dom'),
        gmvSum: sf(domProduct?.statistics?.gmv_sum || null, 'dom'),
      },
      seller: {
        name: sf(domProduct?.seller?.name || null, 'dom'),
        link: sf(domProduct?.seller?.link || null, 'dom'),
      },
    } : {}),
  };
}

// 把 CollectedVariant 合成跟卖 item(含字段来源)
function buildSynthesizedItem(cv) {
  const sf = (field) => field; // 直接透传 SourcedField
  return {
    offer_id: sf({ value: `SKU${cv.sku.value}`, source: 'computed', collectedAt: cv.sku.collectedAt }),
    name: cv.name,
    price: sf({ value: cv.price.value.toFixed(2), source: cv.price.source, collectedAt: cv.price.collectedAt }),
    old_price: sf({ value: (cv.oldPrice.value || cv.price.value * 1.25).toFixed(2), source: cv.oldPrice.source, collectedAt: cv.oldPrice.collectedAt }),
    currency_code: sf({ value: 'CNY', source: 'computed', collectedAt: Date.now() }),
    vat: sf({ value: '0', source: 'computed', collectedAt: Date.now() }),
    images: cv.images,
    bundleComplexAttrs: cv.bundleComplexAttrs,
    videoUrl: cv.videoUrl,
    videoCover: cv.videoCover,
    scraped_breadcrumbs: cv.breadcrumbs,
    scraped_description: cv.description,
    _aiHashtags: cv.hashtags,
    scraped_sku: cv.sku,
    scraped_brand: sf({ value: 'copy', source: 'computed', collectedAt: Date.now() }),
    scraped_brand_value: cv.brand,
    _sourceVariant: cv.sourceVariant,
    weight: cv.weight,
    depth: cv.depth,
    width: cv.width,
    height: cv.height,
    scraped_weight: cv.scrapedDims,
    scraped_depth: cv.scrapedDims,
    scraped_width: cv.scrapedDims,
    scraped_height: cv.scrapedDims,
  };
}
```

### 6.3 SW 侧新增 handler

文件：`qx-ozon/background/service-worker.js`

```js
case 'pushCollectBoxV2': {
  const backendUrl = await getBackendUrl();
  const storeId = await inferStoreId(message, sender);
  const resp = await fetch(`${backendUrl}/ozon/collect-box/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-store-id': storeId },
    body: JSON.stringify(message),
  });
  if (!resp.ok) throw new Error(`pushCollectBoxV2 HTTP ${resp.status}`);
  sendResponse(await resp.json());
  break;
}
```

---

## 七、前端展示页面设计

### 7.1 新增 Tab：`#tabCollectBoxV2`

文件：`erp-backend-lite/src/public/admin.html`

在现有 tab 列表追加：

```html
<li class="tab" data-tab="collectBoxV2">采集箱(全源)</li>
```

Tab 面板：

```html
<section id="tabCollectBoxV2" class="tab-panel">
  <div class="filter-bar">
    <select id="cbv2FilterStore" class="filter-select"></select>
    <input id="cbv2FilterKeyword" class="filter-input" placeholder="SKU/标题搜索">
    <select id="cbv2FilterHasVideo" class="filter-select">
      <option value="">全部</option>
      <option value="1">有视频</option>
    </select>
    <input id="cbv2FilterMinVariants" class="filter-input" type="number" placeholder="最少变体数" min="0">
    <button id="cbv2Search" class="btn">搜索</button>
    <button id="cbv2Refresh" class="btn">刷新</button>
  </div>
  <div id="collectBoxV2List" class="cb-grid"></div>
  <div id="cbv2Pager" class="pager"></div>
</section>
```

### 7.2 详情弹窗：5 个 sub-tab

```html
<div id="cbv2DetailModal" class="modal-mask hidden">
  <div class="modal-card cbv2-detail-card">
    <div class="modal-head">
      <h3 id="cbv2DetailTitle">采集详情</h3>
      <button class="modal-close" data-action="close-cbv2-detail">×</button>
    </div>
    <div class="modal-body">
      <!-- sub-tab 导航 -->
      <div class="sub-tabs">
        <button class="sub-tab active" data-subtab="overview">概览</button>
        <button class="sub-tab" data-subtab="dom">DOM 数据源</button>
        <button class="sub-tab" data-subtab="seller-portal">Seller Portal</button>
        <button class="sub-tab" data-subtab="page-json">Page-JSON</button>
        <button class="sub-tab" data-subtab="synthesized">合成请求预览</button>
      </div>

      <!-- sub-tab 面板 -->
      <div class="sub-panel active" data-subpanel="overview" id="cbv2OverviewPanel"></div>
      <div class="sub-panel" data-subpanel="dom" id="cbv2DomPanel"></div>
      <div class="sub-panel" data-subpanel="seller-portal" id="cbv2SellerPanel"></div>
      <div class="sub-panel" data-subpanel="page-json" id="cbv2PageJsonPanel"></div>
      <div class="sub-panel" data-subpanel="synthesized" id="cbv2SynthesizedPanel"></div>
    </div>
  </div>
</div>
```

### 7.3 accordion 折叠组件（新建）

文件：`erp-backend-lite/src/public/admin.js` 追加通用组件

```js
// 通用 accordion 折叠面板
function createAccordion(title, contentHtml, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'accordion';
  const head = document.createElement('div');
  head.className = 'accordion-head' + (opts.defaultOpen ? ' is-open' : '');
  head.innerHTML = `<span class="accordion-arrow">▶</span><span class="accordion-title">${title}</span>
    ${opts.badge ? `<span class="accordion-badge">${opts.badge}</span>` : ''}`;
  const body = document.createElement('div');
  body.className = 'accordion-body' + (opts.defaultOpen ? '' : ' hidden');
  body.innerHTML = contentHtml;
  head.addEventListener('click', () => {
    head.classList.toggle('is-open');
    body.classList.toggle('hidden');
  });
  wrap.append(head, body);
  return wrap;
}

// 渲染带 source 标记的字段
function renderSourcedField(label, field) {
  if (!field) return '';
  const sourceColors = {
    'dom': '#3b82f6', 'seller-portal': '#10b981', 'page-json': '#f59e0b',
    'ssr-aspects': '#8b5cf6', 'video-transcode': '#ef4444', 'ui': '#6b7280',
    'computed': '#6b7280', 'merged': '#ec4899',
  };
  const color = sourceColors[field.source] || '#6b7280';
  const valHtml = typeof field.value === 'object'
    ? `<pre class="sf-value-pre">${escapeHtml(JSON.stringify(field.value, null, 2))}</pre>`
    : `<span class="sf-value">${escapeHtml(String(field.value ?? ''))}</span>`;
  return `
    <div class="sourced-field">
      <span class="sf-label">${label}</span>
      ${valHtml}
      <span class="sf-source" style="background:${color}">${field.source}</span>
      ${field.sourceDetail ? `<span class="sf-detail">${field.sourceDetail}</span>` : ''}
    </div>`;
}
```

文件：`erp-backend-lite/src/public/admin.css` 追加

```css
.accordion { border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 8px; overflow: hidden; }
.accordion-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; background: #f9fafb; user-select: none; }
.accordion-head:hover { background: #f3f4f6; }
.accordion-arrow { transition: transform 0.2s; font-size: 12px; color: #6b7280; }
.accordion-head.is-open .accordion-arrow { transform: rotate(90deg); }
.accordion-title { font-weight: 500; flex: 1; }
.accordion-badge { background: #e5e7eb; color: #6b7280; font-size: 12px; padding: 2px 8px; border-radius: 10px; }
.accordion-body { padding: 12px; border-top: 1px solid #e5e7eb; }

.sourced-field { display: grid; grid-template-columns: 140px 1fr auto auto; gap: 8px; align-items: start; padding: 6px 0; border-bottom: 1px solid #f3f4f6; }
.sf-label { color: #6b7280; font-size: 13px; }
.sf-value { font-weight: 500; word-break: break-all; }
.sf-value-pre { background: #f9fafb; padding: 8px; border-radius: 4px; font-size: 12px; overflow-x: auto; max-height: 300px; }
.sf-source { color: white; font-size: 11px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
.sf-detail { color: #9ca3af; font-size: 11px; }

.cbv2-detail-card { width: 90vw; max-width: 1200px; max-height: 90vh; }
.cbv2-detail-card .modal-body { overflow-y: auto; }
.sub-tabs { display: flex; gap: 4px; border-bottom: 1px solid #e5e7eb; margin-bottom: 12px; }
.sub-tab { padding: 8px 16px; border: none; background: none; cursor: pointer; border-bottom: 2px solid transparent; }
.sub-tab.active { color: #3b82f6; border-bottom-color: #3b82f6; }
```

### 7.4 各 sub-tab 渲染逻辑

#### 7.4.1 概览 sub-tab

```js
function renderCbv2Overview(detail) {
  const v0 = detail.variants[0] || {};
  return `
    <div class="cbv2-overview">
      ${renderSourcedField('母体 SKU', { value: detail.anchorSku, source: 'dom' })}
      ${renderSourcedField('源页 URL', { value: detail.sourcePageUrl, source: 'dom' })}
      ${renderSourcedField('变体总数', { value: detail.variantCount, source: 'computed' })}
      ${renderSourcedField('采集时间', { value: new Date(detail.collectedAt).toLocaleString(), source: 'computed' })}

      <h4>变体列表</h4>
      ${detail.variants.map((v, i) => createAccordion(
        `变体 ${i+1}: ${v.sku.value}${v.isAnchor.value ? ' (母体)' : ''}`,
        renderSourcedField('名称', v.name) +
        renderSourcedField('价格(CNY)', v.priceCny) +
        renderSourcedField('主图', v.mainImage) +
        renderSourcedField('重量(g)', v.weight) +
        renderSourcedField('图册数', { value: v.images.value?.length || 0, source: v.images.source }),
        { defaultOpen: i === 0, badge: v.imageSource.value }
      ).outerHTML).join('')}
    </div>`;
}
```

#### 7.4.2 DOM 数据源 sub-tab

```js
function renderCbv2Dom(detail) {
  const dom = detail.rawBySource.dom || {};
  return [
    createAccordion('extractProductData (PDP 商品数据)', `<pre>${escapeHtml(JSON.stringify(dom.productData, null, 2))}</pre>`),
    createAccordion('extractBreadcrumbs (面包屑)', `<pre>${escapeHtml(JSON.stringify(dom.breadcrumbs, null, 2))}</pre>`, { defaultOpen: true }),
    createAccordion('extractKeywords (主题标签)', `<pre>${escapeHtml(JSON.stringify(dom.hashtags, null, 2))}</pre>`, { defaultOpen: true }),
    createAccordion('extractCharacteristics (物理特性)', `<pre>${escapeHtml(JSON.stringify(dom.characteristics, null, 2))}</pre>`),
    createAccordion('extractAspectVariants (变体轴)', `<pre>${escapeHtml(JSON.stringify(dom.aspectVariants, null, 2))}</pre>`),
  ].map(el => el.outerHTML).join('');
}
```

#### 7.4.3 Seller Portal sub-tab

```js
function renderCbv2SellerPortal(detail) {
  const sp = detail.rawBySource.sellerPortal || {};
  const skus = Object.keys(sp);
  return skus.map(sku => createAccordion(
    `SKU ${sku}`,
    renderSourcedField('variant_id', { value: sp[sku].pickedSv?.variant_id, source: 'seller-portal', sourceDetail: '/api/v1/search' }) +
    renderSourcedField('类目', { value: sp[sku].pickedSv?.categories, source: 'seller-portal' }) +
    renderSourcedField('attributes 数', { value: sp[sku].pickedSv?.attributes?.length, source: 'seller-portal' }) +
    createAccordion('完整 sv 对象', `<pre>${escapeHtml(JSON.stringify(sp[sku].pickedSv, null, 2))}</pre>`).outerHTML +
    (sp[sku].searchResponse ? createAccordion('/search 响应', `<pre>${escapeHtml(JSON.stringify(sp[sku].searchResponse, null, 2))}</pre>`).outerHTML : '') +
    (sp[sku].bundleResponse ? createAccordion('/bundle 响应', `<pre>${escapeHtml(JSON.stringify(sp[sku].bundleResponse, null, 2))}</pre>`).outerHTML : ''),
    { badge: `${sp[sku].pickedSv?.attributes?.length || 0} attrs` }
  ).outerHTML).join('');
}
```

#### 7.4.4 Page-JSON sub-tab

```js
function renderCbv2PageJson(detail) {
  const pj = detail.rawBySource.pageJson || {};
  const skus = Object.keys(pj);
  return skus.map(sku => createAccordion(
    `SKU ${sku}`,
    renderSourcedField('图册数', { value: pj[sku].gallery?.length, source: 'page-json' }) +
    renderSourcedField('endpoint', { value: pj[sku].endpoint, source: 'page-json' }) +
    createAccordion('图册', `<pre>${escapeHtml(JSON.stringify(pj[sku].gallery, null, 2))}</pre>`).outerHTML +
    (pj[sku].richContent ? createAccordion('富内容(11254)', `<pre>${escapeHtml(pj[sku].richContent)}</pre>`, { defaultOpen: true }).outerHTML : '') +
    createAccordion('完整响应', `<pre>${escapeHtml(JSON.stringify(pj[sku].response, null, 2))}</pre>`).outerHTML,
    { badge: `${pj[sku].gallery?.length || 0} 图` }
  ).outerHTML).join('');
}
```

#### 7.4.5 合成请求预览 sub-tab（核心）

```js
function renderCbv2Synthesized(detail) {
  return detail.synthesizedItems.map((item, i) => createAccordion(
    `Item ${i+1}: ${item.scraped_sku.value}`,
    Object.entries(item).map(([key, field]) =>
      renderSourcedField(key, field)
    ).join(''),
    { defaultOpen: i === 0, badge: `${Object.keys(item).length} 字段` }
  ).outerHTML).join('');
}
```

每个字段都显示 `值 + 来源标签 + 来源细节`，一眼看清该字段来自哪个数据源。

---

## 八、实施步骤

### 8.1 后端（erp-backend-lite）

| 步骤 | 文件 | 内容 |
|------|------|------|
| 1 | `src/db/schema.sql` | 追加 `collect_box_v2` 表 DDL |
| 2 | `src/db/index.js` | `ensureMigrations` 补 CREATE TABLE IF NOT EXISTS |
| 3 | `src/modules/collect-box.js` | 追加 `POST /ozon/collect-box/v2` |
| 4 | `src/modules/admin.js` | 追加 `GET/DELETE /admin/api/collect-box-v2[/:id]` |
| 5 | `src/public/admin.html` | 追加 `#tabCollectBoxV2` Tab + `#cbv2DetailModal` 弹窗 |
| 6 | `src/public/admin.js` | 追加列表加载/详情加载/5 个 sub-tab 渲染/accordion 组件 |
| 7 | `src/public/admin.css` | 追加 accordion/sourced-field/modal 样式 |

### 8.2 插件端（qx-ozon）

| 步骤 | 文件 | 内容 |
|------|------|------|
| 1 | `content/ozon-product.js` | 重构 `collectAllVariants`：跑全数据源 + 组装带 source 标记的记录 |
| 2 | `content/ozon-product.js` | 新增 `buildCollectedVariant` / `buildSynthesizedItem` 辅助函数 |
| 3 | `background/service-worker.js` | 新增 `case 'pushCollectBoxV2'` handler |

### 8.3 兼容性

- **旧 `collect_box` 表与 `/ozon/collect-box` 接口保留不动**：现有搜索页 MY 采集器仍走旧接口
- **旧 admin Tab `#tabCollectBox` 保留**：与新 Tab `#tabCollectBoxV2` 并存
- **一键采集按钮默认走新接口**：但保留 `forceResubmit` 跳 dedup 语义

---

## 九、数据量预估

单条 `collect_box_v2` 记录大小预估：

| 字段 | 预估大小 | 说明 |
|------|---------|------|
| `variants_json` | 50KB-500KB | 每变体 ~5-50KB × 10 变体 |
| `raw_by_source_json` | 100KB-2MB | seller-portal 响应最大（每变体完整 sv + search + bundle 响应） |
| `synthesized_items_json` | 30KB-300KB | 每变体 ~3-30KB × 10 变体 |
| **单条总计** | **200KB-3MB** | 大变体商品可能 5MB+ |

**优化建议**：
- 若 `raw_by_source_json` 超过 1MB，可考虑只存 metadata（URL/响应大小/字段命中）而非完整响应，完整响应走 SW 缓存
- `variants_json` 的 `sourceVariant` 字段是 sv 完整对象，可考虑只存 `variant_id` + `attributes` 而非全量

---

## 十、关键设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 新表 vs 扩展旧表 | **新表 `collect_box_v2`** | 旧表 `product` JSON 结构已固化，扩展会破坏兼容；新表结构清晰 |
| 来源标记粒度 | **字段级 `{value, source, sourceDetail}`** | 满足需求 2/6，每个字段可独立追溯 |
| 原始响应保留 | **全量存 `raw_by_source_json`** | 满足审计/回放需求，SQLite TEXT 无长度限制 |
| 合成请求预览 | **后端不参与合成，插件端组装** | 插件端已有完整字段优先级逻辑，后端只存不处理 |
| 前端框架 | **原生 JS + 新增 accordion 组件** | 沿用现有 admin 无框架模式，避免引入依赖 |
| sub-tab 分源 | **5 个 sub-tab** | 满足需求 5，与 5 类数据源一一对应 |
| 列表页不返全量 | **列表只返摘要，详情单独拉** | 避免列表接口返回 MB 级数据 |

---

## 十一、风险与缓解

| 风险 | 缓解 |
|------|------|
| `raw_by_source_json` 过大（>5MB）导致 SQLite 性能下降 | 后端入库前检查大小，超 5MB 只存 metadata + 响应大小，完整响应丢弃 |
| 插件端采集耗时增加（每变体调 searchVariants + fetchVariantGallery） | 沿用现有 batchSize=3 并发 + AbortController 可取消 |
| Seller Portal 未登录导致 sv 缺失 | `sourceVariant` 字段标记 `source: 'seller-portal'` + `value: null`，前端展示「未采集」 |
| fetchVariantGallery 403（Ozon deprecate composer-api） | 已有 SSR HTML 兜底（Phase A），图册来源标记为 `ssr-aspects` |
| 前端渲染大 JSON 卡顿 | accordion 默认折叠，详情按需展开；JSON 渲染用 `<pre>` 限高 300px 滚动 |

---

## 十二、验收标准

1. **数据源完整性**：一键采集后，`raw_by_source` 含 5 类数据源（dom / sellerPortal / pageJson / ssrAspects / videoTranscode），每类非空
2. **字段来源标记**：`variants[].name.source` 为 `'seller-portal'` 或 `'dom'`，`images.source` 为 `'page-json'` 或 `'seller-portal'`
3. **合成请求预览**：`synthesizedItems` 每个字段都有 `source` 标签，与跟卖 `items[]` 字段同构
4. **后端接口**：`POST /ozon/collect-box/v2` 接收并存储完整记录；`GET /admin/api/collect-box-v2/:id` 返回全量数据
5. **前端展示**：
   - 列表页按 storeId/keyword/hasVideo/minVariants 筛选
   - 详情弹窗 5 个 sub-tab 可切换
   - 每个 sub-tab 内 accordion 可折叠/展开
   - 合成请求预览 sub-tab 每个字段显示来源标签（彩色 chip）
6. **兼容性**：旧 `collect_box` 表与 `/ozon/collect-box` 接口不受影响，旧 admin Tab 仍可用
