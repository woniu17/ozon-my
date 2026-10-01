// 客户端单测：重点验证两件事——重试只发生在可重试的错误上，以及 dry-run 绝不产生任何写请求。
// 这两条错了都会打到真实店铺，所以用 httptest 替身服务器精确计数。
package ozon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ozon-tasks/internal/config"
)

type recorder struct {
	t       *testing.T
	mu      sync.Mutex
	hits    map[string]int
	bodies  []string
	headers []http.Header
	srv     *httptest.Server
}

// newServer 按 path 返回预置响应序列；序列用尽后重复最后一个，避免测试要写一长串。
func newServer(t *testing.T, script map[string][]scriptedResponse) *recorder {
	t.Helper()
	r := &recorder{t: t, hits: map[string]int{}}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		r.mu.Lock()
		r.hits[req.URL.Path]++
		r.bodies = append(r.bodies, string(body))
		r.headers = append(r.headers, req.Header.Clone())
		n := r.hits[req.URL.Path]
		r.mu.Unlock()

		seq, ok := script[req.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprintf(w, `{"code":"404","message":"unexpected path %s"}`, req.URL.Path)
			return
		}
		item := seq[len(seq)-1]
		if n <= len(seq) {
			item = seq[n-1]
		}
		for k, v := range item.header {
			w.Header().Set(k, v)
		}
		w.WriteHeader(item.status)
		io.WriteString(w, item.body)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

type scriptedResponse struct {
	status int
	body   string
	header map[string]string
}

func ok(body string) scriptedResponse {
	return scriptedResponse{status: http.StatusOK, body: body}
}

func (r *recorder) count(path string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.hits[path]
}

func (r *recorder) lastBody() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.bodies) == 0 {
		return ""
	}
	return r.bodies[len(r.bodies)-1]
}

// testClient 用假退避：不真睡，只记录每轮该等多久，测试才能毫秒级跑完。
func testClient(t *testing.T, base string, dryRun bool, opts func(*Options)) (*Client, *[]time.Duration) {
	t.Helper()
	var waits []time.Duration
	o := Options{
		BaseURL: base,
		Timeout: 5 * time.Second,
		Retries: 3,
		Backoff: 10 * time.Millisecond,
		DryRun:  dryRun,
		Sleep: func(ctx context.Context, d time.Duration) error {
			waits = append(waits, d)
			return ctx.Err()
		},
	}
	if opts != nil {
		opts(&o)
	}
	c := NewClient(config.Shop{Name: "测试店", ClientID: "12345", APIKey: "super-secret-key-abcdef"}, o)
	return c, &waits
}

func TestRetriesOnlyRetryableStatuses(t *testing.T) {
	// 429、503 各抖一次后成功
	r := newServer(t, map[string][]scriptedResponse{
		"/v1/product/action/timer/status": {
			{status: http.StatusTooManyRequests, body: `{"code":"429","message":"too many requests"}`},
			{status: http.StatusServiceUnavailable, body: `{"code":"503","message":"upstream busy"}`},
			ok(`{"statuses":[{"product_id":1,"expired_at":"2026-01-02T03:04:05Z"}]}`),
		},
		"/v1/actions": {
			{status: http.StatusBadRequest, body: `{"code":"3","message":"invalid field offer_id","details":[{"type":"field","value":"offer_id"}]}`},
		},
	})
	c, waits := testClient(t, r.srv.URL, false, nil)

	st, err := c.TimerStatus(context.Background(), []int64{1})
	if err != nil {
		t.Fatalf("抖两次后应成功，实际: %v", err)
	}
	if len(st) != 1 {
		t.Fatalf("状态条数不对: %+v", st)
	}
	if got := r.count("/v1/product/action/timer/status"); got != 3 {
		t.Errorf("请求数 = %d，期望 3（2 次重试后成功）", got)
	}
	if len(*waits) != 2 {
		t.Errorf("退避次数 = %d，期望 2", len(*waits))
	}
	// 429 有最低等待门槛，别把限流当普通抖动快速重试
	if (*waits)[0] < 2*time.Second {
		t.Errorf("429 后退避 = %v，期望 >= 2s", (*waits)[0])
	}

	// 400 一次都不该重试
	if _, err := c.ListActions(context.Background()); err == nil {
		t.Fatal("400 应返回错误")
	}
	if got := r.count("/v1/actions"); got != 1 {
		t.Errorf("4xx 被重试了 %d 次，期望 1（4xx 重试只会白占配额）", got)
	}
}

