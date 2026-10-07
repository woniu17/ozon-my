// 端到端任务测试：用一个假 Ozon 站点 + 真 SQLite 跑完整流程，重点验证三件事——
// 最低价的算价与入库状态、影子模式确实一个字节都没写、飞书文案逐行对得上 JS 版。
package task

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ozon-tasks/internal/config"
	"ozon-tasks/internal/feishu"
	"ozon-tasks/internal/ledger"
	"ozon-tasks/internal/logx"
)

// fakeOzon 是一家可编程的假店铺。
type fakeOzon struct {
	t    *testing.T
	srv  *httptest.Server
	mu   sync.Mutex
	hits map[string]int
	// requests 记下每个请求的 path+body：断点续跑这类测试要检查"第二次跑还查了哪些商品"
	requests []loggedReq
	// blockSub 命中时对应有 path 的请求直接 500，用来精确制造"扫到第 N 页时挂了"
	blockSub map[string]string

	products   []map[string]any
	prices     []map[string]any
	actions    []map[string]any
	actProds   map[string][]int64
	statuses   []map[string]any
	failedIDs  map[int64]bool // import/prices 里故意判失败的
	noReplyIDs map[int64]bool // import/prices 里完全不回话的

	importedBatches [][]map[string]any
	timerBatches    [][]int64
	deactivated     []map[string]any
	feishu          []string
}

type loggedReq struct{ path, body string }

