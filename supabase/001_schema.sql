-- =============================================================================
-- OryonIQ outbound engine — Supabase schema
-- Migration 001. Idempotent: safe to run more than once.
--
-- WHAT THIS REPLACES
-- The Google Sheet has been the system of record since 2026-08-16 and has cost
-- us, in one week: a three-day outage (columns are positional, so inserting one
-- broke every writer), two sends that left Instantly and were recorded nowhere
-- (no transactions), an exhausted read quota (60/min, polled every 2 minutes),
-- a stray `action` column invented by a write, and a corrected row that could
-- not be re-read. None of those are bugs in our code. They are a spreadsheet
-- being asked to be a database.
--
-- THE ONE RULE THIS SCHEMA IS BUILT ON
-- Every action is a row in `events`, and `events` is append-only. n8n writes
-- there, Instantly and HubSpot webhooks write there, and a staff click writes
-- there. "Where is this lead?" and "who did what to it?" become the same
-- question. `leads` carries current state for speed; `events` is why it is
-- what it is, and it can never be quietly rewritten.
-- =============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;     -- case-insensitive email/domain matching

-- -----------------------------------------------------------------------------
-- Vocabularies.
--
-- These are enums on purpose. On the sheet, writing through the API bypassed
-- the dropdown's data validation and put off-vocabulary strings into a column
-- staff filter on — a documented bug. Postgres refuses the write instead. The
-- values are exactly the ones the live pipeline already uses; do not invent new
-- ones without changing the workflow that reads them.
-- -----------------------------------------------------------------------------
do $$ begin
  create type vio_product as enum ('oryoniq', 'visioneerit');
exception when duplicate_object then null; end $$;

