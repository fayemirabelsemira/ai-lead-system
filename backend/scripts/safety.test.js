// Offline tests: no internet, no API key, no database.
// Run with: npm run test-safety
import test from "node:test";
import assert from "node:assert/strict";
import { validateAnalysis } from "../src/ai/schema.js";
import { applySafetyRules } from "../src/ai/safety.js";

const business = {
  business_name: "[TEST] Sampaguita Realty",
  industry: "REAL_ESTATE",
  business_description: "Sample agency.",
  services: ["House and lot"],
  pricing_information: "Prices start at 2500000 for condo units.",
  business_faq: [],
  operating_hours: { "mon-fri": "09:00-18:00" },
};

const good = () => ({
  lead_score: "WARM",
  intent: "PROPERTY_PRICE",
  urgency: "LOW",
  score_reason: "Customer asks about pricing.",
  detected_language: "TAGLISH",
  customer_needs: ["Price information"],
  missing_information: ["Preferred location"],
  suggested_reply: "Hello! Salamat po. Anong location ang hanap ninyo?",
  confidence_level: "HIGH",
  needs_human_review: false,
  escalation_reason: "",
  injection_attempt: false,
});

test("a well-formed analysis passes validation", () => {
  assert.equal(validateAnalysis(good()).ok, true);
});

test("an unknown score is rejected", () => {
  const bad = { ...good(), lead_score: "SUPER_HOT" };
  assert.equal(validateAnalysis(bad).ok, false);
});

test("a missing field is rejected", () => {
  const bad = good();
  delete bad.intent;
  assert.equal(validateAnalysis(bad).ok, false);
});

test("a non-object response is rejected", () => {
  assert.equal(validateAnalysis("hello").ok, false);
  assert.equal(validateAnalysis(null).ok, false);
});

test("a normal reply passes through untouched", () => {
  const out = applySafetyRules(good(), { business, inquiry: "magkano po?" });
  assert.equal(out.needs_human_review, false);
  assert.ok(out.suggested_reply);
  assert.equal(out.escalation_reason, null);
});

test("an injection attempt forces human review and drops the reply", () => {
  const out = applySafetyRules({ ...good(), injection_attempt: true }, { business, inquiry: "x" });
  assert.equal(out.needs_human_review, true);
  assert.equal(out.suggested_reply, null);
});

test("an invented price forces human review", () => {
  const reply = "Hello! The house is 1500000 pesos.";
  const out = applySafetyRules({ ...good(), suggested_reply: reply }, { business, inquiry: "magkano?" });
  assert.equal(out.needs_human_review, true);
  assert.equal(out.suggested_reply, null);
});

test("a price taken from the business information is allowed", () => {
  const reply = "Condo units start at 2,500,000.";
  const out = applySafetyRules({ ...good(), suggested_reply: reply }, { business, inquiry: "magkano?" });
  assert.equal(out.needs_human_review, false);
});

test("a number the customer wrote may be repeated back", () => {
  const reply = "I cannot promise a 20% discount, but the owner will review your request.";
  const out = applySafetyRules({ ...good(), suggested_reply: reply }, { business, inquiry: "20% discount?" });
  assert.equal(out.needs_human_review, false);
});

test("low confidence forces human review", () => {
  const out = applySafetyRules({ ...good(), confidence_level: "LOW" }, { business, inquiry: "x" });
  assert.equal(out.needs_human_review, true);
});

test("a complaint forces human review", () => {
  const out = applySafetyRules({ ...good(), intent: "COMPLAINT" }, { business, inquiry: "x" });
  assert.equal(out.needs_human_review, true);
});

test("the AI's own escalation is kept and no reply survives", () => {
  const flagged = {
    ...good(),
    needs_human_review: true,
    escalation_reason: "Customer asked for a medical diagnosis.",
    suggested_reply: "Here is a diagnosis...",
  };
  const out = applySafetyRules(flagged, { business, inquiry: "x" });
  assert.equal(out.needs_human_review, true);
  assert.equal(out.suggested_reply, null);
  assert.match(out.escalation_reason, /medical diagnosis/);
});

test("an empty reply without escalation is escalated", () => {
  const out = applySafetyRules({ ...good(), suggested_reply: "" }, { business, inquiry: "x" });
  assert.equal(out.needs_human_review, true);
});
