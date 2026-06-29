// netlify/functions/_zoho.mjs  (shared helper — underscore prefix = not a function route)
// Fetches the AVAILABLE (in-stock) serial numbers for an item from Zoho Inventory
// and caches them in Blobs. This is the source of truth the serial validation
// layer checks captured serials against.
//
//   GET /inventory/v1/items/serialnumbers?organization_id=…&item_id=…
//   → the in-stock serials for that item (sold/shipped serials are excluded)
//
// Env: ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_ORG_ID
//      ZOHO_API_BASE (default https://www.zohoapis.in), ZOHO_ACCOUNTS_BASE (.in)

import { getStore } from '@netlify/blobs';
import { assertPrimaries } from './_serial.mjs';

const API = process.env.ZOHO_API_BASE || 'https://www.zohoapis.in';
const ACCOUNTS = process.env.ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.in';
const TTL = 5 * 60 * 1000; // 5 min — refresh cadence for the cached pool

export async function zohoToken() {
  const store = getStore('zoho-token');
  const cached = await store.get('access', { type: 'json' }).catch(() => null);
  if (cached && Date.now() < cached.exp) return cached.token;
  const r = await fetch(`${ACCOUNTS}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Zoho token failed');
  // Zoho access tokens last ~1h; cache for 50 min to leave headroom.
  const ttl = ((Number(j.expires_in) || 3600) - 600) * 1000;
  await store.setJSON('access', { token: j.access_token, exp: Date.now() + Math.max(ttl, 60000) }).catch(() => {});
  return j.access_token;
}

// Pull every available serial for an item (paginated). Field names are parsed
// defensively — confirm the exact shape against your org's response once.
export async function fetchAvailableSerials(token, itemId) {
  let page = 1, more = true; const all = [];
  while (more) {
    const url = `${API}/inventory/v1/items/serialnumbers?organization_id=${process.env.ZOHO_ORG_ID}&item_id=${encodeURIComponent(itemId)}&page=${page}&per_page=200`;
    const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (!r.ok) throw new Error('Zoho serials ' + r.status);
    const j = await r.json();
    const arr = j.serial_numbers || j.serialnumbers || j.serials || [];
    for (const s of arr) all.push(typeof s === 'string' ? s : (s.serial_number || s.serialnumber || s.name));
    more = !!(j.page_context && j.page_context.has_more_page);
    page++;
    if (page > 60) break; // safety bound
  }
  return all.filter(Boolean);
}

// Cached accessor: returns the in-stock serials for an item, refreshing from
// Zoho when the cache is older than TTL.
export async function getAvailablePool(itemId) {
  const store = getStore('serial-pool');
  let rec = await store.get(itemId, { type: 'json' }).catch(() => null);
  if (!rec || Date.now() - rec.fetchedAt > TTL) {
    const token = await zohoToken();
    const serials = await fetchAvailableSerials(token, itemId);
    rec = { itemId, serials, fetchedAt: Date.now() };
    await store.setJSON(itemId, rec);
  }
  return rec.serials;
}

// Invalidate the cached pool for items (call after invoicing consumes serials,
// so the next validation reflects the reduced availability).
export async function invalidatePool(itemIds = []) {
  const store = getStore('serial-pool');
  for (const id of itemIds) await store.delete(id).catch(() => {});
}

// Look up an existing invoice by its reference number (the order's stable key).
// Used to make invoicing idempotent — a retry after a lost response adopts the
// already-created invoice instead of posting a duplicate.
// NOTE: confirm the `reference_number` list filter against your org once.
export async function findInvoiceByReference(token, ref) {
  const url = `${API}/inventory/v1/invoices?organization_id=${process.env.ZOHO_ORG_ID}&reference_number=${encodeURIComponent(ref)}`;
  const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  const hit = (j.invoices || []).find(i => i.reference_number === ref);
  return hit ? { invoiceId: hit.invoice_id, invoiceNumber: hit.invoice_number } : null;
}

// Accounting-based write-back: create the Zoho invoice and attach the captured
// serials per line. Idempotent — if an invoice already exists for this order's
// reference, it is adopted rather than duplicated. Zoho blocks the one-click
// SO→invoice for serial-tracked orders, so we create the invoice explicitly
// (linked to the originating SO).
// NOTE: confirm the line-item serial field key ("serial_numbers") against your
// org with one sandbox call — it isn't in Zoho's public API reference.
export async function createInvoiceWithSerials(order, { invoiceNo } = {}) {
  // Zoho only knows primary serials — never let a carton label through.
  const guard = assertPrimaries(order.lines.flatMap(l => l.serials || []));
  if (!guard.ok) throw new Error('Non-primary serial(s) cannot be invoiced to Zoho: ' + guard.bad.join(', '));
  const token = await zohoToken();
  const org = process.env.ZOHO_ORG_ID;
  const ref = order.unoloId || order.id;             // stable, unique per order (idempotency key)

  // Idempotency: adopt an existing invoice for this reference instead of creating a second.
  const existing = await findInvoiceByReference(token, ref);
  if (existing) return { ...existing, adopted: true };

  const body = {
    customer_id: order.dealer.contactId,                 // Zoho contact id (from the SO)
    reference_number: ref,
    ...(order.salesOrderId ? { salesorder_id: order.salesOrderId } : {}),
    line_items: order.lines.map(l => ({
      item_id: l.itemId,
      quantity: l.qty,
      rate: l.price,
      serial_numbers: l.serials,                         // serials leave stock at invoice (accounting-based)
    })),
  };
  const qs = new URLSearchParams({ organization_id: org });
  if (invoiceNo) { body.invoice_number = invoiceNo; qs.set('ignore_auto_number_generation', 'true'); }

  const r = await fetch(`${API}/inventory/v1/invoices?${qs}`, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code && j.code !== 0)) throw new Error(j.message || ('Zoho invoice ' + r.status));
  const inv = j.invoice || {};

  // Mark as sent (best effort).
  if (inv.invoice_id) {
    await fetch(`${API}/inventory/v1/invoices/${inv.invoice_id}/status/sent?organization_id=${org}`,
      { method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${token}` } }).catch(() => {});
  }
  return { invoiceId: inv.invoice_id, invoiceNumber: inv.invoice_number, adopted: false };
}

// Void a Zoho invoice (used when accounts revoke a pre-dispatch, already-invoiced
// order). Voiding — not deleting — keeps the invoice number in the audit trail and
// returns its serials to stock. Caller treats this as FAIL-CLOSED: if it throws,
// abort the whole revoke so local state and Zoho never diverge.
// NOTE: confirm the void endpoint against your org with one sandbox call, same as
// the invoice-create field mapping above.
export async function voidInvoice(token, invoiceId) {
  if (!invoiceId) throw new Error('No Zoho invoice id to void');
  const org = process.env.ZOHO_ORG_ID;
  const r = await fetch(`${API}/inventory/v1/invoices/${invoiceId}/status/void?organization_id=${org}`,
    { method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  const j = await r.json().catch(() => ({}));
  // Treat "already void" as success so a retried revoke is idempotent.
  const already = j.message && /void/i.test(j.message) && /already|current/i.test(j.message);
  if ((!r.ok || (j.code && j.code !== 0)) && !already) throw new Error(j.message || ('Zoho void ' + r.status));
  return { ok: true, invoiceId, alreadyVoid: !!already };
}
