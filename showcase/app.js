// Portfolio demo page. Customer text is untrusted: it is only ever inserted
// with textContent (never as HTML).
import { SAMPLES, MAX_INQUIRY } from "./samples.js";
import { simulateAnalysis } from "./simulate.js";

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms));
const words = (s) => String(s ?? "").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// ---------- theme ----------
function paintTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  $("theme").querySelector("use").setAttribute("href", dark ? "#i-sun" : "#i-moon");
  $("theme").setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
}
$("theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("showcase-theme", next); } catch {}
  paintTheme();
});
paintTheme();

// ---------- mode: live AI or simulation ----------
const state = { live: false, liveReason: "", sample: SAMPLES[0], running: false, run: 0 };

function showMode(live, reason) {
  const m = $("mode");
  m.className = `mode ${live ? "live" : "sim"}`;
  m.replaceChildren(
    el("span", { class: `pill ${live ? "live" : "sim"}` }, live ? "Live AI" : "Simulation"),
    el("span", {}, live
      ? "Connected to the real AI (Groq), running the production prompt and safety rules. Owner approval, sending and storage are simulated."
      : `${reason} The AI steps use a simple rule-based simulation, so results are illustrative, not real AI output.`));
}

async function checkLive() {
  try {
    const res = await fetch("api/analyze", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const body = await res.json();
    state.live = !!body.live;
    state.liveReason = state.live ? "" : "The live AI is not configured on this server.";
  } catch {
    state.live = false;
    state.liveReason = "No AI backend is reachable from this page.";
  }
  showMode(state.live, state.liveReason);
}

// ---------- customer form ----------
function renderSample() {
  const s = state.sample, b = s.business;
  $("tabs").replaceChildren(...SAMPLES.map((x) => el("button", {
    class: "tab", type: "button", role: "tab", "aria-selected": x === s ? "true" : "false",
    onclick: () => { if (state.running) return; state.sample = x; $("inquiry").value = ""; syncCount(); resetRun(); renderSample(); },
  }, x.label)));
  const hours = Object.entries(b.operating_hours).map(([d, h]) => `${d}: ${h}`).join(" · ");
  $("kb").replaceChildren(
    el("div", {}, el("div", { class: "k" }, "Business"), `${b.business_name}. ${b.business_description}`),
    el("div", {}, el("div", { class: "k" }, "Services"), el("ul", {}, b.services.map((x) => el("li", {}, x)))),
    el("div", {}, el("div", { class: "k" }, "Prices"), b.pricing_information),
    el("div", {}, el("div", { class: "k" }, "FAQ"), el("ul", {}, b.business_faq.map((f) => el("li", {}, `${f.q} ${f.a}`)))),
    el("div", {}, el("div", { class: "k" }, "Hours"), hours),
    el("div", { class: "small" }, "The AI may only use these facts. Anything else (like a discount) is left to the owner."));
  $("chips").replaceChildren(...s.examples.map((ex) => el("button", {
    class: "chip", type: "button", onclick: () => { if (state.running) return; $("inquiry").value = ex.text; syncCount(); $("inquiry").focus(); },
  }, ex.label)));
}
function syncCount() { $("count").textContent = `${$("inquiry").value.length} / ${MAX_INQUIRY}`; }
$("inquiry").addEventListener("input", syncCount);
$("inquiry").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); });

// ---------- workflow steps ----------
const STEPS = [
  ["received", "Inquiry received"],
  ["ai", "AI analysis"],
  ["safety", "Safety checks"],
  ["approval", "Owner approval"],
  ["delivery", "Reply delivered"],
  ["saved", "Saved to dashboard"],
];
const STATE_ICON = { done: "check", flag: "flag", waiting: "hand", stopped: "dot", idle: "dot" };

function resetRun() {
  state.run++;
  $("steps").replaceChildren(...STEPS.map(([id, title]) => el("li", { class: "step", id: `s-${id}`, "data-state": "idle" },
    el("span", { class: "st", "aria-hidden": "true" }, icon("dot")), el("span", { class: "t" }, title),
    el("span", { class: "tagcol" }), el("span", { class: "d" }))));
  $("out").replaceChildren(el("div", { class: "placeholder" }, "Send an inquiry to start the workflow."));
}

function step(id, st, detail, tag) {
  const li = $(`s-${id}`);
  li.dataset.state = st;
  const s = li.querySelector(".st");
  s.replaceChildren(st === "running" ? "" : icon(STATE_ICON[st] ?? "dot"));
  if (detail !== undefined) li.querySelector(".d").textContent = detail;
  if (tag) li.querySelector(".tagcol").replaceChildren(el("span", { class: `pill ${tag}` }, tag === "live" ? "Live" : tag === "real" ? "Real" : "Simulated"));
  const t = li.querySelector(".t").textContent;
  li.setAttribute("aria-label", `${t}: ${st}${detail ? `. ${detail}` : ""}`);
}

