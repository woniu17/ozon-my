// Package cronx 解析调度表达式并算出下一次触发时刻，支持三种写法：
//
//	0 3 * * *        标准 5 段 cron（分 时 日 月 周），按本地时区的墙钟对齐
//	0 0 3 * *        6 段带秒位（httpsrv 侧就是这种），秒位必须是 0
//	@every 8h        固定间隔，d/h/m/s 人性化时长（与 .env 冷却期同一方言）
//	@daily 等        常见别名，等价于对应的 cron
//
// 为什么要认 6 段：两个程序吃同一份 .env，JS 侧的默认排期 `0 0 */8 * * *` 就是 6 段。
// 只认 5 段会让 Go 在配置完全没变的情况下悄悄退回 @every 节拍，触发点随启动时间漂，
// 对拍时看起来像 Go 的 bug。秒位强制为 0 是因为这个任务一轮要几十秒到几分钟，
// 亚分钟排期只会让同一班次自我重叠。
//
// 为什么用固定时刻而不是"跑完再等 N 小时"的节拍器：
// 节拍器的触发点会随任务耗时不断漂移，凌晨低峰跑的维护任务会一天比一天晚，
// 最后爬进流量高峰；写死"每天 03:00"才和店铺侧的预期一致，也让多次 --once
// 与常驻进程的排期对得上。间隔型任务用 @every，Next 从上一次的**计划**时刻推进，
// 不会因为本次跑得慢就整体后移。
//
// 不引第三方 cron 库：5 段语法自己写完一百多行，行为可控、错误信息能说人话。
package cronx

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"ozon-tasks/internal/durx"
)

// Schedule 是一次触发排期。
type Schedule interface {
	// Next 返回 after 之后严格下一次的触发时刻（不含 after 本身）。
	Next(after time.Time) time.Time
	// String 回显原始表达式，用于启动日志和 status 输出。
	String() string
}

// cronSpec 是 5 段 cron。各段用位图存储：范围都在 0..31 内，uint64 足够，
// 匹配时一次位运算，比 map/切片都快。
type cronSpec struct {
	raw      string
	minute   uint64
	hour     uint64
	dom      uint64 // 1..31
	month    uint64 // 1..12
	dow      uint64 // 0..6，0=周日
	domStar  bool   // 日段不设限：日/周同时受限才需要取或
	dowStar  bool
	interval time.Duration // >0 表示 @every 语义的固定间隔
}

// 每段的最大值+偏移：值 v 落在位 (v-off) 上。
type field struct {
	name string
	min  int
	max  int
	off  int
}

var fields = []field{
	{"分钟", 0, 59, 0},
	{"小时", 0, 23, 0},
	{"日", 1, 31, 1},
	{"月", 1, 12, 1},
	{"周", 0, 6, 0},
}

// aliasSpecs 是常见 cron 的简写。@weekly 用"周日 0 点"而不是 5 段全星。
var aliasSpecs = map[string]string{
	"@yearly":   "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
	"@monthly":  "0 0 1 * *",
	"@weekly":   "0 0 * * 0",
	"@daily":    "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@hourly":   "0 * * * *",
}

// Parse 解析调度表达式。空串返回 (nil, nil)：调用方据此回退到旧冷却期节拍，
// 切换期两边配置不同步时不该直接拒绝启动。
func Parse(spec string) (Schedule, error) {
	s := strings.TrimSpace(spec)
	if s == "" {
		return nil, nil
	}

	if strings.HasPrefix(s, "@") {
		lower := strings.ToLower(s)
		if alias, ok := aliasSpecs[lower]; ok {
			cron, err := parseCron(alias)
			if err != nil {
				return nil, err
			}
			cron.raw = lower
			return cron, nil
		}
		if rest, ok := strings.CutPrefix(lower, "@every "); ok {
			d, err := durx.Parse(rest)
			if err != nil {
				return nil, fmt.Errorf("@every 的周期: %w", err)
			}
			if d < time.Minute {
				// 拒于分钟以下：这个任务一轮要几十秒到几分钟，秒级排期只会自我重叠
				return nil, fmt.Errorf("@every 的周期不得小于 1 分钟（收到 %q）", rest)
			}
			return &cronSpec{raw: s, interval: d}, nil
		}
		return nil, fmt.Errorf("未知的调度别名: %q（可用 @yearly @monthly @weekly @daily @midnight @hourly @every <时长>）", s)
	}

	return parseCron(s)
}

// MustParse 只用于代码里写死的默认排期。
func MustParse(spec string) Schedule {
	s, err := Parse(spec)
	if err != nil {
		panic(err)
	}
	if s == nil {
		panic("MustParse 不接受空表达式")
	}
	return s
}

func parseCron(spec string) (*cronSpec, error) {
	parts := strings.Fields(spec)
	if len(parts) == 6 {
		// 秒位只接受字面 0：本任务一轮就要几十秒到几分钟，亚分钟排期只会让同一班次自我重叠
		if parts[0] != "0" {
			return nil, fmt.Errorf("6 段表达式的秒位必须是 0，收到 %q: %s", parts[0], spec)
		}
		c, err := parseCron(strings.Join(parts[1:], " "))
		if err != nil {
			return nil, err
		}
		c.raw = spec // 回显保留原始写法：启动日志和 .env 上看到的一模一样，对拍不用换算
		return c, nil
	}
	if len(parts) != 5 {
		return nil, fmt.Errorf("调度表达式需要 5 段（分 时 日 月 周），或 6 段且秒位为 0，收到 %d 段: %q", len(parts), spec)
	}

	c := &cronSpec{raw: spec}
	sets := []*uint64{&c.minute, &c.hour, &c.dom, &c.month, &c.dow}
	for i, p := range parts {
		set, star, err := parseField(p, fields[i])
		if err != nil {
			return nil, fmt.Errorf("调度表达式 %q 的第 %d 段（%s）: %w", spec, i+1, fields[i].name, err)
		}
		*sets[i] = set
		switch i {
		case 2:
			c.domStar = star
		case 4:
			c.dowStar = star
		}
	}
	return c, nil
}

