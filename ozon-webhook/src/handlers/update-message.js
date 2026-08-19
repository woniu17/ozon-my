// TYPE_UPDATE_MESSAGE handler
// 写入 ozon_chat_messages,event_type='update_message'
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function updateMessageHandler(payload, ctx) {
  const chatId = payload.chat_id;
  const messageId = payload.message_id;
  if (!chatId || !messageId) throw new Error('UPDATE_MESSAGE 缺少 chat_id/message_id');

  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO ozon_chat_messages
      (chat_id, message_id, chat_type, seller_id, user_id, user_type, event_type, data_json, created_at, updated_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, 'update_message', ?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id, event_type) DO UPDATE SET
      chat_type=excluded.chat_type,
      data_json=excluded.data_json,
      updated_at=excluded.updated_at,
      received_at=excluded.received_at
  `).run(
    chatId,
    messageId,
    payload.chat_type ?? null,
    typeof payload.seller_id === 'number' ? payload.seller_id : null,
    payload.user?.id ?? null,
    payload.user?.type ?? null,
    JSON.stringify(payload.data ?? []),
    payload.created_at ?? null,
    payload.updated_at ?? null,
    now,
  );

  logger.info({ chatId, messageId, updatedAt: payload.updated_at }, 'UPDATE_MESSAGE 落库');
}
