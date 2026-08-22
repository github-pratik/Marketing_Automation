/**
 * VIO segment scoring — the outbound engine's targeting memory.
 * Built 2026-08-21. Pure functions, no I/O, no deps. Runs three places unchanged:
 *   - `node` (the test harness, test-segment-scoring.mjs)
 *   - an n8n Code node (paste the file body; the module.exports guard at the bottom is a no-op there)
 *   - the reach-engine, via a Node shim, if the Python side ever needs it
 *
 * WHY THIS FILE EXISTS
 * The operator wants the agent to learn which prospects actually reply and to weight future
 * targeting toward them. That learning has to live in DATA — the `Segments` tab — not in an LLM's
 * context. An n8n `memoryBufferWindow` holds one conversation and forgets it; the Sheet remembers
 * across every run, every product, and every model swap. This file is the only place that decides
 * (a) which bucket a lead belongs to and (b) whether a bucket has earned the right to be ranked.
 *
 * THE DANGEROUS PART, STATED PLAINLY
 * An LLM handed "capture_bd/gov_defense: 50% reply rate" will target capture_bd/gov_defense and
 * argue for it fluently. It will not notice the rate came from 1 reply out of 2 sends. Early in a
 * pilot EVERY segment looks like that, so an ungated scorer doesn't learn the market — it learns
 * the noise, then spends real Apollo/Instantly budget defending it. Hence the two hard rules
 * enforced below and covered by tests:
 *   1. No segment under MIN_SAMPLE sends is ranked. Ever. It is returned in a separate
 *      `insufficient` list with COUNTS ONLY — `reply_rate` is literally `null`, so there is no
 *      seductive percentage for a model to quote.
 *   2. Every object that carries a rate also carries `sample_size`. A rate without its denominator
 *      never leaves this file.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Minimum sends before a segment may be ranked at all. See "How much data" at the bottom. */
const MIN_SAMPLE = 50;

/** 95% two-sided normal quantile, for the Wilson interval. */
const Z_95 = 1.96;

/** Fraction of future targeting held back for segments that have not earned a rank yet.
 *  Without this the gate is a trap: a segment stuck at 12 sends is never targeted, so it never
 *  reaches 50, so it is never evaluated. Exploration is what makes the gate escapable. */
const DEFAULT_EXPLORE_SHARE = 0.20;

const DIMENSIONS = ['source_config', 'role_bucket', 'industry_bucket', 'size_band'];

// ---------------------------------------------------------------------------
// 1. Normalizers — turn messy Apollo free-search fields into a small, stable vocabulary
// ---------------------------------------------------------------------------

/**
 * Aggressive text canonicalisation. Everything downstream matches against this form, so
 * "VP of Business Development", "V.P. Business Development" and "VP, BD" become one string.
 * Fragmentation here is fatal: three spellings of one job = three segments of 17 sends each,
 * none of which ever clears the gate, and the system learns nothing.
 */
