<template>
  <view class="page">
    <view class="card">
      <view class="row">
        <text class="label">当前账号</text>
        <text class="val">{{ userPhone || '—' }}</text>
      </view>
      <view class="row">
        <text class="label">登录态检查</text>
        <text class="val" :class="checkFailed ? 'val-err' : ''">{{ checkResult || '未检查' }}</text>
      </view>

      <button class="btn primary" :loading="checking" :disabled="checking" @click="checkAuth">
        检查登录态(调用订单 tabs 接口)
      </button>
      <button class="btn plain" @click="logout">退出登录</button>
    </view>

    <view class="todo">订单列表为任务 2 内容,本页暂为占位</view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { get, getStoredUser, clearAuth } from '../../api/request.js';

const checking = ref(false);
const checkResult = ref('');
const checkFailed = ref(false);

const userPhone = computed(() => {
  const u = getStoredUser();
  return u && u.phone ? u.phone : '';
});

// 验证 BASE_URL + token + envelope 解包全链路
async function checkAuth() {
  if (checking.value) return;
  checking.value = true;
  checkResult.value = '';
  checkFailed.value = false;
  try {
    const tabs = await get('/admin/api/order-process/tabs');
    const n = tabs && typeof tabs === 'object' ? Object.keys(tabs).length : 0;
    checkResult.value = '正常 · ' + n + ' 个状态分类';
  } catch (e) {
    checkFailed.value = true;
    checkResult.value = '失败:' + (e.message || e);
  } finally {
    checking.value = false;
  }
}

function logout() {
  clearAuth();
  uni.reLaunch({ url: '/pages/login/index' });
}
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

.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18rpx 0;
}

.label {
  color: #8f959e;
  font-size: 27rpx;
}

.val {
  font-size: 27rpx;
  color: #1f2329;
}

.val-err {
  color: #f53f3f;
}

.btn {
  margin-top: 28rpx;
  height: 84rpx;
  line-height: 84rpx;
  font-size: 29rpx;
  border-radius: 14rpx;
}

.btn.primary {
  background: #165dff;
  color: #ffffff;
}

.btn.primary[disabled] {
  background: #94bfff;
  color: #ffffff;
}

.btn.plain {
  background: #f2f3f5;
  color: #4e5969;
}

.todo {
  margin-top: 40rpx;
  text-align: center;
  font-size: 24rpx;
  color: #a6abb3;
}
</style>
