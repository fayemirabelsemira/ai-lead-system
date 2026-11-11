-- 012_recovery.sql
-- Requires 011. Safe to re-run.
-- Recovery for work that was interrupted (server crash, restart, deploy).
-- The backend calls these every minute. Nothing here ever sends anything:
-- interrupted EMAILS are never retried blindly (they might have gone out);
-- the owner is asked to check instead.
--
--   recover_stuck_jobs        jobs left RUNNING -> retried, or DEAD (owner told)
--   resend_undelivered_cards  drafts whose Telegram card never arrived -> new card
--   expire_approvals          approvals nobody answered in time -> EXPIRED (owner told)
--   stale_outbox              emails left SENDING -> listed, the backend marks NEEDS_CHECK

-- ============================================================
-- 1. Jobs left RUNNING by a worker that stopped
-- ============================================================
create or replace function public.recover_stuck_jobs(p_stale_minutes integer default 10)
returns table (job_id uuid, business_id uuid, lead_id uuid, job_type text, outcome text, lead_needs_notice boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_stale_minutes is null or p_stale_minutes < 2 then
    raise exception 'p_stale_minutes must be at least 2' using errcode = '22023';
  end if;

  return query
  with stuck as (
    update public.jobs j
       set status     = case when j.attempts < j.max_attempts then 'PENDING' else 'DEAD' end,
           run_at     = now(),
           locked_at  = null,
           locked_by  = null,
           last_error = 'Recovered: the worker stopped while running this job'
     where j.id in (
       select c.id from public.jobs c
        where c.status = 'RUNNING'
          and c.locked_at < now() - make_interval(mins => p_stale_minutes)
        for update skip locked
     )
    returning j.id, j.business_id, j.lead_id, j.job_type, j.status
  ),
  -- A lead whose analysis job died before any card was sent needs a person.
  flagged as (
    update public.leads l
       set lead_status = 'NEEDS_HUMAN_REVIEW', needs_manual_contact = true
      from stuck s
     where s.status = 'DEAD' and s.job_type = 'ANALYZE_LEAD'
       and l.id = s.lead_id and l.business_id = s.business_id
       and l.conversation_status = 'NEW'
    returning l.id
  )
  select s.id, s.business_id, s.lead_id, s.job_type,
         case when s.status = 'DEAD' then 'DEAD' else 'RETRY' end,
         s.lead_id in (select f.id from flagged f)
    from stuck s;
end;
$$;

-- ============================================================
-- 2. Drafts whose Telegram card never arrived
-- The card is sent right after the draft is saved, and its Telegram id is
-- stored right after that. A draft still without an id after a few minutes
-- means the server stopped in between: cancel it and queue a fresh card.
-- (If the old card did arrive, its buttons now answer "no longer pending".)
-- ============================================================
create or replace function public.resend_undelivered_cards(p_stale_minutes integer default 10)
returns table (approval_id uuid, business_id uuid, lead_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
  v_payload jsonb;
begin
  if p_stale_minutes is null or p_stale_minutes < 2 then
    raise exception 'p_stale_minutes must be at least 2' using errcode = '22023';
  end if;

  for r in
    select a.id, a.business_id, m.lead_id
      from public.message_approvals a
      join public.messages m on m.id = a.message_id and m.business_id = a.business_id
     where a.status = 'PENDING'
       and a.telegram_message_id is null
       and a.created_at < now() - make_interval(mins => p_stale_minutes)
       and a.expires_at > now()
     order by a.created_at
     limit 20
       for update of a skip locked
  loop
    if public.cancel_reply_draft(r.id) then
      -- Reuse the original job's payload (it carries the interaction id).
      select j.payload into v_payload
        from public.jobs j
       where j.business_id = r.business_id and j.dedupe_key = 'analyze:' || r.lead_id::text;

      insert into public.jobs (business_id, lead_id, job_type, payload, dedupe_key, max_attempts)
      values (r.business_id, r.lead_id, 'ANALYZE_LEAD',
              coalesce(v_payload, jsonb_build_object('lead_id', r.lead_id)),
              'resend:' || r.id::text, 3)
      on conflict (business_id, dedupe_key) where dedupe_key is not null do nothing;

      approval_id := r.id; business_id := r.business_id; lead_id := r.lead_id;
      return next;
    end if;
  end loop;
end;
$$;

-- ============================================================
-- 3. Approvals nobody answered in time
-- ============================================================
create or replace function public.expire_approvals(p_limit integer default 20)
returns table (approval_id uuid, business_id uuid, lead_id uuid, content text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with expired as (
    update public.message_approvals a
       set status = 'EXPIRED'
     where a.id in (
       select c.id from public.message_approvals c
        where c.status = 'PENDING' and c.expires_at <= now()
        order by c.expires_at
        limit greatest(1, least(p_limit, 100))
        for update skip locked
     )
    returning a.id, a.business_id, a.message_id, a.version_number
  ),
  drafts as (
    update public.messages m
       set status = 'DRAFT'
      from expired e
     where m.id = e.message_id and m.business_id = e.business_id
       and m.status = 'PENDING_APPROVAL'
    returning m.id, m.lead_id
  ),
  leads as (
    update public.leads l
       set needs_manual_contact = true
      from drafts d
     where l.id = d.lead_id
    returning l.id
  ),
  logged as (
    insert into public.activity_logs
      (business_id, lead_id, actor_type, activity_type, activity_description, metadata)
    select e.business_id, d.lead_id, 'SYSTEM', 'APPROVAL_EXPIRED',
           'Nobody approved the reply in time; nothing was sent',
           jsonb_build_object('approval_id', e.id, 'message_id', e.message_id)
      from expired e join drafts d on d.id = e.message_id
    returning 1
  )
  select e.id, e.business_id, d.lead_id, v.content
    from expired e
    join drafts d on d.id = e.message_id
    join public.message_versions v on v.message_id = e.message_id and v.version_number = e.version_number;
end;
$$;

-- ============================================================
-- 4. Emails left SENDING by a worker that stopped
-- Only LISTED here: the backend marks each one NEEDS_CHECK through
-- complete_outbox (with a new "I sent it" token) and tells the owner.
-- ============================================================
create or replace function public.stale_outbox(p_stale_minutes integer default 10)
returns table (outbox_id uuid, recipient text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.recipient
    from public.message_outbox o
   where o.status = 'SENDING'
     and o.updated_at < now() - make_interval(mins => greatest(p_stale_minutes, 2))
   order by o.updated_at
   limit 20;
$$;

-- Server only
revoke execute on function public.recover_stuck_jobs(integer)       from public, anon, authenticated;
revoke execute on function public.resend_undelivered_cards(integer) from public, anon, authenticated;
revoke execute on function public.expire_approvals(integer)         from public, anon, authenticated;
revoke execute on function public.stale_outbox(integer)             from public, anon, authenticated;
grant  execute on function public.recover_stuck_jobs(integer)       to service_role;
grant  execute on function public.resend_undelivered_cards(integer) to service_role;
grant  execute on function public.expire_approvals(integer)         to service_role;
grant  execute on function public.stale_outbox(integer)             to service_role;
