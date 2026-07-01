const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeSourceHashtags,
  pickFollowSellDescription,
  extractDescriptionText,
} = require('../src/lib/content-copy.js');

test('normalizeSourceHashtags: 剥 # + 空格转下划线 + 截断 29 + 去重', () => {
  const tags = normalizeSourceHashtags(['#新品上市', 'hot sale', 'recommend', 'a'.repeat(40)]);
  assert.ok(tags.length >= 3);
  assert.strictEqual(tags[0], '#新品上市');
  assert.strictEqual(tags[1], '#hot_sale');
  assert.strictEqual(tags[2], '#recommend');
  // 截断:# + body ≤ 30,body ≤ 29
  assert.ok(tags[3].length <= 30);
  assert.ok(tags[3].slice(1).length <= 29);
});

test('normalizeSourceHashtags: 去重(大小写不敏感)', () => {
  const tags = normalizeSourceHashtags(['#Demo', 'demo', 'DEMO']);
  assert.strictEqual(tags.length, 1);
  assert.strictEqual(tags[0], '#Demo');
});

test('normalizeSourceHashtags: 最多 30 个', () => {
  const input = Array.from({ length: 50 }, (_, i) => `tag${i}`);
  const tags = normalizeSourceHashtags(input);
  assert.strictEqual(tags.length, 30);
});

test('normalizeSourceHashtags: 删非法字符(保留 CJK/俄文/字母数字下划线)', () => {
  const tags = normalizeSourceHashtags(['你好.世界', 'привет!', 'a-b_c']);
  assert.strictEqual(tags[0], '#你好世界');
  assert.strictEqual(tags[1], '#привет');
  assert.strictEqual(tags[2], '#a_b_c');
});

test('pickFollowSellDescription: 自定义描述优先', () => {
  const desc = pickFollowSellDescription({
    customDescription: '我的自定义描述',
    sourceVariant: { attributes: [{ key: '4191', value: '源描述' }] },
    fallbackName: '标题',
  });
  assert.strictEqual(desc, '我的自定义描述');
});

test('pickFollowSellDescription: 自定义为空时取源 4191', () => {
  const desc = pickFollowSellDescription({
    customDescription: '',
    sourceVariant: { attributes: [{ key: '4191', value: '源描述' }] },
    fallbackName: '标题',
  });
  assert.strictEqual(desc, '源描述');
});

test('pickFollowSellDescription: 源无 4191 时退标题', () => {
  const desc = pickFollowSellDescription({
    customDescription: '',
    sourceVariant: { attributes: [] },
    fallbackName: '标题兜底',
  });
  assert.strictEqual(desc, '标题兜底');
});

test('extractDescriptionText: 富 JSON walker 抽取文本', () => {
  const rich = JSON.stringify({
    widgetName: 'text',
    items: [{ text: '第一段描述' }, { text: '第二段描述' }],
  });
  const text = extractDescriptionText(rich);
  assert.ok(text.includes('第一段描述'));
  assert.ok(text.includes('第二段描述'));
  assert.ok(!text.includes('widgetName'));
});

test('extractDescriptionText: HTML 剥离', () => {
  const text = extractDescriptionText('<p>hello</p><br/><b>world</b>');
  assert.ok(text.includes('hello'));
  assert.ok(text.includes('world'));
  assert.ok(!text.includes('<'));
});
