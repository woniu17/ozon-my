// Package ozon 是 Ozon Seller API 客户端：一个店铺一个实例，读接口照常发，
// 写接口统一过 dry-run 闸——影子模式下只打印将要提交的 body，绝不落到店铺。
package ozon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ozon-tasks/internal/config"
	"ozon-tasks/internal/logx"
)

// DefaultBaseURL 官方地址。真正的默认值在 config 里定（OZON_API_BASE_URL 要拿它做比对），
// 这里只引用，避免同一个 URL 字面量在两处各写一遍。
const DefaultBaseURL = config.DefaultAPIBaseURL

// ErrDryRun 不会作为错误返回给调用方，仅用于内部标记；写接口以 executed=false 表达。
type APIError struct {
	StatusCode int
	Code       string
	Message    string
	Details    []string
}

func (e APIError) Error() string {
	msg := fmt.Sprintf("HTTP %d", e.StatusCode)
	if e.Code != "" {
		msg += fmt.Sprintf(" code=%s", e.Code)
	}
	if e.Message != "" {
		msg += fmt.Sprintf(": %s", e.Message)
	}
	if len(e.Details) > 0 {
		msg += fmt.Sprintf(" details=[%s]", strings.Join(e.Details, "; "))
	}
	return msg
}

// Options 客户端参数。BaseURL/Sleep 为测试留的注入点。
type Options struct {
	BaseURL string
	Timeout time.Duration
	Retries int           // 失败后的重试次数，总请求数 = Retries+1
	Backoff time.Duration // 首次退避基数，默认 500ms
	DryRun  bool
	Sleep   func(context.Context, time.Duration) error
	RPS     float64 // 每店每秒请求数上限，<=0 表示不限速
	Burst   int     // 桶容量，允许一小串请求连发
}

type Client struct {
	shop    config.Shop
	opts    Options
	httpc   *http.Client
	rnd     *rand.Rand
	limiter *Limiter
}

func NewClient(shop config.Shop, opts Options) *Client {
	if opts.BaseURL == "" {
		opts.BaseURL = DefaultBaseURL
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 15 * time.Second
	}
	if opts.Retries < 0 {
		opts.Retries = 0
	}
	if opts.Backoff <= 0 {
		opts.Backoff = 500 * time.Millisecond
	}
	if opts.Sleep == nil {
		opts.Sleep = sleepCtx
	}
	return &Client{
		shop:    shop,
		opts:    opts,
		httpc:   &http.Client{Timeout: opts.Timeout},
		rnd:     rand.New(rand.NewSource(time.Now().UnixNano())),
		limiter: NewLimiter(opts.RPS, opts.Burst),
	}
}

func (c *Client) Shop() config.Shop { return c.shop }
func (c *Client) DryRun() bool      { return c.opts.DryRun }
func (c *Client) BaseURL() string   { return c.opts.BaseURL }
func (c *Client) ClientID() string  { return c.shop.ClientID }

// String / GoString 兜住"顺手把 client 打进日志"这种写法。
// 两个都得实现：%v/%+v 走 Stringer、%#v 走 GoStringer；而且 fmt 只对顶层操作数调这两个接口，
// 嵌套的 config.Shop 字段照样会被原样打印出来，所以必须在 Client 这层就把密钥挡住。
func (c *Client) String() string   { return c.safeString() }
func (c *Client) GoString() string { return c.safeString() }

func (c *Client) safeString() string {
	return fmt.Sprintf("ozon.Client{shop=%s client=%s apiKey=%s dryRun=%v}",
		c.shop.Name, c.shop.ClientID, config.MaskKey(c.shop.APIKey), c.opts.DryRun)
}

// sleepCtx 退避等待；上下文取消时立刻返回，停止任务时不会卡在 sleep 里。
func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (c *Client) headers() map[string]string {
	return map[string]string{
		"Client-Id":    c.shop.ClientID,
		"Api-Key":      c.shop.APIKey,
		"Content-Type": "application/json",
	}
}

// get 发只读 GET。
func (c *Client) get(ctx context.Context, path string, out any) error {
	return c.request(ctx, http.MethodGet, path, nil, out)
}

// postRead 发只读 POST（Ozon 的查询接口大多是 POST + body）。
func (c *Client) postRead(ctx context.Context, path string, body, out any) error {
	return c.request(ctx, http.MethodPost, path, body, out)
}

// postWrite 发写操作。返回 executed=false 表示 dry-run 下被拦下、没有真正提交。
func (c *Client) postWrite(ctx context.Context, path string, body, out any) (bool, error) {
	if c.opts.DryRun {
		logx.Infof("[dry-run] 跳过写入 POST %s body=%s", path, summarizeBody(body))
		return false, nil
	}
	if err := c.request(ctx, http.MethodPost, path, body, out); err != nil {
		return true, err
	}
	return true, nil
}

