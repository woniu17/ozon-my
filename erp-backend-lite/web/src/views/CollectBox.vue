<script setup>
import { reactive, ref, onMounted } from 'vue';
import { getCollectBox, deleteCollectBox } from '../api/collect-box.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';
import AppPager from '../components/AppPager.vue';
import AppModal from '../components/AppModal.vue';
import AppAccordion from '../components/AppAccordion.vue';
import JsonTree from '../components/JsonTree.vue';

const storesStore = useStoresStore();
const { show } = useToast();

// ── 列表状态 ───────────────────────────────────────────────
const state = reactive({
  items: [],
  total: 0,
  loading: false,
  page: 1,
  pageSize: 20,
  filters: {
    storeId: '',
    keyword: '',
  },
});

async function loadList() {
  state.loading = true;
  try {
    const data = await getCollectBox({
      currentPage: state.page,
      pageSize: state.pageSize,
      storeId: state.filters.storeId,
      keyword: state.filters.keyword.trim(),
    });
    // 预计算展示字段,避免模板内反复调用
    state.items = (data?.items || []).map((it) => ({
      ...it,
      _display: extractProductDisplay(it.product),
    }));
    state.total = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    state.items = [];
    state.total = 0;
  } finally {
    state.loading = false;
  }
}

// 查询:重置到第 1 页后加载
function search() {
  state.page = 1;
  loadList();
}

// 翻页:先更新页码再加载,确保读取最新 page
function onPageChange(p) {
  state.page = p;
  loadList();
}

// 编辑:跳转到采集编辑页(新标签打开)
function openEditor(it) {
  window.open('/collect-editor.html?id=' + encodeURIComponent(it.id), '_blank');
}

// 删除:confirm 后调接口,成功 toast + 刷新
async function onRemove(it) {
  if (!confirm(`确认删除采集箱条目 #${it.id}?`)) return;
  try {
    await deleteCollectBox(it.id);
    show('已删除', 'success');
    await loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// ── 详情弹窗(展示原始 product JSON) ───────────────────────
const detailOpen = ref(false);
const detailItem = ref(null);

function openDetail(it) {
  detailItem.value = it;
  detailOpen.value = true;
}

// ── 渲染辅助 ───────────────────────────────────────────────
// 从 product JSON 中容错提取展示字段(插件不同版本字段名可能不同)
function extractProductDisplay(p) {
  const obj = p || {};
  const title = obj.title || obj.name || obj.productName || '';
  const sku = obj.sku || obj.id || '';
  const image =
    obj.image ||
    obj.mainImage ||
    obj.primary_image ||
    (Array.isArray(obj.images) ? obj.images[0] : '') ||
    (Array.isArray(obj.imageUrls) ? obj.imageUrls[0] : '') ||
    '';
  const price = obj.price || obj.marketing_price || '';
  const url = obj.url || obj.link || obj.source_url || '';
  return { title, sku, image, price, url };
}

function storeName(storeId) {
  const s = storesStore.list.find((x) => x.id === storeId);
  return s?.name || storeId || '—';
}

function fmtTime(t) {
  if (!t) return '—';
  return String(t).replace('T', ' ').slice(0, 19);
}

onMounted(() => {
  storesStore.load();
  loadList();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>采集箱</h2>
      <button
        class="btn btn-ghost"
        :disabled="state.loading"
        @click="loadList"
      >{{ state.loading ? '刷新中...' : '刷新' }}</button>
    </div>

    <div class="filter-bar">
      <select class="filter-select" v-model="state.filters.storeId">
        <option value="">全部店铺</option>
        <option v-for="s in storesStore.list" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <input
        class="filter-input"
        type="text"
        v-model.trim="state.filters.keyword"
        placeholder="搜索 SKU / 名称"
        @keydown.enter="search"
      />
      <button class="btn btn-primary" @click="search">查询</button>
    </div>

    <div class="cb-grid">
      <div v-if="state.loading && !state.items.length" class="empty" style="grid-column:1/-1">
        加载中...
      </div>
      <div v-else-if="!state.items.length" class="empty" style="grid-column:1/-1">
        暂无采集记录
      </div>
      <div v-for="it in state.items" :key="it.id" class="cb-card">
        <div class="cb-thumb">
          <img
            v-if="it._display.image"
            :src="it._display.image"
            alt=""
            loading="lazy"
            @error="$event.target.style.display = 'none'"
          />
          <div v-else class="cb-no-img">无图</div>
        </div>
        <div class="cb-body">
          <div class="cb-title" :title="it._display.title">
            {{ it._display.title || '(未命名)' }}
          </div>
          <div class="cb-meta">
            <span>SKU: {{ it._display.sku || '—' }}</span>
            <span v-if="it._display.price">价格: {{ it._display.price }}</span>
            <span>店铺: {{ storeName(it.storeId) }}</span>
          </div>
          <div class="cb-foot">
            <span class="cb-time">{{ fmtTime(it.createdAt) }}</span>
            <span class="badge" :class="it.published ? 'badge-success' : 'badge-pending'">
              {{ it.published ? '已发布' : '未发布' }}
            </span>
          </div>
        </div>
        <div class="cb-actions">
          <button class="btn btn-sm btn-ghost" @click="openDetail(it)">详情</button>
          <button class="btn btn-sm btn-ghost" @click="openEditor(it)">编辑</button>
          <a
            v-if="it._display.url"
            class="btn btn-sm btn-ghost"
            :href="it._display.url"
            target="_blank"
            rel="noopener"
          >查看源</a>
          <button class="btn btn-sm btn-danger" @click="onRemove(it)">删除</button>
        </div>
      </div>
    </div>

    <AppPager
      :modelValue="state.page"
      :total="state.total"
      :pageSize="state.pageSize"
      @update:modelValue="onPageChange"
    />

    <!-- 详情弹窗(结构化展示原始 product JSON) -->
    <AppModal
      :open="detailOpen"
      title="采集详情"
      size="lg"
      @update:open="detailOpen = $event"
    >
      <template v-if="detailItem">
        <AppAccordion title="基本信息" :default-open="true">
          <div class="cb-detail-meta">
            <span><strong>ID:</strong> {{ detailItem.id }}</span>
            <span><strong>SKU:</strong> {{ detailItem._display.sku || '—' }}</span>
            <span><strong>店铺:</strong> {{ storeName(detailItem.storeId) }}</span>
            <span><strong>来源:</strong> {{ detailItem.source || '—' }}</span>
            <span>
              <strong>状态:</strong>
              <span class="badge" :class="detailItem.published ? 'badge-success' : 'badge-pending'">
                {{ detailItem.published ? '已发布' : '未发布' }}
              </span>
            </span>
            <span><strong>采集时间:</strong> {{ fmtTime(detailItem.createdAt) }}</span>
          </div>
        </AppAccordion>
        <AppAccordion title="原始 product 数据" :default-open="true">
          <JsonTree :data="detailItem.product" root-key="product" />
        </AppAccordion>
        <AppAccordion
          v-if="detailItem.aiDraft"
          title="AI 草稿 (ai_draft)"
          :default-open="false"
        >
          <JsonTree :data="detailItem.aiDraft" root-key="ai_draft" />
        </AppAccordion>
      </template>
      <div v-else class="empty">无数据</div>
    </AppModal>
  </div>
</template>

<style scoped>
.cb-detail-meta {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px 16px;
  font-size: 13px;
}
.cb-detail-meta span {
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
