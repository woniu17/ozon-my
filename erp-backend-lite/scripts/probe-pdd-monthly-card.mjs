// 拼多多订单月卡券普查 v2(2026-09-28,服务器上跑,用服务器 .linqx-profile + 生产库)
// 用法: node scripts/probe-pdd-monthly-card.mjs
// 架构:browser-manager withPage 有 60s 任务超时 → 分批调用(浏览器空闲期内复用,无重启开销)
//  1) order_list_v4 翻页拉全部订单(每批 withPage 内 20 页);dump 首单完整字段
//  2) 与生产库 op_purchase_order(purchase_sn) 取交集,筛"数据库采购单 且 有优惠券"
//  3) 对有券采购单逐单开 order.html 详情页查月卡券(每批 withPage 内 12 单);
//     列表未覆盖到的库单也直接查详情页(保证库内每单都有月卡券结论)
//  结果逐行 append 到 /tmp/pdd-monthly-card-results.jsonl(可断点查看)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { withPage } from '../src/services/platform-orders/browser-manager.js';
import { fetchPddOrderDetail } from '../src/services/platform-orders/adapters/pdd.js';

const PDD_ENTRY = 'https://mobile.yangkeduo.com/';
const PDD_ORIGIN = 'https://mobile.yangkeduo.com';
const PDD_API = 'https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4';
const ACCOUNT = 'linqx';
const DB_PATH = new URL('../data/erp.db', import.meta.url).pathname;
const OUT_JSONL = '/tmp/pdd-monthly-card-results.jsonl';
const MAX_PAGES = 60;      // 翻页上限 60 页(3000 单)
const PAGES_PER_BATCH = 20; // 每批 withPage 翻 20 页(~20s)
const DETAIL_PER_BATCH = 12; // 每批 withPage 查 12 个详情页(~45s)

const toYuan = (fen) => (Number(fen || 0) / 100).toFixed(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 0) 生产库采购单主集 ────────────────────────────────
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const poRows = db.prepare(
  "SELECT purchase_sn, payment_amount FROM op_purchase_order WHERE platform='yangkeduo' AND purchase_sn IS NOT NULL"
).all();
db.close();
const poMap = new Map(poRows.map((r) => [r.purchase_sn, r.payment_amount]));
console.log(`生产库 PDD 采购单: ${poMap.size} 个`);

// ── 1) 分批翻页拉列表 ─────────────────────────────────
const listAll = [];
const listSnSet = new Set();
let offset = '';       // 翻页游标(跨批传递)
let listDone = false;  // 翻完标志
let firstOrderKeys = '';

for (let batchStart = 1; batchStart <= MAX_PAGES && !listDone; batchStart += PAGES_PER_BATCH) {
  await withPage(ACCOUNT, 'pdd', PDD_ENTRY, PDD_ORIGIN, async (page) => {
    for (let p = batchStart; p < batchStart + PAGES_PER_BATCH && p <= MAX_PAGES && !listDone; p++) {
      const r = await page.evaluate(async (arg) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25 * 1000);
        try {
          const resp = await fetch(arg.url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(arg.body),
            signal: ctrl.signal,
          });
          let json = null;
          try { json = await resp.json(); } catch { /* 非 JSON */ }
          return { status: resp.status, json };
        } catch (e) {
          return { error: String((e && e.message) || e) };
        } finally { clearTimeout(timer); }
      }, {
        url: PDD_API,
        body: {
          type: 'all', page: p, size: 50, offset,
          origin_host_name: 'mobile.yangkeduo.com',
          scene: 'order_list_h5', page_from: 0, front_env: 1,
          pay_front_supports: [],
        },
      });
      if (r.error || !r.json || r.status !== 200) {
        console.log(`第${p}页异常: ${r.error || 'HTTP ' + r.status},停止翻页`);
        listDone = true;
        return;
      }
      const orders = Array.isArray(r.json.orders) ? r.json.orders : [];
      if (p === 1 && orders[0]) {
        firstOrderKeys = Object.keys(orders[0]).join(',');
        console.log('首单字段:', firstOrderKeys);
      }
      for (const o of orders) {
        const sn = o.order_sn || '';
        if (!sn || listSnSet.has(sn)) continue;
        listSnSet.add(sn);
        listAll.push({
          sn,
          paidFen: o.order_amount || 0,
          discountFen: o.discount_amount || 0,
          used: !!o.used_coupons,
          status: o.order_status_prompt || '',
          orderTime: o.order_time || 0,
        });
      }
      console.log(`第${p}页 ${orders.length} 单,累计 ${listAll.length}`);
      if (typeof r.json.offset === 'string' && r.json.offset) offset = r.json.offset;
      if (orders.length < 50) { listDone = true; return; }
      await sleep(600); // 翻页限速
    }
  }).catch((e) => { console.error('翻页批次失败:', e.message); process.exit(1); });
}
if (!firstOrderKeys) firstOrderKeys = '(未获取)';
// 列表覆盖的时间范围
const times = listAll.map((o) => o.orderTime).filter(Boolean).sort((a, b) => a - b);
if (times.length) {
  console.log(`列表覆盖下单时间: ${new Date(times[0] * 1000).toISOString().slice(0, 10)} ~ ${new Date(times[times.length - 1] * 1000).toISOString().slice(0, 10)}(${listDone ? '已到尾页' : '达翻页上限'})`);
}

