// 月卡券订单采购金额回填(2026-09-28,服务器上跑)
// 范围:2026-09-02~09-15 使用月卡券的 30 单(普查 JSONL 筛出)
// 口径:payment_amount = PDD 原始实付(order_amount) + 月卡券金额
//   不直接用"库内旧值+月卡券",防止 260915-483949340963751 等已按新口径写入的单重复叠加
//   (该单已=实付1.38+月卡券10=11.38,重算后不变,幂等)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { withPage } from '../src/services/platform-orders/browser-manager.js';

const PDD_ENTRY = 'https://mobile.yangkeduo.com/';
const PDD_ORIGIN = 'https://mobile.yangkeduo.com';
const PDD_SEARCH_API = 'https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_search_v4';
const ACCOUNT = 'linqx';
const DB_PATH = new URL('../data/erp.db', import.meta.url).pathname;
const OUT_JSONL = '/tmp/pdd-monthly-card-results.jsonl';

const toYuan = (fen) => (Number(fen || 0) / 100).toFixed(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1) 普查结果筛目标 30 单 ────────────────────────────
const all = fs.readFileSync(OUT_JSONL, 'utf8').trim().split('\n').map(JSON.parse);
const targets = all
  .filter((r) => parseFloat(r.monthlyCard) > 0 && r.sn >= '260902' && r.sn <= '260916')
  .sort((a, b) => a.sn.localeCompare(b.sn));
console.log(`目标订单: ${targets.length} 单(月卡券合计¥${targets.reduce((s, r) => s + parseFloat(r.monthlyCard), 0).toFixed(2)})`);

const db = new DatabaseSync(DB_PATH);

// ── 2) 分批 withPage:搜索接口拿原始实付,回写 ──────────
const BATCH = 15;
let updated = 0, skipped = 0, failed = 0;
await (async () => {
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    await withPage(ACCOUNT, 'pdd', PDD_ENTRY, PDD_ORIGIN, async (page) => {
      for (const t of batch) {
        // 搜索接口拿原始 order_amount(实付分)
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
          url: PDD_SEARCH_API,
          body: {
            type: 'search', key_word: t.sn, scene: 'order_list_h5',
            page: 1, size: 10, front_env: 1,
            origin_host_name: 'mobile.yangkeduo.com',
            query_float_params: {}, pay_front_supports: [],
          },
        });
        const hit = r && r.json && Array.isArray(r.json.orders)
          ? r.json.orders.find((o) => o.order_sn === t.sn) : null;
        if (!hit) {
          console.log(`[跳过] ${t.sn}: 搜索未命中(${r.error || 'HTTP ' + r.status})`);
          failed++;
          continue;
        }
        const paidFen = Number(hit.order_amount || 0);
        const monthlyFen = Math.round(parseFloat(t.monthlyCard) * 100);
        const target = (toYuan(paidFen + monthlyFen));
        const row = db.prepare('SELECT payment_amount FROM op_purchase_order WHERE purchase_sn = ?').get(t.sn);
        if (!row) { console.log(`[跳过] ${t.sn}: 库内无此采购单`); failed++; continue; }
        if (Number(row.payment_amount) === Number(target)) {
          console.log(`[已一致] ${t.sn}: ¥${target}(实付¥${toYuan(paidFen)}+月卡券¥${t.monthlyCard})`);
          skipped++;
          continue;
        }
        db.exec('BEGIN');
        try {
          db.prepare('UPDATE op_purchase_order SET payment_amount = ? WHERE purchase_sn = ?')
            .run(target, t.sn);
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        console.log(`[回填] ${t.sn}: ¥${row.payment_amount} → ¥${target}  (实付¥${toYuan(paidFen)}+月卡券¥${t.monthlyCard})`);
        updated++;
        await sleep(300);
      }
    }).catch((e) => { console.error('批次失败:', e.message); process.exit(1); });
  }
})();

// ── 3) 汇总 ────────────────────────────────────────────
console.log(`\n回填完成:更新 ${updated} 单,已一致 ${skipped} 单,失败 ${failed} 单`);
db.close();
