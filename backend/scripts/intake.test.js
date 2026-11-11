// Offline tests for intake: validation, rate limiting, the HTTP server and
// the job worker. No internet, no API key, no database.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, normalizeEmail, validateSubmission } from "../src/intake/validate.js";
import { createRateLimiter } from "../src/intake/rateLimit.js";
import { createServer } from "../src/server.js";
import { createWorker } from "../src/worker.js";

const FORM_ID = "A".repeat(32);
const quiet = { log() {}, error() {} };

const valid = () => ({
  submission_id: "3f2a1c9e-0000-4000-8000-000000000001",
  full_name: "  Maria   Santos ",
  email: "Maria@Example.com ",
  phone: "0917 123 4567",
  message: "Hi po, magkano yung house?",
  consent: true,
  website: "",
});

// ---------- validation ----------

test("Philippine mobile numbers are normalized to +63", () => {
  assert.equal(normalizePhone("09171234567"), "+639171234567");
  assert.equal(normalizePhone("0917 123 4567"), "+639171234567");
  assert.equal(normalizePhone("0917-123-4567"), "+639171234567");
  assert.equal(normalizePhone("+63 917 123 4567"), "+639171234567");
  assert.equal(normalizePhone("639171234567"), "+639171234567");
  assert.equal(normalizePhone("9171234567"), "+639171234567");
  assert.equal(normalizePhone("+14155550123"), "+14155550123");
});

test("bad phone numbers and emails are rejected", () => {
  for (const p of ["123", "0917123456", "hello", "+0123456789", ""]) assert.equal(normalizePhone(p), null, p);
  for (const e of ["no-at-sign", "a@b", "a b@c.com", "", "x".repeat(320) + "@a.com"]) assert.equal(normalizeEmail(e), null, e);
  assert.equal(normalizeEmail(" Maria@Example.COM "), "maria@example.com");
});

test("a valid submission is cleaned", () => {
  const out = validateSubmission(valid());
  assert.equal(out.ok, true);
  assert.equal(out.isSpam, false);
  assert.equal(out.value.fullName, "Maria Santos");
  assert.equal(out.value.emailNormalized, "maria@example.com");
  assert.equal(out.value.phoneNormalized, "+639171234567");
  assert.equal(out.value.externalId, valid().submission_id);
});

test("email-only and phone-only submissions are accepted", () => {
  assert.equal(validateSubmission({ ...valid(), phone: "" }).ok, true);
  assert.equal(validateSubmission({ ...valid(), email: "" }).ok, true);
});

test("missing fields give one error per field", () => {
  const out = validateSubmission({ ...valid(), full_name: " ", message: "", email: "", phone: "", consent: false });
  assert.equal(out.ok, false);
  assert.deepEqual(Object.keys(out.errors).sort(), ["consent", "contact", "full_name", "message"]);
});

test("consent must be exactly true", () => {
  for (const consent of ["true", 1, "yes", undefined]) {
    assert.equal(validateSubmission({ ...valid(), consent }).ok, false, String(consent));
  }
});

test("wrong types and oversize fields are rejected, not crashed on", () => {
  assert.equal(validateSubmission(null).ok, false);
  assert.equal(validateSubmission([]).ok, false);
  assert.equal(validateSubmission({ ...valid(), full_name: { x: 1 } }).ok, false);
  assert.equal(validateSubmission({ ...valid(), message: "x".repeat(5001) }).ok, false);
  assert.equal(validateSubmission({ ...valid(), submission_id: "bad id!" }).ok, false);
});

test("control characters are stripped, newlines kept", () => {
  const out = validateSubmission({ ...valid(), message: "line1\r\nline2\u0000\u0007" });
  assert.equal(out.value.message, "line1\nline2");
});

test("the hidden honeypot field marks a submission as spam", () => {
  assert.equal(validateSubmission({ ...valid(), website: "http://spam" }).isSpam, true);
});

// ---------- rate limiter ----------

test("the rate limiter allows the limit, then blocks until the window resets", () => {
  let t = 0;
  const allow = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(allow("ip"), true);
  assert.equal(allow("ip"), true);
  assert.equal(allow("ip"), false);
  assert.equal(allow("other"), true);
  t = 1000;
  assert.equal(allow("ip"), true);
});

