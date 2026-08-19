// PM2 ecosystem 配置:ozon-webhook 服务
// 用法:pm2 start ecosystem.config.cjs
// 重启:pm2 restart ozon-webhook
// 日志:pm2 logs ozon-webhook
module.exports = {
  apps: [{
    name: 'msg',
    script: 'src/app.js',
    cwd: '/root/code/ozon-my/ozon-webhook',
    node_args: '--experimental-sqlite',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
