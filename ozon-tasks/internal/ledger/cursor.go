// 断点续跑游标：一轮全店扫描可能几千个商品、几十分钟，进程中途倒下不该从头再来。
//
// 只有"还新鲜"的游标才值得续：商品列表会变动，隔了一天的游标意味着前面那段
// 已经物是人非，接着扫会漏掉新增商品。所以 LoadCursor 带 maxAge，过旧就作废重扫，
// 宁可多花一次分页请求，也不要静默漏掉一批商品没设最低价。
package ledger

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Cursor 是一条扫描进度。Value 原样存 Ozon 的 last_id（数字和字符串都出现过，不做解析）。
type Cursor struct {
	Scope     string    `json:"scope"`
	Value     string    `json:"cursor"`
	Processed int64     `json:"processed"`
	Owner     string    `json:"owner"`
	UpdatedAt time.Time `json:"updatedAt"`
	Finished  bool      `json:"finished"`
}

// LoadCursor 取回可续用的游标。found=false 表示没有、已跑完、或旧得该重扫了——
// 三种情况调用方都应当从头开始，无需区分。
func (d *DB) LoadCursor(scope string, maxAge time.Duration, now time.Time) (Cursor, bool, error) {
	var (
		c            Cursor
		updatedAt    int64
		finishedAt   int64
		value, owner sql.NullString
	)
	err := d.sqlDB.QueryRow(`
		SELECT scope, cursor, processed, owner, updated_at, finished_at
		FROM sweep_cursors WHERE scope = ?`, scope).
		Scan(&c.Scope, &value, &c.Processed, &owner, &updatedAt, &finishedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Cursor{Scope: scope}, false, nil
	}
	if err != nil {
		return Cursor{}, false, fmt.Errorf("读取游标失败 %s: %w", scope, err)
	}
	c.Value = value.String
	c.Owner = owner.String
	c.UpdatedAt = time.UnixMilli(updatedAt)
	c.Finished = finishedAt != 0
	if c.Finished {
		return c, false, nil
	}
	if maxAge > 0 && now.Sub(c.UpdatedAt) > maxAge {
		return c, false, nil
	}
	return c, true, nil
}

// SaveCursor 记录进度。一轮里每个分页批次写一次，写失败只影响下次能否续跑，
// 不该把整轮任务打断，所以调用方通常只记日志、不返回错误。
func (d *DB) SaveCursor(scope, value string, processed int64, owner string, now time.Time) error {
	_, err := d.sqlDB.Exec(`
		INSERT INTO sweep_cursors (scope, cursor, processed, owner, updated_at, finished_at)
		VALUES (?, ?, ?, ?, ?, 0)
		ON CONFLICT(scope) DO UPDATE SET
			cursor = excluded.cursor,
			processed = excluded.processed,
			owner = excluded.owner,
			updated_at = excluded.updated_at,
			finished_at = 0`,
		scope, value, processed, owner, now.UnixMilli())
	if err != nil {
		return fmt.Errorf("写入游标失败 %s: %w", scope, err)
	}
	return nil
}

// FinishCursor 标记本轮跑完：游标清零，下次从头扫。
// 一轮都没写过游标的店铺（空店铺）也要落一条"已完成"，否则 status 上看不出它跑过。
func (d *DB) FinishCursor(scope string, processed int64, now time.Time) error {
	nowMS := now.UnixMilli()
	_, err := d.sqlDB.Exec(`
		INSERT INTO sweep_cursors (scope, cursor, processed, owner, updated_at, finished_at)
		VALUES (?, '', ?, '', ?, ?)
		ON CONFLICT(scope) DO UPDATE SET
			cursor = '',
			processed = excluded.processed,
			updated_at = excluded.updated_at,
			finished_at = excluded.finished_at`,
		scope, processed, nowMS, nowMS)
	if err != nil {
		return fmt.Errorf("标记游标完成失败 %s: %w", scope, err)
	}
	return nil
}

// AllCursors 返回全部进度，status 子命令用。
func (d *DB) AllCursors() ([]Cursor, error) {
	rows, err := d.sqlDB.Query(`
		SELECT scope, cursor, processed, owner, updated_at, finished_at
		FROM sweep_cursors ORDER BY scope`)
	if err != nil {
		return nil, fmt.Errorf("查询游标列表失败: %w", err)
	}
	defer rows.Close()

	var out []Cursor
	for rows.Next() {
		var (
			c          Cursor
			value      sql.NullString
			owner      sql.NullString
			updatedAt  int64
			finishedAt int64
		)
		if err := rows.Scan(&c.Scope, &value, &c.Processed, &owner, &updatedAt, &finishedAt); err != nil {
			return out, fmt.Errorf("读取游标行失败: %w", err)
		}
		c.Value, c.Owner = value.String, owner.String
		c.UpdatedAt = time.UnixMilli(updatedAt)
		c.Finished = finishedAt != 0
		out = append(out, c)
	}
	return out, rows.Err()
}
