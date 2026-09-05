-- =============================================================================
-- Migration 003 — let a lead row be deleted without breaking the ledger.
--
-- THE BUG
-- `events.lead_id` is declared `references leads(id) on delete set null`, and
-- 001's comment explains why: "an audit trail that disappears with its subject
-- is not an audit trail". But that clause is unreachable. Nulling `lead_id` is
-- an UPDATE on `events`, and the append-only trigger refuses every UPDATE, so
-- deleting any lead that has ever been touched fails with:
--
--   events is append-only: UPDATE is not permitted.
--
-- The practical effect: no lead can ever be removed. A test row typed into the
-- console on its first day is in the table for good, in front of whoever is
-- shown the dashboard. Found on 2026-09-05 trying to clean up exactly that.
--
-- THE FIX
-- Permit precisely one UPDATE: the foreign key's own null-out, and only when
-- every other column is byte-for-byte unchanged. The comparison is done on the
-- whole row as jsonb minus `lead_id`, so a future column is covered without
-- anyone remembering to add it here — the failure mode of listing columns by
-- hand is that the list silently goes stale.
--
-- What is still refused, unchanged: editing an event, deleting an event, and
-- editing or deleting a suppression. `lead_email` is deliberately not cleared,
-- so an orphaned event still says who it was about.
-- =============================================================================

create or replace function vio_append_only()
returns trigger language plpgsql as $$
begin
  -- The single permitted mutation: `on delete set null` releasing the lead
  -- reference while leaving the event's content completely intact.
  if tg_op = 'UPDATE'
     and tg_table_name = 'events'
     and old.lead_id is not null
     and new.lead_id is null
     and (to_jsonb(new) - 'lead_id') = (to_jsonb(old) - 'lead_id')
  then
    return new;
  end if;

  raise exception
    '% is append-only: % is not permitted. Record a new row describing the change instead.',
    tg_table_name, tg_op;
end $$;

comment on function vio_append_only is
  'Refuses UPDATE and DELETE. The one exception: the events.lead_id foreign key nulling itself when a lead is deleted, with every other column unchanged.';

-- -----------------------------------------------------------------------------
-- Self-check. A migration that claims to fix something should prove it, and
-- prove it did not open anything else, in the same transaction it runs in.
-- -----------------------------------------------------------------------------
do $$
declare
  v_lead uuid;
  v_event bigint;
  v_ok boolean;
begin
  insert into leads (contact_email, product, first_name)
  values ('migration-003-selfcheck@vio-selfcheck.invalid', 'oryoniq', 'Selfcheck')
  returning id into v_lead;

  insert into events (lead_id, lead_email, actor, action)
  values (v_lead, 'migration-003-selfcheck@vio-selfcheck.invalid', 'migration', 'created')
  returning id into v_event;

  -- 1. the deletion that used to fail must now succeed
  delete from leads where id = v_lead;

  -- 2. the event must survive, orphaned but still readable
  select exists (
    select 1 from events
    where id = v_event and lead_id is null
      and lead_email = 'migration-003-selfcheck@vio-selfcheck.invalid'
      and action = 'created'
  ) into v_ok;
  if not v_ok then
    raise exception '003 self-check: the event did not survive its lead being deleted';
  end if;

  -- 3. a real edit must still be refused
  begin
    update events set action = 'tampered' where id = v_event;
    raise exception '003 self-check: an event UPDATE was allowed — the guard is now too wide';
  exception when sqlstate 'P0001' then
    if sqlmessage like '003 self-check%' then raise; end if;   -- our own alarm, not the guard
  end;

  -- 4. deleting an event must still be refused
  begin
    delete from events where id = v_event;
    raise exception '003 self-check: an event DELETE was allowed — the guard is now too wide';
  exception when sqlstate 'P0001' then
    if sqlmessage like '003 self-check%' then raise; end if;
  end;

  raise notice '003 self-check passed: lead deletable, event preserved, edits still refused.';
  -- The self-check event is left in place on purpose: it cannot be deleted, and
  -- pretending otherwise would mean widening the very guard just tested.
end $$;
