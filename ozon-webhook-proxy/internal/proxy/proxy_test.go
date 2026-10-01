package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ozon-webhook-proxy/internal/alert"
	"ozon-webhook-proxy/internal/config"
	"ozon-webhook-proxy/internal/spool"
)

// fakeErp 记录每次收到的请求，并按 statusFor 决定响应码。
type fakeErp struct {
	ts      *httptest.Server
	mu      sync.Mutex
	bodies  []string
	xff     []string
	tokens  []string
	statusF func(body string) int
}

func newFakeErp(t *testing.T, statusF func(string) int) *fakeErp {
	t.Helper()
	f := &fakeErp{statusF: statusF}
	f.ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.bodies = append(f.bodies, string(body))
		f.xff = append(f.xff, r.Header.Get("X-Forwarded-For"))
		f.tokens = append(f.tokens, r.Header.Get("X-Webhook-Proxy"))
		f.mu.Unlock()
		status := http.StatusOK
		if f.statusF != nil {
			status = f.statusF(string(body))
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, `{"result":true}`)
	}))
	t.Cleanup(f.ts.Close)
	return f
}

func (f *fakeErp) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.bodies...)
}

func (f *fakeErp) seen(i int) (body, xff, token string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if i >= len(f.bodies) {
		return "", "", ""
	}
	return f.bodies[i], f.xff[i], f.tokens[i]
}

func testConfig(t *testing.T, targetURL string) *config.Config {
	t.Helper()
	return &config.Config{
		ListenAddr:      "127.0.0.1:0",
		TargetURL:       targetURL,
		SpoolDir:        filepath.Join(t.TempDir(), "spool"),
		AppName:         "ozon-erp",
		AppVersion:      "2.0.0",
		MaxBodyBytes:    1 << 20,
		ForwardTimeout:  2 * time.Second,
		MaxRetries:      200,
		RetryMax:        time.Minute,
		DrainTimeout:    time.Second,
		AlertConsecFail: 5,
		AlertStaleAfter: time.Hour,
	}
}

func newPair(t *testing.T, cfg *config.Config) (*Server, *Forwarder, *spool.Spool) {
	t.Helper()
	sp, err := spool.Open(cfg.SpoolDir)
	if err != nil {
		t.Fatalf("spool.Open: %v", err)
	}
	// 空 token：告警只写日志，测试不发外网请求
	fwd := NewForwarder(cfg, sp, alert.New("", time.Minute))
	return NewServer(cfg, sp, fwd), fwd, sp
}

