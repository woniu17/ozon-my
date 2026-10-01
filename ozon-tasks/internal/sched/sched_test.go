// 调度的三条硬规矩都在这里压：首班立即跑、同一班次只跑一次、跑的时候别人进不来。
// 另外盯住"停机要快"——pm2 重启时卡在 sleep 里会让新旧两个进程并存几分钟。
package sched

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ozon-tasks/internal/cronx"
	"ozon-tasks/internal/ledger"
	"ozon-tasks/internal/logx"
)

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func (s *syncBuf) contains(sub string) bool { return strings.Contains(s.String(), sub) }

func openDB(t *testing.T) *ledger.DB {
	t.Helper()
	d, err := ledger.Open(filepath.Join(t.TempDir(), "sched.db"))
	if err != nil {
		t.Fatalf("开库失败: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func capture(t *testing.T) *syncBuf {
	t.Helper()
	buf := &syncBuf{}
	logx.Redirect(buf, buf)
	t.Cleanup(func() { logx.Redirect(os.Stdout, os.Stderr) })
	return buf
}

func newTask(t *testing.T, spec string, run func(context.Context) error) Task {
	t.Helper()
	sch, err := cronx.Parse(spec)
	if err != nil {
		t.Fatalf("Parse(%q): %v", spec, err)
	}
	return Task{
		Name:     "测试任务",
		Slot:     "test_slot",
		Holder:   "nuc",
		Schedule: sch,
		Backoff:  0,
		Lease:    time.Hour,
		Run:      run,
	}
}

func noopRun(context.Context) error { return nil }

func TestDueFirstRunFiresImmediately(t *testing.T) {
	capture(t)
	d := openDB(t)
	now := time.Now()
	f := newTask(t, "0 3 * * *", noopRun).Due(d, now, false)
	if !f.Due || !f.Planned.Equal(now) {
		t.Fatalf("新部署应当场跑首班以验证配置: %+v", f)
	}
}

func TestDueParksUntilNextInstant(t *testing.T) {
	capture(t)
	d := openDB(t)
	planned := time.Now().Truncate(time.Millisecond).Add(-2 * time.Hour)
	task := newTask(t, "@every 8h", noopRun)

	if _, _, err := d.TryAcquireLease(task.Slot, task.Holder, planned, ledger.LeaseOpts{TTL: time.Minute}, planned); err != nil {
		t.Fatal(err)
	}
	if err := d.FinishLease(task.Slot, task.Holder, planned, "ok", "", ""); err != nil {
		t.Fatal(err)
	}

	f := task.Due(d, time.Now(), false)
	if f.Due {
		t.Fatalf("上一班 2 小时前刚跑完（间隔 8h），不该立即再跑: %+v", f)
	}
	if want := planned.Add(8 * time.Hour); !f.Planned.Equal(want) {
		t.Errorf("下一班 = %v，期望 %v（必须从上一班的计划时刻推进，不能从完成时间推）", f.Planned.Format(time.RFC3339), want.Format(time.RFC3339))
	}
}

func TestDueCollapsesBacklogIntoOneRun(t *testing.T) {
	capture(t)
	d := openDB(t)
	now := time.Now().Truncate(time.Millisecond)
	last := now.Add(-5*time.Hour - 30*time.Minute)
	task := newTask(t, "@every 1h", noopRun)

	if _, _, err := d.TryAcquireLease(task.Slot, task.Holder, last, ledger.LeaseOpts{TTL: time.Minute}, last); err != nil {
		t.Fatal(err)
	}
	if err := d.FinishLease(task.Slot, task.Holder, last, "ok", "", ""); err != nil {
		t.Fatal(err)
	}

	f := task.Due(d, now, false)
	if !f.Due {
		t.Fatal("停机五小时半后应当班")
	}
	// 欠了六班（last+1h…last+6h 里有五班已过），只补最近的一班 last+5h；
	// 连着补五遍会把限流配额吃干，而且第一遍的全量扫描已经覆盖后面的班次
	if want := last.Add(5 * time.Hour); !f.Planned.Equal(want) {
		t.Errorf("补班时刻 = %v，期望 %v（积压应折叠成一班）", f.Planned.Format(time.RFC3339), want.Format(time.RFC3339))
	}
}

func TestRunSkipsAlreadyExecutedInstant(t *testing.T) {
	logs := capture(t)
	d := openDB(t)
	runs := 0
	task := newTask(t, "@every 1h", func(context.Context) error { runs++; return nil })
	planned := time.Now().Add(time.Hour)

	outcome, _, err := Run(context.Background(), d, task, planned, false)
	if err != nil || outcome != Ran {
		t.Fatalf("首班应执行: %v %v", outcome, err)
	}
	outcome, reason, err := Run(context.Background(), d, task, planned, false)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != Skipped || runs != 1 {
		t.Errorf("同一班次被执行了第二次: outcome=%v runs=%d reason=%s", outcome, runs, reason)
	}

	// Force 可以重跑同一班（-run-now 的语义）
	if outcome, _, _ := Run(context.Background(), d, task, planned, true); outcome != Ran || runs != 2 {
		t.Errorf("Force 应绕过班次去重: outcome=%v runs=%d", outcome, runs)
	}

	st, _ := d.SlotStateOf(task.Slot)
	if st.Runs != 2 || st.Holder != "" {
		t.Errorf("台账审计不对: %+v", st)
	}
	_ = logs
}

func TestRunBlocksWhileAnotherHolderRuns(t *testing.T) {
	capture(t)
	d := openDB(t)
	release := make(chan struct{})
	blocked := make(chan struct{})
	task := newTask(t, "@every 1h", func(context.Context) error {
		close(blocked)
		<-release
		return nil
	})
	planned := time.Now()

	go Run(context.Background(), d, task, planned, false)
	<-blocked
	t.Cleanup(func() { close(release) })

	other := task
	other.Holder = "tencent"
	outcome, reason, err := Run(context.Background(), d, other, time.Now().Add(time.Hour), false)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != Skipped || !strings.Contains(reason, "正被 nuc 执行") {
		t.Errorf("活动租约期间必须挡住第二个执行者，且说明被谁占着: outcome=%v reason=%q", outcome, reason)
	}
}

func TestRunRecordsFailureButStillConsumesTheInstant(t *testing.T) {
	capture(t)
	d := openDB(t)
	runs := 0
	task := newTask(t, "@every 1h", func(context.Context) error { runs++; return context.DeadlineExceeded })
	planned := time.Now().Add(-time.Hour)

	outcome, _, err := Run(context.Background(), d, task, planned, false)
	if outcome != Errored || err == nil {
		t.Fatalf("执行失败应报 Errored: %v %v", outcome, err)
	}
	st, _ := d.SlotStateOf(task.Slot)
	if st.Status != "error" || st.Error == "" || st.Holder != "" {
		t.Errorf("失败也要结单入账并释放租约: %+v", st)
	}
	// 失败同样算处理过这一班：坏凭据不该每一班都重试一次，退避交给 Backoff
	if outcome, _, _ := Run(context.Background(), d, task, planned, false); outcome != Skipped || runs != 1 {
		t.Errorf("失败的那一班不该重跑: outcome=%v runs=%d", outcome, runs)
	}
}

func TestHeartbeatCancelsRunWhenLeaseLost(t *testing.T) {
	capture(t)
	d := openDB(t)
	// 租约 6 秒：心跳每 2 秒续一次。测试里把 holder 换成别人，下一跳就该取消任务上下文
	task := newTask(t, "@every 1h", func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	})
	task.Lease = 6 * time.Second
	planned := time.Now()

	type res struct {
		outcome Outcome
		err     error
	}
	done := make(chan res, 1)
	go func() {
		o, _, err := Run(context.Background(), d, task, planned, false)
		done <- res{o, err}
	}()

	// 模拟持有者失联后被接管：先放开租约，再让别的进程认领下一班
	time.Sleep(100 * time.Millisecond)
	if err := d.AbandonLease(task.Slot, task.Holder, time.Now()); err != nil {
		t.Fatal(err)
	}
	if ok, reason, err := d.TryAcquireLease(task.Slot, "tencent", planned.Add(time.Hour),
		ledger.LeaseOpts{TTL: time.Hour}, time.Now()); !ok {
		t.Fatalf("接管应成功: %s %v", reason, err)
	}

	select {
	case r := <-done:
		if r.outcome == Ran || r.err == nil {
			t.Fatalf("租约被接管后不该报告成功: %v %v", r.outcome, r.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("心跳没能在两个周期内发现租约丢失，双写护栏失效")
	}
	if st, _ := d.SlotStateOf(task.Slot); st.Holder != "tencent" {
		t.Errorf("接管方的租约不该被旧持有者清掉: %+v", st)
	}
}

func TestHeartbeatInterval(t *testing.T) {
	if got := heartbeatInterval(30 * time.Minute); got != 10*time.Minute {
		t.Errorf("30 分钟租约应每 10 分钟续一次，得到 %v", got)
	}
	if got := heartbeatInterval(time.Second); got != 2*time.Second {
		t.Errorf("过小的租约应被下限托住，得到 %v", got)
	}
}

func TestRunReleasesLeaseOnShutdown(t *testing.T) {
	capture(t)
	d := openDB(t)
	ctx, cancel := context.WithCancel(context.Background())
	task := newTask(t, "@every 1h", func(c context.Context) error {
		cancel() // 模拟收到 SIGTERM
		<-c.Done()
		return c.Err()
	})
	planned := time.Now()

	outcome, _, _ := Run(ctx, d, task, planned, false)
	if outcome != Interrupted {
		t.Fatalf("停机打断应报 Interrupted，得到 %v", outcome)
	}
	st, _ := d.SlotStateOf(task.Slot)
	if st.Holder != "" || st.Status != "interrupted" {
		t.Errorf("停机必须立刻放开租约，否则重启后要空等一个 TTL: %+v", st)
	}
	// 放开后下一班（哪怕时刻更早的补班）不用等 TTL 就能被接手
	if ok, _, _ := d.TryAcquireLease(task.Slot, "nuc", time.Now().Add(time.Hour), ledger.LeaseOpts{TTL: time.Hour}, time.Now()); !ok {
		t.Error("停机释放后应能立即重新认领")
	}
}

func TestLoopRunsOnceThenParks(t *testing.T) {
	logs := capture(t)
	d := openDB(t)
	runs := make(chan time.Time, 4)
	task := newTask(t, "0 3 * * *", func(ctx context.Context) error {
		runs <- time.Now()
		return nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { Loop(ctx, d, task); close(done) }()

	select {
	case <-runs:
	case <-time.After(3 * time.Second):
		t.Fatal("首班没有在 3 秒内执行")
	}

	// 下一班在明天 03:00，循环必须停在这儿，不能再跑第二次
	select {
	case extra := <-runs:
		t.Fatalf("第二班不该这么快就来: %v", extra)
	case <-time.After(300 * time.Millisecond):
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("取消后循环没有退出——pm2 重启会留下并存进程")
	}
	if !logs.contains("下次执行约") {
		t.Errorf("循环应当写明下一班还要等多久，日志: %s", logs)
	}
}

// fastTick 是两秒一班的人造排期。cronx 刻意拒绝亚分钟间隔（真任务跑一轮要几十分钟），
// 但循环的"到点就醒"逻辑得能用快节奏验证，所以这里直接实现接口。
type fastTick struct{ step time.Duration }

func (f fastTick) Next(after time.Time) time.Time { return after.Add(f.step) }
func (f fastTick) String() string                 { return "@every 2s(测试)" }

func TestLoopWakesForNextInstant(t *testing.T) {
	capture(t)
	d := openDB(t)
	runs := make(chan struct{}, 4)
	task := newTask(t, "@every 1h", func(context.Context) error {
		runs <- struct{}{}
		return nil
	})
	task.Schedule = fastTick{step: 2 * time.Second}

	ctx, cancel := context.WithCancel(context.Background())
	go Loop(ctx, d, task)
	defer cancel()

	for i := 0; i < 3; i++ {
		select {
		case <-runs:
		case <-time.After(6 * time.Second):
			t.Fatalf("第 %d 班没跑起来", i+1)
		}
	}
	st, _ := d.SlotStateOf(task.Slot)
	if st.Runs != 3 {
		t.Errorf("台账应记到 3 轮，实际 %d（%+v）", st.Runs, st)
	}
}

func TestFormatDelay(t *testing.T) {
	cases := map[time.Duration]string{
		45 * time.Second:            "45 秒",
		90 * time.Second:            "1 分钟",
		2*time.Hour + 5*time.Minute: "2 小时 5 分钟",
		-time.Second:                "0 秒",
	}
	for in, want := range cases {
		if got := FormatDelay(in); got != want {
			t.Errorf("FormatDelay(%v) = %q，期望 %q", in, got, want)
		}
	}
}
