// How we write back when a lead replies. Pure functions so the suite can
// prove the gates (opt-out never sends, OOO never auto-sends, merge tags)
// without booting the console or talking to Instantly.

export const PRODUCTS = ['oryoniq', 'visioneerit'];

export const BOOKING_URLS = {
  oryoniq: 'https://meetings.hubspot.com/gavriel-legynd17/oryoniq-sales?uuid=6326f9ce-c95c-4c5c-b078-80d77911fe1f',
  visioneerit: '',
};

export const DEFAULT_PLAYBOOKS = {
  oryoniq: {
    product: 'oryoniq',
    auto_send_positive: true,
    auto_send_neutral: false,
    auto_send_negative: false,
    template_positive: [
      'Hi {first_name},',
      '',
      'Glad this is useful. Next step is a short call with Gavriel to walk through how OryonIQ would fit.',
      '',
      'Pick a time here:',
      '{booking_url}',
      '',
      'Ellen',
    ].join('\n'),
    template_neutral: [
      'Hi {first_name},',
      '',
      'Happy to help. The shortest path is a short call with Gavriel — he can show you the award and relationship map on your world.',
      '',
      'Pick a time here:',
      '{booking_url}',
      '',
      'Ellen',
    ].join('\n'),
    template_negative: '',
  },
  visioneerit: {
    product: 'visioneerit',
    auto_send_positive: false,
    auto_send_neutral: false,
    auto_send_negative: false,
    template_positive: [
      'Hi {first_name},',
      '',
      'Glad this is useful. Next step is a short call so we can walk through how VisioneerIT would fit.',
      '',
      'Ellen',
    ].join('\n'),
    template_neutral: [
      'Hi {first_name},',
      '',
      'Happy to help. Happy to set up a short call if that is useful.',
      '',
      'Ellen',
    ].join('\n'),
    template_negative: '',
  },
};

// Same phrases the inbound workflow uses. Opt-out is decided from wording,
// never from sentiment — a polite "please take me off your list" is still stop.
export const OPT_OUT_PATTERNS = [
  /\bunsubscrib/,
  /\bopt(?:ing)?[\s-]*out\b/,
  /\bopt\s+(?:me|us)\s+out\b/,
  /\bremove\s+(?:me|us|my|our|this)\b/,
  /\btake\s+(?:me|us)\s+off\b/,
  /\bstop\s+(?:emailing|e-mailing|mailing|contacting|messaging|reaching|sending)/,
  /\bdo\s*n(?:o|')?t\s+(?:email|e-mail|contact|message)\s+(?:me|us)/,
  /\bno\s+longer\s+(?:wish|want)\s+to\s+(?:receive|hear)/,
  /\bdelete\s+(?:my|our)\s+(?:email|e-mail|address|data|details|information|info|contact)/,
];

const OOO_PATTERNS = [
  /\bout\s+of\s+(?:the\s+)?office\b/,
  /\bautomatic(?:ally)?\s+reply\b/,
  /\bauto[- ]?reply\b/,
  /\baway from (?:the )?office\b/,
  /\bon vacation\b/,
  /\bon leave\b/,
  /\bcurrently away\b/,
  /\bi am away\b/,
  /\bi'm away\b/,
];

const TERMINAL_HANDLED = new Set(['booked', 'suppressed', 'parked', 'replied']);

export function stripHtml(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ');
}

function normText(s) {
  return stripHtml(s)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

export function looksLikeOptOut(text) {
  const n = normText(text);
  if (!n) return false;
  return OPT_OUT_PATTERNS.some((rx) => rx.test(n));
}

export function looksLikeOoo(text) {
  const n = normText(text);
  if (!n) return false;
  return OOO_PATTERNS.some((rx) => rx.test(n));
}

export function normalizeSentiment(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s === 'positive' || s === 'neutral' || s === 'negative') return s;
  return 'unknown';
}

export function playbookFor(product, rows = []) {
  const key = PRODUCTS.includes(product) ? product : 'oryoniq';
  const found = rows.find((r) => r && r.product === key);
  const fallback = DEFAULT_PLAYBOOKS[key];
  return {
    ...fallback,
    ...(found || {}),
    product: key,
    auto_send_positive: found ? Boolean(found.auto_send_positive) : fallback.auto_send_positive,
    auto_send_neutral: found ? Boolean(found.auto_send_neutral) : fallback.auto_send_neutral,
    auto_send_negative: found ? Boolean(found.auto_send_negative) : fallback.auto_send_negative,
    template_positive: String(found?.template_positive || '').trim() || fallback.template_positive,
    template_neutral: String(found?.template_neutral || '').trim() || fallback.template_neutral,
    template_negative: found && found.template_negative != null ? String(found.template_negative) : fallback.template_negative,
  };
}

export function pickTemplate(playbook, sentiment) {
  if (sentiment === 'positive') return String(playbook.template_positive || '').trim();
  if (sentiment === 'neutral' || sentiment === 'unknown') return String(playbook.template_neutral || '').trim();
  if (sentiment === 'negative') return String(playbook.template_negative || '').trim();
  return '';
}

export function shouldAutoSend(playbook, sentiment) {
  if (sentiment === 'positive') return Boolean(playbook.auto_send_positive);
  if (sentiment === 'neutral') return Boolean(playbook.auto_send_neutral);
  if (sentiment === 'negative') return Boolean(playbook.auto_send_negative);
  return false;
}

export function renderTemplate(template, vars) {
  const map = {
    first_name: String(vars.first_name || '').trim() || 'there',
    last_name: String(vars.last_name || '').trim(),
    company: String(vars.company || '').trim() || 'your team',
    title: String(vars.title || '').trim(),
    product: String(vars.product || '').trim(),
    booking_url: String(vars.booking_url || '').trim(),
    their_reply: String(vars.their_reply || '').trim().slice(0, 400),
  };
  return String(template || '').replace(/\{([a-z_]+)\}/gi, (_, key) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : `{${key}}`;
  }).trim();
}

