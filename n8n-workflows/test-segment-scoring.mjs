// Test harness for segment-scoring.js — the outbound engine's targeting memory. Built 2026-08-21.
//
// Two things are being defended here, and only one of them is ordinary correctness.
//
// 1. NORMALIZATION. "VP of Business Development", "V.P. Business Development" and "VP, BD" are one
//    job. If they land in three buckets, each bucket carries a third of the evidence, none of them
//    ever clears the sample gate, and the Segments tab accumulates rows that can never be read.
//    Fragmentation doesn't produce wrong answers — it produces no answers, which is harder to spot.
//
// 2. THE SAMPLE GATE. This is the one that costs money if it breaks. An LLM given
//    "capture_bd: 50% reply rate" will target that segment and defend the choice persuasively; it
//    will not volunteer that the rate is 1 reply from 2 sends. Early in a pilot every segment looks
//    like that. So the tests below assert not just that low-n segments rank last, but that they are
//    NOT RANKED AT ALL and that no rate is computed for them — a percentage that is never produced
//    cannot be quoted. The Wilson-inversion test proves why the gate has to exist on top of the
//    statistic rather than instead of it.
//
// No sheet, no network, no n8n. Run:  node test-segment-scoring.mjs

import S from './segment-scoring.js';

let pass = 0, fail = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
}
function ok(name, cond, detail) {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
  cond ? pass++ : fail++;
}

