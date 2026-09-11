// Reoon classify + batch grouping for held console loads.
// Mapping is copied from VIO-intake-verify-curate Classify and reach-engine
// reoon_verify(). Do not "improve" it: auto-dropping disposable loses good
// corporate addresses Reoon false-flags.

export function classifyReoon(status) {
  const reoon_status = String(status || 'unknown').toLowerCase();
  if (['safe', 'valid'].includes(reoon_status)) {
    return { action: 'pass', reason: 'deliverable, safe to send', reoon_status };
  }
  if (['invalid', 'spamtrap'].includes(reoon_status)) {
    return { action: 'drop', reason: `hard fail: ${reoon_status}`, reoon_status };
  }
  if (reoon_status === 'disposable') {
    return {
      action: 'needs_review',
      reason: 'flagged disposable - confirm real throwaway vs greylisted corporate (known Reoon false-negative)',
      reoon_status,
    };
  }
  return {
    action: 'needs_review',
    reason: `ambiguous (${reoon_status}) - human judges`,
    reoon_status,
  };
}

// Same lifecycle the intake Shape Lead Row writes after a Reoon verdict.
export function stateForAction(action) {
  if (action === 'drop') {
    return { channel_state_email: 'dropped', verify_action: 'drop' };
  }
  if (action === 'needs_review') {
    return { channel_state_email: 'needs_review', verify_action: 'needs_review' };
  }
  return { channel_state_email: 'not_sent', verify_action: 'pass' };
}

export const isHeldForPerson = (l) =>
  (l.verify_action === 'needs_review' || l.channel_state_email === 'pending_approval')
  && l.channel_state_email !== 'dropped';

export const isUnverifiedHeld = (l) =>
  isHeldForPerson(l) && (l.verify_action === 'unverified' || !l.verify_action);

export const isDeletableFromLoad = (l) =>
  ['pending_approval', 'needs_review', 'not_sent', 'approved'].includes(l.channel_state_email);

export function groupHeldLeads(leads) {
  const groups = new Map();
  for (const l of leads || []) {
    const batchId = String(l.batch_id || '').trim();
    const key = batchId || `one:${l.id}`;
    if (!groups.has(key)) {
      const label = String(l.batch_label || '').trim()
        || (batchId ? `Load ${batchId.slice(0, 8)}` : 'Single add');
      groups.set(key, {
        key,
        batch_id: batchId,
        label,
        source: l.source || '',
        leads: [],
      });
    }
    groups.get(key).leads.push(l);
  }
  return [...groups.values()].sort((a, b) => b.leads.length - a.leads.length);
}
