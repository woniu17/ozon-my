# Ozon seller-prototype 门户接口使用说明

> 适用于 qx-ozon 扩展跟卖(viaPortal)流程,绕过官方 `/v3/product/import` 限流,直接调用 seller.ozon.ru 后台接口。所有接口在浏览器内执行,带用户真实 cookie/UA/fingerprint 绕反爬。

## 目录

- [1. 通用约定](#1-通用约定)
- [2. 接口清单](#2-接口清单)
- [3. create-bundle(建空草稿)](#3-create-bundle建空草稿)
- [4. create-bundle-by-variant-id(跟卖源数据)](#4-create-bundle-by-variant-id跟卖源数据)
- [5. get-bundle-items(查询草稿)](#5-get-bundle-items查询草稿)
- [6. update-bundle-items(写入草稿数据)](#6-update-bundle-items写入草稿数据)
- [7. upload-bundle(提交发布)](#7-upload-bundle提交发布)
- [8. seller-tree/get-by-company-id(类目树查询)](#8-seller-treeget-by-company-id类目树查询)
- [9. /api/v1/search(SKU 搜索)](#9-apiv1searchsku-搜索)
- [10. 上架编排流程](#10-上架编排流程)
- [11. 常见错误与修复](#11-常见错误与修复)
- [12. 字段名对照表](#12-字段名对照表)

---

## 1. 通用约定

### 1.1 Base URL

```
https://seller.ozon.ru
```

### 1.2 URL 前缀

| 前缀 | 用途 |
|------|------|
| `/api/site/seller-prototype/*` | bundle 草稿管理(create / get / update / upload) |
| `/api/site/seller-prototype/create-bundle-by-variant-id` | 跟卖源数据查询 |
| `/api/v1/search` | 按 SKU 精确搜索源商品 |
| `/api/v1/seller-tree/get-by-company-id` | 完整类目树查询 |
| `/api/site/async-upload/v1/task/*` | 上传任务进度/错误查询 |

### 1.3 必带请求头

```http
POST {path} HTTP/1.1
Host: seller.ozon.ru
Content-Type: application/json
Accept: application/json, text/plain, */*
x-o3-app-name: seller-ui
x-o3-company-id: {sc_company_id}
x-o3-language: zh-Hans
x-o3-page-type: products
Cookie: sc_company_id={sc_company_id}; ...
```

- `sc_company_id`:从 `chrome.cookies.getAll({url:'https://seller.ozon.ru/', name:'sc_company_id'})` 获取,**所有接口 body 必带 `company_id` 字段**,值与该 cookie 一致
- `x-o3-page-type`:大多数接口用 `products`;seller-tree 等其他模块用 `products-other`
- 浏览器内 `fetch(..., {credentials:'include'})` 自动带 cookie

### 1.4 请求方法

所有接口均为 `POST`,body 为 JSON。

### 1.5 反爬与节奏控制

- 所有门户请求走 `fetchSellerPortal` 全局闸门,相邻间隔 ≥200ms
- 跨域快路优先(当前 www.ozon.ru 标签页内直发),失败回退 seller-tab executeScript → bridge
- 命中 403 反爬挑战(HTML 页)触发熔断,冷却 10 分钟

---

## 2. 接口清单

| 接口 | 路径 | 作用 |
|------|------|------|
| create-bundle | `/api/site/seller-prototype/create-bundle` | 建空草稿,固化类目 |
| create-bundle-by-variant-id | `/api/site/seller-prototype/create-bundle-by-variant-id` | 按 variant_id 拉源商品完整 bundle 数据(有副作用,会建 draft) |
| get-bundle-items | `/api/site/seller-prototype/get-bundle-items` | 查询 bundle 草稿当前 items |
| update-bundle-items | `/api/site/seller-prototype/update-bundle-items` | 写入/保存草稿全部商品数据(可反复调) |
| upload-bundle | `/api/site/seller-prototype/upload-bundle` | 提交发布:草稿 → 真实商品 |
| async-upload/v1/task/get-list | `/api/site/async-upload/v1/task/get-list` | 轮询 upload 任务进度 |
| async-upload/v1/task/get-errors | `/api/site/async-upload/v1/task/get-errors` | 拉取任务失败原因 |
| seller-tree/get-by-company-id | `/api/v1/seller-tree/get-by-company-id` | 完整类目树(反查叶子类目名) |
| search | `/api/v1/search` | 按 SKU 精确搜索源商品 |

---

## 3. create-bundle(建空草稿)

**用途**:创建空 bundle 草稿,返回 `bundle_id`。`description_category_lvl3_name` 在此固化。

### 请求

```http
POST /api/site/seller-prototype/create-bundle
```

```json
{
  "company_id": "3891653",
  "description_category_lvl3_name": "Набор для подвижных игр",
  "source_item_id": "2940215370"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `company_id` | string | ✅ | 店铺 ID(sc_company_id) |
| `description_category_lvl3_name` | string | ⭐ | **叶子类目名**(descriptionCategoryName,如"Набор для подвижных игр" = 户外游戏套装) |
| `source_item_id` | string | ❌ | 复制流程的源商品 variant_id;新建流程不传 |

### 响应

```json
{
  "bundle_id": "12813083"
}
```

### ⚠️ 关键说明

- `description_category_lvl3_name` **必须是叶子类目名**(descriptionCategoryName),不是类型名(descriptionTypeName)
- 同一叶子类目下可有多个 type(如 `Набор для подвижных игр` 下有 Вертушка/Дартс детский/Нейроскакалка 等)
- 传类型名会导致 Ozon 报错"Вы не указали тип. Атрибут является обязательным для заполнения"(您没有指定类型。属性是必填项)
- 叶子类目名通过 [seller-tree/get-by-company-id](#8-seller-treeget-by-company-id类目树查询) 按 `description_category_id` 反查

---

## 4. create-bundle-by-variant-id(跟卖源数据)

**用途**:按 variant_id 拉取源商品的完整 bundle 数据(40-63 个 attributes + 物理参数 + barcode)。**有副作用**,每次调用会创建一个 draft bundle。

### 请求

```http
POST /api/site/seller-prototype/create-bundle-by-variant-id
```

```json
{
  "company_id": "3891653",
  "variant_id": "815287627",
  "source": "SOURCE_UI_COPY_APPAREL"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `company_id` | string | ✅ | 店铺 ID |
| `variant_id` | string | ✅ | 源商品 variant_id(从 /search 获取,**不是 URL 数字 SKU**) |
| `source` | string | ✅ | 固定 `SOURCE_UI_COPY_APPAREL` |

### 响应

```json
{
  "bundle_id": "12816906",
  "item": {
    "id": "...",
    "offer_id": "...",
    "name": "Самолет пенопластовый метательный...",
    "barcode": "...",
    "price": "...",
    "old_price": "...",
    "height": 35,
    "depth": 385,
    "width": 110,
    "weight": 28,
    "primary_image": "https://...",
    "color_image": "",
    "images": ["https://..."],
    "attributes": [
      {
        "attribute_id": "8229",
        "complex_id": "0",
        "values": [
          {
            "value": "Набор для подвижных игр",
            "dictionary_value_id": "92991",
            "sequence": "0",
            "complex_sequence": "0",
            "is_default": false
          }
        ]
      }
    ],
    "description_category_id": "43433158",
    "new_description_category_id": "0",
    "type_id": "...",
    "currency": "...",
    "pdf_list": [],
    "image_photo_group": [],
    "geo_restrictions": [],
    "deleted": false,
    "unmerged": false,
    "item_id": "...",
    "group_id": "...",
    "sku": "...",
    "origin_variant_id": "..."
  }
}
```

### attribute 数据 shape(权威参考)

```json
{
  "attribute_id": "8229",           // ← 字符串,字段名是 attribute_id(不是 id)
  "complex_id": "0",                // ← 字符串
  "values": [
    {
      "value": "Набор для подвижных игр",
      "dictionary_value_id": "92991", // ← 字符串
      "sequence": "0",                // ← 额外字段
      "complex_sequence": "0",        // ← 额外字段
      "is_default": false             // ← 额外字段
    }
  ]
}
```

### 缓存策略

- 24 小时 chrome.storage.local cache(key 含 companyId + variantId,跨店隔离)
- `forceRefresh=true` 可绕过 cache 立即重拉
- bundle_id 每次调用递增,源商品改类目/属性时最多 1 天后刷新

---

## 5. get-bundle-items(查询草稿)

**用途**:查询 bundle 草稿当前 items,用于调试 update 是否成功写入。

### 请求

```http
POST /api/site/seller-prototype/get-bundle-items
```

```json
{
  "bundle_id": "12813083",
  "company_id": "3891653"
}
```

### 响应

```json
{
  "bundle_id": "12813083",
  "company_id": "3891653",
  "items": [
    {
      "offer_id": "...",
      "name": "...",
      "attributes": [...],
      "description_category_id": "43433158",
      "type_id": 92991,
      ...
    }
  ]
}
```

- `items` 为空数组说明 update-bundle-items 失败或 upload-bundle 已执行(发布后草稿会被清空)

---

## 6. update-bundle-items(写入草稿数据)

**用途**:写入/保存草稿全部商品数据,可反复调用。每个 item 做字段归一化 + 必填校验。

### 请求

```http
POST /api/site/seller-prototype/update-bundle-items
```

```json
{
  "bundle_id": "12813083",
  "company_id": "3891653",
  "source": "SOURCE_MERGED",
  "items": [
    {
      "offer_id": "jz-260703soqb-907041443",
      "name": "Самолет пенопластовый метательный...",
      "price": "111.00",
      "old_price": "222.00",
      "vat": "0",
      "currency_code": "CNY",
      "weight": 28,
      "weight_unit": "g",
      "depth": 385,
      "width": 110,
      "height": 35,
      "dimension_unit": "mm",
      "primary_image": "https://ir-21.ozonru.cn/s3/multimedia-1-w/7537678880.jpg",
      "images": [
        "https://ir-21.ozonru.cn/s3/multimedia-t/6598091981.jpg",
        "https://ir-21.ozonru.cn/s3/multimedia-8/6598092140.jpg"
      ],
      "images360": [],
      "pdf_list": [],
      "color_image": "",
      "barcode": "OZN907041443",
      "type_id": 92991,
      "description_category_id": 43433158,
      "new_description_category_id": 0,
      "attributes": [
        {
          "attribute_id": 8229,
          "complex_id": 0,
          "values": [
            {
              "value": "Набор для подвижных игр",
              "dictionary_value_id": 92991
            }
          ]
        }
      ],
      "complex_attributes": []
    }
  ]
}
```

### item 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `offer_id` | string | ✅ | 卖家自定义 SKU |
| `name` | string | ✅ | 商品名 |
| `price` | string | ✅ | 价格(字符串) |
| `old_price` | string | ❌ | 折扣前价格 |
| `vat` | string | ✅ | 增值税率("0"/"0.1"/"0.2") |
| `currency_code` | string | ✅ | 货币代码(RUB/CNY) |
| `weight` | number | ✅ | 重量(克,>0) |
| `weight_unit` | string | ✅ | "g" |
| `depth` | number | ✅ | 深(mm) |
| `width` | number | ✅ | 宽(mm) |
| `height` | number | ✅ | 高(mm) |
| `dimension_unit` | string | ✅ | "mm" |
| `primary_image` | string | ❌ | 主图 URL(不能与 images 重复) |
| `images` | string[] | ✅ | 图册 URL 数组 |
| `images360` | string[] | ❌ | 360 图 |
| `pdf_list` | array | ❌ | PDF 文件 |
| `color_image` | string | ❌ | 颜色图 |
| `barcode` | string | ❌ | 条形码 |
| `type_id` | number | ❌ | 类型 ID(>0 才传,与 8229 的 dictionary_value_id 一致) |
| `description_category_id` | number | ❌ | 叶子类目 ID(>0 才传) |
| `new_description_category_id` | number | ❌ | 新类目 ID(改类目时用) |
| `attributes` | array | ✅ | 简单属性数组 |
| `complex_attributes` | array | ❌ | 复杂属性(视频/PDF) |

### attribute 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `attribute_id` | number | **属性 ID(字段名是 `attribute_id`,不是 `id`!)** |
| `complex_id` | number | 复杂 ID(简单属性为 0) |
| `values` | array | 值数组 |
| `values[].value` | string | 属性值 |
| `values[].dictionary_value_id` | number | 字典值 ID(字典类型属性必填,如 8229 类型) |

### 必填字段校验

```js
['offer_id', 'name', 'price', 'images', 'attributes', 'weight',
 'depth', 'width', 'height', 'weight_unit', 'dimension_unit', 'vat']
```

### 响应

```json
{}
```

空对象表示成功。

---

## 7. upload-bundle(提交发布)

**用途**:把草稿提交发布为真实商品,返回 `upload_task_id`。

### 请求

```http
POST /api/site/seller-prototype/upload-bundle
```

```json
{
  "bundle_id": "12813083",
  "company_id": "3891653",
  "name": "Набор для подвижных игр",
  "strict": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `bundle_id` | string | ✅ | 草稿 ID |
| `company_id` | string | ✅ | 店铺 ID |
| `name` | string | ❌ | 类目名(与 create-bundle 时的 `description_category_lvl3_name` 同源,再次确认) |
| `strict` | boolean | ❌ | 严格模式(xy-ozon 扩展,无效图片/字段直接报错而非静默跳过) |

### 响应

```json
{
  "upload_task_id": "4983183941"
}
```

### 任务进度查询

```http
POST /api/site/async-upload/v1/task/get-list
{ "company_id": "3891653", "limit": 30, "page": 1 }
```

### 任务失败原因

```http
POST /api/site/async-upload/v1/task/get-errors
{ "company_id": "3891653", "task_id": 4983183941, "page": 1, "page_size": 50 }
```

---

## 8. seller-tree/get-by-company-id(类目树查询)

**用途**:查询当前店铺的完整类目树,用于按 `description_category_id` 反查叶子类目名(`descriptionCategoryName`)。

### 请求

```http
POST /api/v1/seller-tree/get-by-company-id
```

```json
{
  "company_id": "3891653"
}
```

### 响应

```json
{
  "result": {
    "15621031": {
      "descriptionCategoryId": "15621031",
      "descriptionCategoryName": "Одежда",
      "descriptionTypeId": "0",
      "descriptionTypeName": "",
      "disabled": false,
      "nodes": {
        "41777465": {
          "descriptionCategoryId": "41777465",
          "descriptionCategoryName": "Аксессуары",
          "descriptionTypeId": "0",
          "descriptionTypeName": "",
          "disabled": false,
          "nodes": {
            "93037": {
              "descriptionCategoryId": "41777693",
              "descriptionCategoryName": "Бабочка",
              "descriptionTypeId": "93037",
              "descriptionTypeName": "Бабочка",
              "disabled": false,
              "nodes": {},
              "isWeight": false
            }
          }
        }
      }
    }
  }
}
```

### 节点结构

| 字段 | 类型 | 说明 |
|------|------|------|
| `descriptionCategoryId` | string | 类目 ID(叶子节点是 create-bundle 的 `description_category_id`) |
| `descriptionCategoryName` | string | **叶子类目名**(create-bundle 的 `description_category_lvl3_name` 来源) |
| `descriptionTypeId` | string | 类型 ID("0" 表示非叶子节点;非 0 时与 attribute 8229 的 `dictionary_value_id` 对应) |
| `descriptionTypeName` | string | **类型名**(attribute 8229 的 `value` 来源,**不是** `description_category_lvl3_name`) |
| `nodes` | object | 子类目 map(叶子节点为空 `{}`) |
| `disabled` | boolean | 是否禁用 |
| `isWeight` | boolean | 是否计重商品 |

### 反查逻辑

```js
const findCatNameInTree = (tree, catId) => {
  const target = String(catId);
  const walk = (node) => {
    if (!node) return null;
    if (String(node.descriptionCategoryId) === target) {
      return node.descriptionCategoryName || null;
    }
    const nodes = node.nodes || {};
    for (const k of Object.keys(nodes)) {
      const found = walk(nodes[k]);
      if (found) return found;
    }
    return null;
  };
  for (const k of Object.keys(tree)) {
    const found = walk(tree[k]);
    if (found) return found;
  }
  return null;
};
```

### 缓存策略

- 7 天 chrome.storage.local cache(类目树不常变)
- 数据量较大(约 7992 个节点),DFS 查找性能 OK

### 实测示例

```
catId=43433158
  → descriptionCategoryName="Набор для подвижных игр"(户外游戏套装)
  → 该叶子下有 6 个 type:
      typeId=92987  typeName="Вертушка"
      typeId=92989  typeName="Дартс детский"
      typeId=92991  typeName="Набор для подвижных игр"
      typeId=97300  typeName="Пусковая игрушка"
      typeId=970990105 typeName="Нейроскакалка"
      typeId=971469925 typeName="Сачок"
```

---

## 9. /api/v1/search(SKU 搜索)

**用途**:按 SKU 精确搜索源商品,获取 variant_id(给 create-bundle-by-variant-id 用)。

### 请求

```http
POST /api/v1/search
```

```json
{
  "company_id": "3891653",
  "need_total": true,
  "filter": {
    "children_nodes": {
      "children_nodes": [
        { "input_leaf": { "sku": { "values": ["907041443"] } } }
      ],
      "operator": "AND"
    }
  },
  "pagination": { "limit": "50" },
  "is_copy_allowed": false
}
```

### 响应(关键字段)

```json
{
  "variants": [
    {
      "variant_id": "815287627",
      "variant_name": "Самолет пенопластовый метательный...",
      "main_image": "https://...",
      "secondary_images": ["https://..."],
      "description_type_name": "Набор для подвижных игр",
      "description_type_dict_value": "92991",
      "brand_name": "LEDUO",
      "brand_id": "...",
      "is_copy_allowed": true,
      "is_content_copy_allowed": true,
      "rating": 4.5,
      "skus": ["907041443"],
      "barcodes": ["0040049044276"],
      "categories": [
        { "id": "17027488", "level": "2" },
        { "id": "17028980", "level": "3" },
        { "id": "43433158", "level": "4" }
      ]
    }
  ]
}
```

### 关键字段映射

| /search 字段 | 用途 |
|--------------|------|
| `variant_id` | 给 create-bundle-by-variant-id 用 |
| `description_type_name` | attribute 8229 的 value 来源(类型名) |
| `description_type_dict_value` | attribute 8229 的 dictionary_value_id 来源 + type_id |
| `categories` | 只有 `{id, level}`,**没有 name** —— 叶子类目名必须查 seller-tree |
| `barcodes[0]` | attribute 7822 (GTIN) |
| `brand_name` | attribute 85 |
| `main_image` | attribute 4194 |
| `secondary_images` | attribute 4195 |

---

## 10. 上架编排流程

### 10.1 完整流程

```
[1] /api/v1/search (按 SKU 拿 variant_id + 基础元数据)
        ↓
[2] /api/site/seller-prototype/create-bundle-by-variant-id (拉源商品完整 bundle)
        ↓ bundleItem 挂到 sv._bundleItem
[3] /api/v1/seller-tree/get-by-company-id (查类目树,反查叶子类目名)
        ↓ sv.description_category_lvl3_name = 叶子类目名
[4] 后端 /ozon/products/prepare-bundle-items (加工链 + 分组 + 字段转换)
        ↓ bundles[] 每个 bundle 含 description_category_lvl3_name + items[]
[5] 逐 bundle:
    [5a] create-bundle (建空草稿,传 description_category_lvl3_name)
            ↓ bundle_id
    [5b] update-bundle-items (写入商品数据)
            ↓
    [5c] upload-bundle (提交发布)
            ↓ upload_task_id
[6] async-upload/v1/task/get-list (轮询进度)
[7] async-upload/v1/task/get-errors (失败原因)
```

### 10.2 代码位置

| 步骤 | 文件 | 函数 |
|------|------|------|
| [1] | `qx-ozon/background/service-worker.js` | `searchVariants` action (L4013) |
| [2] | `qx-ozon/background/service-worker.js` | `fetchBundleByVariantId` (L542) |
| [3] | `qx-ozon/background/service-worker.js` | `fetchSellerTree` + `findCatNameInTree` (L604/L638) |
| [4] | `erp-backend-lite/src/services/prepare-bundle.js` | `prepareBundleItems` + `transformItemForPortal` |
| [5a] | `qx-ozon/background/service-worker.js` | `createBundle` (L676) |
| [5b] | `qx-ozon/background/service-worker.js` | `updateBundleItems` (L700) |
| [5c] | `qx-ozon/background/service-worker.js` | `uploadBundle` (L840) |
| 编排 | `qx-ozon/background/service-worker.js` | `importViaPortal` (L890) |

### 10.3 公司一致性护栏

```js
if (storeCompanyId && storeCompanyId !== String(companyId)) {
  throw new Error('所选店铺与当前 seller.ozon.ru 登录店铺不一致,门户上架请先在浏览器切换到该店铺登录');
}
```

---

## 11. 常见错误与修复

### 11.1 "Вы не указали тип. Атрибут является обязательным для заполнения"

**中文**:您没有指定类型。属性是必填项

**根因**(三选一):

1. **attribute 字段名错误**:传了 `id` 而不是 `attribute_id` → Ozon 后台不识别 → 所有 attributes 被丢弃
   - **修复**: [`_normalizeV3Attributes`](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L792) 输出 `{ attribute_id, complex_id, values }`,不要用 `{ id, ... }`

2. **`description_category_lvl3_name` 传成了类型名**:同一叶子类目下有多个 type,传类型名无法按名匹配
   - **修复**: 通过 [seller-tree](#8-seller-treeget-by-company-id类目树查询) 按 `description_category_id` 反查 `descriptionCategoryName`,而不是用 attribute 8229 的 value

3. **8229 被 filter 丢掉**:字典类型属性可能只有 `dictionary_value_id` 而 `value` 为空,只按 value 非空过滤会丢掉
   - **修复**: filter 同时保留 `value` 非空 **或** `dictionary_value_id>0` 的条目

### 11.2 "图片 - 该字段重复的"

**根因**:`primary_image` 与 `images` 数组中的某张图重复
**修复**:`transformItemForPortal` 仅当某张图显式 `default:true` 时才作为 `primary_image`,否则留空让 OPI 自动用 `images[0]`

### 11.3 图片 URL 校验失败

**根因**:Excel 模板粘贴的 URL 被反引号 `` ` `` 包裹(如 `` `https://...jpg` ``),Ozon 无法识别
**修复**:[`_cleanUrl`](file:///c:/root/code/ozon-my/erp-backend-lite/src/services/prepare-bundle.js#L181-L182) 清理 URL 两端的反引号和空白

### 11.4 "4194/4195/4497/9454/9455/9456 重复"

**根因**:这些属性在 v3 schema 里由顶层字段单独传递(`primary_image`/`images`/`weight`/`depth`/`width`/`height`),放进 attributes 数组会重复
**修复**:`SKIP_ATTR_IDS = new Set([4194, 4195, 4497, 9454, 9455, 9456])` 过滤掉

### 11.5 403 PermissionDenied

**根因**:`company_id` 不匹配或会话过期
**修复**:检查 `sc_company_id` cookie,重新登录 seller.ozon.ru

### 11.6 403 HTML 反爬挑战

**根因**:请求密度过高触发反爬
**修复**:命中后冷却 10 分钟,降并发到 BATCH_SIZE=3 + 批间 400ms 节流

### 11.7 update-bundle-items 成功但 get-bundle-items 返回空

**可能原因**:
1. update 实际失败了(响应 body 非空,但有隐藏错误)
2. upload-bundle 已执行(发布后草稿会被清空,items 正常为空)

---

## 12. 字段名对照表

### 12.1 attribute 字段名差异(关键!)

| 字段 | seller-prototype(门户) | OPI v3(官方 API) |
|------|------------------------|-------------------|
| 属性 ID | `attribute_id` | `id` |
| complex ID | `complex_id` | `complex_id` |
| 值数组 | `values` | `values` |
| 值 | `values[].value` | `values[].value` |
| 字典值 ID | `values[].dictionary_value_id` | `values[].dictionary_value_id` |

**⚠️ seller-prototype/update-bundle-items 必须用 `attribute_id`,不能用 `id`!**

### 12.2 类目相关字段对照

| 字段 | 来源 | 示例 |
|------|------|------|
| `description_category_lvl3_name`(create-bundle body) | seller-tree 的 `descriptionCategoryName` | "Набор для подвижных игр" |
| `description_category_id`(update-bundle-items item) | bundleItem 同名字段 | 43433158 |
| `type_id`(update-bundle-items item) | attribute 8229 的 `dictionary_value_id` | 92991 |
| attribute 8229 `value` | seller-tree 的 `descriptionTypeName`(类型名) | "Дартс детский" |
| attribute 8229 `dictionary_value_id` | seller-tree 的 `descriptionTypeId` | 92991 |

### 12.3 图片字段对照

| 字段 | 来源 | 顶层字段 |
|------|------|---------|
| 4194(主图) | bundleItem / /search `main_image` | `primary_image` |
| 4195(图册) | bundleItem / /search `secondary_images` | `images[]` |

### 12.4 物理参数字段对照

| attribute ID | 来源 | 顶层字段 | 单位 |
|--------------|------|---------|------|
| 4497(重量) | bundleItem.weight | `weight` + `weight_unit` | g |
| 9454(深度) | bundleItem.depth | `depth` | mm |
| 9455(宽度) | bundleItem.width | `width` | mm |
| 9456(高度) | bundleItem.height | `height` + `dimension_unit` | mm |

---

## 13. 数据流总览

```
/search → variant_id + description_type_name + categories[{id, level}]
                ↓
create-bundle-by-variant-id → bundleItem(完整 attributes + 物理参数 + description_category_id)
                ↓
seller-tree/get-by-company-id → 按 description_category_id 反查 descriptionCategoryName
                ↓
sv.description_category_lvl3_name = 叶子类目名
                ↓
prepare-bundle.js transformItemForPortal → 转成 OPI v3 格式({id, ...})
                ↓
_normalizeV3Attributes → 转成 seller-prototype 格式({attribute_id, ...})
                ↓
create-bundle(description_category_lvl3_name=叶子类目名) → bundle_id
                ↓
update-bundle-items(items[{attributes:[{attribute_id, ...}]}])
                ↓
upload-bundle(name=叶子类目名) → upload_task_id
```