func newFakeOzon(t *testing.T) *fakeOzon {
	f := &fakeOzon{
		t: t, hits: map[string]int{},
		actProds:  map[string][]int64{},
		blockSub:  map[string]string{},
		failedIDs: map[int64]bool{}, noReplyIDs: map[int64]bool{},
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeOzon) hit(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits[path]
}

// bodiesFor 返回某路径收到的全部请求体（按到达顺序）。
func (f *fakeOzon) bodiesFor(path string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.requests {
		if r.path == path {
			out = append(out, r.body)
		}
	}
	return out
}

// blockContains 让该路径上含 substr 的请求一律 500。传空串解除。
// 制造"某一页失败"必须按请求内容判定，不能按第几次调用：重试会让次数不可预测。
func (f *fakeOzon) blockContains(path, substr string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.blockSub[path] = substr
}

func (f *fakeOzon) blocked(path, body string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	sub := f.blockSub[path]
	return sub != "" && strings.Contains(body, sub)
}

func (f *fakeOzon) decode(path string, body []byte, out any) {
	if err := json.Unmarshal(body, out); err != nil {
		f.t.Fatalf("%s 请求体解析失败: %v", path, err)
	}
}

func (f *fakeOzon) serve(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	raw, _ := io.ReadAll(r.Body)
	defer r.Body.Close()
	f.mu.Lock()
	f.hits[path]++
	f.requests = append(f.requests, loggedReq{path: path, body: string(raw)})
	f.mu.Unlock()

	w.Header().Set("content-type", "application/json")
	if f.blocked(path, string(raw)) {
		w.WriteHeader(http.StatusInternalServerError)
		respond(w, `{"code":"500","message":"按请求内容拦截"}`)
		return
	}
	switch path {
	case "/feishu":
		var msg struct {
			MsgType string `json:"msg_type"`
			Content struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		f.decode(path, raw, &msg)
		f.mu.Lock()
		f.feishu = append(f.feishu, msg.Content.Text)
		f.mu.Unlock()
		respond(w, `{"code":0,"msg":"success"}`)

	case "/v3/product/list":
		var req struct {
			LastID string `json:"last_id"`
			Limit  int    `json:"limit"`
		}
		f.decode(path, raw, &req)
		// 按 last_id 切页，专门盯住翻页是否会漏或重复
		start := 0
		if req.LastID != "" {
			start = mustAtoi(req.LastID)
		}
		end := start + req.Limit
		if end > len(f.products) {
			end = len(f.products)
		}
		next := ""
		if end < len(f.products) {
			next = fmt.Sprint(end)
		}
		respond(w, fmt.Sprintf(`{"result":{"items":%s,"last_id":%q}}`, mustJSON(f.products[start:end]), next))

	case "/v5/product/info/prices":
		var req struct {
			Filter struct {
				ProductID []string `json:"product_id"`
			} `json:"filter"`
		}
		f.decode(path, raw, &req)
		// 只回这批商品的价格：逐页处理时"每页各查一次"必须能被测试看出来
		want := map[string]bool{}
		for _, id := range req.Filter.ProductID {
			want[id] = true
		}
		out := []map[string]any{}
		for _, p := range f.prices {
			if want[fmt.Sprint(p["product_id"])] {
				out = append(out, p)
			}
		}
		respond(w, fmt.Sprintf(`{"items":%s}`, mustJSON(out)))

	case "/v1/product/import/prices":
		var req struct {
			Prices []map[string]any `json:"prices"`
		}
		f.decode(path, raw, &req)
		f.mu.Lock()
		f.importedBatches = append(f.importedBatches, req.Prices)
		var results []map[string]any
		for _, p := range req.Prices {
			pid := int64(p["product_id"].(float64))
			if f.noReplyIDs[pid] {
				continue // 不回话：接口偶尔就是这样，逼调用方自己核对条数
			}
			results = append(results, map[string]any{
				"product_id": pid,
				"updated":    !f.failedIDs[pid],
				"errors":     []map[string]any{},
			})
		}
		f.mu.Unlock()
		respond(w, fmt.Sprintf(`{"result":%s}`, mustJSON(results)))

	case "/v1/product/action/timer/update":
		var req struct {
			ProductIDs []int64 `json:"product_ids"`
		}
		f.decode(path, raw, &req)
		f.mu.Lock()
		f.timerBatches = append(f.timerBatches, req.ProductIDs)
		f.mu.Unlock()
		respond(w, `{}`)

	case "/v1/product/action/timer/status":
		respond(w, fmt.Sprintf(`{"statuses":%s}`, mustJSON(f.statuses)))

	case "/v1/actions":
		respond(w, fmt.Sprintf(`{"result":%s}`, mustJSON(f.actions)))

	case "/v1/actions/products":
		var req struct {
			ActionID json.Number `json:"action_id"`
			LastID   string      `json:"last_id"`
			Limit    int         `json:"limit"`
		}
		f.decode(path, raw, &req)
		// 游标用"下标"模拟真实世界的不透明 string 游标：分页语义一致，够用来验证不重不漏
		ids := f.actProds[req.ActionID.String()]
		limit := req.Limit
		if limit <= 0 {
			limit = 100
		}
		start := mustAtoi(req.LastID)
		end := start + limit
		if end > len(ids) {
			end = len(ids)
		}
		next := ""
		if end < len(ids) {
			next = fmt.Sprint(end)
		}
		out := make([]map[string]any, 0, end-start)
		for _, id := range ids[start:end] {
			out = append(out, map[string]any{"id": id})
		}
		respond(w, fmt.Sprintf(`{"result":{"products":%s,"last_id":%q}}`, mustJSON(out), next))

	case "/v1/actions/products/deactivate":
		var req struct {
			ActionID   json.Number `json:"action_id"`
			ProductIDs []int64     `json:"product_ids"`
		}
		f.decode(path, raw, &req)
		f.mu.Lock()
		f.deactivated = append(f.deactivated, map[string]any{
			"action_id": req.ActionID.String(), "product_ids": req.ProductIDs,
		})
		f.mu.Unlock()
		respond(w, fmt.Sprintf(`{"result":{"product_ids":%s,"rejected":[]}}`, mustJSON(req.ProductIDs)))

	default:
		f.t.Fatalf("站点收到了预期外的请求: %s %s", r.Method, path)
	}
}

func respond(w http.ResponseWriter, s string) { fmt.Fprint(w, s) }

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func mustAtoi(s string) int {
	var n int
	fmt.Sscanf(s, "%d", &n)
	return n
}

var testShop = config.Shop{Name: "YQL01", ClientID: "777", APIKey: "test-key"}

// testNow 是这批发测共用的固定时钟。查游标新鲜度时必须用它：
// 拿 time.Now() 去查一个固定在中午的库，会被判定成"过期游标"而查不到。
var testNow = time.Date(2026, 10, 1, 12, 30, 0, 0, time.Local)

// newTestDeps 建一个跑在假店铺上的 Deps，返回依赖、台账和站点。
// 通知也发到假站点：这样测试能逐字检查文案，而不是只检查"调用过发送函数"。
func newTestDeps(t *testing.T, f *fakeOzon, dryRun bool) (*Deps, *ledger.DB) {
	t.Helper()
	db, err := ledger.Open(filepath.Join(t.TempDir(), "task.db"))
	if err != nil {
		t.Fatalf("开库失败: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	d := &Deps{
		Ledger:  db,
		Feishu:  feishu.NewSender("test-machine", 5*time.Second),
		Machine: "test-machine",
		Timeout: 5 * time.Second,
		DryRun:  dryRun,
		BaseURL: f.srv.URL,
		Sleep:   func(context.Context, time.Duration) error { return nil },
		Now:     func() time.Time { return testNow },
	}
	return d, db
}

func priceItem(pid int64, offerID string, price, minPrice any, currency string) map[string]any {
	p := map[string]any{"currency_code": currency}
	if price != nil {
		p["price"] = price
	}
	if minPrice != nil {
		p["min_price"] = minPrice
	}
	return map[string]any{"product_id": pid, "offer_id": offerID, "price": p}
}

func TestMinPriceMathAndLedgerStatuses(t *testing.T) {
	f := newFakeOzon(t)
	f.products = []map[string]any{{"product_id": 1}, {"product_id": 2}, {"product_id": 3}, {"product_id": 4}}
	f.prices = []map[string]any{
		priceItem(1, "OFF-A", "100.00", 0, "RUB"), // 待设置 → 99.99
		priceItem(2, "OFF-B", 50, 10, "RUB"),      // 已有最低价 → 跳过
		priceItem(3, "OFF-C", nil, nil, "RUB"),    // 无售价 → not_applicable
		priceItem(4, "OFF-D", "0", 0, "RUB"),      // 售价为 0 → 跳过（避免提交 -0.01）
	}
	f.failedIDs[1] = true // 让商品 1 设置失败，验证台账记 failed 而不是 set

	d, db := newTestDeps(t, f, false)
	ctx := context.Background()
	results, err := RunTimerUpdate(ctx, d, []config.Shop{testShop}, f.srv.URL+"/feishu")
	if err != nil {
		t.Fatalf("整轮失败: %v", err)
	}

	if len(f.importedBatches) != 1 {
		t.Fatalf("提交了 %d 批价格，期望 1", len(f.importedBatches))
	}
	items := f.importedBatches[0]
	if len(items) != 1 {
		t.Fatalf("应只提交 1 个待设置商品，实际 %d: %s", len(items), mustJSON(items))
	}
	got := items[0]
	// 这几个字段任何一个错了都会改变平台侧的改价行为，必须逐字钉住
	if got["min_price"] != "99.99" {
		t.Errorf("min_price = %v，期望 99.99（售价 100.00 减 0.01）", got["min_price"])
	}
	if got["price"] != "100" {
		t.Errorf("price = %v，期望原样回传 100（Ozon 要求同时带 price 才能过 min_price<=price 校验）", got["price"])
	}
	if got["auto_action_enabled"] != "DISABLED" || got["price_strategy_enabled"] != "DISABLED" {
		t.Errorf("自动调价/价格策略开关没关掉，平台会替我们改价: %s", mustJSON(got))
	}
	if got["min_price_for_auto_actions_enabled"] != true {
		t.Errorf("min_price_for_auto_actions_enabled 应为 true: %s", mustJSON(got))
	}

	res := results[0]
	if res.TotalProducts != 4 || res.MinPrice.Skip != 3 || res.MinPrice.Fail != 1 {
		t.Errorf("统计不对: %+v", res)
	}

	// 台账：失败的行 min_price 保持 0，成功的行才回写新值并记 set_at
	row1, _ := db.GetPrice(testShop.ClientID, 1)
	if row1 == nil || row1.MinPriceStatus != "failed" {
		t.Fatalf("商品 1 应记 failed: %+v", row1)
	}
	if row1.MinPrice != 0 {
		t.Errorf("设置失败却把新最低价写进了台账: %v", row1.MinPrice)
	}
	if row1.MinPriceSetAt != 0 {
		t.Errorf("设置失败不该更新 min_price_set_at: %d", row1.MinPriceSetAt)
	}
	row3, _ := db.GetPrice(testShop.ClientID, 3)
	if row3 == nil || row3.MinPriceStatus != "not_applicable" || row3.Price != nil {
		t.Errorf("无售价商品应记 not_applicable 且 price 为 NULL: %+v", row3)
	}
	row2, _ := db.GetPrice(testShop.ClientID, 2)
	if row2.MinPriceStatus != "skipped" {
		t.Errorf("已有最低价的商品应记 skipped: %+v", row2)
	}
}

func TestMinPriceSuccessWritesBackNewValue(t *testing.T) {
	f := newFakeOzon(t)
	f.products = []map[string]any{{"product_id": 11}}
	f.prices = []map[string]any{priceItem(11, "X", "7.5", 0, "CNY")}
	d, db := newTestDeps(t, f, false)

	if _, err := RunTimerUpdate(context.Background(), d, []config.Shop{testShop}, ""); err != nil {
		t.Fatal(err)
	}
	row, _ := db.GetPrice(testShop.ClientID, 11)
	// 快照查回来时 min_price 还是 0，必须把设置成功后的新值回写，否则入库等于存了个旧值
	if row.MinPrice != 7.49 {
		t.Errorf("台账 min_price = %v，期望回写为 7.49", row.MinPrice)
	}
	if row.MinPriceStatus != "set" || row.MinPriceSetAt == 0 {
		t.Errorf("状态应为 set 且带设置时间: %+v", row)
	}
	if row.CurrencyCode != "CNY" {
		t.Errorf("币种丢了: %+v", row)
	}
}

// JS 侧 min_price 走 toFixed(2)、price 走 String(currentPrice)，两者写法不同。
// Go 若统一用"最简小数"，整数价就会发出 "101" 而 JS 发 "101.00"：
// 数值没错，但并行对照期两边的报文逐字节比不了，真差异会被这种噪音埋掉。
func TestMinPriceWireFormatMatchesJS(t *testing.T) {
	f := newFakeOzon(t)
	f.products = []map[string]any{{"product_id": 31}}
	f.prices = []map[string]any{priceItem(31, "X", "10.01", 0, "RUB")}
	d, _ := newTestDeps(t, f, false)

	if _, err := RunTimerUpdate(context.Background(), d, []config.Shop{testShop}, ""); err != nil {
		t.Fatal(err)
	}
	bodies := f.bodiesFor("/v1/product/import/prices")
	if len(bodies) != 1 {
		t.Fatalf("应只提交一次改价，实际 %d 次", len(bodies))
	}
	for _, want := range []string{`"min_price":"10.00"`, `"price":"10.01"`, `"old_price":"0"`} {
		if !strings.Contains(bodies[0], want) {
			t.Errorf("报文缺 %s，实际: %s", want, bodies[0])
		}
	}
}

func TestMissingAPIReplyCountsAsFailure(t *testing.T) {
	f := newFakeOzon(t)
	f.products = []map[string]any{{"product_id": 21}, {"product_id": 22}}
	f.prices = []map[string]any{priceItem(21, "A", "10", 0, "RUB"), priceItem(22, "B", "20", 0, "RUB")}
	f.noReplyIDs[22] = true // Ozon 对商品 22 完全不回话

	d, db := newTestDeps(t, f, false)
	results, _ := RunTimerUpdate(context.Background(), d, []config.Shop{testShop}, "")
	st := results[0].MinPrice
	if st.Set != 1 || st.Fail != 1 {
		t.Errorf("没回执的商品被漏计了: 成功 %d 失败 %d，期望 1/1", st.Set, st.Fail)
	}
	row, _ := db.GetPrice(testShop.ClientID, 22)
	if row == nil || row.MinPriceStatus != "failed" {
		t.Errorf("无回执商品在台账里必须留痕，不能显示成没来过: %+v", row)
	}
}

func TestDryRunWritesNothingAnywhere(t *testing.T) {
	f := newFakeOzon(t)
	f.products = []map[string]any{{"product_id": 31}}
	f.prices = []map[string]any{priceItem(31, "A", "10", 0, "RUB")}
	f.statuses = []map[string]any{{"product_id": 31, "min_price_for_auto_actions_enabled": true, "expired_at": "2026-10-05T00:00:00Z"}}
	f.actions = []map[string]any{{"id": 500, "title": "十月活动", "participating_products_count": 1}}
	f.actProds["500"] = []int64{31}

	d, db := newTestDeps(t, f, true)
	ctx := context.Background()
	results, err := RunTimerUpdate(ctx, d, []config.Shop{testShop}, f.srv.URL+"/feishu")
	if err != nil {
		t.Fatal(err)
	}

	// 读接口照常，写接口一次都不许发
	for _, p := range []string{"/v3/product/list", "/v5/product/info/prices", "/v1/product/action/timer/status"} {
		if f.hit(p) == 0 {
			t.Errorf("dry-run 下读接口 %s 应该照常调用", p)
		}
	}
	for _, p := range []string{"/v1/product/import/prices", "/v1/product/action/timer/update"} {
		if n := f.hit(p); n != 0 {
			t.Errorf("dry-run 下 %s 被调用了 %d 次", p, n)
		}
	}
	if n, _ := db.CountPrices(); n != 0 {
		t.Errorf("dry-run 写了 %d 行台账，演练不该留下数据", n)
	}
	// "预计"必须和"成功"分开报，否则值班会把演练当成就绪
	if results[0].MinPrice.Set != 0 || results[0].MinPrice.Planned != 1 {
		t.Errorf("影子模式应只记预计: %+v", results[0].MinPrice)
	}
	if results[0].TimerSuccess != 0 || results[0].TimerPlanned != 1 {
		t.Errorf("影子模式定时器应只记预计: %+v", results[0])
	}

	deact, err := RunActionDeactivate(ctx, d, []config.Shop{testShop}, f.srv.URL+"/feishu")
	if err != nil {
		t.Fatal(err)
	}
	if n := f.hit("/v1/actions/products/deactivate"); n != 0 {
		t.Errorf("dry-run 撤下了商品 %d 次", n)
	}
	if deact[0].Deactivated != 0 || deact[0].Planned != 1 {
		t.Errorf("移除任务影子模式统计不对: %+v", deact[0])
	}

	text := strings.Join(f.feishu, "\n===\n")
	if !strings.Contains(text, "影子模式") {
		t.Error("通知里没标出影子模式，收信人会当真")
	}
}

func TestTimerFeishuCopyMatchesJS(t *testing.T) {
	f := newFakeOzon(t)
	f.products = []map[string]any{{"product_id": 41}, {"product_id": 42}}
	f.prices = []map[string]any{priceItem(41, "A", "10", 0, "RUB"), priceItem(42, "B", "20", 5, "RUB")}
	f.statuses = []map[string]any{
		{"product_id": 41, "min_price_for_auto_actions_enabled": true, "expired_at": "2026-10-09T16:00:00Z"},
	}
	d, _ := newTestDeps(t, f, false)
	if _, err := RunTimerUpdate(context.Background(), d, []config.Shop{testShop}, f.srv.URL+"/feishu"); err != nil {
		t.Fatal(err)
	}
	if len(f.feishu) != 1 {
		t.Fatalf("通知发了 %d 条，期望 1", len(f.feishu))
	}
	msg := f.feishu[0]
	for _, want := range []string{
		"✅ Ozon商品定时器批量更新完成",
		"🏪 店铺数量: 1",
		"📦 商品总数: 2",
		"✅ 定时器更新成功: 2",
		"❌ 定时器更新失败: 0",
		"💰 最低价设置成功: 1",
		"⏭️ 最低价跳过(已有): 1",
		"❌ 最低价设置失败: 0",
		"📋 各店铺详情:",
		"✅ YQL01: 2个商品【定时器成功2, 保持时间: ",
		"—— 来自 test-machine",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("文案缺少 %q\n实际:\n%s", want, msg)
		}
	}
}

func TestOneShopFailureDoesNotBlockOthers(t *testing.T) {
	f := newFakeOzon(t)
	f.products = []map[string]any{{"product_id": 51}}
	f.prices = []map[string]any{priceItem(51, "A", "10", 0, "RUB")}

	broken := config.Shop{Name: "坏店", ClientID: "888", APIKey: "k"}
	d, _ := newTestDeps(t, f, false)

	// 让坏店在拉商品列表时就 500（重试也救不回来）
	origServe := f.srv.Config.Handler
	f.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Client-Id") == "888" && r.URL.Path == "/v3/product/list" {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"code":"500","message":"shop unavailable"}`)
			return
		}
		origServe.ServeHTTP(w, r)
	})

	results, err := RunTimerUpdate(context.Background(), d, []config.Shop{broken, testShop}, "")
	// 坏店必须把这一班判成失败：否则台账记 status=ok、once 退出码 0，
	// 没人知道有半店商品没刷到，systemd 也不会报警
	if err == nil || !strings.Contains(err.Error(), "坏店") {
		t.Fatalf("单店失败应升格为整班失败: %v", err)
	}
	if strings.Contains(err.Error(), testShop.Name) {
		t.Errorf("好店不该出现在失败清单里: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("两家店都该有结果: %d", len(results))
	}
	if results[0].Success || results[0].ErrorMsg == "" {
		t.Errorf("坏店应记失败: %+v", results[0])
	}
	if !results[1].Success || results[1].TotalProducts != 1 {
		t.Errorf("好店被拖累了: %+v", results[1])
	}
}

