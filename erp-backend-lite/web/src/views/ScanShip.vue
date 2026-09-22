<script setup>
// 扫描发货(2026-09,设计文档: docs/扫描发货-功能设计.md)
// 打包发货场景:扫采购快递单号/采购单号/Ozon单号 → 全局搜索定位包裹 → 录入实物重量
// → wait_ship 自动打印面单并流转交运;非 wait_ship 提示状态问题不动状态
// 键盘流:扫描框 Enter=搜索 → 重量框 Enter=发货 → 终态自动回焦扫描框(扫码枪零鼠标作业)
// 2026-09-15:商品/采购信息下方公式化展示订单金额+利润计算过程(估/实+销售/成本利润率),
//            打印发货后按称重重算;交运后可更正重量;发货记录列表可滚动
import { ref, reactive, computed, onMounted, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import {
  getOrderList, scanShipSubmit, correctShipWeight, getScanShipRecords, fetchPackageLabel, markPrinted,
} from '../api/order-process.js';
import { pickLabelPrinter, printLabelImage, getAgentPrinters } from '../api/print-agent.js';
import { useToast } from '../components/useToast.js';
import { useConfirmStore } from '../stores/confirm.js';

const { show } = useToast();
const confirmStore = useConfirmStore();
const router = useRouter();

// ── 扫描输入 ─────────────────────────────────────────────
const scanForm = reactive({ keyword: '', mode: 'ss' }); // mode: 'ss'模糊(默认,防拼单逗号拼接漏单) | 'eq'精确
const scanInputRef = ref(null);
const searching = ref(false);
const results = ref([]);          // 全局搜索命中的包裹(快照)
const selectedId = ref(0);        // 当前选中卡片(多结果时唯一可操作的卡)
const printingPkgId = ref(0);     // 打印互斥(与 OrderProcess printingId 同模式)
const retryPkgIds = ref(new Set()); // 重量已保存但打印失败的包裹(重试只走打印+流转)
const retryWeights = reactive({});  // pkgId → 已保存重量 g(重试成功后回填卡片,避免残留搜索时的旧重量)
const agentOnline = ref(null);    // 菜鸟组件探测:null=探测中 true/false
const printers = ref([]);         // 组件枚举的本机打印机名列表
const defaultPrinter = ref('');   // 组件默认打印机
const selectedPrinter = ref('');  // 当前指定打印机,''=组件默认(localStorage 记忆)
const weightEls = {};             // 动态 ref:重量输入框(pkgId → el)
const correctEls = {};            // 动态 ref:更正重量输入框(pkgId → el)

// 结果横幅(aria-live 播报;内容保留至下一次搜索)
const banner = reactive({ type: '', text: '' }); // type: 'ok'|'err'|'info'

// 重量输入值与错误(pkgId → string / error message)
const weightValues = reactive({});
const weightErrors = reactive({});

// ── 更正重量(交运后人工修正,2026-09)──────────────────────
const correct = reactive({ pkgId: 0, value: '', err: '', saving: false });

// ── 发货记录(右侧栏)──────────────────────────────────────
const RECORD_TABS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
];
const records = reactive({
  tab: 'today',
  loading: false,
  rows: [],
  total: 0,
  pageSize: 500, // 不分页:一次拉全量,列表内部滚动浏览
});

// ── 展示工具(对齐 OrderProcess)──────────────────────────
// 点击复制到剪贴板(货件号/SKU/OfferID)
async function copyText(val, label) {
  if (val == null || val === '') return;
  const s = String(val);
  try {
    await navigator.clipboard.writeText(s);
    show(`${label}已复制:${s}`, 'success');
  } catch {
    // 降级:http 环境无 clipboard API
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    show(`${label}已复制:${s}`, 'success');
  }
}

const PLATFORMS = [
  { value: 'other', label: '手工(其他)' },
  { value: '1688', label: '1688' },
  { value: 'yangkeduo', label: '拼多多' },
  { value: 'taobao', label: '淘宝' },
];
const OPERATE_LABELS = {
  wait_process: { label: '待处理', cls: 'tag-warn' },
  wait_ship: { label: '待打单发货', cls: 'tag-info' },
  ship_success: { label: '交运', cls: 'tag-info' },
  wait_receiver_confirm: { label: '已发货', cls: 'tag-ok' },
  cancelled: { label: '已取消', cls: 'tag-err' },
};
const WEIGHT_SOURCE_LABELS = { ship: '发货称重', miaoshou: '订单称重', system: '系统维护', ozon: 'Ozon后台同步' };

/** 采购商品详情页链接(对齐 OrderProcess:平台 + 商品ID 拼 URL;ID 缺失/非数字返回空) */
function goodsDetailUrl(platform, goodsId) {
  const id = String(goodsId || '').trim();
  if (!id || !/^\d+$/.test(id)) return '';
  if (platform === '1688') return `https://detail.1688.com/offer/${id}.html`;
  if (platform === 'yangkeduo') return `https://mobile.yangkeduo.com/goods.html?goods_id=${id}`;
  if (platform === 'taobao') return `https://item.taobao.com/item.htm?id=${id}`;
  return '';
}

/** 采购订单详情页链接(平台 + 采购单号拼 URL;单号缺失返回空) */
function orderDetailUrl(platform, purchaseSn) {
  const sn = String(purchaseSn || '').trim();
  if (!sn) return '';
  if (platform === '1688') return `https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?word=${encodeURIComponent(sn)}`;
  if (platform === 'yangkeduo') return `https://mobile.yangkeduo.com/order.html?order_sn=${encodeURIComponent(sn)}`;
  return '';
}

function platformLabel(p) {
  return PLATFORMS.find((x) => x.value === p)?.label || p || '—';
}
function fmtMoney(n) {
  if (n == null) return '—';
  return '¥' + Number(n).toFixed(2);
}
// 利润率格式化:null 返回 —;后端 computeProfit 已 ×10000/100 转为百分数(如 23.45)
function fmtRate(n) {
  if (n == null) return '—';
  return Number(n).toFixed(2) + '%';
}

// ── 利润(2026-09):数据源 /list 注入的 pkg.profit(后端 computeProfit 双口径)──
// 估/实标记与 OrderProcess 金额列同源:estimated=false 真实应计,否则预估
function profitEstimated(pkg) {
  return pkg.profit ? pkg.profit.estimated !== false : true;
}

