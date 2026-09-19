// 环境配置
// H5 与 erp 后端同源部署,生产构建用相对路径同源请求——公网入口 https://yochylin.com:17443/miniapp/
// 与内网直连入口 http://192.168.1.212:3001/miniapp/ 均免跨域、免公网域名解析(内网回源 NAT 不通时也能用)。
// H5 dev(localhost:5173)与小程序端无同源概念,仍用绝对地址:
//   - 微信开发者工具:详情 → 本地设置 → 勾选「不校验合法域名、web-view(业务域名)、TLS 版本以及 HTTPS 证书」
//   - 真机预览:手机打开开发版 → 右上角胶囊 → 开发调试,开启后同样跳过域名校验
// 备案 + 云反代就绪后切换为备案域名(443 端口),见 docs/微信小程序订单处理-功能设计.md §4
// #ifdef H5
export const BASE_URL = process.env.NODE_ENV === 'development' ? 'https://yochylin.com:17443' : '';
// #endif
// #ifndef H5
export const BASE_URL = 'https://yochylin.com:17443';
// #endif