func TestDeactivateSkipsEmptyActionsAndNotifiesOnlyWhenNeeded(t *testing.T) {
	f := newFakeOzon(t)
	f.actions = []map[string]any{
		{"id": 1, "title": "空活动", "participating_products_count": 0},
		{"id": 2, "title": "有商品活动", "participating_products_count": 2},
	}
	f.actProds["2"] = []int64{61, 62}
	d, _ := newTestDeps(t, f, false)
	ctx := context.Background()

	results, err := RunActionDeactivate(ctx, d, []config.Shop{testShop}, f.srv.URL+"/feishu")
	if err != nil {
		t.Fatal(err)
	}
	if f.hit("/v1/actions/products") != 1 {
		t.Errorf("0 参与商品的活动不该去拉商品清单，实际拉了 %d 次", f.hit("/v1/actions/products"))
	}
	if results[0].Deactivated != 2 || results[0].ActionCount != 2 {
		t.Errorf("结果不对: %+v", results[0])
	}
	if len(f.feishu) != 1 || !strings.Contains(f.feishu[0], "✅ 移除成功: 2 个商品") {
		t.Errorf("有移除时该发通知: %v", f.feishu)
	}

	// 全是空活动 → 一个都没撤 → 不发通知（JS 的取舍：不然群里全是空报告）
	f2 := newFakeOzon(t)
	f2.actions = []map[string]any{{"id": 9, "title": "空", "participating_products_count": 0}}
	d2, _ := newTestDeps(t, f2, false)
	if _, err := RunActionDeactivate(ctx, d2, []config.Shop{testShop}, f2.srv.URL+"/feishu"); err != nil {
		t.Fatal(err)
	}
	if len(f2.feishu) != 0 {
		t.Errorf("无移除不该发通知，实际发了: %v", f2.feishu)
	}
}

