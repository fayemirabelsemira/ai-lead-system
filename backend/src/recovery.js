// Recovery sweeper: finds work that was interrupted (server crash, restart,
// deploy) and either resumes it safely or hands it to the owner.
// All I/O comes in through `deps`, so this file can be tested offline.
//
//   - jobs stuck in RUNNING      -> retried; if out of attempts the owner is told
//   - cards that never arrived   -> cancelled; the job worker sends a new card
//   - approvals nobody answered  -> expired; the owner gets the text
//   - emails stuck in SENDING    -> NEVER resent (they may have gone out);
//                                   the owner is asked to check Gmail "Sent"

export const STUCK_JOB_NOTICE =
  "Processing this inquiry was interrupted several times (the server stopped or restarted), so no reply was drafted.";
export const STUCK_EMAIL_REASON =
  "The server stopped while this email was being sent, so it may or may not have gone out.";

export function createRecovery(deps, { intervalMs = 60_000, staleMinutes = 10, log = console } = {}) {
  let timer = null;
  let running = false;
  let current = Promise.resolve();

  let warnedMissing = false;

  // One failing step never stops the others.
  async function step(name, fn) {
    try {
      return await fn();
    } catch (err) {
      if (/Could not find the function|does not exist/i.test(err.message)) {
        if (!warnedMissing) log.error("Recovery is OFF: run supabase/migrations/012_recovery.sql, then restart.");
        warnedMissing = true;
      } else {
        log.error(`Recovery (${name}) failed:`, err.message);
      }
      return 0;
    }
  }

  async function jobs() {
    const rows = await deps.recoverStuckJobs(staleMinutes);
    for (const r of rows) {
      log.log(`Recovered job ${r.job_id} (${r.job_type}): ${r.outcome}`);
      if (r.lead_needs_notice) await deps.sendManualNotice(r.lead_id, STUCK_JOB_NOTICE);
    }
    return rows.length;
  }

  async function cards() {
    const rows = await deps.resendUndeliveredCards(staleMinutes);
    for (const r of rows) log.log(`Card for lead ${r.lead_id} never reached Telegram: a new one is queued.`);
    return rows.length;
  }

  async function approvals() {
    const rows = await deps.expireApprovals();
    for (const r of rows) await deps.notifyApprovalExpired({ leadId: r.lead_id, content: r.content });
    return rows.length;
  }

  async function emails() {
    const rows = await deps.staleOutbox(staleMinutes);
    for (const r of rows) {
      const token = deps.newToken();
      const result = await deps.completeOutbox(r.outbox_id, {
        outcome: "NEEDS_CHECK",
        error: "Recovered: the server stopped while sending",
        newTokenHash: deps.hashToken(token),
      });
      // IGNORED = the email worker finished it in the meantime: nothing to do.
      if (result.result === "NEEDS_CHECK") {
        log.log(`Email ${r.outbox_id} was interrupted: the owner is asked to check.`);
        await deps.notifyEmailProblem({ ...result, recipient: r.recipient, token, reason: STUCK_EMAIL_REASON });
      }
    }
    return rows.length;
  }

  async function tick() {
    return {
      jobs: await step("jobs", jobs),
      cards: await step("cards", cards),
      approvals: await step("approvals", approvals),
      emails: await step("emails", emails),
    };
  }

  function schedule(delay) {
    if (!running) return;
    timer = setTimeout(() => {
      current = tick().finally(() => schedule(intervalMs));
    }, delay);
  }

  return {
    tick,
    start() {
      running = true;
      log.log("Recovery sweeper started.");
      schedule(5_000); // first sweep shortly after start: catches what a crash left behind
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      await current;
    },
  };
}
