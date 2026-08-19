// TYPE_CHAT_CLOSED handler
// 写入 ozon_chat_messages,event_type='chat_closed'
// 同一 chat_id 的 chat_closed 事件幂等(同 chat_id + 同 event_type 只一条,但 message_id 需要值)
// 用 'chat_closed' 作为伪 message_id 满足 UNIQUE 约束
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function chatClosedHandler(payload, ctx) {
  const chatId = payload.chat_id;
  if (!chatId) throw new Error('CHAT_CLOSED 缺少 chat_id');

  const db = getDb();
  const now = new Date().toISOString();

  // message_id 用常量占位(聊天关闭事件无 message_id,用 'chat_closed' 满足 UNIQUE)
  db.prepare(`
    INSERT INTO ozon_chat_messages
      (chat_id, message_id, chat_type, seller_id, user_id, user_type, event_type, received_at)
    VALUES (?, 'chat_closed', ?, ?, ?, ?, 'chat_closed', ?)
    ON CONFLICT(chat_id, message_id, event_type) DO UPDATE SET
      chat_type=excluded.chat_type,
      received_at=excluded.received_at
  `).run(
    chatId,
    payload.chat_type ?? null,
    typeof payload.seller_id === 'number' ? payload.seller_id : null,
    payload.user?.id ?? null,
    payload.user?.type ?? null,
    now,
  );

  logger.info({ chatId, chatType: payload.chat_type }, 'CHAT_CLOSED 落库');
}
