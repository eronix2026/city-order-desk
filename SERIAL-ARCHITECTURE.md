# ERONIX Serial-Number Architecture — MC ▸ OC ▸ Primary

Three packaging levels, three code namespaces. The namespace classifies the level
instantly (no lookup); a GS1 mod-10 check digit guards every code against mis-keys.

## Canonical machine form (Code 128, uppercase, no separators)

| Level | Format | Example | Len |
|---|---|---|---|
| **Primary unit** | `ERX` `<ITEM4>` `<YYWW>` `<SEQ7>` `<C>` | `ERXEUAN262700012343` | 19 |
| **Outer carton (OC)** | `OC` `<ITEM4>` `<YYWW>` `<SEQ5>` `<C>` | `OCEUAN2627000123` | 16 |
| **Master carton (MC)** | `MC` `<ITEM4>` `<YYWW>` `<SEQ4>` `<C>` | `MCEUAN262700014` | 15 |

**Fields**
- **Namespace** — `ERX` / `OC` / `MC`. Tells the scanner the level with no database hit.
- **ITEM4** — 4-char product code mapping to the Zoho item (e.g. `EUAN` = Euphoria ANC,
  `GN65` = GaN³ 65W). Human-readable; the authoritative SKU↔item link stays in the
  Zoho items sync.
- **YYWW** — year + ISO week of manufacture. Batch traceability and FIFO.
- **SEQn** — zero-padded running sequence, unique within item + week. 7 digits per unit
  (10M/week), 5 per OC, 4 per MC.
- **C** — GS1 mod-10 check digit over the numeric data (YYWW+SEQ). Catches transposition
  and single-digit mis-scans beyond Code 128's own symbol checksum.

**Human-readable label** may hyphenate for the eye (`ERX-EUAN-2627-0001234-3`); the
**barcode encodes the compact form** above.

## The hierarchy is a mapping, not embedded in the code

A carton code does **not** contain its children. The parent→child links
(MC → [OC] → [primary S/N]) are captured at packing time and stored as an
**aggregation** table (`POST /aggregation`). Scanning a parent looks up its children
and explodes down to the primaries. This is the GS1 *aggregation* concept and lets
a carton be re-packed or split without reprinting unit labels.

## Capture rules (encoded in the desk)
- **Master carton** — scanned only when **intact and taken whole**; a half-emptied or
  oversized MC is refused and the operator scans its **outer cartons**.
- **Outer carton** — captures its available units, capped to what the order line needs.
- **Primary unit** — scanned individually for the remainder.

## Zoho boundary — primaries only

**Zoho only knows the primary serial.** MC/OC labels exist solely in the order desk's
aggregation map and are **never** sent to Zoho. Every carton scan is exploded to its
primary serials first; only those are validated against Zoho's in-stock pool and
written onto the invoice. Two guards enforce this even against direct API calls:
- `orders.mjs` (`serialize`) rejects any code that classifies as a carton, and requires
  a valid primary (format + check digit).
- `_zoho.mjs` (`createInvoiceWithSerials`) calls `assertPrimaries()` and refuses to post
  if any serial is not a clean primary.

## GS1-standard target (for export / organised retail)

When you need full GS1 compliance (exports, modern-trade DCs, EPCIS):
- **Primary** → GTIN (AI `01`) + Serial (AI `21`) in a **GS1 DataMatrix**.
- **OC & MC** → **SSCC** (AI `00`, 18 digits) in **GS1-128** — both are logistics units.
- **Hierarchy** → EPCIS aggregation events (SSCC ↔ contents).
The in-house scheme above maps cleanly onto this later: ITEM4→GTIN, the namespaces→SSCC,
the aggregation table→EPCIS, with the GS1 mod-10 check digit already in place.

## Reference

`_serial.mjs` is the single source of truth: `PRIMARY_RE` / `OC_RE` / `MC_RE`,
`gs1Check`, `classify`, `isPrimary` / `isCarton`, `assertPrimaries`, and reference
generators `genPrimary` / `genOC` / `genMC` for a label-printing utility.

## Capture: explosion, made cheap by ranges

Explosion (scan a carton → expand to its primaries) is the backbone — it records
what was actually packed, so it survives non-contiguous fills, swaps, QC pulls and
returns, and it fails loudly at the desk. Blind generation ("first S/N + qty,
fabricate the rest") is deliberately NOT the default: it asserts contents instead of
recording them, and a fabricated serial passes the check digit and can even be
in-stock while sitting in a different box — a silent error in the exact data the
system exists to protect.

To remove explosion's only real cost (per-unit packing scans), a carton may be
captured as a **range** instead of an enumerated list:

```
POST /aggregation { cartons: [ { mc, ocs: [ { oc, start: "ERX…", count: 24 } ] } ] }
```

`expandRange(start, count)` walks the SEQ (ITEM and YYWW batch fixed) and recomputes
each check digit. The result is identical to importing an explicit list — same unit
rows, same reverse index, same status lifecycle.

**The safety rail is the same in every case:** every expanded serial is validated
against the Zoho in-stock pool and reserved at serialize. So a range that isn't
actually contiguous is caught at pick time, not in the field.

**Manual fallback (warehouse):** for a damaged carton label, the picker can enter the
first S/N and quantity; the desk expands the run and routes each unit through the
normal scan validation, stopping at the first unit that isn't in stock. It's a
flagged fallback, never the default — the picker's job stays "scan and let the system
verify," not "assert the contents from one label."
