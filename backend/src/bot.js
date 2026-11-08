import { getUpdates, sendMessage } from "./telegram.js";
import { supabase } from "./supabase.js";

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

async function handleMessage(message) {
  // Private chats only for now; ignore groups and channels.
  if (message.chat.type !== "private" || !message.from) return;

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();

  const memberships = await findAuthorizedMemberships(userId);

  if (memberships.length === 0) {
    console.log(`Rejected message from unauthorized Telegram user ${userId}`);
    await sendMessage(chatId, "Sorry, this account is not authorized to use this bot.");
    return;
  }

  if (text === "/start" || text === "/whoami") {
    const lines = memberships.map((m) => `• ${m.businesses.business_name} (${m.role})`);
    await sendMessage(chatId, `You are authorized for:\n${lines.join("\n")}`);
    return;
  }

  await sendMessage(chatId, "Available command: /whoami");
}

let offset = 0;
let running = true;
const controller = new AbortController();

process.on("SIGINT", () => {
  running = false;
  controller.abort();
});

async function poll() {
  console.log("Bot polling started. Press Ctrl+C to stop.");
  while (running) {
    try {
      const updates = await getUpdates(offset, controller.signal);
      for (const update of updates) {
        offset = update.update_id + 1; // mark as handled
        try {
          if (update.message) await handleMessage(update.message);
        } catch (err) {
          console.error("Failed to handle an update:", err.message);
        }
      }
    } catch (err) {
      if (!running) break;
      console.error("Polling error:", err.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  console.log("Bot stopped.");
}

poll();
