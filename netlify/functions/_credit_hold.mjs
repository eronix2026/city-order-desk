// netlify/functions/_credit_hold.mjs  (shared — underscore = not a route)
// Single implementation of "release a credit hold" used by BOTH the manual accounts action
// (orders.mjs → releaseHold) and the automatic settlement sweep (credit-release.mjs). Does NOT
// bump `rev` — the orders.mjs handler bumps it at save; the sweep bumps it itself.
export function applyRelease(o, { by, reason, at = Date.now() }) {
  o.creditHold = undefined;
  o.holdClearedAt = at;
  o.creditHoldReleasedBy = by;
  o.creditHoldReleaseReason = String(reason || '').slice(0, 280);
  if (o.status === 'HELD') o.status = 'ACCOUNTS_REVIEW'; // back into the review queue
  o.history = o.history || [];
  o.history.push({ stage: 'Credit hold released — ' + (o.creditHoldReleaseReason || by), by, at });
  o.updatedAt = at;
  return o;
}
