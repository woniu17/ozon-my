<template>
  <view class="page" v-if="pkg || batchMode">
    <!-- 顶部:包裹摘要(单包裹) / 批量目标概览 -->
    <view class="card">
      <template v-if="batchMode">
        <view class="head-line">
          <text class="store">批量录采购</text>
          <text class="posting">{{ batchTargets.length }} 个目标包裹</text>
        </view>
        <view class="head-sub">勾选平台订单后一次性关联到全部目标包裹,分摊按各包裹商品数量自动加权</view>
      </template>
      <template v-else>
        <view class="head-line">
          <text class="store">{{ pkg.storeName }}</text>
          <text class="posting">{{ pkg.postingNumber }}</text>
        </view>
        <view class="head-sub">{{ items.length }} 个商品行 · 采购合计 {{ fmtMoney(profitTotal.alloc) }}</view>
      </template>
    </view>

    <!-- Step2:平台订单选择(从主视图「+ 从平台订单选择」进入) -->
    <view v-if="step === 'select'">
      <view class="card">
        <view class="section-title">选择平台订单</view>
        <!-- 平台×账号 tabs(多账号展开,与 web 端一致) -->
        <scroll-view class="plat-tabs" scroll-x :show-scrollbar="false">
          <view class="plat-tabs-inner">
            <view
              v-for="t in platTabs"
              :key="t.key"
              class="plat-tab"
              :class="{ on: activeTabKey === t.key }"
              @click="switchPlatTab(t.key)"
            >{{ t.label }}</view>
          </view>
        </scroll-view>

        <!-- 登录态警示:恢复登录需在服务器/电脑端操作 -->
        <view v-if="curPlatLogin !== 'yes'" class="login-warn">
          {{ curTabDef ? curTabDef.label : '当前平台' }}未检测到登录态,可能拉不到订单。恢复登录需在服务器/电脑端操作。
        </view>

        <!-- 状态子 tab + 刷新 -->
        <view class="subtabs">
          <view
            v-for="sb in subTabs"
            :key="sb.key"
            class="subtab"
            :class="{ on: curStore.tab === sb.key }"
            @click="switchSubTab(sb.key)"
          >{{ sb.label }}</view>
          <view class="subtab refresh" @click="refreshOrders">刷新</view>
        </view>

        <!-- 按单号精确搜索(跨账号);2026-09-28 聚焦模式:命中后只显示命中订单,✕ 清除恢复 -->
        <view class="imp-search">
          <input
            class="imp-search-input"
            v-model="searchKeyword"
            placeholder="按采购单号精确搜索(跨账号)"
            confirm-type="search"
            @confirm="doSearch"
          />
          <view v-if="curStore.searched.length" class="imp-search-clear" @click="clearSearch">✕</view>
        </view>

        <!-- 订单列表 -->
        <view v-if="curStore.loading" class="muted-line pad">加载中…</view>
        <view v-else-if="curStore.error" class="err-line pad">{{ curStore.error }}</view>
        <view v-else-if="!impOrders.length" class="muted-line pad">暂无订单(可尝试刷新或搜索)</view>
        <view
          v-for="o in impOrders"
          :key="o.orderSn"
          class="po-order"
          :class="{ sel: curStore.selected.includes(o.orderSn), disabled: isRestoredLinked(o) }"
          @click="toggleSelect(o)"
        >
          <view class="po-check">{{ curStore.selected.includes(o.orderSn) ? '☑' : '☐' }}</view>
          <image
            v-if="o.goods && o.goods[0] && o.goods[0].thumbUrl"
            class="po-order-img"
            :src="o.goods[0].thumbUrl"
            mode="aspectFill"
            lazy-load
          />
          <view v-else class="po-order-img"></view>
          <view class="po-order-main">
            <view class="po-order-title">
              {{ (o.goods && o.goods[0] && o.goods[0].goodsName) || '—' }}<text v-if="o.goods && o.goods.length > 1" class="po-more"> 等{{ o.goods.length }}件商品</text>
            </view>
            <view class="po-order-meta">
              <!-- 已勾选单:金额可手改(实际采购价格;分摊仍按数量加权自动算);未勾选只读 -->
              <input
                v-if="curStore.selected.includes(o.orderSn) && !isRestoredLinked(o)"
                class="po-amt-edit"
                type="digit"
                :value="o.amount"
                @click.stop
                @input="onOrderAmountInput(o, $event)"
              />
              <text v-else class="po-order-amt">¥{{ o.amount }}</text>
              <text class="po-order-time">{{ fmtOrderTime(o) }}</text>
            </view>
            <view class="po-order-sn">{{ o.orderSn }}<text v-if="o.trackingNumber"> · {{ o.trackingNumber }}</text></view>
            <!-- PDD 已勾选单优惠勾选(2026-09-28):默认全选计入采购金额,点击逐项取消;
                 列表单先显示"优惠合计",勾选后自动拉详情页逐项明细 -->
            <view
              v-if="curStore.selected.includes(o.orderSn) && o._platform === 'yangkeduo' && ((o.promotions && o.promotions.length) || o._promoLoading)"
              class="po-promos"
              @click.stop
            >
              <view class="po-promos-head">
                <text class="po-promos-label">优惠</text>
                <text class="po-promo-tip">计入采购金额</text>
                <text v-if="o._promoLoading" class="po-promo-loading">明细加载中…</text>
              </view>
              <view
                v-for="(p, pi) in o.promotions"
                :key="pi"
                class="po-promo"
                :class="{ off: !p.checked }"
                @click.stop="togglePromo(o, pi)"
              >
                <text>{{ p.checked ? '☑' : '☐' }}</text>
                <text class="po-promo-desc">{{ p.description }}</text>
                <text class="po-promo-amt">+¥{{ p.amount }}</text>
              </view>
              <view v-if="o.promotionNotes && o.promotionNotes.length" class="po-promo-notes">活动:{{ o.promotionNotes.join('；') }}</view>
            </view>
          </view>
          <text v-if="isRestoredLinked(o)" class="restored-badge">已关联</text>
        </view>
      </view>

      <!-- 底部条:已选统计 + 返回/下一步 -->
      <view class="action-bar">
        <view class="sel-info">
          <text class="sel-count">已选 {{ selCount }} 单</text>
          <text class="sel-total">合计 ¥{{ newSelectedTotal }}</text>
        </view>
        <button class="abtn ghost" @click="backFromSelect">返回</button>
        <button class="abtn primary" :disabled="!selCount" @click="goStep3">下一步</button>
      </view>
    </view>

    <!-- Step3:分摊确认 + 提交(批量模式:目标包裹清单 + 批量关联) -->
    <view v-else-if="step === 'confirm'">
      <view class="card">
        <view class="section-title">{{ batchMode ? '批量关联确认' : '分摊确认' }}</view>

        <!-- 已选订单摘要 -->
        <view class="sum-box">
          <view class="sum-line">
            <text class="po-platform">{{ platformLabel(step3Platform) }}</text>
            <text class="sum-count">已选 {{ selCount }} 单</text>
            <text class="sum-total">¥{{ newSelectedTotal }}</text>
          </view>
          <view class="sum-sns">
            <view v-for="o in step3Sel" :key="o.orderSn" class="sum-sn">{{ o.orderSn }} · ¥{{ Number(o.amount || 0).toFixed(2) }}</view>
          </view>
          <!-- 拼单提示(lookup 查到已关联包裹时) -->
          <view v-if="lookupResult && lookupResult.linkedPackages && lookupResult.linkedPackages.length" class="lookup-tip">
            采购单已关联 {{ lookupResult.linkedPackages.length }} 个包裹,本次为追加关联;auto 模式下已关联 auto 包裹的 {{ autoPreview.existingAutoQty }} 件将参与加权分摊。
          </view>
        </view>

        <!-- 目标包裹(批量模式):已选采购订单将关联到以下全部包裹,可逐个移除 -->
        <view v-if="batchMode" class="batch-targets">
          <view class="bt-head">目标包裹 <b>{{ batchTargets.length }}</b> 个 · 分摊金额按各包裹商品数量自动加权</view>
          <view v-for="t in batchTargets" :key="t.id" class="bt-row">
            <text class="bt-store">{{ t.storeName }}</text>
            <text class="bt-posting">{{ t.postingNumber }}</text>
            <text class="bt-cnt">{{ (t.items || []).length }} 行</text>
            <text class="bt-del" @click="removeBatchTarget(t)">✕</text>
          </view>
          <view v-if="!batchTargets.length" class="bt-empty">已移除全部目标包裹,请返回上一页重新发起批量录采购</view>
        </view>

        <!-- auto 只读加权预览(2026-09-28 与 web 端同步:分摊恒按数量加权,手动改价在订单层) -->
        <template v-if="!batchMode">
          <view class="tip">
            各产品行金额 = 已有采购分摊 + 新订单 ¥{{ newSelectedTotal }} 按数量加权分摊{{ autoPreview.existingAutoQty ? '(加权总数 ' + autoPreview.sumQty + ' 件 = 本包裹 ' + autoPreview.currentQty + ' + 已关联 ' + autoPreview.existingAutoQty + ')' : '' }}。
          </view>
          <view v-for="(it, i) in autoPreview.rows" :key="i" class="alloc-row">
            <image v-if="it.picUrl" class="alloc-img" :src="it.picUrl" mode="aspectFill" />
            <view v-else class="alloc-img"></view>
            <view class="alloc-main">
              <view class="alloc-title">{{ it.title || '—' }}</view>
              <view class="alloc-sub">SKU {{ it.sku || '—' }} ×{{ it.quantity }}</view>
              <view class="alloc-amount">¥{{ it.previewAmount.toFixed(2) }}</view>
            </view>
          </view>
        </template>
        <!-- 批量模式:分摊由后端按各包裹商品数量重算,无需逐行预览 -->
        <view v-else class="tip">
          各包裹的分摊金额由后端按其商品数量加权重算;已关联过的组合按当前金额更新,不会重复建关联、不会双算金额。
        </view>

        <!-- 预估利润合计(本次分摊口径;提交后可在采购管理卡中按 SKU 一键调价) -->
        <view v-if="!batchMode" class="pe-preview">
          预估利润 <b :class="{ neg: step3Profit.profit < 0 }">¥{{ step3Profit.profit.toFixed(2) }}</b>
          <text class="pe-preview-sub">按分摊 ¥{{ step3Profit.alloc.toFixed(2) }} 估算{{ step3Profit.allWeighted ? '' : ',部分行未扣配送' }}</text>
        </view>

        <!-- 国内快递单号(选填,预填平台单号) -->
        <view v-if="!batchMode" class="field">
          <text class="field-label">国内快递单号(选填)</text>
          <input class="field-input" v-model="logisticsInput" placeholder="多个用英文逗号分隔,留空待同步补全" />
        </view>
      </view>
      <view class="action-bar">
        <button class="abtn ghost" @click="backFromConfirm">返回</button>
        <button
          class="abtn primary"
          :disabled="saving || (batchMode && !batchTargets.length)"
          @click="collectAdd"
        >{{ batchMode ? '关联 ' + batchTargets.length + ' 个包裹' : '确认' }}</button>
      </view>
    </view>

    <!-- 默认视图:采购管理(已有采购直接展示,删除为暂存标记,统一保存落地) -->
    <view v-else>
      <view class="card">
        <view class="section-head">
          <view class="section-title">已有采购({{ groups.length }})</view>
        </view>
        <view v-if="!groups.length && !pendingAdd" class="muted-line">尚无采购关联,可从平台订单选择新增</view>
        <view
          v-for="g in groups"
          :key="g.purchaseOrderId"
          class="po"
          :class="{ removing: pendingRemoves.includes(g.purchaseOrderId) }"
        >
          <view class="po-head">
            <text class="po-platform">{{ platformLabel(g.platform) }}</text>
            <text class="po-sn">{{ g.purchaseSn || '#' + g.purchaseOrderId }}</text>
            <text class="po-status">{{ poStatusLabel(g.poStatus) }}</text>
          </view>
          <view class="po-meta">
            <text class="po-amt">分摊 {{ fmtMoney(g.allocated) }}</text>
            <text v-if="g.buyerAccount" class="po-meta-item">买:{{ g.buyerAccount }}</text>
          </view>
          <view v-for="(pi, j) in g.items" :key="j" class="po-goods">
            <image
              v-if="pi.thumbUrl || pi.picUrl"
              class="po-img"
              :src="pi.thumbUrl || pi.picUrl"
              mode="aspectFill"
              lazy-load
            />
            <view v-else class="po-img"></view>
            <view class="po-goods-main">
              <view class="po-goods-title">{{ pi.goodsName || pi.title || '采购商品' }}</view>
              <view class="po-goods-sub">{{ pi.spec ? pi.spec + ' · ' : '' }}¥{{ pi.price ?? '—' }} × {{ pi.number || pi.num || 1 }}</view>
            </view>
          </view>
          <!-- 国内物流:当前单号/未录入 + 录入/修改入口(闲鱼等无物流接口平台,即时生效) -->
          <view class="po-logi-row">
            <view v-if="g.poLogisticsNo" class="po-logi">
              <text class="po-logi-company">{{ g.poLogisticsCompany }}</text>
              <text class="po-logi-no">{{ g.poLogisticsNo }}</text>
            </view>
            <view v-else class="po-logi-empty">未录物流单号</view>
            <button
              v-if="!pendingRemoves.includes(g.purchaseOrderId)"
              class="mini-btn"
              @click="openLogiEdit(g)"
            >{{ g.poLogisticsNo ? '修改' : '录入' }}</button>
          </view>
          <!-- 物流单号录入面板(单号 + 快递公司 picker,卡片内展开) -->
          <view v-if="logiEdit.poId === g.purchaseOrderId" class="logi-edit">
            <view class="logi-field">
              <text class="logi-label">物流单号</text>
              <input class="logi-input" v-model="logiEdit.no" placeholder="必填,多个用英文逗号分隔" />
            </view>
            <view class="logi-field">
              <text class="logi-label">快递公司</text>
              <picker mode="selector" :range="LOGI_COMPANY_RANGE" @change="onLogiCompanyPick">
                <view class="logi-picker" :class="{ ph: !logiEdit.company }">{{ logiEdit.company || '选填,点击选择' }}</view>
              </picker>
            </view>
            <view class="logi-actions">
              <button class="mini-btn" @click="closeLogiEdit">取消</button>
              <button class="mini-btn primary" :disabled="logiEdit.saving" @click="saveLogi(g)">
                {{ logiEdit.saving ? '保存中…' : '保存' }}
              </button>
            </view>
          </view>
          <view class="po-actions">
            <button v-if="!pendingRemoves.includes(g.purchaseOrderId)" class="mini-btn danger" @click="toggleRemove(g)">删除</button>
            <button v-else class="mini-btn" @click="toggleRemove(g)">恢复</button>
          </view>
        </view>

      </view>

      <!-- 订单产品 + 单价调整(合并卡片,与 Web 端同布局:上=产品信息,下=折叠的调整对比;分摊=将保存口径) -->
      <view v-if="profitRows.length" class="card">
        <view v-for="p in profitRows" :key="p.itemId" class="po2-card">
          <!-- 产品信息:图 | 名称+SKU/OfferID | 数量 | 售价/采购价 -->
          <view class="po2-info">
            <image v-if="p.picUrl" class="po2-img" :src="p.picUrl" mode="aspectFill" />
            <view v-else class="po2-img"></view>
            <view class="po2-main">
              <view class="po2-name">{{ p.title && p.title.length > 15 ? p.title.slice(0, 15) + '…' : (p.title || '—') }}</view>
              <view class="po2-code">{{ p.sku || '—' }}</view>
              <view class="po2-code">{{ p.offerId || '—' }}</view>
            </view>
            <view class="po2-qty">× {{ p.qty }}</view>
            <view class="po2-prices">
              <view class="po2-price-row"><text class="po2-price-label">售价</text><text class="po2-price-val">¥{{ (p.price * p.qty).toFixed(2) }}</text></view>
              <view class="po2-price-row"><text class="po2-price-label">采购价</text><text class="po2-price-val">¥{{ p.alloc.toFixed(2) }}</text></view>
            </view>
          </view>
          <!-- 单价调整(默认折叠,点击展开;单件口径) -->
          <view class="po2-cmp">
            <view class="po2-cmp-toggle" @click="toggleCmp(p.sku)">
              <text class="po2-cmp-caret">{{ cmpExpanded[p.sku] ? '▾' : '▸' }}</text>
              <text class="po2-cmp-title">单价调整</text>
              <picker v-if="cmpExpanded[p.sku]" class="po2-rate-pick" mode="selector" :range="RATE_LABELS" :value="Math.max(0, RATE_OPTIONS.indexOf(p.rate))" @click.stop @change="onRatePick(p, $event)">
                <view class="pe-rate-chip">{{ p.rate }}%</view>
              </picker>
              <button
                v-if="cmpExpanded[p.sku]"
                class="mini-btn primary"
                :disabled="!p.canAdjust || adjustingSku === p.sku"
                @click.stop="adjustSkuPrice(p)"
                >{{ adjustingSku === p.sku ? '调价中…' : '调价' }}</button>
            </view>
            <block v-if="cmpExpanded[p.sku]">
              <view class="po2-cmp-rows">
                <view class="po2-cmp-tr">
                  <text class="po2-cmp-label">销售单价</text>
                  <text class="po2-cmp-old">{{ p.listingPrice != null ? p.listingPrice.toFixed(2) : '—' }}</text>
                  <text class="po2-cmp-arrow">→</text>
                  <text class="po2-cmp-new">{{ p.suggested != null ? p.suggested : '—' }}</text>
                </view>
                <view class="po2-cmp-tr">
                  <text class="po2-cmp-label">ozon佣金</text>
                  <text class="po2-cmp-old">{{ p.oldCommission != null ? p.oldCommission.toFixed(2) : '—' }}</text>
                  <text class="po2-cmp-arrow">→</text>
                  <text class="po2-cmp-new">{{ p.newCommission != null ? p.newCommission.toFixed(2) : '—' }}</text>
                </view>
                <view class="po2-cmp-tr">
                  <text class="po2-cmp-label">国际物流费</text>
                  <text class="po2-cmp-old">{{ p.unitDelivery != null ? p.unitDelivery.toFixed(2) : '—' }}</text>
                  <text class="po2-cmp-arrow"></text>
                  <text class="po2-cmp-new"></text>
                </view>
                <view class="po2-cmp-tr">
                  <text class="po2-cmp-label">利润</text>
                  <text class="po2-cmp-old" :class="{ neg: p.oldProfit < 0 }">{{ p.oldProfit != null ? p.oldProfit.toFixed(2) : '—' }}</text>
                  <text class="po2-cmp-arrow">→</text>
                  <text class="po2-cmp-new" :class="{ neg: p.newProfit < 0 }">{{ p.newProfit != null ? p.newProfit.toFixed(2) : '—' }}</text>
                </view>
                <view class="po2-cmp-tr">
                  <text class="po2-cmp-label">成本利润率</text>
                  <text class="po2-cmp-old" :class="{ neg: p.oldProfit < 0 }">{{ p.oldRateC != null ? (p.oldRateC * 100).toFixed(1) + '%' : '—' }}</text>
                  <text class="po2-cmp-arrow">→</text>
                  <text class="po2-cmp-new" :class="{ neg: p.newProfit < 0 }">{{ p.newRateC != null ? (p.newRateC * 100).toFixed(1) + '%' : '—' }}</text>
                </view>
              </view>
              <view v-if="!p.canAdjust" class="pe-why">{{ p.missingWhy }}</view>
            </block>
          </view>
        </view>
        <view class="pe-total">
          采购合计 ¥{{ profitTotal.alloc.toFixed(2) }} · 预估利润合计 <b :class="{ neg: profitTotal.profit < 0 }">¥{{ profitTotal.profit.toFixed(2) }}</b><text v-if="profitTotal.rateC != null"> · 成本利润率 {{ profitTotal.rateC.toFixed(1) }}%</text>
        </view>
      </view>

      <!-- 待新增采购(Step3 确认后暂存,保存时落地) -->
      <view v-if="pendingAdd" class="card">
        <view class="section-title">待新增采购</view>
        <view class="po pending-add">
          <!-- 多笔订单逐笔展示(一笔订单=一个采购单),不再用顿号拼接 -->
          <view v-for="od in pendingAdd.orders" :key="od.purchaseSn" class="po-head">
            <text class="po-platform">{{ platformLabel(pendingAdd.body.platform) }}</text>
            <text class="po-sn">{{ od.purchaseSn || '(无单号)' }}</text>
            <text class="po-amt">¥{{ Number(od.paymentAmount || 0).toFixed(2) }}</text>
            <text class="badge-new">新增</text>
          </view>
          <view class="po-meta">
            <text class="po-amt" v-if="pendingAdd.orders.length > 1">合计 ¥{{ Number(pendingAdd.body.paymentAmount || 0).toFixed(2) }}</text>
            <text class="po-meta-item">{{ pendingAdd.orders.length > 1 ? pendingAdd.orders.length + ' 笔 · ' : '' }}自动 · 按数量分摊</text>
          </view>
          <view class="po-actions">
            <button class="mini-btn danger" @click="discardAdd">移除</button>
          </view>
        </view>
      </view>

      <view class="card">
        <view class="add-entry" @click="enterSelect">+ 从平台订单选择</view>
        <view class="tip-inline">订单金额可手改:勾选订单后直接改金额(实际采购价与平台金额不符时用),各包裹/SKU 分摊仍按数量自动加权。</view>
      </view>

      <view class="action-bar">
        <button class="abtn white" :disabled="saving || !dirty" @click="doSave()">
          {{ saving ? '保存中…' : '保 存' }}
        </button>
        <button class="abtn primary" :disabled="saving || !dirty || !canShipAfterSave" @click="doSave(true)">
          {{ saving ? '处理中…' : '保存并备货' }}
        </button>
      </view>
    </view>
  </view>

  <view v-else class="page">
    <view class="empty">{{ loadError || '加载中…' }}</view>
  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import {
  getOrderDetail,
  unlinkPurchase,
  clearPurchaseInfo,
  submitPurchase,
  lookupPurchase,
  updatePurchaseLogistics,
  shipPackage,
  getPlatformOrders,
  searchPlatformOrder,
  getPlatformOrdersStatus,
  getPddPromotions,
} from '../../api/order.js';
import { getSkusInfo, setSkuCustoms, updatePrice } from '../../api/price-manage.js';
import { fmtMoney, fmtTime } from '../../utils/fmt.js';

