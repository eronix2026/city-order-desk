# City Order Desk — Architecture

Per-city order routing between **Unolo** (field order capture) and the **Accounts**
and **Warehouse** desks in each metro. One deployment, city-scoped — not one
Netlify project per city (respects the `eronix.in` apex / Let's Encrypt–Wix
deadlock; only the `orders` subdomain via CNAME).

## Serialized flow (the gate)

Every unit is serialized. The warehouse captures a serial number for each unit,
per SKU, and relays the manifest to accounts **before** an invoice can be raised.
Accounts therefore touches each order twice: once for credit, once for invoicing.

```
 Field exec (Unolo) ──taps "Send"──┐
                                    ▼
   unolo-inbound.mjs / unolo-poll.mjs ──► Blobs orders/{City}/{id}  (status: NEW)
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        ▼                                                         ▼
   ACCOUNTS · step 1                                        WAREHOUSE
   credit check vs Zoho outstanding                         (after CREDIT_OK)
   approve ─► CREDIT_OK                                     pick units +
   hold / reject                                            scan 1 S/N per unit
        ▲                                                   per SKU  ─► PICKING
        │                                                         │
        │   ◄────── serials relayed ──────  submitSerials ─► SERIALIZED
        ▼
   ACCOUNTS · step 2
   review serial manifest
   raise invoice (serials written to Zoho) ─► INVOICED
        │
        ▼
   WAREHOUSE  dispatch (courier + AWB) ─► DISPATCHED ─► DELIVERED
```

`NEW → CREDIT_OK → PICKING → SERIALIZED → INVOICED → DISPATCHED → DELIVERED`
with `HELD` / `REJECTED` branches off the credit step.

**The constraint is enforced in three places** so it can't be bypassed:
1. `invoice` returns 409 unless `status === SERIALIZED` and every line is full.
2. `dispatch` returns 409 unless `status === INVOICED`.
3. `submitSerials` returns 409 unless every unit has a serial.

## Carton aggregation (MC ▸ OC ▸ primary S/N)

Stock is packed Master Carton ▸ Outer Cartons ▸ primary units, with each level's
label mapped to the level below. Scanning a carton label captures every unit
under it in one action.

- **Map:** built at packing time, imported via `POST /aggregation` (admin only) into
  the `aggregation` Blobs store as `node/{code}` = MC→[OC] / OC→[serials].
- **Resolve:** scanning a code calls `resolveToSerials` — an MC explodes to all its
  OCs' serials, an OC to its serials, an unknown code is treated as a primary.
- **Capture rules (match the physical process):** every scan (camera / wedge /
  manual) routes through `ingestScan`.
  - A **master carton (MC)** is captured only when **intact and taken whole** — if
    any unit inside has already been consumed (half-emptied) or the MC holds more
    than the line needs, it's refused and the operator is told to scan outer cartons.
  - An **outer carton (OC)** captures its available units, capped to what the line
    still needs (the rest stays in the OC).
  - A **single unit** S/N is added on its own.
  Cartons route to the correct SKU line even if a different line was focused.
- **Validation is preserved:** every resolved primary serial is still checked
  against the Zoho in-stock pool and the global dedup index — aggregation only
  decides *which* serials to validate, it never bypasses the checks.

## Serial validation against Zoho (in-stock pool)

Every captured serial is validated against the **in-stock serial pool Zoho holds
for that exact item**, so a mis-scan, a different product's label, or an
already-sold unit is rejected at the point of capture.

- **Source:** `GET /inventory/v1/items/serialnumbers?organization_id&item_id`
  returns the available (not-yet-sold) serials for an item. (`_zoho.mjs`)
- **Pre-load (instant UX):** when the warehouse opens an order, the portal calls
  `serial-pool.mjs` for the order's item ids and holds the pools in memory, so each
  scan is checked client-side with no per-scan round trip (red/green immediately).
  Pools are cached server-side in Blobs with a 5-min TTL.
- **Authoritative enforcement:** `orders.mjs serialize` re-checks every serial
  against `getAvailablePool(itemId)` and returns 409 for any serial not in Zoho
  stock — the client check is convenience, this is the gate.
- **Write-back (accounting-based):** the `invoice` action calls `createInvoiceWithSerials`
  — it creates the Zoho invoice explicitly (the one-click SO→invoice is blocked for
  serial-tracked orders), attaches each line's serials via `serial_numbers`, marks it
  sent, and invalidates the pool cache for those items. Zoho itself rejects any serial
  no longer available, catching staleness. Invoicing is idempotent: a
  60s in-flight lock blocks concurrent raises, and createInvoiceWithSerials looks
  up an existing invoice by the order reference before creating one, so a lost
  response / retry adopts the existing invoice instead of duplicating it. Prereq: receiving records serials on the
  Zoho bill / opening stock, so they exist in the pool to be invoiced out.
