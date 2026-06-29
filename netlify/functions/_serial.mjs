// netlify/functions/_serial.mjs  (shared — underscore = not a route)
// ERONIX serial-number architecture for the three packaging levels.
//
// Canonical machine form (Code 128, uppercase, no separators):
//   Primary unit : ERX <ITEM4> <YYWW> <SEQ7> <C>   e.g. ERXEUAN2526000123 4
//   Outer carton : OC  <ITEM4> <YYWW> <SEQ5> <C>   e.g. OCEUAN25260012 3
//   Master carton: MC  <ITEM4> <YYWW> <SEQ4> <C>   e.g. MCEUAN2526001 7
//
//   namespace  ERX / OC / MC  → instantly classifies the level (no lookup)
//   ITEM4      4-char product code (maps to the Zoho item; human-readable)
//   YYWW       year + ISO week of manufacture (batch traceability)
//   SEQn       zero-padded running sequence, unique within item+week
//   C          GS1 mod-10 check digit over the numeric data (catches mis-keys)
//
// GS1-standard target (for export / retail): primary = GTIN(01)+SERIAL(21) in a
// GS1 DataMatrix; OC & MC = SSCC(00) in GS1-128; hierarchy via EPCIS aggregation.
//
// RULE: Zoho only knows the PRIMARY serial. MC/OC labels live only here and must
// be exploded to primaries before anything is sent to Zoho. assertPrimaries()
// enforces that at the Zoho boundary.

export const PRIMARY_RE = /^ERX[A-Z0-9]{4}\d{12}$/;  // 3+4 + (YYWW4 + SEQ7 + C1)=12
export const OC_RE      = /^OC[A-Z0-9]{4}\d{10}$/;   // 2+4 + (YYWW4 + SEQ5 + C1)=10
export const MC_RE      = /^MC[A-Z0-9]{4}\d{9}$/;    // 2+4 + (YYWW4 + SEQ4 + C1)=9

// GS1 mod-10 check digit over a digit string (rightmost data digit weighted 3).
export function gs1Check(s) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += (+s[s.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}
function checkOk(code, dataStart) {
  const digits = code.slice(dataStart);
  return gs1Check(digits.slice(0, -1)) === +digits.slice(-1);
}

// 'mc' | 'oc' | 'primary' | '*_badcheck' | 'unknown'
export function classify(code) {
  const c = String(code || '').trim().toUpperCase();
  if (MC_RE.test(c))      return checkOk(c, 6) ? 'mc'      : 'mc_badcheck';
  if (OC_RE.test(c))      return checkOk(c, 6) ? 'oc'      : 'oc_badcheck';
  if (PRIMARY_RE.test(c)) return checkOk(c, 7) ? 'primary' : 'primary_badcheck';
  return 'unknown';
}
export const isPrimary = code => classify(code) === 'primary';
export const isCarton  = code => { const t = classify(code); return t.startsWith('mc') || t.startsWith('oc'); };

// Extract the embedded fields from any level's code.
export function parseItem(code) {
  const c = String(code || '').toUpperCase();
  if (MC_RE.test(c) || OC_RE.test(c)) return c.slice(2, 6);
  if (PRIMARY_RE.test(c)) return c.slice(3, 7);
  return null;
}
export function parseBatch(code) {
  const c = String(code || '').toUpperCase();
  if (MC_RE.test(c) || OC_RE.test(c)) return c.slice(6, 10);
  if (PRIMARY_RE.test(c)) return c.slice(7, 11);
  return null;
}

// Zoho boundary guard: every serial sent to Zoho must be a valid primary.
export function assertPrimaries(serials) {
  const bad = (serials || []).filter(s => !isPrimary(s));
  return { ok: bad.length === 0, bad };
}

// ---- reference generators (production codes are printed by ERONIX; these mint
//      spec-compliant codes for the demo / for a label-printing utility) ----
export function yyww(d = new Date()) {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return String(d.getFullYear() % 100).padStart(2, '0') + String(week).padStart(2, '0');
}
export function genPrimary(item, seq, ww = yyww()) { const b = ww + String(seq).padStart(7, '0'); return 'ERX' + item + b + gs1Check(b); }
export function genOC(item, seq, ww = yyww())      { const b = ww + String(seq).padStart(5, '0'); return 'OC'  + item + b + gs1Check(b); }
export function genMC(item, seq, ww = yyww())      { const b = ww + String(seq).padStart(4, '0'); return 'MC'  + item + b + gs1Check(b); }

// ---- range expansion: a sealed carton (or a manual "first S/N + qty" entry) is
//      a contiguous run of primaries. Expansion just walks the SEQ; ITEM and the
//      YYWW batch stay fixed. Every expanded serial is still validated downstream
//      against the Zoho pool — expansion never asserts stock by itself.
export function nextSerial(code) {
  if (!isPrimary(code)) return null;
  const c = code.toUpperCase();
  return genPrimary(c.slice(3, 7), Number(c.slice(11, 18)) + 1, c.slice(7, 11));
}
export function expandRange(startCode, count) {
  const n = Number(count);
  if (!isPrimary(startCode) || !(n >= 1)) return [];
  const c = startCode.toUpperCase();
  const item = c.slice(3, 7), ww = c.slice(7, 11), seq0 = Number(c.slice(11, 18));
  if (seq0 + n - 1 > 9999999) return [];   // SEQ7 overflow — refuse rather than emit malformed codes
  const out = [];
  for (let i = 0; i < n; i++) out.push(genPrimary(item, seq0 + i, ww));
  return out;
}
