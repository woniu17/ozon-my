// 价格台账的单测盯的是"别把历史字段冲掉"——这类错误不会当场报错，
// 只会在几天后发现数据被覆盖。租约与游标的行为在 lease_test.go 里。
// 槽位改成了带 TTL 的租约模型，见 lease.go。
package ledger

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"ozon-tasks/internal/config"
)

func openDB(t *testing.T) *DB {
	t.Helper()
	// 放在子目录里，顺带验证 Open 会自己建目录（首次部署时 data/ 通常不存在）
	d, err := Open(filepath.Join(t.TempDir(), "nested", "test.db"))
	if err != nil {
		t.Fatalf("Open 失败: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func f64(v float64) *float64 { return &v }

var shop = config.Shop{Name: "YQL01", ClientID: "777", APIKey: "k"}

func TestUpsertInsertsAndPreservesCreatedAt(t *testing.T) {
	d := openDB(t)
	first := time.Date(2026, 10, 1, 8, 0, 0, 0, time.Local)
	marketing := 88.5

	if _, err := d.UpsertPrices(shop, []PriceRecord{{
		ProductID: 11, OfferID: "OFFER-1", Price: f64(99.9), MinPrice: 0, OldPrice: 120,
		MinPriceStatus: "set", MinPriceSetAt: first.UnixMilli(), MarketingSellerPrice: &marketing,
	}}, first); err != nil {
		t.Fatalf("入库失败: %v", err)
	}

	row, err := d.GetPrice(shop.ClientID, 11)
	if err != nil || row == nil {
		t.Fatalf("查不到刚写入的行: %v", err)
	}
	if row.CreatedAt != first.UnixMilli() || row.MinPriceSetAt != first.UnixMilli() {
		t.Errorf("首次写入的 created_at/min_price_set_at 不对: %+v", row)
	}
	if row.ID != "777_11" {
		t.Errorf("_id 组法与 Mongo 不一致: %q", row.ID)
	}

	later := first.Add(8 * time.Hour)
	if _, err := d.UpsertPrices(shop, []PriceRecord{{
		ProductID: 11, OfferID: "OFFER-1", Price: f64(88.8), MinPrice: 88.79,
		MinPriceStatus: "skipped", // 本次没设置，min_price_set_at 必须沿用旧值
	}}, later); err != nil {
		t.Fatalf("二次入库失败: %v", err)
	}
	row2, _ := d.GetPrice(shop.ClientID, 11)
	if row2.CreatedAt != first.UnixMilli() {
		t.Errorf("created_at 被更新了（%d → %d），首次入库时间必须保住", first.UnixMilli(), row2.CreatedAt)
	}
	if row2.MinPriceSetAt != first.UnixMilli() {
		t.Errorf("min_price_set_at 被清空了: %d", row2.MinPriceSetAt)
	}
	if row2.MinPrice != 88.79 || row2.MinPriceStatus != "skipped" {
		t.Errorf("业务字段没更新: %+v", row2)
	}
	if row2.CurrencyCode != "RUB" {
		t.Errorf("币种缺省值应为 RUB，实际 %q", row2.CurrencyCode)
	}
}

func TestNullPriceStaysNull(t *testing.T) {
	d := openDB(t)
	now := time.Now()
	// price 为 NULL（商品没报价）必须和 0 区分：状态判定和价格页都靠它
	if _, err := d.UpsertPrices(shop, []PriceRecord{{
		ProductID: 21, MinPriceStatus: "not_applicable",
	}}, now); err != nil {
		t.Fatal(err)
	}
	row, _ := d.GetPrice(shop.ClientID, 21)
	if row.Price != nil {
		t.Errorf("price 应为 NULL，实际 %v", *row.Price)
	}

	// 有营销价时写入，下一次不带营销价也不能把它冲掉
	m := 66.6
	if _, err := d.UpsertPrices(shop, []PriceRecord{{
		ProductID: 22, Price: f64(10), MinPriceStatus: "set", MarketingSellerPrice: &m,
	}}, now); err != nil {
		t.Fatal(err)
	}
	if _, err := d.UpsertPrices(shop, []PriceRecord{{
		ProductID: 22, Price: f64(10), MinPriceStatus: "set",
	}}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	var mStored sql.NullFloat64
	if err := d.sqlDB.QueryRow(`SELECT marketing_seller_price FROM ozon_product_prices WHERE id = '777_22'`).Scan(&mStored); err != nil {
		t.Fatalf("读营销价失败: %v", err)
	}
	// 第二次入库没带营销价，COALESCE 必须让旧值留下来，而不是被 NULL 或 0 覆盖
	if !mStored.Valid || mStored.Float64 != 66.6 {
		t.Errorf("营销价应保持 66.6，实际 valid=%v value=%v", mStored.Valid, mStored.Float64)
	}
}

func TestUpsertRejectsMissingStatus(t *testing.T) {
	d := openDB(t)
	_, err := d.UpsertPrices(shop, []PriceRecord{{ProductID: 1}, {ProductID: 2, MinPriceStatus: "set"}}, time.Now())
	if err == nil {
		t.Fatal("缺状态应当报错")
	}
	// 整批要么全写要么全不写：半途失败会留下"这批改了那批没改"的台账，比全失败更难查
	n, _ := d.CountPrices()
	if n != 0 {
		t.Errorf("事务未回滚，库里残留 %d 行", n)
	}
}

func TestUpsertEmptyBatchIsNoop(t *testing.T) {
	d := openDB(t)
	affected, err := d.UpsertPrices(shop, nil, time.Now())
	if err != nil || affected != 0 {
		t.Errorf("空批次应直接返回: %v %v", affected, err)
	}
}

func TestReopenKeepsRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keep.db")
	d, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.UpsertPrices(shop, []PriceRecord{{ProductID: 5, MinPriceStatus: "set"}}, time.Now()); err != nil {
		t.Fatal(err)
	}
	d.Close()

	// 重启后重复建表必须无害（IF NOT EXISTS），且老数据还在
	d2, err := Open(path)
	if err != nil {
		t.Fatalf("重开失败: %v", err)
	}
	defer d2.Close()
	n, _ := d2.CountPrices()
	if n != 1 {
		t.Errorf("重开后台账丢了: %d", n)
	}
}
