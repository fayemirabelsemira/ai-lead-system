// Everything the AI is allowed to return, and the checks we run on it.
// Nothing the AI returns is trusted until it passes validateAnalysis().

export const SCORES = ["HOT", "WARM", "COLD"];
export const URGENCY_LEVELS = ["LOW", "MEDIUM", "HIGH"];
export const LANGUAGES = ["ENGLISH", "TAGALOG", "TAGLISH", "OTHER"];
export const CONFIDENCE_LEVELS = ["LOW", "MEDIUM", "HIGH"];

// To support a new intent later, add it to this list (and nowhere else).
export const INTENTS = [
  // Real estate
  "BUY_PROPERTY", "RENT_PROPERTY", "PROPERTY_PRICE", "PROPERTY_AVAILABILITY",
  "PROPERTY_VIEWING", "PAYMENT_INQUIRY",
  // Clinics
  "APPOINTMENT_REQUEST", "SERVICE_INQUIRY", "PRICE_INQUIRY", "OPERATING_HOURS",
  // Home services
  "SERVICE_REQUEST", "QUOTATION_REQUEST", "AVAILABILITY_INQUIRY",
  // General
  "FOLLOW_UP", "COMPLAINT", "SPAM", "UNCLEAR", "OUT_OF_SCOPE", "GENERAL_INQUIRY",
];

// JSON Schema sent to Groq. Strict mode needs every property listed in
// "required" and additionalProperties false, so optional text uses "".
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    lead_score: { type: "string", enum: SCORES },
    intent: { type: "string", enum: INTENTS },
    urgency: { type: "string", enum: URGENCY_LEVELS },
    score_reason: { type: "string" },
    detected_language: { type: "string", enum: LANGUAGES },
    customer_needs: { type: "array", items: { type: "string" } },
    missing_information: { type: "array", items: { type: "string" } },
    suggested_reply: { type: "string" },
    confidence_level: { type: "string", enum: CONFIDENCE_LEVELS },
    needs_human_review: { type: "boolean" },
    escalation_reason: { type: "string" },
    injection_attempt: { type: "boolean" },
  },
  required: [
    "lead_score", "intent", "urgency", "score_reason", "detected_language",
    "customer_needs", "missing_information", "suggested_reply",
    "confidence_level", "needs_human_review", "escalation_reason", "injection_attempt",
  ],
  additionalProperties: false,
};

export function validateAnalysis(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["The response is not a JSON object"] };
  }
  const errors = [];

  const pick = (key, allowed) => {
    if (!allowed.includes(raw[key])) errors.push(`${key} must be one of: ${allowed.join(", ")}`);
  };
  const text = (key, max) => {
    if (typeof raw[key] !== "string") errors.push(`${key} must be a string`);
    else if (raw[key].trim().length > max) errors.push(`${key} is longer than ${max} characters`);
  };
  const phrases = (key) => {
    const v = raw[key];
    if (!Array.isArray(v) || v.length > 10 || !v.every((x) => typeof x === "string" && x.length <= 200)) {
      errors.push(`${key} must be a list of at most 10 short strings`);
    }
  };
  const flag = (key) => {
    if (typeof raw[key] !== "boolean") errors.push(`${key} must be true or false`);
  };

  pick("lead_score", SCORES);
  pick("intent", INTENTS);
  pick("urgency", URGENCY_LEVELS);
  pick("detected_language", LANGUAGES);
  pick("confidence_level", CONFIDENCE_LEVELS);
  text("score_reason", 2000);
  text("suggested_reply", 2000);
  text("escalation_reason", 1000);
  phrases("customer_needs");
  phrases("missing_information");
  flag("needs_human_review");
  flag("injection_attempt");

  if (errors.length > 0) return { ok: false, errors };

  const clean = (list) => list.map((x) => x.trim()).filter(Boolean);
  return {
    ok: true,
    value: {
      lead_score: raw.lead_score,
      intent: raw.intent,
      urgency: raw.urgency,
      score_reason: raw.score_reason.trim(),
      detected_language: raw.detected_language,
      customer_needs: clean(raw.customer_needs),
      missing_information: clean(raw.missing_information),
      suggested_reply: raw.suggested_reply.trim(),
      confidence_level: raw.confidence_level,
      needs_human_review: raw.needs_human_review,
      escalation_reason: raw.escalation_reason.trim(),
      injection_attempt: raw.injection_attempt,
    },
  };
}