const FAIL_TEXT = {
  RATE_LIMITED: "You've reached this demo's limit of 6 live tries per 10 minutes.",
  BUSY: "The live demo is busy right now.",
  AI_FAILED: "The AI did not return a usable answer.",
  AI_NOT_CONFIGURED: "The live AI is not configured on this server.",
  TIMEOUT: "The AI took too long to answer.",
  NETWORK: "The AI backend could not be reached.",
};

async function callLive(sample, inquiry) {
  let res;
  try {
    res = await fetch("api/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sample: sample.id, inquiry }), signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    return { ok: false, reason: err.name === "TimeoutError" ? "TIMEOUT" : "NETWORK" };
  }
  const body = await res.json().catch(() => ({}));
  return res.ok && body.analysis ? { ok: true, body } : { ok: false, reason: body.error ?? "AI_FAILED" };
}

// ---------- run ----------
async function run() {
  if (state.running) return;
  const text = $("inquiry").value.trim();
  const err = $("err");
  if (text.length < 3) { err.hidden = false; err.textContent = "Type a message or pick an example first."; return; }
  err.hidden = true;
  resetRun();
  const myRun = state.run;
  const live = () => myRun === state.run;
  state.running = true;
  $("run").disabled = true;
  $("out").replaceChildren();
  const sample = state.sample;

  try {
    step("received", "running", "Validating the form...");
    await sleep(400);
    if (!live()) return;
    step("received", "done", `${sample.business.business_name} · ${text.length} characters · form checked`, "real");

    let result, mode = "sim", note = "";
    if (state.live) {
      const started = Date.now();
      step("ai", "running", "Calling the AI with the production prompt...", "live");
      const tick = setInterval(() => { if (live()) $("s-ai").querySelector(".d").textContent = `Calling the AI with the production prompt... ${secs(Date.now() - started)}`; }, 200);
      const r = await callLive(sample, text);
      clearInterval(tick);
      if (!live()) return;
      if (r.ok) { result = r.body; mode = "live"; }
      else note = `${FAIL_TEXT[r.reason] ?? FAIL_TEXT.AI_FAILED} Showing a simulated result instead.`;
    }
    if (!result) {
      if (!state.live) note = "";
      step("ai", "running", "Simulating the analysis...", "sim");
      await sleep(900);
      if (!live()) return;
      result = { mode: "simulated", analysis: simulateAnalysis(sample.business, text) };
    }

    const a = result.analysis;
    const tag = mode === "live" ? "live" : "sim";
    step("ai", "done", [`${a.lead_score} lead`, words(a.intent), words(a.detected_language),
      result.durationMs ? secs(result.durationMs) : null, result.tokens ? `${result.tokens} tokens` : null].filter(Boolean).join(" · "), tag);

    step("safety", "running", "Checking for injection, made-up figures and promises...", tag);
    await sleep(450);
    if (!live()) return;
    if (a.needs_human_review) step("safety", "flag", "Needs a person: the AI does not reply on its own", tag);
    else step("safety", "done", "Passed: the reply uses only the business's own facts", tag);

    step("approval", "waiting", "Waiting for the owner: that's you, below", "sim");
    renderResult(result, mode, note, sample, text);
  } finally {
    if (myRun === state.run) { state.running = false; $("run").disabled = false; }
  }
}
$("run").addEventListener("click", run);

// ---------- result + owner approval ----------
function renderResult(result, mode, note, sample, text) {
  const a = result.analysis;
  const out = [];
  if (note) out.push(el("div", { class: "mode sim", style: "margin:16px 0 0" }, el("span", { class: "pill sim" }, "Simulated"), el("span", {}, note)));

  const tags = (list) => (list?.length ? el("div", { class: "tags" }, list.map((x) => el("span", { class: "tag" }, x))) : el("span", { class: "muted" }, "None"));
  out.push(el("div", { class: "result" },
    el("div", { class: "badges" },
      el("span", { class: `badge ${a.lead_score}` }, `${words(a.lead_score)} lead`),
      el("span", { class: "badge" }, words(a.intent)),
      el("span", { class: "badge" }, `Urgency: ${words(a.urgency)}`),
      el("span", { class: "badge" }, words(a.detected_language)),
      el("span", { class: "badge" }, `Confidence: ${words(a.confidence_level)}`)),
    el("dl", { class: "kv" },
      el("dt", {}, "Why this score"), el("dd", {}, a.score_reason || "–"),
      el("dt", {}, "Customer wants"), el("dd", {}, tags(a.customer_needs)),
      el("dt", {}, "Still need to ask"), el("dd", {}, tags(a.missing_information))),
    a.needs_human_review ? el("div", { class: "flagbox" }, el("b", {}, "Sent to the owner without a draft"), a.escalation_reason) : null,
    el("div", { class: "meta" }, mode === "live"
      ? [el("span", {}, `Model: ${result.model ?? "unknown"}`), el("span", {}, `Prompt ${result.promptVersion ?? ""}`), result.durationMs ? el("span", {}, secs(result.durationMs)) : null]
      : [el("span", {}, "Rule-based simulation (not real AI output)")]),
    el("details", { class: "raw" }, el("summary", {}, mode === "live" ? "Raw JSON returned by the AI (after validation and safety rules)" : "Raw JSON (simulated)"),
      el("pre", {}, JSON.stringify(a, null, 2)))));

  out.push(telegramCard(a, sample, text));
  $("out").replaceChildren(...out);
}

function telegramCard(a, sample, text) {
  const runId = state.run;
  const wrap = el("div", { class: "tgwrap" });
  const head = el("div", { class: "tghead" }, el("span", { class: "bot", "aria-hidden": "true" }, "AI"),
    el("span", {}, "Telegram message to the owner"), el("span", { class: "pill sim", style: "margin-left:auto" }, "Simulated"));
  const draft = a.suggested_reply ?? "";
  const bubble = el("div", { class: "bubble" },
    el("div", { class: "bh" }, a.needs_human_review ? `NEEDS YOUR REPLY · ${words(a.lead_score)} lead` : `New ${words(a.lead_score)} lead · ${words(a.intent)}`),
    el("div", { class: "muted" }, `${sample.business.business_name} · website form`),
    el("div", { style: "margin-top:6px" }, `"${text.length > 180 ? `${text.slice(0, 180)}...` : text}"`),
    draft ? el("div", { class: "reply" }, draft) : el("div", { class: "reply" }, `No draft. Reason: ${a.escalation_reason ?? "needs a person"}`));

  const editBox = el("div", { class: "tgedit", hidden: true });
  const ta = el("textarea", { class: "input", maxlength: 1000, "aria-label": "Reply to the customer", placeholder: "Write the reply as the owner..." });
  ta.value = draft;
  const sendEdited = el("button", { class: "btn", type: "button" }, icon("check"), "Send this reply");
  const cancel = el("button", { class: "btn secondary", type: "button" }, "Cancel");
  editBox.append(ta, el("div", { class: "form-foot" }, cancel, el("span", { class: "grow" }), sendEdited));

  const btns = el("div", { class: "tgbtns" });
  const approve = el("button", { type: "button", disabled: !draft }, "Approve");
  const edit = el("button", { type: "button" }, draft ? "Edit" : "Write reply");
  const reject = el("button", { type: "button" }, "Reject");
  btns.append(approve, edit, reject);

  const lock = () => { for (const b of [approve, edit, reject]) b.disabled = true; };
  approve.addEventListener("click", () => { lock(); deliver(draft, sample, runId, false); });
  edit.addEventListener("click", () => { editBox.hidden = false; btns.hidden = true; ta.focus(); });
  cancel.addEventListener("click", () => { editBox.hidden = true; btns.hidden = false; });
  sendEdited.addEventListener("click", () => {
    if (!ta.value.trim()) return ta.focus();
    sendEdited.disabled = true; cancel.disabled = true; lock();
    deliver(ta.value.trim(), sample, runId, ta.value.trim() !== draft.trim());
  });
  reject.addEventListener("click", () => {
    lock();
    if (runId !== state.run) return;
    step("approval", "stopped", "Rejected by the owner: nothing was sent", "sim");
    step("delivery", "stopped", "Skipped", "sim");
    step("saved", "done", "Lead saved as \"Needs a reply\" so it is not forgotten", "sim");
  });

  wrap.append(head, bubble, btns, editBox);
  return wrap;
}

async function deliver(reply, sample, runId, edited) {
  if (runId !== state.run) return;
  step("approval", "done", edited ? "Edited and approved by the owner" : "Approved by the owner with one tap", "sim");
  step("delivery", "running", "Sending through the email outbox...", "sim");
  await sleep(800);
  if (runId !== state.run) return;
  step("delivery", "done", "Emailed to the customer (simulated: nothing was sent)", "sim");
  step("saved", "done", "Lead saved as Replied, with reply time and timeline", "sim");
  $("out").append(
    el("div", { class: "delivered" },
      el("div", { class: "eh" }, el("span", {}, `From: ${sample.business.business_name}`), el("span", {}, "To: the customer"),
        el("span", {}, `Subject: Re: your inquiry to ${sample.business.business_name}`)),
      el("div", { class: "eb" }, reply)),
    el("div", { class: "dashrow" }, el("span", {}, el("b", {}, "Owner dashboard"), el("span", { class: "muted" }, " · new lead")),
      el("span", { class: "ok-badge" }, "Replied"), el("span", { class: "small" }, "just now")));
}

// ---------- start ----------
renderSample();
resetRun();
checkLive();
