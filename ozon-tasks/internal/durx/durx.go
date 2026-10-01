// Package durx 解析人性化时长 1d2h30m15s。
//
// 单独成包是因为 config（冷却期）和 cronx（@every 周期）都要用它，
// 而 config 之后还会反过来引用 cronx 做配置校验——放在任何一边都会构成循环依赖。
package durx

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var segmentRe = regexp.MustCompile(`(\d+)([dhms])`)

var unitOf = map[byte]time.Duration{
	'd': 24 * time.Hour,
	'h': time.Hour,
	'm': time.Minute,
	's': time.Second,
}

// Parse 与 JS 侧 parseDuration 同规：段间只允许空白、纯数字（"14400000"）视为非法。
// 保持严格是因为把毫秒当秒写错一个单位，任务会几小时不跑或几秒跑一次；
// 这类错误静默运行时的代价远大于拒绝启动。
func Parse(val string) (time.Duration, error) {
	s := strings.TrimSpace(val)
	if s == "" {
		return 0, fmt.Errorf("时长为空")
	}
	matches := segmentRe.FindAllStringSubmatchIndex(s, -1)
	if len(matches) == 0 {
		return 0, fmt.Errorf("无效的时长格式: %q（支持格式: 1d2h30m15s）", val)
	}
	var total time.Duration
	last := 0
	for _, m := range matches {
		if strings.TrimSpace(s[last:m[2]]) != "" {
			return 0, fmt.Errorf("无效的时长格式: %q（段间不允许非空白字符；支持格式: 1d2h30m15s）", val)
		}
		n, err := strconv.ParseInt(s[m[2]:m[3]], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("无效的时长格式: %q", val)
		}
		total += time.Duration(n) * unitOf[s[m[4]:m[5]][0]]
		last = m[1]
	}
	if strings.TrimSpace(s[last:]) != "" {
		return 0, fmt.Errorf("无效的时长格式: %q（支持格式: 1d2h30m15s）", val)
	}
	return total, nil
}

// MustParse 只用于代码里写死的默认值；写错了应当在开发期就炸掉。
func MustParse(val string) time.Duration {
	d, err := Parse(val)
	if err != nil {
		panic(err)
	}
	return d
}