// ── 2) 交集:数据库采购单 ∩ 列表;筛有券 ────────────────
const couponInPo = listAll.filter((o) => poMap.has(o.sn) && (o.used || o.discountFen > 0));
const poNotInList = [...poMap.keys()].filter((sn) => !listSnSet.has(sn));
console.log(`\n列表共 ${listAll.length} 单;命中数据库采购单 ${[...poMap.keys()].filter(sn => listSnSet.has(sn)).length}/${poMap.size}`);
console.log(`数据库采购单中有优惠券: ${couponInPo.length} 单`);
console.log(`列表未覆盖的库单(直接查详情页): ${poNotInList.length} 单\n`);

// ── 3) 分批详情页查月卡券 ──────────────────────────────
fs.writeFileSync(OUT_JSONL, '');
const targets = [
  ...couponInPo.map((o) => ({ ...o, source: '列表有券' })),
  ...poNotInList.map((sn) => ({ sn, paidFen: 0, discountFen: 0, used: false, status: '', orderTime: 0, source: '库单未覆盖列表' })),
];
const monthlyCard = [];
const otherCoupon = [];
const noDetail = [];

for (let i = 0; i < targets.length; i += DETAIL_PER_BATCH) {
  const batch = targets.slice(i, i + DETAIL_PER_BATCH);
  await withPage(ACCOUNT, 'pdd', PDD_ENTRY, PDD_ORIGIN, async (page) => {
    for (const o of batch) {
      const d = await fetchPddOrderDetail(page, o.sn);
      const promoText = d.promotions.map((p) => `${p.promotionDescription}:${p.promotionAmount}`).join(' | ');
      const row = {
        sn: o.sn,
        dbPaid: poMap.get(o.sn),
        paid: toYuan(o.paidFen),
        discount: toYuan(o.discountFen),
        monthlyCard: toYuan(d.monthlyCardCouponFen),
        status: o.status,
        source: o.source,
        promotions: promoText,
      };
      fs.appendFileSync(OUT_JSONL, JSON.stringify(row) + '\n');
      if (d.monthlyCardCouponFen > 0) monthlyCard.push(row);
      else if (d.promotions.length > 0) otherCoupon.push(row);
      else noDetail.push(row);
      console.log(`[${i + batch.indexOf(o) + 1}/${targets.length}] ${o.sn} 实付¥${row.paid} 优惠¥${row.discount} 月卡券¥${row.monthlyCard} [${promoText}]`);
      await sleep(400); // 详情页限速
    }
  }).catch((e) => { console.error(`详情页批次失败(从 ${batch[0].sn} 起):`, e.message); process.exit(1); });
}

// ── 4) 汇总 ────────────────────────────────────────────
console.log('\n========== 汇总 ==========');
console.log(`生产库 PDD 采购单: ${poMap.size}`);
console.log(`使用优惠券: ${couponInPo.length} 单(另有 ${poNotInList.length} 单列表未覆盖,已直查详情页)`);
console.log(`使用月卡券: ${monthlyCard.length} 单`);
console.log('\n-- 月卡券订单 --');
monthlyCard.forEach((r) => console.log(`${r.sn}  实付¥${r.paid}  月卡券¥${r.monthlyCard}  库内实付¥${r.dbPaid}  [${r.promotions}]`));
console.log(`\n-- 其他优惠券订单: ${otherCoupon.length} 单 --`);
otherCoupon.forEach((r) => console.log(`${r.sn}  实付¥${r.paid}  总优惠¥${r.discount}  [${r.promotions}]`));
console.log(`\n-- 有券但详情页无明细: ${noDetail.length} 单 --`);
noDetail.forEach((r) => console.log(`${r.sn}  实付¥${r.paid}  总优惠¥${r.discount}  (${r.source})`));
console.log(`\n明细已写入 ${OUT_JSONL}`);
