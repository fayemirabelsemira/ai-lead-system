// Public portfolio demo endpoint (Vercel serverless function; also used by
// `npm run showcase` locally). It runs the PRODUCTION analysis code from
// backend/src/ai (same prompt, JSON schema, validation and safety rules) on a
// visitor's sample inquiry and returns the result.
//
// It never touches Supabase, Telegram or email, stores nothing, and the Groq
// key stays on the server (GROQ_API_KEY / GROQ_MODEL environment variables).
//
//   GET  /api/analyze  -> { live: boolean }       is the real AI configured?
//   POST /api/analyze  { sample, inquiry }        -> analysis result
import { analyzeInquiry } from "../backend/src/ai/analyze.js";
import { createRateLimiter } from "../backend/src/intake/rateLimit.js";
import { SAMPLES, MAX_INQUIRY } from "../showcase/samples.js";

// Best effort: limits are per server instance (Vercel may run several).
// Groq's own account limits are the hard ceiling on cost.
const perVisitor = createRateLimiter({ limit: 6, windowMs: 10 * 60_000 });
const overall = createRateLimiter({ limit: 120, windowMs: 60 * 60_000 });

const configured = () => [process.env.GROQ_API_KEY, process.env.GROQ_MODEL].every((v) => v && !v.startsWith("your-"));

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8_000) throw new Error("too large");
  }
  return JSON.parse(raw || "{}");
}

function visitorKey(req) {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return String(req.headers["x-real-ip"] ?? "") || fwd || req.socket?.remoteAddress || "unknown";
}

export default async function handler(req, res) {
  if (req.method === "GET") return send(res, 200, { live: configured() });
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "METHOD_NOT_ALLOWED" });
  }

  // Browsers on other websites may not use this endpoint.
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch {}
    if (host !== req.headers.host) return send(res, 403, { error: "FORBIDDEN_ORIGIN" });
  }

  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: "BAD_REQUEST" }); }
  const sample = SAMPLES.find((s) => s.id === body?.sample);
  const inquiry = typeof body?.inquiry === "string" ? body.inquiry.trim() : "";
  if (!sample) return send(res, 400, { error: "UNKNOWN_SAMPLE" });
  if (inquiry.length < 3 || inquiry.length > MAX_INQUIRY) return send(res, 400, { error: "BAD_LENGTH", max: MAX_INQUIRY });

  if (!configured()) return send(res, 503, { error: "AI_NOT_CONFIGURED" });
  if (!perVisitor(visitorKey(req))) return send(res, 429, { error: "RATE_LIMITED", retryAfterMinutes: 10 });
  if (!overall("all")) return send(res, 429, { error: "BUSY", retryAfterMinutes: 60 });

  const result = await analyzeInquiry({ business: sample.business, inquiry, maxLength: MAX_INQUIRY });
  if (result.status !== "COMPLETED") {
    // Details go to the server log only (they can mention the provider's error).
    console.error(`[demo] analysis failed: ${result.errorMessage}`);
    return send(res, 502, { error: "AI_FAILED" });
  }
  return send(res, 200, {
    mode: "live",
    analysis: result.analysis,
    model: result.model,
    provider: result.provider,
    promptVersion: result.promptVersion,
    durationMs: result.durationMs,
    tokens: result.usage?.total_tokens ?? null,
  });
}
