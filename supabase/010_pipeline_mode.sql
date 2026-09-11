-- =============================================================================
-- 010 — pipeline mode: staff choose You-decide / Hybrid / Autopilot.
--
-- Default is manual so a deploy cannot start spending Apollo. Autopilot uses
-- the saved Find-leads filters and a daily reveal cap. Catch-all addresses
-- still wait on a person in every mode.
-- =============================================================================

create table if not exists pipeline_settings (
  id int primary key default 1 check (id = 1),
  mode text not null default 'manual'
    check (mode in ('manual', 'hybrid', 'autopilot')),
  daily_reveal_cap int not null default 25
    check (daily_reveal_cap >= 0 and daily_reveal_cap <= 25),
  find jsonb not null default '{}'::jsonb,
  last_run_at timestamptz,
  last_result text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

comment on table pipeline_settings is
  'One row. How the You-steps run: staff pick people, hybrid auto-verifies CSVs, '
  'autopilot also searches and reveals up to daily_reveal_cap. Catch-alls never auto-release.';

insert into pipeline_settings (id) values (1)
on conflict (id) do nothing;

do $$
begin
  if (select mode from pipeline_settings where id = 1) is distinct from 'manual' then
    raise exception '010_pipeline_mode: new row must default to manual';
  end if;
end $$;
