// 平台订单浏览器管理器(2026-09,平台订单获取 M1;2026-09-13 多账号改造)
// cloakbrowser 多实例:每账号(=每 profile)一个独立管理器——
// 懒启动 / 空闲回收 / PID 锁 / 崩溃重建,实例间真正并行(独立队列)
//
// 职责(每账号实例):
//  - 懒启动:首个订单请求才 launchPersistentContext,冷启动约 15-25s
//  - 空闲回收:10 分钟(PLATFORM_BROWSER_IDLE_MS)无请求自动 close 释放 profile,
//    给 persistent.js 登录窗口让路
//  - 互斥:profile 与 qxqx/persistent.js 共用,Chromium 单实例机制天然互斥——
//    对方占用时 launch 失败,映射为 PROFILE_LOCKED;同时维护自有 PID 锁文件,
//    防本服务双实例(残留死锁自动覆盖)
//  - 崩溃重建:context 'close' 事件清状态,下次请求自动重新 launch
//
// 约束(踩坑记录):
//  - page.evaluate 仅支持单参数,多参数静默失败 → payload 一律合并为单对象
//  - 同源 fetch 需要页面先导航到平台域名(凭证 cookie + referer 才会带上)
//  - 锁文件范式对齐 qxqx/shallow-collect.js acquireLock
//
// 设计文档: docs/平台订单多账号profile-功能设计.md §3.1

import { launchPersistentContext } from 'cloakbrowser';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import config from '../../config/index.js';
import logger from '../../middleware/log.js';
import { ApiError, ErrorCode } from '../../utils/error-codes.js';
import { SerialQueue, withTimeout } from './queue.js';

// ── 行为层防风控(2026-09-13,对齐 get-shop-product mtopClient 节流/熔断策略)──
// baxia 行为风控的典型信号是连续快速 mtop 请求;参考项目页间隔 5s、触发 punish 即停
const MIN_REQUEST_INTERVAL_MS = 3 * 1000;  // 账号级最小请求间隔(队列内串行等待)
const PUNISH_COOLDOWN_MS = 5 * 60 * 1000;  // RISK_VALIDATE 后账号×平台冷却期

