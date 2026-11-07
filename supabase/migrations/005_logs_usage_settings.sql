-- 005_logs_usage_settings.sql
-- Requires 004. Adds: activity_logs, ai_usage, business_settings,
-- business_integrations, contact_opt_outs.
-- Run ONCE in the Supabase SQL Editor.

-- ============================================================
-- 1. activity_logs (audit trail; keep personal data out of metadata)
-- ============================================================
create table public.activity_logs (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null references public.businesses(id) on delete cascade,
  lead_id              uuid references public.leads(id) on delete set null,
  actor_type           text not null
                         check (actor_type in ('SYSTEM','USER','TELEGRAM','AI','WEBHOOK')),
  actor_user_id        uuid references auth.users(id) on delete set null,
  activity_type        text not null check (activity_type ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  activity_description text not null check (char_length(activity_description) between 1 and 1000),
  metadata             jsonb not null default '{}'::jsonb
                         check (jsonb_typeof(metadata) = 'object'),
  created_at           timestamptz not null default now()
);

create index activity_logs_business_created_idx
  on public.activity_logs (business_id, created_at desc);
create index activity_logs_lead_created_idx
  on public.activity_logs (lead_id, created_at desc) where lead_id is not null;

-- ============================================================
-- 2. ai_usage
-- ============================================================
create table public.ai_usage (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  lead_id            uuid references public.leads(id) on delete set null,
  provider           text not null,
  model              text not null,
  request_type       text not null check (request_type ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  prompt_tokens      integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens  integer check (completion_tokens is null or completion_tokens >= 0),
  total_tokens       integer check (total_tokens is null or total_tokens >= 0),
  estimated_cost_usd numeric(12,6) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  duration_ms        integer check (duration_ms is null or duration_ms >= 0),
  success            boolean not null,
  error_code         text check (error_code is null or char_length(error_code) <= 100),
  created_at         timestamptz not null default now()
);

create index ai_usage_business_created_idx
  on public.ai_usage (business_id, created_at desc);

-- ============================================================
-- 3. business_settings (one row per business, auto-created)
-- ============================================================
create table public.business_settings (
  business_id               uuid primary key references public.businesses(id) on delete cascade,
  follow_ups_enabled        boolean  not null default true,
  -- minutes after the previous outbound message was sent
  follow_up_1_delay_minutes integer  not null default 60
                              check (follow_up_1_delay_minutes between 5 and 10080),
  follow_up_2_delay_minutes integer  not null default 1440
                              check (follow_up_2_delay_minutes between 60 and 43200),
  max_follow_ups            smallint not null default 2 check (max_follow_ups between 0 and 5),
  respect_operating_hours   boolean  not null default true,
  approval_expiry_hours     integer  not null default 24
                              check (approval_expiry_hours between 1 and 168),
  duplicate_window_hours    integer  not null default 72
                              check (duplicate_window_hours between 1 and 720),
  ai_daily_request_limit    integer  not null default 200
                              check (ai_daily_request_limit between 1 and 10000),
  max_inquiry_length        integer  not null default 2000
                              check (max_inquiry_length between 100 and 5000),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create trigger business_settings_set_updated_at
  before update on public.business_settings
  for each row execute function public.set_updated_at();

create function public.create_default_business_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.business_settings (business_id) values (new.id)
  on conflict do nothing;
  return new;
end;
$$;

create trigger businesses_create_settings
  after insert on public.businesses
  for each row execute function public.create_default_business_settings();

-- Backfill for any business that already exists
insert into public.business_settings (business_id)
select id from public.businesses
on conflict do nothing;

-- ============================================================
-- 4. business_integrations (resolve a business from a verified identifier)
-- secret_reference is the NAME of an env var, never the secret.
-- ============================================================
create table public.business_integrations (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  provider          text not null
                      check (provider in ('WEBSITE_FORM','TALLY','GENERIC_WEBHOOK','TELEGRAM','RESEND')),
  public_identifier text not null check (public_identifier ~ '^[A-Za-z0-9_-]{22,64}$'),
  secret_reference  text check (secret_reference is null
                                or secret_reference ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  is_active         boolean not null default true,
  last_used_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint business_integrations_public_identifier_key unique (public_identifier),
  constraint business_integrations_one_per_provider unique (business_id, provider)
);

create trigger business_integrations_set_updated_at
  before update on public.business_integrations
  for each row execute function public.set_updated_at();

-- ============================================================
-- 5. contact_opt_outs (survives lead deletion)
-- ============================================================
create table public.contact_opt_outs (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  channel            text not null check (channel ~ '^[A-Z][A-Z0-9_]{1,29}$'),
  contact_normalized text not null check (char_length(contact_normalized) between 3 and 320),
  reason             text check (reason is null or char_length(reason) <= 500),
  created_at         timestamptz not null default now(),

  constraint contact_opt_outs_unique unique (business_id, channel, contact_normalized)
);

-- ============================================================
-- 6. Row Level Security + permissions
-- ============================================================
alter table public.activity_logs         enable row level security;
alter table public.ai_usage              enable row level security;
alter table public.business_settings     enable row level security;
alter table public.business_integrations enable row level security;
alter table public.contact_opt_outs      enable row level security;

revoke all on public.activity_logs         from anon;
revoke all on public.ai_usage              from anon;
revoke all on public.business_settings     from anon;
revoke all on public.business_integrations from anon;
revoke all on public.contact_opt_outs      from anon;

grant all on public.activity_logs         to service_role;
grant all on public.ai_usage              to service_role;
grant all on public.business_settings     to service_role;
grant all on public.business_integrations to service_role;
grant all on public.contact_opt_outs      to service_role;

grant select on public.activity_logs     to authenticated;
grant select on public.ai_usage          to authenticated;
grant select on public.business_settings to authenticated;
grant select on public.contact_opt_outs  to authenticated;
-- secret_reference is NOT readable by the dashboard
grant select (id, business_id, provider, public_identifier, is_active,
              last_used_at, created_at, updated_at)
  on public.business_integrations to authenticated;

grant update (follow_ups_enabled, follow_up_1_delay_minutes, follow_up_2_delay_minutes,
              max_follow_ups, respect_operating_hours, approval_expiry_hours,
              duplicate_window_hours, ai_daily_request_limit, max_inquiry_length)
  on public.business_settings to authenticated;

create policy activity_logs_select_members
  on public.activity_logs for select to authenticated
  using ((select public.is_business_member(business_id)));

create policy ai_usage_select_admins
  on public.ai_usage for select to authenticated
  using ((select public.has_business_role(business_id, array['OWNER','ADMIN'])));

create policy business_settings_select_members
  on public.business_settings for select to authenticated
  using ((select public.is_business_member(business_id)));

create policy business_settings_update_admins
  on public.business_settings for update to authenticated
  using      ((select public.has_business_role(business_id, array['OWNER','ADMIN'])))
  with check ((select public.has_business_role(business_id, array['OWNER','ADMIN'])));

create policy business_integrations_select_admins
  on public.business_integrations for select to authenticated
  using ((select public.has_business_role(business_id, array['OWNER','ADMIN'])));

create policy contact_opt_outs_select_members
  on public.contact_opt_outs for select to authenticated
  using ((select public.is_business_member(business_id)));
