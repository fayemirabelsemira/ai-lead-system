import { knowledgeOf } from "./prompt.js";

// Extra checks that run AFTER the AI answers. The AI can be wrong or can be
// tricked, so these rules are enforced by our code, not by the AI.

const MAX_ESCALATION = 1000;

// Numbers with 2+ digits, with commas/decimal points removed ("5,000" -> "5000").
const numberTokens = (text) =>
  new Set(
    ((text ?? "").match(/\d[\d,.]*\d|\d/g) ?? [])
      .map((n) => n.replace(/[,.]/g, ""))
      .filter((n) => n.length >= 2)
  );

// Figures in the reply that appear neither in the business information
// nor in the customer's own message: a sign the AI invented something.
export function findUnsupportedFigures(reply, allowedText) {
  const allowed = numberTokens(allowedText);
  return [...numberTokens(reply)].filter((n) => !allowed.has(n));
}

// ---------- Claims the business never made ----------
// The AI is told never to say something is available or offered unless the
// business information says so, but it still does ("may available po kami").
// These checks catch it in English, Tagalog and Taglish. They are deliberately
// cautious: a false alarm only means the owner writes the reply themselves.

const AVAILABILITY = /\b(available|availability|bakante|vacant|openings?|slots?)\b/i;
// "we / kami / namin ..." or Tagalog "may ... available": the business speaking about itself.
const SPEAKS_FOR_BUSINESS = /\b(kami|kaming|namin|natin|tayo|we|we're|we've|our)\b|\bmay\b[^.!?]*\bavailable\b/i;

const OFFER_TERMS = [
  "installment", "hulugan", "financing", "payment plan", "discount", "promo", "libre", "free",
];
const OFFER = new RegExp(`\\b(${OFFER_TERMS.join("|")})s?\\b`, "i");
const AFFIRMS = /\b(yes|oo|opo|meron|mayroon|we (do )?(offer|have|provide|give)|we can (give|offer)|offer (po )?kami|nag-?o?offer)\b|\bmay\b[^.!?]*\b(kami|kaming)\b/i;

// Conditional, negative or "we will check" wording is not a claim.
const HEDGED =
  /\b(kung|if|whether|confirm\w*|i-?confirm|iko-?confirm|kumpirm\w*|check\w*|i-?check|verify|ma-?verify|alamin|aalamin|let you know|ipapaalam|update|hindi|not|cannot|can't|wala)\b/i;

const sentences = (text) =>
  String(text ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

// Questions are not claims. Everything else is checked clause by clause, so a
// "please confirm" later in a sentence cannot excuse an earlier claim
// ("May available units po kami, i-confirm lang natin ang schedule").
const claimClauses = (text) =>
  sentences(text)
    .filter((s) => !s.endsWith("?"))
    .flatMap((s) => s.split(/[,;:]|\s(?:pero|but)\s/i))
    .map((c) => c.trim())
    .filter((c) => c && !HEDGED.test(c));

// The business's own statements: description, services, prices, FAQ answers, hours.
export function statedFacts(business) {
  const k = knowledgeOf(business);
  const faqAnswers = (Array.isArray(k.faq) ? k.faq : []).map((f) => (f && typeof f === "object" ? f.a : f));
  return JSON.stringify([k.description, k.services, k.pricing, faqAnswers, k.operating_hours]);
}

export function findUnsupportedClaims(reply, knowledgeText) {
  const knowledge = String(knowledgeText ?? "").toLowerCase();
  const reasons = new Set();
  for (const s of claimClauses(reply)) {
    if (AVAILABILITY.test(s) && SPEAKS_FOR_BUSINESS.test(s) && !AVAILABILITY.test(knowledge)) {
      reasons.add("The drafted reply says something is available, but the business information does not confirm it.");
    }
    const offer = OFFER.exec(s)?.[1]?.toLowerCase();
    if (offer && AFFIRMS.test(s) && !knowledge.includes(offer)) {
      reasons.add(`The drafted reply promises "${offer}", which the business information does not mention.`);
    }
  }
  return [...reasons];
}

export function applySafetyRules(analysis, { business, inquiry }) {
  const reasons = [];

  if (analysis.needs_human_review) {
    reasons.push(analysis.escalation_reason || "The AI flagged this inquiry for human review.");
  }
  if (analysis.injection_attempt) {
    reasons.push("The message tried to give the AI instructions.");
  }
  if (analysis.intent === "COMPLAINT") {
    reasons.push("The customer has a complaint.");
  }
  if (analysis.confidence_level === "LOW") {
    reasons.push("The AI is not confident about this inquiry.");
  }

  if (analysis.suggested_reply) {
    const allowedText = `${JSON.stringify(knowledgeOf(business))} ${inquiry}`;
    const unsupported = findUnsupportedFigures(analysis.suggested_reply, allowedText);
    if (unsupported.length > 0) {
      reasons.push(
        `The drafted reply contains figures that are not in the business information (${unsupported.join(", ")}).`
      );
    }
    // Only what the business STATES counts: not the customer asking
    // "available ba?", and not a FAQ question like "Do you offer installment?".
    reasons.push(...findUnsupportedClaims(analysis.suggested_reply, statedFacts(business)));
  } else if (!analysis.needs_human_review) {
    reasons.push("The AI did not produce a reply.");
  }

  const needsHuman = reasons.length > 0;
  const uniqueReasons = [...new Set(reasons)];

  return {
    ...analysis,
    needs_human_review: needsHuman,
    escalation_reason: needsHuman ? uniqueReasons.join(" ").slice(0, MAX_ESCALATION) : null,
    // No customer-facing draft is ever kept when a human must decide.
    suggested_reply: needsHuman ? null : analysis.suggested_reply,
  };
}
