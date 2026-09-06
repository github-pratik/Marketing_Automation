-- =============================================================================
-- 005 — `leads_ready` must also say WHERE a lead may come from
--
-- Found while moving VIO-run-outreach onto this view (2026-09-05).
--
-- The sheet-based sender filtered on `source_config`, and the view did not carry
-- that filter at all. Porting the runner as written would have dropped the check
-- silently: `leads_ready` would have handed it every lead in a ready state,
-- whatever wrote it.
--
-- The original reason for the whitelist is gone — it was partly a loop guard,
-- back when the runner polled the same tab the pipeline wrote to, and the atomic
-- claim now makes that impossible. But the other half of it still stands, and it
-- is the half that matters: `source` is free text with a default, so a typo, a
-- half-finished integration, or a script someone writes next month can put any
-- string in it. None of those should start mailing real people the moment they
-- first run. A new source has to be added here, on purpose, by someone who has
-- thought about whether its leads are ready to be contacted.
--
-- The list is the four ways a lead can legitimately arrive today:
--   manual   — typed in, historically through the Inbox tab
--   console  — typed into the staff interface
--   upload   — a CSV or spreadsheet
--   apollo   — sourced and revealed through VIO-apollo-reveal
-- =============================================================================

create or replace view leads_ready as
  select l.*
  from leads l
  join campaigns c on c.product = l.product
  where l.channel_state_email in ('not_sent', 'approved')
    and l.source in ('manual', 'console', 'upload', 'apollo')
    and c.instantly_campaign_id is not null
    and c.active
    and l.contact_email <> ''
    and not is_suppressed(l.contact_email::text, l.company_domain::text, l.phone, l.linkedin_url);

comment on view leads_ready is
  'What VIO-run-outreach may act on. Every condition that decides whether a real person gets mailed '
  'lives here rather than in the workflow: the lifecycle state, the source whitelist, an active '
  'campaign for their product, and a fresh suppression check. A future edit to the sender cannot '
  'forget one of them.';

-- -----------------------------------------------------------------------------
-- Prove each condition actually excludes, so a later rewrite of the view cannot
-- quietly widen it.
-- -----------------------------------------------------------------------------
do $$
declare
  before_n int;
  after_n  int;
  probe    uuid;
begin
  select count(*) into before_n from leads_ready;

  insert into leads (contact_email, product, source, channel_state_email, verify_action)
  values ('view-probe@example.test', 'oryoniq', 'manual', 'not_sent', 'pass')
  returning id into probe;

  -- example.test is on the suppression list, so a ready lead there must NOT appear.
  select count(*) into after_n from leads_ready;
  if after_n <> before_n then
    raise exception 'a suppressed address reached leads_ready';
  end if;

  -- Move it to an address nobody has suppressed: now it should appear.
  update leads set contact_email = 'view-probe@vio-view-check.example' where id = probe;
  select count(*) into after_n from leads_ready;
  if after_n <> before_n + 1 then
    raise exception 'a clean, ready lead did NOT reach leads_ready';
  end if;

  -- An unknown source must drop out again.
  update leads set source = 'some-new-integration' where id = probe;
  select count(*) into after_n from leads_ready;
  if after_n <> before_n then
    raise exception 'an unrecognised source reached leads_ready — the whitelist is not working';
  end if;

  -- And so must a lead that has already been sent.
  update leads set source = 'manual', channel_state_email = 'enrolled' where id = probe;
  select count(*) into after_n from leads_ready;
  if after_n <> before_n then
    raise exception 'an already-enrolled lead reached leads_ready — it would be mailed twice';
  end if;

  delete from leads where id = probe;
end $$;
