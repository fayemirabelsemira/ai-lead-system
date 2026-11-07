-- 002_leads.sql
-- Requires 001. Adds: leads, lead_interactions, lead_analyses, analysis_corrections.
-- Run ONCE in the Supabase SQL Editor.

-- ============================================================
-- 1. leads
-- ============================================================
create table public.leads (
  id                      uuid primary key default gen_random_uuid(),
  business_id             uuid not null references public.businesses(id) on delete cascade,

  full_name               text not null
                            check (char_length(btrim(full_name)) between 1 and 200),
  email                   text check (email is null or char_length(email) <= 320),
  email_normalized        text check (
                            email_normalized is null
                            or (email_normalized = lower(btrim(email_normalized))
                                and position('@' in email_normalized) > 1)),
  phone                   text check (phone is null or char_length(phone) <= 40),
  phone_normalized        text check (
                            phone_normalized is null
                            or phone_normalized ~ '^\+[1-9][0-9]{7,14}$'),

  source                  text not null check (source ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  original_message        text not null
                            check (char_length(original_message) between 1 and 5000),
  preferred_language      text
                            check (preferred_language in ('ENGLISH','TAGALOG','TAGLISH','OTHER')),

  -- Consent: a lead cannot be stored without it
  consent_to_contact      boolean not null check (consent_to_contact),
  consent_recorded_at     timestamptz not null default now(),
  opted_out_at            timestamptz,

  -- AI results (latest), details live in lead_analyses
  lead_score              text check (lead_score in ('HOT','WARM','COLD')),
  lead_intent             text check (lead_intent ~ '^[A-Z][A-Z0-9_]{1,59}$'),

  -- Three independent statuses
  lead_status             text not null default 'RECEIVED'
                            check (lead_status in
                              ('RECEIVED','PROCESSING','ANALYZED','NEEDS_HUMAN_REVIEW','FAILED')),
  conversation_status     text not null default 'NEW'
                            check (conversation_status in
                              ('NEW','WAITING_FOR_APPROVAL','MESSAGE_SENT','WAITING_FOR_CUSTOMER',
                               'CUSTOMER_RESPONDED','FOLLOW_UP_DUE','FOLLOW_UP_PAUSED','CLOSED')),
  outcome                 text not null default 'OPEN'
                            check (outcome in ('OPEN','CONVERTED','LOST','NOT_INTERESTED')),

  needs_manual_contact    boolean not null default false,
  follow_ups_paused       boolean not null default false,
  internal_notes          text check (internal_notes is null or char_length(internal_notes) <= 5000),

  -- Possible duplicates are flagged for review, never auto-merged
  duplicate_of            uuid,
  duplicate_review_status text not null default 'NONE'
                            check (duplicate_review_status in
                              ('NONE','POSSIBLE','CONFIRMED','DISMISSED')),

  first_contact_at        timestamptz not null default now(),
  last_contact_at         timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint leads_id_business_key unique (id, business_id),
  constraint leads_has_contact_method
    check (email_normalized is not null or phone_normalized is not null),
  constraint leads_not_own_duplicate
    check (duplicate_of is null or duplicate_of <> id),
  constraint leads_last_contact_after_first
    check (last_contact_at >= first_contact_at),
  -- duplicate_of must point to a lead in the SAME business
  constraint leads_duplicate_of_fk
    foreign key (duplicate_of, business_id)
    references public.leads (id, business_id)
    on delete set null (duplicate_of)
);

create index leads_business_created_idx      on public.leads (business_id, created_at desc);
create index leads_business_score_idx        on public.leads (business_id, lead_score);
create index leads_business_status_idx       on public.leads (business_id, lead_status);
create index leads_business_last_contact_idx on public.leads (business_id, last_contact_at desc);
create index leads_business_phone_idx
  on public.leads (business_id, phone_normalized) where phone_normalized is not null;
create index leads_business_email_idx
  on public.leads (business_id, email_normalized) where email_normalized is not null;
create index leads_duplicate_of_idx
  on public.leads (duplicate_of) where duplicate_of is not null;

create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

-- ============================================================
-- 2. lead_interactions (every submission, including repeats)
-- ============================================================
create table public.lead_interactions (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null,
  lead_id                uuid not null,
  source                 text not null check (source ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  external_submission_id text
                           check (external_submission_id is null
                                  or char_length(external_submission_id) between 1 and 200),
  message_text           text not null check (char_length(message_text) between 1 and 5000),
  content_hash           text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  form_fields            jsonb not null default '{}'::jsonb
                           check (jsonb_typeof(form_fields) = 'object'),
  received_at            timestamptz not null default now(),
  created_at             timestamptz not null default now(),

  constraint lead_interactions_id_business_key unique (id, business_id),
  constraint lead_interactions_lead_fk
    foreign key (lead_id, business_id)
    references public.leads (id, business_id) on delete cascade
);

-- The database itself rejects a replayed webhook submission
create unique index lead_interactions_external_submission_key
  on public.lead_interactions (business_id, source, external_submission_id)
  where external_submission_id is not null;

create index lead_interactions_lead_received_idx
  on public.lead_interactions (lead_id, received_at desc);
create index lead_interactions_lead_hash_idx
  on public.lead_interactions (lead_id, content_hash);

-- ============================================================
-- 3. lead_analyses (AI output, one row per analysis attempt)
-- ============================================================
create table public.lead_analyses (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null,
  lead_id              uuid not null,
  interaction_id       uuid,
  analysis_status      text not null check (analysis_status in ('COMPLETED','FAILED')),
  intent               text check (intent ~ '^[A-Z][A-Z0-9_]{1,59}$'),
  lead_score           text check (lead_score in ('HOT','WARM','COLD')),
  score_reason         text check (score_reason is null or char_length(score_reason) <= 2000),
  urgency              text check (urgency in ('LOW','MEDIUM','HIGH')),
  detected_language    text check (detected_language in ('ENGLISH','TAGALOG','TAGLISH','OTHER')),
  customer_needs       jsonb not null default '[]'::jsonb
                         check (jsonb_typeof(customer_needs) = 'array'),
  missing_information  jsonb not null default '[]'::jsonb
                         check (jsonb_typeof(missing_information) = 'array'),
  suggested_reply      text check (suggested_reply is null or char_length(suggested_reply) <= 2000),
  confidence_level     text check (confidence_level in ('LOW','MEDIUM','HIGH')),
  needs_human_review   boolean not null default false,
  escalation_reason    text check (escalation_reason is null or char_length(escalation_reason) <= 1000),
  provider             text not null,
  model_used           text not null,
  prompt_version       text,
  error_message        text check (error_message is null or char_length(error_message) <= 2000),
  created_at           timestamptz not null default now(),

  constraint lead_analyses_id_business_key unique (id, business_id),
  constraint lead_analyses_completed_has_core_fields
    check (analysis_status <> 'COMPLETED'
           or (intent is not null and lead_score is not null
               and confidence_level is not null and detected_language is not null)),
  constraint lead_analyses_completed_has_reply_or_escalation
    check (analysis_status <> 'COMPLETED'
           or needs_human_review or suggested_reply is not null),
  constraint lead_analyses_lead_fk
    foreign key (lead_id, business_id)
    references public.leads (id, business_id) on delete cascade,
  constraint lead_analyses_interaction_fk
    foreign key (interaction_id, business_id)
    references public.lead_interactions (id, business_id)
    on delete set null (interaction_id)
);

create index lead_analyses_lead_created_idx
  on public.lead_analyses (lead_id, created_at desc);
create index lead_analyses_business_created_idx
  on public.lead_analyses (business_id, created_at desc);

-- ============================================================
-- 4. analysis_corrections (owner fixes AI classification)
-- ============================================================
create table public.analysis_corrections (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null,
  lead_id          uuid not null,
  analysis_id      uuid not null,
  original_score   text check (original_score in ('HOT','WARM','COLD')),
  corrected_score  text check (corrected_score in ('HOT','WARM','COLD')),
  original_intent  text,
  corrected_intent text check (corrected_intent is null
                               or corrected_intent ~ '^[A-Z][A-Z0-9_]{1,59}$'),
  note             text check (note is null or char_length(note) <= 1000),
  corrected_by     uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),

  constraint analysis_corrections_changes_something
    check (corrected_score is not null or corrected_intent is not null),
  constraint analysis_corrections_analysis_fk
    foreign key (analysis_id, business_id)
    references public.lead_analyses (id, business_id) on delete cascade,
  constraint analysis_corrections_lead_fk
    foreign key (lead_id, business_id)
    references public.leads (id, business_id) on delete cascade
);

create index analysis_corrections_lead_idx
  on public.analysis_corrections (lead_id, created_at desc);

-- ============================================================
-- 5. Row Level Security + permissions
-- Writes that trigger business logic go through the backend
-- (secret key). The dashboard reads, and edits only a few fields.
-- ============================================================
alter table public.leads                enable row level security;
alter table public.lead_interactions    enable row level security;
alter table public.lead_analyses        enable row level security;
alter table public.analysis_corrections enable row level security;

revoke all on public.leads                from anon;
revoke all on public.lead_interactions    from anon;
revoke all on public.lead_analyses        from anon;
revoke all on public.analysis_corrections from anon;

grant all on public.leads                to service_role;
grant all on public.lead_interactions    to service_role;
grant all on public.lead_analyses        to service_role;
grant all on public.analysis_corrections to service_role;

grant select on public.leads                to authenticated;
grant select on public.lead_interactions    to authenticated;
grant select on public.lead_analyses        to authenticated;
grant select on public.analysis_corrections to authenticated;
grant insert on public.analysis_corrections to authenticated;
-- Dashboard may only edit these three lead fields directly.
-- (The follow-up scheduler re-checks them before every send.)
grant update (outcome, follow_ups_paused, internal_notes) on public.leads to authenticated;

create policy leads_select_members
  on public.leads for select to authenticated
  using ((select public.is_business_member(business_id)));

create policy leads_update_staff
  on public.leads for update to authenticated
  using      ((select public.has_business_role(business_id, array['OWNER','ADMIN','STAFF'])))
  with check ((select public.has_business_role(business_id, array['OWNER','ADMIN','STAFF'])));

create policy lead_interactions_select_members
  on public.lead_interactions for select to authenticated
  using ((select public.is_business_member(business_id)));

create policy lead_analyses_select_members
  on public.lead_analyses for select to authenticated
  using ((select public.is_business_member(business_id)));

create policy analysis_corrections_select_members
  on public.analysis_corrections for select to authenticated
  using ((select public.is_business_member(business_id)));

create policy analysis_corrections_insert_staff
  on public.analysis_corrections for insert to authenticated
  with check (
    (select public.has_business_role(business_id, array['OWNER','ADMIN','STAFF']))
    and corrected_by = (select auth.uid())
  );
