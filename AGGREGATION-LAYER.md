# Aggregation Layer — MC ▸ OC ▸ Primary (ERONIX's own system of record)

Zoho only knows primary serials. The carton hierarchy — which OC holds which units,
which MC holds which OCs — is **ERONIX's own layer**, sitting beside the order desk.

## Where it's stored
- **Now (deployable):** Netlify Blobs store `aggregation`, indexed in both directions.
- **At scale (target):** Postgres (Supabase/Neon) per `aggregation-schema.sql`.
`_aggregation.mjs` is the access layer; its exported functions are the stable
interface, so moving Blobs → Postgres is a body swap with no caller changes.

## Data model (both directions indexed)
```
unit/{serial} -> { serial, item, batch, oc, mc, status }   reverse: serial → OC, MC
oc/{oc}       -> { oc, mc, item, batch, serials:[…] }        forward: OC → units
mc/{mc}       -> { mc, item, batch, ocs:[…] }                forward: MC → OCs
```
`status`: `in_stock | invoiced | dispatched`.

## API (`aggregation.mjs`, session-gated)
- `GET ?code=ERX…`  → the unit's `{ oc, mc, status }`  (bottom-up: "which OC has this S/N")
- `GET ?code=MC…|OC…` → `{ serials:[…] }`               (top-down explode, used at picking)
- `GET ?mc=MC…`     → `{ state: intact|opened|empty, inStock/total, ocs:[…] }`
- `GET ?oc=OC…`     → the OC's serials
- `POST { cartons:[ { mc, ocs:[ { oc, serials:[…] } ] } ] }`  (admin) → import a packing run

## Lifecycle
- **Born at packing:** units scanned into OCs, OCs into an MC → `POST /aggregation`.
  Import validates every code (serial format + check digit, carton namespaces) and
  derives item/batch from the codes.
- **Consumed at invoice:** `orders.mjs` calls `markUnitsConsumed(serials,'invoiced')`,
  so MC/OC state (half-emptied detection, recall scope) is answered from the map.
- **Zoho boundary:** this layer never sends carton codes to Zoho. Only the exploded
  primaries flow into the serialize/invoice path.