function canonicalText(raw) {
  if (raw === null || raw === undefined) return '';
  let t = String(raw);
  // strip diacritics ("Directeur Général" -> "directeur general")
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.toLowerCase();
  t = t.replace(/&/g, ' and ');
  t = t.replace(/\./g, '');            // "v.p." -> "vp", "sr." -> "sr"  (BEFORE punctuation split)
  t = t.replace(/[^a-z0-9+]+/g, ' ');  // everything else becomes a separator
  t = t.trim().replace(/\s+/g, ' ');
  if (!t) return '';

  // Token-level expansion. Token-level on purpose: a substring replace of "it" would maul "unit".
  const EXPAND = {
    vp: 'vice president', svp: 'senior vice president', evp: 'executive vice president',
    avp: 'assistant vice president', vps: 'vice president',
    sr: 'senior', snr: 'senior', jr: 'junior',
    dir: 'director', mgr: 'manager', mngr: 'manager', mgmt: 'management',
    asst: 'assistant', assoc: 'associate', exec: 'executive', ops: 'operations',
    biz: 'business', bus: 'business', dev: 'development', devel: 'development',
    bd: 'business development', bizdev: 'business development', bdm: 'business development manager',
    govcon: 'government contracting', gov: 'government', govt: 'government', fed: 'federal',
    it: 'information technology', ict: 'information technology',
    cio: 'chief information officer', ciso: 'chief information security officer',
    cto: 'chief technology officer', ceo: 'chief executive officer',
    coo: 'chief operating officer', cfo: 'chief financial officer',
    cro: 'chief revenue officer', cmo: 'chief marketing officer',
    infosec: 'information security', cyber: 'cybersecurity', sec: 'security',
    hr: 'human resources', pm: 'program manager', pmo: 'program management office',
    rfp: 'proposal', rfps: 'proposal', bids: 'proposal',
    swe: 'software engineer', eng: 'engineering', engr: 'engineer',
    acct: 'account', ae: 'account executive',
  };
  // Noise that only ever splits identical roles into different strings.
  const DROP = new Set(['the', 'of', 'and', 'for', 'at', 'a', 'an', 'to', 'in', 'on',
    'global', 'corporate', 'group', 'team', 'division', 'department', 'office',
    'us', 'usa', 'u', 's', 'america', 'american', 'north', 'emea', 'apac', 'na',
    'interim', 'acting', 'co', 'llc', 'inc']);

  const out = [];
  for (const tok of t.split(' ')) {
    if (!tok) continue;
    const expanded = Object.prototype.hasOwnProperty.call(EXPAND, tok) ? EXPAND[tok] : tok;
    for (const w of expanded.split(' ')) {
      if (!DROP.has(w)) out.push(w);
    }
  }
  return out.join(' ');
}

/**
 * ORDERED rules — first match wins, and the order encodes real judgement calls:
 *   - security BEFORE it_leadership, so "Director of IT Security" is a security buyer, not an IT one.
 *   - capture_bd BEFORE proposal, because in GovCon "Capture & Proposal Manager" is a capture buyer.
 *   - it_leadership BEFORE program_pm, because VisioneerIT's ICP literally targets
 *     "IT Program Manager" as an IT decision maker; a bare "Program Manager" still lands in program_pm.
 *   - exec BEFORE sales/marketing, but its president test excludes "vice president" — otherwise
 *     every "VP of Business Development" would be filed as a C-suite exec.
 * Change the order and you change what the historical data means, so treat it as schema.
 */
const ROLE_RULES = [
  ['security', t => /\b(security|cybersecurity|cyber|zero trust|soc|grc|risk and compliance)\b/.test(t)],
  ['capture_bd', t => /\b(capture|business development|growth|partnerships?|alliances)\b/.test(t)],
  ['proposal', t => /\b(proposal|proposals|bid|bids|pursuit|pursuits)\b/.test(t)],
  ['contracts', t => /\b(contract|contracts|contracting|subcontract|procurement|acquisitions?|sourcing)\b/.test(t)],
  ['it_leadership', t => /\b(information technology|chief information officer|chief technology officer|infrastructure|systems|networks?|digital transformation|modernization|cloud)\b/.test(t)],
  ['engineering', t => /\b(engineer|engineering|software|developer|architect|devops|data science|platform)\b/.test(t)],
  ['program_pm', t => /\b(program|project|portfolio|delivery)\b/.test(t)],
  ['exec', t => /\b(chief executive|chief operating|founder|owner|principal|managing director|general manager)\b/.test(t)
    || (/\bpresident\b/.test(t) && !/\bvice president\b/.test(t))],
  ['sales', t => /\b(sales|account executive|account manager|revenue|quota|client)\b/.test(t)],
  ['marketing', t => /\b(marketing|demand generation|brand|communications|content)\b/.test(t)],
  ['finance', t => /\b(finance|financial|controller|accounting|treasury|pricing)\b/.test(t)],
  ['hr', t => /\b(human resources|talent|recruit|recruiting|recruiter|people)\b/.test(t)],
  ['operations', t => /\b(operations|operational|logistics|supply chain|facilities)\b/.test(t)],
];

const ROLE_BUCKETS = ROLE_RULES.map(r => r[0]).concat(['other', 'unknown']);

/** Messy job title -> one of ROLE_BUCKETS. `unknown` only for genuinely absent titles. */
function normalizeTitle(title) {
  const t = canonicalText(title);
  if (!t) return 'unknown';
  for (const [bucket, test] of ROLE_RULES) if (test(t)) return bucket;
  return 'other';
}

