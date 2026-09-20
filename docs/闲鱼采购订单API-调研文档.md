# 闲鱼(咸鱼/goofish)采购订单 API 调研

> 调研日期:2026-09-20
> 结论:**已实测打通**,在登录态页面上下文可直接拉取「我买到的」订单列表,可接入 ERP 采购平台列表(与拼多多/1688 并列)。

## 1. 接口信息

| 项 | 值 |
|---|---|
| API | `mtop.idle.web.trade.bought.list` |
| 版本 | `1.0` |
| appKey | `34839810` |
| 入口 | `POST https://h5api.m.goofish.com/h5/mtop.idle.web.trade.bought.list/1.0/` |
| Content-Type | `application/x-www-form-urlencoded` |
| body | `data={"pageNumber":1,"orderStatus":"ALL"}`(URL 编码) |
| 凭证 | `credentials: 'include'`(需 goofish.com 登录 cookie) |
| referrer | `https://www.goofish.com/` |

## 2. 调用方式

### 方式 A:页面内 `lib.mtop` SDK(推荐,已实测)

`www.goofish.com` 任意已登录页面自带 mtop SDK(`window.lib.mtop`),sign/token/cookie 全自动:

```js
const res = await window.lib.mtop.request({
  api: 'mtop.idle.web.trade.bought.list',
  v: '1.0',
  data: { pageNumber: 1, orderStatus: 'ALL' },
  appKey: '34839810',
  dataType: 'json'   // ⚠️ 不能传 type:'json'(那是 jsonp 类型参数,会报 UNEXCEPT_REQUEST::错误的请求类型)
});
// res.ret === ['SUCCESS::调用成功'],数据在 res.data
```

### 方式 B:裸 fetch + 自算签名(服务端场景)

mtop H5 签名算法:

```
sign = MD5(token + '&' + t + '&' + appKey + '&' + data)
```

- `token` = cookie `_m_h5_tk` 的前 32 位(该 cookie **非 httpOnly**,JS 可读)
- `t` = 毫秒时间戳
- `appKey` = `34839810`
- `data` = JSON 字符串(与 body 中的 data 一致)
- 登录 cookie(`cookie2` 等)是 httpOnly,页面 JS 读不到,但 `credentials:'include'` 会自动携带

```js
const token = document.cookie.match(/_m_h5_tk=([^;]+)/)[1].split('_')[0] // 实际取第一段
// 注意 _m_h5_tk 格式为 "token32位_时间戳",token 取下划线前的 32 位
const t = Date.now();
const data = JSON.stringify({ pageNumber: 1, orderStatus: 'ALL' });
const sign = md5(`${token}&${t}&34839810&${data}`);
fetch(`https://h5api.m.goofish.com/h5/mtop.idle.web.trade.bought.list/1.0/?jsv=2.7.2&appKey=34839810&t=${t}&sign=${sign}&v=1.0&type=json&accountSite=xianyu&dataType=json&timeout=20000&api=mtop.idle.web.trade.bought.list&valueType=string&sessionOption=AutoLoginOnly`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'data=' + encodeURIComponent(data),
  credentials: 'include'
});
```

## 3. 响应结构

```jsonc
{
  "api": "mtop.idle.web.trade.bought.list",
  "ret": ["SUCCESS::调用成功"],
  "data": {
    "items": [ /* 动态卡片,每页固定 10 条 */ ],
    "lastEndRow": 1,
    "nextPage": true,      // 翻页判断
    "resultExt": {...},
    "totalCount": 0        // 恒为 0,无用
  }
}
```

每个 item 为动态卡片结构(`commonData`/`head`/`content`/`tail` 四段),关键字段映射:

| 业务字段 | 路径 |
|---|---|
| 订单号 | `commonData.orderIdStr` ⚠️ `orderId` 是 JS number 会丢精度,**必须用 `orderIdStr`** |
| 商品 ID | `commonData.itemId` |
| 状态枚举 | `commonData.tradeStatusEnum`(`buyer_to_confirm`=等待买家收货 / `trade_success`=交易成功 …) |
| 状态文本 | `head.data.statusViewMsg` |
| 下单时间 | `head.data.createTime`(格式 `2026-09-20 08:05:38`) |
| 卖家昵称 | `head.data.userInfo.userNick` |
| 卖家 ID | `commonData.peerUserId` |
| 商品标题 | `content.data.detailInfo.auctionTitle` |
| 主图 | `content.data.detailInfo.auctionPic` |
| 实付金额 | `content.data.priceInfo.price`(字符串,如 `"16.80"`) |
| 购买数量 | `content.data.priceInfo.buyAmount` |
| 订单详情跳转 | `commonData.orderDetailUrl`(`fleamarket://` 协议,web 端不可直接用) |

归一化示例(2026-09-20 实测,当前账号 13 条订单,2 页):

```json
{
  "orderId": "5127712344195010728",
  "itemId": 1061194925976,
  "status": "buyer_to_confirm",
  "statusText": "等待买家收货",
  "createTime": "2026-09-20 08:05:38",
  "seller": "千百度英文书屋",
  "title": "助推  Nudge: The Final Edition",
  "price": "16.80",
  "qty": 1
}
```

## 4. 分页与筛选

- **分页**:`pageNumber` 从 1 递增,翻到 `nextPage === false` 停止(实测:第 1 页 10 条 → 第 2 页 3 条 → false)
- **状态筛选**:`orderStatus: 'ALL'` 确定有效;猜测值(`WAIT_PAY`/`WAIT_SEND`/`WAIT_RECEIVE`/`FINISHED`)均被服务端忽略、返回与 ALL 相同。如需按状态筛选需进一步抓包页面 tab 的真实枚举值(对 ERP 场景不关键,可全量拉取后按 `tradeStatusEnum` 本地过滤)

## 5. 已验证的坑

1. **`orderId` 精度丢失**:`commonData.orderId` 超过 JS 安全整数,必须用 `orderIdStr`
2. **SDK 参数**:`type` 是 jsonp 类型参数,传 `'json'` 报 `UNEXCEPT_REQUEST::错误的请求类型`;正确的是 `dataType: 'json'`
3. **`_m_h5_tk` 会过期**:服务端裸调方案需处理 token 过期重采(过期时接口返回 `FAIL_SYS_TOKEN_EXOIRED` 之类的 ret,且响应会 Set-Cookie 新 token,重试一次即可)
4. **登录态判断**:`document.cookie` 含 `unb=` 即已登录

## 6. ERP 集成方案

与现有 1688/拼多多采购单采集同构,两条路:

- **方案 A(浏览器扩展,最稳)**:扩展在 goofish.com 标签页上下文注入调用 `window.lib.mtop`,sign/token/cookie 全自动,无需关心签名。与现有「平台订单多账号 profile」的采集队列模式一致。
- **方案 B(服务端裸调)**:服务端带 cookie 请求 h5api + 自算 MD5 签名。cookie 沿用现有 chrome.cookies 多路采集(profile=linqx 的闲鱼登录态),需处理 `_m_h5_tk` 过期重试。

对接采购平台列表时的映射建议:

| ERP 字段(PDD/1688 现有口径) | 闲鱼来源 |
|---|---|
| orderSn | `orderIdStr` |
| 金额 amount | `priceInfo.price` × `buyAmount`(注意实付价已含单价,单件商品直接取 price) |
| 标题 | `auctionTitle` |
| 图 | `auctionPic` |
| 下单时间 | `createTime` |
| 店铺/卖家 | `userNick` |
| 状态 | `statusViewMsg` / `tradeStatusEnum` |
