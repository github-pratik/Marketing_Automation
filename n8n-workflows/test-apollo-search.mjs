// Proof of the filter gate in VIO-source-leads :: Resolve ICP.
//
// WHY THIS EXISTS
// Until 2026-09-05 the Apollo filters were hardcoded in that node, so the only way to change who we
// searched for was to edit and re-import a workflow. The console now sends them, which means a
// browser can influence which real people enter an outbound pipeline. That is a trust boundary, and
// the interesting failure is not "bad input crashes" — it is "bad input is quietly ignored".
//
// A filter that Apollo does not recognise is dropped SILENTLY by Apollo. The operator narrows the
// search, gets a plausible-looking list back, and pulls people who match none of what they asked
// for. So every unknown value must REFUSE, and these tests exist mostly to prove the refusals.
//
// The code is read out of the workflow JSON rather than re-typed, so the tests cannot drift from
// what is deployed.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-source-leads.json', import.meta.url)));
const code = wf.nodes.find((n) => n.name === 'Resolve ICP').parameters.jsCode;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const run = (body) => new Function('$input', code)({ first: () => ({ json: body }) }).json;
const refuses = (name, body, re) => {
  try {
    run(body);
    ok(name, false, 'it was ACCEPTED');
  } catch (e) {
    ok(name, re ? re.test(e.message) : /REFUSED/.test(e.message), e.message.slice(0, 110));
  }
};

// ---------- the product gate still holds ----------------------------------------------------
refuses('an unknown product is refused', { product: 'acme' }, /unknown product/);
refuses('a missing product is refused', {}, /must be a string/);
// String(['oryoniq']) === 'oryoniq' — a gate that coerces is not a gate.
refuses('an array that stringifies to a valid product is refused', { product: ['oryoniq'] }, /must be a string/);

// ---------- defaults ------------------------------------------------------------------------
{
  const r = run({ product: 'oryoniq' });
  ok('bare product falls back to the ICP titles', r.apollo_body.person_titles.includes('Capture Manager'));
  // Measured live 2026-09-05: q_keywords is a literal full-text match, not an industry filter.
  // 'government contracting' cut 168,759 matching people to seven, so the hardcoded search had
  // been returning almost nobody. Targeting is titles + seniority + location + size.
  ok('  and does NOT apply a keyword by default', r.apollo_body.q_keywords === undefined);
  ok('  and to United States', JSON.stringify(r.apollo_body.person_locations) === '["United States"]');
  ok('  and says which defaults it applied', r.filters_used.defaults_applied.includes('person_titles'));
  ok('  keywords stay available as an explicit narrowing tool',
     run({ product: 'oryoniq', keywords: 'government contracting' }).apollo_body.q_keywords === 'government contracting');
  ok('  product name is resolved for the copy', r.product === 'OryonIQ');
  ok('  source_config is the lowercase key', r.source_config === 'oryoniq');
  ok('VisioneerIT gets its OWN titles, not OryonIQ\'s',
     run({ product: 'visioneerit' }).apollo_body.person_titles.includes('CISO'));
}

// ---------- titles --------------------------------------------------------------------------
{
  const r = run({ product: 'oryoniq', titles: 'Capture Manager, Proposal Manager' });
  ok('a comma string becomes a list', JSON.stringify(r.apollo_body.person_titles) === '["Capture Manager","Proposal Manager"]');
  const r2 = run({ product: 'oryoniq', person_titles: ['  Capture Manager  ', '', 'CIO'] });
  ok('an array is trimmed and blanks dropped', JSON.stringify(r2.apollo_body.person_titles) === '["Capture Manager","CIO"]');
  const r3 = run({ product: 'oryoniq', titles: '   ' });
  ok('an all-blank title list falls back to the ICP rather than searching for everyone',
     r3.apollo_body.person_titles.length === 4);
}
refuses('26 titles is refused as not-a-search',
        { product: 'oryoniq', person_titles: Array.from({ length: 26 }, (_, i) => 'Title ' + i) },
        /at most 25/);
refuses('a number instead of a list is refused', { product: 'oryoniq', titles: 42 }, /list or a comma/);

// ---------- seniority -----------------------------------------------------------------------
{
  const r = run({ product: 'oryoniq', seniorities: 'VP, C Suite' });
  ok('seniority is lowercased and spaces become underscores',
     JSON.stringify(r.apollo_body.person_seniorities) === '["vp","c_suite"]');
}
refuses('an invented seniority is refused rather than ignored',
        { product: 'oryoniq', seniorities: 'wizard' }, /unknown seniority/);
refuses('  including one valid value alongside one invalid',
        { product: 'oryoniq', seniorities: 'vp, overlord' }, /overlord/);

// ---------- company size --------------------------------------------------------------------
{
  const r = run({ product: 'oryoniq', employee_ranges: '51,200' });
  ok('a size band is passed through', JSON.stringify(r.apollo_body.organization_num_employees_ranges) === '["51,200"]');
  ok('a single number becomes a one-wide band',
     JSON.stringify(run({ product: 'oryoniq', employee_ranges: ['500'] }).apollo_body.organization_num_employees_ranges) === '["500,500"]');
  ok('whitespace inside a band is tolerated',
     JSON.stringify(run({ product: 'oryoniq', employee_ranges: ['51 , 200'] }).apollo_body.organization_num_employees_ranges) === '["51,200"]');
  // The comma inside "51,200" is part of the band, so bands are separated by ';'. Getting this
  // wrong is silent: '51,200' split on commas searched for companies of exactly 51 and exactly 200.
  ok('two bands are separated by a semicolon, not a comma',
     JSON.stringify(run({ product: 'oryoniq', employee_ranges: '11,50; 51,200' }).apollo_body.organization_num_employees_ranges) === '["11,50","51,200"]');
  ok('an array of bands works too',
     JSON.stringify(run({ product: 'oryoniq', employee_ranges: ['11,50', '51,200'] }).apollo_body.organization_num_employees_ranges) === '["11,50","51,200"]');
  ok('no size given means the key is absent, not empty',
     run({ product: 'oryoniq' }).apollo_body.organization_num_employees_ranges === undefined);
}
// Apollo answers an inverted range with an empty list, which an operator reads as "nobody
// matches" rather than "you typed it backwards".
refuses('a backwards size band is refused', { product: 'oryoniq', employee_ranges: '200,51' }, /backwards/);
refuses('a non-numeric size band is refused', { product: 'oryoniq', employee_ranges: 'big' }, /must look like/);

