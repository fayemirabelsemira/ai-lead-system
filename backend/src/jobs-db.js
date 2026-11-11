// The database side of the job worker (see worker.js).
import { supabase } from "./supabase.js";

function unwrap({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

export async function claimJobs(workerId, limit) {
  return unwrap(await supabase.rpc("claim_jobs", { p_worker: workerId, p_limit: limit }), "Claim jobs") ?? [];
}

export async function finishJob(jobId, { status, error = null, retryInSeconds = 60 }) {
  const update = { status, locked_at: null, locked_by: null };
  if (status === "SUCCEEDED") update.completed_at = new Date().toISOString();
  if (error) update.last_error = String(error).slice(0, 2000);
  if (status === "PENDING") update.run_at = new Date(Date.now() + retryInSeconds * 1000).toISOString();
  unwrap(await supabase.from("jobs").update(update).eq("id", jobId), "Finish job");
}

export async function loadLead(businessId, leadId) {
  return unwrap(
    await supabase
      .from("leads")
      .select("id, business_id, original_message, conversation_status")
      .eq("id", leadId)
      .eq("business_id", businessId)
      .maybeSingle(),
    "Load lead"
  );
}

export async function loadBusiness(businessId) {
  const business = unwrap(
    await supabase
      .from("businesses")
      .select(
        "id, business_name, industry, business_description, services, pricing_information, business_faq, operating_hours, business_settings ( ai_daily_request_limit, max_inquiry_length )"
      )
      .eq("id", businessId)
      .single(),
    "Load business"
  );
  // business_settings is one-to-one; fall back to the table defaults if it is missing.
  const settings = Array.isArray(business.business_settings)
    ? business.business_settings[0]
    : business.business_settings;
  return {
    ...business,
    settings: { ai_daily_request_limit: 200, max_inquiry_length: 2000, ...(settings ?? {}) },
  };
}

export async function hasCompletedAnalysis(businessId, leadId) {
  const { count, error } = await supabase
    .from("lead_analyses")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("lead_id", leadId)
    .eq("analysis_status", "COMPLETED");
  if (error) throw new Error(`Check analysis: ${error.message}`);
  return count > 0;
}

// "Daily" limit = the last 24 hours, counting failed calls too (they cost tokens).
export async function aiRequestsLast24h(businessId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .gte("created_at", since);
  if (error) throw new Error(`Count AI usage: ${error.message}`);
  return count ?? 0;
}

export async function saveAnalysis(businessId, leadId, interactionId, result) {
  return unwrap(
    await supabase.rpc("save_lead_analysis", {
      p_business_id: businessId,
      p_lead_id: leadId,
      p_interaction_id: interactionId,
      p_result: result,
    }),
    "Save analysis"
  );
}

export async function markLeadNeedsReview(businessId, leadId) {
  unwrap(
    await supabase
      .from("leads")
      .update({ lead_status: "NEEDS_HUMAN_REVIEW" })
      .eq("id", leadId)
      .eq("business_id", businessId),
    "Mark lead"
  );
}

// ---------- email outbox (see outbox.js) ----------

export async function claimOutbox(limit) {
  return unwrap(await supabase.rpc("claim_outbox", { p_limit: limit }), "Claim outbox") ?? [];
}

export async function completeOutbox(
  outboxId,
  { outcome, provider = null, providerMessageId = null, error = null, retrySeconds = null, newTokenHash = null }
) {
  return unwrap(
    await supabase.rpc("complete_outbox", {
      p_outbox_id: outboxId,
      p_outcome: outcome,
      p_provider: provider,
      p_provider_message_id: providerMessageId,
      p_error: error,
      p_retry_seconds: retrySeconds,
      p_new_token_hash: newTokenHash,
    }),
    "Complete outbox"
  );
}

// ---------- recovery (see recovery.js and migration 012) ----------

export async function recoverStuckJobs(staleMinutes) {
  return unwrap(await supabase.rpc("recover_stuck_jobs", { p_stale_minutes: staleMinutes }), "Recover jobs") ?? [];
}

export async function resendUndeliveredCards(staleMinutes) {
  return unwrap(await supabase.rpc("resend_undelivered_cards", { p_stale_minutes: staleMinutes }), "Resend cards") ?? [];
}

export async function expireApprovals(limit = 20) {
  return unwrap(await supabase.rpc("expire_approvals", { p_limit: limit }), "Expire approvals") ?? [];
}

export async function staleOutbox(staleMinutes) {
  return unwrap(await supabase.rpc("stale_outbox", { p_stale_minutes: staleMinutes }), "Find stuck emails") ?? [];
}
