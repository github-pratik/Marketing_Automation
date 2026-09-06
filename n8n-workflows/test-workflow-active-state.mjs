// Guards the "20 of 21 backups were landmines" drift found live 2026-09-05.
//
// `n8n import:workflow` deactivates whatever it imports and IGNORES the JSON's own
// "active" key (see README.md, "import:workflow DEACTIVATES the workflow it
// imports"). That makes a checked-in VIO-*.json's active key pure bookkeeping as
// far as the importer is concerned — but it is exactly the field import-workflow.sh
// now reads to decide whether to restore activation after an import, and the only
// place a human reading the file offline can tell "should be on" from "should be
// off" without an SSH round trip. A backup whose active key doesn't match the
// live intent is a landmine: the next import of it silently ships the wrong state.
//
// This test needs no SSH. It asserts every VIO-*.json's active key against the
// intended live state, captured here from a real database read on 2026-09-05:
//   ssh root@104.248.119.152 "docker exec n8n-stack-postgres-1 psql -U postgres \
//     -d railway -tAc \"select id, name, active from workflow_entity \
//     where name like 'VIO-%' order by name\""
// Update INTENDED_ACTIVE only after confirming a real, deliberate change to what
// should be running live — never just to make this test pass.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// name (no .json) -> intended live `active` state.
const INTENDED_ACTIVE = {
  'VIO-agent-tool-ask-human': true,
  'VIO-agent-tool-push-instantly': true,
  'VIO-agent-tool-reveal-contacts': true,
  'VIO-apollo-reveal': true,
  'VIO-costs-rollup': false, // the one deliberate exception — not yet activated
  'VIO-db-probe': true,
  'VIO-enrol-email': true,
  'VIO-error-alert': true,
  'VIO-inbound-reply-to-call': true,
  'VIO-inbox-mapper': false, // Sheet Inbox door — console add is the front door now
  'VIO-instantly-events': true,
  'VIO-intake-verify-curate': true,
  'VIO-operator-agent': true,
  'VIO-operator-agent-v2': true,
  'VIO-run-campaign': true,
  'VIO-run-outreach': true,
  'VIO-sendr-events': true,
  'VIO-sendr-generate-page': true,
  'VIO-sheet-audit': false,
  'VIO-sheet-provision': false,
  'VIO-sheet-repair': false,
  'VIO-source-leads': true,
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const files = readdirSync(HERE).filter((f) => /^VIO-.*\.json$/.test(f));
const stems = files.map((f) => f.replace(/\.json$/, ''));
const stemSet = new Set(stems);

// The map itself must track the folder exactly, in both directions — otherwise a
// new workflow (or a deleted one) goes unnoticed rather than failing loudly.
for (const name of Object.keys(INTENDED_ACTIVE))
  ok(`${name}.json exists in n8n-workflows/`, stemSet.has(name),
     'INTENDED_ACTIVE names a file that is not in the folder — update the map');
for (const stem of stemSet)
  ok(`${stem}.json has an INTENDED_ACTIVE entry`, Object.hasOwn(INTENDED_ACTIVE, stem),
     'a new VIO-*.json was added without recording its intended live active state');

for (const file of files) {
  const stem = file.replace(/\.json$/, '');
  if (!Object.hasOwn(INTENDED_ACTIVE, stem)) continue; // already flagged above
  const intended = INTENDED_ACTIVE[stem];
  const wf = JSON.parse(readFileSync(join(HERE, file), 'utf8'));

  ok(`${file} declares a top-level "active" key`, Object.hasOwn(wf, 'active'),
     'a missing key reads as "nobody has recorded the intended state" — ' +
     'import:workflow itself ignores it either way and always imports deactivated');
  ok(`${file}: active === ${intended} (matches live)`, wf.active === intended,
     `file has ${JSON.stringify(wf.active)}, live database has ${intended}`);
  ok(`${file}: "id" is present`, typeof wf.id === 'string' && wf.id.length > 0,
     'import-workflow.sh needs the id to look up the live active flag before importing');
}

console.log(`\n[workflow-active-state] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