/** Seniority is deliberately NOT part of segment_key — see "Cardinality" below. Exposed because
 *  it is the first dimension worth adding once volume supports a fifth. */
function titleSeniority(title) {
  const t = canonicalText(title);
  if (!t) return 'unknown';
  if (/\bchief\b|\bchief executive officer\b/.test(t) || /\b(chief information officer|chief technology officer|chief financial officer|chief operating officer)\b/.test(t)) return 'c_suite';
  if (/\bpresident\b|\bfounder\b|\bowner\b|\bpartner\b/.test(t) && !/\bvice president\b/.test(t)) return 'c_suite';
  if (/\bvice president\b/.test(t)) return 'vp';
  if (/\bhead\b|\bdirector\b/.test(t)) return 'director';
  if (/\bmanager\b|\blead\b|\bsupervisor\b/.test(t)) return 'manager';
  if (/\bsenior\b|\bprincipal\b|\bstaff\b/.test(t)) return 'senior_ic';
  return 'ic';
}

/**
 * Apollo emits ~65 free-text industry strings. Kept verbatim they would shatter the table, so they
 * collapse to nine families. Ordered: gov_defense first, because a defense contractor that also
 * calls itself "information technology and services" is, for our purposes, a defense buyer.
 */
const INDUSTRY_RULES = [
  ['gov_defense', t => /\b(defense|defence|space|aerospace|aviation|military|armed forces|government|public policy|international affairs|legislative|judiciary|homeland)\b/.test(t)],
  ['it_software', t => /\b(information technology|computer|software|internet|saas|telecommunications|semiconductors|data|network|security|technology)\b/.test(t)],
  ['prof_services', t => /\b(consulting|staffing|recruiting|legal|law|accounting|research|advertising|marketing|public relations|outsourcing|professional (training|services)|architecture)\b/.test(t)],
  ['industrial', t => /\b(manufactur|construction|engineering|machinery|industrial|automotive|electrical|mining|oil|energy|utilities|logistics|transportation|shipbuilding)\b/.test(t)],
  ['healthcare', t => /\b(hospital|health|medical|pharmaceutical|biotech|clinic)\b/.test(t)],
  ['financial', t => /\b(bank|banking|financial|finance|insurance|investment|capital markets|venture|credit union|wealth)\b/.test(t)],
  ['education', t => /\b(education|university|school|academic|e learning|higher)\b/.test(t)],
  ['nonprofit', t => /\b(nonprofit|non profit|ngo|philanthropy|civic|think tanks?|association)\b/.test(t)],
];

const INDUSTRY_BUCKETS = INDUSTRY_RULES.map(r => r[0]).concat(['other', 'unknown']);

function normalizeIndustry(industry) {
  const t = canonicalText(industry);
  if (!t) return 'unknown';
  for (const [bucket, test] of INDUSTRY_RULES) if (test(t)) return bucket;
  return 'other';
}

/**
 * Headcount bands. The 500 boundary is not arbitrary: it is the SBA employee-count line that most
 * often separates a small-business set-aside bidder from a large prime, which for OryonIQ is the
 * single most decision-relevant fact about a company's size.
 */
const SIZE_BANDS = [
  ['1-10', 1, 10],
  ['11-50', 11, 50],
  ['51-200', 51, 200],
  ['201-500', 201, 500],
  ['501-1000', 501, 1000],
  ['1001+', 1001, Infinity],
];

/** Accepts a number, "1,200", " 340 ", or an Apollo-style range string like "51-200"/"10001+". */
function normalizeHeadcount(value) {
  let n = null;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const s = value.replace(/,/g, '').trim();
    const range = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    const plus = s.match(/^(\d+)\s*\+$/);
    if (range) n = Math.floor((Number(range[1]) + Number(range[2])) / 2);
    else if (plus) n = Number(plus[1]);
    else if (/^\d+(\.\d+)?$/.test(s)) n = Number(s);
  }
  if (n === null || !Number.isFinite(n) || n < 1) return 'unknown';
  for (const [band, lo, hi] of SIZE_BANDS) if (n >= lo && n <= hi) return band;
  return 'unknown';
}

