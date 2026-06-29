# City Order Desk — End-to-End Test Plan

Work top to bottom. **Phase A** needs zero setup (demo mode). **Phases B–E** need a
real Netlify + Zoho deploy. Tick each box; note anything that fails in the right-hand
space. The single highest-value check is **D-4** (serials actually on the Zoho invoice)
— it can look correct while being wrong, so verify it directly.

Legend: `[ ]` to do · `[x]` pass · `[!]` fail (note it) · ⎯ = expected result.

---

## Phase A — Demo walkthrough (no backend, `DEMO_MODE=true`)

Open `index.html` (or `index-light.html`) locally. Everything runs in-browser.
Camera scanning needs HTTPS, so it's covered later in **D-3**.

- [ ] **A-1 Load.** Desk opens with seeded orders; stats and queue render. ⎯ no console errors.
- [ ] **A-1b Order source.** Some rows show a **FOS · Unolo** badge, others **Dealer OS**. Open one of each → drawer shows "via <rep>" for FOS vs "placed by <dealer>" for a dealer self-order; the timeline's first step reads "Booked in Unolo" vs "Placed via Dealer OS".
- [ ] **A-2 Login + persona (demo).** With `DEMO_LOGIN=true`, the login screen shows: enter any email → any 6-digit code → pick **Accounts** or **Warehouse** + a city → you land in that person's desk (role switcher hidden, like production). Demo **Sign out** re-opens the login *without resetting data*, so you can keep the same city and switch role to follow one order accounts→warehouse. (Set `DEMO_LOGIN=false` for free role-switching instead.)
- [ ] **A-3 Credit — approve.** Open a `NEW` order → credit block shows → Approve. ⎯ status → `CREDIT_OK`.
- [ ] **A-4 Credit — hold / reject.** On other orders, Hold and Reject. ⎯ `HELD` / `REJECTED` branches.
- [ ] **A-4b Four actions + loop (light).** On a `NEW` order the accounts drawer shows **Approve · Edit & Approve · Hold · Reject**. Hold/Reject open a reason box (required). **Edit & Approve** opens an editable line table — change qty/rate, press ✕ to drop a line, or use the **+ Add line** picker to add a catalogue SKU the dealer asked for — with a live new total → "Approve with changes". The decision email's diff shows added / changed / removed lines. Each action toasts that the dealer, FOS & warehouse were notified.
- [ ] **A-5 Serialize — type.** On a `CREDIT_OK` order, type a sample serial. ⎯ green (valid) / red (invalid) check.
- [ ] **A-6 Serialize — auto-fill.** Use **Auto-fill**. ⎯ line completes to qty.
- [ ] **A-7 Serialize — range fill.** Enter a first S/N + qty → **Fill**. ⎯ run expands, each verified; stops on a bad one.
- [ ] **A-8 Carton — whole MC.** Scan the demo master-carton chip (fits). ⎯ explodes to all its units.
- [ ] **A-9 Carton — opened/oversized MC.** Scan an MC bigger than the line. ⎯ refused → "scan outer cartons (OC)".
- [ ] **A-10 Carton — OC partial.** Scan an OC chip. ⎯ captures its units, capped to remaining qty.
- [ ] **A-11 Duplicate guard.** Re-enter a serial already on the order. ⎯ rejected as duplicate.
- [ ] **A-12 Submit serials.** Complete all lines → submit. ⎯ status → `SERIALIZED`.
- [ ] **A-13 Invoice (demo).** As accounts, raise invoice. ⎯ status → `INVOICED`.
- [ ] **A-14 Dispatch → Deliver.** ⎯ `DISPATCHED` → `DELIVERED`; timeline shows actor + stage for each.
- [ ] **A-14b Accountant fulfilment.** As **Accounts**, the **Fulfilment** filter lists INVOICED/DISPATCHED/DELIVERED orders (separate from the review queue). Open a `DISPATCHED` one → read-only courier/AWB + a **Mark delivered** button with an optional POD note → `DELIVERED` closes the lifecycle. An INVOICED one shows "awaiting dispatch"; the source badge is a subtle dot + label, not a big pill.
- [ ] **A-15 Gating.** Try to invoice before full serials / dispatch before invoice. ⎯ blocked.
- [ ] **A-16 Packing station** (`packing.html`). Scan units→OC→MC, commit. ⎯ "units mapped" confirmation.
- [ ] **A-17 Bulk import.** Add an MC with one OC by **range** and one by **pasted list** → Validate → Import. ⎯ preview counts, then success.
- [ ] **A-18 Look up.** Look up a unit → returns OC/MC; look up the MC → state pill (intact/opened/empty) + per-OC counts.
- [ ] **A-18b Staff panel** (`packing.html` → Staff). Add a member (email/name/role/city) → appears in the list; Edit changes role/city; Remove deletes it. Try to remove the only **admin** → blocked; try to remove yourself → blocked.
- [ ] **A-19 Light variant.** Repeat a short flow in `index-light.html`. ⎯ readable, same behavior.
- [ ] **A-20 Responsive.** Shrink window. ⎯ mobile hamburger + drawer work.

---

## Phase B — Pre-flight for the live run (setup, do once)

