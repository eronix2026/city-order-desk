// netlify/functions/auth-verify.mjs  —  POST { email, code } → sets session cookie
import { getStore } from '@netlify/blobs';
import { staffLookup, hashOtp, mintSessionCookie, timingSafeEqual } from './_session.mjs';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let email, code;
  try { ({ email, code } = await req.json()); } catch { return new Response('Bad JSON', { status: 400 }); }
  email = String(email || '').trim().toLowerCase();
  code = String(code || '').trim();

  const store = getStore('auth');
  const rec = await store.get(`otp/${email}`, { type: 'json' }).catch(() => null);
  if (!rec || Date.now() > rec.exp) return new Response('Code expired — request a new one', { status: 401 });
  if (rec.attempts >= 5) { await store.delete(`otp/${email}`).catch(() => {}); return new Response('Too many attempts', { status: 429 }); }

  const ok = timingSafeEqual(await hashOtp(email, code), rec.hash);
  if (!ok) {
    rec.attempts++; await store.setJSON(`otp/${email}`, rec);
    return new Response('Incorrect code', { status: 401 });
  }
  await store.delete(`otp/${email}`).catch(() => {});

  const staff = await staffLookup(email);
  if (!staff) return new Response('Not authorized', { status: 403 });

  return new Response(JSON.stringify({ ok: true, session: { name: staff.name, role: staff.role, city: staff.city } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': await mintSessionCookie(staff, email) },
  });
};
