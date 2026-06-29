// netlify/functions/_aggregation.mjs  (shared — underscore = not a route)
//
// The MC ▸ OC ▸ primary aggregation layer — ERONIX's own system of record for the
// carton hierarchy. Zoho only knows primary serials; this layer owns the mapping
// between master cartons, outer cartons, and the units inside them, in BOTH
// directions, plus each unit's lifecycle status.
//
// Storage (Netlify Blobs store 'aggregation'); the access functions below are the
// stable interface — swap the bodies for Postgres (see aggregation-schema.sql)
// without touching callers.
//
//   unit/{serial} -> { serial, item, batch, oc, mc, status }   ← reverse index
//   oc/{oc}       -> { oc, mc, item, batch, serials:[...] }     ← forward (OC→units)
//   mc/{mc}       -> { mc, item, batch, ocs:[...] }             ← forward (MC→OCs)
//
// status: 'in_stock' | 'invoiced' | 'dispatched'

import { getStore } from '@netlify/blobs';
import { classify, isPrimary, isCarton, parseItem, parseBatch, expandRange } from './_serial.mjs';

const store = () => getStore('aggregation');
const get = (k) => store().get(k, { type: 'json' }).catch(() => null);
const put = (k, v) => store().setJSON(k, v);

// ---------- build (packing event) ----------
// payload: { cartons: [ { mc, ocs: [ { oc, serials: [...] } ] } ] }
export async function importAggregation(payload) {
  let units = 0, ocs = 0, mcs = 0; const errors = [];
  for (const carton of (payload.cartons || [])) {
    const mc = String(carton.mc || '').toUpperCase();
    if (classify(mc) !== 'mc') { errors.push(`bad MC code: ${mc}`); continue; }
    const item = parseItem(mc), batch = parseBatch(mc);
    const ocCodes = [];
    for (const ocIn of (carton.ocs || [])) {
      const oc = String(ocIn.oc || '').toUpperCase();
      if (classify(oc) !== 'oc') { errors.push(`bad OC code: ${oc}`); continue; }
      // An OC may be given as an explicit serial list OR a {start, count} range —
      // a sealed carton stamps one range instead of needing N per-unit scans.
      let serials;
      if (Array.isArray(ocIn.serials) && ocIn.serials.length) serials = ocIn.serials.map(s => String(s).toUpperCase());
      else if (ocIn.start && ocIn.count) serials = expandRange(ocIn.start, ocIn.count);
      else { errors.push(`OC ${oc}: needs serials[] or start+count`); continue; }
      const bad = serials.filter(s => !isPrimary(s));
      if (!serials.length || bad.length) { errors.push(`bad serials in ${oc}: ${bad.join(',') || 'empty/overflow'}`); continue; }
      // write unit rows (reverse index) + the OC node (forward)
      await Promise.all(serials.map(s => put(`unit/${s}`, { serial: s, item, batch, oc, mc, status: 'in_stock' })));
      await put(`oc/${oc}`, { oc, mc, item, batch, serials });
      ocCodes.push(oc); ocs++; units += serials.length;
    }
    await put(`mc/${mc}`, { mc, item, batch, ocs: ocCodes });
    mcs++;
  }
  return { mcs, ocs, units, errors };
}

// ---------- bottom-up: which OC / MC holds this serial ----------
export async function lookupUnit(serial) {
  return get(`unit/${String(serial).toUpperCase()}`);
}

// ---------- forward reads ----------
export async function ocContents(oc) { return get(`oc/${String(oc).toUpperCase()}`); }
export async function mcNode(mc) { return get(`mc/${String(mc).toUpperCase()}`); }

// ---------- top-down explode (used by the scan path) ----------
export async function resolveToSerials(code) {
  const c = String(code || '').toUpperCase(); const kind = classify(c);
  if (kind === 'oc') { const n = await ocContents(c); return { type: 'oc', code: c, sku: n?.item || null, serials: n?.serials || [] }; }
  if (kind === 'mc') {
    const n = await mcNode(c); const serials = [];
    for (const oc of (n?.ocs || [])) { const o = await ocContents(oc); if (o?.serials) serials.push(...o.serials); }
    return { type: 'mc', code: c, sku: n?.item || null, serials };
  }
  return { type: 'primary', code: c, sku: null, serials: [c] }; // unknown/primary → itself
}

// ---------- carton state (is this MC half-emptied?) ----------
export async function mcState(mc) {
  const n = await mcNode(mc); if (!n) return null;
  const ocStates = [];
  let total = 0, inStock = 0;
  for (const oc of (n.ocs || [])) {
    const o = await ocContents(oc); const serials = o?.serials || [];
    let ocIn = 0;
    for (const s of serials) { const u = await lookupUnit(s); if (u && u.status === 'in_stock') ocIn++; }
    ocStates.push({ oc, total: serials.length, inStock: ocIn });
    total += serials.length; inStock += ocIn;
  }
  const state = inStock === total ? 'intact' : inStock === 0 ? 'empty' : 'opened';
  return { mc: n.mc, item: n.item, batch: n.batch, total, inStock, consumed: total - inStock, state, ocs: ocStates };
}

// ---------- lifecycle: reserve / release / consume (single source of truth) ----------
// One unit record carries the whole lifecycle: in_stock → reserved{orderId}
// → invoiced → dispatched. This replaces the separate serial index: reservation
// is what prevents the same unit shipping on two orders, and it's set in the
// gated order path (not as a fire-and-forget side effect).

// Claim units for an order. Conflicts = units held by a DIFFERENT order.
// (On Postgres this is an atomic `update … where status='in_stock'`; on Blobs the
//  read-then-write has a small race that Zoho's invoice uniqueness backstops.)
export async function reserveUnits(serials, orderId, item = null) {
  const rows = await Promise.all((serials || []).map(async (raw) => {
    const s = String(raw).toUpperCase(); return { s, u: await get(`unit/${s}`) };
  }));
  const conflicts = rows.filter(({ u }) => u && u.orderId && u.orderId !== orderId && u.status !== 'in_stock').map(r => r.s);
  if (conflicts.length) return { ok: false, conflicts };
  await Promise.all(rows.map(({ s, u }) => {
    const row = u || { serial: s, item: item || parseItem(s), batch: parseBatch(s), oc: null, mc: null };
    row.status = 'reserved'; row.orderId = orderId; row.reservedAt = Date.now();
    return put(`unit/${s}`, row);
  }));
  return { ok: true, conflicts: [] };
}

// Release units a given order had reserved (rollback / re-pick). Packed units go
// back to in_stock; loose rows we created at reserve time are removed.
export async function releaseUnits(serials, orderId) {
  let released = 0;
  await Promise.all((serials || []).map(async (raw) => {
    const s = String(raw).toUpperCase(); const key = `unit/${s}`; const u = await get(key);
    if (!u || (u.orderId && u.orderId !== orderId)) return;     // not ours — leave it
    if (u.oc || u.mc) { u.status = 'in_stock'; delete u.orderId; await put(key, u); }
    else { await store().delete(key).catch(() => {}); }          // loose row → drop
    released++;
  }));
  return released;
}

// ---------- lifecycle: mark units consumed (called by the order flow) ----------
export async function markUnitsConsumed(serials, status = 'invoiced') {
  let updated = 0;
  await Promise.all((serials || []).map(async (s) => {
    const key = `unit/${String(s).toUpperCase()}`; const u = await get(key);
    if (u) { u.status = status; await put(key, u); updated++; }
  }));
  return updated;
}