function normalizeConfig(value) {
  const t = canonicalText(value).replace(/ /g, '_');
  return t || 'unknown';
}

// ---------------------------------------------------------------------------
// 2. segment_key
// ---------------------------------------------------------------------------

/**
 * segment_key = source_config | role_bucket | industry_bucket | size_band
 *
 * Every component is free from Apollo's UNPAID people search (`title`,
 * `organization.industry`, `organization.estimated_num_employees`) plus the product config the run
 * was launched with — so bucketing a lead costs zero credits and happens before any reveal.
 * Pipe-delimited, lowercase, fixed arity, no spaces: greppable in the Sheet, safe in a URL, and
 * reversible via parseSegmentKey.
 */
function buildSegmentKey(lead) {
  const parts = {
    source_config: normalizeConfig(lead.source_config || lead.product || lead.config || ''),
    role_bucket: normalizeTitle(lead.title || lead.role || ''),
    industry_bucket: normalizeIndustry(lead.industry || lead.org_industry || ''),
    size_band: normalizeHeadcount(
      lead.headcount !== undefined ? lead.headcount
        : lead.employee_count !== undefined ? lead.employee_count
          : lead.estimated_num_employees),
  };
  return Object.assign({ segment_key: DIMENSIONS.map(d => parts[d]).join('|') }, parts);
}

function parseSegmentKey(key) {
  const p = String(key === null || key === undefined ? '' : key).split('|');
  const out = {};
  DIMENSIONS.forEach((d, i) => { out[d] = (p[i] || '').trim() || 'unknown'; });
  return out;
}

// ---------------------------------------------------------------------------
// 3. Statistics
// ---------------------------------------------------------------------------

/**
 * Wilson score interval, lower bound. Returns null when n <= 0 — never NaN, never Infinity.
 *
 * WHY WILSON RATHER THAN THE RAW RATE:
 *   - it is defined and sensible at 0 successes (the normal/Wald interval collapses to [0,0] and
 *     tells you a 0/300 segment is *certainly* 0%, which is wrong and would get it culled);
 *   - it never leaves [0,1], so it cannot report a negative reply rate;
 *   - it shrinks toward 0 as n shrinks, so ranking by it automatically prefers the segment we
 *     actually know something about when two point estimates are close.
 *
 * WHY WILSON IS NOT ENOUGH ON ITS OWN — the reason MIN_SAMPLE is a separate hard gate:
 *   1 reply / 2 sends  -> Wilson LB 0.095
 *   60 replies / 1000  -> Wilson LB 0.047
 * The coin-flip segment outranks the proven one. Wilson penalises small n, but not nearly hard
 * enough at n in the single digits, and no amount of interval arithmetic fixes a sample that
 * contains no information. So: gate first, THEN rank the survivors by Wilson LB.
 */
function wilsonLowerBound(successes, n, z) {
  const Z = typeof z === 'number' ? z : Z_95;
  if (!(n > 0)) return null;
  const k = Math.min(Math.max(Number(successes) || 0, 0), n);
  const p = k / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

/** Sample-size honesty label. `insufficient` is the only one that blocks ranking; the rest are
 *  advisory, and "low" genuinely means low — 50 sends at a 5% base rate is ~2.5 expected replies. */
function confidenceLabel(n) {
  if (!(n >= MIN_SAMPLE)) return 'insufficient';
  if (n < 200) return 'low';
  if (n < 500) return 'moderate';
  return 'high';
}

// ---------------------------------------------------------------------------
// 4. Row hygiene
// ---------------------------------------------------------------------------

/** Google Sheets hands back strings, blanks, and occasionally "1,234". Returns null, never NaN. */
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,\s%]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Clean one Segments row into counts we can add up. Impossible values are CLAMPED and FLAGGED
 * rather than dropped: a row saying 9 replies from 3 sends is a bug upstream, but silently
 * discarding it hides the bug, and trusting it produces a 300% reply rate.
 */
