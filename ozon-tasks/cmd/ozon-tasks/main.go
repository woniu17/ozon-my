// Command ozon-tasks 把两件事从 Node 侧接管过来：
//
//	① 商品定时器续期 + 最低价钉死（Ozon 要求周期性刷新，掉档就失去自动调价资格）
//	② 官方促销活动商品自动撤下（不想被活动价拖着走）
//
// 用法：
//
//	ozon-tasks run                        常驻，按排期自驱动（默认子命令）
//	ozon-tasks once                       只跑一班就退出（到班判定 + 租约去重照常生效）
//	ozon-tasks once -force                无视到班判定立即跑一班（ systemd timer / 手工补班 ）
//	ozon-tasks check                      打印解析后的配置与调度单元，不碰接口也不建库
//	ozon-tasks status                     读台账打印排期、租约、游标与价格统计，零接口调用
//	ozon-tasks status -remote             额外向 Ozon 只读查询各店定时器状态
//	ozon-tasks version
//
// 两个任务共用一组选项：-task all|timer|deactivate、-group 组名、-shop 店名列表，
// 写操作闸是 -dry-run（影子模式）。
//
// 部署约束：一台机器管全部店铺。租约去重靠 SQLite，而 SQLite 的文件锁只在同一个文件系统内有效——
// 两台机器各存一份库等于没有去重。要扩就按分组把店铺拆到不同机器上。
//
// 配置沿用 httpsrv 那份 .env（同一份文件、同一套字段名），切换期两边可以并存；
// 但冷却/排期状态各存各的（Mongo vs SQLite），同一时刻只应该有一侧在真正执行写操作。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"ozon-tasks/internal/config"
	"ozon-tasks/internal/cronx"
	"ozon-tasks/internal/feishu"
	"ozon-tasks/internal/ledger"
	"ozon-tasks/internal/logx"
	"ozon-tasks/internal/sched"
	"ozon-tasks/internal/task"
)

const version = "0.2.0"

type options struct {
	envPath string
	envSet  bool
	dbPath  string
	task    string
	group   string
	shops   string
	dryRun  bool
	force   bool
	remote  bool
}

// flagsFor 只给当前子命令注册它认得的选项。
// 认不出来的参数直接失败：把 -dry-run 打错成 -dryrun 之后静默忽略，等于以为在演练其实真在写。
func flagsFor(cmd string, o *options) *flag.FlagSet {
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.Usage = func() { usageFor(cmd, fs.Output()) }
	fs.StringVar(&o.envPath, "env", ".env", "配置文件路径（沿用 httpsrv 的 .env 方言）")
	fs.StringVar(&o.dbPath, "db", "", "SQLite 路径，覆盖 .env 里的 OZON_DB_PATH")

	switch cmd {
	case "run", "once", "check", "status":
		fs.StringVar(&o.task, "task", "all", "执行哪个任务: timer | deactivate | all")
		fs.StringVar(&o.group, "group", "", "只跑指定分组名")
		fs.StringVar(&o.shops, "shop", "", "只跑这些店铺（逗号分隔），与 -group 互斥")
	}
	switch cmd {
	case "run", "once":
		fs.BoolVar(&o.dryRun, "dry-run", false, "影子模式：照常查询和统计，但不提交任何写操作")
	}
	switch cmd {
	case "once":
		fs.BoolVar(&o.force, "force", false, "无视到班判定立即执行一班（仍不越过正在执行的租约）")
	case "status":
		fs.BoolVar(&o.remote, "remote", false, "额外调用 Ozon 只读接口查各店定时器状态")
	}
	return fs
}

func main() {
	args := os.Args[1:]
	cmd := "run"
	if len(args) > 0 {
		switch first := args[0]; {
		case first == "help" || first == "-h" || first == "--help":
			usage(os.Stdout)
			return
		case first == "version" || first == "-version" || first == "--version":
			fmt.Printf("ozon-tasks %s\n", version)
			return
		case strings.HasPrefix(first, "-"):
			fmt.Fprintf(os.Stderr, "ozon-tasks 现在用子命令，%q 不是子命令。\n\n", first)
			usage(os.Stderr)
			os.Exit(2)
		default:
			cmd, args = first, args[1:]
		}
	}
	switch cmd {
	case "run", "once", "check", "status", "version":
	default:
		fmt.Fprintf(os.Stderr, "未知子命令 %q。\n\n", cmd)
		usage(os.Stderr)
		os.Exit(2)
	}

	var o options
	fs := flagsFor(cmd, &o)
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		os.Exit(2)
	}
	// 必须在 Parse 之后看：Visit 只报告命令行上真正出现过的选项
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "env" {
			o.envSet = true
		}
	})

	if err := dispatch(cmd, o); err != nil {
		logx.Errorf("退出: %v", err)
		os.Exit(1)
	}
}

