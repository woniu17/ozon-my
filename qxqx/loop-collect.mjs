#!/usr/bin/env node
// 循环编排:浅度采集 → 深度采集 → 重复,直到全部完成
//
// 原理:
//   浅采(qxqx/shallow-collect.js):扫店铺页,发现 SKU + 4 道过滤,通过的写 dom 缓存并入深度采集队列
//   深采(qxqx/deep-collect.js):消费 collect-queue,逐 SKU 做 card/detail/pdp/search/bundle/marketStats/followSell
//   两者共用同一 .ozon-profile(cloakbrowser 不允许双开),因此必须串行;本脚本把两阶段编排成流水线循环:
//
//     第 N 轮: [浅采 处理一批店铺 → 入队] → [深采 消费一批任务] → 下一轮
//
//   循环终止条件(默认):浅采无待采店铺(输出"全部完成,无需处理") 且 深采队列排空(输出"无可消费任务")。
//
// 用法:
//   ERP_BASE_URL=http://127.0.0.1:3001 ERP_API_KEY=xxx node loop-collect.mjs
//
// 环境变量(除下列外,其余 env 原样透传给子进程,如 SKU_PRICE_MIN/HEADLESS/LOG_SKU 等):
//   MAX_ROUNDS           最大轮次,0=不限直到排空(默认 0)
//   SHALLOW_STORE_LIMIT  每轮浅采店铺数上限,0=不限(默认 2)
//   DEEP_TASK_LIMIT      每轮深采任务数上限,0=不限(默认 3000)
//   SKIP_SHALLOW=1       只跑深采(默认不设)
//   SKIP_DEEP=1          只跑浅采(默认不设)
//   LOOP_WAIT_MS         轮间等待毫秒(默认 5000)
//   IGNORE_CHILD_ERROR=1 子进程非零退出时不中止循环(默认不设)
//
// 命令行:
//   node loop-collect.mjs --once     只跑一轮(浅采+深采各一次)后退出
//
// 注意:
//   - 深采需要 seller 登录态(profile 已登录 seller.ozon.ru),退出码 2 = 登录缺失,循环会中止
//   - Ctrl+C 会向当前子进程转发 SIGINT(子进程会保存进度/把当前任务回队),安全中断
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── .env 加载(不覆盖已有 process.env,命令行优先) ────────────
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(join(__dirname, '.env'));

// ── 配置 ─────────────────────────────────────────────────────
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 0); // 0=不限直到排空
const SHALLOW_STORE_LIMIT = Number(process.env.SHALLOW_STORE_LIMIT ?? 2); // 每轮浅采店铺数上限
const DEEP_TASK_LIMIT = Number(process.env.DEEP_TASK_LIMIT ?? 3000); // 每轮深采任务数上限
const SKIP_SHALLOW = process.env.SKIP_SHALLOW === '1';
const SKIP_DEEP = process.env.SKIP_DEEP === '1';
const LOOP_WAIT_MS = Number(process.env.LOOP_WAIT_MS || 5000);
const IGNORE_CHILD_ERROR = process.env.IGNORE_CHILD_ERROR === '1';
const ONCE = process.argv.includes('--once');

const ERP_BASE_URL = (process.env.ERP_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const ERP_API_KEY = process.env.ERP_API_KEY || '';

// 完成标记(子进程 stdout 中出现即认为该阶段已排空)
const SHALLOW_DONE_MARKERS = ['全部完成,无需处理'];
const DEEP_DONE_MARKERS = ['无可消费任务'];

// ── 状态 ─────────────────────────────────────────────────────
let interrupted = false;
let child = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// SIGINT:转发给子进程(子进程会优雅保存进度),等待其收尾后退出
process.on('SIGINT', () => {
  if (interrupted) process.exit(1);
  interrupted = true;
  console.log('\n[loop] 收到中断,正在终止当前子进程并保存进度...');
  if (child && child.exitCode == null) {
    try {
      child.kill('SIGINT');
    } catch {
      /* noop */
    }
    // 兜底:5s 后仍不退则强杀
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* noop */
      }
    }, 5000);
  } else {
    process.exit(0);
  }
});

