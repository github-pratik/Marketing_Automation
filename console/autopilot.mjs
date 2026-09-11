// How the You-steps run. Pure so the suite can prove the spend cap and the
// "do not re-reveal people we already hold" rule without calling Apollo.

export const MODES = ['manual', 'hybrid', 'autopilot'];

export const MODE_META = {
  manual: {
    label: 'You decide',
    blurb: 'You search, pick, reveal, and verify. Nothing spends a credit until you click.',
  },
  hybrid: {
    label: 'Hybrid',
    blurb: 'A CSV verifies itself with Reoon. You still pick who to reveal. Catch-alls still wait.',
  },
  autopilot: {
    label: 'Autopilot',
    blurb: 'Saved Find filters search and reveal on their own, up to the daily cap. Catch-alls still wait.',
  },
};

export const DEFAULT_SETTINGS = {
  mode: 'manual',
  daily_reveal_cap: 25,
  find: {},
  last_run_at: null,
  last_result: '',
};

export function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return MODES.includes(mode) ? mode : null;
}

export function filtersAreSaved(find) {
  const product = String(find?.product || '').trim().toLowerCase();
  return product === 'oryoniq' || product === 'visioneerit';
}

export function canEnableAutopilot(settings) {
  if (!filtersAreSaved(settings?.find)) {
    return {
      ok: false,
      error: 'Search Apollo once, then click “Use these filters on Autopilot” before turning Autopilot on.',
    };
  }
  return { ok: true };
}

export function autoVerifiesUploads(mode) {
  return mode === 'hybrid' || mode === 'autopilot';
}

export function autoFindsPeople(mode) {
  return mode === 'autopilot';
}

export function revealSpendFromEvents(events, startIso) {
  let n = 0;
  for (const e of events || []) {
    if (e.action !== 'reveal_requested') continue;
    if (startIso && String(e.at || '') < startIso) continue;
    const ids = e.payload && Array.isArray(e.payload.ids) ? e.payload.ids : [];
    n += ids.length;
  }
  return n;
}

export function pickRevealIds(people, { heldIds, remaining, cap = 25 } = {}) {
  const held = heldIds instanceof Set ? heldIds : new Set(heldIds || []);
  const room = Math.max(0, Math.min(Number(remaining) || 0, Number(cap) || 0, 25));
  const out = [];
  for (const p of people || []) {
    if (out.length >= room) break;
    const id = String(p?.apollo_id || '').trim();
    if (!id || held.has(id)) continue;
    out.push(id);
  }
  return out;
}
