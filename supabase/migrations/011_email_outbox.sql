-- 011_email_outbox.sql
-- Requires 010. Safe to run more than once.
-- Automatic email delivery for approved replies (sent from the owner's Gmail).
--   claim_outbox()    takes queued emails to send (SKIP LOCKED: never twice)
--   complete_outbox() records the result; on failure the reply falls back to
--                     copy-and-send, so the owner can still send it by hand.
-- Emails stuck in SENDING (the backend crashed mid-send) are NOT retried
-- automatically, because they may already have been delivered.

-- ============================================================
-- 1. claim_outbox
-- ============================================================
create or replace function public.claim_outbox(p_limit integer default 5)
returns table (
  outbox_id     uuid,
  business_id   uuid,
  lead_id       uuid,
  recipient     text,
  content       text,
  business_name text,
  attempts      integer,
  max_attempts  integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with claimed as (
    update public.message_outbox o
       set status = 'SENDING', attempts = o.attempts + 1
     where o.id in (
       select c.id
         from public.message_outbox c
        where c.status = 'PENDING'
          and c.channel = 'EMAIL'
          and c.next_attempt_at <= now()
          and c.attempts < c.max_attempts
          -- Turning email off for a business also holds its queued emails
          and exists (select 1 from public.business_settings s
                       where s.business_id = c.business_id and s.email_delivery_enabled)
        order by c.next_attempt_at
        limit greatest(1, least(p_limit, 20))
        for update skip locked
     )
    returning o.*
  )
  select c.id, c.business_id, m.lead_id, c.recipient, mv.content, b.business_name,
         c.attempts, c.max_attempts
    from claimed c
    join public.messages m on m.id = c.message_id and m.business_id = c.business_id
    join public.message_versions mv on mv.message_id = c.message_id and mv.version_number = c.version_number
    join public.businesses b on b.id = c.business_id;
end;
$$;

-- ============================================================
-- 2. complete_outbox
-- p_outcome: SENT | RETRY | FAILED | NEEDS_CHECK
-- For FAILED / NEEDS_CHECK the backend passes a fresh token hash so the
-- owner gets a new "I sent it" button for the copy-and-send fallback.
-- ============================================================
create or replace function public.complete_outbox(
  p_outbox_id           uuid,
  p_outcome             text,
  p_provider            text,
  p_provider_message_id text,
  p_error               text,
  p_retry_seconds       integer,
  p_new_token_hash      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out     public.message_outbox%rowtype;
  v_msg     public.messages%rowtype;
  v_outcome text := p_outcome;
  v_content text;
begin
  if p_outcome not in ('SENT','RETRY','FAILED','NEEDS_CHECK') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;

  select * into v_out from public.message_outbox o where o.id = p_outbox_id for update;
  if not found or v_out.status <> 'SENDING' then
    return jsonb_build_object('result', 'IGNORED');
  end if;

  select * into v_msg
    from public.messages m
   where m.id = v_out.message_id and m.business_id = v_out.business_id
     for update;

  if v_outcome = 'SENT' then
    update public.message_outbox o
       set status = 'SENT', provider = p_provider, provider_message_id = p_provider_message_id,
           sent_at = now(), last_error = null
     where o.id = v_out.id;
    update public.messages m set status = 'SENT', sent_at = now() where m.id = v_msg.id;
    update public.leads l
       set conversation_status  = 'MESSAGE_SENT',
           needs_manual_contact = false,
           last_contact_at      = greatest(now(), l.first_contact_at)
     where l.id = v_msg.lead_id and l.business_id = v_msg.business_id;
    insert into public.activity_logs
      (business_id, lead_id, actor_type, activity_type, activity_description, metadata)
    values
      (v_msg.business_id, v_msg.lead_id, 'SYSTEM', 'EMAIL_SENT',
       'Approved reply emailed to the customer',
       jsonb_build_object('outbox_id', v_out.id, 'message_id', v_msg.id, 'provider', p_provider));
    return jsonb_build_object('result', 'SENT', 'lead_id', v_msg.lead_id);
  end if;

  -- Out of retries: give up, and let the owner send it by hand
  if v_outcome = 'RETRY' and v_out.attempts >= v_out.max_attempts then
    v_outcome := 'FAILED';
  end if;

  if v_outcome = 'RETRY' then
    update public.message_outbox o
       set status = 'PENDING',
           next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_retry_seconds, 60), 10)),
           last_error = left(p_error, 2000)
     where o.id = v_out.id;
    return jsonb_build_object('result', 'RETRY');
  end if;

  -- FAILED or NEEDS_CHECK: fall back to copy-and-send
  if p_new_token_hash is null or p_new_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A new token hash is required for the fallback' using errcode = '22023';
  end if;

  update public.message_outbox o
     set status = v_outcome, last_error = left(p_error, 2000)
   where o.id = v_out.id;
  update public.messages m set status = 'APPROVED', channel = 'MANUAL' where m.id = v_msg.id;
  update public.message_approvals a
     set token_hash = p_new_token_hash
   where a.message_id = v_msg.id and a.version_number = v_out.version_number
     and a.status = 'APPROVED';
  update public.leads l
     set needs_manual_contact = true
   where l.id = v_msg.lead_id and l.business_id = v_msg.business_id;

  select mv.content into v_content
    from public.message_versions mv
   where mv.message_id = v_msg.id and mv.version_number = v_out.version_number;

  insert into public.activity_logs
    (business_id, lead_id, actor_type, activity_type, activity_description, metadata)
  values
    (v_msg.business_id, v_msg.lead_id, 'SYSTEM',
     case when v_outcome = 'FAILED' then 'EMAIL_FAILED' else 'EMAIL_NEEDS_CHECK' end,
     case when v_outcome = 'FAILED'
          then 'Email could not be sent; owner asked to send it by hand'
          else 'Email may not have been sent; owner asked to check' end,
     jsonb_build_object('outbox_id', v_out.id, 'message_id', v_msg.id));

  return jsonb_build_object(
    'result', v_outcome, 'lead_id', v_msg.lead_id, 'content', v_content,
    'business_id', v_msg.business_id);
end;
$$;

revoke execute on function public.claim_outbox(integer) from public, anon, authenticated;
revoke execute on function public.complete_outbox(uuid, text, text, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_outbox(integer) to service_role;
grant execute on function public.complete_outbox(uuid, text, text, text, text, integer, text) to service_role;
