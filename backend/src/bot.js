import { getUpdates, sendMessage, answerCallbackQuery } from "./telegram.js";
import { supabase } from "./supabase.js";
import { handleCallback, handleEditReply } from "./approvals.js";

// Authorization comes from the DATABASE, never from message text.
// A Telegram user is authorized only if their ID is linked to a business
// membership with an approving role.
async function findAuthorizedMemberships(telegramUserId) {
  const { data, error } = await supabase
    .from("business_members")
    .select("business_id, role, businesses ( business_name )")
    .eq("telegram_user_id", telegramUserId)
    .in("role", ["OWNER", "ADMIN", "STAFF"]);

  if (error) throw new Error(`Database error: ${error.message}`);
  return data ?? [];
}

const UNAUTHORIZED_NOTICE_MS = 10 * 60 * 1000;
const MAX_TRACKED_STRANGERS = 5000;
const lastUnauthorizedNotice = new Map();

function shouldNotifyUnauthorized(telegramUserId) {
  const now = Date.now();
  const last = lastUnauthorizedNotice.get(telegramUserId);
  if (last && now - last < UNAUTHORIZED_NOTICE_MS) return false;
  // Keep memory bounded: drop the oldest entry (Maps keep insertion order).
  if (lastUnauthorizedNotice.size >= MAX_TRACKED_STRANGERS) {
    lastUnauthorizedNotice.delete(lastUnauthorizedNotice.keys().next().value);
  }
  lastUnauthorizedNotice.delete(telegramUserId);
  lastUnauthorizedNotice.set(telegramUserId, now);
  return true;
}

async function handleMessage(message) {
  // Private chats only for now; ignore groups and channels.
  if (message.chat.type !== "private" || !message.from) return;

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();

  const memberships = await findAuthorizedMemberships(userId);

  if (memberships.length === 0) {
    // Answer a stranger at most once per window, so spamming the bot
    // cannot make it send an unlimited number of replies.
    if (shouldNotifyUnauthorized(userId)) {
      console.log(`Rejected message from unauthorized Telegram user ${userId}`);
      await sendMessage(chatId, "Sorry, this account is not authorized to use this bot.");
    }
    return;
  }

  if (text === "/start" || text === "/whoami") {
    const lines = memberships.map((m) => `• ${m.businesses.business_name} (${m.role})`);
    await sendMessage(chatId, `You are authorized for:\n${lines.join("\n")}`);
    return;
  }

  // Replying to an approval card with plain text means "edit the reply".
  if (message.reply_to_message && text && !text.startsWith("/")) {
    await handleEditReply(message);
    return;
  }

  await sendMessage(chatId, "Available command: /whoami");
}

let offset = 0;
let running = true;
const controller = new AbortController();

async function handleUpdate(update) {
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error("Failed to handle an update:", err.message);
    if (update.callback_query) {
      // Stop the button's loading spinner even when something went wrong.
      await answerCallbackQuery(update.callback_query.id, "Something went wrong. Please try again.").catch(
        () => {}
      );
    }
  }
}

async function poll() {
  console.log("Bot polling started.");
  while (running) {
    try {
      const updates = await getUpdates(offset, controller.signal);
      for (const update of updates) {
        offset = update.update_id + 1; // mark as handled
        await handleUpdate(update);
      }
    } catch (err) {
      if (!running) break;
      console.error("Polling error:", err.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  console.log("Bot stopped.");
}

// Started and stopped by index.js. Resolves once polling has fully stopped.
export function startBot() {
  const done = poll();
  return {
    stop() {
      running = false;
      controller.abort();
      return done;
    },
  };
}
