// netlify/functions/auth-me.mjs  —  GET → current session {name,role,city} or 401
import { verifySession } from './_session.mjs';
export default async (req) => {
  const s = await verifySession(req);
  if (!s) return new Response('Not signed in', { status: 401 });
  return Response.json({ name: s.name, role: s.role, city: s.city, email: s.email });
};
