// netlify/functions/staff.mjs — admin-only staff provisioning.
//   GET    /staff            → { staff: [{ email, name, role, city, source }] }
//   POST   /staff  {…}       → add/update a member
//   DELETE /staff?email=…    → remove (tombstones env-defined members)
//
// There is no self-registration: role and city are assigned here, never chosen by
// the user. Guards prevent removing yourself or demoting/removing the last admin.

import { getStore } from '@netlify/blobs';
import { verifySession, listStaffDetailed } from './_session.mjs';
import { CITIES } from './_route.mjs';

const ROLES = ['accounts', 'warehouse', 'admin'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async (req) => {
  const session = await verifySession(req);
  if (!session) return new Response('Not signed in', { status: 401 });
  if (session.role !== 'admin') return new Response('Admin only', { status: 403 });

  const store = getStore('staff');
  const url = new URL(req.url);

  if (req.method === 'GET') {
    return Response.json({ staff: await listStaffDetailed(), cities: CITIES, roles: ROLES });
  }

  if (req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
    const email = String(b.email || '').trim().toLowerCase();
    const name = String(b.name || '').trim();
    const role = String(b.role || '').trim();
    const city = String(b.city || '').trim();
    if (!EMAIL_RE.test(email)) return new Response('Invalid email', { status: 422 });
    if (!name) return new Response('Name is required', { status: 422 });
    if (!ROLES.includes(role)) return new Response('Invalid role', { status: 422 });
    if (!CITIES.includes(city)) return new Response('Invalid city', { status: 422 });

    // last-admin guard: don't let the only admin be demoted
    if (role !== 'admin') {
      const all = await listStaffDetailed();
      const wasAdmin = all.some(s => s.email === email && s.role === 'admin');
      const otherAdmins = all.filter(s => s.role === 'admin' && s.email !== email).length;
      if (wasAdmin && otherAdmins === 0) return new Response('Cannot demote the last admin', { status: 409 });
    }
    await store.setJSON(email, { name, role, city });
    return Response.json({ ok: true, email, name, role, city });
  }

  if (req.method === 'DELETE') {
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    if (!email) return new Response('email required', { status: 400 });
    if (email === session.email) return new Response('You cannot remove yourself', { status: 409 });

    const all = await listStaffDetailed();
    const target = all.find(s => s.email === email);
    if (target && target.role === 'admin' && all.filter(s => s.role === 'admin' && s.email !== email).length === 0) {
      return new Response('Cannot remove the last admin', { status: 409 });
    }
    // Tombstone if the member is defined in env (can't delete env at runtime); else drop the key.
    let inEnv = false;
    try { inEnv = !!JSON.parse(process.env.STAFF_ALLOWLIST || '{}')[email]; } catch { /* ignore */ }
    if (inEnv) await store.setJSON(email, { disabled: true });
    else await store.delete(email).catch(() => {});
    return Response.json({ ok: true, removed: email });
  }

  return new Response('Method not allowed', { status: 405 });
};
