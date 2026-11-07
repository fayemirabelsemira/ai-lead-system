-- 003_messages.sql
-- Requires 002. Adds: messages, message_versions, message_approvals, message_outbox.
-- Run ONCE in the Supabase SQL Editor.

-- ============================================================
-- 1. messages
-- ============================================================
create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null,
  lead_id          uuid not null,
  analysis_id      uuid,
  direction        text not null check (direction in ('INBOUND','OUTBOUND')),
  channel          text not null check (channel ~ '^[A-Z][A-Z0-9_]{1,29}$'),
  kind             text not null
                     check (kind in ('FIRST_REPLY','FOLLOW_UP','CUSTOMER_REPLY','MANUAL')),
  follow_up_number smallint check (follow_up_number between 1 and 10),
  status           text not null
                     check (status in ('RECEIVED','DRAFT','PENDING_APPROVAL','APPROVED','REJECTED',
                                       'QUEUED','SENDING','SENT','DELIVERED','FAILED','CANCELLED')),
  current_version  integer not null default 1 check (current_version >= 1),
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint messages_id_business_key unique (id, business_id),
  constraint messages_follow_up_needs_number
    check (kind <> 'FOLLOW_UP' or follow_up_number is not null),
  constraint messages_inbound_matches_kind
    check ((direction = 'INBOUND') = (kind = 'CUSTOMER_REPLY')),
  constraint messages_received_only_inbound
    check ((status = 'RECEIVED') = (direction = 'INBOUND')),
  constraint messages_lead_fk
    foreign key (lead_id, business_id)
    references public.leads (id, business_id) on delete cascade,
  constraint messages_analysis_fk
    foreign key (analysis_id, business_id)
    references public.lead_analyses (id, business_id)
    on delete set null (analysis_id)
);

create index messages_lead_created_idx   on public.messages (lead_id, created_at);
create index messages_business_status_idx on public.messages (business_id, status);

-- Only one live follow-up message per lead per follow-up number
create unique index messages_one_active_follow_up
  on public.messages (lead_id, follow_up_number)
  where kind = 'FOLLOW_UP' and status not in ('REJECTED','CANCELLED','FAILED');

create trigger messages_set_updated_at
  before update on public.messages
  for each row execute function public.set_updated_at();

-- ============================================================
-- 2. message_versions (immutable text history)
-- ============================================================
create function public.reject_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Rows in % are immutable', tg_table_name using errcode = '55000';
end;
$$;

create table public.message_versions (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null,
  message_id         uuid not null,
  version_number     integer not null check (version_number >= 1),
  content            text not null check (char_length(btrim(content)) between 1 and 5000),
  authored_by        text not null check (authored_by in ('AI','OWNER','CUSTOMER','SYSTEM')),
  edited_by_user_id  uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),

  constraint message_versions_message_version_key unique (message_id, version_number),
  constraint message_versions_message_fk
    foreign key (message_id, business_id)
    references public.messages (id, business_id) on delete cascade
);

create trigger message_versions_immutable
  before update on public.message_versions
  for each row execute function public.reject_update();

-- ============================================================
-- 3. message_approvals (approval tied to one specific version)
-- ============================================================
create table public.message_approvals (
  id                           uuid primary key default gen_random_uuid(),
  business_id                  uuid not null,
  message_id                   uuid not null,
  version_number               integer not null,
  token_hash                   text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  status                       text not null default 'PENDING'
                                 check (status in ('PENDING','APPROVED','REJECTED',
                                                   'EXPIRED','SUPERSEDED','CANCELLED')),
  telegram_chat_id             bigint,
  telegram_message_id          bigint,
  expires_at                   timestamptz not null,
  decided_at                   timestamptz,
  decided_by_user_id           uuid references auth.users(id) on delete set null,
  decided_by_telegram_user_id  bigint,
  approved_content             text,
  created_at                   timestamptz not null default now(),

  constraint message_approvals_token_key unique (token_hash),
  constraint message_approvals_decided_consistent
    check ((status in ('APPROVED','REJECTED')) = (decided_at is not null)),
  constraint message_approvals_approved_has_content
    check (status <> 'APPROVED' or approved_content is not null),
  constraint message_approvals_message_fk
    foreign key (message_id, business_id)
    references public.messages (id, business_id) on delete cascade,
  constraint message_approvals_version_fk
    foreign key (message_id, version_number)
    references public.message_versions (message_id, version_number) on delete cascade
);

