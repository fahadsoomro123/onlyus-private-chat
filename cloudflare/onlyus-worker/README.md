# Only Us V2 Cloudflare Worker

This is an add-only Cloudflare Workers/Durable Objects deployment target. The existing Node backend and current app installs remain unchanged.

## Deployment shape

- Worker name: `onlyus-private-chat-v2-signaling`
- Persistent signaling/pair state: a single SQLite-backed Durable Object.
- Worker URL: `https://onlyus-private-chat-v2-signaling.fahadsoomro123.workers.dev`.
- Secret `ONLYUS_PAIR_TOKEN`: must equal the existing local 48-character pairing key. Add it with Wrangler secret stdin, never in this file.
- Optional secret: `FIREBASE_SERVICE_ACCOUNT_JSON` for FCM push-call notifications.
- Cloudflare TURN uses the optional secrets `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`. Generate a TURN key under Cloudflare Realtime TURN using a credential with Calls Write permission; store the returned key value as the TURN API token. The Worker requests short-lived ICE credentials (24-hour TTL) server-side and never exposes the long-lived key to clients.
- Optional coturn-compatible fallback: `ONLYUS_TURN_URLS` and `ONLYUS_TURN_SHARED_SECRET`.
- Cloudflare's current published TURN pricing lists 1,000 GB free, then $0.05 per real-time GB outbound to the TURN client. No TURN key has been created and no TURN traffic/billing has been enabled by this setup yet.

FCM remains a separate Android push-provider requirement. Cloudflare hosts signaling but does not replace Google Firebase Cloud Messaging for waking a native Android app after its socket is gone. Without the FCM service-account secret, live WebSocket signaling may work while the phone app is connected, but background wake/push is not ready.

## Local verification

Run `npx wrangler dev --config cloudflare/onlyus-worker/wrangler.jsonc --local` and test `GET /healthz`, unauthorized `GET /v1/ice`, and authorized `GET /v1/ice`.

## Deploy

Run from repository root:

```powershell
npx wrangler deploy --config cloudflare/onlyus-worker/wrangler.jsonc
Get-Content public/pair-config.json | ConvertFrom-Json | Select-Object -ExpandProperty roomKey | npx wrangler secret put ONLYUS_PAIR_TOKEN --config cloudflare/onlyus-worker/wrangler.jsonc
```

The secret command reads the pairing key from the local ignored config through stdin; it must not be echoed or committed. After deployment, update only the ignored local pair configs to the returned Worker URL, then rebuild packages only when Firebase config and TURN configuration are ready.
