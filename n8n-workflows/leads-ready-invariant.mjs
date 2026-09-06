// The one place that says which lifecycle states mean "may be sent".
//
// WHY THIS EXISTS
// This agreement has broken twice, and both times it was silent.
//
//   2026-08-29 — intake stamped `not_sent` and the runner required the column to be BLANK. Every
//                verified, staff-typed lead landed in Leads, looked correct to a human, and was
//                never picked up.
//   2026-09-05 — the runner accepted only `source_config = manual`, so the first real Apollo lead
//                was skipped on every poll for the same silent reason.
//
// The two sides now live in different languages: intake writes a state in JavaScript, and the
// sender selects on it in SQL, inside the `leads_ready` view. A constant copied into both would
// drift exactly the way the two previous versions did — so this parses the READY SET OUT OF THE
// MIGRATION that defines the view, and every suite that cares imports it from here.
//
// If someone changes the view, this changes with it. If someone changes only one side, the tests
// that import this stop agreeing and fail.
import { readFileSync } from 'node:fs';

const SQL_PATH = new URL('../supabase/005_leads_ready_source.sql', import.meta.url);
const sql = readFileSync(SQL_PATH, 'utf8');

const grab = (column) => {
  const m = new RegExp(`${column}\\s+in\\s*\\(([^)]*)\\)`, 'i').exec(sql);
  if (!m) throw new Error(`leads-ready-invariant: no "${column} in (...)" in ${SQL_PATH.pathname}`);
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
};

/** Lifecycle states the sender is allowed to act on. */
export const READY_STATES = grab('l.channel_state_email');

/** Where a lead may have come from and still be sent automatically. */
export const ALLOWED_SOURCES = grab('l.source');

if (READY_STATES.length === 0 || ALLOWED_SOURCES.length === 0) {
  throw new Error('leads-ready-invariant: parsed an empty set — the view definition moved');
}