func TestDeactivateWholeBatchErrorIsCountedAsFailed(t *testing.T) {
	f := newFakeOzon(t)
	f.actions = []map[string]any{{"id": 3, "title": "活动", "participating_products_count": 1}}
	f.actProds["3"] = []int64{71}
	handler := f.srv.Config.Handler
	f.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/actions/products/deactivate" {
			w.WriteHeader(http.StatusBadRequest) // 4xx 不重试，直接算这批失败
			fmt.Fprint(w, `{"code":"400","message":"cannot deactivate"}`)
			return
		}
		handler.ServeHTTP(w, r)
	})
	d, _ := newTestDeps(t, f, false)
	results, err := RunActionDeactivate(context.Background(), d, []config.Shop{testShop}, f.srv.URL+"/feishu")
	// 整批被 4xx 拒掉 = 这个活动没撤完，必须升格成错误：游标留在断点，下一班才会去续
	if err == nil || !strings.Contains(err.Error(), "活动3") {
		t.Fatalf("没撤完的活动应让本轮判失败，实际 err=%v", err)
	}
	if results[0].Deactivated != 0 || results[0].Failed != 1 {
		t.Errorf("接口没回执就绝不能算撤下成功: %+v", results[0])
	}
}

func TestStatusOnlyTouchNoWriteEndpoints(t *testing.T) {
	f := newFakeOzon(t)
	f.products = []map[string]any{{"product_id": 81}}
	now := time.Now().UTC()
	f.statuses = []map[string]any{{
		"product_id": 81, "min_price_for_auto_actions_enabled": false,
		"expired_at": now.Add(24 * time.Hour).Format(time.RFC3339),
	}}
	d, _ := newTestDeps(t, f, false)
	if err := RunTimerStatusCheck(context.Background(), d, []config.Shop{testShop}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"/v1/product/import/prices", "/v1/product/action/timer/update", "/feishu"} {
		if n := f.hit(p); n != 0 {
			t.Errorf("状态巡检碰了 %s %d 次", p, n)
		}
	}
	if n := f.hit("/v1/product/action/timer/status"); n == 0 {
		t.Error("状态巡检应当查状态")
	}
}

