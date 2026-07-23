// 单元测试:采集任务提交决策逻辑
//
// 从 shared-utils.js __jzSubmitCollectTask (行 3904-3955) 提取的决策逻辑。
// 纯函数,不依赖 chrome/DOM,可快速验证各种场景下是否提交任务。
//
// 运行: node --test test/unit/collect-decision.test.js
//
// 决策分支:
//   1. already-seen      — _autoCollectSeen 已含 sku → 跳过
//   2. non-mainland-china-store — checkStoreClass 返回 isMainlandChina=false → 跳过 + 永久标记
//   3. unclassified-store — checkStoreClass 返回 null/isMainlandChina=null → 跳过(不标记,允许重试)
//   4. checkStoreClass-error — checkStoreClass 抛异常 → 跳过(不标记,允许重试)
//   5. submit — 通过所有检查 → 提交 + 标记

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 决策函数:根据 sku、config、店铺分类结果、去重集合,决定是否提交采集任务。
 *
 * 此函数从 shared-utils.js __jzSubmitCollectTask 提取,两者逻辑必须保持一致。
 * 修改任一处时需同步另一处。
 *
 * @param {object} params
 * @param {string|number} params.sku
 * @param {object} params.config - autoCollect 配置(至少含 onlyMainlandChinaStores)
 * @param {string} params.sellerSlug - 当前页卖家 slug(空字符串表示非店铺页)
 * @param {object|null|undefined} params.storeClassResult - checkStoreClass 返回值
 * @param {boolean} params.storeClassError - checkStoreClass 是否出错
 * @param {Set<string>} params.seenSet - 已见 SKU 集合
 * @returns {{ action: 'submit'|'skip', reason: string, markSeen: boolean }}
 */
function decideCollectSubmission({ sku, config, sellerSlug, storeClassResult, storeClassError, seenSet }) {
  const skuStr = String(sku);

  // 1. 页面级去重
  if (seenSet.has(skuStr)) {
    return { action: 'skip', reason: 'already-seen', markSeen: false };
  }

  // 2. 中国店铺筛选(仅在店铺页 + 开启 onlyMainlandChinaStores 时执行)
  if (config.onlyMainlandChinaStores && sellerSlug) {
    if (storeClassError) {
      return { action: 'skip', reason: 'checkStoreClass-error', markSeen: false };
    }
    if (storeClassResult?.isMainlandChina === false) {
      return { action: 'skip', reason: 'non-mainland-china-store', markSeen: true };
    }
    if (storeClassResult?.isMainlandChina !== true) {
      return { action: 'skip', reason: 'unclassified-store', markSeen: false };
    }
  }

  // 3. 通过所有检查,提交
  return { action: 'submit', reason: 'ok', markSeen: true };
}

// ─── 测试场景 ─────────────────────────────────────────────

