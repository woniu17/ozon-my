# 商品信息更新任务 — 概要设计文档

> 版本:v2.0(改名+统一 v3/import+可拓展)
> 日期:2026-07-31
> 状态:**待用户确认**

---

## 一、背景与目标

### 1.1 问题

商品上架后,常因标题(4180)/描述(4191)等字段违规被 Ozon 审核拒绝(`DESCRIPTION_DECLINE`),或运营需要修改价格/图片/库存/属性等字段。当前 ERP 只能针对已上架商品改图片(image-refresh)和库存(stock-refresh),缺乏一个**通用的商品信息更新能力**。

### 1.2 目标

构建一个**通用的商品信息更新任务框架**,本期先实现标题(name/4180)和描述(4191)的更新,后续可低成本扩展到价格、图片、重量尺寸、任意属性等字段的更新。

### 1.3 设计原则

- **统一数据通路**:所有字段更新**统一走 `/v3/product/import` 全量重传**(已实测能同时更新 name + 描述 + 价格等所有字段)
- **字段驱动**:以"更新哪些字段"为输入驱动,而不是"调用哪个 API"
- **数据源 = Ozon 实时数据**:全量重传必须从 Ozon 实时拉完整商品数据,只替换用户指定字段,其他字段保留 Ozon 当前值(避免 ERP 快照过时覆盖中间修改)
- **可拓展**:新增一个可更新字段 = 新增一个 FieldUpdater,不改整体框架

### 1.4 已验证的技术结论(实测)

| 测试项 | 结论 |
|---|---|
| `/v3/product/import` 改 name | ✅ 成功(缓存延迟约 30s) |
| `/v3/product/import` 改描述(4191) | ✅ 成功 |
| `/v3/product/import` 同时改 name + 描述 | ✅ 成功(3760289051-0730-qx 实测) |
| `/v1/product/attributes/update` 改描述 | ✅ 成功(但本期不用,统一走 v3) |
| `/v1/product/attributes/update` 改 name | ❌ 失败(4180 是顶层 name,不在 attributes 体系) |
| 数据源用 ERP 快照 | ❌ 会过时(old_price/min_price 等可能已被 Ozon 修改) |
| price 取错路径(`.price.price`) | ❌ 会传 0,触发"价格不能为负数" |
| min_price ≥ price | ❌ 触发"最低价格应低于价格" |
| 必须过滤 SKIP_ATTR_IDS | `[4194, 4195, 4497, 9454, 9455, 9456, 23536]` 否则重复字段错误(project_memory 硬约束) |

---

## 二、架构设计

### 2.1 任务模型(对齐 image-refresh / stock-refresh)

```
product_update_tasks (任务级)  ──1:N──  product_update_items (商品级)
```

- **任务级**:一次"商品信息更新"操作,含多个商品
- **商品级**:每个商品一个 item,独立处理、独立轮询、独立记录结果

### 2.2 字段驱动架构(核心可拓展点)

```
用户选择商品 + 指定要更新的字段及新值
        ↓
POST /admin/api/product-update (创建任务)
        ↓
写入 product_update_tasks + product_update_items (status=PENDING)
        ↓
product-update-poller 轮询 PENDING 任务
        ↓
对每个 item:
  1. 从 Ozon 实时拉取完整商品数据(/v3/info/list + /v4/attributes)
  2. 根据 item.update_fields,逐个调用对应 FieldUpdater 替换字段
  3. 调 /v3/product/import 全量重传
  4. 轮询 /v1/product/import/info 确认结果
        ↓
更新 item.status (SUCCESS/FAILED) + 写入 errors
        ↓
全部 item 完成后,更新 task.status (SUCCESS/FAILED/PARTIAL)
```

### 2.3 FieldUpdater 机制(可拓展核心)

每个可更新字段对应一个 FieldUpdater,接口契约:

```js
// 输入:Ozon 实时数据(pInfo + pAttrs) + 用户指定的新值
// 输出:修改后的 OPI v3 item(只改对应字段,其他保留)
// 副作用:无(纯函数,不改原始数据)
function updateXxx(pInfo, pAttrs, opiItem, newValue) {
  // 修改 opiItem 的某个字段
  return opiItem;
}
```

### 2.4 本期实现的 FieldUpdater

| 字段 | 字段键 | FieldUpdater | 实现方式 |
|---|---|---|---|
| 标题 | `name` | `updateName` | 替换 `opiItem.name`(顶层字段,非 attribute) |
| 描述 | `description` | `updateDescription` | 替换 `opiItem.attributes` 中 id=4191 的值;不存在则追加 |

