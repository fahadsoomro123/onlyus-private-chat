# Only Us

Private two-device voice calling and messaging for one Android phone and one Windows laptop.

## Reliability v2 status

The `reliability-v2` branch replaces PeerJS Cloud signaling with a private authenticated WebSocket signaling service and standard WebRTC connections. It also adds native Android push-call notification handling, a Windows per-user installer, automated backend signaling tests, and CI Android compilation.

**This branch is not ready to replace the installed apps yet.** The private backend must be deployed, Firebase Cloud Messaging must be configured, TURN credentials must be added, and the local pairing configs must be completed. No real phone-to-laptop locked-screen call test has been run for v2.

## Design

- Android client: native FCM token registration, native incoming-call notification with Answer/Decline actions, and local ringtone service.
- Windows client: per-user installer, autostart at user login, system-tray behavior, and calls/messages UI.
- Signaling: authenticated WebSocket messages for WebRTC offers, answers, ICE candidates and cancel events.
- Media and data: WebRTC between the two paired devices; use the configured TURN service if a direct connection fails.
- Push calls: Firebase Cloud Messaging is used to wake the phone for incoming-call alerts when its app process is not running.
- Secrets: no pairing token, Firebase service-account file, FCM config, signing key, or APK is committed to the repository.

## Required setup before using v2

Follow [backend/DEPLOYMENT-CHECKLIST.md](backend/DEPLOYMENT-CHECKLIST.md). In brief:

1. Configure a Firebase project with Cloud Messaging and Cloud Firestore, then keep `google-services.json` local at `android/app/google-services.json`.
2. Deploy `backend/` on a persistent HTTPS/WSS-capable host. `backend/Dockerfile` is included for container deployments.
3. Configure the backend's private `ONLYUS_PAIR_TOKEN`, Firebase service-account credential, allowed app origins, and TURN URL/shared secret as host secrets.
4. Copy `backend/client-config.template.json` to local `public/pair-config.json` and `android/app/src/main/assets/pair-config.json`, then replace both values with the same private 48-character hex pairing token and your backend HTTPS URL. Keep both generated files out of source control.
5. Build and install local release packages with the existing Android signing key and run the release-gate tests listed in the deployment checklist.

The code deliberately shows a setup error instead of pretending to connect while the backend URL has not been configured.

## Build and checks

- Root JavaScript syntax check: `npm run check:syntax`
- Windows installer: `npm install`, then `npm run desktop:build`. The installer is per-user and should not request administrator elevation.
- Backend: `cd backend`, then `npm install`, `npm run check`, and `npm test`.
- Android debug build: `gradle -p android assembleDebug --no-daemon` (JDK 17, Android SDK 35 and Gradle 8.9).
- GitHub Actions runs JavaScript/backend regression tests and compiles the Android debug APK.

## Verification required before release

Test calling both ways; locked screen; app swiped from Recents; phone app restarted; phone reboot; notification Answer/Decline; missed-call timeout; Wi-Fi/mobile-data handover; a restrictive network with TURN enabled; and Windows restart/login using a standard user account.

No app can promise calls during a complete internet outage or after Android's explicit Force stop. Do not use this app for emergency calls.