// ── 买家账号身份(2026-09-13,采购单自动记平台用户ID/用户名)────────────
// 来源(实测):
//  - 1688/淘宝(阿里系):unb=数字用户ID(两平台同一ID);lid/__cn_logon_id__=用户名;
//    tracknick/_nk_ 可能是 "\uXXXX" 转义字面量,需解码
//  - 拼多多:pdd_user_id=用户ID;用户名无 cookie 来源(留空,订单响应亦无买家字段)
// 1688 订单响应逐单自带 buyerInfo(更权威),cookie 值作兜底;淘宝/PDD 以 cookie 为主源
async function readBuyerIdentity(page, domain) {
  const cs = await page.context().cookies(domain);
  const get = (n) => (cs.find((c) => c.name === n) || {}).value || '';
  // lid 是 percent-encoded UTF-8(实测淘宝 %E6%B8%85%E7%A5%A517);tracknick/_nk_ 是 "\uXXXX" 转义字面量
  const decPct = (s) => { try { return decodeURIComponent(s); } catch { return String(s); } };
  const decUni = (s) =>
    String(s || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return {
    userId: get('unb') || get('pdd_user_id') || '',
    username: decPct(get('lid')) || get('__cn_logon_id__') || decUni(decPct(get('tracknick'))) || decUni(decPct(get('_nk_'))) || '',
  };
}

// ── 单账号管理器(工厂) ──────────────────────────────────
// profileName:账号别名(如 linqx/chenlin);profileDir:对应 userDataDir
function createBrowserManager(profileName, profileDir) {
  const queue = new SerialQueue();
  // 锁文件放 profile 目录旁(不能放 profile 内,避免污染 Chromium userDataDir)
  const lockFile = join(dirname(profileDir), `${basename(profileDir)}.platform-orders.lock`);

  let ctx = null;                 // BrowserContext 单例(该账号)
  const pages = new Map();        // platform → Page(逐平台一页,同源 fetch 载体)
  let idleTimer = null;           // 空闲回收定时器
  let launchPromise = null;       // 并发 ensure 单飞
  let closedByUs = false;         // 区分主动关闭与意外断开
  let lastActiveAt = 0;           // 最近一次任务完成时间
  let lastRequestAt = 0;          // 最近一次任务开始时间(账号级节流基准)
  const punishedUntil = new Map(); // platform → 冷却截止 ts(账号×平台粒度风控熔断)

  // ── PID 锁(防本服务双实例;死进程残留自动覆盖) ──────────
  function isPidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  function acquireLock() {
    let stale = false;
    try {
      const pid = Number(readFileSync(lockFile, 'utf-8').trim());
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        if (isPidAlive(pid)) {
          throw new ApiError('PROFILE_LOCKED', `${profileName} 的 profile 正被本服务其它进程(PID ${pid})占用,锁文件: ${lockFile}`, { status: 409 });
        }
        stale = true;
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      stale = true; // ENOENT 等 → 无锁,直接写
    }
    writeFileSync(lockFile, String(process.pid));
    if (stale) logger.info({ account: profileName }, '[platform-orders] 已覆盖残留锁文件(进程已死)');
  }

  function releaseLock() {
    try { unlinkSync(lockFile); } catch { /* 已删除 */ }
  }

  // ── 启动 / 关闭 ─────────────────────────────────────────
  async function doLaunch() {
    acquireLock();
    closedByUs = false;
    try {
      const c = await launchPersistentContext({
        userDataDir: profileDir,
        headless: config.platformBrowserHeadless,
      });
      // 关闭会话恢复的残留标签页(后台加载占内存;保留第 1 个避免上下文退出)
      const restored = (() => { try { return c.pages(); } catch { return []; } })();
      for (const p of restored.slice(1)) await p.close().catch(() => {});
      c.on('close', onContextClosed);
      ctx = c;
      logger.info(
        { account: profileName, profile: profileDir, headless: config.platformBrowserHeadless, restoredTabs: restored.length },
        '[platform-orders] cloakbrowser 已启动(懒启动)'
      );
      return c;
    } catch (e) {
      releaseLock();
      const msg = String((e && e.message) || e);
      // profile 被其它 Chromium 实例占用(persistent.js 登录窗口未关)是最高频失败原因:
      // 单实例子进程立即退出,Playwright 报 browser closed / Target closed 一类错误
      if (/single|in use|user data|locked|crashed|Target|closed/i.test(msg)) {
        throw new ApiError('PROFILE_LOCKED', `${profileName} 的 profile 被其它浏览器进程占用(如 persistent.js 登录窗口未关闭),请关闭后重试: ${msg}`, { status: 409 });
      }
      throw new ApiError('BROWSER_ERROR', `cloakbrowser 启动失败(${profileName}): ${msg}`, { status: 502 });
    }
  }

  function onContextClosed() {
    if (closedByUs) return; // 主动关闭路径已清理
    logger.warn({ account: profileName }, '[platform-orders] 浏览器意外断开,已清状态,下次请求自动重建');
    cleanupState();
  }

  function cleanupState() {
    clearTimeout(idleTimer);
    idleTimer = null;
    pages.clear();
    ctx = null;
    releaseLock();
  }

  async function closeInternal(reason) {
    clearTimeout(idleTimer);
    idleTimer = null;
    const c = ctx;
    closedByUs = true;
    pages.clear();
    ctx = null;
    releaseLock();
    if (c) {
      try { await c.close(); } catch { /* 已关闭 */ }
    }
    logger.info({ account: profileName, reason }, '[platform-orders] 浏览器已关闭');
  }

  async function ensureContext() {
    if (ctx && !(ctx.isClosed?.() ?? false)) return ctx;
    if (launchPromise) return launchPromise;
    launchPromise = doLaunch().finally(() => { launchPromise = null; });
    return launchPromise;
  }

  // ── 页面管理 ─────────────────────────────────────────────
  async function gotoEntry(page, entryUrl, originPrefix) {
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 30 * 1000 });
    // 校验最终 URL 仍在预期 origin(重定向偏离=页面未真正加载,继续 fetch 只会拿垃圾响应)
    if (!page.url().startsWith(originPrefix)) {
      throw new ApiError('BROWSER_ERROR', `页面导航偏离预期 origin: ${page.url()}`, { status: 502 });
    }
  }

  async function ensurePage(c, platform, entryUrl, originPrefix, settleMs = 0) {
    const settle = settleMs ? new Promise((r) => setTimeout(r, settleMs)) : null;
    let p = pages.get(platform);
    if (p && !p.isClosed()) {
      if (p.url().startsWith(originPrefix)) return p; // 复用已就位页面
      await gotoEntry(p, entryUrl, originPrefix);
      if (settle) await settle;
      return p;
    }
    p = await c.newPage();
    pages.set(platform, p);
    await gotoEntry(p, entryUrl, originPrefix);
    if (settle) await settle;
    return p;
  }

  // ── 空闲回收 ─────────────────────────────────────────────
  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      closeInternal('空闲超时回收').catch(() => {});
    }, config.platformBrowserIdleMs);
    idleTimer.unref?.();
  }

  // ── 对外(实例级) ───────────────────────────────────────
  /** 串行执行一个平台订单任务:排队 → 确保浏览器就绪 → fn(page) → 空闲重排 */
  async function withPage(platform, entryUrl, originPrefix, fn, opts = {}) {
    return queue.run(async () => {
      // 风控熔断:冷却期内快速失败,不再发请求(风控期间继续打会加深惩罚);
      // 重启后端清零;过完滑块后的首次成功请求自动解除
      const until = punishedUntil.get(platform) || 0;
      if (Date.now() < until) {
        const waitMin = Math.ceil((until - Date.now()) / 60000);
        throw new ApiError('RISK_VALIDATE', `${profileName} 的 ${platform} 处于风控冷却期(约${waitMin}分钟后自动解除)。请先用 persistent 过滑块,过完后等冷却结束或重启后端清零`, { status: 409 });
      }
      clearTimeout(idleTimer);
      try {
        // 账号级最小请求间隔:队列内串行等待,避免连续快速 mtop 请求(baxia 行为特征)
        const elapsed = Date.now() - lastRequestAt;
        if (lastRequestAt && elapsed < MIN_REQUEST_INTERVAL_MS) {
          await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
        }
        lastRequestAt = Date.now();
        const c = await ensureContext();
        const page = await ensurePage(c, platform, entryUrl, originPrefix, opts.settleMs || 0);
        const result = await withTimeout(fn(page), config.platformOrderTimeoutMs, '平台订单任务');
        lastActiveAt = Date.now();
        punishedUntil.delete(platform); // 成功即解除(风控已过)
        scheduleIdle();
        return result;
      } catch (e) {
        const isTimeout = e && e.kind === 'timeout';
        const browserDead = !ctx || (ctx.isClosed?.() ?? false);
        if (isTimeout || browserDead) {
          await closeInternal(isTimeout ? '任务超时回收' : '浏览器已断开').catch(() => {});
        } else {
          scheduleIdle(); // 浏览器健康(如 AUTH_REQUIRED),保留复用
        }
        // 风控熔断:登记该平台冷却期(账号×平台粒度,1688 被拦不连累同账号拼多多)
        if (e && e.code === 'RISK_VALIDATE') {
          punishedUntil.set(platform, Date.now() + PUNISH_COOLDOWN_MS);
          logger.warn({ account: profileName, platform, cooldownMs: PUNISH_COOLDOWN_MS }, '[platform-orders] 触发平台风控,进入冷却期');
        }
        // 超时映射为 TIMEOUT(408) 错误码(对齐路由文档;否则是 500 INTERNAL_ERROR)
        if (isTimeout) {
          throw new ApiError(ErrorCode.TIMEOUT, e.message);
        }
        throw e;
      }
    });
  }

  /** 浏览器运行态(不触发冷启动) */
  function status() {
    const running = !!ctx && !(ctx.isClosed?.() ?? false);
    return {
      state: running ? 'running' : 'idle',
      pid: running ? (ctx.browser?.()?.process?.()?.pid ?? null) : null,
      lastActiveAt: lastActiveAt || null,
      profileDir,
    };
  }

  /** 读平台域 cookies(浏览器未运行返回 null);登录态探测用 */
  async function getCookieState(url) {
    if (!ctx || (ctx.isClosed?.() ?? false)) return null;
    try { return await ctx.cookies(url); } catch { return null; }
  }

  /** 关闭浏览器 + 清锁 */
  async function stop() {
    await closeInternal('进程退出').catch(() => {});
  }

  return { withPage, status, getCookieState, stop };
}

