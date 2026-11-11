// Creates (or shows) the website-form id for a business.
// Usage: npm run create-form -- <business-uuid>
import { supabase } from "../src/supabase.js";
import { ensureWebsiteForm, formUrl } from "../src/forms.js";

const businessId = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(businessId ?? "")) {
  console.error("Usage: npm run create-form -- <business-uuid>");
  process.exit(1);
}

try {
  const { data: business, error } = await supabase
    .from("businesses")
    .select("business_name, telegram_chat_id")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!business) throw new Error("No business with that id.");
  console.log(`Business: ${business.business_name}`);
  if (!business.telegram_chat_id) console.log("Warning: this business has no Telegram chat, so no cards can be sent.");

  const form = await ensureWebsiteForm(businessId);
  if (!form.isActive) console.log("Note: this form is turned OFF (is_active = false).");
  console.log(`Form id: ${form.formId}`);
  console.log(`Form page: ${formUrl(form.formId)}`);
} catch (err) {
  console.error("Failed:", err.message);
  process.exitCode = 1;
}
