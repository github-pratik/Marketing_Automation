// Offline proof of VIO-source-leads' gates. Reads jsCode straight out of the workflow JSON —
// never a re-typed copy — so the test cannot drift from what deploys.
//
// Covers the two things that would actually hurt: sourcing against a guessed ICP (wrong people
// enter the pipeline and every later stage trusts them), and an unbounded result size.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-source-leads.json', import.meta.url)));
const jsOf = (name) => {
  const n = wf.nodes.find(x => x.name === name);
  if (!n) throw new Error(`no node "${name}"`);
  if (n.type !== 'n8n-nodes-base.code') throw new Error(`"${name}" is ${n.type}, not a Code node`);
  return n.parameters.jsCode;
};

const CTRL = /[\u0000-\u001f\u007f]/;
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++;
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; }
};

// ---------- Resolve ICP ----------
const icpCode = jsOf('Resolve ICP');
const runIcp = (body) => {
  const $input = { first: () => ({ json: body }) };
  return new Function('$input', icpCode)($input).json;
};
const throwsIcp = (body) => { try { runIcp(body); return null; } catch (e) { return e.message; } };

ok('oryoniq resolves', runIcp({ product: 'oryoniq' }).product === 'OryonIQ');
ok('visioneerit resolves', runIcp({ product: 'visioneerit' }).product === 'VisioneerIT');
ok('product is case-insensitive', runIcp({ product: 'OryonIQ' }).source_config === 'oryoniq');
ok('surrounding whitespace tolerated', runIcp({ product: '  visioneerit ' }).source_config === 'visioneerit');

// Fail closed — every one of these must refuse rather than guess an ICP.
for (const [label, body] of [
  ['unknown product', { product: 'acme' }],
  ['empty product', { product: '' }],
  ['missing product', {}],
  ['null product', { product: null }],
  ['numeric product', { product: 42 }],
  ['array product', { product: ['oryoniq'] }],
  ['object product', { product: { name: 'oryoniq' } }],
  ['near-miss spelling', { product: 'oryoniq ' + String.fromCharCode(0) }],
  ['sql-ish injection', { product: "oryoniq'; DROP TABLE--" }],
]) {
  const msg = throwsIcp(body);
  ok(`REFUSES ${label}`, msg !== null && /REFUSED/.test(msg), msg === null ? 'did not throw' : msg);
}

// Result-size cap — the only lever a caller has on how many real people come back.
ok('default limit is 10', runIcp({ product: 'oryoniq' }).per_page === 10);
ok('limit honoured under cap', runIcp({ product: 'oryoniq', limit: 5 }).per_page === 5);
ok('limit capped at 25', runIcp({ product: 'oryoniq', limit: 5000 }).per_page === 25);
ok('cap is reported, not silent', runIcp({ product: 'oryoniq', limit: 5000 }).capped === true);
ok('no cap flag when under', runIcp({ product: 'oryoniq', limit: 5 }).capped === false);
ok('zero falls back to default', runIcp({ product: 'oryoniq', limit: 0 }).per_page === 10);
ok('negative falls back', runIcp({ product: 'oryoniq', limit: -50 }).per_page === 10);
ok('float floors', runIcp({ product: 'oryoniq', limit: 7.9 }).per_page === 7);
ok('NaN falls back', runIcp({ product: 'oryoniq', limit: NaN }).per_page === 10);
// Infinity is not finite, so it takes the DEFAULT rather than the cap — the conservative answer
// for a nonsense value, and deliberately not 25.
ok('Infinity falls back to default, not the cap', runIcp({ product: 'oryoniq', limit: Infinity }).per_page === 10);
ok('string limit falls back or coerces safely', [10, 5].includes(runIcp({ product: 'oryoniq', limit: '5' }).per_page));

const body = runIcp({ product: 'oryoniq' }).apollo_body;
ok('apollo body carries titles', Array.isArray(body.person_titles) && body.person_titles.length > 0);
ok('apollo body carries locations', Array.isArray(body.person_locations));
ok('apollo body page is 1', body.page === 1);
ok('apollo per_page matches resolved', body.per_page === 10);
ok('ICPs differ between products',
   JSON.stringify(runIcp({ product: 'oryoniq' }).apollo_body.person_titles)
   !== JSON.stringify(runIcp({ product: 'visioneerit' }).apollo_body.person_titles));

// ---------- Filter + Shape ----------
const filterCode = jsOf('Filter + Shape');
const runFilter = (apolloResp, meta = { source_config: 'oryoniq', product: 'OryonIQ', per_page: 10, capped: false }) => {
  const $input = { first: () => ({ json: apolloResp }) };
  const $ = (name) => ({ first: () => ({ json: meta }) });
  return new Function('$input', '$', filterCode)($input, $)[0].json;
};

const person = (over = {}) => ({
  id: 'p1', first_name: 'Kiara', last_name: 'Bell', title: 'Capture Manager',
  has_email: true, has_direct_phone: false, linkedin_url: 'https://linkedin.com/in/x',
  organization: { name: 'Modernized Mobile LLC', primary_domain: 'modernizedmobile.com' }, ...over,
});