function cleanRow(row) {
  const r = row || {};
  const parts = {};
  const fromKey = parseSegmentKey(r.segment_key);
  for (const d of DIMENSIONS) {
    const explicit = r[d] === null || r[d] === undefined ? '' : String(r[d]).trim();
    parts[d] = explicit || fromKey[d];
  }
  const segment_key = (r.segment_key && String(r.segment_key).trim())
    || DIMENSIONS.map(d => parts[d]).join('|');

  const warnings = [];
  const sent = Math.max(0, num(r.sent) || 0);
  const bounced = Math.max(0, num(r.bounced) || 0);
  const pending = Math.max(0, num(r.pending) || 0);

  // sample_size is the denominator that has actually had a chance to reply: sends minus bounces
  // minus anything still inside the reply window. Counting yesterday's sends dilutes every rate.
  let sample = num(r.sample_size);
  if (sample === null) sample = sent - bounced - pending;
  sample = Math.max(0, sample);
  if (sample > sent && sent > 0) { warnings.push('sample_size_exceeds_sent'); sample = sent; }

  let replied = Math.max(0, num(r.replied) || 0);
  if (replied > sample) { warnings.push('replied_exceeds_sample'); replied = sample; }
  let positive = Math.max(0, num(r.positive) || 0);
  if (positive > replied) { warnings.push('positive_exceeds_replied'); positive = replied; }

  if (num(r.sent) === null && (r.sent !== 0 && r.sent !== '0')) warnings.push('missing_sent');

  return { segment_key, parts, sent, bounced, pending, sample_size: sample, replied, positive, warnings };
}

// ---------------------------------------------------------------------------
// 5. Ranking
// ---------------------------------------------------------------------------

function round(x, places) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = Math.pow(10, places === undefined ? 4 : places);
  return Math.round(x * f) / f;
}

/**
 * rankSegments(rows, opts) -> { ranked, insufficient, totals, gate, caveat }
 *
 * opts.minSample   default MIN_SAMPLE (50). Never silently lowered.
 * opts.metric      'positive' (default) | 'reply'
 * opts.dimensions  subset of DIMENSIONS. Rolls up (marginalises) the others — this is how a young
 *                  pilot gets answers at all: 6 role buckets clear 50 sends far sooner than 240
 *                  full four-way segments do. Marginalised dimensions render as '*' in the key.
 * opts.z           Wilson z, default 1.96.
 *
 * DEFAULT METRIC IS 'positive', NOT 'reply'. Ranking on raw replies rewards whatever provokes a
 * response, and "take me off your list" is a response. That segment would get MORE budget while
 * growing the suppression tab. Both rates are always returned, so nothing is hidden by the choice.
 *
 * Segments under the gate are never ranked, never scored, and are returned with `reply_rate: null`
 * and `positive_rate: null` — counts only. Handing a model "50%" from 2 sends is the failure this
 * whole file exists to prevent, so the number is not produced, not merely labelled.
 */
