// =============================================================================
// OryonIQ Outreach Console — server
//
// WHY THIS EXISTS AS A SERVER AND NOT A STATIC PAGE
// The Supabase service_role key bypasses row-level security completely. It must
// never reach a browser. So the browser talks to this process, this process
// talks to Supabase, and the key lives only in the container's environment.
// supabase/001_schema.sql says the interface must not use that key client-side;
// this is how that rule is kept while still allowing staff to act.
//
// THE LEDGER RULE
// Every staff action writes a row to `events` as well as changing `leads`.
// `events` is append-only at the database level (a trigger refuses UPDATE and
// DELETE), so "who released this lead, and when" cannot later be edited away.
// A state change that fails to record its event is treated as a failed action.
//
// Node 22 has fetch, crypto and http built in, so almost none of this needs a
// dependency, and a dependency-free service is one that cannot break on an
// npm outage or drift on a transitive upgrade while nobody is watching it.
// ONE exception: `xlsx` (SheetJS), pinned, for the bulk-upload feature. Hand
// parsing the real OOXML zip format correctly (shared strings, number
// formats, merged cells) is exactly the kind of thing a well-tested library
// earns its place for — the same reasoning that says "call the tested
// VIO-source-leads workflow" rather than re-implementing Apollo's filter gate
// a second time in this file.
// =============================================================================

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHmac, timingSafeEqual, randomBytes, scryptSync } from 'node:crypto';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, 'public');

const PORT = Number(process.env.PORT || 8080);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || '';
// Signing secret for the session cookie. If it is not set the process refuses to
// start rather than falling back to a constant — a predictable secret is the
// same as no login at all, and the failure would be silent.
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_HOURS = 12;

// Optional. Without them the Find-leads tab reports itself unavailable rather
// than half-working: the search runs through n8n, not from here.
const VIO_WEBHOOK_TOKEN = process.env.VIO_WEBHOOK_TOKEN || '';
const N8N_WEBHOOK_BASE = (process.env.N8N_WEBHOOK_BASE || 'https://n8n.industrialbriefs.com/webhook')
  .replace(/\/+$/, '');

