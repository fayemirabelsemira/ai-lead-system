// The only file that talks to Groq. To add another AI provider later,
// create a sibling file with the same callAI() shape and switch in analyze.js.

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

function env(name) {
  const value = process.env[name];
  if (!value || value.startsWith("your-")) {
    // Only the NAME is shown, never the value.
    throw new Error(`Missing or placeholder environment variable: ${name}`);
  }
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function callAI(messages, schema) {
  const apiKey = env("GROQ_API_KEY");
  const model = env("GROQ_MODEL");
  let strict = true;

  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    let res;

    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_completion_tokens: 1200,
          reasoning_effort: "low",
          response_format: {
            type: "json_schema",
            json_schema: { name: "lead_analysis", strict, schema },
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure or timeout
      if (attempt >= MAX_ATTEMPTS) throw new Error(`Groq request failed (${err.name})`);
      await sleep(2000 * attempt);
      continue;
    }

    // Rate limit or temporary outage: wait, then try again
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`Groq unavailable (HTTP ${res.status})`);
      const waitSeconds = Math.min(Number(res.headers.get("retry-after")) || 5 * attempt, 60);
      await sleep(waitSeconds * 1000);
      continue;
    }

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      // Some models only support best-effort schemas: retry once without strict mode.
      if (res.status === 400 && strict) {
        strict = false;
        continue;
      }
      throw new Error(`Groq error (HTTP ${res.status}): ${body?.error?.message ?? "unknown"}`);
    }

    const content = body?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Groq returned an empty response");

    return {
      content,
      usage: body.usage ?? null,
      model: body.model ?? model,
      durationMs: Date.now() - started,
      strict,
    };
  }
}
