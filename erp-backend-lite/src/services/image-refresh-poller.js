// 图片更新任务调度 poller(2026-07)
// 职责:轮询 image_refresh_tasks(PENDING/RUNNING),对每个 item 执行
//   读源图 → 按模板加工水印 → 调 /v1/product/pictures/import 提交 → 等5s → 查 /v2/product/pictures/info 验证 → 更新状态
// 串行处理每个 item,item 间间隔 2s,避免触发 Ozon API 限流;轮询周期 2s
import { db } from '../db/index.js';
import config from '../config/index.js';
import { processImageBatch } from './image-host.js';
import * as opi from './ozon-opi.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 2000;
const FIRST_SCAN_DELAY_MS = 8 * 1000;
const MAX_CONCURRENCY = 1; // 串行处理,降低并发避免 Ozon API 限流
const ITEM_INTERVAL_MS = 2000; // item 间时间间隔,防止连续提交触发限流
const COOLDOWN_MS = 5000; // 提交后等 5s 再查状态(对齐项目约定)

let timer = null;
let running = false;

// 从 payload 行提取指定 offer_id 的图片 URL
function extractImagesFromPayload(payloadJson, offerId) {
  if (!payloadJson) return null;
  let items;
  try {
    items = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  const it = items.find((x) => x.offer_id === offerId);
  if (!it) return null;
  const imgs = [];
  if (it.primary_image) imgs.push(it.primary_image);
  const list = Array.isArray(it.images) ? it.images : [];
  for (const i of list) {
    const url = typeof i === 'object' ? i?.file_name : i;
    if (url) imgs.push(String(url));
  }
  const dedup = [...new Set(imgs)];
  return dedup.length > 0 ? dedup : null;
}

// 读源图:优先 item.source_images → transformed payload → raw payload → 失败
function getSourceImages(item) {
  // 1. 创建任务时已带 source_images
  if (item.source_images) {
    try {
      const arr = JSON.parse(item.source_images);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch {}
  }
  // 2. 有 source_task_id:直接读该任务的 payload
  if (item.source_task_id && item.source_item_offer_id) {
    const tRow = db
      .prepare(
        `SELECT payload FROM follow_sell_task_payloads WHERE local_task_id=? AND stage='transformed' ORDER BY created_at DESC LIMIT 1`
      )
      .get(item.source_task_id);
    const imgs = extractImagesFromPayload(tRow?.payload, item.source_item_offer_id);
    if (imgs) return imgs;
    // 3. raw stage(原始采集图,需重新加工)
    const rRow = db
      .prepare(
        `SELECT payload FROM follow_sell_task_payloads WHERE local_task_id=? AND stage='raw' ORDER BY created_at DESC LIMIT 1`
      )
      .get(item.source_task_id);
    const rawImgs = extractImagesFromPayload(rRow?.payload, item.source_item_offer_id);
    if (rawImgs) return rawImgs;
  }
  // 4. 无 source_task_id(商品列表模式):按 offer_id 反查最近的 follow_sell_task_items 找 sourceTaskId
  //    注意:不要求 product_id IS NOT NULL —— 上架时 product_id 可能为 null(OPI 还没返回),
  //    但 payload 已存在,local_task_id 足以定位源图
  const offerId = item.source_item_offer_id || item.offer_id;
  if (offerId) {
    const tItem = db
      .prepare(
        `SELECT i.local_task_id, i.product_id FROM follow_sell_task_items i
         WHERE i.offer_id=?
         ORDER BY i.id DESC LIMIT 1`
      )
      .get(offerId);
    if (tItem?.local_task_id) {
      const tRow = db
        .prepare(
          `SELECT payload FROM follow_sell_task_payloads WHERE local_task_id=? AND stage='transformed' ORDER BY created_at DESC LIMIT 1`
        )
        .get(tItem.local_task_id);
      const imgs = extractImagesFromPayload(tRow?.payload, offerId);
      if (imgs) return imgs;
      const rRow = db
        .prepare(
          `SELECT payload FROM follow_sell_task_payloads WHERE local_task_id=? AND stage='raw' ORDER BY created_at DESC LIMIT 1`
        )
        .get(tItem.local_task_id);
      const rawImgs = extractImagesFromPayload(rRow?.payload, offerId);
      if (rawImgs) return rawImgs;
    }
  }
  return null;
}

// 读上架模板配置(listing_templates.config_json)
function readListingTemplateConfig(templateId) {
  if (!templateId) return null;
  try {
    const row = db.prepare(`SELECT config_json FROM listing_templates WHERE id=?`).get(Number(templateId));
    return row?.config_json ? JSON.parse(row.config_json) : null;
  } catch (e) {
    logger.warn({ templateId, err: e.message }, 'image-refresh 读取 listing_templates 失败');
    return null;
  }
}

// 读水印模板配置(watermark_templates.config)
function readWatermarkConfig(watermarkTemplateId) {
  if (!watermarkTemplateId) return null;
  try {
    const row = db.prepare(`SELECT config FROM watermark_templates WHERE id=?`).get(Number(watermarkTemplateId));
    return row?.config ? JSON.parse(row.config) : null;
  } catch (e) {
    logger.warn({ watermarkTemplateId, err: e.message }, 'image-refresh 读取 watermark_templates 失败');
    return null;
  }
}

// 应用 imageOrder:keep(原序) / shuffle_non_primary(打乱非主图)
function applyImageOrder(urls, imageOrder) {
  if (imageOrder !== 'shuffle_non_primary' || urls.length <= 2) return urls;
  const [primary, ...rest] = urls;
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [primary, ...rest];
}

// 加工图片:按模板水印渲染 + 落盘图床,返回加工后 URL 数组
async function processImages(urls, item, tplCfg) {
  const sku = String(item.product_id);
  // 无模板:直接返回源图(不加工)
  if (!tplCfg) return urls;
  const applyWatermark = tplCfg.applyWatermark === true && tplCfg.watermarkTemplateId;
  if (!applyWatermark) {
    // 仅应用图片顺序
    return applyImageOrder(urls, tplCfg.imageOrder);
  }
  const wmCfg = readWatermarkConfig(tplCfg.watermarkTemplateId);
  if (!wmCfg) {
    logger.warn({ itemId: item.id, watermarkTemplateId: tplCfg.watermarkTemplateId }, 'image-refresh 水印模板缺失,透传原图');
    return applyImageOrder(urls, tplCfg.imageOrder);
  }
  try {
    const { results } = await processImageBatch(urls, sku, wmCfg);
    const processed = results.map((r) => (r.ok && r.publicUrl) || r.originalUrl);
    return applyImageOrder(processed, tplCfg.imageOrder);
  } catch (e) {
    logger.warn({ itemId: item.id, err: e.message }, 'image-refresh 水印加工整体失败,透传原图');
    return applyImageOrder(urls, tplCfg.imageOrder);
  }
}

// 处理单个 item
async function processItem(item, task) {
  const store = config.loadStores().find((s) => s.id === item.store_id);
  if (!store) {
    failItem(item, task, `店铺不存在: ${item.store_id}`);
    return;
  }
  // 标记 PROCESSING
  db.prepare(
    `UPDATE image_refresh_items SET status='PROCESSING', updated_at=datetime('now') WHERE id=?`
  ).run(item.id);
  // 首次执行时更新 task 状态为 RUNNING
  if (task.status === 'PENDING') {
    db.prepare(`UPDATE image_refresh_tasks SET status='RUNNING' WHERE local_task_id=?`).run(task.local_task_id);
  }

  try {
    // 读源图
    let urls = getSourceImages(item);
    if (!urls || urls.length === 0) {
      failItem(item, task, '无法获取源图(payload 缺失或 offer_id 不匹配,请在前端显式提供 sourceImages)');
      return;
    }
    // 保存源图(便于详情页展示)
    db.prepare(`UPDATE image_refresh_items SET source_images=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(urls), item.id);

    // 按模板加工
    const tplCfg = task.template_id ? readListingTemplateConfig(task.template_id) : null;
    const processed = await processImages(urls, item, tplCfg);
    db.prepare(`UPDATE image_refresh_items SET processed_images=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(processed), item.id);

    // 调 /v1/product/pictures/import 提交
    const importResp = await opi.productPicturesImport(store, {
      product_id: Number(item.product_id),
      images: processed,
    });
    logger.info({ itemId: item.id, productId: item.product_id }, 'image-refresh 已提交 OPI');

    // 等 5s 冷却,让 Ozon 抓取图片
    await new Promise((r) => setTimeout(r, COOLDOWN_MS));

    // 查 /v2/product/pictures/info 验证
    const infoResp = await opi.productPicturesInfo(store, [item.product_id]);
    const found = (infoResp?.items || []).find((it) => String(it.product_id) === String(item.product_id));
    const errors = found?.errors || [];
    db.prepare(
      `UPDATE image_refresh_items
       SET status=?, opi_result=?, updated_at=datetime('now')
       WHERE id=?`
    ).run(
      errors.length === 0 ? 'SUCCESS' : 'FAILED',
      JSON.stringify(found || { import: importResp }),
      item.id
    );
    if (errors.length === 0) {
      db.prepare(`UPDATE image_refresh_tasks SET success_count = success_count + 1 WHERE local_task_id=?`).run(
        task.local_task_id
      );
      logger.info({ itemId: item.id, productId: item.product_id }, 'image-refresh 图片更新成功');
    } else {
      db.prepare(`UPDATE image_refresh_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`).run(
        task.local_task_id
      );
      logger.warn({ itemId: item.id, productId: item.product_id, errors }, 'image-refresh 图片仍有错误');
    }
    summarizeTask(task.local_task_id);
  } catch (e) {
    failItem(item, task, e.message || String(e));
  }
}

function failItem(item, task, msg) {
  db.prepare(
    `UPDATE image_refresh_items SET status='FAILED', error_message=?, updated_at=datetime('now') WHERE id=?`
  ).run(msg, item.id);
  db.prepare(`UPDATE image_refresh_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`).run(
    task.local_task_id
  );
  logger.warn({ itemId: item.id, err: msg }, 'image-refresh item 失败');
  summarizeTask(task.local_task_id);
}

// 汇总任务状态:无 PENDING/PROCESSING item 时计算终态
function summarizeTask(localTaskId) {
  const pending = db
    .prepare(`SELECT COUNT(*) as n FROM image_refresh_items WHERE task_id=? AND status IN ('PENDING','PROCESSING')`)
    .get(localTaskId).n;
  if (pending > 0) return;
  const task = db.prepare(`SELECT * FROM image_refresh_tasks WHERE local_task_id=?`).get(localTaskId);
  if (!task) return;
  if (['SUCCESS', 'FAILED'].includes(task.status)) return; // 已终态
  let newStatus;
  if (task.success_count > 0 && task.failed_count > 0) newStatus = 'PARTIAL';
  else if (task.success_count > 0) newStatus = 'SUCCESS';
  else newStatus = 'FAILED';
  db.prepare(`UPDATE image_refresh_tasks SET status=?, completed_at=datetime('now') WHERE local_task_id=?`).run(
    newStatus,
    localTaskId
  );
  logger.info({ localTaskId, status: newStatus, success: task.success_count, failed: task.failed_count }, 'image-refresh 任务完成');
}

// 扫描一次
async function scanOnce() {
  if (running) return;
  running = true;
  try {
    // 取 PENDING/RUNNING 任务
    const tasks = db
      .prepare(`SELECT * FROM image_refresh_tasks WHERE status IN ('PENDING','RUNNING') ORDER BY created_at ASC`)
      .all();
    for (const task of tasks) {
      // 取该任务下 PENDING item(最多 MAX_CONCURRENCY)
      const items = db
        .prepare(`SELECT * FROM image_refresh_items WHERE task_id=? AND status='PENDING' ORDER BY id ASC LIMIT ?`)
        .all(task.local_task_id, MAX_CONCURRENCY);
      if (items.length === 0) continue;
      // 串行处理每个 item,item 间增加时间间隔,避免触发 Ozon API 限流
      for (const it of items) {
        await processItem(it, task);
        await new Promise((r) => setTimeout(r, ITEM_INTERVAL_MS));
      }
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'image-refresh-poller 扫描异常');
  } finally {
    running = false;
  }
}

export function startImageRefreshPoller() {
  if (timer) return;
  setTimeout(() => {
    scanOnce().catch((e) => logger.warn({ err: e.message }, 'image-refresh-poller 首次扫描异常'));
    timer = setInterval(() => {
      scanOnce().catch((e) => logger.warn({ err: e.message }, 'image-refresh-poller 扫描异常'));
    }, POLL_INTERVAL_MS);
    timer.unref();
  }, FIRST_SCAN_DELAY_MS).unref();
  logger.info(
    { intervalMs: POLL_INTERVAL_MS, concurrency: MAX_CONCURRENCY, itemIntervalMs: ITEM_INTERVAL_MS },
    'image-refresh-poller: 已启动(2s检查,串行处理,item间2s间隔,图片更新调度)'
  );
}

export function stopImageRefreshPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