- **Notes:** Zoho has no free-text serial search, so validation is per-item against
  the pool. Serials are assigned at invoice (accounting-based) or package
  (physical-based) creation — confirm which mode the org uses; it only changes
  *where* serials are written back, not this validation. The demo simulates the
  pool per SKU (toggle "Zoho check" to see accept/reject); production uses the live
  endpoint.

## Serial integrity

- **One S/N, one shipment.** A `serials` Blobs store maps `serial → orderId`.
  `serialize` rejects any serial already claimed by another order, and within the
  same order. Removing a serial releases it back.
- **Count match.** A line is complete only when `serials.length === qty`.
- **Three capture methods, one path.** Serials reach `addSerialValue()` (UI) /
  the `serialize` action (API) identically whether they come from (a) a hardware
  keyboard-wedge scanner, (b) manual keyboard entry, or (c) the **phone camera**.
  The camera mode uses the native `BarcodeDetector` on Android/Chromium and a
  ZXing-WASM fallback on iOS/Safari (which has no Barcode Detection API). It is
  locked to Code 128, scans continuously, auto-advances SKU to SKU, and dedupes
  against the live serial set. `detectFrame()` is the swap seam — drop in STRICH /
  Scanbot / Scandit there if free-engine reading rates fall short in the field.
  The ZXing-WASM binary is self-hosted under /vendor/zxing (no CDN) and precached
  by the service worker, so iOS scanning works offline. Decoding runs on the
  reticle ROI only. Deploy over HTTPS (camera + service worker require it).
- **Symbology: Code 128.** The mod-103 check character is internal to Code 128 and
  is verified by the scanner at decode time — a scan that reaches the app has
  already passed it, so there is **no software checksum step**. Payloads are
  variable-length and case-significant: the app preserves case, strips control
  chars (FNC/CR/LF), rejects embedded spaces, and shape-checks against `SERIAL_RE`.
  If the labels are GS1-128 (FNC1 + AI-prefixed), the serial is wrapped in AI (21)
  and needs a parse step — not yet built. The `BarcodeDetector` camera path also
  supports `code_128` if phone-camera capture is added later.
- **On invoice**, serials are written onto the Zoho tax invoice line items
  (`serial_numbers`), so warranty registration and channel anti-diversion trace
  back to the GST document. Zoho Inventory natively tracks serialized items.

## Two inbound paths from Unolo

| | `unolo-inbound.mjs` (webhook) | `unolo-poll.mjs` (Zoho pull) |
|---|---|---|
| Latency | Instant | ≤ 5 min |
| Needs Unolo API creds | Yes | No |
| Best when | order needed before Zoho | reuse the Dealer OS sync |

Idempotent on order id — safe to run both. Recommended: start with the pull.

## Roles & scoping

`orders.mjs` enforces a hard stage scope per role and a per-action role guard
(`ACTION_ROLE`). Accounts owns `NEW / HELD / SERIALIZED`; warehouse owns
`CREDIT_OK / PICKING / SERIALIZED / INVOICED / …`. `SERIALIZED` shows in both —
accounts to invoice it, warehouse read-only ("awaiting invoice"). City + role come
from the signed session, never the query string.

## Access control (role + city isolation)

Both constraints are enforced **server-side from the signed session**, never from
client input — the portal UI hiding things is only cosmetic.

**Role — an inventory user cannot reach the accounts section:**
- Actions are gated: `ACTION_ROLE` maps approve/hold/reject/invoice → accounts and
  serialize/submitSerials/dispatch/deliver → warehouse; a mismatched role gets 403.
- The queue is filtered by `scope(role)` — a warehouse session never lists NEW /
  HELD / accounts-review orders.
- `projectForRole()` **strips** accounts-only fields (dealer.outstanding, credit
  limit) from every order sent to a warehouse session — they're removed from the
  payload, not just hidden, so the raw API leaks nothing.

**City — staff see only their own city:**
- Orders are keyed `${city}/${id}` and listed by `${city}/` prefix, where `city`
  comes from the session cookie — a Kolkata session can only ever read/write the
  Kolkata partition.
- POST adds a defense-in-depth assertion: `if (o.city !== session.city) → 403`.
- The portal drops spoofable `?city=&role=` params (the server ignores them anyway)
  and locks the city switcher to the session city in production.

