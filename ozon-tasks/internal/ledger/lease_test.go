// 租约的单测盯两件事：同一个计划时刻只允许被执行一次（防重入），
// 以及正在跑的时候别人抢不走、但崩溃的持有者不会把槽位永久锁死（防并发 + 防僵死）。
// 这两条出错都不会当场报错，只会在几周后发现同一批商品被改了两遍，或任务再也不跑了。
package ledger

import (
	"errors"
	"sync"
	"testing"
	"time"

	"ozon-tasks/internal/config"
)

var base = time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)

func mustAcquire(t *testing.T, d *DB, slot, holder string, planned time.Time, opts LeaseOpts, now time.Time) {
	t.Helper()
	ok, reason, err := d.TryAcquireLease(slot, holder, planned, opts, now)
	if err != nil {
		t.Fatalf("认领租约失败: %v", err)
	}
	if !ok {
		t.Fatalf("预期能认领 %s@%v，实际被拒: %s", slot, planned.Format(time.RFC3339), reason)
	}
}

func TestLeaseFirstTimeCreatesRow(t *testing.T) {
	d := openDB(t)
	planned := base
	opts := LeaseOpts{TTL: time.Hour}
	mustAcquire(t, d, "ozonTimerUpdate", "nuc", planned, opts, base)

	st, err := d.SlotStateOf("ozonTimerUpdate")
	if err != nil {
		t.Fatal(err)
	}
	if !st.Exists || st.Holder != "nuc" || !st.PlannedAt.Equal(planned) {
		t.Fatalf("台账不对: %+v", st)
	}
	if !st.Running(base.Add(30 * time.Minute)) {
		t.Error("租约期内应视为正在执行")
	}
	if st.Running(base.Add(2 * time.Hour)) {
		t.Error("租约过期后不应仍视为正在执行")
	}
}

func TestLeaseRejectsSamePlannedInstant(t *testing.T) {
	d := openDB(t)
	planned := base
	opts := LeaseOpts{TTL: 0} // TTL 0 走默认 30 分钟；这里刻意让它过期，专测计划时刻去重
	mustAcquire(t, d, "slot", "nuc", planned, LeaseOpts{TTL: time.Nanosecond}, base)

	// 租约已过期，但同一班次的计划时刻不该再跑第二遍（pm2 重启、手工补敲 --once 都在这类场景里）
	ok, reason, err := d.TryAcquireLease("slot", "nuc", planned, opts, base.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("同一计划时刻被认领了两次，去重失效")
	}
	if reason == "" {
		t.Error("拒绝必须给出原因，否则线上无从排查")
	}

	// 下一班可以正常认领
	mustAcquire(t, d, "slot", "nuc", base.Add(8*time.Hour), opts, base.Add(8*time.Hour))
	st, _ := d.SlotStateOf("slot")
	if !st.PlannedAt.Equal(base.Add(8 * time.Hour)) {
		t.Errorf("planned_at 未推进: %v", st.PlannedAt)
	}
}

func TestLeaseBlocksActiveHolder(t *testing.T) {
	d := openDB(t)
	opts := LeaseOpts{TTL: time.Hour}
	mustAcquire(t, d, "slot", "nuc", base, opts, base)

	ok, reason, err := d.TryAcquireLease("slot", "tencent", base.Add(time.Hour), opts, base.Add(time.Minute))
	if err != nil || ok {
		t.Fatalf("活动租约期间不该被别的持有者抢走: ok=%v err=%v", ok, err)
	}
	if reason == "" {
		t.Error("拒绝必须说明被谁占着")
	}

	// 同一个持有者也不能自我套娃
	if ok, _, _ := d.TryAcquireLease("slot", "nuc", base.Add(time.Hour), opts, base.Add(time.Minute)); ok {
		t.Error("同一持有者重复认领应被拒绝")
	}

	// Force 也不能越过活动租约：两个执行者同时改价格比少跑一轮严重得多
	if ok, _, _ := d.TryAcquireLease("slot", "tencent", base, LeaseOpts{TTL: time.Hour, Force: true}, base.Add(time.Minute)); ok {
		t.Error("Force 越过了活动租约")
	}

	// 租约到期后可被接管
	if ok, _, _ := d.TryAcquireLease("slot", "tencent", base.Add(2*time.Hour), LeaseOpts{TTL: time.Hour}, base.Add(3*time.Hour)); !ok {
		t.Error("租约过期后应允许接管，崩溃的持有者不能把槽位锁死")
	}
}