function rankSegments(rows, opts) {
  const o = opts || {};
  const minSample = typeof o.minSample === 'number' ? o.minSample : MIN_SAMPLE;
  const metric = o.metric === 'reply' ? 'reply' : 'positive';
  const dims = Array.isArray(o.dimensions) && o.dimensions.length
    ? DIMENSIONS.filter(d => o.dimensions.indexOf(d) !== -1)
    : DIMENSIONS.slice();
  const z = typeof o.z === 'number' ? o.z : Z_95;

  const groups = new Map();
  for (const raw of (Array.isArray(rows) ? rows : [])) {
    const c = cleanRow(raw);
    const key = DIMENSIONS.map(d => (dims.indexOf(d) !== -1 ? c.parts[d] : '*')).join('|');
    let g = groups.get(key);
    if (!g) {
      g = {
        segment_key: key, members: 0, sent: 0, bounced: 0, pending: 0,
        sample_size: 0, replied: 0, positive: 0, warnings: new Set(),
      };
      for (const d of DIMENSIONS) g[d] = dims.indexOf(d) !== -1 ? c.parts[d] : '*';
      groups.set(key, g);
    }
    g.members += 1;
    g.sent += c.sent; g.bounced += c.bounced; g.pending += c.pending;
    g.sample_size += c.sample_size; g.replied += c.replied; g.positive += c.positive;
    for (const w of c.warnings) g.warnings.add(w);
  }

  const ranked = [];
  const insufficient = [];
  for (const g of groups.values()) {
    const base = {
      segment_key: g.segment_key,
      source_config: g.source_config, role_bucket: g.role_bucket,
      industry_bucket: g.industry_bucket, size_band: g.size_band,
      rows_aggregated: g.members,
      sent: g.sent, bounced: g.bounced, pending: g.pending,
      sample_size: g.sample_size, replied: g.replied, positive: g.positive,
      data_warnings: Array.from(g.warnings),
    };

    if (!(g.sample_size >= minSample)) {
      insufficient.push(Object.assign(base, {
        rank: null,
        confidence: 'insufficient',
        // Counts only. No rate is computed for an ungated segment — not even a "use with caution"
        // one — because a percentage in a tool result WILL be quoted back as a finding.
        reply_rate: null, positive_rate: null, score: null,
        needs_n_more: minSample - g.sample_size,
        reason: `below the ${minSample}-send minimum (has ${g.sample_size}); rate not computed`,
      }));
      continue;
    }

    const replyLb = wilsonLowerBound(g.replied, g.sample_size, z);
    const posLb = wilsonLowerBound(g.positive, g.sample_size, z);
    ranked.push(Object.assign(base, {
      rank: null,
      confidence: confidenceLabel(g.sample_size),
      reply_rate: round(g.replied / g.sample_size),
      positive_rate: round(g.positive / g.sample_size),
      reply_rate_lb: round(replyLb),
      positive_rate_lb: round(posLb),
      score: round(metric === 'reply' ? replyLb : posLb),
      score_metric: metric === 'reply' ? 'reply_rate_lb' : 'positive_rate_lb',
    }));
  }

  // Deterministic ordering: score desc, then the bigger sample, then key — so two identical runs
  // never hand the agent a different "top segment".
  ranked.sort((a, b) => (b.score - a.score)
    || (b.sample_size - a.sample_size)
    || (a.segment_key < b.segment_key ? -1 : a.segment_key > b.segment_key ? 1 : 0));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  insufficient.sort((a, b) => (b.sample_size - a.sample_size)
    || (a.segment_key < b.segment_key ? -1 : a.segment_key > b.segment_key ? 1 : 0));

  const totals = ranked.concat(insufficient).reduce((acc, r) => {
    acc.sent += r.sent; acc.sample_size += r.sample_size;
    acc.replied += r.replied; acc.positive += r.positive; return acc;
  }, { segments: groups.size, sent: 0, sample_size: 0, replied: 0, positive: 0 });
  totals.ranked_segments = ranked.length;
  totals.insufficient_segments = insufficient.length;

  return {
    gate: { min_sample: minSample, metric, statistic: 'wilson_lower_bound_95', dimensions: dims },
    ranked,
    insufficient,
    totals,
    caveat: ranked.length === 0
      ? `No segment has reached ${minSample} sends yet. There is no ranking to give — targeting `
        + `should stay broad and even. Do not infer a winner from the counts below.`
      : `Ranked by ${metric === 'reply' ? 'reply' : 'positive-reply'} rate Wilson 95% lower bound. `
        + `${insufficient.length} segment(s) are below the ${minSample}-send minimum and are `
        + `deliberately unranked and unrated. Every rate above is paired with its sample_size — `
        + `quote them together or not at all.`,
  };
}

/**
 * Turn a ranking into targeting weights for the next batch. Sums to 1.
 *
 * `exploreShare` of the budget is reserved for segments that have NOT cleared the gate, spread
 * evenly. That reserve is the only way an under-sampled segment ever accumulates enough sends to
 * be evaluated — a pure exploit policy freezes the pilot's early, noisiest picture in place forever.
 * With nothing ranked yet, weight is uniform across everything: the honest position at n<50 is
 * "we don't know", and the correct action is to keep sampling evenly.
 */