// parseField 解析一段，返回位图和"整段是否等价于 *（不设限）"。
// 支持 *、*/n、a、a-b、a-b/n、a/n 以及它们的逗号列表。区间允许 22-2 这种跨界写法。
//
// 段内一律用"下标"（值减偏移，0..span-1）参与位运算，避免偏移量在多处反复加减。
func parseField(seg string, f field) (uint64, bool, error) {
	span := f.max - f.min + 1
	var set uint64
	unrestricted := true

	for _, item := range strings.Split(seg, ",") {
		if item == "" {
			return 0, false, fmt.Errorf("%q 有空的分项", seg)
		}
		step := 1
		base := item
		if slash := strings.IndexByte(item, '/'); slash >= 0 {
			base = item[:slash]
			n, err := strconv.Atoi(item[slash+1:])
			if err != nil || n <= 0 {
				return 0, false, fmt.Errorf("步长 %q 必须是正整数", item[slash+1:])
			}
			step = n
		}

		var lo, hi int
		switch {
		case base == "*":
			lo, hi = 0, span-1
		default:
			head, tail, isRange := strings.Cut(base, "-")
			v, err := f.value(head)
			if err != nil {
				return 0, false, err
			}
			lo = v
			switch {
			case isRange:
				if hi, err = f.value(tail); err != nil {
					return 0, false, err
				}
			case step > 1:
				// "a/n" 在 cron 里是"a 起每隔 n 直到段尾"，不是单点
				hi = span - 1
			default:
				hi = v
			}
		}
		// 只有裸 * 才算不设限：*/2 会漏掉一半的时刻，
		// 若在日/周的或判定里当星处理，"0 0 1-31/2 * 1" 会退化成每天触发
		if item != "*" {
			unrestricted = false
		}

		count := (hi-lo+span)%span + 1 // lo>hi 即跨界区间，绕一圈
		for i := 0; i < count; i += step {
			set |= 1 << uint((lo+i)%span)
		}
	}
	return set, unrestricted, nil
}

func (f field) value(raw string) (int, error) {
	v, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return 0, fmt.Errorf("%q 不是数字（%s 的合法范围 %d-%d）", raw, f.name, f.min, f.max)
	}
	// 周日既可写 0 也可写 7，与 cron 一致
	if f.off == 0 && f.max == 6 && v == 7 {
		v = 0
	}
	if v < f.min || v > f.max {
		return 0, fmt.Errorf("%d 超出 %s 的合法范围 %d-%d", v, f.name, f.min, f.max)
	}
	return v - f.off, nil
}

func (c *cronSpec) String() string { return c.raw }

func matches(set uint64, v int) bool { return set&(1<<uint(v)) != 0 }

// dayMatches 实现标准 cron 的"日/周同时受限时取或"规则：
// 只有两段都被人为限制（都不是 *）时才是或关系，否则按与关系判定。
// 少这一条，"0 0 * * 1"（每周一）会因为 dom 也满足而天天触发。
func (c *cronSpec) dayMatches(t time.Time) bool {
	dom := matches(c.dom, t.Day()-1)
	dow := matches(c.dow, int(t.Weekday()))
	switch {
	case c.domStar && c.dowStar:
		return true
	case c.domStar:
		return dow
	case c.dowStar:
		return dom
	default:
		return dom || dow
	}
}

// maxProbe 是向后搜索的上界（分钟数）。5 段 cron 最长间隔是"2 月 29 日 + 指定星期"
// 这一类组合，四年足够；再兜不住就当作表达式有问题退出，避免调度循环假死。
const maxProbe = 366*5*24*60 + 10

func (c *cronSpec) Next(after time.Time) time.Time {
	loc := after.Location()

	// @every：从上一次计划时刻等间隔推进。刻意不看墙钟对齐，保证节拍不因单次耗时漂移。
	if c.interval > 0 {
		return after.Add(c.interval).In(loc)
	}

	t := time.Date(after.Year(), after.Month(), after.Day(), after.Hour(), after.Minute(), 0, 0, loc).
		Add(time.Minute)

	for probes := 0; probes < maxProbe; probes++ {
		if !matches(c.month, int(t.Month())-1) {
			// 跳到下月 1 号 00:00：整月不合时逐分钟空转太浪费
			t = time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, loc)
			continue
		}
		if !c.dayMatches(t) {
			t = time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, loc)
			continue
		}
		if !matches(c.hour, t.Hour()) {
			t = time.Date(t.Year(), t.Month(), t.Day(), t.Hour()+1, 0, 0, 0, loc)
			continue
		}
		if !matches(c.minute, t.Minute()) {
			t = t.Add(time.Minute)
			continue
		}
		return t
	}
	return time.Time{}
}

// Describe 把排期翻成人话，用于启动日志和飞书通知。
func Describe(s Schedule) string {
	if s == nil {
		return "未配置"
	}
	c, ok := s.(*cronSpec)
	if !ok {
		return s.String()
	}
	if c.interval > 0 {
		return fmt.Sprintf("每 %v（固定间隔）", c.interval)
	}
	return fmt.Sprintf("%s（本地时区 %s）", c.raw, time.Now().Format("MST"))
}
