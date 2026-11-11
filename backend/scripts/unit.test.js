// Offline tests: no internet, no API key, no database.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { clip, TELEGRAM_MAX_TEXT } from "../src/text.js";
import { analyzeInquiry } from "../src/ai/analyze.js";

const business = {
  business_name: "[TEST] Sampaguita Realty",
  industry: "REAL_ESTATE",
  services: ["House and lot"],
  pricing_information: "Prices vary per property.",
};

const goodAnalysis = {
  lead_score: "WARM",
  intent: "PROPERTY_PRICE",
  urgency: "LOW",
  score_reason: "Customer asks about pricing.",
  detected_language: "TAGLISH",
  customer_needs: ["Price information"],
  missing_information: [],
  suggested_reply: "Salamat po! Anong location ang hanap ninyo?",
  confidence_level: "HIGH",
  needs_human_review: false,
  escalation_reason: "",
  injection_attempt: false,
};

// Replaces fetch with a fake Groq that returns the given contents in order.
function fakeGroq(t, contents) {
  const calls = [];
  const original = globalThis.fetch;
  process.env.GROQ_API_KEY = "test-key";
  process.env.GROQ_MODEL = "test-model";
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const content = contents[Math.min(calls.length - 1, contents.length - 1)];
    return new Response(
      JSON.stringify({ model: "test-model", choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test("clip leaves short text alone and caps long text at the limit", () => {
  assert.equal(clip("hello", 10), "hello");
  const long = clip("x".repeat(5000), TELEGRAM_MAX_TEXT);
  assert.equal(long.length, TELEGRAM_MAX_TEXT);
  assert.ok(long.endsWith("…"));
});

test("clip tolerates null and undefined", () => {
  assert.equal(clip(null, 5), "");
  assert.equal(clip(undefined, 5), "");
});

test("an empty inquiry fails without calling the AI", async (t) => {
  const calls = fakeGroq(t, [JSON.stringify(goodAnalysis)]);
  for (const inquiry of ["", "   ", null, undefined, 42]) {
    const out = await analyzeInquiry({ business, inquiry });
    assert.equal(out.status, "FAILED");
  }
  assert.equal(calls.length, 0);
});

test("missing business information fails without calling the AI", async (t) => {
  const calls = fakeGroq(t, [JSON.stringify(goodAnalysis)]);
  const out = await analyzeInquiry({ business: null, inquiry: "magkano po?" });
  assert.equal(out.status, "FAILED");
  assert.equal(calls.length, 0);
});

test("a valid AI answer is returned as COMPLETED", async (t) => {
  fakeGroq(t, [JSON.stringify(goodAnalysis)]);
  const out = await analyzeInquiry({ business, inquiry: "magkano po?" });
  assert.equal(out.status, "COMPLETED");
  assert.equal(out.analysis.needs_human_review, false);
});

test("non-JSON AI output is retried once, then reported as FAILED (never thrown)", async (t) => {
  const calls = fakeGroq(t, ["not json", "still not json"]);
  const out = await analyzeInquiry({ business, inquiry: "magkano po?" });
  assert.equal(out.status, "FAILED");
  assert.equal(calls.length, 2);
});

test("the inquiry is trimmed to maxLength before it reaches the AI", async (t) => {
  const calls = fakeGroq(t, [JSON.stringify(goodAnalysis)]);
  await analyzeInquiry({ business, inquiry: "a".repeat(5000), maxLength: 100 });
  const userMessage = calls[0].messages.find((m) => m.role === "user").content;
  assert.ok(!userMessage.includes("a".repeat(101)));
});
