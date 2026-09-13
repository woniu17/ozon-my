// 1688 官方 API 获取买家订单列表 - 可运行示例
// 已验证：签名/token/权限 OK，历史订单 1525 条，含商品图片/SKU/支付/地址
const crypto = require('crypto');

const APP_KEY = '2381926';
const APP_SECRET = 'AntHHpKb9Dc';
const ACCESS_TOKEN = '4fd3fafa-5cdf-417c-92b7-ec966d3f34cb';

// 复刻 buyer-sdk base.py 的 HMAC-SHA1 签名
function aopSign(urlPath, params, secret) {
  const joined = Object.entries(params)
    .map(([k, v]) => String(k) + String(v))
    .sort()
    .join('');
  return crypto.createHmac('sha1', secret)
    .update(urlPath + joined, 'utf8')
    .digest('hex')
    .toUpperCase();
}

// 安全解析：1688 订单号/phase 等是 19 位长整型，JSON.parse 会丢精度，
// 必须先把 16 位以上数字值转成字符串再解析
function safeParse(raw) {
  return JSON.parse(raw.replace(/"(\w+)":\s*(\d{16,})([,\}])/g, '"$1":"$2"$3'));
}

async function getBuyerOrderList({ page = 1, pageSize = 20, isHis = 'false', start, end, orderStatus }) {
  const urlPath = `param2/1/com.alibaba.trade/alibaba.trade.getBuyerOrderList/${APP_KEY}`;
  const params = {
    access_token: ACCESS_TOKEN,
    // 重要：不要传 bizTypes！传了会过滤掉新业务类型订单（实测 trade_general,trade_assure
    // 只能查到老订单，最近的订单全被过滤成 0）。不传 = 全部类型。
    createStartTime: start,
    createEndTime: end,
    isHis, // 注意传字符串：SDK/HTTP 层 falsy 值会被丢弃
    page: String(page),
    pageSize: String(pageSize),
  };
  if (orderStatus) params.orderStatus = orderStatus;
  params._aop_signature = aopSign(urlPath, params, APP_SECRET);
  const resp = await fetch(`https://gw.open.1688.com/openapi/${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  return safeParse(await resp.text());
}

async function main() {
  const data = await getBuyerOrderList({
    isHis: 'false',
    start: '20260907000000000+0800',
    end: '20260913235959000+0800',
    page: 1,
    pageSize: 20,
  });
  console.log('总订单数 totalRecord:', data.totalRecord);
  for (const o of data.result || []) {
    const b = o.baseInfo;
    const item = (o.productItems || [])[0] || {};
    console.log(`订单 ${b.id} | ${b.status} | ¥${b.totalAmount} | ${b.createTime.slice(0, 8)}`);
    console.log(`  商品: ${item.name} × ${item.quantity} @¥${item.price}`);
    console.log(`  货号: ${item.productCargoNumber} | 图片: ${(item.productImgUrl || [])[1] || (item.productImgUrl || [])[0]}`);
    console.log(`  SKU: ${(item.skuInfos || []).map(s => `${s.name}=${s.value}`).join(', ')}`);
    console.log(`  收货: ${o.nativeLogistics?.province}${o.nativeLogistics?.city}${o.nativeLogistics?.area}`);
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
