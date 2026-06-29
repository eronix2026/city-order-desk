// netlify/functions/dealer-inbound.mjs
// Dealer self-orders placed in Dealer OS (rewards.eronix.in). The dealer is already
// authenticated there (GSTIN + OTP), so Dealer OS posts the order here with the
// dealer's own identity. Normalizes via the shared builder (source = 'dealer').
//
// Wire-up in Dealer OS: POST https://orders.eronix.in/.netlify/functions/dealer-inbound
//   header X-Dealer-Secret: <DEALER_WEBHOOK_SECRET>
//   body { orderId, dealer:{ gstin, name, code, email, pincode, city, contactId },
//          lines:[{ sku, name, price, qty, itemId }] }
// Env: DEALER_WEBHOOK_ENABLED=1, DEALER_WEBHOOK_SECRET, RESEND_API_KEY (optional)
//
// (Alternatively, Dealer OS can create a Zoho draft SO tagged DEALER_SOURCE_TAG and
//  let unolo-poll ingest it — this webhook is the direct path.)

import { GSTIN_RE } from './_route.mjs';
import { buildOrder, attachCredit, storeOrder } from './_ingest.mjs';
import { verifyWebhook } from './_webhook.mjs';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (process.env.DEALER_WEBHOOK_ENABLED !== '1')
    return new Response('Dealer webhook disabled. Set DEALER_WEBHOOK_ENABLED=1 to enable.', { status: 410 });

  let rawText; try { rawText = await req.text(); } catch { return new Response('Bad body', { status: 400 }); }
  const v = await verifyWebhook(req, rawText, { secret: process.env.DEALER_WEBHOOK_SECRET, signingSecret: process.env.DEALER_SIGNING_SECRET, secretHeader: 'x-dealer-secret' });
  if (!v.ok) return new Response(v.reason, { status: v.status });

  let raw; try { raw = JSON.parse(rawText); } catch { return new Response('Bad JSON', { status: 400 }); }
  const d = raw.dealer || {};

  const order = buildOrder({
    source: 'dealer',
    id: 'ERX-D-' + (raw.orderId || raw.order_id || Date.now()),
    unoloId: raw.orderId || raw.order_id || null,
    dealer: {
      name: d.name || d.dealer_name,
      code: d.code || d.dealer_code || '',
      gstin: (d.gstin || '').toUpperCase(),
      email: d.email || '',
      pincode: d.pincode || '',
      city: d.city || '',
      contactId: d.contactId || d.contact_id || null, // Zoho contact for invoice write-back
    },
    rawLines: (raw.lines || raw.items || []).map(it => ({
      sku: it.sku, name: it.name, price: it.rate ?? it.price ?? 0, qty: it.quantity ?? it.qty ?? 0,
      itemId: it.itemId || it.item_id,
    })),
    hold: raw.hold === true,
    holdReason: typeof raw.holdReason === 'string' ? raw.holdReason : '',
  });

  if (!order.lines.length) return new Response(JSON.stringify({ ok: false, reason: 'no valid order lines' }), { status: 422 });
  if (!GSTIN_RE.test(order.dealer.gstin)) return new Response(JSON.stringify({ ok: false, reason: 'missing or malformed GSTIN' }), { status: 422 });

  await attachCredit(order);
  const fresh = await storeOrder(order, { overwrite: false }); // idempotent on order id

  if (fresh && process.env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ERONIX Orders <orders@eronix.in>',
        to: [`accounts.${order.city.toLowerCase()}@eronix.in`],
        subject: `New dealer order ${order.id} · ${order.dealer.name} · ₹${order.total.toLocaleString('en-IN')}`,
        text: `${order.dealer.name} (${order.dealer.gstin}) self-placed ${order.lines.length} line(s) via Dealer OS. Review at https://orders.eronix.in`,
      }),
    }).catch(() => {});
  }

  return new Response(JSON.stringify({ ok: true, id: order.id, city: order.city, source: 'dealer' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};