func TestPaginationCoversAllProducts(t *testing.T) {
	f := newFakeOzon(t)
	// 1201 个商品：正好跨两页且尾页不满，用来验证翻页不会把尾巴丢掉
	for i := 1; i <= 1201; i++ {
		f.products = append(f.products, map[string]any{"product_id": i})
	}
	f.prices = []map[string]any{priceItem(1, "A", "10", 1, "RUB")}
	d, _ := newTestDeps(t, f, false)
	results, err := RunTimerUpdate(context.Background(), d, []config.Shop{testShop}, "")
	if err != nil {
		t.Fatal(err)
	}
	if results[0].TotalProducts != 1201 {
		t.Errorf("只统计到 %d 个商品，期望 1201", results[0].TotalProducts)
	}
	if f.hit("/v3/product/list") != 2 {
		t.Errorf("翻页 %d 次，期望 2", f.hit("/v3/product/list"))
	}
	if len(f.timerBatches) != 2 {
		t.Errorf("定时器分了 %d 批，期望 2（每批上限 1000）", len(f.timerBatches))
	}
	if len(f.timerBatches[0]) != 1000 || len(f.timerBatches[1]) != 201 {
		t.Errorf("批次切分不对: %d, %d", len(f.timerBatches[0]), len(f.timerBatches[1]))
	}
}