test("the rate limiter keeps memory bounded", () => {
  const allow = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
  for (const k of ["a", "b", "c", "d"]) allow(k);
  assert.equal(allow("a"), true); // "a" was evicted, so it starts fresh
});

// ---------- HTTP server ----------

async function startTestServer(t, options = {}) {
  const calls = [];
  const server = createServer({
    submit: async (formId, value) => {
      calls.push({ formId, value });
      return options.result ?? "CREATED";
    },
    log: quiet,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}, path = `/intake/${FORM_ID}`) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { base, post, calls };
}

test("a valid submission is accepted with 202 and saved once", async (t) => {
  const { post, calls } = await startTestServer(t);
  const res = await post(valid());
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].formId, FORM_ID);
  assert.equal(calls[0].value.phoneNormalized, "+639171234567");
});

test("invalid input returns 400 with field errors and saves nothing", async (t) => {
  const { post, calls } = await startTestServer(t);
  const res = await post({ ...valid(), consent: false });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).errors.consent);
  assert.equal(calls.length, 0);
});

test("broken JSON, wrong content type and oversized bodies are refused", async (t) => {
  const { post, calls } = await startTestServer(t, { perMinute: 100, perHour: 100 });
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post(valid(), { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post({ ...valid(), message: "x".repeat(20_000) })).status, 413);
  assert.equal(calls.length, 0);
});

test("spam is answered like success but never saved", async (t) => {
  const { post, calls } = await startTestServer(t);
  const res = await post({ ...valid(), website: "http://spam.example" });
  assert.equal(res.status, 202);
  assert.equal(calls.length, 0);
});

test("an unknown or malformed form id returns 404", async (t) => {
  const { post } = await startTestServer(t, { result: "NOT_FOUND" });
  assert.equal((await post(valid())).status, 404);
  assert.equal((await post(valid(), {}, "/intake/short")).status, 404);
});

test("a repeated submission is still answered with 202", async (t) => {
  const { post } = await startTestServer(t, { result: "DUPLICATE_SUBMISSION" });
  assert.equal((await post(valid())).status, 202);
});

test("too many submissions from one address get 429", async (t) => {
  const { post } = await startTestServer(t, { perMinute: 2 });
  assert.equal((await post(valid())).status, 202);
  assert.equal((await post(valid())).status, 202);
  const res = await post(valid());
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("retry-after"));
});

test("a database failure returns a generic 500 without details", async (t) => {
  const server = createServer({ submit: async () => { throw new Error("secret db detail"); }, log: quiet });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/intake/${FORM_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(valid()),
  });
  assert.equal(res.status, 500);
  assert.ok(!(await res.text()).includes("secret"));
});

