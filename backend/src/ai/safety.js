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