const packageId = ref('');
const pkg = ref(null);
const items = ref([]);
const links = ref([]);
const loadError = ref('');
const saving = ref(false);
// 暂存变更(统一保存落地,2026-09-19):
//   pendingRemoves: 标记删除的已有采购单 purchaseOrderId
//   pendingAdd: Step3 确认的新增采购(存 submitPurchase body + 拼单 lookup 结果)
const pendingRemoves = ref([]);
const pendingAdd = ref(null);
const dirty = computed(
  () => pendingRemoves.value.length > 0 || !!pendingAdd.value
);

// ════════════════════════════════════════════════════════════
// 批量录采购(2026-09-28 与 web 端 saveBatchLink 同步):
// orders 列表勾选多个包裹进入,选好采购订单后一次性关联到全部目标包裹
// ════════════════════════════════════════════════════════════
const batchMode = ref(false);
const batchTargets = ref([]); // {id, storeName, postingNumber, items}
// 逐个拉取目标包裹详情(商品行用于后端 auto 加权重算)
async function loadBatchTargets(ids) {
  for (const id of ids) {
    try {
      const d = await getOrderDetail(id);
      batchTargets.value.push({
        id,
        storeName: d?.package?.storeName || '',
        postingNumber: d?.package?.postingNumber || '',
        items: d?.items || [],
      });
    } catch (e) { /* 单个拉取失败跳过,不影响其余目标 */ }
  }
  if (!batchTargets.value.length) {
    uni.showToast({ title: '目标包裹加载失败', icon: 'none' });
    setTimeout(() => uni.navigateBack(), 800);
  }
}
function removeBatchTarget(t) {
  batchTargets.value = batchTargets.value.filter((x) => x.id !== t.id);
}
// select step 返回:批量模式退回列表页,单包裹回管理视图
function backFromSelect() {
  if (batchMode.value) uni.navigateBack();
  else step.value = 'manage';
}
// confirm step 返回:批量模式回选单,单包裹回管理视图
function backFromConfirm() {
  if (batchMode.value) step.value = 'select';
  else step.value = 'manage';
}

