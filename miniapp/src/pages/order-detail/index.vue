<template>
  <view class="page">
    <view class="card">
      <view class="line">包裹ID:{{ packageId }}</view>
      <view class="hint">订单详情为任务 3 内容,本页暂为占位</view>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

const packageId = ref('');

onLoad((opts) => {
  packageId.value = (opts && opts.id) || '';
});
</script>

<style scoped>
.page {
  padding: 32rpx;
}

.card {
  background: #ffffff;
  border-radius: 20rpx;
  padding: 36rpx 32rpx;
}

.line {
  font-size: 28rpx;
  color: #1f2329;
}

.hint {
  margin-top: 16rpx;
  font-size: 24rpx;
  color: #a6abb3;
}
</style>
