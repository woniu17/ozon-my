<template>
  <!-- 底部功能导航(2026-11-02 参考安卓端 MainShellActivity 底部导航排版):
       顺序:扫描入库 | 扫描打单 | 发运管理 | 订单处理 | 财务统计 | 订单统计
       图标路径与安卓端 res/drawable/ic_nav_*.xml 一一对应;激活色 #165dff,未激活 #86909c -->
  <view class="app-tabbar">
    <view
      v-for="it in TABS"
      :key="it.key"
      class="tab-item"
      :class="{ on: active === it.key }"
      @click="onTap(it)"
    >
      <view class="tab-icon">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path :d="it.path" />
        </svg>
      </view>
      <text class="tab-text">{{ it.label }}</text>
    </view>
  </view>
</template>

<script setup>
const props = defineProps({
  active: { type: String, required: true },
});

// 与安卓端 BottomNav.kt items 顺序一致(2026-10-28 用户要求)
const TABS = [
  { key: 'stock', label: '扫描入库', path: 'M3 7l9-4 9 4v10l-9 4-9-4V7zM3 7l9 4 9-4M12 11v10M8 12.5l3 3 5-5', url: '/pages/scan-ship/index?mode=stock' },
  { key: 'home', label: '扫描打单', path: 'M3 11.2L12 4.5l9 6.7M5.5 9.8V20h13V9.8', url: '/pages/scan-ship/index' },
  { key: 'container', label: '发运管理', path: 'M3 7l9-4 9 4v10l-9 4-9-4V7zM3 7l9 4 9-4M12 11v10M7 9.5v-2M17 9.5v-2', url: '/pages/carriage/index' },
  { key: 'order', label: '订单处理', path: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6', url: '/pages/orders/index' },
  { key: 'finance', label: '财务统计', path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 13h6M12 13V8m0 0c-1.6 0-2.2.9-2.2 1.6 0 .8 1.1 1 2.2 1s2.2.2 2.2 1-.6 1.6-2.2 1.6', url: '/pages/stats/index?tab=finance' },
  { key: 'stats', label: '订单统计', path: 'M5 20v-6M10 20V9M15 20V4M4 20h16', url: '/pages/stats/index?tab=order' },
];

function onTap(it) {
  if (it.key === props.active) return;
  // redirectTo 替换当前模块页:底部导航切换后返回键直接回工作台,不会在模块间堆积历史
  uni.redirectTo({ url: it.url });
}
</script>

<style scoped>
.app-tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 100;
  display: flex;
  align-items: stretch;
  background: #ffffff;
  border-top: 1rpx solid #ebedf0;
  box-shadow: 0 -4rpx 16rpx rgba(31, 35, 41, 0.06);
  box-sizing: border-box;
  height: calc(120rpx + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
}

.tab-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #86909c;
}

.tab-item.on {
  color: #165dff;
}

.tab-icon {
  width: 48rpx;
  height: 48rpx;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tab-text {
  font-size: 20rpx;
  line-height: 1;
  margin-top: 6rpx;
}
</style>