-- =============================================================================
-- 008 — lead priority for the console Kanban
--
-- Stage is already channel_state_email (enrolled = already sent). Staff also
-- need to say which of those people matter most. hot / normal / later is a
-- ranking, not a lifecycle — it never moves the runner.
-- =============================================================================

do $$ begin
  create type vio_priority as enum ('hot', 'normal', 'later');
exception when duplicate_object then null; end $$;

alter table leads
  add column if not exists priority vio_priority not null default 'normal';

comment on column leads.priority is
  'Staff ranking on the Kanban. Independent of channel_state_email. '
  'hot floats to the top of its stage; later sinks. The send runner ignores this.';
