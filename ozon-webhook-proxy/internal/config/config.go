// 配置：凭证/地址全部来自环境变量，无内置默认密钥。
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddr string // 代理监听地址（nginx 反代到这里）
	TargetURL  string // erp 接收端点（公网 TLS）
	SpoolDir   string // 落盘队列目录

	AppName    string // PING 响应里的 name，与 erp 保持一致
	AppVersion string // PING 响应里的 version

	MaxBodyBytes    int64         // 入站 body 上限，对齐 erp 的 express.json limit
	ForwardTimeout  time.Duration // 单次转发超时
	PingTimeout     time.Duration
	MaxRetries      int           // 超过则进 dead 目录
	RetryMax        time.Duration // 退避封顶
	DrainTimeout    time.Duration // 退出时等待在途转发的时间
	AlertConsecFail int           // 连续失败多少条告警
	AlertStaleAfter time.Duration // 队头滞留多久告警

	ProxyToken string // 与 erp 之间的共享密钥（第二阶段启用，空则不带）
	FeishuBot  string // 飞书机器人 token，空则不告警
}

const (
	defaultAppName    = "ozon-erp"
	defaultAppVersion = "2.0.0"
)

func Load() *Config {
	return &Config{
		ListenAddr: env("LISTEN_ADDR", "127.0.0.1:3002"),
		// 用 apex 域名而不是 nuc.yochylin.com：两者解析到同一台机器，
		// 但证书 SAN 只有 yochylin.com/www.yochylin.com，按 nuc. 校验会失败。
		TargetURL: env("TARGET_URL", "https://yochylin.com:17443/webhook/ozon"),
		SpoolDir:  env("SPOOL_DIR", "./data/spool"),

		AppName:    env("APP_NAME", defaultAppName),
		AppVersion: env("APP_VERSION", defaultAppVersion),

		MaxBodyBytes:    envInt64("MAX_BODY_BYTES", 50<<20),
		ForwardTimeout:  envDur("FORWARD_TIMEOUT", 8*time.Second),
		PingTimeout:     envDur("PING_TIMEOUT", 3*time.Second),
		MaxRetries:      envInt("MAX_RETRIES", 200),
		RetryMax:        envDur("RETRY_MAX", 5*time.Minute),
		DrainTimeout:    envDur("DRAIN_TIMEOUT", 10*time.Second),
		AlertConsecFail: envInt("ALERT_CONSEC_FAIL", 5),
		AlertStaleAfter: envDur("ALERT_STALE_AFTER", 10*time.Minute),

		ProxyToken: env("PROXY_TOKEN", ""),
		FeishuBot:  env("FEISHU_BOT_TOKEN", ""),
	}
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func envInt64(key string, fallback int64) int64 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return fallback
	}
	return n
}

// envDur 接受 Go 时长写法（"8s"、"5m"），也接受纯数字（按秒计）。
func envDur(key string, fallback time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	if d, err := time.ParseDuration(v); err == nil {
		return d
	}
	if n, err := strconv.ParseInt(v, 10, 64); err == nil {
		return time.Duration(n) * time.Second
	}
	return fallback
}
