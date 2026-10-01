// 调度表达式单测。基准是"固定时刻不漂移"和标准 cron 的日/周或语义——
// 这两条一旦写错，任务会悄悄爬进业务高峰或天天触发，运行时很难看出来。
package cronx

import (
	"testing"
	"time"
)

// 本地时区里构造时刻，避免断言依赖机器时区
func at(y int, mo time.Month, d, hh, mm int) time.Time {
	return time.Date(y, mo, d, hh, mm, 0, 0, time.Local)
}

func must(t *testing.T, spec string) Schedule {
	t.Helper()
	s, err := Parse(spec)
	if err != nil {
		t.Fatalf("Parse(%q) 报错: %v", spec, err)
	}
	if s == nil {
		t.Fatalf("Parse(%q) 返回空排期", spec)
	}
	return s
}

func TestEveryInterval(t *testing.T) {
	cases := map[string]time.Duration{
		"@every 8h":   8 * time.Hour,
		"@every 1d":   24 * time.Hour,
		"@EVERY 30M":  30 * time.Minute,
		"@every 1d2h": 26 * time.Hour,
	}
	for spec, want := range cases {
		s := must(t, spec)
		base := at(2026, 10, 1, 12, 30)
		if got := s.Next(base); got != base.Add(want) {
			t.Errorf("%s Next(%v) = %v，期望 %v", spec, base.Format(time.RFC3339), got.Format(time.RFC3339), base.Add(want).Format(time.RFC3339))
		}
	}

	// 节拍必须从上一次的计划时刻推进：任务跑 40 分钟不该把后续排期一路推下去
	base := at(2026, 10, 1, 0, 0)
	s := must(t, "@every 1h")
	want := at(2026, 10, 1, 3, 0)
	got := s.Next(s.Next(s.Next(base)))
	if got != want {
		t.Errorf("连推三次 = %v，期望 %v（间隔排期不能累积任务耗时）", got, want)
	}
}

func TestAlias(t *testing.T) {
	base := at(2026, 10, 1, 12, 30) // 周四
	cases := []struct {
		spec string
		want time.Time
	}{
		{"@daily", at(2026, 10, 2, 0, 0)},
		{"@midnight", at(2026, 10, 2, 0, 0)},
		{"@hourly", at(2026, 10, 1, 13, 0)},
		{"@weekly", at(2026, 10, 4, 0, 0)}, // 下个周日
		{"@monthly", at(2026, 11, 1, 0, 0)},
		{"@yearly", at(2027, 1, 1, 0, 0)},
	}
	for _, c := range cases {
		if got := must(t, c.spec).Next(base); got != c.want {
			t.Errorf("%s Next = %v，期望 %v", c.spec, got.Format(time.RFC3339), c.want.Format(time.RFC3339))
		}
	}
}

func TestFixedTimeIsStrictlyAfter(t *testing.T) {
	// 正好落在触发时刻上也必须推下一轮，否则调度循环会在同一分钟里自旋
	three := must(t, "0 3 * * *")
	if got := three.Next(at(2026, 10, 1, 3, 0)); got != at(2026, 10, 2, 3, 0) {
		t.Errorf("边界时刻应严格向后: %v", got)
	}
	if got := three.Next(at(2026, 10, 1, 2, 59)); got != at(2026, 10, 1, 3, 0) {
		t.Errorf("2:59 的下一班应是当天 3:00: %v", got)
	}
}

func TestListsRangesSteps(t *testing.T) {
	cases := []struct {
		spec string
		from time.Time
		want []time.Time
	}{
		{"0,30 * * * *", at(2026, 10, 1, 9, 5),
			[]time.Time{at(2026, 10, 1, 9, 30), at(2026, 10, 1, 10, 0), at(2026, 10, 1, 10, 30)}},
		{"*/15 * * * *", at(2026, 10, 1, 9, 1),
			[]time.Time{at(2026, 10, 1, 9, 15), at(2026, 10, 1, 9, 30), at(2026, 10, 1, 9, 45), at(2026, 10, 1, 10, 0)}},
		{"0 9-18/3 * * *", at(2026, 10, 1, 8, 0),
			[]time.Time{at(2026, 10, 1, 9, 0), at(2026, 10, 1, 12, 0), at(2026, 10, 1, 15, 0), at(2026, 10, 1, 18, 0), at(2026, 10, 2, 9, 0)}},
		{"0 0 1,15 * *", at(2026, 10, 1, 0, 0),
			[]time.Time{at(2026, 10, 15, 0, 0), at(2026, 11, 1, 0, 0), at(2026, 11, 15, 0, 0)}},
		{"0 20 * * 1-5", at(2026, 10, 1, 21, 0), // 周四 21 点 -> 周五 20 点，再跳到下周一
			[]time.Time{at(2026, 10, 2, 20, 0), at(2026, 10, 5, 20, 0)}},
		{"0 0 5/10 * *", at(2026, 10, 1, 0, 0), // 5 号起每 10 天直到月末
			[]time.Time{at(2026, 10, 5, 0, 0), at(2026, 10, 15, 0, 0), at(2026, 10, 25, 0, 0)}},
	}
	for _, c := range cases {
		s := must(t, c.spec)
		cur := c.from
		for i, want := range c.want {
			cur = s.Next(cur)
			if cur != want {
				t.Errorf("%s 第 %d 次 = %v，期望 %v", c.spec, i+1, cur.Format(time.RFC3339), want.Format(time.RFC3339))
				break
			}
		}
	}
}