// ===========================================================================
console.log('\n-- title normalization: the messy real world collapses to one bucket --');
// ===========================================================================
{
  // The exact variants named in the spec, plus the spellings Apollo actually returns.
  const capture = [
    'VP of Business Development', 'V.P. Business Development', 'VP, BD',
    'vp business development', 'Vice President - Business Development',
    'VP  of   Business   Development ', 'SVP, Business Development',
    'Director, Business Development (Federal)', 'Dir. of Biz Dev',
    'BizDev Lead', 'Sr. Business Development Manager', 'Capture Manager',
    'Senior Capture Manager, GovCon', 'Head of Growth', 'Bus. Dev. Manager',
  ];
  const buckets = capture.map(S.normalizeTitle);
  ok('15 capture/BD spellings all land in capture_bd',
    buckets.every(b => b === 'capture_bd'),
    capture.map((t, i) => `${t} -> ${buckets[i]}`).filter((_, i) => buckets[i] !== 'capture_bd').join('; '));

  check('the three spec variants normalize to one identical string', [
    S.canonicalText('VP of Business Development'),
    S.canonicalText('V.P. Business Development'),
    S.canonicalText('VP, BD'),
  ], ['vice president business development', 'vice president business development',
    'vice president business development']);
}
{
  const cases = [
    ['Proposal Manager', 'proposal'],
    ['RFP Coordinator', 'proposal'],
    ['Capture & Proposal Manager', 'capture_bd'],   // capture wins on purpose: GovCon buyer signal
    ['Contracting Officer', 'contracts'],
    ['Director of Procurement', 'contracts'],
    ['CIO', 'it_leadership'],
    ['C.I.O.', 'it_leadership'],
    ['Chief Information Officer', 'it_leadership'],
    ['Director of IT', 'it_leadership'],
    ['IT Program Manager', 'it_leadership'],        // ordered before program_pm — it is an IT buyer
    ['Program Manager', 'program_pm'],              // ...but a bare one is not
    ['Digital Transformation Lead', 'it_leadership'],
    ['CISO', 'security'],
    ['Chief Information Security Officer', 'security'],
    ['Director of IT Security', 'security'],        // security beats it_leadership, deliberately
    ['Cyber Program Manager', 'security'],
    ['Software Engineer', 'engineering'],
    ['Chief Executive Officer', 'exec'],
    ['CEO', 'exec'],
    ['President', 'exec'],
    ['President & Founder', 'exec'],
    ['Vice President, Sales', 'sales'],             // "vice president" must NOT read as exec
    ['VP Marketing', 'marketing'],
    ['CFO', 'finance'],
    ['Director of Human Resources', 'hr'],
    ['Operations Manager', 'operations'],
    // The vocabulary is English/US-only on purpose — the ICP in both configs is
    // person_locations: ["United States"]. A foreign-language title is honestly 'other', not a guess.
    ['Directeur Général', 'other'],
    ['Barista', 'other'],
    ['', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    ['   ', 'unknown'],
    ['!!!', 'unknown'],
  ];
  let bad = [];
  for (const [title, want] of cases) {
    const got = S.normalizeTitle(title);
    if (got !== want) bad.push(`${JSON.stringify(title)} -> ${got} (want ${want})`);
  }
  ok(`${cases.length} title cases route to the intended bucket`, bad.length === 0, bad.join('\n        '));
}
{
  // Every title must land in a KNOWN bucket — a typo in a rule name would otherwise silently
  // create a new segment dimension value that nothing else in the system recognises.
  const wild = ['Chief Ninja', '  ', 'VP', 'Manager', '123', 'Vice President of Everything'];
  ok('diacritics are stripped before matching', S.canonicalText('Directeur Général') === 'directeur general');
  ok('no title ever produces an unknown bucket name',
    wild.map(S.normalizeTitle).every(b => S.ROLE_BUCKETS.indexOf(b) !== -1));
}
{
  check('seniority is derived but stays OUT of segment_key (cardinality)',
    [S.titleSeniority('VP, BD'), S.titleSeniority('CIO'), S.titleSeniority('Capture Manager'),
      S.buildSegmentKey({ source_config: 'oryoniq', title: 'VP, BD', industry: 'Defense & Space', headcount: 120 }).segment_key],
    ['vp', 'c_suite', 'manager', 'oryoniq|capture_bd|gov_defense|51-200']);
}

// ===========================================================================
console.log('\n-- industry normalization --');
// ===========================================================================
{
  const cases = [
    ['Defense & Space', 'gov_defense'],
    ['Aviation & Aerospace', 'gov_defense'],
    ['Government Administration', 'gov_defense'],
    ['Information Technology & Services', 'it_software'],
    ['Computer & Network Security', 'it_software'],
    ['Computer Software', 'it_software'],
    ['Management Consulting', 'prof_services'],
    ['Construction', 'industrial'],
    ['Mechanical Or Industrial Engineering', 'industrial'],
    ['Hospital & Health Care', 'healthcare'],
    ['Banking', 'financial'],
    ['Higher Education', 'education'],
    ['Nonprofit Organization Management', 'nonprofit'],
    ['Sheep Farming', 'other'],
    ['', 'unknown'],
    [null, 'unknown'],
  ];
  let bad = [];
  for (const [ind, want] of cases) {
    const got = S.normalizeIndustry(ind);
    if (got !== want) bad.push(`${JSON.stringify(ind)} -> ${got} (want ${want})`);
  }
  ok(`${cases.length} Apollo industry strings collapse to the right family`, bad.length === 0,
    bad.join('\n        '));
  ok('a defense contractor that also says "IT services" is filed as gov_defense',
    S.normalizeIndustry('Defense & Space / Information Technology and Services') === 'gov_defense');
}

// ===========================================================================
console.log('\n-- headcount banding, exactly at the boundaries --');
// ===========================================================================
{
  const cases = [
    [1, '1-10'], [10, '1-10'], [11, '11-50'], [50, '11-50'],
    [51, '51-200'], [200, '51-200'], [201, '201-500'], [500, '201-500'],
    [501, '501-1000'], [1000, '501-1000'], [1001, '1001+'], [250000, '1001+'],
  ];
  let bad = [];
  for (const [n, want] of cases) {
    const got = S.normalizeHeadcount(n);
    if (got !== want) bad.push(`${n} -> ${got} (want ${want})`);
  }
  ok('every band boundary (10/11, 50/51, 200/201, 500/501, 1000/1001) lands on the right side',
    bad.length === 0, bad.join('; '));

  check('0, negatives, blanks and junk are "unknown" — never a band, never NaN', [
    S.normalizeHeadcount(0), S.normalizeHeadcount(-5), S.normalizeHeadcount(null),
    S.normalizeHeadcount(undefined), S.normalizeHeadcount(''), S.normalizeHeadcount('   '),
    S.normalizeHeadcount('abc'), S.normalizeHeadcount(NaN), S.normalizeHeadcount(Infinity),
    S.normalizeHeadcount({}),
  ], ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown',
    'unknown', 'unknown']);

  check('sheet/Apollo string shapes parse', [
    S.normalizeHeadcount('120'), S.normalizeHeadcount(' 340 '), S.normalizeHeadcount('1,200'),
    S.normalizeHeadcount('51-200'), S.normalizeHeadcount('10001+'), S.normalizeHeadcount('11-50'),
  ], ['51-200', '201-500', '1001+', '51-200', '1001+', '11-50']);
}