do $$ begin
  -- Lifecycle of the EMAIL channel. `not_sent` and `approved` are the only
  -- states VIO-run-outreach will act on (see the leads_ready view).
  create type vio_email_state as enum (
    'not_sent',          -- verified and waiting to be picked up
    'needs_review',      -- verification inconclusive; a human must vouch
    'pending_approval',  -- held for a person to release
    'approved',          -- a human vouched for it; runner may take it
    'enrolled',          -- handed to Instantly; mail is away
    'replied',           -- they answered
    'booked',            -- they took a meeting  <- the conversion
    'bounced',
    'unsubscribed',
    'dropped'            -- verified negative, or refused on purpose. Terminal.
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type vio_verify_verdict as enum ('pass', 'needs_review', 'drop', 'unverified');
exception when duplicate_object then null; end $$;

do $$ begin
  create type vio_identifier_type as enum ('email', 'domain', 'phone', 'linkedin');
exception when duplicate_object then null; end $$;

-- =============================================================================
-- CANONICALISATION
--
-- ⚠️ SECURITY-CRITICAL, AND IT MUST STAY IDENTICAL TO THE JAVASCRIPT.
--
-- Exact string matching on the suppression list was bypassable three ways, all
-- proven live on 2026-08-30: plus-addressing (suppress a@x.com, re-contact as
-- a+anything@x.com), subdomains (suppress x.com, re-contact at mail.x.com), and
-- zero-width characters pasted invisibly into an address.
--
-- Everyone on that list has ASKED US TO STOP. A near-miss that still delivers
-- mail is the exact failure the list exists to prevent.
--
-- These three functions mirror `VIO-enrol-email :: Preconditions (fail closed)`
-- line for line. `n8n-workflows/test-suppression-parity.mjs` runs the deployed
-- JavaScript and this logic over the same inputs and fails if they ever differ.
-- If you change one, change the other and run that test.
-- =============================================================================

-- Zero-width and soft-hyphen characters, stripped before anything else.
-- U+200B..U+200F, U+2060, U+FEFF, U+00AD — the invisible ones.
create or replace function vio_canon(s text)
returns text language sql immutable as $$
  select lower(btrim(regexp_replace(
    coalesce(s, ''),
    '[​‌‍‎‏⁠﻿­]', '', 'g')));
$$;

comment on function vio_canon(text) is
  'Strip zero-width/soft-hyphen characters, trim, lowercase. Mirrors ZW+canon in VIO-enrol-email.';

-- Both forms of an address: as written, and with any +tag removed. The tag is
-- stripped ALWAYS, and both keys are kept, so a list entry written either way
-- still matches. Dots are deliberately NOT stripped — the JavaScript does not
-- strip them either, and silently disagreeing would be worse than either rule.
create or replace function vio_email_keys(raw text)
returns text[] language plpgsql immutable as $$
declare
  e text := vio_canon(raw);
  at_pos int;
  local_part text;
  dom text;
begin
  if e = '' then return array[]::text[]; end if;
  at_pos := length(e) - position('@' in reverse(e)) + 1;   -- lastIndexOf('@')
  if at_pos < 2 then return array[e]; end if;
  local_part := substring(e from 1 for at_pos - 1);
  dom        := substring(e from at_pos + 1);
  return array(select distinct k from unnest(array[
    e,
    split_part(local_part, '+', 1) || '@' || dom
  ]) k where k <> '' and k <> '@');
end $$;

-- Suppressing a domain must cover its subdomains: opting out of x.com and then
-- being mailed at mail.x.com is the same person receiving the same unwanted mail.
-- mail.x.com -> {mail.x.com, x.com}
create or replace function vio_domain_chain(host text)
returns text[] language plpgsql immutable as $$
declare
  h text;
  parts text[];
  out_arr text[] := array[]::text[];
  i int;
begin
  h := vio_canon(host);
  h := regexp_replace(h, '^https?://', '');
  h := regexp_replace(h, '^www\.', '');
  h := split_part(h, '/', 1);
  parts := string_to_array(h, '.');
  parts := array(select p from unnest(parts) p where p <> '');
  for i in 1 .. greatest(array_length(parts, 1) - 1, 0) loop
    out_arr := out_arr || array_to_string(parts[i:array_length(parts, 1)], '.');
  end loop;
  return out_arr;
end $$;

-- =============================================================================
-- TABLES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- suppression — APPEND ONLY, matched on ANY identifier.
-- A hard rule of this project. Nothing may update or delete a row here; the
-- trigger below enforces it at the database level rather than by convention.
-- -----------------------------------------------------------------------------
create table if not exists suppression (
  id               bigserial primary key,
  added_at         timestamptz not null default now(),
  identifier_type  vio_identifier_type not null,
  identifier_value citext not null,
  -- Canonical keys this entry blocks, computed once at insert. Matching reads
  -- this array, so a lookup is an index hit rather than a per-row function call.
  match_keys       text[] not null default '{}',
  reason           text not null default '',
  added_by         text not null default ''
);

create index if not exists suppression_match_keys_idx on suppression using gin (match_keys);
create index if not exists suppression_value_idx      on suppression (identifier_value);

create or replace function vio_suppression_keys()
returns trigger language plpgsql as $$
begin
  if new.identifier_type = 'email' then
    new.match_keys := vio_email_keys(new.identifier_value::text);
  elsif new.identifier_type = 'domain' then
    new.match_keys := vio_domain_chain(new.identifier_value::text);
  else
    new.match_keys := array[vio_canon(new.identifier_value::text)];
  end if;
  return new;
end $$;

drop trigger if exists suppression_keys_trg on suppression;
create trigger suppression_keys_trg before insert on suppression
  for each row execute function vio_suppression_keys();

-- -----------------------------------------------------------------------------
-- leads — one row per person. Current state, for speed.
-- The history of HOW it reached this state lives in `events` and is immutable.
-- -----------------------------------------------------------------------------
create table if not exists leads (
  id                uuid primary key default gen_random_uuid(),
  contact_email     citext not null unique,
  first_name        text not null default '',
  last_name         text not null default '',
  title             text not null default '',
  company           text not null default '',
  company_domain    citext not null default '',
  phone             text not null default '',
  linkedin_url      text not null default '',
  timezone          text not null default '',

  product           vio_product not null,
  -- HOW the lead arrived: manual, apollo, upload, excel. Deliberately NOT the
  -- product — on the sheet these were confused once and a council CIO nearly
  -- received GovCon capture copy.
  source            text not null default 'manual',

  channel_state_email vio_email_state not null default 'not_sent',
  verify_action     vio_verify_verdict not null default 'unverified',
  verify_reason     text not null default '',
  reoon_status      text not null default '',

  opener            text not null default '',
  email_draft       text not null default '',
  sendr_page_id     text not null default '',
  sendr_page_url    text not null default '',
  instantly_lead_id text not null default '',

  replied_at        timestamptz,
  reply_sentiment   text,
  meeting_booked_at timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        text not null default 'n8n'
);

create index if not exists leads_state_idx   on leads (channel_state_email);
create index if not exists leads_product_idx on leads (product);
create index if not exists leads_domain_idx  on leads (company_domain);
create index if not exists leads_created_idx on leads (created_at desc);

create or replace function vio_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists leads_touch_trg on leads;
create trigger leads_touch_trg before update on leads
  for each row execute function vio_touch_updated_at();

-- -----------------------------------------------------------------------------
-- events — THE LEDGER. Append only.
--
-- One row per thing that happened, from any actor. This is the table the
-- interface's per-lead timeline reads, and the one that makes "sent but not
-- recorded" impossible to hide: the write-ahead `enroll_attempt` pattern that
-- saved us from double-mailing two people on 2026-08-31 becomes native here.
-- -----------------------------------------------------------------------------
create table if not exists events (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  lead_id      uuid references leads(id) on delete set null,
  -- Kept even if the lead row is ever removed: an audit trail that disappears
  -- with its subject is not an audit trail.
  lead_email   citext not null default '',
  actor        text not null,              -- n8n | instantly | hubspot | sendr | reoon | <staff email>
  action       text not null,              -- verified | drafted | page_created | enroll_attempt | enrolled | opened | replied | bounced | unsubscribed | booked | approved | suppressed | parked
  outcome      text not null default '',
  workflow     text not null default '',
  units        numeric,
  est_cost_usd numeric,
  payload      jsonb not null default '{}'::jsonb
);

create index if not exists events_lead_at_idx on events (lead_id, at desc);
create index if not exists events_at_idx      on events (at desc);
create index if not exists events_action_idx  on events (action);
create index if not exists events_email_idx   on events (lead_email);

-- -----------------------------------------------------------------------------
-- Append-only enforcement for events + suppression.
-- Convention is not enforcement. On the sheet, "append only" was a rule in a
-- document; here it is the database refusing.
-- -----------------------------------------------------------------------------
create or replace function vio_append_only()
returns trigger language plpgsql as $$
begin
  raise exception
    '% is append-only: % is not permitted. Record a new row describing the change instead.',
    tg_table_name, tg_op;
end $$;

drop trigger if exists events_append_only_trg on events;
create trigger events_append_only_trg before update or delete on events
  for each row execute function vio_append_only();

drop trigger if exists suppression_append_only_trg on suppression;
create trigger suppression_append_only_trg before update or delete on suppression
  for each row execute function vio_append_only();

-- -----------------------------------------------------------------------------
-- replies — what a prospect actually wrote, and who is handling it.
-- -----------------------------------------------------------------------------
create table if not exists replies (
  id           bigserial primary key,
  lead_id      uuid references leads(id) on delete cascade,
  lead_email   citext not null default '',
  received_at  timestamptz not null default now(),
  subject      text not null default '',
  body         text not null default '',
  sentiment    text not null default '',       -- positive | negative | neutral | out_of_office
  handled_by   text,
  handled_at   timestamptz,
  handled_as   text                            -- booked | parked | suppressed | ignored
);

create index if not exists replies_lead_idx     on replies (lead_id, received_at desc);
create index if not exists replies_unhandled_idx on replies (received_at desc) where handled_at is null;

-- -----------------------------------------------------------------------------
-- campaigns — which Instantly campaign a product sends through.
-- Replaces the hardcoded CAMPAIGNS map in VIO-enrol-email. `null` campaign id
-- means the product cannot send, which is deliberate: VisioneerIT has no
-- campaign yet and must refuse rather than borrow OryonIQ's.
-- -----------------------------------------------------------------------------
create table if not exists campaigns (
  id                    bigserial primary key,
  product               vio_product not null unique,
  instantly_campaign_id text,
  name                  text not null default '',
  daily_cap             int not null default 20,
  active                boolean not null default true,
  updated_at            timestamptz not null default now()
);

insert into campaigns (product, instantly_campaign_id, name, daily_cap, active)
values ('oryoniq', '77b2cd80-5bf2-4656-8857-b310858d5a77',
        'OryonIQ - Reach Engine Pilot (2026-08)', 20, true)
on conflict (product) do nothing;

insert into campaigns (product, instantly_campaign_id, name, daily_cap, active)
values ('visioneerit', null, '(none yet — must refuse rather than borrow OryonIQ''s)', 20, false)
on conflict (product) do nothing;

-- -----------------------------------------------------------------------------
-- intake_raw — the Inbox tab's replacement.
-- A staff paste or an uploaded spreadsheet arrives in whatever shape its source
-- gave it. The alias mapper reads `raw` (arbitrary keys), and the outcome is
-- written back here so the person who pasted it can see what happened to their
-- row — the thing the Inbox tab's `status` and `notes` columns do today.
-- -----------------------------------------------------------------------------
create table if not exists intake_raw (
  id            bigserial primary key,
  received_at   timestamptz not null default now(),
  submitted_by  text not null default '',
  batch_id      uuid,                              -- one upload = one batch
  raw           jsonb not null,
  status        text not null default 'pending',   -- pending | mapped | needs_review | dropped
  notes         text not null default '',
  lead_id       uuid references leads(id) on delete set null,
  processed_at  timestamptz
);

create index if not exists intake_pending_idx on intake_raw (received_at) where status = 'pending';
create index if not exists intake_batch_idx   on intake_raw (batch_id);

-- -----------------------------------------------------------------------------
-- staff_profiles — names for Supabase Auth users, so "who approved this" has
-- an answer in the interface.
-- -----------------------------------------------------------------------------
create table if not exists staff_profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      citext not null,
  full_name  text not null default '',
  role       text not null default 'staff',    -- staff | admin
  created_at timestamptz not null default now()
);