func post(t *testing.T, s *Server, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/webhook/ozon", strings.NewReader(body))
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

// ---- 接收侧 ----

func TestPingAnsweredLocally(t *testing.T) {
	cfg := testConfig(t, "http://127.0.0.1:1/never")
	s, _, sp := newPair(t, cfg)

	w := post(t, s, `{"type":"TYPE_PING","message_type":"TYPE_PING"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d body = %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q，Ozon 要求 application/json 否则判 INVALID_BODY", ct)
	}
	var got struct {
		Version string `json:"version"`
		Name    string `json:"name"`
		Time    string `json:"time"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("响应不是 JSON: %v (%s)", err, w.Body)
	}
	if got.Name != "ozon-erp" || got.Version != "2.0.0" || got.Time == "" {
		t.Errorf("PING 响应 = %+v", got)
	}
	if sp.Depth() != 0 {
		t.Errorf("PING 不应进队列, depth = %d", sp.Depth())
	}
}

func TestAckReturnsResultTrue(t *testing.T) {
	erp := newFakeErp(t, nil)
	cfg := testConfig(t, erp.ts.URL)
	s, fwd, sp := newPair(t, cfg)

	w := post(t, s, `{"message_type":"TYPE_NEW_POSTING","result":{"posting_number":"123"}}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d body = %s", w.Code, w.Body)
	}
	if got := strings.TrimSpace(w.Body.String()); got != `{"result":true}` {
		t.Errorf("响应体 = %s, want {\"result\":true}", got)
	}

	// 关键契约：回包时消息只落盘、还没转发。同步等 erp 会让响应时延
	// 受 nuc 网络影响，超过 5 秒就计入 Ozon 的"服务不可用"。
	if sp.Depth() != 1 {
		t.Errorf("回包后应先落盘, depth = %d", sp.Depth())
	}
	if len(erp.calls()) != 0 {
		t.Errorf("回包前不应请求 erp")
	}
	if st := fwd.Stats(); st.Received != 1 || st.Forwarded != 0 {
		t.Errorf("stats = %+v", st)
	}
}

func TestBadRequestsGetOzonErrorTemplate(t *testing.T) {
	erp := newFakeErp(t, nil)
	cfg := testConfig(t, erp.ts.URL)
	s, _, sp := newPair(t, cfg)

	cases := []struct {
		name       string
		method     string
		body       string
		wantCode   int
		wantErrCde string
	}{
		{"缺 message_type", http.MethodPost, `{"result":{}}`, http.StatusBadRequest, "ERROR_PARAMETER_VALUE_MISSED"},
		{"非法 JSON", http.MethodPost, `{`, http.StatusBadRequest, "ERROR_PARAMETER_VALUE_MISSED"},
		{"GET 不允许", http.MethodGet, ``, http.StatusMethodNotAllowed, "ERROR_UNKNOWN"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(c.method, "/webhook/ozon", strings.NewReader(c.body))
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != c.wantCode {
				t.Fatalf("code = %d, want %d (%s)", w.Code, c.wantCode, w.Body)
			}
			var e struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil {
				t.Fatalf("错误响应不是模板: %v (%s)", err, w.Body)
			}
			if e.Error.Code != c.wantErrCde {
				t.Errorf("code = %q, want %q", e.Error.Code, c.wantErrCde)
			}
		})
	}
	if sp.Depth() != 0 {
		t.Errorf("非法请求不应入队, depth = %d", sp.Depth())
	}
}

func TestOversizedBodyRejected(t *testing.T) {
	cfg := testConfig(t, "http://127.0.0.1:1/never")
	cfg.MaxBodyBytes = 32
	s, _, sp := newPair(t, cfg)

	w := post(t, s, `{"message_type":"TYPE_X","padding":"`+strings.Repeat("a", 4096)+`"}`, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400 (%s)", w.Code, w.Body)
	}
	if sp.Depth() != 0 {
		t.Errorf("超限 body 不应入队")
	}
}

func TestHealthReportsStats(t *testing.T) {
	erp := newFakeErp(t, nil)
	cfg := testConfig(t, erp.ts.URL)
	s, fwd, sp := newPair(t, cfg)
	_, _ = sp.Append(&spool.Envelope{MessageType: "TYPE_A", Payload: json.RawMessage(`{}`)})
	fwd.drainOnce()

	r := httptest.NewRequest(http.MethodGet, "/webhook/health", nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d", w.Code)
	}
	var got struct {
		Status string `json:"status"`
		Role   string `json:"role"`
		Proxy  Stats  `json:"proxy"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("health 不是 JSON: %v (%s)", err, w.Body)
	}
	if got.Status != "ok" || got.Role != "webhook-proxy" {
		t.Errorf("health = %+v", got)
	}
	if got.Proxy.Forwarded != 1 || got.Proxy.QueueDepth != 0 {
		t.Errorf("health.proxy = %+v", got.Proxy)
	}
}

// ---- 转发侧 ----

// payload 原样转发：erp 的幂等键由字段明文拼接，product_id/sku 大整数
// 一旦经 map 中转就丢精度，幂等键随之改变 → 重复入库。
func TestForwardPreservesBytesAndSourceIP(t *testing.T) {
	erp := newFakeErp(t, nil)
	cfg := testConfig(t, erp.ts.URL)
	cfg.ProxyToken = "secret"
	s, fwd, sp := newPair(t, cfg)

	const raw = `{"message_type":"TYPE_POSTING_NUMBER_CHANGED","result":{"product_id":1812345678901234567,"sku":9223372036854775807}}`
	// 195.34.21.0/24 是 Ozon 文档声明的推送源段之一，erp 的 ipWhitelist 按它比对
	w := post(t, s, raw, map[string]string{"X-Forwarded-For": "195.34.21.77, 127.0.0.1"})
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d", w.Code)
	}
	fwd.drainOnce()

	body, xff, token := erp.seen(0)
	if body != raw {
		t.Errorf("转发 body 被改写:\n got %s\nwant %s", body, raw)
	}
	if xff != "195.34.21.77" {
		t.Errorf("X-Forwarded-For = %q, want Ozon 真实源 IP（erp 白名单取首段比对）", xff)
	}
	if token != "secret" {
		t.Errorf("X-Webhook-Proxy = %q", token)
	}
	if sp.Depth() != 0 {
		t.Errorf("成功后应删除, depth = %d", sp.Depth())
	}
	if st := fwd.Stats(); st.Forwarded != 1 || st.ConsecFailures != 0 || !st.ErpReachable {
		t.Errorf("stats = %+v", st)
	}
}

func TestTransportFailureKeepsEventForRetry(t *testing.T) {
	cfg := testConfig(t, "http://127.0.0.1:1/unreachable")
	sp0, err := spool.Open(cfg.SpoolDir)
	if err != nil {
		t.Fatal(err)
	}
	fwd := NewForwarder(cfg, sp0, alert.New("", time.Minute))
	if _, err := sp0.Append(&spool.Envelope{MessageType: "TYPE_A", Payload: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}

	fwd.drainOnce()
	if sp0.Depth() != 1 {
		t.Fatalf("传输失败不应丢消息, depth = %d", sp0.Depth())
	}
	st := fwd.Stats()
	if st.ConsecFailures != 1 || st.ErpReachable || st.Forwarded != 0 {
		t.Errorf("stats = %+v", st)
	}
	if st.LastFailure == "" {
		t.Error("LastFailure 应记录错误")
	}

	// 队头退避期间不许把后面的消息插队发出去
	fwd.drainOnce()
	if sp0.Depth() != 1 {
		t.Errorf("退避期间不应立刻重试")
	}
}

func TestServerErrorRetriesForeverThenSucceeds(t *testing.T) {
	fail := true
	erp := newFakeErp(t, func(string) int {
		if fail {
			return http.StatusInternalServerError
		}
		return http.StatusOK
	})
	cfg := testConfig(t, erp.ts.URL)
	s, fwd, sp := newPair(t, cfg)

	post(t, s, `{"message_type":"TYPE_A"}`, nil)
	fwd.drainOnce()
	if sp.Depth() != 1 || fwd.Stats().Forwarded != 0 {
		t.Fatalf("5xx 应留在队列等待重试: %+v", fwd.Stats())
	}

	// 绕过退避窗口：清掉 nextAt，模拟"退避时间到了"
	fwd.clearRetry(firstPending(t, sp))
	fail = false
	fwd.drainOnce()

	if sp.Depth() != 0 {
		t.Errorf("erp 恢复后应投递成功, depth = %d", sp.Depth())
	}
	if len(erp.calls()) != 2 {
		t.Errorf("erp 收到 %d 次, want 2（一次失败一次成功）", len(erp.calls()))
	}
	if st := fwd.Stats(); st.Forwarded != 1 || !st.ErpReachable {
		t.Errorf("stats = %+v", st)
	}
}

// erp 判 4xx（白名单/入参）时重试毫无意义：进 dead 目录留档并告警。
func TestClientErrorGoesToDead(t *testing.T) {
	erp := newFakeErp(t, func(string) int { return http.StatusForbidden })
	cfg := testConfig(t, erp.ts.URL)
	s, fwd, sp := newPair(t, cfg)

	name, err := s.sp.Append(&spool.Envelope{MessageType: "TYPE_A", Payload: json.RawMessage(`{"message_type":"TYPE_A"}`)})
	if err != nil {
		t.Fatal(err)
	}
	fwd.drainOnce()

	if sp.Depth() != 0 {
		t.Errorf("4xx 不应无限重试, depth = %d", sp.Depth())
	}
	if st := fwd.Stats(); st.Dead != 1 || st.Forwarded != 0 {
		t.Errorf("stats = %+v", st)
	}
	reason, err := os.ReadFile(filepath.Join(cfg.SpoolDir, "dead", name+".reason"))
	if err != nil {
		t.Fatalf("dead 边车文件缺失: %v", err)
	}
	if !strings.HasPrefix(string(reason), "403:") {
		t.Errorf("reason = %q", reason)
	}
	if len(erp.calls()) != 1 {
		t.Errorf("4xx 后不该再请求, calls = %d", len(erp.calls()))
	}
}

func TestMaxRetriesSendsToDead(t *testing.T) {
	erp := newFakeErp(t, func(string) int { return http.StatusBadGateway })
	cfg := testConfig(t, erp.ts.URL)
	cfg.MaxRetries = 1
	s, fwd, sp := newPair(t, cfg)

	post(t, s, `{"message_type":"TYPE_A"}`, nil)
	fwd.drainOnce()
	if sp.Depth() != 0 {
		t.Errorf("达到 MaxRetries 应进 dead, depth = %d", sp.Depth())
	}
	if st := fwd.Stats(); st.Dead != 1 {
		t.Errorf("stats = %+v", st)
	}
}

// 队头失败时必须停手：同一 posting 的状态变更事件乱序进 erp 会算错状态。
func TestHeadOfLineBlockingKeepsOrder(t *testing.T) {
	erp := newFakeErp(t, func(body string) int {
		if strings.Contains(body, "FIRST") {
			return http.StatusServiceUnavailable
		}
		return http.StatusOK
	})
	cfg := testConfig(t, erp.ts.URL)
	s, fwd, sp := newPair(t, cfg)

	post(t, s, `{"message_type":"TYPE_A","tag":"FIRST"}`, nil)
	post(t, s, `{"message_type":"TYPE_A","tag":"SECOND"}`, nil)
	fwd.drainOnce()

	if len(erp.calls()) != 1 {
		t.Fatalf("队头失败时第二条不该发出, calls = %v", erp.calls())
	}
	if !strings.Contains(erp.calls()[0], "FIRST") {
		t.Errorf("发出的不是队头消息: %s", erp.calls()[0])
	}
	if sp.Depth() != 2 {
		t.Errorf("两条都应留在队列, depth = %d", sp.Depth())
	}
}

func TestUnreadableSpoolFileGoesToDead(t *testing.T) {
	erp := newFakeErp(t, nil)
	cfg := testConfig(t, erp.ts.URL)
	_, fwd, sp := newPair(t, cfg)

	if err := os.MkdirAll(filepath.Join(cfg.SpoolDir, "pending"), 0o750); err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(cfg.SpoolDir, "pending", "1730000000000000000-000001-TYPE_A.json")
	if err := os.WriteFile(bad, []byte(`不是 JSON`), 0o600); err != nil {
		t.Fatal(err)
	}
	fwd.drainOnce()

	if sp.Depth() != 0 {
		t.Errorf("坏文件应移出 pending, depth = %d", sp.Depth())
	}
	if fwd.Stats().Dead != 1 {
		t.Errorf("stats = %+v", fwd.Stats())
	}
	if len(erp.calls()) != 0 {
		t.Errorf("坏文件不该发给 erp")
	}
}

func TestBackoffGrowsAndCaps(t *testing.T) {
	limit := 5 * time.Minute
	for i, want := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second} {
		lo, hi := want*4/5, want*6/5
		for n := 0; n < 100; n++ {
			if d := backoff(i+1, limit); d < lo || d > hi {
				t.Fatalf("attempt=%d 抖动越界: %v, want [%v,%v]", i+1, d, lo, hi)
			}
		}
	}
	// 封顶后停在 limit ±20%，不会无限增长
	for n := 0; n < 100; n++ {
		if d := backoff(200, limit); d < limit*4/5 || d > limit*6/5 {
			t.Fatalf("封顶后 = %v, want [%v,%v]", d, limit*4/5, limit*6/5)
		}
	}
	// 单调增长（抖动区间重叠时允许不严格递增，但中位数必须递增）
	if backoff(10, limit) <= backoff(3, limit) {
		t.Error("退避没有随次数增长")
	}
}

// tencent 上的 ozonerp.conf 只设了 X-Real-IP，没有 XFF，所以这条路径必须能用。
func TestClientIPFromRealIPOrRemoteAddr(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.Header.Set("X-Real-IP", "2001:67a:7::80")
	if got := clientIP(r); got != "2001:67a:7::80" {
		t.Errorf("X-Real-IP IPv6 = %q", got)
	}

	// nginx 的 $remote_addr 对 IPv6 客户端可能带方括号，且会带 zone（链路本地）
	rb := httptest.NewRequest(http.MethodPost, "/", nil)
	rb.Header.Set("X-Real-IP", "[fe80::1%en0]")
	if got := clientIP(rb); got != "fe80::1" {
		t.Errorf("方括号/zone 未剥掉: %q", got)
	}

	r2 := httptest.NewRequest(http.MethodPost, "/", nil)
	r2.RemoteAddr = "185.73.192.55:51234"
	if got := clientIP(r2); got != "185.73.192.55" {
		t.Errorf("无头时应取 socket 对端, got %q", got)
	}

	r3 := httptest.NewRequest(http.MethodPost, "/", nil)
	r3.Header.Set("X-Forwarded-For", " not-an-ip , 195.34.21.9")
	r3.Header.Set("X-Real-IP", "91.223.93.1")
	if got := clientIP(r3); got != "91.223.93.1" {
		t.Errorf("XFF 首段非法时应回落 X-Real-IP, got %q", got)
	}
}

func firstPending(t *testing.T, sp *spool.Spool) string {
	t.Helper()
	items, err := sp.Pending()
	if err != nil {
		t.Fatalf("读 pending: %v", err)
	}
	if len(items) == 0 {
		t.Fatal("pending 为空")
	}
	return items[0].Name
}
