<template>
  <view class="page">
    <!-- 搜索区 -->
    <view class="search-box">
      <input
        class="search-input"
        v-model="keyword"
        placeholder="搜 SKU / OfferID / 商品ID / 标题"
        placeholder-class="ph"
        confirm-type="search"
        @confirm="doSearch"
      />
      <text v-if="keyword" class="search-clear" @click="clearSearch">×</text>
    </view>
    <view class="hint">改价按「成本利润率」自动计算建议价(向上取整到整数元),划线价=新价×2</view>

    <!-- 搜索结果 -->
    <view v-if="rows.length" class="list">
      <view v-for="row in rows" :key="row.sku" class="card">
        <view class="card-head">
          <text class="sku" @click.stop="copyText(row.sku, 'SKU')">{{ row.sku }}</text>
          <text class="store" v-if="row.store_name">{{ row.store_name }}</text>
          <text class="sync-btn" @click.stop="onSync(row)">同步</text>
        </view>
        <view class="title">{{ row.title || '—' }}</view>
        <view class="meta">
          <text v-if="row.offer_id" class="meta-item">OfferID {{ row.offer_id }}</text>
          <text v-if="row.product_id" class="meta-item">商品ID {{ row.product_id }}</text>
        </view>

        <view class="info-grid">
          <view class="info-item"><text class="k">现价</text><text class="v price">{{ fmtPrice(row.price) }}</text></view>
          <view class="info-item"><text class="k">建议价</text><text class="v suggest">{{ fmtPrice(suggestedPrice(row)) }}</text></view>
          <view class="info-item"><text class="k">采购成本</text><text class="v">{{ fmtPrice(row.custom_purchase_price) }}</text></view>
          <view class="info-item"><text class="k">重量</text><text class="v">{{ row.weight_g != null ? Math.floor(row.weight_g) + 'g' : '—' }}</text></view>
          <view class="info-item"><text class="k">划线价</text><text class="v">{{ row.old_price != null ? fmtPrice(row.old_price) : '—' }}</text></view>
          <view class="info-item"><text class="k">现成本利润</text><text class="v" :class="rateClass(currentCostRate(row))">{{ fmtRate(currentCostRate(row)) }}</text></view>
        </view>

        <!-- 目标成本利润率选择(12档,默认100%) -->
        <view class="rate-line">
          <text class="rate-label">目标利润率</text>
          <picker mode="selector" :range="RATE_LABELS" @change="onRatePick(row, $event)">
            <view class="rate-chip">{{ (rateChoices[row.sku] ?? DEFAULT_TARGET_RATE) }}% ▾</view>
          </picker>
        </view>

        <!-- 操作按钮 -->
        <view class="card-actions">
          <button
            class="mini-btn primary"
            :disabled="updatingSku === row.sku || !canTarget(row)"
            @click.stop="applyTargetPrice(row)"
          >{{ updatingSku === row.sku ? '提交中…' : '按目标率改价' }}</button>
          <button
            class="mini-btn"
            :disabled="updatingSku === row.sku"
            @click.stop="roundUpPrice(row)"
          >取整</button>
        </view>
        <view v-if="!canTarget(row)" class="hint-warn">需同时有采购成本与重量才能按目标率定价</view>
      </view>
    </view>

    <view v-if="loading" class="empty">加载中…</view>
    <view v-if="!loading && !rows.length" class="empty">
      {{ searchedOnce ? '未找到商品' : '输入 SKU / OfferID / 商品ID / 标题后搜索' }}
    </view>
    <view v-if="rows.length && rows.length >= total" class="end-tip">— 共 {{ total }} 条,已全部加载 —</view>
  </view>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import { getPriceList, updatePrice, syncPrices } from '../../api/price-manage.js';
import { fmtMoney } from '../../utils/fmt.js';

const TARGET_RATES = [50, 60, 70, 80, 90, 100, 110, 120, 140, 160, 180, 200];
const DEFAULT_TARGET_RATE = 100;
const RATE_LABELS = TARGET_RATES.map((r) => r + '%');
const COMMISSION_RATE = 0.16;
const DELIVERY_BASE_CNY = 3.37;
const DELIVERY_PER_G_CNY = 0.0281;

const keyword = ref('');
const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const searchedOnce = ref(false);
const updatingSku = ref('');
const rateChoices = reactive({});

