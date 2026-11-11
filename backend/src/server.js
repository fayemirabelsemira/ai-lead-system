// HTTP API. No framework: node:http only.
//   GET  /health                   for the host's health checks
//   POST /intake/<form id>         website form submissions
//   GET  /test-form                the development test form (when enabled)
// The database call is passed in as `submit`, so this file has no I/O of its own.
import { createServer as createHttpServer } from "node:http";
import { validateSubmission } from "./intake/validate.js";
import { createRateLimiter } from "./intake/rateLimit.js";

const MAX_BODY_BYTES = 16 * 1024;
const FORM_ID = /^[A-Za-z0-9_-]{22,64}$/;

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const TEST_FORM_CSP =
  // The two animation libraries are allowed by exact file only (and pinned with
  // integrity hashes in the page). The form works without them.
  "default-src 'none'; script-src 'unsafe-inline' " +
  "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js " +
  "https://unpkg.com/lenis@1.1.13/dist/lenis.min.js; style-src 'unsafe-inline'; " +
  "connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > MAX_BODY_BYTES) return reject(new HttpError(413, "The submission is too large."));
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return; // keep draining, but stop storing
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, "The submission is too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "The submission is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

export function createServer({
  submit,
  allowedOrigins = [],
  trustProxy = false,
  testFormHtml = null,
  perMinute = 5,
  perHour = 30,
  log = console,
}) {
  const minuteLimit = createRateLimiter({ limit: perMinute, windowMs: 60_000 });
  const hourLimit = createRateLimiter({ limit: perHour, windowMs: 3_600_000 });

  const clientIp = (req) => {
    if (trustProxy) {
      const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const corsHeaders = (req) => {
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.includes(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  };

  const send = (res, status, body, extra = {}) => {
    res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra });
    res.end(JSON.stringify(body));
  };

  async function handleIntake(req, res, formId) {
    const cors = corsHeaders(req);
    const ip = clientIp(req);
    // Both windows are always counted, so a burst also uses up the hourly allowance.
    const withinMinute = minuteLimit(ip);
    const withinHour = hourLimit(ip);
    if (!withinMinute || !withinHour) {
      return send(res, 429, { ok: false, error: "Too many submissions. Please try again later." }, {
        ...cors,
        "Retry-After": withinHour ? "60" : "3600",
      });
    }
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return send(res, 415, { ok: false, error: "Send the form as JSON." }, cors);
    }

    const body = await readJson(req);
    const check = validateSubmission(body);
    if (!check.ok) return send(res, 400, { ok: false, errors: check.errors }, cors);

    // Bots get the same answer as people, so they cannot tell they were filtered.
    if (check.isSpam) return send(res, 202, { ok: true }, cors);

    const result = await submit(formId, check.value);
    if (result === "NOT_FOUND") return send(res, 404, { ok: false, error: "This form is not active." }, cors);
    return send(res, 202, { ok: true }, cors);
  }

  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/health" && req.method === "GET") return send(res, 200, { ok: true });

      if (path === "/test-form" && req.method === "GET" && testFormHtml) {
        res.writeHead(200, {
          ...BASE_HEADERS,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": TEST_FORM_CSP,
          "X-Frame-Options": "DENY",
        });
        return res.end(testFormHtml);
      }

      const match = /^\/intake\/([^/]+)$/.exec(path);
      if (match) {
        const formId = match[1];
        if (!FORM_ID.test(formId)) return send(res, 404, { ok: false, error: "This form is not active." });
        if (req.method === "OPTIONS") {
          res.writeHead(204, { ...BASE_HEADERS, ...corsHeaders(req) });
          return res.end();
        }
        if (req.method === "POST") return await handleIntake(req, res, formId);
        return send(res, 405, { ok: false, error: "Method not allowed." }, { Allow: "POST, OPTIONS" });
      }

      return send(res, 404, { ok: false, error: "Not found." });
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) send(res, err.status, { ok: false, error: err.message }, corsHeaders(req));
        return;
      }
      // Details go to the server log only, never to the caller.
      log.error("Request failed:", err.message);
      if (!res.headersSent) send(res, 500, { ok: false, error: "Something went wrong. Please try again." }, corsHeaders(req));
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