`serial-pool` is session-gated but not city-scoped by design: serial availability is
org-level inventory (a SKU sells in every city), not a city's private customer data.

## Staff authentication

Passwordless email-OTP, gated by a staff allowlist (the allowlist IS the
authorization — role and city are fixed per email, never user input).

```
 email ─► auth-request ─► OTP emailed (Resend), hash stored in Blobs (10-min TTL)
 code  ─► auth-verify  ─► signed HttpOnly session cookie { email, name, role, city, exp }
 boot  ─► auth-me      ─► restores the session, or shows the login overlay
          auth-logout  ─► clears the cookie
```

`_session.mjs` signs/verifies the cookie (HMAC-SHA256, Web Crypto). Every protected
function (`orders.mjs`, `serial-pool.mjs`) calls `verifySession(req)` and 401s
without one. In production the portal hides the role switch and locks the city to
the session; in demo the switcher stays for exploration.

## Env

```
UNOLO_WEBHOOK_SECRET
ZOHO_REFRESH_TOKEN / ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_ORG_ID
RESEND_API_KEY
SESSION_SECRET            # HMAC key for signed session cookies
STAFF_ALLOWLIST           # JSON: email -> {name, role, city}
SESSION_TTL_HOURS         # session lifetime (default 12)
```

## Deploy

`orders.eronix.in` → CNAME to the Netlify site. **Never** add `eronix.in` or
`www.eronix.in`. `portal.html` is the front-end; point its actions at
`/.netlify/functions/orders` once the staff session edge function is in.

## Open items before go-live

1. Confirm the live Unolo order payload → finalize `normalize()` field names.
2. Confirm the ERONIX serial-number format → tighten validation in `serialize`
   (length / prefix / checksum) beyond the current uniqueness + count checks.
3. Wire serials into the Zoho invoice call (`serial_numbers` per line item).
4. Staff session edge function (email-allowlist login for internal staff).
5. Rotate the Zoho self-client creds flagged in Dealer OS.

## Robustness model (single unit-state lifecycle)

Unit availability has ONE source of truth: the aggregation `unit/{serial}` record,
which carries the whole lifecycle `in_stock → reserved{orderId} → invoiced → dispatched`.
The old separate serial index is gone.

- **Reserve at serialize.** Capturing serials reserves them to the order (`reserveUnits`).
  A unit held by another order is a hard conflict (409). Reservation is set in the
  gated order path, so availability is never a fire-and-forget side effect.
- **Release on rollback.** Rejecting an order (or re-picking a line) releases its units
  back to `in_stock` (`releaseUnits`) — no stock leakage. Loose rows created for
  un-packed units are removed.
- **Consume at invoice (non-fatal).** The Zoho invoice is the only fatal step. Once it
  succeeds, pool-cache invalidation and the `invoiced` status update are best-effort:
  units are already reserved (so availability is correct regardless) and a retry adopts
  the same invoice. A failure here only sets `reconcilePending` for a later refresh.
- **Concurrency.** On Blobs, reserve is read-then-write with a small race that Zoho's
  invoice-level serial uniqueness backstops. Moving the unit table to Postgres
  (`aggregation-schema.sql`) makes reservation an atomic `UPDATE … WHERE status='in_stock'`,
  closing the race at pick time. Blobs stays as the read cache.

## Ingestion & routing

- **One active path by default.** The scheduled poll (`unolo-poll`) is the ingestion path;
  the webhook (`unolo-inbound`) is opt-in via `UNOLO_WEBHOOK_ENABLED=1`. One surface to
  reason about, one field-mapping, no secret to rotate unless you turn it on.
- **Territory routing is shared** (`_route.mjs`): exec → pincode → explicit city →
  flagged fallback. An unresolved order lands in `DEFAULT_CITY` with `needsRouting: true`
  rather than silently masquerading as a normal order, so a human can verify/reassign it.

New env: `UNOLO_WEBHOOK_ENABLED` (default off), `DEFAULT_CITY` (default Kolkata).

## Hardening (security & robustness pass)

- **Live authorization.** `verifySession` re-checks the staff allowlist on every
  request and takes role/city from it — the signed token is advisory. Removing or
  re-roling a staff member takes effect immediately, not at token expiry.
- **OTP.** Compared in constant time (`timingSafeEqual`); the OTP hash can use a
  separate `OTP_SECRET` (falls back to `SESSION_SECRET`).
- **Reservation safety net.** Reservations carry `reservedAt`; the scheduled
  `reconcile` job (every 15 min) releases units from picks abandoned past
  `PICK_STALE_HOURS` (default 24, reverting them to re-pickable) and re-applies
  deferred consumption for any `reconcilePending` invoice.
