// Ozon 接口的一次往返：请求/响应结构 + 分页与批量循环，语义逐条对齐
// httpsrv/ozon/ozonProductTimerUpdate.js 与 ozonActionDeactivate.js。
package ozon

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"ozon-tasks/internal/logx"
)

// FlexFloat 兼容"数字或字符串"两种形态。
// /v5/product/info/prices 的价格字段历史上返回过字符串 "12.34"，JS 版靠隐式转换混过去了；
// Go 里不兼容就会 unmarshal 失败、整店商品被判为 0 个，所以显式做个宽容类型。
type FlexFloat float64

func (f *FlexFloat) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" || s == `""` {
		*f = 0
		return nil
	}
	s = strings.Trim(s, `"`)
	if s == "" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return fmt.Errorf("无法把 %s 当作数字解析", string(b))
	}
	*f = FlexFloat(v)
	return nil
}

func (f FlexFloat) Float64() float64 { return float64(f) }

// FlexInt 同上，用于可能是字符串形态的 ID。
type FlexInt int64

func (i *FlexInt) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" || s == `""` {
		*i = 0
		return nil
	}
	s = strings.Trim(s, `"`)
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return fmt.Errorf("无法把 %s 当作整数解析", string(b))
	}
	*i = FlexInt(v)
	return nil
}

func (i FlexInt) Int64() int64   { return int64(i) }
func (i FlexInt) String() string { return strconv.FormatInt(int64(i), 10) }

// ---------- 商品列表 ----------

type ProductListItem struct {
	ProductID  FlexInt `json:"product_id"`
	OfferID    string  `json:"offer_id"`
	Visibility string  `json:"visibility"`
}

type productListItemResp struct {
	Result struct {
		Items  []ProductListItem `json:"items"`
		LastID json.RawMessage   `json:"last_id"` // 有时是 string 有时是数字
		Total  FlexInt           `json:"total"`
	} `json:"result"`
}

// ProductPage 是一页商品，连同"下一页从哪儿接着拉"的游标。
type ProductPage struct {
	Number int // 从 1 开始的页号，仅用于日志
	Items  []ProductListItem
	LastID string // 空串表示已经到末页
}

// SweepProducts 逐页拉取全店商品并当场交给 onPage。
// 游标 last_id 在两个接口里类型不一致（这里可能是数字，活动商品接口是 string），
// 统一转成 string 传回去，避免"游标丢字段导致只处理第一页"。
//
// 为什么不先把整店列表收进数组：一家店几万个商品时，"全收齐再处理"意味着
// 一是内存里堆一整份，二是中途崩了就得从头再来。逐页处理 + 每页记游标，
// 崩溃后重跑只从断点继续，已经处理过的那几页不会再打一遍 API。
//
// startAfter 传上次记下的游标即可续跑，传空串从头开始。onPage 报错立即中断：
// 游标停在出错页之前，重跑时那一页会被重新处理——宁可重复，绝不跳过。
func (c *Client) SweepProducts(ctx context.Context, startAfter string, onPage func(ProductPage) error) error {
	const limit = 1000
	lastID := startAfter
	for page := 1; ; page++ {
		var resp productListItemResp
		body := map[string]any{
			"filter":  map[string]string{"visibility": "ALL"},
			"last_id": lastID,
			"limit":   limit,
		}
		if err := c.postRead(ctx, "/v3/product/list", body, &resp); err != nil {
			return err
		}
		p := ProductPage{Number: page, Items: resp.Result.Items, LastID: rawToString(resp.Result.LastID)}
		if len(p.Items) == 0 {
			return nil // 空页即结束，包括续跑到末尾的情况
		}
		if p.LastID != "" && p.LastID == lastID {
			// 游标没前进 = 接口把同一页又发了一遍。必须在交给 onPage 之前就收手：
			// 先处理后报错会让这一页的商品被重复提交一遍（真实店铺上就是重复改价）。
			return fmt.Errorf("商品列表游标没有前进（last_id=%s），停止扫描以避免死循环", lastID)
		}
		if err := onPage(p); err != nil {
			return err
		}
		if p.LastID == "" {
			return nil
		}
		lastID = p.LastID
	}
}

func rawToString(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return ""
	}
	return strings.Trim(s, `"`)
}

// ---------- 价格 ----------