// 打印发货/更正重量后,按新重量本地重算利润(预估口径,公式与后端 computeProfit 一致)
// 真实应计口径(estimated=false)/已取消/已退货的利润不随重量变化,不重算
const EST_COMMISSION_RATE = 0.16;   // 预估佣金率(对齐后端 DEFAULT_COMMISSION_RATE)
const DELIVERY_BASE_CNY = 3.37;     // 国际配送费公式(对齐后端)
const DELIVERY_PER_G_CNY = 0.0281;
function recomputeProfitByWeight(pkg, g) {
  const p = pkg.profit;
  if (!p || p.estimated === false || p.cancelled || p.returned) return;
  const orderAmount = Number(pkg.orderAmount) || 0;
  const purchase = Number(pkg.totalPurchaseAmount) || 0;
  const round2 = (n) => Math.round(n * 100) / 100;
  const commission = round2(orderAmount * EST_COMMISSION_RATE);
  const delivery = round2(DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * g);
  const escrow = round2(orderAmount - commission - delivery);
  const profit = round2(escrow - purchase);
  p.commission = commission;
  p.delivery = delivery;
  p.escrow = escrow;
  p.profit = profit;
  p.profitRateCost = purchase > 0 ? Math.round((profit / purchase) * 10000) / 100 : null;
  p.profitRateSale = orderAmount > 0 ? Math.round((profit / orderAmount) * 10000) / 100 : null;
  p.estimated = true;
  p.weightG = g;
  p.weightSource = 'ship';
  delete p.weightMissing;
}

// 利润计算过程(公式化展示,口径对齐后端 computeProfit):
//   预估口径:利润(估) = 订单金额 − 佣金(订单×16%) − 国际配送(3.37+0.0281×g) − 采购
//   真实口径:利润(实) = 打款(应计净额) − 采购
//   已取消/已退货:利润 = −采购(无销售收入/货款全额扣回)
function profitCalc(pkg) {
  const n2 = (n) => (n == null ? '—' : Number(n).toFixed(2));
  const p = pkg.profit;
  const orderAmount = Number(pkg.orderAmount) || 0;
  const purchase = Number(pkg.totalPurchaseAmount) || 0;
  if (!p) return { estimated: true, main: '利润:—(无计算数据)', rates: null };
  const saleRate = orderAmount > 0
    ? `销售利润率 = ${n2(p.profit)} ÷ ${n2(orderAmount)} = ${fmtRate(p.profitRateSale)}`
    : '销售利润率 = —(无订单金额)';
  const costRate = purchase > 0
    ? `成本利润率 = ${n2(p.profit)} ÷ ${n2(purchase)} = ${fmtRate(p.profitRateCost)}`
    : '成本利润率 = —(无采购金额)';
  if (p.estimated === false) {
    return {
      estimated: false,
      main: `利润(实) = 打款 ${n2(p.escrow)} − 采购 ${n2(purchase)} = ${fmtMoney(p.profit)}`,
      rates: `${saleRate} · ${costRate}`,
    };
  }
  if (p.cancelled) {
    return { estimated: true, main: `利润 = −采购 ${n2(purchase)} = ${fmtMoney(p.profit)}(已取消,无销售收入)`, rates: null };
  }
  if (p.returned) {
    return { estimated: true, main: `利润 = −采购 ${n2(purchase)} = ${fmtMoney(p.profit)}(已退货,货款被全额扣回)`, rates: null };
  }
  if (p.delivery != null) {
    return {
      estimated: true,
      main: `利润(估) = 订单 ${n2(orderAmount)} − 佣金 ${n2(p.commission)}(订单×16%) − 国际配送 ${n2(p.delivery)}(3.37+0.0281×${Math.floor(p.weightG ?? 0)}g) − 采购 ${n2(purchase)} = ${fmtMoney(p.profit)}`,
      rates: `${saleRate} · ${costRate}`,
    };
  }
  return {
    estimated: true,
    main: `利润(估) = 订单 ${n2(orderAmount)} − 佣金 ${n2(p.commission)}(订单×16%,配送隐含) − 采购 ${n2(purchase)} = ${fmtMoney(p.profit)}(无重量,配送未单独估算)`,
    rates: `${saleRate} · ${costRate}`,
  };
}
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return t;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// ── 最迟发货时间与剩余时间(2026-09-17,数据源 op_package.last_delivery_at 冗余自 Ozon shipment_date)──
// 颜色分级:已超时=红加粗 / <24h=红 / <48h=橙 / 其余默认灰
function shipRemainCls(pkg) {
  if (!pkg.lastDeliveryAt) return '';
  const t = new Date(pkg.lastDeliveryAt).getTime();
  if (isNaN(t)) return '';
  const ms = t - Date.now();
  if (ms <= 0) return 'remain-over';
  if (ms < 24 * 3600 * 1000) return 'remain-urg';
  if (ms < 48 * 3600 * 1000) return 'remain-warn';
  return '';
}
function fmtRemain(pkg) {
  if (!pkg.lastDeliveryAt) return '';
  const t = new Date(pkg.lastDeliveryAt).getTime();
  if (isNaN(t)) return '';
  const diff = t - Date.now();
  const neg = diff < 0;
  let s = Math.floor(Math.abs(diff) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  const body = d > 0 ? `${d}天${h}小时` : h > 0 ? `${h}小时${m}分` : `${m}分`;
  return neg ? `已超时${body}` : `剩${body}`;
}
// 采购商品数量合计(items_json 各商品 number 求和;无明细返回 0)
function poGoodsCount(l) {
  return (l.items || []).reduce((s, i) => s + Number(i.number || i.num || 1), 0);
}
// 标签配色(2026-09-17):与订单处理页同口径——标签名 hash 稳定分配 tag-c0~7,同名永远同色
function tagColorClass(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return 'tag-c' + (h % 8);
}
function operateTag(pkg) {
  return OPERATE_LABELS[pkg.operateStatus] || { label: pkg.operateStatus, cls: 'tag-mute' };
}
// 卡片是否可发货(快照预判;submit 时服务端权威二次校验)
function canShipCard(pkg) {
  return pkg.operateStatus === 'wait_ship' && !pkg.isIgnored;
}
// 非 wait_ship 卡片的拦截原因(置灰卡 + 横幅文案同源)
function blockReason(pkg) {
  if (pkg.isIgnored) return '已搁置';
  switch (pkg.operateStatus) {
    case 'wait_process': return '待处理(未采购)';
    case 'ship_success': return '已交运';
    case 'wait_receiver_confirm': return '已发货(已交运)';
    case 'cancelled': return '订单已取消';
    default: return pkg.operateStatus;
  }
}
// 重量校验提示等见 onSubmitShip;输入框不带参考文案(强制人工读秤)

// ── 搜索 ─────────────────────────────────────────────────
async function doSearch() {
  const kw = scanForm.keyword.trim();
  if (!kw || searching.value) return;
  searching.value = true;
  results.value = [];
  selectedId.value = 0;
  retryPkgIds.value = new Set();
  Object.keys(retryWeights).forEach((k) => delete retryWeights[k]);
  banner.type = 'info';
  banner.text = '搜索中…';
  try {
    // 复用 /list 全局搜索(跨所有状态,7 类字段:Ozon单号/包裹号/包裹物流号/offer_id/SKU/采购单号/采购物流单号)
    const data = await getOrderList({
      tab: 'all',
      globalKeyword: kw,
      globalMode: scanForm.mode,
      page: 1,
      pageSize: 50,
    });
    results.value = data?.packages || [];
    const n = results.value.length;
    if (n === 0) {
      banner.text = `未找到匹配订单「${kw}」`;
      focusScan();
    } else if (n === 1) {
      selectCard(results.value[0]);
      banner.text = '';
    } else {
      // 多结果(拼单场景):需人工选卡
      banner.type = 'info';
      banner.text = `命中 ${n} 个包裹,请选择要发货的订单`;
      focusScan();
    }
  } catch (err) {
    banner.type = 'err';
    banner.text = err.message || String(err);
    focusScan();
  } finally {
    searching.value = false;
  }
}

function selectCard(pkg) {
  if (!canShipCard(pkg)) return;
  selectedId.value = pkg.id;
  banner.type = '';
  banner.text = '';
  nextTick(() => weightEls[pkg.id]?.focus());
}

function focusScan() {
  nextTick(() => {
    scanInputRef.value?.focus();
    scanInputRef.value?.select();
  });
}

function onScanKeydown(e) {
  if (e.key === 'Escape') {
    scanForm.keyword = '';
    results.value = [];
    selectedId.value = 0;
    banner.type = '';
    banner.text = '';
  }
}

// ── 发货提交(核心流程)──────────────────────────────────
// 提交重量 → 服务端权威状态校验 → canShip 时打印面单 → 出纸后 markPrinted 流转交运
async function onSubmitShip(pkg) {
  if (printingPkgId.value) return;
  // 前端重量校验(服务端 400 之外的即时反馈)
  const raw = String(weightValues[pkg.id] ?? '').trim();
  const g = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(g) || g < 1 || g > 50000) {
    weightErrors[pkg.id] = '重量须为 1~50000 的整数(克)';
    weightEls[pkg.id]?.focus();
    return;
  }
  weightErrors[pkg.id] = '';
  printingPkgId.value = pkg.id;
  let submitted = false; // 重量是否已成功落库(区分 submit 失败与打印失败)
  try {
    // 1) 服务端权威校验(覆盖搜索后状态被同步任务/他端操作改变的场景)
    const r = await scanShipSubmit(pkg.id, g);
    if (!r.canShip) {
      // 非 wait_ship:不打印不改状态,横幅提示原因
      banner.type = 'err';
      banner.text = r.message || `订单状态问题:${r.operateStatus}`;
      // 已交运:可选重打(缓存秒出,不改状态)
      if (r.operateStatus === 'ship_success' && !r.isIgnored) {
        const ok = await confirmStore.ask({
          message: `包裹 ${pkg.postingNumber} 已交运。面单丢失或打花?重新打印面单(不改状态)`,
        });
        if (ok) await doPrint(pkg, { reprint: true });
      }
      focusScan();
      return;
    }
    submitted = true; // canShip=true → 重量已落库
    // 2) 打印面单 → 出纸后流转交运
    await doPrint(pkg, { reprint: false });
    banner.type = 'ok';
    banner.text = `✓ 已交运 ${pkg.postingNumber} · 重量 ${g}g · 面单已打印`;
    // 卡片就地流转(留作上下文,不消失)
    pkg.operateStatus = 'ship_success';
    pkg.weightG = g;
    pkg.weightSource = 'ship';
    // 打印发货后按称重重量重算利润(预估口径,国际配送费随重量变化)
    recomputeProfitByWeight(pkg, g);
    retryPkgIds.value.delete(pkg.id);
    refreshRecords();
    focusScan();
  } catch (err) {
    const msg = err?.message || String(err);
    banner.type = 'err';
    if (submitted) {
      // 打印阶段失败:重量已保存,重试只走打印+流转(不再提交重量)
      retryPkgIds.value.add(pkg.id);
      retryWeights[pkg.id] = g;
      banner.text = `${msg}(重量 ${g}g 已保存,点击「重试打印」继续)`;
    } else {
      // submit 本身失败(网络/5xx):重量未保存,直接重按 Enter 走全流程
      banner.text = msg;
    }
    focusScan();
  } finally {
    printingPkgId.value = 0;
  }
}

