// netlify/functions/_notify.mjs  (shared — underscore = not a route)
// On invoice, notify the three parties: the sales rep, the dealer, and the city's
// warehouse staff. Best-effort and self-contained — failures never block the
// invoice (which has already posted to Zoho); each recipient is independent, and a
// missing address is recorded, not fatal.

import { staffByCityRole } from './_session.mjs';
import { getStore } from '@netlify/blobs';

const FROM = process.env.NOTIFY_FROM || 'ERONIX Order Desk <orders@eronix.in>';
const PORTAL = process.env.PORTAL_URL || 'https://orders.eronix.in';

// Idempotency: a notification is keyed to the *event* (order + decision + the stamp of
// that transition) and recipient, so a retried action — platform retry, double-click,
// reconcile — can never send the same email twice. Only successful sends are recorded,
// so a genuinely failed send is still retried.
const notifyLog = () => getStore('notify-log');
async function alreadySent(key) { if (!key) return false; try { return !!(await notifyLog().get(key)); } catch { return false; } }
async function markSent(key) { if (!key) return; try { await notifyLog().setJSON(key, { at: Date.now() }); } catch { /* non-fatal */ } }
const DECISION_STAMP = { approved: 'CREDIT_OK', edited: 'CREDIT_OK', held: 'HELD', rejected: 'REJECTED', revoked: 'REVOKED' };
function decisionToken(order, decision) {
  const ts = (order.stamps && order.stamps[DECISION_STAMP[decision]]) || order.updatedAt || '';
  return `dec:${order.id}:${decision}:${ts}`;
}

function repDirectory() { try { return JSON.parse(process.env.REP_DIRECTORY || '{}'); } catch { return {}; } }
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function send(to, subject, html, idemKey) {
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!list.length) return { skipped: 'no recipient' };
  if (idemKey && await alreadySent(idemKey)) return { skipped: 'duplicate' };  // already delivered for this event
  if (!process.env.RESEND_API_KEY) return { skipped: 'no RESEND_API_KEY' }; // dry in dev/test
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: list, subject, html }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 120)}`);
  await markSent(idemKey);
  return r.json();
}

function lineRows(order) {
  return (order.lines || []).map(l =>
    `<tr><td style="padding:6px 0;color:#1d1d1f">${esc(l.name || l.sku)}</td>` +
    `<td style="padding:6px 0;text-align:right;color:#6e6e73">×${esc(l.qty)}</td>` +
    `<td style="padding:6px 0;text-align:right;color:#1d1d1f">${inr((l.price || 0) * (l.qty || 0))}</td></tr>`
  ).join('');
}
function unitCount(order) { return (order.lines || []).reduce((n, l) => n + (l.serials ? l.serials.length : 0), 0); }

function shell(title, intro, order, extra = '') {
  return `<div style="font-family:-apple-system,Inter,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1d1d1f">
  <div style="font-size:17px;font-weight:700;letter-spacing:-.02em">ERONIX</div>
  <h2 style="font-size:19px;font-weight:600;margin:14px 0 4px">${esc(title)}</h2>
  <p style="font-size:14px;color:#6e6e73;line-height:1.5;margin:0 0 18px">${intro}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #e5e5ea;border-bottom:1px solid #e5e5ea">${lineRows(order)}</table>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:10px">
   <tr><td style="color:#6e6e73">Subtotal</td><td style="text-align:right">${inr(order.subtotal)}</td></tr>
   <tr><td style="color:#6e6e73">GST</td><td style="text-align:right">${inr(order.gst)}</td></tr>
   <tr><td style="font-weight:600;padding-top:4px">Total</td><td style="text-align:right;font-weight:600;padding-top:4px">${inr(order.total)}</td></tr>
  </table>
  ${extra}
  <p style="font-size:12px;color:#aeaeb2;margin-top:22px">Order ${esc(order.id)}${order.invoiceNo ? ' · Invoice ' + esc(order.invoiceNo) : ''} · ${esc(order.city)} · ERONIX (Mobyara Lifestyle)</p>
  </div>`;
}

export async function sendInvoiceEmails(order) {
  const result = { rep: null, dealer: null, warehouse: 0, skipped: [], errors: [] };
  const dealerName = order.dealer?.name || 'Dealer';
  const inv = order.invoiceNo || '';

  const repEmail = order.repEmail || repDirectory()[order.exec] || null;
  const dealerEmail = order.dealer?.email || null;
  const tok = `inv:${order.id}:${order.invoiceNo || ''}`;
  let warehouse = [];
  try { warehouse = await staffByCityRole(order.city, 'warehouse'); } catch (e) { result.errors.push('warehouse lookup: ' + e.message); }

  // 1) Dealer — customer-facing confirmation
  if (dealerEmail) {
    try {
      await send(dealerEmail,
        `Your ERONIX order ${order.id} is invoiced (${inv})`,
        shell('Your order has been invoiced',
          `Hi ${esc(dealerName)}, invoice <b>${esc(inv)}</b> has been raised for your order. It is being prepared for dispatch and you'll be notified with tracking shortly.`,
          order), `${tok}:dealer`);
      result.dealer = dealerEmail;
    } catch (e) { result.errors.push('dealer: ' + e.message); }
  } else result.skipped.push('dealer (no email)');

  // 2) Sales rep — booking confirmation
  if (repEmail) {
    try {
      await send(repEmail,
        `Invoice raised — ${dealerName} · ${order.id} (${inv})`,
        shell('Invoice raised for your order',
          `Invoice <b>${esc(inv)}</b> has been raised for <b>${esc(dealerName)}</b>${order.dealer?.code ? ' (' + esc(order.dealer.code) + ')' : ''}. The warehouse has been notified to dispatch.`,
          order), `${tok}:rep`);
      result.rep = repEmail;
    } catch (e) { result.errors.push('rep: ' + e.message); }
  } else result.skipped.push('rep (no email)');

  // 3) Warehouse — dispatch-ready, with serial count
  const whEmails = warehouse.map(s => s.email);
  if (whEmails.length) {
    try {
      await send(whEmails,
        `Ready to dispatch — ${order.id} · ${dealerName}, ${order.city}`,
        shell('Ready to dispatch',
          `Order <b>${esc(order.id)}</b> for <b>${esc(dealerName)}</b> is invoiced (<b>${esc(inv)}</b>) with <b>${unitCount(order)}</b> serialized unit(s). Pack and dispatch, then mark it dispatched.`,
          order,
          `<p style="margin-top:16px"><a href="${PORTAL}" style="display:inline-block;background:#0a84ff;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:10px">Open the warehouse desk</a></p>`), `${tok}:wh`);
      result.warehouse = whEmails.length;
    } catch (e) { result.errors.push('warehouse: ' + e.message); }
  } else result.skipped.push(`warehouse (none in ${order.city})`);

  return result;
}

