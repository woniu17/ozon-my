// 极掌采集器 — AutoScroller (P1)
//
// 用法:
//   const scroller = new window.QXAutoScroller({
//     queue: jzTaskQueue,                 // 必传, 用于联动节流
//     intervalMs: 3000,                   // 每 3 秒滚一次
//     emptyThreshold: 5,                  // 连续 N 次 scroll 没新卡片 → onEmpty
//     getCardCount: () => documentCardCount(),  // 必传, 返回当前页面已渲染的卡片数
//     onEmpty: () => { ... },             // 可选, 触发关键词跳下一个
//     onCongestionPause: () => { ... },   // 可选, 队列拥塞导致自动暂停时回调
//   });
//   scroller.start();   // 用户主动启动
//   scroller.stop();    // 用户主动停止 (彻底关掉, 也清掉空轮计数)
//
// 行为:
//   1. 每 intervalMs 调用 scrollTo(底部)
//   2. 订阅 queue.on('congestion'):
//        high → autoPause (不是 stop, 区别于用户 stop)
//        low  → 如果是 autoPause 进入的, 则 autoResume
//   3. 用户手动 stop 后, 即使 low 也不会自动复活
//   4. 每次 scroll 后等待 1.5s 检查 cardCount 是否增长; 不增长 emptyStreak++; 增长则清零
//   5. emptyStreak >= emptyThreshold → onEmpty (然后 stop)