// 拉面单 → 组件静默出纸;reprint=true 时不动状态(markPrinted 会刷新交运时间,重打禁止)
async function doPrint(pkg, { reprint }) {
  const blob = await fetchPackageLabel([pkg.id]);
  const printer = await pickLabelPrinter();
  await printLabelImage(blob, pkg.logisticsNo || String(pkg.id), printer);
  if (!reprint) {
    await markPrinted(pkg.id);
  } else {
    banner.type = 'ok';
    banner.text = `面单已重新打印(交运订单,状态不变)`;
  }
}

// 重试打印(重量已保存的场景):只走打印 + 流转
async function onRetryPrint(pkg) {
  if (printingPkgId.value) return;
  printingPkgId.value = pkg.id;
  try {
    await doPrint(pkg, { reprint: false });
    banner.type = 'ok';
    banner.text = `✓ 已交运 ${pkg.postingNumber} · 面单已打印`;
    pkg.operateStatus = 'ship_success';
    // 回填已保存重量(卡片显示的仍是搜索时快照,不含提交的称重值)
    const savedG = retryWeights[pkg.id];
    if (savedG != null) {
      pkg.weightG = savedG;
      pkg.weightSource = 'ship';
      recomputeProfitByWeight(pkg, savedG);
      delete retryWeights[pkg.id];
    }
    retryPkgIds.value.delete(pkg.id);
    refreshRecords();
    focusScan();
  } catch (err) {
    banner.type = 'err';
    banner.text = err?.message || String(err);
    focusScan();
  } finally {
    printingPkgId.value = 0;
  }
}

// 已交运卡片的重打入口(拼单场景发完剩余卡片)
async function onReprint(pkg) {
  if (printingPkgId.value) return;
  const ok = await confirmStore.ask({
    message: `包裹 ${pkg.postingNumber} 已交运。面单丢失或打花?重新打印面单(不改状态)`,
  });
  if (!ok) return;
  printingPkgId.value = pkg.id;
  try {
    await doPrint(pkg, { reprint: true });
    focusScan();
  } catch (err) {
    banner.type = 'err';
    banner.text = err?.message || String(err);
    focusScan();
  } finally {
    printingPkgId.value = 0;
  }
}

