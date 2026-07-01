/**
 * 标题质量预检（纯函数、无 LLM、无网络、无副作用）。
 *
 * 跟卖复制源 SKU 标题前做一次「明显问题」体检：只在标题有明显瑕疵时报警，
 * 宁可漏报不要误报。返回 { level, issues } 供 UI 决定是否提示用户开 AI 重写或手改。
 *
 * 双导出：浏览器 content script 用 self.JZTitleQuality；node 单测用 module.exports。
 * 与 0.13.31.1/lib/title-quality.js 同款 IIFE 模式，但返回结构与规则按本任务约定。
 */
(function (root) {
  'use strict';

  // 默认阈值（可被 options 覆盖）
  var DEFAULT_MIN_LENGTH = 10;   // 低于此长度 → warn「偏短」
  var DEFAULT_MAX_LENGTH = 200;  // Ozon 名称硬上限，超出 → warn
  var HARD_MIN_LENGTH = 3;       // 低于此长度 → bad「过短」（不可配置）

  // 疑似无意义的占位标题（小写匹配）
  var MEANINGLESS_TITLES = {
    'test': 1, 'тест': 1, 'asdf': 1, 'qwerty': 1,
    'sample': 1, 'пример': 1, 'заголовок': 1, 'title': 1, 'название': 1
  };

  // 连续重复字符：同一个非空白字符连续出现 ≥4 次（如 aaaa、1111）
  var RE_REPEAT = /(\S)\1{3,}/;
  // 字母或数字（用于判「纯标点」——无任何字母/数字即视为无意义）
  var RE_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

  /**
   * 标题质量预检主函数。
   * @param {string} title 待检标题
   * @param {{maxLength?: number, minLength?: number}} [options] 覆盖默认阈值
   * @returns {{ level: 'ok'|'warn'|'bad', issues: string[] }}
   *   level 优先级：bad > warn > ok，多个 issue 取最高 level。
   */
  function checkTitleQuality(title, options) {
    var opts = options || {};
    var minLength = typeof opts.minLength === 'number' ? opts.minLength : DEFAULT_MIN_LENGTH;
    var maxLength = typeof opts.maxLength === 'number' ? opts.maxLength : DEFAULT_MAX_LENGTH;

    // 内部先记录 { level, msg }，最后聚合成 { level, issues: string[] }
    var records = [];
    function add(level, msg) { records.push({ level: level, msg: msg }); }

    var name = (title == null ? '' : String(title)).trim();

    if (!name) {
      // 空标题：最高优先级 bad，不再做其它判断
      add('bad', '标题为空');
    } else {
      // 长度（分层：过短 bad / 偏短 warn / 过长 warn）
      if (name.length < HARD_MIN_LENGTH) {
        add('bad', '标题过短');
      } else if (name.length < minLength) {
        add('warn', '标题偏短，可能影响搜索曝光');
      }
      if (name.length > maxLength) {
        add('warn', '标题过长，Ozon 上限 ' + maxLength + ' 字符');
      }

      // 纯数字（去空格后全是数字）
      var compact = name.replace(/\s+/g, '');
      if (compact && /^\d+$/.test(compact)) {
        add('warn', '标题纯数字，建议添加文字描述');
      }

      // 连续重复字符（≥4）
      if (RE_REPEAT.test(name)) {
        add('warn', '标题含重复字符');
      }

      // 疑似无意义：命中占位词，或纯标点（无任何字母/数字）
      var lower = name.toLowerCase();
      if (MEANINGLESS_TITLES[lower] || !RE_LETTER_OR_DIGIT.test(name)) {
        add('warn', '标题疑似无意义');
      }
    }

    // 聚合 level：bad > warn > ok
    var level = 'ok';
    for (var i = 0; i < records.length; i++) {
      var lv = records[i].level;
      if (lv === 'bad') { level = 'bad'; break; }
      if (lv === 'warn') { level = 'warn'; }
    }

    var issues = [];
    for (var j = 0; j < records.length; j++) issues.push(records[j].msg);

    return { level: level, issues: issues };
  }

  var api = { checkTitleQuality: checkTitleQuality };
  if (root) root.JZTitleQuality = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // —— 简单自检：直接 `node src/lib/title-quality.js` 运行验证 ——
  if (typeof require !== 'undefined' && require.main === module) {
    if (checkTitleQuality('').level !== 'bad') throw new Error('空标题应为 bad');
    if (checkTitleQuality('ab').level !== 'bad') throw new Error('过短(<3)应为 bad');
    if (checkTitleQuality('aaaa bbbb').level !== 'warn') throw new Error('重复字符应为 warn');
    if (checkTitleQuality('12345').level !== 'warn') throw new Error('纯数字应为 warn');
    if (checkTitleQuality('正常商品标题描述示例文字').level !== 'ok') throw new Error('正常标题应为 ok');
    console.log('title-quality self-check passed');
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null));
