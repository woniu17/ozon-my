// 极掌采集器 — IndexedDB 持久化层 (v2)
//
// database 'jzCollector' v2: sales / keywords / sessions / failures
//
// stores:
//   sales      keyPath='sku'              indexes: keyword, collectedAt, status
//   keywords   keyPath='id' (auto)        indexes: status
//   sessions   keyPath='key' (常量)
//   failures   keyPath='taskId'           indexes: keyword
//
// API:
//   sales:    putSale, putSaleBatch, getSale, getAllSales, countSales, markPushed,
//             deleteSale, clearSales, exportCsv
//   keywords: addKeywords, getKeywords, getNextPendingKeyword, updateKeyword,
//             removeKeyword, clearKeywords
//   sessions: setSession, getSession, clearSession
//   failures: addFailure, getFailures, removeFailure, clearFailures
//   util:     init, onChange (BroadcastChannel 跨 tab 同步)

(() => {
  if (window.JZCollectorDB && window.JZCollectorDB._v2) return;

  const DB_NAME = 'jzCollector';
  const DB_VERSION = 2;
  const STORE_SALES = 'sales';
  const STORE_KEYWORDS = 'keywords';
  const STORE_SESSIONS = 'sessions';
  const STORE_FAILURES = 'failures';

  let _db = null;
  let _initPromise = null;
  let _channel = null;
  const _changeListeners = new Set();

  function _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_SALES)) {
          const store = db.createObjectStore(STORE_SALES, { keyPath: 'sku' });
          store.createIndex('keyword', 'keyword', { unique: false });
          store.createIndex('collectedAt', 'collectedAt', { unique: false });
          store.createIndex('status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_KEYWORDS)) {
          const store = db.createObjectStore(STORE_KEYWORDS, { keyPath: 'id', autoIncrement: true });
          store.createIndex('status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          db.createObjectStore(STORE_SESSIONS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_FAILURES)) {
          const store = db.createObjectStore(STORE_FAILURES, { keyPath: 'taskId' });
          store.createIndex('keyword', 'keyword', { unique: false });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function init() {
    if (_db) return _db;
    if (!_initPromise) {
      _initPromise = _open().then((db) => {
        _db = db;
        try {
          _channel = new BroadcastChannel('jz-collector');
          _channel.addEventListener('message', (ev) => {
            if (!ev.data || !ev.data.type) return;
            for (const cb of _changeListeners) {
              try {
                cb(ev.data);
              } catch (e) {
                console.error('[JZCollectorDB] listener error:', e);
              }
            }
          });
        } catch (e) {
          console.warn('[JZCollectorDB] BroadcastChannel unavailable:', e);
        }
        return db;
      });
    }
    return _initPromise;
  }

  function _broadcast(payload) {
    for (const cb of _changeListeners) {
      try {
        cb(payload);
      } catch (e) {
        console.error('[JZCollectorDB] listener error:', e);
      }
    }
    if (_channel) {
      try {
        _channel.postMessage(payload);
      } catch (e) {
        /* swallow */
      }
    }
  }

  function _store(name, mode = 'readonly') {
    return _db.transaction([name], mode).objectStore(name);
  }

  function _wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // ─── sales ─────────────────────────────────────────────
  async function putSale(record) {
    await init();
    if (!record || !record.sku) throw new Error('sku required');
    if (!record.collectedAt) record.collectedAt = Date.now();
    if (!record.status) record.status = 'local';
    await _wrap(_store(STORE_SALES, 'readwrite').put(record));
    _broadcast({ type: 'sale-changed', skus: [record.sku] });
    return record;
  }

  async function putSaleBatch(records) {
    await init();
    if (!records || records.length === 0) return [];
    const tx = _db.transaction([STORE_SALES], 'readwrite');
    const store = tx.objectStore(STORE_SALES);
    const skus = [];
    for (const r of records) {
      if (!r || !r.sku) continue;
      if (!r.collectedAt) r.collectedAt = Date.now();
      if (!r.status) r.status = 'local';
      store.put(r);
      skus.push(r.sku);
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
      tx.onabort = (e) => reject(e.target.error);
    });
    _broadcast({ type: 'sale-changed', skus });
    return skus;
  }

  async function getSale(sku) {
    await init();
    return _wrap(_store(STORE_SALES).get(sku));
  }

  async function getAllSales(opts = {}) {
    await init();
    const store = _store(STORE_SALES);
    if (opts.status) {
      return _wrap(store.index('status').getAll(opts.status));
    }
    return _wrap(store.getAll());
  }

  // 走 collectedAt 索引拉时间窗口内的 sale,避免 getAllSales 把整桶载入内存。
  // sales 桶在长期使用后可能上万行,getAll() 一次 deserialize 全量很重;
  // 配合 IDBKeyRange.lowerBound 走 collectedAt 索引游标,IDB 只 yield 命中
  // 区间的行。
  //
  // 注意:`collectedAt` 索引会自动跳过该字段为 null/undefined 的行,所以
  // 老/坏数据(没有 collectedAt 的 row)天然被滤掉 — 不会污染窗口统计。
  async function getSalesSince(sinceTs, opts = {}) {
    await init();
    if (typeof sinceTs !== 'number' || !isFinite(sinceTs)) {
      throw new Error('getSalesSince: sinceTs must be a finite number (ms epoch)');
    }
    const limit = Math.max(1, Math.min(500_000, opts.limit || 500_000));
    const store = _store(STORE_SALES);
    const idx = store.index('collectedAt');
    const range = IDBKeyRange.lowerBound(sinceTs);
    return new Promise((resolve, reject) => {
      const out = [];
      const req = idx.openCursor(range);
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur && out.length < limit) {
          out.push(cur.value);
          cur.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function countSales(opts = {}) {
    await init();
    const store = _store(STORE_SALES);
    if (opts.status) {
      return _wrap(store.index('status').count(opts.status));
    }
    return _wrap(store.count());
  }

  async function markPushed(skus) {
    await init();
    if (!skus || skus.length === 0) return 0;
    const tx = _db.transaction([STORE_SALES], 'readwrite');
    const store = tx.objectStore(STORE_SALES);
    let count = 0;
    for (const sku of skus) {
      const existing = await new Promise((resolve, reject) => {
        const r = store.get(sku);
        r.onsuccess = (e) => resolve(e.target.result);
        r.onerror = (e) => reject(e.target.error);
      });
      if (existing) {
        existing.status = 'pushed';
        existing.pushedAt = Date.now();
        store.put(existing);
        count++;
      }
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
    _broadcast({ type: 'sale-changed', skus });
    return count;
  }

  async function deleteSale(sku) {
    await init();
    await _wrap(_store(STORE_SALES, 'readwrite').delete(sku));
    _broadcast({ type: 'sale-changed', skus: [sku] });
  }

  async function clearSales() {
    await init();
    await _wrap(_store(STORE_SALES, 'readwrite').clear());
    _broadcast({ type: 'sale-changed', skus: [], cleared: true });
  }

  // ─── CSV 导出（流式） ───────────────────────────────────
  // 字段顺序固定，与 sales record 对齐
  const CSV_FIELDS = [
    { key: 'sku', label: 'SKU' },
    { key: 'name', label: '商品名' },
    { key: 'price', label: '当前价(₽)' },
    { key: 'soldCount', label: '月销量' },
    { key: 'gmvSum', label: '月销售额(₽)' },
    { key: 'gmvSumCny', label: '月销售额(¥)' },
    { key: 'brandName', label: '品牌' },
    { key: 'shippingMode', label: '发货模式' },
    { key: 'weight', label: '重量(g)' },
    { key: 'listedDays', label: '上架时间(天)' },
    { key: 'monthlyTurnoverDynamic', label: '月周转动态(%)' },
    { key: 'adCostRatio', label: '广告费占比(%)' },
    { key: 'promoDays', label: '参与促销天数' },
    { key: 'promoDiscount', label: '参与促销折扣(%)' },
    { key: 'promoConversionRate', label: '促销活动转化率(%)' },
    { key: 'paidPromotionDays', label: '付费推广天数' },
    { key: 'views', label: '商品卡浏览量' },
    { key: 'cardAddToCartRate', label: '商品卡加购率(%)' },
    { key: 'searchCatalogViews', label: '搜索目录浏览量' },
    { key: 'searchCatalogAddToCartRate', label: '搜索目录加购率(%)' },
    { key: 'displayConversionRate', label: '展示转化率(%)' },
    { key: 'returnCancelRate', label: '退货取消率(%)' },
    { key: 'followerCount', label: '跟卖人数' },
    { key: 'lowestFollowerPrice', label: '跟卖最低价' },
    { key: 'discount', label: '折扣(%)' },
    { key: 'keyword', label: '关键词' },
    { key: 'url', label: 'URL' },
    { key: 'image', label: '主图' },
    { key: 'status', label: '状态' },
    { key: 'collectedAt', label: '采集时间' },
  ];

  function _csvEscape(v) {
    if (v == null) return '';
    let s = String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function _firstValue(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  function _toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value)
      .replace(/\u00a0/g, ' ')
      .trim();
    if (!text || text === '-' || text === '\u2014') return null;
    const compact = text.replace(/\s+/g, '');
    const match = compact.match(/[-+]?\d+(?:[,.]\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0].replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function _daysSince(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return null;
    return Math.max(0, Math.floor((Date.now() - time) / 86400000));
  }

  function _daysValue(...values) {
    for (const value of values) {
      if (value === null || value === undefined || value === '') continue;
      if (typeof value === 'number') {
        if (Number.isFinite(value)) return value;
        continue;
      }
      const text = String(value)
        .replace(/\u00a0/g, ' ')
        .trim();
      if (!text || text === '-' || text === '\u2014') continue;
      const dayMatch = text.match(/(\d+)\s*(?:天|days?|дн)/i);
      if (dayMatch) return Number(dayMatch[1]);
      const dateMatch = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
      if (dateMatch) {
        const days = _daysSince(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`);
        if (days !== null) return days;
        continue;
      }
      const num = _toNumber(text);
      if (num !== null) return num;
    }
    return null;
  }

  function _extractCny(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value || '')
      .replace(/\u00a0/g, ' ')
      .trim();
    if (!text || text === '-' || text === '\u2014') return null;
    const match = text.replace(/\s+/g, '').match(/[\u00A5\uFFE5]\s*([-+]?\d+(?:[,.]\d+)?)/);
    if (!match) return null;
    const parsed = Number(match[1].replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function _resolveCsvValue(rec, key) {
    const raw = rec?.raw || {};
    if (key === 'gmvSumCny') {
      return _firstValue(
        raw.gmvSumCny,
        raw.revenue30dCny,
        _extractCny(raw.revenue30d),
        _toNumber(raw.gmvSum) != null ? _toNumber(raw.gmvSum) * 0.084 : null,
        _toNumber(rec.gmvSum) != null ? _toNumber(rec.gmvSum) * 0.084 : null
      );
    }
    if (key === 'brandName') return _firstValue(raw.brandName, raw.brand);
    if (key === 'shippingMode')
      return _firstValue(
        raw.shippingMode,
        raw.salesSchema,
        raw.marketSalesSchema,
        raw.deliverySchema,
        raw.deliveryType
      );
    if (key === 'weight') return _firstValue(raw.weight, raw.weightG, raw.weightGrams);
    if (key === 'listedDays') return _daysValue(raw.listedDays, raw.daysOnline, raw.createDate, raw.nullableCreateDate);
    if (key === 'monthlyTurnoverDynamic')
      return _firstValue(raw.monthlyTurnoverDynamic, raw.turnoverDynamic, raw.salesDynamics);
    if (key === 'adCostRatio') return _firstValue(raw.adCostRatio, raw.adCostPercent, raw.drr);
    if (key === 'promoDays') return _firstValue(raw.promoDays, raw.daysInPromo);
    if (key === 'promoDiscount') return _firstValue(raw.promoDiscount, raw.discount);
    if (key === 'promoConversionRate')
      return _firstValue(raw.promoConversionRate, raw.promoRevenueShare, raw.promoConvRate);
    if (key === 'paidPromotionDays') return _firstValue(raw.paidPromotionDays, raw.daysWithTrafarets, raw.daysWithAds);
    if (key === 'views') return _firstValue(rec.views, raw.views, raw.qtyViewPdp, raw.sessionCount, raw.pdpViews);
    if (key === 'cardAddToCartRate')
      return _firstValue(raw.cardAddToCartRate, raw.pdpToCartConversion, raw.convToCartPdp, raw.pdpCartRate);
    if (key === 'searchCatalogViews')
      return _firstValue(raw.searchCatalogViews, raw.sessionCountSearch, raw.searchViews);
    if (key === 'searchCatalogAddToCartRate')
      return _firstValue(raw.searchCatalogAddToCartRate, raw.convToCartSearch, raw.searchCartRate);
    if (key === 'displayConversionRate')
      return _firstValue(raw.displayConversionRate, raw.convViewToOrder, rec.convViewToOrder);
    if (key === 'returnCancelRate') {
      const direct = _firstValue(raw.returnCancelRate, raw.returnRate);
      if (direct !== null) return direct;
      const redemption = _toNumber(raw.nullableRedemptionRate);
      return redemption === null ? null : 100 - redemption;
    }
    if (key === 'followerCount') return _firstValue(raw.followerCount, raw.followSellCount, raw.heroFollow);
    if (key === 'lowestFollowerPrice')
      return _firstValue(raw.lowestFollowerPrice, raw.followSellMinPrice, raw.followMinPrice);
    return rec[key];
  }

  function _formatRow(rec) {
    return (
      CSV_FIELDS.map((f) => {
        let v = _resolveCsvValue(rec, f.key);
        if (f.key === 'collectedAt' && v) v = new Date(v).toISOString();
        return _csvEscape(v);
      }).join(',') + '\n'
    );
  }

  const CSV_HEADER = '﻿' + CSV_FIELDS.map((f) => f.label).join(',') + '\n'; // BOM for Excel CN

  // 用 cursor 流式遍历，避免大数据集 OOM
  async function _streamSales(onRow, opts = {}) {
    await init();
    return new Promise((resolve, reject) => {
      const tx = _db.transaction([STORE_SALES], 'readonly');
      const store = tx.objectStore(STORE_SALES);
      const req = opts.status ? store.index('status').openCursor(IDBKeyRange.only(opts.status)) : store.openCursor();
      let count = 0;
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          try {
            onRow(cursor.value);
            count++;
            cursor.continue();
          } catch (err) {
            reject(err);
          }
        } else {
          resolve(count);
        }
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // 优先 File System Access API 流式写一个文件；不支持则切片 500/份多文件下载
  async function exportCsv(opts = {}) {
    await init();
    const total = await countSales(opts);
    if (total === 0) throw new Error('没有可导出的数据');

    const filenameBase =
      opts.filename || `${globalThis.__JZ_BRAND__.displayName}采集_${new Date().toISOString().slice(0, 10)}`;

    // Path A: showSaveFilePicker 流式写
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filenameBase + '.csv',
          types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
        });
        const writable = await handle.createWritable();
        const encoder = new TextEncoder();
        await writable.write(encoder.encode(CSV_HEADER));
        let written = 0;
        await _streamSales(async (rec) => {
          // queueMicrotask 给 cursor 一些喘息
          writable.write(encoder.encode(_formatRow(rec)));
          written++;
        }, opts);
        await writable.close();
        return { ok: true, total, written, mode: 'fs-access', files: 1 };
      } catch (err) {
        if (err && err.name === 'AbortError') {
          return { ok: false, total, mode: 'fs-access', cancelled: true };
        }
        // 失败兜底走 fallback
        console.warn('[JZCollectorDB] showSaveFilePicker failed, fallback:', err);
      }
    }

    // Path B: fallback — 切片 500/份，多个 a.click 下载
    const SLICE = 500;
    let buffer = CSV_HEADER;
    let inSlice = 0;
    let sliceIdx = 0;
    const downloads = [];
    const triggerDownload = () => {
      if (inSlice === 0) return;
      const blob = new Blob([buffer], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filenameBase}_${sliceIdx + 1}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      downloads.push(a.download);
      sliceIdx++;
      buffer = CSV_HEADER;
      inSlice = 0;
    };
    await _streamSales((rec) => {
      buffer += _formatRow(rec);
      inSlice++;
      if (inSlice >= SLICE) triggerDownload();
    }, opts);
    triggerDownload();
    return { ok: true, total, mode: 'fallback', files: sliceIdx, filenames: downloads };
  }

  // ─── keywords ──────────────────────────────────────────
  async function addKeywords(texts) {
    await init();
    if (!texts || texts.length === 0) return 0;
    const tx = _db.transaction([STORE_KEYWORDS], 'readwrite');
    const store = tx.objectStore(STORE_KEYWORDS);
    let n = 0;
    for (const raw of texts) {
      const text = String(raw || '').trim();
      if (!text) continue;
      store.add({
        text,
        maxCollectNumber: 0,
        status: 'pending',
        collectedCount: 0,
        createdAt: Date.now(),
      });
      n++;
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
    _broadcast({ type: 'keyword-changed' });
    return n;
  }

  async function getKeywords(opts = {}) {
    await init();
    const store = _store(STORE_KEYWORDS);
    if (opts.status) {
      return _wrap(store.index('status').getAll(opts.status));
    }
    return _wrap(store.getAll());
  }

  async function getNextPendingKeyword() {
    const list = await getKeywords({ status: 'pending' });
    if (!list.length) return null;
    return list.sort((a, b) => a.id - b.id)[0];
  }

  async function updateKeyword(id, patch) {
    await init();
    const store = _store(STORE_KEYWORDS, 'readwrite');
    const existing = await _wrap(store.get(id));
    if (!existing) return null;
    Object.assign(existing, patch);
    await _wrap(store.put(existing));
    _broadcast({ type: 'keyword-changed' });
    return existing;
  }

  async function removeKeyword(id) {
    await init();
    await _wrap(_store(STORE_KEYWORDS, 'readwrite').delete(id));
    _broadcast({ type: 'keyword-changed' });
  }

  async function clearKeywords() {
    await init();
    await _wrap(_store(STORE_KEYWORDS, 'readwrite').clear());
    _broadcast({ type: 'keyword-changed' });
  }

  // ─── sessions ─────────────────────────────────────────
  const SESSION_KEY = 'current';

  async function setSession(patch) {
    await init();
    const store = _store(STORE_SESSIONS, 'readwrite');
    const existing = (await _wrap(store.get(SESSION_KEY))) || { key: SESSION_KEY };
    Object.assign(existing, patch, { updatedAt: Date.now() });
    await _wrap(store.put(existing));
    return existing;
  }

  async function getSession() {
    await init();
    return _wrap(_store(STORE_SESSIONS).get(SESSION_KEY));
  }

  async function clearSession() {
    await init();
    await _wrap(_store(STORE_SESSIONS, 'readwrite').delete(SESSION_KEY));
  }

  // ─── failures ─────────────────────────────────────────
  async function addFailure(rec) {
    await init();
    if (!rec || !rec.taskId) throw new Error('taskId required');
    if (!rec.lastTriedAt) rec.lastTriedAt = Date.now();
    if (!rec.attempts) rec.attempts = 1;
    await _wrap(_store(STORE_FAILURES, 'readwrite').put(rec));
  }

  async function getFailures(opts = {}) {
    await init();
    const store = _store(STORE_FAILURES);
    if (opts.keyword) {
      return _wrap(store.index('keyword').getAll(opts.keyword));
    }
    return _wrap(store.getAll());
  }

  async function removeFailure(taskId) {
    await init();
    await _wrap(_store(STORE_FAILURES, 'readwrite').delete(taskId));
  }

  async function clearFailures() {
    await init();
    await _wrap(_store(STORE_FAILURES, 'readwrite').clear());
  }

  function onChange(cb) {
    _changeListeners.add(cb);
    return () => _changeListeners.delete(cb);
  }

  window.JZCollectorDB = {
    _v2: true,
    init,
    // sales
    putSale,
    putSaleBatch,
    getSale,
    getAllSales,
    getSalesSince,
    countSales,
    markPushed,
    deleteSale,
    clearSales,
    exportCsv,
    // keywords
    addKeywords,
    getKeywords,
    getNextPendingKeyword,
    updateKeyword,
    removeKeyword,
    clearKeywords,
    // sessions
    setSession,
    getSession,
    clearSession,
    // failures
    addFailure,
    getFailures,
    removeFailure,
    clearFailures,
    // util
    onChange,
  };
})();
