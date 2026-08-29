# 采购订单与Ozon订单关联管理 — 功能设计文档

> 复刻妙手ERP「订单处理 + 采购管理」核心链路，用于管理 1688/拼多多/淘宝采购订单与 Ozon FBS 订单的关联。
>
> 调研基线：妙手ERP `erp.91miaoshou.com/order/package/index`（2026-08-29 实测）
> Ozon API 参考：`docs/ozon-api/05-FBS订单与配送.md`

***

## 目录

1. [背景与目标](#1-背景与目标)
2. [妙手ERP实测功能解剖](#2-妙手erp实测功能解剖)
3. [核心概念：三层关联模型](#3-核心概念三层关联模型)
4. [数据模型设计](#4-数据模型设计)
5. [状态机设计](#5-状态机设计)
6. [Ozon订单同步方案](#6-ozon订单同步方案)
7. [核心功能流程](#7-核心功能流程)
8. [采购物流同步与异常监控](#8-采购物流同步与异常监控)
9. [页面功能清单](#9-页面功能清单)
10. [与现有系统集成](#10-与现有系统集成)
11. [实施分期建议](#11-实施分期建议)

***

## 1. 背景与目标

### 1.1 业务场景

无货源（一件代发）模式运营 Ozon FBS 店铺：

```
买家在Ozon下单 → 卖家在1688/拼多多/淘宝采购 → 上家发货到国内集运/货代
→ 货代打包贴国际面单 → 交运Ozon物流 → 妥投 → 回款结算
```

痛点：采购单（1688订单号）与平台订单（Ozon posting number）分散在两个体系，人工对照极易错发、漏发、超时发货（Ozon FBS 有 cutoff 时限，超时罚款）。

### 1.2 目标

| 目标    | 说明                               |
| ----- | -------------------------------- |
| 订单聚合  | 同步 Ozon FBS 订单到本地，以「包裹」为单位聚合管理   |
| 采购关联  | 建立 采购单 ↔ 包裹 ↔ Ozon订单 的双向关联，支持一对多 |
| 全链路跟踪 | 采购金额/物流轨迹自动回写，驱动利润计算与发货决策        |
| 异常预警  | 采购超时未发货、物流轨迹停滞、即将延迟发货等预警         |

### 1.3 范围

* ✅ Ozon FBS（含 rFBS 跨境）订单同步、状态跟踪

* ✅ 采购单手工录入 / 购物车半自动下单 / 关联管理

* ✅ 采购物流轨迹同步（国内段）

* ✅ 妙手「订单处理」「采购记录」两页面的复刻

* ❌ 妙手「扫描分拣/扫描发货」「货代管理」「Ozon发运单」组包预报（二期）

* ❌ 1688 自动下单/自动付款（妙手依赖其自研浏览器扩展与1688深度授权，复刻采用半自动购物车方案）

***

## 2. 妙手ERP实测功能解剖

### 2.1 订单处理页面（`/order/package/index`）

**页面骨架**：

```
┌ Tab页签（按包裹操作状态分流）─────────────────────────────┐
│ 待处理(3) 待打单发货(30) 交运平台(2) 已发货(150) 已搁置(2) 平台售后(132) │
├ 出货维度 ──────────────────────────────────────────────┤
│ 未出货 / 已出货                                          │
├ 平台维度 ──────────────────────────────────────────────┤
│ 全部 / Ozon / 其他                                       │
├ 筛选标签（点击计数进入过滤视图）──────────────────────────┤
│ 未选择物流 / 报关信息缺失 / 即将延迟发货 / 已延迟发货        │
│ 收件地址变更 / 已配对SKU / 未配对SKU / 缺货 / 部分缺货      │
│ 有货 / 有买家留言 / +自定义筛选                            │
├ 搜索区（精确/模糊双模式，双击批量）────────────────────────┤
│ 全局搜索: 包裹号/订单号/运单号/采购单号/采购物流单号（模糊）  │
│ 包裹号 | 订单编号 | 订单线上状态 | 物流方式 | 订单标记       │
│ 产品来源ID | 平台SKU | 下单时间 | 订单标签 | 产品数量 | 店铺  │
├ 批量操作 ──────────────────────────────────────────────┤
│ 申请运单号 | 打印 | 合并采购(1688) | 提交代打包             │
│ 刷新规则 | 订单设置 | 同步上家物流 | 导入/导出 | 手工订单     │
│ 同步订单                                                │
└────────────────────────────────────────────────────────┘
```

**列表列（自左向右）**：产品信息（图片/标题/规格(中)(原)/单价/平台SKU）｜自定义信息（订单标记）｜出货信息（采购物流单号/上家发货状态）｜订单金额（订单金额/实付/预估结算/采购金额/运费成本/预估利润/成本利润率/销售利润率）｜收件人（地区/姓名/买家留言）｜包裹号&物流信息｜时间（下单时间/剩余发货时间倒计时）

**行内操作**：`申请运单号` `提交代打包` `详情` `更多▾`（调用库存/确定出库/修改收件人信息/搁置/标记黑名单/不打单直接发货/移入缺货/取消订单/打印拿货小标签/标记测评订单）

### 2.2 实测API与数据结构

#### 2.2.1 列表主接口

```
POST /api/order/package/render_list/searchOrderPackageList
Content-Type: application/x-www-form-urlencoded
```

**关键请求参数**：

| 参数                                           | 说明                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `appPackageTab`                              | tab路由：`waitProcess`/`waitShip`/`submitPlatform`/`waitReceiverConfirm` |
| `submitPlatformTab`                          | 交运平台子tab（如 `shipSuccess`）                                             |
| `waitProcessTab`                             | 待处理子tab（`all`/未出货/已出货）                                                |
| `pageSize` / `page`                          | 分页（10/页）                                                              |
| `sortField=gmtOrderStart&sortType=desc`      | 下单时间倒序                                                                |
| `platformOrderSns` + `platformOrderSnsRp=eq` | 订单号批量精确搜索（`Rp`=匹配模式：eq精确/ss模糊/g范围）                                    |
| `priceType=profit`                           | 金额列展示口径（利润视图）                                                         |

**响应结构（包裹为聚合根，实测89字段）**：

```jsonc
{
  "result": "success",
  "packageList": [{
    // ── 包裹层 ──
    "opOrderPackageId": "1819118513",       // 包裹内部ID
    "appPackageNo": "MS20260829153356062",  // 包裹号（自生成）
    "appPackageOperateStatus": "wait_audit",// 操作状态（tab分流依据）
    "appPurchaseStatus": "0",               // 采购状态: 0未采购 2已采购
    "platformPackageStatus": "awaiting_packaging", // Ozon货件状态
    "logisticsNo": null,                    // 尾程运单号（Ozon跟踪号）
    "logisticsCompany": "ABT Economy Extra Small",
    "logisticsType": "aggregator",
    "headLogisticsNo": null,                // 头程（上家）物流单号
    "isShipped": "0",
    "gmtLastDelivery": "2026-09-03 17:00:00", // 最晚发货时限（倒计时源）
    "gmtCreate": "2026-08-29 15:33:56",
    "itemQuantity": "1",

    // ── 订单层 orderInfo（1:1）──
    "orderInfo": {
      "opOrderId": "1850522674",
      "platform": "ozon",
      "platformOrderSn": "78345175-0268-1",   // = Ozon posting_number ★关联键
      "platformOrderId": "38656575079",       // = Ozon order_id
      "platformOrderStatus": "awaiting_packaging",
      "orderAmount": "27.75",                 // 订单金额(CNY)
      "escrowAmount": "27.75",                // 预估结算
      "estimatedShippingFee": 4.35,           // 预估运费
      "buyerId": "78345175",
      "buyerUsername": "Petr Ignatov Aleksandrovich",
      "buyerSelectLogistics": "ABT Economy Extra Small",
      "platformOrderDetailUrl": "https://seller.ozon.ru/app/postings/...",
      "isCb": "1",                            // 跨境单标记
      "buyerMessage": null
    },

    // ── 产品行层 items（Map, key=opOrderItemId）──
    "items": {
      "2211860745": {
        "opOrderItemId": "2211860745",
        "platformItemId": "6010934464",        // = Ozon products[].sku
        "platformSkuId": "5512860768",
        "platformItemNum": "4823859913-0818-qx", // = offer_id ★采购匹配键
        "platformOuterSkuId": "4823859913-0818-qx",
        "title": "Беспроводная виброколонка...",
        "skuSubName": "Цвет товара:белый,Максимальная мощность, Вт:25", // 规格(原)
        "quantity": "1",
        "picUrl": "...",
        "itemCostDetail": {                    // 成本明细（采购回写目标）
          "purchaseAmount": "8.50",            // 采购金额
          "headShippingFee": null,             // 头程运费
          "tailShippingFee": null,             // 尾程运费
          "packagingCost": "0.00",             // 包材成本
          "forwarderFreight": null             // 货代运费
        },
        "purchasePriceTotal": "12.80",
        "goodsPurchaseOrderInternalSns": []    // 列表接口恒为空，关联在配套接口
      }
    },

    // ── Ozon专属 ──
    "ozonPackage": {
      "deliveryMethodName": "ABT Economy Extra Small Xiamen 03 PUDO",
      "deliveryMethodWarehouseId": "1020005008464080",
      "deliveryMethodWarehouse": "厦门006",     // 发货仓库
      "warehouseType": "rfbs",
      "isFbp": "0"
    },

    // ── 金额/利润（orderPackageAmountDetail节选）──
    "orderPackageAmountDetail": {
      "purchasePrice": "12.80", "CNYPurchasePrice": "12.80",
      "escrowAmount": "...", "income": 0
    },

    "consigneeInfo": { "country": "RU", "name": "...", "fullAddress": "..." },
    "flags": [],                               // 订单标记
    "packagingList": [], "packagingCost": 0
  }],
  "total": 3, "page": 1, "pageSize": 10
}
```

#### 2.2.2 采购关联明细接口（列表加载后二次并行请求）

```
POST /api/order/package/render_list/getOpOrderPackageIdAndOutboundInfoMap
body: opOrderPackageIds=1818474065        （逗号分隔批量）
```

**响应（采购单完整挂载）**：

```jsonc
{
  "result": "success",
  "opOrderPackageIdAndOutboundInfoMap": {
    "1818474065": {
      "opOrderPackageId": "1818474065",
      "purchaseOrders": {                    // ★ 采购单按包裹挂载（可多张）
        "156704170": {
          "purchaseOrderId": "156704170",
          "purchasePlatform": "1688",        // 1688 / 拼多多 / 淘宝
          "purchaseOrderSn": "5127660720062029909", // 1688订单号
          "purchaseOrderStatus": "wait_send",
          "purchaseOrderPayment": "12.80",   // 实付
          "purchaseOrderBuyer": "清祥17",    // 采购账号
          "purchaseOrderSeller": "深圳市嘉龙盛电子有限公司", // 上家
          "purchaseOrderFullAddress": "福建省 厦门市 ... 菜鸟驿站", // 收货地址(集运仓)
          "purchaseOrderDetailUrl": "https://trade.1688.com/order/new_step_order_detail.htm?orderId=...",
          "purchaseOrderStartTime": "2026-08-29 12:56:45",
          "isAutoRsyncPurchasePayment": "1",
          "relateOpOrderItemIds": ["2211130114"],  // ★ 关联的平台产品行
          "platformOrderSn": "22612735-0197-1",    // ★ 反查Ozon订单
          "items": [{
            "opOrderItemId": "2211130114",
            "platformItemId": "6010934464",   // Ozon SKU
            "purchasePrice": "12.80",
            "purchaseNum": "1",
            "purchaseUrl": null,              // 货源链接
            "forwarderProductName": "",       // 报关-中文品名
            "forwarderProductEnName": null,   // 报关-英文品名
            "forwarderGoodsType": ""          // 报关-海关编码
          }],
          "purchaseOrderPackages": []
        }
      },
      "items": { "2211130114": { "supplierGoodsSku": null, "needPurchase1688TimeoutTip": 0, ... } }
    }
  }
}
```

**关联链路实证**：

```
Ozon订单 platformOrderSn ──1:1──> opOrderId ──1:N──> opOrderPackageId(包裹)
包裹 ──1:N──> purchaseOrders[]（采购单）
采购单 ──N:N──> relateOpOrderItemIds[]（平台产品行 opOrderItemId）
采购金额 ──回写──> items[].itemCostDetail.purchaseAmount + orderPackageAmountDetail.purchasePrice
```

#### 2.2.3 四个Tab实测状态对照（计数与页面一致）

| Tab   | appPackageTab         | appPackageOperateStatus       | platformPackageStatus(Ozon) | 特征字段                               |
| ----- | --------------------- | ----------------------------- | --------------------------- | ---------------------------------- |
| 待处理   | `waitProcess`         | `wait_audit` / `wait_process` | `awaiting_packaging`        | appPurchaseStatus=0或2              |
| 待打单发货 | `waitShip`            | `wait_ship`                   | `awaiting_deliver`          | 已有logisticsNo，gmtPrintWaybill=null |
| 交运平台  | `submitPlatform`      | `ship_success`                | `awaiting_deliver`          | gmtPrintWaybill有值（已打单）             |
| 已发货   | `waitReceiverConfirm` | `ship_success`                | `delivering`                | isShipped=1，gmtDelivery有值          |

### 2.3 代发采购弹窗（单包裹采购入口）

点击行内「代发采购」：

```
┌ 代发采购 ────────────────────────────────────────┐
│ 包裹号: MS20260829150443072                       │
│ 产品规格: 一件产品中的数量单位:1,丝扣位置:内螺纹...    │
│ 数量: 1                                           │
│ 选择服务商: [不使用货代 ▾]  添加货代                 │
│ 采购方式: ○链接下单 ○1688购物车 ○淘宝购物车          │
│ 自动同步采购金额: ○是 ○否                           │
│ 关联产品: ☑ x1 [产品名]  添加货源链接                │
│ ── 1688同款商品推荐（按SKU/图搜）查看更多 ──          │
│ 1688产品信息        | 价格/库存   | 销量/复购率 | 操作  │
│ 【升级蓝帽】pe管...  | CNY0.5~0.5  | 14422/23%  | 一键关联 去采购 │
│ ...（5条推荐）                                    │
└──────────────────────────────────────────────────┘
```

* **一键关联**：把1688商品链接绑定到该SKU（供应商-产品映射，下次自动带出）

* **去采购**：跳转1688商品页，用户手动下单（或加入1688购物车统一结算）

* **自动同步采购金额=是**：采购单创建后自动把实付金额回写到订单成本

### 2.4 合并采购弹窗（批量聚合采购）

全选订单 →「合并采购(1688)」：

```
┌ 合并采购(1688) ─────────────────────────────────────┐
│ 提示: ①下单付款后，采购成本均分至多个平台订单           │
│       ②每次采购最多100个供货商 ③每供货商最多50种商品    │
│ 采购账号: [清祥17]  选择货代: [不使用货代]  收件地址: [选择] │
│ ┌ 1688商家(供货商分组) │ 平台产品 │ 1688采购产品 │ 操作 ┐│
│ │ 未匹配链接           │          │              │      ││
│ │  以下产品无法采购                │  匹配供应商 移除│      ││
│ │  [Ozon产品×规格×金额]           │              │      ││
│ │  [一键移除不可采购产品(2)]       │              │      ││
│ ├ 供货商数量: 0 │ 采购总数量: 0 │ 共计: ¥0 ────────────┤│
│ │ 给商家留言: [0/500]                                 ││
│ │                              [预览采购单]           ││
│ └────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

**核心逻辑**：按「供货商」（1688商家ID）聚合多张Ozon订单的相同/相近SKU → 一张1688采购单覆盖多个平台订单 → 采购成本（商品+运费）**按数量占比均分**回写到各平台订单的 `itemCostDetail`。

### 2.5 采购记录页面（`/order/purchase_record`）

**Tab**：`全部(837) 待付款(2) 待发货(26) 已发货(714) 部分已发货(0) 已签收(31) 已完成(49) 已关闭(15)`

**搜索**：采购单号（精确）｜采购平台（1688/1688妙手/拼多多/淘宝）｜采购时间｜货代服务｜站点/店铺｜**关联状态（已关联/已取消关联）**｜订单状态｜上家名称

**列表列**：

```
采购信息                      | 金额(元)          | 时间信息              | 关联平台订单信息           | 关联订单产品信息
采购单号:5127660720062029909  | 实付:12.80        | 采购:12:56:45         | 平台:Ozon-Ozon            | Беспроводная...×1
采购平台:1688                 | 运费:--           | 付款:12:56:53         | 店铺:YQL006               |   规格:Цвет товара:белый
采购账号:清祥17               | 其他:--           | 同步:15:19:57         | 包裹号:MS20260829...      |   产品ID:6010934464
上家名称:深圳市嘉龙盛电子      |                   | 发货:13:46:01         | 订单号:22612735-0197-1    |   平台SKU:4823859913-0818-qx
[催促发货]                    |                   |                       | 订单状态:待发货            |   产品单价:CNY 27.75
                              |                   |                       | [已关联]                   |
─────────────────────────────────────────────────────────────────────────
物流: 韵达快递 435332472136948                                          │
最新轨迹: 2026-08-29 14:44:09 【金华市】浙江义乌凌云公司 已揽收 [查看完整轨迹]│
```

**批量操作**：`批量付款(1688)` `催1688商家发货` `导出采购记录` `同步上家物流`

**异常监控面板**（`催发/物流追踪异常(558)`）：

| 预警规则             | 实测计数 |
| ---------------- | ---- |
| 采购单下单24小时后上家仍未发货 | 13笔  |
| 采购单发货24小时无揽收轨迹   | 120笔 |
| 采购单轨迹24小时未更新     | 51笔  |

**采购平台分类实测**：`1688`（API直连同步）｜`1688妙手`（妙手代下单，与1688同单号但渠道标记不同）｜`拼多多`（采购单号格式 `260829-516906094883751`，页面同步）｜`淘宝`

### 2.6 订单详情弹窗（关联信息聚合视图）

```
详情
包裹号: MS... | 平台: Ozon | 店铺: YQL004 | IOSS: 无 | 买家: Mariya... | 回款金额: CNY 14.28
┌──────────┬──────────────────────┬─────────┬──────────┐
│ 产品信息   │ 报关信息(合并申报)      │ 出货信息 │ 操作      │
│ 订单号     │ 英文品名 / 中文品名     │ 追加商品 │ 调用库存  │
│ 产品×数量  │ 申报重量               │         │ 编辑报关  │
│ 产品ID     │ 目的国申报金额          │         │          │
│ 产品规格   │ 出口国申报金额          │         │          │
│ 产品单价   │ 海关编码               │         │          │
│ 商品SKU    │                       │         │          │
└──────────┴──────────────────────┴─────────┴──────────┘
买家地址 | 物流信息(买家指定/获取方式/物流方式/预估运费/跟踪单号/打印面单)
备注信息 | 包材信息 | 操作日志
```

**报关信息**是跨境发运（rFBS）回传 Ozon 的 `requirements.products_requiring_country/gtd` 前置数据，与 `/v2/posting/fbs/product/country/set` 配套。

***

## 3. 核心概念：三层关联模型

从妙手实测抽象出的领域模型：

```
┌─────────────┐      ┌─────────────┐      ┌──────────────────┐
│  Ozon订单    │ 1──1 │   平台订单    │ 1──N │     包裹(Package)  │
│ (posting)   │      │ (order)      │      │ 发货/采购/物流单元  │
└─────────────┘      └─────────────┘      └────────┬─────────┘
                       │ 1                       │ 1
                       │                         │ N
                       ▼                         ▼
                  ┌─────────────┐      ┌──────────────────┐
                  │  订单产品行   │ N──N │    采购单(Purchase) │
                  │ (order_item) │◄─────│ 1688/拼多多/淘宝   │
                  └─────────────┘ 关联  └────────┬─────────┘
                       ▲                        │ 1
                       │ 金额回写                 │ N
                       │                        ▼
                       │                 ┌──────────────────┐
                       └─────────────────│  采购产品行         │
                          (itemCostDetail) │ (purchase_item)  │
                                         └────────┬─────────┘
                                                  │ 1:1
                                                  ▼
                                         ┌──────────────────┐
                                         │  头程物流轨迹       │
                                         │ (国内快递)         │
                                         └──────────────────┘
```

**为什么以「包裹」为中心**（而非直接订单↔采购单）：

1. Ozon 一张订单可能因分仓拆成多个 posting（`parent_posting_number`），妙手拆成多包裹分别发货
2. 多张 Ozon 订单的相同产品可合并成一张 1688 采购单（合并采购），成本均分——需要中间层拆账
3. 包裹承载全部操作状态（打单、交运、发货），是页面tab的分流单元

***

## 4. 数据模型设计

存储沿用 `erp-backend-lite` 的 SQLite（`node:sqlite` DatabaseSync），遵循项目 `db/schema.sql` 既有风格。

### 4.1 ER总览

```
ozon_order ──1:1── order ──1:N── package ──1:N── purchase ──1:N── purchase_item
                      │              │             │
                      1:N            1:1            N:1
                      │              │             │
                  order_item ──N:N──┘(package_item) supplier_product(货源映射)
                      │
                      采购金额回写 item_cost
```

### 4.2 表结构

#### `ozon_order` — Ozon平台订单（posting同步落地）

```sql
CREATE TABLE IF NOT EXISTS ozon_order (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        TEXT NOT NULL,                -- 店铺(对应OPI client_id)
  posting_number  TEXT NOT NULL,                -- ★ Ozon posting_number (78345175-0268-1)
  order_id        INTEGER,                      -- Ozon order_id (38656575079)
  order_number    TEXT,                         -- Ozon order_number
  parent_posting_number TEXT,                   -- 母件号(拆单溯源)
  status          TEXT NOT NULL,                -- awaiting_packaging / awaiting_deliver / delivering / driver_pickup / delivered / cancelled
  substatus       TEXT,
  in_process_at   TEXT,                         -- 开始处理时间
  shipment_date   TEXT,                         -- ★ cutoff最晚发货时间(倒计时)
  cutoff_at       TEXT,
  currency        TEXT DEFAULT 'CNY',
  order_amount    REAL,                         -- 订单金额(店铺币种折CNY)
  products_amount REAL,
  delivery_price  REAL,                         -- 物流价格
  buyer_id        TEXT,
  buyer_name      TEXT,
  delivery_method_name TEXT,                    -- ABT Economy Extra Small
  warehouse_name  TEXT,                         -- 厦门006
  warehouse_type  TEXT,                         -- rfbs
  tpl_integration_type TEXT,
  is_express      INTEGER DEFAULT 0,
  is_cb           INTEGER DEFAULT 1,            -- 跨境单
  cancellation_json TEXT,                       -- 取消原因快照
  raw_json        TEXT,                         -- API原始响应(审计/补字段)
  first_synced_at TEXT,
  last_synced_at  TEXT,
  gmt_create      TEXT,
  gmt_modified    TEXT,
  UNIQUE(store_id, posting_number)
);
CREATE INDEX IF NOT EXISTS idx_ozon_order_status ON ozon_order(status);
CREATE INDEX IF NOT EXISTS idx_ozon_order_shipment ON ozon_order(shipment_date);
```

#### `ozon_order_item` — Ozon订单产品行

```sql
CREATE TABLE IF NOT EXISTS ozon_order_item (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ozon_order_id   INTEGER NOT NULL REFERENCES ozon_order(id),
  sku             INTEGER,                      -- Ozon products[].sku (6010934464)
  offer_id        TEXT,                         -- ★ products[].offer_id (4823859913-0818-qx) 采购匹配键
  title           TEXT,
  quantity        INTEGER NOT NULL DEFAULT 1,
  price           REAL,                         -- 折后价(店铺币种)
  currency_code   TEXT,
  -- 采购金额回写（妙手 itemCostDetail 等价物）
  purchase_amount REAL DEFAULT 0,               -- 采购金额(均摊后)
  purchase_num    INTEGER DEFAULT 0,            -- 已采数量
  dimensions_json TEXT,
  raw_json        TEXT,
  UNIQUE(ozon_order_id, sku, offer_id)
);
CREATE INDEX IF NOT EXISTS idx_ooi_offer ON ozon_order_item(offer_id);
```

#### `package` — 包裹（发货操作单元，妙手 opOrderPackage 等价物）

```sql
CREATE TABLE IF NOT EXISTS package (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  package_no          TEXT NOT NULL UNIQUE,     -- MS20260829... 自生成: MS+yyMMddHHmmss+rand
  ozon_order_id       INTEGER NOT NULL REFERENCES ozon_order(id),
  store_id            TEXT NOT NULL,
  -- 三态状态机（见 §5）
  operate_status      TEXT NOT NULL DEFAULT 'wait_process',
  purchase_status     TEXT NOT NULL DEFAULT 'none',   -- none/partial/complete
  shipping_status     TEXT NOT NULL DEFAULT 'unshipped',
  -- 尾程物流
  logistics_no        TEXT,                     -- Ozon跟踪号(=posting_number)
  logistics_company   TEXT,
  logistics_method    TEXT,
  waybill_printed_at  TEXT,
  -- 头程（上家→集运仓）
  head_logistics_no   TEXT,
  head_logistics_company TEXT,                  -- 韵达/中通...
  head_shipped_at     TEXT,
  -- 采购聚合金额（冗余，加速列表）
  total_purchase_amount REAL DEFAULT 0,
  -- 时间
  last_delivery_at    TEXT,                     -- 最晚发货(冗余自ozon_order.shipment_date)
  shipped_at          TEXT,
  gmt_create          TEXT,
  gmt_modified        TEXT,
  note                TEXT,
  is_ignored          INTEGER DEFAULT 0         -- 搁置/取消
);
CREATE INDEX IF NOT EXISTS idx_pkg_operate ON package(operate_status);
CREATE INDEX IF NOT EXISTS idx_pkg_purchase ON package(purchase_status);
```

#### `purchase_order` — 采购订单（★核心表）

```sql
CREATE TABLE IF NOT EXISTS purchase_order (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_sn         TEXT,                     -- 上家采购单号(1688:5127660720062029909 / 拼多多:260829-...)
  platform            TEXT NOT NULL,            -- 1688 / pdd / taobao
  purchase_channel    TEXT DEFAULT 'manual',    -- manual(手工录入) / cart_1688(购物车) / miaoshou_like(代下单)
  -- 采购账号与上家
  buyer_account       TEXT,                     -- 清祥17
  seller_name         TEXT,                     -- 深圳市嘉龙盛电子有限公司
  seller_url          TEXT,                     -- 1688店铺/商品链接
  -- 收货地址(集运仓/货代)
  receive_address     TEXT,                     -- 福建 厦门 ... 菜鸟驿站
  forwarder_id        INTEGER,                  -- 货代(可空=不使用货代)
  -- 金额
  currency            TEXT DEFAULT 'CNY',
  payment_amount      REAL DEFAULT 0,           -- 实付(商品+运费)
  goods_amount        REAL DEFAULT 0,           -- 商品金额
  shipping_amount     REAL DEFAULT 0,           -- 采购运费(参与均摊)
  -- 状态(见 §5.3)
  status              TEXT NOT NULL DEFAULT 'wait_pay',
  pay_at              TEXT,
  send_at             TEXT,                     -- 上家发货时间
  signed_at           TEXT,
  -- 关联状态
  link_status         TEXT NOT NULL DEFAULT 'linked',  -- linked / unlinked(取消关联)
  auto_sync_amount    INTEGER DEFAULT 1,        -- 自动同步采购金额
  -- 头程物流
  logistics_company   TEXT,
  logistics_no        TEXT,                     -- 韵达435332472136948
  last_trace_at       TEXT,                     -- 最新轨迹时间(异常监控用)
  last_trace_desc     TEXT,
  -- 采购备注/留言
  buyer_message       TEXT,                     -- 给商家留言(合并采购)
  note                TEXT,
  gmt_create          TEXT,
  gmt_modified        TEXT,
  UNIQUE(platform, purchase_sn)
);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_order(status);
CREATE INDEX IF NOT EXISTS idx_po_link ON purchase_order(link_status);
CREATE INDEX IF NOT EXISTS idx_po_logistics ON purchase_order(logistics_no);
```

#### `purchase_order_link` — 采购单↔包裹关联（★多对多桥表）

```sql
CREATE TABLE IF NOT EXISTS purchase_order_link (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id   INTEGER NOT NULL REFERENCES purchase_order(id),
  package_id          INTEGER NOT NULL REFERENCES package(id),
  ozon_order_item_id  INTEGER REFERENCES ozon_order_item(id),  -- 可空:包裹级关联(未到行)
  -- 成本均摊结果（合并采购拆账落点）
  allocated_amount    REAL DEFAULT 0,           -- 均摊采购金额(含运费)
  allocated_shipping  REAL DEFAULT 0,
  quantity            INTEGER DEFAULT 0,
  gmt_create          TEXT,
  UNIQUE(purchase_order_id, package_id, ozon_order_item_id)
);
CREATE INDEX IF NOT EXISTS idx_pol_pkg ON purchase_order_link(package_id);
```

> 设计说明：妙手用 `relateOpOrderItemIds[]` 表达行级关联，本设计拆成独立桥表并增加 `allocated_amount` 均摊列，使「一张采购单服务多包裹」的拆账有明确落点；包裹级/行级关联通过 `ozon_order_item_id` 可空列兼容。

#### `supplier_product` — 货源映射（一键关联的落地）

```sql
CREATE TABLE IF NOT EXISTS supplier_product (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id            TEXT NOT NULL,
  offer_id            TEXT,                     -- Ozon offer_id（可空=按SKU）
  ozon_sku            INTEGER,
  platform            TEXT NOT NULL,            -- 1688/pdd/taobao
  source_url          TEXT NOT NULL,            -- https://detail.1688.com/offer/997687875219.html
  source_item_id      TEXT,                     -- 1688 offerId
  title               TEXT,
  spec_mapping        TEXT,                     -- {"Цвет товара:белый":"白色","...":"规格映射JSON"}
  price_range         TEXT,                     -- "0.5~0.5"
  recent_sales_30d    INTEGER,
  repurchase_rate     REAL,
  is_primary          INTEGER DEFAULT 1,        -- 主推货源(自动带出)
  enabled             INTEGER DEFAULT 1,
  gmt_create          TEXT,
  gmt_modified        TEXT,
  UNIQUE(store_id, COALESCE(offer_id,''), source_url)
);
```

#### `logistics_trace` — 头程物流轨迹

```sql
CREATE TABLE IF NOT EXISTS logistics_trace (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER REFERENCES purchase_order(id),
  logistics_no    TEXT NOT NULL,
  company         TEXT,
  trace_at        TEXT,                         -- 轨迹时间
  description     TEXT,                         -- 【金华市】浙江义乌凌云公司 已揽收
  raw_json        TEXT,
  gmt_create      TEXT,
  UNIQUE(logistics_no, trace_at, description)
);
```

#### 辅助表

```sql
-- 报关信息（编辑报关/合并申报）
CREATE TABLE IF NOT EXISTS customs_declaration (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ozon_order_item_id INTEGER NOT NULL REFERENCES ozon_order_item(id),
  en_name       TEXT, cn_name       TEXT,
  weight_g      REAL,
  dest_amount   REAL, origin_amount REAL,      -- 目的国/出口国申报金额
  hs_code       TEXT,                           -- 海关编码
  gmt_modified  TEXT
);

-- 订单同步游标（增量拉取水位）
CREATE TABLE IF NOT EXISTS sync_cursor (
  sync_type  TEXT PRIMARY KEY,                  -- unfulfilled / fbs_list / purchase
  store_id   TEXT NOT NULL,
  cursor_val TEXT,                              -- ISO时间戳或Ozon cursor
  last_run_at TEXT,
  last_count  INTEGER DEFAULT 0,
  last_error  TEXT
);
```

### 4.3 与妙手字段映射总表（复刻对照）

| 妙手字段                                 | 本设计落点                                                   | 来源                                                        |
| ------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------- |
| `platformOrderSn`                    | `ozon_order.posting_number`                             | Ozon `/v4/posting/fbs/*/list` `postings[].posting_number` |
| `platformOrderId`                    | `ozon_order.order_id`                                   | `postings[].order_id`                                     |
| `platformPackageStatus`              | `ozon_order.status`                                     | `postings[].status`                                       |
| `platformItemId`                     | `ozon_order_item.sku`                                   | `postings[].products[].sku`                               |
| `platformItemNum/platformOuterSkuId` | `ozon_order_item.offer_id`                              | `postings[].products[].offer_id`                          |
| `skuSubName`                         | 拼接                                                      | `products[].name` 规格段（或商品库规格回填）                           |
| `orderAmount/escrowAmount`           | `ozon_order.order_amount`                               | `financial_data`（with.financial\_data=true）               |
| `estimatedShippingFee`               | `delivery_price`                                        | `financial_data`/`delivery_price`                         |
| `gmtLastDelivery`（倒计时）               | `ozon_order.shipment_date`→冗余`package.last_delivery_at` | `postings[].shipment_date`                                |
| `appPackageNo`                       | `package.package_no`                                    | 自生成 MS+时间戳                                                |
| `logisticsNo`                        | `package.logistics_no`                                  | Ozon跟踪号（`tracking_number`）                                |
| `appPurchaseStatus 0/2`              | `package.purchase_status none/partial/complete`         | 由 link 表聚合计算                                              |
| `itemCostDetail.purchaseAmount`      | `ozon_order_item.purchase_amount`                       | 采购均摊回写                                                    |
| `purchaseOrderSn`                    | `purchase_order.purchase_sn`                            | 1688订单号（人工/购物车回填）                                         |
| `purchaseOrderPayment`               | `purchase_order.payment_amount`                         | 人工/自动同步                                                   |
| `headLogisticsNo`                    | `purchase_order.logistics_no`                           | 采购物流同步                                                    |
| `relateOpOrderItemIds`               | `purchase_order_link`                                   | 关联操作落库                                                    |
| `supplierGoodsSku`（一键关联）             | `supplier_product`                                      | 关联货源链接                                                    |
| 关联状态 已关联/已取消                         | `purchase_order.link_status`                            | 取消关联操作                                                    |

***

## 5. 状态机设计

### 5.1 包裹操作状态（页面Tab的分流依据）

```
                    ┌────────── 搁置 is_ignored=1 ──────────┐
                    ▼                                        │
Ozon同步 → [wait_process 待处理]                             │
   │  采购(可选) / 物流确认                                    │
   ▼                                                        │
[wait_ship 待打单发货] ── 打印面单 ──> [ship_success 交运平台] │
   │  ↑ 运单申请                 gmtPrintWaybill            │
   │  │                                                  交运
   ▼  │(打单后仍可回到待打单:不打单直接发货)                      ▼
[wait_ship] ──────────────────────> [wait_receiver_confirm 已发货]
                                        isShipped=1, gmtDelivery
        任意状态 ←── Ozon取消/本地取消 ── [cancelled 已取消]
```

**与Ozon状态联动**（同步任务驱动，见§6）：

| Ozon status                    | 包裹动作                                          |
| ------------------------------ | --------------------------------------------- |
| `awaiting_packaging`           | 新建包裹 → `wait_process`                         |
| `awaiting_deliver`             | `wait_process` → `wait_ship`（获得logisticsNo时机） |
| `delivering` / `driver_pickup` | → `wait_receiver_confirm`                     |
| `delivered`                    | 已发货完结（列表移出/历史订单）                              |
| `cancelled`                    | 包裹 `cancelled`，采购关联可人工保留观察                    |

### 5.2 采购状态（采购单独立状态机）

```
[wait_pay 待付款] --付款确认--> [wait_send 待发货] --上家发货--> [shipped 已发货]
                                    │ (部分SKU先发)  ┌→ [part_shipped 部分已发货]
                                    └────────────────┘
[shipped/part_shipped] --签收--> [signed 已签收] --订单完成/关闭--> [finished 已完成]
任意(未发货) --退款/取消--> [closed 已关闭]
```

妙手实测Tab：待付款/待发货/已发货/部分已发货/已签收/已完成/已关闭 —— 一一对应。

### 5.3 关键派生字段

* `package.purchase_status`：`SELECT count(link)>0` → partial/complete（对照订单行需采数量）

* 筛选标签「未配对SKU」：`ozon_order_item` 无 `supplier_product` 映射且无 link

* 「缺货/部分缺货」：采购中上家反馈库存不足（人工标记或1688库存接口）

* 「即将延迟发货」：`now + 24h > last_delivery_at` 且未发货

* 「已延迟发货」：`now > last_delivery_at` 且未发货

***

## 6. Ozon订单同步方案

### 6.1 API选型（对照 `docs/ozon-api/05-FBS订单与配送.md`）

| 用途             | 接口                                      | 说明                                                                                                        |
| -------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **主增量源：待处理订单** | `POST /v4/posting/fbs/unfulfilled/list` | 按 `cutoff_from/cutoff_to` 或 `delivering_date` 过滤，cursor翻页；覆盖 awaiting\_packaging→awaiting\_deliver 全部未妥投单 |
| 历史回补/状态校准      | `POST /v4/posting/fbs/list`             | `filter.since/to`（≤1年），可按 `order_numbers` 精确查                                                             |
| 单票详情补全         | `POST /v3/posting/fbs/get`              | 收件人电话、`related_postings`、`requirements` 报关要求                                                              |
| 状态推送（可选增强）     | webhook `new-posting` / `state-changed` | 已有 `ozon-webhook` 服务可复用（`ozon-webhook/src/handlers/`）                                                     |

> 注意：`/v3/posting/fbs/unfulfilled/list`、`/v3/posting/fbs/list` 将于 **2026-06-01 停用**，直接实现 v4。
> v4 相比 v3 的差异：`filter.statuses` 为数组、`delivery_method_ids/provider_ids/warehouse_ids` 为字符串数组、游标为 `cursor`（无offset）。

### 6.2 同步流程（定时任务，建议5分钟一次）

```
for store of 启用FBS同步的店铺:
  cursor = sync_cursor('unfulfilled', store)
  cutoff窗口 = [max(cursor, now-30d), now]
  resp = POST /v4/posting/fbs/unfulfilled/list
         { filter: { cutoff_from, cutoff_to },
           with: { analytics_data: true, financial_data: true, barcodes: true },
           limit: 100, cursor }
  for posting of resp.postings:
    upsert ozon_order (store_id, posting_number)      -- 状态/金额/shipment_date
    upsert ozon_order_item (sku+offer_id)             -- 数量/价格
    ensure package (一单一包，parent_posting_number拆分时多包)
    状态联动(§5.1)
  while resp.has_next: cursor=resp.cursor 继续拉取
  更新 sync_cursor
```

**字段抽取要点（2026-08-29 实测核实，详见附录C）**：

* **价格结构（v4与文档有差异）**：`products[].price` 是对象 `{amount:"35.22", currency:"CNY"}`（非v3文档的字符串）；`financial_data.products[].price` 是数字；`customer_price` 为 `{amount:"439", currency:"RUB"}` 对象（买家视角卢布价）

* **payout=0 陷阱**：未妥投订单 `financial_data.products[].payout` 恒为 0、`commission` 也为 0——真实结算数据事后才有。**预估结算/佣金必须自算**：`预估佣金 = price × 店铺配置佣金率(如16%)`，`预估结算 = price - 预估佣金`（与妙手"平台佣金 CNY 4.44 估"口径一致）

* **拆单实证**：`90292829-0048-1/-2/-3` 同属 `order_id=37892760605` —— 一张订单拆成3个posting，`posting_number` 末段 `-N` 即拆分序号。**一个 posting = 一个包裹**，直接验证了 §3 的 1:N 订单→包裹模型

* **buyer\_id 规律**：`customer.customer_id` = posting\_number 前缀（如 `0164557276-0053-1` → `164557276`），与妙手 `buyerId` 完全一致

* **时间语义**：`in_process_at` = 妙手"下单时间"（实测 `07:04:02Z` ↔ 妙手 `15:04:02` UTC+8 吻合）；`shipment_date` = cutoff发货倒计时；`delivering_date` = 交物流时间

* **fbs/list 的 since/to 按** **`in_process_at`** **过滤**（实测返回条目的 in\_process\_at 全部落在窗口内），适合按天下单增量

* **unfulfilled 含 delivering**：`/v4/posting/fbs/unfulfilled/list` 返回"未妥投"而非"未处理"——首个条目即 `status=delivering`（08-21下单仍在途）。要只取待处理需传 `filter.statuses: ["awaiting_packaging","awaiting_approve","awaiting_registration"]`

* **买家电话**：v4列表 `customer.phone` 恒为 `""`，真实电话需 `/v3/posting/fbs/get`（`addressee.phone`）

* **barcodes 为 null**：`with.barcodes=true` 时未打单货件仍返回 null（面单条码在打单后才生成），打单链路走 `/v2/posting/fbs/package-label`

* **products 额外字段**：`weight`(0.3)、`product_color`、`is_blr_traceable`、`is_marketplace_buyout`、`imei[]`

* 取消：`cancellation.cancel_reason/cancellation_type` → 展示并联动包裹取消

### 6.3 现有资产复用

* `erp-backend-lite/src/services/ozon-opi.js` — OPI client 基建（认证/重试/`ApiError{details:{kind:'connect_timeout'}}`），新增 posting 系列封装

* `ozon-webhook` — 已有 `order-new.js`/`order-state-changed.js`/`new-posting.js`/`state-changed.js` handler 骨架，可作为准实时触发（同步轮询兜底）

* `stores.json` 配置 — 多店铺凭据管理

***

## 7. 核心功能流程

### 7.1 采购发起（三条路径）

#### 路径A：代发采购（单包裹，主流程）

```
入口: 订单行 [代发采购]
1. 弹窗展示: 包裹号/产品规格/数量 + 已关联货源(supplier_product自动带出)
2. 货源选择:
   a. 已有映射 → 直接展示绑定链接
   b. 无映射 → 展示"1688同款推荐"(见下方货源推荐) → [一键关联]/[去采购]
3. 用户在1688完成下单(链接下单或购物车)
4. 回填采购单: 1688订单号 + 实付金额 + (可选)物流单号
   → 创建 purchase_order + purchase_order_link
   → 回写 ozon_order_item.purchase_amount
   → package.purchase_status = complete
```

**1688同款推荐（MVP实现）**：复用项目已有的 1688 能力（`MY/content/1688-image-search.js`、`alibaba-1688.js`、`cn-source-scraper.js`），以产品图或标题搜索1688同款，返回商品/价格区间/30天销量/复购率供选择。二期可缓存至 `supplier_product`。

#### 路径B：合并采购（批量，降运费）

```
入口: 勾选多订单 → [合并采购(1688)]
1. 聚合分组: 按 supplier_product.seller / 货源链接 → 供货商分组
   未匹配货源的产品 → "以下产品无法采购"区 + [一键移除]
2. 每组生成预览: 平台产品×数量 vs 1688采购产品
3. 用户跳转1688购物车统一下单(妙手采购方式之一)
4. 回填整张采购单(一个1688订单号)
5. ★成本均分算法:
   for link in 该采购单关联的所有 ozon_order_item:
     alloc = purchase.payment_amount * item.qty / total_qty   (按数量均摊)
     ozon_order_item.purchase_amount += alloc
   (妙手规则: "下单付款后，会将采购该产品的成本均分至多个平台订单中")
6. 限制校验: 供货商≤100、每供货商SKU≤50
```

#### 路径C：采购记录页手工补录

适合已人工在拼多多/淘宝下单的场景：`采购单号+平台+金额+关联包裹` 一步录入，立即建立 link 与金额回写。

#### 路径D：提交代打包（2026-08-29 实测补全，待处理tab行内操作）

**入口**：待处理tab行内 `[提交代打包]` 按钮（每个包裹一个）。

**弹窗结构**：

```
┌ 提交代打包 ─────────────────────────────────────────────┐
│ 推荐使用妙手1688采购下单功能...（营销位）                    │
│ 选择服务商: [不使用货代 ▾]  添加货代                        │
│ 录入方式: ○录入快递单号  ●录入采购信息（自动同步快递单号）     │
│ ┌ 订单产品 ──────────────────────────────────┐          │
│ │ [图] x1 产品名  产品规格: 产品颜色：白色        │          │
│ │ 采购金额(CNY): [9.9__]                      │          │
│ │ 快递单号: [SF1234567890123__]  物流公司: [顺丰速运__] │      │
│ │ [添加]  (一行产品填完可再加一行)              │          │
│ └────────────────────────────────────────────┘          │
│ ⚠ 由于您选择了不使用货代，包裹采购信息将不会推送给货代        │
│                              [取 消] [保存]              │
└────────────────────────────────────────────────────────┘
```

* **录入方式二选一**：`录入快递单号`（只填单号，无金额） / `录入采购信息`（金额+单号，自动同步轨迹）

* **校验**：只填金额不填单号 → 提示"此订单出货信息填写不完整，请完善出货信息后再保存"（快递单号必填）

* **无货代模式**：不推送货代（自发货流程）

**提交API链（实测捕获）**：

```
1. POST /api/order/purchase/getOpOrderPackAddedServiceList   (opOrderId) 弹窗打开时加载
2. POST /api/order/purchase/saveOpOrderPackAddedServiceList  (opOrderId) 保存附加服务
3. POST /api/order/purchase/manualRelateOrderPackagePurchaseOrders  ★核心
4. POST /api/order/package/checkPackagesIsAutoMoveWaitShip   (opOrderPackageIds) 检查是否自动流转
5. 列表刷新（searchOrderPackageList + 配套批量接口）
```

**核心请求体（form-urlencoded，`purchaseOrderInfoList`** **数组）**：

```jsonc
{
  "purchaseOrderInfoList": [{
    "opOrderPackageId": "1819535566",           // 包裹
    "forwarderId": "0",                          // 货代(0=不使用)
    "opOrderItemIdAndPurchaseOrderInfoMap": {    // ★ 按产品行录入
      "2212382575": {                            // opOrderItemId
        "purchaseOrderPackages": [{
          "purchaseOrderLogisticsName": "顺丰速运",   // 物流公司
          "purchaseOrderWaybillCode": "SF1234567890123" // 快递单号
        }],
        "forwarderId": "0",
        "forwarderInfo": { "purchaseUrl": "" },   // 货源链接(货代模式用)
        "appNote": "",
        "itemPurchaseAmount": "9.9",              // ★ 采购金额(CNY)
        "isAutoRsyncPurchasePayment": "0",        // 自动同步实付
        "forwarderNote": "",
        "isAlibbOfficialService": "0",
        "purchasePlatform": "other"               // ★ other=手工(非1688渠道)
      }
    }
  }]
}
```

**提交后效果（实测）**：

* `purchase_order` 创建（platform=other手工，状态视为已发货——因有快递单号）

* `package.head_logistics_no/company` 回填、`purchase_status=complete`

* `checkPackagesIsAutoMoveWaitShip` 判定后包裹可能自动从待处理 → 待打单发货（出货信息齐备即流转）

**复刻要点**：路径D本质是"采购单极简录入"——不要求上家采购单号，只需金额+国内快递单号即可完成关联与出货登记。适合淘宝/拼多多等无法自动同步的平台。与路径C互补：C补完整采购单号，D快速登记出货。

#### 路径D2：录入采购信息（1688单号自动补全，2026-08-29 实测补全链路）

"提交代打包"弹窗切换到 **录入采购信息（自动同步快递单号）** 模式（radio `platform`）后，表单变为：

```
采购金额(CNY): [___]        ← 可留空
自动同步采购金额: ●是 ○否
采购信息
下单平台: 1688 [登录]
采购单号:   [填1688订单号]  ← ★ 触发自动补全
采购账号:   [自动带出]
卖家账号:   [自动带出]
```

**实测补全链路**（填入 `5127660720062029909` 后点保存）：

1. 提交 `manualRelateOrderPackagePurchaseOrders`，body 中 `purchasePlatform: "1688"`、采购单号、`isAutoRsyncPurchasePayment=1`（金额留空）
2. **后端拿单号实时调1688开放接口**拉取订单详情并落库，自动补全字段：

| 补全字段                       | 实测值                                                         | 说明            |
| -------------------------- | ----------------------------------------------------------- | ------------- |
| `purchaseOrderPayment`     | 12.80                                                       | 1688实付金额      |
| `purchaseOrderBuyer`       | 清祥17                                                        | 采购账号（1688登录态） |
| `purchaseOrderSeller`      | 深圳市嘉龙盛电子有限公司                                                | 上家            |
| `purchaseOrderStatus`      | wait\_send                                                  | 1688订单状态      |
| `purchaseOrderStartTime`   | 2026-08-29 12:56:45                                         | 1688下单时间      |
| `purchaseOrderFullAddress` | 福建 厦门 …菜鸟驿站                                                 | 1688收货地址      |
| `purchaseOrderDetailUrl`   | trade.1688.com/order/new\_step\_order\_detail.htm?orderId=… | 订单直链          |
| `sourceItemId`             | 1007720689392                                               | ★1688商品ID     |
| `sourceSkuId`              | 6169636091410                                               | ★1688 SKU ID  |
| `sourceTitle`              | 迷你版20W30W…数字功放板 502L                                        | 1688商品标题      |
| `sourceSkuSubName`         | 单功放板                                                        | 1688规格名       |
| `sourceUnitPrice`          | 13.80                                                       | 1688单价        |
| `sourcePicUrl`             | cbu01.alicdn.com/…                                          | 1688商品图       |
| `gmtLastRsync`             | 2026-08-29 18:12:00                                         | 同步时间戳         |

1. 保存后包裹 `appPurchaseStatus=2`、产品行 `itemCostDetail.purchaseAmount` 自动回写
2. 弹窗填单号时"产品实付"框自动变为 `0.00` 占位（表示金额由系统同步而非手填）

**关键发现**：

* **一单多关联**：同一1688采购单可被关联到多个包裹——实测 `5127660720062029909` 同时关联 YQL006蓝牙音箱订单 `22612735-0197-1`（原）与 YQL003砂轮订单 `0204256053-0026-1`（新提交），关联状态均为 `relateStatus: "normal"`。这是**复用已有采购单**的场景：上家一个包裹发多个订单或采购多件分发的场景

* **双渠道双记录**：同一1688单号在采购记录中存在两条记录——`platform: "1688"`（手工关联，purchaseOrderFilterId=21793890）与 `platform: "ali1688"`（渠道名"1688妙手"，自动同步，purchaseOrderFilterId=21824473）。印证采购记录页"1688"与"1688妙手"两个tab的来源

* `sourceItemId`（1688商品ID）正是 §4.2 `supplier_product.source_item_id` 的数据来源——采购补全顺手完成了货源映射积累

* 采购账号/卖家账号输入框是**可编辑的筛选字段**（留空=自动带出全部），非必填

**复刻要点**：1688侧需一个"按订单号查订单详情"的能力（1688开放平台 `alibaba.trade.get.buyerView` 或浏览器采集），补全落库动作在保存事务内完成：先 upsert purchase\_order（拉1688详情），再建 link，再回写金额。

### 7.2 采购单与订单关联（关联管理）

```
关联建立: 创建link → 状态=linked → 金额回写 → 利润重算
关联取消: [取消关联] → link_status=unlinked → 冲回 ozon_order_item.purchase_amount
          (全局搜索仍可见, 筛选"已取消关联")
重新关联: unlinked单可重新绑定到其他包裹(换供应商重采场景)
```

**利润计算**（对照妙手列表金额列）：

```
预估利润 = escrowAmount(预估结算) - purchase_amount(采购) - head_shipping(头程估) 
           - tail_shipping_fee(尾程=estimatedShippingFee) - commission(平台佣金估)
成本利润率 = 预估利润 / (采购+运费成本)
销售利润率 = 预估利润 / orderAmount
```

### 7.3 发货执行链路（简版，完整版二期）

```
待处理 → 确认采购到货(头程轨迹显示已揽收/签收集运仓)
       → [申请运单号] Ozon跟踪号即posting_number(跨境线上物流,无需额外申请, 
          妙手"申请"实为拉取条码/面单)
       → [打印面单] /v2/posting/fbs/package-label (PDF, 20单/批)
       → 打单完成 → 交货物流 → Ozon status=delivering → 已发货tab
```

***

## 8. 采购物流同步与异常监控

### 8.1 头程物流同步（`同步上家物流`）

```
数据源优先级:
1. 1688: 订单详情接口返回物流单号+公司 (代下单渠道可自动)
2. 快递100/快递鸟通用查询 API (国内快递轨迹, 拼多多/淘宝单)
3. 人工粘贴轨迹(兜底)

同步节奏: 每30分钟轮询 status=wait_send/shipped 的采购单
写入 logistics_trace, 更新 purchase_order.last_trace_at/desc
回填 package.head_logistics_no
```

> 妙手实测提示：拼多多采购单轨迹需单独订购轨迹服务（"物流轨迹无法获取，非1688平台采购单"），复刻时轨迹API选型需按平台覆盖度评估，MVP可先只做1688+人工。

### 8.2 异常监控规则（定时扫描，每30分钟）

| 规则     | 判定                                                       | 动作                          |
| ------ | -------------------------------------------------------- | --------------------------- |
| 上家未发货  | `purchase: now - gmt_create > 24h && status = wait_send` | 提醒催发（`催1688商家发货`=1688消息API） |
| 发货无揽收  | `send_at有值 && 24h内无 logistics_trace`                     | 标记轨迹异常                      |
| 轨迹停滞   | `now - last_trace_at > 24h && 未签收`                       | 标记停滞                        |
| 即将延迟发货 | `now+24h > package.last_delivery_at && 未打单`              | 订单列表红色预警                    |
| 已延迟发货  | `now > last_delivery_at && 未发货`                          | 高优先级预警（Ozon罚款风险）            |
| 采购单缺关联 | `purchase.link_status=unlinked 或 无link`                  | 待处理列表"未配对SKU"计数             |

### 8.3 通知

复用 `ozon-webhook` 的 `feishu-notify.js` 模式：异常聚合日报 + 高优（延迟发货）即时通知。

***

## 9. 页面功能清单

复刻为 `erp-backend-lite/web`（Vue3+Vite）两个新视图，路由 `/order-process` 与 `/purchase-records`。

### 9.1 订单处理页（`OrderProcess.vue`）

| 区块    | 功能点                                                     | 优先级 |
| ----- | ------------------------------------------------------- | --- |
| Tab页签 | 待处理/待打单发货/交运平台/已发货/已搁置 + 实时计数                           | P0  |
| 快捷筛选  | 未采购/已采购、未配对SKU、即将延迟/已延迟、有买家留言                           | P0  |
| 搜索    | 全局模糊（包裹号/订单号/采购单号/物流单号）+ 订单号/平台SKU批量精确                  | P0  |
| 列表    | 产品(图/标题/规格/单价/平台SKU)·金额组(订单/实付/结算/采购/利润)·收件人·包裹物流·时间倒计时 | P0  |
| 行操作   | 代发采购、详情、移入待打单、取消关联                                      | P0  |
| 行操作   | 提交代打包、打印面单、搁置、取消订单                                      | P1  |
| 批量    | 合并采购(1688)、同步上家物流、导出                                    | P1  |
| 详情弹窗  | 产品行+采购关联+报关信息+操作日志                                      | P0  |
| 详情弹窗  | 报关编辑、买家地址、物流方式对比                                        | P2  |

### 9.2 采购记录页（`PurchaseRecords.vue`）

| 区块   | 功能点                                   | 优先级 |
| ---- | ------------------------------------- | --- |
| Tab  | 全部/待付款/待发货/已发货/部分已发货/已签收/已完成/已关闭 + 计数 | P0  |
| 搜索   | 采购单号/平台/时间/店铺/关联状态/上家名称               | P0  |
| 列表   | 采购信息·金额·时间·关联平台订单·关联订单产品(双列布局)        | P0  |
| 物流   | 头程轨迹卡片(最新轨迹+查看完整)                     | P1  |
| 批量   | 批量付款标记、催发、导出、同步上家物流                   | P1  |
| 异常面板 | 三类异常计数+点击过滤                           | P1  |
| 操作   | 取消关联/重新关联、手工补录采购单                     | P0  |

### 9.3 API设计（`erp-backend-lite/src/modules/order-process.js` + `purchase.js`）

```
POST /api/order-process/list            -- 包裹列表(tab+筛选+分页, 聚合采购状态)
GET  /api/order-process/:id/detail      -- 详情(产品行+links+报关+轨迹)
POST /api/order-sync/run                -- 手动触发Ozon同步
POST /api/purchase/create               -- 创建采购单(路径A/C: 单号+金额+关联包裹ids)
POST /api/purchase/merge-preview        -- 合并采购预览(供货商分组+均摊模拟)
POST /api/purchase/:id/unlink|relink    -- 取消/重新关联
POST /api/purchase/:id/status           -- 状态推进(付款/发货/签收)
POST /api/purchase/logistics-sync       -- 同步上家物流
GET  /api/purchase/list                 -- 采购记录列表
GET  /api/purchase/abnormal-count       -- 异常计数
```

均遵循现有 `x-api-key` 认证 + `response.js` 统一响应 + audit中间件规范。

***

## 10. 与现有系统集成

| 现有资产                            | 复用方式                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `erp-backend-lite` SQLite/DAO分层 | 新表挂入 `db/schema.sql`，DAO放 `db/dao/sqlite/`（遵循显式 BEGIN/COMMIT、`?`占位符约束）                                        |
| `services/ozon-opi.js`          | 扩展 `postingFbsUnfulfilledList()` / `postingFbsList()` / `postingFbsGet()` / `postingFbsPackageLabel()`，复用超时重试 |
| `web` Vue框架                     | AppTabs/AppModal/AppPager/AppToast 组件直接复用，新增两个views+router                                                    |
| `ozon-webhook`                  | `order-new`/`state-changed` handler 落库事件 → 触发即时同步（保留轮询兜底）                                                     |
| `qxqx/.env` 采集脚本模式              | 1688购物车/订单同步脚本同款环境（ERP\_BASE\_URL/ERP\_API\_KEY）                                                              |
| MongoDB（如有历史选型）                 | 仅轨迹/原始JSON归档可选；主关联数据用SQLite保证事务                                                                               |

***

## 11. 实施分期建议

### Phase 1 — 数据底座 + 只读链路（可验证核心价值）

1. 建表（§4.2 六张核心表）
2. Ozon订单同步任务（`/v4/posting/fbs/unfulfilled/list` 增量）
3. 订单处理页只读版：Tab+列表+详情+倒计时
4. 手工补录采购单（路径C）+ link + 金额回写 + 利润列

**验收**：订单自动同步、手工补录1688单号后列表正确展示采购金额与预估利润。

### Phase 2 — 采购工作流

1. 代发采购弹窗 + 货源映射（supplier\_product 一键关联）
2. 合并采购预览 + 成本均分
3. 采购记录页完整版（Tab/搜索/关联状态/取消关联）
4. 头程物流同步（1688优先）+ 三类异常监控 + 飞书通知

**验收**：合并采购3张订单→1张1688单，成本均分正确；轨迹停滞24h触发通知。

### Phase 3 — 发货执行与体验完善

1. 打印面单（`/v2/posting/fbs/package-label`）
2. 报关信息维护 + Ozon requirements 提示（`products_requiring_country/gtd`）
3. 1688同款推荐（复用图搜能力）、批量付款、催发
4. 历史订单归档、导出Excel（复用 `export-excel.js`）

***

## 附录A：Ozon订单状态 → 页面语义对照

| Ozon status                       | 中文（页面展示） | 包裹归属Tab    |
| --------------------------------- | -------- | ---------- |
| awaiting\_registration            | 等待登记     | 待处理        |
| awaiting\_approve                 | 等待确认     | 待处理        |
| awaiting\_packaging               | 等待包装     | 待处理        |
| awaiting\_deliver                 | 等待发运     | 待打单发货→交运平台 |
| delivering                        | 运输中      | 已发货        |
| driver\_pickup                    | 司机派送中    | 已发货        |
| delivered                         | 已送达      | 已发货(终态)    |
| cancelled                         | 已取消      | 已搁置/取消     |
| arbitration / client\_arbitration | 仲裁       | 平台售后       |
| not\_accepted                     | 分拣中心未接受  | 异常         |

## 附录B：实测样本（调试用）

* Ozon订单 `22612735-0197-1`（店铺YQL006）↔ 包裹 `MS20260829121626015` ↔ 1688采购单 `5127660720062029909`（上家：深圳市嘉龙盛电子，实付12.80，SKU 4823859913-0818-qx）

* 多对一样本：1688单 `5127395654065010728`（锯片×3）同时关联包裹 `MS20260829021743112`（×1）与 `MS20260829021743131`（×2）→ 验证成本均分

* 拼多多采购单格式：`260829-516906094883751`（账号PCC01）

## 附录C：Ozon v4接口实测结构核对（2026-08-29）

> 凭证：`ozon-webhook/src/config/stores.json`（YQL04 clientId=4173939、YQL06 clientId=4174037）
> 请求体与响应均为原始实测，与 `05-FBS订单与配送.md` 文档逐字段核对。

### C.1 请求样本

```jsonc
// /v4/posting/fbs/unfulfilled/list（cutoff过滤，注意返回的是"未妥投"全集）
{ "filter": { "cutoff_from": "2026-08-26T00:00:00Z", "cutoff_to": "2026-09-10T00:00:00Z" },
  "limit": 5, "with": { "analytics_data": true, "financial_data": true, "barcodes": true } }
// 响应: HTTP 200, { result: { count: 21, has_next: true, cursor: "eyJ...", postings: [...] } }

// /v4/posting/fbs/list（since/to 按 in_process_at 过滤 = 下单时间窗口）
{ "dir": "DESC", "filter": { "since": "2026-08-26T00:00:00Z", "to": "2026-08-30T00:00:00Z" },
  "limit": 5, "with": { ... } }
// 响应: { result: { has_next: true, cursor: "eyJ...", postings: [...] } }  ← 无count
```

### C.2 posting完整字段清单（实测46键，两接口结构一致）

```
posting_number, order_id, order_number, pickup_code_verified_at, status, substatus,
delivery_method, delivery_schema("fbs"), tracking_number, tpl_integration_type("aggregator"),
in_process_at, shipment_date, shipment_date_without_delay, optional, cancellation, customer,
products, addressee, barcodes, analytics_data, destination_place_id, destination_place_name,
financial_data, is_express, legal_info, quantum_id, require_blr_traceable_attrs, requirements,
tariffication, external_order{is_external,platform_name}, volume_weight, is_click_and_collect,
delivering_date, is_multibox, multi_box_qty, is_presortable, prr_option, parent_posting_number,
available_actions, tariffication_steps, container_sort_type, container, integration_type_flow,
sorting_center, received_at_sorting_center
```

文档未记载、实测新增的关键字段：`delivery_schema`、`external_order`、`volume_weight`、`is_multibox`/`multi_box_qty`（多箱包裹）、`is_click_and_collect`、`sorting_center`、`integration_type_flow`、`quantum_id`、`require_blr_traceable_attrs`、`pickup_code_verified_at`

### C.3 实测样本（YQL06，0164557276-0053-1）

```jsonc
{
  "posting_number": "0164557276-0053-1",
  "order_id": 38418224572,
  "order_number": "0164557276-0053",
  "status": "delivering", "substatus": "posting_on_way_to_city",
  "delivery_method": { "id": 34052153, "name": "ABT Economy Extra Small Xiamen 03 PUDO",
    "warehouse_id": 1020005008464080, "warehouse": "厦门006",       // =stores.json warehouse_id ✓
    "tpl_provider_id": 1065, "tpl_provider": "ABT Economy Extra Small" },
  "tracking_number": "0164557276-0053-1",                            // =posting_number
  "tpl_integration_type": "aggregator", "delivery_schema": "fbs",
  "in_process_at": "2026-08-21T07:42:19Z",                           // 下单时间
  "shipment_date": "2026-08-26T09:00:00Z",                           // cutoff
  "delivering_date": "2026-08-24T08:01:10Z",                         // 交物流时间
  "customer": { "customer_id": 164557276, "name": "Юнона Бучнева", "phone": "",
    "address": { "address_tail": "Москва, Россия", "city": "Москва", "country": "Россия",
      "region": "", "district": "", "zip_code": "", "pvz_code": 0 } },
  "products": [{
    "offer_id": "4456106117-0814-qx",        // ★ 妙手platformItemNum同源
    "sku": 5462125811,                        // ★ 妙手platformItemId同源
    "quantity": 1, "weight": 0.3, "product_color": "черный",
    "price": { "amount": "35.22", "currency": "CNY" },   // ★ 对象而非字符串
    "name": "Горшок для цветов большой объем 25 см..."
  }],
  "analytics_data": { "warehouse": "厦门006", "city": "Москва", "delivery_type": "PVZ",
    "payment_type_group_name": "Кредитная карта", "is_premium": false,
    "delivery_date_begin": "2026-09-07T14:01:00Z", "delivery_date_end": "2026-09-18T14:01:00Z" },
  "financial_data": {
    "cluster_from": "Китай", "cluster_to": "Москва, МО и Дальние регионы",
    "products": [{ "product_id": 5462125811, "price": 35.22, "old_price": 35.22,
      "payout": 0,                                  // ★ 未妥投恒为0
      "customer_price": { "amount": "439", "currency": "RUB" },
      "commission": { "amount": 0, "percent": 0, "currency": "RUB" },  // ★ 同样为0
      "quantity": 1, "actions": ["Системная виртуальная скидка селлера Россия (CNY)", ...] }]
  },
  "barcodes": null,                       // with.barcodes=true仍为null（打单后生成）
  "requirements": { "products_requiring_gtd": [], "products_requiring_country": [], ... },
  "cancellation": { "cancel_reason_id": 0, "cancel_reason": "", "cancellation_type": "" },
  "is_multibox": false, "multi_box_qty": 1, "volume_weight": 0.3,
  "available_actions": ["click_track_number"],
  "received_at_sorting_center": "1970-01-01T00:00:00Z"   // 占位值
}
```

### C.4 与妙手字段核对结论（闭环验证）

| 妙手字段                                      | Ozon实测字段                                                  | 核对结果           |
| ----------------------------------------- | --------------------------------------------------------- | -------------- |
| `platformOrderSn` 0173332501-1424-1       | `posting_number`（YQL04 fbs/list近3天命中同单）                   | ✅              |
| 下单时间 2026-08-29 15:04:02                  | `in_process_at` 2026-08-29T07:04:02Z                      | ✅ UTC+8换算吻合    |
| `platformPackageStatus` awaiting\_deliver | `status` awaiting\_deliver                                | ✅              |
| `logisticsNo` = 订单号                       | `tracking_number` = posting\_number                       | ✅              |
| `buyerId` 78345175                        | `customer.customer_id`（=posting\_number前缀）                | ✅              |
| `platformItemId` 6010934464               | `products[].sku`                                          | ✅              |
| `platformItemNum` 4823859913-0818-qx      | `products[].offer_id`                                     | ✅              |
| 仓库 厦门006/厦门004                            | `delivery_method.warehouse` + warehouse\_id与stores.json一致 | ✅              |
| 预估结算 27.75-4.44佣金估                        | `payout/commission` API均为0 → 需自算（price×佣金率）               | ⚠️ 口径差异已记入§6.2 |

**拆单实证**：YQL04 返回 `90292829-0048-1 / -0048-2 / -0048-3` 三个posting同属 `order_id=37892760605`——一单拆三包裹，`posting_number` 尾段`-N`即拆分序号，`parent_posting_number` 为空串。同步任务必须以 `posting_number`（而非order\_id）为主键upsert。

**父子拆单实证（YQL06，2026-08-29深查）**：订单 `0105259411-0854`（order\_id=38844960403，买家Владимир Варивода，下单2026-08-25）下仅有两个货件 `-0854-2` 与 `-0854-3`，**无 -1**（推测原始 -1 拆分后被重编号为 -2）：

| 字段                      | -0854-2（母件）                                                    | -0854-3（子件）                   |
| ----------------------- | -------------------------------------------------------------- | ----------------------------- |
| `parent_posting_number` | `""`（空）                                                        | `"0105259411-0854-2"` ★指向母件   |
| `related_postings`      | `["0105259411-0854-3"]`                                        | `["0105259411-0854-2"]`（双向互引） |
| products                | SKU 5311201790 ×1（E27灯头座，offer\_id 4233380115-0802-qx，单价18.55） | **完全相同** SKU×1                |
| 时间线                     | in\_process/shipment/delivering 三时间完全一致                        | 同左                            |
| tracking\_number        | =自身posting\_number（独立包裹独立跟踪）                                   | 同左                            |

要点：

* 买家下单同一SKU数量2，拆成 1+1 两个包裹分别发货（对应 `/v4/posting/fbs/ship` 传2个packages的场景）

* **`parent_posting_number`** **构成母子树**：母件为空、子件指向母件；`related_postings` 提供兄弟互引——同步时二者都应落库，用于"同订单拆包裹"聚合展示

* **采购数量核算必须跨包裹求和**：该订单需采数量 = 两个posting的quantity之和(2)，不能只看单包裹——否则采购下单会少买

* 查询全量货件：`/v4/posting/fbs/list` 传 `filter.order_numbers:["0105259411-0854"]` 可按订单号反查所有包裹

