# Dealer OS — Order Timeline Bridge

Makes every order's full lifecycle visible to the dealer in **Dealer OS** (rewards.eronix.in),
**regardless of origin** — orders booked by a field officer in **Unolo** *and* orders the dealer
self-places in **Dealer OS** both appear, each with the complete timeline including **HOLD,
REJECTION and APPROVAL** (with reasons), then packing, invoice, e-way bill, dispatch and delivery.

The City Order Desk is the system of record. This bridge is a **read-only, server-to-server**
projection of a dealer's own orders. No serial numbers, credit/ledger position, staff identities,
Zoho ids or POD files are ever exposed.

---

## 1. Bridge endpoint (on the desk)

```
GET https://orders.eronix.in/.netlify/functions/dealer-orders?gstin=<DEALER_GSTIN>
header  X-Dealer-Secret: <DEALER_BRIDGE_SECRET>
optional  &id=ERX-D-123      → a single order
optional  &limit=100         → cap (default 100, max 200)
```

- Auth uses a dedicated, read-only `DEALER_BRIDGE_SECRET` (separate from the inbound `DEALER_WEBHOOK_SECRET`, so a read-secret leak can't forge orders). Falls back to `DEALER_WEBHOOK_SECRET` if the dedicated one isn't set yet.
- A dealer can only ever see **their own GSTIN** — the secret is held by the Dealer OS backend, never the browser.
- `401` if the secret is wrong/absent, `422` on a malformed GSTIN.

### Response

```json
{
  "ok": true,
  "gstin": "19AABCG1234K1Z5",
  "count": 2,
  "orders": [
    {
      "id": "ERX-501",
      "source": "unolo",
      "placedVia": "Field officer (Unolo)",
      "placedAt": 1750000000000,
      "status": "DISPATCHED",
      "statusLabel": "In transit",
      "lines": [{ "sku": "EUPH-ANC-BLK", "name": "Euphoria ANC", "qty": 20, "price": 2499 }],
      "amount": 58982,
      "invoiceNo": "INV/26/4412",
      "eway": { "number": "181400235567", "validTill": 1750100000000 },
      "dispatch": { "type": "interstate", "provider": "Delhivery", "ref": "1248839201" },
      "deliveredAt": null,
      "podOnFile": false,
      "holdReason": null,
      "rejectReason": null,
      "timeline": [
        { "key": "placed",     "label": "Order placed",        "at": 1750000000000, "note": "Booked by field officer (Unolo)" },
        { "key": "held",       "label": "Order on hold",       "at": 1750003600000, "note": "Pending invoices unsettled" },
        { "key": "approved",   "label": "Order approved",      "at": 1750010800000, "note": "Approved with revisions" },
        { "key": "packed",     "label": "Packed & verified",   "at": 1750018000000, "note": null },
        { "key": "invoiced",   "label": "Invoice raised",      "at": 1750021600000, "note": "INV/26/4412" },
        { "key": "eway",       "label": "E-way bill generated","at": 1750023400000, "note": "181400235567" },
        { "key": "dispatched", "label": "Dispatched",          "at": 1750028800000, "note": "Delhivery · 1248839201" }
      ]
    }
  ]
}
```

`timeline[]` is chronological. Possible `key`s: `placed`, `held`, `approved`, `rejected`,
`revised`, `packed`, `invoiced`, `eway`, `dispatched`, `delivered`.

---

## 2. Dealer OS wiring (two small pieces)

**a. A server-side proxy** so the secret never reaches the browser and the GSTIN is taken from the
**signed-in dealer's session**, not from a query the client can tamper with:

```js
// Dealer OS backend — e.g. /api/order-timeline
export default async (req, ctx) => {
  const dealer = await currentDealer(req);          // your existing Dealer OS auth (GSTIN + OTP)
  if (!dealer) return new Response('Not signed in', { status: 401 });
  const r = await fetch(
    `https://orders.eronix.in/.netlify/functions/dealer-orders?gstin=${encodeURIComponent(dealer.gstin)}`,
    { headers: { 'X-Dealer-Secret': process.env.DEALER_BRIDGE_SECRET } }
  );
  return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json' } });
};
```

**b. Render** with the included `dealer-timeline.html` component:

```js
const data = await (await fetch('/api/order-timeline')).json();
renderDealerOrders(document.getElementById('orders'), data.orders);
```

`dealer-timeline.html` is self-contained (ERONIX light tokens, Inter, the same status colours as the
desk) and ships with a demo dataset so it renders standalone for review. Drop it in, or lift its
`renderDealerOrders()` / `renderTimeline()` into your existing page.

---

## 3. Notes & next steps

- **Performance:** the bridge currently scans all order blobs and filters by GSTIN — fine at present
  volume. At scale, add a `dealer-index/{gstin} → [orderKeys]` blob updated in `storeOrder()` and read
  that instead of `list()`. (Drop-in optimisation; contract unchanged.)
- **Freshness:** poll on portal load (and optionally every ~60s on an open order). The desk writes
  each transition synchronously, so the bridge is always current.
- **Env:** set `DEALER_BRIDGE_SECRET` (read-only bridge); it falls back to `DEALER_WEBHOOK_SECRET` if unset.
