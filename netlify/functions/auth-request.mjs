// netlify/functions/auth-request.mjs  —  POST { email } → emails a 6-digit OTP
// Always returns 200 (never reveals whether an email is on the allowlist).
import { getStore } from '@netlify/blobs';
import { staffLookup, hashOtp } from './_session.mjs';

// Cryptographically-secure, unbiased 6-digit code (rejection sampling).
function genOtp() {
  const max = 900000, limit = 4294967296 - (4294967296 % max), a = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(a); } while (a[0] >= limit);
  return String(100000 + (a[0] % max));
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let email;
  try { ({ email } = await req.json()); } catch { return new Response('Bad JSON', { status: 400 }); }
  email = String(email || '').trim().toLowerCase();
  const DRY = process.env.STAFF_OTP_DRY_RUN === '1';   // TEST ONLY — returns devCode in response; remove before launch
  const generic = Response.json({ ok: true }); // identical response regardless of validity

  const staff = await staffLookup(email);
  if (!staff) return generic;

  const store = getStore('auth');
  const existing = await store.get(`otp/${email}`, { type: 'json' }).catch(() => null);
  const now = Date.now();
  if (!DRY && existing && now - existing.last < 30000) return generic;  // 30s resend cooldown (skipped in dry-run)
  // Hourly issuance cap — blunts OTP-flooding / email-bombing of a staff inbox.
  const windowStart = existing && now - (existing.since || 0) < 3600000 ? existing.since : now;
  const issued = (existing && windowStart === existing.since ? (existing.issued || 0) : 0) + 1;
  if (issued > 5) return generic;                                       // silently drop beyond 5/hour

  const code = genOtp();
  await store.setJSON(`otp/${email}`, { hash: await hashOtp(email, code), exp: now + 10 * 60000, attempts: 0, last: now, issued, since: windowStart });

  if (process.env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || 'ERONIX Order Desk <orders@eronix.in>',
        to: [email],
        subject: `Your Order Desk sign-in code: ${code}`,
        text: `Hi ${staff.name},\n\nYour ERONIX City Order Desk sign-in code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, ignore this email.`,
      }),
    }).catch(() => {});
  }
  if (DRY) return Response.json({ ok: true, devCode: code }); // TEST ONLY
  return generic;
};