// request 是唯一的出口：重试、退避、错误解析都集中在这里。
// 只对 429/5xx 和网络错误重试；其余 4xx 是请求本身有问题，重试只会白占 Ozon 配额。
func (c *Client) request(ctx context.Context, method, path string, body, out any) error {
	var payload []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("请求体序列化失败 %s: %w", path, err)
		}
		payload = b
	}

	attempts := c.opts.Retries + 1
	var lastErr error
	// serverWait 记服务端用 Retry-After 指定的等待时长。它必须在下一轮请求前生效，
	// 而且不能和退避叠加——叠加会把限流期成倍拖长，这正是 Ozon 最不想看到的。
	var serverWait time.Duration
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			wait := c.backoff(attempt, lastErr)
			if serverWait > wait {
				wait = serverWait
			}
			serverWait = 0
			logx.Infof("%s %s 第 %d 次重试，等待 %v（%v）", method, path, attempt, wait, lastErr)
			if err := c.opts.Sleep(ctx, wait); err != nil {
				return err
			}
		}

		// 每个请求（含重试）都要过一个令牌：重试同样吃 Ozon 的配额
		if err := c.limiter.Wait(ctx); err != nil {
			return err
		}

		var reader io.Reader
		if payload != nil {
			reader = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.opts.BaseURL+path, reader)
		if err != nil {
			return fmt.Errorf("构造请求失败 %s: %w", path, err)
		}
		for k, v := range c.headers() {
			req.Header.Set(k, v)
		}

		resp, err := c.httpc.Do(req)
		if err != nil {
			// 上下文取消不是可重试的抖动，直接返回，保证 --once 和停止能及时退出
			if ctx.Err() != nil {
				return ctx.Err()
			}
			lastErr = fmt.Errorf("请求失败 %s: %w", path, err)
			continue
		}

		data, readErr := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("读取响应失败 %s: %w", path, readErr)
			continue
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			if out == nil || len(bytes.TrimSpace(data)) == 0 {
				return nil
			}
			if err := json.Unmarshal(data, out); err != nil {
				return fmt.Errorf("响应解析失败 %s: %w（响应前 %d 字节: %s）", path, err, min(len(data), 200), truncate(string(data), 200))
			}
			return nil
		}

		apiErr := parseAPIError(resp, data)
		if retryable(apiErr.StatusCode) {
			lastErr = apiErr
			if d, ok := retryAfter(resp); ok && d > serverWait {
				serverWait = d
			}
			continue
		}
		// 不可重试：立即返回，4xx 的 body 里通常带着定位问题的字段名
		logx.Errorf("%s %s 返回 %s", method, path, apiErr.Error())
		return apiErr
	}

	return fmt.Errorf("%s 请求失败（共 %d 次尝试）: %w", path, attempts, lastErr)
}

func retryable(status int) bool {
	return status == http.StatusTooManyRequests || status >= 500
}

// backoff 指数退避 + 抖动（full jitter）。
// 加抖动是因为多店铺同时被限流时，固定间隔会让所有重试挤在同一秒打到 Ozon。
func (c *Client) backoff(attempt int, lastErr error) time.Duration {
	base := float64(c.opts.Backoff) * math.Pow(2, float64(attempt-1))
	if max := float64(30 * time.Second); base > max {
		base = max
	}
	d := time.Duration(c.rnd.Float64() * base)
	if min := 100 * time.Millisecond; d < min {
		d = min
	}
	var ae APIError
	if errors.As(lastErr, &ae) && ae.StatusCode == http.StatusTooManyRequests {
		if d < 2*time.Second {
			d = 2 * time.Second // 限流要多等一轮，别的错误按抖动来
		}
	}
	return d
}

func retryAfter(resp *http.Response) (time.Duration, bool) {
	v := strings.TrimSpace(resp.Header.Get("Retry-After"))
	if v == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(v); err == nil && secs >= 0 {
		return time.Duration(secs) * time.Second, true
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d, true
		}
	}
	return 0, false
}

// errorEnvelope Ozon 的错误体是 {code,message,details,status}，details 里的 value 形态不固定。
type errorEnvelope struct {
	Code    any `json:"code"`
	Message any `json:"message"`
	Details []struct {
		Type  string          `json:"type"`
		Value json.RawMessage `json:"value"`
	} `json:"details"`
}

func parseAPIError(resp *http.Response, data []byte) APIError {
	e := APIError{StatusCode: resp.StatusCode}
	var env errorEnvelope
	if err := json.Unmarshal(data, &env); err == nil {
		e.Code = jsonString(env.Code)
		e.Message = jsonString(env.Message)
		for _, d := range env.Details {
			e.Details = append(e.Details, d.Type+": "+string(d.Value))
		}
	}
	if e.Message == "" {
		msg := strings.TrimSpace(string(data))
		if msg == "" {
			msg = resp.Status
		}
		e.Message = truncate(msg, 300)
	}
	return e
}

func jsonString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	default:
		return fmt.Sprint(t)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// summarizeBody 打印写请求时不带 Api-Key，但请求 body 本身是业务数据，可以整段打出来供核对。
func summarizeBody(body any) string {
	b, err := json.Marshal(body)
	if err != nil {
		return fmt.Sprintf("%+v", body)
	}
	return truncate(string(b), 2000)
}
