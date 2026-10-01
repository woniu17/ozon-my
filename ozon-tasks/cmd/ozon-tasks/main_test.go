// CLI 装配的测试：这里盯的都是"配错时的行为"，而不是 happy path。
// 子命令展开、排期回退、选项作用域这三件事一旦错了，表现是"任务看起来在跑其实没跑"
// 或者"以为在演练其实真在写"，都只有靠断言才防得住。
package main

import (
	"errors"
	"flag"
	"io"
	"strings"
	"testing"
	"time"

	"ozon-tasks/internal/config"
	"ozon-tasks/internal/task"
)

func testConfig() *config.Config {
	return &config.Config{
		MachineName:        "test-machine",
		Shops:              []config.Shop{{Name: "A", ClientID: "1", APIKey: "k"}, {Name: "B", ClientID: "2", APIKey: "k"}},
		TimerCooldown:      8 * time.Hour,
		DeactivateCooldown: time.Hour,
		LeaseTTL:           30 * time.Minute,
		RetryBackoff:       10 * time.Minute,
		TimerGroups: []config.Group{
			{Name: "夜间", ShopNames: []string{"A"}, Schedule: "30 4 * * *"},
			{Name: "跟全局", ShopNames: []string{"B"}},
		},
	}
}

func deps() *task.Deps { return &task.Deps{Machine: "test-machine", Holder: "test-machine"} }

func TestScheduleFallbackOrderInUnits(t *testing.T) {
	cfg := testConfig()
	cfg.TimerSchedule = "@daily"

	units, err := buildUnits(cfg, deps(), options{task: "all"})
	if err != nil {
		t.Fatalf("展开失败: %v", err)
	}
	// 两个定时器分组 + 移除任务无分组时回退成"全部店铺"一组
	if len(units) != 3 {
		t.Fatalf("调度单元 %d 个，期望 3: %v", len(units), labels(units))
	}
	if got, want := units[0].task.Slot, "ozon_timer_update_夜间"; got != want {
		t.Errorf("分组槽位 = %q，期望 %q（槽名与 JS 侧一致，排查手册才通用）", got, want)
	}
	if got := units[0].task.Schedule.String(); got != "30 4 * * *" {
		t.Errorf("分组自带排期被覆盖: %q", got)
	}
	if got := units[1].task.Schedule.String(); got != "@daily" {
		t.Errorf("分组没写排期时应回退全局排期，实际 %q", got)
	}
	if got := units[2].task.Schedule.String(); got != "@every 1h0m0s" {
		t.Errorf("移除任务没配排期应退回冷却期节拍，实际 %q", got)
	}
	for _, u := range units {
		if u.task.Holder != "test-machine" {
			t.Errorf("%s 没带持有者，租约会记成空持有人: %+v", u.task.Name, u.task)
		}
		if u.task.Lease != cfg.LeaseTTL || u.task.Backoff != cfg.RetryBackoff {
			t.Errorf("%s 租约/退避没传下去: lease=%v backoff=%v", u.task.Name, u.task.Lease, u.task.Backoff)
		}
	}
}

func TestUnitsRejectBadSchedule(t *testing.T) {
	cfg := testConfig()
	cfg.TimerGroups = []config.Group{{Name: "坏排期", ShopNames: []string{"A"}, Schedule: "每天四点"}}
	if _, err := buildUnits(cfg, deps(), options{task: "all"}); err == nil {
		t.Error("config.Load 之外还有人能塞进非法排期，展开时必须再拦一次")
	}
}

func TestShopFlagOverridesGroups(t *testing.T) {
	cfg := testConfig()

	// -shop 只该限定"哪些店"，绝不能顺手把"哪个任务"也定死。
	// 曾经的写法是 -shop 分支直接返回定时器单元，于是
	// `once -task deactivate -shop A` 会绕过用户点名的任务去改价。
	for _, tc := range []struct{ task, want string }{
		{"timer", "ozon_timer_update"},
		{"deactivate", "ozon_action_deactivate"},
		{"all", "ozon_timer_update ozon_action_deactivate"},
	} {
		units, err := buildUnits(cfg, deps(), options{task: tc.task, shops: "A"})
		if err != nil {
			t.Fatalf("-task %s 展开失败: %v", tc.task, err)
		}
		if len(units) != strings.Count(tc.want, " ")+1 {
			t.Fatalf("-task %s 单元数 %d，期望 %q", tc.task, len(units), tc.want)
		}
		if got := strings.Join(slotList(units), " "); got != tc.want {
			t.Errorf("-task %s 槽位 = %q，期望 %q", tc.task, got, tc.want)
		}
		for _, u := range units {
			if !strings.HasSuffix(u.task.Name, "/手工指定") {
				t.Errorf("-shop 时单元名应标出手工指定范围: %s", u.task.Name)
			}
		}
	}

	if _, err := buildUnits(cfg, deps(), options{task: "定时器", shops: "A"}); err == nil {
		t.Error("-task 认不出来的值必须报错，静默当成 all 会跑出范围外的写操作")
	}
	if _, err := buildUnits(cfg, deps(), options{task: "all", shops: "A", group: "夜间"}); err == nil {
		t.Error("-shop 与 -group 同时给应报错，否则执行范围取决于解析顺序")
	}
	if _, err := buildUnits(cfg, deps(), options{task: "all", shops: "不存在的店"}); err == nil {
		t.Error("未知店铺名应报错并列出可用店铺")
	}
	if _, err := buildUnits(cfg, deps(), options{task: "all", group: "没这个组"}); err == nil {
		t.Error("-group 指向不存在的分组应报错，静默跑全部店铺太危险")
	}
}

