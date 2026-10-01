package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadEnvFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "proxy.env")
	content := "# 注释\n" +
		"LISTEN_ADDR=0.0.0.0:3002\r\n" +
		`PROXY_TOKEN="quoted token"` + "\n" +
		"FEISHU_BOT_TOKEN = bare \n" +
		"\n" +
		"NOEQUALS\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := loadEnvFile(path); err != nil {
		t.Fatalf("loadEnvFile: %v", err)
	}
	if got := os.Getenv("LISTEN_ADDR"); got != "0.0.0.0:3002" {
		t.Errorf("LISTEN_ADDR = %q（应去掉行尾 \\r）", got)
	}
	if got := os.Getenv("PROXY_TOKEN"); got != "quoted token" {
		t.Errorf("PROXY_TOKEN = %q，引号应剥掉", got)
	}
	if got := os.Getenv("FEISHU_BOT_TOKEN"); got != "bare" {
		t.Errorf("FEISHU_BOT_TOKEN = %q", got)
	}
	if os.Getenv("NOEQUALS") != "" {
		t.Error("无 = 的行应忽略")
	}
}

func TestLoadEnvFileKeepsRealEnvPriority(t *testing.T) {
	t.Setenv("LISTEN_ADDR", "1.2.3.4:9999")
	path := filepath.Join(t.TempDir(), "e.env")
	if err := os.WriteFile(path, []byte("LISTEN_ADDR=5.6.7.8:1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := loadEnvFile(path); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("LISTEN_ADDR"); got != "1.2.3.4:9999" {
		t.Errorf("真实环境变量应优先, got %q", got)
	}
}

func TestLoadEnvFileMissing(t *testing.T) {
	if err := loadEnvFile(filepath.Join(t.TempDir(), "nope.env")); err == nil {
		t.Error("文件不存在应报错，让启动失败而不是静默用默认配置")
	}
}