// ===========================================================================
console.log('\n-- segment_key: build, parse, round-trip --');
// ===========================================================================
{
  const lead = {
    source_config: 'OryonIQ', title: 'V.P. Business Development',
    industry: 'Defense & Space', headcount: 340,
  };
  const built = S.buildSegmentKey(lead);
  check('key is source|role|industry|size, lowercase, 4 parts',
    built.segment_key, 'oryoniq|capture_bd|gov_defense|201-500');
  check('components are returned alongside, ready to write as their own columns',
    [built.source_config, built.role_bucket, built.industry_bucket, built.size_band],
    ['oryoniq', 'capture_bd', 'gov_defense', '201-500']);
  check('parse round-trips', S.parseSegmentKey(built.segment_key), {
    source_config: 'oryoniq', role_bucket: 'capture_bd',
    industry_bucket: 'gov_defense', size_band: '201-500',
  });
  check('a lead with nothing known still gets a well-formed key',
    S.buildSegmentKey({}).segment_key, 'unknown|unknown|unknown|unknown');
  check('a truncated key parses to unknowns rather than undefined',
    S.parseSegmentKey('oryoniq|capture_bd'),
    { source_config: 'oryoniq', role_bucket: 'capture_bd', industry_bucket: 'unknown', size_band: 'unknown' });
  check('the two live product configs produce distinct keys for their own ICPs', [
    S.buildSegmentKey({ source_config: 'OryonIQ', title: 'Capture Manager', industry: 'Defense & Space', headcount: 90 }).segment_key,
    S.buildSegmentKey({ source_config: 'VisioneerIT', title: 'CISO', industry: 'Information Technology & Services', headcount: 90 }).segment_key,
  ], ['oryoniq|capture_bd|gov_defense|51-200', 'visioneerit|security|it_software|51-200']);
}

// ===========================================================================
console.log('\n-- Wilson lower bound --');
// ===========================================================================
{
  ok('n = 0 returns null, not NaN and not Infinity', S.wilsonLowerBound(0, 0) === null);
  ok('0 successes of 300 is a small positive number, not 0 — we do not "know" it is zero',
    S.wilsonLowerBound(0, 300) >= 0 && S.wilsonLowerBound(0, 300) < 0.02);
  ok('lower bound never exceeds the point estimate',
    S.wilsonLowerBound(60, 1000) < 0.06 && S.wilsonLowerBound(60, 1000) > 0.04);
  ok('more evidence at the same rate tightens the bound upward',
    S.wilsonLowerBound(30, 500) > S.wilsonLowerBound(6, 100));
  ok('successes above n are clamped rather than producing a rate > 1',
    S.wilsonLowerBound(99, 10) <= 1);

  // THE REASON THE HARD GATE EXISTS. Wilson penalises small n — but not nearly enough down here.
  const tiny = S.wilsonLowerBound(1, 2);       // 1 reply from 2 sends
  const solid = S.wilsonLowerBound(60, 1000);  // 6% from a real campaign
  ok('a 1/2 coin flip OUT-SCORES 60/1000 on Wilson alone — statistic alone is not a safeguard',
    tiny > solid, `1/2 lb=${tiny.toFixed(4)} vs 60/1000 lb=${solid.toFixed(4)}`);
}