func dispatch(cmd string, o options) error {
	switch cmd {
	case "run":
		return cmdRun(o)
	case "once":
		return cmdOnce(o)
	case "check":
		return cmdCheck(o)
	case "status":
		return cmdStatus(o)
	case "version":
		fmt.Printf("ozon-tasks %s\n", version)
		return nil
	}
	return fmt.Errorf("未知子命令 %q", cmd)
}

// ---------- 启动装配 ----------

func loadConfig(o options) (*config.Config, error) {
	envPath := o.envPath
	if envPath == "" {
		envPath = ".env"
	}
	// 默认路径下没这个文件就退回纯进程环境变量（容器里常这么注入）；
	// 但 -env 显式指了路径还读不到，必须是硬错误。
	if _, err := os.Stat(envPath); err != nil {
		if o.envSet {
			return nil, fmt.Errorf("读取配置失败: %w", err)
		}
		logx.Infof("未找到配置文件 %s，改用进程环境变量", envPath)
		envPath = ""
	}
	cfg, err := config.Load(envPath)
	if err != nil {
		return nil, fmt.Errorf("配置不合法，拒绝启动: %w", err)
	}
	if o.dbPath != "" {
		cfg.DBPath = o.dbPath
	}
	switch o.task {
	case "all", "timer", "deactivate":
	default:
		return nil, fmt.Errorf("-task 只接受 all|timer|deactivate，当前 %q", o.task)
	}
	// 指向非官方地址 = 这一轮的所有写请求都不去 Ozon。这种情况必须扎眼，
	// 否则"演练通过"和"真的改到了价"这两种结果在日志里长得一模一样。
	if cfg.APIBaseURL != config.DefaultAPIBaseURL {
		logx.Errorf("⚠️ 演练模式：接口地址被改成 %s（官方是 %s）——本次不会向 Ozon 发出任何请求",
			cfg.APIBaseURL, config.DefaultAPIBaseURL)
	}
	return cfg, nil
}

func newDeps(cfg *config.Config, o options) *task.Deps {
	return &task.Deps{
		Feishu:      feishu.NewSender(cfg.MachineName, 0),
		Machine:     cfg.MachineName,
		Holder:      cfg.MachineName,
		Timeout:     cfg.APITimeout,
		Retries:     cfg.HTTPRetries,
		DryRun:      o.dryRun,
		Concurrency: cfg.TaskConcurrency,
		RPS:         cfg.APIRPS,
		Burst:       cfg.APIBurst,
		BaseURL:     cfg.APIBaseURL,
	}
}

// ---------- run ----------

func cmdRun(o options) error {
	cfg, err := loadConfig(o)
	if err != nil {
		return err
	}
	db, err := ledger.Open(cfg.DBPath)
	if err != nil {
		return err
	}
	defer db.Close()

	deps := newDeps(cfg, o)
	deps.Ledger = db
	units, err := buildUnits(cfg, deps, o)
	if err != nil {
		return err
	}
	if len(units) == 0 {
		return errors.New("没有可执行的调度单元：检查 OZON_SHOPS 是否为空、-group/-shop 是否写错")
	}

	logx.Infof("ozon-tasks %s 启动: machine=%s db=%s 调度单元=%d%s",
		version, cfg.MachineName, cfg.DBPath, len(units), drySuffix(o.dryRun))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// 常驻：每个调度单元一条独立 goroutine，各自按自己的排期与租约走，互不拖累。
	// 一个分组的店铺挂了不该让另一个分组停在旧的排期上。
	// 必须真的并发——Loop 永不返回，串行写法会让除第一个以外的单元永远起不来。
	var wg sync.WaitGroup
	for _, u := range units {
		wg.Add(1)
		t := u.task
		go func() {
			defer wg.Done()
			sched.Loop(ctx, db, t)
		}()
	}
	wg.Wait()
	logx.Infof("已收到停止信号，全部调度循环退出")
	return nil
}

// ---------- once ----------

