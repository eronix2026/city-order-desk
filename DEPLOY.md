# City Order Desk — Deploy (Android + iOS PWA)

Installable, offline-capable PWA. Camera scanning works on both platforms:
native `BarcodeDetector` on Android, self-hosted ZXing-WASM on iOS (Safari has no
Barcode Detection API). Locked to Code 128.

## What's in the bundle
```
index.html                  portal (Dealer OS shell)
manifest.webmanifest        PWA manifest (installable, standalone)
sw.js                       service worker (offline app shell + scan engine)
netlify.toml                publish + wasm headers + unolo-poll schedule
icons/                      app + maskable + apple-touch icons
vendor/zxing/               self-hosted Code 128 engine (no CDN)
  es/reader/index.js, es/share.js, zxing_reader.wasm
netlify/functions/          unolo-inbound, orders, unolo-poll
ARCHITECTURE.md
```

## Deploy
1. Push this folder to the Netlify site that serves `orders.eronix.in`.
   - **Never** add `eronix.in` / `www.eronix.in` (Let's Encrypt ↔ Wix apex deadlock).
     Use the `orders` subdomain via CNAME only.
2. Set function env vars: `UNOLO_WEBHOOK_SECRET`, the `ZOHO_*` block, `RESEND_API_KEY`.
3. HTTPS is required for the camera and the service worker — Netlify provides it.

## Install on a phone
- **Android (Chrome):** open the site → menu → *Install app* / *Add to Home screen*.
- **iOS (Safari):** Share → *Add to Home Screen*. Launches standalone, full-screen.
First launch caches the app shell + the 0.9 MB scan engine, so it runs offline after.

## Camera notes
- First camera use prompts for permission. If denied, the user is told to re-enable
  it in Settings; hardware-wedge and manual entry still work.
- Decoding runs only on the central reticle band (ROI) for speed on older iPhones.
- Torch toggle appears when the device exposes it.
- The camera is released when the order is fully serialized, on close, and when the
  app is backgrounded.

## Going live with real data
The portal ships in demo mode (in-memory). To run against the backend + live Zoho:

1. **Set env vars** on the Netlify site:
   - `SESSION_SECRET` — a long random string (HMAC signing key for session cookies)
   - `SESSION_TTL_HOURS` — session lifetime, default 12
   - `STAFF_ALLOWLIST` — JSON mapping each staff email to name/role/city, e.g.
     ```json
     {"rohan@eronix.in":{"name":"Rohan Das","role":"accounts","city":"Kolkata"},
      "ashok@eronix.in":{"name":"Ashok Mondal","role":"warehouse","city":"Kolkata"}}
     ```
     (Or manage per-email in the `staff` Blobs store, which overrides the env.)
   - Plus the Zoho block + `RESEND_API_KEY` (already needed).
2. In `index.html`, set `const DEMO_MODE = false;`

Staff then sign in with **email → 6-digit OTP** (emailed via Resend). Role and city
come from the allowlist, not user input — a warehouse user cannot self-assign
accounts or another city. Sessions are signed HttpOnly cookies; `orders.mjs` and
`serial-pool.mjs` reject any request without a valid session.

## Engine swap (optional)
If field reading rates fall short (poor light, worn labels), replace `detectFrame()`
in `index.html` with STRICH / Scanbot / Scandit — that one function is the entire
integration point. Everything downstream (dedup, gate, manifest) is unchanged.

## On every release
Bump `CACHE` in `sw.js` (e.g. `codesk-v2`) so clients pick up the new shell.

## Debugging the camera (read the status line)
The scanner now shows a status line under the top bar. If scanning fails, that line
says where — please report what it shows:
- **"Needs HTTPS"** → not served over https (or opened in a non-secure preview).
- **"Camera blocked"** / "permission was denied" → grant camera permission for the site.
- **"Engine failed"** → `/vendor/zxing/` didn't deploy; verify those files are live.
- **"No camera frames — tap to retry"** → the stream didn't render (often iOS needs a
  tap; tap the screen, or reopen). 
- **"Scanning · native"** (Android) / **"Scanning · wasm"** (iOS) → engine is live; if
  it still won't read, improve lighting/steadiness or use the **Type S/N** box.

If a fix doesn't appear after redeploying, the old build is cached: the service-worker
cache was bumped to `codesk-v2`, but force it by reloading twice, or test in a private
tab. The in-sheet **Type S/N** field always works as a fallback.
