// Offline proof of VIO-instantly-events. Reads jsCode straight out of the workflow JSON.
//
// The risk here is specific: this endpoint can mark a prospect bounced or unsubscribed, which
// suppresses them permanently. A wrong classification or a guessed email address is not a
// cosmetic error — it silently removes someone from every future campaign.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-instantly-events.json', import.meta.url)));
const jsOf = (name) => {
  const n = wf.nodes.find(x => x.name === name);
  if (!n) throw new Error(`no node "${name}"`);
  if (n.type !== 'n8n-nodes-base.code') throw new Error(`"${name}" is ${n.type}, not a Code node`);
  return n.parameters.jsCode;
};
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) pass++; else { console.error(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail++; } };

const classCode = jsOf('Classify Event');
const classify = (b) => new Function('$input', classCode)({ first: () => ({ json: b }) })[0].json;
const throws = (b) => { try { classify(b); return null; } catch (e) { return e.message; } };

const ev = (t, over = {}) => ({ event_type: t, lead_email: 'a@b.com', campaign_id: 'C', ...over });

// --- the vocabulary contract. Every stage written must exist in the live sheet's dropdown. ---
const SHEET_VOCAB = new Set(['needs_review','pending_approval','approved','enrolled','replied',
  'positive','booked','rejected','dropped','unsubscribed','bounced']);

for (const [type, action, stage, suppress] of [
  ['email_sent',        'send',         null,           null],
  ['email_delivered',   'send',         null,           null],
  ['email_bounced',     'bounced',      'bounced',      'bounced'],
  ['hard_bounce',       'bounced',      'bounced',      'bounced'],
  ['lead_unsubscribed', 'unsubscribed', 'unsubscribed', 'opt_out'],
  ['opt_out',           'unsubscribed', 'unsubscribed', 'opt_out'],
  ['email_opened',      'open',         null,           null],
  ['link_clicked',      'click',        null,           null],
  ['reply_received',    'reply_seen',   null,           null],
]) {
  const r = classify(ev(type));
  ok(`${type} -> action ${action}`, r.action === action, `got ${r.action}`);
  ok(`${type} -> stage ${stage}`, r.stage === stage, `got ${r.stage}`);
  ok(`${type} -> suppress ${suppress}`, r.suppress === suppress, `got ${r.suppress}`);
  if (r.stage) ok(`${type} stage is in the sheet dropdown`, SHEET_VOCAB.has(r.stage), r.stage);
}

// A SEND must not touch the ladder. There is no 'sent' in the live vocabulary, and a row that
// jumps to a made-up stage is worse than one that stays 'enrolled'.
ok('a send never changes the stage', classify(ev('email_sent')).stage === null);
ok('an open never changes the stage', classify(ev('email_opened')).stage === null);
ok('a click never changes the stage', classify(ev('link_clicked')).stage === null);

// Replies belong to VIO-inbound-reply-to-call, which runs an OpenAI sentiment pass. Two workflows
// writing reply state would race and the loser would overwrite a classified sentiment.
ok('a reply is recorded but does NOT set the stage here',
   classify(ev('reply_received')).stage === null);

// --- the email address gates everything. Guessing which row to suppress is unacceptable. ---
for (const [label, over] of [
  ['no email at all', { lead_email: undefined }],
  ['empty email', { lead_email: '' }],
  ['malformed email', { lead_email: 'not-an-address' }],
  ['comma-bearing email', { lead_email: 'a@b.com,c@d.com' }],
  ['bracketed email', { lead_email: '<a@b.com>' }],
  ['non-string email', { lead_email: 42 }],
]) {
  const msg = throws(ev('email_bounced', over));
  ok(`REFUSES to suppress on ${label}`, msg !== null && /REFUSED/.test(msg), msg || 'did not throw');
}
ok('email is lowercased', classify(ev('email_sent', { lead_email: 'A@B.COM' })).email === 'a@b.com');
ok('alternative field names are accepted',
   classify({ event: 'email_sent', email: 'x@y.com' }).email === 'x@y.com');