// ===========================================================================
console.log('\n-- the sample gate: low-n segments are not ranked and get no rate at all --');
// ===========================================================================
const rows = [
  // the tempting one: 50% reply rate, two sends
  { segment_key: 'oryoniq|capture_bd|gov_defense|1-10', sent: 2, sample_size: 2, replied: 1, positive: 1 },
  // the boring one that actually knows something
  { segment_key: 'oryoniq|capture_bd|gov_defense|201-500', sent: 1000, sample_size: 1000, replied: 60, positive: 30 },
  // exactly at the gate
  { segment_key: 'oryoniq|proposal|gov_defense|51-200', sent: 50, sample_size: 50, replied: 4, positive: 2 },
  // one under the gate
  { segment_key: 'oryoniq|contracts|gov_defense|51-200', sent: 49, sample_size: 49, replied: 9, positive: 9 },
];
{
  const r = S.rankSegments(rows);
  check('only the segments at/over 50 sends are ranked',
    r.ranked.map(x => x.segment_key).sort(),
    ['oryoniq|capture_bd|gov_defense|201-500', 'oryoniq|proposal|gov_defense|51-200']);
  check('the rest are quarantined in `insufficient`, never in `ranked`',
    r.insufficient.map(x => x.segment_key).sort(),
    ['oryoniq|capture_bd|gov_defense|1-10', 'oryoniq|contracts|gov_defense|51-200']);

  ok('n = 50 is IN (the gate is >=, not >)',
    r.ranked.some(x => x.sample_size === 50));
  ok('n = 49 is OUT',
    r.insufficient.some(x => x.sample_size === 49));

  const tiny = r.insufficient.find(x => x.sample_size === 2);
  check('the 50%-from-2-sends segment yields NO rate — null, not a labelled number',
    { reply_rate: tiny.reply_rate, positive_rate: tiny.positive_rate, score: tiny.score, rank: tiny.rank },
    { reply_rate: null, positive_rate: null, score: null, rank: null });
  check('...but its raw counts and shortfall are reported honestly',
    { replied: tiny.replied, sample_size: tiny.sample_size, needs: tiny.needs_n_more,
      confidence: tiny.confidence },
    { replied: 1, sample_size: 2, needs: 48, confidence: 'insufficient' });
  ok('no serialized rate string for an ungated segment can leak into a prompt',
    JSON.stringify(tiny).indexOf('0.5') === -1, JSON.stringify(tiny));
}
{
  // The headline requirement, stated as an assertion.
  const r = S.rankSegments(rows);
  check('the tiny high-rate segment does NOT outrank the solid one — it has no rank',
    r.ranked[0].segment_key, 'oryoniq|capture_bd|gov_defense|201-500');
  ok('the 1000-send segment ranks #1 despite a lower headline rate than 50% and 18%',
    r.ranked[0].rank === 1 && r.ranked[0].sample_size === 1000);

  // ...and it stays true when ranking on replies rather than positives.
  const r2 = S.rankSegments(rows, { metric: 'reply' });
  check('same under metric:"reply"', r2.ranked[0].segment_key, 'oryoniq|capture_bd|gov_defense|201-500');
}
{
  const r = S.rankSegments(rows, { minSample: 500 });
  check('raising the gate re-quarantines segments that used to be ranked',
    { ranked: r.ranked.length, insufficient: r.insufficient.length }, { ranked: 1, insufficient: 3 });
  check('the gate in force is reported back so a caller cannot mistake which one ran',
    r.gate.min_sample, 500);
}
{
  const none = S.rankSegments([
    { segment_key: 'oryoniq|capture_bd|gov_defense|1-10', sent: 3, sample_size: 3, replied: 2, positive: 2 },
  ]);
  check('with nothing over the gate there is no ranking at all', none.ranked, []);
  ok('and the caveat says so in words the agent will read',
    /No segment has reached 50 sends/.test(none.caveat), none.caveat);
}