-- At most one pending approval per message
create unique index message_approvals_one_pending
  on public.message_approvals (message_id) where status = 'PENDING';

create index message_approvals_business_status_idx
  on public.message_approvals (business_id, status);

-- ============================================================
-- 4. message_outbox (reliable, idempotent delivery)
-- ============================================================
create table public.message_outbox (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null,
  message_id          uuid not null,
  version_number      integer not null,
  channel             text not null check (channel ~ '^[A-Z][A-Z0-9_]{1,29}$'),
  recipient           text not null check (char_length(recipient) between 3 and 320),
  idempotency_key     text not null check (char_length(idempotency_key) between 16 and 200),
  status              text not null default 'PENDING'
                        check (status in ('PENDING','SENDING','ACCEPTED','SENT','DELIVERED',
                                          'BOUNCED','FAILED','NEEDS_CHECK')),
  provider            text,
  provider_message_id text,
  attempts            integer not null default 0 check (attempts >= 0),
  max_attempts        integer not null default 3 check (max_attempts between 1 and 10),
  next_attempt_at     timestamptz not null default now(),
  last_error          text check (last_error is null or char_length(last_error) <= 2000),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint message_outbox_idempotency_key unique (idempotency_key),
  -- One delivery record per approved version: duplicate sends are impossible
  constraint message_outbox_one_per_version unique (message_id, version_number),
  constraint message_outbox_message_fk
    foreign key (message_id, business_id)
    references public.messages (id, business_id) on delete cascade,
  constraint message_outbox_version_fk
    foreign key (message_id, version_number)
    references public.message_versions (message_id, version_number) on delete cascade
);

create unique index message_outbox_provider_message_key
  on public.message_outbox (provider, provider_message_id)
  where provider_message_id is not null;

create index message_outbox_pending_idx
  on public.message_outbox (next_attempt_at) where status = 'PENDING';

create trigger message_outbox_set_updated_at
  before update on public.message_outbox
  for each row execute function public.set_updated_at();

-- ============================================================
-- 5. Row Level Security + permissions (read-only for the dashboard)
-- ============================================================
alter table public.messages          enable row level security;
alter table public.message_versions  enable row level security;
alter table public.message_approvals enable row level security;
alter table public.message_outbox    enable row level security;

revoke all on public.messages          from anon;
revoke all on public.message_versions  from anon;
revoke all on public.message_approvals from anon;
revoke all on public.message_outbox    from anon;

grant all on public.messages          to service_role;
grant all on public.message_versions  to service_role;
grant all on public.message_approvals to service_role;
grant all on public.message_outbox    to service_role;

grant select on public.messages         to authenticated;
grant select on public.message_versions to authenticated;
grant select on public.message_outbox   to authenticated;
-- Approval token hash and Telegram identifiers are NOT readable by the dashboard
grant select (id, business_id, message_id, version_number, status, expires_at,
              decided_at, decided_by_user_id, approved_content, created_at)
  on public.message_approvals to authenticated;

create policy messages_select_members
  on public.messages for select to authenticated
  using ((select public.is_business_member(business_id)));

create policy message_versions_select_members
  on public.message_versions for select to authenticated
  using ((select public.is_business_member(business_id)));

create policy message_approvals_select_members
  on public.message_approvals for select to authenticated
  using ((select public.is_business_member(business_id)));

create policy message_outbox_select_members
  on public.message_outbox for select to authenticated
  using ((select public.is_business_member(business_id)));