describe('decideCollectSubmission', () => {
  const BASE_CONFIG = { onlyMainlandChinaStores: true };
  const CHINA_SHOP = 'mock-china-shop';

  test('1. already-seen: sku 已在 seenSet → 跳过,不标记', () => {
    const seenSet = new Set(['100001']);
    const result = decideCollectSubmission({
      sku: '100001',
      config: BASE_CONFIG,
      sellerSlug: CHINA_SHOP,
      storeClassResult: { isMainlandChina: true },
      storeClassError: false,
      seenSet,
    });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'already-seen');
    assert.equal(result.markSeen, false);
  });

  test('2. non-mainland-china-store: isMainlandChina=false → 跳过 + 永久标记', () => {
    const seenSet = new Set();
    const result = decideCollectSubmission({
      sku: '100001',
      config: BASE_CONFIG,
      sellerSlug: CHINA_SHOP,
      storeClassResult: { isMainlandChina: false, classifiedBy: 'manual' },
      storeClassError: false,
      seenSet,
    });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'non-mainland-china-store');
    assert.equal(result.markSeen, true);
  });

  test('3a. unclassified-store: result=null → 跳过,不标记(允许重试)', () => {
    const seenSet = new Set();
    const result = decideCollectSubmission({
      sku: '100001',
      config: BASE_CONFIG,
      sellerSlug: CHINA_SHOP,
      storeClassResult: null,
      storeClassError: false,
      seenSet,
    });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'unclassified-store');
    assert.equal(result.markSeen, false);
  });

  test('3b. unclassified-store: isMainlandChina=null → 跳过,不标记(允许重试)', () => {
    const seenSet = new Set();
    const result = decideCollectSubmission({
      sku: '100001',
      config: BASE_CONFIG,
      sellerSlug: CHINA_SHOP,
      storeClassResult: { isMainlandChina: null },
      storeClassError: false,
      seenSet,
    });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'unclassified-store');
    assert.equal(result.markSeen, false);
  });

  test('3c. unclassified-store: isMainlandChina=undefined → 跳过,不标记(允许重试)', () => {
    const seenSet = new Set();
    const result = decideCollectSubmission({
      sku: '100001',
      config: BASE_CONFIG,
      sellerSlug: CHINA_SHOP,
      storeClassResult: { isMainlandChina: undefined },
      storeClassError: false,
      seenSet,
    });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'unclassified-store');
    assert.equal(result.markSeen, false);
  });

  test('4. checkStoreClass-error: 异常 → 跳过,不标记(允许重试)', () => {
    const seenSet = new Set();
    const result = decideCollectSubmission({
      sku: '100001',
      config: BASE_CONFIG,
      sellerSlug: CHINA_SHOP,
      storeClassResult: undefined,
      storeClassError: true,
      seenSet,
    });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'checkStoreClass-error');
    assert.equal(result.markSeen, false);
  });

  test('5. submit-mainland-china: isMainlandChina=true → 提交 + 标记', () => {
    const seenSet = new Set();
    const result = decideCollectSubmission({
      sku: '100001',
      config: BASE_CONFIG,
      sellerSlug: CHINA_SHOP,
      storeClassResult: { isMainlandChina: true, classifiedBy: 'manual' },
      storeClassError: false,
      seenSet,
    });
    assert.equal(result.action, 'submit');
    assert.equal(result.reason, 'ok');
    assert.equal(result.markSeen, true);
  });

  test('6. submit-no-filter: onlyMainlandChinaStores=false → 跳过筛选,直接提交', () => {
    const seenSet = new Set();
    const result = decideCollectSubmission({
      sku: '100001',
      config: { onlyMainlandChinaStores: false },
      sellerSlug: CHINA_SHOP,
      storeClassResult: null, // 即使未分类也提交
      storeClassError: false,
      seenSet,
    });
    assert.equal(result.action, 'submit');
    assert.equal(result.reason, 'ok');
  });

  test('7. submit-no-slug: sellerSlug 为空 → 跳过筛选,直接提交', () => {
    const seenSet = new Set();
    const result = decideCollectSubmission({
      sku: '100001',
      config: BASE_CONFIG,
      sellerSlug: '', // 非店铺页(搜索页等)
      storeClassResult: null,
      storeClassError: false,
      seenSet,
    });
    assert.equal(result.action, 'submit');
    assert.equal(result.reason, 'ok');
  });

  test('8. 未分类后可重试: 第一次跳过不标记,第二次仍可提交', () => {
    const seenSet = new Set();
    // 第一次:店铺未分类
    const r1 = decideCollectSubmission({
      sku: '100001',
      config: BASE_CONFIG,
      sellerSlug: CHINA_SHOP,
      storeClassResult: null,
      storeClassError: false,
      seenSet,
    });
    assert.equal(r1.action, 'skip');
    assert.equal(r1.markSeen, false);
    // 模拟 markSeen=false → 不加入 seenSet

    // 第二次:店铺已被标记为中国
    const r2 = decideCollectSubmission({
      sku: '100001',
      config: BASE_CONFIG,
      sellerSlug: CHINA_SHOP,
      storeClassResult: { isMainlandChina: true },
      storeClassError: false,
      seenSet,
    });
    assert.equal(r2.action, 'submit');
    assert.equal(r2.markSeen, true);
  });

  test('9. 非中国店铺永久标记: 第一次跳过+标记,第二次 already-seen', () => {
    const seenSet = new Set();
    // 第一次:非中国店铺
    const r1 = decideCollectSubmission({
      sku: '100001',
      config: BASE_CONFIG,
      sellerSlug: CHINA_SHOP,
      storeClassResult: { isMainlandChina: false },
      storeClassError: false,
      seenSet,
    });
    assert.equal(r1.action, 'skip');
    assert.equal(r1.markSeen, true);
    // 模拟 markSeen=true → 加入 seenSet
    seenSet.add('100001');

    // 第二次:同一 sku
    const r2 = decideCollectSubmission({
      sku: '100001',
      config: BASE_CONFIG,
      sellerSlug: CHINA_SHOP,
      storeClassResult: { isMainlandChina: false },
      storeClassError: false,
      seenSet,
    });
    assert.equal(r2.action, 'skip');
    assert.equal(r2.reason, 'already-seen');
  });

  test('10. 4 SKU 场景: 店铺未分类 → 全部跳过(不标记)', () => {
    // 模拟用户报告的场景:4 个 SKU 可见,但全部未入队
    const seenSet = new Set();
    const skus = ['100001', '100002', '100003', '100004'];
    const results = skus.map((sku) =>
      decideCollectSubmission({
        sku,
        config: BASE_CONFIG,
        sellerSlug: CHINA_SHOP,
        storeClassResult: null, // 店铺未分类
        storeClassError: false,
        seenSet,
      })
    );
    // 全部跳过
    for (const r of results) {
      assert.equal(r.action, 'skip');
      assert.equal(r.reason, 'unclassified-store');
      assert.equal(r.markSeen, false);
    }
    // seenSet 应为空(因为 markSeen=false)
    assert.equal(seenSet.size, 0);
  });

  test('11. 4 SKU 场景: checkStoreClass 异常 → 全部跳过(不标记)', () => {
    const seenSet = new Set();
    const skus = ['100001', '100002', '100003', '100004'];
    const results = skus.map((sku) =>
      decideCollectSubmission({
        sku,
        config: BASE_CONFIG,
        sellerSlug: CHINA_SHOP,
        storeClassResult: undefined,
        storeClassError: true,
        seenSet,
      })
    );
    for (const r of results) {
      assert.equal(r.action, 'skip');
      assert.equal(r.reason, 'checkStoreClass-error');
      assert.equal(r.markSeen, false);
    }
    assert.equal(seenSet.size, 0);
  });

  test('12. 4 SKU 场景: 店铺已分类中国 → 全部提交', () => {
    const seenSet = new Set();
    const skus = ['100001', '100002', '100003', '100004'];
    const results = skus.map((sku) => {
      const r = decideCollectSubmission({
        sku,
        config: BASE_CONFIG,
        sellerSlug: CHINA_SHOP,
        storeClassResult: { isMainlandChina: true },
        storeClassError: false,
        seenSet,
      });
      if (r.markSeen) seenSet.add(String(sku));
      return r;
    });
    for (const r of results) {
      assert.equal(r.action, 'submit');
      assert.equal(r.reason, 'ok');
    }
    assert.equal(seenSet.size, 4);
  });
});