function fmtPrice(n) {
  return n == null ? '—' : fmtMoney(n);
}
function fmtRate(n) {
  return n == null ? '—' : Number(n).toFixed(1) + '%';
}
function copyText(val, label) {
  const s = String(val || '').trim();
  if (!s) return;
  uni.setClipboardData({ data: s, success: () => uni.showToast({ title: (label || '') + '已复制', icon: 'none' }) });
}
function selRate(row) {
  return rateChoices[row.sku] || DEFAULT_TARGET_RATE;
}
function canTarget(row) {
  return Number(row.custom_purchase_price) > 0 && Number(row.weight_g) > 0;
}
function suggestedPrice(row) {
  const rate = selRate(row);
  const purchase = Number(row.custom_purchase_price);
  const w = Number(row.weight_g);
  if (!(purchase > 0) || !(w > 0)) return null;
  const delivery = DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * w;
  return Math.ceil((purchase * (1 + rate / 100) + delivery) / (1 - COMMISSION_RATE));
}
function currentCostRate(row) {
  const price = Number(row.price);
  const purchase = Number(row.custom_purchase_price);
  const w = Number(row.weight_g);
  if (!(price > 0) || !(purchase > 0)) return null;
  const commission = price * COMMISSION_RATE;
  const delivery = w > 0 ? DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * w : 0;
  const profit = price - commission - delivery - purchase;
  return (profit / purchase) * 100;
}
function rateClass(v) {
  if (v == null) return '';
  return v >= 0 ? 'rate-pos' : 'rate-neg';
}

async function doSearch() {
  const kw = keyword.value.trim();
  if (!kw || loading.value) return;
  loading.value = true;
  searchedOnce.value = true;
  rows.value = [];
  total.value = 0;
  try {
    const data = await getPriceList({ keyword: kw, page: 1, pageSize: 30 });
    rows.value = data?.items || data?.rows || data?.list || [];
    total.value = data?.total ?? rows.value.length;
  } catch (e) {
    /* request.js 已 toast */
  } finally {
    loading.value = false;
  }
}
function clearSearch() {
  keyword.value = '';
  rows.value = [];
  searchedOnce.value = false;
  total.value = 0;
}
function onRatePick(row, e) {
  rateChoices[row.sku] = TARGET_RATES[Number(e.detail.value)] ?? DEFAULT_TARGET_RATE;
}

