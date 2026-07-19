/* =========================================================
 * API 直取翻页器(独立于 DOM AutoScroller)
 *
 * 设计动机:
 *   DOM 滚动翻页依赖页面渲染完成,慢(2-4s/页)且脆弱(Ozon 改版即失效)。
 *   本方案直接调 Ozon entrypoint-api.bx/page/json/v2 接口拿分页数据,
 *   速度提升 ~10 倍(200-500ms/页),不干扰用户浏览,不依赖 DOM 结构。
 *
 * 工作流程:
 *   1. start() → fetch 首页 entrypoint-api(path=/seller/{slug}/)
 *   2. 解析 widgetStates.tileGridDesktop-*.items → SKU 列表
 *   3. 对每个 SKU: 调 onCardExtracted 回调(由调用方写缓存 + submitTask)
 *   4. 解析 widgetStates.infiniteVirtualPaginator-*.nextPage
 *   5. nextPage 非空 → fetch 下一页,循环(受 intervalMs 节流)
 *   6. nextPage 为空 → onEmpty 回调
 *
 * 终止条件:
 *   - nextPage 为空(到达最后一页)
 *   - stop() 被调用(用户手动停止)
 *   - fetch 连续失败 maxConsecutiveErrors 次
 *
 * 与 DOM AutoScroller 的差异:
 *   - 不滚动页面(后台 fetch)
 *   - 不依赖 isReadyToScroll / getCardCount
 *   - 节流参数是 fetch 间隔,不是滚动间隔
 *   - 不监听 taskQueue 拥塞(调用方可通过 pause/resume 控制)
 * ========================================================= */