func TestCrossMidnightRange(t *testing.T) {
	// 22-2 是绕圈区间：22,23,0,1,2
	s := must(t, "0 22-2 * * *")
	var got []int
	cur := at(2026, 10, 1, 20, 0)
	for i := 0; i < 5; i++ {
		cur = s.Next(cur)
		got = append(got, cur.Hour())
	}
	want := []int{22, 23, 0, 1, 2}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("跨界区间第 %d 次落在 %d 点，期望 %d 点（%v）", i+1, got[i], want[i], got)
			break
		}
	}
}

func TestDayOfWeekOnly(t *testing.T) {
	// 日段是 * 时，周段单独生效；否则"每周一"会因 dom 恒真变成每天
	s := must(t, "0 0 * * 1")
	cur := at(2026, 10, 1, 0, 0) // 周四
	for i := 0; i < 3; i++ {
		cur = s.Next(cur)
		if cur.Weekday() != time.Monday {
			t.Fatalf("第 %d 次 %v 不是周一", i+1, cur.Format(time.RFC3339))
		}
	}
	if cur != at(2026, 10, 19, 0, 0) {
		t.Errorf("连三次周一 = %v，期望 10-19（10-05、10-12、10-19）", cur.Format(time.RFC3339))
	}
}

func TestDomDowOrSemantics(t *testing.T) {
	// 两段同时受限 -> 取或：13 号与周五都触发，谁先来算谁
	s := must(t, "0 0 13 * 5")
	cur := at(2026, 10, 1, 0, 0) // 周四
	got := []string{}
	for i := 0; i < 4; i++ {
		cur = s.Next(cur)
		got = append(got, cur.Format("2006-01-02 Mon"))
	}
	want := []string{"2026-10-02 Fri", "2026-10-09 Fri", "2026-10-13 Tue", "2026-10-16 Fri"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("或语义第 %d 次 = %s，期望 %s（%v）", i+1, got[i], want[i], got)
		}
	}
}

func TestSundayZeroAndSeven(t *testing.T) {
	// 周日写 0 与写 7 必须等价（10-04 是周日）
	from := at(2026, 10, 1, 0, 0)
	a := must(t, "0 0 * * 0").Next(from)
	b := must(t, "0 0 * * 7").Next(from)
	if a != at(2026, 10, 4, 0, 0) || a != b {
		t.Errorf("周日 0=%v 7=%v，都应为 2026-10-04", a.Format(time.RFC3339), b.Format(time.RFC3339))
	}
}

func TestMonthAndYearRollover(t *testing.T) {
	cases := []struct {
		spec string
		from time.Time
		want time.Time
	}{
		{"0 0 1 1 *", at(2026, 12, 2, 3, 0), at(2027, 1, 1, 0, 0)},
		{"0 0 1 3 *", at(2026, 10, 1, 0, 0), at(2027, 3, 1, 0, 0)},
		{"30 2 29 2 *", at(2026, 3, 1, 0, 0), at(2028, 2, 29, 2, 30)}, // 2027 平年，闰日要再等一年
		{"0 0 31 * *", at(2026, 4, 1, 0, 0), at(2026, 5, 31, 0, 0)},   // 4 月没有 31 号，直接跳过
	}
	for _, c := range cases {
		if got := must(t, c.spec).Next(c.from); got != c.want {
			t.Errorf("%s Next(%v) = %v，期望 %v", c.spec, c.from.Format(time.RFC3339), got.Format(time.RFC3339), c.want.Format(time.RFC3339))
		}
	}
}

func TestParseRejectsBadSpecs(t *testing.T) {
	bad := []string{
		"* * * *",     // 段数不足
		"* * * * * *", // 带秒位
		"60 * * * *",  // 越界
		"* 24 * * *",
		"* * 0 * *", // 日没有 0
		"* * * 13 *",
		"* * * * 8",
		"*/0 * * * *", // 步长 0 会死循环
		"a * * * *",
		"* * * * mon-fri", // 不支持英文名，报错也比猜强
		"@every",
		"@every 14400000", // 裸毫秒
		"@every 30s",      // 低于一分钟
		"@every 1.5h",
		"@workdaily",
		"@every -1h",
	}
	for _, spec := range bad {
		if _, err := Parse(spec); err == nil {
			t.Errorf("Parse(%q) 应当报错却成功了", spec)
		}
	}
}

func TestEmptyMeansNoSchedule(t *testing.T) {
	// 空串不是错误：配置里没写排期时由调用方回退到冷却期节拍
	for _, spec := range []string{"", "   "} {
		s, err := Parse(spec)
		if err != nil {
			t.Errorf("Parse(%q) 意外报错: %v", spec, err)
		}
		if s != nil {
			t.Errorf("Parse(%q) 应返回 nil 排期", spec)
		}
	}
}

func TestStringAndDescribe(t *testing.T) {
	if got := must(t, "0 3 * * *").String(); got != "0 3 * * *" {
		t.Errorf("String 应回显原表达式，得到 %q", got)
	}
	if got := Describe(must(t, "@every 8h")); got != "每 8h0m0s（固定间隔）" {
		t.Errorf("Describe(@every 8h) = %q", got)
	}
	if got := Describe(nil); got != "未配置" {
		t.Errorf("Describe(nil) = %q", got)
	}
	if d := Describe(must(t, "0 3 * * *")); d == "" {
		t.Error("Describe(cron) 不该为空")
	}
}
