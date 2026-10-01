// pm2 托管 Go 二进制的定义。放在代码仓库里而不是只存在于 nuc 上，是为了让
// 「线上这一版跑的是什么参数」能被审、能回滚；改完要 pm2 startOrReload + pm2 save 才在重启后仍生效。
module.exports = {
  apps: [
    {
      name: 'ozon-tasks',
      script: '/root/ozon-tasks/ozon-tasks',

      // 关键：别拿 node 去解释这个静态 ELF
      interpreter: 'none',
      exec_mode: 'fork', // 单进程。去重靠一份 SQLite 文件，多实例只会互相抢租约
      cwd: '/root/ozon-tasks',

      // 与 httpsrv 共用同一份 .env（改一处两边同时生效）。SQLite 用绝对路径显式给，
      // 不依赖 pm2 恢复出来的工作目录——库文件位置认错就等于凭空丢掉全部排期状态。
      args: [
        'run',
        '-env', '/root/code/get-shop-product/httpsrv/.env',
        '-db', '/root/ozon-tasks/data/ozon-tasks.db',
      ],

      autorestart: true,
      restart_delay: 10000,
      // 配置不合法时程序是「拒绝启动并退出 1」，没有这两样 pm2 会把它打成无限重启环
      min_uptime: '30s',
      max_restarts: 5,

      // SIGINT 会把正在跑的那一班打断并立刻释放租约（不留僵尸槽位），给足收尾时间
      kill_timeout: 60000,

      // 日志文件在 ~/.pm2/logs/ozon-tasks-out.log 与 -error.log；
      // 轮转由 pm2-logrotate 模块负责：
      //   pm2 install pm2-logrotate
      //   pm2 set pm2-logrotate:max_size 20M
      //   pm2 set pm2-logrotate:retain 14
      //   pm2 set pm2-logrotate:compress true
      merge_logs: true,
      time: false, // 程序每行已经自带时间戳，再叠一层会成两列
    },
  ],
};