(() => {
  if (window.QXApiScroller) return; // 守卫,防止重复加载

  const ENTRYPOINT_API_BASE = 'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=';

  // 默认配置
  const _DEFAULTS = {
    intervalMs: 800, // 翻页间隔(毫秒),默认 800ms(比 DOM 滚动快 3-5 倍)
    maxConsecutiveErrors: 3, // 连续失败次数上限,超过则停止
    requestTimeoutMs: 15000, // 单次 fetch 超时
  };

  /**
   * 从 tileGridDesktop item 提取 card 5 字段 + 扩展字段
   * 字段对齐 ozon-data-panel.js 的 __jzExtractCardInfo:
   *   sku / name / price / imageUrl / ratingCount
   * 扩展字段(原 DOM 采集没有,API 独有):
   *   originalPrice / rating / url
   */
  function _extractCardFromItem(item) {
    let name = '';
    let price = null;
    let originalPrice = null;
    let rating = null;
    let ratingCount = null;

    for (const st of item.mainState || []) {
      // 商品名: textDS + automatizationId='tile-name'
      if (st.type === 'textDS' && st.textDS?.testInfo?.automatizationId === 'tile-name') {
        name = st.textDS.text || '';
      }
      // 价格: priceV2.price 数组,PRICE=售价,ORIGINAL_PRICE=划线价
      if (st.type === 'priceV2' && Array.isArray(st.priceV2?.price)) {
        for (const p of st.priceV2.price) {
          const m = String(p.text || '').match(/([\d.,]+)/);
          if (!m) continue;
          // "18,60 ¥" → 18.60 (俄文逗号小数点)
          const n = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
          if (!isFinite(n)) continue;
          if (p.textStyle === 'PRICE') price = n;
          else if (p.textStyle === 'ORIGINAL_PRICE') originalPrice = n;
        }
      }
      // 评分 + 评论数: labelListV2.items 中找特定 icon
      if (st.type === 'labelListV2' && Array.isArray(st.labelListV2?.items)) {
        const labelItems = st.labelListV2.items;
        for (let i = 0; i < labelItems.length; i++) {
          const it = labelItems[i];
          // 评分: ic_s_star_filled_compact 后的 text
          if (it.type === 'icon' && it.icon?.icon?.icon === 'ic_s_star_filled_compact') {
            const next = labelItems[i + 1];
            if (next?.type === 'text') rating = next.text.text || null;
          }
          // 评论数: ic_s_dialog_filled_compact 后的 text("111 отзывов" → 111)
          if (it.type === 'icon' && it.icon?.icon?.icon === 'ic_s_dialog_filled_compact') {
            const next = labelItems[i + 1];
            if (next?.type === 'text') {
              const m = String(next.text.text || '').match(/(\d+)/);
              if (m) ratingCount = parseInt(m[1], 10);
            }
          }
        }
      }
    }

    // 图片: tileImage.items[0].image.link
    let imageUrl = '';
    const imgItems = item.tileImage?.items || [];
    if (imgItems.length > 0 && imgItems[0].image?.link) {
      imageUrl = imgItems[0].image.link;
    }

    // 商品 URL: action.link
    const url = item.action?.link || '';

    return {
      sku: String(item.sku || ''),
      name,
      price,
      originalPrice,
      rating,
      ratingCount,
      imageUrl,
      url,
    };
  }

  /**
   * 从 entrypoint-api 响应中提取 tileGrid state 和分页器 state
   * 返回 { items, nextPage, sellerId, page }
   */
  function _parseEntryResponse(data) {
    if (!data || !data.widgetStates) {
      return { items: [], nextPage: null, sellerId: null, page: null };
    }

    // 找 tileGridDesktop widget
    const tileGridKey = Object.keys(data.widgetStates).find((k) => k.startsWith('tileGridDesktop'));
    let items = [];
    let page = null;
    if (tileGridKey) {
      try {
        const state = JSON.parse(data.widgetStates[tileGridKey]);
        items = Array.isArray(state.items) ? state.items : [];
        page = state.page ?? null;
      } catch (e) {
        console.warn('[ApiScroller] parse tileGridState failed:', e?.message);
      }
    }

    // 找 infiniteVirtualPaginator widget(含 nextPage)
    let nextPage = data.nextPage || null;
    const pagKey = Object.keys(data.widgetStates).find((k) => k.startsWith('infiniteVirtualPaginator'));
    if (pagKey) {
      try {
        const pag = JSON.parse(data.widgetStates[pagKey]);
        // 优先用 paginator 的 nextPage(首页顶层 nextPage 为空,但 paginator 中有)
        if (pag.nextPage) nextPage = pag.nextPage;
      } catch (e) {
        console.warn('[ApiScroller] parse paginator failed:', e?.message);
      }
    }

    // sellerId 在 pageInfo.analyticsInfo
    const sellerId = data.pageInfo?.analyticsInfo?.sellerId || null;

    return { items, nextPage, sellerId, page };
  }

  /**
   * fetch 单页 entrypoint-api
   * path 为相对路径(如 /seller/huiying-1837894/?layout_page_index=2&...)
   *
   * URL 构造说明:
   *   Ozon entrypoint-api 的 url 参数是一个完整的 path+query,
   *   例如 /seller/lantuo01/?layout_page_index=2&page=2&paginator_token=...
   *   这个 path 本身就包含 & = ? 等字符,它们是 path 自身 query 的分隔符,
   *   必须作为字面量传递,不能被 encodeURIComponent 转义。
   *
   *   错误做法: ENTRYPOINT_API_BASE + encodeURIComponent(path)
   *     → url=%2Fseller%2Flantuo01%2F%3Flayout_page_index%3D2%26page%3D2
   *     会导致 Ozon 后端把整个 path 当成一个无意义的字符串,无法解析分页参数
   *
   *   正确做法: ENTRYPOINT_API_BASE + path
   *     → url=/seller/lantuo01/?layout_page_index=2&page=2
   *     path 中的 & = ? 作为顶层 query 的一部分,Ozon 后端能正确解析
   *
   *   安全性:path 来自 Ozon 自己返回的 nextPage 字段,格式可控,
   *   不会包含 # 或其他会破坏顶层 URL 结构的字符。
   */
  async function _fetchEntryPage(path, timeoutMs) {
    const url = ENTRYPOINT_API_BASE + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        credentials: 'include',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  class QXApiScroller {
    constructor(opts = {}) {
      this.opts = { ..._DEFAULTS, ...opts };
      // 外部回调
      this.onCardExtracted = opts.onCardExtracted || null; // (card) => void
      this.onPageDone = opts.onPageDone || null; // (pageInfo) => void
      this.onEmpty = opts.onEmpty || null; // () => void
      this.onError = opts.onError || null; // (err) => void
      // 运行时状态
      this._running = false;
      this._stopped = false;
      this._currentPage = 0;
      this._totalCards = 0;
      this._sellerSlug = opts.sellerSlug || '';
      this._sellerId = opts.sellerId || '';
      this._firstPagePath = opts.firstPagePath || '';
      this._nextPagePath = null;
      this._consecutiveErrors = 0;
      // 状态追踪(供 getStatus 读取,与 AutoScroller getScrollStatus 结构对齐)
      // phase: 'idle' | 'fetching' | 'throttling' | 'error-backoff' | 'completed'
      this._phase = 'idle';
      this._phaseStartedAt = 0; // 当前 phase 开始时间戳
      this._throttleUntil = 0; // 节流结束时间戳(用于显示"距下次请求 Xs")
      this._lastError = null; // 最近一次错误
      this._lastPageDoneAt = 0; // 最近一次成功翻页时间戳
    }

    /**
     * 启动 API 翻页
     * @param {object} startOpts
     * @param {string} startOpts.sellerSlug - 店铺 slug(如 huiying-1837894)
     * @param {string} [startOpts.firstPagePath] - 首页 path,默认 /seller/{slug}/
     */
    async start(startOpts = {}) {
      if (this._running) return;
      const slug = startOpts.sellerSlug || this._sellerSlug;
      if (!slug) {
        this.onError?.(new Error('sellerSlug required'));
        return;
      }
      this._sellerSlug = slug;
      this._firstPagePath = startOpts.firstPagePath || `/seller/${slug}/`;
      this._running = true;
      this._stopped = false;
      this._currentPage = 0;
      this._totalCards = 0;
      this._consecutiveErrors = 0;
      this._nextPagePath = this._firstPagePath;
      this._setPhase('fetching');
      console.log(`[ApiScroller] 启动, slug=${slug}, firstPage=${this._firstPagePath}`);
      await this._loop();
    }

    /** 切换 phase 并记录开始时间 */
    _setPhase(phase) {
      this._phase = phase;
      this._phaseStartedAt = Date.now();
    }

    /**
     * 获取当前状态(与 AutoScroller.getScrollStatus 结构兼容)
     * 返回 { status, reason, detail }
     * status 枚举: idle / scrolling / congested / completed / failed
     *   - idle: 未启动
     *   - scrolling: 正在 fetch 或节流等待(正常进行中)
     *   - congested: 连续失败重试中(类比 DOM 模式的队列拥塞)
     *   - completed: 全部页抓取完成
     *   - failed: 连续失败达到上限,已停止
     *
     * 注:completed 和 failed 都是终态(_running=false),ozon-data-panel.js 的
     *   500ms 轮询 timer 需把两者都识别为终态(走"显示完成"分支,而非"未开启")。
     */
    getStatus() {
      if (!this._running) {
        if (this._phase === 'completed') {
          return {
            status: 'completed',
            reason: '抓取完成',
            detail: `共 ${this._currentPage} 页`,
          };
        }
        if (this._phase === 'failed') {
          return {
            status: 'failed',
            reason: '抓取失败',
            detail: this._lastError?.message || `连续失败 ${this._consecutiveErrors} 次`,
          };
        }
        return { status: 'idle', reason: '未启动', detail: '' };
      }
      // 运行中:按 phase 映射
      // 注:不再在 detail 中显示"累计 XX 个 SKU",该信息已统一由面板上
      //     "店铺SKU发现 XX 采集XX个 略过XX个"区块展示(数据源 collect-status.js 的
      //     _storeCollectedSkus Set,DOM/API 两种模式共用,避免双计数)
      if (this._phase === 'error-backoff' || this._consecutiveErrors > 0) {
        return {
          status: 'congested',
          reason: '请求失败,重试中',
          detail: `${this._consecutiveErrors}/${this.opts.maxConsecutiveErrors} 次`,
        };
      }
      if (this._phase === 'throttling') {
        const remainMs = Math.max(0, this._throttleUntil - Date.now());
        const remainSec = Math.ceil(remainMs / 1000);
        return {
          status: 'scrolling',
          reason: `第${this._currentPage}页完成,等待下一页`,
          detail: remainSec > 0 ? `距下次请求 ${remainSec}s` : '',
        };
      }
      // fetching 或其他运行中 phase
      return {
        status: 'scrolling',
        reason: `正在抓取第${this._currentPage + 1}页`,
        detail: '',
      };
    }

    /** 兼容 AutoScroller.isUserActive() 语义:是否用户主动启动且未完成 */
    isUserActive() {
      return this._running;
    }

    // 兼容 AutoScroller.getScrollStatus() 方法名(ozon-data-panel.js 轮询 timer 调此名)
    getScrollStatus() {
      return this.getStatus();
    }

    /** 停止翻页 */
    stop() {
      if (!this._running) return;
      this._stopped = true;
      this._running = false;
      console.log(`[ApiScroller] 停止,已采集 ${this._totalCards} 个 SKU`);
    }

    isRunning() {
      return this._running;
    }

    getStats() {
      return {
        running: this._running,
        currentPage: this._currentPage,
        totalCards: this._totalCards,
        sellerSlug: this._sellerSlug,
      };
    }

    /** 主循环: fetch → 解析 → 回调 → 节流 → 下一页 */
    async _loop() {
      while (!this._stopped && this._nextPagePath) {
        const pageStartTime = Date.now();
        try {
          this._setPhase('fetching');
          const data = await _fetchEntryPage(this._nextPagePath, this.opts.requestTimeoutMs);
          const { items, nextPage, sellerId, page } = _parseEntryResponse(data);

          this._currentPage = page || this._currentPage + 1;
          if (sellerId) this._sellerId = String(sellerId);

          // 提取每个 SKU 并回调
          for (const item of items) {
            if (this._stopped) break;
            const card = _extractCardFromItem(item);
            if (!card.sku) continue;
            this._totalCards++;
            try {
              this.onCardExtracted?.(card);
            } catch (e) {
              console.warn('[ApiScroller] onCardExtracted callback error:', e?.message);
            }
          }

          this._consecutiveErrors = 0;
          this._nextPagePath = nextPage || null;
          this._lastPageDoneAt = Date.now();

          const duration = Date.now() - pageStartTime;
          console.log(
            `[ApiScroller] 第${this._currentPage}页完成: ${items.length} 个 SKU, 耗时 ${duration}ms` +
              (nextPage ? `, 下一页存在` : ', 已到最后一页')
          );

          this.onPageDone?.({
            page: this._currentPage,
            itemsCount: items.length,
            totalCards: this._totalCards,
            duration,
            hasNext: !!nextPage,
          });

          // 终止: nextPage 为空
          if (!nextPage) {
            this._running = false;
            this._setPhase('completed');
            console.log(`[ApiScroller] 全部完成,共 ${this._totalCards} 个 SKU`);
            this.onEmpty?.();
            break;
          }

          // 节流: 等待 intervalMs(速度配置生效)
          if (this.opts.intervalMs > 0) {
            this._setPhase('throttling');
            this._throttleUntil = Date.now() + this.opts.intervalMs;
            await new Promise((r) => setTimeout(r, this.opts.intervalMs));
          }
        } catch (err) {
          this._consecutiveErrors++;
          this._lastError = err;
          console.warn(
            `[ApiScroller] 第${this._currentPage + 1}页失败(${this._consecutiveErrors}/${this.opts.maxConsecutiveErrors}):`,
            err?.message || err
          );
          this.onError?.(err);

          if (this._consecutiveErrors >= this.opts.maxConsecutiveErrors) {
            console.error(`[ApiScroller] 连续失败 ${this._consecutiveErrors} 次,停止`);
            this._running = false;
            // 设置 phase='failed' 让 getStatus 返回终态而非"未启动",
            // panel 上会显示"抓取失败" + 具体错误信息(如 HTTP 429)
            this._setPhase('failed');
            this.onError?.(new Error(`连续失败 ${this._consecutiveErrors} 次,已停止`));
            break;
          }
          // 退避后重试同一页
          this._setPhase('error-backoff');
          const backoff = Math.min(5000, 1000 * this._consecutiveErrors);
          this._throttleUntil = Date.now() + backoff;
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
      this._running = false;
    }
  }

  window.QXApiScroller = QXApiScroller;
})();