-- =============================================================================
-- SUPPRESSION LOOKUP
-- The single question the pipeline asks before every send.
-- =============================================================================
create or replace function is_suppressed(
  p_email    text default null,
  p_domain   text default null,
  p_phone    text default null,
  p_linkedin text default null
) returns boolean language sql stable as $$
  select exists (
    select 1 from suppression s
    where s.match_keys && (
        coalesce(vio_email_keys(p_email), '{}')
      || coalesce(vio_domain_chain(p_domain), '{}')
      -- the address's own domain, so suppressing x.com blocks a@mail.x.com
      || case when p_email is null or position('@' in p_email) = 0 then '{}'::text[]
              else vio_domain_chain(split_part(vio_canon(p_email), '@', 2)) end
      || case when p_phone    is null then '{}'::text[] else array[vio_canon(p_phone)]    end
      || case when p_linkedin is null then '{}'::text[] else array[vio_canon(p_linkedin)] end
    )
  );
$$;

comment on function is_suppressed is
  'True if ANY identifier matches the append-only suppression list, after canonicalisation. Call before every send.';

-- =============================================================================
-- VIEWS
-- =============================================================================

-- What VIO-run-outreach may act on. Replaces the sheet filter, and the
-- suppression re-check is now part of the definition rather than a separate
-- step a future edit could forget.
create or replace view leads_ready as
  select l.*
  from leads l
  join campaigns c on c.product = l.product
  where l.channel_state_email in ('not_sent', 'approved')
    and c.instantly_campaign_id is not null
    and c.active
    and l.contact_email <> ''
    and not is_suppressed(l.contact_email::text, l.company_domain::text, l.phone, l.linkedin_url);

