// 促销活动商品移除：对应 httpsrv/ozon/ozonActionDeactivate.js。
// 语义要点：把店铺当前报名在官方促销活动里的商品全部撤下（deactivate），
// 只处理 participating_products_count>0 的活动；通知仅在本次真有商品被移除时才发。
//
// 与 JS 的差别只有批次粒度：JS 把一个活动的商品清单一次性 POST 出去，
// 这里按活动商品分页（每页 100）提交。撤销是幂等的，粒度变细只会让单次请求更小、
// 崩溃后能续跑，不会少撤商品——回执对不上的差额仍然按失败计入。
package task

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"ozon-tasks/internal/config"
	"ozon-tasks/internal/logx"
	"ozon-tasks/internal/ozon"
)

// ActionDetail 单个活动的处理结果。
type ActionDetail struct {
	ActionID    int64  `json:"actionId"`
	ActionTitle string `json:"actionTitle"`
	Products    int    `json:"products"`
	Deactivated int    `json:"deactivated"`
	Failed      int    `json:"failed"`
	Error       string `json:"error,omitempty"`
	Planned     int    `json:"planned,omitempty"`
}

// DeactivateResult 单店结果。
type DeactivateResult struct {
	ShopName    string         `json:"shopName"`
	ActionCount int            `json:"actionCount"`
	Deactivated int            `json:"deactivatedCount"`
	Failed      int            `json:"failedCount"`
	Planned     int            `json:"plannedCount"`
	Details     []ActionDetail `json:"details"`
	Error       string         `json:"error,omitempty"`
}

// RunActionDeactivate 批量移除多店铺的活动商品。
// 上下文取消、或有店铺/活动没跑完时返回非空 error；单店统计仍完整记在结果里。
func RunActionDeactivate(ctx context.Context, d *Deps, shops []config.Shop, webhook string) ([]DeactivateResult, error) {
	if len(shops) == 0 {
		return nil, errors.New("没有可处理的店铺：检查 .env 里的 OZON_SHOPS / 分组配置")
	}
	logx.Infof("[活动移除] 开始处理 %d 家店铺的活动商品移除，最多 %d 家并行%s",
		len(shops), d.concurrency(), drySuffix(d.DryRun))

	results := eachShop(ctx, d, shops, d.deactivateShopActionProducts)
	if ctx.Err() != nil {
		return results, ctx.Err()
	}

	totalDeactivated, totalPlanned, totalFailed := 0, 0, 0
	for _, r := range results {
		totalDeactivated += r.Deactivated
		totalPlanned += r.Planned
		totalFailed += r.Failed
	}
	summary := fmt.Sprintf("[活动移除] 全部完成: 移除 %d, 失败 %d", totalDeactivated, totalFailed)
	if d.DryRun {
		summary += fmt.Sprintf(", 预计 %d", totalPlanned)
	}
	logx.Infof("%s", summary)

	// JS 的取舍：一个都没撤下时不发通知，否则每天一小时一条空报告，很快就没人看这个群了。
	// 影子模式例外——演练的目的就是看报告，所以"预计移除 0"也要说清楚。
	if totalDeactivated > 0 || totalPlanned > 0 || d.DryRun {
		NotifyDeactivateResults(ctx, d, results, webhook)
	} else {
		logx.Infof("[活动移除] 本次无商品被移除，跳过飞书通知")
	}

	var incomplete []string
	for _, r := range results {
		if r.Error != "" {
			incomplete = append(incomplete, r.ShopName+": "+r.Error)
			continue
		}
		// 单个活动没扫完也算没跑完：断点游标就是为它准备的，不升格成错误就没人来续
		for _, a := range r.Details {
			if a.Error != "" {
				incomplete = append(incomplete, fmt.Sprintf("%s/活动%d: %s", r.ShopName, a.ActionID, a.Error))
			}
		}
	}
	return results, incompleteErr("[活动移除]", incomplete)
}

// deactivateShopActionProducts 单店：拉活动 → 逐页拉活动商品 → 逐页撤下。
func (d *Deps) deactivateShopActionProducts(ctx context.Context, shop config.Shop) DeactivateResult {
	l := logx.Tag("["+shop.Name+"]", "[活动移除]")
	res := DeactivateResult{ShopName: shop.Name}
	cli := d.ClientFor(shop)

	actions, err := cli.ListActions(ctx)
	if err != nil {
		// JS 在这里只记日志并把活动列表拉取失败当作该店本轮无动作，不告警：
		// 授权失效的店会天天拉不到列表，保持同样噪音水平，避免换实现后突然刷满群。
		l.Infof("拉取活动列表失败: %v", err)
		res.Error = err.Error()
		return res
	}
	res.ActionCount = len(actions)

	for _, a := range actions {
		if err := ctx.Err(); err != nil {
			res.Error = err.Error()
			return res
		}
		if a.ParticipatingProductsCount.Int64() == 0 {
			continue // 没商品参与，连拉取都省了
		}
		title := a.Title
		if title == "" {
			title = a.ID.String()
		}
		detail := deactivateOneAction(ctx, d, l, cli, shop, a.ID.Int64(), title)
		res.Deactivated += detail.Deactivated
		res.Failed += detail.Failed
		res.Planned += detail.Planned
		res.Details = append(res.Details, detail)
	}
	return res
}

