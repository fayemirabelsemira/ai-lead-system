// The backend process: Telegram bot + job worker + HTTP intake API.
// Run exactly ONE instance (Telegram long polling allows only one).
import { readFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { config, required } from "./config.js";
import { startBot } from "./bot.js";
import { createServer } from "./server.js";
import { createWorker } from "./worker.js";
import { submitIntake } from "./intake/submit.js";
import { analyzeInquiry } from "./ai/analyze.js";
import {
  sendLeadCard,
  sendManualNotice,
  notifyEmailSent,
  notifyEmailProblem,
  notifyApprovalExpired,
  newToken,
  hashToken,
} from "./approvals.js";
import { createOutboxWorker } from "./outbox.js";
import { createRecovery } from "./recovery.js";
import { createGmailSender } from "./email/gmail.js";
import * as jobsDb from "./jobs-db.js";
import { supabase } from "./supabase.js";
import { lookupForm, formUrl } from "./forms.js";

// The worker needs the AI settings; fail now rather than on the first lead.
required("GROQ_API_KEY");
required("GROQ_MODEL");

// The customer form page, served at /f/<form id>.
const formPath = new URL("../../form/index.html", import.meta.url);
const formHtml = existsSync(formPath) ? readFileSync(formPath, "utf8") : null;
if (!formHtml) console.warn("form/index.html not found: the form page is OFF (the intake API still works).");

const server = createServer({
  submit: submitIntake,
  allowedOrigins: config.intakeAllowedOrigins,
  trustProxy: config.trustProxy,
  formHtml,
  lookupForm,
  devNote: !config.isProduction,
});

const worker = createWorker(
  { ...jobsDb, analyze: analyzeInquiry, sendLeadCard, sendManualNotice },
  { workerId: `${hostname()}:${process.pid}` }
);

// Automatic email runs only when Gmail is configured.
const outbox =
  config.gmailUser && config.gmailAppPassword
    ? createOutboxWorker({
        ...jobsDb,
        sender: createGmailSender({ user: config.gmailUser, appPassword: config.gmailAppPassword }),
        newToken,
        hashToken,
        notifyEmailSent,
        notifyEmailProblem,
      })
    : null;

const recovery = createRecovery({
  ...jobsDb,
  newToken,
  hashToken,
  sendManualNotice,
  notifyEmailProblem,
  notifyApprovalExpired,
});

const bot = startBot();
worker.start();
recovery.start();
if (outbox) outbox.start();
else console.log("Automatic email is OFF (GMAIL_USER / GMAIL_APP_PASSWORD not set). Approved replies use copy-and-send.");
server.listen(config.port, async () => {
  console.log(`HTTP server listening on port ${config.port}.`);
  if (formHtml) await printFormLinks();
});

// Prints the form link of every active business, so it is easy to find.
async function printFormLinks() {
  const { data, error } = await supabase
    .from("business_integrations")
    .select("public_identifier, businesses!inner ( business_name )")
    .eq("provider", "WEBSITE_FORM")
    .eq("is_active", true)
    .eq("businesses.is_active", true);
  if (error) return console.error("Could not list forms:", error.message);
  if (!data.length) return console.log("No active forms yet. Add a business with: npm run add-business -- business.json");
  for (const form of data) console.log(`Form (${form.businesses.business_name}): ${formUrl(form.public_identifier)}`);
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down...`);
  server.close();
  await Promise.allSettled([bot.stop(), worker.stop(), outbox?.stop(), recovery.stop()]);
  console.log("Stopped.");
  process.exit(0);
}
// SIGINT = Ctrl+C locally; SIGTERM = how hosting platforms and Docker stop a process.
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
