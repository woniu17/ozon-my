// 转发器：把 spool 里的事件按接收顺序投递到 erp，失败退避重试。
package proxy

import (
	"bytes"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"ozon-webhook-proxy/internal/alert"
	"ozon-webhook-proxy/internal/config"
	"ozon-webhook-proxy/internal/spool"
)

// Stats 是对外暴露的运行指标，供 /webhook/health 与告警判断使用。
type Stats struct {
	Received       int64   `json:"received"`
	Forwarded      int64   `json:"forwarded"`
	Dead           int64   `json:"dead"`
	QueueDepth     int     `json:"queue_depth"`
	OldestAgeSec   float64 `json:"oldest_age_seconds"`
	ConsecFailures int64   `json:"consecutive_failures"`
	ErpReachable   bool    `json:"erp_reachable"`
	LastForwardOK  string  `json:"last_forward_ok"`
	LastFailure    string  `json:"last_failure"`
	LastForwardMs  int64   `json:"last_forward_ms"`
}

type Forwarder struct {
	cfg   *config.Config
	spool *spool.Spool
	al    *alert.Alerter
	http  *http.Client

	statsMu sync.RWMutex
	stats   Stats

	triesMu sync.Mutex
	tries   map[string]int
	nextAt  map[string]time.Time

	wake   chan struct{}
	stop   chan struct{}
	closed chan struct{}
}

func NewForwarder(cfg *config.Config, sp *spool.Spool, al *alert.Alerter) *Forwarder {
	f := &Forwarder{
		cfg:   cfg,
		spool: sp,
		al:    al,
		http: &http.Client{
			Timeout: cfg.ForwardTimeout,
			Transport: &http.Transport{
				DialContext:         (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
				TLSHandshakeTimeout: 3 * time.Second,
				MaxIdleConns:        4,
				IdleConnTimeout:     60 * time.Second,
			},
		},
		tries:  make(map[string]int),
		nextAt: make(map[string]time.Time),
		wake:   make(chan struct{}, 1),
		stop:   make(chan struct{}),
		closed: make(chan struct{}),
	}
	// 启动即认为可达，真正的连通性由第一条转发结果决定；
	// 这样刚重启时不会误报"erp 不可达"。
	f.stats = Stats{ErpReachable: true}
	return f
}

func (f *Forwarder) Run() {
	defer close(f.closed)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		f.drainOnce()
		select {
		case <-f.stop:
			f.drainOnce()
			return
		case <-ticker.C:
		case <-f.wake:
		}
	}
}

func (f *Forwarder) Stop() {
	close(f.stop)
	select {
	case <-f.closed:
	case <-time.After(f.cfg.DrainTimeout):
		log.Printf("[forwarder] 退出等待 %s 超时，未转发完的事件留在 spool 里，下次启动续投", f.cfg.DrainTimeout)
	}
}

// Signal 让刚入队的事件立刻被尝试转发，不必等 ticker。
func (f *Forwarder) Signal() {
	select {
	case f.wake <- struct{}{}:
	default:
	}
}

// drainOnce 扫一遍 pending。队头需要退避时立刻停手，不许后面的插队——
// 同一 posting 的状态变更事件乱序进 erp 会算错状态。
func (f *Forwarder) drainOnce() {
	items, err := f.spool.Pending()
	if err != nil {
		log.Printf("[forwarder] 读 spool 失败: %v", err)
		return
	}
	now := time.Now()
	for _, it := range items {
		f.triesMu.Lock()
		next := f.nextAt[it.Name]
		f.triesMu.Unlock()
		if now.Before(next) {
			return
		}
		if !f.forward(it) {
			return
		}
	}
	f.publishStats()
}

// forward 返回 true 表示这条已终结（成功或进 dead），可以继续下一条。
func (f *Forwarder) forward(it spool.Item) bool {
	env, err := f.spool.Read(it)
	if err != nil {
		log.Printf("[forwarder] %v", err)
		if merr := f.spool.Dead(it, "unreadable: "+err.Error()); merr != nil {
			log.Printf("[forwarder] %v", merr)
		}
		f.countDead()
		return true
	}

	start := time.Now()
	status, respBody, postErr := f.post(env)
	elapsed := time.Since(start)

	switch {
	case postErr == nil && status >= 200 && status < 300:
		if derr := f.spool.Done(it); derr != nil {
			log.Printf("[forwarder] %v", derr)
		}
		f.clearRetry(it.Name)
		f.update(func(st *Stats) {
			st.Forwarded++
			st.ConsecFailures = 0
			st.ErpReachable = true
			st.LastForwardOK = time.Now().UTC().Format(time.RFC3339)
			st.LastForwardMs = elapsed.Milliseconds()
		})
		// erp 只会对入参问题回 4xx，2xx 里带 error 体说明有非预期分支，记一条便于事后定位
		if strings.Contains(respBody, "error") {
			log.Printf("[forwarder] %s erp 回 %d 但响应体含 error: %s", it.Name, status, truncate(respBody, 200))
		}
		return true

	case postErr != nil:
		return f.retryLater(it, postErr.Error(), true)

	case status >= 500 || status == http.StatusTooManyRequests:
		return f.retryLater(it, http.StatusText(status), false)

	default:
		// 其余 4xx：入参或白名单问题，重试无意义，进 dead 并告警（多为配置错误）
		f.clearRetry(it.Name)
		if merr := f.spool.Dead(it, strconv.Itoa(status)+": "+respBody); merr != nil {
			log.Printf("[forwarder] %v", merr)
		}
		f.countDead()
		f.al.Send("dead", "事件被 erp 判为永久失败(HTTP "+strconv.Itoa(status)+")，已移入 dead 目录: "+
			it.Name+" / "+truncate(respBody, 200))
		return true
	}
}