func TestRetryAfterHeaderWins(t *testing.T) {
	r := newServer(t, map[string][]scriptedResponse{
		"/v1/actions": {
			{status: http.StatusTooManyRequests, body: `{}`, header: map[string]string{"Retry-After": "7"}},
			ok(`{"result":[]}`),
		},
	})
	c, waits := testClient(t, r.srv.URL, false, nil)
	if _, err := c.ListActions(context.Background()); err != nil {
		t.Fatalf("应重试后成功: %v", err)
	}
	if len(*waits) < 1 || (*waits)[len(*waits)-1] < 7*time.Second {
		t.Errorf("没照 Retry-After 等够: %v", *waits)
	}
}

func TestRetriesExhausted(t *testing.T) {
	r := newServer(t, map[string][]scriptedResponse{
		"/v1/actions": {{status: http.StatusBadGateway, body: `{"code":"502","message":"bad gateway"}`}},
	})
	c, _ := testClient(t, r.srv.URL, false, func(o *Options) { o.Retries = 2 })
	_, err := c.ListActions(context.Background())
	if err == nil {
		t.Fatal("全部失败时应报错")
	}
	if got := r.count("/v1/actions"); got != 3 {
		t.Errorf("请求数 = %d，期望 3（1 + 2 次重试）", got)
	}
	var ae APIError
	if !errors.As(err, &ae) || ae.StatusCode != http.StatusBadGateway {
		t.Errorf("错误里应带上状态码，实际: %v", err)
	}
}

func TestContextCancelBreaksRetryLoop(t *testing.T) {
	r := newServer(t, map[string][]scriptedResponse{
		"/v1/actions": {{status: http.StatusInternalServerError, body: `{}`}},
	})
	ctx, cancel := context.WithCancel(context.Background())
	c, _ := testClient(t, r.srv.URL, false, func(o *Options) {
		o.Retries = 50
		// 第一次退避时就取消，模拟停服时任务要立刻退出而不是把 50 轮等完
		o.Sleep = func(context.Context, time.Duration) error {
			cancel()
			return ctx.Err()
		}
	})
	start := time.Now()
	if _, err := c.ListActions(ctx); err == nil {
		t.Fatal("取消后应返回错误")
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("取消后仍耗了 %v，退出不够及时", time.Since(start))
	}
}

func TestDryRunIssuesNoWriteRequests(t *testing.T) {
	r := newServer(t, map[string][]scriptedResponse{
		"/v3/product/list":        {ok(`{"result":{"items":[{"product_id":11}],"last_id":""}}`)},
		"/v5/product/info/prices": {ok(`{"items":[]}`)},
	})
	c, _ := testClient(t, r.srv.URL, true, nil)
	ctx := context.Background()

	seen := 0
	if err := c.SweepProducts(ctx, "", func(p ProductPage) error { seen += len(p.Items); return nil }); err != nil {
		t.Fatalf("dry-run 不该拦读接口: %v", err)
	}
	if seen != 1 {
		t.Errorf("dry-run 下读接口应照常分页取回，实际收到 %d 个商品", seen)
	}

	var outcomes []PriceImportOutcome
	executed, err := c.ImportPrices(ctx, []PriceImportItem{{ProductID: 11, Price: "10.00", MinPrice: "9.99"}}, &outcomes)
	if err != nil || executed {
		t.Fatalf("ImportPrices dry-run: executed=%v err=%v", executed, err)
	}
	if executed, err := c.UpdateTimers(ctx, []int64{11}); err != nil || executed {
		t.Fatalf("UpdateTimers dry-run: executed=%v err=%v", executed, err)
	}
	if _, _, executed, err := c.DeactivateProducts(ctx, 1, []int64{11}); err != nil || executed {
		t.Fatalf("DeactivateProducts dry-run: executed=%v err=%v", executed, err)
	}

	for _, path := range []string{"/v1/product/import/prices", "/v1/product/action/timer/update", "/v1/actions/products/deactivate"} {
		if got := r.count(path); got != 0 {
			t.Errorf("dry-run 下 %s 被真实调用了 %d 次", path, got)
		}
	}
	if got := r.count("/v3/product/list"); got != 1 {
		t.Errorf("读接口应照常调用，实际 %d 次", got)
	}
}

