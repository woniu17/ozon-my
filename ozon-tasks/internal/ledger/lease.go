// 任务租约（lease）：谁是这一轮的执行者、能占多久、这一轮的账记在哪个计划时刻上。
//
// 与旧的"冷却期槽位"的区别在于两条护栏各管一件事，不再混用一个字段：
//   - planned_at 防重入：每个 cron 计划时刻只能被执行一次。手工再敲 --once、
//     或 pm2  reload 后进程重启，都不会把同一轮再跑一遍。
//   - lease_until 防并发：任务正在跑的时候别人抢不走；持有者崩溃时租约到期自动放开，
//     不会像纯冷却期模型那样把一个死掉的任务锁到天荒地老。
//
// 之所以够用：一台机器拥有全部门店，SQLite 文件锁只在同一文件系统内去重。
// 要扩到多机，得按分组把店铺拆到不同机器，而不是让两台机器抢同一个库。
package ledger

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// LeaseOpts 是拿租约时的附加约束。
type LeaseOpts struct {
	TTL         time.Duration // 租约时长，必须大于单轮最坏耗时；心跳会续期
	MinInterval time.Duration // 上一轮没成功时的重试退避间距；成功过就不参与判定
	Force       bool          // 忽略"本计划时刻已执行"与最小间隔，但仍不越过活动租约
}

// ErrLeaseLost 表示租约已经不归本进程（超时被接管）。
// 正在跑的任务收到它就该尽快收手，避免两个执行者同时写同一批商品。
var ErrLeaseLost = errors.New("任务租约已丢失")

func (d *DB) ensureSlotRow(tx *sql.Tx, slot string, nowMS int64) error {
	_, err := tx.Exec(`
		INSERT INTO task_slots (slot, holder, lease_until, planned_at, created_at, updated_at)
		VALUES (?, '', 0, 0, ?, ?) ON CONFLICT(slot) DO NOTHING`, slot, nowMS, nowMS)
	if err != nil {
		return fmt.Errorf("初始化槽位失败 %s: %w", slot, err)
	}
	return nil
}