type PriceInfo struct {
	ProductID FlexInt `json:"product_id"`
	OfferID   string  `json:"offer_id"`
	// 内层用指针是为了把"字段缺失/为 null"和"值就是 0"分开：
	// JS 用 currentPrice == null 判定 not_applicable，换成值类型后 0 会被当成有价格，
	// 影子模式的统计会虚高，真跑时还会给零报价商品提交 min_price=-0.01。
	Price *struct {
		Price                *FlexFloat `json:"price"`
		MinPrice             *FlexFloat `json:"min_price"`
		OldPrice             *FlexFloat `json:"old_price"`
		CurrencyCode         string     `json:"currency_code"`
		MarketingSellerPrice *FlexFloat `json:"marketing_seller_price"`
	} `json:"price"`
}

type priceInfoResp struct {
	Items  []PriceInfo `json:"items"`
	LastID string      `json:"last_id"`
}

// ListPrices 按 product_id 批量查价格。内部按 200 个一批分次查询:
// 一次 1000 个的请求 Ozon 侧要 15s+ 才吐完响应,连续两天整页超时(2026-10-06 漏 2000、
// 10-07 漏 3000 个商品的价格检查,重试 5 次也救不回来);改小批量后单次几秒内返回。
// 某批失败只丢那一批(记录错误继续其余批),返回"已拿到的部分 + 首个错误",
// 调用方可继续处理成功部分,漏的下一班补。
// filter.product_id 必须是字符串数组，传数字 Ozon 会直接 400。
const priceQueryChunk = 200

func (c *Client) ListPrices(ctx context.Context, productIDs []int64) ([]PriceInfo, error) {
	var all []PriceInfo
	var firstErr error
	for start := 0; start < len(productIDs); start += priceQueryChunk {
		end := start + priceQueryChunk
		if end > len(productIDs) {
			end = len(productIDs)
		}
		chunk := productIDs[start:end]
		ids := make([]string, 0, len(chunk))
		for _, id := range chunk {
			ids = append(ids, strconv.FormatInt(id, 10))
		}
		var resp priceInfoResp
		filter := map[string]any{"product_id": ids}
		if err := c.postRead(ctx, "/v5/product/info/prices", map[string]any{"filter": filter, "limit": len(chunk)}, &resp); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			logx.Errorf("[价格] 第 %d 批(%d 个商品)查询失败,跳过该批: %v", start/priceQueryChunk+1, len(chunk), err)
			continue
		}
		// 显式 id 列表正常不会有下一页；真出现了说明这批漏查，必须喊出来而不是默默少处理
		if resp.LastID != "" && len(resp.Items) >= len(chunk) {
			logx.Errorf("[价格] 返回了游标 %q 但本批已取满 %d 条，可能有商品被漏掉", resp.LastID, len(resp.Items))
		}
		all = append(all, resp.Items...)
	}
	return all, firstErr
}

// PriceImportItem /v1/product/import/prices 的单条。
// 价格字段全部用字符串提交：Ozon 对浮点尾巴很敏感，toFixed(2) 的等价写法就是字符串。
type PriceImportItem struct {
	ProductID                         int64  `json:"product_id"`
	OfferID                           string `json:"offer_id"`
	AutoActionEnabled                 string `json:"auto_action_enabled"`
	MinPriceForAutoActionsEnabled     bool   `json:"min_price_for_auto_actions_enabled"`
	PriceStrategyEnabled              string `json:"price_strategy_enabled"`
	ManageElasticBoostingThroughPrice bool   `json:"manage_elastic_boosting_through_price"`
	MinPrice                          string `json:"min_price"`
	Price                             string `json:"price"`
	OldPrice                          string `json:"old_price"`
	CurrencyCode                      string `json:"currency_code"`
}

type PriceImportError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field"`
}

func (e PriceImportError) String() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

type PriceImportOutcome struct {
	ProductID FlexInt            `json:"product_id"`
	OfferID   string             `json:"offer_id"`
	Updated   bool               `json:"updated"`
	Errors    []PriceImportError `json:"errors"`
}

type priceImportResp struct {
	Result []PriceImportOutcome `json:"result"`
}

// ImportPrices 写价格。out 可能为 nil（调用方只关心是否成功）。
func (c *Client) ImportPrices(ctx context.Context, items []PriceImportItem, out *[]PriceImportOutcome) (bool, error) {
	var resp priceImportResp
	executed, err := c.postWrite(ctx, "/v1/product/import/prices", map[string]any{"prices": items}, &resp)
	if err != nil {
		return executed, err
	}
	if out != nil {
		*out = resp.Result
	}
	return executed, nil
}

