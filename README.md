# Only Us

A simple private two-device voice and chat app. The PC version runs on the home laptop; the Android APK runs on Fahad's phone.

## Start on the home laptop
1. Open the desktop shortcut **Only Us** (created by setup).
2. Leave the browser tab open when you want to be reachable for calls/messages.
3. Choose **Wife** on the laptop the first time.

## Start on Android
1. Install OnlyUs.apk.
2. Open it and choose **Fahad** once.
3. Keep the app open while you want to receive calls.

## GitHub Pages desktop version
The hosted browser version is published from `public/` with GitHub Pages. The hosted copy intentionally does not include `pair-config.json` or the private pairing key. On the home laptop, enter the 48-character key from `pair-secret.private` once in the hosted setup panel, then choose **Wife**. The key is saved only in that browser's local storage; it is not uploaded to GitHub. The Android app continues to use its private bundled configuration and should be opened as **Fahad**.

Never commit or publish `pair-secret.private`, either `pair-config.json`, signing keys, or an APK that contains your pairing ID. The Pages workflow checks for these files before publishing.

## What it does
- Live voice calls using browser/WebView WebRTC.
- Chat between the two paired app instances.
- Chat messages are stored on each device and synchronized peer-to-peer when both clients reconnect. A message written while the other side is offline stays queued on the sending device until the app reconnects.
- No account, phone number, public room link, camera, recording, or home-router port forwarding is required.

## Network and privacy notes
- PeerJS Cloud is used only for WebRTC signaling. Voice and chat normally travel directly between the devices using encrypted WebRTC. A restrictive network may block direct media/data connections because this build uses a public STUN server and does not include a TURN relay.
- The PC app binds to 127.0.0.1 only; it does not expose a local web server to the LAN or Internet.
- Both clients include the same randomly generated pairing ID. Keep the APK and this folder private. Anyone who gets the APK or folder can extract that pairing ID and could impersonate one endpoint.
- Both apps must be open and online for new messages to sync and for incoming calls to ring. This build does not use background push notifications.
- Do not use this app for emergency calls or sensitive information until both devices have been tested by you.
