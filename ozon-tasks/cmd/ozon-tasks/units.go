package main

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"ozon-tasks/internal/config"
	"ozon-tasks/internal/cronx"
	"ozon-tasks/internal/logx"
	"ozon-tasks/internal/sched"
	"ozon-tasks/internal/task"
)

// 槽名与 JS 侧保持一致（ozon_timer_update / ozon_action_deactivate，分组加 _组名 后缀）。
// 两边冷却状态各存各的库，不会因为重名互相干扰；重名的收益是日志和排查手册可以通用。
const (
	timerSlot      = "ozon_timer_update"
	deactivateSlot = "ozon_action_deactivate"
)

type unit struct {
	label string
	task  sched.Task
}

// taskRunner 是一个调度单元这一轮的活。给它整个分组，因为它同时要店铺和 webhook。
type taskRunner func(context.Context, *task.Deps, config.ResolvedGroup) error

// taskSpec 是一个任务在展开调度单元时要的全部信息。把两个任务摆成一张表，
// 是为了让 -shop/-group 这类范围选项只写一遍判断——写在两条分支里迟早会漏掉一条
// （曾经就漏了：-shop 分支只认定时器，于是 `-task deactivate -shop X` 真去改了价）。
type taskSpec struct {
	pick   bool // 这一任务本次要不要展开
	label  string
	slot   string
	groups []config.Group
	fb     config.GroupFallback
	runner taskRunner
}

// buildUnits 把配置展开成调度单元。展开顺序与 JS 的 start*Task 一致：
// 指定店铺 > 分组配置 > 全部店铺单组。
func buildUnits(cfg *config.Config, d *task.Deps, o options) ([]unit, error) {
	wantTimer := o.task == "all" || o.task == "timer"
	wantDeact := o.task == "all" || o.task == "deactivate"
	if !wantTimer && !wantDeact {
		return nil, fmt.Errorf("-task 只接受 all|timer|deactivate，当前 %q", o.task)
	}
	if o.shops != "" && o.group != "" {
		return nil, fmt.Errorf("-shop 与 -group 不能同时使用")
	}

	// -shop 用于"就先拿这一家试试"，这时不该顺带碰其他店
	var manualShops []config.Shop
	if o.shops != "" {
		var err error
		if manualShops, err = pickShops(cfg, strings.Split(o.shops, ",")); err != nil {
			return nil, err
		}
	}

	specs := []taskSpec{
		{wantTimer, "定时器", timerSlot, cfg.TimerGroups, timerFallback(cfg), runTimerUnits},
		{wantDeact, "活动移除", deactivateSlot, cfg.DeactivateGroups, deactivateFallback(cfg), runDeactivateUnits},
	}

	var out []unit
	for _, s := range specs {
		if !s.pick {
			continue
		}
		groups := []config.ResolvedGroup(nil)
		if o.shops != "" {
			fb := s.fb
			groups = []config.ResolvedGroup{{
				Name:          "手工指定",
				Shops:         manualShops,
				Cooldown:      fb.Cooldown,
				Schedule:      config.ScheduleSpec("", fb.Schedule, fb.Cooldown),
				FeishuWebhook: fb.Webhook,
			}}
		} else {
			var err error
			if groups, err = selectGroups(cfg, s.groups, s.fb, o.group, s.label); err != nil {
				return nil, err
			}
		}
		u, err := build(cfg, d, groups, s.slot, s.label, s.runner)
		if err != nil {
			return nil, err
		}
		out = append(out, u...)
	}
	return out, nil
}

func timerFallback(cfg *config.Config) config.GroupFallback {
	return config.GroupFallback{
		Schedule: cfg.TimerSchedule,
		Cooldown: cfg.TimerCooldown,
		Webhook:  cfg.OzonFeishuWebhook,
	}
}

func deactivateFallback(cfg *config.Config) config.GroupFallback {
	return config.GroupFallback{
		Schedule: cfg.DeactivateSchedule,
		Cooldown: cfg.DeactivateCooldown,
		Webhook:  cfg.OzonFeishuWebhook,
	}
}