func (f *Forwarder) post(env *spool.Envelope) (int, string, error) {
	req, err := http.NewRequest(http.MethodPost, f.cfg.TargetURL, bytes.NewReader(env.Payload))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	// erp 的 ipWhitelist 取 X-Forwarded-For 首段比对 Ozon 网段，
	// 所以必须透传 Ozon 真实源 IP，否则会被 erp 判 403。
	req.Header.Set("X-Forwarded-For", env.SrcIP)
	if f.cfg.ProxyToken != "" {
		req.Header.Set("X-Webhook-Proxy", f.cfg.ProxyToken)
	}

	resp, err := f.http.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	return resp.StatusCode, string(body), nil
}

func (f *Forwarder) retryLater(it spool.Item, reason string, transportFailure bool) bool {
	f.triesMu.Lock()
	f.tries[it.Name]++
	n := f.tries[it.Name]
	delay := backoff(n, f.cfg.RetryMax)
	f.nextAt[it.Name] = time.Now().Add(delay)
	f.triesMu.Unlock()

	var consec int64
	f.update(func(st *Stats) {
		st.ConsecFailures++
		st.ErpReachable = !transportFailure
		st.LastFailure = time.Now().UTC().Format(time.RFC3339) + " " + reason
		consec = st.ConsecFailures
	})

	log.Printf("[forwarder] 第 %d 次转发失败 %s: %s，%s 后重试", n, it.Name, reason, delay)

	if n >= f.cfg.MaxRetries {
		f.clearRetry(it.Name)
		if merr := f.spool.Dead(it, "max retries: "+reason); merr != nil {
			log.Printf("[forwarder] %v", merr)
		}
		f.countDead()
		f.al.Send("dead", "事件重试 "+strconv.Itoa(n)+" 次仍失败，移入 dead: "+it.Name+" ("+reason+")")
		return true
	}
	if consec == int64(f.cfg.AlertConsecFail) {
		f.al.Send("erp-unreachable", "连续 "+strconv.Itoa(f.cfg.AlertConsecFail)+
			" 条事件转发 erp 失败，最后错误: "+reason+"；队列积压 "+strconv.Itoa(f.spool.Depth())+
			" 条。事件已落盘不会丢，但 erp 处理会延迟")
	}
	return false
}

func (f *Forwarder) countDead() {
	f.update(func(st *Stats) { st.Dead++ })
}

func (f *Forwarder) clearRetry(name string) {
	f.triesMu.Lock()
	delete(f.tries, name)
	delete(f.nextAt, name)
	f.triesMu.Unlock()
}

// update 在持锁状态下修改指标。接收侧（CountReceived）与唯一的转发 worker 都会进来，
// 所以这里必须加锁，不能用无锁的读-改-写。
func (f *Forwarder) update(fn func(*Stats)) {
	f.statsMu.Lock()
	fn(&f.stats)
	f.statsMu.Unlock()
}

func (f *Forwarder) publishStats() {
	f.update(func(st *Stats) {
		st.QueueDepth = f.spool.Depth()
		st.OldestAgeSec = f.spool.OldestAge().Seconds()
	})
	st := f.Stats()

	if st.QueueDepth > 0 && st.OldestAgeSec > f.cfg.AlertStaleAfter.Seconds() {
		f.al.Send("stale", "队头事件已滞留 "+(time.Duration(st.OldestAgeSec*float64(time.Second))).String()+
			"，队列 "+strconv.Itoa(st.QueueDepth)+" 条；检查 nuc 是否在线、17443 是否可达")
	}
}

// Stats 返回带队列态的指标快照。
func (f *Forwarder) Stats() Stats {
	f.statsMu.RLock()
	st := f.stats
	f.statsMu.RUnlock()
	st.QueueDepth = f.spool.Depth()
	st.OldestAgeSec = f.spool.OldestAge().Seconds()
	return st
}

// CountReceived 由接收侧在落盘成功后调用。
func (f *Forwarder) CountReceived() {
	f.update(func(st *Stats) { st.Received++ })
}

// backoff 指数退避：1s、2s、4s …… 封顶 RetryMax，再叠加 ±20% 抖动，
// 避免 nuc 恢复的瞬间积压消息一起重发把它打垮。
func backoff(attempt int, limit time.Duration) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 16 {
		attempt = 16
	}
	d := time.Second << uint(attempt-1)
	if d > limit {
		d = limit
	}
	span := int64(d) / 5
	jitter := rand.Int63n(2*span+1) - span
	return d + time.Duration(jitter)
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