// ── 标签映射(与详情页/ web 端同步)────────────────────────
const PLATFORM_LABELS = {
  '1688': '1688',
  ali1688: '1688',
  pdd: '拼多多',
  yangkeduo: '拼多多',
  taobao: '淘宝',
  xianyu: '闲鱼',
  other: '手工(其他)',
};
function platformLabel(p) {
  return PLATFORM_LABELS[p] || p || '—';
}

const PO_STATUS_LABELS = {
  wait_pay: '待付款',
  wait_send: '待发货',
  shipped: '已发货',
  part_shipped: '部分发货',
  signed: '已签收',
  finished: '已完成',
  closed: '已关闭',
};
function poStatusLabel(s) {
  return PO_STATUS_LABELS[s] || s || '—';
}

// 行级 link 按 purchaseOrderId 分组成"已有采购单"(与 web 端 restoredPurchases 同构)
const groups = computed(() => {
  const byPo = new Map();
  for (const l of links.value) {
    if (!byPo.has(l.purchaseOrderId)) byPo.set(l.purchaseOrderId, []);
    byPo.get(l.purchaseOrderId).push(l);
  }
  return [...byPo.values()].map((ls) => {
    const first = ls[0];
    return {
      purchaseOrderId: first.purchaseOrderId,
      platform: first.platform,
      purchaseSn: first.purchaseSn,
      poStatus: first.poStatus,
      allocated: ls.reduce((s, l) => s + (Number(l.allocatedAmount) || 0), 0),
      buyerAccount: first.buyerAccount,
      sellerName: first.sellerName,
      items: first.items || [],
      poLogisticsNo: first.poLogisticsNo,
      poLogisticsCompany: first.poLogisticsCompany,
    };
  });
});

// ── 数据加载 ────────────────────────────────────────────────
async function loadDetail() {
  loadError.value = '';
  try {
    const d = await getOrderDetail(packageId.value);
    pkg.value = d?.package || null;
    items.value = d?.items || [];
    links.value = d?.purchaseLinks || [];
    if (!pkg.value) loadError.value = '包裹不存在';
    loadSkuPricing(); // 利润预估/调价所需的 SKU 定价信息
  } catch (e) {
    loadError.value = e.message || '加载失败';
  }
}

function notifyRefresh() {
  // 通知订单列表页刷新(tab 计数 + 列表)
  uni.$emit('orders-refresh');
}

// ── 删除标记(暂存,保存时统一落地)─────────────────────────
function toggleRemove(g) {
  const i = pendingRemoves.value.indexOf(g.purchaseOrderId);
  if (i >= 0) pendingRemoves.value.splice(i, 1);
  else pendingRemoves.value.push(g.purchaseOrderId);
}

// ════════════════════════════════════════════════════════════
// 已有采购单手动录入/修改国内物流单号(2026-09-20,闲鱼等无物流接口平台)
// 独立操作即时生效,不依赖底部「保存」;后端联动 wait_send→shipped
// ════════════════════════════════════════════════════════════
const LOGI_COMPANY_RANGE = ['(不填)', '顺丰速运', '中通快递', '圆通速递', '韵达快递', '申通快递', '极兔速递', '邮政快递包裹', '京东物流', '德邦物流', 'EMS'];
const logiEdit = reactive({ poId: 0, no: '', company: '', saving: false });

function openLogiEdit(g) {
  logiEdit.poId = g.purchaseOrderId;
  logiEdit.no = g.poLogisticsNo || '';
  logiEdit.company = g.poLogisticsCompany || '';
  logiEdit.saving = false;
}
function closeLogiEdit() {
  logiEdit.poId = 0;
}
function onLogiCompanyPick(e) {
  const i = Number(e.detail.value);
  logiEdit.company = i === 0 ? '' : LOGI_COMPANY_RANGE[i];
}
async function saveLogi(g) {
  if (logiEdit.saving) return;
  const no = String(logiEdit.no || '').trim();
  if (!no) {
    uni.showToast({ title: '请填写物流单号', icon: 'none' });
    return;
  }
  logiEdit.saving = true;
  try {
    await updatePurchaseLogistics({
      purchaseOrderId: g.purchaseOrderId,
      logisticsNo: no,
      logisticsCompany: logiEdit.company.trim(),
    });
    uni.showToast({ title: '物流单号已保存', icon: 'none' });
    closeLogiEdit();
    await loadDetail(); // 已有采购展示刷新(状态联动已发货)
  } catch (e) {
    /* 错误 toast 已由 request.js 统一弹出 */
  } finally {
    logiEdit.saving = false;
  }
}

// ════════════════════════════════════════════════════════════
// 利润预估与一键调价(2026-09-20,口径同价格管理单件)
// 常量镜像 profit-estimator.js(服务端单点维护,前端预览)
// ════════════════════════════════════════════════════════════
const PM_COMMISSION_RATE = 0.16;
const PM_DELIVERY_BASE_CNY = 3.37;
const PM_DELIVERY_PER_G_CNY = 0.0281;
const RATE_OPTIONS = [50, 60, 70, 80, 90, 100, 110, 120, 140, 160, 180, 200]; // 目标成本利润率(%)
const RATE_LABELS = RATE_OPTIONS.map((r) => r + '%');
const DEFAULT_RATE = 90;

const skuPricing = ref({});   // sku → 定价信息(现价/重量/缓存命中)
const poRates = reactive({}); // sku → 目标率(未选默认 50%)
const adjustingSku = ref('');

async function loadSkuPricing() {
  const skus = [...new Set(items.value.map((it) => it.sku).filter(Boolean))];
  if (!skus.length) { skuPricing.value = {}; return; }
  try {
    const list = await getSkusInfo(skus);
    const map = {};
    for (const r of list || []) map[r.sku] = r;
    skuPricing.value = map;
  } catch (e) {
    console.warn('[profit-est] skus-info failed', e);
  }
}

function unitDeliveryOf(weightG) {
  const w = Number(weightG);
  if (!(w > 0)) return null;
  return PM_DELIVERY_BASE_CNY + PM_DELIVERY_PER_G_CNY * w;
}

// 单行利润(单件口径:佣金 16% + 单件配送×数量;无重量不扣配送标"估")
function calcProfit(it, alloc) {
  const qty = Number(it.quantity) || 0;
  const price = Number(it.price) || 0;
  const unitDelivery = unitDeliveryOf(skuPricing.value[it.sku]?.weightG);
  const revenue = price * qty;
  const commission = revenue * PM_COMMISSION_RATE;
  const delivery = unitDelivery != null ? unitDelivery * qty : null;
  const profit = revenue - commission - (delivery || 0) - alloc;
  return {
    profit: Math.round(profit * 100) / 100,
    profitRateCost: alloc > 0 ? Math.round((profit / alloc) * 10000) / 100 : null,
    delivery,
  };
}