(() => {
  if (window.QXAutoScroller) return;

  class QXAutoScroller {
    constructor(opts = {}) {
      if (!opts.queue) throw new Error('QXAutoScroller: queue required');
      if (typeof opts.getCardCount !== 'function') throw new Error('QXAutoScroller: getCardCount required');

      this.queue = opts.queue;
      // 翻页间隔(毫秒),支持范围随机:优先用 intervalMinMs/intervalMaxMs,缺省时 fallback 到 intervalMs
      // 用户在面板配置 min~max 秒,每次 tick 末尾 _scheduleNext 时取 [min, max] 内随机值
      // 兼容旧调用:仅传 intervalMs 时视为 min=max=intervalMs(固定间隔)
      this.intervalMinMs = opts.intervalMinMs ?? null;
      this.intervalMaxMs = opts.intervalMaxMs ?? null;
      this.intervalMs = opts.intervalMs ?? 3000; // 兼容字段:仅当 min/max 未设置时使用
      this.settleMs = opts.settleMs ?? 2500;
      this.scrollStepRatio = opts.scrollStepRatio ?? 0.75;
      this.minScrollStepPx = opts.minScrollStepPx ?? 480;
      this.emptyThreshold = opts.emptyThreshold ?? 5;
      this.getCardCount = opts.getCardCount;
      this.isReadyToScroll = opts.isReadyToScroll || (() => true);
      this.readinessPollMs = opts.readinessPollMs ?? 1000;
      this.maxReadinessWaitMs = opts.maxReadinessWaitMs ?? 0;
      this.onEmpty = opts.onEmpty || (() => {});
      this.onCongestionPause = opts.onCongestionPause || (() => {});

      this._timer = null;
      this._userActive = false; // 用户意图：true=想跑
      this._autoPaused = false; // 是否被节流自动暂停
      this._emptyStreak = 0;
      this._lastCardCount = 0;
      this._waitingReadySince = 0;
      this._unsubCongestion = null;
      // 翻页状态追踪（供 getScrollStatus 读取）
      this._nextTickReason = null; // 'interval'|'waiting-ready'|'waiting-queue'
      this._nextTickAt = 0; // 下次 tick 触发的时间戳(供 interval 倒计时)
      this._settleUntil = 0; // 等待卡片渲染的截止时间戳
      this._completedReason = null; // 自动完成原因: 'empty'|null
    }

    start() {
      if (this._userActive) {
        console.log('[QXAutoScroller] start() skipped (already active)');
        return;
      }
      this._userActive = true;
      this._autoPaused = false;
      this._emptyStreak = 0;
      this._waitingReadySince = 0;
      this._nextTickReason = null;
      this._settleUntil = 0;
      this._completedReason = null;
      this._lastCardCount = this.getCardCount();
      this._unsubCongestion = this.queue.on('congestion', (e) => this._onCongestion(e));
      console.log('[QXAutoScroller] start() ok, lastCardCount=', this._lastCardCount);
      this._scheduleNext(0, 'interval'); // 立即滚一次
    }

    stop() {
      console.log(
        '[QXAutoScroller] stop() called',
        'wasUserActive=',
        this._userActive,
        'wasAutoPaused=',
        this._autoPaused
      );
      this._userActive = false;
      this._autoPaused = false;
      this._emptyStreak = 0;
      this._waitingReadySince = 0;
      this._nextTickReason = null;
      this._nextTickAt = 0;
      this._settleUntil = 0;
      this._completedReason = null;
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      if (this._unsubCongestion) {
        this._unsubCongestion();
        this._unsubCongestion = null;
      }
    }

    isRunning() {
      return this._userActive && !this._autoPaused;
    }

    isUserActive() {
      return this._userActive;
    }

    isAutoPaused() {
      return this._autoPaused;
    }

    // 返回当前翻页状态，供面板展示
    // { status: 'idle'|'disabled'|'scrolling'|'congested'|'waiting-ready'|'waiting-queue'|'completed', reason, detail }
    getScrollStatus() {
      if (!this._userActive) {
        if (this._completedReason === 'empty') {
          return { status: 'completed', reason: '当前页已抓取完成', detail: '' };
        }
        return { status: 'idle', reason: '未启动', detail: '' };
      }
      if (this._autoPaused) {
        var stats = typeof this.queue.stats === 'function' ? this.queue.stats() : null;
        return {
          status: 'congested',
          reason: '队列拥塞，等待采集跟上',
          detail: stats ? stats.running + ' 进行中 / ' + stats.pending + ' 排队' : '',
        };
      }
      var now = Date.now();
      // 等待卡片渲染中
      if (this._settleUntil && now < this._settleUntil) {
        var remainMs = Math.max(0, this._settleUntil - now);
        var remainSec = (remainMs / 1000).toFixed(1);
        return { status: 'scrolling', reason: '翻页中，等待新卡片渲染', detail: remainSec + 's' };
      }
      switch (this._nextTickReason) {
        case 'waiting-ready': {
          if (!this._waitingReadySince) {
            return { status: 'waiting-ready', reason: '等待视口数据就绪', detail: '' };
          }
          var waited = Math.max(0, Math.round((now - this._waitingReadySince) / 1000));
          var isTimeout = this.maxReadinessWaitMs && now - this._waitingReadySince >= this.maxReadinessWaitMs;
          return {
            status: isTimeout ? 'scrolling' : 'waiting-ready',
            reason: isTimeout ? '就绪等待超时，继续翻页' : '等待视口数据就绪 (' + waited + 's)',
            detail: '',
          };
        }
        case 'waiting-queue': {
          var qStats = typeof this.queue.stats === 'function' ? this.queue.stats() : null;
          return {
            status: 'waiting-queue',
            reason: '等待采集队列空闲',
            detail: qStats ? qStats.running + ' 进行中 / ' + qStats.pending + ' 排队' : '',
          };
        }
        default: {
          // 正常翻页间隔中:显示距下次滚动的倒计时
          var detail = '';
          if (this._nextTickAt) {
            var remainMs = Math.max(0, this._nextTickAt - Date.now());
            var remainSec = Math.round(remainMs / 1000);
            detail = remainSec + 's';
          }
          return { status: 'scrolling', reason: '正常翻页中，距下次滚动还有', detail: detail };
        }
      }
    }

    _onCongestion({ level, stats }) {
      console.log(
        '[QXAutoScroller] _onCongestion',
        'level=',
        level,
        'userActive=',
        this._userActive,
        'autoPaused=',
        this._autoPaused,
        'stats=',
        stats
      );
      if (!this._userActive) {
        console.log('[QXAutoScroller] _onCongestion skip (user not active)');
        return;
      }
      if (level === 'high' && !this._autoPaused) {
        this._autoPaused = true;
        if (this._timer) {
          clearTimeout(this._timer);
          this._timer = null;
        }
        console.log('[QXAutoScroller] → autoPaused=true (翻页已暂停)', stats);
        try {
          this.onCongestionPause('paused');
        } catch {}
      } else if (level === 'low' && this._autoPaused) {
        this._autoPaused = false;
        console.log('[QXAutoScroller] → autoPaused=false (翻页将恢复)', stats);
        try {
          this.onCongestionPause('resumed');
        } catch {}
        this._scheduleNext(this._getNextInterval());
      } else {
        console.log('[QXAutoScroller] _onCongestion no-op');
      }
    }

    _scheduleNext(delay, reason) {
      if (this._timer) clearTimeout(this._timer);
      this._nextTickReason = reason || 'interval';
      this._nextTickAt = Date.now() + delay;
      this._timer = setTimeout(() => this._tick(), delay);
    }

    // 计算下一次翻页的间隔(毫秒)
    // 优先用 [intervalMinMs, intervalMaxMs] 范围随机(反爬+拟人化);
    // 若未配置范围则 fallback 到固定值 intervalMs(兼容旧调用)
    _getNextInterval() {
      var lo = this.intervalMinMs;
      var hi = this.intervalMaxMs;
      if (lo != null && hi != null && hi >= lo) {
        return lo + Math.random() * (hi - lo);
      }
      return this.intervalMs;
    }

    async _tick() {
      this._timer = null;
      if (!this._userActive || this._autoPaused) {
        console.log(
          '[QXAutoScroller] _tick early-return',
          'userActive=',
          this._userActive,
          'autoPaused=',
          this._autoPaused
        );
        return;
      }

      let readyToScroll = true;
      try {
        readyToScroll = this.isReadyToScroll();
      } catch (e) {
        console.log('[QXAutoScroller] isReadyToScroll throw:', e);
        readyToScroll = false;
      }
      if (!readyToScroll) {
        const now = Date.now();
        if (!this._waitingReadySince) this._waitingReadySince = now;
        const waited = now - this._waitingReadySince;
        if (!this.maxReadinessWaitMs || waited < this.maxReadinessWaitMs) {
          console.log(
            '[QXAutoScroller] _tick wait (not ready)',
            'waitedMs=',
            waited,
            'maxWaitMs=',
            this.maxReadinessWaitMs
          );
          this._scheduleNext(this.readinessPollMs, 'waiting-ready');
          return;
        }
        console.log('[QXAutoScroller] _tick readiness timeout, force proceed');
        this._waitingReadySince = 0;
      } else {
        this._waitingReadySince = 0;
      }

      const stats = typeof this.queue.stats === 'function' ? this.queue.stats() : null;
      if (stats && (stats.running > 0 || stats.pending > 0)) {
        console.log('[QXAutoScroller] _tick wait (queue busy)', 'running=', stats.running, 'pending=', stats.pending);
        this._scheduleNext(this.readinessPollMs, 'waiting-queue');
        return;
      }

      const beforeCount = this._lastCardCount;
      // 滚到底部触发懒加载
      const scroller = document.scrollingElement || document.documentElement || document.body;
      const scrollStep = Math.max(this.minScrollStepPx, Math.floor((window.innerHeight || 800) * this.scrollStepRatio));
      // 二次校验: 上面 isReadyToScroll / queue.stats 检查后到此处之间, 用户可能已点 stop.
      // 不校验会导致 stop 后仍触发一次 scrollBy, 用户看到"停止后还翻页".
      if (!this._userActive || this._autoPaused) {
        console.log(
          '[QXAutoScroller] _tick pre-scroll return',
          'userActive=',
          this._userActive,
          'autoPaused=',
          this._autoPaused
        );
        return;
      }
      try {
        window.scrollBy({ top: scrollStep, behavior: 'smooth' });
      } catch (e) {
        // some pages override scrollTo, fall back
        scroller.scrollTop += scrollStep;
      }
      console.log('[QXAutoScroller] scrolled', 'step=', scrollStep, 'beforeCount=', beforeCount);

      // 等卡片渲染（settleMs）后再检查
      this._settleUntil = Date.now() + this.settleMs;
      await new Promise((r) => setTimeout(r, this.settleMs));
      this._settleUntil = 0;
      if (!this._userActive || this._autoPaused) {
        console.log(
          '[QXAutoScroller] _tick post-settle return',
          'userActive=',
          this._userActive,
          'autoPaused=',
          this._autoPaused
        );
        return;
      }

      const nowCount = this.getCardCount();
      const nearBottom = scroller.scrollTop + window.innerHeight >= scroller.scrollHeight - 800;
      console.log(
        '[QXAutoScroller] settle check',
        'nowCount=',
        nowCount,
        'beforeCount=',
        beforeCount,
        'nearBottom=',
        nearBottom,
        'emptyStreak=',
        this._emptyStreak
      );
      if (nowCount > beforeCount) {
        this._emptyStreak = 0;
        this._lastCardCount = nowCount;
      } else if (nearBottom) {
        this._emptyStreak++;
        if (this._emptyStreak >= this.emptyThreshold) {
          // 触发 onEmpty 然后停止
          console.log('[QXAutoScroller] → onEmpty triggered, emptyStreak=', this._emptyStreak);
          const cb = this.onEmpty;
          this.stop();
          this._completedReason = 'empty';
          try {
            await cb();
          } catch (e) {
            console.error('[QXAutoScroller] onEmpty error:', e);
          }
          return;
        }
      } else {
        this._emptyStreak = 0;
      }
      this._scheduleNext(this._getNextInterval(), 'interval');
    }
  }

  window.QXAutoScroller = QXAutoScroller;
})();
