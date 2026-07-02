/**
 * 批量上架独立窗口页编排(P2-2:接入 ERP):
 *   1. textarea 输入 → parseLine 解析每行 → 渲染解析预览表
 *   2. AI 卡片折叠/展开
 *   3. 使用说明抽屉开关
 *   4. 点击「开始批采 + 上架」→ 创建批量任务 → 逐条 followSell 上架 → 实时进度日志
 *   5. 清空 / 取消 按钮
 *   6. 历史记录 → 跳转 ERP admin 批量任务 tab
 */
(function () {
  'use strict';

  // 工具:按 id 取元素
  const $ = (id) => document.getElementById(id);

  // ─── 消息发送(封装 chrome.runtime.sendMessage) ───
  function sendMessage(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (!chrome?.runtime?.sendMessage) {
        reject(new Error('chrome.runtime 不可用'));
        return;
      }
      chrome.runtime.sendMessage({ type, ...data }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    });
  }

  // ─── State ──────────────────────────────────────
  const state = {
    rows: [], // 解析后的行数据 parseLine 返回值
    submitting: false, // 是否正在提交
    cancelRequested: false, // 是否请求取消
    aborted: false, // 是否已中断(用于跳出循环)
  };

  // ─── 简化 10 格式解析器 ─────────────────────────
  // 每行一条,格式: SKU,售价[,货号|重量|长|宽|高|~最低价]
  // 返回行对象: { index, raw, sku?, price?, minPrice?, offerId?, weightG?,
  //               lengthMm?, widthMm?, heightMm?, formatHint, valid, reason? }
  function parseLine(line, index) {
    const raw = line.trim();
    if (!raw) return null;
    // 分隔符: , ， Tab 2空格
    const parts = raw
      .split(/[,，\t]|\s{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 2) return { index, raw, valid: false, reason: '格式错误:至少需要 SKU 和售价' };
    const sku = parts[0];
    if (!/^\d{6,16}$/.test(sku)) return { index, raw, sku, valid: false, reason: 'SKU 需 6-16 位数字' };
    const price = parseFloat(parts[1]);
    if (!isFinite(price) || price <= 0) return { index, raw, sku, valid: false, reason: '售价无效' };
    // 提取 ~最低价
    let minPrice = null;
    const cleanParts = [sku, String(price)];
    for (let i = 2; i < parts.length; i++) {
      if (parts[i].startsWith('~')) {
        minPrice = parseFloat(parts[i].slice(1));
        if (!isFinite(minPrice) || minPrice <= 0) return { index, raw, sku, valid: false, reason: '最低价无效' };
        if (minPrice > price) return { index, raw, sku, valid: false, reason: '最低价不能>售价' };
      } else {
        cleanParts.push(parts[i]);
      }
    }
    // 根据剩余部分数量判断格式
    const extra = cleanParts.length - 2;
    let offerId = '',
      weightG = null,
      lengthMm = null,
      widthMm = null,
      heightMm = null,
      formatHint = 1;
    if (extra === 0) formatHint = 1;
    else if (extra === 1) {
      // 格式2(货号) 或 3(重量) 或 4(长度)
      const v = cleanParts[2];
      if (/^[a-zA-Z0-9-_]+$/.test(v) && isNaN(parseFloat(v))) {
        offerId = v;
        formatHint = 2;
      } else {
        weightG = parseInt(v);
        formatHint = 3;
      } // 简化:数字当重量
    } else if (extra === 2) {
      lengthMm = parseInt(cleanParts[2]);
      widthMm = parseInt(cleanParts[3]);
      formatHint = 5;
    } else if (extra === 3) {
      lengthMm = parseInt(cleanParts[2]);
      widthMm = parseInt(cleanParts[3]);
      heightMm = parseInt(cleanParts[4]);
      formatHint = 6;
    } else if (extra === 4) {
      weightG = parseInt(cleanParts[2]);
      lengthMm = parseInt(cleanParts[3]);
      widthMm = parseInt(cleanParts[4]);
      heightMm = parseInt(cleanParts[5]);
      formatHint = 7;
    }
    return {
      index,
      raw,
      sku,
      price,
      minPrice,
      offerId,
      weightG,
      lengthMm,
      widthMm,
      heightMm,
      formatHint,
      valid: true,
    };
  }

  // ─── 文本 → 行数据 ──────────────────────────────
  function parseAll(text) {
    const lines = text.split(/\r?\n/);
    const rows = [];
    lines.forEach((line, i) => {
      const r = parseLine(line, i + 1);
      if (r) rows.push(r);
    });
    return rows;
  }

  // ─── 渲染解析预览 ───────────────────────────────
  function renderPreview() {
    const tbody = $('preview-tbody');
    const card = $('preview-card');
    const stat = $('preview-stat');
    const parseStat = $('parse-stat');
    const rows = state.rows;
    parseStat.textContent = rows.length + ' 行';
    if (rows.length === 0) {
      card.style.display = 'none';
      stat.textContent = '';
      refreshSubmit();
      return;
    }
    card.style.display = '';
    const okCount = rows.filter((r) => r.valid).length;
    const badCount = rows.length - okCount;
    stat.textContent = '成功 ' + okCount + (badCount ? ' · 失败 ' + badCount : '');
    // 渲染表格行
    const html = rows
      .map((r) => {
        const cls = r.valid ? '' : 'row-bad';
        const dim = r.valid
          ? [r.lengthMm, r.widthMm, r.heightMm]
              .filter((v) => v != null && !isNaN(v))
              .map((v) => v + 'mm')
              .join(' × ')
          : '';
        const priceCell = r.valid
          ? String(r.price) + (r.minPrice != null ? ' <span class="price-min">~' + r.minPrice + '</span>' : '')
          : '';
        const fmtCell = r.valid ? '<span class="fmt-tag">F' + r.formatHint + '</span>' : '';
        const wCell = r.valid && r.weightG != null ? r.weightG + 'g' : '';
        return (
          '<tr class="' +
          cls +
          '">' +
          '<td class="c-idx">' +
          r.index +
          '</td>' +
          '<td class="c-sku">' +
          (r.sku || '') +
          '</td>' +
          '<td class="c-price">' +
          priceCell +
          '</td>' +
          '<td class="c-offer">' +
          (r.offerId || '') +
          '</td>' +
          '<td class="c-w">' +
          wCell +
          '</td>' +
          '<td class="c-dim">' +
          dim +
          '</td>' +
          '<td class="c-fmt">' +
          fmtCell +
          '</td>' +
          '<td class="c-msg">' +
          (r.reason || '') +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
    tbody.innerHTML = html;
    refreshSubmit();
  }

  // ─── 提交按钮启用/禁用 ─────────────────────────
  function refreshSubmit() {
    const btn = $('btn-submit');
    const hasValid = state.rows.some((r) => r.valid);
    btn.disabled = state.submitting || !hasValid;
  }

  // ─── AI 卡折叠 ─────────────────────────────────
  function bindAiCollapse() {
    const head = $('ai-head');
    const section = $('ai-section');
    const chevron = head.querySelector('.ai-chevron');
    head.addEventListener('click', () => {
      const collapsed = section.classList.toggle('mv-collapsed');
      chevron.style.transform = collapsed ? 'rotate(-90deg)' : '';
    });
  }

  // ─── AI 已启用计数 ─────────────────────────────
  function bindAiCount() {
    const ids = ['cfg-watermark', 'cfg-ai-poster', 'cfg-ai-rewrite', 'cfg-capture-video'];
    const chip = $('ai-enabled-count');
    const update = () => {
      const n = ids.filter((id) => $(id).checked).length;
      if (n > 0) {
        chip.style.display = '';
        chip.textContent = '已启用 ' + n;
      } else {
        chip.style.display = 'none';
      }
    };
    ids.forEach((id) => $(id).addEventListener('change', update));
    update();
  }

  // ─── 使用说明抽屉 ──────────────────────────────
  function bindHelpDrawer() {
    const backdrop = $('help-backdrop');
    const drawer = $('help-drawer');
    const open = () => {
      backdrop.style.display = '';
      drawer.style.display = '';
    };
    const close = () => {
      backdrop.style.display = 'none';
      drawer.style.display = 'none';
    };
    $('btn-help').addEventListener('click', open);
    $('btn-help-close').addEventListener('click', close);
    backdrop.addEventListener('click', close);
  }

  // ─── 清空 ──────────────────────────────────────
  function bindClear() {
    $('btn-clear').addEventListener('click', () => {
      $('textarea').value = '';
      state.rows = [];
      renderPreview();
      $('textarea').focus();
    });
  }

  // ─── 粘贴区实时解析 ────────────────────────────
  function bindTextarea() {
    const ta = $('textarea');
    ta.addEventListener('input', () => {
      state.rows = parseAll(ta.value);
      renderPreview();
    });
  }

  // ─── 进度日志 ──────────────────────────────────
  function logLine(text, level) {
    const log = $('progress-log');
    const div = document.createElement('div');
    if (level) div.className = 'log-' + level;
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    div.textContent = '[' + ts + '] ' + text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  // ─── 延时工具 ──────────────────────────────────
  function sleep(ms) {
    return new Promise((resolve) => {
      // 取消时立即 resolve,让循环尽快跳出
      const t = setTimeout(resolve, ms);
      if (state.aborted) {
        clearTimeout(t);
        resolve();
      }
    });
  }

  // ─── 店铺下拉填充(P2-2:从 ERP 拉取) ───────────
  async function initStores() {
    const sel = $('cfg-store');
    if (!sel) return;
    try {
      const resp = await sendMessage('getStores');
      const stores = resp?.data || [];
      if (Array.isArray(stores) && stores.length) {
        sel.innerHTML = stores
          .map((s) => `<option value="${s.id}">${s.name} (${s.currency_code || 'RUB'})</option>`)
          .join('');
      }
    } catch (e) {
      console.warn('[BatchUpload] 拉取店铺失败,保留默认:', e?.message || e);
    }
  }

  // ─── 真实提交(P2-2:接入 ERP) ───────────────────
  // 流程:创建批量任务 → 逐条 followSell 上架 → 实时日志
  async function submitReal() {
    if (state.submitting) return;
    const validRows = state.rows.filter((r) => r.valid);
    if (validRows.length === 0) return;
    state.submitting = true;
    state.cancelRequested = false;
    state.aborted = false;
    $('btn-submit').style.display = 'none';
    $('btn-cancel').style.display = '';
    // 重置进度/结果卡
    const progressCard = $('progress-card');
    const resultCard = $('result-card');
    const log = $('progress-log');
    log.innerHTML = '';
    progressCard.style.display = '';
    resultCard.style.display = 'none';
    $('result-list').innerHTML = '';

    const storeSel = $('cfg-store');
    const storeId = storeSel.value;
    const storeLabel = storeSel.options[storeSel.selectedIndex]?.text || storeId;

    // 收集 AI/水印等配置快照
    const configSnapshot = {
      watermark: $('cfg-watermark')?.checked || false,
      aiPoster: $('cfg-ai-poster')?.checked || false,
      aiRewrite: $('cfg-ai-rewrite')?.checked || false,
      captureVideo: $('cfg-capture-video')?.checked || false,
    };

    logLine('开始批采 + 上架,共 ' + validRows.length + ' 个 SKU', 'warn');

    // 1. 创建批量任务记录
    let batchLocalTaskId = null;
    try {
      const createResp = await sendMessage('createBatchTask', {
        payload: {
          storeId,
          items: validRows.map((r) => ({ sourceSku: r.sku, sourceUrl: '' })),
          config: configSnapshot,
        },
      });
      const created = createResp?.data?.data || createResp?.data || {};
      batchLocalTaskId = created.localTaskId || null;
      if (batchLocalTaskId) {
        logLine('已创建批量任务 ' + batchLocalTaskId, 'ok');
      }
    } catch (e) {
      logLine('创建批量任务记录失败(继续逐条上架): ' + (e?.message || e), 'err');
    }

    // 2. 逐条 followSell 上架
    const results = [];
    let okCount = 0;
    let failCount = 0;
    for (const row of validRows) {
      if (state.aborted) break;
      logLine('正在提交 SKU ' + row.sku + ' ...');
      try {
        const resp = await sendMessage('followSell', {
          storeId,
          viaPortal: false,
          items: [
            {
              sku: row.sku,
              price: row.price,
              offerId: row.offerId || '',
              weightG: row.weightG,
              lengthMm: row.lengthMm,
              widthMm: row.widthMm,
              heightMm: row.heightMm,
            },
          ],
        });
        if (resp?.ok) {
          const taskId = resp?.data?.localTaskId || resp?.data?.taskId || 'ok';
          logLine('提交成功 SKU ' + row.sku + ' task_id=' + taskId, 'ok');
          results.push({ ok: true, store: storeLabel, sku: row.sku, taskId });
          okCount++;
        } else {
          const errMsg = resp?.error || resp?.message || '未知错误';
          logLine('提交失败 SKU ' + row.sku + ': ' + errMsg, 'err');
          results.push({ ok: false, store: storeLabel, sku: row.sku, taskId: errMsg });
          failCount++;
        }
      } catch (e) {
        logLine('提交异常 SKU ' + row.sku + ': ' + (e?.message || e), 'err');
        results.push({ ok: false, store: storeLabel, sku: row.sku, taskId: String(e?.message || e) });
        failCount++;
      }
    }

    if (state.aborted) {
      logLine('已取消(剩余 SKU 未提交)', 'err');
    } else {
      logLine('全部完成,成功 ' + okCount + ' 条' + (failCount ? ' · 失败 ' + failCount + ' 条' : ''), 'ok');
    }

    // 渲染结果列表
    renderResults(results, state.aborted);

    state.submitting = false;
    state.aborted = false;
    $('btn-cancel').style.display = 'none';
    $('btn-submit').style.display = '';
    refreshSubmit();
  }

  // ─── 渲染结果列表 ──────────────────────────────
  function renderResults(results, aborted) {
    const list = $('result-list');
    const card = $('result-card');
    card.style.display = '';
    if (results.length === 0 && !aborted) {
      list.innerHTML = '<div style="font-size:12px;color:#94a3b8">无结果</div>';
      return;
    }
    const html = results
      .map(
        (r) =>
          '<div class="result-row is-' +
          (r.ok ? 'ok' : 'err') +
          '">' +
          '<div class="result-store">' +
          r.store +
          ' · ' +
          r.sku +
          '</div>' +
          '<div class="result-meta">task_id=' +
          r.taskId +
          '</div>' +
          '</div>'
      )
      .join('');
    list.innerHTML = html;
  }

  // ─── 取消 ──────────────────────────────────────
  function bindCancel() {
    $('btn-cancel').addEventListener('click', () => {
      if (!state.submitting) return;
      state.cancelRequested = true;
      state.aborted = true;
      logLine('收到取消请求,正在停止...', 'warn');
    });
  }

  // ─── 历史记录(P2-2:跳转 ERP admin 批量任务 tab) ───
  function bindHistory() {
    $('btn-history').addEventListener('click', async () => {
      try {
        const resp = await sendMessage('getErpBaseUrl');
        const baseUrl = resp?.baseUrl || '';
        if (baseUrl) {
          window.open(baseUrl + '/admin#batch', '_blank');
        } else {
          alert('未获取到 ERP 地址');
        }
      } catch (e) {
        alert('打开历史记录失败: ' + (e?.message || e));
      }
    });
  }

  // ─── 绑定提交 ──────────────────────────────────
  function bindSubmit() {
    $('btn-submit').addEventListener('click', submitReal);
  }

  // ─── 启动 ──────────────────────────────────────
  function init() {
    bindTextarea();
    bindClear();
    bindAiCollapse();
    bindAiCount();
    bindHelpDrawer();
    bindSubmit();
    bindCancel();
    bindHistory();
    initStores();
    // 初始渲染
    state.rows = parseAll($('textarea').value);
    renderPreview();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
