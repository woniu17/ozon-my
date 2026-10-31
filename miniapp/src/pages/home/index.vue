<template>
  <view class="page">
    <!-- 顶部品牌区 -->
    <view class="hero">
      <view class="hero-title">Ozon ERP</view>
      <view class="hero-sub">{{ greeting }}，{{ displayName }}</view>
    </view>

    <!-- 功能网格 -->
    <view class="grid">
      <view
        v-for="item in MENUS"
        :key="item.url"
        class="cell"
        @click="go(item.url)"
      >
        <view class="cell-icon">{{ item.icon }}</view>
        <view class="cell-name">{{ item.name }}</view>
        <view class="cell-desc">{{ item.desc }}</view>
      </view>
    </view>

    <view class="logout" @click="doLogout">退出登录</view>
  </view>
</template>

<script setup>
import { computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { getStoredUser, clearAuth } from '../../api/request.js';

// 核心 6 模块在前,顺序与安卓端底部导航一致(2026-11-02):扫描入库/扫描打单/发运管理/订单处理/财务统计/订单统计
const MENUS = [
  { icon: '📥', name: '扫描入库', desc: '连扫自动入库', url: '/pages/scan-ship/index?mode=stock' },
  { icon: '📷', name: '扫描打单', desc: '扫码/入库/录重', url: '/pages/scan-ship/index' },
  { icon: '🚚', name: '发运管理', desc: '发运/货件/标签', url: '/pages/carriage/index' },
  { icon: '📦', name: '订单处理', desc: '货件/质检/录采购', url: '/pages/orders/index' },
  { icon: '💰', name: '财务统计', desc: '应计/在途/已结算', url: '/pages/stats/index?tab=finance' },
  { icon: '📊', name: '订单统计', desc: '新单/揽收/签收', url: '/pages/stats/index?tab=order' },
  { icon: '🛒', name: '采购处理', desc: '批量关联采购单', url: '/pages/purchase/index' },
  { icon: '💲', name: '价格管理', desc: '调价/取整/建议价', url: '/pages/price-manage/index' },
  { icon: '📋', name: '任务中心', desc: '更新/归档/导出', url: '/pages/task-center/index' },
  { icon: '🔍', name: '数据查看', desc: 'SKU/店铺/关联', url: '/pages/data-view/index' },
  { icon: '🗂️', name: '商品/采集箱', desc: '商品与采集缓存', url: '/pages/product-center/index' },
];

const user = computed(() => getStoredUser() || {});
const displayName = computed(() => {
  const u = user.value;
  return u.name || u.phoneNumber || u.username || '管理员';
});

const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 6) return '凌晨好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
});

onShow(() => {
  // 每次回到工作台刷新用户信息(可能被其他页面更新)
  user.value = getStoredUser() || {};
});

function go(url) {
  uni.navigateTo({ url });
}

function doLogout() {
  uni.showModal({
    title: '退出登录',
    content: '确定退出当前账号吗？',
    success: (res) => {
      if (res.confirm) {
        clearAuth();
        uni.reLaunch({ url: '/pages/login/index' });
      }
    },
  });
}
</script>

<style scoped>
.page {
  min-height: 100vh;
  padding: 24rpx 24rpx 60rpx;
  box-sizing: border-box;
}

.hero {
  background: linear-gradient(135deg, #165dff 0%, #3b82f6 100%);
  border-radius: 24rpx;
  padding: 48rpx 40rpx;
  color: #ffffff;
  margin-bottom: 32rpx;
}

.hero-title {
  font-size: 44rpx;
  font-weight: 700;
  letter-spacing: 2rpx;
}

.hero-sub {
  font-size: 26rpx;
  opacity: 0.92;
  margin-top: 12rpx;
}

.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 20rpx;
}

.cell {
  width: calc((100% - 40rpx) / 3);
  background: #ffffff;
  border-radius: 20rpx;
  padding: 28rpx 12rpx 24rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  box-shadow: 0 2rpx 12rpx rgba(31, 35, 41, 0.04);
}

.cell-icon {
  font-size: 52rpx;
  line-height: 1;
  margin-bottom: 16rpx;
}

.cell-name {
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
}

.cell-desc {
  font-size: 20rpx;
  color: #8f959e;
  margin-top: 6rpx;
  text-align: center;
  line-height: 1.4;
}

.logout {
  margin-top: 60rpx;
  text-align: center;
  font-size: 26rpx;
  color: #8f959e;
  padding: 20rpx 0;
}
</style>