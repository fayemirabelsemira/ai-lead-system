-- 010_manual_delivery.sql
-- Requires 009. Safe to run more than once.
--
-- Copy-and-send delivery: after approval the owner sends the reply
-- themselves (SMS / Viber / Messenger / email) and taps "I sent it".
--   * business_settings.email_delivery_enabled (default OFF): approved
--     replies are only queued for automatic email when this is on.
--     While it is off, every approval is manual, so a reply can never be
--     sent twice (once by hand, once by a future email worker).
--   * decide_approval(): honours the setting and returns the approved
--     text and lead id so the bot can show it for copying.
--   * mark_message_sent(): records that the owner sent it.

-- ============================================================
-- 1. Setting
-- ============================================================
alter table public.business_settings
  add column if not exists email_delivery_enabled boolean not null default false;

grant update (email_delivery_enabled) on public.business_settings to authenticated;

-- ============================================================
-- 2. decide_approval (same as 007, plus the setting and a richer result)
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
  v_appr          public.message_approvals%rowtype;
  v_msg           public.messages%rowtype;
  v_lead          public.leads%rowtype;
  v_user_id       uuid;
  v_content       text;
  v_delivery      text;
  v_email_enabled boolean;
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

  select coalesce(
           (select s.email_delivery_enabled from public.business_settings s
             where s.business_id = v_msg.business_id), false)
    into v_email_enabled;

  if v_lead.email_normalized is not null and v_email_enabled then
    -- Transactional outbox: the delivery record is created in the SAME
    -- transaction as the approval, so the two can never disagree.
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
    -- The owner sends it by hand, then taps "I sent it"
    update public.messages m set status = 'APPROVED', channel = 'MANUAL' where m.id = v_msg.id;
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

  return jsonb_build_object(
    'result', 'APPROVED',
    'delivery', v_delivery,
    'lead_id', v_lead.id,
    'content', v_content);
end;
$$;

-- ============================================================
-- 3. mark_message_sent: the owner sent an approved reply by hand
-- Results: SENT | ALREADY_SENT | NOT_SENDABLE | FORBIDDEN | NOT_FOUND
-- ============================================================
create or replace function public.mark_message_sent(
  p_token_hash       text,
  p_telegram_user_id bigint,
  p_telegram_chat_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appr    public.message_approvals%rowtype;
  v_msg     public.messages%rowtype;
  v_user_id uuid;
begin
  select * into v_appr
    from public.message_approvals a
   where a.token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;

  v_user_id := public.authorize_telegram_actor(
    v_appr.business_id, p_telegram_user_id, p_telegram_chat_id);
  if v_user_id is null then
    return jsonb_build_object('result', 'FORBIDDEN');
  end if;

  select * into v_msg
    from public.messages m
   where m.id = v_appr.message_id and m.business_id = v_appr.business_id
     for update;
  if not found then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;

  if v_msg.status = 'SENT' then
    return jsonb_build_object('result', 'ALREADY_SENT');
  end if;
  -- Only an approved, hand-delivered reply of THIS version can be marked sent
  if v_appr.status <> 'APPROVED' or v_msg.status <> 'APPROVED' or v_msg.channel <> 'MANUAL'
     or v_msg.current_version <> v_appr.version_number then
    return jsonb_build_object('result', 'NOT_SENDABLE');
  end if;

  update public.messages m
     set status = 'SENT', sent_at = now()
   where m.id = v_msg.id;

  update public.leads l
     set conversation_status  = 'MESSAGE_SENT',
         needs_manual_contact = false,
         last_contact_at      = greatest(now(), l.first_contact_at)
   where l.id = v_msg.lead_id and l.business_id = v_msg.business_id;

  insert into public.activity_logs
    (business_id, lead_id, actor_type, actor_user_id, activity_type, activity_description, metadata)
  values
    (v_msg.business_id, v_msg.lead_id, 'TELEGRAM', v_user_id, 'MESSAGE_SENT_MANUALLY',
     'Owner confirmed the approved reply was sent by hand',
     jsonb_build_object('approval_id', v_appr.id, 'message_id', v_msg.id));

  return jsonb_build_object('result', 'SENT');
end;
$$;

revoke execute on function public.decide_approval(text, text, bigint, bigint)
  from public, anon, authenticated;
revoke execute on function public.mark_message_sent(text, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.decide_approval(text, text, bigint, bigint) to service_role;
grant execute on function public.mark_message_sent(text, bigint, bigint) to service_role;
