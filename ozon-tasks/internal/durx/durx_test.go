// 时长解析单测。行为基准是 httpsrv/config.js 的 parseDuration：
// 两个程序吃同一份 .env，这里松一寸，JS 侧就得多猜一寸。
package durx

import (
	"testing"
	"time"
)

func TestParse(t *testing.T) {
	valid := map[string]time.Duration{
		"8h":           8 * time.Hour,
		"1h":           time.Hour,
		"1d2h30m15s":   26*time.Hour + 30*time.Minute + 15*time.Second,
		" 45m ":        45 * time.Minute,
		"1d 2h":        26 * time.Hour,
		"300s":         5 * time.Minute,
		"1d2h30m15s1d": 50*time.Hour + 30*time.Minute + 15*time.Second, // 重复单位照旧累加，与 JS 一致
	}
	for in, want := range valid {
		got, err := Parse(in)
		if err != nil {
			t.Errorf("Parse(%q) 意外报错: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("Parse(%q) = %v，期望 %v", in, got, want)
		}
	}

	// 裸数字必须拒绝：把毫秒当秒写会让调度频率直接跑飞
	for _, in := range []string{"", "  ", "14400000", "100", "8", "abc", "1h30x", "1w", "h", "1.5h", "1hh"} {
		if _, err := Parse(in); err == nil {
			t.Errorf("Parse(%q) 应当报错，却返回了成功", in)
		}
	}
}

func TestMustParsePanicsOnBadValue(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("MustParse 对写死的非法默认值应当 panic")
		}
	}()
	MustParse("14400000")
}