### 2.5 后续可拓展的 FieldUpdater(本期不实现,留接口)

| 字段 | 字段键 | FieldUpdater | 实现方式 |
|---|---|---|---|
| 价格 | `price` | `updatePrice` | 替换 `opiItem.price`,同步调整 `min_price` 保证 `< price` |
| 划线价 | `old_price` | `updateOldPrice` | 替换 `opiItem.old_price` |
| 重量 | `weight` | `updateWeight` | 替换 `opiItem.weight` + `weight_unit` |
| 尺寸 | `dimensions` | `updateDimensions` | 替换 `opiItem.depth/width/height` + `dimension_unit` |
| 主图 | `primary_image` | `updatePrimaryImage` | 替换 `opiItem.primary_image` |
| 图片列表 | `images` | `updateImages` | 替换 `opiItem.images` |
| 任意属性 | `attr:{attrId}` | `updateAttribute` | 替换 `opiItem.attributes` 中指定 id 的值 |

新增字段只需:
1. 在 `field-updaters/` 目录新增一个文件
2. 在 `field-updaters/index.js` 注册
3. 前端弹窗加一个对应的输入控件

---

## 三、数据库设计(新增 2 张表)

### 3.1 `product_update_tasks` — 任务级

```sql
CREATE TABLE IF NOT EXISTS product_update_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT UNIQUE NOT NULL,    -- pu-{timestamp}-{rand}
  store_id       TEXT NOT NULL,            -- 目标店铺
  status         TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/RUNNING/SUCCESS/FAILED/PARTIAL
  total_count    INTEGER DEFAULT 0,
  success_count  INTEGER DEFAULT 0,
  failed_count   INTEGER DEFAULT 0,
  update_fields  TEXT NOT NULL,           -- JSON: 任务级字段清单 ["name","description"](所有 item 的并集)
  source_type    TEXT DEFAULT 'manual',   -- manual(单条) / batch(批量)
  error_message  TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_put_status ON product_update_tasks(status, created_at DESC);
```

### 3.2 `product_update_items` — 商品级

```sql
CREATE TABLE IF NOT EXISTS product_update_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL,          -- 关联 product_update_tasks.local_task_id
  product_id       TEXT NOT NULL,          -- Ozon 商品 ID
  offer_id         TEXT NOT NULL,          -- 卖家 SKU(必填,API 用)
  store_id         TEXT NOT NULL,
  status           TEXT DEFAULT 'PENDING', -- PENDING/PROCESSING/SUCCESS/FAILED
  update_fields    TEXT NOT NULL,          -- JSON: 该 item 实际更新哪些字段 ["name","description"]
  new_values       TEXT NOT NULL,          -- JSON: { "name": "新标题", "description": "新描述" }(只含 update_fields 对应的键)
  opi_task_id      TEXT,                   -- Ozon 返回的 task_id
  opi_result       TEXT,                   -- JSON: /v1/product/import/info 查询结果
  error_message    TEXT,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pui_task ON product_update_items(task_id);
CREATE INDEX IF NOT EXISTS idx_pui_status ON product_update_items(status);
```

**设计要点**:
- `new_values` 用 JSON 存所有字段的新值,不同字段用不同键,拓展字段无需改表结构
- `update_fields` 是数组,明确该 item 更新哪些字段(避免 `new_values` 里某键为空字符串时无法区分"不更新"和"更新为空")

### 3.3 migration

在 [db/index.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/db/index.js) 的 migration 逻辑中追加建表语句(`CREATE TABLE IF NOT EXISTS`,老库自动补表)。

---

## 四、后端设计

### 4.1 OPI 封装([ozon-opi.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/services/ozon-opi.js))

新增 1 个函数(全量重传的核心):

```js
// 从 Ozon 实时拉取完整商品数据,根据 updateFields 替换指定字段,构建 /v3/product/import 的 payload
// 流程:
//   1. /v3/product/info/list 拿 price/old_price/min_price/vat 等顶层字段
//   2. /v4/product/info/attributes 拿 weight/dims/images/attributes/type_id/desc_cat_id
//   3. 转换 attributes:过滤 SKIP_ATTR_IDS,用 {complex_id, id, values:[{value}]} 格式
//   4. 构建 OPI v3 item(保留 Ozon 实时值)
//   5. 根据 updateFields 逐个调用 FieldUpdater 替换字段
//   6. min_price 仅当 < price 时才传(避免规则冲突)
// 返回: opiItem(可直接塞进 {items:[opiItem]} 调 productImport)
export async function buildProductUpdatePayload(store, offerId, updateFields, newValues) {
  // ...
}
```

