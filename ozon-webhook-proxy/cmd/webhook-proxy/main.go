// ozon-webhook-proxy：接收 Ozon 推送 → 毫秒级回包 → 落盘 → 异步转发 erp。
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"ozon-webhook-proxy/internal/alert"
	"ozon-webhook-proxy/internal/config"
	"ozon-webhook-proxy/internal/proxy"
	"ozon-webhook-proxy/internal/spool"
)

func main() {
	envFile := flag.String("env", "", "环境变量文件路径（KEY=VALUE），可空")
	flag.Parse()

	if *envFile != "" {
		if err := loadEnvFile(*envFile); err != nil {
			log.Fatalf("[main] 读取 env 文件失败: %v", err)
		}
	}

	cfg := config.Load()
	log.Printf("[main] 监听 %s，转发目标 %s，spool %s", cfg.ListenAddr, cfg.TargetURL, cfg.SpoolDir)

	sp, err := spool.Open(cfg.SpoolDir)
	if err != nil {
		log.Fatalf("[main] 打开 spool 失败: %v", err)
	}
	log.Printf("[main] spool 待转发 %d 条", sp.Depth())

	al := alert.New(cfg.FeishuBot, 10*time.Minute)
	fwd := proxy.NewForwarder(cfg, sp, al)
	go fwd.Run()

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           proxy.NewServer(cfg, sp, fwd).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      15 * time.Second,
		// 留一点余量：nginx 侧 proxy_read_timeout 更短，正常超时由代理自己控制。
		IdleTimeout: 60 * time.Second,
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[main] HTTP 服务退出: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	sig := <-stop
	log.Printf("[main] 收到 %s，开始优雅退出", sig)

	// 先把接收端关掉：不再收新消息，Ozon 会对新推送重试（或由 nginx 直接回 502），
	// 已落盘的消息不受影响。
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("[main] 关闭接收端: %v", err)
	}
	cancel()

	fwd.Stop()
	log.Printf("[main] 已退出，剩余队列 %d 条（下次启动自动续投）", sp.Depth())
}

// loadEnvFile 解析 KEY=VALUE 行，已存在的真实环境变量优先（便于临时覆盖）。
func loadEnvFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key, val = strings.TrimSpace(key), strings.TrimSpace(val)
		if len(val) >= 2 && (val[0] == '"' || val[0] == '\'') && val[len(val)-1] == val[0] {
			val = val[1 : len(val)-1]
		}
		if key != "" && os.Getenv(key) == "" {
			if err := os.Setenv(key, val); err != nil {
				return err
			}
		}
	}
	return nil
}
