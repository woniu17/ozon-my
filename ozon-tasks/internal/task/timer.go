// Package task 是两个业务功能的本体：
//
//	定时器 + 最低价刷新（对应 httpsrv/ozon/ozonProductTimerUpdate.js）
//	促销活动商品移除（对应 httpsrv/ozon/ozonActionDeactivate.js）
//
// 业务规则（批次大小、状态判定顺序、最低价算式、飞书文案）逐条对齐 JS，
// 有意为之的两处结构差异：
//
//  1. 逐页处理而不是"全店列表收齐再算"。一家店几万个商品时，全收齐既吃内存，
//     中途崩溃又得从头再来。现在每页处理完才推进游标，重跑从断点继续。
//     副作用是同一店铺内"先给全部商品设最低价、再统一刷定时器"变成了
//     "每页先设最低价再刷该页定时器"——单个商品的先后次序不变，跨商品的次序无业务含义。
//  2. 请求间隔不再靠 sleep 硬编码，而是每店一个令牌桶（见 internal/ozon/rate.go）。
//     店铺之间有限并发，单店内部串行。
package task

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"ozon-tasks/internal/config"
	"ozon-tasks/internal/feishu"
	"ozon-tasks/internal/ledger"
	"ozon-tasks/internal/logx"
	"ozon-tasks/internal/ozon"
)

// resumeWindow 是断点游标的保鲜期。超过它就重扫：商品列表在这几小时里会变，
// 拿着昨天的游标续跑等于默认前半截不需要设最低价，那批商品会一直漏。
const resumeWindow = 6 * time.Hour

// Deps 一次进程运行所需的依赖。测试用 BaseURL/Sleep/Now 把时间与网络固定住。
type Deps struct {
	Ledger  *ledger.DB
	Feishu  *feishu.Sender
	Machine string
	Holder  string

	Timeout     time.Duration
	Retries     int
	DryRun      bool
	Concurrency int     // 同时在跑几家店（单店内部始终串行）
	RPS         float64 // 每店每秒请求数上限
	Burst       int     // 每店突发桶容量

	BaseURL string
	Sleep   func(context.Context, time.Duration) error
	Now     func() time.Time
}

func (d *Deps) sleep(ctx context.Context, dd time.Duration) error {
	if d.Sleep != nil {
		return d.Sleep(ctx, dd)
	}
	if dd <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(dd)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (d *Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d *Deps) concurrency() int {
	if d.Concurrency <= 0 {
		return 3
	}
	return d.Concurrency
}

// ClientFor 一家店铺一个客户端（凭据按店隔离，限速额度也按店隔离）。
func (d *Deps) ClientFor(shop config.Shop) *ozon.Client {
	return ozon.NewClient(shop, ozon.Options{
		BaseURL: d.BaseURL,
		Timeout: d.Timeout,
		Retries: d.Retries,
		DryRun:  d.DryRun,
		Sleep:   d.sleep,
		RPS:     d.RPS,
		Burst:   d.Burst,
	})
}

// eachShop 按有限并发跑一批店铺，结果按传入顺序回填（通知里的店铺次序不能乱）。
// 单店失败记在结果里，不拖垮其余店铺——16 家店里 1 家挂了不该让整轮不刷新。
// shopFn 是"跑一家店"的函数形状。做成具名类型是为了让调用处能直接传 (*Deps) 的方法值，
// 依赖不从全局取，并发跑几家店时也不会有人偷偷共享状态。
type shopFn[T any] func(context.Context, config.Shop) T

func eachShop[T any](ctx context.Context, d *Deps, shops []config.Shop, run shopFn[T]) []T {
	out := make([]T, len(shops))
	sem := make(chan struct{}, d.concurrency())
	var wg sync.WaitGroup
	for i, shop := range shops {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		go func(i int, shop config.Shop) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			out[i] = run(ctx, shop)
		}(i, shop)
	}
	wg.Wait()
	return out
}

