// netlify/functions/_ingest.mjs  (shared — underscore = not a route)
// One normalizer for every order origin. source: 'unolo' (field officer via the
// Unolo app) | 'dealer' (dealer self-order via Dealer OS). Whatever the origin,
// orders look identical downstream — only `source` / `placedBy` differ.

import { getStore } from '@netlify/blobs';
import { routeCity, sanitizeLines } from './_route.mjs';

export function buildOrder({ source = 'unolo', id, unoloId, exec = '', repEmail = '', dealer = {}, rawLines = [], hold = false, holdReason = '' }) {
  const lines = sanitizeLines(rawLines);
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const gst = Math.round(subtotal * 0.18);
  // Dealer self-orders have no field officer → route by the dealer's pincode/city.
  const { city, routed } = routeCity({ exec: source === 'dealer' ? '' : exec, pincode: dealer.pincode, city: dealer.city });
  const now = Date.now();
  const placedBy = source === 'dealer' ? `${dealer.name || 'Dealer'} · Dealer OS` : (exec || '—');
  return {
    id, unoloId: unoloId || id, source, city,
    exec: source === 'dealer' ? '' : exec,
    repEmail,
    dealer,
    lines, subtotal, gst, total: subtotal + gst,
    status: hold ? 'HELD' : 'NEW', createdAt: now, updatedAt: now,
    stamps: hold ? { NEW: now, HELD: now } : { NEW: now },
    needsRouting: routed ? undefined : true,
    // Credit hold flagged upstream by Dealer OS (dealer past credit period + grace). The desk-side
    // interlock blocks approval/invoicing until accounts releases it (audited). Pairs with the ledger gate.
    creditHold: hold ? true : undefined,
    holdReason: hold ? (holdReason || 'Credit hold — dues past credit period + grace') : undefined,
    placedBy,
    history: [
      {
        stage: source === 'dealer' ? 'Placed by dealer via Dealer OS' : 'Booked in Unolo',
        by: source === 'dealer' ? (dealer.name || 'Dealer') : exec,
        at: now,
      },
      ...(hold ? [{ stage: 'On credit hold' + (holdReason ? ' — ' + holdReason : ''), by: 'Dealer OS', at: now }] : []),
    ],
    picked: [], invoiceNo: null, courier: null, awb: null,
  };
}

// Enrich with the dealer's ledger position from the shared Zoho financials map.
// Clearance is now based on 100% settlement of pending invoices, so the open-invoice
// ledger is the authoritative signal (credit limit retained only for reference).
export async function attachCredit(order) {
  try {
    const rec = await getStore('financials').get(`outstanding/${order.dealer.gstin}`, { type: 'json' });
    if (rec) {
      order.dealer.limit = rec.creditLimit;
      order.dealer.outstanding = rec.outstanding;
      // Only treat the ledger as KNOWN when the sync actually supplied invoice-level
      // detail. If it didn't, leave it unknown so the desk shows "ledger unavailable"
      // instead of falsely clearing a dealer who may have open invoices.
      const inv = rec.openInvoices || rec.ledger;
      if (Array.isArray(inv)) { order.dealer.ledger = inv; order.dealer.ledgerKnown = true; }
      else { order.dealer.ledgerKnown = false; }
    }
  } catch { /* ledger unknown until next Zoho sync */ }
  return order;
}

// Idempotent write under the city partition. Returns false if the order already exists.
export async function storeOrder(order, { overwrite = false } = {}) {
  const store = getStore('orders');
  const key = `${order.city}/${order.id}`;
  if (!overwrite) {
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    if (existing) return false;
  }
  await store.setJSON(key, order);
  return true;
}
