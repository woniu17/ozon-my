<template>
  <view class="login-page">
    <view class="login-card">
      <view class="login-title">Ozon ERP</view>
      <view class="login-sub">订单处理 · 小程序端</view>

      <view class="field">
        <input
          class="input"
          type="number"
          maxlength="11"
          v-model="phone"
          placeholder="手机号"
          placeholder-class="ph"
        />
      </view>
      <view class="field">
        <input
          class="input"
          password
          v-model="password"
          placeholder="密码"
          placeholder-class="ph"
          @confirm="doLogin"
        />
      </view>

      <button class="btn" :loading="loading" :disabled="loading" @click="doLogin">
        登 录
      </button>
      <view class="tip">与电脑端 admin 使用同一账号</view>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { post, setAuth, getToken } from '../../api/request.js';

const PHONE_KEY = 'erp_mini_phone'; // 记住手机号

const phone = ref('');
const password = ref('');
const loading = ref(false);

onLoad(() => {
  // 已有 token 直接进入订单页(7 天有效 + 滑动续期)
  if (getToken()) {
    uni.reLaunch({ url: '/pages/orders/index' });
    return;
  }
  // 回填上次登录的手机号
  phone.value = uni.getStorageSync(PHONE_KEY) || '';
});

async function doLogin() {
  const p = (phone.value || '').trim();
  const pwd = (password.value || '').trim();
  if (!p || !pwd) {
    uni.showToast({ title: '请输入手机号和密码', icon: 'none' });
    return;
  }
  if (loading.value) return;
  loading.value = true;
  try {
    // 后端返回 { accessToken, user }(非 envelope,request 原样返回)
    const data = await post('/auth/login-password', { phoneNumber: p, password: pwd });
    setAuth(data.accessToken, data.user);
    uni.setStorageSync(PHONE_KEY, p);
    uni.reLaunch({ url: '/pages/orders/index' });
  } catch (e) {
    // 错误 toast 已由 request.js 统一弹出(如「手机号或密码错误」)
    password.value = '';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 60rpx;
}

.login-card {
  width: 100%;
  background: #ffffff;
  border-radius: 24rpx;
  padding: 80rpx 48rpx 60rpx;
  box-shadow: 0 4rpx 24rpx rgba(0, 0, 0, 0.06);
}

.login-title {
  font-size: 48rpx;
  font-weight: 600;
  text-align: center;
  color: #1f2329;
}

.login-sub {
  font-size: 26rpx;
  color: #8f959e;
  text-align: center;
  margin-top: 12rpx;
  margin-bottom: 72rpx;
}

.field {
  margin-bottom: 32rpx;
}

.input {
  height: 96rpx;
  background: #f5f6f7;
  border-radius: 16rpx;
  padding: 0 28rpx;
  font-size: 30rpx;
}

.ph {
  color: #a6abb3;
}

.btn {
  margin-top: 24rpx;
  background: #165dff;
  color: #ffffff;
  font-size: 32rpx;
  border-radius: 16rpx;
  height: 92rpx;
  line-height: 92rpx;
}

.btn[disabled] {
  background: #94bfff;
  color: #ffffff;
}

.tip {
  margin-top: 28rpx;
  text-align: center;
  font-size: 24rpx;
  color: #a6abb3;
}
</style>