func TestCredentialsSentAsHeaders(t *testing.T) {
	r := newServer(t, map[string][]scriptedResponse{"/v1/actions": {ok(`{"result":[]}`)}})
	c, _ := testClient(t, r.srv.URL, false, nil)
	if _, err := c.ListActions(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	h := r.headers[0]
	r.mu.Unlock()
	if h.Get("Client-Id") != "12345" {
		t.Errorf("Client-Id 头缺失: %v", h)
	}
	if h.Get("Api-Key") != "super-secret-key-abcdef" {
		t.Errorf("Api-Key 头缺失")
	}
}

func TestAPIKeyNeverLeaksIntoErrors(t *testing.T) {
	// 密钥只走请求头；错误信息、日志里都不许出现完整 Api-Key
	r := newServer(t, map[string][]scriptedResponse{
		"/v1/actions": {{status: http.StatusForbidden, body: `{"code":"5","message":"permission denied"}`}},
	})
	c, _ := testClient(t, r.srv.URL, false, func(o *Options) { o.Retries = 0 })
	_, err := c.ListActions(context.Background())
	if err == nil {
		t.Fatal("应报错")
	}
	if strings.Contains(err.Error(), "super-secret-key-abcdef") {
		t.Errorf("错误信息泄露密钥: %v", err)
	}
	if strings.Contains(fmt.Sprintf("%+v", c), "super-secret-key-abcdef") ||
		strings.Contains(fmt.Sprintf("%v", c), "super-secret-key-abcdef") ||
		strings.Contains(fmt.Sprintf("%#v", c), "super-secret-key-abcdef") {
		t.Error("Client 被格式化打印时泄露了完整密钥，任意 print 动词都不允许带出明文")
	}
	if !strings.Contains(err.Error(), "permission denied") {
		t.Errorf("错误信息丢了服务端原因: %v", err)
	}
}

func TestFlexNumberDecoding(t *testing.T) {
	// 价格字段线上见过字符串、数字、null、空串四种形态，任何一种解析失败都会让整店商品被判 0 个
	var p PriceInfo
	if err := json.Unmarshal([]byte(`{"product_id":"123","price":{"price":"99.90","min_price":0,"old_price":"","currency_code":"RUB"}}`), &p); err != nil {
		t.Fatalf("字符串/数字混合形态解析失败: %v", err)
	}
	if p.ProductID.Int64() != 123 {
		t.Errorf("product_id = %d，期望 123", p.ProductID.Int64())
	}
	if p.Price.Price == nil || p.Price.Price.Float64() != 99.9 {
		t.Errorf("price 解析错: %+v", p.Price)
	}
	if p.Price.OldPrice == nil || p.Price.OldPrice.Float64() != 0 {
		t.Errorf("空串 old_price 应落成 0: %+v", p.Price.OldPrice)
	}

	// null / 缺失 与 0 必须区分开：not_applicable 的判定就靠这个
	var q PriceInfo
	if err := json.Unmarshal([]byte(`{"product_id":1,"price":{"price":null,"min_price":0}}`), &q); err != nil {
		t.Fatalf("null 形态解析失败: %v", err)
	}
	if q.Price.Price != nil {
		t.Errorf("price:null 应解析成缺失，实际 %v", q.Price.Price.Float64())
	}
	if q.Price.MinPrice == nil || q.Price.MinPrice.Float64() != 0 {
		t.Error("min_price:0 应解析成有值 0，而不是缺失")
	}

	var r PriceInfo
	if err := json.Unmarshal([]byte(`{"product_id":1}`), &r); err != nil {
		t.Fatalf("缺 price 段解析失败: %v", err)
	}
	if r.Price != nil {
		t.Error("整个 price 段缺失时应为 nil")
	}
}

func TestProductListPaginationStops(t *testing.T) {
	// 第一页带数字游标、第二页带字符串游标，最后空游标收尾：三种形态都得正确终止
	r := newServer(t, map[string][]scriptedResponse{
		"/v3/product/list": {
			ok(`{"result":{"items":[{"product_id":1},{"product_id":2}],"last_id":900}}`),
			ok(`{"result":{"items":[{"product_id":3}],"last_id":"1200"}}`),
			ok(`{"result":{"items":[{"product_id":4}],"last_id":""}}`),
		},
	})
	c, _ := testClient(t, r.srv.URL, false, nil)
	var numbers, sizes []int
	total := 0
	err := c.SweepProducts(context.Background(), "", func(p ProductPage) error {
		numbers = append(numbers, p.Number)
		sizes = append(sizes, len(p.Items))
		total += len(p.Items)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if total != 4 {
		t.Fatalf("共取到 %d 个商品，期望 4", total)
	}
	if len(numbers) != 3 || numbers[0] != 1 || numbers[2] != 3 {
		t.Errorf("页号不对: %v", numbers)
	}
	if sizes[0] != 2 || sizes[1] != 1 || sizes[2] != 1 {
		t.Errorf("每页条数不对: %v", sizes)
	}
	if got := r.count("/v3/product/list"); got != 3 {
		t.Errorf("翻页 %d 次，期望 3", got)
	}
	// 数字游标要转成字符串原样回传，否则第二页会重复拿第一页
	if len(r.bodies) < 2 || !strings.Contains(r.bodies[1], `"last_id":"900"`) {
		t.Errorf("第二页请求没带上首页游标: %v", r.bodies)
	}
	if !strings.Contains(r.lastBody(), `"last_id":"1200"`) {
		t.Errorf("最后一次请求没带上字符串游标: %s", r.lastBody())
	}
}

func TestEmptyResultIsNotAnError(t *testing.T) {
	r := newServer(t, map[string][]scriptedResponse{
		"/v1/actions":          {ok(`{"result":[]}`)},
		"/v1/actions/products": {ok(`{"result":{"products":[],"last_id":""}}`)},
	})
	c, _ := testClient(t, r.srv.URL, false, nil)
	acts, err := c.ListActions(context.Background())
	if err != nil || len(acts) != 0 {
		t.Fatalf("空活动列表: %+v %v", acts, err)
	}
	products := 0
	err = c.SweepActionProducts(context.Background(), 5, "", func(p ActionProductPage) error {
		products += len(p.Products)
		return nil
	})
	if err != nil || products != 0 {
		t.Fatalf("空商品列表: %d 个, err=%v", products, err)
	}
}

func TestSweepProductsResumesFromCursor(t *testing.T) {
	// 断点续跑：从上次记下的游标开始，第一次请求就该带上它，而不是从头再扫一遍
	r := newServer(t, map[string][]scriptedResponse{
		"/v3/product/list": {ok(`{"result":{"items":[{"product_id":3}],"last_id":""}}`)},
	})
	c, _ := testClient(t, r.srv.URL, false, nil)

	var ids []int64
	err := c.SweepProducts(context.Background(), "1200", func(p ProductPage) error {
		if p.Number != 1 {
			t.Errorf("续跑的第一页页号 = %d，期望 1（页号只用于日志，不代表请求次数）", p.Number)
		}
		for _, it := range p.Items {
			ids = append(ids, it.ProductID.Int64())
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != 3 {
		t.Errorf("续跑只该拿到剩下那页: %v", ids)
	}
	if len(r.bodies) == 0 || !strings.Contains(r.bodies[0], `"last_id":"1200"`) {
		t.Errorf("续跑请求没带上断点游标: %v", r.bodies)
	}
	if got := r.count("/v3/product/list"); got != 1 {
		t.Errorf("翻页 %d 次，期望 1 次就到末尾", got)
	}
}

func TestSweepStopsWhenCursorDoesNotAdvance(t *testing.T) {
	// 接口在同一个游标上原地打转（真实遇到过）：必须报错收手。
	// 常驻进程若继续翻页就是无限循环，还会把这家店的限流配额一起吃干。
	r := newServer(t, map[string][]scriptedResponse{
		"/v3/product/list": {ok(`{"result":{"items":[{"product_id":1}],"last_id":900}}`)},
	})
	c, _ := testClient(t, r.srv.URL, false, nil)

	pages := 0
	err := c.SweepProducts(context.Background(), "", func(ProductPage) error {
		pages++
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "没有前进") {
		t.Fatalf("游标不前进应报错，实际: %v", err)
	}
	if pages != 1 {
		t.Errorf("只该处理一页就收手，实际处理了 %d 页", pages)
	}
	if got := r.count("/v3/product/list"); got != 2 {
		t.Errorf("请求 %d 次，期望 2 次（第二次发现游标没动就停）", got)
	}
}

func TestSweepPageErrorStopsImmediately(t *testing.T) {
	// onPage 报错必须中断整个扫描：调用方据此把游标停在出错页之前，重跑时这一页会重来
	r := newServer(t, map[string][]scriptedResponse{
		"/v3/product/list": {
			ok(`{"result":{"items":[{"product_id":1}],"last_id":"10"}}`),
			ok(`{"result":{"items":[{"product_id":2}],"last_id":"20"}}`),
			ok(`{"result":{"items":[{"product_id":3}],"last_id":""}}`),
		},
	})
	c, _ := testClient(t, r.srv.URL, false, nil)

	boom := errors.New("这一页处理失败")
	pages := 0
	err := c.SweepProducts(context.Background(), "", func(ProductPage) error {
		pages++
		if pages == 2 {
			return boom
		}
		return nil
	})
	if !errors.Is(err, boom) {
		t.Fatalf("应把 onPage 的错误原样传出，实际: %v", err)
	}
	if pages != 2 {
		t.Errorf("报错后还处理了 %d 页，期望 2", pages)
	}
	if got := r.count("/v3/product/list"); got != 2 {
		t.Errorf("请求 %d 次，期望报错后不再翻页", got)
	}
}
