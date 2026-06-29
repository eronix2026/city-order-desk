// netlify/functions/serial-pool.mjs
// The portal pre-loads the in-stock serial pool for an order's items when the
// warehouse opens it, so every scan can be validated INSTANTLY client-side
// (red/green at the point of capture) without a per-scan round trip.
//
//   GET /serial-pool?items=ITEMID1,ITEMID2     → { pools: { itemId: [serials] } }
//   GET /serial-pool?item_id=ITEMID            → single item

import { getAvailablePool } from './_zoho.mjs';
import { verifySession } from './_session.mjs';

export default async (req) => {
  if (!(await verifySession(req))) return new Response('Not signed in', { status: 401 });
  const url = new URL(req.url);
  const ids = (url.searchParams.get('items') || url.searchParams.get('item_id') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return new Response('item_id or items required', { status: 400 });

  const pools = {};
  for (const id of ids) {
    try { pools[id] = await getAvailablePool(id); }
    catch (e) { pools[id] = null; } // null = couldn't reach Zoho; portal treats as "unverified"
  }
  return Response.json({ pools });
};
