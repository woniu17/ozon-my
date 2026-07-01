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
| `OPENAI_API_KEY` | 否 | — | AI 重写功能密钥(开启 ai_rewrite flag 时必填) |
| `OPENAI_MODEL` | 否 | `gpt-4o-mini` | AI 重写模型 |
| `SD_API_URL` | 否 | — | AI 海报生成 API 地址(开启 ai_poster flag 时必填) |

### 静态配置文件(src/config/)

| 文件 | 说明 |
| --- | --- |
| `stores.json` | 店铺列表(含 company_id、sync_credentials) |
| `membership.json` | 会员/配额/极点余额 |
| `feature-flags.json` | 灰度开关 + 可选能力开关 |

修改配置文件后无需重启,下次请求自动生效(`stores.json` 热加载)。

### feature-flags 配置

`src/config/feature-flags.json` 控制灰度和可选能力:

```json
{
  "ozon_portal_import": true,   // 模拟手动上架灰度开关
  "ai_rewrite": false,          // AI 重写(需安装 openai + 配 OPENAI_API_KEY)
  "ai_poster": false,           // AI 海报(需配 SD_API_URL)
  "watermark": false,           // 水印(需安装 sharp)
  "copy_ban_solution": false,   // 防搬运
  "proxy_collect": false        // 代采端点(仅挂载路由,单机版无真实派单)
}
```

所有可选 flag 默认关闭。开启时需安装对应依赖并配置环境变量,否则自动降级为透传。

### 可选依赖

可选能力依赖通过 `optionalDependencies` 声明,`npm install` 时会尝试安装但失败不影响主流程:

```bash
# 安装全部可选依赖
npm install

# 或只安装需要的
npm install openai    # AI 重写
npm install sharp     # 水印(原生编译,可能需要 build-tools)
```

未安装可选依赖时,对应加工模块自动降级为透传,不报错。

## 可选加工能力

`prepare-bundle-items` 支持可插拔加工链,按 feature-flag 顺序执行:

| 模块 | flag | 依赖 | 关闭时行为 |
| --- | --- | --- | --- |
| `enrichments/ai-rewrite.js` | `ai_rewrite` | openai + OPENAI_API_KEY | 透传 |
| `enrichments/watermark.js` | `watermark` | sharp | 透传 |
| `enrichments/poster.js` | `ai_poster` | SD_API_URL | 透传 |
| `enrichments/copy-ban.js` | `copy_ban_solution` | 无 | 透传 |

加工链异常时整体降级为透传,不阻断上架。

### 代采端点

`proxy_collect=true` 时挂载代采路由(对齐 0.13 browser-agents 接口契约):

- `POST /browser-agents/collection-jobs` — 派单(单机版返回 PENDING,无跨设备派单)
- `GET /browser-agents/collection-jobs/:id` — 查询(返回 NOT_FOUND)
- `POST /browser-agents/collection-jobs/:id/report` — 上报(接收不做处理)

> 单机版代采只补端点契约,不做真实派单(自派自领无意义)。

## 与插件对接

### 1. 修改插件 BACKEND_URLS

在插件 `0.13.31.1/background/service-worker.js` 或 `xy-ozon/src/background/erp-client.js` 中:

```javascript
// xy-ozon 默认指向 localhost:3001
const DEFAULT_BASE_URL = 'http://localhost:3001';
// 或通过 chrome.storage.local.erpBaseUrl 覆盖
```

### 2. 填写店铺凭据

编辑 `src/config/stores.json`,把 `company_id` 改成你在 seller.ozon.ru 登录后的真实 `sc_company_id`,`sync_credentials` 填入 Ozon 后台的 `Client-Id` / `Api-Key`。

### 3. 登录

插件 popup 输入 `.env` 中配置的手机号 + 密码即可。

## API 端点(18 个核心 + 代采可选)

详见 [设计文档](../docs/ERP_BACKEND_LITE_DESIGN.md)。

## 备份

```bash
# SQLite 在线备份(不阻塞写入)
sqlite3 data/erp.db ".backup data/erp-backup-$(date +%Y%m%d).db"

# 配置备份
cp -r src/config/ config-backup/
```