// ---------- 结果结构 ----------

// MinPriceStat 单店最低价处理结果。字段名与 JS 返回的统计项一一对应，方便对拍。
type MinPriceStat struct {
	Total int `json:"minPriceTotal"`
	Set   int `json:"minPriceSetCount"`
	Skip  int `json:"minPriceSkipCount"`
	Fail  int `json:"minPriceFailCount"`

	// Planned 是影子模式下"打算设置但没提交"的条数：报告要能区分"验证过没问题"和"真的改了"
	Planned  int    `json:"minPricePlannedCount"`
	ErrorMsg string `json:"minPriceError,omitempty"`
}

func (m *MinPriceStat) add(o MinPriceStat) {
	m.Total += o.Total
	m.Set += o.Set
	m.Skip += o.Skip
	m.Fail += o.Fail
	m.Planned += o.Planned
	if m.ErrorMsg == "" {
		m.ErrorMsg = o.ErrorMsg
	}
}

// ShopTimerResult 单店定时器结果。
type ShopTimerResult struct {
	Shop               string `json:"shop"`
	TotalProducts      int    `json:"totalProducts"`
	TimerSuccess       int    `json:"updateSuccess"`
	TimerPlanned       int    `json:"updatePlanned"`
	TimerFail          int    `json:"updateFail"`
	StatusCount        int    `json:"statusCount"`
	AutoActionsEnabled int    `json:"autoActionsEnabledCount"`
	EarliestExpiredAt  string `json:"earliestExpiredAt"`
	ResumedFrom        string `json:"resumedFromCursor,omitempty"`

	MinPrice MinPriceStat `json:"-"`

	Success  bool   `json:"success"`
	ErrorMsg string `json:"error,omitempty"`
}

// ---------- 定时器 + 最低价 ----------

// RunTimerUpdate 处理多家店铺：设最低价 → 刷定时器 → 查状态 → 入库 → 汇总通知。
// 上下文被取消、或有店铺没跑完时返回非空 error（结果切片照常返回，通知先发再报错）。
func RunTimerUpdate(ctx context.Context, d *Deps, shops []config.Shop, webhook string) ([]ShopTimerResult, error) {
	if len(shops) == 0 {
		return nil, errors.New("没有可处理的店铺：检查 .env 里的 OZON_SHOPS / 分组配置")
	}
	logx.Infof("[定时器] 开始处理 %d 家店铺，最多 %d 家并行%s", len(shops), d.concurrency(), drySuffix(d.DryRun))

	results := eachShop(ctx, d, shops, d.updateShopTimers)

	if ctx.Err() != nil {
		return results, ctx.Err()
	}
	NotifyTimerResults(ctx, d, results, webhook)
	logx.Infof("[定时器] ========== 所有店铺更新完成 ==========")

	var incomplete []string
	for _, r := range results {
		if !r.Success {
			incomplete = append(incomplete, r.Shop+": "+r.ErrorMsg)
		}
	}
	return results, incompleteErr("[定时器]", incomplete)
}

// incompleteErr 把"有店铺没跑完"升格成错误。非空返回值换来三件事：
// 台账记 status=error（status 子命令和飞书之外的任何巡检都能一眼看到没跑完），
// once 有非 0 退出码供 systemd/cron 报警，以及认领时的失败退避开始生效。
// 注意这不会把下一班提前：排期是固定时刻，半路挂掉的那 1300 个商品要等到下一班才续跑，
// 失败退避只是"排期比退避还密时不许连打"的地板。
// 只统计整店/整活动级失败：个别商品被平台拒回（PRICE_TOO_LOW 之类）重跑也不会变，
// 若按它退避，整组店铺会每 10 分钟重扫一遍白烧配额。
func incompleteErr(label string, incomplete []string) error {
	if len(incomplete) == 0 {
		return nil
	}
	return fmt.Errorf("%s 本轮有 %d 处未跑完，游标已停在断点，下一班从这儿续跑: %s",
		label, len(incomplete), strings.Join(incomplete, "; "))
}