func TestLeaseFailureBackoffOnlyAfterBadRun(t *testing.T) {
	d := openDB(t)
	opts := LeaseOpts{TTL: time.Minute, MinInterval: 30 * time.Minute}
	mustAcquire(t, d, "slot", "nuc", base, opts, base)

	// 上一轮失败：下一班即使时刻更新，也要等满退避间距，否则坏凭据会被每分钟重试一次
	if err := d.FinishLease("slot", "nuc", base.Add(time.Minute), "error", "", "Ozon 403"); err != nil {
		t.Fatal(err)
	}
	if ok, _, _ := d.TryAcquireLease("slot", "nuc", base.Add(2*time.Minute), opts, base.Add(2*time.Minute)); ok {
		t.Fatal("失败后不足退避间距仍被放行")
	}
	mustAcquire(t, d, "slot", "nuc", base.Add(time.Hour), opts, base.Add(time.Hour))

	// 成功过之后，退避间距不再卡排期：每 2 小时就是每 2 小时
	if err := d.FinishLease("slot", "nuc", base.Add(time.Hour), "ok", "全部成功", ""); err != nil {
		t.Fatal(err)
	}
	mustAcquire(t, d, "slot", "nuc", base.Add(2*time.Hour), LeaseOpts{TTL: time.Minute, MinInterval: 8 * time.Hour}, base.Add(2*time.Hour))

	// Force 忽略退避间距，但依然不越过活动租约（上面已测）
	mustAcquire(t, d, "slot", "nuc", base.Add(2*time.Hour), LeaseOpts{TTL: time.Minute, MinInterval: 8 * time.Hour, Force: true}, base.Add(2*time.Hour+time.Second))
}

func TestRenewLease(t *testing.T) {
	d := openDB(t)
	mustAcquire(t, d, "slot", "nuc", base, LeaseOpts{TTL: time.Minute}, base)

	if ok, err := d.RenewLease("slot", "nuc", time.Minute, base.Add(30*time.Second)); err != nil || !ok {
		t.Fatalf("持有者续租应成功: ok=%v err=%v", ok, err)
	}
	if ok, err := d.RenewLease("slot", "other", time.Minute, base.Add(40*time.Second)); err != nil || ok {
		t.Fatalf("非持有者续租应失败: ok=%v err=%v", ok, err)
	}
	// 续租后原到期时间被推后，接管要等到新到期时间
	if ok, _, _ := d.TryAcquireLease("slot", "other", base.Add(time.Hour), LeaseOpts{TTL: time.Minute}, base.Add(70*time.Second)); ok {
		t.Error("续租后租约应仍未到期")
	}
	if ok, err := d.RenewLease("slot", "nuc", time.Minute, base.Add(90*time.Minute)); err != nil || ok {
		t.Errorf("已过期租约的续租必须报告丢失: ok=%v err=%v", ok, err)
	}
	// 结单之后租约就不存在了，续租同样要报告丢失
	if err := d.FinishLease("slot", "nuc", base.Add(91*time.Minute), "ok", "", ""); err != nil {
		t.Fatal(err)
	}
	if ok, err := d.RenewLease("slot", "nuc", time.Minute, base.Add(92*time.Minute)); err != nil || ok {
		t.Errorf("结单后续租必须报告丢失: ok=%v err=%v", ok, err)
	}
}

func TestFinishLeaseReleasesAndAudits(t *testing.T) {
	d := openDB(t)
	mustAcquire(t, d, "slot", "nuc", base, LeaseOpts{TTL: time.Hour}, base)

	if err := d.FinishLease("slot", "wrong", base, "ok", "", ""); !errors.Is(err, ErrLeaseLost) {
		t.Errorf("非持有者结单应报租约丢失，得到 %v", err)
	}
	if err := d.FinishLease("slot", "nuc", base.Add(2*time.Minute), "error", "3 个成功", "Ozon 503"); err != nil {
		t.Fatal(err)
	}

	st, _ := d.SlotStateOf("slot")
	if st.Holder != "" || st.Running(base) {
		t.Error("结单后必须释放租约，否则下一班要空等 TTL")
	}
	if st.Status != "error" || st.Detail != "3 个成功" || st.Error != "Ozon 503" || st.Runs != 1 {
		t.Errorf("审计字段不对: %+v", st)
	}
	// 失败也算处理过这一班次：不该在下一分钟重试到天涯海角
	if ok, _, _ := d.TryAcquireLease("slot", "nuc", base, LeaseOpts{TTL: time.Hour}, base.Add(time.Minute)); ok {
		t.Error("失败的那一班不该被重跑")
	}
}

