-- 009_intake.sql
-- Requires 008. Safe to run more than once.
-- Adds:
--   intake_submission()  save a website-form lead + queue its analysis (one transaction)
--   save_lead_analysis() save an AI result + usage + lead summary (one transaction)
-- Only the server (secret key) may call them.

-- ============================================================
-- 1. intake_submission
-- The business is resolved from the form's PUBLIC identifier, never
-- from anything else the caller sends. Inputs are already validated
-- and normalized by the backend; table constraints check them again.
-- Results: CREATED | DUPLICATE_SUBMISSION | NOT_FOUND
-- ============================================================
create or replace function public.intake_submission(
  p_public_identifier text,
  p_external_id       text,
  p_full_name         text,
  p_email             text,
  p_email_normalized  text,
  p_phone             text,
  p_phone_normalized  text,
  p_message           text,
  p_content_hash      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id    uuid;
  v_window_hours   integer;
  v_duplicate_of   uuid;
  v_lead_id        uuid;
  v_interaction_id uuid;
  v_job_id         uuid;
  v_rows           integer;
begin
  select i.business_id into v_business_id
    from public.business_integrations i
    join public.businesses b on b.id = i.business_id
   where i.public_identifier = p_public_identifier
     and i.provider = 'WEBSITE_FORM'
     and i.is_active
     and b.is_active;
  if v_business_id is null then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;

  -- One submission at a time per business, so the duplicate checks below are reliable
  perform pg_advisory_xact_lock(hashtextextended('intake:' || v_business_id::text, 0));

  update public.business_integrations i
     set last_used_at = now()
   where i.public_identifier = p_public_identifier;

  -- Replay protection 1: the form's own submission id (e.g. a double-click or a retry)
  if p_external_id is not null then
    insert into public.webhook_events
      (business_id, provider, external_event_id, event_type, processing_status, processed_at)
    values
      (v_business_id, 'WEBSITE_FORM', p_external_id, 'form_submission', 'PROCESSED', now())
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      return jsonb_build_object('result', 'DUPLICATE_SUBMISSION');
    end if;
  end if;

  -- Replay protection 2: same message from the same contact within 10 minutes
  if exists (
    select 1
      from public.lead_interactions li
      join public.leads l on l.id = li.lead_id and l.business_id = li.business_id
     where li.business_id = v_business_id
       and li.content_hash = p_content_hash
       and li.received_at > now() - interval '10 minutes'
       and ((p_email_normalized is not null and l.email_normalized = p_email_normalized)
         or (p_phone_normalized is not null and l.phone_normalized = p_phone_normalized))
  ) then
    return jsonb_build_object('result', 'DUPLICATE_SUBMISSION');
  end if;

  -- Possible duplicate: same contact recently. Flagged for review, never merged.
  select coalesce(
           (select s.duplicate_window_hours from public.business_settings s
             where s.business_id = v_business_id), 72)
    into v_window_hours;

  select coalesce(l.duplicate_of, l.id) into v_duplicate_of
    from public.leads l
   where l.business_id = v_business_id
     and l.created_at > now() - make_interval(hours => v_window_hours)
     and ((p_email_normalized is not null and l.email_normalized = p_email_normalized)
       or (p_phone_normalized is not null and l.phone_normalized = p_phone_normalized))
   order by l.created_at desc
   limit 1;

  insert into public.leads
    (business_id, full_name, email, email_normalized, phone, phone_normalized,
     source, original_message, consent_to_contact, duplicate_of, duplicate_review_status)
  values
    (v_business_id, btrim(p_full_name), p_email, p_email_normalized, p_phone, p_phone_normalized,
     'WEBSITE_FORM', p_message, true, v_duplicate_of,
     case when v_duplicate_of is null then 'NONE' else 'POSSIBLE' end)
  returning id into v_lead_id;

  insert into public.lead_interactions
    (business_id, lead_id, source, external_submission_id, message_text, content_hash)
  values
    (v_business_id, v_lead_id, 'WEBSITE_FORM', p_external_id, p_message, p_content_hash)
  returning id into v_interaction_id;

  insert into public.jobs
    (business_id, lead_id, job_type, payload, dedupe_key, max_attempts)
  values
    (v_business_id, v_lead_id, 'ANALYZE_LEAD',
     jsonb_build_object('lead_id', v_lead_id, 'interaction_id', v_interaction_id),
     'analyze:' || v_lead_id::text, 3)
  returning id into v_job_id;

  -- No personal data in the audit metadata
  insert into public.activity_logs
    (business_id, lead_id, actor_type, activity_type, activity_description, metadata)
  values
    (v_business_id, v_lead_id, 'WEBHOOK', 'LEAD_RECEIVED',
     'New lead received from the website form',
     jsonb_build_object('interaction_id', v_interaction_id,
                        'possible_duplicate', v_duplicate_of is not null));

  return jsonb_build_object('result', 'CREATED', 'lead_id', v_lead_id, 'job_id', v_job_id);
end;
$$;

-- ============================================================
-- 2. save_lead_analysis
-- p_result is the object returned by analyzeInquiry() in the backend.
-- ============================================================
create or replace function public.save_lead_analysis(
  p_business_id    uuid,
  p_lead_id        uuid,
  p_interaction_id uuid,
  p_result         jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status      text  := p_result->>'status';
  v_a           jsonb := p_result->'analysis';
  v_human       boolean;
  v_analysis_id uuid;
begin
  if v_status is null or v_status not in ('COMPLETED','FAILED') then
    raise exception 'Invalid analysis status' using errcode = '22023';
  end if;

  perform 1 from public.leads l
   where l.id = p_lead_id and l.business_id = p_business_id
     for update;
  if not found then
    raise exception 'Lead not found for this business' using errcode = 'P0002';
  end if;

  v_human := coalesce((v_a->>'needs_human_review')::boolean, false);

  insert into public.lead_analyses
    (business_id, lead_id, interaction_id, analysis_status, intent, lead_score, score_reason,
     urgency, detected_language, customer_needs, missing_information, suggested_reply,
     confidence_level, needs_human_review, escalation_reason, provider, model_used,
     prompt_version, error_message)
  values
    (p_business_id, p_lead_id, p_interaction_id, v_status,
     v_a->>'intent', v_a->>'lead_score', nullif(v_a->>'score_reason', ''),
     v_a->>'urgency', v_a->>'detected_language',
     coalesce(v_a->'customer_needs', '[]'::jsonb),
     coalesce(v_a->'missing_information', '[]'::jsonb),
     nullif(v_a->>'suggested_reply', ''),
     v_a->>'confidence_level', v_human, nullif(v_a->>'escalation_reason', ''),
     coalesce(p_result->>'provider', 'unknown'), coalesce(p_result->>'model', 'unknown'),
     p_result->>'promptVersion', left(p_result->>'errorMessage', 2000))
  returning id into v_analysis_id;

  insert into public.ai_usage
    (business_id, lead_id, provider, model, request_type, prompt_tokens, completion_tokens,
     total_tokens, duration_ms, success, error_code)
  values
    (p_business_id, p_lead_id,
     coalesce(p_result->>'provider', 'unknown'), coalesce(p_result->>'model', 'unknown'),
     'LEAD_ANALYSIS',
     (p_result->'usage'->>'prompt_tokens')::integer,
     (p_result->'usage'->>'completion_tokens')::integer,
     (p_result->'usage'->>'total_tokens')::integer,
     (p_result->>'durationMs')::integer,
     v_status = 'COMPLETED',
     case when v_status = 'FAILED' then 'ANALYSIS_FAILED' end);

  if v_status = 'COMPLETED' then
    update public.leads l
       set lead_score         = v_a->>'lead_score',
           lead_intent        = v_a->>'intent',
           preferred_language = v_a->>'detected_language',
           lead_status        = case when v_human then 'NEEDS_HUMAN_REVIEW' else 'ANALYZED' end
     where l.id = p_lead_id and l.business_id = p_business_id;
  else
    update public.leads l
       set lead_status = 'FAILED'
     where l.id = p_lead_id and l.business_id = p_business_id;
  end if;

  insert into public.activity_logs
    (business_id, lead_id, actor_type, activity_type, activity_description, metadata)
  values
    (p_business_id, p_lead_id, 'AI',
     case when v_status = 'COMPLETED' then 'LEAD_ANALYZED' else 'LEAD_ANALYSIS_FAILED' end,
     case when v_status = 'COMPLETED' then 'AI analysis completed' else 'AI analysis failed' end,
     jsonb_build_object('analysis_id', v_analysis_id, 'needs_human_review', v_human));

  return v_analysis_id;
end;
$$;

-- ============================================================
-- 3. Only the server (secret key) may call these
-- ============================================================
revoke execute on function public.intake_submission(text, text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.save_lead_analysis(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.intake_submission(text, text, text, text, text, text, text, text, text)
  to service_role;
grant execute on function public.save_lead_analysis(uuid, uuid, uuid, jsonb)
  to service_role;
