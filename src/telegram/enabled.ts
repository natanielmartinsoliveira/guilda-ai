import { config } from '../config';
/** Telegram is used only when both the bot token and the operator chat are configured. */
export function telegramEnabled() {
  const c = config();
  return !!c.TELEGRAM_BOT_TOKEN && !!c.TELEGRAM_CHAT_ID;
}
