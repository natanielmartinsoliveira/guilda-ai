import { InlineKeyboard } from './messages';
export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number }; text?: string };
  };
}
/** Errors never include the request URL: it contains the bot token. */
export class TelegramError extends Error {}
/** Thin Bot API client; the HTTP function is injectable for tests. */
export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly http: typeof fetch = fetch,
  ) {}
  private async call<T>(method: string, body: unknown, timeoutMs = 30000): Promise<T> {
    let response: Response;
    try {
      response = await this.http(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new TelegramError(`Telegram ${method}: network error`);
    }
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!data.ok)
      throw new TelegramError(
        `Telegram ${method}: ${data.description ?? `HTTP ${response.status}`}`,
      );
    return data.result as T;
  }
  async sendMessage(chatId: string, text: string, keyboard?: InlineKeyboard) {
    const result = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      ...(keyboard ? { reply_markup: keyboard } : {}),
      link_preview_options: { is_disabled: true },
    });
    return { messageId: String(result.message_id) };
  }
  async editMessageText(chatId: string, messageId: string, text: string) {
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
      link_preview_options: { is_disabled: true },
    });
  }
  async answerCallbackQuery(id: string, text: string) {
    await this.call('answerCallbackQuery', { callback_query_id: id, text });
  }
  /** Long polling: waits up to timeoutSeconds for new updates. */
  getUpdates(offset: number | undefined, timeoutSeconds: number) {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      {
        ...(offset !== undefined ? { offset } : {}),
        timeout: timeoutSeconds,
        allowed_updates: ['message', 'callback_query'],
      },
      (timeoutSeconds + 10) * 1000,
    );
  }
}
