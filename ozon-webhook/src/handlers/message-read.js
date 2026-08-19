// TYPE_MESSAGE_READ handler
// 写入 ozon_chat_messages,event_type='message_read'
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function messageReadHandler(payload, ctx) {
  const chatId = payload.chat_id;
  const lastReadMessageId = payload.last_read_message_id;
  if (!chatId || !lastReadMessageId) throw new Error('MESSAGE_READ 缺少 chat_id/last_read_message_id');

  const db = getDb();
  const now = new Date().toISOString();

  // message_id 用 last_read_message_id 作为事件标识(语义为"已读到这条")
  db.prepare(`
    INSERT INTO ozon_chat_messages
      (chat_id, message_id, chat_type, seller_id, user_id, user_type, event_type, last_read_message_id, created_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, 'message_read', ?, ?, ?)
    ON CONFLICT(chat_id, message_id, event_type) DO UPDATE SET
      last_read_message_id=excluded.last_read_message_id,
      received_at=excluded.received_at
  `).run(
    chatId,
    lastReadMessageId,
    payload.chat_type ?? null,
    typeof payload.seller_id === 'number' ? payload.seller_id : null,
    payload.user?.id ?? null,
    payload.user?.type ?? null,
    lastReadMessageId,
    payload.created_at ?? null,
    now,
  );

  logger.info({ chatId, lastReadMessageId }, 'MESSAGE_READ 落库');
}