func TestAbandonLeaseOnShutdown(t *testing.T) {
	d := openDB(t)
	mustAcquire(t, d, "slot", "nuc", base, LeaseOpts{TTL: time.Hour}, base)
	if err := d.AbandonLease("slot", "nuc", base.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	st, _ := d.SlotStateOf("slot")
	if st.Holder != "" || st.Status != "interrupted" {
		t.Errorf("停机后应标记 interrupted 并放人: %+v", st)
	}
	// 不用等一小时 TTL 就能被下一班（或换机）接手
	mustAcquire(t, d, "slot", "other", base.Add(2*time.Hour), LeaseOpts{TTL: time.Hour}, base.Add(2*time.Minute))
}

func TestSlotStateMissingIsNotError(t *testing.T) {
	d := openDB(t)
	st, err := d.SlotStateOf("从未跑过")
	if err != nil {
		t.Fatalf("查不到槽位不该报错: %v", err)
	}
	if st.Exists || !st.PlannedAt.IsZero() {
		t.Errorf("空槽位应是 Exists=false: %+v", st)
	}
}

// 同一班次只允许一个赢家。SQLite 的连接限死 1，写串行化后靠 planned_at 去重，
// 这正是"多进程同时活着也不重复跑"的地基，所以用真并发压一遍。
func TestConcurrentAcquireSingleWinner(t *testing.T) {
	d := openDB(t)
	const n = 24
	var wg sync.WaitGroup
	wins := make(chan string, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			holder := string(rune('a' + i))
			ok, _, err := d.TryAcquireLease("hot", holder, base, LeaseOpts{TTL: time.Hour}, base)
			if err != nil {
				t.Errorf("并发认领报错: %v", err)
				return
			}
			if ok {
				wins <- holder
			}
		}(i)
	}
	wg.Wait()
	close(wins)
	var got []string
	for h := range wins {
		got = append(got, h)
	}
	if len(got) != 1 {
		t.Fatalf("同一班次应有且只有一个赢家，实际 %d 个: %v", len(got), got)
	}
}

func TestAllSlotStates(t *testing.T) {
	d := openDB(t)
	mustAcquire(t, d, "b-slot", "nuc", base, LeaseOpts{TTL: time.Hour}, base)
	mustAcquire(t, d, "a-slot", "nuc", base, LeaseOpts{TTL: time.Hour}, base)

	all, err := d.AllSlotStates()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].Slot != "a-slot" || all[1].Slot != "b-slot" {
		t.Fatalf("应排序返回两个槽位: %+v", all)
	}
}

func TestLedgerSummary(t *testing.T) {
	d := openDB(t)
	shopB := config.Shop{Name: "YQL02", ClientID: "888", APIKey: "k"}
	if _, err := d.UpsertPrices(shop, []PriceRecord{
		{ProductID: 1, MinPriceStatus: "set", MinPriceSetAt: base.UnixMilli()},
		{ProductID: 2, MinPriceStatus: "skipped"},
		{ProductID: 3, MinPriceStatus: "failed"},
	}, base); err != nil {
		t.Fatal(err)
	}
	if _, err := d.UpsertPrices(shopB, []PriceRecord{
		{ProductID: 4, MinPriceStatus: "not_applicable"},
	}, base.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	got, err := d.LedgerSummary()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("应有两家店: %+v", got)
	}
	a, b := got[0], got[1]
	if a.ShopName != "YQL01" || a.Rows != 3 || a.Set != 1 || a.Skipped != 1 || a.Failed != 1 {
		t.Errorf("YQL01 汇总不对: %+v", a)
	}
	if a.LatestSetAt.IsZero() || !a.LatestSetAt.Equal(base) {
		t.Errorf("YQL01 最近设置时刻 = %v，期望 %v", a.LatestSetAt, base)
	}
	if b.ShopName != "YQL02" || b.Rows != 1 || b.NotApplicable != 1 {
		t.Errorf("YQL02 汇总不对: %+v", b)
	}
	if !b.LatestSetAt.IsZero() {
		t.Errorf("YQL02 从未设置过最低价，LatestSetAt 应为空: %v", b.LatestSetAt)
	}
}
