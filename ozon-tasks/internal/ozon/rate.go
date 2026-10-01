// 每店令牌桶限速。
//
// Ozon 的配额是按 client-id 算的，不是按进程：一家店打满了会连累这家店的其余任务，
// 但不会（也不该）拖慢别的店铺。所以令牌桶挂在 Client 上（一店一实例），而不是全局一份。
//
// 之所以手写：标准库没有 rate.Limiter，而 x/time/rate 是这项目目前唯一会引入的第三方运行时依赖，
// 为一个减法换来的令牌桶不值得——交叉编译时要多带一个模块，出问题时也没法一眼看完。
package ozon

import (
	"context"
	"sync"
	"time"
)

// Limiter 是经典令牌桶：桶里最多 burst 个令牌，按 rps 匀速补充，每次请求取一个。
// 取不到就等——等待时长按"补足差额需要多久"算，令牌允许透支成负数，
// 这样并发请求按各自预约的时间自然排队，不需要循环重试抢桶（那种写法在高并发下会活锁）。
type Limiter struct {
	mu     sync.Mutex
	rps    float64
	burst  float64
	tokens float64
	last   time.Time

	now  func() time.Time
	wait func(context.Context, time.Duration) error
}

// NewLimiter 建桶。rps<=0 表示不限速（返回 nil，调用方判空即可，不另设 NoLimiter 类型）。
func NewLimiter(rps float64, burst int) *Limiter {
	if rps <= 0 {
		return nil
	}
	if burst <= 0 {
		burst = 1
	}
	return &Limiter{
		rps:    rps,
		burst:  float64(burst),
		tokens: float64(burst), // 开局给满：任务刚启动时有一串独立的读请求，没必要先排一轮队
		now:    time.Now,
		wait:   sleepCtx,
	}
}

// reserve 结算到 at 这一刻并预定一个令牌，返回"至少还要等多久才能发"。
func (l *Limiter) reserve(at time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.last.IsZero() {
		l.last = at
	} else if elapsed := at.Sub(l.last); elapsed > 0 {
		l.tokens += float64(elapsed) / float64(time.Second) * l.rps
		if l.tokens > l.burst {
			l.tokens = l.burst
		}
	}
	l.last = at

	l.tokens-- // 透支：后面的请求据此排队，而不是抢完再回头补
	if l.tokens >= 0 {
		return 0
	}
	return time.Duration(float64(-l.tokens) / l.rps * float64(time.Second))
}

// Wait 阻塞到拿到令牌、或上下文取消。
func (l *Limiter) Wait(ctx context.Context) error {
	if l == nil {
		return nil
	}
	if d := l.reserve(l.now()); d > 0 {
		return l.wait(ctx, d)
	}
	return ctx.Err()
}
