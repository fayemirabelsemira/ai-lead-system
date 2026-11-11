// Email worker: sends approved replies that are queued in message_outbox.
// All I/O comes in through `deps`, so this file can be tested offline.
//
// Safety rule: an email is only retried when it certainly did NOT go out.
// When that is unclear, the owner is asked to check their Gmail "Sent"
// folder and, if needed, send it by hand (copy-and-send).
import { composeReplyEmail, classifySendError } from "./email/compose.js";

const BASE_RETRY_SECONDS = 60;

export function createOutboxWorker(deps, { intervalMs = 5000, batchSize = 5, log = console } = {}) {
  let timer = null;
  let running = false;
  let current = Promise.resolve();

  async function sendOne(item) {
    const message = composeReplyEmail({
      businessName: item.business_name,
      fromAddress: deps.sender.fromAddress,
      toEmail: item.recipient,
      reply: item.content,
    });

    let providerMessageId;
    try {
      providerMessageId = await deps.sender.sendEmail(message);
    } catch (err) {
      const outcome = classifySendError(err);
      const reason = String(err?.message ?? err).slice(0, 500);
      log.error(`Email ${item.outbox_id} failed (${outcome}) on attempt ${item.attempts}:`, reason);
      // The owner sees a plain explanation; the full error is kept in the database.
      const ownerReason =
        err?.code === "EAUTH"
          ? "Gmail rejected the login. Fix GMAIL_USER / GMAIL_APP_PASSWORD in .env, then restart"
          : reason;
      // RETRY on the last attempt becomes FAILED in the database, so always
      // prepare a fallback token; it is only used if the database gives up.
      const token = deps.newToken();
      const result = await deps.completeOutbox(item.outbox_id, {
        outcome,
        error: reason,
        retrySeconds: BASE_RETRY_SECONDS * 2 ** (item.attempts - 1),
        newTokenHash: deps.hashToken(token),
      });
      if (result.result === "FAILED" || result.result === "NEEDS_CHECK") {
        await deps.notifyEmailProblem({ ...result, recipient: item.recipient, token, reason: ownerReason });
      }
      return;
    }

    const result = await deps.completeOutbox(item.outbox_id, {
      outcome: "SENT",
      provider: "GMAIL",
      providerMessageId,
    });
    if (result.result === "SENT") {
      await deps.notifyEmailSent({ leadId: result.lead_id, recipient: item.recipient }).catch((err) =>
        log.error("Could not send the 'email sent' notice:", err.message)
      );
    }
  }

  async function tick() {
    const items = await deps.claimOutbox(batchSize);
    for (const item of items) {
      try {
        await sendOne(item);
      } catch (err) {
        // A database or Telegram error after sending: never resend blindly.
        // The row stays in SENDING and is visible for a manual check.
        log.error(`Email ${item.outbox_id}: could not record the result:`, err.message);
      }
    }
    return items.length;
  }

  function schedule() {
    if (!running) return;
    timer = setTimeout(() => {
      current = tick()
        .catch((err) => log.error("Email worker error:", err.message))
        .finally(schedule);
    }, intervalMs);
  }

  return {
    tick,
    start() {
      running = true;
      log.log("Email worker started (sending from Gmail).");
      schedule();
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      await current;
    },
  };
}