// cmdOnce 串行跑一班。
// 串行而不是并发：同一时间只发一批请求给 Ozon，限流风险最小，日志也还能读。
func cmdOnce(o options) error {
	cfg, err := loadConfig(o)
	if err != nil {
		return err
	}
	db, err := ledger.Open(cfg.DBPath)
	if err != nil {
		return err
	}
	defer db.Close()

	deps := newDeps(cfg, o)
	deps.Ledger = db
	units, err := buildUnits(cfg, deps, o)
	if err != nil {
		return err
	}
	if len(units) == 0 {
		return errors.New("没有可执行的调度单元：检查 OZON_SHOPS 是否为空、-group/-shop 是否写错")
	}
	logx.Infof("ozon-tasks %s 单轮模式: machine=%s db=%s 单元=%d%s",
		version, cfg.MachineName, cfg.DBPath, len(units), drySuffix(o.dryRun))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var errs []error
	ran, skipped := 0, 0
	for _, u := range units {
		if ctx.Err() != nil {
			errs = append(errs, ctx.Err())
			break
		}
		t := u.task
		planned := time.Now()
		if !o.force {
			f := t.Due(db, planned, false)
			if !f.Due {
				logx.Infof("%s 跳过: %s", t.Name, f.Reason)
				skipped++
				continue
			}
			planned = f.Planned
		}
		// 强制跑时把班次记成"此刻"：这一班的去重键因此不会和排期上的任何一班撞上。
		// 代价是 @every 排期的相位会被这次强跑挪动（cron 固定时刻不受影响）。
		outcome, reason, err := sched.Run(ctx, db, t, planned, o.force)
		switch outcome {
		case sched.Ran:
			ran++
			logx.Infof("%s 本轮完成（班次 %s），下一班: %s",
				t.Name, planned.Format("2006-01-02 15:04:05"), nextFire(t, planned))
		case sched.Skipped:
			skipped++
			logx.Infof("%s 本轮跳过: %s", t.Name, reason)
		case sched.Interrupted:
			skipped++
			logx.Infof("%s 本轮中断: %s", t.Name, reason)
		case sched.Errored:
			ran++
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", t.Name, err))
			}
		}
	}
	logx.Infof("单轮结束: 执行 %d 个单元, 跳过 %d 个%s", ran, skipped, drySuffix(o.dryRun))
	return errors.Join(errs...)
}

func nextFire(t sched.Task, after time.Time) string {
	next := t.Schedule.Next(after)
	if next.IsZero() {
		return "无"
	}
	return fmt.Sprintf("%s（约 %s 后）", next.Format("2006-01-02 15:04:05"), sched.FormatDelay(time.Until(next)))
}

// ---------- check ----------

// cmdCheck 只装配配置并展开调度单元：不打开 SQLite（免得"看一眼配置"顺手建出库文件），
// 更不碰 Ozon 接口。
func cmdCheck(o options) error {
	cfg, err := loadConfig(o)
	if err != nil {
		return err
	}
	return printConfig(cfg, o)
}

// ---------- status ----------

// cmdStatus 读台账汇报现状。默认零接口调用：运维在任务正在跑的时候也要查得到，
// 而且这个二进制没有任何鉴权，绝不在它身上开监听端口。
func cmdStatus(o options) error {
	cfg, err := loadConfig(o)
	if err != nil {
		return err
	}
	if _, statErr := os.Stat(cfg.DBPath); statErr != nil {
		fmt.Printf("台账数据库: %s（还不存在，说明这台机器一次都没成功写过）\n", cfg.DBPath)
		fmt.Printf("先跑一轮演练看效果: ozon-tasks once -dry-run\n")
	} else {
		db, err := ledger.Open(cfg.DBPath)
		if err != nil {
			return err
		}
		defer db.Close()

		fmt.Printf("机器: %s\n台账数据库: %s\n", cfg.MachineName, cfg.DBPath)
		deps := newDeps(cfg, o)
		units, unitsErr := buildUnits(cfg, deps, o)
		if unitsErr != nil {
			logx.Errorf("调度单元展开失败，只按台账里已有的槽位汇报: %v", unitsErr)
		}
		if err := printSlots(db, units); err != nil {
			return err
		}
		if err := printCursors(db); err != nil {
			return err
		}
		if err := printLedger(db); err != nil {
			return err
		}
	}

	if !o.remote {
		return nil
	}
	// -remote 是只读巡检：不写台账、不改定时器，可以放心在生产上随时查。
	shops, err := statusShops(cfg, o)
	if err != nil {
		return err
	}
	deps := newDeps(cfg, o)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	fmt.Printf("\n== Ozon 定时器只读巡检（%d 家店铺）==\n", len(shops))
	return task.RunTimerStatusCheck(ctx, deps, shops)
}

// statusShops 决定巡检范围：-shop 优先，其次 -group（定时器/移除两类分组都找），最后全部店铺。
func statusShops(cfg *config.Config, o options) ([]config.Shop, error) {
	if o.shops != "" {
		if o.group != "" {
			return nil, fmt.Errorf("-shop 与 -group 不能同时使用")
		}
		return pickShops(cfg, strings.Split(o.shops, ","))
	}
	if o.group != "" {
		for _, groups := range [][]config.Group{cfg.TimerGroups, cfg.DeactivateGroups} {
			for _, g := range groups {
				if g.Name != o.group {
					continue
				}
				shops, err := pickShops(cfg, g.ShopNames)
				if err != nil {
					return nil, err
				}
				return shops, nil
			}
		}
		return nil, fmt.Errorf("没有名为 %q 的分组（定时器与移除两类分组里都没找到）", o.group)
	}
	if len(cfg.Shops) == 0 {
		return nil, errors.New("没有可巡检的店铺：OZON_SHOPS 为空")
	}
	return cfg.Shops, nil
}

