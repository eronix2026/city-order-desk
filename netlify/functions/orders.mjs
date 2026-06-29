// netlify/functions/orders.mjs
// City + role scoped read/update API behind the portal.
// Serialized flow: every unit carries a serial number, captured by the
// warehouse and relayed to accounts BEFORE an invoice can be raised.
//
//   GET  /orders                         -> queue for the signed-in desk
//   POST /orders { id, action, ...payload }
//
// Actions:
//   accounts  : approve (credit) | hold | reject | invoice
//   warehouse : serialize | submitSerials | dispatch | deliver
//
// Pipeline:
//   NEW → CREDIT_OK → PICKING → SERIALIZED → INVOICED → DISPATCHED → DELIVERED
//                                  └ serials relayed to accounts ┘
//                          (invoice is impossible before SERIALIZED)

import { getStore } from '@netlify/blobs';
import { getAvailablePool, createInvoiceWithSerials, invalidatePool, zohoToken, voidInvoice } from './_zoho.mjs';
import { verifySession } from './_session.mjs';
import { sanitizeLines } from './_route.mjs';
import { isPrimary, isCarton } from './_serial.mjs';
import { markUnitsConsumed, reserveUnits, releaseUnits } from './_aggregation.mjs';
import { sendInvoiceEmails, sendDecisionEmails } from './_notify.mjs';
import { finalizeRevoke } from './_revoke.mjs';
import { applyRelease } from './_credit_hold.mjs';

const ACCOUNTS  = ['NEW', 'ACCOUNTS_REVIEW', 'HELD', 'CREDIT_OK', 'PICKING', 'SERIALIZED', 'INVOICED', 'DISPATCHED', 'DELIVERED'];
const WAREHOUSE = ['CREDIT_OK', 'PICKING', 'SERIALIZED', 'INVOICED', 'DISPATCHED', 'DELIVERED'];
const EWAY_THRESHOLD = Number(process.env.EWAY_THRESHOLD) || 50000; // ₹ consignment value (incl. GST) above which an e-way bill is mandatory
const inr0 = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const scope = role => (role === 'warehouse' ? WAREHOUSE : ACCOUNTS);

// Serial shape check (Code 128 payload, case-preserved). Tighten to the real
// ERONIX S/N pattern once confirmed, e.g. /^ERX[0-9A-Z]{8,}$/.
const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{3,47}$/;

// which role may run which action (defence in depth — the constraint lives here)
const ACTION_ROLE = {
  approve: 'accounts', editApprove: 'accounts', hold: 'accounts', releaseHold: 'accounts', reject: 'accounts', invoice: 'accounts', revoke: 'accounts', eway: 'accounts',
  serialize: 'warehouse', submitSerials: 'warehouse', dispatch: 'warehouse', deliver: ['accounts', 'warehouse'],
};

const fullySerialized = o => o.lines.every(l => (l.serials?.length || 0) === l.qty);
const unitCount = o => o.lines.reduce((s, l) => s + l.qty, 0);

// Accounts-only fields (dealer credit/financials) are NEVER sent to a warehouse
// session — not just hidden in the UI, stripped from the payload. So an inventory
// user cannot reach the accounts section's data even via the raw API.
function projectForRole(order, role) {
  if (role !== 'warehouse') return order;          // accounts sees the full record
  const o = JSON.parse(JSON.stringify(order));
  if (o.dealer) { delete o.dealer.outstanding; delete o.dealer.limit; delete o.dealer.creditLimit; delete o.dealer.ledger; }
  delete o.credit;
  return o;
}

