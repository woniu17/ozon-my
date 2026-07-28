// 图床 + 水印加工功能 HTTP API 端到端测试
// 运行方式: node test/image-host.api.e2e.js
// 前置条件:
//   1. ERP 后端已启动(node --experimental-sqlite src/app.js)
//   2. 环境变量 IMAGE_HOST_BASE_URL=http://localhost:3001 已设置
//   3. 测试用账号 13800138000 / password 可登录
//
// 测试覆盖:
//   1. 登录获取 JWT token
//   2. 水印模板 CRUD(text/border/image 三种类型)
//   3. 上架模板配置水印字段
//   4. 一键上架(executeListing)端到端:触发加工链 → 图片落盘 → opi_request 中 images 为图床 URL
//   5. 静态资源访问:图床 URL 可下载
//   6. 幂等性:重复触发不重复生成
//   7. 降级:无 watermarkTemplateId 时透传
import assert from 'node:assert';
import { existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'src', 'public');
const IMAGES_DIR = join(PUBLIC_DIR, 'images');

const BASE = process.env.ERP_BASE_URL || 'http://localhost:3001';
const PHONE = '13800138000';
const PASSWORD = 'password';

// 测试图片 URL(picsum.photos 固定 seed,稳定可访问)
const TEST_IMG_1 = 'https://picsum.photos/seed/api-e2e-001/600/400';
const TEST_IMG_2 = 'https://picsum.photos/seed/api-e2e-002/600/400';
const TEST_WM_LOGO = 'https://picsum.photos/seed/api-e2e-logo/200/200';

