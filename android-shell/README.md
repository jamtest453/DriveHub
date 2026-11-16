# DriveHub Android shell

DriveHub remains one web product. This Capacitor shell bundles a known-good DriveHub web build into the Play Store binary, while `@capgo/capacitor-updater` can replace only the HTML/CSS/JS/assets from DriveHub's own update endpoint.

That gives the Android app three layers:

1. **Native shell** — Capacitor/Android/plugins. Changes here require a normal Play Store release.
2. **Bundled web fallback** — generated into `android-shell/web` and shipped inside the AAB/APK.
3. **OTA web release** — a newer signed/versioned web bundle downloaded from DriveHub and applied in the background.

The updater is configured as `atBackground`: it checks/downloads while DriveHub is active and applies the downloaded web release after the app is backgrounded. `shared/public/drivehub-runtime.js` waits for a successful page load before calling `notifyAppReady()`, allowing the native updater to roll back a failed bundle.

## First native build

Prerequisites: Android Studio, the JDK required by Capacitor 8, Node/npm, and network access to npm.

From `android-shell/`:

```bash
npm install
npm run android:add
npm run android:open
```

`android:add` first regenerates `android-shell/web`, then creates the native `android/` project. Subsequent native changes use:

```bash
npm run android:sync
npm run android:open
```

The app ID is currently **`app.drivehub.mobile`**. Decide the permanent package ID before the first Play Store release; changing it later creates a different Android application.

Optional build-time settings:

```text
DRIVEHUB_APP_ORIGIN=https://your-drivehub-host.example
DRIVEHUB_OTA_CHANNEL=stable        # or beta
DRIVEHUB_OTA_PUBLIC_KEY=<Capgo Encryption V2 public key>
```

The default hosted origin is `https://drive-hub-production-6748.up.railway.app`.

## Normal DriveHub development

Continue editing the normal DriveHub source. The same source drives web, standalone and Android.

Before a native build or OTA bundle, run from the repository root:

```bash
npm run build:android-web
```

This creates `android-shell/web/` with Home, MyGarage, Valuation, Road Finder and shared assets, plus `drivehub-build.json`. Native-local API calls are routed back to the configured hosted DriveHub API.

The native shell carries a web baseline version (`142.21.0` in this release). The OTA server will not offer that same version, and it will never intentionally downgrade a device already running a newer web bundle.

## Publishing an OTA web release

OTA release versions use semver. DriveHub `142.21` therefore becomes OTA version `142.21.0`.

1. Build and test DriveHub normally, including `npm run check`.
2. Run `npm run build:android-web`.
3. From `android-shell/`, use the Capgo CLI to make a compatible bundle and checksum, for example:

```bash
npx capgo bundle zip app.drivehub.mobile --path ./web --bundle 142.21.0 --name drivehub-142.21.0 --json
```

4. Copy the resulting ZIP into `../app-updates/bundles/`.
5. Promote it from the repository root using the checksum returned by the CLI:

```bash
npm run promote:android-ota -- 142.21.0 drivehub-142.21.0.zip <checksum> stable 1
```

`1` is the minimum Android native `versionCode` capable of running that web release. Increase it when a web release depends on a new native plugin/capability. Deploy DriveHub/Railway after promotion; installed Android apps will then discover the release automatically.

Do **not** use a generic ZIP utility. The updater expects the Capgo-compatible bundle structure/checksum.

## Encrypted OTA releases (recommended before public release)

The server and promotion format support Capgo Encryption V2. Configure the matching public key in `DRIVEHUB_OTA_PUBLIC_KEY` **before building the Play Store shell**. Keep the private key outside the repository.

Typical flow:

```bash
npx capgo key create
npx capgo bundle zip app.drivehub.mobile --path ./web --bundle 142.21.0 --name drivehub-142.21.0 --key-v2 --json
npx capgo bundle encrypt <zip-from-previous-command> <checksum-from-zip-command> --json
```

The encrypt command returns an encrypted checksum and `ivSessionKey`. Use the encrypted ZIP, encrypted checksum and the returned session key when promoting:

```bash
npm run promote:android-ota -- 142.21.0 <encrypted-zip> <encrypted-checksum> stable 1 <ivSessionKey>
```

The DriveHub update endpoint maps that value to the updater's `session_key` field. Once a native shell is shipped with a public key, use the matching private key for its encrypted OTA releases.

## Stable and beta channels

`app-updates/channels.json` contains separate `stable` and `beta` promotions. A native build can target beta by setting `DRIVEHUB_OTA_CHANNEL=beta` before `cap sync`/building it. Production should use stable.

A channel is disabled by default and is only useful after its compatible bundle exists on the server. Promotion is deliberately explicit so simply deploying web source does not accidentally ship an untested OTA bundle.

## Native versus OTA changes

Usually safe for OTA:

- HTML/CSS/JavaScript changes
- MyGarage/Valuation/Road Finder UI and web logic
- images and other web assets
- fixes that use capabilities already present in the native shell

Requires Play Store release first:

- new/updated native Capacitor plugins
- Android permissions or AndroidManifest changes
- native notification implementation changes
- camera/Bluetooth/OBD integrations not already in the shell
- Android widgets, services, Kotlin/Java changes
- target SDK/native dependency changes

When a web release needs new native code, promote it with a higher `minimumNativeVersionCode`; older shells receive `native_update_required` instead of downloading an incompatible bundle.

## Current v142.21 scope

This release scaffolds the Android shell and OTA infrastructure. It does **not** yet generate the Gradle `android/` project in this archive because npm/Android tooling is not available in the build environment used here. Run `npm install` and `npm run android:add` on the development machine once Android Studio is installed.

Existing web functionality is carried into the native web bundle. Browser Web Push/service-worker registration is intentionally suppressed inside the native shell; the dedicated **App** notification channel still needs its native Android/FCM implementation. Google sign-in/Drive should also be validated on a physical Android device because embedded-web OAuth can require a native auth path.
