// Package sched 是常驻调度循环：按固定时刻触发，用数据库租约做去重和防并发。
//
// 两条护栏各管一件事（都在 ledger/lease.go 里实现）：
//   - 计划时刻去重：每一班（cron 算出来的那个时刻）最多执行一次。进程重启、
//     pm2 reload、手工再敲一次 --once 都不会把同一班重跑。
//   - 租约：正在跑的时候别人抢不走；持有者崩溃后租约到期自动放开，不会锁死。
//     跑的过程中心跳续租，一旦租约被接管就立刻取消任务上下文，避免两个执行者同时写。
//
// 触发点用"上一班的计划时刻"往后推，而不是"这次跑完的时间 + 间隔"：
// 后者会让每天凌晨的低峰任务随着耗时一点点爬进业务高峰，这是节拍器式调度的经典故障。
// 长时间停机后只补最近的一班，不把欠的班次一次性追平——三天的间隔补一遍全量就够，
// 连着跑三轮反而会把限流配额吃干。
package sched

import (
	"context"
	"errors"
	"fmt"
	"time"

	"ozon-tasks/internal/cronx"
	"ozon-tasks/internal/ledger"
	"ozon-tasks/internal/logx"
)

const (
	// MinWake 是没抢到锁时的再探间隔：抢不到说明排期被别的进程占着，不必秒级轮询。
	MinWake = time.Minute
	// RetryDelay 是执行报错后下一班的顺延量。真正的重试交给下一班，不在这里连打。
	RetryDelay = time.Minute
)

// Task 是一个调度单元：一个槽位 + 一份排期 + 一轮要干的活。
type Task struct {
	Name     string
	Slot     string
	Holder   string
	Schedule cronx.Schedule
	// Backoff 是上一轮失败后的最小重试间距（成功过就不参与判定，见 ledger.LeaseOpts）。
	Backoff time.Duration
	// Lease 是租约 TTL，必须大于单轮最坏耗时，否则跑一半会被"接管"。
	Lease time.Duration
	// Run 是这一轮的活。它拿到带心跳取消的上下文：租约丢了上下文就取消。
	Run func(context.Context) error
}

// Outcome 是一次触发的结果，--once 和 status 都要据此汇报。
type Outcome string

const (
	Ran         Outcome = "ran"         // 抢到并跑完（可能任务内部有失败，但这一班执行过了）
	Skipped     Outcome = "skipped"     // 没到班，或这一班已经被执行过
	Interrupted Outcome = "interrupted" // 停机信号打断了这一轮
	Errored     Outcome = "errored"     // 抢到了但执行报错或台账写入失败
)

func (o Outcome) String() string { return string(o) }

// Firing 是"这一班该不该跑"的判定结果。
type Firing struct {
	Planned time.Time
	Due     bool
	Reason  string
}

// Due 依据台账算出当前该执行的那一班。
// force 忽略到班判定（-run-now 用），但绝不忽略活动租约。
func (t Task) Due(db *ledger.DB, now time.Time, force bool) Firing {
	st, err := db.SlotStateOf(t.Slot)
	if err != nil {
		// 读不到台账就别跑了：连"这一班是否已经跑过"都不知道，贸然执行等于放弃去重
		return Firing{Reason: fmt.Sprintf("读取槽位台账失败: %v", err)}
	}
	if st.PlannedAt.IsZero() {
		// 这个槽位从没跑过：首班立即执行一次，方便新部署当场验证配置，之后按排期走
		return Firing{Planned: now, Due: true, Reason: "首次运行，立即执行"}
	}

	next := t.Schedule.Next(st.PlannedAt)
	if next.After(now) {
		return Firing{Planned: next, Reason: fmt.Sprintf("下一班在 %s（%s）", next.Format("01-02 15:04:05"), FormatDelay(next.Sub(now)))}
	}
	// 停机期间积压的班次折叠成最近一班：补跑一次就够，不该连着跑三遍
	latest := next
	for {
		nb := t.Schedule.Next(latest)
		if nb.After(now) {
			break
		}
		latest = nb
	}
	return Firing{Planned: latest, Due: true, Reason: fmt.Sprintf("已到班（计划 %s）", latest.Format("01-02 15:04:05"))}
}