// ===========================================================================
console.log('\n-- every rate is accompanied by its sample_size, everywhere --');
// ===========================================================================
{
  const r = S.rankSegments(rows);
  const rateKeys = ['reply_rate', 'positive_rate', 'reply_rate_lb', 'positive_rate_lb', 'score'];
  let violations = [];
  for (const seg of r.ranked.concat(r.insufficient)) {
    const carriesRate = rateKeys.some(k => typeof seg[k] === 'number');
    if (carriesRate && typeof seg.sample_size !== 'number') violations.push(seg.segment_key);
  }
  ok('no object carrying a rate is missing sample_size', violations.length === 0, violations.join(', '));

  const text = S.summarize(r);
  ok('every summary line that prints a % also prints the sample it came from',
    text.split('\n').filter(l => l.startsWith('#')).length === 2
    && text.split('\n').filter(l => l.startsWith('#')).every(l => /matured sends/.test(l)), text);
  ok('the summary marks unranked segments UNRANKED', /UNRANKED/.test(text));
}

// ===========================================================================
console.log('\n-- division by zero and other arithmetic traps --');
// ===========================================================================
{
  const r = S.rankSegments([
    { segment_key: 'oryoniq|capture_bd|gov_defense|51-200', sent: 0, sample_size: 0, replied: 0, positive: 0 },
    { segment_key: 'oryoniq|proposal|gov_defense|51-200', sent: 0, replied: 0, positive: 0 },
    { segment_key: 'oryoniq|exec|gov_defense|51-200', sent: 300, sample_size: 0, replied: 0, positive: 0 },
  ]);
  check('a zero-send segment produces no rate and no ranking', r.ranked, []);
  const dumped = JSON.stringify(r);
  ok('nothing anywhere in the result is NaN', dumped.indexOf('NaN') === -1);
  ok('nothing anywhere in the result is Infinity', dumped.indexOf('Infinity') === -1);
  ok('nothing anywhere in the result is null-as-a-string artifact of a bad divide',
    r.insufficient.every(s => s.reply_rate === null && s.positive_rate === null));
  ok('a segment with sends but a zero denominator is still unranked, not crashed',
    r.insufficient.some(s => s.sent === 300 && s.sample_size === 0));
  ok('confidenceLabel is defined at 0', S.confidenceLabel(0) === 'insufficient');
}