### 4.2 FieldUpdater(`src/services/field-updaters/`,新建目录)

```
src/services/field-updaters/
  ├── index.js              # 注册表 + 统一入口 applyFieldUpdaters(pInfo, pAttrs, opiItem, updateFields, newValues)
  ├── name.js               # updateName: 替换 opiItem.name
  └── description.js        # updateDescription: 替换 opiItem.attributes 中 id=4191
```

#### `field-updaters/index.js`(注册表)

```js
import updateName from './name.js';
import updateDescription from './description.js';

// 注册表:字段键 → updater 函数
const REGISTRY = {
  name: updateName,
  description: updateDescription,
  // 后续拓展:
  // price: updatePrice,
  // old_price: updateOldPrice,
  // weight: updateWeight,
  // dimensions: updateDimensions,
  // primary_image: updatePrimaryImage,
  // images: updateImages,
};

export function applyFieldUpdaters(pInfo, pAttrs, opiItem, updateFields, newValues) {
  for (const field of updateFields) {
    const updater = REGISTRY[field];
    if (!updater) throw new Error(`不支持的更新字段: ${field}`);
    updater(pInfo, pAttrs, opiItem, newValues[field]);
  }
  return opiItem;
}

export function getSupportedFields() {
  return Object.keys(REGISTRY);
}
```

#### `field-updaters/name.js`

```js
// 替换 opiItem.name(顶层字段,非 attribute)
export default function updateName(pInfo, pAttrs, opiItem, newName) {
  if (typeof newName !== 'string' || !newName.trim()) {
    throw new Error('新标题不能为空');
  }
  opiItem.name = newName.trim();
}
```

#### `field-updaters/description.js`

```js
const ATTR_ID_DESCRIPTION = 4191;

// 替换 opiItem.attributes 中 id=4191 的值;不存在则追加
export default function updateDescription(pInfo, pAttrs, opiItem, newDescription) {
  if (typeof newDescription !== 'string') {
    throw new Error('新描述类型错误');
  }
  const existing = opiItem.attributes.find((a) => Number(a.id) === ATTR_ID_DESCRIPTION);
  if (existing) {
    existing.values = [{ value: newDescription }];
  } else {
    opiItem.attributes.push({
      complex_id: 0,
      id: ATTR_ID_DESCRIPTION,
      values: [{ value: newDescription }],
    });
  }
}
```

### 4.3 REST 路由(`src/modules/product-update.js`,新建)

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/admin/api/product-update` | 创建任务(单条或批量) |
| `GET`  | `/admin/api/product-update` | 任务列表(分页) |
| `GET`  | `/admin/api/product-update/:localTaskId` | 任务详情(含 items) |
| `POST` | `/admin/api/product-update/:localTaskId/cancel` | 取消未处理 items |
| `POST` | `/admin/api/product-update/:localTaskId/items/:id/retry` | 重试单个失败 item |
| `POST` | `/admin/api/product-update/preview` | 预览:根据 offer_id 拉当前商品信息(name + description 等) |
| `GET`  | `/admin/api/product-update/supported-fields` | 查询当前支持更新的字段列表 |

#### 创建任务请求体

```jsonc
// 单条
{
  "storeId": "store-yql01-b6b2b1",
  "items": [
    {
      "productId": "5736725672",
      "offerId": "3760289051-0730-qx",
      "updateFields": ["name", "description"],
      "newValues": {
        "name": "Тренажер для растяжения шейного отдела позвоночника",
        "description": "Тренажер для растяжения шейного отдела..."
      }
    }
  ]
}