func printSlots(db *ledger.DB, units []unit) error {
	fmt.Printf("\n== 排期与租约 ==\n")
	now := time.Now()
	seen := map[string]bool{}
	for _, u := range units {
		t := u.task
		seen[t.Slot] = true
		st, err := db.SlotStateOf(t.Slot)
		if err != nil {
			return err
		}
		fmt.Printf("%s\n  排期: %s  槽位: %s\n", t.Name, cronx.Describe(t.Schedule), t.Slot)
		if !st.Exists {
			fmt.Printf("  台账里还没有这个槽位：首次到班会立即执行一次\n\n")
			continue
		}
		fmt.Printf("  上次: 状态=%s 计划班次=%s 开始=%s 完成=%s 累计 %d 次\n",
			orDash(st.Status), fmtTime(st.PlannedAt), fmtTime(st.StartedAt), fmtTime(st.FinishedAt), st.Runs)
		if st.Detail != "" || st.Error != "" {
			fmt.Printf("       详情=%s 错误=%s\n", orDash(st.Detail), orDash(st.Error))
		}
		if st.Running(now) {
			fmt.Printf("  ⚠️ 正在被 %s 执行（租约至 %s）\n", orDash(st.Holder), fmtTime(st.LeaseUntil))
		}
		f := t.Due(db, now, false)
		if f.Due {
			fmt.Printf("  本轮: 到班（%s）\n", f.Planned.Format("2006-01-02 15:04:05"))
		} else {
			fmt.Printf("  本轮: %s\n", f.Reason)
		}
		fmt.Println()
	}

	// 配置里已经没有、台账里还留着的槽位（改过组名就会这样），点出来免得被当成还在调度
	all, err := db.AllSlotStates()
	if err != nil {
		return err
	}
	var stale []string
	for _, st := range all {
		if !seen[st.Slot] {
			stale = append(stale, fmt.Sprintf("%s（上次 %s，状态 %s）",
				st.Slot, fmtTime(st.FinishedAt), orDash(st.Status)))
		}
	}
	if len(stale) > 0 {
		fmt.Printf("台账里有 %d 个槽位已不在当前配置中（改过组名或删过分组）:\n  - %s\n",
			len(stale), strings.Join(stale, "\n  - "))
	}
	return nil
}

func printCursors(db *ledger.DB) error {
	cur, err := db.AllCursors()
	if err != nil {
		return err
	}
	if len(cur) == 0 {
		fmt.Printf("\n== 扫描进度 ==\n  （还没有扫描记录）\n")
		return nil
	}
	fmt.Printf("\n== 扫描进度 ==\n")
	for _, c := range cur {
		state := "进行中"
		if c.Finished {
			state = "已完成"
		}
		fmt.Printf("  - %-40s %s 已处理 %d 个 更新于 %s",
			c.Scope, state, c.Processed, fmtTime(c.UpdatedAt))
		if !c.Finished {
			fmt.Printf("（续跑游标 %s，超 6 小时未更新则作废重扫）", orDash(c.Value))
		}
		fmt.Println()
	}
	return nil
}

func printLedger(db *ledger.DB) error {
	shops, err := db.LedgerSummary()
	if err != nil {
		return err
	}
	fmt.Printf("\n== 价格台账 ==\n")
	if len(shops) == 0 {
		fmt.Printf("  （空库）\n")
		return nil
	}
	for _, s := range shops {
		fmt.Printf("  - %-14s 共 %5d 条  最低价已设 %5d  跳过 %5d  失败 %5d  不适用 %5d  最后核查 %s 最后设价 %s\n",
			s.ShopName, s.Rows, s.Set, s.Skipped, s.Failed, s.NotApplicable,
			fmtTime(s.LatestCheckedAt), fmtTime(s.LatestSetAt))
	}
	return nil
}

// fmtTime 零值时间不打印 0001-01-01，那种值在运维眼里和"没有"是一回事。
func fmtTime(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return t.Format(logx.TimeLayout)
}

// ---------- usage ----------

func usage(w io.Writer) {
	for _, c := range []string{"run", "once", "check", "status", "version"} {
		usageFor(c, w)
	}
}

func usageFor(cmd string, w io.Writer) {
	var o options
	fs := flagsFor(cmd, &o)
	fs.SetOutput(w)
	fmt.Fprintf(w, "用法: ozon-tasks %s [选项]\n", cmd)
	fs.PrintDefaults()
	fmt.Fprintln(w)
}
