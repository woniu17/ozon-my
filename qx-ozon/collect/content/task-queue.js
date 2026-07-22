// QX采集器 — TaskQueue 通用类
//
// 用法:
//   const q = new window.JZTaskQueue({ concurrency: 10, timeoutMs: 120000 });
//   q.on('stateChange', (stats) => console.log(stats));
//   q.on('congestion', ({ level }) => level === 'high' ? autoScroller.pause() : autoScroller.resume());
//   q.add('sku-12345', async () => { ... return data; });
//
// 状态机: pending → running → success | timeout | error
// 失败/超时进 failures Map，可手动 retry(taskId) 重新入队
// 自适应节流: running > autoPauseHigh 触发 'congestion' high；running ≤ autoPauseLow && pending ≤ pauseLowPending 触发 'congestion' low；hysteresis ≥ 2s

(() => {
  if (window.JZTaskQueue) return; // 防重入

  const STATES = {
    PENDING: 'pending',
    RUNNING: 'running',
    SUCCESS: 'success',
    TIMEOUT: 'timeout',
    ERROR: 'error',
  };

  class JZTaskQueue {
    constructor(opts = {}) {
      this.concurrency = opts.concurrency ?? 10;
      this.timeoutMs = opts.timeoutMs ?? 120000;
      this.autoPauseHigh = opts.autoPauseHigh ?? 10;
      this.autoPauseLow = opts.autoPauseLow ?? 5;
      this.pauseLowPending = opts.pauseLowPending ?? 10;
      this.hysteresisMs = opts.hysteresisMs ?? 2000;

      this.tasks = new Map(); // taskId → { id, fn, state, result, error, attempts, createdAt, startedAt, finishedAt, _resolveOuter, _rejectOuter, _outerPromise }
      this.failures = new Map(); // taskId → task (only failed/timeout)
      this.paused = false;

      this._listeners = new Map(); // event → Set<cb>
      this._pumping = false;
      this._congestionLevel = 'low';
      this._lastCongestionAt = 0;
    }

    on(event, cb) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event).add(cb);
      return () => this.off(event, cb);
    }

    off(event, cb) {
      this._listeners.get(event)?.delete(cb);
    }

    _emit(event, payload) {
      const set = this._listeners.get(event);
      if (!set) return;
      for (const cb of set) {
        try {
          cb(payload);
        } catch (e) {
          console.error('[JZTaskQueue]', event, 'listener error:', e);
        }
      }
    }

    add(taskId, fn) {
      // 去重: 已存在的 task 直接返回它的 outer promise
      const existing = this.tasks.get(taskId);
      if (existing) return existing._outerPromise;

      const task = {
        id: taskId,
        fn,
        state: STATES.PENDING,
        result: undefined,
        error: undefined,
        attempts: 0,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      };
      task._outerPromise = new Promise((resolve, reject) => {
        task._resolveOuter = resolve;
        task._rejectOuter = reject;
      });
      this.tasks.set(taskId, task);
      this.failures.delete(taskId); // 如果是从失败列表重试进来
      this._scheduleEmit();
      this._pump();
      return task._outerPromise;
    }

    retry(taskId) {
      const task = this.tasks.get(taskId);
      if (!task) return;
      if (task.state !== STATES.ERROR && task.state !== STATES.TIMEOUT) return;
      task.state = STATES.PENDING;
      task.error = undefined;
      task.startedAt = null;
      task.finishedAt = null;
      this.failures.delete(taskId);
      this._scheduleEmit();
      this._pump();
    }

    retryAllFailures() {
      for (const id of Array.from(this.failures.keys())) this.retry(id);
    }

    pause() {
      console.log('[JZTaskQueue] pause() called (用户手动暂停)', 'wasPaused=', this.paused);
      this.paused = true;
      this._scheduleEmit();
    }
    resume() {
      console.log('[JZTaskQueue] resume() called (用户手动恢复)', 'wasPaused=', this.paused);
      this.paused = false;
      this._pump();
      this._scheduleEmit();
    }

    clear() {
      // 清空全部（包括运行中的：抛弃 outer promise 的等待者会一直挂着——调用方自负）
      this.tasks.clear();
      this.failures.clear();
      this._scheduleEmit();
    }

    stats() {
      let pending = 0,
        running = 0,
        success = 0,
        failed = 0;
      for (const t of this.tasks.values()) {
        switch (t.state) {
          case STATES.PENDING:
            pending++;
            break;
          case STATES.RUNNING:
            running++;
            break;
          case STATES.SUCCESS:
            success++;
            break;
          case STATES.TIMEOUT:
          case STATES.ERROR:
            failed++;
            break;
        }
      }
      return { pending, running, success, failed, total: this.tasks.size, paused: this.paused };
    }

    _scheduleEmit() {
      // 多次状态变更合并成一次 emit
      if (this._emitScheduled) return;
      this._emitScheduled = true;
      Promise.resolve().then(() => {
        this._emitScheduled = false;
        const stats = this.stats();
        this._emit('stateChange', stats);
        this._maybeEmitCongestion(stats);
        if (stats.pending === 0 && stats.running === 0) this._emit('drained', stats);
      });
    }

    _maybeEmitCongestion(stats) {
      const now = Date.now();
      // 例外:当前为 high 但队列已空(running=0 && pending=0)时,跳过滞后检查直接恢复,
      // 否则 high 刚触发后任务快速完成,low 事件被 hysteresis 跳过,翻页永久卡在拥塞暂停。
      const drainedFromHigh = this._congestionLevel === 'high' && stats.running === 0 && stats.pending === 0;
      if (!drainedFromHigh && now - this._lastCongestionAt < this.hysteresisMs) {
        console.log(
          '[JZTaskQueue] congestion skip(hysteresis)',
          'elapsed=',
          now - this._lastCongestionAt,
          'hysteresisMs=',
          this.hysteresisMs,
          'stats=',
          stats
        );
        return;
      }
      const isHigh =
        stats.running >= this.concurrency || stats.pending > this.pauseLowPending || stats.running > this.autoPauseHigh;
      const isLow = stats.running <= this.autoPauseLow && stats.pending <= this.pauseLowPending;
      console.log(
        '[JZTaskQueue] congestion eval',
        'running=',
        stats.running,
        'pending=',
        stats.pending,
        'concurrency=',
        this.concurrency,
        'autoPauseHigh=',
        this.autoPauseHigh,
        'autoPauseLow=',
        this.autoPauseLow,
        'pauseLowPending=',
        this.pauseLowPending,
        'isHigh=',
        isHigh,
        'isLow=',
        isLow,
        'curLevel=',
        this._congestionLevel
      );
      if (isHigh && this._congestionLevel !== 'high') {
        this._congestionLevel = 'high';
        this._lastCongestionAt = now;
        console.log('[JZTaskQueue] congestion → high (将暂停翻页)', stats);
        this._emit('congestion', { level: 'high', stats });
      } else if (isLow && this._congestionLevel !== 'low') {
        this._congestionLevel = 'low';
        this._lastCongestionAt = now;
        console.log('[JZTaskQueue] congestion → low (将恢复翻页)', stats);
        this._emit('congestion', { level: 'low', stats });
      }
    }

    async _pump() {
      if (this._pumping || this.paused) return;
      this._pumping = true;
      try {
        while (!this.paused) {
          const stats = this.stats();
          if (stats.running >= this.concurrency) break;
          // 找一个 pending
          let next = null;
          for (const t of this.tasks.values()) {
            if (t.state === STATES.PENDING) {
              next = t;
              break;
            }
          }
          if (!next) break;
          this._runTask(next); // 不 await，让多个并发跑起来
        }
      } finally {
        this._pumping = false;
      }
    }

    _runTask(task) {
      task.state = STATES.RUNNING;
      task.startedAt = Date.now();
      task.attempts++;
      this._scheduleEmit();

      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Task ${task.id} timeout after ${this.timeoutMs}ms`)),
          this.timeoutMs
        );
      });

      Promise.race([Promise.resolve().then(() => task.fn(task)), timeoutPromise])
        .then((result) => {
          clearTimeout(timer);
          task.state = STATES.SUCCESS;
          task.result = result;
          task.finishedAt = Date.now();
          this._emit('taskDone', { task, ok: true });
          task._resolveOuter(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          const isTimeout = err && /timeout/i.test(err.message);
          task.state = isTimeout ? STATES.TIMEOUT : STATES.ERROR;
          task.error = err;
          task.finishedAt = Date.now();
          this.failures.set(task.id, task);
          this._emit('taskDone', { task, ok: false });
          task._rejectOuter(err);
        })
        .finally(() => {
          this._scheduleEmit();
          this._pump();
        });
    }
  }

  window.JZTaskQueue = JZTaskQueue;
  window.JZTaskQueue.STATES = STATES;
})();
