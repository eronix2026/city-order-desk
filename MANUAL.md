# ERONIX City Order Desk — Complete Manual

*Operator & administrator guide. Covers every screen, action, state, and rule in the portal.*

---

## 1. What the Order Desk is

The City Order Desk is the internal back-office portal where ERONIX staff turn an incoming dealer order into a dispatched, delivered, invoiced shipment. It sits between two order sources and Zoho Inventory:

- Orders arrive either from a **field officer using the Unolo app** or from a **dealer placing it themselves in Dealer OS**. Once inside the desk they look identical — only their origin badge differs.
- Two desks process every order: **Accounts** (review, approve, invoice, e-way bill) and **Warehouse** (pick, serialize, dispatch, deliver).
- Zoho Inventory is the financial system of record (invoices, serials, the dealer ledger). The desk's own store is the system of record for the order's *lifecycle*.

The portal is a Progressive Web App: it installs to a phone or desktop, works offline for scanning, and runs on `orders.eronix.in` in production.

---

## 2. Core concepts

**Roles.** Every signed-in user is either **Accounts** or **Warehouse**. The role is fixed by the staff allowlist — you cannot give yourself a role or switch cities. Accounts handles money and approvals; Warehouse handles physical goods.

**Cities.** Every order is routed to a city desk (Kolkata, Mumbai, Delhi, Bangalore, Chennai by default), each with its own Accounts and Warehouse staff and a named warehouse (e.g. Kolkata → Howrah WH). You only ever see and act on **your** city's orders.

**Origin.** An order is either `Unolo` (booked by a field officer) or `Dealer OS` (self-placed by the dealer). The queue shows a small badge for each. The workflow afterwards is the same.

**The desk vs Zoho.** The desk drives the lifecycle (review → pick → invoice → dispatch → deliver). When an invoice is raised, the desk writes it — with serial numbers — into Zoho. The dealer's outstanding ledger is read back from Zoho.

---

## 3. The order lifecycle

Every order moves through a strict, gated state machine. You can never skip a step, and most steps can't be undone except by an explicit revoke. The internal state, the label you see, and what it means:

| State (internal) | Label shown | Whose action | Meaning |
|---|---|---|---|
| `NEW` | **New** | Accounts | Just arrived, awaiting first review |
| `ACCOUNTS_REVIEW` | **In review** / **Reopened** | Accounts | Being reviewed, or pulled back after a revoke |
| `HELD` | **On hold** | Accounts | Paused with a reason; warehouse must not pick |
| `REJECTED` | **Rejected** | — (terminal) | Not approved; reserved stock released |
| `CREDIT_OK` | **Approved** | Warehouse | Cleared by accounts; queued to pick |
| `PICKING` | **Serializing** | Warehouse | Warehouse is capturing serial numbers |
| `SERIALIZED` | **Awaiting invoice** | Accounts | All serials captured; ready to invoice |
| `INVOICED` | **Invoiced** | Warehouse | Zoho invoice raised; ready to dispatch |
| `DISPATCHED` | **Dispatched** | Warehouse | Shipped with courier + tracking |
| `DELIVERED` | **Delivered** | — (terminal) | Proof-of-delivery on file |

**Reopened** is a visible sub-state of `ACCOUNTS_REVIEW`: an order that was approved (or further) and then revoked back for changes. It shows an amber ⟲ pill and remembers what stage it came back from and why.

---

## 4. Signing in

The desk uses **passwordless sign-in**:

1. Enter your work email (e.g. `you@eronix.in`) and tap **Send sign-in code**.
2. A 6-digit code is emailed to you. It expires in 10 minutes; you can request a new one after 30 seconds.
3. Enter the code and tap **Verify & sign in**.

You stay signed in for 12 hours. Your role and city come from the staff allowlist, not from anything you type. Signing out invalidates your session immediately on the server, not just in the browser.

*(In demo/preview the login screen also offers a persona picker to sign in as Accounts or Warehouse without a code. On the production host this is disabled automatically — real codes are required.)*

---

## 5. The portal at a glance

The portal has three areas:

- **Left navigation** — your role's filters (each with a live count), a role indicator, and — when relevant — the red **Needs attention** tab. There's also a city label/switcher and your identity.
- **Centre — the queue.** A titled list ("Accounts queue" / "Warehouse queue") of orders for your city and role, each row showing the dealer, value, order id, unit/SKU counts, origin, status pill, any flags, and age. Tap a row to open it.
- **Stats strip.** A small set of live counters tailored to your role (see below).

**Accounts stats:** New · On hold · Ready to invoice · Invoiced · Shipped.
**Warehouse stats:** To pick & serialize · Serializing · Awaiting invoice · To dispatch · Dispatched.

---

## 6. Filters (the left nav)

Filters narrow the queue. Counts update live.

**Accounts:** All orders · Awaiting review · Approved · Ready to invoice · On hold · Fulfilment.
**Warehouse:** All orders · To pick & serialize · Awaiting invoice · To dispatch · Dispatched.

**Needs attention** appears (in red, second slot) for either role only when one or more orders are flagged. See §11.

---

## 7. The order drawer

Tapping any order opens a side drawer with everything about it. The header shows the dealer name, order id, origin (Unolo + its id, or "Dealer self-order"), dealer code, GSTIN, who placed it, age, and the total with unit count. Below that the drawer adapts to the order's state and your role, and always ends with a **timeline** of every event with timestamps.

The exact sections you see depend on the stage — the workflows below walk through each.

---

## 8. Accounts — full workflow

### 8.1 Review a new order & the ledger

Open a `New` or `In review` order. You'll see the order lines (product, qty, rate, amount, subtotal, GST @ 18%, total) and the **Ledger — pending invoices** block. This is the credit control: ERONIX clears an order only when the dealer has settled prior invoices.

The ledger block has three possible states:

- **Clear** (green ✓) — no pending invoices; cleared to approve.
- **Pending** (red ⚠) — a table of open invoices with due dates, balances, and overdue badges, plus the total outstanding. The guidance is to collect in full before clearing.
- **Unavailable** (amber ?) — the settlement data hasn't synced from Zoho. The desk deliberately does **not** say "clear" here; it tells you to verify the dealer's open invoices in Zoho before approving. (This prevents a data gap being read as "all good.")

The ledger is **advisory** — it informs you, it doesn't hard-block approval — so you retain judgement, but the queue and drawer flag the risk.

### 8.2 Approve

If you're satisfied, **Approve** the order. It moves to `Approved` (CREDIT_OK) and drops into the warehouse queue to be picked and serialized. The dealer, the field rep, and the warehouse are notified.

### 8.3 Edit & approve

You can adjust quantities, rates, or remove/add lines before approving. The desk records exactly what changed and approves with revisions; the recipients' emails include a "what changed" table, and the order is marked as edited.

### 8.4 Hold

**Hold** pauses an order with a reason (e.g. "Pending invoices unsettled"). It moves to `On hold`, the warehouse is told not to pick, and the dealer/rep are notified with the reason. You can later approve or reject it.

### 8.5 Reject

**Reject** declines the order with a reason. This is terminal — any reserved stock is released, and the dealer/rep/warehouse are notified. A rejected order can't be revived; the dealer must place a new one.

### 8.6 Revoke & reopen (pull a pre-dispatch order back)

If something needs changing *after* approval but *before* dispatch, **Revoke approval & reopen**. This works on `Approved`, `Serializing`, `Awaiting invoice`, and `Invoiced` orders. Revoking:

- Releases any captured/reserved serials back to stock.
- If the order was already invoiced, **voids the Zoho invoice first** — and if that void fails, the whole revoke is aborted so the desk and Zoho never disagree. (Revoking an invoiced order asks for explicit confirmation.)
- Returns the order to `In review` as **Reopened**, remembering the stage it came from, the reason, and how many times it's been revoked.

You then re-edit and re-approve. The timeline pins every revoke event permanently, so the history is auditable even after re-approval.

### 8.7 Raise invoice