// ─── 测试框架 ────────────────────────────────────────────
const results = [];
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, status: 'PASS' });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    results.push({ name, status: 'FAIL', err: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assertEqual(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
}
function assertMatch(actual, regex, msg) {
  assert.match(String(actual), regex, msg);
}
function assertOk(value, msg) {
  assert.ok(value, msg);
}

// ─── HTTP 工具 ────────────────────────────────────────────
let TOKEN = '';
let STORE_ID = '';

async function api(path, options = {}) {
  const { method = 'GET', body, headers = {} } = options;
  const url = path.startsWith('http') ? path : BASE + path;
  const finalHeaders = { 'Content-Type': 'application/json', ...headers };
  if (TOKEN) finalHeaders['Authorization'] = 'Bearer ' + TOKEN;

  const res = await fetch(url, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// 带 x-ozon-store-id header 的 api 调用(用于 /ozon/products/* 路由)
async function storeApi(path, options = {}) {
  const opts = { ...options };
  opts.headers = { ...(opts.headers || {}), 'x-ozon-store-id': STORE_ID };
  return api(path, opts);
}

// 获取 db 只读连接(避免与运行中的 ERP 服务争抢写锁)
// 直接用 node:sqlite 打开只读连接,不走 initSchema(避免 migration 写操作)
let _db = null;
async function getDb() {
  if (!_db) {
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = join(__dirname, '..', 'data', 'erp.db');
    _db = new DatabaseSync(dbPath, { readOnly: true });
  }
  return _db;
}

// ─── 清理测试产物 ─────────────────────────────────────────
function cleanupTestImages() {
  // 清理测试 SKU 目录
  const testSkus = ['APIE2E001', 'APIE2E002', 'APIEXEC001', 'APIEXEC002'];
  for (const sku of testSkus) {
    const dir = join(IMAGES_DIR, sku);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 主流程 ──────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('=== 图床 + 水印加工功能 HTTP API 端到端测试 ===');
  console.log(`BASE = ${BASE}`);
  console.log('');

  cleanupTestImages();

  // ════════════════════════════════════════════════════
  // 1. 登录
  // ════════════════════════════════════════════════════
  console.log('--- 1. 登录 ---');

  await test('1.1 登录获取 JWT token', async () => {
    const r = await api('/auth/login-password', {
      method: 'POST',
      body: { phoneNumber: PHONE, password: PASSWORD },
    });
    assertEqual(r.status, 200, `登录应返回 200, 实际 ${r.status}`);
    assertOk(r.json?.accessToken, '应返回 accessToken');
    assertOk(r.json?.user, '应返回 user');
    TOKEN = r.json.accessToken;
  });

  await test('1.2 获取店铺列表(取第一个 storeId 供后续测试)', async () => {
    const r = await api('/auth/ozon-stores');
    assertEqual(r.status, 200, `查询应返回 200, 实际 ${r.status}`);
    assertOk(Array.isArray(r.json) && r.json.length > 0, '应返回非空店铺数组');
    STORE_ID = r.json[0].id;
    assertOk(STORE_ID, `应获取到 storeId, 实际: ${STORE_ID}`);
    console.log(`      使用 storeId: ${STORE_ID}`);
  });

  // ════════════════════════════════════════════════════
  // 2. 水印模板 CRUD
  // ════════════════════════════════════════════════════
  console.log('');
  console.log('--- 2. 水印模板 CRUD ---');

  let textTplId, borderTplId, imageTplId;

  await test('2.1 创建文字水印模板', async () => {
    const r = await api('/watermark-templates', {
      method: 'POST',
      body: {
        name: 'API-E2E-TEXT',
        config: {
          type: 'text',
          text: { content: '测试水印', fontSize: 36, color: '#FF0000', opacity: 0.7, position: 'bottom-right' },
        },
        isDefault: false,
      },
    });
    assertEqual(r.status, 200, `创建应返回 200, 实际 ${r.status}`);
    assertOk(r.json?.data?.id, '应返回 id');
    assertEqual(r.json.data.config.type, 'text', 'config.type 应为 text');
    assertEqual(r.json.data.config.text.content, '测试水印', 'content 应正确');
    textTplId = r.json.data.id;
  });

  await test('2.2 创建边框水印模板', async () => {
    const r = await api('/watermark-templates', {
      method: 'POST',
      body: {
        name: 'API-E2E-BORDER',
        config: {
          type: 'border',
          border: { width: 15, color: '#0000FF', opacity: 0.4 },
        },
        isDefault: false,
      },
    });
    assertEqual(r.status, 200, `创建应返回 200, 实际 ${r.status}`);
    assertOk(r.json?.data?.id, '应返回 id');
    assertEqual(r.json.data.config.type, 'border', 'config.type 应为 border');
    borderTplId = r.json.data.id;
  });

  await test('2.3 创建图片水印模板', async () => {
    const r = await api('/watermark-templates', {
      method: 'POST',
      body: {
        name: 'API-E2E-IMAGE',
        config: {
          type: 'image',
          image: { url: TEST_WM_LOGO, scale: 0.2, opacity: 0.6, position: 'bottom-right' },
        },
        isDefault: false,
      },
    });
    assertEqual(r.status, 200, `创建应返回 200, 实际 ${r.status}`);
    assertOk(r.json?.data?.id, '应返回 id');
    assertEqual(r.json.data.config.type, 'image', 'config.type 应为 image');
    imageTplId = r.json.data.id;
  });

  await test('2.4 查询水印模板列表', async () => {
    const r = await api('/watermark-templates');
    assertEqual(r.status, 200, `查询应返回 200, 实际 ${r.status}`);
    assertOk(Array.isArray(r.json?.data), '应返回数组');
    // 至少包含刚创建的 3 个
    const names = r.json.data.map((t) => t.name);
    assertOk(names.includes('API-E2E-TEXT'), '列表应包含 API-E2E-TEXT');
    assertOk(names.includes('API-E2E-BORDER'), '列表应包含 API-E2E-BORDER');
    assertOk(names.includes('API-E2E-IMAGE'), '列表应包含 API-E2E-IMAGE');
  });

  await test('2.5 更新水印模板', async () => {
    const r = await api('/watermark-templates/' + textTplId, {
      method: 'PUT',
      body: {
        name: 'API-E2E-TEXT-UPDATED',
        config: {
          type: 'text',
          text: { content: '更新后的水印', fontSize: 40, color: '#00FF00', opacity: 0.8, position: 'top-left' },
        },
      },
    });
    assertEqual(r.status, 200, `更新应返回 200, 实际 ${r.status}`);
    assertEqual(r.json.data.name, 'API-E2E-TEXT-UPDATED', '名称应已更新');
    assertEqual(r.json.data.config.text.content, '更新后的水印', 'content 应已更新');
    assertEqual(r.json.data.config.text.position, 'top-left', 'position 应已更新');
  });

  await test('2.6 删除水印模板', async () => {
    const r = await api('/watermark-templates/' + imageTplId, { method: 'DELETE' });
    assertEqual(r.status, 200, `删除应返回 200, 实际 ${r.status}`);
    assertEqual(r.json.data.deleted, true, '应返回 deleted:true');
    // 再查一次,确认已删除
    const list = await api('/watermark-templates');
    const ids = list.json.data.map((t) => t.id);
    assertOk(!ids.includes(imageTplId), '已删除的模板不应在列表中');
  });

  // ════════════════════════════════════════════════════
  // 3. 上架模板配置水印字段
  // ════════════════════════════════════════════════════
  console.log('');
  console.log('--- 3. 上架模板配置水印字段 ---');

  let listingTplId;

  await test('3.1 创建带水印配置的上架模板', async () => {
    const r = await api('/admin/api/listing-templates', {
      method: 'POST',
      body: {
        name: 'API-E2E-LISTING-WM',
        config: {
          brand: 'no_brand',
          imageOrder: 'keep',
          applyWatermark: true,
          watermarkTemplateId: textTplId,
          defaultStock: 5,
          salePriceA: 130,
          salePriceB: 0,
          oldPriceA: 150,
          minPriceB: 2,
        },
        isDefault: false,
      },
    });
    assertEqual(r.status, 200, `创建应返回 200, 实际 ${r.status}`);
    assertOk(r.json?.data?.id, '应返回 id');
    listingTplId = r.json.data.id;
    assertEqual(r.json.data.config.applyWatermark, true, 'applyWatermark 应为 true');
    assertEqual(r.json.data.config.watermarkTemplateId, textTplId, 'watermarkTemplateId 应正确');
  });

  await test('3.2 查询上架模板列表应包含水印字段', async () => {
    const r = await api('/admin/api/listing-templates');
    assertEqual(r.status, 200, `查询应返回 200, 实际 ${r.status}`);
    const found = r.json.data.find((t) => t.id === listingTplId);
    assertOk(found, '应找到刚创建的模板');
    assertEqual(found.config.applyWatermark, true, 'applyWatermark 应为 true');
    assertEqual(found.config.watermarkTemplateId, textTplId, 'watermarkTemplateId 应正确');
  });

  // ════════════════════════════════════════════════════
  // 4. executeListing 端到端(Preview.vue 一键上架路径)
  // ════════════════════════════════════════════════════
  console.log('');
  console.log('--- 4. executeListing 端到端(一键上架路径) ---');

  // Preview.vue 调 /ozon/products/import,后端 products.js 直接传 body 给 executeListing
  // executeListing 会兜底注入 applyWatermark/watermarkTemplateId,然后调 prepareBundleItems
  // 最终调用 opi.productImport 向 Ozon 发送 —— 测试中会因 OPI 凭据/网络失败,
  // 但图片加工链在 prepareBundleItems 阶段已完成,opi_request payload 会落库

  await test('4.1 一键上架:触发水印加工链(文字水印)', async () => {
    const r = await storeApi('/ozon/products/import', {
      method: 'POST',
      body: {
        items: [
          {
            offer_id: 'APIEXEC001',
            name: '测试商品-text',
            price: '1000',
            old_price: '1500',
            vat: '0',
            currency_code: 'RUB',
            images: [
              { file_name: TEST_IMG_1, default: true },
              { file_name: TEST_IMG_2, default: false },
            ],
            attributes: [],
            description: '测试描述',
          },
        ],
        defaultStock: 5,
        templateId: listingTplId,
      },
    });
    // executeListing 可能因 OPI 调用失败而返回错误,但图片加工链已执行
    // 关键是看 follow_sell_task_payloads 中的 opi_request

    // 直接查 db 验证图片 URL 已替换(用真实 storeId 查询)
    const db = await getDb();
    const rows = db
      .prepare(`SELECT stage, payload FROM follow_sell_task_payloads WHERE store_id=? AND payload LIKE '%APIEXEC001%' ORDER BY id DESC LIMIT 5`)
      .all(STORE_ID);

    assertOk(rows.length > 0, '应有 payload 记录');

    // 优先查 transformed stage(prepareBundleItems 输出,images 为 {file_name}[] 格式)
    // 其次查 opi_request(已转 OPI 格式,images 为 string[] 格式)
    const transformedRow = rows.find((r) => r.stage === 'transformed');
    const opiRow = rows.find((r) => r.stage === 'opi_request');

    const checkRow = transformedRow || opiRow;
    assertOk(checkRow, '应有 transformed 或 opi_request stage');

    const payload = typeof checkRow.payload === 'string' ? JSON.parse(checkRow.payload) : checkRow.payload;
    const items = Array.isArray(payload) ? payload : (payload.items || []);
    const targetItem = items.find((i) => i.offer_id === 'APIEXEC001');
    assertOk(targetItem, `${checkRow.stage} 中应包含测试 item`);

    // images 格式:transformed 和 opi_request 都是 string[] 格式
    // (prepareBundleItems 内部已将 {file_name}[] 转为 string[])
    let images = targetItem.images || [];
    assertOk(images.length > 0, '应有图片');

    // 统一按 string[] 格式断言(若元素是对象则取 file_name)
    for (const img of images) {
      const url = typeof img === 'string' ? img : img.file_name;
      assertOk(url, `图片 URL 不应为空, 实际: ${JSON.stringify(img)}`);
      assertMatch(
        url,
        /^http:\/\/localhost:3001\/images\/APIEXEC001\/[a-f0-9]{32}\.jpg$/,
        `图片 URL 应为图床 URL, 实际: ${url}`
      );
    }

    // 验证文件已落盘(无论 OPI 是否成功,加工链在 prepareBundleItems 内完成)
    const skuDir = join(IMAGES_DIR, 'APIEXEC001');
    assertOk(existsSync(skuDir), 'SKU 目录应存在');
    const files = readdirSync(skuDir);
    assertOk(files.length >= 2, `应有至少 2 张图片, 实际 ${files.length}`);
    for (const f of files) {
      assertMatch(f, /^[a-f0-9]{32}\.jpg$/, `文件名应为 md5.jpg 格式, 实际: ${f}`);
      const stat = statSync(join(skuDir, f));
      assertOk(stat.size > 0, `文件 ${f} 大小应 > 0`);
    }
  });

  await test('4.2 幂等性:同一 SKU 重复触发不重复生成文件', async () => {
    // 记录当前文件数
    const skuDir = join(IMAGES_DIR, 'APIEXEC001');
    const filesBefore = readdirSync(skuDir);

    // 再次触发上架
    await storeApi('/ozon/products/import', {
      method: 'POST',
      body: {
        items: [
          {
            offer_id: 'APIEXEC001',
            name: '测试商品-text-2',
            price: '1100',
            old_price: '1600',
            vat: '0',
            currency_code: 'RUB',
            images: [
              { file_name: TEST_IMG_1, default: true },
              { file_name: TEST_IMG_2, default: false },
            ],
            attributes: [],
            description: '测试描述2',
          },
        ],
        defaultStock: 5,
        templateId: listingTplId,
      },
    });

    const filesAfter = readdirSync(skuDir);
    assertEqual(filesAfter.length, filesBefore.length, '文件数应不变(幂等)');
  });

  await test('4.3 降级:无 watermarkTemplateId 时透传原图', async () => {
    const r = await storeApi('/ozon/products/import', {
      method: 'POST',
      body: {
        items: [
          {
            offer_id: 'APIEXEC002',
            name: '测试商品-noWatermark',
            price: '1000',
            old_price: '1500',
            vat: '0',
            currency_code: 'RUB',
            images: [{ file_name: TEST_IMG_1, default: true }],
            attributes: [],
            description: '无水印测试',
          },
        ],
        defaultStock: 5,
        // 不传 templateId,也不传 applyWatermark
      },
    });

    // 查 db 验证图片 URL 未被替换(透传原 URL)
    const db = await getDb();
    const rows = db
      .prepare(`SELECT stage, payload FROM follow_sell_task_payloads WHERE store_id=? AND payload LIKE '%APIEXEC002%' ORDER BY id DESC LIMIT 5`)
      .all(STORE_ID);

    // 优先查 raw stage(原始请求体,images 保留 {file_name}[] 格式且未替换)
    const rawRow = rows.find((r) => r.stage === 'raw');
    assertOk(rawRow, '应有 raw stage');

    const payload = typeof rawRow.payload === 'string' ? JSON.parse(rawRow.payload) : rawRow.payload;
    // raw stage 的 payload 是 items 数组(非 {items: []})
    const items = Array.isArray(payload) ? payload : (payload.items || []);
    const targetItem = items.find((i) => i.offer_id === 'APIEXEC002');
    assertOk(targetItem, 'raw stage 中应包含测试 item');

    const images = targetItem.images || [];
    assertOk(images.length > 0, '应有图片');
    for (const img of images) {
      const url = typeof img === 'string' ? img : img.file_name;
      assertOk(url, `图片 URL 不应为空, 实际: ${JSON.stringify(img)}`);
      assertEqual(url, TEST_IMG_1, `图片应透传原 URL, 实际: ${url}`);
    }

    // 验证 APIEXEC002 目录不存在(未配置水印时不应创建 SKU 目录)
    const skuDir = join(IMAGES_DIR, 'APIEXEC002');
    assertOk(!existsSync(skuDir), '未配置水印时不应创建 SKU 目录');
  });

  // ════════════════════════════════════════════════════
  // 5. 静态资源访问
  // ════════════════════════════════════════════════════
  console.log('');
  console.log('--- 5. 静态资源访问 ---');

  await test('5.1 图床 URL 可下载图片', async () => {
    // 从 4.1 的产物中取一个图床 URL
    const skuDir = join(IMAGES_DIR, 'APIEXEC001');
    const files = readdirSync(skuDir);
    const hash = files[0].replace('.jpg', '');
    const url = `${BASE}/images/APIEXEC001/${hash}.jpg`;

    const res = await fetch(url);
    assertEqual(res.status, 200, `图床 URL 应返回 200, 实际 ${res.status}`);
    assertEqual(res.headers.get('content-type'), 'image/jpeg', 'Content-Type 应为 image/jpeg');
    const buf = Buffer.from(await res.arrayBuffer());
    assertOk(buf.length > 0, '图片内容应非空');
  });

  await test('5.2 不存在的图床 URL 返回 404 或 401(fallthrough 到 auth)', async () => {
    const res = await fetch(`${BASE}/images/APIEXEC001/nonexistent.jpg`);
    // express.static 找不到文件时 fallthrough 到 authMiddleware
    // 带 token 时返回 404,不带 token 时返回 401 —— 两种都是正常行为
    assertOk(
      res.status === 404 || res.status === 401,
      `不存在的图片应返回 404 或 401, 实际 ${res.status}`
    );
  });

  // ════════════════════════════════════════════════════
  // 6. 清理 + 汇总
  // ════════════════════════════════════════════════════
  console.log('');
  console.log('--- 清理测试数据 ---');

  // 清理 db 中的测试数据 —— 通过 HTTP API 删(水印模板/上架模板),避免直接写 db 锁冲突
  try {
    // 删除测试水印模板
    const tplRes = await api('/watermark-templates');
    if (tplRes.json?.data) {
      for (const t of tplRes.json.data) {
        if (t.name && t.name.startsWith('API-E2E-')) {
          await api('/watermark-templates/' + t.id, { method: 'DELETE' });
        }
      }
    }
    // 删除测试上架模板
    const ltRes = await api('/admin/api/listing-templates');
    if (ltRes.json?.data) {
      for (const t of ltRes.json.data) {
        if (t.name && t.name.startsWith('API-E2E-')) {
          await api('/admin/api/listing-templates/' + t.id, { method: 'DELETE' });
        }
      }
    }
    // follow_sell_tasks / payloads 用专用脚本清理(需写库,通过服务端 API 或单独脚本)
    console.log('  已清理水印模板和上架模板测试数据');
    console.log('  (follow_sell_tasks 测试记录需手动清理,或运行 test/_cleanup.js)');
  } catch (e) {
    console.log('  清理失败:', e.message);
  }

  // 清理测试图片产物
  cleanupTestImages();

  console.log('  已清理测试数据(db 记录 + 图片文件)');
  console.log('');

  console.log('═══════════════════════════════════════════════════════');
  console.log(`  测试结果: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('═══════════════════════════════════════════════════════');
  if (failed > 0) {
    console.log('');
    console.log('失败项:');
    for (const r of results) {
      if (r.status === 'FAIL') {
        console.log(`  ✗ ${r.name}: ${r.err}`);
      }
    }
    process.exit(1);
  } else {
    console.log('');
    console.log('✓ 所有测试通过');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('测试运行异常:', e);
  process.exit(1);
});
