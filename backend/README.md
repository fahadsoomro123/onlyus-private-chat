# Only Us reliability backend

This service is the server-side foundation for push call alerts, device presence, and TURN credentials. It must be deployed on a persistent host with HTTPS/WSS in front of it. It is not yet connected to the Android or Windows clients, so deploying this folder alone will not make the current APK ring in the background.

## Requirements

- Node.js 20 or newer.
- A Firebase project with Cloud Messaging enabled and an Android app registered for package `com.onlyus.privatechat`.
- A private Firebase service-account credential available to the server, never committed to this repository.
- A persistent disk for `ONLYUS_STATE_FILE`.
- A TURN server (for example coturn) configured with REST/shared-secret authentication.
- A TLS reverse proxy (Caddy or nginx) that forwards HTTPS and WebSocket traffic to port 8787.

## Environment

Set these on the server, not in Git:

- `ONLYUS_PAIR_TOKEN`: random private pairing token, at least 32 characters. Keep it identical to the private client config.
- `GOOGLE_APPLICATION_CREDENTIALS`: absolute path to the Firebase service-account JSON file, or use `FIREBASE_SERVICE_ACCOUNT_JSON` as a protected secret.
- `ONLYUS_STATE_FILE`: persistent path for the phone's FCM registration token.
- `ONLYUS_ALLOWED_ORIGINS`: comma-separated origins; default is the app-assets Android origin and local Windows app origin.
- `ONLYUS_TURN_URLS`: comma-separated TURN URLs, e.g. `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp`.
- `ONLYUS_TURN_SHARED_SECRET`: coturn REST API shared secret. Do not use the TURN secret as the pairing token.

Run `npm install`, `npm run check`, then `npm start`. Use a process manager and a TLS reverse proxy in production. Do not expose port 8787 directly to the public internet without HTTPS/WSS.

## Routes

- `GET /healthz`: health/configuration status without revealing credentials.
- `POST /v1/register-phone`: registers an FCM device token (Bearer pairing token).
- `POST /v1/unregister-phone`: clears the saved phone token.
- `GET /v1/ice`: returns STUN and, when configured, short-lived TURN credentials.
- `POST /v1/call`: sends call state to the other connected device and high-priority FCM data messages for incoming phone calls.
- `WS /ws`: authenticated device presence and call-state events. The first JSON message must be `{"type":"auth","device":"phone|desktop","token":"..."}`.

The client-integration work must be completed before this backend is considered production-ready. Specifically, Android must register its FCM token and display native call-style notifications; both clients must use this signaling channel and the returned ICE server list; call acceptance, timeout, cancel and reconnect flows must be wired end-to-end.