// updateShopTimers 单店完整流程：逐页扫描，每页处理完推进游标。
func (d *Deps) updateShopTimers(ctx context.Context, shop config.Shop) ShopTimerResult {
	l := logx.Tag("["+shop.Name+"]", "[定时器]")
	res := ShopTimerResult{Shop: shop.Name, EarliestExpiredAt: "无", Success: true}
	cli := d.ClientFor(shop)

	scope := "timer:" + shop.Name
	startAfter, processed := d.resumePoint(scope, l)
	if startAfter != "" {
		res.ResumedFrom = startAfter
	}

	var firstErr string
	err := cli.SweepProducts(ctx, startAfter, func(page ozon.ProductPage) error {
		ids := make([]int64, 0, len(page.Items))
		for _, p := range page.Items {
			ids = append(ids, p.ProductID.Int64())
		}
		res.TotalProducts += len(ids)
		l.Infof("第 %d 页 %d 个商品（累计 %d）", page.Number, len(ids), res.TotalProducts)

		// 1. 最低价（在刷定时器前执行，JS 顺序）
		res.MinPrice.add(setMinPrices(ctx, d, cli, shop, l, ids))

		// 2. 刷定时器
		updateTimers(ctx, d, cli, l, ids, &res)

		// 3. 查状态（只读，dry-run 也照常做）
		readTimerStatus(ctx, cli, l, ids, &res)

		processed += len(ids)
		d.saveCursor(scope, page.LastID, processed, l)
		return nil
	})

	if err != nil {
		// 扫描中断：游标停在出错页之前，重跑时那一页会被重新处理
		res.Success = false
		res.ErrorMsg = err.Error()
		if firstErr == "" {
			firstErr = err.Error()
		}
		l.Errorf("扫描失败: %v（已处理 %d 个商品，游标已记录，重跑会从断点继续）", err, processed)
	} else {
		d.finishCursor(scope, processed, l)
	}

	if firstErr != "" {
		res.ErrorMsg = firstErr
	}
	l.Infof("本店铺完成: 商品 %d, 定时器成功 %d, 失败 %d, 最低价成功 %d",
		res.TotalProducts, res.TimerSuccess, res.TimerFail, res.MinPrice.Set)
	return res
}

// updateTimers 刷一页商品的定时器。影子模式单独计入 Planned：
// 把"没提交"报成"更新成功 N 个"，值班的人会以为定时器已经续上了，实际到期照样掉自动调价。
func updateTimers(ctx context.Context, d *Deps, cli *ozon.Client, l *logx.Tagged, ids []int64, res *ShopTimerResult) {
	if len(ids) == 0 {
		return
	}
	executed, err := cli.UpdateTimers(ctx, ids)
	switch {
	case err != nil:
		res.TimerFail += len(ids)
		l.Errorf("定时器更新异常（%d 个）: %v", len(ids), err)
	case !executed:
		res.TimerPlanned += len(ids)
		l.Infof("dry-run 预计刷新定时器 %d 个", len(ids))
	default:
		res.TimerSuccess += len(ids)
	}
}

// readTimerStatus 查一页商品的定时器状态并累计体检指标。
func readTimerStatus(ctx context.Context, cli *ozon.Client, l *logx.Tagged, ids []int64, res *ShopTimerResult) {
	if len(ids) == 0 {
		return
	}
	statuses, err := cli.TimerStatus(ctx, ids)
	if err != nil {
		l.Errorf("获取定时器状态失败: %v", err)
		return
	}
	res.StatusCount += len(statuses)
	for _, s := range statuses {
		if s.MinPriceForAutoActionsEnabled {
			res.AutoActionsEnabled++
		}
	}
	if earliest := earliestExpiredAt(statuses); earliest != "无" {
		res.EarliestExpiredAt = mergeEarliest(res.EarliestExpiredAt, earliest)
	}
}