Once the warehouse has captured all serials, the order shows as `Awaiting invoice`. Open it and **Raise invoice**. You can supply an invoice number or leave it blank for Zoho to auto-generate. The desk posts the invoice to Zoho **with the serial numbers attached**, idempotently (a retry won't double-post). The order moves to `Invoiced`, and the dealer, rep, and warehouse are emailed.

### 8.8 E-way bill

If the consignment value (incl. GST) exceeds the e-way threshold (₹50,000 by default), an **e-way bill is mandatory before dispatch** and the desk hard-gates it. After invoicing, the e-way block asks for:

- **E-way bill number** (12 digits)
- **Approximate distance (km)** — drives validity (1 day per 200 km)
- **Transporter**
- **Vehicle number** — optional at ≤ 50 km (Part A only); **mandatory over 50 km** (Part B)
- Mode (Road, etc.)

Once recorded, the order can be dispatched; the e-way number and validity appear on the timeline and in the fulfilment view. Below the threshold, the block simply states no e-way bill is required.

> Admin note: the desk *records* the e-way number you enter; it does not yet generate it via the NIC portal. The threshold is configurable.

### 8.9 Fulfilment view

For `Invoiced`, `Dispatched`, and `Delivered` orders, the accounts drawer shows a read-only fulfilment summary: invoice, e-way details, dispatch courier + tracking, and (once delivered) the proof of delivery.

---

## 9. Warehouse — full workflow

### 9.1 Pick & serialize

Approved orders appear in the warehouse queue as **To pick & serialize**. Open one and, for each SKU line, scan or type the serial numbers of the physical units. The order moves to `Serializing` as you go, and a per-line progress counter shows captured vs required (e.g. "12 / 20"). When every line is fully serialized, the order becomes `Awaiting invoice` and goes back to accounts.

The scanner uses a self-hosted Code 128 engine that works offline, with camera capture on mobile. Every serial is validated for shape and against the available stock pool (see §13), so a wrong, duplicate, or already-shipped serial is rejected at the point of scan.

### 9.2 Dispatch

Once accounts have invoiced (and recorded the e-way bill if required), the order shows as **To dispatch**. Before you can mark it dispatched you must capture:

- **Dispatch type** — Hyperlocal, Interstate (default), or International.
- **Service provider** — chosen from a curated list for that type (or "Other"):
  - *Hyperlocal:* Uber, Porter, Rapido, Dunzo, Shadowfax, Borzo
  - *Interstate:* Delhivery, BlueDart, DTDC, Ekart, VRL Logistics, Gati, Safexpress
  - *International:* DHL, FedEx, UPS, Aramex, India Post EMS
- **Reference** — the tracking id appropriate to the type (an order/trip ID for hyperlocal, an AWB/LR number otherwise).

All three are mandatory; the desk blocks dispatch until they're present. If an e-way bill was required and isn't on file, dispatch is blocked with a clear message. On success the order becomes `Dispatched`.

### 9.3 Proof-of-delivery (deliver)

Marking an order **Delivered** requires uploading a **proof of delivery** — a photo or PDF of the stamped receipt / signed invoice (camera capture on mobile). The desk:

- Accepts only images or PDF, up to ~6 MB, and verifies the file's actual content matches its type (a disguised file is rejected).
- Stores it securely; every later view of a POD is access-audited.

Without a POD, the order cannot be delivered. Once delivered, the order is complete and the POD is viewable from the fulfilment view.

---

## 10. Order origins — Unolo vs Dealer OS

- **Unolo** orders are pushed by a field officer's app the moment they tap send. They carry the executive's name; routing is by the dealer's city/pincode.
- **Dealer OS** orders are self-placed by the dealer in their portal and arrive with the dealer's own identity and Zoho contact.

Both are validated (valid GSTIN, real order lines) on arrival, de-duplicated by order id, and notified to the city's accounts inbox. Inbound is authenticated; with signing enabled it's also tamper- and replay-proof.

---

## 11. Needs attention (exceptions)

This red tab surfaces orders that are **stuck** or have **silently failed**, so nothing slips through. It appears only when there's something to act on, scoped to your role's stages.

**Operational faults** flag immediately (red):
- *Revoke/void incomplete* — a revoke didn't finish voiding its Zoho invoice.
- *Notification failed* — an email to a party errored.
- *Post-invoice sync pending* (amber) — Zoho bookkeeping hasn't converged.

**Time-based staleness** flags an order sitting too long where someone owes an action: New / Awaiting-review and Ready-to-invoice at 8h, On-hold at 48h, the pick/dispatch stages at 24h. Amber past the threshold, red past double it. Finished orders (Dispatched/Delivered/Rejected) never flag.

Flagged orders also show a coloured pill (with the reason) and a left accent stripe in the main queue. A scheduled job additionally writes an exceptions snapshot and can email a once-daily digest to an ops address, so stuck orders are caught even if nobody opens the portal.

---

## 12. What the dealer sees (Dealer OS timeline)

Regardless of origin, the dealer can see their order's full timeline in Dealer OS — placed → approved/held/rejected/reopened → packed → invoiced → e-way → dispatched → delivered — each step with its reason and time. The desk exposes a dealer-safe view that strips serials, the credit ledger, staff identities, and internal ids. Dealers only ever see their own orders, by GSTIN.

---

## 13. The serial number system

ERONIX serials are structured and self-checking. There are three kinds:

- **Primary (unit) serial** — `ERX` + 4-char item code + 12 digits (year-week + sequence + check digit). Example shape: `ERXEUAN260000123456C`. **Only primary serials are written to Zoho.**
- **Outer carton (OC)** — `OC` + item + 10 digits.
- **Master carton (MC)** — `MC` + item + 9 digits.

Each carries a GS1-style check digit, so a mistyped or fabricated serial fails validation instantly. The 4-char item code maps to the SKU (e.g. `EUAN` = Euphoria ANC, `GN65` = GaN 65W). During serializing, scanning an outer or master carton can expand to its contained unit serials.

Serials are tracked in ERONIX's own stock pool as a single lifecycle record per unit: `in_stock → reserved → consumed`. Reserving on serialize, releasing on revoke/rejection, consuming on invoice. The available pool is cached briefly from Zoho and fails closed (if stock can't be confirmed, the scan is rejected rather than risk a diversion).

