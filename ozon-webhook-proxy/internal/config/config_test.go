package config

import (
	"testing"
	"time"
)

func TestDefaults(t *testing.T) {
	c := Load()
	if c.ListenAddr != "127.0.0.1:3002" {
		t.Errorf("ListenAddr = %q", c.ListenAddr)
	}
	// 必须用 apex 域名：nuc.yochylin.com 与 yochylin.com 解析到同一台机器，
	// 但证书 SAN 里只有 yochylin.com/www.yochylin.com，用 nuc. 做 TLS 校验会失败。
	if c.TargetURL != "https://yochylin.com:17443/webhook/ozon" {
		t.Errorf("TargetURL = %q", c.TargetURL)
	}
	if c.AppName != "ozon-erp" || c.AppVersion != "2.0.0" {
		t.Errorf("PING 身份 = %q %q，必须与 erp 一致，否则 Ozon 侧看到的名字变了", c.AppName, c.AppVersion)
	}
	if c.MaxBodyBytes != 50<<20 {
		t.Errorf("MaxBodyBytes = %d", c.MaxBodyBytes)
	}
	// 单次转发必须明显快于 Ozon 的 5s 判定线？不：转发是异步的，
	// 这里只要求小于 nginx proxy_read_timeout，避免半途被切断。
	if c.ForwardTimeout > 30*time.Second {
		t.Errorf("ForwardTimeout = %v", c.ForwardTimeout)
	}
	if c.ProxyToken != "" || c.FeishuBot != "" {
		t.Error("默认不应内置任何密钥")
	}
}

func TestEnvOverrides(t *testing.T) {
	t.Setenv("LISTEN_ADDR", "0.0.0.0:8080")
	t.Setenv("FORWARD_TIMEOUT", "1500ms")
	t.Setenv("RETRY_MAX", "90") // 纯数字按秒
	t.Setenv("MAX_BODY_BYTES", "1048576")
	t.Setenv("MAX_RETRIES", "abc")
	t.Setenv("PROXY_TOKEN", "  secret  ")

	c := Load()
	if c.ListenAddr != "0.0.0.0:8080" {
		t.Errorf("ListenAddr = %q", c.ListenAddr)
	}
	if c.ForwardTimeout != 1500*time.Millisecond {
		t.Errorf("ForwardTimeout = %v", c.ForwardTimeout)
	}
	if c.RetryMax != 90*time.Second {
		t.Errorf("RetryMax = %v", c.RetryMax)
	}
	if c.MaxBodyBytes != 1048576 {
		t.Errorf("MaxBodyBytes = %d", c.MaxBodyBytes)
	}
	if c.MaxRetries != 200 {
		t.Errorf("非法数字应回落默认值, got %d", c.MaxRetries)
	}
	if c.ProxyToken != "secret" {
		t.Errorf("ProxyToken 应去空白, got %q", c.ProxyToken)
	}
}
