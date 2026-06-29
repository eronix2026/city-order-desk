# City Order Desk — Infrastructure-Bound Hardening Spec

The audit items below can't be implemented inside this repo because they need an external
service, a sandbox, or platform infrastructure. Each is specified concretely against the
current code so it can be picked up and executed. Ordered by leverage.

---

## A. Confirm the live Zoho field mappings  *(audit #4 — highest leverage, lowest effort)*

**Why.** The serial→invoice integrity gate, the idempotency filter, and the void path are
all coded to Zoho's documented shapes but unverified against the live org. If the serial
field key is wrong, serials *silently* don't attach to the invoice and the anti-diversion
guarantee is void with no error.

**Where.** `netlify/functions/_zoho.mjs` — `createInvoiceWithSerials`, `findInvoiceByReference`, `voidInvoice`.

**Steps.**
1. In a Zoho Inventory **sandbox** org, create one invoice via the API with a `line_items[].serial_numbers` array and confirm the serials land on the invoice (UI + GET).
2. Confirm the search param for idempotency: `GET /invoices?reference_number=<id>` returns the prior invoice (vs. `search_text`/`reference_number_contains`). Adjust `findInvoiceByReference` accordingly.
3. Confirm the void endpoint: `POST /invoices/{id}/status/void` returns 200 and flips status. Confirm whether a filed period requires a **credit note** instead — if so, branch `voidInvoice` to issue one.
4. Confirm `organization_id` is required on every call and that the India DC base (`www.zohoapis.in`) is correct for this org.

**Done when.** A sandbox round-trip attaches serials, finds-by-reference, and voids — all green. No code here changes behavior; it only confirms or corrects three field names.

---

## B. Atomic serial reservation in Postgres  *(audit #6 — the one true remaining race)*

**Why.** `reserveUnits` in `_aggregation.mjs` is read-then-write on Blobs (no compare-and-swap),
so two orders reserving the same serial can both pass the conflict check and double-reserve.
Blobs cannot express an atomic conditional write; a relational `UPDATE … WHERE` can.

**Plan.**
1. Provision Postgres (Neon/Supabase/RDS). Schema already drafted in `aggregation-schema.sql` — apply it; the unit row is `(serial PK, item, batch, status, order_id, reserved_at, …)`.
2. Replace `reserveUnits(serials, orderId)` with a single transaction:
   ```sql
   UPDATE units SET status='reserved', order_id=$1, reserved_at=now()
   WHERE serial = ANY($2) AND (status='in_stock' OR order_id=$1)
   RETURNING serial;
   ```
   If the returned count < requested, ROLLBACK and report the conflicting serials (the ones not returned). This makes double-reservation impossible regardless of concurrency.
3. Mirror `releaseUnits` / `markUnitsConsumed` as `UPDATE … WHERE order_id=$1`.
4. Keep the Blobs pool **cache** (`getAvailablePool`) as-is — it's advisory; the DB is the authority.
5. Backfill: import current Blobs unit rows into Postgres once, then cut over.

**Interface unchanged.** `reserveUnits/releaseUnits/markUnitsConsumed` keep their signatures, so `orders.mjs` and `reconcile.mjs` don't change.

---

## C. NIC e-way bill generation  *(audit #14)*

**Why.** Today the e-way number is *recorded*, not generated — a wrong/fabricated number passes
the shape check. Legal compliance needs the real document.

**Plan.** Integrate a GSP (ClearTax / Masters India / NIC sandbox). On the `eway` action in
`orders.mjs`, after local validation, call the GSP "generate EWB" API with the invoice + transport
details; store the returned EWB number + validity instead of accepting client input. Keep the
current manual-entry path as a fallback behind a flag for when the GSP is down. The gate logic
(threshold, Part-B vehicle rule, dispatch block) already exists and stays.

---

## D. Secret rotation + new secrets  *(operational — do at deploy)*

Rotate everything that has ever passed through a chat or commit, and set the new ones added
during hardening:
- Rotate: `ZOHO_REFRESH_TOKEN`, `ZOHO_CLIENT_SECRET`, `SESSION_SECRET`, `UNOLO_WEBHOOK_SECRET`, `DEALER_WEBHOOK_SECRET`, `RESEND_API_KEY`.
- Set new: `DEALER_BRIDGE_SECRET` (read bridge), `UNOLO_SIGNING_SECRET` / `DEALER_SIGNING_SECRET` (enable HMAC replay-protection on inbound — only once the senders sign), `OPS_ALERT_EMAIL` (exception digest), optionally `EWAY_THRESHOLD`.
- Rotating `SESSION_SECRET` invalidates all live sessions (everyone re-logs-in) — do it in a maintenance window.

---

## E. POD: signed direct upload + malware scan  *(audit #13 remainder)*

In-repo already done: server-side type+size limits, **magic-byte** content check, view-audit,
private no-store serving, retention metadata. Still infra-bound:
- **Direct-to-storage signed upload** for large files: issue a short-lived signed URL (S3/R2/Netlify Blobs signed) so the file bypasses the ~6 MB function-body limit and never transits the function as base64.
- **Malware scan**: pass the stored object through a scanner (ClamAV container / VirusTotal / S3 malware scanning) before marking the POD usable; quarantine on hit.

---

## F. Observability, CI, backups  *(audit #18–20)*

- **Error tracking:** add Sentry (or equivalent) to all functions; emit the failures already
  captured on the order (`notify.errors`, Zoho 5xx, `reconcilePending`, `revokePending`).
- **Metrics/alerts:** dashboard for queue depth, stuck-order count (the reconcile `ops/exceptions`
  snapshot is the source), invoice-write-back failures, webhook 4xx/5xx.
- **CI:** run `node --check` on every function + the portal-script extraction on push; add unit
  tests for the pure functions already isolated this session (`projectForDealer`, `clearanceFor`,
  `finalizeRevoke`, `attentionInfo`, the POD sniff, the webhook HMAC verifier).
- **Backups/PITR:** once on Postgres (B), enable automated backups + point-in-time recovery. Until
  then, schedule a nightly export of the `orders`, `pods`, and `pod-audit` Blobs stores to object
  storage so the system-of-record is recoverable.
- **Retention/compliance:** codify GST record-retention windows (the POD `retainUntil` tag is the
  hook) and a deletion path for dealer/staff PII on request.

---

## Prune task (small, in-repo, optional follow-up)
The `revoked-tokens` and `notify-log` Blobs stores grow slowly. Add a reconcile branch to delete
`revoked-tokens` entries older than the session TTL and `notify-log` entries older than ~30 days.