---

## 14. The Aggregation / Packing desk (admin)

`packing.html` is a separate admin tool for building stock: registering master/outer cartons and the unit serials inside them, so that when those units are later scanned on an order they're already known to the pool. It mirrors the same serial rules as the order desk. It's an admin surface, always served fresh, and (like the main portal) cannot run in demo mode on the production host.

---

## 15. Demo mode

Demo mode runs the whole portal in-memory with synthetic dealers, catalog, and orders — for previews and training. It's **hostname-gated**: on the production host (`orders.eronix.in`) it is forced off automatically, so a forgotten flag can never ship a fake-data, sign-in-bypassed desk. In demo you can switch role/city freely and use the persona picker; in production, real OTP sign-in and the live API are enforced.

---

## 16. Administration

**Staff allowlist.** Who can sign in, and their role + city, is governed by the staff allowlist — an environment list, overridable per-email in a `staff` store (with a "disabled" tombstone to remove someone instantly). Removing or changing a staff member takes effect on their very next request, not at token expiry.

**Key environment settings** (set in Netlify):
- `SESSION_SECRET` — signs session cookies (rotating it logs everyone out).
- `STAFF_ALLOWLIST` — JSON of `email → {name, role, city}`.
- `ZOHO_*` — refresh token, client id/secret, org id, India DC bases.
- `RESEND_API_KEY`, `NOTIFY_FROM` — outbound email.
- `UNOLO_WEBHOOK_SECRET` / `DEALER_WEBHOOK_SECRET` — inbound order auth; `*_SIGNING_SECRET` to enable HMAC replay-protection.
- `DEALER_BRIDGE_SECRET` — the dealer-timeline read bridge (separate from the webhook secret).
- `EWAY_THRESHOLD` — the e-way value threshold (default ₹50,000), served to the portal so front and back never drift.
- `OPS_ALERT_EMAIL` — recipient of the daily exceptions digest.
- `PICK_STALE_HOURS`, `SESSION_TTL_HOURS`, `DEFAULT_CITY`, `PORTAL_URL`.

