-- =============================================================================
-- 002 — a suppression entry must never silently match nothing
--
-- Found immediately after applying 001, by reading back what each row actually
-- blocks instead of trusting the insert:
--
--   domain  example.com  -> {example.com}
--   domain  invalid      -> {}            <-- blocks NOTHING
--   domain  test         -> {}            <-- blocks NOTHING
--
-- `vio_domain_chain` emits every suffix of a host EXCEPT the last label, so that
-- suppressing x.com can never block all of .com. Correct for a real domain. For
-- a single-label value the loop runs zero times, and the row is stored with no
-- keys — it looks like a suppression, reads like a suppression, and stops no
-- mail. The deployed JavaScript in VIO-enrol-email has the identical hole; the
-- parity test passed because both sides were equally wrong.
--
-- WHY SINGLE-LABEL IS REFUSED RATHER THAN SUPPORTED
-- The first attempt at this migration made a bare label block its own namespace,
-- so `invalid` stored {invalid}. Its own self-check caught that this still does
-- not work: LOOKUP builds candidate keys with the same chain, so an address at
-- foo.invalid generates {foo.invalid} and never {invalid}. Storage and lookup
-- disagreed. Fixing the lookup end would mean emitting bare TLDs as candidates,
-- and then one row saying `com` would suppress the entire internet.
--
-- So a single-label domain is ambiguous and dangerous, and is refused at insert
-- with a message that says what to write instead. Anything that would match
-- nothing is refused for the same reason: silently storing a suppression that
-- protects nobody is the worst outcome available — someone believes a person was
-- taken off the list, and they were not.
-- =============================================================================

create or replace function vio_suppression_keys()
returns trigger language plpgsql as $$
declare
  keys text[];
  v text;
begin
  v := vio_canon(new.identifier_value::text);

  if new.identifier_type = 'domain' and v <> '' and position('.' in v) = 0 then
    raise exception
      'suppression on the single label % is ambiguous: as a domain it can only be a whole TLD, '
      'and matching would then block every address under it. Write the full domain instead '
      '(for example %.com), or use identifier_type email for one address.',
      quote_literal(v), v;
  end if;

  if new.identifier_type = 'email' then
    keys := vio_email_keys(new.identifier_value::text);
  elsif new.identifier_type = 'domain' then
    keys := vio_domain_chain(new.identifier_value::text);
  else
    keys := array[v];
  end if;

  keys := array(select distinct k from unnest(coalesce(keys, '{}')) k where k <> '');

  if coalesce(array_length(keys, 1), 0) = 0 then
    raise exception
      'suppression entry %/% would match nothing — refusing to store a suppression that protects nobody',
      new.identifier_type, new.identifier_value;
  end if;

  new.match_keys := keys;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Repair what 001 and the first cut of 002 left behind.
--
-- `match_keys` is DERIVED data, so recomputing it is not rewriting history — the
-- identifier, timestamp, reason and author are untouched. The two bare-label
-- rows are removed outright: they were seeded by 001 minutes earlier, they have
-- never blocked anything, and leaving them would leave the table asserting a
-- protection that cannot fire. The append-only trigger is lifted for exactly
-- these two statements and put straight back.
-- -----------------------------------------------------------------------------
alter table suppression disable trigger suppression_append_only_trg;

delete from suppression
 where identifier_type = 'domain'
   and position('.' in vio_canon(identifier_value::text)) = 0;

update suppression s set match_keys = k.keys
from (
  select id,
         case when identifier_type = 'email'  then vio_email_keys(identifier_value::text)
              when identifier_type = 'domain' then vio_domain_chain(identifier_value::text)
              else array[vio_canon(identifier_value::text)]
         end as keys
  from suppression
) k
where k.id = s.id and s.match_keys is distinct from k.keys;

alter table suppression enable trigger suppression_append_only_trg;

-- -----------------------------------------------------------------------------
-- Prove it here, so a regression fails the migration instead of opening a hole.
-- -----------------------------------------------------------------------------
do $$
declare bad int;
begin
  select count(*) into bad from suppression
   where coalesce(array_length(match_keys, 1), 0) = 0;
  if bad > 0 then
    raise exception '% suppression row(s) still match nothing', bad;
  end if;

  -- every stored key must be reachable by the lookup that will be asked for it
  if not is_suppressed('anyone@example.invalid') then
    raise exception 'a stored domain suppression is not reachable from is_suppressed()';
  end if;
  if not is_suppressed('someone+tag@example.com') then
    raise exception 'plus-addressing bypasses a domain suppression';
  end if;
  if is_suppressed('dana@cardinalfederal.com') then
    raise exception 'suppression is over-matching: an unrelated address was blocked';
  end if;

  -- and the ambiguous form must be refused
  begin
    insert into suppression (identifier_type, identifier_value, reason, added_by)
      values ('domain', 'invalid', 'should be refused', 'migration 002 self-check');
    raise exception 'a single-label domain was accepted; the guard is not working';
  exception when others then
    if sqlerrm like '%is ambiguous%' then null; else raise; end if;
  end;
end $$;
