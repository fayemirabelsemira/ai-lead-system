// Creates (or shows) the website-form id for a business.
// Usage: npm run create-form -- <business-uuid>
import { randomBytes } from "node:crypto";
import { supabase } from "../src/supabase.js";
import { config } from "../src/config.js";

const businessId = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(businessId ?? "")) {
  console.error("Usage: npm run create-form -- <business-uuid>");
  process.exit(1);
}

function show(id) {
  console.log(`Form id: ${id}`);
  console.log(`Test form: http://localhost:${config.port}/test-form?form=${id}`);
}

try {
  const { data: business, error: bErr } = await supabase
    .from("businesses")
    .select("business_name, telegram_chat_id")
    .eq("id", businessId)
    .maybeSingle();
  if (bErr) throw new Error(bErr.message);
  if (!business) throw new Error("No business with that id.");
  console.log(`Business: ${business.business_name}`);
  if (!business.telegram_chat_id) console.log("Warning: this business has no Telegram chat, so no cards can be sent.");

  const { data: existing, error: eErr } = await supabase
    .from("business_integrations")
    .select("public_identifier, is_active")
    .eq("business_id", businessId)
    .eq("provider", "WEBSITE_FORM")
    .maybeSingle();
  if (eErr) throw new Error(eErr.message);

  if (existing) {
    if (!existing.is_active) console.log("Note: this form is turned OFF (is_active = false).");
    show(existing.public_identifier);
  } else {
    // 24 random bytes = 32 URL-safe characters: public, but impossible to guess.
    const id = randomBytes(24).toString("base64url");
    const { error } = await supabase
      .from("business_integrations")
      .insert({ business_id: businessId, provider: "WEBSITE_FORM", public_identifier: id });
    if (error) throw new Error(error.message);
    show(id);
  }
} catch (err) {
  console.error("Failed:", err.message);
  process.exitCode = 1;
}
