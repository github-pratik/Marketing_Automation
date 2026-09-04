// Offline proof of VIO-inbox-mapper. Reads jsCode straight out of the workflow JSON.
//
// This workflow takes spreadsheets a human pasted in — arbitrary headers, real-world mess — and
// turns them into canonical leads. The risks are: importing a row that cannot be mailed, silently
// dropping a row the human is watching, calling the model when a lookup table would do, and
// choking on a 49,000-row upload.
import { readFileSync } from 'node:fs';
import { schemaViolations } from './sheets-schema-invariant.mjs';

const wf = JSON.parse(readFileSync(new URL('./VIO-inbox-mapper.json', import.meta.url)));
const jsOf = (name) => {
  const n = wf.nodes.find(x => x.name === name);
  if (!n) throw new Error(`no node "${name}"`);
  return n.parameters.jsCode;
};
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) pass++; else { console.error(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail++; } };

const mapCode = jsOf('Map headers (alias table)');
const map = (rows) => new Function('$input', mapCode)({ all: () => rows.map(j => ({ json: j })) })
  .map(i => i.json);
// Every usable row now needs a Product — staff choose it, nothing can infer it. The default keeps
// the ~200 assertions that are about column MAPPING focused on column mapping; the cases that are
// about the product itself pass their own value.
const one = (r) => { const o = map([{ row_number: 2, status: '', Product: 'OryonIQ', ...r }]);
                     return o.length ? o[0] : null; };

// ---------- the real upload shape (49,251 contacts) ----------
const real = one({ 'Company name': 'TRUSTED SOLUTIONS LLC', 'First name': 'ROBERT',
  'Last name': 'DEPASQUO', 'Email address': 'r.depasquo@tacticalchat.com', 'Website': 'tacticalchat.com' });
ok('maps "Company name"', real.company === 'Trusted Solutions LLC');
ok('maps "First name"', real.first_name === 'Robert');
ok('maps "Last name"', real.last_name === 'Depasquo');
ok('maps "Email address"', real.contact_email === 'r.depasquo@tacticalchat.com');
ok('maps "Website" to company_domain', real.company_domain === 'tacticalchat.com');
ok('the real upload needs NO model call', real._needs_llm === false);
ok('the real upload is usable', real._ok === true);

// ---------- header spelling variants ----------
for (const [header, field, val] of [
  ['Email', 'contact_email', 'a@b.com'], ['E-mail Address', 'contact_email', 'a@b.com'],
  ['work_email', 'contact_email', 'a@b.com'], ['EMAILADDRESS', 'contact_email', 'a@b.com'],
  ['FirstName', 'first_name', 'Ann'], ['Given Name', 'first_name', 'Ann'],
  ['Organisation', 'company', 'Acme'], ['org', 'company', 'Acme'], ['Account Name', 'company', 'Acme'],
  ['Job Title', 'title', 'CIO'], ['Position', 'title', 'CIO'], ['Designation', 'title', 'CIO'],
  ['LinkedIn URL', 'linkedin_url', 'https://li/x'], ['Mobile', 'phone', '555'],
]) {
  const r = one({ [header]: val, 'Email address': 'x@y.com', 'First name': 'Z', 'Company name': 'C' });
  ok(`"${header}" maps to ${field}`, String(r[field]).toLowerCase().includes(String(val).toLowerCase().slice(0, 5)));
}

// ---------- shouting ----------
ok('ALL CAPS first name is fixed', one({ 'First name': 'NATHANIEL', 'Email address': 'n@w.com', 'Company name': 'C' }).first_name === 'Nathaniel');
ok('entity suffixes stay upper',
   one({ 'Company name': 'GLOBAL RESPONSE & DEPLOYMENT INC', 'First name': 'A', 'Email address': 'a@b.com' }).company === 'Global Response & Deployment INC');
ok('a correctly-typed name is left alone',
   one({ 'First name': "Siobhan", 'Last name': "O'Brien", 'Email address': 'a@b.com', 'Company name': 'McDonald Group' }).last_name === "O'Brien");
ok('a correctly-typed company is left alone',
   one({ 'First name': 'A', 'Email address': 'a@b.com', 'Company name': 'McDonald Group' }).company === 'McDonald Group');

// ---------- full name splitting ----------
const fn = one({ 'Full Name': 'Ada Lovelace', 'Email address': 'a@b.com', 'Company name': 'C' });
ok('a single Full Name column is split', fn.first_name === 'Ada' && fn.last_name === 'Lovelace');
ok('a one-word full name still yields a first name',
   one({ 'Name': 'Cher', 'Email address': 'a@b.com', 'Company name': 'C' }).first_name === 'Cher');