// ===========================================================================
console.log('\n-- missing and malformed fields --');
// ===========================================================================
{
  const messy = [
    // sheet strings, thousands separators, stray %
    { segment_key: 'oryoniq|capture_bd|gov_defense|201-500', sent: '1,000', sample_size: '1,000', replied: '60', positive: '30' },
    // no counts at all
    { segment_key: 'oryoniq|proposal|gov_defense|51-200' },
    // completely empty row (a trailing blank line in the Sheet)
    {},
    // null row
    null,
    // impossible: more replies than sends
    { segment_key: 'oryoniq|contracts|gov_defense|51-200', sent: 100, sample_size: 100, replied: 400, positive: 1 },
    // impossible: more positives than replies
    { segment_key: 'oryoniq|exec|gov_defense|51-200', sent: 200, sample_size: 200, replied: 5, positive: 99 },
    // negatives
    { segment_key: 'oryoniq|sales|gov_defense|51-200', sent: -10, sample_size: -10, replied: -3, positive: -1 },
    // garbage in numeric columns
    { segment_key: 'oryoniq|hr|gov_defense|51-200', sent: 'n/a', sample_size: 'tbd', replied: '', positive: undefined },
  ];
  let r;
  let threw = null;
  try { r = S.rankSegments(messy); } catch (e) { threw = e; }
  ok('a malformed sheet never throws', threw === null, threw && threw.message);
  ok('no NaN / Infinity survives the mess',
    JSON.stringify(r).indexOf('NaN') === -1 && JSON.stringify(r).indexOf('Infinity') === -1);

  const strRow = r.ranked.find(x => x.segment_key === 'oryoniq|capture_bd|gov_defense|201-500');
  check('"1,000" is read as 1000 and rates come out right',
    { n: strRow.sample_size, reply: strRow.reply_rate, pos: strRow.positive_rate },
    { n: 1000, reply: 0.06, pos: 0.03 });

  const impossible = r.ranked.find(x => x.segment_key === 'oryoniq|contracts|gov_defense|51-200');
  check('400 replies from 100 sends is clamped to 100% and FLAGGED, not silently believed',
    { reply_rate: impossible.reply_rate, warn: impossible.data_warnings },
    { reply_rate: 1, warn: ['replied_exceeds_sample'] });

  const posBad = r.ranked.find(x => x.segment_key === 'oryoniq|exec|gov_defense|51-200');
  check('positives above replies are clamped to replies and flagged',
    { positive: posBad.positive, warn: posBad.data_warnings },
    { positive: 5, warn: ['positive_exceeds_replied'] });

  const neg = r.insufficient.find(x => x.segment_key === 'oryoniq|sales|gov_defense|51-200');
  check('negative counts floor at zero',
    { sent: neg.sent, sample: neg.sample_size, replied: neg.replied, positive: neg.positive },
    { sent: 0, sample: 0, replied: 0, positive: 0 });

  ok('an empty row and a null row become the unknown segment rather than crashing',
    r.insufficient.some(x => x.segment_key === 'unknown|unknown|unknown|unknown'));
  ok('missing sent is flagged',
    r.insufficient.concat(r.ranked).some(x => x.data_warnings.indexOf('missing_sent') !== -1));

  check('non-array input is tolerated',
    [S.rankSegments(null).ranked.length, S.rankSegments(undefined).totals.segments,
      S.rankSegments('nope').ranked.length], [0, 0, 0]);
}
{
  // A row with no segment_key but with the component columns filled — the shape the Sheet actually
  // holds, since the columns are written out individually as well as composed into the key.
  const r = S.rankSegments([{
    source_config: 'oryoniq', role_bucket: 'capture_bd', industry_bucket: 'gov_defense',
    size_band: '51-200', sent: 200, sample_size: 200, replied: 12, positive: 6,
  }]);
  check('component columns reconstruct the key when segment_key is blank',
    r.ranked[0].segment_key, 'oryoniq|capture_bd|gov_defense|51-200');
}
{
  // ...and the reverse: key present, component columns blank.
  const r = S.rankSegments([{
    segment_key: 'visioneerit|security|it_software|1001+', sent: 200, sample_size: 200, replied: 12, positive: 6,
  }]);
  check('components are recovered from the key when the columns are blank',
    [r.ranked[0].source_config, r.ranked[0].role_bucket, r.ranked[0].industry_bucket, r.ranked[0].size_band],
    ['visioneerit', 'security', 'it_software', '1001+']);
}

