// Offline tests for automatic email: composing, error handling, and the
// email worker. No internet, no Gmail, no database.
import test from "node:test";
import assert from "node:assert/strict";
import { composeReplyEmail, classifySendError } from "../src/email/compose.js";
import { createOutboxWorker } from "../src/outbox.js";

const quiet = { log() {}, error() {} };

test("the email is plain text from the business, with a signature", () => {
  const m = composeReplyEmail({
    businessName: "Sampaguita Realty",
    fromAddress: "owner@gmail.com",
    toEmail: "rosa@example.com",
    reply: "  Hi po! Salamat.  ",
  });
  assert.deepEqual(m.from, { name: "Sampaguita Realty", address: "owner@gmail.com" });
  assert.equal(m.to, "rosa@example.com");
  assert.equal(m.subject, "Re: your inquiry to Sampaguita Realty");
  assert.equal(m.text, "Hi po! Salamat.\n\n— Sampaguita Realty");
  assert.equal(m.html, undefined);
});

test("a business name cannot inject email headers", () => {
  const m = composeReplyEmail({
    businessName: "Evil\r\nBcc: victim@example.com",
    fromAddress: "o@gmail.com",
    toEmail: "a@b.co",
    reply: "x",
  });
  assert.ok(!/[\r\n]/.test(m.subject));
  assert.ok(!/[\r\n]/.test(m.from.name));
});

test("only errors that certainly did not send are retried", () => {
  assert.equal(classifySendError({ code: "ECONNECTION" }), "RETRY");
  assert.equal(classifySendError({ code: "EAUTH", responseCode: 535 }), "RETRY");
  assert.equal(classifySendError({ responseCode: 421 }), "RETRY");
  assert.equal(classifySendError({ responseCode: 550 }), "FAILED");
  assert.equal(classifySendError({ code: "EENVELOPE" }), "FAILED");
  // Interrupted mid-send: it may have gone out, so a person must check.
  assert.equal(classifySendError({ code: "ETIMEDOUT" }), "NEEDS_CHECK");
  assert.equal(classifySendError({ code: "ESOCKET" }), "NEEDS_CHECK");
  assert.equal(classifySendError(new Error("weird")), "NEEDS_CHECK");
});

// ---------- email worker ----------

const item = (attempts = 1) => ({
  outbox_id: "o1",
  business_id: "b",
  lead_id: "lead",
  recipient: "rosa@example.com",
  content: "Hi po!",
  business_name: "Biz",
  attempts,
  max_attempts: 3,
});

function fakeDeps({ sendError = null, dbResult } = {}) {
  const log = [];
  const deps = {
    queue: [],
    claimOutbox: async () => deps.queue.splice(0),
    sender: {
      fromAddress: "owner@gmail.com",
      sendEmail: async (m) => {
        log.push(["send", m.to]);
        if (sendError) throw sendError;
        return "<gmail-id>";
      },
    },
    newToken: () => "a".repeat(32),
    hashToken: () => "h".repeat(64),
    completeOutbox: async (id, args) => {
      log.push(["complete", args.outcome]);
      return dbResult ?? { result: args.outcome, lead_id: "lead", content: "Hi po!" };
    },
    notifyEmailSent: async () => log.push(["notify-sent"]),
    notifyEmailProblem: async (p) => log.push(["notify-problem", p.result, p.token]),
  };
  return { deps, log };
}

const runOnce = async (deps, it) => {
  deps.queue.push(it);
  await createOutboxWorker(deps, { log: quiet }).tick();
};

test("email worker: send, record SENT, tell the owner", async () => {
  const { deps, log } = fakeDeps();
  await runOnce(deps, item());
  assert.deepEqual(log, [["send", "rosa@example.com"], ["complete", "SENT"], ["notify-sent"]]);
});

test("email worker: a connection error is retried quietly", async () => {
  const { deps, log } = fakeDeps({ sendError: { code: "ECONNECTION", message: "down" } });
  await runOnce(deps, item());
  assert.deepEqual(log, [["send", "rosa@example.com"], ["complete", "RETRY"]]);
});

test("email worker: when retries run out, the owner gets the reply to send by hand", async () => {
  const { deps, log } = fakeDeps({
    sendError: { code: "ECONNECTION", message: "down" },
    dbResult: { result: "FAILED", lead_id: "lead", content: "Hi po!" },
  });
  await runOnce(deps, item(3));
  assert.deepEqual(log.at(-1), ["notify-problem", "FAILED", "a".repeat(32)]);
});

test("email worker: an unclear failure asks the owner to check, never resends", async () => {
  const { deps, log } = fakeDeps({ sendError: { code: "ETIMEDOUT", message: "timeout" } });
  await runOnce(deps, item());
  assert.deepEqual(log, [["send", "rosa@example.com"], ["complete", "NEEDS_CHECK"], ["notify-problem", "NEEDS_CHECK", "a".repeat(32)]]);
});

test("email worker: a Gmail login failure is explained plainly to the owner", async () => {
  const { deps } = fakeDeps({
    sendError: { code: "EAUTH", responseCode: 535, message: "Invalid login: 535-5.7.8 https://support.google.com/..." },
    dbResult: { result: "FAILED", lead_id: "lead", content: "Hi po!" },
  });
  let reason;
  deps.notifyEmailProblem = async (p) => { reason = p.reason; };
  await runOnce(deps, item(3));
  assert.match(reason, /Gmail rejected the login/);
  assert.ok(!reason.includes("http"));
});

test("email worker: a bad address fails immediately", async () => {
  const { deps, log } = fakeDeps({ sendError: { responseCode: 550, message: "no such user" } });
  await runOnce(deps, item());
  assert.deepEqual(log.slice(1), [["complete", "FAILED"], ["notify-problem", "FAILED", "a".repeat(32)]]);
});

test("email worker: a database error after sending does not resend", async () => {
  const { deps, log } = fakeDeps();
  deps.completeOutbox = async () => { throw new Error("db down"); };
  await runOnce(deps, item());
  const sends = log.filter((x) => x[0] === "send").length;
  assert.equal(sends, 1);
});
