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

// ---------- claims the business never made ----------
import { findUnsupportedClaims, statedFacts } from "../src/ai/safety.js";

const realty = {
  business_name: "[TEST] Sampaguita Realty",
  industry: "REAL_ESTATE",
  business_description: "Sample real estate agency used only for testing.",
  services: ["House and lot", "Condominium units"],
  pricing_information: "Prices vary per property. Sample data only.",
  business_faq: [{ q: "Do you offer installment payment?", a: "Please confirm payment terms with the agent." }],
  operating_hours: { "mon-fri": "09:00-18:00", sat: "09:00-13:00" },
};
const facts = statedFacts(realty);

// Replies the AI really drafted on 2026-11-11 (all invented availability).
const INVENTED = [
  "Hi! Salamat sa pag-tanong. Sa ngayon po, may ilang bahay na available kami. Maaari po ba ninyong ibahagi kung anong lokasyon o klase ng bahay ang hinahanap ninyo?",
  "Hi! Salamat sa pag-tanong. May ilang bahay at condo units po kami na available. Maaari po ba ninyong ibahagi kung anong klase o lokasyon ang hinahanap ninyo?",
  "Hi po! Sa ngayon po ay may ilang house and lot at condominium units kaming available. Maaari po ba naming malaman kung anong uri ng property ang interesado kayo?",
  // Phrases seen in earlier test runs
  "Opo, may bakante kaming slot bukas ng umaga.",
  "Yes, we have an opening tomorrow at 10am.",
  "Hello! The unit is still available and we can schedule a viewing.",
  // A "confirm" later in the sentence must not excuse the claim
  "May available units po kami, i-confirm lang po natin ang schedule.",
  "We have units available, but please confirm your budget first.",
];

for (const reply of INVENTED) {
  test(`invented availability is caught: "${reply.slice(0, 45)}..."`, () => {
    assert.ok(findUnsupportedClaims(reply, facts).length > 0);
  });
}

const INVENTED_OFFERS = [
  // Real drafts from 2026-11-11 for "May installment po ba?"
  "Mayroon po kaming installment options, pero pakipag-ugnayan po sa aming agent para makumpirma ang mga detalye.",
  "Oo, may installment options po kami. Pakipag-ugnayan po sa aming agent para makumpirma ang mga detalye.",
  "Opo, may installment po kami para sa mga units.",
  "Yes, we offer installment plans for all properties.",
  "Oo naman po, may discount kami ngayong buwan.",
  "We have a free site visit this weekend.",
];
for (const reply of INVENTED_OFFERS) {
  test(`invented offer is caught: "${reply.slice(0, 45)}..."`, () => {
    assert.ok(findUnsupportedClaims(reply, facts).length > 0);
  });
}

// Good replies the AI drafted: careful wording must NOT be flagged.
const SAFE = [
  "Hi po, salamat sa interes ninyo. Sa kasalukuyan, hihingi muna kami ng kaunting detalye para ma-verify ang availability ng condo unit. Maaari po ba naming malaman kung anong unit type o budget ang inyong hinahanap?",
  "Hello po! Salamat sa pag-contact sa Sampaguita Realty. Paano po namin kayo matutulungan?",
  "Hello Maria! Thank you for your interest. May I know which location or property type you prefer so we can share the right pricing details?",
  "Iko-confirm po namin kung available pa ang unit at babalikan namin kayo.",
  "We will check availability and let you know as soon as possible.",
  "Our agent will confirm if installment payment is possible for this property.",
  "I cannot promise a 20% discount, but the owner will review your request.",
  "Is there a particular date you would like to visit?",
];
for (const reply of SAFE) {
  test(`careful wording passes: "${reply.slice(0, 45)}..."`, () => {
    assert.deepEqual(findUnsupportedClaims(reply, facts), []);
  });
}

test("a FAQ QUESTION about installment does not make installment a stated fact", () => {
  assert.ok(!facts.toLowerCase().includes("installment"));
});

test("a business that states availability or an offer may mention it", () => {
  const stated = statedFacts({ ...realty, pricing_information: "Installment available up to 5 years. 2 units available now." });
  assert.deepEqual(findUnsupportedClaims("Yes, we offer installment up to 5 years.", stated), []);
  assert.deepEqual(findUnsupportedClaims("May 2 units po kaming available ngayon.", stated), []);
});

test("an invented availability claim sends the lead to human review with no reply", () => {
  const ai = {
    lead_score: "HOT", intent: "PROPERTY_AVAILABILITY", urgency: "MEDIUM", score_reason: "Asks availability.",
    detected_language: "TAGALOG", customer_needs: [], missing_information: [],
    suggested_reply: INVENTED[2], confidence_level: "HIGH", needs_human_review: false,
    escalation_reason: "", injection_attempt: false,
  };
  const out = applySafetyRules(ai, { business: realty, inquiry: "hi ano pong available nyo" });
  assert.equal(out.needs_human_review, true);
  assert.equal(out.suggested_reply, null);
  assert.match(out.escalation_reason, /available/);
});
