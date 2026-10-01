// Webhook 第二阶段改造验证:共享密钥鉴权 + processing 卡死回收
// 运行方式:
//   node --experimental-sqlite test/webhook-phase2.e2e.js
//
// 说明:
//   1. ip-whitelist 用假 req/res 做纯函数级验证(不起 express)
//   2. event-dao 的回收跑在临时空库里(ERP_DATA_DIR 指向 mkdtemp),
//      不会去动开发库里的真实事件——回收函数是全表 UPDATE,必须隔离
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DB_DIR = mkdtempSync(join(tmpdir(), 'erp-webhook-phase2-'));
process.env.ERP_DATA_DIR = TMP_DB_DIR;

// 这两个模块在加载时就 open 数据库/读 env,所以只能设完环境变量再动态 import
const { initSchema, getDb } = await import('../src/db/index.js');
const { insertEvent, claimPendingEvents, reclaimAllProcessing, reclaimStaleProcessing } =
  await import('../src/db/dao/sqlite/event-dao.js');
const config = (await import('../src/config/index.js')).default;
const { ipWhitelist } = await import('../src/middleware/ip-whitelist.js');

const TOKEN = 'phase2-test-secret';
const KEY_PREFIX = 'test-phase2-';

function fakeReq(headers, socketIp = '195.34.21.77') {
  return { headers, path: '/webhook/ozon', socket: { remoteAddress: socketIp } };
}

function fakeRes() {
  const res = { statusCode: 200, body: null, status(c) { res.statusCode = c; return res; }, json(o) { res.body = o; return res; } };
  return res;
}

// 返回 'next' 或状态码
function run(req) {
  const res = fakeRes();
  let passed = false;
  ipWhitelist(req, res, () => { passed = true; });
  return passed ? 'next' : res.statusCode;
}

function testWhitelist() {
  const origToken = config.webhook.proxyToken;
  const origEnabled = config.webhook.ipWhitelistEnabled;
  config.webhook.ipWhitelistEnabled = true;
  try {
    // ── 未配密钥:维持 CIDR 老行为 ──
    config.webhook.proxyToken = '';
    assert.strictEqual(run(fakeReq({ 'x-forwarded-for': '195.34.21.77' })), 'next', 'CIDR 内应放行');
    assert.strictEqual(run(fakeReq({ 'x-forwarded-for': '8.8.8.8' })), 403, 'CIDR 外应拒绝');
    assert.strictEqual(run(fakeReq({ 'x-webhook-proxy': 'whatever', 'x-forwarded-for': '203.0.113.9' })), 403,
      '没配密钥时,带随便什么头的非 Ozon 源仍应拒绝');

    // ── 配了密钥:只认头,伪造 XFF 不再管用 ──
    config.webhook.proxyToken = TOKEN;
    assert.strictEqual(run(fakeReq({ 'x-webhook-proxy': TOKEN, 'x-forwarded-for': '8.8.8.8' })), 'next',
      '密钥匹配即放行(源 IP 已在信任边界外)');
    assert.strictEqual(run(fakeReq({ 'x-webhook-proxy': TOKEN })), 'next', '无 XFF 时同样只看头');
    assert.strictEqual(run(fakeReq({ 'x-webhook-proxy': 'wrong', 'x-forwarded-for': '195.34.21.77' })), 403,
      '密钥不匹配时,即便源 IP 在 Ozon 段也拒绝');
    assert.strictEqual(run(fakeReq({ 'x-forwarded-for': '195.34.21.77' })), 403,
      '缺密钥头时,即便源 IP 在 Ozon 段也拒绝');
    assert.strictEqual(run(fakeReq({ 'x-webhook-proxy': TOKEN.slice(0, -1), 'x-forwarded-for': '195.34.21.77' })), 403,
      '长度不同的密钥不应通过');

    // ── 开发开关优先:关掉白名单就一律放行,与密钥无关 ──
    config.webhook.ipWhitelistEnabled = false;
    assert.strictEqual(run(fakeReq({})), 'next', 'IP_WHITELIST_ENABLED=false 应直通');
  } finally {
    config.webhook.proxyToken = origToken;
    config.webhook.ipWhitelistEnabled = origEnabled;
  }
  console.log('✓ ipWhitelist:未配密钥走 CIDR,配了密钥只认 X-Webhook-Proxy');
}

