import { buildMessages, PROMPT_VERSION } from "./prompt.js";
import { RESPONSE_SCHEMA, validateAnalysis } from "./schema.js";
import { applySafetyRules } from "./safety.js";
import { callAI } from "./groq.js";

const MAX_TRIES = 2; // one retry when the AI returns something unusable

// Reads one customer inquiry and returns either a validated analysis or a
// FAILED result. It never throws and never returns unchecked AI output.
export async function analyzeInquiry({ business, inquiry, maxLength = 2000 }) {
  const text = inquiry.trim().slice(0, maxLength);
  const totals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const started = Date.now();
  let lastProblem = "no attempt made";
  let model = null;

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let call;
    try {
      call = await callAI(buildMessages(business, text), RESPONSE_SCHEMA);
    } catch (err) {
      return failed(err.message, totals, started, model);
    }

    model = call.model;
    for (const key of Object.keys(totals)) totals[key] += call.usage?.[key] ?? 0;

    let parsed;
    try {
      parsed = JSON.parse(call.content);
    } catch {
      lastProblem = "The AI response was not valid JSON";
      continue;
    }

    const check = validateAnalysis(parsed);
    if (!check.ok) {
      lastProblem = `The AI response failed validation: ${check.errors.join("; ")}`;
      continue;
    }

    return {
      status: "COMPLETED",
      analysis: applySafetyRules(check.value, { business, inquiry: text }),
      usage: totals,
      model,
      provider: "groq",
      promptVersion: PROMPT_VERSION,
      durationMs: Date.now() - started,
    };
  }

  return failed(lastProblem, totals, started, model);
}

function failed(message, usage, started, model) {
  return {
    status: "FAILED",
    errorMessage: message.slice(0, 1000),
    usage,
    model,
    provider: "groq",
    promptVersion: PROMPT_VERSION,
    durationMs: Date.now() - started,
  };
}
