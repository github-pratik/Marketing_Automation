-- =============================================================================
-- 004 — somewhere for "is it actually running?" to live
--
-- The sheet has a `System` tab that each poller overwrites every cycle, so a
-- human glancing at it can tell a QUIET pipeline from a DEAD one. That question
-- does not answer itself from the events ledger: a healthy pipeline with no work
-- to do writes no events, and so does a scheduler that stopped firing three days
-- ago. On 2026-09-04 a poller misfired ~2,500 times in an hour and the only
-- reason anyone noticed was that Slack caught fire.
--
-- So the heartbeat is ported rather than dropped. One row per workflow, upserted
-- — this is deliberately NOT in `events`, which is append-only and is what the
-- console reads: 480 heartbeat rows a day would bury the ledger it exists to make
-- readable.
-- =============================================================================

create table if not exists system_status (
  workflow      text primary key,
  last_run_at   timestamptz not null default now(),
  every_minutes int,
  -- What the run found, in the words a person would use. Free text on purpose:
  -- this is read by a human deciding whether to worry, not queried by code.
  last_result   text not null default '',
  checked       text not null default '',
  waiting       int,
  ok            boolean not null default true,
  detail        jsonb not null default '{}'::jsonb
);

comment on table system_status is
  'Liveness board. One row per poller, overwritten each cycle. Answers "is this thing still '
  'running", which the events ledger cannot: a healthy idle pipeline and a dead scheduler both '
  'write nothing. Deliberately not in events — that table is append-only and a heartbeat every '
  'three minutes would bury it.';

comment on column system_status.waiting is
  'How many leads were ready to act on at that moment. A number that never falls is the signal '
  'that mail has stopped moving while every workflow still reports success.';

alter table system_status enable row level security;

-- Same shape as every other table here: staff may read, nothing may write except
-- n8n with the service_role key, which bypasses RLS. A heartbeat a browser could
-- forge is a heartbeat that proves nothing.
drop policy if exists system_status_read on system_status;
create policy system_status_read on system_status for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- Prove the upsert shape the workflow will use, then leave no test rows behind.
-- -----------------------------------------------------------------------------
do $$
declare n int;
begin
  insert into system_status (workflow, last_result, waiting, every_minutes)
  values ('migration-004-selftest', 'first write', 1, 3);

  insert into system_status (workflow, last_result, waiting, every_minutes)
  values ('migration-004-selftest', 'second write', 0, 3)
  on conflict (workflow) do update set
    last_run_at = now(),
    last_result = excluded.last_result,
    waiting     = excluded.waiting;

  select count(*) into n from system_status where workflow = 'migration-004-selftest';
  if n <> 1 then
    raise exception 'the heartbeat upsert made % rows; it must overwrite, not accumulate', n;
  end if;

  if (select last_result from system_status where workflow = 'migration-004-selftest')
     <> 'second write' then
    raise exception 'the second heartbeat did not overwrite the first';
  end if;

  delete from system_status where workflow = 'migration-004-selftest';
end $$;