// ── ERP 队列探测(仅用于展示,失败不影响循环) ─────────────────
async function fetchQueueStats() {
  if (!ERP_API_KEY) return null;
  try {
    const res = await fetch(`${ERP_BASE_URL}/admin/api/collect-queue/stats`, {
      headers: { 'x-api-key': ERP_API_KEY },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const d = j?.data;
    return d ? { total: d.total, byStatus: d.byStatus } : null;
  } catch {
    return null;
  }
}

// ── 运行一个采集子进程 ─────────────────────────────────────
// 逐行转发输出(带阶段前缀),并检测「已排空」完成标记。
// 返回 { code, exhausted }
function runPhase(name, script, extraEnv, doneMarkers) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...extraEnv };
    child = spawn('node', [script], { cwd: __dirname, env, stdio: ['inherit', 'pipe', 'pipe'] });

    const lineBuf = { out: '', err: '' };
    const found = new Set();

    const handleChunk = (chunk, stream) => {
      lineBuf[stream] += chunk.toString();
      const lines = lineBuf[stream].split('\n');
      lineBuf[stream] = lines.pop(); // 最后一段可能是不完整行,留到下一块
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        const trimmed = line.trim();
        if (trimmed) console.log(`[${name}] ${trimmed}`);
        for (const m of doneMarkers) {
          if (trimmed.includes(m)) found.add(m);
        }
      }
    };
    const flushTail = (stream) => {
      const rest = lineBuf[stream].trim();
      if (rest) {
        console.log(`[${name}] ${rest}`);
        for (const m of doneMarkers) if (rest.includes(m)) found.add(m);
      }
    };

    child.stdout.on('data', (c) => handleChunk(c, 'out'));
    child.stderr.on('data', (c) => handleChunk(c, 'err'));

    child.on('error', (e) => {
      console.error(`[${name}] 启动失败:`, e.message);
      resolve({ code: -1, exhausted: false });
    });

    child.on('close', (code) => {
      flushTail('out');
      flushTail('err');
      child = null;
      console.log(`[${name}] 进程退出 exit=${code}, 排空标记: ${[...found].join('、') || '无'}`);
      resolve({ code, exhausted: found.size > 0 });
    });
  });
}

// ── 主循环 ─────────────────────────────────────────────────
let round = 0;
let shallowExhausted = SKIP_SHALLOW; // 跳过浅采则视为已排空
let deepExhausted = SKIP_DEEP;

console.log('=== 循环采集编排(浅度采集 + 深度采集) ===');
console.log(`ERP:       ${ERP_BASE_URL}`);
console.log(`每轮浅采: ${SHALLOW_STORE_LIMIT || '不限'} 店铺 | 每轮深采: ${DEEP_TASK_LIMIT || '不限'} 任务`);
console.log(`最大轮次: ${MAX_ROUNDS || '不限(直到排空)'} | 轮间等待: ${LOOP_WAIT_MS}ms | 模式: ${ONCE ? 'ONCE(一轮)' : '循环'}`);

while (!interrupted) {
  round++;
  const stats = await fetchQueueStats();
  const pending = stats?.byStatus?.pending ?? '?';
  console.log(
    `\n===== 第 ${round} 轮 ===== 队列 total=${stats?.total ?? '?'}, pending=${pending}` +
      (stats?.byStatus?.running ? `, running=${stats.byStatus.running}` : '')
  );

  // ── 浅采 ──
  if (!SKIP_SHALLOW && !shallowExhausted) {
    const extra = {};
    if (SHALLOW_STORE_LIMIT > 0) extra.STORE_LIMIT = String(SHALLOW_STORE_LIMIT);
    const r = await runPhase('浅采', 'shallow-collect.js', extra, SHALLOW_DONE_MARKERS);
    if (r.exhausted) shallowExhausted = true;
    if (r.code !== 0 && !IGNORE_CHILD_ERROR) {
      console.error(`[loop] 浅采失败(exit=${r.code}),中止循环(IGNORE_CHILD_ERROR=1 可继续)`);
      process.exit(r.code);
    }
  }

  if (interrupted) break;

  // ── 深采 ──
  if (!SKIP_DEEP && !deepExhausted) {
    const extra = {};
    if (DEEP_TASK_LIMIT > 0) extra.TASK_LIMIT = String(DEEP_TASK_LIMIT);
    const r = await runPhase('深采', 'deep-collect.js', extra, DEEP_DONE_MARKERS);
    if (r.code === 2) {
      console.error('[loop] 深采退出码 2 = seller 登录态缺失,请在 .ozon-profile 人工登录 seller.ozon.ru 后重跑');
      process.exit(2);
    }
    if (r.exhausted) deepExhausted = true;
    if (r.code !== 0 && !IGNORE_CHILD_ERROR) {
      console.error(`[loop] 深采失败(exit=${r.code}),中止循环(IGNORE_CHILD_ERROR=1 可继续)`);
      process.exit(r.code);
    }
  }

  console.log(
    `[loop] 第 ${round} 轮完成 → 浅采${shallowExhausted ? '已排空' : '还有店'} / 深采${deepExhausted ? '已排空' : '还有任务'}`
  );

  if (ONCE) break;
  if (MAX_ROUNDS > 0 && round >= MAX_ROUNDS) {
    console.log(`[loop] 达到最大轮次 ${MAX_ROUNDS},退出`);
    break;
  }
  if (shallowExhausted && deepExhausted) {
    console.log('[loop] 浅采无待采店铺 且 深采队列已排空 → 全部完成,退出');
    break;
  }
  if (LOOP_WAIT_MS > 0) await sleep(LOOP_WAIT_MS);
}

// 等待子进程收尾(中断场景)
if (child && child.exitCode == null) {
  await new Promise((r) => child.on('close', r));
}
console.log('[loop] 编排结束。');
process.exit(interrupted ? 130 : 0);
