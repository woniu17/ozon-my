// 跟卖数据清洗/转换纯函数库 —— 从原项目 lib/follow-sell-content-copy.js 抽离。
// 不发任何网络请求,只做描述抽取 / 标签规范化 / 富内容解析。
// 同时挂到 self.JZFollowSellContentCopy 供 content script 使用,
// 并兼容 CommonJS 供单测 require。
(function (root) {
  'use strict';

  function safeText(value, max) {
    if (value == null) return '';
    const text = String(value).replace(/\s+/g, ' ').trim();
    return max && text.length > max ? text.slice(0, max) : text;
  }

  function htmlToText(value) {
    return String(value || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ');
  }

  function extractRichContentText(value, max) {
    const maxChars = max || 2000;
    let doc = value;
    if (typeof value === 'string') {
      try {
        doc = JSON.parse(value);
      } catch {
        return '';
      }
    }
    if (!doc || typeof doc !== 'object') return '';

    const skipKeys = new Set([
      'widgetName',
      'align',
      'size',
      'color',
      'type',
      'src',
      'img',
      'imgLink',
      'url',
      'link',
      'gifUrl',
      'videoUrl',
      'previewUrl',
      'backgroundColor',
      'theme',
      'padding',
      'margin',
      'id',
      'reff',
      'fontColor',
      'borderColor',
      'characteristics',
      'specifications',
      'reviews',
      'questions',
      'comments',
      'aspects',
      'params',
      'feedbacks',
      'hashtags',
      'tags',
    ]);
    const out = [];
    let total = 0;
    const pushText = (raw) => {
      if (total >= maxChars) return;
      const text = safeText(htmlToText(raw));
      if (text.length < 2) return;
      if (/^https?:\/\//i.test(text)) return;
      if (!/\p{L}/u.test(text)) return;
      out.push(text);
      total += text.length + 1;
    };
    const walk = (node, key, depth) => {
      if (total >= maxChars || depth > 64) return;
      if (typeof node === 'string') {
        if (!key || !skipKeys.has(key)) pushText(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item, key, depth + 1);
        return;
      }
      if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) {
          if (skipKeys.has(k)) continue;
          walk(node[k], k, depth + 1);
        }
      }
    };

    walk(doc, undefined, 0);
    const seen = new Set();
    const deduped = out.filter((text) => {
      const key = text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return deduped.join(' ').slice(0, maxChars).trim();
  }

  function extractDescriptionText(value, max) {
    const maxChars = max || 4096;
    if (value == null) return '';
    if (typeof value === 'string') {
      const richText = extractRichContentText(value, maxChars);
      if (richText) return richText;
      if (/^\s*[[{]/.test(value)) return '';
      return safeText(htmlToText(value), maxChars);
    }
    if (typeof value !== 'object') return safeText(value, maxChars);

    const richKeys = ['richAnnotationJson', 'richContent', 'richContentJson', 'richJson'];
    for (const key of richKeys) {
      const text = extractRichContentText(value[key], maxChars);
      if (text) return text;
    }

    const directKeys = ['description', 'text', 'content', 'html', 'value'];
    for (const key of directKeys) {
      const raw = value[key];
      const richText = extractRichContentText(raw, maxChars);
      if (richText) return richText;
      if (typeof raw === 'string') {
        const text = safeText(htmlToText(raw), maxChars);
        if (text) return text;
      }
    }

    return extractRichContentText(value, maxChars);
  }

  function readSourceAttrText(sourceVariant, key) {
    const attrs = Array.isArray(sourceVariant?.attributes) ? sourceVariant.attributes : [];
    const hit = attrs.find((attr) => String(attr?.key ?? attr?.id) === String(key));
    if (!hit) return '';
    const candidates = [
      hit.value,
      Array.isArray(hit.collection) ? hit.collection.join(' ') : '',
      Array.isArray(hit.values)
        ? hit.values
            .map((v) => v?.value)
            .filter(Boolean)
            .join(' ')
        : '',
    ];
    for (const value of candidates) {
      const text = safeText(value);
      if (text) return text;
    }
    return '';
  }

  // 商品简介只取真实描述字段:自定义 → 源 4191 → 标题兜底。
  // 不再用 pageDescription(页面可见描述)兜底,避免源商品做富内容时漏点。
  function pickFollowSellDescription(input) {
    const max = input?.max || 4096;
    return (
      safeText(input?.customDescription, max) ||
      safeText(extractDescriptionText(readSourceAttrText(input?.sourceVariant, '4191'), max), max) ||
      safeText(input?.fallbackName, max)
    );
  }

  function mergeSourceDescriptionIntoVariant(sourceVariant, rawDescription) {
    const text = safeText(extractDescriptionText(rawDescription, 4096) || rawDescription, 4096);
    if (!text) return sourceVariant;
    const target = sourceVariant && typeof sourceVariant === 'object' ? sourceVariant : {};
    const attrs = Array.isArray(target.attributes) ? target.attributes : [];
    const existing = attrs.find((attr) => String(attr?.key ?? attr?.id) === '4191');
    if (existing) {
      if (existing.key == null) existing.key = String(existing.id ?? '4191');
      if (readSourceAttrText({ attributes: [existing] }, '4191')) return target;
      existing.value = text;
      return target;
    }
    target.attributes = [...attrs, { key: '4191', value: text }];
    return target;
  }

  function normalizeSourceHashtags(raw) {
    const values = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,\uFF0C]+/);
    const out = [];
    const seen = new Set();
    for (const item of values) {
      let body = safeText(item)
        .replace(/^#+/, '')
        .replace(/[\s-]+/g, '_')
        .replace(/[^A-Za-z\u0410-\u042F\u0430-\u044F\u0401\u04510-9_\u4E00-\u9FFF]/g, '')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
      if (!body) continue;
      if (body.length > 29) body = body.slice(0, 29);
      const tag = `#${body}`;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
      if (out.length >= 30) break;
    }
    return out;
  }

  function mergeSourceHashtagsIntoVariant(sourceVariant, rawHashtags) {
    const tags = normalizeSourceHashtags(rawHashtags);
    if (tags.length === 0 || !sourceVariant || typeof sourceVariant !== 'object') return sourceVariant;
    const attrs = Array.isArray(sourceVariant.attributes) ? sourceVariant.attributes : [];
    const existing = attrs.find((attr) => String(attr?.key ?? attr?.id) === '23171');
    if (existing) {
      if (existing.key == null) existing.key = String(existing.id ?? '23171');
      if (readSourceAttrText({ attributes: [existing] }, '23171')) return sourceVariant;
      existing.value = tags.join(' ');
      return sourceVariant;
    }
    sourceVariant.attributes = [...attrs, { key: '23171', value: tags.join(' ') }];
    return sourceVariant;
  }

  function shouldForceCollectRefresh(input) {
    if (!input || typeof input !== 'object') return false;
    if (safeText(input.videoUrl)) return true;
    if (safeText(input.description)) return true;
    if (safeText(input.richContent)) return true;
    return normalizeSourceHashtags(input.hashtags).length > 0;
  }

  const api = {
    safeText,
    extractDescriptionText,
    extractRichContentText,
    readSourceAttrText,
    pickFollowSellDescription,
    mergeSourceDescriptionIntoVariant,
    normalizeSourceHashtags,
    mergeSourceHashtagsIntoVariant,
    shouldForceCollectRefresh,
  };

  root.JZFollowSellContentCopy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