test("CORS headers are sent only to allowed origins", async (t) => {
  const { base } = await startTestServer(t, { allowedOrigins: ["https://forms.example.com"] });
  const preflight = (origin) =>
    fetch(`${base}/intake/${FORM_ID}`, { method: "OPTIONS", headers: { Origin: origin } });
  const ok = await preflight("https://forms.example.com");
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://forms.example.com");
  const bad = await preflight("https://evil.example");
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

test("health check, unknown paths, and the test form switch", async (t) => {
  const { base } = await startTestServer(t);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/test-form`)).status, 404); // off unless enabled
  const withForm = await startTestServer(t, { testFormHtml: "<p>form</p>" });
  const page = await fetch(`${withForm.base}/test-form`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
});

test("X-Forwarded-For is ignored unless trustProxy is on", async (t) => {
  const { post } = await startTestServer(t, { perMinute: 1 });
  assert.equal((await post(valid(), { "X-Forwarded-For": "1.1.1.1" })).status, 202);
  // Spoofing a different address does not get around the limit.
  assert.equal((await post(valid(), { "X-Forwarded-For": "2.2.2.2" })).status, 429);
});

// ---------- worker ----------

const completed = {
  status: "COMPLETED",
  analysis: { needs_human_review: false, suggested_reply: "Hello!" },
  usage: { total_tokens: 10 },
};

function fakeDeps(overrides = {}) {
  const log = [];
  const deps = {
    jobs: [],
    claimJobs: async () => deps.jobs.splice(0),
    finishJob: async (id, result) => log.push(["finish", id, result.status]),
    loadLead: async () => ({ id: "lead", original_message: "magkano po?", conversation_status: "NEW" }),
    loadBusiness: async () => ({ business_name: "Biz", settings: { ai_daily_request_limit: 5, max_inquiry_length: 2000 } }),
    hasCompletedAnalysis: async () => false,
    aiRequestsLast24h: async () => 0,
    analyze: async () => { log.push(["analyze"]); return completed; },
    saveAnalysis: async (b, l, i, r) => log.push(["save", r.status]),
    markLeadNeedsReview: async () => log.push(["needs-review"]),
    sendLeadCard: async () => log.push(["card"]),
    sendManualNotice: async (id, reason) => log.push(["manual", reason]),
    ...overrides,
  };
  return { deps, log };
}

const job = (attempts = 1, max = 3) => ({
  id: "job1",
  job_type: "ANALYZE_LEAD",
  business_id: "biz",
  attempts,
  max_attempts: max,
  payload: { lead_id: "lead", interaction_id: "int" },
});

const runOnce = async (deps, j) => {
  deps.jobs.push(j);
  await createWorker(deps, { log: quiet }).tick();
};

test("worker: analyze, save, send card, then mark the job done", async () => {
  const { deps, log } = fakeDeps();
  await runOnce(deps, job());
  assert.deepEqual(log, [["analyze"], ["save", "COMPLETED"], ["card"], ["finish", "job1", "SUCCEEDED"]]);
});

test("worker: an AI failure is saved and retried later", async () => {
  const { deps, log } = fakeDeps({ analyze: async () => ({ status: "FAILED", errorMessage: "down" }) });
  await runOnce(deps, job(1));
  assert.deepEqual(log, [["save", "FAILED"], ["finish", "job1", "PENDING"]]);
});

test("worker: on the last attempt the owner is told to handle it by hand", async () => {
  const { deps, log } = fakeDeps({ analyze: async () => ({ status: "FAILED", errorMessage: "down" }) });
  await runOnce(deps, job(3, 3));
  assert.equal(log[1][0], "manual");
  assert.deepEqual(log.at(-1), ["finish", "job1", "SUCCEEDED"]);
});

test("worker: a retry after a saved analysis does not call the AI again", async () => {
  const { deps, log } = fakeDeps({ hasCompletedAnalysis: async () => true });
  await runOnce(deps, job(2));
  assert.deepEqual(log, [["card"], ["finish", "job1", "SUCCEEDED"]]);
});

test("worker: a lead that already has a card is skipped", async () => {
  const { deps, log } = fakeDeps({ loadLead: async () => ({ id: "lead", conversation_status: "WAITING_FOR_APPROVAL" }) });
  await runOnce(deps, job());
  assert.deepEqual(log, [["finish", "job1", "SUCCEEDED"]]);
});

test("worker: a deleted lead finishes quietly", async () => {
  const { deps, log } = fakeDeps({ loadLead: async () => null });
  await runOnce(deps, job());
  assert.deepEqual(log, [["finish", "job1", "SUCCEEDED"]]);
});

test("worker: the daily AI limit skips the AI and tells the owner", async () => {
  const { deps, log } = fakeDeps({ aiRequestsLast24h: async () => 5 });
  await runOnce(deps, job());
  assert.deepEqual(log.map((x) => x[0]), ["needs-review", "manual", "finish"]);
});

test("worker: a Telegram failure retries the job; the last failure marks it DEAD", async () => {
  const failing = { sendLeadCard: async () => { throw new Error("Telegram down"); } };
  const first = fakeDeps(failing);
  await runOnce(first.deps, job(1));
  assert.deepEqual(first.log.at(-1), ["finish", "job1", "PENDING"]);
  const last = fakeDeps({ ...failing, hasCompletedAnalysis: async () => true });
  await runOnce(last.deps, job(3, 3));
  assert.deepEqual(last.log.at(-1), ["finish", "job1", "DEAD"]);
});

test("worker: 'already has a reply' counts as done", async () => {
  const { deps, log } = fakeDeps({
    sendLeadCard: async () => { throw new Error("Create draft: This lead already has a reply waiting"); },
  });
  await runOnce(deps, job());
  assert.deepEqual(log.at(-1), ["finish", "job1", "SUCCEEDED"]);
});

test("worker: an unknown job type is not run and is retried", async () => {
  const { deps, log } = fakeDeps();
  await runOnce(deps, { ...job(), job_type: "SOMETHING_ELSE" });
  assert.deepEqual(log, [["finish", "job1", "PENDING"]]);
});