// ─── classifyStoreByRules 单元测试 ──────────────────────────
//
// 从 service-worker.js classifyStoreByRules (行 2631-2665) 提取。
// 纯函数,根据 slug/name/companyInfo/config 判定店铺是否中国大陆。
// 规则优先级:knownMainlandChinaSlugs > knownNonMainlandChinaSlugs > companyInfo.country=CN > companyInfo.country≠CN

/**
 * 从 service-worker.js 提取的规则引擎。两者逻辑必须保持一致。
 */
function classifyStoreByRules(slug, name, companyInfo, config) {
  if (!config) {
    return { isMainlandChina: null, by: null };
  }
  if (Array.isArray(config.knownMainlandChinaSlugs) && config.knownMainlandChinaSlugs.includes(slug)) {
    return { isMainlandChina: true, by: 'rule:known-list' };
  }
  if (Array.isArray(config.knownNonMainlandChinaSlugs) && config.knownNonMainlandChinaSlugs.includes(slug)) {
    return { isMainlandChina: false, by: 'rule:known-list' };
  }
  if (companyInfo && companyInfo.country === 'CN') {
    return { isMainlandChina: true, by: 'rule:company-country' };
  }
  if (companyInfo && companyInfo.country && companyInfo.country !== 'CN') {
    return { isMainlandChina: false, by: 'rule:company-country' };
  }
  return { isMainlandChina: null, by: null };
}

