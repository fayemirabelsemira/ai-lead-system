-- 008_harden_grants_and_drafts.sql
-- Requires 007. Safe to run more than once.
--
-- 1. Supabase's default privileges grant ALL on new public tables to
--    `authenticated`. Column-level grants in 001-005 do nothing while a
--    table-level grant exists, so we revoke everything and re-grant
--    exactly what the earlier migrations intended.
--    (Revoking a table privilege also revokes its column privileges.)
-- 2. create_reply_draft: refuses a second live first reply for a lead.
-- 3. cancel_reply_draft: undoes a draft whose Telegram card never arrived.
--
-- Check BEFORE and AFTER running with:
--   select table_name, privilege_type
--     from information_schema.role_table_grants
--    where grantee = 'authenticated' and table_schema = 'public'
--    order by 1, 2;
-- After: only SELECT (and INSERT on analysis_corrections) should be
-- listed; column-level UPDATEs show in information_schema.column_privileges.

-- ============================================================
-- 1. Grants for logged-in dashboard users
-- ============================================================
revoke all on
  public.businesses, public.business_members,
  public.leads, public.lead_interactions, public.lead_analyses, public.analysis_corrections,
  public.messages, public.message_versions, public.message_approvals, public.message_outbox,
  public.webhook_events, public.jobs, public.follow_up_tasks,
  public.activity_logs, public.ai_usage, public.business_settings,
  public.business_integrations, public.contact_opt_outs
from authenticated, anon;

-- 001
grant select on public.businesses to authenticated;
grant update (
  business_name, industry, business_description, business_email,
  business_phone, business_timezone, telegram_chat_id, business_faq,
  services, pricing_information, operating_hours
) on public.businesses to authenticated;
grant select, insert, delete on public.business_members to authenticated;
grant update (role, telegram_user_id) on public.business_members to authenticated;

-- 002
grant select on public.leads, public.lead_interactions, public.lead_analyses,
                public.analysis_corrections to authenticated;
grant insert on public.analysis_corrections to authenticated;
grant update (outcome, follow_ups_paused, internal_notes) on public.leads to authenticated;

-- 003 (approval token hash and Telegram identifiers stay hidden)
grant select on public.messages, public.message_versions, public.message_outbox to authenticated;
grant select (id, business_id, message_id, version_number, status, expires_at,
              decided_at, decided_by_user_id, approved_content, created_at)
  on public.message_approvals to authenticated;

-- 004
grant select on public.webhook_events, public.jobs, public.follow_up_tasks to authenticated;

-- 005 (secret_reference stays hidden)
grant select on public.activity_logs, public.ai_usage, public.business_settings,
                public.contact_opt_outs to authenticated;
grant select (id, business_id, provider, public_identifier, is_active,
              last_used_at, created_at, updated_at)
  on public.business_integrations to authenticated;
grant update (follow_ups_enabled, follow_up_1_delay_minutes, follow_up_2_delay_minutes,
              max_follow_ups, respect_operating_hours, approval_expiry_hours,
              duplicate_window_hours, ai_daily_request_limit, max_inquiry_length)
  on public.business_settings to authenticated;

