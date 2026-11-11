// Website forms: one public, unguessable id per business.
import { randomBytes } from "node:crypto";
import { supabase } from "./supabase.js";
import { config } from "./config.js";

// The public address of a form page.
export const formUrl = (formId) => `${config.publicBaseUrl}/f/${formId}`;

// The business behind an ACTIVE form of an ACTIVE business, or null.
// Only the business name is returned: it is shown on the public page.
export async function lookupForm(formId) {
  const { data, error } = await supabase
    .from("business_integrations")
    .select("is_active, businesses!inner ( business_name, is_active )")
    .eq("provider", "WEBSITE_FORM")
    .eq("public_identifier", formId)
    .maybeSingle();
  if (error) throw new Error(`Look up form: ${error.message}`);
  if (!data?.is_active || !data.businesses?.is_active) return null;
  return { businessName: data.businesses.business_name };
}

// Returns the business's website form id, creating one if needed.
export async function ensureWebsiteForm(businessId) {
  const { data: existing, error } = await supabase
    .from("business_integrations")
    .select("public_identifier, is_active")
    .eq("business_id", businessId)
    .eq("provider", "WEBSITE_FORM")
    .maybeSingle();
  if (error) throw new Error(`Find form: ${error.message}`);
  if (existing) return { formId: existing.public_identifier, isActive: existing.is_active, created: false };

  // 24 random bytes = 32 URL-safe characters: public, but impossible to guess.
  const formId = randomBytes(24).toString("base64url");
  const { error: insertError } = await supabase
    .from("business_integrations")
    .insert({ business_id: businessId, provider: "WEBSITE_FORM", public_identifier: formId });
  if (insertError) throw new Error(`Create form: ${insertError.message}`);
  return { formId, isActive: true, created: true };
}
