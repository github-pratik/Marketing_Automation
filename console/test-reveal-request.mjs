// Offline proof of the console's cheap reveal gate.
//
// The expensive gate lives in VIO-apollo-reveal. This file proves two things:
//   1. The console refuses the same bad shapes before it ever calls n8n.
//   2. The regex and cap here have not drifted from the workflow Guard node.
import { readFileSync } from 'node:fs';
import { shapeRevealRequest, REVEAL_ID_RE, REVEAL_MAX_IDS } from './reveal-request.mjs';

const wf = JSON.parse(readFileSync(new URL('../n8n-workflows/VIO-apollo-reveal.json', import.meta.url)));
const guard = wf.nodes.find((n) => n.name === 'Guard (cap + shape)');
if (!guard) throw new Error('VIO-apollo-reveal has no Guard (cap + shape) node');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

ok('the workflow still shape-checks with the same id regex',
   /ID_RE = \/\^\[A-Za-z0-9_-\]\{8,64\}\$\//.test(guard.parameters.jsCode));
ok('  and the console uses that same regex',
   String(REVEAL_ID_RE) === String(/^[A-Za-z0-9_-]{8,64}$/));
ok('the workflow cap is still 25', /MAX_IDS = 25/.test(guard.parameters.jsCode));
ok('  and the console cap matches', REVEAL_MAX_IDS === 25);

const refuses = (name, body, re) => {
  const r = shapeRevealRequest(body);
  ok(name, r.ok === false && re.test(r.error), r.error);
};
const accepts = (name, body, pred) => {
  const r = shapeRevealRequest(body);
  ok(name, r.ok === true && pred(r), JSON.stringify(r));
};

refuses('an unknown product is refused', { product: 'acme', ids: ['abcdefgh'] }, /product/);
refuses('an array product is refused, not coerced', { product: ['oryoniq'], ids: ['abcdefgh'] }, /product/);
refuses('filters instead of ids are refused', { product: 'oryoniq', person_titles: ['CIO'] }, /search filter/);
refuses('an empty pull is refused', { product: 'oryoniq', ids: [] }, /empty pull/);
refuses('26 ids is refused', {
  product: 'oryoniq',
  ids: Array.from({ length: 26 }, (_, i) => 'id00000' + i),
}, /cap is 25/);
refuses('a hand-typed email is refused', { product: 'oryoniq', ids: ['dana@cardinalfederal.com'] }, /not a plausible/);
refuses('a short id is refused', { product: 'oryoniq', ids: ['abc'] }, /not a plausible/);

accepts('a real-looking id is accepted', { product: 'OryonIQ', ids: ['63ac5a9458b4c70001bd377c'] },
  (r) => r.product === 'oryoniq' && r.ids.length === 1);
accepts('duplicate ids collapse rather than refuse',
  { product: 'visioneerit', ids: ['aaaaaaaa11', 'aaaaaaaa11', 'bbbbbbbb22'] },
  (r) => r.ids.length === 2 && r.ids[0] === 'aaaaaaaa11');
accepts('25 ids is allowed', {
  product: 'oryoniq',
  ids: Array.from({ length: 25 }, (_, i) => 'id00000' + String(i).padStart(2, '0')),
}, (r) => r.ids.length === 25);

const server = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
ok('the console calls VIO-apollo-reveal, not Apollo itself',
   /vio-apollo-reveal/.test(server) && /This does NOT call Apollo/.test(server));
ok('the staff click is recorded before the spend',
   server.indexOf('reveal_requested') < server.indexOf('vio-apollo-reveal')
   && /Fail closed/.test(server));

console.log(`\n[reveal-request] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
