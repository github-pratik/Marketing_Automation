// Offline proof of VIO-inbox-mapper. Reads jsCode straight out of the workflow JSON.
//
// This workflow takes spreadsheets a human pasted in — arbitrary headers, real-world mess — and
// turns them into canonical leads. The risks are: importing a row that cannot be mailed, silently
// dropping a row the human is watching, calling the model when a lookup table would do, and
// choking on a 49,000-row upload.
import { readFileSync } from 'node:fs';

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
const one = (r) => { const o = map([{ row_number: 2, status: '', ...r }]); return o.length ? o[0] : null; };

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
  ['no email', { 'First name': 'A', 'Company name': 'C' }, 'email'],
  ['malformed email', { 'Email address': 'nope', 'First name': 'A', 'Company name': 'C' }, 'valid address'],
  ['two emails in one cell', { 'Email address': 'a@b.com,c@d.com', 'First name': 'A', 'Company name': 'C' }, 'valid address'],
  ['no first name', { 'Email address': 'a@b.com', 'Company name': 'C' }, 'first name'],
  ['no company', { 'Email address': 'a@b.com', 'First name': 'A' }, 'company'],
]) {
  const o = one(r);
  ok(`${label} is NOT importable`, o._ok === false);
  ok(`  ${label} says why`, (o._problems || []).join(' ').toLowerCase().includes(problem));
}

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
for (const s of ['mapped', 'needs_review', 'anything'])
  ok(`status "${s}" means already handled`, map([{ row_number: 2, status: s, 'Email address': 'a@b.com' }]).length === 0);
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

// ---------- an imported lead is not mail-ready ----------
const leadCode = jsOf('Shape Lead row');
const lead = new Function('$input', leadCode)({ item: { json: { contact_email: 'a@b.com',
  first_name: 'A', company: 'C', source_config: 'Manual' } } }).json;
ok('an uploaded lead lands as needs_review, not ready to send',
   lead.channel_state_email === 'needs_review');
ok('  which is a value the live sheet dropdown allows',
   ['needs_review','pending_approval','approved','enrolled','replied','positive','booked',
    'rejected','dropped','unsubscribed','bounced'].includes(lead.channel_state_email));

// ---------- structure ----------
ok('workflow id stable', wf.id === 'VIOwfHinboxmap');
const sheetNodes = wf.nodes.filter(n => n.type === 'n8n-nodes-base.googleSheets');
ok('every Sheets node pins the credential by id',
   sheetNodes.every(n => n.credentials?.googleApi?.id === 'VIOgsheetcred01'));
ok('every Sheets node is typeVersion 4.7', sheetNodes.every(n => n.typeVersion === 4.7));
// Only WRITES map columns; a read has no schema and needs none.
const writeNodes = sheetNodes.filter(n => n.parameters.operation !== 'read');
ok('every Sheets WRITE declares a schema',
   writeNodes.length > 0 && writeNodes.every(n => (n.parameters.columns?.schema || []).length > 0));
ok('the Leads write matches on contact_email',
   (sheetNodes.find(n => n.name === 'Add to Leads')?.parameters.columns?.matchingColumns || []).includes('contact_email'));
ok('no A1 range anywhere', !/"[A-Z]{1,2}[0-9]{1,4}:[A-Z]{1,2}/.test(JSON.stringify(wf)));
ok('an error workflow is set', wf.settings?.errorWorkflow === 'VIOwfEerroralert');

const names = new Set(wf.nodes.map(n => n.name));
for (const [src, v] of Object.entries(wf.connections))
  for (const g of v.main) for (const c of g)
    ok(`connection ${src} -> ${c.node} resolves`, names.has(c.node));

console.log(`\n[inbox-mapper] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
