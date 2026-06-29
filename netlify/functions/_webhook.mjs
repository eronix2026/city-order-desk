// netlify/functions/_webhook.mjs  (shared — underscore = not a route)
// Webhook authentication. Baseline: a shared-secret header. Hardened (when a signing
// secret is configured): an HMAC-SHA256 body signature bound to a timestamp, which
// makes a captured request non-replayable and tamper-evident.
//
// Senders that sign must send:
//   X-Timestamp: <epoch ms>
//   X-Signature: hex( HMAC-SHA256( `${X-Timestamp}.${rawBody}`, signingSecret ) )
// (Replaying the same order id is already a no-op — storeOrder is id-idempotent — so
//  the timestamp window + signature close the remaining tamper/replay surface.)

import { timingSafeEqual } from './_session.mjs';

const enc = new TextEncoder();
const SKEW_MS = 5 * 60 * 1000;

async function hmacHex(secret, msg) {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// → { ok:true } | { ok:false, status, reason }
export async function verifyWebhook(req, rawText, { secret, signingSecret, secretHeader }) {
  if (!secret) return { ok: false, status: 500, reason: 'secret not configured' };
  if (req.headers.get(secretHeader) !== secret) return { ok: false, status: 401, reason: 'Unauthorized' };

  if (signingSecret) {
    const ts = req.headers.get('x-timestamp');
    const sig = (req.headers.get('x-signature') || '').toLowerCase();
    if (!ts || !sig) return { ok: false, status: 401, reason: 'missing signature' };
    const skew = Math.abs(Date.now() - Number(ts));
    if (!Number.isFinite(skew) || skew > SKEW_MS) return { ok: false, status: 401, reason: 'stale or invalid timestamp' };
    const expected = await hmacHex(signingSecret, `${ts}.${rawText}`);
    if (!timingSafeEqual(expected, sig)) return { ok: false, status: 401, reason: 'bad signature' };
  }
  return { ok: true };
}