func runTimerUnits(ctx context.Context, d *task.Deps, g config.ResolvedGroup) error {
	_, err := task.RunTimerUpdate(ctx, d, g.Shops, g.FeishuWebhook)
	return err
}

func runDeactivateUnits(ctx context.Context, d *task.Deps, g config.ResolvedGroup) error {
	_, err := task.RunActionDeactivate(ctx, d, g.Shops, g.FeishuWebhook)
	return err
}

// selectGroups 有分组用分组，没分组回退成"全部店铺一组"；-group 指定了组名就必须存在。
func selectGroups(cfg *config.Config, groups []config.Group, fb config.GroupFallback, only, label string) ([]config.ResolvedGroup, error) {
	if len(groups) > 0 {
		resolved, warns := cfg.ResolveGroups(groups, fb)
		for _, w := range warns {
			logx.Errorf("[%s] 分组配置有问题: %s", label, w)
		}
		if only != "" {
			var filtered []config.ResolvedGroup
			for _, g := range resolved {
				if g.Name == only {
					filtered = append(filtered, g)
				}
			}
			if len(filtered) == 0 {
				names := make([]string, 0, len(resolved))
				for _, g := range resolved {
					names = append(names, g.Name)
				}
				return nil, fmt.Errorf("%s 任务没有名为 %q 的分组，可用: %s", label, only, strings.Join(names, ", "))
			}
			resolved = filtered
		}
		if len(resolved) == 0 {
			return nil, fmt.Errorf("%s 任务的分组全部校验失败，拒绝执行（宁可不动，也不要按半截配置去改店铺）", label)
		}
		logx.Infof("[%s] 检测到 %d 个分组配置，校验通过 %d 个", label, len(groups), len(resolved))
		return resolved, nil
	}

	if only != "" {
		return nil, fmt.Errorf("%s 任务没有配置任何分组，-group %q 无处可查（先在 .env 里配分组，或去掉 -group 跑全部店铺）", label, only)
	}
	if len(cfg.Shops) == 0 {
		return nil, fmt.Errorf("%s 任务：既没有分组配置也没有任何店铺（OZON_SHOPS 为空）", label)
	}
	logx.Infof("[%s] 未配置分组，使用单组模式（处理全部 %d 家店铺）", label, len(cfg.Shops))
	return []config.ResolvedGroup{{
		Name:          "全部店铺",
		Shops:         cfg.Shops,
		Cooldown:      fb.Cooldown,
		Schedule:      config.ScheduleSpec("", fb.Schedule, fb.Cooldown),
		FeishuWebhook: fb.Webhook,
	}}, nil
}

func pickShops(cfg *config.Config, names []string) ([]config.Shop, error) {
	var out []config.Shop
	var unknown []string
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		s, ok := cfg.GetShop(name)
		if !ok {
			unknown = append(unknown, name)
			continue
		}
		out = append(out, s)
	}
	if len(unknown) > 0 {
		known := make([]string, 0, len(cfg.Shops))
		for _, s := range cfg.Shops {
			known = append(known, s.Name)
		}
		sort.Strings(known)
		return nil, fmt.Errorf("店铺 %s 未在 OZON_SHOPS 中定义，可用: %s", strings.Join(unknown, ", "), strings.Join(known, ", "))
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("-shop 没有解析出任何店铺")
	}
	return out, nil
}

func build(cfg *config.Config, d *task.Deps, groups []config.ResolvedGroup, baseSlot, label string,
	runner taskRunner) ([]unit, error) {

	out := make([]unit, 0, len(groups))
	for _, g := range groups {
		shopNames := make([]string, 0, len(g.Shops))
		for _, s := range g.Shops {
			shopNames = append(shopNames, s.Name)
		}
		slot := baseSlot
		if g.Name != "全部店铺" && g.Name != "手工指定" {
			slot = baseSlot + "_" + g.Name
		}
		// config.Load 已经校验过表达式，这里解析失败只可能是有人绕过 Load 直接调进来
		schedule, err := cronx.Parse(g.Schedule)
		if err != nil {
			return nil, fmt.Errorf("%s 分组 %s 的排期 %q 解析失败: %w", label, g.Name, g.Schedule, err)
		}
		group := g
		out = append(out, unit{
			label: fmt.Sprintf("[%s] %s 排期=%s 店铺=%d slot=%s",
				label, g.Name, cronx.Describe(schedule), len(g.Shops), slot),
			task: sched.Task{
				Name:     label + "/" + g.Name,
				Slot:     slot,
				Holder:   d.Holder,
				Schedule: schedule,
				Backoff:  cfg.RetryBackoff,
				Lease:    cfg.LeaseTTL,
				Run: func(ctx context.Context) error {
					logx.Infof("%s 开始执行（店铺: %s）", label+"/"+group.Name, strings.Join(shopNames, ","))
					return runner(ctx, d, group)
				},
			},
		})
	}
	return out, nil
}