async function applyTargetPrice(row) {
  if (updatingSku.value) return;
  const rate = selRate(row);
  const newPrice = suggestedPrice(row);
  if (newPrice == null) return;
  const old = row.price;
  const ok = await new Promise((resolve) => {
    uni.showModal({
      title: '按目标率改价',
      content: `SKU ${row.sku}\n${old != null ? `¥${old}` : '无现价'} → ¥${newPrice}\n目标成本利润率 ${rate}%\n划线价将设为 ¥${newPrice * 2}`,
      confirmText: '改价',
      success: (res) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
  if (!ok) return;
  updatingSku.value = row.sku;
  try {
    await updatePrice({ sku: row.sku, newPrice, targetRate: rate / 100 });
    row.price = newPrice;
    row.old_price = Math.round(newPrice * 2 * 100) / 100;
    uni.showToast({ title: '改价已提交,30秒后自动回读校准', icon: 'none', duration: 2500 });
  } catch (e) {
    /* request.js 已 toast */
  } finally {
    updatingSku.value = '';
  }
}

async function roundUpPrice(row) {
  if (updatingSku.value) return;
  const price = Number(row.price);
  if (!(price > 0) || !Number.isFinite(price)) {
    uni.showToast({ title: '当前无现价', icon: 'none' });
    return;
  }
  const newPrice = Math.ceil(price);
  if (newPrice === price) {
    uni.showToast({ title: '现价已是整数,无需取整', icon: 'none' });
    return;
  }
  const ok = await new Promise((resolve) => {
    uni.showModal({
      title: '价格取整',
      content: `SKU ${row.sku}\n现价 ¥${price.toFixed(2)} → ¥${newPrice}\n划线价将设为 ¥${newPrice * 2}(手动改价,不按目标率)`,
      confirmText: '取整',
      success: (res) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
  if (!ok) return;
  updatingSku.value = row.sku;
  try {
    await updatePrice({ sku: row.sku, newPrice });
    row.price = newPrice;
    row.old_price = newPrice * 2;
    uni.showToast({ title: '取整已提交,30秒后自动回读校准', icon: 'none', duration: 2500 });
  } catch (e) {
    /* request.js 已 toast */
  } finally {
    updatingSku.value = '';
  }
}

async function onSync(row) {
  if (!row.store_id) {
    uni.showToast({ title: '该商品无店铺信息,无法同步', icon: 'none' });
    return;
  }
  uni.showLoading({ title: '同步指令已提交', mask: true });
  try {
    await syncPrices(row.store_id);
    uni.showToast({ title: '价格同步已触发,稍后下拉刷新', icon: 'none' });
  } catch (e) {
    /* request.js 已 toast */
  } finally {
    uni.hideLoading();
  }
}

onLoad(() => {});
onPullDownRefresh(async () => {
  if (keyword.value.trim()) await doSearch();
  uni.stopPullDownRefresh();
});
</script>

<style scoped>
.page {
  padding: 20rpx 24rpx 60rpx;
}
.search-box {
  display: flex;
  align-items: center;
  background: #ffffff;
  border-radius: 16rpx;
  padding: 6rpx 16rpx;
}
.search-input {
  flex: 1;
  height: 72rpx;
  font-size: 28rpx;
  color: #1f2329;
}
.ph { color: #a6abb3; }
.search-clear {
  font-size: 36rpx;
  color: #c9cdd4;
  padding: 0 8rpx;
}
.hint {
  margin-top: 10rpx;
  font-size: 21rpx;
  color: #86909c;
  line-height: 1.5;
}
.hint-warn {
  margin-top: 10rpx;
  font-size: 21rpx;
  color: #d97706;
}
.list {
  margin-top: 16rpx;
}
.card {
  background: #ffffff;
  border-radius: 18rpx;
  padding: 20rpx;
  margin-bottom: 20rpx;
}
.card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.sku {
  font-size: 28rpx;
  font-weight: 600;
  color: #165dff;
  font-family: 'Courier New', monospace;
}
.store {
  font-size: 20rpx;
  color: #4e5969;
  background: #f2f3f5;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
  margin-left: 10rpx;
}
.sync-btn {
  margin-left: auto;
  font-size: 22rpx;
  color: #165dff;
  background: #eef4ff;
  padding: 4rpx 16rpx;
  border-radius: 999rpx;
}
.title {
  margin-top: 10rpx;
  font-size: 25rpx;
  color: #1f2329;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.meta {
  margin-top: 6rpx;
  display: flex;
  flex-wrap: wrap;
  gap: 0 16rpx;
}
.meta-item {
  font-size: 21rpx;
  color: #86909c;
}
.info-grid {
  margin-top: 14rpx;
  display: flex;
  flex-wrap: wrap;
  background: #f7f8fa;
  border-radius: 12rpx;
  padding: 12rpx;
}
.info-item {
  width: 33.33%;
  display: flex;
  flex-direction: column;
  padding: 6rpx 8rpx;
  box-sizing: border-box;
}
.info-item .k {
  font-size: 20rpx;
  color: #86909c;
}
.info-item .v {
  margin-top: 2rpx;
  font-size: 25rpx;
  font-weight: 600;
  color: #1f2329;
  font-variant-numeric: tabular-nums;
}
.info-item .v.price { color: #1f2329; }
.info-item .v.suggest { color: #165dff; }
.rate-pos { color: #00b42a; }
.rate-neg { color: #f53f3f; }

.rate-line {
  margin-top: 14rpx;
  display: flex;
  align-items: center;
}
.rate-label {
  font-size: 23rpx;
  color: #4e5969;
}
.rate-chip {
  margin-left: 12rpx;
  font-size: 25rpx;
  color: #165dff;
  background: #eef4ff;
  padding: 6rpx 20rpx;
  border-radius: 999rpx;
  font-weight: 600;
}
.card-actions {
  margin-top: 14rpx;
  display: flex;
  gap: 12rpx;
}
.mini-btn {
  flex: 1;
  font-size: 24rpx;
  line-height: 1;
  padding: 0 20rpx;
  height: 64rpx;
  border-radius: 10rpx;
  background: #f2f3f5;
  color: #4e5969;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mini-btn::after { border: none; }
.mini-btn.primary {
  background: #165dff;
  color: #ffffff;
}
.mini-btn[disabled] { opacity: 0.6; }

.empty {
  text-align: center;
  padding: 80rpx 0;
  color: #a6abb3;
  font-size: 26rpx;
}
.end-tip {
  text-align: center;
  color: #a6abb3;
  font-size: 22rpx;
  padding: 16rpx 0;
}
</style>