// manage 视图:每行有效分摊(与将保存口径一致)
// 有 pendingAdd(待新增采购暂存)时直接用其分摊值——auto 模式下它已是"未删除已有 + 新增加权"的行总额;
// 否则 = 未删除已有采购的行分摊合计
const profitRows = computed(() => {
  const keptByItem = new Map();
  if (pendingAdd.value) {
    for (const it of pendingAdd.value.body.items || []) {
      keptByItem.set(it.itemId, (keptByItem.get(it.itemId) || 0) + (Number(it.amount) || 0));
    }
  } else {
    for (const l of links.value) {
      if (pendingRemoves.value.includes(l.purchaseOrderId)) continue;
      keptByItem.set(l.ozonOrderItemId, (keptByItem.get(l.ozonOrderItemId) || 0) + (Number(l.allocatedAmount) || 0));
    }
  }
  return items.value.map((it) => {
    const alloc = Math.round((keptByItem.get(it.id) || 0) * 100) / 100;
    const qty = Number(it.quantity) || 0;
    const price = Number(it.price) || 0;
    const info = skuPricing.value[it.sku] || null;
    const unitCost = qty > 0 ? alloc / qty : 0;
    const unitDelivery = unitDeliveryOf(info?.weightG);
    const rate = poRates[it.sku] || DEFAULT_RATE;
    const base = calcProfit(it, alloc);
    const suggested = unitCost > 0 && unitDelivery != null
      ? Math.ceil((unitCost * (1 + rate / 100) + unitDelivery) / (1 - PM_COMMISSION_RATE))
      : null;
    // 单价调整对比(单件口径,与 Web 端一致):调整前=当前上架价,调整后=建议价
    const oldPrice = info?.price ?? null;
    const oldCommission = oldPrice != null ? oldPrice * PM_COMMISSION_RATE : null;
    const newCommission = suggested != null ? suggested * PM_COMMISSION_RATE : null;
    const oldProfit = oldPrice != null && unitDelivery != null
      ? Math.round((oldPrice * (1 - PM_COMMISSION_RATE) - unitDelivery - unitCost) * 100) / 100 : null;
    const newProfit = suggested != null && unitDelivery != null
      ? Math.round((suggested * (1 - PM_COMMISSION_RATE) - unitDelivery - unitCost) * 100) / 100 : null;
    const oldRateC = oldProfit != null && unitCost > 0 ? Math.round((oldProfit / unitCost) * 1000) / 1000 : null;
    const newRateC = newProfit != null && unitCost > 0 ? Math.round((newProfit / unitCost) * 1000) / 1000 : null;
    return {
      itemId: it.id, sku: it.sku, offerId: it.offerId, title: it.title, picUrl: it.picUrl,
      qty, price, alloc, rate, ...base,
      listingPrice: oldPrice, suggested, unitCost, unitDelivery,
      oldCommission, newCommission, oldProfit, newProfit, oldRateC, newRateC,
      canAdjust: !!(it.sku && unitCost > 0 && unitDelivery != null && info?.inCache && info?.hasProductId),
      missingWhy: !it.sku ? '订单商品缺 SKU'
        : unitCost <= 0 ? '分摊金额为 0'
        : unitDelivery == null ? 'SKU 未维护重量(价格管理)'
        : !info?.inCache ? '不在价格缓存'
        : !info?.hasProductId ? '缺少 product_id'
        : '',
    };
  });
});

const profitTotal = computed(() => {
  const alloc = Math.round(profitRows.value.reduce((s, p) => s + p.alloc, 0) * 100) / 100;
  const profit = Math.round(profitRows.value.reduce((s, p) => s + p.profit, 0) * 100) / 100;
  return {
    alloc,
    profit,
    rateC: alloc > 0 ? Math.round((profit / alloc) * 1000) / 10 : null, // 成本利润率%(1位小数)
  };
});

// 单价调整折叠(默认收起,按 SKU 记忆展开状态)
const cmpExpanded = reactive({});
function toggleCmp(sku) { cmpExpanded[sku] = !cmpExpanded[sku]; }

// Step3 预览:按将保存的分摊(auto 加权预览)估合计利润
const step3Profit = computed(() => {
  const rows = autoPreview.value.rows;
  let profit = 0;
  let allocSum = 0;
  let allWeighted = true;
  for (let i = 0; i < items.value.length; i++) {
    const alloc = Number(rows[i]?.previewAmount ?? rows[i]?.amount) || 0;
    allocSum += alloc;
    const r = calcProfit(items.value[i], alloc);
    if (r.delivery == null) allWeighted = false;
    profit += r.profit;
  }
  return { alloc: Math.round(allocSum * 100) / 100, profit: Math.round(profit * 100) / 100, allWeighted };
});

function onRatePick(p, e) {
  poRates[p.sku] = RATE_OPTIONS[Number(e.detail.value)];
}

// 一键调价:先同步成本基准(本单分摊单价)再走价格管理改价(服务端按基准复算校验)
function adjustSkuPrice(p) {
  if (adjustingSku.value || p.suggested == null || !p.canAdjust) return;
  const rate = p.rate;
  const cur = p.listingPrice;
  uni.showModal({
    title: `调整 SKU ${p.sku} 上架价格`,
    content: `现价 ${cur != null ? '¥' + cur : '无'} → 新价 ¥${p.suggested}(目标成本利润率 ${rate}%,划线价 ¥${p.suggested * 2})\n将同步更新成本基准:采购价 ¥${Math.round(p.unitCost * 100) / 100}\n只影响后续新订单,已下单包裹价格不变`,
    confirmText: '调整',
    success: async (res) => {
      if (!res.confirm) return;
      adjustingSku.value = p.sku;
      try {
        // 1) 成本基准 = 本单分摊单价(price-update 服务端复算校验的前提)
        await setSkuCustoms(p.sku, { purchasePrice: Math.round(p.unitCost * 100) / 100 });
        // 2) 目标率改价(限频/日志/30s 回读均复用价格管理链路)
        await updatePrice({ sku: String(p.sku), newPrice: p.suggested, targetRate: rate / 100 });
        uni.showToast({ title: '改价已提交,30秒后回读校准', icon: 'none', duration: 2500 });
        await loadSkuPricing(); // 刷新现价显示
      } catch (e) {
        /* 错误 toast 已由 request.js 统一弹出 */
      } finally {
        adjustingSku.value = '';
      }
    },
  });
}

// ════════════════════════════════════════════════════════════
// Step2:平台订单选择(与 web 端 OrderProcess.vue 同构,2026-09-13 多账号模型)
// ════════════════════════════════════════════════════════════
// 平台 tab 元数据:platform(请求用)→ platformVal(入库平台值)/label
const PLATFORM_TAB_META = {
  pdd: { platformVal: 'yangkeduo', label: '拼多多' },
  ali1688: { platformVal: '1688', label: '1688' },
  taobao: { platformVal: 'taobao', label: '淘宝' },
  xianyu: { platformVal: 'xianyu', label: '闲鱼' },
};

const step = ref('manage'); // manage=采购管理(默认) | select=选平台订单 | confirm=分摊确认
// 默认 tabs(/status 未返回时兜底,与 web 端一致)
const platTabs = ref([
  { key: 'pdd', platform: 'pdd', account: 'linqx', label: '拼多多' },
  { key: 'ali:linqx', platform: 'ali1688', account: 'linqx', label: '1688·linqx' },
  { key: 'taobao', platform: 'taobao', account: 'linqx', label: '淘宝' },
  { key: 'xianyu', platform: 'xianyu', account: 'linqx', label: '闲鱼' },
]);
const platLogin = reactive({}); // `${platform}:${account}` → 'yes'|'no'|'unknown'
const stores = reactive({});    // tabKey → { orders, loading, error, tab, selected, searched }
const activeTabKey = ref('');
const searchKeyword = ref('');

function storeFor(key) {
  if (!stores[key]) {
    stores[key] = { orders: [], loading: false, error: '', tab: 'all', selected: [], searched: [] };
  }
  return stores[key];
}

const curTabDef = computed(() => platTabs.value.find((t) => t.key === activeTabKey.value) || null);
const curStore = computed(() => storeFor(activeTabKey.value));
const curPlatLogin = computed(() => {
  const d = curTabDef.value;
  return d ? platLogin[d.platform + ':' + d.account] || 'unknown' : 'unknown';
});

// 状态子 tab(pdd 无"待发货",与 web 端一致)
const subTabs = computed(() => {
  const p = curTabDef.value?.platform || '';
  if (p === 'pdd') {
    return [{ key: 'all', label: '全部' }, { key: 'unreceived', label: '待收货' }];
  }
  // 闲鱼列表接口 orderStatus 仅支持全量,只留"全部"(与 web 端一致)
  if (p === 'xianyu') return [{ key: 'all', label: '全部' }];
  return [{ key: 'all', label: '全部' }, { key: 'unshipped', label: '待发货' }, { key: 'unreceived', label: '待收货' }];
});

// 已有采购单的 SN 键集合(逗号拼接的 SN 拆开),平台列表里标记"已关联"并禁止重复勾选
const restoredSnKeys = computed(() => {
  const s = new Set();
  for (const g of groups.value) {
    for (const part of String(g.purchaseSn || '').split(',')) {
      const p = part.trim();
      if (p) s.add(g.platform + ':' + p);
    }
  }
  return s;
});

function isRestoredLinked(o) {
  const plat = PLATFORM_TAB_META[curTabDef.value?.platform]?.platformVal || '';
  return restoredSnKeys.value.has(plat + ':' + o.orderSn);
}

// 当前 tab 订单(2026-09-28 搜索聚焦:有命中时只显示命中订单,✕ 清除恢复完整列表;注入 _platform)
const impOrders = computed(() => {
  const st = curStore.value;
  const plat = PLATFORM_TAB_META[curTabDef.value?.platform]?.platformVal || '';
  const wrap = (o) => (o._platform === plat ? o : { ...o, _platform: plat });
  if (st.searched.length) {
    const bySn = new Map(st.orders.map((o) => [o.orderSn, o]));
    return st.searched.map((o) => wrap(bySn.get(o.orderSn) || o));
  }
  return st.orders.map(wrap);
});

// 清除搜索聚焦,恢复完整订单列表
function clearSearch() {
  const st = curStore.value;
  if (st) st.searched = [];
  searchKeyword.value = '';
}

// 跨平台×账号合并的新勾选订单(排除已关联单);提交时只入库新增部分
const newSelectedOrders = computed(() => {
  const sel = [];
  for (const t of platTabs.value) {
    const st = stores[t.key];
    if (!st) continue;
    const inList = new Set((st.orders || []).map((o) => o.orderSn));
    const merged = [...(st.searched || []).filter((x) => !inList.has(x.orderSn)), ...(st.orders || [])];
    for (const o of merged) {
      if (
        st.selected.includes(o.orderSn) &&
        !restoredSnKeys.value.has((PLATFORM_TAB_META[t.platform]?.platformVal || '') + ':' + o.orderSn)
      ) {
        sel.push({ ...o, _platform: PLATFORM_TAB_META[t.platform]?.platformVal, _account: t.account });
      }
    }
  }
  return sel;
});
const selCount = computed(() => newSelectedOrders.value.length);
const newSelectedTotal = computed(() =>
  newSelectedOrders.value.reduce((s, o) => s + (Number(o.amount) || 0), 0).toFixed(2)
);

