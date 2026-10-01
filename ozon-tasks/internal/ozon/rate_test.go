// 令牌桶的账必须算得死：放行快了会踩 Ozon 限流（连带 Retry-After 干等），
// 算慢了任务要跑几个小时。这里用手动时钟，不靠真睡觉。
package ozon

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func manualClock() (*time.Time, func() time.Time) {
	now := time.Unix(1700000000, 0)
	return &now, func() time.Time { return now }
}

func TestReserveQueueing(t *testing.T) {
	now, clock := manualClock()
	l := NewLimiter(2, 3) // 2 个/秒，桶 3
	l.now = clock
	l.wait = func(context.Context, time.Duration) error { return nil }

	// 开局满桶：前三发不用等
	for i := 0; i < 3; i++ {
		if d := l.reserve(*now); d != 0 {
			t.Fatalf("第 %d 发不该等待，却排了 %v", i+1, d)
		}
	}
	// 桶空之后每发按 1/rps 递增排队
	want := []time.Duration{500 * time.Millisecond, time.Second, 1500 * time.Millisecond}
	for i, w := range want {
		if d := l.reserve(*now); d != w {
			t.Errorf("第 %d 发排队 %v，期望 %v", i+4, d, w)
		}
	}

	// 补桶不等于插队：过一秒补进 2 个令牌，余额 -1，新一发仍要排在既有欠账之后
	*now = now.Add(time.Second)
	if d := l.reserve(*now); d != time.Second {
		t.Errorf("欠账排队应等 1s，得到 %v", d)
	}
	// 桶彻底回满后要什么发什么
	*now = now.Add(3 * time.Second)
	if d := l.reserve(*now); d != 0 {
		t.Errorf("补满后应立即可发，却排了 %v", d)
	}
}

func TestRefillCapsAtBurst(t *testing.T) {
	now := time.Unix(1700000000, 0)
	l := NewLimiter(2, 3)
	l.now = func() time.Time { return now }
	l.wait = func(context.Context, time.Duration) error { return nil }

	// 空闲一整天也只补到桶容量，否则攒出来的令牌会让一轮请求瞬间打出去
	now = now.Add(24 * time.Hour)
	for i := 0; i < 3; i++ {
		if d := l.reserve(now); d != 0 {
			t.Fatalf("满桶第 %d 发不该等待: %v", i+1, d)
		}
	}
	if d := l.reserve(now); d != 500*time.Millisecond {
		t.Errorf("超出 burst 的第 4 发应排 500ms，得到 %v", d)
	}
}

func TestNilLimiterIsNoop(t *testing.T) {
	var l *Limiter
	if l != nil {
		t.Fatal("rps<=0 应返回 nil 桶")
	}
	if err := l.Wait(context.Background()); err != nil {
		t.Errorf("nil 桶不该报错: %v", err)
	}
}

func TestWaitHonorsContext(t *testing.T) {
	_, clock := manualClock()
	l := NewLimiter(1, 1)
	l.now = clock
	l.wait = sleepCtx

	// 第一发把令牌用光（reserve 透支后余额为 0，等待 0）；第二发要等 1 秒
	if err := l.Wait(context.Background()); err != nil {
		t.Fatalf("首发应直接通过: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if err := l.Wait(ctx); err == nil {
		t.Error("上下文已取消时不应放行")
	}
	if time.Since(start) > time.Second {
		t.Errorf("取消后应立刻返回，实际耗了 %v", time.Since(start))
	}
}

// 端到端确认限速闸确实挂在出口上：重试也要过桶，否则退避期间攒下的令牌会被重试一次性挥霍。
func TestClientRequestsGoThroughLimiter(t *testing.T) {
	now := time.Unix(1700000000, 0)
	var waits []time.Duration
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n := atomic.AddInt32(&hits, 1); n <= 2 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.Write([]byte(`{"result":[]}`))
	}))
	defer srv.Close()

	c, _ := testClient(t, srv.URL, false, func(o *Options) {
		o.RPS = 1
		o.Burst = 1
		o.Retries = 2
		o.Sleep = func(context.Context, time.Duration) error { return nil } // 退避不真等
	})
	c.limiter.now = func() time.Time { return now }
	c.limiter.wait = func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}

	if _, err := c.ListActions(context.Background()); err != nil {
		t.Fatalf("请求应最终成功: %v", err)
	}
	// 桶容量 1：首发用掉初始令牌不排队，两次重试各自透支一档。
	// 若重试绕过限速闸，waits 会是空的——这条断言就是在盯这一点。
	want := []time.Duration{time.Second, 2 * time.Second}
	if len(waits) != len(want) {
		t.Fatalf("两次重试应各过一次限速闸，实际 %v，期望 %v", waits, want)
	}
	for i, w := range want {
		if waits[i] != w {
			t.Errorf("第 %d 次重试排队 %v，期望 %v", i+1, waits[i], w)
		}
	}
}
