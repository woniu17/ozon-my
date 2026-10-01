// Package ledger 用 SQLite 承担原来 MongoDB 的三件事：商品价格台账（ozon_product_prices）、
// 任务租约（task_slots）和断点续跑游标（sweep_cursors）。
//
// 价格字段语义逐条对齐 httpsrv/dataprocessv2/ozonPriceStore.js，包括两个容易看漏的点：
//   - price 为 NULL 表示"这个商品没有价格"，与 0 必须区分开（状态判定靠它）
//   - created_at / marketing_seller_price 在更新时不能被空值冲掉（对应 Mongo 的 $setOnInsert 与条件 $set）
package ledger

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite" // 纯 Go 驱动：不需要 CGO，才能交叉编译出单个静态二进制丢到 nuc 上跑

	"ozon-tasks/internal/config"
)

// PriceRecord 一行价格台账。MinPriceSetAt 为 0 表示"本次没实际设置成功，沿用旧值"。
type PriceRecord struct {
	ProductID            int64
	OfferID              string
	Price                *float64
	MinPrice             float64
	OldPrice             float64
	CurrencyCode         string
	MarketingSellerPrice *float64
	MinPriceStatus       string // set | skipped | failed | not_applicable
	MinPriceSetAt        int64
}

// DB 包一层 *sql.DB。连接数限死 1：SQLite 只允许一个写者，
// 与其在并发写时踩 SQLITE_BUSY，不如让写操作排队（任务本来就是串行跑的）。
type DB struct {
	sqlDB *sql.DB
	path  string
}

func Open(path string) (*DB, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("创建数据库目录失败 %s: %w", dir, err)
		}
	}
	// WAL：读不阻塞写。任务跑几十分钟，期间还要能查台账。
	dsn := path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(10000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"
	raw, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败 %s: %w", path, err)
	}
	raw.SetMaxOpenConns(1)
	if err := raw.Ping(); err != nil {
		raw.Close()
		return nil, fmt.Errorf("连接数据库失败 %s: %w", path, err)
	}
	d := &DB{sqlDB: raw, path: path}
	if err := d.migrate(); err != nil {
		raw.Close()
		return nil, err
	}
	return d, nil
}

func (d *DB) Close() error { return d.sqlDB.Close() }
func (d *DB) Path() string { return d.path }

const schema = `
CREATE TABLE IF NOT EXISTS ozon_product_prices (
	id                     TEXT    PRIMARY KEY,
	client_id              TEXT    NOT NULL,
	shop_name              TEXT    NOT NULL,
	product_id             INTEGER NOT NULL,
	offer_id               TEXT,
	price                  REAL,
	min_price              REAL    NOT NULL DEFAULT 0,
	old_price              REAL    NOT NULL DEFAULT 0,
	currency_code          TEXT    NOT NULL DEFAULT 'RUB',
	marketing_seller_price REAL,
	min_price_status       TEXT    NOT NULL,
	min_price_set_at       INTEGER,
	price_checked_at       INTEGER NOT NULL,
	created_at             INTEGER NOT NULL,
	updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS price_shop_name_idx     ON ozon_product_prices (shop_name);
CREATE INDEX IF NOT EXISTS price_status_idx        ON ozon_product_prices (min_price_status);
CREATE INDEX IF NOT EXISTS price_checked_at_idx    ON ozon_product_prices (price_checked_at DESC);
CREATE INDEX IF NOT EXISTS price_offer_id_idx      ON ozon_product_prices (offer_id);
CREATE INDEX IF NOT EXISTS price_set_at_idx        ON ozon_product_prices (min_price_set_at DESC);

CREATE TABLE IF NOT EXISTS task_slots (
	slot         TEXT    PRIMARY KEY,
	holder       TEXT    NOT NULL DEFAULT '',
	lease_until  INTEGER NOT NULL DEFAULT 0,
	heartbeat_at INTEGER,
	planned_at   INTEGER NOT NULL DEFAULT 0,
	started_at   INTEGER,
	finished_at  INTEGER,
	status       TEXT,
	detail       TEXT,
	last_error   TEXT,
	runs         INTEGER NOT NULL DEFAULT 0,
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sweep_cursors (
	scope       TEXT    PRIMARY KEY,
	cursor      TEXT    NOT NULL DEFAULT '',
	processed   INTEGER NOT NULL DEFAULT 0,
	owner       TEXT    NOT NULL DEFAULT '',
	updated_at  INTEGER NOT NULL,
	finished_at INTEGER NOT NULL DEFAULT 0
);
`