// 浏览器登录态探测 + 按账号展开平台 tabs(与 web 端 rebuildAccountTabs 一致)
async function loadPlatformStatus() {
  try {
    const data = await getPlatformOrdersStatus();
    const tabs = [];
    for (const [platform, meta] of Object.entries(PLATFORM_TAB_META)) {
      const accounts = Object.keys(data?.platforms?.[platform]?.accounts || {});
      if (!accounts.length) continue; // 后端未配置该平台 → 保留默认
      const multi = accounts.length > 1;
      for (const account of accounts) {
        const prefix = platform === 'ali1688' ? 'ali' : platform;
        tabs.push({
          key: multi ? prefix + ':' + account : prefix,
          platform,
          account,
          label: multi ? meta.label + '·' + account : meta.label,
        });
      }
    }
    if (tabs.length) {
      platTabs.value = tabs;
      if (!tabs.some((t) => t.key === activeTabKey.value)) activeTabKey.value = tabs[0].key;
    }
    for (const [plat, info] of Object.entries(data?.platforms || {})) {
      for (const [account, v] of Object.entries(info?.accounts || {})) {
        platLogin[plat + ':' + account] = v?.login || 'unknown';
      }
    }
  } catch (e) {
    /* 静默:探测失败不阻塞主流程 */
  }
}

// 拉取指定 tab 的订单(懒建 store;刷新列表保留搜索命中单的勾选)
async function loadOrders(tabKey) {
  const def = platTabs.value.find((t) => t.key === tabKey);
  if (!def) return;
  const st = storeFor(tabKey);
  st.loading = true;
  st.error = '';
  const keepSn = new Set(st.searched.map((o) => o.orderSn));
  st.selected = st.selected.filter((s) => keepSn.has(s));
  try {
    const data = await getPlatformOrders(def.platform, { tab: st.tab, size: 30, account: def.account });
    // PDD 列表单(2026-09-28):后端 amount 已是默认口径(实付+优惠合计);
    // 此处补伪优惠条目供勾选(lazy 标记=仅合计无明细,勾选后按需拉详情页逐项明细)
    st.orders = def.platform === 'pdd'
      ? (data?.orders || []).map((o) => normalizePddPromoOrder(o))
      : (data?.orders || []);
  } catch (e) {
    st.error = e.message || '获取订单失败';
    st.orders = [];
  } finally {
    st.loading = false;
  }
}

// ── PDD 采购优惠勾选(2026-09-28,与 web 端 OrderProcess.vue 同口径)──
// 采购金额默认=实付+全部优惠(默认全选),选单卡片上可逐项取消某项/多项;
// 搜索单后端已带逐项明细 promotions,列表单初始仅有"优惠合计"伪条目(lazy 标记),
// 勾选该单后 ensurePromoDetail 调 /pdd/promotions 拉详情页明细替换伪条目
function normalizePddPromoOrder(o) {
  const n = { ...o };
  if (Array.isArray(n.promotions)) {
    n.promotions = n.promotions.map((p) => ({ ...p, checked: true }));
  } else {
    const disc = Number(n.discountAmount) || 0;
    n.promotions = disc > 0 ? [{ description: '优惠合计', amount: disc.toFixed(2), checked: true, lazy: true }] : [];
  }
  return n;
}

/** 按勾选状态重算订单有效金额:实付 + 勾选优惠合计(手动指定过采购价的订单不重算,以手改值为准) */
function recalcPddAmount(src) {
  if (src._amountManual) return;
  const base = Number(src.paidAmount ?? src.amount ?? 0) || 0;
  const add = (src.promotions || []).reduce((s, p) => s + (p.checked ? (Number(p.amount) || 0) : 0), 0);
  src.amount = (base + add).toFixed(2);
}

/** 列表/搜索区展示的是 store 订单的浅拷贝,勾选/明细回写需定位源订单对象 */
function findSourceOrder(platformVal, orderSn) {
  for (const t of platTabs.value) {
    if ((PLATFORM_TAB_META[t.platform]?.platformVal || '') !== platformVal) continue;
    const st = stores[t.key];
    if (!st) continue;
    const src = [...(st.searched || []), ...(st.orders || [])].find((x) => x.orderSn === orderSn);
    if (src) return src;
  }
  return null;
}

/** 手动指定某笔采购单的采购价格(2026-09-28,与 web 端同步):回写源订单并打手动标记,
 *  此后该笔的优惠勾选不再重算金额(以手改值为准);分摊仍走 auto 按数量加权。
 *  自由输入不做格式强转(避免输入 "61." 被折回 "61"),提交时统一按 Number 解析 */
function onOrderAmountInput(o, ev) {
  const src = findSourceOrder(o._platform, o.orderSn);
  const raw = String(ev.detail.value).replace(/[^\d.]/g, '');
  if (src) {
    src._amountManual = true;
    src.amount = raw;
  }
}

/** 优惠条目点击切换勾选(拷贝与源单共享 promotions 对象):翻转勾选后重算源单金额
 *  合计(newSelectedTotal)/分摊预览/提交体均按 o.amount 计算,自动联动 */
function togglePromo(o, pi) {
  const p = o.promotions && o.promotions[pi];
  if (!p) return;
  p.checked = !p.checked;
  const src = findSourceOrder(o._platform, o.orderSn);
  if (src) recalcPddAmount(src);
}

// 已尝试过明细拉取的订单(成功/失败都算,防反复请求;失败保留"优惠合计"条目兜底)
const promoDetailFetched = new Set();
/** 列表单(伪"优惠合计"条目)被勾选后按需拉取详情页逐项优惠明细:
 *  成功→替换伪条目(加载期间已手动取消过合计则新明细默认全不选,尊重取消意图) */
async function ensurePromoDetail(o) {
  if (!o || promoDetailFetched.has(o.orderSn)) return;
  if (!Array.isArray(o.promotions) || !o.promotions.some((p) => p.lazy)) return; // 搜索单已带明细
  promoDetailFetched.add(o.orderSn);
  const src = findSourceOrder(o._platform, o.orderSn);
  const account = o._account || curTabDef.value?.account;
  if (src) src._promoLoading = true;
  try {
    const data = await getPddPromotions(o.orderSn, account);
    const items = (data?.promotions || []).map((p) => ({ description: p.description, amount: p.amount, checked: true }));
    if (src && items.length) {
      const keepOff = src.promotions.some((p) => !p.checked);
      src.promotions = items.map((p) => ({ ...p, checked: !keepOff }));
      src.promotionNotes = data?.promotionNotes || [];
      recalcPddAmount(src);
    }
  } catch (e) { /* 拉取失败:保留"优惠合计"单条勾选兜底 */ }
  finally {
    if (src) { src._promoLoading = false; recalcPddAmount(src); }
  }
}

function enterSelect() {
  step.value = 'select';
  // 每次进入选单重置搜索聚焦(对齐 web 打开弹窗重置),从完整列表开始
  for (const t of platTabs.value) {
    const st = stores[t.key];
    if (st) st.searched = [];
  }
  searchKeyword.value = '';
  if (!activeTabKey.value) activeTabKey.value = platTabs.value[0]?.key || '';
  if (!Object.keys(platLogin).length) loadPlatformStatus();
  const st = storeFor(activeTabKey.value);
  if (!st.orders.length && !st.loading) loadOrders(activeTabKey.value);
}

function switchPlatTab(key) {
  if (activeTabKey.value === key || curStore.value.loading) return;
  activeTabKey.value = key;
  searchKeyword.value = '';
  const st = storeFor(key);
  if (!st.orders.length && !st.loading) loadOrders(key);
}

function switchSubTab(t) {
  if (curStore.value.tab === t || curStore.value.loading) return;
  curStore.value.tab = t;
  loadOrders(activeTabKey.value);
}

function refreshOrders() {
  loadOrders(activeTabKey.value);
}

// 按采购单号精确搜索(后端跨账号);命中置顶且刷新列表不丢
async function doSearch() {
  const kw = searchKeyword.value.trim();
  const def = curTabDef.value;
  if (!kw || !def) return;
  const st = curStore.value;
  st.loading = true;
  st.error = '';
  try {
    const data = await searchPlatformOrder(def.platform, kw);
    const found = data?.result;
    if (found) {
      // 字段对齐:后端搜索返回 orderAmount,前端表格/保存逻辑用 amount(与 web 端 OrderProcess.vue 同口径)
      // PDD 单(2026-09-28):归一化优惠勾选态(默认全选),amount=后端默认口径(实付+全部优惠)
      const hit = def.platform === 'pdd'
        ? normalizePddPromoOrder({ ...found, amount: found.orderAmount ?? found.amount ?? 0 })
        : { ...found, amount: found.orderAmount ?? found.amount ?? 0 };
      st.searched = [hit, ...st.searched.filter((o) => o.orderSn !== found.orderSn)];
    } else {
      uni.showToast({ title: '未找到该采购单号', icon: 'none' });
    }
  } catch (e) {
    st.error = e.message || '搜索失败';
  } finally {
    st.loading = false;
  }
}

function toggleSelect(o) {
  if (isRestoredLinked(o)) return;
  const st = curStore.value;
  const i = st.selected.indexOf(o.orderSn);
  if (i >= 0) st.selected.splice(i, 1);
  else {
    st.selected.push(o.orderSn);
    // PDD 列表单:勾选后按需拉优惠明细(搜索单已带明细/已拉取过则内部跳过)
    if (o._platform === 'yangkeduo') ensurePromoDetail(o);
  }
}

// 平台订单时间:PDD(yangkeduo)为秒级数字需 ×1000;1688/淘宝为字符串
function fmtOrderTime(o) {
  const t = o.orderTime;
  if (t == null || t === '') return '—';
  if (o._platform === 'yangkeduo') return fmtTime(Number(t) * 1000);
  return String(t).replace('T', ' ').slice(0, 16);
}

// ════════════════════════════════════════════════════════════
// Step3:分摊确认 + 提交(与 web 端 savePurchase 语义对齐,5893fbf)
// ════════════════════════════════════════════════════════════
const lookupResult = ref(null); // 拼单查询结果(单单有效;多单拼接查询查不到则忽略)
const logisticsInput = ref(''); // 国内快递单号(选填,预填平台单号)

const step3Sel = computed(() => newSelectedOrders.value);
const step3Sn = computed(() => step3Sel.value.map((o) => o.orderSn).join(','));
const step3Platform = computed(() => step3Sel.value[0]?._platform || 'other');

// auto 模式加权预览(与 web 端 autoPreview 同构)
// 公式:每行金额 = 未删除已有采购的行分摊合计 + (该行 quantity / Σauto 关联 quantity) × 订单合计
// Σ = 本包裹各行数量 + lookup 已关联 auto 模式包裹的数量(manual 关联不参与加权)
const autoPreview = computed(() => {
  const payment = Number(newSelectedTotal.value) || 0;
  const currentQty = items.value.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  const existingAutoQty = (lookupResult.value?.linkedPackages || [])
    .filter((p) => (p.alloc_modes || '').includes('auto'))
    .reduce((s, p) => s + (Number(p.quantity) || 0), 0);
  const sumQty = currentQty + existingAutoQty;
  const round2 = (n) => Math.round(n * 100) / 100;
  // 未删除已有采购按产品行分摊合计(2026-09-19 与 web 端同步修复:
  // 此前只显示新订单加权分摊,把已有分摊顶掉了,与保存后行金额口径不一致)
  const keptByItem = new Map();
  for (const l of links.value) {
    if (pendingRemoves.value.includes(l.purchaseOrderId)) continue;
    keptByItem.set(l.ozonOrderItemId, (keptByItem.get(l.ozonOrderItemId) || 0) + (Number(l.allocatedAmount) || 0));
  }
  const rows = items.value.map((it) => ({
    itemId: it.id,
    title: it.title,
    sku: it.sku,
    picUrl: it.picUrl,
    quantity: it.quantity,
    previewAmount: round2(
      (keptByItem.get(it.id) || 0) +
      (sumQty ? ((Number(it.quantity) || 0) * payment) / sumQty : 0)
    ),
  }));
  return { rows, sumQty, payment, currentQty, existingAutoQty };
});

