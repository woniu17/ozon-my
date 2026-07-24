// 采集队列 DAO(MongoDB 实现):collectQueueTasks + collectQueueOps
// 含 __snapshot__ 特殊文档处理、$setOnInsert、嵌套字段查询、TTL 索引
import { ObjectId } from 'mongodb';
import { cols } from '../../mongo.js';

export const collectQueueTasksDao = {
  /** 聚合状态计数:排除 __snapshot__ 文档 */
  async aggregateStatusCounts() {
    const col = await cols.collectQueueTasks();
    return col.aggregate([
      { $match: { _id: { $ne: '__snapshot__' } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).toArray();
  },

  /** 今日指定状态计数(finishedAt >= since) */
  async countTodayByStatus(status, since) {
    const col = await cols.collectQueueTasks();
    return col.countDocuments({ status, finishedAt: { $gte: since } });
  },

  /** 查最近 antibot 任务(嵌套字段 'lastError.type' + sort)
   *  antibot 不再是终态,SW 会把 antibot 任务回 pending 重试(lastError.type='antibot')
   *  此处查询用于推导熔断状态:最近 10 分钟内有 antibot 任务则认为熔断中
   */
  async findLatestAntibotBlocked(since) {
    const col = await cols.collectQueueTasks();
    return col.findOne(
      {
        'lastError.type': 'antibot',
        finishedAt: { $gte: since },
      },
      { sort: { finishedAt: -1 }, projection: { finishedAt: 1, lastError: 1 } }
    );
  },

  /** 按错误类型计数(可选时间窗)
   *  按 lastError.type 嵌套字段过滤(失败/反爬/partial/internal/STALE 等都走 pending 重试,
   *  状态值无法区分,必须查 lastError.type)。since 省略时统计全量(当前队列中正在重试的)。
   */
  async countByErrorType(type, since) {
    const col = await cols.collectQueueTasks();
    const query = { 'lastError.type': type };
    if (since) query.finishedAt = { $gte: since };
    return col.countDocuments(query);
  },

  /** 读取 __snapshot__ 文档(全字段,与 sqlite 实现对齐) */
  async findSnapshot() {
    const col = await cols.collectQueueTasks();
    const doc = await col.findOne({ _id: '__snapshot__' });
    if (!doc) return null;
    return {
      pending: doc.pending ?? 0,
      running: doc.running ?? 0,
      success: doc.success ?? 0,
      failed: doc.failed ?? 0,
      syncedAt: doc.syncedAt ?? null,
      consumePaused: doc.consumePaused ?? null,
      lastConsumeAt: doc.lastConsumeAt ?? null,
    };
  },

  /** 列表计数(排除 __snapshot__) */
  async countList(filter = {}) {
    const col = await cols.collectQueueTasks();
    const query = { _id: { $ne: '__snapshot__' }, ...filter };
    return col.countDocuments(query);
  },

  /** 列表查询(排除 __snapshot__,默认按 createdAt 降序) */
  async findList(filter = {}, page, pageSize, sort) {
    const col = await cols.collectQueueTasks();
    const query = { _id: { $ne: '__snapshot__' }, ...filter };
    const skip = (page - 1) * pageSize;
    // 排序:默认 createdAt DESC。sort 参数格式 { col: 1|-1 }
    const SORT_ALLOWED = ['createdAt', 'updatedAt', 'finishedAt', 'startedAt', 'status', 'sku', 'attempts'];
    let sortSpec = { createdAt: -1 };
    if (sort && typeof sort === 'object') {
      const spec = {};
      for (const [col, dir] of Object.entries(sort)) {
        if (!SORT_ALLOWED.includes(col)) continue;
        spec[col] = String(dir).toUpperCase() === 'ASC' ? 1 : -1;
      }
      if (Object.keys(spec).length) sortSpec = spec;
    }
    return col.find(query).sort(sortSpec).skip(skip).limit(pageSize).toArray();
  },

  /** 按 SKU 查询 */
  async getBySku(sku) {
    const col = await cols.collectQueueTasks();
    return col.findOne({ sku });
  },

  /** 批量按 SKU 查询(投影 4 字段) */
  async findBySkus(skus) {
    const col = await cols.collectQueueTasks();
    return col.find(
      { sku: { $in: skus } },
      { projection: { sku: 1, status: 1, result: 1, updatedAt: 1 } }
    ).toArray();
  },

  /** 重置单任务(重新入队) */
  async resetBySku(sku) {
    const col = await cols.collectQueueTasks();
    const now = new Date().toISOString();
    return col.updateOne(
      { sku },
      { $set: { status: 'pending', attempts: 0, lastError: null, updatedAt: now } }
    );
  },

  async deleteBySku(sku) {
    const col = await cols.collectQueueTasks();
    const r = await col.deleteOne({ sku });
    return { deletedCount: r.deletedCount };
  },

  /** 批量重置(updateMany) */
  async resetBySkus(skus) {
    const col = await cols.collectQueueTasks();
    const now = new Date().toISOString();
    return col.updateMany(
      { sku: { $in: skus } },
      { $set: { status: 'pending', attempts: 0, lastError: null, updatedAt: now } }
    );
  },

  /** 清空 pending 任务(排除 __snapshot__) */
  async deletePendingAll() {
    const col = await cols.collectQueueTasks();
    const r = await col.deleteMany({ status: 'pending', _id: { $ne: '__snapshot__' } });
    return { deletedCount: r.deletedCount };
  },

  /** 写入 __snapshot__ 文档($set 全量刷新,含 sku 兼容 unique 索引) */
  async upsertSnapshot(data) {
    const col = await cols.collectQueueTasks();
    const now = new Date().toISOString();
    const setDoc = {
      _id: '__snapshot__',
      sku: '__snapshot__',
      pending: Number(data.pending) || 0,
      running: Number(data.running) || 0,
      success: Number(data.success) || 0,
      failed: Number(data.failed) || 0,
      syncedAt: data.syncedAt || now,
      consumePaused: data.consumePaused ?? null,
      lastConsumeAt: data.lastConsumeAt ?? null,
      updatedAt: now,
    };
    return col.updateOne({ _id: '__snapshot__' }, { $set: setDoc }, { upsert: true });
  },

  /** 更新任务结果(无 upsert) */
  async updateResult(sku, update) {
    const col = await cols.collectQueueTasks();
    const now = new Date().toISOString();
    return col.updateOne({ sku }, { $set: { ...update, updatedAt: now } });
  },

  /** 提交任务(upsert,$setOnInsert 保护 createdAt 和 result:null) */
  async submit(task) {
    const col = await cols.collectQueueTasks();
    const now = new Date().toISOString();
    const setDoc = {
      sku: task.sku,
      sellerSlug: task.sellerSlug,
      sellerId: task.sellerId,
      domInfo: task.domInfo,
      status: task.status,
      attempts: task.attempts,
      lastError: task.lastError,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      steps: task.steps,
      updatedAt: now,
    };
    const r = await col.updateOne(
      { sku: task.sku },
      { $set: setDoc, $setOnInsert: { createdAt: now, result: null } },
      { upsert: true }
    );
    return { upsertedCount: r.upsertedCount, created: r.upsertedCount === 1 };
  },
};

export const collectQueueOpsDao = {
  /** 去重查询:op + sku + processed:false */
  async findDedup(op, sku) {
    const col = await cols.collectQueueOps();
    return col.findOne({ op, sku, processed: false });
  },

  /** 插入 op(sku 可为 null) */
  async insertOp(op, sku, params = {}) {
    const col = await cols.collectQueueOps();
    const doc = {
      op,
      sku: sku ?? null,
      params,
      ts: new Date(),
      processed: false,
      processedAt: null,
    };
    const r = await col.insertOne(doc);
    return { insertedId: r.insertedId };
  },

  /** 批量插入 ops */
  async insertManyOps(docs) {
    const col = await cols.collectQueueOps();
    const r = await col.insertMany(docs);
    return { insertedCount: r.insertedCount };
  },

  /** 查 pending ops(SW 轮询,默认 limit 100) */
  async findPendingOps(limit = 100) {
    const col = await cols.collectQueueOps();
    return col.find({ processed: false }).sort({ ts: 1 }).limit(limit).toArray();
  },

  /** 标记 op 已处理(ObjectId + processed:false 幂等保护) */
  async markProcessed(id) {
    const col = await cols.collectQueueOps();
    if (!ObjectId.isValid(id)) return { matchedCount: 0, modifiedCount: 0 };
    return col.updateOne(
      { _id: new ObjectId(id), processed: false },
      { $set: { processed: true, processedAt: new Date() } }
    );
  },
};