-- The per-lead timeline the interface shows.
create or replace view lead_timeline as
  select e.id, e.at, e.lead_id, coalesce(l.contact_email, e.lead_email) as email,
         l.first_name, l.company, e.actor, e.action, e.outcome, e.workflow, e.payload
  from events e
  left join leads l on l.id = e.lead_id
  order by e.at desc;

-- The dashboard row.
create or replace view daily_stats as
  select date_trunc('day', at)::date as day,
         count(*) filter (where action = 'enrolled')     as sent,
         count(*) filter (where action = 'opened')       as opened,
         count(*) filter (where action = 'replied')      as replied,
         count(*) filter (where action = 'booked')       as booked,
         count(*) filter (where action = 'bounced')      as bounced,
         count(*) filter (where action = 'unsubscribed') as unsubscribed,
         round(sum(coalesce(est_cost_usd, 0))::numeric, 4) as est_cost_usd
  from events
  group by 1 order by 1 desc;

-- =============================================================================
-- ROW LEVEL SECURITY
--
-- n8n connects with the service_role key, which bypasses RLS entirely — that is
-- correct and intended for the pipeline.
--
-- ⚠️ The Phase 2 interface must NOT use that key. A browser gets the ANON key,
-- and these policies are what stand between a logged-in staff member and the
-- whole table. Read is open to any authenticated user; writes are deliberately
-- absent, so a staff action has to go through n8n (which records an event)
-- rather than being written straight into a table. Add narrower policies when
-- the interface exists — do not widen these to get something working.
-- =============================================================================
alter table leads          enable row level security;
alter table events         enable row level security;
alter table suppression    enable row level security;
alter table replies        enable row level security;
alter table campaigns      enable row level security;
alter table intake_raw     enable row level security;
alter table staff_profiles enable row level security;

do $$
declare t text;
begin
  foreach t in array array['leads','events','suppression','replies','campaigns','intake_raw'] loop
    execute format(
      'drop policy if exists %I on %I; create policy %I on %I for select to authenticated using (true);',
      t || '_read', t, t || '_read', t);
  end loop;
end $$;

drop policy if exists staff_profiles_self on staff_profiles;
create policy staff_profiles_self on staff_profiles
  for select to authenticated using (id = auth.uid());

-- =============================================================================
-- SEED: carry over what the sheet already knows.
-- The RFC 2606 reserved domain has been on the suppression list since
-- 2026-08-17 and must never be mailed.
-- =============================================================================
insert into suppression (identifier_type, identifier_value, reason, added_by)
select 'domain', 'example.com', 'manual',
       'VIO-intake-verify-curate (build verification; RFC 2606 reserved domain, never a real prospect)'
where not exists (select 1 from suppression where identifier_value = 'example.com');

insert into suppression (identifier_type, identifier_value, reason, added_by)
select 'domain', d, 'reserved test domain — never a real prospect', 'migration 001'
from unnest(array['example.invalid', 'example.test', 'invalid', 'test']) d
where not exists (select 1 from suppression s where s.identifier_value = d);