// 批量(同店铺,多商品,每个 item 独立指定字段和值)
{
  "storeId": "store-yql01-b6b2b1",
  "items": [
    {
      "productId": "...", "offerId": "...",
      "updateFields": ["description"],
      "newValues": { "description": "..." }
    },
    {
      "productId": "...", "offerId": "...",
      "updateFields": ["name", "description"],
      "newValues": { "name": "...", "description": "..." }
    }
  ]
}
```

### 4.4 Poller(`src/services/product-update-poller.js`,新建)

仿 [image-refresh-poller.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/services/image-refresh-poller.js) 模式:

```js
// 每 5 秒扫描一次 PENDING 的 product_update_tasks
// 对每个 RUNNING 任务的 PENDING items,串行处理:
//   1. buildProductUpdatePayload(store, offerId, updateFields, newValues)
//      → 从 Ozon 实时拉数据 + 应用 FieldUpdater → 得到 opiItem
//   2. productImport(store, { items: [opiItem] }) → 拿 task_id
//   3. 轮询 productImportInfo(store, task_id) 直到 status != pending
//   4. 更新 item.status + opi_result + errors
//   5. 全部 item 完成后更新 task.status
//
// 并发控制:串行处理 items(避免 OPI 限流),遇 429 等待 Retry-After
```

### 4.5 挂载([app.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/app.js))

```js
import productUpdateRouter from './modules/product-update.js';
import { startProductUpdatePoller } from './services/product-update-poller.js';

