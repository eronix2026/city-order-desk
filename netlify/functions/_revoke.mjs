// netlify/functions/_revoke.mjs  (shared — underscore = not a route)
// Single source of truth for the *state mutation* of a revoke, so the live action
// (orders.mjs) and the crash-recovery job (reconcile.mjs) can never drift apart.
// The async side-effects (Zoho void, releaseUnits, invalidatePool) stay with the
// caller; this function only mutates the order record.

export function finalizeRevoke(o, { from, reason = '', by, at = Date.now(), voided = null }) {
  o.lines.forEach(l => { l.serials = []; });
  const wasInvoice = voided || o.invoiceNo || null;
  delete o.invoiceNo; delete o.zohoInvoiceId; delete o.invoiceState; delete o.invoiceStartedAt; delete o.reconcilePending;
  o.revokedFrom = from;
  o.revokedAt = at; o.revokeReason = reason; o.revokeCount = (o.revokeCount || 0) + 1;
  o.revocations = o.revocations || []; o.revocations.push({ from, by, at, reason });
  if (o.stamps) for (const k of ['CREDIT_OK', 'PICKING', 'SERIALIZED', 'INVOICED', 'DISPATCHED', 'DELIVERED']) delete o.stamps[k];
  o.stamps = o.stamps || {}; o.stamps.REVOKED = at;
  o.status = 'ACCOUNTS_REVIEW';
  o.history = o.history || [];
  o.history.push({ stage: `Revoked from ${from}${wasInvoice ? ` — invoice ${wasInvoice} voided` : ''}${reason ? ` (${reason})` : ''} — reopened for review`, by, at });
  delete o.revokePending;
  return o;
}