// ---------- location: the constraint, not a filter -------------------------------------------
{
  const r = run({ product: 'oryoniq', locations: 'Virginia, Maryland' });
  ok('a state is expanded to Apollo\'s "<State>, US" form',
     JSON.stringify(r.apollo_body.person_locations) === '["Virginia, US","Maryland, US"]');
  ok('case is forgiven',
     JSON.stringify(run({ product: 'oryoniq', locations: 'virginia' }).apollo_body.person_locations) === '["Virginia, US"]');
  ok('an already-suffixed state is not double-suffixed',
     JSON.stringify(run({ product: 'oryoniq', locations: 'Texas, US' }).apollo_body.person_locations) === '["Texas, US"]');
  ok('a state carrying its own country suffix stays ONE entry',
     JSON.stringify(run({ product: 'oryoniq', locations: 'Virginia, US, Maryland, US' }).apollo_body.person_locations) === '["Virginia, US","Maryland, US"]');
  ok('the whole country is allowed',
     JSON.stringify(run({ product: 'oryoniq', locations: 'United States' }).apollo_body.person_locations) === '["United States"]');
  ok('DC counts as a state',
     JSON.stringify(run({ product: 'oryoniq', locations: 'District of Columbia' }).apollo_body.person_locations) === '["District of Columbia, US"]');
}
// This is the compliance boundary, not a convenience default. Mailing outside the US means GDPR
// or CASL exposure this pilot has never been cleared for.
refuses('a non-US country is refused', { product: 'oryoniq', locations: 'Germany' }, /United States only/);
refuses('  and so is a US city, which would silently match nothing',
        { product: 'oryoniq', locations: 'Arlington' }, /not a US state/);

// ---------- keywords ------------------------------------------------------------------------
{
  ok('keywords pass through', run({ product: 'oryoniq', keywords: 'defense primes' }).apollo_body.q_keywords === 'defense primes');
  const cleared = run({ product: 'oryoniq', keywords: '' });
  ok('an explicitly empty keyword stays empty', cleared.apollo_body.q_keywords === undefined);
  ok('  and is reported as not-a-default', !cleared.filters_used.defaults_applied.includes('q_keywords'));
}

// ---------- paging and the cap ---------------------------------------------------------------
{
  ok('per_page defaults to 10', run({ product: 'oryoniq' }).apollo_body.per_page === 10);
  const capped = run({ product: 'oryoniq', per_page: 500 });
  ok('per_page is capped at 25', capped.apollo_body.per_page === 25);
  ok('  and the caller is TOLD it was capped', capped.capped === true);
  ok('page defaults to 1', run({ product: 'oryoniq' }).apollo_body.page === 1);
  ok('page is honoured', run({ product: 'oryoniq', page: 3 }).apollo_body.page === 3);
  ok('page is capped', run({ product: 'oryoniq', page: 9999 }).apollo_body.page === 50);
  ok('a fractional per_page floors rather than reaching Apollo as a float',
     run({ product: 'oryoniq', per_page: 7.9 }).apollo_body.per_page === 7);
}
// Deliberately NOT a refusal. The line is: refuse what changes WHO is contacted, forgive what
// only changes HOW MANY come back. A nonsense page size cannot reach the wrong person, and the
// operator agent emits nulls and strings for it.
{
  ok('a nonsense per_page falls back rather than failing the run',
     run({ product: 'oryoniq', per_page: 0 }).apollo_body.per_page === 10);
  ok('  and so does a negative page', run({ product: 'oryoniq', page: -1 }).apollo_body.page === 1);
  ok('  Infinity takes the default, not the cap',
     run({ product: 'oryoniq', per_page: Infinity }).apollo_body.per_page === 10);
}

// ---------- what the caller gets back --------------------------------------------------------
{
  const r = run({ product: 'oryoniq', titles: 'CIO', locations: 'Texas', employee_ranges: '11,50' });
  // A saved search must replay identically. Storing the operator's typing rather than the
  // RESOLVED filters would replay differently from the run it was saved off.
  ok('filters_used echoes the resolved values, not the raw input',
     r.filters_used.person_locations[0] === 'Texas, US');
  ok('  including the size band', r.filters_used.organization_num_employees_ranges[0] === '11,50');
  ok('  and matches what was actually sent to Apollo',
     JSON.stringify(r.filters_used.person_titles) === JSON.stringify(r.apollo_body.person_titles));
}

// ---------- the free search stays free -------------------------------------------------------
// Nothing in this node may reach a paid endpoint. If a reveal ever gets bolted on here, the two
// buttons collapse into one and a wide search becomes an unbounded spend.
{
  ok('the node never mentions the paid endpoint', !/people\/match/.test(code));
  const httpNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  ok('the workflow calls exactly one Apollo endpoint', httpNodes.length === 1, `${httpNodes.length} http nodes`);
  ok('  and it is the FREE search',
     /mixed_people\/api_search/.test(httpNodes[0].parameters.url),
     httpNodes[0].parameters.url);
}

console.log(`\n[apollo-search] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