// TryAcquireLease 尝试认领 slot 在 planned 这个计划时刻的执行权。
// 返回 acquired=false 时 reason 说明原因（写日志足够定位，不需要再翻库）。
func (d *DB) TryAcquireLease(slot, holder string, planned time.Time, opts LeaseOpts, now time.Time) (bool, string, error) {
	tx, err := d.sqlDB.Begin()
	if err != nil {
		return false, "", fmt.Errorf("开启租约事务失败: %w", err)
	}
	defer tx.Rollback()

	nowMS := now.UnixMilli()
	if err := d.ensureSlotRow(tx, slot, nowMS); err != nil {
		return false, "", err
	}

	var (
		curHolder  string
		leaseUntil int64
		plannedAt  int64
		startedAt  sql.NullInt64
		lastStatus sql.NullString
	)
	err = tx.QueryRow(`
		SELECT holder, lease_until, planned_at, started_at, status
		FROM task_slots WHERE slot = ?`, slot).
		Scan(&curHolder, &leaseUntil, &plannedAt, &startedAt, &lastStatus)
	if err != nil {
		return false, "", fmt.Errorf("读取租约失败 %s: %w", slot, err)
	}

	// 活动租约：只有持有者自己回来认领同一轮才允许（Force 重入），否则一律拒绝。
	// 这一条永远不放开——两个执行者同时改价格比少跑一轮严重得多。
	if curHolder != "" && leaseUntil > nowMS {
		if curHolder == holder && opts.Force {
			// 同一个持有者强制重跑：继续往下走，由 UPDATE 覆盖租约
		} else if curHolder == holder {
			return false, fmt.Sprintf("本进程已持有 %s 的租约（%s 前有效）", slot, logTime(leaseUntil)), nil
		} else {
			return false, fmt.Sprintf("%s 正被 %s 执行（租约 %s 前有效）", slot, curHolder, logTime(leaseUntil)), nil
		}
	}

	plannedMS := planned.UnixMilli()
	if !opts.Force {
		if plannedMS <= plannedAt {
			return false, fmt.Sprintf("计划时刻 %s 已执行过（台账记录到 %s）", logTime(plannedMS), logTime(plannedAt)), nil
		}
		// 最小间隔只用来给失败退避，不用来卡正常排期：上一轮成功时，
		// 排期本身已经决定了节奏，再叠一层冷却会把"每 2 小时"偷偷变成"每 8 小时"，
		// 这种静默降频比跑错更难查。上一轮失败（或从未成功）才需要拉开重试间距。
		if lastStatus.String != "ok" && opts.MinInterval > 0 && startedAt.Valid && startedAt.Int64 > 0 {
			if gap := time.Duration(nowMS-startedAt.Int64) * time.Millisecond; gap < opts.MinInterval {
				return false, fmt.Sprintf("上次未成功，距上次开始只过 %s，不足退避间隔 %s", gap.Round(time.Second), opts.MinInterval), nil
			}
		}
	}

	ttl := opts.TTL
	if ttl <= 0 {
		ttl = 30 * time.Minute
	}
	res, err := tx.Exec(`
		UPDATE task_slots
		SET holder = ?, lease_until = ?, heartbeat_at = ?, planned_at = ?, started_at = ?,
		    status = 'running', last_error = NULL, updated_at = ?
		WHERE slot = ? AND holder = ? AND lease_until = ?`,
		holder, nowMS+ttl.Milliseconds(), nowMS, plannedMS, nowMS, nowMS, slot, curHolder, leaseUntil)
	if err != nil {
		return false, "", fmt.Errorf("写入租约失败 %s: %w", slot, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// 上面读判写之间被人抢先：直接让调用方本轮跳过，下一班 cron 再来
		return false, "认领瞬间被其他进程抢先，本轮跳过", nil
	}
	if err := tx.Commit(); err != nil {
		return false, "", fmt.Errorf("提交租约失败: %w", err)
	}
	return true, "", nil
}

// RenewLease 续租。返回 false 表示租约已不归本进程（被接管或槽位被重置），
// 调用方应把它当作 ErrLeaseLost 处理并尽快收手。
func (d *DB) RenewLease(slot, holder string, ttl time.Duration, now time.Time) (bool, error) {
	res, err := d.sqlDB.Exec(`
		UPDATE task_slots SET lease_until = ?, heartbeat_at = ?, updated_at = ?
		WHERE slot = ? AND holder = ? AND lease_until > ?`,
		now.Add(ttl).UnixMilli(), now.UnixMilli(), now.UnixMilli(), slot, holder, now.Add(-time.Second).UnixMilli())
	if err != nil {
		return false, fmt.Errorf("续租失败 %s: %w", slot, err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// FinishLease 结束这一轮：释放 holder（下一班 cron 才能重新认领），并落结果供 status 查。
// 成功和失败都要调——失败同样算"这个计划时刻已经处理过了"，不该在下一分钟重试到天涯海角。
func (d *DB) FinishLease(slot, holder string, at time.Time, status, detail, errMsg string) error {
	res, err := d.sqlDB.Exec(`
		UPDATE task_slots
		SET holder = '', lease_until = 0, heartbeat_at = ?, finished_at = ?,
		    status = ?, detail = ?, last_error = ?, runs = runs + 1, updated_at = ?
		WHERE slot = ? AND holder = ?`,
		at.UnixMilli(), at.UnixMilli(), status, detail, errMsg, at.UnixMilli(), slot, holder)
	if err != nil {
		return fmt.Errorf("结束租约失败 %s: %w", slot, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("%w: %s 的租约不再属于 %s，本轮结果未入账", ErrLeaseLost, slot, holder)
	}
	return nil
}

// SlotState 是槽位的台账快照，供 status 子命令和调度器决定首班时刻。
type SlotState struct {
	Slot        string
	Holder      string
	LeaseUntil  time.Time
	HeartbeatAt time.Time
	PlannedAt   time.Time // 最近被认领的计划时刻；Zero 表示从未跑过
	StartedAt   time.Time
	FinishedAt  time.Time
	Status      string
	Detail      string
	Error       string
	Runs        int
	Exists      bool
}

// Running 判断是否有一轮正在执行中（租约还没过期）。
func (s SlotState) Running(now time.Time) bool {
	return s.Holder != "" && s.LeaseUntil.After(now)
}

func (d *DB) readSlot(rows interface{ Scan(...any) error }) (SlotState, error) {
	var (
		st                     SlotState
		leaseUntil, plannedAt  int64
		heartbeat, started     sql.NullInt64
		finished               sql.NullInt64
		status, detail, errMsg sql.NullString
	)
	err := rows.Scan(&st.Slot, &st.Holder, &leaseUntil, &heartbeat, &plannedAt,
		&started, &finished, &status, &detail, &errMsg, &st.Runs)
	if err != nil {
		return st, err
	}
	st.Exists = true
	st.LeaseUntil = time.UnixMilli(leaseUntil)
	st.PlannedAt = zeroOr(plannedAt)
	st.HeartbeatAt = nullTime(heartbeat)
	st.StartedAt = nullTime(started)
	st.FinishedAt = nullTime(finished)
	st.Status, st.Detail, st.Error = status.String, detail.String, errMsg.String
	return st, nil
}

const slotColumns = `slot, holder, lease_until, heartbeat_at, planned_at, started_at, finished_at,
	status, detail, last_error, runs`

// SlotStateOf 读单个槽位；不存在时返回 Exists=false（不是错误，首次运行就是这样）。
func (d *DB) SlotStateOf(slot string) (SlotState, error) {
	row := d.sqlDB.QueryRow(`SELECT `+slotColumns+` FROM task_slots WHERE slot = ?`, slot)
	st, err := d.readSlot(row)
	if errors.Is(err, sql.ErrNoRows) {
		return SlotState{Slot: slot}, nil
	}
	if err != nil {
		return st, fmt.Errorf("查询槽位失败 %s: %w", slot, err)
	}
	return st, nil
}

// AllSlotStates 按槽位名排序返回全部槽位，status 子命令用它一次读全量。
func (d *DB) AllSlotStates() ([]SlotState, error) {
	rows, err := d.sqlDB.Query(`SELECT ` + slotColumns + ` FROM task_slots ORDER BY slot`)
	if err != nil {
		return nil, fmt.Errorf("查询槽位列表失败: %w", err)
	}
	defer rows.Close()

	var out []SlotState
	for rows.Next() {
		st, err := d.readSlot(rows)
		if err != nil {
			return out, fmt.Errorf("读取槽位行失败: %w", err)
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// AbandonLease 在优雅停机时把本进程持有的租约立刻放开，
// 让下一班 cron（或另一台机器接手后）不必等租约自然到期。
func (d *DB) AbandonLease(slot, holder string, at time.Time) error {
	_, err := d.sqlDB.Exec(`
		UPDATE task_slots SET holder = '', lease_until = 0, status = 'interrupted', updated_at = ?
		WHERE slot = ? AND holder = ?`, at.UnixMilli(), slot, holder)
	if err != nil {
		return fmt.Errorf("释放租约失败 %s: %w", slot, err)
	}
	return nil
}

func nullTime(v sql.NullInt64) time.Time {
	if !v.Valid || v.Int64 == 0 {
		return time.Time{}
	}
	return time.UnixMilli(v.Int64)
}

func zeroOr(v int64) time.Time {
	if v == 0 {
		return time.Time{}
	}
	return time.UnixMilli(v)
}

func logTime(ms int64) string {
	return time.UnixMilli(ms).Format("2006-01-02 15:04:05")
}
