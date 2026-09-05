// Proof that the SQL suppression logic and the deployed JavaScript agree.
//
// WHY THIS EXISTS
// Suppression is about to have TWO implementations: the one in
// `VIO-enrol-email :: Preconditions (fail closed)`, which guards every send
// today, and `vio_canon` / `vio_email_keys` / `vio_domain_chain` in
// supabase/001_schema.sql, which will guard every send after the migration.
//
// Everyone on that list has ASKED US TO STOP. Exact string matching was already
// bypassable three ways — plus-addressing, subdomains, and zero-width characters
// pasted into an address — all proven live on 2026-08-30. If the two
// implementations drift by even one case, that case is a person who opted out
// and gets mailed anyway.
//
// So: this reads the REAL jsCode out of the workflow JSON (never a re-typed
// copy), ports the SQL to JavaScript once, and runs both over the same
// adversarial corpus. Any divergence fails the build.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-enrol-email.json', import.meta.url)));
const js = wf.nodes.find((n) => n.name === 'Preconditions (fail closed)').parameters.jsCode;

// ---- extract the three functions from the deployed code, unmodified ---------
const grab = (start, end) => {
  const i = js.indexOf(start);
  if (i < 0) throw new Error(`could not find ${start} in the deployed jsCode`);
  const j = js.indexOf(end, i);
  return js.slice(i, j);
};
const deployedSrc =
  grab('const ZW =', 'const supp = new Set()');

let deployed;
try {
  deployed = new Function(`${deployedSrc}; return { canon, emailKeys, domainChain };`)();
} catch (e) {
  console.log(`  FAIL  could not evaluate the deployed canonicalisation: ${e.message}`);
  process.exit(1);
}

// ---- the SQL, ported to JS. Mirrors supabase/001_schema.sql exactly. --------
// vio_canon: strip zero-width + soft hyphen, trim, lowercase
const SQL_ZW = /[​‌‍‎‏⁠﻿­]/g;
const sqlCanon = (s) => String(s ?? '').replace(SQL_ZW, '').trim().toLowerCase();

// vio_email_keys
const sqlEmailKeys = (raw) => {
  const e = sqlCanon(raw);
  if (e === '') return [];
  const at = e.lastIndexOf('@');
  if (at < 1) return [e];
  const local = e.slice(0, at), dom = e.slice(at + 1);
  return [...new Set([e, `${local.split('+')[0]}@${dom}`])].filter((k) => k && k !== '@');
};

// vio_domain_chain
const sqlDomainChain = (host) => {
  let h = sqlCanon(host).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const parts = h.split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < parts.length; i++) out.push(parts.slice(i).join('.'));
  return out;
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// ---- the corpus: every bypass we know about, plus ordinary traffic ----------
const ADDRESSES = [
  'dana@cardinalfederal.com',
  'DANA@CardinalFederal.COM',
  '  dana@cardinalfederal.com  ',
  'dana+govcon@cardinalfederal.com',        // plus-addressing
  'dana+a+b@cardinalfederal.com',
  'dana@mail.cardinalfederal.com',          // subdomain
  'dana​@cardinalfederal.com',         // zero-width space
  'da‍na@cardinalfederal.com',         // zero-width joiner
  'dana@cardinal﻿federal.com',         // BOM inside the domain
  'da­na@cardinalfederal.com',         // soft hyphen
  'first.last@sub.deep.example.org',
  'weird@@double.com',                      // two @ — lastIndexOf matters
  '@nolocal.com',
  'nodomain@',
  'plain-string',
  '',
  '   ',
];

const HOSTS = [
  'cardinalfederal.com',
  'www.cardinalfederal.com',
  'https://cardinalfederal.com',
  'https://www.cardinalfederal.com/careers',
  'mail.cardinalfederal.com',
  'a.b.c.example.org',
  'CardinalFederal.COM',
  'cardinal​federal.com',
  'localhost',
  '',
];

for (const a of ADDRESSES) {
  ok(`canon parity: ${JSON.stringify(a)}`,
     deployed.canon(a) === sqlCanon(a),
     `js=${JSON.stringify(deployed.canon(a))} sql=${JSON.stringify(sqlCanon(a))}`);
  ok(`emailKeys parity: ${JSON.stringify(a)}`,
     same(deployed.emailKeys(a), sqlEmailKeys(a)),
     `js=${JSON.stringify(deployed.emailKeys(a))} sql=${JSON.stringify(sqlEmailKeys(a))}`);
}

for (const h of HOSTS) {
  ok(`domainChain parity: ${JSON.stringify(h)}`,
     same(deployed.domainChain(h), sqlDomainChain(h)),
     `js=${JSON.stringify(deployed.domainChain(h))} sql=${JSON.stringify(sqlDomainChain(h))}`);
}

// ---- the bypasses must actually be blocked, in BOTH implementations ---------
// Parity alone is not enough: two implementations can agree and both be wrong.
const blocks = (keysOf, suppressed, attempt) => {
  const listed = new Set(keysOf(suppressed));
  return keysOf(attempt).some((k) => listed.has(k));
};
for (const [impl, keys] of [['js', deployed.emailKeys], ['sql', sqlEmailKeys]]) {
  ok(`${impl}: +tag cannot get past a suppressed address`,
     blocks(keys, 'dana@cardinalfederal.com', 'dana+anything@cardinalfederal.com'));
  ok(`${impl}: a suppressed +tag address also blocks the bare one`,
     blocks(keys, 'dana+govcon@cardinalfederal.com', 'dana@cardinalfederal.com'));
  ok(`${impl}: zero-width characters cannot get past`,
     blocks(keys, 'dana@cardinalfederal.com', 'dana​@cardinalfederal.com'));
  ok(`${impl}: a different person at the same domain is NOT blocked`,
     !blocks(keys, 'dana@cardinalfederal.com', 'sam@cardinalfederal.com'));
}
for (const [impl, chain] of [['js', deployed.domainChain], ['sql', sqlDomainChain]]) {
  ok(`${impl}: suppressing a domain covers its subdomains`,
     chain('mail.cardinalfederal.com').includes('cardinalfederal.com'));
  ok(`${impl}: suppressing a domain does not leak into a different one`,
     !chain('cardinalfederal.com.evil.com').includes('cardinalfederal.com'));
}

// ---- the ONE place the two sides deliberately differ ------------------------
// A single-label suppression value (`invalid`, `localhost`, a bare TLD) produces
// no keys from either chain, so in the JavaScript it is a SILENT NO-OP: the row
// looks like a suppression and stops nothing. Postgres now REFUSES to store it
// (supabase/002), because the alternative — emitting bare TLDs as lookup keys —
// would let one row saying `com` suppress the entire internet.
//
// This is asserted rather than fixed in the JavaScript on purpose. The live
// Suppression tab holds only `example.com`, so the hole is unreachable today,
// and the sender is the one workflow where an unnecessary change costs the most.
// Phase 1 closes it structurally by moving the list into Postgres.
//
// If either of these assertions starts failing, the two sides have moved and one
// of them is now wrong — do not "fix" the failing side in isolation.
for (const label of ['invalid', 'localhost', 'com']) {
  ok(`js: a single label (${label}) still yields no keys — known no-op`,
     deployed.domainChain(label).length === 0);
  ok(`sql port: same, which is why Postgres refuses to store it`,
     sqlDomainChain(label).length === 0);
}

console.log(`\n[suppression-parity] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
