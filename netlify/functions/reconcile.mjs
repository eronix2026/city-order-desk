// netlify/functions/reconcile.mjs — scheduled housekeeping.
// 1. Releases reservations for orders stuck mid-pick (abandoned), returning their
//    units to stock so they can't leak.
// 2. Re-applies consumption for invoiced orders whose post-invoice bookkeeping
//    was deferred (reconcilePending), so unit status converges with Zoho.
//
// A min-interval lock makes it cheap and idempotent even if the URL is triggered
// directly — real work runs at most once per interval.
//
// netlify.toml:  [functions."reconcile"]  schedule = "*/15 * * * *"

import { getStore } from '@netlify/blobs';
import { releaseUnits, markUnitsConsumed } from './_aggregation.mjs';
import { invalidatePool, zohoToken, voidInvoice } from './_zoho.mjs';
import { finalizeRevoke } from './_revoke.mjs';

const STALE_MS = (Number(process.env.PICK_STALE_HOURS) || 24) * 3600 * 1000;
const MIN_INTERVAL = 5 * 60 * 1000; // don't do real work more than once / 5 min

export default async () => {
  const meta = getStore('sync-meta');
  const last = Number(await meta.get('reconcile-last').catch(() => 0)) || 0;
  if (Date.now() - last < MIN_INTERVAL) return Response.json({ ok: true, skipped: 'recently ran' });
  await meta.set('reconcile-last', String(Date.now()));

  const store = getStore('orders');
  const { blobs = [] } = await store.list().catch(() => ({ blobs: [] }));
  let released = 0, reapplied = 0, revoked = 0, now = Date.now();
  const stuck = [];

  for (const { key } of blobs) {
    const o = await store.get(key, { type: 'json' }).catch(() => null);
    if (!o) continue;

    // (0) a revoke that began voiding the Zoho invoice but didn't finish (crash between
    //     a successful void and the local write). Re-void is idempotent; only on a clean
    //     void do we finalize — fail-closed, so the desk never claims a void that didn't happen.
    if (o.revokePending) {
      try {
        if (o.zohoInvoiceId) { const tok = await zohoToken(); await voidInvoice(tok, o.zohoInvoiceId); }
        const serials = o.lines.flatMap(l => l.serials || []);
        if (serials.length) await releaseUnits(serials, o.id);
        await invalidatePool([...new Set(o.lines.map(l => l.itemId).filter(Boolean))]).catch(() => {});
        finalizeRevoke(o, { from: o.revokePending.from, reason: o.revokePending.reason, by: 'system', at: now, voided: o.invoiceNo });
        o.updatedAt = now; await store.setJSON(key, o);
        revoked++;
      } catch { /* void still failing — leave marker, retry next run */ }
      continue;
    }

    // (1) abandoned pick → return units to stock, revert to re-pickable
    if (o.status === 'PICKING' && now - (o.updatedAt || o.createdAt || 0) > STALE_MS) {
      const serials = o.lines.flatMap(l => l.serials || []);
      if (serials.length) await releaseUnits(serials, o.id);
      o.lines.forEach(l => { l.serials = []; });
      o.status = 'CREDIT_OK';
      o.staleReleased = true;
      (o.history = o.history || []).push({ stage: 'Stale pick released — units returned to stock', by: 'system', at: now });
      o.updatedAt = now;
      await store.setJSON(key, o);
      released++;
      continue;
    }

    // (2) invoiced but bookkeeping deferred → converge unit status with Zoho
    if (o.status === 'INVOICED' && o.reconcilePending) {
      try {
        await invalidatePool([...new Set(o.lines.map(l => l.itemId).filter(Boolean))]);
        await markUnitsConsumed(o.lines.flatMap(l => l.serials || []), 'invoiced');
        delete o.reconcilePending; o.updatedAt = now;
        await store.setJSON(key, o);
        reapplied++;
      } catch { /* retry next run */ }
    }

    // (3) anything still needing a human — surfaced as an exception snapshot / alert
    const r = stuckReason(o, now);
    if (r) stuck.push({ id: o.id, city: o.city, status: o.status, dealer: o.dealer && o.dealer.name, reason: r, total: o.total, ageH: Math.floor((now - (o.updatedAt || o.createdAt || now)) / 3600000) });
  }

  // Persist a snapshot (queryable/auditable) and, if configured, alert ops once a day.
  try { await getStore('ops').setJSON('exceptions', { at: now, count: stuck.length, items: stuck }); } catch { /* non-fatal */ }
  let alerted = false;
  if (stuck.length && process.env.OPS_ALERT_EMAIL && process.env.RESEND_API_KEY) {
    const day = new Date(now).toISOString().slice(0, 10);
    const lastDay = await meta.get('exceptions-digest-day').catch(() => null);
    if (lastDay !== day) {
      try {
        const rows = stuck.slice(0, 50).map(s => `• ${s.id} · ${s.city} · ${s.status} · ${s.dealer || ''} — ${s.reason}`).join('\n');
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: process.env.NOTIFY_FROM || 'ERONIX Order Desk <orders@eronix.in>',
            to: [process.env.OPS_ALERT_EMAIL],
            subject: `City Order Desk — ${stuck.length} order(s) need attention`,
            text: `${stuck.length} order(s) are stuck or errored as of ${new Date(now).toLocaleString('en-IN')}:\n\n${rows}\n\nOpen the desk: ${process.env.PORTAL_URL || 'https://orders.eronix.in'}`,
          }),
        });
        if (res.ok) { await meta.set('exceptions-digest-day', day); alerted = true; }
      } catch { /* non-fatal */ }
    }
  }
  return Response.json({ ok: true, released, reapplied, revoked, stuck: stuck.length, alerted });
};

const SLA_HRS = { NEW: 8, ACCOUNTS_REVIEW: 8, HELD: 48, CREDIT_OK: 24, PICKING: 24, SERIALIZED: 8, INVOICED: 24 };
function stuckReason(o, now) {
  if (o.revokePending) return 'revoke/void incomplete';
  if (Array.isArray(o.notify && o.notify.errors) && o.notify.errors.length) return 'notification failed';
  if (o.reconcilePending) return 'post-invoice sync pending';
  const sla = SLA_HRS[o.status];
  if (!sla) return null;
  const since = o.updatedAt || (o.stamps && o.stamps[o.status]) || o.createdAt || now;
  const hrs = (now - since) / 3600000;
  return hrs >= sla ? `stuck ${Math.floor(hrs)}h in ${o.status}` : null;
}