**Infrastructure rule.** Only the `orders` / `rewards` subdomains may be added to Netlify (never the `eronix.in` apex), to avoid a TLS/Wix deadlock.

---

## 17. How the desk protects you (security & integrity)

- **No cross-city / cross-role action.** The server enforces your scope on every request; a warehouse user can't act as accounts, and no one acts on another city's orders.
- **Strict gates.** Each transition checks the prior state, so steps can't be skipped or repeated.
- **No lost updates.** If two people act on the same order at once, the second is rejected and told to reload — no silent clobbering.
- **Zoho never diverges.** Invoicing is idempotent; revoking an invoiced order voids it first and aborts if the void fails; an interrupted void is finished by the recovery job.
- **Tamper-proof inbound.** Webhooks check a shared secret and (when enabled) an HMAC signature with a timestamp, so captured requests can't be replayed.
- **No duplicate emails.** Notifications are idempotent per event and recipient.
- **POD integrity.** Uploads are content-checked and access-audited.
- **Real sign-out.** Logout revokes the session server-side; OTP codes are cryptographically generated and rate-limited.

---

## 18. Reliability & recovery

A scheduled housekeeping job runs every 15 minutes and:
- Releases abandoned picks (serials stuck reserved beyond the stale window) back to stock.
- Converges any post-invoice bookkeeping that was deferred.
- Completes any interrupted revoke/void.
- Snapshots stuck/errored orders and (optionally) emails the ops digest.

The portal itself is network-first for its own pages, so a new release is picked up immediately, while still working offline for scanning.

---

## 19. Troubleshooting & FAQ

**The ledger says "Unavailable" — can I still approve?** Yes, but verify the dealer's open invoices in Zoho first. "Unavailable" means the settlement data didn't sync; the desk won't pretend it's clear.

**I can't dispatch — "E-way bill required."** The consignment is over the threshold. Accounts must record the e-way bill (number, distance, transporter, and vehicle if over 50 km) first.

**A serial won't scan.** It failed validation — wrong shape, a bad check digit, a duplicate, or it isn't in available stock. Confirm you're scanning the right unit; build it into the pool via the packing desk if it's genuinely new stock.

**"Order changed elsewhere — reloading."** Someone else acted on this order at the same time. The desk reloaded the latest state; redo your action on the fresh order.

**An order I approved is back in review as "Reopened."** Accounts revoked it to make a change before dispatch. Any invoice was voided and serials released; it will re-clear once adjusted.

**I marked delivered but it won't save.** A proof-of-delivery file is mandatory and must be a genuine image or PDF under ~6 MB.

**Mark delivered / dispatch buttons want extra info.** By design — POD for delivery; type, provider, and tracking reference for dispatch. All are required.

---

## 20. Glossary

- **POD** — Proof of delivery (the receipt photo/PDF).
- **Ledger / clearance** — the dealer's open Zoho invoices; "cleared" means none outstanding.
- **Reopened** — an order revoked back to review after approval.
- **Primary serial** — the per-unit serial; the only kind written to Zoho.
- **OC / MC** — outer-carton / master-carton serials.
- **Part A / Part B** — e-way bill sections; Part B (vehicle) is required over 50 km.
- **Pool** — ERONIX's available-stock record of units.

---

## 21. Quick reference

**Accounts:** review → check ledger → **Approve** (or **Edit & approve** / **Hold** / **Reject**) → wait for serials → **Raise invoice** → record **E-way bill** (if > ₹50,000) → done. Use **Revoke** to pull anything pre-dispatch back for changes.

**Warehouse:** open **To pick & serialize** → scan all serials → (accounts invoice) → **To dispatch:** set type + provider + tracking → **Dispatched** → upload **POD** → **Delivered**.

**Watch the red Needs attention tab** — it only shows up when an order is stuck or a step silently failed, and it's the fastest way to keep the queue clean.