- [ ] **B-1 Domain.** Site on `orders.eronix.in` via CNAME on the `orders` subdomain (never the apex).
- [ ] **B-2 Core env vars.** `SESSION_SECRET`, `OTP_SECRET`, `ZOHO_REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET/ORG_ID`, `RESEND_API_KEY`.
- [ ] **B-3 Allowlist.** `STAFF_ALLOWLIST` has ≥1 **accounts**, ≥1 **warehouse**, ≥1 **admin**, all in one test city.
- [ ] **B-4 Optional env.** `UNOLO_SOURCE_TAG`, `REP_DIRECTORY`, `DEFAULT_CITY`, `PICK_STALE_HOURS` as needed.
- [ ] **B-5 Zoho field keys (open audit item).** With one sandbox call confirm: invoice line-item `serial_numbers` key **and** the `reference_number` list filter. ⎯ do this before trusting D-4.
- [ ] **B-6 Seed stock.** Receive the test units in Zoho (bill / opening stock) so their serials are in the **available pool**. *(Most common blocker — a serial not in the pool is rejected at serialize.)*
- [ ] **B-7 Build carton map.** In `packing.html` (as admin) map the exact serials from B-6 into their OCs/MC.
- [ ] **B-8 Flip demo off.** `DEMO_MODE=false` in `index.html` **and** `packing.html`; bump SW cache; deploy.
- [ ] **B-9 Schedules.** Confirm `unolo-poll` and `reconcile` are registered in Netlify.

---

## Phase C — Live smoke tests (per component)

- [ ] **C-1 OTP login.** Request OTP → email arrives → verify → in. ⎯ `auth-me` returns your role/city.
- [ ] **C-2 Live deauth.** Remove yourself from `STAFF_ALLOWLIST` → next action. ⎯ 401 immediately (not at token expiry).
- [ ] **C-3 Role gate.** As warehouse, try Approve → 403. As accounts, try Serialize → 403.
- [ ] **C-4 City gate.** As a city-A user, confirm city-B orders are not visible/actionable.
- [ ] **C-5 Ingestion — FOS.** Create a Zoho SO tagged `UNOLO_SOURCE_TAG` → poll (≤5 min). ⎯ appears in the correct city `NEW` with a FOS source.
- [ ] **C-5b Ingestion — dealer.** POST a dealer order to `dealer-inbound` (with `DEALER_WEBHOOK_ENABLED=1` + secret), **or** create a Zoho SO tagged `DEALER_SOURCE_TAG`. ⎯ appears as `ERX-D-…`, `source:dealer`, routed by the dealer's pincode, `placedBy` = dealer.
- [ ] **C-6 Ingestion — routing fallback.** SO with an unmapped pincode. ⎯ lands in `DEFAULT_CITY`, flagged `needsRouting`.
- [ ] **C-7 Ingestion — validation.** SO with a junk line (qty 0 / no SKU). ⎯ line dropped (or SO skipped if no valid lines).

---

## Phase D — Full live pipeline (one order, end to end)

- [ ] **D-1 Ingest.** Order arrives → `NEW`.
- [ ] **D-2 Approve.** Accounts approve → `CREDIT_OK`.
- [ ] **D-3 Scan on a phone (HTTPS).** Warehouse scans the carton with the camera → explodes to primaries, each validated against the **real Zoho pool** → `SERIALIZED`.
- [ ] **D-4 Invoice + verify serials (critical).** Accounts raise invoice → **open the invoice in Zoho and confirm the serial numbers are attached**. ⎯ pool refreshed, aggregation status → `invoiced`, status `INVOICED`.
- [ ] **D-5 Notifications.** ⎯ three emails arrive: **dealer**, **sales rep**, **warehouse** (city staff).
- [ ] **D-2b Decision emails (live).** On Approve / Edit & Approve / Hold / Reject, confirm the dealer, FOS and warehouse each receive the matching email (Edit & Approve includes the change diff; Hold/Reject include the reason). A dealer self-order skips the FOS mail.
- [ ] **D-6 Dispatch → Deliver.** Add courier/AWB → `DISPATCHED` → mark `DELIVERED`.

---

## Phase E — Negative & robustness checks

- [ ] **E-1 Reject releases stock.** Reject a serialized order → look its serials up in `packing.html`. ⎯ back to `in_stock`.
- [ ] **E-2 Double-ship guard.** Put the same serial on a second order. ⎯ blocked (reservation conflict; Zoho also rejects at invoice).
- [ ] **E-3 Carton to Zoho.** Scan an OC/MC label at **serialize**. ⎯ rejected — only primaries reach Zoho.
- [ ] **E-4 Bad serial.** Scan a tampered / check-digit-fail code. ⎯ rejected.
- [ ] **E-5 Invoice idempotency.** Invoice the same order twice / replay. ⎯ no duplicate Zoho invoice (adopts existing).
- [ ] **E-6 Reconcile.** Set `PICK_STALE_HOURS` low, leave an order mid-pick. ⎯ next reconcile releases its reservations, reverts to re-pickable.
- [ ] **E-7 Webhook off.** With `UNOLO_WEBHOOK_ENABLED` unset, POST the webhook. ⎯ 410 disabled.
- [ ] **E-8 Demo guard.** A `DEMO_MODE=true` build on the prod host. ⎯ red warning banner.
- [ ] **E-9 Poll abuse.** Hit `unolo-poll` URL twice quickly. ⎯ second returns "recently polled" (no double work).

---

## Sign-off

| Phase | Tester | Date | Result | Notes |
|---|---|---|---|---|
| A — Demo | | | | |
| B — Pre-flight | | | | |
| C — Smoke | | | | |
| D — Pipeline | | | | |
| E — Negative | | | | |

**Blockers found:**

1.
2.
3.
