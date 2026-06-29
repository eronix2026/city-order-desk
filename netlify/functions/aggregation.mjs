// netlify/functions/aggregation.mjs — the aggregation layer's API
//
//   GET /aggregation?code=ERX…   → unit's { oc, mc, status }           (bottom-up)
//   GET /aggregation?code=MC…|OC… → { type, serials:[…] }              (top-down explode)
//   GET /aggregation?mc=MC…       → { state:intact|opened|empty, ocs:[…] }
//   GET /aggregation?oc=OC…       → { oc, mc, serials:[…] }
//   POST /aggregation { cartons:[…] }  (admin)  → import packing map
//
// Zoho is never touched here — this layer owns the carton hierarchy.

import { verifySession } from './_session.mjs';
import { classify } from './_serial.mjs';
import { importAggregation, lookupUnit, ocContents, mcState, resolveToSerials } from './_aggregation.mjs';

export default async (req) => {
  const session = await verifySession(req);
  if (!session) return new Response('Not signed in', { status: 401 });
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const mc = url.searchParams.get('mc');
    if (mc) { const s = await mcState(mc); return s ? Response.json(s) : new Response('MC not found', { status: 404 }); }
    const oc = url.searchParams.get('oc');
    if (oc) { const c = await ocContents(oc); return c ? Response.json(c) : new Response('OC not found', { status: 404 }); }

    const code = url.searchParams.get('code');
    if (!code) return new Response('code, mc or oc required', { status: 400 });
    const kind = classify(code);
    if (kind === 'primary') {                              // bottom-up: which OC/MC holds it
      const u = await lookupUnit(code);
      return u ? Response.json(u) : new Response('Serial not found in aggregation', { status: 404 });
    }
    if (kind === 'mc' || kind === 'oc') return Response.json(await resolveToSerials(code)); // top-down explode
    return new Response('Unrecognized code', { status: 422 });
  }

  if (req.method === 'POST') {
    if (session.role !== 'admin') return new Response('Admin only', { status: 403 });
    let body; try { body = await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
    return Response.json({ ok: true, ...(await importAggregation(body)) });
  }
  return new Response('Method not allowed', { status: 405 });
};