// ---------- domains ----------
for (const [given, want] of [
  ['https://www.acme.com/about', 'acme.com'], ['WWW.ACME.COM', 'acme.com'],
  ['http://acme.com', 'acme.com'], ['acme.com', 'acme.com'],
]) ok(`domain "${given}" -> ${want}`,
   one({ 'Website': given, 'Email address': 'a@b.com', 'First name': 'A', 'Company name': 'C' }).company_domain === want);

// ---------- required fields: a row that cannot be mailed must NOT be imported ----------
for (const [label, r, problem] of [
  ['malformed email', { 'Email address': 'nope', 'First name': 'A', 'Company name': 'C' }, 'valid address'],
  ['two emails in one cell', { 'Email address': 'a@b.com,c@d.com', 'First name': 'A', 'Company name': 'C' }, 'valid address'],
  ['no first name', { 'Email address': 'a@b.com', 'Company name': 'C' }, 'first name'],
  ['no company', { 'Email address': 'a@b.com', 'First name': 'A' }, 'company'],
]) {
  const o = one(r);
  ok(`${label} is NOT importable`, o._ok === false);
  ok(`  ${label} says why`, (o._problems || []).join(' ').toLowerCase().includes(problem));
}

// ---------- half-typed rows must be left alone ----------
// This polls every two minutes while a human types a row cell by cell. A row read mid-edit used to
// be marked needs_review and CLAIMED, so finishing the address afterwards changed nothing and the
// row silently never imported. No address now means "not ready", not "invalid".
for (const [label, r] of [
  ['first name only', { 'First name': 'Pratik' }],
  ['name and company, no address yet', { 'First name': 'Pratik', 'Company name': 'VisioneerIT' }],
  ['company only', { 'Company name': 'VisioneerIT' }],
  ['everything except the address', { 'First name': 'P', 'Last name': 'P', 'Company name': 'V', 'Website': 'v.com' }],
]) ok(`${label} is left untouched, not claimed`, map([{ row_number: 2, status: '', ...r }]).length === 0);

// But a row that HAS an address and is still wrong is genuinely incomplete and must be flagged —
// otherwise "leave it alone" would swallow real errors.
ok('an address with no company IS flagged',
   one({ 'Email address': 'a@b.com', 'First name': 'A' })._ok === false);
ok('an address with no first name IS flagged',
   one({ 'Email address': 'a@b.com', 'Company name': 'C' })._ok === false);
ok('a malformed address IS flagged',
   one({ 'Email address': 'nope', 'First name': 'A', 'Company name': 'C' })._ok === false);
ok('the leave-alone rule is documented', /STILL BEING TYPED/.test(mapCode));

// ---------- dedupe within one upload ----------
const dup = map([
  { row_number: 2, status: '', 'Email address': 'a@b.com', 'First name': 'A', 'Company name': 'C' },
  { row_number: 3, status: '', 'Email address': 'A@B.COM', 'First name': 'A', 'Company name': 'C' },
]);
ok('a duplicate address inside one upload is caught', dup[1]._ok === false);
ok('  and says so', dup[1]._problems.join(' ').includes('duplicate'));

// ---------- the pairing warning ----------
const mismatch = one({ 'First name': 'ANGELA', 'Last name': 'SPEASE',
  'Email address': 'Kevin.Spease@isse-services.com', 'Company name': 'ISSE SERVICES LLC' });
ok('a name that is absent from the address is flagged', mismatch._warnings.length > 0);
ok('  but the row is still importable (a warning, not a block)', mismatch._ok === true);
ok('a matching name is not flagged',
   one({ 'First name': 'Nick', 'Email address': 'nick.marteney@u.com', 'Company name': 'C' })._warnings.length === 0);

// ---------- claim marker and blanks ----------
for (const s of ['mapped', 'dropped', 'anything'])
  ok(`status "${s}" is final — never read again`,
     map([{ row_number: 2, status: s, 'Email address': 'a@b.com' }]).length === 0);

