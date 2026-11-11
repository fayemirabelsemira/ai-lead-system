import { randomBytes, createHash } from "node:crypto";
import { supabase } from "./supabase.js";
import { sendMessage, editMessageText, answerCallbackQuery } from "./telegram.js";
import { clip } from "./text.js";

// Button data looks like "ap:<32 hex characters>" (Telegram allows 64 bytes).
const CALLBACK_PATTERN = /^(ap|rj|ed|vw):([0-9a-f]{32})$/;
const MAX_EDIT_LENGTH = 2000;
const DEV_NOTE = "(Dev mode: no email provider is connected yet, so nothing has actually been sent.)";

// The raw token only ever lives inside the Telegram buttons.
// The database stores only its SHA-256 hash.
export const newToken = () => randomBytes(16).toString("hex");
export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

function unwrap({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

async function loadLeadContext(leadId) {
  const lead = unwrap(
    await supabase
      .from("leads")
      .select(
        "id, business_id, full_name, phone, email, source, original_message, businesses ( business_name, telegram_chat_id )"
      )
      .eq("id", leadId)
      .maybeSingle(),
    "Load lead"
  );
  if (!lead) throw new Error("Lead not found");

  const analysis = unwrap(
    await supabase
      .from("lead_analyses")
      .select(
        "id, intent, lead_score, score_reason, detected_language, suggested_reply, needs_human_review, escalation_reason"
      )
      .eq("lead_id", lead.id)
      .eq("business_id", lead.business_id)
      .eq("analysis_status", "COMPLETED")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    "Load analysis"
  );
  if (!analysis) throw new Error("No completed analysis for this lead");

  return { lead, analysis };
}

async function expiryFor(businessId) {
  const settings = unwrap(
    await supabase
      .from("business_settings")
      .select("approval_expiry_hours")
      .eq("business_id", businessId)
      .maybeSingle(),
    "Load settings"
  );
  const hours = settings?.approval_expiry_hours ?? 24;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function cardText(lead, analysis, reply, version) {
  return [
    "NEW LEAD RECEIVED",
    "",
    `Name: ${lead.full_name}`,
    `Phone: ${lead.phone ?? "not provided"}`,
    `Source: ${lead.source}`,
    "",
    `Lead Score: ${analysis.lead_score}`,
    `Intent: ${analysis.intent}`,
    `Language: ${analysis.detected_language}`,
    "",
    "Customer Message:",
    `"${clip(lead.original_message, 800)}"`,
    "",
    version > 1 ? `Edited Reply (version ${version}):` : "AI Suggested Reply:",
    `"${reply}"`,
    "",
    "AI Reason:",
    // Clipped so the card always fits Telegram's 4096-character limit
    // (the reply itself is never clipped: the owner must see all of it).
    analysis.score_reason ? clip(analysis.score_reason, 500) : "-",
  ].join("\n");
}

const keyboard = (token) => ({
  inline_keyboard: [
    [
      { text: "✅ Approve", callback_data: `ap:${token}` },
      { text: "✏️ Edit Reply", callback_data: `ed:${token}` },
    ],
    [
      { text: "❌ Reject", callback_data: `rj:${token}` },
      { text: "👁 View Lead", callback_data: `vw:${token}` },
    ],
  ],
});

const NO_BUTTONS = { reply_markup: { inline_keyboard: [] } };

// Sends the owner either an approval card or, when the AI says a human
// must handle it, an escalation notice with no reply drafted.
export async function sendLeadCard(leadId) {
  const { lead, analysis } = await loadLeadContext(leadId);
  const chatId = lead.businesses.telegram_chat_id;
  if (!chatId) throw new Error("This business has no Telegram chat configured");

  if (analysis.needs_human_review || !analysis.suggested_reply) {
    await sendMessage(
      chatId,
      [
        "NEEDS HUMAN REVIEW",
        "",
        `Name: ${lead.full_name}`,
        `Phone: ${lead.phone ?? "not provided"}`,
        `Source: ${lead.source}`,
        "",
        "Customer Message:",
        `"${clip(lead.original_message, 800)}"`,
        "",
        "Why a human is needed:",
        analysis.escalation_reason ?? "The AI could not safely answer this.",
        "",
        "No reply was drafted. Please contact the customer yourself.",
      ].join("\n")
    );
    return { escalated: true };
  }

  const token = newToken();
  const draft = unwrap(
    await supabase.rpc("create_reply_draft", {
      p_business_id: lead.business_id,
      p_lead_id: lead.id,
      p_analysis_id: analysis.id,
      p_content: analysis.suggested_reply,
      p_token_hash: hashToken(token),
      p_expires_at: await expiryFor(lead.business_id),
    }),
    "Create draft"
  );

  let sent;
  try {
    sent = await sendMessage(chatId, cardText(lead, analysis, analysis.suggested_reply, 1), {
      reply_markup: keyboard(token),
    });
  } catch (err) {
    // The card never arrived, so its token is lost. Cancel the draft so the
    // lead is not stuck waiting for an approval nobody can give.
    const { error } = await supabase.rpc("cancel_reply_draft", { p_approval_id: draft.approval_id });
    if (error) console.error("Could not cancel the undelivered draft:", error.message);
    throw err;
  }
  unwrap(
    await supabase
      .from("message_approvals")
      .update({ telegram_message_id: sent.message_id })
      .eq("id", draft.approval_id),
    "Save card id"
  );
  return { escalated: false, approvalId: draft.approval_id };
}

async function isAuthorized(businessId, telegramUserId, telegramChatId) {
  const userId = unwrap(
    await supabase.rpc("authorize_telegram_actor", {
      p_business_id: businessId,
      p_telegram_user_id: telegramUserId,
      p_telegram_chat_id: telegramChatId,
    }),
    "Authorize"
  );
  return Boolean(userId);
}

function describeOutcome(result) {
  switch (result.result) {
    case "APPROVED":
      return result.delivery === "EMAIL_QUEUED"
        ? { toast: "Approved.", status: `✅ APPROVED — queued for email delivery.\n${DEV_NOTE}` }
        : {
            toast: "Approved.",
            status:
              "✅ APPROVED — this lead has no email address, so nothing can be emailed. Please contact them yourself. The lead is marked as needing manual contact.",
          };
    case "REJECTED":
      return { toast: "Rejected.", status: "❌ REJECTED — nothing will be sent." };
    case "OPTED_OUT":
      return { toast: "Customer opted out.", status: "🚫 CANCELLED — this customer has opted out of contact." };
    case "EXPIRED":
      return { toast: "This approval has expired.", status: "⌛ EXPIRED — this approval is no longer valid." };
    case "STALE":
      return { toast: "This card is out of date.", status: "⚠️ OUT OF DATE — the reply changed after this card was sent." };
    case "ALREADY_DECIDED":
      return { toast: "This was already handled." };
    case "FORBIDDEN":
      return { toast: "Not authorized.", alert: true };
    default:
      return { toast: "This approval was not found." };
  }
}

async function decide(cb, decision, tokenHash) {
  const chatId = cb.message.chat.id;
  const result = unwrap(
    await supabase.rpc("decide_approval", {
      p_token_hash: tokenHash,
      p_decision: decision,
      p_telegram_user_id: cb.from.id,
      p_telegram_chat_id: chatId,
    }),
    "Decide approval"
  );

  const outcome = describeOutcome(result);
  await answerCallbackQuery(cb.id, outcome.toast, Boolean(outcome.alert));

  if (outcome.status) {
    try {
      await editMessageText(
        chatId,
        cb.message.message_id,
        `${cb.message.text ?? ""}\n\n${outcome.status}`,
        NO_BUTTONS
      );
    } catch (err) {
      console.error("Could not update the card:", err.message);
    }
  }
}

export async function handleCallback(cb) {
  const match = CALLBACK_PATTERN.exec(cb.data ?? "");
  const chatId = cb.message?.chat?.id;
  if (!match || !chatId || cb.message.chat.type !== "private") {
    await answerCallbackQuery(cb.id, "This button is not valid.");
    return;
  }

  const [, action, token] = match;
  const tokenHash = hashToken(token);

  // Approve / Reject: the database function does ALL the checking and
  // changes everything in one transaction.
  if (action === "ap") return decide(cb, "APPROVE", tokenHash);
  if (action === "rj") return decide(cb, "REJECT", tokenHash);

  // Edit / View do not use up the approval, but still require authorization.
  const approval = unwrap(
    await supabase
      .from("message_approvals")
      .select("id, business_id, status, message_id")
      .eq("token_hash", tokenHash)
      .maybeSingle(),
    "Load approval"
  );
  if (!approval || !(await isAuthorized(approval.business_id, cb.from.id, chatId))) {
    await answerCallbackQuery(cb.id, "Not authorized.", true);
    return;
  }
  if (approval.status !== "PENDING") {
    await answerCallbackQuery(cb.id, "This approval is no longer active.");
    return;
  }

  if (action === "ed") {
    await answerCallbackQuery(cb.id, "Type your new reply.");
    // force_reply makes Telegram open the reply box for this prompt automatically.
    await sendMessage(
      chatId,
      `✏️ Reply to this message with your new reply text. The edited version will need a new approval.\n\nRef: ${approval.id}`,
      { reply_markup: { force_reply: true, input_field_placeholder: "Type the new reply" } }
    );
    return;
  }

  // action === "vw"
  const message = unwrap(
    await supabase
      .from("messages")
      .select("lead_id")
      .eq("id", approval.message_id)
      .eq("business_id", approval.business_id)
      .single(),
    "Load message"
  );
  const { lead, analysis } = await loadLeadContext(message.lead_id);
  await answerCallbackQuery(cb.id);
  await sendMessage(
    chatId,
    [
      "LEAD DETAILS",
      "",
      `Name: ${lead.full_name}`,
      `Phone: ${lead.phone ?? "not provided"}`,
      `Email: ${lead.email ?? "not provided"}`,
      `Source: ${lead.source}`,
      `Score: ${analysis.lead_score}  Intent: ${analysis.intent}`,
      "",
      `"${clip(lead.original_message, 800)}"`,
    ].join("\n")
  );
}

// The owner replied to an approval card with new text.
export async function handleEditReply(message) {
  const chatId = message.chat.id;
  const repliedTo = message.reply_to_message;
  const newText = (message.text ?? "").trim();

  // Two ways to point at an approval: reply to the edit prompt (it carries "Ref: <id>"),
  // or reply directly to the card itself. "Ref:" is only trusted in the bot's own messages.
  const ref = repliedTo.from?.is_bot
    ? /Ref: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(repliedTo.text ?? "")
    : null;
  let lookup = supabase
    .from("message_approvals")
    .select("id, business_id, telegram_message_id")
    .eq("telegram_chat_id", chatId)
    .eq("status", "PENDING");
  lookup = ref ? lookup.eq("id", ref[1]) : lookup.eq("telegram_message_id", repliedTo.message_id);
  const approval = unwrap(await lookup.maybeSingle(), "Find card");
  if (!approval) {
    await sendMessage(chatId, "That card is not waiting for approval anymore.");
    return;
  }
  if (!newText || newText.length > MAX_EDIT_LENGTH) {
    await sendMessage(chatId, `Please send between 1 and ${MAX_EDIT_LENGTH} characters.`);
    return;
  }

  const token = newToken();
  const result = unwrap(
    await supabase.rpc("edit_reply", {
      p_approval_id: approval.id,
      p_new_content: newText,
      p_telegram_user_id: message.from.id,
      p_telegram_chat_id: chatId,
      p_new_token_hash: hashToken(token),
      p_expires_at: await expiryFor(approval.business_id),
    }),
    "Edit reply"
  );
  if (result.result !== "EDITED") {
    await sendMessage(chatId, `The edit could not be applied (${result.result}).`);
    return;
  }

  const { lead, analysis } = await loadLeadContext(result.lead_id);
  const sent = await sendMessage(chatId, cardText(lead, analysis, newText, result.version), {
    reply_markup: keyboard(token),
  });
  unwrap(
    await supabase
      .from("message_approvals")
      .update({ telegram_message_id: sent.message_id })
      .eq("id", result.new_approval_id),
    "Save card id"
  );

  try {
    await editMessageText(
      chatId,
      approval.telegram_message_id,
      "✏️ SUPERSEDED — this reply was edited. Use the newer card below.",
      NO_BUTTONS
    );
  } catch (err) {
    console.error("Could not update the old card:", err.message);
  }
}