// ---- Accounts decision notifications (CTA loop: dealer + FOS + warehouse) ----

function resolveRecipients(order) {
  return {
    dealer: order.dealer?.email || null,
    rep: order.repEmail || repDirectory()[order.exec] || null, // null for dealer self-orders
  };
}

function changesTable(changes = []) {
  if (!changes.length) return '';
  const rows = changes.map(c => {
    if (c.removed) return `<tr><td style="padding:6px 0;color:#1d1d1f">${esc(c.name)}</td><td style="padding:6px 0;text-align:right;color:#b00020">removed</td></tr>`;
    if (c.added) return `<tr><td style="padding:6px 0;color:#1d1d1f">${esc(c.name)}</td><td style="padding:6px 0;text-align:right;color:#1c7a3a">added · qty <b>${c.now.qty}</b> @ ${inr(c.now.price)}</td></tr>`;
    const q = c.was.qty !== c.now.qty ? `qty ${c.was.qty}→<b>${c.now.qty}</b>` : '';
    const p = c.was.price !== c.now.price ? `rate ${inr(c.was.price)}→<b>${inr(c.now.price)}</b>` : '';
    return `<tr><td style="padding:6px 0;color:#1d1d1f">${esc(c.name)}</td><td style="padding:6px 0;text-align:right;color:#6e6e73">${[q, p].filter(Boolean).join(' · ')}</td></tr>`;
  }).join('');
  return `<div style="margin-top:16px"><div style="font-size:12px;color:#6e6e73;margin-bottom:4px">What changed</div><table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #e5e5ea;border-bottom:1px solid #e5e5ea">${rows}</table></div>`;
}

