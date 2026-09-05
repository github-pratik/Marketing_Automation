// =============================================================================
// Move the live Leads rows out of the Google Sheet and into Supabase.
//
// The source is not the sheet's API. It is the last successful VIO-run-outreach
// execution, which READ the sheet — the same 34-column rows the poller acted on,
// captured in n8n's execution record. That avoids needing the service-account
// key here, and it has a useful property: what gets migrated is exactly what the
// pipeline last saw, not a later hand-edit.
//
// ⚠️ THE EVENTS THIS WRITES ARE RECONSTRUCTED, AND SAY SO.
// The sheet never kept a ledger, so there is no true event history to import.
// Each backfilled row carries `payload.backfilled: true` and an explicit source,
// so nobody later mistakes a reconstruction for something that was observed as
// it happened. Timestamps that are known (created_at, updated_at, and the
// Instantly last-contact times) are used; nothing else is invented.
//
//   node console/migrate-leads.mjs --dry-run     # print what would be written
//   node console/migrate-leads.mjs --commit      # actually write
// =============================================================================

import { readFile } from 'node:fs/promises';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const COMMIT = process.argv.includes('--commit');
const SOURCE = process.argv.find((a) => a.startsWith('--source='))?.split('=')[1]
  || new URL('./sheet-rows.json', import.meta.url).pathname;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[fatal] SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.');
  process.exit(1);
}

const H = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const headers = { ...H };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// Instantly is the authority on when mail actually left, and it disagreed with
// the sheet for two of these rows — the sheet's `updated_at` stopped at the
// failed write, not at the send. These are the values read from the Instantly
// API on 2026-09-05.
const INSTANTLY_LAST_CONTACT = {
  'pratik.patil@visioneerit.com': '2026-09-02T13:07:00Z',
  'gavriel.legynd@visioneerit.com': '2026-09-02T13:16:00Z',
  'patilsp.0202@gmail.com': '2026-09-04T13:00:00Z',
};

const norm = (s) => String(s ?? '').trim();
const lower = (s) => norm(s).toLowerCase();

// The sheet's state vocabulary already matches the enum, with one exception:
// blank. A blank state on a row that was never verified is `pending_approval`,
// which is what the sheet's own runner treated it as.
function emailState(row) {
  const v = lower(row.channel_state_email);
  const allowed = new Set(['not_sent', 'needs_review', 'pending_approval', 'approved',
    'enrolled', 'replied', 'booked', 'bounced', 'unsubscribed', 'dropped']);
  return allowed.has(v) ? v : 'pending_approval';
}

function verifyAction(row) {
  const v = lower(row.verify_action);
  return ['pass', 'needs_review', 'drop'].includes(v) ? v : 'unverified';
}

function buildLead(row) {
  const email = lower(row.contact_email);
  return {
    contact_email: email,
    first_name: norm(row.first_name),
    last_name: norm(row.last_name),
    title: norm(row.title),
    company: norm(row.company),
    company_domain: lower(row.company_domain) || (email.split('@')[1] || ''),
    phone: norm(row.phone),
    linkedin_url: norm(row.linkedin_url),
    timezone: norm(row.timezone),
    // 'OryonIQ' and 'oryoniq' both appear on the sheet; the enum takes one.
    product: lower(row.Product) === 'visioneerit' ? 'visioneerit' : 'oryoniq',
    source: lower(row.source_config) === 'manual' ? 'manual' : (lower(row.source_config) || 'manual'),
    channel_state_email: emailState(row),
    verify_action: verifyAction(row),
    verify_reason: norm(row.verify_reason),
    reoon_status: norm(row.reoon_status),
    opener: norm(row.opener),
    email_draft: norm(row.email_draft),
    sendr_page_id: norm(row.sendr_page_id),
    sendr_page_url: norm(row.sendr_page_url),
    created_at: norm(row.created_at) || undefined,
    updated_at: norm(row.updated_at) || undefined,
    created_by: 'sheet-migration',
  };
}

// Only events we can actually stand behind, each tied to a fact in the row.
function buildEvents(row, leadId) {
  const email = lower(row.contact_email);
  const out = [];
  const mark = (at, action, outcome, extra = {}) => out.push({
    at, lead_id: leadId, lead_email: email,
    actor: 'sheet-migration', action, outcome, workflow: 'migration',
    payload: { backfilled: true, source: 'google sheet Leads tab, via n8n execution record', ...extra },
  });

  if (norm(row.created_at)) mark(row.created_at, 'created', 'added to the sheet');
  if (norm(row.reoon_status)) {
    mark(norm(row.updated_at) || row.created_at, 'verified', verifyAction(row),
      { reoon_status: row.reoon_status, reason: norm(row.verify_reason) });
  }
  if (norm(row.opener)) mark(norm(row.updated_at) || row.created_at, 'drafted', 'opener written', { by: 'openai' });
  if (norm(row.sendr_page_url)) {
    mark(norm(row.updated_at) || row.created_at, 'page_created', 'page built', { url: row.sendr_page_url });
  }
  // The one event with an independent witness: Instantly's own record.
  if (INSTANTLY_LAST_CONTACT[email]) {
    mark(INSTANTLY_LAST_CONTACT[email], 'enrolled', 'mail away',
      { source: 'Instantly API last_contact, read 2026-09-05', backfilled: true });
  }
  return out.sort((a, b) => new Date(a.at) - new Date(b.at));
}

const rows = JSON.parse(await readFile(SOURCE, 'utf8'));
console.log(`[source] ${rows.length} sheet rows from ${SOURCE}`);
console.log(COMMIT ? '[mode  ] COMMIT — this writes to Supabase' : '[mode  ] DRY RUN — nothing is written');

let written = 0, skipped = 0, events = 0;

for (const row of rows) {
  const email = lower(row.contact_email);
  if (!email || !email.includes('@')) { console.log(`  skip (no address): row ${row.row_number}`); skipped++; continue; }

  const existing = await sb(`leads?select=id&contact_email=eq.${encodeURIComponent(email)}`);
  if (existing.length) {
    console.log(`  skip (already in Supabase): ${email}`);
    skipped++;
    continue;
  }

  const lead = buildLead(row);
  if (!COMMIT) {
    const preview = buildEvents(row, '00000000-0000-0000-0000-000000000000');
    console.log(`  would write: ${email}  [${lead.channel_state_email}/${lead.verify_action}]  +${preview.length} events`);
    written++; events += preview.length;
    continue;
  }

  const created = (await sb('leads', { method: 'POST', prefer: 'return=representation', body: [lead] }))[0];
  const evs = buildEvents(row, created.id);
  if (evs.length) await sb('events', { method: 'POST', body: evs });
  console.log(`  wrote: ${email}  [${lead.channel_state_email}/${lead.verify_action}]  +${evs.length} events`);
  written++; events += evs.length;
}

console.log(`\n[done  ] ${written} lead(s), ${events} event(s), ${skipped} skipped.`);
if (!COMMIT) console.log('[next  ] re-run with --commit to write.');
