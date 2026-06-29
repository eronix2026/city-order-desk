// netlify/functions/_dealer_view.mjs  (shared — underscore = not a route)
// Dealer-safe projection of an internal order for the Dealer OS portal timeline.
//
// The desk is the system of record for the order lifecycle. This module exposes ONLY
// what a dealer is entitled to see — the lifecycle of their own order, from BOTH
// origins (Unolo field app and Dealer OS self-orders) — including HOLD, REJECTION
// and APPROVAL, each with its reason and timestamp.
//
// It strips everything internal: serial numbers, the credit/ledger position, staff
// identities, Zoho ids, blob keys and POD bytes.

const DEALER_STATUS = {
  NEW: 'Under review', ACCOUNTS_REVIEW: 'Under review', HELD: 'On hold', REJECTED: 'Not approved',
  CREDIT_OK: 'Approved · being prepared', PICKING: 'Approved · being prepared',
  SERIALIZED: 'Packed · invoicing', INVOICED: 'Invoiced · preparing dispatch',
  DISPATCHED: 'In transit', DELIVERED: 'Delivered',
};

export function dealerStatusLabel(o) {
  if (o.status === 'ACCOUNTS_REVIEW' && o.revokedFrom) return 'Under revision';
  return DEALER_STATUS[o.status] || o.status;
}

// Chronological, dealer-safe event log built from transition stamps + structured
// fields (no internal history-text parsing). Each event: { key, label, at, note }.
export function buildDealerTimeline(o) {
  const s = o.stamps || {};
  const ev = [];
  const add = (key, label, at, note) => { if (at) ev.push({ key, label, at, note: note || null }); };

  add('placed', 'Order placed', s.NEW || o.createdAt,
    o.source === 'dealer' ? 'Self-placed via Dealer OS' : 'Booked by field officer (Unolo)');
  add('held', 'Order on hold', s.HELD, o.holdReason || null);
  add('hold_cleared', 'Credit hold cleared', o.holdClearedAt, o.creditHoldReleaseReason || null);
  add('approved', 'Order approved', s.CREDIT_OK, o.edited ? 'Approved with revisions' : null);
  add('rejected', 'Order not approved', s.REJECTED, o.rejectReason || null);
  (o.revocations || []).forEach(r => add('revised', 'Reopened for revision', r.at, r.reason || null));
  add('packed', 'Packed & verified', s.SERIALIZED, null);
  if (o.eway && o.eway.number) add('eway', 'E-way bill generated', o.eway.generatedAt, o.eway.number);
  add('invoiced', 'Invoice raised', s.INVOICED, o.invoiceNo || null);
  add('dispatched', 'Dispatched', s.DISPATCHED,
    o.provider ? `${o.provider}${o.refId ? ' · ' + o.refId : ''}` : null);
  add('delivered', 'Delivered', s.DELIVERED || o.deliveredAt, null);

  return ev.sort((a, b) => a.at - b.at);
}

export function projectForDealer(o) {
  return {
    id: o.id,
    source: o.source,
    placedVia: o.source === 'dealer' ? 'Dealer OS (self-placed)' : 'Field officer (Unolo)',
    placedAt: o.createdAt,
    status: o.status,
    statusLabel: dealerStatusLabel(o),
    lines: (o.lines || []).map(l => ({ sku: l.sku, name: l.name, qty: l.qty, price: l.price })),
    amount: o.total,
    invoiceNo: o.invoiceNo || null,
    eway: o.eway && o.eway.number ? { number: o.eway.number, validTill: o.eway.validTill || null } : null,
    dispatch: o.dispatchType ? { type: o.dispatchType, provider: o.provider || null, ref: o.refId || null } : null,
    deliveredAt: o.deliveredAt || null,
    podOnFile: !!o.pod,
    holdReason: o.status === 'HELD' ? (o.holdReason || null) : null,
    rejectReason: o.status === 'REJECTED' ? (o.rejectReason || null) : null,
    updatedAt: o.updatedAt || null,
    timeline: buildDealerTimeline(o),
  };
}