// 进入 Step3:重置状态 + 预填快递单号 + 拼单探测(批量模式无单包裹 lookup)
async function goStep3() {
  if (!selCount.value) return;
  step.value = 'confirm';
  lookupResult.value = null;
  if (batchMode.value) return;
  const tracks = [...new Set(step3Sel.value.map((o) => o.trackingNumber).filter(Boolean))];
  logisticsInput.value = tracks.join(',');
  const sn = step3Sn.value;
  if (step3Platform.value !== 'other' && sn) {
    try {
      const r = await lookupPurchase(step3Platform.value, sn);
      if (r?.exists) lookupResult.value = r;
    } catch (e) {
      /* 探测失败不阻塞,提交前还会再查一次 */
    }
  }
}

// ════════════════════════════════════════════════════════════
// Step3 确认 → 暂存新增采购(不落库,回主视图统一保存)
// ════════════════════════════════════════════════════════════
function collectAdd() {
  const sel = step3Sel.value;
  if (!sel.length) return;
  // 批量模式:直接执行批量关联(无暂存,逐单提交后返回列表页)
  if (batchMode.value) {
    saveBatchLink(sel);
    return;
  }
  // 产品行分摊:恒 auto 加权预览(手动改价在订单层,分摊按数量自动加权)
  const itemsArg = autoPreview.value.rows.map((it) => ({
    itemId: it.itemId,
    amount: Number(it.previewAmount) || 0,
    quantity: it.quantity,
  }));
  // 每笔平台订单独立提交体(2026-09-20 修复:多选曾把单号 join(',') 拼成一个采购单提交,
  // 产生"单号A,单号B"拼接 purchase_sn,物流同步/单号查找全部失效;现改为保存时逐单落库,
  // 一笔平台订单=一个采购单,auto 模式由后端按数量加权重算各单分摊)
  const orders = sel.map((o) => ({
    purchaseSn: o.orderSn,
    buyerAccount: o.account || o._account || o.buyerUsername || null,
    buyerUserId: o.buyerUserId || null,
    sellerName: o.mallName || o.sellerName || null,
    paymentAmount: Number(o.amount) || 0,
    logisticsCompany: o.logisticsCompany || null,
    // 单笔:保留可编辑的物流输入框值;多笔:各单用自己的快递单号
    logisticsNo: sel.length === 1 ? (logisticsInput.value.trim() || o.trackingNumber || null) : (o.trackingNumber || null),
    platformGoods: o.goods || [],
    // auto 模式金额为占位,后端按数量加权重算
    items: itemsArg,
  }));
  pendingAdd.value = {
    lookup: lookupResult.value,
    // body 仅承载公共字段+展示(purchaseSn 用'、'连接仅供展示,落库走 orders)
    body: {
      packageId: packageId.value,
      platform: step3Platform.value,
      purchaseSn: sel.map((o) => o.orderSn).join('、') || null,
      paymentAmount: Number(newSelectedTotal.value) || null,
      logisticsNo: logisticsInput.value.trim() || null,
      note: null,
      items: itemsArg,
      allocMode: 'auto',
    },
    orders,
  };
  // 清空勾选(重新进入选择时从头开始;再次确认将替换待新增)
  for (const t of platTabs.value) {
    const st = stores[t.key];
    if (st) st.selected = [];
  }
  step.value = 'manage';
  uni.showToast({ title: '已暂存,请点击保存落地', icon: 'none' });
}

// 移除暂存的新增
function discardAdd() {
  pendingAdd.value = null;
}

// ════════════════════════════════════════════════════════════
// 批量关联保存(2026-09-28,与 web 端 saveBatchLink 同步):
// 已选采购订单逐单挂到每个目标包裹(固定 auto 模式,后端按各包裹商品数量加权重算分摊;
// 后端幂等:重复提交=按当前金额更新并重新加权,不重复建关联、不双算金额)
// ════════════════════════════════════════════════════════════
async function saveBatchLink(sel) {
  if (saving.value) return;
  const targets = batchTargets.value;
  if (!targets.length) {
    uni.showToast({ title: '请至少保留一个目标包裹', icon: 'none' });
    return;
  }
  // 逐单查询已关联包裹:拼单确认提示
  const linkedLines = [];
  for (const od of sel) {
    try {
      const r = await lookupPurchase(od._platform, od.orderSn);
      for (const p of r?.linkedPackages || []) {
        linkedLines.push('  · ' + p.package_no + ' (' + p.posting_number + ') 数量' + (p.quantity || 0) + ' 分摊 ' + fmtMoney(p.allocated_amount));
      }
    } catch (e) { /* lookup 失败不阻塞提交 */ }
  }
  if (linkedLines.length) {
    const confirmed = await new Promise((resolve) => {
      uni.showModal({
        title: '已关联提示',
        content:
          '以下采购订单已关联过包裹:\n' + linkedLines.join('\n') + '\n\n本次将把 ' + sel.length + ' 笔采购订单关联到 ' + targets.length + ' 个目标包裹;其中已关联过的组合按当前金额更新,全部包裹的分摊金额将按数量重新加权计算。确认继续?',
        confirmText: '关联/更新',
        success: (res) => resolve(!!res.confirm),
      });
    });
    if (!confirmed) return;
  }
  saving.value = true;
  try {
    for (const t of targets) {
      const its = (t.items || [])
        .map((it) => ({ itemId: it.id, amount: 0, quantity: it.quantity }))
        .filter((it) => it.itemId);
      for (const od of sel) {
        await submitPurchase({
          packageId: t.id,
          platform: od._platform,
          purchaseSn: od.orderSn,
          buyerAccount: od.account || od._account || od.buyerUsername || null,
          buyerUserId: od.buyerUserId || null,
          sellerName: od.mallName || od.sellerName || null,
          paymentAmount: Number(od.amount) || 0,
          logisticsCompany: od.logisticsCompany || null,
          logisticsNo: od.trackingNumber || null,
          note: null,
          items: its,
          platformGoods: od.goods || [],
          allocMode: 'auto',
        });
      }
    }
    uni.showToast({ title: '已关联 ' + sel.length + ' 笔采购到 ' + targets.length + ' 个包裹(分摊按数量加权)', icon: 'none' });
    notifyRefresh();
    setTimeout(() => uni.navigateBack(), 800);
  } catch (e) {
    /* 错误 toast 已由 request.js 统一弹出;后端幂等,中断后可直接重试 */
  } finally {
    saving.value = false;
  }
}

// ════════════════════════════════════════════════════════════
// 统一保存:删除标记落地 + 新增采购落地(与 web 端 savePurchase 语义对齐)
// withShip=true: 保存成功后立即备货(「保存并备货」按钮)
// ════════════════════════════════════════════════════════════
async function doSave(withShip = false) {
  if (saving.value || !dirty.value) return;
  // 拼单确认(纯前端,先于任何落库;取消则中止整个保存;多单逐单查合并提示)
  const add = pendingAdd.value;
  if (add && add.body.platform !== 'other' && add.orders?.length) {
    try {
      let linkedCount = 0;
      const firstLinked = [];
      for (const od of add.orders) {
        const r = add.orders.length === 1 && add.lookup
          ? add.lookup
          : await lookupPurchase(add.body.platform, od.purchaseSn);
        if (r?.exists && r.linkedPackages?.length) {
          linkedCount++;
          for (const p of r.linkedPackages) {
            if (!firstLinked.some((x) => x.package_no === p.package_no)) firstLinked.push(p);
          }
        }
      }
      if (linkedCount) {
        const confirmed = await new Promise((resolve) => {
          uni.showModal({
            title: '拼单提示',
            content:
              '本次 ' + add.orders.length + ' 笔采购单中有 ' + linkedCount + ' 笔已关联包裹(合计 ' + firstLinked.length + ' 个包裹),本次将追加关联到本包裹(auto 模式:已关联包裹分摊金额将按数量重新加权)。是否继续?',
            confirmText: '追加关联',
            success: (res) => resolve(!!res.confirm),
          });
        });
        if (!confirmed) return;
      }
    } catch (e) {
      /* lookup 失败不阻塞保存 */
    }
  }
  saving.value = true;
  try {
    // 1) 删除标记落地(逐单冲回)
    for (const g of groups.value) {
      if (pendingRemoves.value.includes(g.purchaseOrderId)) {
        await unlinkPurchase(g.purchaseOrderId, packageId.value);
      }
    }
    // 全部删光且无新增:清残留聚合(采购状态/头程物流)
    const allRemoved =
      groups.value.length > 0 &&
      groups.value.every((g) => pendingRemoves.value.includes(g.purchaseOrderId));
    if (allRemoved && !add) await clearPurchaseInfo(packageId.value);
    // 2) 新增采购落地:逐笔平台订单分别提交(一笔订单=一个采购单,杜绝单号拼接)
    if (add && add.orders?.length) {
      for (const od of add.orders) {
        await submitPurchase({ ...add.body, ...od, purchaseSn: od.purchaseSn });
      }
    }
    uni.showToast({
      title: add?.orders?.length > 1 ? '已保存 ' + add.orders.length + ' 笔采购' : add ? '采购已保存' : '已保存',
      icon: 'none',
    });
    // 保存并备货:保存成功后向 Ozon 确认货件(多件二次确认,单件直接备货)
    if (withShip && canShipAfterSave.value) await shipAfterSave();
    notifyRefresh();
    // 返回详情页(onShow 自动刷新)
    setTimeout(() => uni.navigateBack(), 600);
  } catch (e) {
    /* 错误 toast 已由 request.js 统一弹出 */
  } finally {
    saving.value = false;
  }
}

// 保存后可备货:未交运未取消且 Ozon 侧待打包(与 web 端备货按钮同口径)
const canShipAfterSave = computed(() => {
  const p = pkg.value;
  return (
    !!p &&
    (p.operateStatus === 'wait_process' || p.operateStatus === 'wait_ship') &&
    p.ozonStatus === 'awaiting_packaging'
  );
});

