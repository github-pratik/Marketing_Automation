-- =============================================================================
-- 003 — a lead needs to remember its Apollo identity
--
-- Found while moving VIO-intake-verify-curate off Google Sheets (2026-09-05).
--
-- The sheet's `Leads` tab carried BOTH `contact_email` and `apollo_id`, and the
-- intake gate de-duplicated on either one. This schema kept only the address, so
-- porting the gate as-written would have quietly dropped half the check:
--
--   * The same person can arrive under two addresses — a personal alias and a
--     work address, or a role account and a named one. Apollo's person id is the
--     same both times; the email is not.
--   * VIO-apollo-reveal de-duplicates BEFORE it spends a credit, and at that
--     point in the chain the address has not been bought yet. The Apollo id is
--     the ONLY identifier that exists. Without this column that check has nothing
--     to read, and every pull would pay again for people we already hold.
--
-- Nullable, because most leads have no Apollo id at all: a lead typed by a human
-- or uploaded from a spreadsheet never had one, and inventing a placeholder would
-- make those rows collide with each other. UNIQUE only over the non-null values,
-- which is exactly what a partial index gives.
-- =============================================================================

alter table leads add column if not exists apollo_id citext;

comment on column leads.apollo_id is
  'Apollo''s own person id when the lead came from Apollo, else NULL. The only identifier that '
  'exists before a paid reveal, so it is what VIO-apollo-reveal checks to avoid buying the same '
  'address twice.';

-- A partial unique index: two Apollo leads may never share an id, but any number
-- of hand-typed leads may share NULL. A plain UNIQUE would also allow that in
-- Postgres, but stating it as a partial index says the intent out loud and keeps
-- the index off every row that will never be searched by it.
create unique index if not exists leads_apollo_id_key
  on leads (apollo_id) where apollo_id is not null;

-- -----------------------------------------------------------------------------
-- Backfill what we already know.
--
-- Harrison came in through VIO-apollo-reveal before this column existed, and his
-- Apollo id is sitting in the events ledger that recorded the reveal. Reading it
-- back from there is not guesswork — it is the same value the workflow sent.
-- -----------------------------------------------------------------------------
update leads l set apollo_id = e.aid
from (
  select lead_email, max(payload->>'apollo_id') as aid
  from events
  where action in ('revealed', 'sourced') and payload->>'apollo_id' is not null
  group by lead_email
) e
where vio_canon(l.contact_email::text) = vio_canon(e.lead_email::text)
  and l.apollo_id is null
  and e.aid is not null;

-- -----------------------------------------------------------------------------
-- Prove it, so a regression fails the migration rather than opening the hole again.
-- -----------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from leads where apollo_id is not null;
  if n = 0 then
    raise exception 'backfill matched nothing — expected at least the Apollo-sourced lead';
  end if;

  -- Many leads may have no Apollo id; that must stay legal.
  begin
    insert into leads (contact_email, product) values ('noapollo1@example.test', 'oryoniq');
    insert into leads (contact_email, product) values ('noapollo2@example.test', 'oryoniq');
  exception when others then
    raise exception 'two leads without an Apollo id collided: %', sqlerrm;
  end;

  -- Two leads may never SHARE one.
  begin
    update leads set apollo_id = 'dup_test_id' where contact_email = 'noapollo1@example.test';
    update leads set apollo_id = 'dup_test_id' where contact_email = 'noapollo2@example.test';
    raise exception 'two leads were allowed to share an apollo_id; the index is not working';
  exception when unique_violation then null;
  end;

  delete from leads where contact_email in ('noapollo1@example.test', 'noapollo2@example.test');
end $$;
