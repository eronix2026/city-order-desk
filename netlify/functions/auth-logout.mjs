// netlify/functions/auth-logout.mjs  —  POST → revokes this session token + clears the cookie
import { clearSessionCookie, revokeRequestToken } from './_session.mjs';
export default async (req) => {
  await revokeRequestToken(req).catch(() => {}); // invalidate server-side so a captured cookie is dead too
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() },
  });
};