// needs_review is the ONE state a human is expected to act on, so a corrected row must get a
// second look. Staff were previously told "address rejected by verification", fixed the address,
// and nothing happened — the note explained the problem and then the row was unreachable.
{
  const flagged = (email, lastTried) => ({
    row_number: 2, status: 'needs_review', mapped_lead_id: lastTried,
    'Email address': email, 'First name': 'Dana', 'Company name': 'Cardinal', Product: 'OryonIQ',
  });
  ok('a needs_review row whose address was CORRECTED is picked up again',
     map([flagged('dana@cardinalfederal.com', 'dana@cardinalfederal.invalid')]).length === 1);
  ok('  and an UNCHANGED needs_review row is left alone (no rework, no OpenAI call)',
     map([flagged('dana@cardinalfederal.invalid', 'dana@cardinalfederal.invalid')]).length === 0);
  ok('  the comparison ignores case, so re-casing an address is not a "change"',
     map([flagged('Dana@Cardinal.com', 'dana@cardinal.com')]).length === 0);
  ok('  a row whose email column was never recognised stays quiet until a human edits it',
     map([{ row_number: 3, status: 'needs_review', mapped_lead_id: '',
            'Contact Point': '', 'First name': 'Dana' }]).length === 0);
}
ok('a blank row is ignored', map([{ row_number: 9, status: '', 'Email address': '', 'First name': '' }]).length === 0);
ok('control columns are never treated as data',
   (one({ 'Email address': 'a@b.com', 'First name': 'A', 'Company name': 'C' })._unmapped_headers || []).length === 0);

// ---------- 49,000 rows must not be swallowed whole ----------
const huge = Array.from({ length: 500 }, (_, i) => ({ row_number: i + 2, status: '',
  'Email address': `p${i}@x.com`, 'First name': 'P', 'Company name': 'C' }));
const capped = map(huge);
ok('a huge upload is capped per cycle', capped.length > 0 && capped.length <= 50, `got ${capped.length}`);
ok('the cap is documented in the code', /MAX_PER_CYCLE/.test(mapCode));

// ---------- the model is a fallback, not the first move ----------
ok('unknown headers alone do NOT trigger the model when the row is already usable',
   one({ 'Email address': 'a@b.com', 'First name': 'A', 'Company name': 'C', 'Weird Column': 'x' })._needs_llm === false);
ok('the model is only needed when a required field is missing AND a header is unrecognised',
   one({ 'Contact Point': 'a@b.com', 'First name': 'A', 'Company name': 'C' })._needs_llm === true);

// ---------- the AI mapping is re-validated, never trusted ----------
const applyCode = jsOf('Apply AI mapping');
const apply = (aiJson, src) => new Function('$input', '$', applyCode)(
  { item: { json: aiJson } }, () => ({ first: () => ({ json: src }) })).json;
const base = { _raw: { 'Contact Point': 'a@b.com' }, first_name: 'A', company: 'C',
               _unmapped_headers: ['Contact Point'], _problems: ['no email column found'] };
const good = apply({ message: { content: '{"Contact Point":"contact_email"}' } }, base);
ok('a valid AI mapping is applied', good.contact_email === 'a@b.com' && good._ok === true);
const invented = apply({ message: { content: '{"Contact Point":"totally_made_up_field"}' } }, base);
ok('an invented field is discarded', invented.totally_made_up_field === undefined);
ok('  and the row stays unusable', invented._ok === false);
ok('unparseable model output does not throw',
   apply({ message: { content: 'sorry, I cannot help' } }, base)._ok === false);
ok('the model cannot make a malformed address valid',
   apply({ message: { content: '{"Contact Point":"contact_email"}' } },
         { ...base, _raw: { 'Contact Point': 'not-an-email' } })._ok === false);

// ---------- an unusable row is reported, never dropped ----------
const statusCode = jsOf('Shape Inbox status');
const status = (r) => new Function('$input', statusCode)({ item: { json: r } }).json;
ok('a good row is marked mapped', status({ _ok: true, contact_email: 'a@b.com', row_number: 2 }).status === 'mapped');
const bad = status({ _ok: false, row_number: 3, _problems: ['no email column found'], _unmapped_headers: ['Zip'] });
ok('a bad row is marked needs_review', bad.status === 'needs_review');
ok('  and the note says why', /no email column found/.test(bad.notes));
ok('  and names the unrecognised columns', /Zip/.test(bad.notes));

// ---------- an uploaded lead goes through VERIFICATION, not straight to the sheet ----------
// Changed 2026-08-29. This node used to build a Leads row and the next node wrote it, which put
// every staff-typed lead round the outside of Reoon, the dedupe check and the suppression list.
const leadCode = jsOf('Shape Lead row');
const lead = new Function('$input', leadCode)({ item: { json: { contact_email: 'a@b.com',
  first_name: 'A', company: 'C', source_config: 'Manual', Product: 'OryonIQ', row_number: 7,
  _unmapped_headers: ['Zip'], _warnings: ['w'] } } }).json;
