// The one true rule about `parameters.columns.schema` on a Google Sheets node.
//
// Four test suites used to assert "every Sheets WRITE declares a schema". That
// invariant was written from a guess and it was BACKWARDS: on `appendOrUpdate` a
// declared schema is exactly what takes the workflow down. It cost three days of
// the OryonIQ send path, and it was reasserted by the tests every time, which is
// why the rule now lives in one file instead of four copies.
//
// THE MECHANISM (read out of the deployed n8n 2.22.6 image, not inferred):
//
//   GoogleSheets.utils.js:283  checkForSchemaChanges compares the cached schema
//   to the live header row POSITIONALLY, by index, never by name:
//
//       for (const [columnIndex, columnName] of columnNames.entries()) {
//           const schemaEntry = schemaColumns[columnIndex];
//           if (schemaEntry === undefined) break;      // empty cache exits here
//           if (columnName !== schemaEntry) { ...throw... }
//       }
//
//   and only two operations call it, inconsistently:
//
//       append.operation.js:211          nodeVersion >= 4.4 && dataMode !== 'autoMapInputData'
//       appendOrUpdate.operation.js:272  nodeVersion >= 4.4                    <- no dataMode guard
//       update.operation.js              never calls it
//
// So `appendOrUpdate` runs the check even in autoMapInputData mode, where the
// schema is used for nothing else: the row is built from the input item's keys
// (appendOrUpdate.operation.js:309) and the match column is resolved against the
// LIVE header (appendOrUpdate.operation.js:281). The cache only feeds the editor
// dropdown — it cannot help at runtime, and it can break the node forever the
// moment a column is inserted anywhere before the end of the tab.
//
// Hence: an auto-mapping appendOrUpdate node must carry NO cached schema. Empty is
// not a workaround; it is the only state that cannot fail.
//
// `defineBelow` is the opposite — there the schema names the values being written,
// so it must be present, and it must stay a positional prefix of the live header.

export function schemaViolations(wf) {
  const bad = [];
  for (const n of wf.nodes || []) {
    if (n.type !== 'n8n-nodes-base.googleSheets') continue;
    const p = n.parameters || {};
    const op = p.operation || 'read';
    const cols = p.columns || {};
    const declared = (cols.schema || []).length;

    if (op === 'appendOrUpdate' && cols.mappingMode === 'autoMapInputData' && declared > 0) {
      bad.push(`${n.name}: appendOrUpdate+autoMapInputData must cache NO schema, `
             + `found ${declared} columns — this throws "Column names were updated `
             + `after the node's setup" as soon as the tab's columns shift`);
    }
    if (cols.mappingMode === 'defineBelow' && declared === 0) {
      bad.push(`${n.name}: defineBelow needs its schema — it names the values written`);
    }
  }
  return bad;
}

// Every Sheets node must still pin its credential by id and stay on 4.7. Kept here
// so the four suites cannot drift on these either.
export function credentialViolations(wf, credId = 'VIOgsheetcred01') {
  const bad = [];
  for (const n of wf.nodes || []) {
    if (n.type !== 'n8n-nodes-base.googleSheets') continue;
    if (n.credentials?.googleApi?.id !== credId) bad.push(`${n.name}: credential not pinned to ${credId}`);
    if (n.typeVersion !== 4.7) bad.push(`${n.name}: typeVersion ${n.typeVersion}, expected 4.7`);
  }
  return bad;
}
