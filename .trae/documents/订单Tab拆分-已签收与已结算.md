# 订单 Tab 拆分:已完成 → 已签收 + 已结算

## Context

订单管理页面(OrderProcess.vue)当前只有一个"已完成"Tab,定义为"已妥投(delivered_at 有值)"。但实际业务中,已妥投的订单财务数据未必完整:Ozon 应计项目分批返回,首次可能只返回 SaleCommission,代理佣金(type_id=66)和国际配送费(type_id=67)可能滞后才生成。

为便于区分财务结算进度,把"已完成"Tab 拆成两个:

- **已签收**:已妥投 且 (应计缺代理佣金 66 OR 缺国际配送费 67)
- **已结算**:已妥投 且 (应计同时有 66 AND 67)

二者互斥且并集覆盖全部已妥投订单,无遗漏。

## 改动文件清单

### 1. 后端 `src/db/dao/sqlite/order-daos.js`

**a) `tabCounts()` (L285-315)** — 把 `completed` 桶拆成 `signed`/`settled` 两个桶:

```sql
CASE
  WHEN operate_status = 'wait_receiver_confirm' AND delivered_at IS NOT NULL
       AND id IN (SELECT package_id FROM op_accrual WHERE type_id = 66)
       AND id IN (SELECT package_id FROM op_accrual WHERE type_id = 67) THEN 'settled'
  WHEN operate_status = 'wait_receiver_confirm' AND delivered_at IS NOT NULL THEN 'signed'
  WHEN operate_status = 'wait_receiver_confirm' AND delivered_at IS NULL THEN 'wait_receiver_confirm'
  ELSE operate_status
END AS bucket
```

返回 map 新增 `signed`/`settled`,移除 `completed`;`all` 求和式同步替换。

**b) `TAB_STATUS` (L317-326)** — 移除 `completed` 键,新增:

```js
signed: ['wait_receiver_confirm'],   // 列表查询时再叠加 delivered_at IS NOT NULL + 应计缺 66/67
settled: ['wait_receiver_confirm'], // 列表查询时再叠加 delivered_at IS NOT NULL + 应计有 66 AND 67
```

**c) `listPackages()` (L368-387)** — 移除 `tab === 'completed'` 分支,新增两个分支:

```js
} else if (tab === 'signed') {
  // 已签收=已妥投但应计不完整(缺代理佣金66或国际配送67)
  where.push('p.is_ignored = 0');
  where.push("p.operate_status = 'wait_receiver_confirm' AND p.delivered_at IS NOT NULL");
  where.push(`NOT (
    EXISTS (SELECT 1 FROM op_accrual a WHERE a.package_id = p.id AND a.type_id = 66)
    AND EXISTS (SELECT 1 FROM op_accrual a WHERE a.package_id = p.id AND a.type_id = 67)
  )`);
} else if (tab === 'settled') {
  // 已结算=已妥投且应计完整(同时有66和67)
  where.push('p.is_ignored = 0');
  where.push("p.operate_status = 'wait_receiver_confirm' AND p.delivered_at IS NOT NULL");
  where.push(`EXISTS (SELECT 1 FROM op_accrual a WHERE a.package_id = p.id AND a.type_id = 66)
    AND EXISTS (SELECT 1 FROM op_accrual a WHERE a.package_id = p.id AND a.type_id = 67)`);
}
```

注释同步更新(L282、L322)。

### 2. 前端 `web/src/views/OrderProcess.vue`

**TABS 数组 (L35)** — 替换 `completed` 一行为两行:

```js
{ key: 'signed', label: '已签收' },
{ key: 'settled', label: '已结算' },
```

`activeTab` 默认值保持 `waitProcess` 不变;`switchTab`/`loadList` 无需改动,后端已支持新 tab。

## 不需要改动

- **MiaoshouOrders.vue**:使用妙手平台自身的 `appPackageTab='finished'`,与本地 ERP 的 `completed` 无关。
- **schema.sql / 迁移**:`op_accrual` 表已有 `idx_op_acc_pkg(package_id)` 索引,EXISTS 子查询可命中索引,无需新增。
- **路由 / 默认 tab**:默认仍 `waitProcess`,无路由 query 引用 `completed`。
- **其他模块**:grep 确认所有 `completed` 字符串仅在 order-daos.js(L282/290/304/311/322/374)和 OrderProcess.vue(L35)三处与订单 Tab 相关,其余命中均为 `completed_at`(其他业务表),无关。

## SQL 性能

- `tabCounts()` 单条 GROUP BY 查询带两个 `IN (subquery)` 谓词,SQLite 会走 `idx_op_acc_pkg` 索引扫描,量级与原 `completed` 计数同级。
- `listPackages()` 用 `EXISTS` 而非 `JOIN`,避免对一包裹多应计行产生重复行影响分页;主表仍走 `op_package` 的 `idx_op_operate_status` 过滤。
- 已妥投订单量在万级以内,无性能风险。

## 验证

1. **后端重启**:`pm2 restart erp`。
2. **前端构建**:`cd erp-backend-lite/web && npm run build`(产物输出到 `src/public/`)。
3. **浏览器验证**:刷新 `?ts=Date.now()` 强制加载新构建。
4. **Tab 计数**:打开订单处理页,看到"已签收"和"已结算"两个 Tab,数字之和等于原"已完成"Tab 数字。
5. **列表内容**:点"已结算"Tab,任意行点详情弹窗,应计明细里应同时存在 type 66 和 67 行;"已签收"Tab 里至少缺其一。
6. **回归**:切换其他 Tab(待处理/已发货/已取消)计数和列表正常,全局搜索正常。
7. **应计同步**:对"已签收"Tab 中缺 66/67 的订单,手动触发 `POST /admin/api/order-process/accrual-sync {mode:'packages', packageIds:[...]}` 重拉应计,刷新后该订单应跳到"已结算"Tab。
