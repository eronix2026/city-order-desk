// netlify/functions/unolo-poll.mjs
// Alternative inbound path. Unolo natively syncs booked orders into Zoho
// Inventory as Sales Orders, so instead of (or alongside) the webhook you can
// pull straight from the stack Dealer OS already syncs — no new Unolo creds.
//
// Runs on a schedule; picks up Sales Orders tagged from Unolo since the last
// cursor, normalizes, routes to a city, and seeds the NEW queue (idempotent on
// order id, so it's safe to run beside unolo-inbound.mjs).
//
// netlify.toml:
//   [functions."unolo-poll"]
//   schedule = "*/5 * * * *"
//
// Env: ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_ORG_ID

import { getStore } from '@netlify/blobs';
import { zohoToken } from './_zoho.mjs';
import { buildOrder, attachCredit, storeOrder } from './_ingest.mjs';

const MIN_INTERVAL = 60 * 1000; // coalesce direct triggers — real work at most once / 60s
const UNOLO_TAG = process.env.UNOLO_SOURCE_TAG || 'Unolo';
const DEALER_TAG = process.env.DEALER_SOURCE_TAG || 'DealerOS';
const STRICT = process.env.ORDER_SOURCE_STRICT === '1'; // ignore SOs without a known source tag

export default async () => {
  const meta = getStore('sync-meta');
  const last = Number(await meta.get('unolo-poll-last').catch(() => 0)) || 0;
  if (Date.now() - last < MIN_INTERVAL) return Response.json({ ok: true, skipped: 'recently polled' });
  await meta.set('unolo-poll-last', String(Date.now()));

  const token = await zohoToken();
  const since = (await meta.get('unolo-poll-cursor')) || '';

  // Pull recent sales orders. Origin filter (UNOLO_SOURCE_TAG) keeps non-Unolo
  // drafts out of the desk; leave it unset only if every draft is Unolo-sourced.
  const res = await fetch(
    `${process.env.ZOHO_API_BASE || 'https://www.zohoapis.in'}/inventory/v1/salesorders?organization_id=${process.env.ZOHO_ORG_ID}&status=draft&sort_column=date&sort_order=D`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
  const { salesorders = [] } = await res.json();

  let added = 0, newest = since;

  for (const so of salesorders) {
    if (so.created_time <= since) continue;           // cursor: only newer
    const tag = so.cf_source || '';
    if (STRICT && tag !== UNOLO_TAG && tag !== DEALER_TAG) continue; // origin filter
    if (so.created_time > newest) newest = so.created_time;

    // FOS orders (Unolo) vs dealer self-orders (Dealer OS), distinguished by the tag.
    const source = tag === DEALER_TAG ? 'dealer' : 'unolo';
    const order = buildOrder({
      source,
      id: (source === 'dealer' ? 'ERX-D-' : 'ERX-') + so.salesorder_number,
      unoloId: so.reference_number,
      exec: so.salesperson_name,
      repEmail: so.salesperson_email || so.cf_salesperson_email || '',
      dealer: {
        name: so.customer_name, code: so.cf_dealer_code || '',
        gstin: (so.gst_no || '').toUpperCase(),
        email: so.email || so.contact_email || '',
        pincode: so.shipping_address?.zip || '', city: so.cf_city || '',
        contactId: so.customer_id || null,
      },
      rawLines: (so.line_items || []).map(li => ({
        sku: li.sku, name: li.name, price: li.rate, qty: li.quantity, itemId: li.item_id,
      })),
    });
    if (!order.lines.length) continue;                // skip SOs with no valid lines
    await attachCredit(order);
    const fresh = await storeOrder(order, { overwrite: false }); // idempotent on order id
    if (fresh) added++;
  }

  if (newest !== since) await meta.set('unolo-poll-cursor', newest);
  return new Response(JSON.stringify({ ok: true, scanned: salesorders.length, added }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