for (const [name, value] of Object.entries({
  SUPABASE_URL, SUPABASE_SERVICE_KEY: SUPABASE_KEY, STAFF_PASSWORD, SESSION_SECRET,
})) {
  if (!value) {
    console.error(`[fatal] ${name} is not set. Refusing to start.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Supabase (PostgREST)
// ---------------------------------------------------------------------------
const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const headers = { ...SB_HEADERS };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // PostgREST puts the real reason in the body; the status alone is rarely
    // enough to tell an enum violation from a missing column.
    const err = new Error(`Supabase ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.supabase = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// The password, and how it can be changed.
//
// STAFF_PASSWORD in the environment is only the BOOTSTRAP value. Once someone
// changes the password in the console, a scrypt hash is written to a file on a
// docker volume and that file wins from then on. Two reasons for the file
// rather than the environment: a container cannot rewrite its own env, and a
// password that only exists as a deploy-time variable is one that nobody can
// rotate without ssh.
//
// Deleting the file is therefore the documented recovery path — it falls back
// to STAFF_PASSWORD, which is the only way back in if the password is lost.
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || '/data';
const AUTH_FILE = join(DATA_DIR, 'auth.json');

let auth = null;   // { salt, hash, epoch, updatedAt } — null means "use the env value"

const hashPassword = (password, salt) => scryptSync(password, salt, 64).toString('hex');

async function loadAuth() {
  try {
    const parsed = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
    if (parsed && parsed.salt && parsed.hash) {
      auth = parsed;
      console.log(`[auth ] using the stored password, last changed ${parsed.updatedAt || 'unknown'}`);
      return;
    }
    console.warn('[auth ] auth.json is malformed; falling back to STAFF_PASSWORD');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[auth ] could not read auth.json (${err.code}); using STAFF_PASSWORD`);
  }
  auth = null;
}

async function saveAuth(next) {
  await mkdir(DATA_DIR, { recursive: true });
  // Written to a temp name and renamed, so a crash mid-write cannot leave a
  // truncated file that locks everyone out of a password nobody knows.
  const tmp = `${AUTH_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(tmp, AUTH_FILE);
  auth = next;
}

// Every session carries the epoch it was issued under. Changing the password
// bumps it, which invalidates every cookie in existence — including the one
// belonging to the person who just changed it. That is the point: a password
// change that leaves old sessions alive has not really changed anything.
const currentEpoch = () => (auth ? Number(auth.epoch) || 0 : 0);

// Constant-time in both branches, so a wrong guess cannot be narrowed by timing.
function passwordMatches(given) {
  const g = String(given ?? '');
  if (auth) {
    const candidate = Buffer.from(hashPassword(g, auth.salt), 'hex');
    const stored = Buffer.from(auth.hash, 'hex');
    return candidate.length === stored.length && timingSafeEqual(candidate, stored);
  }
  const a = Buffer.from(g);
  const b = Buffer.from(STAFF_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Sessions — an HMAC-signed cookie. No server-side store, so a restart does not
// log everybody out, and there is no session table to grow unbounded.
// ---------------------------------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signSession(expiresAt, epoch) {
  const payload = b64u(`${expiresAt}.${epoch}`);
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function validSession(cookieValue) {
  if (!cookieValue || !cookieValue.includes('.')) return false;
  const [payload, sig] = cookieValue.split('.');
  const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const [expStr, epochStr] = Buffer.from(payload, 'base64url').toString().split('.');
  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return false;
  return Number(epochStr) === currentEpoch();
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// A crude but sufficient brake on password guessing: a handful of attempts per
// IP per minute. Without it a public URL with a shared password is a free
// offline-speed guessing oracle.
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const window = 60_000;
  const list = (attempts.get(ip) || []).filter((t) => now - t < window);
  list.push(now);
  attempts.set(ip, list);
  if (attempts.size > 5000) attempts.clear();   // never grow without bound
  return list.length > 8;
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------
const PRODUCTS = new Set(['oryoniq', 'visioneerit']);

// The sheet wrote 'OryonIQ' and 'oryoniq' interchangeably; the enum accepts only
// one of them. Normalising here means a legacy row does not fail the insert.
const normProduct = (p) => String(p || '').trim().toLowerCase();

async function recordEvent(ev) {
  return sb('events', { method: 'POST', body: [ev], prefer: 'return=representation' });
}

// The one place a lead is created, used by both the single-lead form and the
// bulk upload. Returns a uniform shape rather than throwing, so a bulk upload
// can report a per-row reason without one bad row aborting the whole batch.
// `campaignCache` is an optional Map<product, campaignRowOrNull> the caller
// already populated. A bulk upload passes one shared cache across every row so
// the campaigns table is read once per PRODUCT in the file, not once per row —
// with a real campaign lookup a network round trip away, "once per row" is the
// difference between an upload finishing in seconds and taking minutes.
// Measured live 2026-09-05: ~2 rows/sec fully sequential, so 1000 rows would
// have taken roughly 8 minutes inside one HTTP request — long past what any
// browser or reverse proxy would wait out.
async function addLead(fields, eventContext, campaignCache) {
  const email = String(fields.email || '').trim().toLowerCase();
  const product = normProduct(fields.product);

  if (!email || !email.includes('@')) {
    return { ok: false, status: 400, error: 'A work email address is required.' };
  }
  // A blank or unknown product REFUSES rather than guessing. Guessing wrong
  // puts the wrong company's pitch in front of a real person, and that cannot
  // be recalled. Same rule the inbox mapper enforces.
  if (!PRODUCTS.has(product)) {
    return { ok: false, status: 400, error: 'Pick a product. The system will not guess who is pitching.' };
  }

  let campaign;
  if (campaignCache) {
    if (!campaignCache.has(product)) {
      campaignCache.set(product, (await sb(`campaigns?select=*&product=eq.${product}`))[0] || null);
    }
    campaign = campaignCache.get(product);
  } else {
    campaign = (await sb(`campaigns?select=*&product=eq.${product}`))[0];
  }
  if (!campaign || !campaign.instantly_campaign_id || !campaign.active) {
    return { ok: false, status: 400,
      error: `${product} has no active campaign, so it cannot send. Refusing rather than borrowing another product's.` };
  }

  const domain = email.split('@')[1] || '';
  const suppressed = await sb(
    `rpc/is_suppressed?p_email=${encodeURIComponent(email)}&p_domain=${encodeURIComponent(domain)}`,
  );
  if (suppressed === true) {
    return { ok: false, status: 409, error: 'That address is on the never-contact list. Not added.' };
  }

  let lead;
  try {
    lead = (await sb('leads', {
      method: 'POST',
      prefer: 'return=representation',
      body: [{
        contact_email: email,
        first_name: String(fields.first || '').trim(),
        last_name: String(fields.last || '').trim(),
        company: String(fields.company || '').trim(),
        company_domain: String(fields.domain || domain).trim().toLowerCase(),
        title: String(fields.title || '').trim(),
        phone: String(fields.phone || '').trim(),
        linkedin_url: String(fields.linkedin_url || '').trim(),
        product,
        source: eventContext && eventContext.via === 'upload' ? 'upload' : 'console',
        // Not verified yet, so it is not ready to send. Reoon decides that,
        // not this form.
        channel_state_email: 'pending_approval',
        verify_action: 'unverified',
        created_by: 'console',
      }],
    }))[0];
  } catch (err) {
    if (err.status === 409) {
      return { ok: false, status: 409, error: 'That address is already in the pipeline.' };
    }
    throw err;
  }

  await recordEvent({
    lead_id: lead.id,
    lead_email: lead.contact_email,
    actor: 'console',
    action: 'created',
    outcome: 'pending_approval',
    workflow: 'console',
    payload: eventContext || {},
  });

  return { ok: true, lead };
}

// ---------------------------------------------------------------------------
// Header aliasing for uploaded files.
//
// Ported from VIO-inbox-mapper's "Map headers (alias table)" node, which
// handles this exact problem for pasted Sheet rows — a staff-supplied file
// arrives with headers in whatever shape its source gave it. Kept
// deliberately deterministic and in sync with that table rather than a
// separate guess at the same problem, which is how the Sheet and n8n's JS
// suppression logic drifted apart on 2026-09-05.
//
// ⚠️ WHAT THIS DOES NOT DO: the inbox mapper falls back to an OpenAI call for
// headers this table has never seen. That fallback is NOT ported here — this
// console has no OpenAI credential wired in, and adding one silently to parse
// a file header is a bigger step than this feature asked for. An unrecognised
// header is reported to the operator as "unmapped", not guessed by a model.
// ---------------------------------------------------------------------------
const ALIASES = {
  contact_email: ['email', 'emailaddress', 'workemail', 'businessemail', 'contactemail',
                  'primaryemail', 'mail', 'emailid', 'eaddress', 'personalemail'],
  first_name:    ['firstname', 'fname', 'givenname', 'first', 'forename'],
  last_name:     ['lastname', 'lname', 'surname', 'familyname', 'last'],
  _full_name:    ['fullname', 'name', 'contactname', 'leadname', 'personname', 'contact'],
  company:       ['company', 'companyname', 'organization', 'organisation', 'org', 'account',
                  'accountname', 'employer', 'business', 'firm'],
  title:         ['title', 'jobtitle', 'position', 'role', 'designation', 'jobrole', 'jobposition'],
  company_domain:['domain', 'companydomain', 'website', 'websiteurl', 'url', 'web', 'companyurl',
                  'site', 'companywebsite'],
  linkedin_url:  ['linkedin', 'linkedinurl', 'linkedinprofile', 'liprofile', 'profileurl', 'li'],
  phone:         ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'telephone', 'tel',
                  'directdial', 'cell', 'cellphone'],
  product_raw:   ['product'],
};
// Note this does NOT include 'product', unlike the Sheet's own control-column
// set it is otherwise copied from. There, `Product` is a dedicated column read
// directly by other code. Here, it is meant to flow through ALIAS_LOOKUP
// (product_raw) so a row can override the upload's default product — filtering
// it out here would silently make that override a no-op, which is worse than
// not having the feature: a bad value in that column would look refused-or-
// respected but actually just get ignored.
const CONTROL = new Set(['status', 'notes', 'row_number', 'source_config']);

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIAS_LOOKUP = {};
for (const [field, names] of Object.entries(ALIASES)) for (const n of names) ALIAS_LOOKUP[n] = field;

const clean = (v, cap = 200) => {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return '';
  return v.replace(/[ -]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap);
};

// Real uploads arrive SHOUTING: ROBERT, TRUSTED SOLUTIONS LLC. Only rewritten
// when the value has no lowercase at all, so correctly-typed names (McDonald,
// O'Brien) are left untouched.
const KEEP_UPPER = new Set(['LLC', 'INC', 'LLP', 'PLLC', 'PC', 'LP', 'LTD', 'PLC', 'CO', 'CORP',
  'USA', 'US', 'IT', 'AI', 'HR', 'IP', 'GSA', 'DOD']);
const fixCase = (s) => {
  if (!s || /[a-z]/.test(s)) return s;
  return s.replace(/[A-Za-z][A-Za-z'’.-]*/g, (w) => {
    const bare = w.replace(/[.,]+$/, '');
    if (KEEP_UPPER.has(bare) || bare.length <= 1) return w;
    return w.charAt(0) + w.slice(1).toLowerCase();
  });
};

// Maps one parsed row (a plain object of header -> cell value) onto the
// canonical field names, and reports which headers matched nothing.
function mapRow(row) {
  const mapped = {};
  const unmapped = [];
  for (const [key, rawVal] of Object.entries(row)) {
    if (CONTROL.has(norm(key))) continue;
    const field = ALIAS_LOOKUP[norm(key)];
    const val = clean(rawVal);
    if (!field) { if (val) unmapped.push(key); continue; }
    if (val && !mapped[field]) mapped[field] = val; // first non-empty column wins
  }

  if (!mapped.first_name && mapped._full_name) {
    const parts = mapped._full_name.split(/\s+/).filter(Boolean);
    if (parts.length) mapped.first_name = parts[0];
    if (parts.length > 1 && !mapped.last_name) mapped.last_name = parts.slice(1).join(' ');
  }
  delete mapped._full_name;

  mapped.first_name = fixCase(mapped.first_name);
  mapped.last_name = fixCase(mapped.last_name);
  mapped.company = fixCase(mapped.company);
  if (mapped.company_domain) {
    mapped.company_domain = mapped.company_domain
      .replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  }
  if (mapped.contact_email) mapped.contact_email = mapped.contact_email.toLowerCase();

  return { first: mapped, unmapped };
}

// Parses CSV, XLSX and XLS via the same library call — it auto-detects the
// format from the buffer's own signature, so the extension is only used for a
// clearer error message, never trusted for parsing itself.
//
// raw:false asks the library to hand back each cell's DISPLAYED text rather
// than its internal type. Without that, a phone number typed into Excel as
// 5551234567 comes back as the JS number 5551234567 (silently losing a
// leading zero if there was one), and a cell that merely looks date-like can
// come back as a Date object instead of the text a person actually typed.
function parseSpreadsheet(buf, filename) {
  let workbook;
  try {
    workbook = XLSX.read(buf, { type: 'buffer', cellDates: false });
  } catch (err) {
    throw new Error(`"${filename}" does not look like a CSV or Excel file (${err.message}).`);
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('The file has no sheets.');
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  return rows;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('body is not valid JSON');
  }
}

const clientIP = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function handleAPI(req, res, url) {
  const path = url.pathname;

  // -- health: deliberately unauthenticated, and deliberately says nothing
  //    about the data. It reports whether this process can reach Supabase.
  if (path === '/api/health') {
    try {
      await sb('campaigns?select=product&limit=1');
      return sendJSON(res, 200, { ok: true, supabase: 'reachable' });
    } catch (err) {
      return sendJSON(res, 503, { ok: false, error: String(err.message).slice(0, 200) });
    }
  }

  if (path === '/api/login' && req.method === 'POST') {
    const ip = clientIP(req);
    if (rateLimited(ip)) return sendJSON(res, 429, { error: 'Too many attempts. Wait a minute.' });
    const body = await readBody(req);
    if (!passwordMatches(body.password)) {
      return sendJSON(res, 401, { error: 'That password is not right.' });
    }
    const expiresAt = Date.now() + SESSION_HOURS * 3600_000;
    const cookie = [
      `vio_session=${signSession(expiresAt, currentEpoch())}`,
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${SESSION_HOURS * 3600}`,
    ].join('; ');
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    return sendJSON(res, 200, { ok: true }, {
      'Set-Cookie': 'vio_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    });
  }

  // Everything past this point requires a session.
  if (!validSession(readCookie(req, 'vio_session'))) {
    return sendJSON(res, 401, { error: 'Not signed in.' });
  }

  // -- change the shared password -------------------------------------------
  if (path === '/api/password' && req.method === 'POST') {
    const ip = clientIP(req);
    // The current password is re-checked here, so a borrowed session on an
    // unlocked laptop cannot be used to lock the real staff out.
    if (rateLimited(ip)) return sendJSON(res, 429, { error: 'Too many attempts. Wait a minute.' });
    const body = await readBody(req);
    const next = String(body.next ?? '');

    // 403, deliberately not 401. The session IS valid; it is this one action
    // that is refused. The client treats every 401 as "your session died" and
    // bounces to the sign-in screen, so a 401 here would throw a person out of
    // the console for a typo in a form.
    if (!passwordMatches(body.current)) {
      return sendJSON(res, 403, { error: 'The current password is not right.' });
    }
    if (next.length < 8) {
      return sendJSON(res, 400, { error: 'The new password must be at least 8 characters.' });
    }
    if (passwordMatches(next)) {
      return sendJSON(res, 400, { error: 'That is already the password.' });
    }

    const salt = randomBytes(16).toString('hex');
    try {
      await saveAuth({
        salt,
        hash: hashPassword(next, salt),
        epoch: currentEpoch() + 1,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      // Almost always a volume that is missing or not writable by the `node`
      // user. Say that, rather than reporting a generic failure for something
      // the operator can fix in one command.
      console.error('[auth ] could not write auth.json:', err.message);
      return sendJSON(res, 500, {
        error: `The new password could not be saved (${err.code || 'write failed'}). `
             + `The password is unchanged. Check that ${DATA_DIR} is a writable volume.`,
      });
    }

    // The ledger records that it happened and when. It does not record what to.
    await recordEvent({
      actor: 'console',
      action: 'password_changed',
      outcome: 'ok',
      workflow: 'console',
      payload: { note: 'shared staff password changed in the console; all sessions invalidated' },
    }).catch((err) => console.error('[auth ] password changed but the event failed:', err.message));

    // The epoch bump above has already invalidated this very cookie. Clearing
    // it too means the browser is not left holding a token it cannot use.
    return sendJSON(res, 200, { ok: true, signedOut: true }, {
      'Set-Cookie': 'vio_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    });
  }

  // -- the whole dashboard in one round trip -------------------------------
  if (path === '/api/state') {
    // Counted by fetching ids rather than by reading PostgREST's Content-Range
    // header, because this helper hands back only the parsed body. The list is
    // small and this keeps the count honest instead of approximate.
    //
    // ⚠️ Leads are fetched as two separate queries — active first, dropped
    // second — rather than one `order=updated_at.desc` over everything.
    // Found live 2026-09-05: a single bulk correction that touches many
    // `dropped` rows at once (cleaning up test data, say) bumps their
    // `updated_at` to the same instant, and a pure recency sort then buries
    // every genuinely active lead under however many dropped rows exist,
    // pushing them clean off the end of the `limit`. `dropped` is terminal —
    // nobody needs to see it before the leads still waiting on a decision.
    const [active, droppedRecent, activeCountRows, replies, campaigns, suppressionRows, todayEvents] = await Promise.all([
      sb('leads?select=*&channel_state_email=neq.dropped&order=updated_at.desc&limit=2000'),
      sb('leads?select=*&channel_state_email=eq.dropped&order=updated_at.desc&limit=200'),
      sb('leads?select=id&channel_state_email=neq.dropped&limit=5000'),
      sb('replies?select=*&order=received_at.desc&limit=200'),
      sb('campaigns?select=*'),
      sb('suppression?select=id'),
      sb(`events?select=action,at&at=gte.${new Date().toISOString().slice(0, 10)}T00:00:00Z&limit=2000`),
    ]);
    const leads = [...active, ...droppedRecent];

    const cap = (campaigns.find((c) => c.product === 'oryoniq') || {}).daily_cap ?? 20;

    const sentToday = todayEvents.filter((e) => e.action === 'enrolled').length;

    return sendJSON(res, 200, {
      leads,
      replies,
      campaigns,
      stats: {
        sentToday,
        dailyCap: cap,
        // The count a person glances at should say how many leads are ALIVE,
        // not how many rows merely exist — a graveyard of dropped test data
        // or genuinely dead leads should never inflate the number staff read
        // as "how much is there to work through".
        activeLeadCount: activeCountRows.length,
        awaitingYou: active.filter(
          (l) => l.verify_action === 'needs_review' || l.channel_state_email === 'pending_approval',
        ).length,
        unreadReplies: replies.filter((r) => !r.handled_at).length,
        meetings: leads.filter((l) => l.meeting_booked_at).length,
        suppressed: suppressionRows.length,
      },
      serverTime: new Date().toISOString(),
    });
  }

  // -- find people in Apollo ------------------------------------------------
  //
  // This does NOT call Apollo. It calls VIO-source-leads, which already holds a
  // filter gate that refuses any value Apollo would silently ignore, and which
  // has a test suite read straight out of the deployed workflow. Re-implementing
  // the search here would mean two filter gates drifting apart, and the failure
  // that causes is the quiet one: an operator narrows a search, gets a plausible
  // list, and pulls people who match none of what they asked for.
  //
  // The token never reaches the browser — that endpoint returns real people's
  // names, so an open copy of it would leak a prospect list.
  if (path === '/api/find' && req.method === 'POST') {
    if (!VIO_WEBHOOK_TOKEN) {
      return sendJSON(res, 501, {
        error: 'Apollo search is not configured here. Set VIO_WEBHOOK_TOKEN in the console environment.',
      });
    }
    const body = await readBody(req);
    const upstream = await fetch(`${N8N_WEBHOOK_BASE}/vio-source-leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vio-token': VIO_WEBHOOK_TOKEN },
      body: JSON.stringify({
        product: body.product,
        titles: body.titles,
        seniorities: body.seniorities,
        employee_ranges: body.employee_ranges,
        locations: body.locations,
        keywords: body.keywords,
        per_page: body.per_page,
        page: body.page,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      // ⚠️ The filter gate's refusal reason does NOT survive the webhook. n8n
      // replies with a bare {"message":"Error in workflow"} and keeps the
      // `REFUSED: ...` text in its own execution log (measured 2026-09-05). So
      // the reason is matched for in case a future n8n version passes it
      // through, and otherwise the message says what to check rather than
      // inventing a cause it cannot know.
      const reason = (text.match(/REFUSED:[^"'\\}]+/) || [])[0];
      if (reason) return sendJSON(res, 400, { error: reason });
      return sendJSON(res, 400, {
        error: 'The search was refused. The usual cause is a filter value Apollo does not '
             + 'recognise, or more than 25 job titles. The exact reason is in the n8n execution log '
             + 'for VIO-source-leads — the webhook does not pass it back.',
      });
    }
    let data;
    try { data = JSON.parse(text); } catch { return sendJSON(res, 502, { error: 'The search returned something that is not JSON.' }); }
    return sendJSON(res, 200, data);
  }

  // -- one lead's ledger ----------------------------------------------------
  const timelineMatch = path.match(/^\/api\/leads\/([0-9a-f-]{36})\/timeline$/i);
  if (timelineMatch) {
    const events = await sb(
      `events?select=*&lead_id=eq.${timelineMatch[1]}&order=at.desc&limit=200`,
    );
    return sendJSON(res, 200, { events });
  }

  // -- add one lead ---------------------------------------------------------
  if (path === '/api/leads' && req.method === 'POST') {
    const body = await readBody(req);
    const result = await addLead(body, { via: 'add one lead form' });
    if (!result.ok) return sendJSON(res, result.status, { error: result.error });
    return sendJSON(res, 201, { lead: result.lead });
  }

  // -- add many leads from an uploaded file ----------------------------------
  //
  // Every row runs through the SAME addLead() the single-lead form uses. That
  // is deliberate: "never guess a product", "check suppression before
  // insert", "a duplicate address is refused" are rules that must hold
  // identically whether a person typed one lead or pasted five hundred. A
  // second copy of those rules here would drift from the first one the moment
  // either is edited alone — the exact failure this project has hit before
  // (Sheet vs n8n JS suppression logic, 2026-09-05).
  if (path === '/api/leads/upload' && req.method === 'POST') {
    // Raised well past the default 1MB: a base64-encoded spreadsheet runs
    // about a third bigger than the file itself, and a few hundred rows of
    // xlsx can genuinely be a few MB.
    const body = await readBody(req, 15_000_000);
    const filename = String(body.filename || 'upload');
    const defaultProduct = normProduct(body.product);

    if (!body.content_base64) {
      return sendJSON(res, 400, { error: 'No file content received.' });
    }
    // The default product is required even though a per-row Product column
    // can override it — most uploads will not have that column, and a blank
    // default here would mean guessing for every row in the file at once.
    if (!PRODUCTS.has(defaultProduct)) {
      return sendJSON(res, 400, { error: 'Pick a product for this upload. Rows may still override it with their own Product column.' });
    }

    let buf;
    try {
      buf = Buffer.from(body.content_base64, 'base64');
    } catch {
      return sendJSON(res, 400, { error: 'The file content is not valid base64.' });
    }
    if (buf.length > 10_000_000) {
      return sendJSON(res, 400, { error: 'That file is over 10MB. Split it into smaller files.' });
    }

    let rows;
    try {
      rows = parseSpreadsheet(buf, filename);
    } catch (err) {
      return sendJSON(res, 400, { error: `Could not read that file: ${err.message}` });
    }
    if (!rows.length) {
      return sendJSON(res, 400, { error: 'That file has no data rows.' });
    }

    // ⚠️ CAP measured live 2026-09-05: fully sequential (the first cut of this
    // endpoint), a 1200-row file was still running after 3 minutes at roughly
    // 2 rows/sec — every row was 3-4 separate round trips to Supabase, and a
    // 1000-row cap would have taken on the order of 8 minutes inside ONE HTTP
    // request. No browser tab or reverse proxy is going to sit through that.
    // The fix below (cache the campaign lookup once per product instead of
    // once per row, and run rows with bounded concurrency) makes a real
    // difference, but the cap is still set to something that finishes in well
    // under a minute rather than something that merely finishes eventually.
    const CAP = 300;
    const overCap = rows.length > CAP;
    if (overCap) rows = rows.slice(0, CAP);

    const batchId = randomBytes(8).toString('hex');
    // One lookup per PRODUCT actually present in the file, shared by every
    // row that needs it — not one lookup per row. Passed into every addLead()
    // call below.
    const campaignCache = new Map();

    // Map each row first, entirely locally — no Supabase calls yet. This does
    // two things at once: it is what lets duplicate ADDRESSES WITHIN THE SAME
    // FILE be caught here (first occurrence wins, everything after it is
    // reported as a duplicate) rather than racing each other as concurrent
    // check-then-insert calls against Supabase, and it means the concurrency
    // limiter below only ever schedules real, distinct work.
    const seenInFile = new Map(); // lowercased email -> first row number that used it
    const planned = [];
    const results = [];
    const tally = { added: 0, duplicate: 0, suppressed: 0, invalid: 0, no_email: 0, refused: 0 };

    for (let i = 0; i < rows.length; i++) {
      const mapped = mapRow(rows[i]);
      const rowNum = i + 2; // header is row 1 in the source file
      const email = mapped.first.contact_email;

      if (!email) {
        const reason = mapped.unmapped.length
          ? `No email column recognised. Unmatched headers: ${mapped.unmapped.join(', ')}`
          : 'This row has no email address.';
        results.push({ row: rowNum, email: '', outcome: 'no_email', reason });
        tally.no_email++;
        continue;
      }

      if (seenInFile.has(email)) {
        results.push({ row: rowNum, email, outcome: 'duplicate',
          reason: `Same address as row ${seenInFile.get(email)} in this file.` });
        tally.duplicate++;
        continue;
      }
      seenInFile.set(email, rowNum);

      // A row's own Product column wins if it names one of the two known
      // products; anything else in that column is refused rather than
      // silently falling back to the upload's default — a typo'd product on
      // one row must not quietly become a correct-looking guess.
      let rowProduct = defaultProduct;
      if (mapped.first.product_raw) {
        const asked = normProduct(mapped.first.product_raw);
        if (!PRODUCTS.has(asked)) {
          results.push({ row: rowNum, email, outcome: 'refused',
            reason: `Unrecognised product "${mapped.first.product_raw}" in this row. Fix it or remove the column.` });
          tally.refused++;
          continue;
        }
        rowProduct = asked;
      }

      planned.push({ rowNum, email, product: rowProduct, mapped: mapped.first });
    }

    // Bounded concurrency: several rows' worth of Supabase round trips in
    // flight at once, capped so this does not turn into 300 simultaneous
    // requests hitting Supabase (and this container's own open-connection
    // limit) at the same instant. Every distinct email was already isolated
    // above, so nothing here can race against another in-flight row.
    const CONCURRENCY = 8;
    let cursor = 0;
    async function worker() {
      while (cursor < planned.length) {
        const job = planned[cursor++];
        const outcome = await addLead({
          email: job.email,
          first: job.mapped.first_name,
          last: job.mapped.last_name,
          company: job.mapped.company,
          domain: job.mapped.company_domain,
          title: job.mapped.title,
          phone: job.mapped.phone,
          linkedin_url: job.mapped.linkedin_url,
          product: job.product,
        }, { via: 'upload', filename, batch_id: batchId, row: job.rowNum }, campaignCache);

        if (outcome.ok) {
          results.push({ row: job.rowNum, email: job.email, outcome: 'added', reason: '' });
          tally.added++;
        } else if (outcome.status === 409 && /never-contact/.test(outcome.error)) {
          results.push({ row: job.rowNum, email: job.email, outcome: 'suppressed', reason: outcome.error });
          tally.suppressed++;
        } else if (outcome.status === 409) {
          results.push({ row: job.rowNum, email: job.email, outcome: 'duplicate', reason: outcome.error });
          tally.duplicate++;
        } else {
          results.push({ row: job.rowNum, email: job.email, outcome: 'invalid', reason: outcome.error });
          tally.invalid++;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, planned.length) }, worker));

    // The concurrent workers finish out of row order; the response should not.
    results.sort((a, b) => a.row - b.row);

    return sendJSON(res, 200, {
      filename, batch_id: batchId, total_rows: rows.length, capped: overCap, cap: CAP,
      ...tally, results,
    });
  }

  // -- release a lead a human vouches for -----------------------------------
  const releaseMatch = path.match(/^\/api\/leads\/([0-9a-f-]{36})\/release$/i);
  if (releaseMatch && req.method === 'POST') {
    const id = releaseMatch[1];
    const lead = (await sb(`leads?select=*&id=eq.${id}`))[0];
    if (!lead) return sendJSON(res, 404, { error: 'No such lead.' });

    // A dropped lead is terminal. Releasing one would mail an address Reoon
    // already proved is not real, so the refusal is the point.
    if (lead.channel_state_email === 'dropped') {
      return sendJSON(res, 409, { error: 'This lead was dropped. That is terminal and cannot be undone here.' });
    }

    const updated = (await sb(`leads?id=eq.${id}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: {
        channel_state_email: 'approved',
        verify_action: 'pass',
        verify_reason: 'released by a person in the console',
      },
    }))[0];

    await recordEvent({
      lead_id: id,
      lead_email: lead.contact_email,
      actor: 'console',
      action: 'approved',
      outcome: 'approved',
      workflow: 'console',
      payload: { previous_state: lead.channel_state_email, previous_verdict: lead.verify_action },
    });

    return sendJSON(res, 200, { lead: updated });
  }

  // -- never contact --------------------------------------------------------
  const suppressMatch = path.match(/^\/api\/leads\/([0-9a-f-]{36})\/suppress$/i);
  if (suppressMatch && req.method === 'POST') {
    const id = suppressMatch[1];
    const body = await readBody(req);
    const lead = (await sb(`leads?select=*&id=eq.${id}`))[0];
    if (!lead) return sendJSON(res, 404, { error: 'No such lead.' });

    // Suppression first, state second. If the process dies between the two, the
    // safe half is the half that already happened: the address is blocked even
    // though the row still looks active.
    await sb('suppression', {
      method: 'POST',
      body: [{
        identifier_type: 'email',
        identifier_value: lead.contact_email,
        reason: String(body.reason || 'marked never-contact in the console'),
        added_by: 'console',
      }],
    });

    const updated = (await sb(`leads?id=eq.${id}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { channel_state_email: 'dropped', verify_action: 'drop', verify_reason: 'never-contact' },
    }))[0];

    await recordEvent({
      lead_id: id,
      lead_email: lead.contact_email,
      actor: 'console',
      action: 'suppressed',
      outcome: 'dropped',
      workflow: 'console',
      payload: { reason: body.reason || '' },
    });

    return sendJSON(res, 200, { lead: updated });
  }

  // -- handle a reply -------------------------------------------------------
  const replyMatch = path.match(/^\/api\/replies\/(\d+)\/handle$/);
  if (replyMatch && req.method === 'POST') {
    const id = Number(replyMatch[1]);
    const body = await readBody(req);
    const as = String(body.as || '');
    if (!['booked', 'parked', 'suppressed', 'ignored'].includes(as)) {
      return sendJSON(res, 400, { error: 'Unknown action for a reply.' });
    }
    const reply = (await sb(`replies?select=*&id=eq.${id}`))[0];
    if (!reply) return sendJSON(res, 404, { error: 'No such reply.' });

    const updated = (await sb(`replies?id=eq.${id}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { handled_by: 'console', handled_at: new Date().toISOString(), handled_as: as },
    }))[0];

    if (as === 'booked' && reply.lead_id) {
      await sb(`leads?id=eq.${reply.lead_id}`, {
        method: 'PATCH',
        body: { channel_state_email: 'booked', meeting_booked_at: new Date().toISOString() },
      });
    }
    if (as === 'suppressed' && reply.lead_email) {
      await sb('suppression', {
        method: 'POST',
        body: [{
          identifier_type: 'email',
          identifier_value: reply.lead_email,
          reason: 'asked not to be contacted, in a reply',
          added_by: 'console',
        }],
      });
      if (reply.lead_id) {
        await sb(`leads?id=eq.${reply.lead_id}`, {
          method: 'PATCH',
          body: { channel_state_email: 'dropped', verify_action: 'drop', verify_reason: 'never-contact' },
        });
      }
    }

    await recordEvent({
      lead_id: reply.lead_id,
      lead_email: reply.lead_email,
      actor: 'console',
      action: as === 'booked' ? 'booked' : as,
      outcome: as,
      workflow: 'console',
      payload: { reply_id: id },
    });

    return sendJSON(res, 200, { reply: updated });
  }

  return sendJSON(res, 404, { error: 'No such endpoint.' });
}

async function serveStatic(req, res, url) {
  // Any non-API path serves the app shell, so a refresh on a deep link works.
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  // normalize() collapses `..` before it is joined, so a crafted path cannot
  // escape the public directory.
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  let file = join(PUBLIC, safe);
  if (!file.startsWith(PUBLIC)) file = join(PUBLIC, 'index.html');

  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    res.end(data);
  } catch {
    const data = await readFile(join(PUBLIC, 'index.html')).catch(() => null);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    res.end(data);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleAPI(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error('[error]', req.method, url.pathname, err.message);
    // The client gets a short reason; the full Supabase body stays in the log,
    // because it can contain column and constraint detail.
    if (!res.headersSent) sendJSON(res, 500, { error: String(err.message).slice(0, 300) });
    else res.end();
  }
});

await loadAuth();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ready] console on :${PORT} → ${SUPABASE_URL}`);
  console.log(`[find ] apollo search ${VIO_WEBHOOK_TOKEN ? 'via ' + N8N_WEBHOOK_BASE : 'DISABLED (no VIO_WEBHOOK_TOKEN)'}`);
});
