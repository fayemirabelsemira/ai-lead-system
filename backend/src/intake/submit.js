import { createHash } from "node:crypto";
import { supabase } from "../supabase.js";

// Saves one validated submission and queues its analysis, in one database
// transaction. Returns "CREATED", "DUPLICATE_SUBMISSION" or "NOT_FOUND".
export async function submitIntake(formId, value) {
  const { data, error } = await supabase.rpc("intake_submission", {
    p_public_identifier: formId,
    p_external_id: value.externalId,
    p_full_name: value.fullName,
    p_email: value.email,
    p_email_normalized: value.emailNormalized,
    p_phone: value.phone,
    p_phone_normalized: value.phoneNormalized,
    p_message: value.message,
    p_content_hash: createHash("sha256").update(value.message).digest("hex"),
  });
  if (error) throw new Error(`Save submission: ${error.message}`);
  return data.result;
}