func slotList(units []unit) []string {
	out := make([]string, 0, len(units))
	for _, u := range units {
		out = append(out, u.task.Slot)
	}
	return out
}

func TestStatusShopsScoping(t *testing.T) {
	cfg := testConfig()
	// status 默认查全部店铺；-group 要能在两类分组里找到同名组
	all, err := statusShops(cfg, options{})
	if err != nil || len(all) != 2 {
		t.Fatalf("默认应巡检全部店铺: %v %v", all, err)
	}
	cfg.DeactivateGroups = []config.Group{{Name: "移除组", ShopNames: []string{"A"}}}
	if _, err := statusShops(cfg, options{group: "没这个组"}); err == nil {
		t.Error("两类分组里都没有这个组名时应报错，否则会以为自己在巡检某个分组其实巡检了全部")
	}
	got, err := statusShops(cfg, options{group: "移除组"})
	if err != nil {
		t.Fatalf("分组巡检失败: %v", err)
	}
	if len(got) != 1 || got[0].Name != "A" {
		t.Errorf("分组展开不对: %+v", got)
	}
	if _, err := statusShops(cfg, options{shops: "A", group: "移除组"}); err == nil {
		t.Error("-shop 与 -group 互斥")
	}
}

func TestFlagsAreScopedToSubcommand(t *testing.T) {
	// 每个子命令只认自己那几个选项。run 认 -force 的话，常驻进程会每班都绕过到班判定。
	cases := []struct {
		cmd     string
		flag    string
		wantErr bool
	}{
		{"run", "-dry-run", false},
		{"run", "-force", true},
		{"once", "-force", false},
		{"once", "-remote", true},
		{"check", "-dry-run", true},
		{"status", "-dry-run", true},
		{"status", "-remote", false},
		{"run", "-dryrun", true}, // 打错的选项绝不能被静默忽略
	}
	for _, tc := range cases {
		var o options
		fs := flagsFor(tc.cmd, &o)
		fs.SetOutput(io.Discard)
		err := fs.Parse([]string{tc.flag})
		if tc.wantErr && err == nil {
			t.Errorf("%s 竟然接受 %s", tc.cmd, tc.flag)
		}
		if !tc.wantErr && err != nil && !errors.Is(err, flag.ErrHelp) {
			t.Errorf("%s 不该拒绝 %s: %v", tc.cmd, tc.flag, err)
		}
	}
}

func TestEnvFlagMustBeExplicitToBeHardError(t *testing.T) {
	// -env 指了路径却读不到 = 硬错误；默认路径没这个文件 = 退回进程环境变量
	var o options
	fs := flagsFor("check", &o)
	fs.SetOutput(io.Discard)
	if err := fs.Parse([]string{"-env", "/definitely/not/here/.env"}); err != nil {
		t.Fatal(err)
	}
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "env" {
			o.envSet = true
		}
	})
	if !o.envSet {
		t.Fatal("Visit 必须在 Parse 之后才认得出命令行里出现过 -env")
	}
	if _, err := loadConfig(o); err == nil {
		t.Error("显式指定的配置文件读不到必须报错，否则等于拿着空配置去跑生产")
	}
}

func TestFmtTime(t *testing.T) {
	if got := fmtTime(time.Time{}); got != "-" {
		t.Errorf("零值时间应打成 -，实际 %q", got)
	}
	want := "2026-10-01 12:30:00"
	if got := fmtTime(time.Date(2026, 10, 1, 12, 30, 0, 0, time.Local)); got != want {
		t.Errorf("时间格式 = %q，期望 %q（飞书文案与 JS 侧 dayjs 对齐）", got, want)
	}
}

func labels(units []unit) []string {
	out := make([]string, 0, len(units))
	for _, u := range units {
		out = append(out, u.task.Name)
	}
	return out
}

// 演练开关必须真的走到客户端那一侧：地址没透传的话，"假服务演练"其实打在真实店铺上。
// Deps.BaseURL → ozon.Client 那一段由各 task 测试用 httptest 覆盖，这里只补配置到 Deps 这一环。
func TestRehearsalBaseURLReachesDeps(t *testing.T) {
	t.Setenv("OZON_SHOPS", "A:1:k")
	t.Setenv("OZON_API_BASE_URL", "http://127.0.0.1:9555")

	cfg, err := loadConfig(options{task: "all"})
	if err != nil {
		t.Fatalf("loadConfig 报错: %v", err)
	}
	if cfg.APIBaseURL != "http://127.0.0.1:9555" {
		t.Fatalf("配置没读到演练地址: %q", cfg.APIBaseURL)
	}
	if got := newDeps(cfg, options{}).BaseURL; got != cfg.APIBaseURL {
		t.Errorf("Deps.BaseURL 没透传: %q", got)
	}
}
