-- 004_jobs_followups_webhooks.sql
-- Requires 003. Adds: webhook_events, jobs (+ claim_jobs), follow_up_tasks.
-- Run ONCE in the Supabase SQL Editor.

-- ============================================================
-- 1. webhook_events
-- business_id is NULL until the business is resolved from a
-- verified integration identifier. Never trust a business_id
-- sent by the caller.
-- ============================================================
create table public.webhook_events (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid references public.businesses(id) on delete cascade,
  provider          text not null
                      check (provider in ('WEBSITE_FORM','TALLY','GENERIC_WEBHOOK','TELEGRAM','RESEND')),
  external_event_id text
                      check (external_event_id is null
                             or char_length(external_event_id) between 1 and 200),
  event_type        text not null check (char_length(event_type) between 1 and 100),
  processing_status text not null default 'RECEIVED'
                      check (processing_status in
                        ('RECEIVED','PROCESSING','PROCESSED','FAILED','REJECTED')),
  payload_reference text check (payload_reference is null or char_length(payload_reference) <= 500),
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  error_message     text check (error_message is null or char_length(error_message) <= 2000)
);

-- Same provider + business + event id can only be recorded once
create unique index webhook_events_dedupe_key
  on public.webhook_events (
    provider,
    coalesce(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
    external_event_id
  )
  where external_event_id is not null;

create index webhook_events_business_received_idx
  on public.webhook_events (business_id, received_at desc);
create index webhook_events_open_idx
  on public.webhook_events (processing_status)
  where processing_status in ('RECEIVED','PROCESSING','FAILED');

-- ============================================================
-- 2. jobs (background work queue with retries)
-- ============================================================
create table public.jobs (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  lead_id       uuid,
  job_type      text not null check (job_type ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  status        text not null default 'PENDING'
                  check (status in ('PENDING','RUNNING','SUCCEEDED','FAILED','DEAD')),
  payload       jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  dedupe_key    text check (dedupe_key is null or char_length(dedupe_key) between 1 and 200),
  attempts      integer not null default 0 check (attempts >= 0),
  max_attempts  integer not null default 5 check (max_attempts between 1 and 20),
  run_at        timestamptz not null default now(),
  locked_at     timestamptz,
  locked_by     text,
  last_error    text check (last_error is null or char_length(last_error) <= 2000),
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint jobs_lead_fk
    foreign key (lead_id, business_id)
    references public.leads (id, business_id) on delete cascade
);

-- The same logical job cannot be queued twice
create unique index jobs_dedupe_key
  on public.jobs (business_id, dedupe_key) where dedupe_key is not null;

create index jobs_claim_idx on public.jobs (run_at) where status = 'PENDING';
create index jobs_business_status_idx on public.jobs (business_id, status);

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

-- Workers call this to take jobs. SKIP LOCKED means two workers
-- can never claim the same job. Jobs stuck in RUNNING are NOT
-- auto-reclaimed (they might be half-done sends); review them manually.
create or replace function public.claim_jobs(p_worker text, p_limit integer default 5)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.jobs j
     set status    = 'RUNNING',
         locked_at = now(),
         locked_by = p_worker,
         attempts  = j.attempts + 1
   where j.id in (
     select c.id
       from public.jobs c
      where c.status = 'PENDING'
        and c.run_at <= now()
        and c.attempts < c.max_attempts
      order by c.run_at
      limit greatest(1, least(p_limit, 50))
      for update skip locked
   )
  returning j.*;
end;
$$;

revoke execute on function public.claim_jobs(text, integer) from public, anon, authenticated;
grant  execute on function public.claim_jobs(text, integer) to service_role;

-- ============================================================
-- 3. follow_up_tasks
-- ============================================================
create table public.follow_up_tasks (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null,
  lead_id             uuid not null,
  message_id          uuid,
  follow_up_number    smallint not null check (follow_up_number between 1 and 10),
  scheduled_at        timestamptz not null,
  status              text not null default 'SCHEDULED'
                        check (status in ('SCHEDULED','DUE','AWAITING_APPROVAL','APPROVED',
                                          'SENT','CANCELLED','SKIPPED','FAILED')),
  cancellation_reason text
                        check (cancellation_reason in
                          ('CUSTOMER_RESPONDED','OPTED_OUT','LEAD_CLOSED','OWNER_PAUSED',
                           'OWNER_CANCELLED','MAX_FOLLOW_UPS','NO_CONTACT_METHOD','OTHER')),
  processed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- One task per lead per follow-up number: duplicates are impossible
  constraint follow_up_tasks_one_per_number unique (lead_id, follow_up_number),
  constraint follow_up_tasks_reason_matches_status
    check ((status in ('CANCELLED','SKIPPED')) = (cancellation_reason is not null)),
  constraint follow_up_tasks_lead_fk
    foreign key (lead_id, business_id)
    references public.leads (id, business_id) on delete cascade,
  constraint follow_up_tasks_message_fk
    foreign key (message_id, business_id)
    references public.messages (id, business_id)
    on delete set null (message_id)
);

create index follow_up_tasks_due_idx
  on public.follow_up_tasks (scheduled_at) where status = 'SCHEDULED';
create index follow_up_tasks_business_status_idx
  on public.follow_up_tasks (business_id, status);

create trigger follow_up_tasks_set_updated_at
  before update on public.follow_up_tasks
  for each row execute function public.set_updated_at();

-- ============================================================
-- 4. Row Level Security + permissions (read-only for the dashboard)
-- ============================================================
alter table public.webhook_events   enable row level security;
alter table public.jobs             enable row level security;
alter table public.follow_up_tasks  enable row level security;

revoke all on public.webhook_events  from anon;
revoke all on public.jobs            from anon;
revoke all on public.follow_up_tasks from anon;

grant all on public.webhook_events  to service_role;
grant all on public.jobs            to service_role;
grant all on public.follow_up_tasks to service_role;

grant select on public.webhook_events  to authenticated;
grant select on public.jobs            to authenticated;
grant select on public.follow_up_tasks to authenticated;

-- Technical tables: OWNER/ADMIN only
create policy webhook_events_select_admins
  on public.webhook_events for select to authenticated
  using ((select public.has_business_role(business_id, array['OWNER','ADMIN'])));

create policy jobs_select_admins
  on public.jobs for select to authenticated
  using ((select public.has_business_role(business_id, array['OWNER','ADMIN'])));

create policy follow_up_tasks_select_members
  on public.follow_up_tasks for select to authenticated
  using ((select public.is_business_member(business_id)));
