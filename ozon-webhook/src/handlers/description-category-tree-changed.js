// TYPE_DESCRIPTION_CATEGORY_TREE_CHANGED handler
// 写入 ozon_category_tree_refresh_log,供 erp 消费触发类目树刷新
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function descriptionCategoryTreeChangedHandler(payload, ctx) {
  const changedAt = payload.changed_at;
  if (!changedAt) throw new Error('DESCRIPTION_CATEGORY_TREE_CHANGED 缺少 changed_at');

  const db = getDb();
  const now = new Date().toISOString();

  // ON CONFLICT(changed_at):重复推送直接覆盖 received_at,consumed_at 保持 NULL
  db.prepare(`
    INSERT INTO ozon_category_tree_refresh_log
      (changed_at, received_at, consumed_at)
    VALUES (?, ?, NULL)
    ON CONFLICT(changed_at) DO UPDATE SET
      received_at=excluded.received_at,
      consumed_at=NULL
  `).run(changedAt, now);

  logger.info({ changedAt }, 'DESCRIPTION_CATEGORY_TREE_CHANGED 落库');
}
