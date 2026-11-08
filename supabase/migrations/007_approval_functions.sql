-- 007_approval_functions.sql
-- Requires 006. Adds: authorize_telegram_actor, create_reply_draft,
-- decide_approval, edit_reply. Only the server (secret key) may call them.
-- Run ONCE in the Supabase SQL Editor.

-- ============================================================
-- 1. Who may act? Returns the member's user id, or NULL.
-- The Telegram user must be linked to an approving member of THIS
-- business, and the tap must come from the business's own chat.
-- ============================================================
create or replace function public.authorize_telegram_actor(
  p_business_id      uuid,
  p_telegram_user_id bigint,
  p_telegram_chat_id bigint
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id
  from public.business_members m
  join public.businesses b on b.id = m.business_id
  where m.business_id = p_business_id
    and m.telegram_user_id = p_telegram_user_id
    and m.role in ('OWNER','ADMIN','STAFF')
    and b.telegram_chat_id = p_telegram_chat_id
    and b.is_active
  limit 1;
$$;

-- ============================================================
-- 2. Create a draft reply + its pending approval in ONE transaction
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
  select * into v_lead
    from public.leads l
   where l.id = p_lead_id and l.business_id = p_business_id;
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
-- 3. Approve or reject: every check and every change in ONE transaction
-- ============================================================
create or replace function public.decide_approval(
  p_token_hash       text,
  p_decision         text,
  p_telegram_user_id bigint,
  p_telegram_chat_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appr     public.message_approvals%rowtype;
  v_msg      public.messages%rowtype;
  v_lead     public.leads%rowtype;
  v_user_id  uuid;
  v_content  text;
  v_delivery text;
begin
  if p_decision not in ('APPROVE','REJECT') then
    raise exception 'Invalid decision' using errcode = '22023';
  end if;

  -- Lock the approval row: two quick taps are handled one after the other
  select * into v_appr
    from public.message_approvals a
   where a.token_hash = p_token_hash
     for update;
  if not found then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;

  v_user_id := public.authorize_telegram_actor(
    v_appr.business_id, p_telegram_user_id, p_telegram_chat_id);
  if v_user_id is null then
    return jsonb_build_object('result', 'FORBIDDEN');
  end if;

  if v_appr.status <> 'PENDING' then
    return jsonb_build_object('result', 'ALREADY_DECIDED', 'status', v_appr.status);
  end if;

  if v_appr.expires_at <= now() then
    update public.message_approvals a set status = 'EXPIRED' where a.id = v_appr.id;
    update public.messages m set status = 'DRAFT'
     where m.id = v_appr.message_id and m.status = 'PENDING_APPROVAL';
    return jsonb_build_object('result', 'EXPIRED');
  end if;

  select * into v_msg
    from public.messages m
   where m.id = v_appr.message_id and m.business_id = v_appr.business_id
     for update;
  if not found then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;

  -- The message must still be on the version this card was made for
  if v_msg.current_version <> v_appr.version_number
     or v_msg.status <> 'PENDING_APPROVAL' then
    update public.message_approvals a set status = 'SUPERSEDED' where a.id = v_appr.id;
    return jsonb_build_object('result', 'STALE');
  end if;

  select * into v_lead
    from public.leads l
   where l.id = v_msg.lead_id and l.business_id = v_msg.business_id;

  if p_decision = 'REJECT' then
    update public.message_approvals a
       set status = 'REJECTED',
           decided_at = now(),
           decided_by_user_id = v_user_id,
           decided_by_telegram_user_id = p_telegram_user_id
     where a.id = v_appr.id;

    update public.messages m set status = 'REJECTED' where m.id = v_msg.id;

    insert into public.activity_logs
      (business_id, lead_id, actor_type, actor_user_id, activity_type, activity_description, metadata)
    values
      (v_msg.business_id, v_lead.id, 'TELEGRAM', v_user_id, 'MESSAGE_REJECTED',
       'Suggested reply rejected via Telegram',
       jsonb_build_object('approval_id', v_appr.id, 'message_id', v_msg.id,
                          'version', v_appr.version_number));

    return jsonb_build_object('result', 'REJECTED');
  end if;

  -- APPROVE: never contact someone who has opted out
  if v_lead.opted_out_at is not null
     or (v_lead.email_normalized is not null and exists (
           select 1
             from public.contact_opt_outs o
            where o.business_id = v_lead.business_id
              and o.channel = 'EMAIL'
              and o.contact_normalized = v_lead.email_normalized)) then
    update public.message_approvals a set status = 'CANCELLED' where a.id = v_appr.id;
    update public.messages m set status = 'CANCELLED' where m.id = v_msg.id;

    insert into public.activity_logs
      (business_id, lead_id, actor_type, actor_user_id, activity_type, activity_description, metadata)
    values
      (v_msg.business_id, v_lead.id, 'SYSTEM', v_user_id, 'MESSAGE_CANCELLED_OPT_OUT',
       'Approval cancelled because the customer opted out',
       jsonb_build_object('approval_id', v_appr.id, 'message_id', v_msg.id));

    return jsonb_build_object('result', 'OPTED_OUT');
  end if;

  select mv.content into v_content
    from public.message_versions mv
   where mv.message_id = v_msg.id and mv.version_number = v_appr.version_number;

  -- Record exactly what was approved, and who approved it
  update public.message_approvals a
     set status = 'APPROVED',
         decided_at = now(),
         decided_by_user_id = v_user_id,
         decided_by_telegram_user_id = p_telegram_user_id,
         approved_content = v_content
   where a.id = v_appr.id;

  -- Transactional outbox: the delivery record is created in the SAME
  -- transaction as the approval, so the two can never disagree.
  if v_lead.email_normalized is not null then
    insert into public.message_outbox
      (business_id, message_id, version_number, channel, recipient, idempotency_key)
    values
      (v_msg.business_id, v_msg.id, v_appr.version_number, 'EMAIL',
       v_lead.email_normalized,
       'msg:' || v_msg.id::text || ':v' || v_appr.version_number::text)
    on conflict on constraint message_outbox_one_per_version do nothing;

    update public.messages m set status = 'QUEUED' where m.id = v_msg.id;
    v_delivery := 'EMAIL_QUEUED';
  else
    -- No email address: do NOT pretend anything was sent
    update public.messages m set status = 'APPROVED' where m.id = v_msg.id;
    update public.leads l set needs_manual_contact = true
     where l.id = v_lead.id and l.business_id = v_lead.business_id;
    v_delivery := 'MANUAL';
  end if;

  insert into public.activity_logs
    (business_id, lead_id, actor_type, actor_user_id, activity_type, activity_description, metadata)
  values
    (v_msg.business_id, v_lead.id, 'TELEGRAM', v_user_id, 'MESSAGE_APPROVED',
     'Reply approved via Telegram',
     jsonb_build_object('approval_id', v_appr.id, 'message_id', v_msg.id,
                        'version', v_appr.version_number, 'delivery', v_delivery));

  return jsonb_build_object('result', 'APPROVED', 'delivery', v_delivery);
end;
$$;

-- ============================================================
-- 4. Edit: new version, old approval cancelled, new approval created
-- ============================================================
create or replace function public.edit_reply(
  p_approval_id      uuid,
  p_new_content      text,
  p_telegram_user_id bigint,
  p_telegram_chat_id bigint,
  p_new_token_hash   text,
  p_expires_at       timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appr            public.message_approvals%rowtype;
  v_msg             public.messages%rowtype;
  v_user_id         uuid;
  v_new_version     integer;
  v_new_approval_id uuid;
begin
  select * into v_appr
    from public.message_approvals a
   where a.id = p_approval_id
     for update;
  if not found then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;

  v_user_id := public.authorize_telegram_actor(
    v_appr.business_id, p_telegram_user_id, p_telegram_chat_id);
  if v_user_id is null then
    return jsonb_build_object('result', 'FORBIDDEN');
  end if;

  if v_appr.status <> 'PENDING' then
    return jsonb_build_object('result', 'ALREADY_DECIDED');
  end if;

  if v_appr.expires_at <= now() then
    update public.message_approvals a set status = 'EXPIRED' where a.id = v_appr.id;
    update public.messages m set status = 'DRAFT'
     where m.id = v_appr.message_id and m.status = 'PENDING_APPROVAL';
    return jsonb_build_object('result', 'EXPIRED');
  end if;

  select * into v_msg
    from public.messages m
   where m.id = v_appr.message_id and m.business_id = v_appr.business_id
     for update;
  if not found then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;

  if v_msg.current_version <> v_appr.version_number
     or v_msg.status <> 'PENDING_APPROVAL' then
    return jsonb_build_object('result', 'STALE');
  end if;

  v_new_version := v_msg.current_version + 1;

  -- Old approval can never be used again
  update public.message_approvals a set status = 'SUPERSEDED' where a.id = v_appr.id;

  insert into public.message_versions
    (business_id, message_id, version_number, content, authored_by, edited_by_user_id)
  values
    (v_msg.business_id, v_msg.id, v_new_version, btrim(p_new_content), 'OWNER', v_user_id);

  update public.messages m set current_version = v_new_version where m.id = v_msg.id;

  insert into public.message_approvals
    (business_id, message_id, version_number, token_hash, expires_at, telegram_chat_id)
  values
    (v_msg.business_id, v_msg.id, v_new_version, p_new_token_hash, p_expires_at,
     v_appr.telegram_chat_id)
  returning id into v_new_approval_id;

  insert into public.activity_logs
    (business_id, lead_id, actor_type, actor_user_id, activity_type, activity_description, metadata)
  values
    (v_msg.business_id, v_msg.lead_id, 'TELEGRAM', v_user_id, 'MESSAGE_EDITED',
     'Reply edited via Telegram; a new approval is required',
     jsonb_build_object('message_id', v_msg.id, 'version', v_new_version));

  return jsonb_build_object(
    'result', 'EDITED',
    'new_approval_id', v_new_approval_id,
    'message_id', v_msg.id,
    'lead_id', v_msg.lead_id,
    'version', v_new_version);
end;
$$;

-- ============================================================
-- 5. Only the server (secret key) may call these
-- ============================================================
revoke execute on function public.authorize_telegram_actor(uuid, bigint, bigint)
  from public, anon, authenticated;
revoke execute on function public.create_reply_draft(uuid, uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.decide_approval(text, text, bigint, bigint)
  from public, anon, authenticated;
revoke execute on function public.edit_reply(uuid, text, bigint, bigint, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.authorize_telegram_actor(uuid, bigint, bigint) to service_role;
grant execute on function public.create_reply_draft(uuid, uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.decide_approval(text, text, bigint, bigint) to service_role;
grant execute on function public.edit_reply(uuid, text, bigint, bigint, text, timestamptz) to service_role;