export function bookingUrlFor(product) {
  return BOOKING_URLS[product] || BOOKING_URLS.oryoniq;
}

// Decide what to do with one inbound reply. Never throws. Never sends on
// opt-out, bounce wording, or a terminal staff outcome.
export function decideFollowup({ reply, lead, playbook } = {}) {
  if (!reply || !reply.id) return { action: 'skip', reason: 'no_reply' };
  if (reply.followup_sent_at) return { action: 'skip', reason: 'already_sent' };
  if (TERMINAL_HANDLED.has(String(reply.handled_as || ''))) {
    return { action: 'skip', reason: 'already_handled' };
  }
  if (!reply.lead_email) return { action: 'skip', reason: 'no_email' };

  const inbound = `${reply.subject || ''} ${reply.body || ''}`;
  if (looksLikeOptOut(inbound)) return { action: 'skip', reason: 'opt_out' };

  const product = PRODUCTS.includes(lead?.product) ? lead.product : (playbook?.product || 'oryoniq');
  const book = playbook || playbookFor(product);
  const sentiment = normalizeSentiment(reply.sentiment);
  const ooo = reply.out_of_office === true || looksLikeOoo(inbound);
  const template = pickTemplate(book, ooo ? 'neutral' : sentiment);
  const text = renderTemplate(template, {
    first_name: lead?.first_name,
    last_name: lead?.last_name,
    company: lead?.company,
    title: lead?.title,
    product,
    booking_url: bookingUrlFor(product),
    their_reply: stripHtml(reply.body || ''),
  });
  if (!text) return { action: 'skip', reason: 'empty_template', sentiment, product };

  const auto = !ooo && shouldAutoSend(book, sentiment);
  return {
    action: auto ? 'send' : 'draft',
    reason: ooo ? 'out_of_office' : (auto ? 'auto' : 'draft_only'),
    text,
    sentiment,
    product,
  };
}