let r = runFilter({ people: [person(), person({ id: 'p2', has_email: false })] });
ok('drops leads without has_email', r.emailable === 1 && r.dropped_no_email === 1);
ok('reports what Apollo returned', r.returned_by_apollo === 2);
ok('states zero credits spent', r.credits_spent === 0);
ok('never emits a contact_email', r.leads.every(l => l.contact_email === ''));
ok('stamps source_config on each lead', r.leads.every(l => l.source_config === 'oryoniq'));
ok('carries company_domain', r.leads[0].company_domain === 'modernizedmobile.com');

ok('strips protocol from website_url',
   runFilter({ people: [person({ organization: { name: 'X', website_url: 'https://www.acme.com/about' } })] })
     .leads[0].company_domain === 'acme.com');

ok('falls back to account name',
   runFilter({ people: [person({ organization: null, account: { name: 'Fallback Inc' } })] })
     .leads[0].company === 'Fallback Inc');
ok('company has a last-resort value',
   runFilter({ people: [person({ organization: null, account: null, organization_name: null })] })
     .leads[0].company === 'their firm');

ok('respects per_page as a hard slice',
   runFilter({ people: Array.from({ length: 50 }, (_, i) => person({ id: 'p' + i })) },
             { source_config: 'oryoniq', product: 'OryonIQ', per_page: 3, capped: true }).emailable === 3);

// Malformed / hostile Apollo responses must not throw.
for (const [label, resp] of [
  ['empty people array', { people: [] }],
  ['people missing', {}],
  ['people is null', { people: null }],
  ['people is a string', { people: 'nope' }],
  ['null entries', { people: [null, undefined, person()] }],
  ['person with no fields', { people: [{ has_email: true }] }],
  ['non-string names', { people: [person({ first_name: 42, title: null, last_name: {} })] }],
]) {
  let threw = null, out = null;
  try { out = runFilter(resp); } catch (e) { threw = e.message; }
  ok(`survives ${label}`, threw === null, threw);
  if (out) ok(`  ${label} still reports credits_spent 0`, out.credits_spent === 0);
}

ok('control characters are stripped from names',
   !CTRL.test(JSON.stringify(runFilter({ people: [person({ first_name: 'Kia\nra' })] }))));
ok('over-long values are capped',
   runFilter({ people: [person({ title: 'x'.repeat(5000) })] }).leads[0].title.length <= 120);

// --- the free-tier response shape, verified live 2026-08-22 ---
const freeShape = {
  id: 'p9', first_name: 'Kiara', last_name_obfuscated: 'B.', title: 'Capture Manager',
  has_email: true, has_direct_phone: 'Maybe: please request direct dial via people/bulk_match',
  organization: { name: 'Modernized Mobile LLC', has_industry: true, has_phone: true },
};
const fr = runFilter({ people: [freeShape] });
ok('a "Maybe" phone is NOT reported as true', fr.leads[0].has_phone === 'maybe');
ok('a real boolean phone stays true',
   runFilter({ people: [{ ...freeShape, has_direct_phone: true }] }).leads[0].has_phone === true);
ok('absent phone is false',
   runFilter({ people: [{ ...freeShape, has_direct_phone: null }] }).leads[0].has_phone === false);
ok('obfuscated surname is carried', fr.leads[0].last_name_obfuscated === 'B.');
ok('missing domain yields empty string, not a crash', fr.leads[0].company_domain === '');
ok('domain availability is reported, not silently empty', fr.company_domain_available === false);
ok('domain availability true when a domain exists',
   runFilter({ people: [person()] }).company_domain_available === true);
ok('company name still resolves from the free shape',
   fr.leads[0].company === 'Modernized Mobile LLC');

// ---------- structure ----------
ok('workflow id stable', wf.id === 'VIOwf9source0001');
ok('apollo node pins credential by id',
   wf.nodes.find(n => n.name === 'Apollo Search (free)')?.credentials?.httpHeaderAuth?.id === 'VIOapollocred01');
ok('apollo hits the FREE search endpoint',
   wf.nodes.find(n => n.name === 'Apollo Search (free)')?.parameters?.url?.endsWith('/mixed_people/api_search'));
// Check the URLs actually requested, not the whole JSON — the previous form matched a comment
// that merely NAMES the reveal endpoint while explaining why it is absent.
ok('no node calls the paid reveal endpoint',
   wf.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest')
           .every(n => !String(n.parameters?.url || '').includes('people/match')));
ok('webhook node carries an explicit webhookId',
   Boolean(wf.nodes.find(n => n.type === 'n8n-nodes-base.webhook')?.webhookId),
   'without it n8n registers a mangled fallback path (workflowId/nodeName/path) and the endpoint '
   + '404s while import, activation and healthz all report success');
ok('auth node is fail-closed',
   /REFUSED/.test(jsOf('Authenticate (fail-closed)')) && /VIO_WEBHOOK_TOKEN/.test(jsOf('Authenticate (fail-closed)')));
ok('no secret literal in the workflow',
   !/sk-|Bearer\s+[A-Za-z0-9]{20}|api_key=/.test(JSON.stringify(wf)));

const names = new Set(wf.nodes.map(n => n.name));
for (const [src, v] of Object.entries(wf.connections))
  for (const grp of v.main) for (const c of grp)
    ok(`connection ${src} -> ${c.node} targets a real node`, names.has(c.node));

console.log(`\n[source-leads] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