// ── 账号注册表(模块级,按需懒实例化) ─────────────────────
const managers = new Map(); // profileName → manager

/** 取账号管理器;未注册的别名抛配置错(路由层前置校验,此为兜底) */
function managerFor(account) {
  let m = managers.get(account);
  if (!m) {
    const dir = config.platformProfiles[account];
    if (!dir) {
      throw new ApiError('VALIDATION_ERROR', `未知账号别名 "${account}",可用: ${Object.keys(config.platformProfiles).join(', ')}`, { status: 400 });
    }
    m = createBrowserManager(account, dir);
    managers.set(account, m);
  }
  return m;
}

// ── 对外 API(模块级) ───────────────────────────────────
/**
 * 串行执行一个平台订单任务(指定账号):排队 → 确保浏览器就绪 → fn(page) → 空闲重排
 * 任务超时(kind='timeout')或浏览器已断开时回收该账号浏览器,其余错误(如登录态失效)
 * 保留浏览器复用;不同账号实例间并行
 * @param {string} account 账号别名(如 linqx/chenlin)
 * @param {object} [opts] settleMs:新导航后等待页面自身 mtop 调用轮换 token(仅首航生效)
 */
async function withPage(account, platform, entryUrl, originPrefix, fn, opts = {}) {
  return managerFor(account).withPage(platform, entryUrl, originPrefix, fn, opts);
}

/** 全部账号浏览器运行态聚合(不触发冷启动);供 status 路由用 */
function status() {
  const browsers = {};
  for (const [name, m] of managers) browsers[name] = m.status();
  return {
    state: Object.values(browsers).some((b) => b.state === 'running') ? 'running' : 'idle',
    browsers,
  };
}

/** 读指定账号的平台域 cookies(浏览器未运行返回 null) */
async function getCookieState(account, url) {
  return managerFor(account).getCookieState(url);
}

/** 进程退出钩子(app.js shutdown 调用):关闭全部账号浏览器 + 清锁 */
async function stopPlatformOrders() {
  await Promise.all([...managers.values()].map((m) => m.stop())).catch(() => {});
}

export { withPage, status, getCookieState, stopPlatformOrders, readBuyerIdentity };
