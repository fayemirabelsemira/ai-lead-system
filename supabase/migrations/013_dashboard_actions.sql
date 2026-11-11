-- 013_dashboard_actions.sql
-- Requires 012. Safe to re-run.
-- Lets a SIGNED-IN owner / admin / staff member act on replies from the
-- dashboard (the Telegram buttons keep working as before):
--   dashboard_decide_reply(message, APPROVE|REJECT, edited text?)
--   dashboard_send_reply(lead, text)       write your own reply
--   dashboard_mark_sent(message)           "I sent it" for hand delivery
-- Every function checks the caller's role in the row's OWN business
-- (auth.uid()), never a business id passed in by the browser.
-- Delivery follows the same rules as Telegram approvals (010): opted-out
-- customers are never contacted; email only when the business has it on.
-- Outcome and notes are plain column updates already allowed by 008 + RLS.

-- ============================================================
-- Helpers (not callable from the browser)
-- ============================================================
create or replace function public.dashboard_actor(p_business_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id
    from public.business_members m
   where m.business_id = p_business_id
     and m.user_id = (select auth.uid())
     and m.role in ('OWNER','ADMIN','STAFF')
   limit 1;
$$;

-- A token nobody knows: approvals made in the dashboard never need one,
-- but the column is required and unique.
create or replace function public.unusable_token_hash()
returns text
language sql
volatile
set search_path = ''
as $$
  select encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text || random()::text, 'UTF8')), 'hex');
$$;