func TestEmptyShopListIsAnError(t *testing.T) {
	f := newFakeOzon(t)
	d, _ := newTestDeps(t, f, false)
	if _, err := RunTimerUpdate(context.Background(), d, nil, ""); err == nil {
		t.Error("店铺列表为空时应报错，静默跳过会让人以为定时任务在跑")
	}
	if _, err := RunActionDeactivate(context.Background(), d, nil, ""); err == nil {
		t.Error("移除任务同样不该静默跳过")
	}
}

// 保证 logx 的时间格式与 JS 侧 dayjs 一致（飞书文案里直接嵌这个串）
func TestTimeFormatParity(t *testing.T) {
	ms := time.Date(2026, 10, 1, 9, 5, 3, 0, time.Local).UnixMilli()
	if got := logx.FormatTime(ms); got != "2026-10-01 09:05:03" {
		t.Errorf("FormatTime = %q", got)
	}
}

func TestSweepResumesFromCursorAfterFailure(t *testing.T) {
	// 断点续跑是这轮重构的主要动机：一轮几万商品跑到第 2 页挂掉，
	// 绝不能下一次又从第 1 页重打一遍（重复改价 + 白烧配额）。
	f := newFakeOzon(t)
	for i := 1; i <= 1201; i++ {
		f.products = append(f.products, map[string]any{"product_id": i})
	}
	f.prices = []map[string]any{priceItem(1001, "A", "10", 0, "RUB")}

	d, db := newTestDeps(t, f, false)
	ctx := context.Background()
	f.blockContains("/v3/product/list", `"last_id":"1000"`) // 第 2 页起就 500

	first, err := RunTimerUpdate(ctx, d, []config.Shop{testShop}, "")
	if err == nil {
		t.Fatal("扫到一半挂掉必须报错，否则台账记 ok，下一班要等满冷却期")
	}
	if first[0].Success || first[0].ErrorMsg == "" {
		t.Errorf("扫描中断应记失败: %+v", first[0])
	}
	if first[0].TotalProducts != 1000 {
		t.Errorf("第一页 %d 个商品应已处理，实际 %d", 1000, first[0].TotalProducts)
	}
	if len(f.timerBatches) != 1 || len(f.timerBatches[0]) != 1000 {
		t.Errorf("只该提交第 1 页的定时器: %v", batchSizes(f.timerBatches))
	}

	cur, found, err := db.LoadCursor("timer:"+testShop.Name, time.Hour, testNow)
	if err != nil || !found {
		t.Fatalf("失败后必须留下断点游标: found=%v err=%v", found, err)
	}
	if cur.Value != "1000" || cur.Processed != 1000 {
		t.Errorf("游标 = %+v，期望停在游标 1000 / 已处理 1000", cur)
	}

	// 恢复：第二轮只处理剩下的 201 个，且不重复查第一页商品的价格
	f.blockContains("/v3/product/list", "")
	before := len(f.bodiesFor("/v5/product/info/prices"))
	second, err := RunTimerUpdate(ctx, d, []config.Shop{testShop}, "")
	if err != nil {
		t.Fatal(err)
	}
	res := second[0]
	if !res.Success || res.TotalProducts != 201 {
		t.Fatalf("续跑应只处理剩下 201 个: %+v", res)
	}
	if res.ResumedFrom != "1000" {
		t.Errorf("结果没标出这是续跑: %+v", res)
	}
	if res.TimerSuccess != 201 {
		t.Errorf("续跑刷了 %d 个定时器，期望 201", res.TimerSuccess)
	}
	after := f.bodiesFor("/v5/product/info/prices")
	newBodies := after[before:]
	// 201 个商品按 200 一批拆成 2 次价格查询(2026-10-07 分批改造,防整页 1000 个超时)
	if len(newBodies) != 2 {
		t.Errorf("续跑应按 200 一批查 2 次价格，实际从 %d 次变成 %d 次", before, len(after))
	}
	for _, b := range newBodies {
		if strings.Contains(b, `"1000"`) {
			t.Errorf("续跑还在重复查第一页最后一个商品的价格，游标没生效: %s", b)
		}
	}
	if len(newBodies) > 0 && !strings.Contains(newBodies[0], `"1001"`) {
		t.Errorf("续跑应查第 2 页商品: %s", newBodies[0])
	}

	// 完整跑完后游标必须收尾，否则下一班永远从旧断点起步
	if _, found, _ := db.LoadCursor("timer:"+testShop.Name, time.Hour, testNow); found {
		t.Error("扫描已跑完，游标却没有标记成完成")
	}
	all, _ := db.AllCursors()
	if len(all) != 1 || !all[0].Finished {
		t.Errorf("游标收尾状态不对: %+v", all)
	}
}

