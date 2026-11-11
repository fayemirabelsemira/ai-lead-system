// Offline tests for the recovery sweeper. No database, no Telegram.
import test from "node:test";
import assert from "node:assert/strict";
import { createRecovery, STUCK_JOB_NOTICE, STUCK_EMAIL_REASON } from "../src/recovery.js";

const quiet = { log() {}, error() {} };

function fakeDeps(over = {}) {
  const log = [];
  const deps = {
    recoverStuckJobs: async () => [],
    resendUndeliveredCards: async () => [],
    expireApprovals: async () => [],
    staleOutbox: async () => [],
    completeOutbox: async (id, args) => {
      log.push(["complete", id, args.outcome]);
      return { result: "NEEDS_CHECK", lead_id: "lead-e", content: "Hi po!" };
    },
    newToken: () => "t".repeat(32),
    hashToken: () => "h".repeat(64),
    sendManualNotice: async (leadId, reason) => log.push(["manual", leadId, reason]),
    notifyApprovalExpired: async (p) => log.push(["expired", p.leadId, p.content]),
    notifyEmailProblem: async (p) => log.push(["email", p.result, p.recipient, p.token, p.reason]),
    ...over,
  };
  return { deps, log };
}

const run = (deps) => createRecovery(deps, { log: quiet }).tick();

test("nothing stuck: nothing happens", async () => {
  const { deps, log } = fakeDeps();
  assert.deepEqual(await run(deps), { jobs: 0, cards: 0, approvals: 0, emails: 0 });
  assert.deepEqual(log, []);
});

test("a dead analysis job tells the owner; a retried one stays quiet", async () => {
  const { deps, log } = fakeDeps({
    recoverStuckJobs: async () => [
      { job_id: "j1", lead_id: "l1", job_type: "ANALYZE_LEAD", outcome: "RETRY", lead_needs_notice: false },
      { job_id: "j2", lead_id: "l2", job_type: "ANALYZE_LEAD", outcome: "DEAD", lead_needs_notice: true },
    ],
  });
  assert.equal((await run(deps)).jobs, 2);
  assert.deepEqual(log, [["manual", "l2", STUCK_JOB_NOTICE]]);
});

test("undelivered cards are only re-queued (the job worker sends the new card)", async () => {
  const { deps, log } = fakeDeps({ resendUndeliveredCards: async () => [{ lead_id: "l3" }] });
  assert.equal((await run(deps)).cards, 1);
  assert.deepEqual(log, []);
});

test("an expired approval gives the owner the unsent text", async () => {
  const { deps, log } = fakeDeps({ expireApprovals: async () => [{ lead_id: "l4", content: "Hello" }] });
  await run(deps);
  assert.deepEqual(log, [["expired", "l4", "Hello"]]);
});

test("an interrupted email is marked NEEDS_CHECK with a fresh 'I sent it' token, never resent", async () => {
  const { deps, log } = fakeDeps({ staleOutbox: async () => [{ outbox_id: "o1", recipient: "rosa@example.com" }] });
  await run(deps);
  assert.deepEqual(log, [
    ["complete", "o1", "NEEDS_CHECK"],
    ["email", "NEEDS_CHECK", "rosa@example.com", "t".repeat(32), STUCK_EMAIL_REASON],
  ]);
});

test("an email the worker finished in the meantime is left alone", async () => {
  const { deps, log } = fakeDeps({
    staleOutbox: async () => [{ outbox_id: "o2", recipient: "x@example.com" }],
    completeOutbox: async () => ({ result: "IGNORED" }),
  });
  await run(deps);
  assert.deepEqual(log, []);
});

test("one failing step does not stop the others", async () => {
  const { deps, log } = fakeDeps({
    recoverStuckJobs: async () => { throw new Error("db down"); },
    expireApprovals: async () => [{ lead_id: "l5", content: "Hi" }],
  });
  const result = await run(deps);
  assert.equal(result.jobs, 0);
  assert.deepEqual(log, [["expired", "l5", "Hi"]]);
});

test("before migration 012 is run, one clear message instead of an error every minute", async () => {
  const errors = [];
  const missing = async () => { throw new Error("Recover jobs: Could not find the function public.recover_stuck_jobs"); };
  const { deps } = fakeDeps({ recoverStuckJobs: missing, resendUndeliveredCards: missing, expireApprovals: missing, staleOutbox: missing });
  const r = createRecovery(deps, { log: { log() {}, error: (m) => errors.push(m) } });
  await r.tick();
  await r.tick();
  assert.deepEqual(errors, ["Recovery is OFF: run supabase/migrations/012_recovery.sql, then restart."]);
});