// mergeEarliest 比较两个 "2006-01-02 15:04:05" 形式的本地时间串，取更早的那个。
func mergeEarliest(a, b string) string {
	layout := logx.TimeLayout
	ta, errA := time.ParseInLocation(layout, a, time.Local)
	tb, errB := time.ParseInLocation(layout, b, time.Local)
	if errA != nil {
		return b
	}
	if errB != nil {
		return a
	}
	if tb.Before(ta) {
		return b
	}
	return a
}

// earliestExpiredAt 取这批商品里最早的定时器过期时间，展示成 JS 的本地时间格式。
func earliestExpiredAt(statuses []ozon.TimerStatus) string {
	var earliest time.Time
	for _, s := range statuses {
		if s.ExpiredAt == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339, s.ExpiredAt)
		if err != nil {
			continue
		}
		if earliest.IsZero() || t.Before(earliest) {
			earliest = t
		}
	}
	if earliest.IsZero() {
		return "无"
	}
	return earliest.Local().Format(logx.TimeLayout)
}

// ---------- 断点游标 ----------

// resumePoint 问台账该从哪个游标续跑；演练模式和没配库时一律从头扫。
func (d *Deps) resumePoint(scope string, l *logx.Tagged) (string, int) {
	if d.Ledger == nil || d.DryRun {
		return "", 0
	}
	cur, found, err := d.Ledger.LoadCursor(scope, resumeWindow, d.now())
	if err != nil {
		l.Errorf("读取断点游标失败: %v（本轮从头扫描）", err)
		return "", 0
	}
	if !found {
		return "", 0
	}
	l.Infof("从上次断点续跑：游标 %s，此前已处理 %d 个", cur.Value, cur.Processed)
	return cur.Value, int(cur.Processed)
}

func (d *Deps) saveCursor(scope, value string, processed int, l *logx.Tagged) {
	if d.Ledger == nil || d.DryRun {
		return
	}
	// 游标只影响下次能否续跑，写失败不值得把整轮判死
	if err := d.Ledger.SaveCursor(scope, value, int64(processed), d.Holder, d.now()); err != nil {
		l.Errorf("记录断点游标失败: %v", err)
	}
}

func (d *Deps) finishCursor(scope string, processed int, l *logx.Tagged) {
	if d.Ledger == nil || d.DryRun {
		return
	}
	if err := d.Ledger.FinishCursor(scope, int64(processed), d.now()); err != nil {
		l.Errorf("清理断点游标失败: %v", err)
	}
}

// ---------- 最低价 ----------

