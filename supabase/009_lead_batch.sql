-- =============================================================================
-- 009 — batch id on leads so a CSV upload or Apollo reveal can be acted on
-- as a group (delete this load / approve all / verify with Reoon).
--
-- The console already wrote payload.batch_id onto the created event. That is
-- enough to backfill; new inserts stamp the columns directly.
-- =============================================================================

alter table leads
  add column if not exists batch_id text not null default '',
  add column if not exists batch_label text not null default '';

comment on column leads.batch_id is
  'One CSV upload or Apollo reveal. Empty for a single typed lead. '
  'Group delete / approve / verify use this, never a guess across loads.';

comment on column leads.batch_label is
  'What staff called this load — usually the filename, or "Apollo reveal".';

create index if not exists leads_batch_idx on leads (batch_id) where batch_id <> '';

update leads l
set
  batch_id = coalesce(nullif(l.batch_id, ''), e.payload->>'batch_id', ''),
  batch_label = coalesce(nullif(l.batch_label, ''), e.payload->>'filename', '')
from events e
where e.lead_id = l.id
  and e.action = 'created'
  and coalesce(e.payload->>'batch_id', '') <> '';

do $$
declare
  event_batches int;
  lead_batches int;
begin
  select count(distinct payload->>'batch_id') into event_batches
    from events
   where action = 'created'
     and coalesce(payload->>'batch_id', '') <> '';
  select count(distinct batch_id) into lead_batches
    from leads
   where batch_id <> '';
  if event_batches > 0 and lead_batches = 0 then
    raise exception '009_lead_batch: created events have batch_id but no lead was backfilled';
  end if;
end $$;