function findCols() {
  return getDb().prepare('PRAGMA table_info(ozon_push_events)').all().map(c => c.name);
}

function seed(n, tag) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const key = `${KEY_PREFIX}${tag}-${i}`;
    const r = insertEvent({
      message_type: 'TYPE_NEW_POSTING',
      idempotency_key: key,
      seller_id: null,
      posting_number: `TEST-${tag}-${i}`,
      product_id: null,
      sku: null,
      chat_id: null,
      order_number: null,
      raw_payload: JSON.stringify({ message_type: 'TYPE_NEW_POSTING', result: { posting_number: `TEST-${tag}-${i}` } }),
    });
    assert.ok(r.inserted, `插入测试事件失败 ${key}`);
    ids.push(r.id);
  }
  return ids;
}

function statusOf(id) {
  return getDb().prepare('SELECT status, retry_count, claimed_at FROM ozon_push_events WHERE id=?').get(id);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function testReclaim() {
  const db = getDb();
  assert.ok(findCols().includes('claimed_at'), 'claimed_at 列应存在(migration 未跑?)');

  // claim 要打上 claimed_at
  let ids = seed(2, 'claim');
  const claimed = claimPendingEvents(2, 5);
  assert.strictEqual(claimed.length, 2, '应 claim 到 2 条');
  for (const ev of claimed) {
    const row = statusOf(ev.id);
    assert.strictEqual(row.status, 'processing');
    assert.ok(row.claimed_at, 'processing 行必须有 claimed_at');
  }

  // 窗口内不误回收:刚刚 claim 的事件仍在处理中
  assert.strictEqual(reclaimStaleProcessing(60 * 1000), 0, '未超窗的 processing 不应被回收');
  // 超窗则放回 pending,且 retry_count +1(有毒事件仍按 maxRetry 收敛)
  await sleep(5);
  const reclaimed = reclaimStaleProcessing(0);
  assert.ok(reclaimed >= 2, `超窗 processing 应被回收,实际 ${reclaimed}`);
  for (const id of ids) {
    const row = statusOf(id);
    assert.strictEqual(row.status, 'pending', '回收后应回到 pending');
    assert.strictEqual(row.retry_count, 1, '回收应累加 retry_count');
    assert.strictEqual(row.claimed_at, null);
  }

  // 启动回收:全部 processing 一律放回 pending,不管新旧
  ids = seed(1, 'orphan');
  claimPendingEvents(50, 5);  // 库里只有测试行,整批 claim 才能确保拿到刚插的那条
  assert.strictEqual(statusOf(ids[0]).status, 'processing');
  const orphan = reclaimAllProcessing();
  assert.ok(orphan >= 1, '启动回收应吃掉所有 processing 孤儿');
  assert.strictEqual(statusOf(ids[0]).status, 'pending');

  const leftover = db.prepare(`SELECT COUNT(*) AS n FROM ozon_push_events WHERE status='processing'`).get().n;
  assert.strictEqual(leftover, 0, '回收后不应有残留 processing');
  console.log('✓ event-dao:claimed_at 上锁、超窗回收、启动回收孤儿');
}

function cleanup() {
  getDb().close();
  rmSync(TMP_DB_DIR, { recursive: true, force: true });
  console.log(`✓ 临时库已删除 ${TMP_DB_DIR}`);
}

await initSchema();
try {
  testWhitelist();
  await testReclaim();
} finally {
  cleanup();
}
console.log('\n全部通过');