// ── 更正重量(已交运卡片:人工修正发货重量,利润随之重算)──
function onStartCorrect(pkg) {
  correct.pkgId = pkg.id;
  correct.value = pkg.weightG != null ? String(Math.floor(pkg.weightG)) : '';
  correct.err = '';
  nextTick(() => correctEls[pkg.id]?.focus());
}
function onCancelCorrect() {
  correct.pkgId = 0;
  correct.err = '';
}
async function onSubmitCorrect(pkg) {
  if (correct.saving) return;
  const raw = String(correct.value).trim();
  const g = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(g) || g < 1 || g > 50000) {
    correct.err = '重量须为 1~50000 的整数(克)';
    correctEls[pkg.id]?.focus();
    return;
  }
  correct.saving = true;
  try {
    await correctShipWeight(pkg.id, g);
    pkg.weightG = g;
    pkg.weightSource = 'ship';
    // 更正重量后本地重算利润(预估口径,国际配送费随重量变化)
    recomputeProfitByWeight(pkg, g);
    banner.type = 'ok';
    banner.text = `✓ ${pkg.postingNumber} 重量已更正为 ${g}g`;
    correct.pkgId = 0;
    correct.err = '';
    refreshRecords();
  } catch (err) {
    correct.err = err?.message || String(err);
  } finally {
    correct.saving = false;
  }
}

// ── 发货记录 ─────────────────────────────────────────────
async function loadRecords() {
  records.loading = true;
  try {
    const data = await getScanShipRecords({
      day: records.tab,
      page: 1,
      pageSize: records.pageSize,
    });
    records.rows = data?.packages || [];
    records.total = data?.total || 0;
    counts[records.tab] = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    records.rows = [];
    records.total = 0;
  } finally {
    records.loading = false;
  }
}

// 今日/昨日计数独立维护(角标互不影响;轻量请求只取 total)
const counts = reactive({ today: null, yesterday: null });
async function loadCount(day) {
  try {
    const data = await getScanShipRecords({ day, page: 1, pageSize: 1 });
    counts[day] = data?.total || 0;
  } catch { /* 静默 */ }
}
function loadCounts() {
  loadCount('today');
  loadCount('yesterday');
}

function switchRecordTab(key) {
  if (records.tab === key) return;
  records.tab = key;
  loadRecords();
}

// 发货成功后静默刷新(不抢焦点;计数同步更新)
async function refreshRecords() {
  try {
    const data = await getScanShipRecords({
      day: records.tab,
      page: 1,
      pageSize: records.pageSize,
    });
    records.rows = data?.packages || [];
    records.total = data?.total || 0;
    counts[records.tab] = data?.total || 0;
  } catch { /* 静默 */ }
  loadCounts();
}

// 记录行 Ozon 单号 → 跳订单处理页全局搜索(复用妙手订单页"本地包裹"跳转模式)
function jumpToOrderProcess(pkg) {
  router.push({ path: '/order-process', query: { kw: pkg.postingNumber } });
}

// ── 初始化 ───────────────────────────────────────────────
onMounted(() => {
  focusScan();
  loadRecords();
  loadCounts();
  // 菜鸟组件探测(仅状态展示,失败不阻塞——打印时 pickLabelPrinter 会再连)
  getAgentPrinters()
    .then(({ defaultPrinter: dp, printers: list }) => {
      agentOnline.value = true;
      defaultPrinter.value = dp || '';
      printers.value = list || [];
      // 恢复上次指定:记忆值仍在本机列表中才生效(打印机可能已被移除/重命名)
      let saved = '';
      try { saved = localStorage.getItem('erp:labelPrinter') || ''; } catch { /* noop */ }
      if (saved && list.includes(saved)) {
        selectedPrinter.value = saved;
      } else {
        selectedPrinter.value = '';
        if (saved) {
          try { localStorage.removeItem('erp:labelPrinter'); } catch { /* noop */ }
        }
      }
    })
    .catch(() => { agentOnline.value = false; });
});

// 指定打印机:''=组件默认(清除记忆);pickLabelPrinter 优先读该记忆,打印链路无需改动
function onPrinterChange() {
  try {
    if (selectedPrinter.value) localStorage.setItem('erp:labelPrinter', selectedPrinter.value);
    else localStorage.removeItem('erp:labelPrinter');
  } catch { /* noop */ }
}
</script>

