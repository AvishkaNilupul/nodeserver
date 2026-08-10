# RedeemHub Seller — Android app

A thin Kotlin WebView shell around the mobile seller app the server hosts at
`/app` (`public/app.html`). The UI lives on the server, so **UI changes ship by
deploying `public/app.html` — no APK rebuild needed**. Rebuild the APK only for
native changes (icon, splash, base URL, WebView behavior).

- **Release** loads `https://redeemhub.lets.game/app`
- **Debug** loads `http://10.0.2.2:3000/app` (your Mac's localhost from an
  emulator) and installs side-by-side as `com.redeemhub.seller.debug`

Sellers sign in with the same admin accounts as the website (`utils/admins.json`
on the server, managed from the Admins page). 2FA and the per-admin Telegram
alert linking work inside the app.

## Installing on a phone

1. Copy `app-release.apk` to the phone (Telegram "Saved Messages" works well).
2. Open it; allow "install from unknown sources" when prompted.
3. Sign in with the seller's admin username/password.

The same app is also installable as a PWA without the APK: open
`https://redeemhub.lets.game/app` in Chrome on Android → menu → *Add to Home
screen* (served by `public/app-manifest.json`).

## Building

Requires JDK 17 and the Android SDK (build-tools 33.0.1, platform 33).

```bash
cd android
JAVA_HOME=$(/usr/libexec/java_home -v 17) ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

`local.properties` (gitignored) must point at your SDK, e.g.
`sdk.dir=/Users/<you>/Library/Android/sdk`.

## Signing

Release builds are signed with `keystore/redeemhub-seller.keystore`, configured
by `keystore/keystore.properties` (both **gitignored — back them up somewhere
safe**). If the keystore is lost, a rebuilt APK gets a new signature and phones
will refuse to update over the old app (sellers would have to uninstall and
reinstall — they'd need to log in again, nothing else is lost).

If `keystore/keystore.properties` is missing, the release build falls back to
the debug key so it still builds.

## Shipping an update to the APK itself

1. Bump `versionCode` (and `versionName`) in `app/build.gradle`.
2. `./gradlew assembleRelease`
3. Send the new `app-release.apk` to sellers; installing over the old version
   keeps their session.

## Native features

- Persistent login (cookies survive app restarts; server session TTL is 12h)
- Pull-to-refresh (the page opts out on the chat tab via the `AppBridge`
  JS interface)
- Hardware back = in-app history; never accidentally exits
- File chooser works for image upload in the buyer chat
- External links (Telegram deep links etc.) open in the matching app
- Offline error screen with retry
