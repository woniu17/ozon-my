// Package feishu 发送飞书机器人文本消息，行为对齐 httpsrv/feishuHelper.js。
package feishu

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"ozon-tasks/internal/logx"
)

// Sender 一台机器一个发送器；webhook 为空时按 JS 版语义"跳过并返回 false"，不报错。
type Sender struct {
	httpc       *http.Client
	machineName string
}

func NewSender(machineName string, timeout time.Duration) *Sender {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &Sender{httpc: &http.Client{Timeout: timeout}, machineName: machineName}
}

type payload struct {
	MsgType string `json:"msg_type"`
	Content struct {
		Text string `json:"text"`
	} `json:"content"`
}

// Send 发送文本，末尾追加来源机器标识。
// 失败只记日志、只返回 false：通知挂了不该让已经成功的商品操作算失败，这是 JS 版就有的取舍。
func (s *Sender) Send(ctx context.Context, webhookURL, text string) bool {
	if webhookURL == "" {
		logx.Infof("[飞书] 未配置 webhook URL，跳过飞书通知")
		return false
	}
	p := payload{MsgType: "text"}
	p.Content.Text = fmt.Sprintf("%s\n—— 来自 %s", text, s.machineName)

	body, err := json.Marshal(p)
	if err != nil {
		logx.Errorf("[飞书] 消息序列化失败: %v", err)
		return false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(body))
	if err != nil {
		logx.Errorf("[飞书] 构造请求失败: %v", err)
		return false
	}
	req.Header.Set("content-type", "application/json")

	resp, err := s.httpc.Do(req)
	if err != nil {
		logx.Errorf("[飞书] 发送异常 %v", err)
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		logx.Infof("[飞书] 飞书消息发送成功")
		return true
	}
	logx.Errorf("[飞书] 飞书消息发送失败 HTTP %d", resp.StatusCode)
	return false
}
