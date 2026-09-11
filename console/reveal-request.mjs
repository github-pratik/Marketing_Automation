// Cheap shape check for POST /api/reveal.
//
// The authority is VIO-apollo-reveal's Guard node. This exists so a mis-click
// gets a useful error from the console instead of waiting on n8n to refuse.
// Keep the regex, the cap, and the "ids not filters" rule identical to that
// node — test-reveal-request.mjs asserts the two have not drifted.

export const REVEAL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const REVEAL_MAX_IDS = 25;
export const REVEAL_PRODUCTS = new Set(['oryoniq', 'visioneerit']);

export function shapeRevealRequest(body) {
  const product = String(body?.product || '').trim().toLowerCase();
  if (typeof body?.product !== 'string' || !REVEAL_PRODUCTS.has(product)) {
    return { ok: false, error: 'Pick a product. The system will not guess who is pitching.' };
  }
  if (!Array.isArray(body?.ids)) {
    return {
      ok: false,
      error: 'Name the people to reveal as an explicit list of Apollo ids. This endpoint will not take a search filter.',
    };
  }

  const ids = [];
  const seen = new Set();
  for (const v of body.ids) {
    const id = String(v == null ? '' : v).trim();
    if (!REVEAL_ID_RE.test(id)) {
      return {
        ok: false,
        error: `'${id}' is not a plausible Apollo person id. Pick people from a search — do not type ids by hand.`,
      };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    return { ok: false, error: 'No ids to reveal. An empty pull is a mistake, not a no-op.' };
  }
  if (ids.length > REVEAL_MAX_IDS) {
    return { ok: false, error: `${ids.length} ids in one pull; the cap is ${REVEAL_MAX_IDS}.` };
  }
  return { ok: true, product, ids };
}
