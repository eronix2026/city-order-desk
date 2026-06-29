// netlify/functions/dealer-orders.mjs
// Read bridge for the Dealer OS portal (rewards.eronix.in). Returns a dealer's orders
// — from BOTH origins (Unolo field app and Dealer OS self-orders) — each with a
// dealer-safe lifecycle timeline (placed → approved/held/rejected/revised → packed →
// invoiced → e-way → dispatched → delivered).
//
// Server-to-server only. The Dealer OS backend calls this with the shared secret it
// already holds for dealer-inbound, then proxies the result to its own UI — the secret
// never reaches the browser, and a dealer can only ever see their own GSTIN.
//
//   GET https://orders.eronix.in/.netlify/functions/dealer-orders?gstin=19AABCG1234K1Z5
//   header  X-Dealer-Secret: <DEALER_BRIDGE_SECRET>   (read-only; separate from the inbound webhook secret)
//   optional  &id=ERX-D-123   (single order)      &limit=100
//
// Response: { ok, gstin, count, orders: [ projectForDealer(order), ... ] }

import { getStore } from '@netlify/blobs';
import { projectForDealer } from './_dealer_view.mjs';

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  // Read-only bridge uses its OWN secret so a leak can't also forge inbound orders.
  // Falls back to the webhook secret only if the dedicated one isn't configured yet.
  const expected = process.env.DEALER_BRIDGE_SECRET || process.env.DEALER_WEBHOOK_SECRET;
  const secret = req.headers.get('x-dealer-secret');
  if (!expected || secret !== expected)
    return new Response('Unauthorized', { status: 401 });

  const url = new URL(req.url);
  const gstin = (url.searchParams.get('gstin') || '').toUpperCase().trim();
  const id = url.searchParams.get('id');
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 100));
  if (!GSTIN_RE.test(gstin))
    return Response.json({ ok: false, reason: 'missing or malformed GSTIN' }, { status: 422 });

  const store = getStore('orders');
  const { blobs } = await store.list();            // keys: {city}/{id} across every city desk
  const out = [];
  for (const b of blobs) {
    const o = await store.get(b.key, { type: 'json' });
    if (!o || !o.dealer || (o.dealer.gstin || '').toUpperCase() !== gstin) continue;
    if (id && o.id !== id) continue;
    out.push(projectForDealer(o));
  }
  out.sort((a, b) => (b.placedAt || 0) - (a.placedAt || 0));

  return Response.json({ ok: true, gstin, count: out.length, orders: out.slice(0, limit) });
};