<template>
  <div class="scan-ship-page">
    <!-- ① 扫描输入区(sticky,扫码枪主操作目标) -->
    <div class="scan-bar-wrap">
      <div class="scan-bar card">
        <select v-model="scanForm.mode" class="filter-input scan-mode" title="匹配模式:默认模糊(拼单采购单号逗号拼接,精确匹配会漏单)">
          <option value="ss">模糊</option>
          <option value="eq">精确</option>
        </select>
        <input
          ref="scanInputRef"
          v-model.trim="scanForm.keyword"
          class="scan-input"
          type="text"
          aria-label="扫描输入"
          placeholder="扫描/输入 采购快递单号 · 采购单号 · Ozon订单号"
          :readonly="searching"
          @focus="$event.target.select()"
          @keydown.enter="doSearch"
          @keydown="onScanKeydown"
        />
        <button class="btn btn-primary scan-btn" :disabled="searching" @click="doSearch">
          {{ searching ? '搜索中…' : '搜索' }}
        </button>
        <!-- 指定标签打印机(记住上次选择;''=组件默认) -->
        <select
          v-model="selectedPrinter"
          class="filter-input printer-select"
          :disabled="agentOnline !== true || !printers.length"
          :title="agentOnline === true
            ? (printers.length ? '标签打印机(记住上次选择)' : '未枚举到打印机')
            : '打印组件未连接,无法选择打印机'"
          @change="onPrinterChange"
        >
          <option value="">默认{{ defaultPrinter ? `(${defaultPrinter})` : '' }}</option>
          <option v-for="p in printers" :key="p" :value="p">{{ p }}</option>
        </select>
        <span
          class="agent-dot"
          :class="agentOnline === true ? 'on' : agentOnline === false ? 'off' : ''"
          :title="agentOnline === true ? '菜鸟打印组件已连接' : agentOnline === false ? '菜鸟打印组件未连接(打印前请启动组件)' : '正在探测打印组件…'"
        >
          {{ agentOnline === true ? '打印组件已连接' : agentOnline === false ? '打印组件未连接' : '探测打印组件…' }}
        </span>
      </div>
    </div>

    <!-- ② 结果反馈横幅(自动播报) -->
    <div v-if="banner.text" class="scan-banner" :class="`banner-${banner.type || 'info'}`" role="status" aria-live="polite">
      {{ banner.text }}
    </div>

    <div class="scan-body">
      <!-- ③ 搜索结果(左侧工作区) -->
      <section class="results-col" aria-label="搜索结果">
        <div v-if="!results.length" class="empty card">
          {{ searching ? '搜索中…' : '扫描采购快递单号开始发货' }}
        </div>

        <div
          v-for="pkg in results"
          :key="pkg.id"
          class="pkg-card card"
          :class="{
            selected: selectedId === pkg.id,
            disabled: !canShipCard(pkg),
            shipped: pkg.operateStatus === 'ship_success',
          }"
          :aria-current="selectedId === pkg.id ? 'true' : undefined"
          @click="selectCard(pkg)"
        >
          <!-- 订单级信息(横贯整行,2026-09-17 布局):店铺/货件号/状态/下单时间/最迟发货时间/标签/备注 -->
          <div class="pkg-order">
                <div class="order-line order-line1">
                  <span class="order-store">{{ pkg.storeName }}</span>
                  <span class="mono order-posting">{{ pkg.postingNumber }}</span>
                  <button
                    class="copy-btn"
                    title="复制货件号"
                    @click.stop="copyText(pkg.postingNumber, '货件号')"
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" /></svg>
                  </button>
                  <span v-if="pkg.parentId" class="tag tag-mute" title="拆单子件">子件</span>
                  <span class="tag" :class="operateTag(pkg).cls">{{ operateTag(pkg).label }}</span>
                  <!-- 订单标签(只读;与货件号同一行,2026-09-17;同 8 色 hash 口径) -->
                  <span v-for="t in pkg.tags" :key="t" class="ship-tag" :class="tagColorClass(t)">{{ t }}</span>
                </div>
                <!-- 订单备注(只读;本地录入或妙手同步;单行省略,悬浮看全文;货件号行下一行,2026-09-17) -->
                <div v-if="pkg.note" class="order-note" :title="pkg.note">备注:{{ pkg.note }}</div>
                <div class="order-line">
                  下单 {{ fmtTime(pkg.inProcessAt) }}
                  <template v-if="pkg.lastDeliveryAt">
                    · 最迟发货 {{ fmtTime(pkg.lastDeliveryAt) }}
                    <span class="ship-remain" :class="shipRemainCls(pkg)" :title="'Ozon 最迟发货时间(shipment_date)'">{{ fmtRemain(pkg) }}</span>
                  </template>
                </div>
              </div>

          <div class="pkg-grid">
            <!-- 左列:产品信息 / 右列:采购信息(2026-09-17 布局调整) -->
            <div class="pkg-left">
              <div class="pkg-left-label">产品信息</div>
              <!-- 商品信息(SKU/OfferID 可点击复制,数量独立右列) -->
              <div class="pkg-products">
                <div v-for="(it, i) in pkg.items" :key="i" class="product-item">
                  <div class="img-hover-wrap">
                    <a v-if="it.picUrl && it.pdpUrl" :href="it.pdpUrl" target="_blank" rel="noopener" class="img-link" title="打开Ozon商品详情页" @click.stop>
                      <img :src="it.picUrl" referrerpolicy="no-referrer" loading="lazy" class="thumb140" alt="" />
                    </a>
                    <img v-else-if="it.picUrl" :src="it.picUrl" referrerpolicy="no-referrer" loading="lazy" class="thumb140" alt="" />
                    <div v-else class="thumb140 thumb-empty">—</div>
                    <img v-if="it.picUrl" :src="it.picUrl" referrerpolicy="no-referrer" class="img-preview" alt="" />
                  </div>
                  <div class="product-main">
                    <div class="product-line">
                      <a v-if="it.pdpUrl" :href="it.pdpUrl" target="_blank" rel="noopener" class="mono sku-link" title="打开Ozon商品详情页" @click.stop>SKU:{{ it.sku ?? '—' }}</a>
                      <span v-else class="mono">SKU:{{ it.sku ?? '—' }}</span>
                      <button
                        v-if="it.sku != null"
                        class="copy-btn"
                        title="复制SKU"
                        @click.stop="copyText(it.sku, 'SKU')"
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" /></svg>
                      </button>
                    </div>
                    <div class="product-line">
                      <span class="mono">Offer ID:{{ it.offerId ?? '—' }}</span>
                      <button
                        v-if="it.offerId != null"
                        class="copy-btn"
                        title="复制Offer ID"
                        @click.stop="copyText(it.offerId, 'Offer ID')"
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" /></svg>
                      </button>
                    </div>
                    <div class="product-line">单价 {{ fmtMoney(it.price) }}</div>
                  </div>
                  <div class="product-qty" :class="{ 'qty-multi': it.quantity > 1 }">× {{ it.quantity }}</div>
                </div>
                <div v-if="!pkg.items?.length" class="muted">—</div>
              </div>
            </div>

            <!-- 右列:采购信息 -->
            <div class="pkg-right">
              <div class="pkg-right-label">采购信息</div>
              <div class="pkg-purchases">
                <div v-if="!pkg.purchaseLinks?.length" class="muted sub">未录入采购信息</div>
                <div v-for="l in pkg.purchaseLinks" :key="l.id" class="purchase-item">
                  <div class="purchase-imgs">
                    <div v-for="(pi, j) in (l.items || []).slice(0, 3)" :key="j" class="img-hover-wrap">
                      <a v-if="goodsDetailUrl(l.platform, pi.goodsId)" :href="goodsDetailUrl(l.platform, pi.goodsId)" target="_blank" rel="noopener" class="img-link" :title="'打开' + platformLabel(l.platform) + '商品详情页'" @click.stop>
                        <img :src="pi.thumbUrl || pi.picUrl" referrerpolicy="no-referrer" loading="lazy" class="thumb140" alt="" />
                      </a>
                      <img v-else :src="pi.thumbUrl || pi.picUrl" referrerpolicy="no-referrer" loading="lazy" class="thumb140" alt="" />
                      <img :src="pi.thumbUrl || pi.picUrl" referrerpolicy="no-referrer" class="img-preview" alt="" />
                    </div>
                    <span v-if="!l.items?.length" class="thumb140 thumb-empty">—</span>
                    <span v-if="l.items?.length > 3" class="muted sub purchase-more">+{{ l.items.length - 3 }}</span>
                  </div>
                  <div class="purchase-info">
                    <div class="purchase-line">
                      <span class="muted">{{ platformLabel(l.platform) }}</span>
                      <a
                        v-if="orderDetailUrl(l.platform, l.purchaseSn)"
                        :href="orderDetailUrl(l.platform, l.purchaseSn)"
                        target="_blank"
                        rel="noopener"
                        class="mono order-link"
                        :title="'打开' + platformLabel(l.platform) + '订单详情'"
                        @click.stop
                      >{{ l.purchaseSn }}</a>
                      <span v-else class="mono">{{ l.purchaseSn || '#' + l.id }}</span>
                      <button
                        v-if="l.purchaseSn"
                        class="copy-btn"
                        title="复制采购订单号"
                        @click.stop="copyText(l.purchaseSn, '采购订单号')"
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" /></svg>
                      </button>
                    </div>
                    <div class="purchase-line sub muted">采购买家:{{ l.buyerAccount || '—' }}<template v-if="poGoodsCount(l)"> · 数量 ×{{ poGoodsCount(l) }}</template></div>
                    <!-- 采购时间:优先采购单支付时间(pay_at),无则入库时间(gmt_create) -->
                    <div class="purchase-line sub muted" title="优先采购单支付时间,无则本地入库时间">采购时间:{{ fmtTime(l.poPayAt || l.poGmtCreate) }}</div>
                    <!-- 采购金额:分摊到本包裹的金额(口径同 OrderProcess;利润计算即用此口径) -->
                    <div
                      class="purchase-line sub muted"
                      :title="Number(l.paymentAmount) > 0 && Number(l.paymentAmount) !== Number(l.allocatedAmount)
                        ? `本包裹分摊 ¥${Number(l.allocatedAmount ?? 0).toFixed(2)}(采购单整单 ¥${Number(l.paymentAmount).toFixed(2)},拼单按数量分摊)`
                        : '本包裹采购分摊金额'"
                    >采购金额:{{ fmtMoney(l.allocatedAmount) }}</div>
                    <div class="purchase-line sub muted">
                      物流:{{ l.poLogisticsNo ? `${l.poLogisticsCompany || ''} ${l.poLogisticsNo}`.trim() : '—' }}
                      <button
                        v-if="l.poLogisticsNo"
                        class="copy-btn"
                        title="复制快递单号"
                        @click.stop="copyText(l.poLogisticsNo, '快递单号')"
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" /></svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 金额与利润计算(商品/采购信息下方整行,公式化展示计算过程) -->
          <div class="profit-block">
            <div class="profit-row profit-head">
              <span class="profit-label">订单金额 <b class="mono">{{ fmtMoney(pkg.orderAmount) }}</b></span>
              <span class="tag" :class="profitEstimated(pkg) ? 'tag-warn' : 'tag-ok'" title="估=预估口径 / 实=真实应计口径">{{ profitEstimated(pkg) ? '估' : '实' }}</span>
              <span class="profit-final">
                利润
                <b
                  class="mono"
                  :class="pkg.profit?.profit > 0 ? 'profit-pos' : pkg.profit?.profit < 0 ? 'profit-neg' : 'muted'"
                >{{ fmtMoney(pkg.profit?.profit) }}</b>
              </span>
            </div>
            <div class="profit-row mono formula">{{ profitCalc(pkg).main }}</div>
            <div v-if="profitCalc(pkg).rates" class="profit-row mono formula sub">{{ profitCalc(pkg).rates }}</div>
          </div>

          <!-- 操作条 -->
          <div class="pkg-actions">
            <template v-if="canShipCard(pkg)">
              <span class="ref-weight" title="Ozon后台同步重量(按数量加权求和)">Ozon后台 {{ pkg.ozonWeightG != null ? Math.floor(pkg.ozonWeightG) + 'g' : '—' }}</span>
              <span class="ref-weight" title="本系统维护重量">本系统 {{ pkg.systemWeightG != null ? Math.floor(pkg.systemWeightG) + 'g' : '—' }}</span>
              <label class="weight-label" :for="'weight-' + pkg.id">重量(g)</label>
              <input
                :id="'weight-' + pkg.id"
                :ref="(el) => (weightEls[pkg.id] = el)"
                v-model="weightValues[pkg.id]"
                class="weight-input"
                :class="{ 'weight-invalid': weightErrors[pkg.id] }"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                :disabled="selectedId !== pkg.id || printingPkgId === pkg.id"
                :aria-describedby="weightErrors[pkg.id] ? 'weight-err-' + pkg.id : undefined"
                @focus="$event.target.select()"
                @keydown.enter="onSubmitShip(pkg)"
                @input="weightErrors[pkg.id] = ''"
              />
              <button
                class="btn btn-primary ship-btn"
                :disabled="selectedId !== pkg.id || printingPkgId === pkg.id || printingPkgId !== 0"
                :title="retryPkgIds.has(pkg.id) ? '重量已保存,重试打印面单并流转交运' : '打印面单并流转交运(仅待打单发货状态)'"
                @click.stop="retryPkgIds.has(pkg.id) ? onRetryPrint(pkg) : onSubmitShip(pkg)"
              >
                {{ printingPkgId === pkg.id ? '打印中…' : retryPkgIds.has(pkg.id) ? '重试打印' : '打印并发货' }}
              </button>
            </template>
            <template v-else-if="pkg.operateStatus === 'ship_success'">
              <span class="tag tag-ok">已交运 {{ fmtTime(pkg.shippedAt || pkg.waybillPrintedAt) }}</span>
              <span class="ref-weight" :title="WEIGHT_SOURCE_LABELS[pkg.weightSource] || ''">称重 {{ pkg.weightG != null ? Math.floor(pkg.weightG) + 'g' : '—' }}</span>
              <!-- 更正重量:打印发货后人工修正(内联输入,Enter 保存 / Esc 取消) -->
              <template v-if="correct.pkgId === pkg.id">
                <input
                  :ref="(el) => (correctEls[pkg.id] = el)"
                  v-model="correct.value"
                  class="weight-input correct-input"
                  :class="{ 'weight-invalid': correct.err }"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  :aria-label="'更正重量(克)-' + pkg.postingNumber"
                  @focus="$event.target.select()"
                  @keydown.enter="onSubmitCorrect(pkg)"
                  @keydown.escape="onCancelCorrect"
                  @input="correct.err = ''"
                />
                <button
                  class="btn btn-primary btn-sm"
                  :disabled="correct.saving"
                  @click.stop="onSubmitCorrect(pkg)"
                >{{ correct.saving ? '保存中…' : '保存更正' }}</button>
                <button class="btn btn-ghost btn-sm" @click.stop="onCancelCorrect">取消</button>
              </template>
              <template v-else>
                <button
                  class="btn btn-ghost btn-sm"
                  :disabled="printingPkgId !== 0"
                  title="打印发货后人工修正发货重量,利润(估)随之更新"
                  @click.stop="onStartCorrect(pkg)"
                >更正重量</button>
              </template>
              <button
                class="btn btn-ghost btn-sm"
                :disabled="printingPkgId !== 0"
                title="面单丢失或打花时重新打印(缓存秒出,不改状态)"
                @click.stop="onReprint(pkg)"
              >重新打印</button>
            </template>
            <template v-else>
              <span class="tag tag-mute">{{ blockReason(pkg) }} · 不可发货</span>
            </template>
          </div>
          <div v-if="weightErrors[pkg.id]" :id="'weight-err-' + pkg.id" class="error-text weight-err">
            {{ weightErrors[pkg.id] }}
          </div>
          <div v-if="correct.pkgId === pkg.id && correct.err" class="error-text weight-err">
            {{ correct.err }}
          </div>
        </div>
      </section>

      <!-- ④ 发货记录(右侧参考栏) -->
      <aside class="records-col card" aria-label="发货记录">
        <div class="records-head">
          <div class="record-tabs">
            <button
              v-for="t in RECORD_TABS"
              :key="t.key"
              class="tab-btn"
              :class="{ active: records.tab === t.key }"
              @click="switchRecordTab(t.key)"
            >
              {{ t.label }}
              <span v-if="counts[t.key] != null" class="tab-count">{{ counts[t.key] }}</span>
            </button>
          </div>
          <button class="btn btn-ghost btn-sm" :disabled="records.loading" @click="loadRecords" title="刷新发货记录">
            {{ records.loading ? '加载中…' : '刷新' }}
          </button>
        </div>

        <!-- 记录列表(可滚动区域) -->
        <div class="records-list">
          <div v-if="!records.rows.length" class="empty records-empty">
            {{ records.loading ? '加载中…' : (records.tab === 'today' ? '今日暂无发货记录' : '昨日暂无发货记录') }}
          </div>

          <!-- 记录行:第一列图片(70x70 悬浮放大) + 第二列三行(货件号+复制/称重重量/打印发货时间) -->
          <div
            v-for="p in records.rows"
            :key="p.id"
            class="record-row"
          >
            <div class="img-hover-wrap">
              <img
                v-if="p.items?.[0]?.picUrl"
                :src="p.items[0].picUrl"
                referrerpolicy="no-referrer"
                loading="lazy"
                class="record-thumb"
                alt=""
              />
              <div v-else class="record-thumb thumb-empty">—</div>
              <img
                v-if="p.items?.[0]?.picUrl"
                :src="p.items[0].picUrl"
                referrerpolicy="no-referrer"
                class="img-preview"
                alt=""
              />
            </div>
            <div class="record-main">
              <div class="record-line1">
                <span class="record-store">{{ p.storeName }}</span>
                <span
                  class="link mono record-posting"
                  title="点击跳转订单处理页全局搜索"
                  @click="jumpToOrderProcess(p)"
                >{{ p.postingNumber }}</span>
                <button
                  class="copy-btn"
                  title="复制货件号"
                  @click.stop="copyText(p.postingNumber, '货件号')"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" /></svg>
                </button>
              </div>
              <div class="record-line" :title="WEIGHT_SOURCE_LABELS[p.weightSource] || ''">
                称重 {{ p.weightG != null ? Math.floor(p.weightG) + 'g' : '—' }}
              </div>
              <div class="record-line">打印发货 {{ fmtTime(p.waybillPrintedAt) }}</div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.scan-ship-page {
  padding: 20px 24px 24px;
  max-width: 1440px;
  margin: 0 auto;
}