// ---------- 定时器 ----------

type TimerStatus struct {
	ProductID                     FlexInt `json:"product_id"`
	OfferID                       string  `json:"offer_id"`
	MinPriceForAutoActionsEnabled bool    `json:"min_price_for_auto_actions_enabled"`
	ExpiredAt                     string  `json:"expired_at"`
}

type timerStatusResp struct {
	Statuses []TimerStatus `json:"statuses"`
}

// UpdateTimers 刷新商品定时器；接口只回 2xx 空体，所以成功与否看状态码。
func (c *Client) UpdateTimers(ctx context.Context, productIDs []int64) (bool, error) {
	return c.postWrite(ctx, "/v1/product/action/timer/update", map[string]any{"product_ids": productIDs}, nil)
}

func (c *Client) TimerStatus(ctx context.Context, productIDs []int64) ([]TimerStatus, error) {
	var resp timerStatusResp
	if err := c.postRead(ctx, "/v1/product/action/timer/status", map[string]any{"product_ids": productIDs}, &resp); err != nil {
		return nil, err
	}
	return resp.Statuses, nil
}

// ---------- 促销活动 ----------

type Action struct {
	ID                         FlexInt `json:"id"`
	Title                      string  `json:"title"`
	ParticipatingProductsCount FlexInt `json:"participating_products_count"`
}

type actionsResp struct {
	Result []Action `json:"result"`
}

func (c *Client) ListActions(ctx context.Context) ([]Action, error) {
	var resp actionsResp
	if err := c.get(ctx, "/v1/actions", &resp); err != nil {
		return nil, err
	}
	return resp.Result, nil
}

type ActionProduct struct {
	ID FlexInt `json:"id"`
}

type actionProductsResp struct {
	Result struct {
		Products []ActionProduct `json:"products"`
		LastID   json.RawMessage `json:"last_id"`
	} `json:"result"`
}

// ActionProductPage 是一页活动商品（活动接口 limit 上限 100，游标是 string）。
type ActionProductPage struct {
	Number   int
	Products []ActionProduct
	LastID   string
}

// SweepActionProducts 逐页拉取某活动下的商品。语义与 SweepProducts 相同：
// startAfter 传断点游标可续跑，onPage 报错即中断，游标停在出错页之前。
func (c *Client) SweepActionProducts(ctx context.Context, actionID int64, startAfter string, onPage func(ActionProductPage) error) error {
	const limit = 100 // 接口上限
	lastID := startAfter
	for page := 1; ; page++ {
		var resp actionProductsResp
		if err := c.postRead(ctx, "/v1/actions/products", map[string]any{
			"action_id": actionID, "limit": limit, "last_id": lastID,
		}, &resp); err != nil {
			return err
		}
		if resp.Result.Products == nil && resp.Result.LastID == nil {
			logx.Infof("[活动 %d] 响应里没有 result，按 0 个商品处理", actionID)
			return nil
		}
		p := ActionProductPage{Number: page, Products: resp.Result.Products, LastID: rawToString(resp.Result.LastID)}
		if len(p.Products) == 0 {
			return nil
		}
		if p.LastID != "" && p.LastID == lastID {
			return fmt.Errorf("活动 %d 的商品游标没有前进（last_id=%s），停止扫描以避免死循环", actionID, lastID)
		}
		if err := onPage(p); err != nil {
			return err
		}
		if p.LastID == "" {
			return nil
		}
		lastID = p.LastID
	}
}

type DeactivateRejected struct {
	ProductID FlexInt `json:"product_id"`
	Reason    string  `json:"reason"`
}

type deactivateResp struct {
	Result struct {
		ProductIDs []FlexInt            `json:"product_ids"`
		Rejected   []DeactivateRejected `json:"rejected"`
	} `json:"result"`
}

// DeactivateProducts 把商品从促销活动中移除。
func (c *Client) DeactivateProducts(ctx context.Context, actionID int64, productIDs []int64) (deactivated []int64, rejected []DeactivateRejected, executed bool, err error) {
	var resp deactivateResp
	executed, err = c.postWrite(ctx, "/v1/actions/products/deactivate", map[string]any{
		"action_id": actionID, "product_ids": productIDs,
	}, &resp)
	if err != nil || !executed {
		return nil, nil, executed, err
	}
	for _, id := range resp.Result.ProductIDs {
		deactivated = append(deactivated, id.Int64())
	}
	return deactivated, resp.Result.Rejected, true, nil
}
