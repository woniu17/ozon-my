// 拼多多订单月卡券普查(2026-09-28,在服务器上跑,用服务器 .linqx-profile)
// 用法: node scripts/probe-pdd-monthly-card.mjs
// 流程:
//  1) order_list_v4 列表接口翻页拉全部订单(响应带 used_coupons/discount_amount)
//  2) 筛出"有使用优惠券"的订单(used_coupons=true 或 discount_amount>0)
//  3) 只对有券订单逐单打开 order.html 详情页,读 window.rawData 优惠明细,区分月卡券/其他券
// 输出:有券订单清单 + 其中月卡券订单清单
import { withPage } from '../src/services/platform-orders/browser-manager.js';
import { fetchPddOrderDetail } from '../src/services/platform-orders/adapters/pdd.js';

const PDD_ENTRY = 'https://mobile.yangkeduo.com/';
const PDD_ORIGIN = 'https://mobile.yangkeduo.com';
const PDD_API = 'https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4';
const ACCOUNT = 'linqx';

const toYuan = (fen) => (Number(fen || 0) / 100).toFixed(2);

async function main() {
  await withPage(ACCOUNT, 'pdd', PDD_ENTRY, PDD_ORIGIN, async (page) => {
    // ── 1) 翻页拉全部订单 ──────────────────────────────
    const all = [];
    let offset = '';
    for (let p = 1; p <= 40; p++) {
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
          type: 'all',
          page: p,
          size: 50,
          offset,
          origin_host_name: 'mobile.yangkeduo.com',
          scene: 'order_list_h5',
          page_from: 0,
          front_env: 1,
          pay_front_supports: [],
        },
      });
      if (r.error) { console.log(`第${p}页请求失败: ${r.error}`); break; }
      if (!r.json || r.status !== 200) { console.log(`第${p}页异常: HTTP ${r.status}`); break; }
      if (p === 1) console.log('响应顶层字段:', Object.keys(r.json).join(','));
      const orders = Array.isArray(r.json.orders) ? r.json.orders : [];
      for (const o of orders) {
        all.push({
          sn: o.order_sn || '',
          paidFen: o.order_amount || 0,
          discountFen: o.discount_amount || 0,
          used: !!o.used_coupons,
          status: o.order_status_prompt || '',
        });
      }
      console.log(`第${p}页 ${orders.length} 单,累计 ${all.length}`);
      if (typeof r.json.offset === 'string' && r.json.offset) offset = r.json.offset;
      if (orders.length < 50) break;
      await new Promise((res) => setTimeout(res, 800)); // 翻页限速
    }
    console.log(`\n列表共拉到 ${all.length} 单`);

    // ── 2) 筛有券订单 ──────────────────────────────────
    const withCoupon = all.filter((o) => o.used || o.discountFen > 0);
    console.log(`其中使用优惠券的订单: ${withCoupon.length} 单\n`);

    // ── 3) 逐单开详情页查月卡券 ────────────────────────
    const monthlyCard = [];
    const otherCoupon = [];
    for (let i = 0; i < withCoupon.length; i++) {
      const o = withCoupon[i];
      const d = await fetchPddOrderDetail(page, o.sn);
      const promoText = d.promotions.map((p) => `${p.promotionDescription}:${p.promotionAmount}`).join(' | ');
      const row = {
        sn: o.sn,
        paid: toYuan(o.paidFen),
        discount: toYuan(o.discountFen),
        monthlyCard: toYuan(d.monthlyCardCouponFen),
        status: o.status,
        promotions: promoText,
      };
      if (d.monthlyCardCouponFen > 0) monthlyCard.push(row);
      else otherCoupon.push(row);
      console.log(`[${i + 1}/${withCoupon.length}] ${o.sn} 实付¥${row.paid} 总优惠¥${row.discount} 月卡券¥${row.monthlyCard} [${promoText}]`);
      await new Promise((res) => setTimeout(res, 500)); // 详情页限速
    }

    // ── 4) 汇总输出 ────────────────────────────────────
    console.log('\n========== 汇总 ==========');
    console.log(`列表订单总数: ${all.length}`);
    console.log(`使用优惠券订单: ${withCoupon.length}`);
    console.log(`其中使用月卡券: ${monthlyCard.length}`);
    console.log('\n-- 月卡券订单 --');
    monthlyCard.forEach((r) => console.log(`${r.sn}  实付¥${r.paid}  月卡券¥${r.monthlyCard}  [${r.promotions}]`));
    console.log('\n-- 其他优惠券(非月卡券)订单 --');
    otherCoupon.forEach((r) => console.log(`${r.sn}  实付¥${r.paid}  总优惠¥${r.discount}  [${r.promotions}]`));
  }).catch((e) => {
    console.error('执行失败:', e.message);
    process.exit(1);
  });
}

main();
