# ozon-webhook-proxy

Ozon 推送 → 毫秒级回包 → 本地落盘 → 按序转发 ERP。
部署在 `2.tencent.yochylin.com`，把"接收"从家宽上的 ERP 里摘出来，
避免 ERP 抖动导致 Ozon 判定服务不可用并暂停推送。

设计与取舍见 [DESIGN.md](DESIGN.md)，配置项见 [.env.example](.env.example)。
Go 1.22+，只用标准库，无第三方依赖。

## 本地开发

```bash
export PATH="$HOME/.local/go/bin:$PATH"   # 本机 Go 在 ~/.local/go（brew 装不动）
make            # fmt + vet + test + build
make test
make race       # 带 -race
make linux      # 交叉编译服务器用的静态二进制
```

跑起来（先建一个假 ERP 收转发）：

```bash
# 终端 1：假 erp
node -e 'require("http").createServer((q,r)=>{let b="";q.on("data",c=>b+=c);
  q.on("end",()=>{console.log(q.headers["x-forwarded-for"],b);
  r.writeHead(200,{"content-type":"application/json"});r.end(`{"result":true}`)})}).listen(3098)'

# 终端 2：代理
SPOOL_DIR=/tmp/spool LISTEN_ADDR=127.0.0.1:3002 \
  TARGET_URL=http://127.0.0.1:3098/webhook/ozon ./bin/webhook-proxy
```

冒烟：

```bash
curl -si -X POST localhost:3002/webhook/ozon -H 'content-type: application/json' \
  -H 'x-real-ip: 195.34.21.77' -d '{"type":"TYPE_PING","message_type":"TYPE_PING"}'
# 期望：200 + application/json + {"name":"ozon-erp","time":...,"version":"2.0.0"}

curl -s -w '\n%{http_code} %{time_total}s\n' -X POST localhost:3002/webhook/ozon \
  -H 'x-real-ip: 195.34.21.77' \
  -d '{"message_type":"TYPE_NEW_POSTING","result":{"product_id":1812345678901234567,"posting_number":"123-1"}}'
# 期望：{"result":true} 200 0.0x s（回包时还没转发）

curl -s localhost:3002/webhook/health | jq
```

## 部署（2.tencent.yochylin.com）

已在 2026-10-01 上线，下面的就是实际执行的步骤（保留备查/重装）。
原 nginx 配置备份在同目录 `ozonerp.conf.bak-20261001-101912`。

上线时验证到的程度：
- `POST /webhook/ozon` 的 `TYPE_PING` 走 17443 TLS 由代理本地应答（200 + `application/json` + version/name/time），**不写 ERP**；
- `/webhook/health` 经 nginx 与直连 3002 都通；
- 从这台机器**严格校验**访问 `https://yochylin.com:17443/webhook/health` 返回 200 / 87ms，即转发目标的 TLS 链路成立；
- 真实的业务事件转发（会往 ERP 写事件行）**没有用假数据打过**，等 Ozon 首推后用 `health` 的 `forwarded` 计数确认；
- 同机 nginx 上 mydns(17853) 回归正常。

```bash
# 1. 本地交叉编译并上传
make linux
ssh root@2.tencent.yochylin.com 'mkdir -p /root/code/ozon-webhook-proxy/{bin,data/spool}'
scp bin/webhook-proxy-linux-amd64 root@2.tencent.yochylin.com:/root/code/ozon-webhook-proxy/bin/webhook-proxy
scp start.sh root@2.tencent.yochylin.com:/root/code/ozon-webhook-proxy/
scp .env.example root@2.tencent.yochylin.com:/root/code/ozon-webhook-proxy/ozon-webhook-proxy.env
ssh root@2.tencent.yochylin.com 'chmod +x /root/code/ozon-webhook-proxy/bin/webhook-proxy /root/code/ozon-webhook-proxy/start.sh
  chmod 600 /root/code/ozon-webhook-proxy/ozon-webhook-proxy.env'

# 2. nginx：17443 上加一条 location，指到 3002
#    /etc/nginx/conf.d/ozonerp.conf 原本只有 location / → 127.0.0.1:3001（tencent 上的 ERP 已下线，3001 无人监听）
#    在 location / 之前插入（X-Real-IP 必须保留：代理靠它还原 Ozon 源 IP，
#    再写进转发给 ERP 的 X-Forwarded-For；client_max_body_size 不抬的话 nginx 默认 1m 会先给 Ozon 回 413）：
#      location /webhook/ {
#          proxy_pass http://127.0.0.1:3002;
#          proxy_set_header Host $host;
#          proxy_set_header X-Real-IP $remote_addr;
#          client_max_body_size 50m;
#          proxy_read_timeout 30s;
#      }
#    nginx -t && systemctl reload nginx

# 3. pm2（非登录 shell 里 pm2 不在 PATH，先补）
ssh root@2.tencent.yochylin.com 'export PATH=$PATH:$(ls -d /root/.nvm/versions/node/*/bin | tail -1)
  pm2 start /root/code/ozon-webhook-proxy/start.sh --name ozon-webhook-proxy \
    --interpreter bash --cwd /root/code/ozon-webhook-proxy
  pm2 save'
```

验证与运维：

```bash
curl -sk https://2.tencent.yochylin.com:17443/webhook/health | jq
pm2 logs ozon-webhook-proxy --lines 50
pm2 restart ozon-webhook-proxy          # 改 env 后直接 restart（start.sh 每次重新 source）
```

回滚：`pm2 delete ozon-webhook-proxy`，nginx 那段 `location /webhook/` 注释掉 reload。
落盘目录保留，重启后续投。

## dead 目录手工重放

被 ERP 判 4xx 或重试超限的消息进 `data/spool/dead/`，`.reason` 边车写失败原因：

```bash
cd /root/code/ozon-webhook-proxy/data/spool/dead
cat xxx.json | jq -r '.payload' | \
  curl -s --data-binary @- -H 'content-type: application/json' \
       -H 'x-forwarded-for: 195.34.21.77' -H "x-webhook-proxy: $PROXY_TOKEN" \
       https://yochylin.com:17443/webhook/ozon
```

ERP 一旦配了 `PROXY_TOKEN`，只带 XFF 的重放会被 403 —— 密钥头必须一起带上（与代理 env 里同一个值）。

## 注意

1. **别改 PING 的 `APP_NAME`/`APP_VERSION`**：Ozon 后台展示的就是它，也是运维辨认端点的依据。
2. **落盘失败回 5xx 是有意的**：宁可让 Ozon 重投，也不能假成功把消息吞掉。
3. **payload 全程原始字节**：不要"顺手"在代理里做 JSON 解析再序列化，
   19 位 `product_id`/`sku` 会丢精度，ERP 的幂等键跟着变（`TestForwardPreservesBytesAndSourceIP` 守着这条）。
4. **`TARGET_URL` 用 apex 域名 `yochylin.com`**，不要用 `nuc.yochylin.com`：证书 SAN 里没有它，TLS 校验会失败。
5. **`PROXY_TOKEN` 什么时候能填**：ERP 侧已经支持（配了就只认 `X-Webhook-Proxy`，不再看 XFF）。
   但 Ozon 的回调 URL 还在 ERP 上时**不能填**，否则 Ozon 直推全部 403；
   等 URL 切到本代理，两边填同一个值再各自重启。见 DESIGN.md §8。
