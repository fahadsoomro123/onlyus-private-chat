# Only Us reliability v2 deployment checklist

This branch is an in-progress redesign. It is not ready to install on the two live devices until all required steps below have been completed.

## Required private setup

- [ ] Create/choose a Firebase project and add the Android app ID `com.onlyus.privatechat`.
- [ ] Enable Firebase Cloud Messaging and Cloud Firestore.
- [ ] Download `google-services.json` into `android/app/google-services.json`. This private file is ignored by Git.
- [ ] Make sure the Firebase service account is available only to the backend runtime. Never put its JSON key in the repository or APK.
- [ ] Generate a random 48-character hexadecimal pairing token and use it only in the local private pairing config and backend environment.
- [ ] Deploy the Node backend on a persistent HTTPS/WSS host.
- [ ] Configure `ONLYUS_PAIR_TOKEN`, `ONLYUS_ALLOWED_ORIGINS`, and Firebase server credentials in that host's secret settings.
- [ ] Configure a TURN server and set `ONLYUS_TURN_URLS` plus `ONLYUS_TURN_SHARED_SECRET` in the backend.
- [ ] Add the backend HTTPS URL to the private `pair-config.json` on both clients.
- [ ] Build and install the Android release APK and per-user Windows installer locally, keeping both private.
- [ ] Test: app closed, Recents-swiped, screen locked, reboot, call answer/decline/timeout, Wi-Fi to mobile data, and laptop login without administrator elevation.

## Release gate

Do not publish a release or replace the working installation until the Android build, Windows build, backend health check, and real phone-to-laptop call tests all pass. Firebase, backend hosting, and TURN require private configuration; source code and GitHub Actions cannot provision those account resources automatically.