func (d *DB) migrate() error {
	if _, err := d.sqlDB.Exec(schema); err != nil {
		return fmt.Errorf("建表失败: %w", err)
	}
	return nil
}

// docID 与原 Mongo 的 _id 组法一致（clientId_productId），两边数据对拍时能一一对上。
func docID(clientID string, productID int64) string {
	return fmt.Sprintf("%s_%d", clientID, productID)
}

// UpsertPrices 批量写价格台账，整批一个事务。返回受影响行数。
// created_at 不在 UPDATE 分支里出现，等价于 Mongo 的 $setOnInsert：只在首次插入时落值。
func (d *DB) UpsertPrices(shop config.Shop, records []PriceRecord, at time.Time) (int64, error) {
	if len(records) == 0 {
		return 0, nil
	}
	tx, err := d.sqlDB.Begin()
	if err != nil {
		return 0, fmt.Errorf("开启事务失败: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
INSERT INTO ozon_product_prices (
	id, client_id, shop_name, product_id, offer_id, price, min_price, old_price,
	currency_code, marketing_seller_price, min_price_status, min_price_set_at,
	price_checked_at, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	client_id = excluded.client_id,
	shop_name = excluded.shop_name,
	product_id = excluded.product_id,
	offer_id = excluded.offer_id,
	price = excluded.price,
	min_price = excluded.min_price,
	old_price = excluded.old_price,
	currency_code = excluded.currency_code,
	marketing_seller_price = COALESCE(excluded.marketing_seller_price, ozon_product_prices.marketing_seller_price),
	min_price_status = excluded.min_price_status,
	min_price_set_at = COALESCE(excluded.min_price_set_at, ozon_product_prices.min_price_set_at),
	price_checked_at = excluded.price_checked_at,
	updated_at = excluded.updated_at`)
	if err != nil {
		return 0, fmt.Errorf("预编译语句失败: %w", err)
	}
	defer stmt.Close()

	nowMS := at.UnixMilli()
	var affected int64
	for i, r := range records {
		if strings.TrimSpace(r.MinPriceStatus) == "" {
			return affected, fmt.Errorf("第 %d 条记录缺少 min_price_status，拒绝入库（状态为空会让价格页筛不出这批商品）", i+1)
		}
		currency := r.CurrencyCode
		if currency == "" {
			currency = "RUB"
		}
		var setAt any
		if r.MinPriceSetAt > 0 {
			setAt = r.MinPriceSetAt
		}
		var marketing any
		if r.MarketingSellerPrice != nil {
			marketing = *r.MarketingSellerPrice
		}
		res, err := stmt.Exec(
			docID(shop.ClientID, r.ProductID), shop.ClientID, shop.Name, r.ProductID, r.OfferID,
			r.Price, r.MinPrice, r.OldPrice, currency, marketing, r.MinPriceStatus, setAt,
			nowMS, nowMS, nowMS,
		)
		if err != nil {
			return affected, fmt.Errorf("写入价格记录失败 product_id=%d: %w", r.ProductID, err)
		}
		n, _ := res.RowsAffected()
		affected += n
	}
	if err := tx.Commit(); err != nil {
		return affected, fmt.Errorf("提交事务失败: %w", err)
	}
	return affected, nil
}

// CountPrices 供自检用：库里现有多少条、本次是否真的写进去了。
func (d *DB) CountPrices() (int64, error) {
	var n int64
	err := d.sqlDB.QueryRow(`SELECT COUNT(1) FROM ozon_product_prices`).Scan(&n)
	return n, err
}

// ShopLedger 是一家店在台账里的概况，status 子命令用。
type ShopLedger struct {
	ShopName        string    `json:"shopName"`
	Rows            int       `json:"rows"`
	Set             int       `json:"set"`
	Skipped         int       `json:"skipped"`
	Failed          int       `json:"failed"`
	NotApplicable   int       `json:"notApplicable"`
	LatestCheckedAt time.Time `json:"latestCheckedAt"`
	LatestSetAt     time.Time `json:"latestSetAt"`
}

// LedgerSummary 按店铺汇总台账。SQLite 里布尔就是 0/1，SUM 直接当计数用。
func (d *DB) LedgerSummary() ([]ShopLedger, error) {
	rows, err := d.sqlDB.Query(`
		SELECT shop_name, COUNT(1),
		       SUM(min_price_status = 'set'),
		       SUM(min_price_status = 'skipped'),
		       SUM(min_price_status = 'failed'),
		       SUM(min_price_status = 'not_applicable'),
		       MAX(price_checked_at), MAX(min_price_set_at)
		FROM ozon_product_prices GROUP BY shop_name ORDER BY shop_name`)
	if err != nil {
		return nil, fmt.Errorf("汇总台账失败: %w", err)
	}
	defer rows.Close()

	var out []ShopLedger
	for rows.Next() {
		var (
			s         ShopLedger
			set, skip sql.NullInt64
			fail, na  sql.NullInt64
			checked   int64
			setAt     sql.NullInt64
		)
		if err := rows.Scan(&s.ShopName, &s.Rows, &set, &skip, &fail, &na, &checked, &setAt); err != nil {
			return out, fmt.Errorf("读取台账汇总失败: %w", err)
		}
		s.Set, s.Skipped, s.Failed, s.NotApplicable =
			int(set.Int64), int(skip.Int64), int(fail.Int64), int(na.Int64)
		s.LatestCheckedAt = time.UnixMilli(checked)
		if setAt.Valid && setAt.Int64 > 0 {
			s.LatestSetAt = time.UnixMilli(setAt.Int64)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// PriceRow 一行台账（自检/对账用的最小集，字段名沿用 JS 侧驼峰，方便和 Mongo 文档对拍）。
type PriceRow struct {
	ID             string   `json:"id"`
	ShopName       string   `json:"shopName"`
	ProductID      int64    `json:"productId"`
	OfferID        string   `json:"offerId"`
	Price          *float64 `json:"price"`
	MinPrice       float64  `json:"minPrice"`
	OldPrice       float64  `json:"oldPrice"`
	CurrencyCode   string   `json:"currencyCode"`
	MinPriceStatus string   `json:"minPriceStatus"`
	MinPriceSetAt  int64    `json:"minPriceSetAt"`
	PriceCheckedAt int64    `json:"priceCheckedAt"`
	CreatedAt      int64    `json:"createdAt"`
}

// GetPrice 按店铺+商品查一行，测试与自检用。
func (d *DB) GetPrice(clientID string, productID int64) (*PriceRow, error) {
	row := d.sqlDB.QueryRow(`
		SELECT id, shop_name, product_id, IFNULL(offer_id,''), price, min_price, old_price,
		       currency_code, IFNULL(min_price_status,''), IFNULL(min_price_set_at,0),
		       price_checked_at, created_at
		FROM ozon_product_prices WHERE id = ?`, docID(clientID, productID))
	var r PriceRow
	var setAt, checked, created sql.NullInt64
	var price sql.NullFloat64
	err := row.Scan(&r.ID, &r.ShopName, &r.ProductID, &r.OfferID, &price, &r.MinPrice, &r.OldPrice,
		&r.CurrencyCode, &r.MinPriceStatus, &setAt, &checked, &created)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if price.Valid {
		v := price.Float64
		r.Price = &v
	}
	r.MinPriceSetAt = setAt.Int64
	r.PriceCheckedAt = checked.Int64
	r.CreatedAt = created.Int64
	return &r, nil
}