// setMinPrices 是这套系统里最需要照抄的一段：判错一个方向就会把整店商品底价压错。
// 规则：只处理 min_price==0 的商品；min_price>0 视为已设置直接跳过（不做任何"纠偏"）。
func setMinPrices(ctx context.Context, d *Deps, cli *ozon.Client, shop config.Shop,
	l *logx.Tagged, ids []int64) MinPriceStat {

	st := MinPriceStat{Total: len(ids)}
	if len(ids) == 0 {
		return st
	}

	// 一页最多 1000 个商品，正好是查询接口的上限，一次调用拿完
	priceInfos, err := cli.ListPrices(ctx, ids)
	if err != nil {
		// JS 这里只记日志、继续下一批：少查到的商品本次不进设置清单，下次任务再补
		l.Errorf("[最低价] 查询价格失败: %v", err)
		st.ErrorMsg = err.Error()
	}

	// 挑出要设最低价的商品
	var updates []ozon.PriceImportItem
	for _, item := range priceInfos {
		if item.Price == nil || item.Price.Price == nil {
			st.Skip++ // 没有售价：状态 not_applicable，不动 min_price
			continue
		}
		currentPrice := item.Price.Price.Float64()
		currentMin := 0.0
		if item.Price.MinPrice != nil {
			currentMin = item.Price.MinPrice.Float64()
		}
		if currentPrice <= 0 {
			// 比 JS 多加的一道闸：售价为 0 时算出来是 min_price=-0.01，提交上去只会挨 400
			st.Skip++
			continue
		}
		if currentMin > 0 {
			st.Skip++ // 已有最低价，尊重现状不覆盖
			continue
		}
		oldPrice := 0.0
		if item.Price.OldPrice != nil {
			oldPrice = item.Price.OldPrice.Float64()
		}
		currency := item.Price.CurrencyCode
		if currency == "" {
			currency = "RUB"
		}
		updates = append(updates, ozon.PriceImportItem{
			ProductID: item.ProductID.Int64(),
			OfferID:   item.OfferID,
			// 自动调价与价格策略保持关闭：这两个开关一旦被打开，平台会替我们改价，
			// 本任务"手工钉死最低价"的前提就不成立了。
			AutoActionEnabled:                 "DISABLED",
			MinPriceForAutoActionsEnabled:     true,
			PriceStrategyEnabled:              "DISABLED",
			ManageElasticBoostingThroughPrice: false,
			MinPrice:                          formatPriceFixed(math.Round((currentPrice-0.01)*100) / 100),
			Price:                             formatPrice(currentPrice),
			OldPrice:                          formatPrice(oldPrice),
			CurrencyCode:                      currency,
		})
	}
	l.Infof("[最低价] 本页查询 %d 个商品，需设置 %d 个，跳过 %d 个", len(priceInfos), len(updates), st.Skip)

	results := map[int64]priceSetResult{} // 入库时靠它决定 min_price_status
	newMinPrice := map[int64]float64{}
	for _, u := range updates {
		v, _ := strconv.ParseFloat(u.MinPrice, 64)
		newMinPrice[u.ProductID] = v
	}

	if len(updates) == 0 {
		l.Infof("[最低价] 无需设置最低价的商品")
		d.upsertLedger(shop, priceInfos, results, nil, l)
		return st
	}

	if d.DryRun {
		// 影子模式：一条都不提交，把"打算设置"的数量报出来，同时不污染台账里的历史状态
		st.Planned = len(updates)
		l.Infof("[最低价] dry-run：预计设置 %d 个，本次不提交", len(updates))
		d.upsertLedger(shop, priceInfos, results, nil, l)
		return st
	}

	var outcomes []ozon.PriceImportOutcome
	executed, err := cli.ImportPrices(ctx, updates, &outcomes)
	if err != nil || !executed {
		// 整批失败时全记 failed，否则台账会显示"从没查过"，查问题时看不到痕迹
		st.Fail += len(updates)
		for _, item := range updates {
			results[item.ProductID] = priceSetResult{updated: false, status: "failed"}
		}
		l.Errorf("[最低价] 更新异常（%d 个）: %v", len(updates), err)
	} else {
		seen := map[int64]bool{}
		for _, r := range outcomes {
			pid := r.ProductID.Int64()
			seen[pid] = true
			if r.Updated {
				st.Set++
				results[pid] = priceSetResult{updated: true, status: "set"}
			} else {
				st.Fail++
				results[pid] = priceSetResult{updated: false, status: "failed"}
				l.Errorf("[最低价] 更新失败 product_id=%d: %s", pid, joinImportErrors(r.Errors))
			}
		}
		// Ozon 偶尔对部分商品完全不回话，按失败处理，别让它们在台账里以"跳过"混过去
		for _, item := range updates {
			if !seen[item.ProductID] {
				st.Fail++
				results[item.ProductID] = priceSetResult{updated: false, status: "failed"}
				l.Errorf("[最低价] 接口未返回 product_id=%d 的结果，按失败处理", item.ProductID)
			}
		}
	}

	d.upsertLedger(shop, priceInfos, results, newMinPrice, l)
	l.Infof("[最低价] 本页完成: 设置成功 %d 个, 跳过 %d 个, 失败 %d 个", st.Set, st.Skip, st.Fail)
	return st
}