func TestShopsRunInParallelButBounded(t *testing.T) {
	f := newFakeOzon(t)
	f.products = []map[string]any{{"product_id": 1}}
	f.prices = []map[string]any{priceItem(1, "A", "10", 0, "RUB")}

	d, _ := newTestDeps(t, f, false)
	d.Concurrency = 2

	var mu sync.Mutex
	inFlight, peak := 0, 0
	handler := f.srv.Config.Handler
	f.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v3/product/list" {
			mu.Lock()
			inFlight++
			if inFlight > peak {
				peak = inFlight
			}
			mu.Unlock()
			time.Sleep(40 * time.Millisecond) // 让并行度有机会暴露出来
			mu.Lock()
			inFlight--
			mu.Unlock()
		}
		handler.ServeHTTP(w, r)
	})

	shops := make([]config.Shop, 0, 4)
	for _, n := range []string{"A", "B", "C", "D"} {
		shops = append(shops, config.Shop{Name: n, ClientID: "1", APIKey: "k"})
	}
	results, err := RunTimerUpdate(context.Background(), d, shops, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 4 {
		t.Fatalf("结果数 = %d，期望 4（结果顺序必须和店铺顺序一致，通知文案据此排版）", len(results))
	}
	for i, r := range results {
		if r.Shop != shops[i].Name {
			t.Errorf("结果第 %d 位是 %s，期望 %s", i, r.Shop, shops[i].Name)
		}
		if !r.Success {
			t.Errorf("店铺 %s 失败: %s", r.Shop, r.ErrorMsg)
		}
	}
	if peak > 2 {
		t.Errorf("同时在跑 %d 家店，超过了上限 2（并发失控会撞 Ozon 限流）", peak)
	}
	if peak < 2 {
		t.Errorf("峰值并发只有 %d：还是在串行，16 家店要一家家排完", peak)
	}
}