ok('the lead is shaped for the verifier, keyed the way intake expects', lead.email === 'a@b.com');
ok('it carries the chosen product', lead.Product === 'OryonIQ');
ok('it does NOT stamp a lifecycle state — intake owns the Leads row',
   lead.channel_state_email === undefined);
ok('it carries the Inbox row so the verdict can be reported back', lead.inbox_row === 7);
ok('mapping diagnostics ride along for the merge node', lead._inbox.unmapped_headers[0] === 'Zip');

// The mapper must not write to Leads any more — that is intake's job, and two writers stamping
// the same row is how a lead ends up disagreeing with itself.
ok('the mapper no longer writes to the Leads tab',
   !wf.nodes.some(n => n.type === 'n8n-nodes-base.googleSheets'
     && (n.parameters.sheetName?.value || n.parameters.sheetName) === 'Leads'));
const call = wf.nodes.find(n => n.type === 'n8n-nodes-base.executeWorkflow');
ok('it calls the verify/curate workflow instead', call?.parameters.workflowId?.value === 'VIOwf1intake0001');
ok('it waits for the verdict', call?.parameters.options?.waitForSubWorkflow === true);
// Intake is a BATCH pipeline whose two Sheets reads are executeOnce — the opposite of
// VIO-run-campaign, where mode:'each' was the fix. Per-lead here would re-read Leads and
// Suppression once per lead.
ok('it verifies the whole batch in one call, not one call per lead',
   call?.parameters.mode === undefined || call?.parameters.mode === 'once');

// ---------- the product gate ----------
ok('a row with no product is refused, not guessed',
   one({ 'Email address': 'a@b.com', 'First name': 'A', 'Company name': 'C', Product: '' })._ok === false);
ok('  and says what to do about it',
   /choose OryonIQ or VisioneerIT/.test(
     one({ 'Email address': 'a@b.com', 'First name': 'A', 'Company name': 'C', Product: '' })._problems.join(' ')));
// A complete row, so these cases isolate the product and nothing else.
const withProduct = (p, extra = {}) => one({ 'Email address': 'a@b.com', 'First name': 'A',
                                             'Company name': 'C', Product: p, ...extra });
ok('an unknown product is refused', withProduct('Acme')._ok === false);
ok('OryonIQ resolves', withProduct('oryoniq').Product === 'OryonIQ');
ok('VisioneerIT resolves', withProduct(' visioneer it ').Product === 'VisioneerIT');
ok('the product is never mistaken for lead data', withProduct('OryonIQ').company === 'C');
// source_config records how the lead ARRIVED and must never stand in for the product.
ok('source_config is not used as a product fallback',
   withProduct('', { source_config: 'oryoniq' })._ok === false);

// ---------- the merge node: a verdict that never came back is not a success ----------
const mergeCode = jsOf('Merge verdicts');
const merge = (verdicts, sent) => new Function('$input', '$', mergeCode)(
  { all: () => verdicts.map(j => ({ json: j })) },
  (n) => ({ all: () => sent.map(j => ({ json: j })) })).map(i => i.json);
const SENT = [{ contact_email: 'a@b.com', inbox_row: 4,
                _inbox: { row_number: 4, llm_used: false, llm_applied: [], warnings: [], unmapped_headers: [] } }];
for (const [outcome, want] of [['pass', true], ['needs_review', true],
                               ['drop', false], ['skipped', false], ['verify_failed', false]]) {
  const m = merge([{ inbox_row: 4, outcome, reason: 'r', reoon_status: 'safe' }], SENT)[0];
  ok(`verification "${outcome}" -> imported=${want}`, m._ok === want, `got ${m._ok}`);
}
// The note a human reads must not stutter. Shape Inbox status already prefixes "Not imported — ",
// so a reason that repeats it produced "Not imported — not imported — duplicate" on the live
// sheet (2026-08-29).
for (const [reason, want] of [['duplicate', /already hold/], ['suppressed', /suppression list/]]) {
  const note = status({ row_number: 4, _ok: false, _verify_outcome: 'skipped',
    _problems: merge([{ inbox_row: 4, outcome: 'skipped', reason }], SENT)[0]._problems }).notes;
  ok(`a ${reason} reads as plain English`, want.test(note), note);
  ok(`  and does not stutter`, !/not imported .{0,3} not imported/i.test(note), note);
}

ok('a lead intake never answered for is NOT reported as imported',
   merge([], SENT)[0]._ok === false);