-- ============================================================
-- 2. create_reply_draft: at most one live first reply per lead
-- ============================================================
create or replace function public.create_reply_draft(
  p_business_id uuid,
  p_lead_id     uuid,
  p_analysis_id uuid,
  p_content     text,
  p_token_hash  text,
  p_expires_at  timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead        public.leads%rowtype;
  v_chat        bigint;
  v_channel     text;
  v_message_id  uuid;
  v_approval_id uuid;
begin
  -- Lock the lead: two concurrent calls for the same lead run one at a time
  select * into v_lead
    from public.leads l
   where l.id = p_lead_id and l.business_id = p_business_id
     for update;
  if not found then
    raise exception 'Lead not found for this business' using errcode = 'P0002';
  end if;

  select b.telegram_chat_id into v_chat
    from public.businesses b
   where b.id = p_business_id;
  if v_chat is null then
    raise exception 'Business has no Telegram chat configured' using errcode = 'P0001';
  end if;

  if p_expires_at <= now() then
    raise exception 'Approval expiry must be in the future' using errcode = 'P0001';
  end if;

  -- Approvals that ran out without anyone tapping them no longer block a new card
  with expired as (
    update public.message_approvals a
       set status = 'EXPIRED'
      from public.messages m
     where a.message_id = m.id
       and m.lead_id = p_lead_id and m.business_id = p_business_id
       and m.kind = 'FIRST_REPLY'
       and a.status = 'PENDING' and a.expires_at <= now()
    returning a.message_id
  )
  update public.messages m
     set status = 'DRAFT'
   where m.id in (select message_id from expired) and m.status = 'PENDING_APPROVAL';

  if exists (
    select 1 from public.messages m
     where m.lead_id = p_lead_id and m.business_id = p_business_id
       and m.kind = 'FIRST_REPLY'
       and m.status in ('PENDING_APPROVAL','APPROVED','QUEUED','SENDING','SENT','DELIVERED')
  ) then
    raise exception 'This lead already has a reply waiting for approval or already sent'
      using errcode = 'P0001';
  end if;

  v_channel := case when v_lead.email_normalized is not null then 'EMAIL' else 'MANUAL' end;

  insert into public.messages
    (business_id, lead_id, analysis_id, direction, channel, kind, status)
  values
    (p_business_id, p_lead_id, p_analysis_id, 'OUTBOUND', v_channel, 'FIRST_REPLY', 'PENDING_APPROVAL')
  returning id into v_message_id;

  insert into public.message_versions
    (business_id, message_id, version_number, content, authored_by)
  values
    (p_business_id, v_message_id, 1, btrim(p_content), 'AI');

  insert into public.message_approvals
    (business_id, message_id, version_number, token_hash, expires_at, telegram_chat_id)
  values
    (p_business_id, v_message_id, 1, p_token_hash, p_expires_at, v_chat)
  returning id into v_approval_id;

  update public.leads l
     set conversation_status = 'WAITING_FOR_APPROVAL'
   where l.id = p_lead_id and l.business_id = p_business_id;

  insert into public.activity_logs
    (business_id, lead_id, actor_type, activity_type, activity_description, metadata)
  values
    (p_business_id, p_lead_id, 'SYSTEM', 'REPLY_DRAFTED',
     'AI reply drafted and sent to the owner for approval',
     jsonb_build_object('message_id', v_message_id, 'approval_id', v_approval_id));

  return jsonb_build_object('message_id', v_message_id, 'approval_id', v_approval_id);
end;
$$;

-- ============================================================
-- 3. cancel_reply_draft: the Telegram card could not be delivered
-- Only a still-PENDING approval that never got a card can be cancelled.
-- ============================================================
create or replace function public.cancel_reply_draft(p_approval_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appr public.message_approvals%rowtype;
  v_lead_id uuid;
begin
  select * into v_appr
    from public.message_approvals a
   where a.id = p_approval_id
     for update;
  if not found or v_appr.status <> 'PENDING' or v_appr.telegram_message_id is not null then
    return false;
  end if;

  update public.message_approvals a set status = 'CANCELLED' where a.id = v_appr.id;

  update public.messages m set status = 'CANCELLED'
   where m.id = v_appr.message_id and m.business_id = v_appr.business_id
  returning m.lead_id into v_lead_id;

  update public.leads l set conversation_status = 'NEW'
   where l.id = v_lead_id and l.business_id = v_appr.business_id
     and l.conversation_status = 'WAITING_FOR_APPROVAL';

  insert into public.activity_logs
    (business_id, lead_id, actor_type, activity_type, activity_description, metadata)
  values
    (v_appr.business_id, v_lead_id, 'SYSTEM', 'REPLY_DRAFT_CANCELLED',
     'Approval card could not be delivered to Telegram; draft cancelled',
     jsonb_build_object('approval_id', v_appr.id, 'message_id', v_appr.message_id));

  return true;
end;
$$;

revoke execute on function public.create_reply_draft(uuid, uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.cancel_reply_draft(uuid)
  from public, anon, authenticated;
grant execute on function public.create_reply_draft(uuid, uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.cancel_reply_draft(uuid) to service_role;
