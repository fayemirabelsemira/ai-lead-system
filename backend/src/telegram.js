import { config } from "./config.js";
import { clip, TELEGRAM_MAX_TEXT } from "./text.js";

const BASE = `https://api.telegram.org/bot${config.telegramBotToken}`;

async function call(method, payload = {}, signal) {
  const res = await fetch(`${BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    // Never include the URL in errors: it contains the bot token.
    throw new Error(`Telegram ${method} failed: ${data?.description ?? res.status}`);
  }
  return data.result;
}

// Long polling: waits up to 25 seconds for new messages.
export const getUpdates = (offset, signal) =>
  call(
    "getUpdates",
    { offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
    signal
  );

// Messages are sent as PLAIN TEXT (no parse_mode) on purpose:
// customer-written text must never be able to inject formatting.
// Text is capped at Telegram's limit so an oversized message never fails to send.
export const sendMessage = (chatId, text, extra = {}) =>
  call("sendMessage", {
    chat_id: chatId,
    text: clip(text, TELEGRAM_MAX_TEXT),
    // No link previews: links in customer messages or errors must not unfurl.
    link_preview_options: { is_disabled: true },
    ...extra,
  });

export const editMessageText = (chatId, messageId, text, extra = {}) =>
  call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: clip(text, TELEGRAM_MAX_TEXT),
    ...extra,
  });

export const answerCallbackQuery = (callbackQueryId, text, showAlert = false) =>
  call("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
