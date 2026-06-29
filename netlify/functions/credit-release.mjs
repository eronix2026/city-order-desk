// netlify/functions/credit-release.mjs — auto-release credit holds once the dealer settles.
//
// The hold lives here (on the order); the credit TRUTH lives in Dealer OS (credit-core + live Zoho
// invoices, which reflect EVERY settlement method — portal AND NEFT/RTGS). So this sweep asks Dealer OS
// "is this dealer still on hold?" and releases the orders of those who are not.
//
// Two ways in:
//   • Scheduled (cron, no gstin) — full sweep, min-interval locked (cheap + idempotent).
//   • On-demand POST ?gstin=… with X-Dealer-Secret — targeted, immediate (Dealer OS pings this right
//     after it reconciles a portal settlement). Bypasses the interval lock for that one dealer.
//
// Fail-safe: Dealer OS must EXPLICITLY answer onHold:false before anything is released. Any error,
// timeout, or ambiguous answer leaves the hold in place.
//
// netlify.toml:  [functions."credit-release"]  schedule = "*/15 * * * *"

import { getStore } from '@netlify/blobs';
import { applyRelease } from './_credit_hold.mjs';

const MIN_INTERVAL = 5 * 60 * 1000; // full sweep does real work at most once / 5 min
const OS_URL = () => (process.env.DEALER_OS_URL || 'https://rewards.eronix.in').replace(/\/+$/, '');
const SECRET = () => process.env.DEALER_BRIDGE_SECRET || process.env.DEALER_WEBHOOK_SECRET;

// Authority lives in Dealer OS. Returns true unless Dealer OS clearly says the dealer is cleared.
async function stillOnHold(gstin) {
  const secret = SECRET();
  if (!secret) return true; // can't verify → don't release
  try {
    const res = await fetch(`${OS_URL()}/api/credit-hold?gstin=${encodeURIComponent(gstin)}`,
      { headers: { 'x-dealer-secret': secret } });
    if (!res.ok) return true;
    const j = await res.json().catch(() => null);
    if (!j || j.ok !== true || typeof j.onHold !== 'boolean') return true;
    return j.onHold;
  } catch { return true; }
}

async function sweep({ gstin = null } = {}) {
  if (!SECRET()) return { ok: false, reason: 'unconfigured', released: 0 };
  const store = getStore('orders');
  const { blobs = [] } = await store.list().catch(() => ({ blobs: [] }));

  const held = [];
  for (const b of blobs) {
    const o = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!o || !o.creditHold) continue;
    const g = ((o.dealer && o.dealer.gstin) || '').toUpperCase();
    if (gstin && g !== gstin.toUpperCase()) continue;
    held.push({ key: b.key, o, gstin: g });
  }
  if (!held.length) return { ok: true, checked: 0, released: 0, dealers: 0 };

  // one authority check per unique dealer
  const gstins = [...new Set(held.map(h => h.gstin).filter(Boolean))];
  const onHold = {};
  for (const g of gstins) onHold[g] = await stillOnHold(g);

  let released = 0;
  for (const h of held) {
    if (onHold[h.gstin] === false) { // explicit clearance only
      applyRelease(h.o, { by: 'System · settlement', reason: 'Dues cleared — auto-released on settlement' });
      h.o.rev = (h.o.rev || 0) + 1;
      await store.setJSON(h.key, h.o);
      released++;
    }
  }
  return { ok: true, checked: held.length, released, dealers: gstins.length };
}

export default async (req) => {
  // Targeted on-demand path (has a gstin) is authenticated; the scheduled full sweep is interval-locked.
  let gstin = null;
  try {
    const url = new URL(req.url);
    const g = url.searchParams.get('gstin');
    if (g) {
      if (req.headers.get('x-dealer-secret') !== SECRET() || !SECRET())
        return new Response('Unauthorized', { status: 401 });
      gstin = g;
    }
  } catch { /* scheduled invocation — no URL params */ }

  if (!gstin) {
    const meta = getStore('sync-meta');
    const last = Number(await meta.get('credit-release-last').catch(() => 0)) || 0;
    if (Date.now() - last < MIN_INTERVAL) return Response.json({ ok: true, skipped: 'recently ran' });
    await meta.set('credit-release-last', String(Date.now()));
  }

  const out = await sweep({ gstin });
  return Response.json(out);
};