ok('  and says so rather than inventing a reason',
   /no verdict/.test(merge([], SENT)[0]._problems.join(' ')));

// A row verification could not finish must stay UNCLAIMED, or a Reoon outage silently eats it.
ok('a failed verification leaves the row unclaimed for the next cycle',
   status({ row_number: 4, _ok: false, _verify_outcome: 'verify_failed', _problems: ['x'] }).status === '');
ok('a rejected address IS claimed, with the reason',
   status({ row_number: 4, _ok: false, _verify_outcome: 'drop', _problems: ['address rejected'] }).status === 'needs_review');
ok('a verified lead is claimed as mapped',
   status({ row_number: 4, _ok: true, _verify_outcome: 'pass', contact_email: 'a@b.com',
            _reoon_status: 'safe' }).status === 'mapped');

// ---------- structure ----------
ok('workflow id stable', wf.id === 'VIOwfHinboxmap');
const sheetNodes = wf.nodes.filter(n => n.type === 'n8n-nodes-base.googleSheets');
ok('every Sheets node pins the credential by id',
   sheetNodes.every(n => n.credentials?.googleApi?.id === 'VIOgsheetcred01'));
ok('every Sheets node is typeVersion 4.7', sheetNodes.every(n => n.typeVersion === 4.7));
const schemaBad = schemaViolations(wf);
ok('Sheets caches obey the schema rule (empty on appendOrUpdate+autoMap, present on defineBelow)',
   schemaBad.length === 0, schemaBad.join(' | '));
ok('no A1 range anywhere', !/"[A-Z]{1,2}[0-9]{1,4}:[A-Z]{1,2}/.test(JSON.stringify(wf)));
ok('an error workflow is set', wf.settings?.errorWorkflow === 'VIOwfEerroralert');

const names = new Set(wf.nodes.map(n => n.name));
for (const [src, v] of Object.entries(wf.connections))
  for (const g of v.main) for (const c of g)
    ok(`connection ${src} -> ${c.node} resolves`, names.has(c.node));

// ---------- the heartbeat ----------
// Staff type into this spreadsheet and nothing on screen tells them the poller is alive. Both
// schedules are silent by design when there is nothing to do — the mapper's chain literally stops
// at the sheet read — so "working, nothing to do" and "dead" looked identical from the sheet.
{
  const beat = (rows) => new Function('$input', jsOf('Heartbeat'))(
    { all: () => rows.map((j) => ({ json: j })) }).json;
  const readNode = 'Read Inbox';

  // It must hang off the sheet READ, so it reports what was actually seen rather than just that a
  // timer fired — and it must be the FIRST branch, so a throw further down cannot swallow it.
  const branch = wf.connections[readNode].main[0].map((c) => c.node);
  ok('the heartbeat hangs off the sheet read', branch.includes('Heartbeat'), branch.join(', '));
  ok('  and runs before the work, so a later throw cannot swallow it', branch[0] === 'Heartbeat');
  // Without this the read emits nothing on an empty tab and the heartbeat never fires — exactly
  // when a human most needs to know the system is alive.
  ok('the read always emits, so an empty tab still produces a heartbeat',
     wf.nodes.find((n) => n.name === readNode).alwaysOutputData === true);

  const b = beat([{ row_number: 2, status: '', junk: 'x' }]);
  ok('it names the workflow in words a human recognises', /VIO-inbox-mapper/.test(b.workflow));
  ok('it records when it last ran', typeof b.last_run_at === 'string' && b.last_run_at.length > 5);
  ok('  in local time, not UTC arithmetic', !/UTC/.test(b.last_run_at));
  ok('it says when the next check is due', typeof b.next_check_at === 'string' && b.next_check_at.length > 3);
  ok('it states the interval', b.every === '2 min');
  ok('it reports what it saw', /inbox|lead|row/i.test(String(b.checked)));
  ok('an idle cycle still reports a result', typeof b.last_result === 'string' && b.last_result.length > 5);

  // A write failure must never take down the run it is only reporting on.
  const w = wf.nodes.find((n) => n.name === 'Write heartbeat');
  ok('the heartbeat write cannot break the run it reports on', w.onError === 'continueRegularOutput');
  ok('  it updates one row per workflow instead of appending forever',
     w.parameters.operation === 'appendOrUpdate' && w.parameters.columns.matchingColumns.includes('workflow'));
  ok('  and writes to the System tab', w.parameters.sheetName.value === 'System');
}

console.log(`\n[inbox-mapper] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