func printConfig(cfg *config.Config, o options) error {
	fmt.Printf("machine        : %s\n", cfg.MachineName)
	fmt.Printf("db             : %s\n", cfg.DBPath)
	fmt.Printf("api timeout    : %v, retries=%d\n", cfg.APITimeout, cfg.HTTPRetries)
	apiBase := ""
	if cfg.APIBaseURL != config.DefaultAPIBaseURL {
		apiBase = "  ⚠️ 非官方地址：演练模式，请求不会到达 Ozon"
	}
	fmt.Printf("api base url   : %s%s\n", cfg.APIBaseURL, apiBase)
	fmt.Printf("并发/限速       : 跨店 %d 家并行，每店 %.2f req/s（突发 %d）\n",
		cfg.TaskConcurrency, cfg.APIRPS, cfg.APIBurst)
	fmt.Printf("租约/失败退避   : %v / %v\n", cfg.LeaseTTL, cfg.RetryBackoff)
	fmt.Printf("feishu webhook : %s\n", maskedURL(cfg.OzonFeishuWebhook))
	fmt.Printf("shops          : %d 家\n", len(cfg.Shops))
	for _, s := range cfg.Shops {
		fmt.Printf("  - %-14s client=%s key=%s\n", s.Name, s.ClientID, config.MaskKey(s.APIKey))
	}
	printGroups := func(label string, groups []config.Group, fb config.GroupFallback) {
		fmt.Printf("%-15s: %d 组（全局排期=%s，全局冷却=%v）\n", label, len(groups),
			orDash(fb.Schedule), fb.Cooldown)
		for _, g := range groups {
			cd := g.Cooldown
			if cd <= 0 {
				cd = fb.Cooldown
			}
			webhook := "(回退全局)"
			if g.FeishuWebhook != "" {
				webhook = maskedURL(g.FeishuWebhook)
			}
			fmt.Printf("  - %-10s 排期=%-14s cooldown=%-8v shops=%s webhook=%s\n",
				g.Name, orDash(config.ScheduleSpec(g.Schedule, fb.Schedule, cd)), cd,
				strings.Join(g.ShopNames, ","), maskedURL(webhook))
		}
	}
	printGroups("timer groups", cfg.TimerGroups, timerFallback(cfg))
	printGroups("deact groups", cfg.DeactivateGroups, deactivateFallback(cfg))

	units, err := buildUnits(cfg, &task.Deps{Machine: cfg.MachineName, Holder: cfg.MachineName}, o)
	if err != nil {
		return fmt.Errorf("调度单元展开失败: %w", err)
	}
	fmt.Printf("\n调度单元        : %d 个\n", len(units))
	for _, u := range units {
		fmt.Printf("  - %s\n", u.label)
	}
	return nil
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// maskedURL webhook 末段就是密钥，只露前 12 字符够定位是哪台机器人了。
// 按字符而不是按字节截：中文标签和 URL 走同一个函数，切在多字节中间会打出乱码。
func maskedURL(u string) string {
	r := []rune(u)
	if len(r) == 0 {
		return "(未配置)"
	}
	if len(r) <= 12 {
		return "***"
	}
	return string(r[:12]) + "…"
}

func drySuffix(dryRun bool) string {
	if dryRun {
		return "（影子模式：只读不写）"
	}
	return ""
}