// Run 认领并执行一班。它负责租约的整个生命周期：认领、心跳续租、结单或停机释放。
func Run(ctx context.Context, db *ledger.DB, t Task, planned time.Time, force bool) (Outcome, string, error) {
	now := time.Now()
	acquired, reason, err := db.TryAcquireLease(t.Slot, t.Holder, planned, ledger.LeaseOpts{
		TTL:         t.Lease,
		MinInterval: t.Backoff,
		Force:       force,
	}, now)
	if err != nil {
		return Errored, "", err
	}
	if !acquired {
		if reason == "" {
			reason = "未说明原因"
		}
		return Skipped, reason, nil
	}

	// 心跳：租约快到期就续。续不上说明已被别人接管，立刻取消任务上下文收手。
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go heartbeat(runCtx, cancel, db, t)

	err = t.Run(runCtx)

	finishAt := time.Now()
	if ctx.Err() != nil {
		// 停机：把租约立刻放开，下一班（或接手的那台）不用等 TTL 自然到期
		if abandonErr := db.AbandonLease(t.Slot, t.Holder, finishAt); abandonErr != nil {
			logx.Errorf("%s 停机释放租约失败: %v", t.Name, abandonErr)
		}
		return Interrupted, "已收到停止信号，本轮中断", ctx.Err()
	}

	status, detail, errMsg := "ok", "", ""
	if err != nil {
		status, errMsg = "error", err.Error()
		logx.Errorf("%s 执行失败: %v", t.Name, err)
	} else {
		detail = "执行完成"
	}
	if finishErr := db.FinishLease(t.Slot, t.Holder, finishAt, status, detail, errMsg); finishErr != nil {
		if errors.Is(finishErr, ledger.ErrLeaseLost) {
			logx.Errorf("%s 本轮结果未入账：租约已被接管", t.Name)
			return Errored, "租约被接管", finishErr
		}
		logx.Errorf("%s 写结单台账失败: %v", t.Name, finishErr)
	}
	if err != nil {
		return Errored, "", err
	}
	return Ran, "", nil
}

// heartbeat 续租。cancelLease 在续不上时被调用，让正在跑的批量操作尽快退出。
func heartbeat(ctx context.Context, cancel context.CancelFunc, db *ledger.DB, t Task) {
	interval := heartbeatInterval(t.Lease)
	tk := time.NewTicker(interval)
	defer tk.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
			ok, err := db.RenewLease(t.Slot, t.Holder, t.Lease, time.Now())
			if err != nil {
				logx.Errorf("%s 续租出错: %v", t.Name, err)
				continue
			}
			if !ok {
				logx.Errorf("%s 租约已丢失（超过 %v 没续上或被人接管），停止本轮以避免双写", t.Name, t.Lease)
				cancel()
				return
			}
		}
	}
}

// heartbeatInterval 取三分之一 TTL：留出两次续租机会，某一次被 SQLite 写锁堵住也不会立刻丢租约。
// 下限 2 秒只是防止排期被配成毫秒级租约后心跳把自己打满。
func heartbeatInterval(lease time.Duration) time.Duration {
	d := lease / 3
	if d < 2*time.Second {
		return 2 * time.Second
	}
	return d
}

// Loop 常驻循环。它只在 ctx 取消时返回。
func Loop(ctx context.Context, db *ledger.DB, t Task) {
	if t.Schedule == nil {
		logx.Errorf("%s 没有排期，循环不启动", t.Name)
		return
	}
	logx.Infof("%s 调度启动: 排期=%s 槽位=%s 租约=%v", t.Name, cronx.Describe(t.Schedule), t.Slot, t.Lease)

	for ctx.Err() == nil {
		firing := t.Due(db, time.Now(), false)
		if !firing.Due {
			logx.Infof("%s %s", t.Name, firing.Reason)
			if !sleepUntil(ctx, firing.Planned) {
				break
			}
			continue
		}

		outcome, reason, err := Run(ctx, db, t, firing.Planned, false)
		wake := time.Time{}
		switch outcome {
		case Ran:
			logx.Infof("%s 本轮完成（班次 %s）", t.Name, firing.Planned.Format("2006-01-02 15:04:05"))
		case Skipped:
			logx.Infof("%s 本轮跳过: %s", t.Name, reason)
			wake = time.Now().Add(MinWake)
		case Interrupted:
			logx.Infof("%s 本轮被停止信号打断", t.Name)
		case Errored:
			if err != nil {
				logx.Errorf("%s 本轮异常: %v，%v 后按下一班继续", t.Name, err, RetryDelay)
			}
			wake = time.Now().Add(RetryDelay)
		}
		if !wake.IsZero() && !sleepUntil(ctx, wake) {
			break
		}
	}
	logx.Infof("%s 调度循环退出", t.Name)
}

// sleepUntil 睡到 at；取消时返回 false，正常睡到返回 true。
func sleepUntil(ctx context.Context, at time.Time) bool {
	d := time.Until(at)
	if d > 0 {
		logx.Infof("下次执行约 %s 后", FormatDelay(d))
		t := time.NewTimer(d)
		defer t.Stop()
		select {
		case <-ctx.Done():
			return false
		case <-t.C:
		}
	}
	return ctx.Err() == nil
}

// FormatDelay 把等待时长写成人类可读的"X小时Y分钟"，和 JS 侧 formatDelay 对齐。
func FormatDelay(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	if d < time.Minute {
		return fmt.Sprintf("%d 秒", int(d.Seconds()))
	}
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	if h == 0 {
		return fmt.Sprintf("%d 分钟", m)
	}
	return fmt.Sprintf("%d 小时 %d 分钟", h, m)
}
