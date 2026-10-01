// Package logx 提供与 httpsrv 侧一致的日志格式和时间字符串。
// 飞书通知里的"执行时间"必须和 JS 版同为 YYYY-MM-DD HH:mm:ss（本地时区），
// 否则运维对着两边的日志对不上时间线。
package logx

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

const TimeLayout = "2006-01-02 15:04:05"

var (
	mu       sync.Mutex
	infoOut  io.Writer = os.Stdout
	errorOut io.Writer = os.Stderr
)

// Redirect 换掉日志输出目标，测试据此断言日志内容（比如 dry-run 下不许出现"更新成功"）。
func Redirect(info, errs io.Writer) {
	mu.Lock()
	defer mu.Unlock()
	infoOut, errorOut = info, errs
}

func emit(level, prefix, format string, a ...any) {
	line := fmt.Sprintf(format, a...)
	mu.Lock()
	defer mu.Unlock()
	w := infoOut
	if level == "ERROR" {
		w = errorOut
	}
	if prefix != "" {
		prefix += " "
	}
	// 整行在锁内写出：多店并发时日志才是一行一条，不会被拆成 A 的前缀配 B 的内容
	fmt.Fprintf(w, "%s %s %s%s\n", time.Now().Format(TimeLayout), level, prefix, line)
}

func Infof(format string, a ...any)  { emit("INFO", "", format, a...) }
func Errorf(format string, a ...any) { emit("ERROR", "", format, a...) }

// Tagged 是带来源标签（如 "[YQL01] [定时器]"）的日志器。
// 多店并发时必须用它，不能再用进程级前缀：前缀是共享变量，
// 两个店铺交错打日志会把 A 的行标成 B，事后完全查错线索。
type Tagged struct{ prefix string }

// Tag 拼出来源标签，各段之间自动留空格。
func Tag(parts ...string) *Tagged {
	return &Tagged{prefix: strings.Join(compact(parts), " ")}
}

func compact(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func (t *Tagged) Infof(format string, a ...any)  { emit("INFO", t.prefix, format, a...) }
func (t *Tagged) Errorf(format string, a ...any) { emit("ERROR", t.prefix, format, a...) }

// FormatTime 毫秒时间戳转本地时间字符串，对齐 dayjs 的 'YYYY-MM-DD HH:mm:ss'。
func FormatTime(ms int64) string {
	return time.UnixMilli(ms).Format(TimeLayout)
}

// FormatOzonTime 解析 Ozon 返回的带时区时间串并转本地展示格式；解析失败返回空串。
func FormatOzonTime(s string) string {
	if s == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return ""
	}
	return t.Local().Format(TimeLayout)
}