// deactivateOneAction 撤下一个活动里的全部商品。
// 拉不到清单就整活动跳过：宁可这轮不撤，也不能凭半截清单做删除式操作。
func deactivateOneAction(ctx context.Context, d *Deps, l *logx.Tagged, cli *ozon.Client,
	shop config.Shop, actionID int64, title string) ActionDetail {

	detail := ActionDetail{ActionID: actionID, ActionTitle: title}
	scope := fmt.Sprintf("deactivate:%s:%d", shop.Name, actionID)
	startAfter, processed := d.resumePoint(scope, l)

	err := cli.SweepActionProducts(ctx, actionID, startAfter, func(page ozon.ActionProductPage) error {
		ids := make([]int64, 0, len(page.Products))
		for _, p := range page.Products {
			ids = append(ids, p.ID.Int64())
		}
		detail.Products += len(ids)

		deactivated, rejected, executed, err := cli.DeactivateProducts(ctx, actionID, ids)
		switch {
		case err != nil:
			// 整批失败时按"全都撤不动"计，和 JS 一致：接口没回执就不能假定任何商品已下线
			detail.Failed += len(ids)
			detail.Error = err.Error()
			l.Errorf("[%s] 移除异常（%d 个）: %v", title, len(ids), err)
		case !executed:
			detail.Planned += len(ids)
			l.Infof("[%s] dry-run 预计移除 %d 个", title, len(ids))
		default:
			detail.Deactivated += len(deactivated)
			detail.Failed += len(rejected)
			l.Infof("[%s] 第 %d 页移除 %d 个, 失败 %d 个", title, page.Number, len(deactivated), len(rejected))
			for _, r := range rejected {
				if r.Reason != "" {
					l.Infof("[%s] 被拒 product_id=%s: %s", title, r.ProductID.String(), r.Reason)
				}
			}
			if skipped := len(ids) - len(deactivated) - len(rejected); skipped > 0 {
				// 回执条数对不上：多半 Ozon 把这些商品当"已不在活动中"，静默吞掉会让下轮继续踩
				detail.Failed += skipped
				l.Errorf("[%s] 提交了 %d 个，回执只对上 %d 个，差额按失败计入",
					title, len(ids), len(deactivated)+len(rejected))
			}
		}

		processed += len(ids)
		d.saveCursor(scope, page.LastID, processed, l)
		return nil
	})

	if err != nil {
		if detail.Error == "" {
			detail.Error = err.Error()
		}
		l.Errorf("[%s] 扫描活动商品失败: %v（已处理 %d 个，重跑从断点继续）", title, err, processed)
	} else {
		d.finishCursor(scope, processed, l)
	}

	l.Infof("[%s] 本活动累计: 商品 %d, 移除 %d, 失败 %d, 预计 %d",
		title, detail.Products, detail.Deactivated, detail.Failed, detail.Planned)
	return detail
}

// NotifyDeactivateResults 移除通知，文案对齐 JS 的 sendDeactivateFeishuNotification。
func NotifyDeactivateResults(ctx context.Context, d *Deps, results []DeactivateResult, webhook string) {
	now := d.now()
	totalDeactivated, totalFailed, totalPlanned, totalProducts := 0, 0, 0, 0
	for _, r := range results {
		totalDeactivated += r.Deactivated
		totalFailed += r.Failed
		totalPlanned += r.Planned
		for _, a := range r.Details {
			totalProducts += a.Products
		}
	}

	lines := []string{}
	add := func(format string, a ...any) { lines = append(lines, fmt.Sprintf(format, a...)) }

	if d.DryRun {
		add("🧪 Ozon 促销活动商品移除通知（影子模式：未实际移除）")
	} else {
		add("🔔 Ozon 促销活动商品移除通知")
	}
	add("⏰ 执行时间: %s", now.Format(logx.TimeLayout))
	add("📦 处理店铺: %d 家", len(results))
	add("🏷️ 涉及商品: %d 个", totalProducts)
	add("✅ 移除成功: %d 个商品", totalDeactivated)
	if totalFailed > 0 {
		add("❌ 移除失败: %d 个商品", totalFailed)
	}
	if totalPlanned > 0 {
		add("🧪 预计移除: %d 个商品", totalPlanned)
	}
	lines = append(lines, "")
	lines = append(lines, "各店铺明细:")

	for _, r := range results {
		// 无移除、无失败、无错误的店不列，避免 16 家店的长报告把关键行挤出屏幕
		if r.Deactivated == 0 && r.Failed == 0 && r.Planned == 0 && r.Error == "" {
			continue
		}
		var status string
		switch {
		case r.Error != "":
			status = "❌ " + r.Error
		case r.Planned > 0:
			status = fmt.Sprintf("🧪 预计移除 %d, 失败 %d", r.Planned, r.Failed)
		default:
			status = fmt.Sprintf("✅ 移除 %d, 失败 %d", r.Deactivated, r.Failed)
		}
		add("  • %s: %s（活动 %d 个）", r.ShopName, status, r.ActionCount)
	}

	msg := strings.Join(lines, "\n")
	logx.Infof("发送移除通知:\n%s", msg)
	if d.Feishu != nil {
		d.Feishu.Send(ctx, webhook, msg)
	}
}
