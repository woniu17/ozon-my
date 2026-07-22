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
  const statNextRun = $('stat-next-run');

  // task window
  const taskWindow = $('task-window');
  const twEmpty = $('tw-empty');
  const windowStatusHint = $('window-status-hint');

  // filters
  const fStatus = $('f-status');
  const fSource = $('f-source');
  const fStore = $('f-store');
  const fSku = $('f-sku');
  const filterStat = $('filter-stat');
  const btnResetFilter = $('btn-reset-filter');
  const btnToggleFilter = $('btn-toggle-filter');
  const filterBody = $('filter-body');

  // table
  const queueTbody = $('queue-tbody');
  const emptyHint = $('empty-hint');

  // rate config
  const rateMin = $('rate-min');
  const rateMax = $('rate-max');
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
      running: { cls: 'status-running', text: '采集中' },
      success: { cls: 'status-success', text: '成功' },
      partial: { cls: 'status-partial', text: '部分' },
      failed: { cls: 'status-failed', text: '失败' },
      skipped: { cls: 'status-skipped', text: '跳过' },
      antibot: { cls: 'status-antibot', text: '反爬' },
    };
    const m = map[status] || map.pending;
    return `<span class="status-badge ${m.cls}">${m.text}</span>`;
  };

  const renderSourceBadge = (source) => {
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

  // ─── 渲染表格(筛选区,可折叠) ───
  const renderTable = () => {
    const filtered = applyFilters(allTasks);
    filterStat.textContent = `${filtered.length} / ${allTasks.length}`;

    if (!filtered.length) {
      queueTbody.innerHTML =
        '<tr><td colspan="10" style="text-align:center;color:#86909c;padding:24px">无符合条件的任务</td></tr>';
      return;
    }

    // 排序:running 最前 → pending → 其他按 finishedAt 倒序
    // 注:createdAt/finishedAt 是 ISO 字符串,需转时间戳再比较
    const _ts = (v) => (v ? new Date(v).getTime() : 0);
    const statusOrder = { running: 0, pending: 1 };
    filtered.sort((a, b) => {
      const oa = statusOrder[a.status] ?? 3;
      const ob = statusOrder[b.status] ?? 3;
      if (oa !== ob) return oa - ob;
      // 同组内:running/ pending 按 createdAt 升序,其他按 finishedAt 倒序
      if (oa <= 2) return _ts(a.createdAt) - _ts(b.createdAt);
      return _ts(b.finishedAt) - _ts(a.finishedAt);
    });

    queueTbody.innerHTML = filtered
      .map((t) => {
        const runningClass = t.status === 'running' ? ' is-running' : '';
        const sourceBadge = renderSourceBadge(t.source);
        const statusBadge = renderStatusBadge(t.status);
        const attempts = t.attempts != null ? `第${t.attempts}次` : '';
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
  // 与 popup / QX 采集器面板共用同一份配置(autoCollectRunning / shallowCollectRunning),
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
  // 与 popup 限速配置一致:队列间隔 min~max(秒,每次随机)。
  // min/max 与 input 的 min/max 属性保持一致 [5, 120],超界不写入并提示。
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

  // 读取队列间隔范围(秒):consumeRateMinSec/consumeRateMaxSec
  const getRateRangeFromState = (d) => {
    let lo = Number(d?.consumeRateMinSec);
    let hi = Number(d?.consumeRateMaxSec);
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

  rateMin?.addEventListener('change', saveRateRange);
  rateMax?.addEventListener('change', saveRateRange);

  // ─── 渲染队列任务窗口视图 ──────────────────────────────
  // 窗口式滑动展示 5 个 SKU(任务从左到右流动:左边等待 → 中间采集 → 右边完成):
  //   窗口位置:  [left-2]  [left-1]  [center]  [right-1]  [right-2]
  //   含义:      再下一个    下一个    采集中    最近完成    更早完成
  //
  //   - left-1(紧邻中间左侧):下一个要采集的 = pending[0](最早创建)
  //   - left-2(最左):再下一个要采集的 = pending[1]
  //   - center(中间):正在采集(running);无 running 时保留最近完成的任务状态
  //   - right-1(紧邻中间右侧):最近完成的 = finished[0](finishedAt 最新)
  //   - right-2(最右):更早完成的 = finished[1]
  //
  // 示例:窗口 A B C D E,采集顺序 E→D→C→B→A(C 正在采集)
  //   C 完成后窗口变成 X A B C D(X 新进入最左,B 升到 center,C 移到 right-1)
  // 徽章:成功(success/skipped)、失败(partial/failed)、采集中(running)、未采集(pending)
  // 每个槽位的视觉参数(scale/opacity),FLIP 动画用
  const SLOT_VIS = [
    { scale: 0.88, opacity: 0.65 }, // left-2
    { scale: 0.96, opacity: 0.9 },  // left-1
    { scale: 1, opacity: 1 },        // center
    { scale: 0.96, opacity: 0.9 },  // right-1
    { scale: 0.88, opacity: 0.65 }, // right-2
  ];
  const FLIP_DURATION = 450; // ms,需与 CSS transition 时长一致

  const renderTaskWindow = () => {
    const slots = taskWindow?.querySelectorAll('.tw-slot');
    if (!slots || !slots.length) return;

    // FLIP First:记录渲染前每个 slot 里卡片的 SKU 和屏幕位置
    const oldState = {}; // sku -> { rect, slotIdx }
    slots.forEach((slot, i) => {
      const card = slot.querySelector('.tw-card[data-sku]');
      if (card) {
        oldState[card.dataset.sku] = { rect: card.getBoundingClientRect(), slotIdx: i };
      }
    });

    // 分类
    // 注:createdAt/finishedAt 是 ISO 字符串(如 "2026-07-21T14:24:22.330Z"),
    // 不能直接用减法(字符串相减得 NaN,排序失效),必须转成时间戳。
    const ts = (v) => (v ? new Date(v).getTime() : 0);
    const running = allTasks.filter((t) => t.status === 'running');
    const finished = allTasks
      .filter((t) => ['success', 'skipped'].includes(t.status))
      .sort((a, b) => ts(b.finishedAt) - ts(a.finishedAt)); // 最近完成在前
    const pending = allTasks
      .filter((t) => t.status === 'pending')
      .sort((a, b) => ts(a.createdAt) - ts(b.createdAt)); // 早创建在前(下一个要采集)

    // 中间槽:优先 running,没有 running 时用最近完成的(保留完成状态,不空着)
    const hasRunning = running.length > 0;
    const centerTask = hasRunning ? running[0] : (finished[0] || null);
    // 如果中间槽用了 finished[0],右侧已完成从 finished[1] 开始偏移
    const finishedOffset = !hasRunning && finished.length > 0 ? 1 : 0;

    // 顺序:left-2, left-1, center, right-1, right-2
    const arranged = [
      pending[1] || null,                                    // left-2: 再下一个要采集
      pending[0] || null,                                    // left-1: 下一个要采集(紧邻中间)
      centerTask,                                             // center: 正在采集 / 刚完成(保留状态)
      finished[finishedOffset] || null,                      // right-1: 最近完成
      finished[finishedOffset + 1] || null,                  // right-2: 更早完成
    ];

    let filledCount = 0;
    slots.forEach((slot, i) => {
      const t = arranged[i];
      if (!t) {
        slot.innerHTML = '<div class="tw-card tw-card-empty"><span>—</span></div>';
        slot.classList.remove('is-filled');
        return;
      }
      filledCount++;
      slot.innerHTML = renderWindowCard(t, i === 2);
      slot.classList.add('is-filled');
    });

    // FLIP Last + Invert + Play:让卡片从旧位置平滑滑到新位置
    slots.forEach((slot, i) => {
      const card = slot.querySelector('.tw-card[data-sku]');
      if (!card) return;
      const sku = card.dataset.sku;
      const newVis = SLOT_VIS[i];
      const old = oldState[sku];

      // 清除上一轮 FLIP 残留的定时器
      if (card._flipTimer) {
        clearTimeout(card._flipTimer);
        card._flipTimer = null;
      }

      if (old) {
        // 同 SKU:从旧位置滑到新位置
        const newRect = card.getBoundingClientRect();
        const dx = old.rect.left - newRect.left;
        const dy = old.rect.top - newRect.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || old.slotIdx !== i) {
          const oldVis = SLOT_VIS[old.slotIdx];
          // Invert:用 inline transform 拉回旧位置(含旧 scale)
          card.style.transition = 'none';
          card.style.transform = `translate(${dx}px, ${dy}px) scale(${oldVis.scale})`;
          card.style.opacity = String(oldVis.opacity);
          // Play:下一帧滑到新位置
          requestAnimationFrame(() => {
            card.style.transition = `transform ${FLIP_DURATION}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${FLIP_DURATION}ms ease`;
            card.style.transform = `scale(${newVis.scale})`;
            card.style.opacity = String(newVis.opacity);
          });
          // 动画结束后清理 inline style,恢复 CSS 控制
          card._flipTimer = setTimeout(() => {
            card.style.transition = '';
            card.style.transform = '';
            card.style.opacity = '';
            card._flipTimer = null;
          }, FLIP_DURATION + 80);
        }
      } else {
        // 新进入的卡片:从左侧滑入 + 淡入
        card.style.transition = 'none';
        card.style.transform = `translateX(-30px) scale(${newVis.scale})`;
        card.style.opacity = '0';
        requestAnimationFrame(() => {
          card.style.transition = `transform ${FLIP_DURATION}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${FLIP_DURATION}ms ease`;
          card.style.transform = `scale(${newVis.scale})`;
          card.style.opacity = String(newVis.opacity);
        });
        card._flipTimer = setTimeout(() => {
          card.style.transition = '';
          card.style.transform = '';
          card.style.opacity = '';
          card._flipTimer = null;
        }, FLIP_DURATION + 80);
      }
    });

    if (twEmpty) twEmpty.style.display = filledCount === 0 ? '' : 'none';
    if (windowStatusHint) {
      const parts = [];
      if (running.length > 0) parts.push(`采集中 ${running.length}`);
      if (pending.length > 0) parts.push(`待采集 ${pending.length}`);
      if (finished.length > 0) parts.push(`已完成 ${finished.length}`);
      windowStatusHint.textContent = parts.join(' · ') || '—';
    }
  };

  // 渲染单个窗口卡片
  // isCenter:是否中间槽(采集中时样式加亮 + 进度脉冲;已完成任务保留在中间槽时不加脉冲)
  const renderWindowCard = (t, isCenter) => {
    const dom = t.domInfo || {};
    const title = dom.title || '(无标题)';
    const price =
      dom.price != null ? '¥' + Number(dom.price).toLocaleString('zh-CN') : '-';
    const img = dom.imageUrl
      ? `<img class="tw-thumb" src="${escapeHtml(dom.imageUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display=''" /><div class="tw-thumb tw-thumb-placeholder" style="display:none">无图</div>`
      : `<div class="tw-thumb tw-thumb-placeholder">无图</div>`;
    const badge = renderWindowBadge(t.status);
    const sku = `<span class="tw-meta tw-meta-sku">${escapeHtml(t.sku)}</span>`;
    const seller = t.sellerSlug
      ? `<span class="tw-meta" title="${escapeHtml(t.sellerId || '')}">${escapeHtml(t.sellerSlug)}</span>`
      : '';
    let timeMeta = '';
    if (t.status === 'running' && t.startedAt) {
      timeMeta = `<span class="tw-meta">开始 ${formatTime(t.startedAt)}</span>`;
    } else if (t.finishedAt) {
      timeMeta = `<span class="tw-meta">完成 ${formatTime(t.finishedAt)}</span>`;
    } else if (t.status === 'pending') {
      timeMeta = `<span class="tw-meta">等待中</span>`;
    }
    const rating =
      dom.ratingCount != null ? `<span class="tw-meta">评价 ${dom.ratingCount}</span>` : '';
    const errorLine =
      t.lastError && typeof t.lastError === 'object' && t.lastError.message
        ? `<div class="tw-error" title="${escapeHtml(t.lastError.message)}">${escapeHtml(t.lastError.message)}</div>`
        : t.lastError && typeof t.lastError === 'string'
          ? `<div class="tw-error" title="${escapeHtml(t.lastError)}">${escapeHtml(t.lastError)}</div>`
          : '';
    // 中间槽仅在 running 时才加脉冲高亮;已完成任务保留在中间槽时不加脉冲
    const centerCls = isCenter && t.status === 'running' ? ' tw-card-center' : '';
    return `<div class="tw-card${centerCls}" data-sku="${escapeHtml(t.sku)}">
      ${img}
      <div class="tw-body">
        <div class="tw-badge-row">${badge}</div>
        <div class="tw-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <div class="tw-price">${escapeHtml(price)}</div>
        <div class="tw-meta-row">${sku}${seller}${timeMeta}${rating}</div>
        ${errorLine}
      </div>
    </div>`;
  };

  // 窗口视图专用徽章(简化为 4 类:采集中/采集成功/采集失败/未采集)
  const renderWindowBadge = (status) => {
    const map = {
      running: { cls: 'tw-badge tw-badge-running', text: '采集中' },
      success: { cls: 'tw-badge tw-badge-success', text: '采集成功' },
      skipped: { cls: 'tw-badge tw-badge-skipped', text: '已跳过' },
      failed: { cls: 'tw-badge tw-badge-failed', text: '采集失败' },
      antibot: { cls: 'tw-badge tw-badge-failed', text: '反爬' },
      pending: { cls: 'tw-badge tw-badge-pending', text: '未采集' },
    };
    const m = map[status] || { cls: 'tw-badge tw-badge-pending', text: '未采集' };
    return `<span class="${m.cls}">${m.text}</span>`;
  };

  // ─── 渲染概览 ───
  const renderStats = (d) => {
    statTotal.textContent = String(d.totalCount || 0);
    statPending.textContent = String(d.pendingCount || 0);
    statRunning.textContent = String(d.runningSkus?.length || 0);
    statFinished.textContent = String(d.finishedCount || 0);
    statToday.textContent = String(d.finishedCount || 0);

    // 队列状态
    const now = Date.now();
    if (now < (d.circuitBreakerUntil || 0)) {
      const remainSec = Math.ceil((d.circuitBreakerUntil - now) / 1000);
      statPaused.innerHTML = `<span style="color:var(--error-fg)">熔断 ${remainSec}s</span>`;
    } else if (d.consumePaused) {
      statPaused.innerHTML = '<span style="color:var(--warning-fg)">已暂停</span>';
    } else {
      statPaused.innerHTML = '<span style="color:var(--success-fg)">运行中</span>';
    }

    // 自动采集状态 + SW 消费诊断
    // consuming=true 且近期 → "采集中(Xs)";consuming=true 且 >5min → "疑似卡死";false → "空闲"
    let consumeHint = '';
    if (d.consuming) {
      const elapsedSec = Math.round((now - (d.consumeStartedAt || 0)) / 1000);
      if (elapsedSec > 300) {
        consumeHint = ` · 疑似卡死 ${elapsedSec}s`;
        autoStatus.style.color = 'var(--error-fg)';
      } else {
        consumeHint = ` · 采集中 ${elapsedSec}s`;
        autoStatus.style.color = 'var(--success-fg)';
      }
    } else {
      consumeHint = ' · 空闲';
      autoStatus.style.color = d.autoCollectRunning ? 'var(--success-fg)' : 'var(--ink-3)';
    }
    autoStatus.textContent = `自动采集: ${d.autoCollectRunning ? '开' : '关'}${consumeHint}`;

    // 计算下次执行时间(用于 1s 倒计时渲染)
    // 规则:
    //   - 优先用 SW 的 nextConsumeAt(setTimeout 调度的真实随机值)
    //   - 回退:lastConsumeAt + (min+max)/2 中点估算(SW 刚重启 / nextConsumeAt=0 时)
    //   - 熔断中 → nextRunAt = circuitBreakerUntil
    //   - 暂停/达上限/无 pending → nextRunAt = 0(显示"—")
    // 注:now 已在上方"队列状态"段声明,此处复用
    const hasPending = (d.pendingCount || 0) > 0;
    if (now < (d.circuitBreakerUntil || 0)) {
      nextRunAt = d.circuitBreakerUntil;
    } else if (hasPending && !d.consumePaused) {
      if (d.nextConsumeAt) {
        // SW 提供精确下次执行时间(setTimeout 调度的真实随机值)
        nextRunAt = d.nextConsumeAt;
        // 已过预计时间但 SW 还没回调(setTimeout 可能有几 ms 抖动),显示"即将执行"
        if (nextRunAt < now) nextRunAt = now + 500;
      } else {
        // 回退:SW 刚重启或未调度,用 lastConsumeAt + 中点估算
        const range = getRateRangeFromState(d);
        const interval = Math.round((range.min + range.max) / 2) * 1000;
        nextRunAt = (d.lastConsumeAt || 0) + interval;
        if (nextRunAt < now) nextRunAt = now + 500;
      }
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
        renderTaskWindow();
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
        } else {
          hideNotice();
        }

        // 更新时间
        const ts = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        lastUpdate.textContent = `最后更新: ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;

        // 根据队列活动状态动态调整轮询周期(捕捉 3-6s running 窗口)
        _reschedulePoller(_pickPollInterval(d));
      } else {
        swDot.parentElement.classList.add('is-off');
        swDot.parentElement.classList.remove('is-on');
        swText.textContent = 'SW 未响应';
      }
    } catch (e) {
      swDot.parentElement.classList.add('is-off');
      swDot.parentElement.classList.remove('is-on');
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
  // 轮询周期分两档:
  //   - 默认 5s(队列无活动时,降低 SW 压力)
  //   - 加速 2s(队列正在消费中:pendingCount > 0 且 lastConsumeAt 在 30s 内更新过)
  //     用于密集捕捉 3-6 秒的 running 窗口,避免 5s 轮询恰好错过
  const POLL_INTERVAL_DEFAULT = 5000;
  const POLL_INTERVAL_FAST = 2000;
  let _lastLastConsumeAt = 0;
  let _lastPendingCount = 0;
  // 当前轮询周期(独立变量,不能挂在 pollTimer 上 — setInterval 返回的是数字,
  // 严格模式下给原始类型设属性会抛 TypeError,导致 fetchState 进入 catch 块,
  // UI 错误显示"SW 连接失败"覆盖正常状态)
  let _pollInterval = 0;
  const _pickPollInterval = (d) => {
    const pending = d?.pendingCount || 0;
    const lastConsume = d?.lastConsumeAt || 0;
    const autoRunning = d?.autoCollectRunning;
    // 启发式:深度采集开 + 有 pending + 30s 内有消费 → 加速轮询
    if (autoRunning && pending > 0 && lastConsume > 0 && Date.now() - lastConsume < 30000) {
      return POLL_INTERVAL_FAST;
    }
    return POLL_INTERVAL_DEFAULT;
  };
  const _reschedulePoller = (interval) => {
    if (pollTimer && _pollInterval === interval) return;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchState, interval);
    _pollInterval = interval;
  };

  const startPolling = () => {
    stopPolling();
    pollTimer = setInterval(fetchState, POLL_INTERVAL_DEFAULT);
    _pollInterval = POLL_INTERVAL_DEFAULT;
    // 倒计时定时器:每秒更新下次执行倒计时(独立于轮询,提升体验)
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

  // 筛选区折叠/展开
  if (btnToggleFilter && filterBody) {
    btnToggleFilter.addEventListener('click', () => {
      const isOpen = filterBody.style.display !== 'none';
      filterBody.style.display = isOpen ? 'none' : '';
      btnToggleFilter.classList.toggle('is-open', !isOpen);
      btnToggleFilter.setAttribute('aria-expanded', String(!isOpen));
    });
  }

  // ─── 初始化 ───
  fetchState().then(() => {
    if (autoRefresh.checked) startPolling();
  });
})();