// decision: 'approved' | 'edited' | 'held' | 'rejected'
function decisionCopy(decision, order, opts, who) {
  const id = esc(order.id), dealer = esc(order.dealer?.name || 'Dealer'), city = esc(order.city);
  const reason = esc(opts.reason || '');
  const units = (order.lines || []).reduce((n, l) => n + (l.qty || 0), 0);
  const deskBtn = `<p style="margin-top:16px"><a href="${PORTAL}" style="display:inline-block;background:#0a84ff;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:10px">Open the warehouse desk</a></p>`;
  const diff = changesTable(opts.changes);
  const M = {
    approved: {
      dealer: ['Your order is approved', `Good news — order <b>${id}</b> has been approved and is now being prepared. We'll send your invoice once it's packed.`, ''],
      rep:    [`Approved — ${dealer}`, `<b>${dealer}</b>'s order <b>${id}</b> was approved and has gone to the ${city} warehouse to pick & serialize.`, ''],
      wh:     ['Ready to pick', `Order <b>${id}</b> for <b>${dealer}</b> is approved — ${units} unit(s) to pick & serialize.`, deskBtn],
    },
    edited: {
      dealer: ['Your order was adjusted & approved', `We've adjusted order <b>${id}</b> and approved it. Updated total <b>${inr(order.total)}</b>. It's now being prepared.`, diff],
      rep:    [`Edited & approved — ${dealer}`, `<b>${dealer}</b>'s order <b>${id}</b> was adjusted and approved (new total <b>${inr(order.total)}</b>).`, diff],
      wh:     ['Ready to pick (revised)', `Order <b>${id}</b> for <b>${dealer}</b> is approved with revised quantities — pick per the lines below (${units} unit(s)).`, deskBtn],
    },
    held: {
      dealer: ['Your order is on hold', `Order <b>${id}</b> is on hold${reason ? `: ${reason}` : ''}. Please get in touch to clear it.`, ''],
      rep:    [`On hold — ${dealer}`, `<b>${dealer}</b>'s order <b>${id}</b> is on hold${reason ? `: ${reason}` : ''}. Please follow up with the dealer.`, ''],
      wh:     ['Hold — do not pick', `<b>${id}</b> for <b>${dealer}</b> is on hold${reason ? ` (${reason})` : ''}. Do not pick yet.`, ''],
    },
    rejected: {
      dealer: ['Your order could not be processed', `Unfortunately order <b>${id}</b> was not approved${reason ? `: ${reason}` : ''}.`, ''],
      rep:    [`Rejected — ${dealer}`, `<b>${dealer}</b>'s order <b>${id}</b> was rejected${reason ? `: ${reason}` : ''}.`, ''],
      wh:     ['Cancelled — do not pick', `<b>${id}</b> for <b>${dealer}</b> was rejected${reason ? ` (${reason})` : ''}; reserved stock has been released.`, ''],
    },
    revoked: {
      dealer: ['Your order is being revised', `We've reopened order <b>${id}</b> to make an adjustment before dispatch${reason ? `: ${reason}` : ''}. We'll confirm again shortly — no action needed from you.`, ''],
      rep:    [`Reopened by accounts — ${dealer}`, `<b>${dealer}</b>'s order <b>${id}</b> was pulled back to review${reason ? `: ${reason}` : ''}. Any invoice has been voided and reserved stock released; it will re-clear once adjusted.`, ''],
      wh:     ['Stop — order pulled back', `<b>${id}</b> for <b>${dealer}</b> has been revoked by accounts${reason ? ` (${reason})` : ''}. Do not pick or dispatch — reserved serials have been released and any invoice voided. It will return once re-approved.`, ''],
    },
  };
  const [title, intro, extra] = (M[decision] || M.approved)[who];
  return { title, intro, extra };
}

export async function sendDecisionEmails(order, decision, opts = {}) {
  const result = { decision, dealer: null, rep: null, warehouse: 0, skipped: [], errors: [] };
  const { dealer: dealerEmail, rep: repEmail } = resolveRecipients(order);
  let warehouse = [];
  try { warehouse = await staffByCityRole(order.city, 'warehouse'); } catch (e) { result.errors.push('warehouse lookup: ' + e.message); }
  const whEmails = warehouse.map(s => s.email);

  const subj = { dealer: c => `${c.title} — ${order.id}`, rep: c => `${c.title} · ${order.id}`, wh: c => `${c.title} — ${order.id} · ${order.dealer?.name || ''}, ${order.city}` };
  const tok = decisionToken(order, decision);
  const jobs = [];

  if (dealerEmail) { const c = decisionCopy(decision, order, opts, 'dealer'); jobs.push(send(dealerEmail, subj.dealer(c), shell(c.title, c.intro, order, c.extra), `${tok}:dealer`).then(() => { result.dealer = dealerEmail; }, e => result.errors.push('dealer: ' + e.message))); }
  else result.skipped.push('dealer (no email)');

  if (repEmail) { const c = decisionCopy(decision, order, opts, 'rep'); jobs.push(send(repEmail, subj.rep(c), shell(c.title, c.intro, order, c.extra), `${tok}:rep`).then(() => { result.rep = repEmail; }, e => result.errors.push('rep: ' + e.message))); }
  else result.skipped.push(order.source === 'dealer' ? 'rep (dealer self-order)' : 'rep (no email)');

  if (whEmails.length) { const c = decisionCopy(decision, order, opts, 'wh'); jobs.push(send(whEmails, subj.wh(c), shell(c.title, c.intro, order, c.extra), `${tok}:wh`).then(() => { result.warehouse = whEmails.length; }, e => result.errors.push('warehouse: ' + e.message))); }
  else result.skipped.push(`warehouse (none in ${order.city})`);

  await Promise.allSettled(jobs);
  return result;
}
