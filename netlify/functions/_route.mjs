// netlify/functions/_route.mjs  (shared — single source of truth for territory)
//
// Maps a field exec / dealer pincode to a city desk. Precedence: exec → pincode
// → explicit city → flagged fallback. An order that can't be resolved is NOT
// silently dropped into a metro; it lands in DEFAULT_CITY with routed=false so the
// desk can flag and reassign it.

export const CITIES = ['Kolkata', 'Mumbai', 'Delhi', 'Bangalore', 'Chennai'];
export const DEFAULT_CITY = process.env.DEFAULT_CITY || 'Kolkata';

export const EXEC_TO_CITY = {
  'sourav.b': 'Kolkata', 'debjit.m': 'Kolkata',
  'rahul.k': 'Mumbai', 'faizan.a': 'Mumbai',
  'amit.s': 'Delhi', 'gaurav.t': 'Delhi',
  'naveen.r': 'Bangalore', 'manoj.p': 'Bangalore',
  'karthik.s': 'Chennai', 'vignesh.r': 'Chennai',
};
export const PIN_PREFIX_TO_CITY = {
  '70': 'Kolkata', '71': 'Kolkata', '40': 'Mumbai', '41': 'Mumbai',
  '11': 'Delhi', '12': 'Delhi', '56': 'Bangalore', '60': 'Chennai',
};

// → { city, routed }. routed=false means "fell back — needs human verification".
export function routeCity({ exec, pincode, city } = {}) {
  const ex = String(exec || '').toLowerCase().trim();
  if (EXEC_TO_CITY[ex]) return { city: EXEC_TO_CITY[ex], routed: true };
  const pin = String(pincode || '').slice(0, 2);
  if (PIN_PREFIX_TO_CITY[pin]) return { city: PIN_PREFIX_TO_CITY[pin], routed: true };
  if (city && CITIES.includes(city)) return { city, routed: true };
  return { city: DEFAULT_CITY, routed: false };
}

// Standard 15-char GSTIN shape.
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

// Drop junk lines from inbound orders: non-positive qty, missing SKU, bad price.
export function sanitizeLines(lines = []) {
  return (lines || [])
    .map(l => ({
      sku: String(l.sku || '').trim().toUpperCase(),
      name: String(l.name || '').trim(),
      price: Number(l.price),
      qty: Math.floor(Number(l.qty)),
      ...(l.itemId ? { itemId: l.itemId } : {}),
    }))
    .filter(l => l.sku && Number.isFinite(l.price) && l.price >= 0 && Number.isInteger(l.qty) && l.qty > 0);
}
