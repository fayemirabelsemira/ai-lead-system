// Adds a business (or updates it, when run again) from a JSON file:
// business info for the AI, the owner, the Telegram chat, and a form link.
//
//   npm run add-business -- business.json          add or update
//   npm run add-business -- business.json --yes    without the confirmation question
//   npm run add-business -- --show-ids             list the Telegram ids already in the database
//
// The business is matched by its Telegram chat (one chat = one business), so
// edit the file and run it again to update the info the AI uses.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { supabase } from "../src/supabase.js";
import { config } from "../src/config.js";
import { parseBusinessFile, isTestBusiness } from "../src/onboarding.js";
import { ensureWebsiteForm, formUrl } from "../src/forms.js";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const fileArg = args.find((a) => !a.startsWith("--"));

const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

async function confirm(question) {
  if (yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} (y/N) `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function showIds() {
  const businesses = must(
    await supabase.from("businesses").select("business_name, is_active, telegram_chat_id").order("created_at"),
    "List businesses"
  );
  const members = must(
    await supabase
      .from("business_members")
      .select("role, telegram_user_id, businesses ( business_name )")
      .not("telegram_user_id", "is", null),
    "List members"
  );
  console.log("Businesses and their Telegram chat:");
  for (const b of businesses)
    console.log(`  ${b.business_name}${b.is_active ? "" : " (off)"}: ${b.telegram_chat_id ?? "no chat"}`);
  console.log("Telegram users linked to a business:");
  for (const m of members) console.log(`  ${m.telegram_user_id} (${m.role} of ${m.businesses?.business_name})`);
  console.log("In a private chat with the bot, your chat id is the same number as your user id.");
}

async function findOrCreateUser(email) {
  for (let page = 1; ; page++) {
    const { users } = must(await supabase.auth.admin.listUsers({ page, perPage: 1000 }), "List users");
    const found = users.find((u) => u.email?.toLowerCase() === email);
    if (found) return { id: found.id, created: false };
    if (users.length < 1000) break;
  }
  // No password: this account exists only to own the business (no login yet).
  const { user } = must(await supabase.auth.admin.createUser({ email, email_confirm: true }), "Create owner");
  return { id: user.id, created: true };
}

async function retireTestBusiness(b) {
  must(await supabase.from("businesses").update({ is_active: false, telegram_chat_id: null }).eq("id", b.id), "Switch off test business");
  must(await supabase.from("business_integrations").update({ is_active: false }).eq("business_id", b.id), "Switch off test form");
  must(await supabase.from("business_settings").update({ email_delivery_enabled: false }).eq("business_id", b.id), "Switch off test email");
}

async function main() {
  if (args.includes("--show-ids")) return showIds();
  if (!fileArg) {
    console.error("Usage: npm run add-business -- business.json   (copy business.example.json to start)");
    process.exitCode = 1;
    return;
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), fileArg), "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${fileArg}: ${err.message}`);
  }
  const parsed = parseBusinessFile(raw);
  if (!parsed.ok) {
    console.error(`Please fix ${fileArg}:`);
    for (const e of parsed.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  const { business, owner, automaticEmail } = parsed;

  const existing = must(
    await supabase
      .from("businesses")
      .select("id, business_name, is_active")
      .eq("telegram_chat_id", business.telegram_chat_id)
      .maybeSingle(),
    "Find business"
  );
  const retire = existing && isTestBusiness(existing.business_name) ? existing : null;
  const update = existing && !retire ? existing : null;

  console.log(`Database: ${new URL(config.supabaseUrl).host}`);
  if (retire) console.log(`- Switch OFF the sample business "${retire.business_name}" and move your Telegram chat to the new one (its data is kept).`);
  console.log(update ? `- UPDATE "${update.business_name}" -> "${business.business_name}"` : `- ADD "${business.business_name}"`);
  console.log(`- Owner: ${owner.email} (Telegram ${owner.telegram_user_id})`);
  console.log(`- Automatic email: ${automaticEmail ? "ON" : "OFF (copy-and-send)"}`);
  if (!(await confirm("Go ahead?"))) return console.log("Nothing changed.");

  if (retire) await retireTestBusiness(retire);

  const { id: userId, created: userCreated } = await findOrCreateUser(owner.email);

  let businessId;
  if (update) {
    must(await supabase.from("businesses").update({ ...business, is_active: true }).eq("id", update.id), "Update business");
    businessId = update.id;
  } else {
    const row = must(
      await supabase.from("businesses").insert({ ...business, created_by: userId }).select("id").single(),
      "Add business"
    );
    businessId = row.id;
  }

  const member = must(
    await supabase.from("business_members").select("id").eq("business_id", businessId).eq("user_id", userId).maybeSingle(),
    "Find owner"
  );
  if (member) {
    must(
      await supabase.from("business_members").update({ role: "OWNER", telegram_user_id: owner.telegram_user_id }).eq("id", member.id),
      "Update owner"
    );
  } else {
    must(
      await supabase
        .from("business_members")
        .insert({ business_id: businessId, user_id: userId, role: "OWNER", telegram_user_id: owner.telegram_user_id }),
      "Add owner"
    );
  }

  // business_settings is created automatically with the business.
  must(
    await supabase.from("business_settings").update({ email_delivery_enabled: automaticEmail }).eq("business_id", businessId),
    "Save email setting"
  );

  const form = await ensureWebsiteForm(businessId);

  console.log("\nDone.");
  console.log(`Business id: ${businessId}`);
  if (userCreated) console.log(`Owner account created for ${owner.email} (no password; used only to own the business).`);
  if (!form.isActive) console.log("Note: the form is turned OFF (is_active = false in business_integrations).");
  console.log(`Form page: ${formUrl(form.formId)}`);
  if (automaticEmail && !(config.gmailUser && config.gmailAppPassword))
    console.log("Warning: automatic email is ON but GMAIL_USER / GMAIL_APP_PASSWORD are not set, so replies wait in the queue.");
  console.log("Restart the backend, then send a test inquiry through the form page.");
}

main().catch((err) => {
  console.error("Failed:", err.message);
  console.error("Run it again after fixing the problem: it continues where it stopped.");
  process.exitCode = 1;
});
