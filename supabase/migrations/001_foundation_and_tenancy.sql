-- 001_foundation_and_tenancy.sql
-- Creates: updated_at helper, businesses, business_members,
--          RLS helper functions, create_business().
-- Run ONCE in the Supabase SQL Editor. Running it twice will error
-- because the objects already exist.

-- ============================================================
-- 1. Helper: keep updated_at current
-- ============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- 2. businesses
-- ============================================================
create table public.businesses (
  id                   uuid primary key default gen_random_uuid(),
  business_name        text not null
                         check (char_length(btrim(business_name)) between 1 and 200),
  industry             text not null
                         check (industry in ('REAL_ESTATE','CLINIC','HOME_SERVICE','OTHER')),
  business_description text,
  business_email       text,
  business_phone       text,
  business_timezone    text not null default 'Asia/Manila',
  telegram_chat_id     bigint,
  business_faq         jsonb not null default '[]'::jsonb
                         check (jsonb_typeof(business_faq) = 'array'),
  services             jsonb not null default '[]'::jsonb
                         check (jsonb_typeof(services) = 'array'),
  pricing_information  text,
  operating_hours      jsonb not null default '{}'::jsonb
                         check (jsonb_typeof(operating_hours) = 'object'),
  is_active            boolean not null default true,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- One Telegram chat can belong to only one business
create unique index businesses_telegram_chat_id_key
  on public.businesses (telegram_chat_id)
  where telegram_chat_id is not null;

create trigger businesses_set_updated_at
  before update on public.businesses
  for each row execute function public.set_updated_at();

-- ============================================================
-- 3. business_members
-- ============================================================
create table public.business_members (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  role             text not null
                     check (role in ('OWNER','ADMIN','STAFF','VIEWER')),
  telegram_user_id bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (business_id, user_id)
);

create index business_members_user_id_idx
  on public.business_members (user_id);

-- A Telegram account can be linked to only one member per business
create unique index business_members_telegram_user_key
  on public.business_members (business_id, telegram_user_id)
  where telegram_user_id is not null;

create trigger business_members_set_updated_at
  before update on public.business_members
  for each row execute function public.set_updated_at();

-- ============================================================
-- 4. RLS helper functions
-- SECURITY DEFINER lets them read business_members without
-- triggering that table's own policies (avoids infinite recursion).
-- ============================================================
create or replace function public.is_business_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_members m
    where m.business_id = p_business_id
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.has_business_role(p_business_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_members m
    where m.business_id = p_business_id
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
  );
$$;

-- ============================================================
-- 5. create_business(): the only way a user creates a business
-- ============================================================
create or replace function public.create_business(p_business_name text, p_industry text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id     uuid := auth.uid();
  v_business_id uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  insert into public.businesses (business_name, industry, created_by)
  values (btrim(p_business_name), p_industry, v_user_id)
  returning id into v_business_id;

  insert into public.business_members (business_id, user_id, role)
  values (v_business_id, v_user_id, 'OWNER');

  return v_business_id;
end;
$$;

-- Only logged-in users (and the server) may call these
revoke execute on function public.is_business_member(uuid)       from public, anon;
revoke execute on function public.has_business_role(uuid, text[]) from public, anon;
revoke execute on function public.create_business(text, text)     from public, anon;

grant execute on function public.is_business_member(uuid)        to authenticated, service_role;
grant execute on function public.has_business_role(uuid, text[]) to authenticated, service_role;
grant execute on function public.create_business(text, text)     to authenticated, service_role;

-- ============================================================
-- 6. Row Level Security + permissions
-- ============================================================
alter table public.businesses       enable row level security;
alter table public.business_members enable row level security;

-- Logged-out users get nothing
revoke all on public.businesses       from anon;
revoke all on public.business_members from anon;

-- Server (secret key) gets full access
grant all on public.businesses       to service_role;
grant all on public.business_members to service_role;

-- Logged-in users: limited, column-level permissions
grant select on public.businesses to authenticated;
grant update (
  business_name, industry, business_description, business_email,
  business_phone, business_timezone, telegram_chat_id, business_faq,
  services, pricing_information, operating_hours
) on public.businesses to authenticated;

grant select, insert, delete on public.business_members to authenticated;
grant update (role, telegram_user_id) on public.business_members to authenticated;

-- businesses: members can read; OWNER/ADMIN can edit
create policy businesses_select_members
  on public.businesses for select to authenticated
  using ((select public.is_business_member(id)));

create policy businesses_update_admins
  on public.businesses for update to authenticated
  using      ((select public.has_business_role(id, array['OWNER','ADMIN'])))
  with check ((select public.has_business_role(id, array['OWNER','ADMIN'])));

-- business_members: members can see teammates; only OWNER manages
create policy members_select_same_business
  on public.business_members for select to authenticated
  using ((select public.is_business_member(business_id)));

create policy members_insert_owner
  on public.business_members for insert to authenticated
  with check ((select public.has_business_role(business_id, array['OWNER'])));

create policy members_update_owner
  on public.business_members for update to authenticated
  using      ((select public.has_business_role(business_id, array['OWNER'])))
  with check ((select public.has_business_role(business_id, array['OWNER'])));

create policy members_delete_owner
  on public.business_members for delete to authenticated
  using ((select public.has_business_role(business_id, array['OWNER'])));