func joinImportErrors(errs []ozon.PriceImportError) string {
	parts := make([]string, 0, len(errs))
	for _, e := range errs {
		parts = append(parts, e.String())
	}
	return strings.Join(parts, "; ")
}

// formatPrice 价格一律转字符串提交：JS 用 String(...) / toFixed(2)，
// 浮点直接进 JSON 会带出 0.30000000000000004 这种尾巴，Ozon 会拒。
func formatPrice(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// formatPriceFixed 固定两位小数，对应 JS 的 toFixed(2)。
// min_price 和 price 在 JS 里走的是两个写法，这里也分开——切换期两边会同时跑，
// 报文能逐字节比对才看得出是真差异，"101" 和 "101.00" 这种纯属写法不同的先排除掉。
func formatPriceFixed(v float64) string {
	return strconv.FormatFloat(v, 'f', 2, 64)
}

// priceSetResult 单个商品的最低价设置结果。
type priceSetResult struct {
	updated bool
	status  string
}

// upsertLedger 写台账。
// 传 newMinPrice 把设置成功后的新 min_price 回写进快照再入库——快照是改价之前查的，
// 不回写就会把 min_price=0 存回去，等于白查一遍还覆盖掉历史值。
func (d *Deps) upsertLedger(shop config.Shop, infos []ozon.PriceInfo,
	results map[int64]priceSetResult, newMinPrice map[int64]float64, l *logx.Tagged) {

	if d.Ledger == nil {
		l.Infof("[最低价] 未配置台账库，跳过入库")
		return
	}
	if d.DryRun {
		// 影子模式连台账也不写：SQLite 就是这套系统的产出之一，
		// 演练时写进去的"skipped"会在真跑之后仍然留在库里，比少几行数据更糟。
		l.Infof("[最低价] dry-run：跳过入库（本应写 %d 条）", len(infos))
		return
	}
	now := d.now()
	records := make([]ledger.PriceRecord, 0, len(infos))
	for _, item := range infos {
		pid := item.ProductID.Int64()
		rec := ledger.PriceRecord{ProductID: pid, OfferID: item.OfferID}
		var minVal float64
		if item.Price != nil {
			if item.Price.Price != nil {
				v := item.Price.Price.Float64()
				rec.Price = &v
			}
			if item.Price.MinPrice != nil {
				minVal = item.Price.MinPrice.Float64()
			}
			if item.Price.OldPrice != nil {
				rec.OldPrice = item.Price.OldPrice.Float64()
			}
			rec.CurrencyCode = item.Price.CurrencyCode
			if item.Price.MarketingSellerPrice != nil {
				v := item.Price.MarketingSellerPrice.Float64()
				rec.MarketingSellerPrice = &v
			}
		}
		if newMinPrice != nil {
			if r, ok := results[pid]; ok && r.updated {
				if v, ok := newMinPrice[pid]; ok {
					minVal = v
				}
			}
		}
		rec.MinPrice = minVal

		// 状态判定顺序照抄 ozonPriceStore：先看本次有没有设置操作，再看快照里的价格
		switch r, ok := results[pid]; {
		case !ok:
			if rec.Price == nil {
				rec.MinPriceStatus = "not_applicable"
			} else {
				rec.MinPriceStatus = "skipped"
			}
		case r.updated:
			rec.MinPriceStatus = "set"
			rec.MinPriceSetAt = now.UnixMilli()
		default:
			rec.MinPriceStatus = "failed"
		}
		records = append(records, rec)
	}

	if _, err := d.Ledger.UpsertPrices(shop, records, now); err != nil {
		l.Errorf("[最低价] 入库失败: %v", err)
		return
	}
	l.Infof("[最低价] 入库 %d 条", len(records))
}

func drySuffix(dryRun bool) string {
	if dryRun {
		return "（影子模式：只读不写）"
	}
	return ""
}

// ---------- 通知文案 ----------

// NotifyTimerResults 汇总通知。文案逐行对齐 JS 的 sendSummaryNotification，
// 只在影子模式下多打一行标记——否则运维会把演练结果当成已经改了价。
func NotifyTimerResults(ctx context.Context, d *Deps, results []ShopTimerResult, webhook string) {
	sum := func(pick func(ShopTimerResult) int) int {
		total := 0
		for _, r := range results {
			total += pick(r)
		}
		return total
	}

	var sb strings.Builder
	sb.WriteString("✅ Ozon商品定时器批量更新完成\n\n")
	if d.DryRun {
		sb.WriteString("🧪 影子模式：本次未提交任何写操作，数字为按现状推算的结果\n\n")
	}
	sb.WriteString(fmt.Sprintf("🏪 店铺数量: %d\n", len(results)))
	sb.WriteString(fmt.Sprintf("📦 商品总数: %d\n", sum(func(r ShopTimerResult) int { return r.TotalProducts })))
	sb.WriteString(fmt.Sprintf("✅ 定时器更新成功: %d\n", sum(func(r ShopTimerResult) int { return r.TimerSuccess })))
	sb.WriteString(fmt.Sprintf("❌ 定时器更新失败: %d\n", sum(func(r ShopTimerResult) int { return r.TimerFail })))
	if planned := sum(func(r ShopTimerResult) int { return r.TimerPlanned }); planned > 0 {
		sb.WriteString(fmt.Sprintf("🧪 定时器预计更新(未提交): %d\n", planned))
	}
	sb.WriteString(fmt.Sprintf("💰 最低价设置成功: %d\n", sum(func(r ShopTimerResult) int { return r.MinPrice.Set })))
	sb.WriteString(fmt.Sprintf("⏭️ 最低价跳过(已有): %d\n", sum(func(r ShopTimerResult) int { return r.MinPrice.Skip })))
	sb.WriteString(fmt.Sprintf("❌ 最低价设置失败: %d\n", sum(func(r ShopTimerResult) int { return r.MinPrice.Fail })))
	// 未检查 = 总数 − 设置 − 跳过 − 失败(影子模式再减预计设置):
	// 价格查询失败的批整批没查,之前直接从统计里消失,总数对不上账(2026-10-06/07 连续两天)
	if missed := sum(func(r ShopTimerResult) int {
		return r.MinPrice.Total - r.MinPrice.Set - r.MinPrice.Skip - r.MinPrice.Fail - r.MinPrice.Planned
	}); missed > 0 {
		sb.WriteString(fmt.Sprintf("⚠️ 最低价未检查(查询失败): %d\n", missed))
	}
	if planned := sum(func(r ShopTimerResult) int { return r.MinPrice.Planned }); planned > 0 {
		sb.WriteString(fmt.Sprintf("🧪 最低价预计设置: %d\n", planned))
	}
	sb.WriteString("\n📋 各店铺详情:\n")
	for _, r := range results {
		mark := "✅"
		if !r.Success {
			mark = "❌"
		}
		sb.WriteString(fmt.Sprintf("%s %s: %d个商品【定时器成功%d, 保持时间: %s】, 【最低价成功%d】\n",
			mark, r.Shop, r.TotalProducts, r.TimerSuccess, orNone(r.EarliestExpiredAt), r.MinPrice.Set))
		if r.ErrorMsg != "" {
			sb.WriteString(fmt.Sprintf("   ⚠️ 错误: %s\n", r.ErrorMsg))
		}
	}

	msg := sb.String()
	logx.Infof("发送汇总通知:\n%s", msg)
	if d.Feishu != nil {
		d.Feishu.Send(ctx, webhook, msg)
	}
}

func orNone(s string) string {
	if s == "" {
		return "无"
	}
	return s
}

// ---------- 只读状态巡检 ----------

// TimerStatusReport 单店定时器体检结果，对应 JS 的 getShopTimerStatus。
type TimerStatusReport struct {
	Shop                string `json:"shop"`
	TotalProducts       int    `json:"totalProducts"`
	StatusCount         int    `json:"statusCount"`
	AutoActionsEnabled  int    `json:"autoActionsEnabledCount"`
	AutoActionsDisabled int    `json:"autoActionsDisabledCount"`
	Expired             int    `json:"expiredCount"`
	ExpiringSoon        int    `json:"expiringSoonCount"`
	EarliestExpiredAt   string `json:"earliestExpiredAt"`
	Error               string `json:"error,omitempty"`
}

// RunTimerStatusCheck 只查不写：产品列表 + 定时器状态，用来在正式接管前先看清现状，
// 也是 status/check 路径的实现（这条路径连 dry-run 都不需要，因为它根本不提交任何东西）。
func RunTimerStatusCheck(ctx context.Context, d *Deps, shops []config.Shop) error {
	logx.Infof("[状态巡检] 开始查询 %d 家店铺的计时器状态...", len(shops))
	reports := eachShop(ctx, d, shops, d.shopTimerStatus)
	for _, r := range reports {
		line := fmt.Sprintf("[状态巡检] %s: 商品 %d, 状态 %d, 启用 %d, 禁用 %d, 已过期 %d, 7天内过期 %d, 最早过期 %s",
			r.Shop, r.TotalProducts, r.StatusCount, r.AutoActionsEnabled, r.AutoActionsDisabled,
			r.Expired, r.ExpiringSoon, orNone(r.EarliestExpiredAt))
		if r.Error != "" {
			line += ", 错误: " + r.Error
		}
		logx.Infof("%s", line)
	}
	return ctx.Err()
}

func (d *Deps) shopTimerStatus(ctx context.Context, shop config.Shop) TimerStatusReport {
	l := logx.Tag("["+shop.Name+"]", "[状态查询]")
	rep := TimerStatusReport{Shop: shop.Name, EarliestExpiredAt: "无"}
	cli := d.ClientFor(shop)
	now := d.now()
	sevenDays := now.Add(7 * 24 * time.Hour)

	err := cli.SweepProducts(ctx, "", func(page ozon.ProductPage) error {
		ids := make([]int64, 0, len(page.Items))
		for _, p := range page.Items {
			ids = append(ids, p.ProductID.Int64())
		}
		rep.TotalProducts += len(ids)

		statuses, err := cli.TimerStatus(ctx, ids)
		if err != nil {
			l.Errorf("获取定时器状态失败: %v", err)
			if rep.Error == "" {
				rep.Error = err.Error()
			}
			return nil // 一页查不到不代表整店不用体检，继续翻
		}
		rep.StatusCount += len(statuses)
		for _, s := range statuses {
			if s.MinPriceForAutoActionsEnabled {
				rep.AutoActionsEnabled++
			}
			if s.ExpiredAt == "" {
				continue
			}
			t, err := time.Parse(time.RFC3339, s.ExpiredAt)
			if err != nil {
				continue
			}
			switch {
			case t.Before(now):
				rep.Expired++
			case t.Before(sevenDays):
				rep.ExpiringSoon++
			}
		}
		if earliest := earliestExpiredAt(statuses); earliest != "无" {
			rep.EarliestExpiredAt = mergeEarliest(rep.EarliestExpiredAt, earliest)
		}
		return nil
	})
	if err != nil && rep.Error == "" {
		rep.Error = err.Error()
		l.Errorf("获取商品列表失败: %v", err)
	}
	rep.AutoActionsDisabled = rep.StatusCount - rep.AutoActionsEnabled
	return rep
}
