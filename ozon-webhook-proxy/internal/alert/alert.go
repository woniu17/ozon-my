// Package alert 把异常发到飞书机器人，并按类别限频，避免 NUC 长时间不可达时刷屏。
package alert

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

const botPrefix = "https://open.feishu.cn/open-apis/bot/v2/hook/"

type Alerter struct {
	token    string
	client   *http.Client
	mu       sync.Mutex
	lastSend map[string]time.Time
	minGap   time.Duration
}

func New(token string, minGap time.Duration) *Alerter {
	if minGap <= 0 {
		minGap = 10 * time.Minute
	}
	return &Alerter{
		token:    token,
		client:   &http.Client{Timeout: 10 * time.Second},
		lastSend: make(map[string]time.Time),
		minGap:   minGap,
	}
}

// Send 按 kind 限频。kind 相同的告警在 minGap 内只发一次。
func (a *Alerter) Send(kind, message string) {
	if a.token == "" {
		log.Printf("[alert:%s] %s", kind, message)
		return
	}
	a.mu.Lock()
	if t, ok := a.lastSend[kind]; ok && time.Since(t) < a.minGap {
		a.mu.Unlock()
		return
	}
	a.lastSend[kind] = time.Now()
	a.mu.Unlock()

	log.Printf("[alert:%s] %s", kind, message)

	payload := struct {
		MsgType string `json:"msg_type"`
		Content struct {
			Text string `json:"text"`
		} `json:"content"`
	}{MsgType: "text"}
	payload.Content.Text = "[ozon-webhook-proxy] " + message

	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	req, err := http.NewRequest(http.MethodPost, botPrefix+a.token, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.client.Do(req)
	if err != nil {
		log.Printf("[alert] 发送失败: %v", err)
		return
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
}