ok('an unknown event type is recorded, not dropped',
   /^other:/.test(classify(ev('some_new_thing')).action));
ok('a missing timestamp falls back to now', typeof classify(ev('email_sent', { timestamp: undefined })).when === 'string');

// --- row building ---
const rowsCode = jsOf('Build Rows');
const rows = (e) => new Function('$input', rowsCode)({ first: () => ({ json: e }) }).map(i => i.json);

const sendRows = rows(classify(ev('email_sent')));
ok('a send writes exactly one Events row', sendRows.length === 1 && sendRows[0]._kind === 'event');
ok('a send writes no Leads row', !sendRows.some(r => r._kind === 'lead'));
ok('a send writes no Suppression row', !sendRows.some(r => r._kind === 'suppress'));

const bounceRows = rows(classify(ev('email_bounced')));
ok('a bounce writes all three rows', bounceRows.length === 3);
ok('a bounce suppresses by email',
   bounceRows.some(r => r._kind === 'suppress' && r.identifier_type === 'email' && r.reason === 'bounced'));
ok('a bounce sets the stage to bounced',
   bounceRows.some(r => r._kind === 'lead' && r.channel_state_email === 'bounced'));

const unsubRows = rows(classify(ev('lead_unsubscribed')));
ok('an unsubscribe suppresses as opt_out',
   unsubRows.some(r => r._kind === 'suppress' && r.reason === 'opt_out'));

ok('every Events row leaves est_cost_usd blank (measure, do not estimate)',
   rows(classify(ev('email_sent')))[0].est_cost_usd === '');

// --- structure ---
ok('workflow id stable', wf.id === 'VIOwfGinstevents');
ok('webhook has an explicit webhookId',
   Boolean(wf.nodes.find(n => n.type === 'n8n-nodes-base.webhook')?.webhookId));
ok('auth is fail-closed',
   /REFUSED/.test(jsOf('Authenticate (fail-closed)')) && /VIO_WEBHOOK_TOKEN/.test(jsOf('Authenticate (fail-closed)')));

ok('no Google Sheets nodes remain',
   wf.nodes.every(n => n.type !== 'n8n-nodes-base.googleSheets'));
const pgNodes = wf.nodes.filter(n => n.type === 'n8n-nodes-base.postgres');
ok('three Postgres writers', pgNodes.length === 3, String(pgNodes.length));
ok('every Postgres node pins VIO Supabase by id',
   pgNodes.every(n => n.credentials?.postgres?.id === 'VIOsupabasepg1'));
ok('suppression insert happens in SQL',
   /insert into suppression/i.test(pgNodes.find(n => n.name.includes('Suppression'))?.parameters.query || ''));
ok('lead update is an UPDATE, never an upsert',
   /update leads/i.test(pgNodes.find(n => n.name.includes('Lead Stage'))?.parameters.query || '')
   && !/insert into leads/i.test(pgNodes.find(n => n.name.includes('Lead Stage'))?.parameters.query || ''));
ok('events land in the ledger',
   /insert into events/i.test(pgNodes.find(n => n.name.includes('Event'))?.parameters.query || ''));
ok('suppression is wired before the lead stage write',
   (wf.connections['Append Suppression']?.main || []).flat().some(c => c.node === 'Update Lead Stage (Leads)'));
ok('no A1 range anywhere', !/"[A-Z]{1,2}[0-9]{1,4}:[A-Z]{1,2}/.test(JSON.stringify(wf)));

const names = new Set(wf.nodes.map(n => n.name));
for (const [src, v] of Object.entries(wf.connections))
  for (const g of v.main) for (const c of g)
    ok(`connection ${src} -> ${c.node} resolves`, names.has(c.node));

console.log(`\n[instantly-events] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