- **Ingestion validation.** Both inbound paths run `sanitizeLines` (drops missing
  SKU, non-positive/fractional qty, bad price) and the webhook validates `GSTIN_RE`.
- **Ingestion trigger.** `unolo-poll` and `reconcile` coalesce direct hits with a
  min-interval lock, and `unolo-poll` filters to `UNOLO_SOURCE_TAG` (when set) so
  only Unolo-tagged sales orders ingest.
- **Zoho token cache.** The access token is cached (~50 min) instead of minted on
  every pool refresh and invoice.
- **Demo guard.** The portal shows a blocking banner if `DEMO_MODE` is on while
  served from a production host, so a demo build can't masquerade as live.

New env: `OTP_SECRET` (optional), `PICK_STALE_HOURS` (default 24),
`UNOLO_SOURCE_TAG` (optional origin filter), `ZOHO_API_BASE` (used by the poll too).

### Still requires your action (not code)
- Confirm the Zoho invoice line-item `serial_numbers` key and the `reference_number`
  list filter against your org with one sandbox call — an unconfirmed key risks
  invoices posting without serials, or the idempotent adopt missing an existing one.

## Admin: the Aggregation Desk (packing.html)

A standalone admin tool at `/packing.html` builds and inspects the MC → OC → serial
map. It's admin-gated (calls `auth-me`; non-admins are blocked, and `POST /aggregation`
re-enforces admin server-side) and excluded from the service-worker cache so it's
always fresh. Three modes:

- **Packing station** — one scan box routes by namespace: a master carton sets the box,
  an outer carton opens a layer, a unit drops into the open OC (or fill a sealed OC from
  its first serial + a count). Seal each OC, commit the MC → `POST /aggregation`.
- **Bulk import** — back-office form: per MC, add OCs each defined by a serial range
  (first S/N + count) or a pasted serial list. Validate & preview (counts + errors),
  then import.
- **Look up** — verify the map: a unit returns its OC/MC/status, a master carton its
  state (intact/opened/empty) with per-OC counts, an outer carton its contents.

All three validate codes client-side (namespace + GS1 check digit) before submitting,
and produce the exact payload `importAggregation` expects. In demo mode the page builds
an in-memory map so the full round-trip (build → look up) works without a backend.

## Invoice notifications

On a successful invoice, `orders.mjs` calls `sendInvoiceEmails(order)` (`_notify.mjs`)
to notify three parties via Resend:
- **Dealer** — customer-facing confirmation (invoice no., items, total, dispatch coming).
- **Sales rep** — booking confirmation for their dealer.
- **Warehouse** — dispatch-ready notice with serialized unit count + a desk link, sent
  to every `warehouse` staff member in the order's city (resolved from the allowlist
  via `staffByCityRole`).

It's best-effort and non-fatal: the invoice has already posted to Zoho, so each
recipient is independent and a missing address is recorded on `order.notify`
(`{ rep, dealer, warehouse, skipped, errors }`), never raised. It fires once — only on
the SERIALIZED→INVOICED transition — so retries can't double-send. With no
`RESEND_API_KEY` it runs dry (resolves recipients, sends nothing).

Recipient emails: dealer + rep are captured at ingestion (`dealer.email`, `repEmail`);
the rep also falls back to an optional `REP_DIRECTORY` map (exec name → email).

New env: `REP_DIRECTORY` (optional JSON), `NOTIFY_FROM` (default `orders@eronix.in`),
`PORTAL_URL` (default `https://orders.eronix.in`).

## Admin: Staff provisioning (no self-registration)

There is no self sign-up — role and city are assigned, never chosen. The **Staff**
tab in `packing.html` (admin-gated) manages the allowlist via `staff.mjs`:
- `GET /staff` — list with provenance (`env` vs `added`).
- `POST /staff {email,name,role,city}` — add/update (validates email, role∈accounts/warehouse/admin, city∈CITIES).
- `DELETE /staff?email=` — remove; an env-defined member is tombstoned (`{disabled:true}`)
  in the Blobs `staff` store so removal works at runtime without a redeploy.

Guards: you can't remove yourself, and you can't remove or demote the **last admin**.
`staffLookup` honors tombstones, so a removed member is denied at the next request even
if still listed in `STAFF_ALLOWLIST` env. A new member's first email-OTP login is their
"registration"; the allowlist entry is what authorizes them.

## Order sources — FOS (Unolo) + dealer (Dealer OS)

Orders now enter from two origins, both normalized by `_ingest.mjs::buildOrder` into
one shape (only `source` / `placedBy` differ), so everything downstream — credit,
serialize, invoice, dispatch, notifications — is identical:

