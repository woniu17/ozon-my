/**
 * ERP 质检单高亮 - popup 设置页
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'qc_prefixes';
  const DEFAULT_PREFIXES = ['02131', '02478'];

  const $textarea = document.getElementById('prefixes');
  const $save = document.getElementById('save');
  const $reset = document.getElementById('reset');
  const $toast = document.getElementById('toast');

  function showToast(msg, isError) {
    if (!$toast) return;
    $toast.textContent = msg;
    $toast.classList.toggle('toast-error', !!isError);
    $toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      $toast.hidden = true;
    }, 2000);
  }

  function load() {
    chrome.storage.sync.get([STORAGE_KEY], (res) => {
      const list = res && Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : DEFAULT_PREFIXES;
      $textarea.value = list.filter((s) => typeof s === 'string' && s.trim()).join('\n');
    });
  }

  function save() {
    const raw = $textarea.value || '';
    const list = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const finalList = list.length ? list : DEFAULT_PREFIXES.slice();
    chrome.storage.sync.set({ [STORAGE_KEY]: finalList }, () => {
      if (chrome.runtime.lastError) {
        showToast('保存失败：' + chrome.runtime.lastError.message, true);
        return;
      }
      $textarea.value = finalList.join('\n');
      showToast('已保存（共 ' + finalList.length + ' 条）');
    });
  }

  function reset() {
    chrome.storage.sync.set({ [STORAGE_KEY]: DEFAULT_PREFIXES.slice() }, () => {
      $textarea.value = DEFAULT_PREFIXES.join('\n');
      showToast('已恢复默认');
    });
  }

  $save.addEventListener('click', save);
  $reset.addEventListener('click', reset);
  document.addEventListener('DOMContentLoaded', load);
})();