describe('classifyStoreByRules', () => {
  const CONFIG = {
    knownMainlandChinaSlugs: ['known-china-shop'],
    knownNonMainlandChinaSlugs: ['known-foreign-shop'],
  };

  test('1. config=null → isMainlandChina=null(需人工确认)', () => {
    const r = classifyStoreByRules('any-shop', 'name', null, null);
    assert.equal(r.isMainlandChina, null);
    assert.equal(r.by, null);
  });

  test('2. knownMainlandChinaSlugs 命中 → isMainlandChina=true', () => {
    const r = classifyStoreByRules('known-china-shop', 'name', null, CONFIG);
    assert.equal(r.isMainlandChina, true);
    assert.equal(r.by, 'rule:known-list');
  });

  test('3. knownNonMainlandChinaSlugs 命中 → isMainlandChina=false', () => {
    const r = classifyStoreByRules('known-foreign-shop', 'name', null, CONFIG);
    assert.equal(r.isMainlandChina, false);
    assert.equal(r.by, 'rule:known-list');
  });

  test('4. companyInfo.country=CN → isMainlandChina=true', () => {
    const r = classifyStoreByRules('unknown-shop', 'name', { country: 'CN' }, CONFIG);
    assert.equal(r.isMainlandChina, true);
    assert.equal(r.by, 'rule:company-country');
  });

  test('5. companyInfo.country=US → isMainlandChina=false', () => {
    const r = classifyStoreByRules('unknown-shop', 'name', { country: 'US' }, CONFIG);
    assert.equal(r.isMainlandChina, false);
    assert.equal(r.by, 'rule:company-country');
  });

  test('6. 无任何匹配 → isMainlandChina=null(需人工确认)', () => {
    // 用户报告的场景:新店铺,不在已知列表,无 companyInfo
    const r = classifyStoreByRules('new-unknown-shop', 'name', null, CONFIG);
    assert.equal(r.isMainlandChina, null);
    assert.equal(r.by, null);
  });

  test('7. companyInfo=null → isMainlandChina=null', () => {
    const r = classifyStoreByRules('unknown-shop', 'name', null, CONFIG);
    assert.equal(r.isMainlandChina, null);
  });

  test('8. companyInfo.country 为空字符串 → isMainlandChina=null', () => {
    const r = classifyStoreByRules('unknown-shop', 'name', { country: '' }, CONFIG);
    assert.equal(r.isMainlandChina, null);
  });

  test('9. 优先级:knownMainlandChinaSlugs 优先于 companyInfo.country=US', () => {
    // slug 在中国列表但 companyInfo 显示美国 → 应判定中国(规则1优先)
    const r = classifyStoreByRules('known-china-shop', 'name', { country: 'US' }, CONFIG);
    assert.equal(r.isMainlandChina, true);
    assert.equal(r.by, 'rule:known-list');
  });

  test('10. 用户场景: 新店铺无 companyInfo → null → checkStoreClassification 返回 null → 4 SKU 全跳过', () => {
    // 模拟完整链路:规则引擎返回 null
    const ruleResult = classifyStoreByRules('new-shop', 'New Shop', null, CONFIG);
    assert.equal(ruleResult.isMainlandChina, null);

    // checkStoreClassification 会返回 null → __jzSubmitCollectTask 跳过
    const storeClassResult = null; // checkStoreClassification 返回值
    const decision = decideCollectSubmission({
      sku: '100001',
      config: { onlyMainlandChinaStores: true },
      sellerSlug: 'new-shop',
      storeClassResult,
      storeClassError: false,
      seenSet: new Set(),
    });
    assert.equal(decision.action, 'skip');
    assert.equal(decision.reason, 'unclassified-store');
  });
});