async function listCity(store, city, role) {
  const { blobs } = await store.list({ prefix: `${city}/` });
  const allowed = scope(role);
  const out = [];
  for (const b of blobs) {
    const o = await store.get(b.key, { type: 'json' });
    if (o && allowed.includes(o.status)) out.push(projectForRole(o, role));
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

// Unit reservation lives in the aggregation layer (single lifecycle record),
// so there is no separate serial index to keep in sync.

export default async (req, context) => {
  const store = getStore('orders');
  const url = new URL(req.url);
  const session = await verifySession(req);
  if (!session) return new Response('Not signed in', { status: 401 });
  const { role, city, name: actor } = session;

  if (req.method === 'GET') {
    const podId = url.searchParams.get('pod');
    if (podId) {
      const ord = await store.get(`${city}/${podId}`, { type: 'json' });
      if (!ord || !ord.pod || !ord.pod.key) return new Response('No POD on file', { status: 404 });
      if (ord.city && ord.city !== city) return new Response('Forbidden', { status: 403 });
      const bytes = await getStore('pods').get(ord.pod.key, { type: 'arrayBuffer' });
      if (!bytes) return new Response('POD missing', { status: 404 });
      // View-audit: who opened proof-of-delivery, when (delivery evidence is sensitive).
      try { await getStore('pod-audit').setJSON(`${ord.id}/${Date.now()}`, { order: ord.id, by: actor, role, at: Date.now() }); } catch { /* non-fatal */ }
      return new Response(bytes, { headers: { 'Content-Type': ord.pod.type || 'application/octet-stream', 'Content-Disposition': `inline; filename="${(ord.pod.name || 'pod').replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store' } });
    }
    return Response.json({ city, role, config: { ewayThreshold: EWAY_THRESHOLD }, orders: await listCity(store, city, role) });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const { id, action, ...p } = await req.json();
  const allowedRole = ACTION_ROLE[action];
  if (allowedRole && !(Array.isArray(allowedRole) ? allowedRole.includes(role) : allowedRole === role)) {
    return new Response(`${role} cannot ${action}`, { status: 403 });
  }
  const key = `${city}/${id}`;
  const o = await store.get(key, { type: 'json' });
  if (!o) return new Response('Not found', { status: 404 });
  if (o.city && o.city !== city) return new Response('Forbidden', { status: 403 }); // never act cross-city
  // Optimistic concurrency: if the client tells us which revision it acted on and the
  // stored order has moved on since, reject so two operators can't silently clobber
  // each other. Legacy orders / clients that don't send baseRev are unaffected.
  if (p.baseRev != null && (o.rev || 0) !== p.baseRev)
    return new Response('Order changed since you loaded it — reload and retry', { status: 409 });
  const now = Date.now();
  const prevStatus = o.status;
  o.history = o.history || [];
  let decision = null, decisionOpts = {};   // accounts decisions fan out an email loop

  switch (action) {
    case 'approve': // credit clearance only — NO invoice here
      if (o.creditHold) return new Response('On credit hold — dues past credit period + grace. Release the hold before approving.', { status: 423 });
      if (!['NEW', 'ACCOUNTS_REVIEW', 'HELD'].includes(o.status)) return new Response('Not reviewable', { status: 409 });
      o.status = 'CREDIT_OK';
      o.history.push({ stage: 'Order approved', by: actor, at: now });
      decision = 'approved';
      break;

    case 'releaseHold': // accounts lift the upstream credit hold (audited) → back into review
      if (!o.creditHold) return new Response('No credit hold on this order', { status: 409 });
      if (!p.reason || !String(p.reason).trim()) return new Response('A reason is required to release a credit hold', { status: 422 });
      applyRelease(o, { by: actor, reason: String(p.reason).trim(), at: now });
      break;

    case 'editApprove': { // adjust qty/rate, add a SKU, or drop a SKU — then clear credit
      if (o.creditHold) return new Response('On credit hold — release the hold before approving.', { status: 423 });
      if (!['NEW', 'ACCOUNTS_REVIEW', 'HELD'].includes(o.status)) return new Response('Not reviewable', { status: 409 });
      const incoming = sanitizeLines(p.lines); // final desired set; qty<=0 is dropped (= deletion)
      if (!incoming.length) return new Response('Cannot remove every line', { status: 422 });
      const oldBySku = new Map(o.lines.map(l => [String(l.sku), l]));
      const newSkus = new Set(incoming.map(l => String(l.sku)));
      const changes = [];
      for (const l of o.lines) {
        if (!newSkus.has(String(l.sku))) changes.push({ sku: l.sku, name: l.name, removed: true, was: { qty: l.qty, price: l.price } });
      }
      const finalLines = incoming.map(e => {
        const prev = oldBySku.get(String(e.sku));
        if (!prev) { // new SKU added at review (dealer asked for it informally)
          changes.push({ sku: e.sku, name: e.name, added: true, now: { qty: e.qty, price: e.price } });
          return { sku: e.sku, name: e.name, price: e.price, qty: e.qty, ...(e.itemId ? { itemId: e.itemId } : {}), serials: [] };
        }
        if (prev.qty !== e.qty || prev.price !== e.price) changes.push({ sku: e.sku, name: prev.name, was: { qty: prev.qty, price: prev.price }, now: { qty: e.qty, price: e.price } });
        return { ...prev, name: e.name || prev.name, price: e.price, qty: e.qty, serials: (prev.serials || []).slice(0, e.qty) };
      });
      o.lines = finalLines;
      const oldTotal = o.total;
      o.subtotal = o.lines.reduce((s, l) => s + l.price * l.qty, 0);
      o.gst = Math.round(o.subtotal * 0.18);
      o.total = o.subtotal + o.gst;
      o.edited = true;
      o.status = 'CREDIT_OK';
      o.history.push({ stage: `Edited & approved (${changes.length} change${changes.length === 1 ? '' : 's'})`, by: actor, at: now });
      decision = 'edited'; decisionOpts = { changes, oldTotal, newTotal: o.total };
      break;
    }

    case 'hold':
      if (!['NEW', 'ACCOUNTS_REVIEW', 'HELD', 'CREDIT_OK'].includes(o.status)) return new Response('Cannot hold at this stage', { status: 409 });
      o.status = 'HELD'; o.holdReason = p.reason || 'Held by accounts';
      o.history.push({ stage: 'Held', by: actor, at: now });
      decision = 'held'; decisionOpts = { reason: o.holdReason }; break;

    case 'reject':
      if (['INVOICED', 'DISPATCHED', 'DELIVERED'].includes(o.status)) return new Response('Cannot reject after invoicing', { status: 409 });
      o.status = 'REJECTED'; o.rejectReason = p.reason || '';
      await releaseUnits(o.lines.flatMap(l => l.serials || []), id); // return stock
      o.history.push({ stage: 'Rejected', by: actor, at: now });
      decision = 'rejected'; decisionOpts = { reason: o.rejectReason }; break;

    case 'revoke': { // accounts pull a pre-dispatch order back to review (and re-edit)
      const REVOCABLE = ['CREDIT_OK', 'PICKING', 'SERIALIZED', 'INVOICED'];
      if (!REVOCABLE.includes(o.status)) return new Response('Only a pre-dispatch order can be revoked', { status: 409 });

      // INVOICED → void the Zoho tax invoice FIRST, fail-closed. We persist a
      // revokePending marker BEFORE touching Zoho, so if the process dies between a
      // successful void and the local write, reconcile finds the marker and completes
      // the revoke — Zoho and the desk can never end up disagreeing.
      let voided = null;
      if (o.status === 'INVOICED') {
        if (p.confirm !== true) return new Response('Revoking an invoiced order voids its Zoho invoice — confirmation required', { status: 428 });
        voided = o.invoiceNo || null;
        if (o.zohoInvoiceId) {
          o.revokePending = { from: prevStatus, reason: p.reason || '', at: now };
          await store.setJSON(key, o);                       // record intent (crash-safe)
          try {
            const tok = await zohoToken();
            await voidInvoice(tok, o.zohoInvoiceId);
          } catch (e) {
            delete o.revokePending; await store.setJSON(key, o);
            return new Response('Could not void the Zoho invoice — revoke aborted: ' + e.message, { status: 502 });
          }
        }
      }

      // Return every reserved/consumed serial to stock and refresh the pool cache.
      const serials = o.lines.flatMap(l => l.serials || []);
      if (serials.length) await releaseUnits(serials, id);
      try { await invalidatePool([...new Set(o.lines.map(l => l.itemId).filter(Boolean))]); } catch {}

      finalizeRevoke(o, { from: prevStatus, reason: p.reason || '', by: actor, at: now, voided });
      decision = 'revoked'; decisionOpts = { reason: p.reason || '', from: prevStatus };
      break;
    }

    case 'serialize': { // add/replace serials for one SKU line
      if (!['CREDIT_OK', 'PICKING'].includes(o.status)) return new Response('Not in serializing stage', { status: 409 });
      const line = o.lines.find(l => l.sku === p.sku);
      if (!line) return new Response('Unknown SKU', { status: 404 });
      // Code 128 is already mod-103 checksum-verified by the scanner; we only
      // strip transport noise (control chars / FNC), preserve case, and shape-check.
      const clean = s => String(s).replace(/[\x00-\x1F\x7F]/g, '').trim();
      const incoming = (p.serials || []).map(clean).filter(Boolean);
      if (incoming.length > line.qty) return new Response('More serials than units', { status: 422 });
      for (const s of incoming) {
        if (/\s/.test(s)) return new Response(`Serial contains a space: ${s}`, { status: 422 });
        // Only exploded PRIMARY serials are ever stored / sent to Zoho.
        if (isCarton(s)) return new Response(`Carton label cannot be stored in Zoho — explode it to primary serials first: ${s}`, { status: 422 });
        if (!isPrimary(s)) return new Response(`Not a valid primary serial: ${s}`, { status: 422 });
      }

      // --- Zoho authoritative validation: every serial must be an in-stock
      //     serial that Zoho holds for THIS item (matches SKU, not yet sold). ---
      if (line.itemId) {
        let pool;
        try { pool = new Set(await getAvailablePool(line.itemId)); }
        catch (e) { return new Response('Zoho serial pool unavailable — try again', { status: 503 }); }
        for (const s of incoming) {
          if (!pool.has(s)) return new Response(`Serial not in Zoho in-stock for this item: ${s}`, { status: 409 });
        }
      }

      // within-order duplicate guard
      const local = new Set(o.lines.flatMap(l => l.sku === p.sku ? [] : (l.serials || [])));
      for (const s of incoming) {
        if (local.has(s)) return new Response(`Duplicate serial in order: ${s}`, { status: 409 });
      }
      // Reserve across orders (single source of truth). Conflicts = held elsewhere.
      const claim = await reserveUnits(incoming, id, line.itemId || null);
      if (!claim.ok) return new Response(`Serial already reserved on another order: ${claim.conflicts.join(', ')}`, { status: 409 });
      // release any of this line's previously-reserved serials that were dropped
      const dropped = (line.serials || []).filter(s => !incoming.includes(s));
      if (dropped.length) await releaseUnits(dropped, id);
      line.serials = incoming;
      if (o.status === 'CREDIT_OK' && incoming.length) o.status = 'PICKING';
      break;
    }

    case 'submitSerials': // warehouse relays the full manifest to accounts
      if (!fullySerialized(o)) return new Response('Capture every serial first', { status: 409 });
      o.status = 'SERIALIZED';
      o.history.push({ stage: `Serials captured (${unitCount(o)})`, by: actor, at: now });
      break;

    case 'invoice': // accounts — only possible once serials are in hand
      if (o.creditHold) return new Response('On credit hold — release the hold before invoicing.', { status: 423 });
      if (o.status !== 'SERIALIZED') return new Response('Order is not ready to invoice', { status: 409 });
      if (!fullySerialized(o)) return new Response('Serial manifest incomplete', { status: 409 });
      // Idempotency guard 1: block a concurrent raise while one is in flight.
      if (o.invoiceState === 'pending' && now - (o.invoiceStartedAt || 0) < 60000)
        return new Response('An invoice for this order is already being raised — please wait', { status: 409 });
      o.invoiceState = 'pending'; o.invoiceStartedAt = now; await store.setJSON(key, o);
      // Create the Zoho invoice with serials attached (accounting-based). Serials
      // leave stock here, so the pool shrinks — invalidate its cache afterwards.
      // Idempotency guard 2: createInvoiceWithSerials adopts an existing invoice
      // for this order's reference instead of posting a duplicate (lost-response/retry).
      let invRes;
      try {
        invRes = await createInvoiceWithSerials(o, { invoiceNo: p.invoiceNo });
      } catch (e) {
        o.invoiceState = 'failed'; await store.setJSON(key, o);
        return new Response('Zoho invoice failed: ' + e.message, { status: 502 });
      }
      // The invoice now exists in Zoho. Local bookkeeping below is NON-FATAL: units
      // are already reserved (so availability is correct regardless), and a retry
      // adopts this same invoice. A failure here only defers a status-label refresh.
      o.invoiceNo = invRes.invoiceNumber || p.invoiceNo;
      o.zohoInvoiceId = invRes.invoiceId;
      try {
        await invalidatePool([...new Set(o.lines.map(l => l.itemId).filter(Boolean))]);
        await markUnitsConsumed(o.lines.flatMap(l => l.serials || []), 'invoiced');
        delete o.reconcilePending;
      } catch { o.reconcilePending = true; }
      o.invoiceState = 'done';
      o.status = 'INVOICED';
      o.history.push({ stage: `Invoiced ${o.invoiceNo}${invRes.adopted ? ' (recovered existing)' : ''} — serials written to Zoho`, by: actor, at: now });
      // Notify sales rep, dealer, and warehouse — best-effort, never blocks the invoice.
      try { o.notify = await sendInvoiceEmails(o); }
      catch (e) { o.notify = { errors: ['notify failed: ' + e.message] }; }
      break;

    case 'eway': { // accounts record the e-way bill for a >₹50k consignment (generated from the invoice)
      if (o.status !== 'INVOICED') return new Response('E-way bill is generated from the invoice', { status: 409 });
      if ((o.total || 0) <= EWAY_THRESHOLD) return new Response('E-way bill not required — consignment within ' + inr0(EWAY_THRESHOLD) + '', { status: 422 });
      const number = String(p.number || '').replace(/\s/g, '');
      if (!/^\d{12}$/.test(number)) return new Response('E-way bill number must be 12 digits', { status: 422 });
      const distanceKm = Math.max(0, parseInt(p.distanceKm, 10) || 0);
      if (!distanceKm) return new Response('Approximate distance (km) is required', { status: 422 });
      const partB = distanceKm > 50; // ≤50 km intra-state may be Part A only
      const vehicle = String(p.vehicle || '').toUpperCase().replace(/\s/g, '');
      if (partB && !vehicle) return new Response('Vehicle number is required for distance over 50 km (Part B)', { status: 422 });
      const days = Math.max(1, Math.ceil(distanceKm / 200)); // EWB validity: 1 day per 200 km
      o.eway = {
        number, transporter: String(p.transporter || '').slice(0, 80), mode: p.mode || 'Road',
        vehicle, distanceKm, partB, generatedAt: now, by: actor, validTill: now + days * 86400000,
      };
      o.history.push({ stage: `E-way bill ${number} generated${vehicle ? ' · ' + vehicle : ''}`, by: actor, at: now });
      break;
    }

    case 'dispatch': // gated behind INVOICED → gated behind serials
      if (o.status !== 'INVOICED') return new Response('Cannot dispatch before invoice', { status: 409 });
      if ((o.total || 0) > EWAY_THRESHOLD && !(o.eway && o.eway.number))
        return new Response('E-way bill required before dispatch — consignment over ' + inr0(EWAY_THRESHOLD) + '', { status: 409 });
      if (!p.provider || !String(p.provider).trim()) return new Response('Service provider is required to dispatch', { status: 422 });
      if (!p.refId || !String(p.refId).trim()) return new Response('Provider order/reference ID is required to dispatch', { status: 422 });
      o.status = 'DISPATCHED';
      o.dispatchType = ['hyperlocal', 'interstate', 'international'].includes(p.type) ? p.type : 'interstate';
      o.provider = String(p.provider).slice(0, 60); o.refId = String(p.refId).slice(0, 60);
      o.courier = String(p.courier || o.provider).slice(0, 60); o.awb = String(p.awb || o.refId).slice(0, 60);
      markUnitsConsumed(o.lines.flatMap(l => l.serials || []), 'dispatched').catch(() => {});
      o.history.push({ stage: `Dispatched · ${o.provider} · ${o.refId} (${o.dispatchType})`, by: actor, at: now }); break;

    case 'deliver': {
      if (o.status !== 'DISPATCHED') return new Response('Can only deliver a dispatched order', { status: 409 });
      // Mandatory proof of delivery — a stamped receipt / signed invoice image or PDF.
      if (!o.pod && !(p.pod && p.pod.dataB64)) return new Response('A proof-of-delivery file is required to mark delivered', { status: 422 });
      if (p.pod && p.pod.dataB64) {
        if (!/^image\/(jpe?g|png|webp|heic|heif)$|^application\/pdf$/i.test(p.pod.type || ''))
          return new Response('POD must be an image or PDF', { status: 422 });
        const buf = Buffer.from(p.pod.dataB64, 'base64');
        if (!buf.length) return new Response('POD file is empty', { status: 422 });
        if (buf.length > 6 * 1024 * 1024) return new Response('POD file too large (max ~6 MB)', { status: 413 });
        // Magic-byte sniff: the actual bytes must match the declared family, so a
        // disguised payload can't slip through the content-type allowlist.
        const sniff = (() => {
          const b = buf;
          if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
          if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
          if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
          if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
          if ((b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) && /heic|heif/i.test(b.slice(8, 12).toString('latin1'))) return 'image/heic';
          return null;
        })();
        const declared = (p.pod.type || '').toLowerCase();
        const ok = sniff && (sniff === declared || (sniff === 'image/jpeg' && declared === 'image/jpg') || (/heic|heif/.test(sniff) && /heic|heif/.test(declared)));
        if (!ok) return new Response('POD file content doesn\u2019t match its type — upload a genuine image or PDF', { status: 422 });
        const ext = /pdf/i.test(p.pod.type) ? 'pdf' : ((p.pod.type || '').split('/')[1] || 'jpg');
        const key = `${city}/${id}/${now}.${ext}`;
        const retainUntil = now + 8 * 365 * 86400000; // ~8y, GST record-retention horizon
        await getStore('pods').set(key, buf, { metadata: { type: p.pod.type, name: p.pod.name, by: actor, uploadedAt: now, retainUntil } });
        o.pod = { name: String(p.pod.name || 'pod').slice(0, 120), type: p.pod.type, size: buf.length, by: actor, uploadedAt: now, key, retainUntil };
      }
      o.status = 'DELIVERED'; o.deliveredAt = now;
      if (p.note) o.deliveryNote = String(p.note).slice(0, 200);
      o.history.push({ stage: `Delivered${o.deliveryNote ? ' — ' + o.deliveryNote : ''}${o.pod ? ' · POD ' + o.pod.name : ''}`, by: actor, at: now }); break;
    }

    default:
      return new Response('Unknown action', { status: 400 });
  }

  // Time-stamp the transition so the timeline can show when each step happened.
  if (o.status !== prevStatus) { o.stamps = o.stamps || {}; o.stamps[o.status] = now; }

  // Accounts decisions fan out the CTA loop — dealer + FOS + warehouse. Best-effort.
  if (decision) {
    try { o.notify = await sendDecisionEmails(o, decision, decisionOpts); }
    catch (e) { o.notify = { decision, errors: ['notify failed: ' + e.message] }; }
  }

  o.rev = (o.rev || 0) + 1;
  await store.setJSON(key, { ...o, updatedAt: now });
  return Response.json({ ok: true, order: projectForRole(o, role) });
};