// ===========================================================================
console.log('\n-- roll-ups: how a young pilot gets an answer before 30,000 sends --');
// ===========================================================================
{
  const fragmented = [
    { segment_key: 'oryoniq|capture_bd|gov_defense|51-200', sent: 30, sample_size: 30, replied: 3, positive: 2 },
    { segment_key: 'oryoniq|capture_bd|it_software|201-500', sent: 30, sample_size: 30, replied: 2, positive: 1 },
    { segment_key: 'oryoniq|capture_bd|industrial|1001+', sent: 30, sample_size: 30, replied: 1, positive: 1 },
    { segment_key: 'oryoniq|proposal|gov_defense|51-200', sent: 20, sample_size: 20, replied: 0, positive: 0 },
  ];
  const full = S.rankSegments(fragmented);
  check('at the full four-way key nothing clears 50 sends', full.ranked.length, 0);

  const rolled = S.rankSegments(fragmented, { dimensions: ['source_config', 'role_bucket'] });
  check('rolled up to role, capture_bd has 90 sends and IS rankable',
    { key: rolled.ranked[0].segment_key, n: rolled.ranked[0].sample_size, replied: rolled.ranked[0].replied },
    { key: 'oryoniq|capture_bd|*|*', n: 90, replied: 6 });
  check('marginalised dimensions render as * so nobody mistakes a roll-up for a full segment',
    rolled.ranked[0].industry_bucket, '*');
  check('proposal at 20 sends is still quarantined even after the roll-up',
    rolled.insufficient.map(x => x.segment_key), ['oryoniq|proposal|*|*']);
  check('the roll-up dimensions are echoed back', rolled.gate.dimensions,
    ['source_config', 'role_bucket']);
}
{
  // Ordering must be deterministic — the same table must never give the agent a different winner.
  const tied = [
    { segment_key: 'oryoniq|proposal|gov_defense|51-200', sent: 200, sample_size: 200, replied: 20, positive: 10 },
    { segment_key: 'oryoniq|capture_bd|gov_defense|51-200', sent: 200, sample_size: 200, replied: 20, positive: 10 },
  ];
  const a = S.rankSegments(tied).ranked.map(x => x.segment_key);
  const b = S.rankSegments(tied.slice().reverse()).ranked.map(x => x.segment_key);
  check('identical scores break ties deterministically regardless of row order', a, b);
}

// ===========================================================================
console.log('\n-- targeting weights: exploit the winners, keep sampling the unknowns --');
// ===========================================================================
{
  const r = S.rankSegments(rows);
  const w = S.targetingWeights(r);
  const sum = w.reduce((a, x) => a + x.weight, 0);
  ok('weights sum to 1', Math.abs(sum - 1) < 1e-4, String(sum));
  ok('every weighted segment still carries its sample_size',
    w.every(x => typeof x.sample_size === 'number'));
  const reserve = w.filter(x => x.basis === 'exploration_reserve');
  ok('under-sampled segments keep a share of the budget — otherwise the gate is a trap they can '
    + 'never escape', reserve.length === 2 && reserve.every(x => x.weight > 0));
  const exploit = w.filter(x => x.basis === 'wilson_lb_proportional');
  ok('the proven segment gets the largest single share',
    exploit.every(x => x.weight <= exploit.find(y => y.segment_key.indexOf('201-500') !== -1).weight));
  ok('exploration share is honoured',
    Math.abs(reserve.reduce((a, x) => a + x.weight, 0) - 0.20) < 1e-4);
}
{
  const none = S.rankSegments([
    { segment_key: 'oryoniq|capture_bd|gov_defense|1-10', sent: 3, sample_size: 3, replied: 3, positive: 3 },
    { segment_key: 'oryoniq|proposal|gov_defense|1-10', sent: 3, sample_size: 3, replied: 0, positive: 0 },
  ]);
  const w = S.targetingWeights(none);
  check('with no evidence, weighting is UNIFORM — a 3/3 segment gets no advantage over a 0/3 one',
    w.map(x => x.weight), [0.5, 0.5]);
  check('and says why', w.map(x => x.basis), ['uniform_no_evidence', 'uniform_no_evidence']);
}
{
  const r = S.rankSegments(rows);
  const w = S.targetingWeights(r, { exploreShare: 0 });
  ok('exploration can be switched off explicitly, but only explicitly',
    Math.abs(w.filter(x => x.basis === 'exploration_reserve').reduce((a, x) => a + x.weight, 0)) < 1e-9);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
