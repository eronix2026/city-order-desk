// netlify/functions/unolo-inbound.mjs
// Field-officer orders pushed by Unolo (or a Pabbly/Make relay) the moment a FOS
// taps "send". Normalizes via the shared builder (source = 'unolo') and queues it.
//
// Wire-up: POST https://orders.eronix.in/.netlify/functions/unolo-inbound
//   header X-Unolo-Secret: <UNOLO_WEBHOOK_SECRET>
// Env: UNOLO_WEBHOOK_ENABLED=1, UNOLO_WEBHOOK_SECRET, RESEND_API_KEY (optional)

import { GSTIN_RE } from './_route.mjs';
import { buildOrder, attachCredit, storeOrder } from './_ingest.mjs';
import { verifyWebhook } from './_webhook.mjs';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (process.env.UNOLO_WEBHOOK_ENABLED !== '1')
    return new Response('Webhook disabled — orders arrive via the scheduled poll. Set UNOLO_WEBHOOK_ENABLED=1 to enable.', { status: 410 });

  let rawText; try { rawText = await req.text(); } catch { return new Response('Bad body', { status: 400 }); }
  const v = await verifyWebhook(req, rawText, { secret: process.env.UNOLO_WEBHOOK_SECRET, signingSecret: process.env.UNOLO_SIGNING_SECRET, secretHeader: 'x-unolo-secret' });
  if (!v.ok) return new Response(v.reason, { status: v.status });

  let raw; try { raw = JSON.parse(rawText); } catch { return new Response('Bad JSON', { status: 400 }); }

  const order = buildOrder({
    source: 'unolo',
    id: 'ERX-' + (raw.order_id || Date.now()),
    unoloId: raw.order_id || raw.id,
    exec: raw.executive || raw.exec_username,
    repEmail: raw.exec_email || raw.salesperson_email || '',
    dealer: {
      name: raw.dealer_name || raw.client_name,
      code: raw.dealer_code || '',
      gstin: (raw.gstin || raw.dealer_gstin || '').toUpperCase(),
      email: raw.dealer_email || raw.email || '',
      pincode: raw.dealer_pincode || raw.pincode || '',
      city: raw.city || '',
    },
    rawLines: (raw.items || raw.products || []).map(it => ({
      sku: it.sku || it.product_code, name: it.name || it.product_name,
      price: it.rate ?? it.price ?? 0, qty: it.quantity ?? it.qty ?? 0,
    })),
  });

  if (!order.lines.length) return new Response(JSON.stringify({ ok: false, reason: 'no valid order lines' }), { status: 422 });
  if (!GSTIN_RE.test(order.dealer.gstin)) return new Response(JSON.stringify({ ok: false, reason: 'missing or malformed GSTIN' }), { status: 422 });

  await attachCredit(order);
  await storeOrder(order, { overwrite: false }); // idempotent on order id

  if (process.env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ERONIX Orders <orders@eronix.in>',
        to: [`accounts.${order.city.toLowerCase()}@eronix.in`],
        subject: `New order ${order.id} · ${order.dealer.name} · ₹${order.total.toLocaleString('en-IN')}`,
        text: `${order.dealer.name} (${order.dealer.gstin}) placed ${order.lines.length} line(s) via ${order.exec}. Review at https://orders.eronix.in`,
      }),
    }).catch(() => {});
  }

  return new Response(JSON.stringify({ ok: true, id: order.id, city: order.city }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};