// 备货(与详情页 onShip 同口径:存在数量≥2 的商品二次确认,单件直接备货)
async function shipAfterSave() {
  const multiQty = items.value.some((it) => (Number(it.quantity) || 0) >= 2);
  const qty = items.value.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  const doShip = async () => {
    try {
      const r = await shipPackage(packageId.value);
      uni.showToast({
        title: r?.pending
          ? '备货指令已提交,Ozon 状态变更中'
          : r?.alreadyShipped
            ? '该包裹已备货过'
            : '备货成功',
        icon: 'none',
      });
    } catch (e) {
      /* 备货失败不影响已保存的采购;toast 已由 request.js 弹出 */
    }
  };
  if (!multiQty) return doShip();
  return new Promise((resolve) => {
    uni.showModal({
      title: '备货确认',
      content:
        '货件 ' + (pkg.value?.postingNumber || '') + '\n含数量≥2的商品(共 ' + qty + ' 件),将向 Ozon 确认全部商品为一个货件(不拆分)。',
      confirmText: '备货',
      success: async (res) => {
        if (res.confirm) await doShip();
        resolve();
      },
    });
  });
}

onLoad((opts) => {
  // 批量录采购:orders 列表勾选多个包裹进入(ids 逗号分隔),直接进选单 step
  const ids = String((opts && opts.ids) || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (opts && opts.batch && ids.length) {
    batchMode.value = true;
    loadBatchTargets(ids);
    enterSelect();
    return;
  }
  packageId.value = String((opts && opts.id) || '');
  // 默认停留管理视图(已有采购直接展示);平台 tabs/登录态在首次进入选择视图时初始化
  loadDetail();
});
</script>

<style scoped>
.page {
  padding: 24rpx 24rpx 200rpx;
}

.card {
  background: #ffffff;
  border-radius: 18rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.head-line {
  display: flex;
  align-items: center;
}

.store {
  font-size: 24rpx;
  color: #165dff;
  background: #eef4ff;
  padding: 4rpx 12rpx;
  border-radius: 8rpx;
  margin-right: 12rpx;
}

.posting {
  font-size: 26rpx;
  color: #1f2329;
  font-family: 'Courier New', monospace;
}

.head-sub {
  margin-top: 12rpx;
  font-size: 23rpx;
  color: #86909c;
}

.section-title {
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
  margin-bottom: 16rpx;
}

/* 标题行(标题+右侧操作按钮,改分摊入口) */
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-head .section-title {
  margin-bottom: 0;
}

.section-head + .muted-line,
.section-head + .po {
  margin-top: 16rpx;
}

/* 删除标记态(暂存,保存落地前灰化提示) */
.po.removing {
  opacity: 0.55;
}

.po.removing .po-sn {
  text-decoration: line-through;
}

/* 待新增采购徽标 */
.badge-new {
  margin-left: auto;
  font-size: 20rpx;
  color: #00b42a;
  background: #e8ffea;
  border-radius: 999rpx;
  padding: 4rpx 14rpx;
}

/* 从平台订单选择入口 */
.add-entry {
  text-align: center;
  height: 84rpx;
  line-height: 84rpx;
  font-size: 27rpx;
  border-radius: 14rpx;
  background: #f0f5ff;
  border: 2rpx dashed #a8ccff;
  color: #165dff;
}

.tip-inline {
  margin-top: 14rpx;
  font-size: 21rpx;
  color: #a6abb3;
  line-height: 1.5;
}

.muted-line {
  font-size: 24rpx;
  color: #a6abb3;
}

.tip {
  font-size: 22rpx;
  color: #86909c;
  background: #f7f8fa;
  border-radius: 10rpx;
  padding: 14rpx 18rpx;
  margin-bottom: 16rpx;
  line-height: 1.6;
}

/* ── 改分摊编辑 ── */
.alloc-row {
  display: flex;
  align-items: flex-start;
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f7f8fa;
}

.alloc-img {
  width: 96rpx;
  height: 96rpx;
  border-radius: 12rpx;
  background: #f2f3f5;
  flex-shrink: 0;
}

.alloc-main {
  flex: 1;
  margin-left: 16rpx;
  overflow: hidden;
}

.alloc-title {
  font-size: 25rpx;
  color: #1f2329;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.alloc-sub {
  margin-top: 4rpx;
  font-size: 22rpx;
  color: #86909c;
}

/* ── 利润预估与调价(Step3 预览 + 采购管理卡) ── */
.pe-preview {
  margin-top: 16rpx;
  padding: 14rpx 18rpx;
  background: #f7f8fa;
  border-radius: 10rpx;
  font-size: 25rpx;
  color: #4e5969;
  line-height: 1.6;
}

.pe-preview b {
  font-size: 30rpx;
  font-weight: 600;
}

.pe-preview-sub {
  margin-left: 8rpx;
  font-size: 22rpx;
  color: #86909c;
}

/* ── 产品卡片 + 单价调整(与 Web 端同布局:上=产品信息,下=折叠对比) ── */
.po2-card {
  border: 1rpx solid #e5e6eb;
  border-radius: 16rpx;
  padding: 18rpx 20rpx;
  margin-bottom: 16rpx;
  background: #fff;
}
.po2-info {
  display: flex;
  align-items: flex-start;
}
.po2-img {
  width: 96rpx;
  height: 96rpx;
  border-radius: 12rpx;
  background: #f2f3f5;
  flex-shrink: 0;
}
.po2-main {
  flex: 1;
  min-width: 0;
  margin-left: 16rpx;
  display: flex;
  flex-direction: column;
  gap: 4rpx;
}
.po2-name {
  font-size: 25rpx;
  font-weight: 600;
  color: #1f2329;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.po2-code {
  font-size: 22rpx;
  color: #86909c;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 数量列(无标题,与产品名同行) */
.po2-qty {
  flex-shrink: 0;
  margin-left: 12rpx;
  line-height: 36rpx;
  font-size: 24rpx;
  color: #86909c;
  font-variant-numeric: tabular-nums;
}
/* 售价/采购价列(上下两行,金额右对齐小数对齐) */
.po2-prices {
  flex-shrink: 0;
  margin-left: 12rpx;
  display: flex;
  flex-direction: column;
  gap: 4rpx;
}
.po2-price-row {
  display: flex;
  align-items: baseline;
  gap: 8rpx;
  font-size: 24rpx;
}
.po2-price-label {
  width: 68rpx;
  flex-shrink: 0;
  color: #86909c;
}
.po2-price-val {
  min-width: 130rpx;
  text-align: right;
  color: #1f2329;
  font-variant-numeric: tabular-nums;
}
/* 单价调整(默认折叠,点击展开) */
.po2-cmp {
  margin-top: 16rpx;
  padding-top: 14rpx;
  border-top: 1rpx dashed #e5e6eb;
}
.po2-cmp-toggle {
  display: flex;
  align-items: center;
  gap: 12rpx;
}
.po2-cmp-caret {
  width: 28rpx;
  color: #94a3b8;
  flex-shrink: 0;
}
.po2-cmp-title {
  font-size: 25rpx;
  font-weight: 600;
  color: #1f2329;
}
.po2-rate-pick {
  margin-left: auto;
}
.po2-cmp-rows {
  margin-top: 8rpx;
}
.po2-cmp-tr {
  display: flex;
  align-items: baseline;
  padding: 6rpx 0;
  font-size: 24rpx;
}
.po2-cmp-label {
  flex: 1;
  color: #86909c;
}
.po2-cmp-old {
  width: 150rpx;
  text-align: right;
  color: #4e5969;
  font-variant-numeric: tabular-nums;
}
.po2-cmp-arrow {
  width: 44rpx;
  text-align: center;
  color: #94a3b8;
}
.po2-cmp-new {
  width: 150rpx;
  text-align: right;
  color: #1f2329;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.po2-cmp-old.neg,
.po2-cmp-new.neg {
  color: #f53f3f;
}

.pe-preview b,
.pe-total b {
  color: #00b42a;
}

.pe-preview b.neg,
.pe-total b.neg {
  color: #f53f3f;
}

.pe-rate-chip {
  font-size: 24rpx;
  color: #4e5969;
  background: #f2f3f5;
  border-radius: 10rpx;
  padding: 4rpx 20rpx;
}

.pe-why {
  margin-top: 8rpx;
  font-size: 22rpx;
  color: #ff7d00;
}

.pe-total {
  margin-top: 16rpx;
  padding: 14rpx 18rpx;
  background: #f7f8fa;
  border-radius: 10rpx;
  font-size: 24rpx;
  color: #4e5969;
}

.pe-total b {
  font-size: 28rpx;
  font-weight: 600;
}

/* ── 已有采购卡 ── */
.po {
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f7f8fa;
}

.po:last-child {
  border-bottom: none;
}

.po-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.po-platform {
  font-size: 22rpx;
  color: #165dff;
  background: #eef4ff;
  padding: 2rpx 12rpx;
  border-radius: 8rpx;
  margin-right: 12rpx;
}

.po-sn {
  font-size: 24rpx;
  color: #1f2329;
  font-family: 'Courier New', monospace;
}

.po-status {
  margin-left: auto;
  font-size: 22rpx;
  color: #4e5969;
}

.po-meta {
  display: flex;
  flex-wrap: wrap;
  margin-top: 10rpx;
  font-size: 22rpx;
  color: #86909c;
}

.po-amt {
  color: #1f2329;
  margin-right: 16rpx;
}

.po-meta-item {
  margin-right: 16rpx;
}

.po-goods {
  display: flex;
  align-items: center;
  margin-top: 12rpx;
}

.po-img {
  width: 80rpx;
  height: 80rpx;
  border-radius: 10rpx;
  background: #f2f3f5;
  flex-shrink: 0;
}

.po-goods-main {
  flex: 1;
  margin-left: 14rpx;
  overflow: hidden;
}

.po-goods-title {
  font-size: 24rpx;
  color: #1f2329;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.po-goods-sub {
  margin-top: 4rpx;
  font-size: 21rpx;
  color: #86909c;
}

.po-logi {
  margin-top: 12rpx;
  font-size: 22rpx;
  color: #4e5969;
  background: #f7f8fa;
  border-radius: 8rpx;
  padding: 8rpx 14rpx;
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.po-logi-row {
  margin-top: 12rpx;
  display: flex;
  align-items: center;
}

.po-logi-row .po-logi {
  margin-top: 0;
}

.po-logi-empty {
  flex: 1;
  margin-top: 12rpx;
  font-size: 22rpx;
  color: #a6abb3;
  background: #f7f8fa;
  border-radius: 8rpx;
  padding: 8rpx 14rpx;
}

.po-logi-row .mini-btn {
  margin: 0 0 0 16rpx;
  flex-shrink: 0;
}

.po-logi-company {
  margin-right: 12rpx;
}

.po-logi-no {
  font-family: 'Courier New', monospace;
}

/* ── 物流单号录入面板 ── */
.logi-edit {
  margin-top: 16rpx;
  background: #f7f8fa;
  border-radius: 12rpx;
  padding: 18rpx 20rpx;
}

.logi-field {
  display: flex;
  align-items: center;
}

.logi-field + .logi-field {
  margin-top: 16rpx;
}

.logi-label {
  width: 130rpx;
  font-size: 24rpx;
  color: #4e5969;
  flex-shrink: 0;
}

.logi-input {
  flex: 1;
  background: #ffffff;
  border-radius: 10rpx;
  height: 64rpx;
  line-height: 64rpx;
  padding: 0 20rpx;
  font-size: 25rpx;
}

.logi-picker {
  flex: 1;
  background: #ffffff;
  border-radius: 10rpx;
  height: 64rpx;
  line-height: 64rpx;
  padding: 0 20rpx;
  font-size: 25rpx;
  color: #1f2329;
}

.logi-picker.ph {
  color: #a6abb3;
}

.logi-actions {
  margin-top: 20rpx;
  display: flex;
  justify-content: flex-end;
}

.logi-actions .mini-btn {
  margin: 0 0 0 16rpx;
}

.mini-btn.primary {
  background: #165dff;
  color: #ffffff;
}

.po-actions {
  margin-top: 16rpx;
  display: flex;
  justify-content: flex-end;
}

.mini-btn {
  font-size: 24rpx;
  height: 60rpx;
  line-height: 60rpx;
  padding: 0 28rpx;
  margin: 0 0 0 16rpx;
  border-radius: 12rpx;
  background: #eef4ff;
  color: #165dff;
}

.mini-btn::after {
  border: none;
}

.mini-btn.danger {
  background: #ffece8;
  color: #f53f3f;
}

.mini-btn[disabled] {
  opacity: 0.6;
}

/* ── Step2 平台订单选择 ── */
.plat-tabs {
  white-space: nowrap;
  margin-bottom: 16rpx;
}

.plat-tabs-inner {
  display: inline-flex;
}

.plat-tab {
  display: inline-flex;
  align-items: center;
  padding: 10rpx 24rpx;
  margin-right: 12rpx;
  border-radius: 12rpx;
  background: #f2f3f5;
  font-size: 25rpx;
  color: #4e5969;
  flex-shrink: 0;
}

.plat-tab.on {
  background: #165dff;
  color: #ffffff;
}

.login-warn {
  font-size: 22rpx;
  color: #d97706;
  background: #fff7e6;
  border-radius: 10rpx;
  padding: 12rpx 16rpx;
  margin-bottom: 16rpx;
  line-height: 1.5;
}

.subtabs {
  display: flex;
  align-items: center;
  margin-bottom: 16rpx;
}

.subtab {
  font-size: 24rpx;
  color: #4e5969;
  padding: 8rpx 22rpx;
  border-radius: 999rpx;
  background: #f2f3f5;
  margin-right: 12rpx;
}

.subtab.on {
  background: #eef4ff;
  color: #165dff;
  font-weight: 600;
}

.subtab.refresh {
  margin-left: auto;
  margin-right: 0;
  color: #165dff;
  background: #eef4ff;
}

.imp-search {
  margin-bottom: 8rpx;
  position: relative;
}

.imp-search-input {
  background: #f7f8fa;
  border-radius: 12rpx;
  height: 68rpx;
  line-height: 68rpx;
  padding: 0 64rpx 0 24rpx;
  font-size: 25rpx;
}

/* 搜索聚焦清除按钮(有命中时显示) */
.imp-search-clear {
  position: absolute;
  right: 16rpx;
  top: 50%;
  transform: translateY(-50%);
  width: 36rpx;
  height: 36rpx;
  line-height: 36rpx;
  text-align: center;
  border-radius: 50%;
  background: #c9cdd4;
  color: #fff;
  font-size: 20rpx;
}

.pad {
  padding: 24rpx 0;
}

.err-line {
  font-size: 23rpx;
  color: #f53f3f;
  line-height: 1.5;
}

.po-order {
  display: flex;
  align-items: center;
  padding: 16rpx 8rpx;
  border-bottom: 1rpx solid #f7f8fa;
  border-radius: 8rpx;
}

.po-order.disabled {
  opacity: 0.55;
}

.po-order.sel {
  background: #f0f7ff;
}

.po-check {
  font-size: 36rpx;
  color: #c9cdd4;
  margin-right: 14rpx;
  line-height: 1;
}

.po-order.sel .po-check {
  color: #165dff;
}

.po-order-img {
  width: 88rpx;
  height: 88rpx;
  border-radius: 10rpx;
  background: #f2f3f5;
  flex-shrink: 0;
}

.po-order-main {
  flex: 1;
  margin-left: 14rpx;
  overflow: hidden;
}

.po-order-title {
  font-size: 25rpx;
  color: #1f2329;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.po-more {
  font-size: 21rpx;
  color: #86909c;
}

.po-order-meta {
  margin-top: 4rpx;
  display: flex;
  align-items: center;
}

.po-order-amt {
  font-size: 24rpx;
  color: #f53f3f;
  margin-right: 16rpx;
}

/* 已勾选单:采购单金额手改输入(实际采购价格;分摊仍按 auto 加权) */
.po-amt-edit {
  width: 150rpx;
  height: 44rpx;
  line-height: 44rpx;
  border: 1rpx solid #e5e6eb;
  border-radius: 8rpx;
  padding: 0 10rpx;
  margin-right: 16rpx;
  font-size: 24rpx;
  color: #f53f3f;
  font-weight: 600;
  background: #fff;
}

.po-order-time {
  font-size: 21rpx;
  color: #a6abb3;
}

.po-order-sn {
  margin-top: 4rpx;
  font-size: 21rpx;
  color: #86909c;
  font-family: 'Courier New', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.restored-badge {
  flex-shrink: 0;
  font-size: 20rpx;
  color: #86909c;
  background: #f2f3f5;
  border-radius: 999rpx;
  padding: 4rpx 14rpx;
  margin-left: 10rpx;
}

/* PDD 已勾选单优惠勾选块(2026-09-28) */
.po-promos {
  margin-top: 10rpx;
  padding: 10rpx 12rpx;
  background: #f7faf7;
  border: 1rpx solid #d9f0d9;
  border-radius: 10rpx;
}
.po-promos-head {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 6rpx;
}
.po-promos-label {
  font-size: 21rpx;
  font-weight: 600;
  color: #166534;
}
.po-promo-tip {
  font-size: 19rpx;
  color: #a6abb3;
}
.po-promo-loading {
  font-size: 19rpx;
  color: #a6abb3;
}
.po-promo {
  display: flex;
  align-items: center;
  gap: 8rpx;
  padding: 6rpx 0;
  font-size: 22rpx;
  color: #166534;
}
.po-promo.off {
  color: #a6abb3;
}
.po-promo.off .po-promo-desc,
.po-promo.off .po-promo-amt {
  text-decoration: line-through;
  color: #a6abb3;
}
.po-promo-desc {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.po-promo-amt {
  font-weight: 600;
}
.po-promo-notes {
  margin-top: 6rpx;
  font-size: 19rpx;
  color: #a6abb3;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sel-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  margin-right: 8rpx;
}

.sel-count {
  font-size: 23rpx;
  color: #4e5969;
}

.sel-total {
  font-size: 27rpx;
  color: #1f2329;
  font-weight: 600;
}

/* ── Step3 分摊确认 ── */
.sum-box {
  background: #f7f8fa;
  border-radius: 12rpx;
  padding: 18rpx 20rpx;
  margin-bottom: 20rpx;
}

.sum-line {
  display: flex;
  align-items: center;
}

.sum-count {
  margin-left: 16rpx;
  font-size: 24rpx;
  color: #4e5969;
}

.sum-total {
  margin-left: auto;
  font-size: 30rpx;
  font-weight: 600;
  color: #f53f3f;
}

.sum-sns {
  margin-top: 10rpx;
  font-size: 21rpx;
  color: #86909c;
  font-family: 'Courier New', monospace;
  word-break: break-all;
  line-height: 1.6;
}

/* 已选订单逐笔单号行(多笔订单不再顿号拼接) */
.sum-sn {
  padding: 2rpx 0;
}

.lookup-tip {
  margin-top: 12rpx;
  font-size: 21rpx;
  color: #d97706;
  background: #fff7e6;
  border-radius: 8rpx;
  padding: 10rpx 14rpx;
  line-height: 1.5;
}

/* 目标包裹清单(批量录采购,Step3 内) */
.batch-targets {
  margin-top: 16rpx;
  border-top: 1rpx dashed #e5e6eb;
  padding-top: 16rpx;
}

.bt-head {
  font-size: 23rpx;
  color: #4e5969;
  margin-bottom: 10rpx;
}

.bt-head b {
  color: #165dff;
}

.bt-row {
  display: flex;
  align-items: center;
  padding: 10rpx 12rpx;
  background: #f7f8fa;
  border-radius: 10rpx;
  margin-bottom: 8rpx;
  font-size: 22rpx;
}

.bt-store {
  color: #165dff;
  margin-right: 12rpx;
  flex-shrink: 0;
}

.bt-posting {
  font-family: 'Courier New', monospace;
  color: #1f2329;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bt-cnt {
  color: #86909c;
  font-size: 21rpx;
  margin-right: 12rpx;
  flex-shrink: 0;
}

.bt-del {
  color: #f53f3f;
  font-size: 26rpx;
  padding: 0 8rpx;
  flex-shrink: 0;
}

.bt-empty {
  font-size: 22rpx;
  color: #f53f3f;
  padding: 8rpx 0;
}

.alloc-amount {
  margin-top: 12rpx;
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
  text-align: right;
}

.field {
  margin-top: 24rpx;
}

.field-label {
  font-size: 24rpx;
  color: #4e5969;
  display: block;
  margin-bottom: 12rpx;
}

.field-input {
  background: #f7f8fa;
  border-radius: 12rpx;
  height: 72rpx;
  line-height: 72rpx;
  padding: 0 24rpx;
  font-size: 25rpx;
}

/* ── 底部操作条 ── */
.action-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  background: #ffffff;
  padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom));
  box-shadow: 0 -4rpx 16rpx rgba(0, 0, 0, 0.06);
}

.abtn {
  flex: 1;
  margin: 0 8rpx;
  height: 80rpx;
  line-height: 80rpx;
  font-size: 27rpx;
  border-radius: 14rpx;
  background: #f2f3f5;
  color: #4e5969;
  padding: 0;
}

.abtn::after {
  border: none;
}

.abtn.primary {
  background: #165dff;
  color: #ffffff;
}

/* 白底黑字(「仅保存」) */
.abtn.white {
  background: #ffffff;
  color: #1f2329;
  border: 2rpx solid #e5e6eb;
}

.abtn[disabled] {
  opacity: 0.6;
}

.empty {
  text-align: center;
  padding: 120rpx 0;
  color: #a6abb3;
  font-size: 26rpx;
}
</style>