func TestDeactivateSweepsActionProductsByPage(t *testing.T) {
	// 活动商品接口每页上限 100。JS 版把整份清单塞进一次 deactivate 请求，
	// 大活动会撞上请求体上限；这里改成逐页拉、逐页撤。
	f := newFakeOzon(t)
	f.actions = []map[string]any{{"id": 7, "title": "大活动", "participating_products_count": 250}}
	ids := make([]int64, 0, 250)
	for i := 1; i <= 250; i++ {
		ids = append(ids, int64(1000+i))
	}
	f.actProds["7"] = ids

	d, _ := newTestDeps(t, f, false)
	results, err := RunActionDeactivate(context.Background(), d, []config.Shop{testShop}, "")
	if err != nil {
		t.Fatal(err)
	}
	res := results[0]
	if res.Deactivated != 250 || res.Failed != 0 {
		t.Errorf("撤下统计不对: %+v", res)
	}
	if len(res.Details) != 1 || res.Details[0].Products != 250 {
		t.Errorf("活动明细不对: %+v", res.Details)
	}
	if got := f.hit("/v1/actions/products"); got != 3 {
		t.Errorf("拉取活动商品 %d 次，期望 3 页", got)
	}
	var sizes []int
	for _, dd := range f.deactivated {
		sizes = append(sizes, len(dd["product_ids"].([]int64)))
	}
	if len(sizes) != 3 || sizes[0] != 100 || sizes[1] != 100 || sizes[2] != 50 {
		t.Errorf("撤下请求批大小 = %v，期望 [100 100 50]", sizes)
	}
}

func batchSizes(b [][]int64) []int {
	out := make([]int, 0, len(b))
	for _, x := range b {
		out = append(out, len(x))
	}
	return out
}
