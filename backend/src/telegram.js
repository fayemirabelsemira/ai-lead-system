import { config } from "./config.js";

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

export const sendMessage = (chatId, text, extra = {}) =>
  call("sendMessage", { chat_id: chatId, text, ...extra });