- **`source:'unolo'`** — a field officer books in the Unolo app. Arrives via the
  scheduled `unolo-poll` (Zoho draft SOs) or the opt-in `unolo-inbound` webhook.
  Routed by exec→pincode; `placedBy` = the FOS.
- **`source:'dealer'`** — a dealer self-orders in Dealer OS (rewards.eronix.in). The
  dealer is already authenticated there, so Dealer OS posts to the opt-in
  `dealer-inbound` webhook (id prefix `ERX-D-`, carries the Zoho `contactId`), **or**
  creates a Zoho draft SO tagged `DEALER_SOURCE_TAG` for the poll to pick up. No FOS,
  so routed by the dealer's pincode/city; `placedBy` = the dealer.

The poll tells them apart by `cf_source` (`UNOLO_SOURCE_TAG` / `DEALER_SOURCE_TAG`);
set `ORDER_SOURCE_STRICT=1` to ignore SOs without a known tag. On invoice, the dealer
and warehouse are always notified; the sales rep is notified for FOS orders and
skipped for dealer self-orders (no rep). The desk shows a source badge (FOS · Unolo /
Dealer OS) on each order row and in the drawer.

New env: `DEALER_WEBHOOK_ENABLED`, `DEALER_WEBHOOK_SECRET`, `DEALER_SOURCE_TAG`
(default `DealerOS`), `ORDER_SOURCE_STRICT` (optional).

## Accounts decisions — four actions + CTA notification loop

At credit review the accountant has four actions, each a guarded transition that fans
out an email loop to **dealer + FOS + warehouse** (`_notify.mjs::sendDecisionEmails`,
parallel, best-effort, non-fatal):
- **Approve** → `CREDIT_OK` (warehouse: "ready to pick").
- **Edit & Approve** (`editApprove`) → the payload is the desired final line set, diffed
  against the order, so the accountant can adjust qty/rate, **add a new SKU** (e.g. one the
  dealer phoned in), or **drop a SKU** in one step. Totals/GST recompute; → `CREDIT_OK`.
  The emails carry the change diff (added / qty·rate change / removed). New lines should
  reference a real Zoho item (`itemId`) so the eventual invoice line resolves.
- **Hold** → `HELD` with a captured reason (warehouse: "do not pick").
- **Reject** → `REJECTED` with a reason; reserved stock released (warehouse: "cancelled").

For a dealer self-order there's no FOS, so the FOS email is skipped (the dealer is
notified directly). New guards stop hold/reject from firing after invoicing. The UI for
all four lives in the **light** portal (`index-light.html`); the backend serves both
portals, so Approve/Hold/Reject from the dark portal also trigger the loop.

## Delivered / fulfilment + accountant visibility

The post-invoice tail (INVOICED → DISPATCHED → DELIVERED) is now visible to **accounts**,
not just warehouse: `ACCOUNTS` scope includes those statuses, and the light portal adds a
separate **Fulfilment** nav item + filter (`fulfil` = INVOICED/DISPATCHED/DELIVERED) so
they stay out of the review queue. The accountant's drawer for those orders is a read-only
fulfilment panel (invoice + courier/AWB) with a **Mark delivered** action (optional
proof-of-delivery note) on dispatched orders — completing the lifecycle.

`deliver` is now allowed for **both** accounts and warehouse (array-valued `ACTION_ROLE`,
gate updated), guarded to `DISPATCHED → DELIVERED`, and records `deliveredAt` + an optional
`deliveryNote`. The source badge was also restyled to a subtle dot+label ("Unolo" /
"Dealer OS") and removed from the drawer header (it was redundant with the meta line).


## Timeline timestamps

Every order carries a `stamps` map (status → epoch ms). `orders.mjs` writes `stamps[newStatus]=now` on each transition, and `_ingest.buildOrder` seeds `stamps.NEW`. The Progress timeline (both portals) renders a date + time line under each completed step via `fmtStamp` (e.g. "27 Jun 2026 · 4:54 pm"). Demo orders synthesise realistic per-stage stamps from `createdAt`.


## Serial-capture UX (light)

Redesigned for clarity: one primary field that takes **units and cartons** (MC/OC auto-detected) with a quiet caption; the sealed-carton range tool is behind a "Damaged carton label?" disclosure; the two info boxes are collapsed into a single expandable "How scanning works" with a unit/OC/MC code legend; decorative glyphs removed; the random Auto-fill is demo-only ("Fill all"), while the real range-fill fallback remains in both modes. All scan/serial handler IDs are unchanged.
