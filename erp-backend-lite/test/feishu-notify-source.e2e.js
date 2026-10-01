// 飞书通知"触发来源"后缀验证:消息推送 / 定时获取 / 手动操作 / 运维补发 四种来源在文案尾部可区分
// 运行方式:
//   node --experimental-sqlite test/feishu-notify-source.e2e.js
//
// 说明:
//   1. 不发真实网络请求 —— globalThis.fetch 被换成记录器，断言的是最终落到机器人的文本
//   2. notifyPostingPickedUp 跑在临时空库上(ERP_DATA_DIR 指向 mkdtemp)，
//      它内部的当日统计/商品明细查询在空库会被自己的 try/catch 降级，不影响来源后缀断言
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DB_DIR = mkdtempSync(join(tmpdir(), 'erp-feishu-source-'));
process.env.ERP_DATA_DIR = TMP_DB_DIR;

// db/config 在加载时就会 open 库、读 env，只能设完环境变量再动态 import
const { initSchema } = await import('../src/db/index.js');
const config = (await import('../src/config/index.js')).default;
const { sendFeishuText, notifyPostingPickedUp } = await import('../src/services/webhook/feishu-notify.js');

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  sent.push({ url, text: JSON.parse(opts.body).content.text });
  return { ok: true, status: 200, text: async () => 'ok' };
};

const footerOf = (text) => text.split('\n').pop();
const LABELS = { webhook: '消息推送', polling: '定时获取', manual: '手动操作', backfill: '运维补发' };

async function testSourceLabels() {
  for (const [source, label] of Object.entries(LABELS)) {
    sent.length = 0;
    const ok = await sendFeishuText(`正文(${source})`, 'https://fake.example/robot', source);
    assert.equal(ok, true, `source=${source} 应发送成功`);
    assert.equal(sent.length, 1);
    assert.equal(
      footerOf(sent[0].text),
      `—— 来自 ${config.appName} · ${label}`,
      `source=${source} 的后缀不对: ${footerOf(sent[0].text)}`
    );
  }
  // 不传 source / 传了不认识的键都回落成"消息推送"，不允许出现没有来源标识的消息
  sent.length = 0;
  await sendFeishuText('缺省', 'https://fake.example/robot');
  await sendFeishuText('乱键', 'https://fake.example/robot', 'nonsense');
  assert.equal(footerOf(sent[0].text).endsWith('· 消息推送'), true);
  assert.equal(footerOf(sent[1].text).endsWith('· 消息推送'), true);
  console.log('✓ sendFeishuText: 四种来源后缀正确，缺省/未知键回落"消息推送"');
}

async function testNotifyForwardsSource() {
  const pickupUrl = 'https://fake.example/pickup';
  config.feishu.webhookUrlPickup = pickupUrl;

  sent.length = 0;
  const ok = await notifyPostingPickedUp(
    { posting_number: 'TEST-SOURCE-1', seller_id: 1, changed_state_date: null, new_state: 'posting_on_way_to_city' },
    'polling'
  );
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, pickupUrl, '揽收通知应仍走 PICKUP 机器人(路由不能被来源参数改动)');
  assert.equal(sent[0].text.includes('TEST-SOURCE-1'), true);
  assert.equal(footerOf(sent[0].text), `—— 来自 ${config.appName} · 定时获取`);

  // 机器人 URL 留空 = 跳过不发(本地开发的安全阀)，来源参数不能绕过它
  config.feishu.webhookUrlPickup = '';
  sent.length = 0;
  assert.equal(await notifyPostingPickedUp({ posting_number: 'TEST-SOURCE-2', seller_id: 1 }, 'polling'), false);
  assert.equal(sent.length, 0, '未配 URL 时不应发出任何请求');
  console.log('✓ notifyPostingPickedUp: source 一路透传到文案尾部，机器人路由与空 URL 跳过不受影响');
}

try {
  await initSchema();
  await testSourceLabels();
  await testNotifyForwardsSource();
  console.log('\n全部通过');
} finally {
  globalThis.fetch = realFetch;
  rmSync(TMP_DB_DIR, { recursive: true, force: true });
  console.log(`临时库已删除 ${TMP_DB_DIR}`);
}