app.use(productUpdateRouter.routes());
startProductUpdatePoller();
```

---

## 五、前端设计

### 5.1 新增文件

| 文件 | 说明 |
|---|---|
| `web/src/views/ProductUpdateList.vue` | 任务列表页(仿 ImageRefreshList) |
| `web/src/views/ProductUpdateDetail.vue` | 任务详情页(含新旧值对比) |
| `web/src/components/ProductUpdateDialog.vue` | 创建任务弹窗(单条/批量,字段驱动) |
| `web/src/api/productUpdate.js` | API 调用封装 |

### 5.2 路由注册([router/index.js](file:///c:/root/code/ozon-my/erp-backend-lite/web/src/router/index.js))

```js
{ path: '/product-update-tasks', name: 'product-update-tasks', component: ProductUpdateList, meta: { title: '商品信息更新任务' } },
{ path: '/product-update/:localTaskId', name: 'product-update-detail', component: ProductUpdateDetail, meta: { title: '商品信息更新详情' } },
```

### 5.3 顶部菜单入口([AppTopbar.vue](file:///c:/root/code/ozon-my/erp-backend-lite/web/src/components/AppTopbar.vue))

在"图片更新任务"旁新增"商品信息更新"菜单项。

### 5.4 商品列表入口([Products.vue](file:///c:/root/code/ozon-my/erp-backend-lite/web/src/views/Products.vue))

商品列表行操作菜单新增"更新信息"按钮,点击弹出 `ProductUpdateDialog`,预填 offer_id / product_id,并调 `/preview` 拉当前 name/description。

### 5.5 创建任务弹窗(ProductUpdateDialog.vue)交互

```
┌─────────────────────────────────────────────┐
│ 创建商品信息更新任务                         │
├─────────────────────────────────────────────┤
│ 店铺: [YQL01 ▼]                             │
│                                             │
│ ┌─ 商品 1 ─────────────────────────────┐   │
│ │ offer_id: 3760289051-0730-qx         │   │
│ │                                      │   │
│ │ ☑ 标题  [Тренажер для растяжения...] │   │
│ │ ☑ 描述  [Тренажер для растяжения...  │   │
│ │         (多行文本框)                 │   │
│ │ ☐ 价格  [本期待实现,置灰]            │   │
│ │ ☐ 重量  [本期待实现,置灰]            │   │
│ │ [预览当前值]                         │   │
│ └──────────────────────────────────────┘   │
│                                             │
│ [+ 添加商品]                                │
│                                             │
│              [取消]  [提交任务]             │
└─────────────────────────────────────────────┘
```

**字段驱动**:勾选哪个字段,就显示对应的输入控件。本期只勾选标题/描述,后续可勾选价格/重量等(控件已预留位置)。

### 5.6 任务详情页(ProductUpdateDetail.vue)展示

每个 item 展示:

| 列 | 内容 |
|---|---|
| offer_id | 卖家 SKU |
| 状态 | PENDING/SUCCESS/FAILED |
| 更新字段 | name, description(逗号分隔) |
| 标题(旧→新) | 旧值 → 新值(并排对比) |
| 描述(旧→新) | 旧值(截断) → 新值(截断),点击展开完整 |
| errors | Ozon 返回的错误信息 |
| 操作 | 重试(失败时) |

---

## 六、关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| **统一 API** | 所有字段都走 `/v3/product/import` 全量重传 | 1. 一次请求可改多个字段 2. 简化框架 3. 已实测可改 name + 描述 + 价格等所有字段 |
| **数据源** | Ozon 实时数据(`/v3/info/list` + `/v4/attributes`) | ERP 快照会过时(old_price/min_price 等可能已变) |
| **可拓展机制** | FieldUpdater 注册表 | 新增字段不改框架,只加一个 updater 文件 + 注册 |
| **任务命名** | `product_update_*`(而非 `attr_refresh_*`) | 命名反映"商品信息更新"的通用性,不局限于属性 |
| **字段统一性** | 每个 item 独立指定字段和值 | 不同商品需要改的内容不同 |
| **页面入口** | 独立菜单 + 商品列表入口 | 对齐 image-refresh 模式 |
| **轮询策略** | poller 自动轮询 | 对齐 image-refresh,用户无需手动刷新 |
| **字段存储** | `new_values` JSON(键=字段名,值=新值) | 拓展字段无需改表结构 |

---

## 七、改动清单

### 7.1 后端(7 个文件)

| 文件 | 改动 |
|---|---|
| [ozon-opi.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/services/ozon-opi.js) | 新增 `buildProductUpdatePayload` |
| `src/services/field-updaters/index.js` | **新建** FieldUpdater 注册表 + `applyFieldUpdaters` |
| `src/services/field-updaters/name.js` | **新建** 标题 updater |
| `src/services/field-updaters/description.js` | **新建** 描述 updater |
| `src/services/product-update-poller.js` | **新建** 仿 image-refresh-poller |
| `src/modules/product-update.js` | **新建** REST 路由 |
| [app.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/app.js) | 挂载路由 + 启动 poller |
| [schema.sql](file:///c:/root/code/ozon-my/erp-backend-lite/src/db/schema.sql) | 新增 2 张表 |
| [db/index.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/db/index.js) | migration 补表 |

### 7.2 前端(6 个文件)

| 文件 | 改动 |
|---|---|
| `web/src/views/ProductUpdateList.vue` | **新建** |
| `web/src/views/ProductUpdateDetail.vue` | **新建** |
| `web/src/components/ProductUpdateDialog.vue` | **新建** |
| `web/src/api/productUpdate.js` | **新建** |
| [router/index.js](file:///c:/root/code/ozon-my/erp-backend-lite/web/src/router/index.js) | 注册 2 条路由 |
| [AppTopbar.vue](file:///c:/root/code/ozon-my/erp-backend-lite/web/src/components/AppTopbar.vue) | 新增菜单项 |
| [Products.vue](file:///c:/root/code/ozon-my/erp-backend-lite/web/src/views/Products.vue) | 行操作菜单加"更新信息" |

---

## 八、风险与约束

| 风险 | 应对 |
|---|---|
| OPI 限流(每分钟/每日限制) | poller 串行处理,遇 429 等待 Retry-After |
| 全量重传覆盖了 Ozon 中间修改的字段 | 数据源用 Ozon 实时数据,只替换用户指定字段 |
| SKIP_ATTR_IDS 未过滤导致重复字段错误 | `buildProductUpdatePayload` 内置过滤 |
| min_price ≥ price 触发"最低价格应低于价格"错误 | 仅当 `min_price < price` 时才传 min_price |
| price 取错路径(`.price.price`)导致传 0 | 严格从 `/v3/product/info/list` 顶层取 |
| declined 商品改了字段后审核不自动重置 | 实测会自动重置 moderate_status,无需额外操作 |
| 全量重传比增量(/v1/attributes/update)略慢 | 缓存延迟约 30s,可接受;换取框架统一性 |

---

## 九、不在本期范围

- 价格/划线价更新(框架已预留 FieldUpdater 接口,后续加 `price.js` / `old_price.js` 即可)
- 重量/尺寸更新(同上,加 `weight.js` / `dimensions.js`)
- 图片/主图更新(已有 image-refresh 模块,后续可整合)
- 任意属性更新(加通用 `attr:{attrId}` updater)
- 描述内容自动优化/净化(自动删除 emoji/[标签]/颜色枚举等)
- 标题自动生成(根据商品类型+品牌+型号)
- 批量任务支持统一文案(所有商品共用一份标题/描述)
- 历史违规商品扫描与自动修复

---

## 十、待确认

请确认以下内容后开始实施:

1. **改名**:从"标题/描述更新"改为"商品信息更新任务",统一命名是否 OK?
2. **统一 API**:所有字段更新统一走 `/v3/product/import` 全量重传(而非 v1/v3 混用)是否 OK?
3. **FieldUpdater 可拓展机制**:新增字段只加 updater 文件 + 注册,是否 OK?
4. **页面入口**(独立菜单 + 商品列表行操作)是否 OK?
5. **不在本期范围**的 8 项是否同意推迟?