function targetingWeights(ranking, opts) {
  const o = opts || {};
  const explore = typeof o.exploreShare === 'number'
    ? Math.min(Math.max(o.exploreShare, 0), 1) : DEFAULT_EXPLORE_SHARE;
  const ranked = ranking.ranked || [];
  const insufficient = ranking.insufficient || [];
  const out = [];

  if (ranked.length === 0) {
    const all = insufficient;
    const w = all.length ? 1 / all.length : 0;
    for (const s of all) {
      out.push({ segment_key: s.segment_key, weight: round(w, 6), sample_size: s.sample_size, basis: 'uniform_no_evidence' });
    }
    return out;
  }

  const exploitShare = insufficient.length ? 1 - explore : 1;
  const totalScore = ranked.reduce((a, r) => a + (r.score || 0), 0);
  for (const r of ranked) {
    const share = totalScore > 0 ? (r.score || 0) / totalScore : 1 / ranked.length;
    out.push({
      segment_key: r.segment_key, weight: round(exploitShare * share, 6),
      sample_size: r.sample_size, basis: totalScore > 0 ? 'wilson_lb_proportional' : 'uniform_zero_scores',
    });
  }
  if (insufficient.length) {
    const w = explore / insufficient.length;
    for (const s of insufficient) {
      out.push({ segment_key: s.segment_key, weight: round(w, 6), sample_size: s.sample_size, basis: 'exploration_reserve' });
    }
  }
  return out;
}

/** One-screen text summary safe to hand an LLM: no rate ever appears without its denominator. */
function summarize(ranking) {
  const lines = [];
  lines.push(`gate: >= ${ranking.gate.min_sample} sends | metric: ${ranking.gate.metric} | stat: ${ranking.gate.statistic}`);
  lines.push(ranking.caveat);
  for (const r of ranking.ranked) {
    lines.push(`#${r.rank} ${r.segment_key} — ${r.positive} positive / ${r.replied} replied / `
      + `${r.sample_size} matured sends (${r.sent} sent). reply ${(r.reply_rate * 100).toFixed(1)}% `
      + `(lb ${(r.reply_rate_lb * 100).toFixed(1)}%), positive ${(r.positive_rate * 100).toFixed(1)}% `
      + `(lb ${(r.positive_rate_lb * 100).toFixed(1)}%), confidence ${r.confidence}`);
  }
  for (const s of ranking.insufficient) {
    lines.push(`—  ${s.segment_key} — UNRANKED: ${s.replied} replied / ${s.sample_size} matured `
      + `sends. No rate computed; needs ${s.needs_n_more} more.`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// How much data before any of this means anything
// ---------------------------------------------------------------------------
//
// MIN_SAMPLE = 50 is a FLOOR, not a threshold of trust. At a 5% reply rate, 50 sends buys about
// 2.5 expected replies and a Wilson 95% interval roughly [1%, 17%] — enough to notice a segment
// that produces literally nothing, not enough to choose between two live ones.
//
// To actually separate a 4% segment from an 8% segment at 80% power / 5% alpha needs about
// 550 matured sends PER SEGMENT. So:
//   - rolled up to role_bucket alone (say 4 live buckets): ~2,200 sends before the ranking is
//     decision-grade. First weak signals around 200-400 total.
//   - the full four-way key (~2 configs x 4 roles x 3-4 industries x 3-4 bands = 70-130 live
//     segments in practice): 30,000+ sends. That is not a pilot-scale number.
// Practical consequence, and the reason `dimensions` exists: start every query rolled up to
// ['source_config','role_bucket'], add a dimension only when its groups clear the gate on their
// own. The full key is what gets STORED (you cannot recover a dimension you never wrote down);
// it is not what gets QUERIED early.
//
// CARDINALITY: seniority is computed by titleSeniority() but deliberately kept OUT of segment_key.
// Adding it multiplies segment count by ~5 and pushes the decision-grade volume above 100k sends.

const API = {
  MIN_SAMPLE, Z_95, DIMENSIONS, ROLE_BUCKETS, INDUSTRY_BUCKETS, SIZE_BANDS,
  canonicalText, normalizeTitle, titleSeniority, normalizeIndustry, normalizeHeadcount,
  normalizeConfig, buildSegmentKey, parseSegmentKey,
  wilsonLowerBound, confidenceLabel, num, cleanRow,
  rankSegments, targetingWeights, summarize,
};

// n8n Code nodes have no `module`; the guard makes this file paste-able there unchanged.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