/* ── ① 扫描输入区(sticky 置顶)── */
.scan-bar-wrap {
  position: sticky;
  top: 0;
  z-index: 10;
}
.scan-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
}
.scan-mode {
  min-width: 76px;
}
.printer-select {
  max-width: 190px;
  min-width: 96px;
  font-size: 12px;
  padding: 5px 6px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.scan-input {
  flex: 1;
  height: 46px;
  padding: 0 16px;
  border: 2px solid var(--border);
  border-radius: 8px;
  font-size: 17px;
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  background: #fff;
  color: var(--text);
  transition: border-color 0.15s;
}
.scan-input:hover {
  border-color: #c7cdd6;
}
.scan-input:focus,
.scan-input:focus-visible {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}
.scan-input[readonly] {
  background: #f9fafb;
}
.scan-btn {
  height: 46px;
  padding: 0 24px;
  font-size: 15px;
}
.agent-dot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.agent-dot::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d1d5db;
}
.agent-dot.on {
  color: var(--success);
}
.agent-dot.on::before {
  background: var(--success);
}
.agent-dot.off {
  color: var(--warning);
}
.agent-dot.off::before {
  background: var(--warning);
}

/* ── ② 结果横幅 ── */
.scan-banner {
  margin-top: 12px;
  padding: 10px 16px;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 500;
}
.banner-ok {
  background: #d1fae5;
  color: #059669;
}
.banner-err {
  background: #fee2e2;
  color: var(--danger);
}
.banner-info {
  background: #dbeafe;
  color: #1d4ed8;
}

