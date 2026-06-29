// netlify/functions/_session.mjs  (shared — underscore = not a route)
// Passwordless staff auth: email → 6-digit OTP → signed HttpOnly session cookie.
// Role + city are NOT user input — they come from the staff allowlist, so a
// warehouse user cannot self-assign accounts (or another city).
//
// Env: SESSION_SECRET (HMAC signing key), SESSION_TTL_HOURS (default 12),
//      STAFF_ALLOWLIST (JSON: { "email": {"name","role","city"} })

import { getStore } from '@netlify/blobs';

const COOKIE = 'eronix_session';
const enc = new TextEncoder();
const TTL = (Number(process.env.SESSION_TTL_HOURS) || 12) * 3600 * 1000;

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(s, 'base64url');

async function hmacKey(secret = process.env.SESSION_SECRET) {
  if (!secret) throw new Error('signing secret not set');
  return globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// Constant-time compare for secret material (OTP hashes, tokens).
export function timingSafeEqual(a, b) {
  const ab = enc.encode(String(a)), bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let r = 0; for (let i = 0; i < ab.length; i++) r |= ab[i] ^ bb[i];
  return r === 0;
}

export async function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = await globalThis.crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(body));
  return body + '.' + b64u(new Uint8Array(sig));
}
export async function verifyToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const ok = await globalThis.crypto.subtle.verify('HMAC', await hmacKey(), unb64u(sig), enc.encode(body));
  if (!ok) return null;
  const payload = JSON.parse(unb64u(body).toString());
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

function readCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// → { email, name, role, city } or null. Re-checks the live allowlist so a
// removed or role-changed staff member loses access immediately, not at token
// expiry, and honours per-token revocation (logout invalidates the session
// server-side, not just by clearing the cookie).
export async function verifySession(req) {
  const payload = await verifyToken(readCookie(req, COOKIE));
  if (!payload || !payload.email) return null;
  const staff = await staffLookup(payload.email);
  if (!staff) return null;                       // deauthorized since the token was issued
  if (payload.jti && await isRevoked(payload.jti)) return null;  // explicitly signed out
  return { email: payload.email, name: staff.name, role: staff.role, city: staff.city };
}

export async function mintSessionCookie(staff, email) {
  const token = await signToken({ email, name: staff.name, role: staff.role, city: staff.city, iat: Date.now(), jti: globalThis.crypto.randomUUID(), exp: Date.now() + TTL });
  const maxAge = Math.floor(TTL / 1000);
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
export function clearSessionCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

// Per-token revocation list. A revoked jti is rejected by verifySession even though
// the signature and expiry are still valid. Entries are safe to prune once older
// than the session TTL (a stale jti can never re-validate).
async function isRevoked(jti) { if (!jti) return false; try { return !!(await getStore('revoked-tokens').get(jti)); } catch { return false; } }
export async function revokeToken(jti) { if (!jti) return; try { await getStore('revoked-tokens').setJSON(jti, { at: Date.now() }); } catch { /* non-fatal */ } }
export async function revokeRequestToken(req) {
  const payload = await verifyToken(readCookie(req, COOKIE));
  if (payload && payload.jti) await revokeToken(payload.jti);
}

// Staff allowlist: Blobs 'staff' store overrides env JSON. A stored {disabled:true}
// tombstone removes a member even if they're defined in env. Returns {name,role,city} or null.
export async function staffLookup(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  try {
    const rec = await getStore('staff').get(e, { type: 'json' });
    if (rec) return rec.disabled ? null : rec;   // tombstone → denied
  } catch { /* fall through to env */ }
  try {
    const map = JSON.parse(process.env.STAFF_ALLOWLIST || '{}');
    return map[e] || null;
  } catch { return null; }
}

// All staff: env JSON is the base; Blobs 'staff' entries override/extend per-email,
// and a {disabled:true} tombstone removes one.
export async function listStaff() {
  let out = {};
  try { out = { ...JSON.parse(process.env.STAFF_ALLOWLIST || '{}') }; } catch { /* ignore */ }
  try {
    const store = getStore('staff');
    const { blobs = [] } = await store.list();
    for (const { key } of blobs) {
      const v = await store.get(key, { type: 'json' }).catch(() => null);
      if (!v) continue;
      if (v.disabled) delete out[key]; else out[key] = v;
    }
  } catch { /* env only */ }
  return out; // { email: { name, role, city } }
}
// Merged active list with provenance, for the admin Staff panel.
export async function listStaffDetailed() {
  let env = {};
  try { env = JSON.parse(process.env.STAFF_ALLOWLIST || '{}'); } catch { /* ignore */ }
  const storeMap = {};
  try {
    const store = getStore('staff');
    const { blobs = [] } = await store.list();
    for (const { key } of blobs) { const v = await store.get(key, { type: 'json' }).catch(() => null); if (v) storeMap[key] = v; }
  } catch { /* env only */ }
  const out = [];
  for (const email of new Set([...Object.keys(env), ...Object.keys(storeMap)])) {
    const sv = storeMap[email];
    if (sv && sv.disabled) continue;            // tombstoned → removed
    const rec = sv || env[email];
    if (!rec) continue;
    out.push({ email, name: rec.name, role: rec.role, city: rec.city, source: sv ? 'added' : 'env' });
  }
  return out.sort((a, b) => `${a.city}${a.role}${a.email}`.localeCompare(`${b.city}${b.role}${b.email}`));
}
// Staff in a city holding a role → [{ email, name }]. Used to notify warehouse staff.
export async function staffByCityRole(city, role) {
  const all = await listStaff();
  return Object.entries(all)
    .filter(([, s]) => s && s.city === city && s.role === role)
    .map(([email, s]) => ({ email, name: s.name }));
}


export async function hashOtp(email, code) {
  const key = await hmacKey(process.env.OTP_SECRET || process.env.SESSION_SECRET);
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(`${String(email).toLowerCase()}:${code}`));
  return b64u(new Uint8Array(sig));
}
