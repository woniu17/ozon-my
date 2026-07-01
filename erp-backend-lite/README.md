# ERP 后端服务(轻量级个人版)

基于 `0.13.31.1` 插件项目接口契约,面向个人单用户单设备使用场景的精简实现。

## 快速开始

### 方式一:Docker(推荐)

```bash
# 1. 准备配置
cp .env.example .env
# 编辑 .env:改 JWT_SECRET / USER_PHONE / USER_PASSWORD(明文密码即可)

# 2. 启动
docker compose up -d

# 3. 验证
curl http://localhost:3001/health
```

### 方式二:本地 Node.js

```bash
# 1. 安装依赖
npm install

# 2. 准备配置
cp .env.example .env
# 编辑 .env

# 3. 初始化数据库
npm run init-db

# 4. 启动
npm start
# 或开发模式(文件变更自动重启)
npm run dev
```

### 方式三:PM2 守护

```bash
npm install -g pm2
npm run pm2
pm2 save
pm2 startup
```

## 配置说明

### 环境变量(.env)

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 否 | `3001` | 服务端口 |
| `JWT_SECRET` | **是** | — | JWT 签名密钥(随机长字符串) |
| `USER_PHONE` | **是** | `13800138000` | 登录手机号 |
| `USER_PASSWORD` | **是** | — | 登录密码(明文) |
| `OZON_OPI_BASE_URL` | 否 | `https://api-seller.ozon.ru` | Ozon OPI 域名 |
| `LOG_LEVEL` | 否 | `info` | 日志级别 |

### 静态配置文件(src/config/)

| 文件 | 说明 |
| --- | --- |
| `stores.json` | 店铺列表(含 company_id、sync_credentials) |
| `membership.json` | 会员/配额/极点余额 |
| `feature-flags.json` | 灰度开关 |

修改配置文件后无需重启,下次请求自动生效(`stores.json` 热加载)。

## 与插件对接

### 1. 修改插件 BACKEND_URLS

在插件 `0.13.31.1/background/service-worker.js` 中:

```javascript
if (globalThis.__JZ_PROD_BUILD__ === 'true') {
  BACKEND_URLS = ['http://localhost:3001']; // 改成本服务地址
} else {
  BACKEND_URLS = ['http://localhost:3001', 'https://api.jizhangerp.com'];
}
```

### 2. 填写店铺凭据

编辑 `src/config/stores.json`,把 `company_id` 改成你在 seller.ozon.ru 登录后的真实 `sc_company_id`,`sync_credentials` 填入 Ozon 后台的 `Client-Id` / `Api-Key`。

### 3. 登录

插件 popup 输入 `.env` 中配置的手机号 + 密码即可。

## API 端点(18 个核心 + 辅助)

详见 [设计文档](../docs/ERP_BACKEND_LITE_DESIGN.md)。

## 备份

```bash
# SQLite 在线备份(不阻塞写入)
sqlite3 data/erp.db ".backup data/erp-backup-$(date +%Y%m%d).db"

# 配置备份
cp -r src/config/ config-backup/
```