/* ── 主体分栏 ── */
.scan-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 16px;
  margin-top: 12px;
  align-items: start;
}
@media (max-width: 1100px) {
  .scan-body {
    grid-template-columns: 1fr;
  }
}

/* ── ③ 结果卡片 ── */
.results-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.pkg-card {
  position: relative;
  padding: 14px 16px 14px 20px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.pkg-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  border-radius: var(--radius) 0 0 var(--radius);
  background: transparent;
}
.pkg-card:hover {
  border-color: #c7cdd6;
}
.pkg-card.selected {
  background: #eff6ff;
  border-color: var(--primary);
}
.pkg-card.selected::before {
  background: var(--primary);
}
.pkg-card.disabled {
  cursor: default;
  opacity: 0.65;
}
.pkg-card.shipped {
  cursor: default;
}

/* 订单信息(三行,黑色字体) */
.pkg-order {
  color: var(--text);
  display: flex;
  flex-direction: column;
  gap: 3px;
  /* 2026-09-17 布局:订单级信息横贯卡片顶部,与下方 产品/采购 两列虚线分隔 */
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border);
  margin-bottom: 10px;
}
.order-line {
  font-size: 13px;
  color: var(--text);
}
/* 最迟发货剩余时间(2026-09-17):已超时=红加粗 / <24h=红 / <48h=橙 */
.ship-remain {
  font-weight: 600;
}
.ship-remain.remain-warn {
  color: #d97706;
}
.ship-remain.remain-urg {
  color: #dc2626;
}
.ship-remain.remain-over {
  color: #dc2626;
  font-weight: 700;
}
/* ── 订单标签 chip(只读;与货件号同行,2026-09-17;与订单处理页同 8 色 hash 口径)── */
.ship-tag {
  margin: 1px 4px 1px 0;
  padding: 1px 7px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  max-width: 220px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  background: var(--tag-bg, #e0e7ff);
  color: var(--tag-fg, #4338ca);
}
.ship-tag.tag-c0 { --tag-bg: #e0e7ff; --tag-fg: #4338ca; }
.ship-tag.tag-c1 { --tag-bg: #d1fae5; --tag-fg: #065f46; }
.ship-tag.tag-c2 { --tag-bg: #fef3c7; --tag-fg: #92400e; }
.ship-tag.tag-c3 { --tag-bg: #ffe4e6; --tag-fg: #9f1239; }
.ship-tag.tag-c4 { --tag-bg: #e0f2fe; --tag-fg: #075985; }
.ship-tag.tag-c5 { --tag-bg: #ede9fe; --tag-fg: #5b21b6; }
.ship-tag.tag-c6 { --tag-bg: #fce7f3; --tag-fg: #9d174d; }
.ship-tag.tag-c7 { --tag-bg: #ccfbf1; --tag-fg: #115e59; }
/* 订单备注(只读;本地录入或妙手同步;单行省略,悬浮看全文) */
.order-note {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: #92400e;
  background: #fde68a;
  border-radius: 5px;
  padding: 2px 8px;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.order-line1 {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.order-store {
  font-size: 14px;
  font-weight: 600;
}
.order-posting {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
/* 金额与利润计算块(商品/采购信息下方整行):首行订单金额+利润,次行公式,末行利润率 */
.profit-block {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: #fafbfc;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.profit-row {
  min-width: 0;
}
.profit-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--text);
}
.profit-label b {
  font-size: 14px;
}
.profit-final {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.profit-final b {
  font-size: 16px;
}
.formula {
  font-size: 12.5px;
  color: var(--text);
  word-break: break-all;
  font-variant-numeric: tabular-nums;
  line-height: 1.6;
}
.profit-pos {
  color: var(--success);
}
.profit-neg {
  color: var(--danger);
}

.pkg-products {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.product-item {
  display: flex;
  gap: 12px;
  align-items: center;
}
.product-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.product-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
/* 数量独立右列:字体加大,>1 时红色(2026-09-15:>1 字号翻倍至 40px 加粗) */
.product-qty {
  margin-left: auto;
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.qty-multi {
  color: var(--danger);
  font-size: 40px;
  font-weight: 800;
}
/* 复制按钮 */
.copy-btn {
  border: none;
  background: transparent;
  color: #9ca3af;
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  align-items: center;
  border-radius: 4px;
  flex-shrink: 0;
}
.copy-btn:hover {
  color: var(--primary);
  background: #eff6ff;
}
.copy-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.35);
}
/* 两列布局:左=订单+商品 / 右=采购 */
.pkg-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 14px;
}
.pkg-left {
  min-width: 0;
}
.pkg-right {
  min-width: 0;
  border-left: 1px dashed var(--border);
  padding-left: 14px;
}
.pkg-right-label {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 8px;
}
/* 左列"产品信息"标签(2026-09-17 布局:与右列"采购信息"对称) */
.pkg-left-label {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 8px;
}
@media (max-width: 900px) {
  .pkg-grid {
    grid-template-columns: 1fr;
  }
  .pkg-right {
    border-left: none;
    padding-left: 0;
    border-top: 1px dashed var(--border);
    padding-top: 10px;
  }
}

/* 140x140 缩略图(商品图/采购图,2026-09 要求) + 悬浮放大预览 */
.thumb140 {
  width: 140px;
  height: 140px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #fff;
  flex-shrink: 0;
  display: block;
}
.thumb-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 12px;
}
.img-hover-wrap {
  position: relative;
  flex-shrink: 0;
}
/* 图片详情页链接(订单商品/采购商品;a 包裹 img,inline-flex 保住 140px 方图布局) */
.img-link {
  text-decoration: none;
  color: inherit;
  display: inline-flex;
  min-width: 0;
}
/* 采购订单详情页链接(单号;蓝色示意可点,口径同 OrderProcess) */
.order-link {
  text-decoration: none;
  color: #3b82f6;
}
.order-link:hover {
  text-decoration: underline;
}
/* SKU 链接(Ozon 商品详情页;2026-09-17) */
.sku-link {
  text-decoration: none;
  color: #3b82f6;
}
.sku-link:hover {
  text-decoration: underline;
}
.img-preview {
  display: none;
  position: absolute;
  left: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%);
  width: 280px;
  height: 280px;
  object-fit: contain;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  z-index: 30;
  pointer-events: none;
}
.img-hover-wrap:hover .img-preview {
  display: block;
}

.pkg-purchases {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.purchase-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.purchase-imgs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  flex-shrink: 0;
  max-width: 300px; /* 2 列 140 图(140×2+6) */
}
.purchase-more {
  align-self: center;
}
.purchase-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.purchase-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  flex-wrap: wrap;
}

/* 操作条 */
.pkg-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
/* 参考重量(Ozon后台/本系统,未设置显示—) */
.ref-weight {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  cursor: help;
}
.weight-label {
  font-size: 13px;
  color: var(--text);
  font-weight: 500;
  white-space: nowrap;
}
.weight-input {
  width: 150px;
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 16px;
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-variant-numeric: tabular-nums;
  text-align: right;
  background: #fff;
  color: var(--text);
  transition: border-color 0.15s;
}
.weight-input:focus,
.weight-input:focus-visible {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}
.weight-input:disabled {
  background: #f3f4f6;
  cursor: not-allowed;
  opacity: 0.7;
}
.weight-input.weight-invalid {
  border-color: var(--danger);
}
/* 更正重量输入框(已交运卡片内联,略窄) */
.correct-input {
  width: 120px;
  height: 34px;
  font-size: 15px;
}
.weight-err {
  margin: 6px 0 0;
  font-size: 12px;
}
.ship-btn {
  height: 40px;
  padding: 0 20px;
  font-size: 14px;
}

/* ── ④ 发货记录 ── */
.records-col {
  padding: 14px 16px;
  position: sticky;
  top: 86px;
}
.records-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.record-tabs {
  display: flex;
  gap: 4px;
}
.tab-btn {
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  touch-action: manipulation;
}
.tab-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.35);
  border-radius: 6px 6px 0 0;
}
.tab-btn:hover {
  color: var(--text);
}
.tab-btn.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
  font-weight: 500;
}
.tab-count {
  display: inline-block;
  min-width: 18px;
  padding: 0 5px;
  margin-left: 4px;
  border-radius: 8px;
  background: #f3f4f6;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
}
.tab-btn.active .tab-count {
  background: #dbeafe;
  color: var(--primary);
}
.records-empty {
  padding: 28px 0;
  font-size: 13px;
}
/* 记录列表滚动区(2026-09-16):不分页一次拉全量,限高内部滚动 */
.records-list {
  max-height: 380px;
  min-height: 120px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.record-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 2px;
  border-bottom: 1px solid #f3f4f6;
}
.record-row:last-of-type {
  border-bottom: none;
}
.record-thumb {
  width: 70px;
  height: 70px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #fff;
  flex-shrink: 0;
}
.record-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 2px;
}
.record-line1 {
  display: flex;
  align-items: center;
  gap: 6px;
}
.record-store {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}
.record-posting {
  font-size: 13px;
}
.record-line {
  font-size: 12px;
  color: var(--muted);
}

.mono {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
}
.sub {
  font-size: 12px;
}
</style>