-- Approves one PENDING approval and delivers it. The caller has already
-- locked the approval and the message and checked who is acting.
create or replace function public.approve_and_deliver(p_approval_id uuid, p_user_id uuid, p_description text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appr          public.message_approvals%rowtype;
  v_msg           public.messages%rowtype;
  v_lead          public.leads%rowtype;
  v_content       text;
  v_delivery      text;
  v_email_enabled boolean;
begin
  select * into v_appr from public.message_approvals a where a.id = p_approval_id;
  select * into v_msg from public.messages m where m.id = v_appr.message_id and m.business_id = v_appr.business_id;
  select * into v_lead from public.leads l where l.id = v_msg.lead_id and l.business_id = v_msg.business_id;

  -- Never contact someone who has opted out
  if v_lead.opted_out_at is not null
     or (v_lead.email_normalized is not null and exists (
           select 1 from public.contact_opt_outs o
            where o.business_id = v_lead.business_id and o.channel = 'EMAIL'
              and o.contact_normalized = v_lead.email_normalized)) then
    update public.message_approvals a set status = 'CANCELLED' where a.id = v_appr.id;
    update public.messages m set status = 'CANCELLED' where m.id = v_msg.id;
    insert into public.activity_logs
      (business_id, lead_id, actor_type, actor_user_id, activity_type, activity_description, metadata)
    values
      (v_msg.business_id, v_lead.id, 'SYSTEM', p_user_id, 'MESSAGE_CANCELLED_OPT_OUT',
       'Reply cancelled because the customer opted out',
       jsonb_build_object('approval_id', v_appr.id, 'message_id', v_msg.id));
    return jsonb_build_object('result', 'OPTED_OUT');
  end if;

  select mv.content into v_content
    from public.message_versions mv
   where mv.message_id = v_msg.id and mv.version_number = v_appr.version_number;

  update public.message_approvals a
     set status = 'APPROVED', decided_at = now(), decided_by_user_id = p_user_id, approved_content = v_content
   where a.id = v_appr.id;

  select coalesce((select s.email_delivery_enabled from public.business_settings s
                    where s.business_id = v_msg.business_id), false)
    into v_email_enabled;

  if v_lead.email_normalized is not null and v_email_enabled then
    insert into public.message_outbox
      (business_id, message_id, version_number, channel, recipient, idempotency_key)
    values
      (v_msg.business_id, v_msg.id, v_appr.version_number, 'EMAIL', v_lead.email_normalized,
       'msg:' || v_msg.id::text || ':v' || v_appr.version_number::text)
    on conflict on constraint message_outbox_one_per_version do nothing;
    update public.messages m set status = 'QUEUED', channel = 'EMAIL' where m.id = v_msg.id;
    update public.leads l set needs_manual_contact = false
     where l.id = v_lead.id and l.business_id = v_lead.business_id;
    v_delivery := 'EMAIL_QUEUED';
  else
    update public.messages m set status = 'APPROVED', channel = 'MANUAL' where m.id = v_msg.id;
    update public.leads l set needs_manual_contact = true
     where l.id = v_lead.id and l.business_id = v_lead.business_id;
    v_delivery := 'MANUAL';
  end if;

  insert into public.activity_logs
    (business_id, lead_id, actor_type, actor_user_id, activity_type, activity_description, metadata)
  values
    (v_msg.business_id, v_lead.id, 'USER', p_user_id, 'MESSAGE_APPROVED', p_description,
     jsonb_build_object('approval_id', v_appr.id, 'message_id', v_msg.id,
                        'version', v_appr.version_number, 'delivery', v_delivery));

  return jsonb_build_object('result', 'APPROVED', 'delivery', v_delivery, 'content', v_content);
end;
$$;

-- ============================================================
-- 1. Approve (optionally edited) or reject the AI's reply
-- Results: APPROVED (+delivery) | REJECTED | OPTED_OUT | EXPIRED |
--          ALREADY_DECIDED | FORBIDDEN | NOT_FOUND
-- ============================================================
create or replace function public.dashboard_decide_reply(
  p_message_id uuid,
  p_decision   text,
  p_content    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg_business uuid;
  v_appr     public.message_approvals%rowtype;
  v_msg      public.messages%rowtype;
  v_user_id  uuid;
  v_current  text;
  v_new_ver  integer;
  v_new_appr uuid;
  v_text     text := nullif(btrim(coalesce(p_content, '')), '');
begin
  if p_decision not in ('APPROVE','REJECT') then
    raise exception 'Invalid decision' using errcode = '22023';
  end if;
  if v_text is not null and char_length(v_text) > 5000 then
    raise exception 'The reply is too long (max 5000 characters)' using errcode = '22023';
  end if;

  select m.business_id into v_msg_business from public.messages m where m.id = p_message_id;
  if not found then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;
  v_user_id := public.dashboard_actor(v_msg_business);
  if v_user_id is null then
    return jsonb_build_object('result', 'FORBIDDEN');
  end if;

  -- Same lock order as Telegram (approval, then message): no deadlocks.
  select a.* into v_appr
    from public.message_approvals a
   where a.message_id = p_message_id and a.business_id = v_msg_business and a.status = 'PENDING'
   order by a.version_number desc
   limit 1
     for update;
  if not found then
    return jsonb_build_object('result', 'ALREADY_DECIDED');
  end if;

  select * into v_msg from public.messages m where m.id = p_message_id for update;
  if v_msg.status <> 'PENDING_APPROVAL' or v_msg.current_version <> v_appr.version_number then
    return jsonb_build_object('result', 'ALREADY_DECIDED');
  end if;

  if v_appr.expires_at <= now() then
    update public.message_approvals a set status = 'EXPIRED' where a.id = v_appr.id;
    update public.messages m set status = 'DRAFT' where m.id = v_msg.id;
    update public.leads l set needs_manual_contact = true where l.id = v_msg.lead_id and l.business_id = v_msg.business_id;
    return jsonb_build_object('result', 'EXPIRED');
  end if;

  if p_decision = 'REJECT' then
    update public.message_approvals a
       set status = 'REJECTED', decided_at = now(), decided_by_user_id = v_user_id
     where a.id = v_appr.id;
    update public.messages m set status = 'REJECTED' where m.id = v_msg.id;
    -- Nothing will be sent: the lead now needs a reply written by a person.
    update public.leads l set needs_manual_contact = true
     where l.id = v_msg.lead_id and l.business_id = v_msg.business_id;
    insert into public.activity_logs
      (business_id, lead_id, actor_type, actor_user_id, activity_type, activity_description, metadata)
    values
      (v_msg.business_id, v_msg.lead_id, 'USER', v_user_id, 'MESSAGE_REJECTED',
       'Suggested reply rejected in the dashboard',
       jsonb_build_object('approval_id', v_appr.id, 'message_id', v_msg.id));
    return jsonb_build_object('result', 'REJECTED');
  end if;

  -- Edited before approving: save the new text as a new version first.
  select mv.content into v_current
    from public.message_versions mv
   where mv.message_id = v_msg.id and mv.version_number = v_appr.version_number;

  if v_text is not null and v_text <> btrim(v_current) then
    v_new_ver := v_msg.current_version + 1;
    update public.message_approvals a set status = 'SUPERSEDED' where a.id = v_appr.id;
    insert into public.message_versions
      (business_id, message_id, version_number, content, authored_by, edited_by_user_id)
    values (v_msg.business_id, v_msg.id, v_new_ver, v_text, 'OWNER', v_user_id);
    update public.messages m set current_version = v_new_ver where m.id = v_msg.id;
    insert into public.message_approvals
      (business_id, message_id, version_number, token_hash, expires_at, telegram_chat_id)
    values (v_msg.business_id, v_msg.id, v_new_ver, public.unusable_token_hash(), v_appr.expires_at, v_appr.telegram_chat_id)
    returning id into v_new_appr;
    insert into public.activity_logs
      (business_id, lead_id, actor_type, actor_user_id, activity_type, activity_description, metadata)
    values
      (v_msg.business_id, v_msg.lead_id, 'USER', v_user_id, 'MESSAGE_EDITED', 'Reply edited in the dashboard',
       jsonb_build_object('message_id', v_msg.id, 'version', v_new_ver));
    return public.approve_and_deliver(v_new_appr, v_user_id, 'Edited reply approved in the dashboard');
  end if;

  return public.approve_and_deliver(v_appr.id, v_user_id, 'Reply approved in the dashboard');
end;
$$;

-- ============================================================
-- 2. Write your own reply (lead has no reply waiting or sent)
-- Results: APPROVED (+delivery) | OPTED_OUT | HAS_REPLY | FORBIDDEN | NOT_FOUND
-- ============================================================
create or replace function public.dashboard_send_reply(p_lead_id uuid, p_content text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead     public.leads%rowtype;
  v_user_id  uuid;
  v_msg_id   uuid;
  v_appr_id  uuid;
  v_text     text := btrim(coalesce(p_content, ''));
begin
  if char_length(v_text) not between 1 and 5000 then
    raise exception 'Write a reply (1 to 5000 characters)' using errcode = '22023';
  end if;

  select l.* into v_lead from public.leads l where l.id = p_lead_id;
  if not found then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;
  v_user_id := public.dashboard_actor(v_lead.business_id);
  if v_user_id is null then
    return jsonb_build_object('result', 'FORBIDDEN');
  end if;

  -- Lock the lead (same as create_reply_draft) so two replies cannot be made at once.
  select l.* into v_lead from public.leads l where l.id = p_lead_id for update;

  if exists (
    select 1 from public.messages m
     where m.lead_id = v_lead.id and m.business_id = v_lead.business_id and m.kind = 'FIRST_REPLY'
       and m.status in ('PENDING_APPROVAL','APPROVED','QUEUED','SENDING','SENT','DELIVERED')
  ) then
    return jsonb_build_object('result', 'HAS_REPLY');
  end if;

  insert into public.messages (business_id, lead_id, direction, channel, kind, status)
  values (v_lead.business_id, v_lead.id, 'OUTBOUND',
          case when v_lead.email_normalized is not null then 'EMAIL' else 'MANUAL' end,
          'FIRST_REPLY', 'PENDING_APPROVAL')
  returning id into v_msg_id;

  insert into public.message_versions (business_id, message_id, version_number, content, authored_by, edited_by_user_id)
  values (v_lead.business_id, v_msg_id, 1, v_text, 'OWNER', v_user_id);

  insert into public.message_approvals (business_id, message_id, version_number, token_hash, expires_at)
  values (v_lead.business_id, v_msg_id, 1, public.unusable_token_hash(), now() + interval '1 day')
  returning id into v_appr_id;

  return public.approve_and_deliver(v_appr_id, v_user_id, 'Reply written and approved in the dashboard');
end;
$$;

-- ============================================================
-- 3. "I sent it": an approved hand-delivery reply was sent
-- Results: SENT | ALREADY_SENT | NOT_SENDABLE | FORBIDDEN | NOT_FOUND
-- ============================================================
create or replace function public.dashboard_mark_sent(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg     public.messages%rowtype;
  v_user_id uuid;
begin
  select * into v_msg from public.messages m where m.id = p_message_id;
  if not found then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;
  v_user_id := public.dashboard_actor(v_msg.business_id);
  if v_user_id is null then
    return jsonb_build_object('result', 'FORBIDDEN');
  end if;

  select * into v_msg from public.messages m where m.id = p_message_id for update;
  if v_msg.status = 'SENT' then
    return jsonb_build_object('result', 'ALREADY_SENT');
  end if;
  if v_msg.status <> 'APPROVED' or v_msg.channel <> 'MANUAL' then
    return jsonb_build_object('result', 'NOT_SENDABLE');
  end if;

  update public.messages m set status = 'SENT', sent_at = now() where m.id = v_msg.id;
  update public.leads l
     set conversation_status = 'MESSAGE_SENT', needs_manual_contact = false,
         last_contact_at = greatest(now(), l.first_contact_at)
   where l.id = v_msg.lead_id and l.business_id = v_msg.business_id;
  insert into public.activity_logs
    (business_id, lead_id, actor_type, actor_user_id, activity_type, activity_description, metadata)
  values
    (v_msg.business_id, v_msg.lead_id, 'USER', v_user_id, 'MESSAGE_SENT_MANUALLY',
     'Owner confirmed in the dashboard that the reply was sent by hand',
     jsonb_build_object('message_id', v_msg.id));
  return jsonb_build_object('result', 'SENT');
end;
$$;

-- ============================================================
-- Permissions: the three actions for signed-in users; helpers for nobody
-- ============================================================
revoke execute on function public.dashboard_actor(uuid)                     from public, anon, authenticated;
revoke execute on function public.unusable_token_hash()                     from public, anon, authenticated;
revoke execute on function public.approve_and_deliver(uuid, uuid, text)     from public, anon, authenticated;
revoke execute on function public.dashboard_decide_reply(uuid, text, text)  from public, anon;
revoke execute on function public.dashboard_send_reply(uuid, text)          from public, anon;
revoke execute on function public.dashboard_mark_sent(uuid)                 from public, anon;
grant  execute on function public.dashboard_decide_reply(uuid, text, text)  to authenticated;
grant  execute on function public.dashboard_send_reply(uuid, text)          to authenticated;
grant  execute on function public.dashboard_mark_sent(uuid)                 to authenticated;
