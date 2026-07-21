/* =========================================================
 * SW 采集队列监控页面
 *
 * 数据流:
 *   页面 ──sendMessage──→ SW(getCollectManagerState)
 *                          │
 *                          ←─broadcast── (collectDone/queuePaused/queueResumed)
 *   页面 ←─onMessage──────────┘
 *
 * 5 秒自动轮询 getCollectManagerState,展示队列实时状态
 * ========================================================= */
(() => {
  'use strict';

  // ─── DOM refs ───
  const $ = (id) => document.getElementById(id);
  const swDot = $('sw-dot');
  const swText = $('sw-text');
  const autoStatus = $('auto-status');
  const btnRefresh = $('btn-refresh');
  const btnClearAntibot = $('btn-clear-antibot');
  const btnClearFinished = $('btn-clear-finished');
  const autoRefresh = $('auto-refresh');
  const lastUpdate = $('last-update');
  const authNotice = $('auth-notice');
  const authNoticeText = $('auth-notice-text');

  // stats
  const statTotal = $('stat-total');
  const statPending = $('stat-pending');
  const statRunning = $('stat-running');
  const statFinished = $('stat-finished');
  const statToday = $('stat-today');
  const statPaused = $('stat-paused');
  const statRunningSku = $('stat-running-sku');
  const statNextRun = $('stat-next-run');

  // filters
  const fStatus = $('f-status');
  const fSource = $('f-source');
  const fStore = $('f-store');
  const fSku = $('f-sku');
  const filterStat = $('filter-stat');
  const btnResetFilter = $('btn-reset-filter');

  // table
  const taskCount = $('task-count');
  const queueTbody = $('queue-tbody');
  const emptyHint = $('empty-hint');

  // rate config
  const rateMin = $('rate-min');
  const rateMax = $('rate-max');
  const ratePerday = $('rate-perday');
  const rateHint = $('rate-hint');

  // collect switches
  const swDeep = $('sw-deep-toggle');
  const swShallow = $('sw-shallow-toggle');

  // ─── State ───
  /** @type {Array} SW 队列里所有任务 */
  let allTasks = [];
  let pollTimer = null;
  let isPolling = false;
  // 倒计时状态(由 fetchState 更新,由 countdownTimer 每秒渲染)
  let nextRunAt = 0; // 0 = 无下次执行(队列空/暂停/熔断)
  let countdownTimer = null;

  // ─── Generic helpers ───
  const hasRuntime = typeof chrome !== 'undefined' && !!chrome.runtime;
  const sendMessage = (payload) =>
    new Promise((resolve) => {
      if (!hasRuntime) {
        resolve({ ok: false, error: 'chrome.runtime unavailable (not extension context)' });
        return;
      }
      try {
        chrome.runtime.sendMessage(payload, resolve);
      } catch (e) {
        resolve({ ok: false, error: e?.message || String(e) });
      }
    });

  const showNotice = (text) => {
    authNoticeText.textContent = text;
    authNotice.style.display = 'block';
  };
  const hideNotice = () => {
    authNotice.style.display = 'none';
  };

  const escapeHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  // 时间格式化:同天 HH:mm:ss,跨天 MM-DD HH:mm
  const formatTime = (ts) => {
    if (!ts) return '-';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const pad = (n) => String(n).padStart(2, '0');
    if (sameDay) {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // 耗时格式化:小于 60s 显示秒,否则显示 m:ss
  const formatDuration = (startedAt, finishedAt) => {
    if (!startedAt) return '-';
    const end = finishedAt || Date.now();
    const sec = Math.floor((end - startedAt) / 1000);
    if (sec < 0) return '-';
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m${String(s).padStart(2, '0')}s`;
  };

  // ─── 状态/来源 badge 渲染 ───
  const renderStatusBadge = (status) => {
    const map = {
      pending: { cls: 'status-pending', text: '待采集' },
      failed_retry: { cls: 'status-pending', text: '重试中' },
      running: { cls: 'status-running', text: '采集中' },
      success: { cls: 'status-success', text: '成功' },
      partial: { cls: 'status-partial', text: '部分' },
      failed_final: { cls: 'status-failed', text: '失败' },
      failed_partial: { cls: 'status-partial', text: '部分失败' },
      failed: { cls: 'status-failed', text: '失败' },
      skipped: { cls: 'status-skipped', text: '跳过' },
      antibot: { cls: 'status-antibot', text: '反爬' },
    };
    const m = map[status] || map.pending;
    return `<span class="status-badge ${m.cls}">${m.text}</span>`;
  };

  const renderSourceBadge = (source) => {
    if (source === 'manual') {
      return '<span class="source-badge source-manual">手动</span>';
    }
    return '<span class="source-badge source-shop-page">自动</span>';
  };

  // ─── 筛选 ───
  const applyFilters = (list) => {
    const statusFilter = fStatus.value;
    const sourceFilter = fSource.value;
    const storeFilter = fStore.value.trim().toLowerCase();
    const skuFilter = fSku.value.trim().toLowerCase();

    return list.filter((t) => {
      if (statusFilter && t.status !== statusFilter) return false;
      if (sourceFilter && t.source !== sourceFilter) return false;
      if (
        storeFilter &&
        !String(t.sellerSlug || '')
          .toLowerCase()
          .includes(storeFilter)
      )
        return false;
      if (
        skuFilter &&
        !String(t.sku || '')
          .toLowerCase()
          .includes(skuFilter)
      )
        return false;
      return true;
    });
  };

  // ─── 渲染表格 ───
  const renderTable = () => {
    const filtered = applyFilters(allTasks);
    filterStat.textContent = `${filtered.length} / ${allTasks.length}`;
    taskCount.textContent = String(filtered.length);

    if (!filtered.length) {
      queueTbody.innerHTML =
        '<tr><td colspan="10" style="text-align:center;color:#86909c;padding:24px">无符合条件的任务</td></tr>';
      return;
    }

    // 排序:running 最前 → pending → 其他按 finishedAt 倒序
    const statusOrder = { running: 0, pending: 1, failed_retry: 2 };
    filtered.sort((a, b) => {
      const oa = statusOrder[a.status] ?? 3;
      const ob = statusOrder[b.status] ?? 3;
      if (oa !== ob) return oa - ob;
      // 同组内:running/ pending 按 createdAt 升序,其他按 finishedAt 倒序
      if (oa <= 2) return (a.createdAt || 0) - (b.createdAt || 0);
      return (b.finishedAt || 0) - (a.finishedAt || 0);
    });

    queueTbody.innerHTML = filtered
      .map((t) => {
        const runningClass = t.status === 'running' ? ' is-running' : '';
        const sourceBadge = renderSourceBadge(t.source);
        const statusBadge = renderStatusBadge(t.status);
        const attempts = `${t.attempts || 0}/${t.maxAttempts || 3}`;
        const created = formatTime(t.createdAt);
        const started = formatTime(t.startedAt);
        const finished = formatTime(t.finishedAt);
        const duration = formatDuration(t.startedAt, t.finishedAt);
        const error = t.lastError
          ? `<td class="cell-error" title="${escapeHtml(t.lastError)}">${escapeHtml(t.lastError)}</td>`
          : '<td class="cell-empty">-</td>';

        return `<tr class="queue-row${runningClass}" data-sku="${escapeHtml(t.sku)}">
          <td><span class="cell-sku">${escapeHtml(t.sku)}</span></td>
          <td><span class="cell-store">${escapeHtml(t.sellerId || '-')}</span></td>
          <td>${sourceBadge}</td>
          <td>${statusBadge}</td>
          <td class="cell-mono">${attempts}</td>
          <td class="cell-mono">${created}</td>
          <td class="cell-mono">${started}</td>
          <td class="cell-mono">${finished}</td>
          <td class="cell-mono">${duration}</td>
          ${error}
        </tr>`;
      })
      .join('');
  };

  // ─── 采集开关(深度/浅度) ──────────────────────────────
  // 与 popup / MY 采集器面板共用同一份配置(autoCollectRunning / shallowCollectRunning),
  // 通过 autoCollectSetConfig 保存到 SW,SW 广播 configChanged 后各端同步。
  const renderSwitches = (d) => {
    if (swDeep && document.activeElement !== swDeep) {
      swDeep.checked = !!d?.autoCollectRunning;
    }
    if (swShallow && document.activeElement !== swShallow) {
      swShallow.checked = d?.shallowCollectRunning !== false;
    }
  };

  swDeep?.addEventListener('change', async () => {
    try {
      await sendMessage({ action: 'autoCollectSetConfig', config: { autoCollectRunning: swDeep.checked } });
      await fetchState();
    } catch (e) {
      // 失败回滚
      await fetchState();
    }
  });

  swShallow?.addEventListener('change', async () => {
    try {
      await sendMessage({ action: 'autoCollectSetConfig', config: { shallowCollectRunning: swShallow.checked } });
      await fetchState();
    } catch (e) {
      await fetchState();
    }
  });

  // ─── 限速配置 ──────────────────────────────────────────
  // 与 popup 限速配置一致:队列间隔 min~max(秒,每次随机),每日上限。
  // min/max 与 input 的 min/max 属性保持一致 [5, 120],超界不写入并提示。
  // 兼容旧字段 consumeRateSec:读取时若 min/max 不存在则用 consumeRateSec 作为 min=max。
  const RATE_RANGE = { min: 5, max: 120 };

  let _rateHintTimer = null;
  const showRateHint = (text, kind) => {
    if (!rateHint) return;
    rateHint.textContent = text;
    rateHint.className = 'ratecfg-hint' + (kind ? ' is-' + kind : '');
    if (_rateHintTimer) clearTimeout(_rateHintTimer);
    _rateHintTimer = setTimeout(() => {
      rateHint.textContent = '';
      rateHint.className = 'ratecfg-hint';
      _rateHintTimer = null;
    }, 2000);
  };

  // 读取队列间隔范围(秒):优先 consumeRateMinSec/consumeRateMaxSec,fallback 到 consumeRateSec
  const getRateRangeFromState = (d) => {
    let lo = d?.consumeRateMinSec;
    let hi = d?.consumeRateMaxSec;
    if (lo == null || hi == null) {
      const single = d?.consumeRateSec;
      lo = single;
      hi = single;
    }
    lo = Number(lo);
    hi = Number(hi);
    if (!Number.isFinite(lo)) lo = 5;
    if (!Number.isFinite(hi)) hi = 15;
    lo = Math.max(RATE_RANGE.min, Math.min(RATE_RANGE.max, lo));
    hi = Math.max(RATE_RANGE.min, Math.min(RATE_RANGE.max, hi));
    if (lo > hi) {
      const t = lo;
      lo = hi;
      hi = t;
    }
    return { min: lo, max: hi };
  };

  // 渲染限速输入框(用户正在编辑的字段跳过,避免输入被打断)
  const renderRateConfig = (d) => {
    if (rateMin && document.activeElement !== rateMin) {
      const range = getRateRangeFromState(d);
      rateMin.value = range.min;
    }
    if (rateMax && document.activeElement !== rateMax) {
      const range = getRateRangeFromState(d);
      rateMax.value = range.max;
    }
    if (ratePerday && document.activeElement !== ratePerday) {
      const v = d?.perDayLimit;
      if (typeof v === 'number') ratePerday.value = v;
      else if (v != null) ratePerday.value = String(v);
    }
  };

  // 保存限速配置到 SW(走 autoCollectSetConfig,SW 会同步到 queueMeta)
  const saveAutoCollectConfig = async (cfg) => {
    const resp = await sendMessage({ action: 'autoCollectSetConfig', config: cfg });
    return resp?.ok === true;
  };

  // 队列间隔范围(min~max)change 事件:任意一边变化都校验两边并一起保存
  const saveRateRange = async () => {
    const rawMin = (rateMin?.value || '').trim();
    const rawMax = (rateMax?.value || '').trim();
    if (rawMin === '' || rawMax === '') return; // 任一为空不保存(等用户填齐)
    let lo = Number(rawMin);
    let hi = Number(rawMax);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      showRateHint('队列间隔: 非数字', 'err');
      return;
    }
    if (lo < RATE_RANGE.min || lo > RATE_RANGE.max || hi < RATE_RANGE.min || hi > RATE_RANGE.max) {
      showRateHint(`队列间隔: 范围 [${RATE_RANGE.min}, ${RATE_RANGE.max}]`, 'err');
      return;
    }
    if (lo > hi) {
      // 自动互换而非报错(与 popup / collector-panel 行为一致)
      const t = lo;
      lo = hi;
      hi = t;
      if (rateMin) rateMin.value = lo;
      if (rateMax) rateMax.value = hi;
    }
    try {
      const ok = await saveAutoCollectConfig({ consumeRateMinSec: lo, consumeRateMaxSec: hi });
      showRateHint(ok ? '队列间隔 已保存' : '队列间隔 保存失败', ok ? 'ok' : 'err');
      if (ok) fetchState();
    } catch (e) {
      showRateHint('队列间隔 保存失败', 'err');
    }
  };

  // 每日上限 change 事件
  const saveRatePerday = async () => {
    const raw = (ratePerday?.value || '').trim();
    if (raw === '') return;
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      showRateHint('每日上限: 非数字', 'err');
      return;
    }
    if (num < 0 || num > 100000) {
      showRateHint('每日上限: 范围 [0, 100000]', 'err');
      return;
    }
    try {
      const ok = await saveAutoCollectConfig({ perDayLimit: num });
      showRateHint(ok ? '每日上限 已保存' : '每日上限 保存失败', ok ? 'ok' : 'err');
      if (ok) fetchState();
    } catch (e) {
      showRateHint('每日上限 保存失败', 'err');
    }
  };

  rateMin?.addEventListener('change', saveRateRange);
  rateMax?.addEventListener('change', saveRateRange);
  ratePerday?.addEventListener('change', saveRatePerday);

  // ─── 渲染概览 ───
  const renderStats = (d) => {
    statTotal.textContent = String(d.totalCount || 0);
    statPending.textContent = String(d.pendingCount || 0);
    statRunning.textContent = String(d.runningSkus?.length || 0);
    statFinished.textContent = String(d.finishedCount || 0);
    statToday.textContent = `${d.todayCount || 0} / ${d.perDayLimit || 0}`;

    // 队列状态
    const now = Date.now();
    if (now < (d.circuitBreakerUntil || 0)) {
      const remainSec = Math.ceil((d.circuitBreakerUntil - now) / 1000);
      statPaused.innerHTML = `<span style="color:var(--error-fg)">熔断 ${remainSec}s</span>`;
    } else if (d.consumePaused) {
      statPaused.innerHTML = '<span style="color:var(--warning-fg)">已暂停</span>';
    } else if (d.todayCount >= d.perDayLimit) {
      statPaused.innerHTML = '<span style="color:var(--warning-fg)">达上限</span>';
    } else {
      statPaused.innerHTML = '<span style="color:var(--success-fg)">运行中</span>';
    }

    // 正在采集 SKU
    const runningSkus = d.runningSkus || [];
    statRunningSku.textContent = runningSkus.length ? runningSkus.join(', ') : '—';

    // 自动采集状态
    autoStatus.textContent = `自动采集: ${d.autoCollectRunning ? '开' : '关'}`;
    autoStatus.style.color = d.autoCollectRunning ? 'var(--success-fg)' : 'var(--ink-3)';

    // 计算下次执行时间(用于 1s 倒计时渲染)
    // 规则:
    //   - 有 pending 任务 + 队列未暂停/未熔断 → nextRunAt = lastConsumeAt + interval*1000
    //     interval 优先用 consumeRateMinSec/consumeRateMaxSec 的中点(展示用,SW 实际随机);
    //     fallback 到 consumeRateSec
    //   - 熔断中 → nextRunAt = circuitBreakerUntil
    //   - 暂停/达上限/无 pending → nextRunAt = 0(显示"—")
    // 注:now 已在上方"队列状态"段声明,此处复用
    const hasPending = (d.pendingCount || 0) > 0;
    if (now < (d.circuitBreakerUntil || 0)) {
      nextRunAt = d.circuitBreakerUntil;
    } else if (hasPending && !d.consumePaused && d.todayCount < d.perDayLimit) {
      const range = getRateRangeFromState(d);
      const interval = Math.round((range.min + range.max) / 2) * 1000;
      nextRunAt = (d.lastConsumeAt || 0) + interval;
      // 如果已过预计时间(SW 还没调度到),显示 "即将执行"
      if (nextRunAt < now) nextRunAt = now + 500;
    } else {
      nextRunAt = 0;
    }
    renderCountdown();
  };

  // ─── 倒计时渲染(每秒更新 stat-next-run) ───
  const renderCountdown = () => {
    if (!nextRunAt) {
      statNextRun.textContent = '—';
      statNextRun.style.color = 'var(--ink-3)';
      return;
    }
    const now = Date.now();
    const remain = nextRunAt - now;
    if (remain <= 0) {
      statNextRun.textContent = '即将执行';
      statNextRun.style.color = 'var(--primary)';
      return;
    }
    const sec = Math.ceil(remain / 1000);
    if (sec < 60) {
      statNextRun.textContent = `${sec}s`;
    } else {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      statNextRun.textContent = `${m}m${String(s).padStart(2, '0')}s`;
    }
    statNextRun.style.color = 'var(--primary)';
  };

  // ─── 拉取队列状态 ───
  const fetchState = async () => {
    if (isPolling) return;
    isPolling = true;
    try {
      const resp = await sendMessage({ action: 'getCollectManagerState' });
      if (resp?.ok && resp.data) {
        const d = resp.data;
        allTasks = Array.isArray(d.tasks) ? d.tasks : [];
        renderStats(d);
        renderTable();
        renderSwitches(d);
        renderRateConfig(d);
        emptyHint.style.display = 'none';

        // SW 连接状态
        swDot.parentElement.classList.add('is-on');
        swDot.parentElement.classList.remove('is-off');
        swText.textContent = 'SW 已连接';

        // 暂停 notice
        const now = Date.now();
        if (now < (d.circuitBreakerUntil || 0)) {
          const remainSec = Math.ceil((d.circuitBreakerUntil - now) / 1000);
          showNotice(`检测到反爬熔断,采集将暂停 ${remainSec} 秒`);
        } else if (d.todayCount >= d.perDayLimit) {
          showNotice(`已达每日上限(${d.perDayLimit}),次日自动恢复`);
        } else {
          hideNotice();
        }

        // 更新时间
        const ts = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        lastUpdate.textContent = `最后更新: ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;
      } else {
        swDot.parentElement.classList.add('is-off');
        swDot.parentElement.classList.remove('is-on');
        swText.textContent = 'SW 未响应';
      }
    } catch (e) {
      swDot.parentElement.classList.add('is-off');
      swText.textContent = 'SW 连接失败';
    } finally {
      isPolling = false;
    }
  };

  // ─── 强制清除反爬熔断状态 ───
  const clearAntibot = async () => {
    if (
      !confirm(
        '确认强制清除反爬熔断状态?\n\n将重置:\n· circuitBreakerUntil → 0\n· consumePaused → false\n· config.paused/pausedUntil → false/0\n\n注意:如果 Ozon 仍在反爬,下次请求可能再次触发熔断。'
      )
    )
      return;
    btnClearAntibot.disabled = true;
    try {
      const resp = await sendMessage({ action: 'clearAntibotState' });
      if (resp?.ok) {
        await fetchState();
      } else {
        showNotice('清除反爬状态失败: ' + (resp?.error || '未知错误'));
      }
    } finally {
      btnClearAntibot.disabled = false;
    }
  };

  // ─── 清空已完成 ───
  const clearFinished = async () => {
    if (!confirm('确认清空队列中所有已完成(success/partial/failed/skipped/antibot)的任务?')) return;
    btnClearFinished.disabled = true;
    try {
      const resp = await sendMessage({ action: 'clearFinishedQueueTasks' });
      if (resp?.ok) {
        await fetchState();
      } else {
        showNotice('清空失败: ' + (resp?.error || '未知错误'));
      }
    } finally {
      btnClearFinished.disabled = false;
    }
  };

  // ─── 轮询控制 ───
  const startPolling = () => {
    stopPolling();
    pollTimer = setInterval(fetchState, 5000);
    // 倒计时定时器:每秒更新下次执行倒计时(独立于 5s 轮询,提升体验)
    if (!countdownTimer) {
      countdownTimer = setInterval(renderCountdown, 1000);
    }
  };
  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };

  // ─── 事件绑定 ───
  btnRefresh.addEventListener('click', fetchState);
  btnClearAntibot.addEventListener('click', clearAntibot);
  btnClearFinished.addEventListener('click', clearFinished);
  autoRefresh.addEventListener('change', () => {
    if (autoRefresh.checked) startPolling();
    else stopPolling();
  });
  fStatus.addEventListener('change', renderTable);
  fSource.addEventListener('change', renderTable);
  fStore.addEventListener('input', renderTable);
  fSku.addEventListener('input', renderTable);
  btnResetFilter.addEventListener('click', () => {
    fStatus.value = '';
    fSource.value = '';
    fStore.value = '';
    fSku.value = '';
    renderTable();
  });

  // ─── 初始化 ───
  fetchState().then(() => {
    if (autoRefresh.checked) startPolling();
  });
})();
