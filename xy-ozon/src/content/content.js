// Content 主入口 —— 统一挂载所有内容脚本模块。
// 注入条件:Ozon 任意页(www.ozon.ru / ozon.ru / ozon.kz)。
//   - 商品页(/product/):挂 Action Bar + Sidebar 数据卡
//   - 所有页:挂采集器浮动面板(受 storage 开关控制)
//   - 搜索/分类/以图搜图页:挂数据面板(商品卡注入,受 storage 开关控制)

(function () {
  'use strict';

  if (window.__XY_CONTENT_LOADED__) return;
  window.__XY_CONTENT_LOADED__ = true;

  function isProductPage() {
    return /\/product\//.test(window.location.pathname);
  }

  function isSearchOrCategoryPage() {
    return /\/(search|category|search-by-image)/.test(window.location.pathname);
  }

  function mountProductPageModules() {
    // 挂载右侧浮动动作栏(品牌头 + 8 按钮)
    if (self.JZActionBar?.mount) {
      self.JZActionBar.mount();
    }
    // 挂载右侧栏数据卡(hero 4 卡 + 5 分组 + 上架/采集按钮)
    if (self.JZSidebarCard?.mount) {
      self.JZSidebarCard.mount();
    }
  }

  function mountCollectorPanel() {
    if (self.JZCollectorPanel?.mount) {
      self.JZCollectorPanel.mount();
    }
  }

  function mountDataPanel() {
    if (self.JZDataPanel?.mount) {
      self.JZDataPanel.mount();
    }
  }

  function boot() {
    const mountAll = () => {
      // 商品页:Action Bar + Sidebar 数据卡
      if (isProductPage()) {
        mountProductPageModules();
      }
      // 所有页:采集器浮动面板(内部自行判断 storage 开关)
      mountCollectorPanel();
      // 搜索/分类/以图搜图页:数据面板(商品卡注入)
      if (isSearchOrCategoryPage()) {
        mountDataPanel();
      }
    };

    if (document.body) {
      mountAll();
    } else {
      document.addEventListener('DOMContentLoaded', mountAll, { once: true });
    }
  }

  boot();
})();
